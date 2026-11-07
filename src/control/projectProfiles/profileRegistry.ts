/**
 * Durable Project Profile registry and one authoritative active-project pointer.
 *
 * The registry owns namespace/root uniqueness and visibility. Profile bytes remain owned by
 * ProjectProfileStore. Every mutation is serialized, journalled, evented and generation-checked.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { z } from 'zod';

import { nowIso } from '../../shared/ids.js';
import {
  asTargetRootIdentity,
  assertPathIdentity,
  resolvePathIdentity,
} from '../../shared/pathIdentity.js';
import {
  actorSchema,
  isoTimestampSchema,
  projectIdSchema,
  projectProfileHashSchema,
  sha256Schema,
  targetRootIdentitySchema,
  type Actor,
  type ProjectProfile,
  type ProjectProfileRecord,
} from '../../shared/schemas.js';
import { canonicalizeProjectProfile } from './profileCanonicalization.js';
import { computeProjectAuthorityHash } from './profileHash.js';
import { ProfileEventLog, type ProfileEventInput } from './profileEventLog.js';
import {
  readJsonFile,
  removeFileDurably,
  withExclusiveFileLock,
  writeJsonAtomically,
} from './profileFileSystem.js';
import {
  ProfileStoreError,
  ProjectProfileStore,
  type ProjectProfileMetadata,
} from './profileStore.js';

export const PROJECT_PROFILE_REGISTRY_VERSION = 'clue-project-profile-registry/1' as const;
export const PROJECT_PROFILE_TRANSACTION_VERSION = 'clue-project-profile-transaction/2' as const;

export const projectProfileRegistryEntrySchema = z
  .object({
    projectId: projectIdSchema,
    targetRootIdentity: targetRootIdentitySchema,
    profileFile: z.string().regex(/^profiles\/[a-z0-9][a-z0-9._-]*\.json$/u),
    registeredAt: isoTimestampSchema,
  })
  .strict();
export type ProjectProfileRegistryEntry = z.infer<typeof projectProfileRegistryEntrySchema>;

export const projectProfileRegistrySchema = z
  .object({
    registryVersion: z.literal(PROJECT_PROFILE_REGISTRY_VERSION),
    generation: z.number().int().nonnegative(),
    activeProjectId: projectIdSchema.nullable(),
    activatedAt: isoTimestampSchema.nullable().default(null),
    projects: z.array(projectProfileRegistryEntrySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const roots = new Set<string>();
    for (const [index, entry] of value.projects.entries()) {
      if (ids.has(entry.projectId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projects', index, 'projectId'], message: `duplicate Project ID ${entry.projectId}` });
      }
      ids.add(entry.projectId);
      if (roots.has(entry.targetRootIdentity)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projects', index, 'targetRootIdentity'], message: `duplicate Target Root identity ${entry.targetRootIdentity}` });
      }
      roots.add(entry.targetRootIdentity);
      if (entry.profileFile !== `profiles/${entry.projectId}.json`) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projects', index, 'profileFile'], message: 'profileFile must be the canonical project profile path' });
      }
    }
    if (value.activeProjectId !== null && !ids.has(value.activeProjectId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeProjectId'], message: 'activeProjectId must name a registered project' });
    }
    if ((value.activeProjectId === null) !== (value.activatedAt === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activatedAt'], message: 'activatedAt must be present exactly when an active project exists' });
    }
  });
export type ProjectProfileRegistryState = z.infer<typeof projectProfileRegistrySchema>;

export interface ActiveProjectPointer {
  readonly pointerVersion: 'clue-active-project-pointer/1';
  readonly projectId: string;
  readonly targetRootIdentity: string;
  readonly projectProfileHash: string;
  readonly profileGeneration: number;
  readonly registryGeneration: number;
  readonly activatedAt: string;
}

const profileTransactionSchema = z
  .object({
    transactionVersion: z.literal(PROJECT_PROFILE_TRANSACTION_VERSION),
    transactionId: z.string().regex(/^PROFILE-TX-[0-9a-f-]{36}$/u),
    operation: z.enum(['create', 'update', 'delete', 'activate']),
    actor: actorSchema,
    reason: z.string().min(1).nullable(),
    projectId: projectIdSchema,
    targetRootIdentity: targetRootIdentitySchema,
    createdAt: isoTimestampSchema,
    afterRegistry: projectProfileRegistrySchema,
    previousGeneration: z.number().int().positive().nullable(),
    previousProfileHash: projectProfileHashSchema.nullable(),
    previousAuthorityHash: sha256Schema.nullable(),
    generation: z.number().int().positive().nullable(),
    projectProfileHash: projectProfileHashSchema.nullable(),
    authorityHash: sha256Schema.nullable(),
  })
  .strict();
type ProfileTransaction = z.infer<typeof profileTransactionSchema>;

export type ProfileRegistryErrorCode =
  | 'PROJECT_ID_ALREADY_REGISTERED'
  | 'TARGET_ROOT_ALREADY_REGISTERED'
  | 'PROJECT_NOT_REGISTERED'
  | 'TARGET_ROOT_IDENTITY_MISMATCH'
  | 'TARGET_ROOT_REBIND_FORBIDDEN'
  | 'REGISTRY_MALFORMED'
  | 'REGISTRY_INTEGRITY_FAILED'
  | 'ACTIVE_POINTER_CONFLICT';

export class ProfileRegistryError extends Error {
  public readonly code: ProfileRegistryErrorCode;
  public readonly projectId: string | null;
  public readonly existingProjectId: string | null;

  public constructor(
    code: ProfileRegistryErrorCode,
    message: string,
    options: { readonly projectId?: string; readonly existingProjectId?: string } = {},
  ) {
    super(message);
    this.name = 'ProfileRegistryError';
    this.code = code;
    this.projectId = options.projectId ?? null;
    this.existingProjectId = options.existingProjectId ?? null;
  }
}

/** Compatibility read shape retained for callers that need the registry entry and record together. */
export interface RegisteredProjectProfile {
  readonly entry: ProjectProfileRegistryEntry;
  readonly record: ProjectProfileRecord;
}

export interface ProjectProfileRegistryOptions {
  readonly eventLog?: ProfileEventLog;
  readonly now?: () => string;
}

export interface ProjectProfileMutationOptions {
  readonly actor: Actor;
  readonly reason?: string;
}

interface ProjectProfileActivationPrecondition {
  readonly generation: number;
  readonly projectProfileHash: string;
  readonly registryGeneration?: number;
}

function mutationOptions(value: ProjectProfileMutationOptions | Actor | undefined): ProjectProfileMutationOptions {
  if (value === undefined) return { actor: 'creator' };
  return typeof value === 'string' ? { actor: value } : value;
}

function emptyRegistry(): ProjectProfileRegistryState {
  return {
    registryVersion: PROJECT_PROFILE_REGISTRY_VERSION,
    generation: 0,
    activeProjectId: null,
    activatedAt: null,
    projects: [],
  };
}

function sortedRegistry(state: ProjectProfileRegistryState): ProjectProfileRegistryState {
  return projectProfileRegistrySchema.parse({
    ...state,
    projects: [...state.projects].sort((left, right) => left.projectId.localeCompare(right.projectId)),
  });
}

function canonicalTargetProfile(input: unknown): ProjectProfile {
  const requested = canonicalizeProjectProfile(input);
  const target = resolvePathIdentity(requested.targetRoot, { zone: 'target', expectedKind: 'directory' });
  try {
    assertPathIdentity(requested.targetRootIdentity, target, 'Project Profile target root');
  } catch (error) {
    throw new ProfileRegistryError(
      'TARGET_ROOT_IDENTITY_MISMATCH',
      (error as Error).message,
      { projectId: requested.projectId },
    );
  }
  const canonicalTarget = target.displayPath;
  return canonicalizeProjectProfile({
    ...requested,
    targetRoot: canonicalTarget,
    targetRootIdentity: asTargetRootIdentity(target.identity),
    benchmarkRuntime: {
      ...requested.benchmarkRuntime,
      workingDirectory:
        requested.benchmarkRuntime.workingDirectory === requested.targetRoot
          ? canonicalTarget
          : requested.benchmarkRuntime.workingDirectory,
    },
    integrations: {
      ...requested.integrations,
      powershell: { ...requested.integrations.powershell, projectRoot: canonicalTarget },
      git: { ...requested.integrations.git, repositoryRoot: canonicalTarget },
    },
  });
}

export class ProjectProfileRegistry {
  public readonly root: string;
  public readonly registryPath: string;
  private readonly transactionsDir: string;
  private readonly lockPath: string;
  private readonly store: ProjectProfileStore;
  private readonly eventLog: ProfileEventLog;
  private readonly now: () => string;

  public constructor(storeOrRoot: ProjectProfileStore | string, options: ProjectProfileRegistryOptions = {}) {
    this.store = typeof storeOrRoot === 'string'
      ? new ProjectProfileStore(storeOrRoot, options.now === undefined ? {} : { now: options.now })
      : storeOrRoot;
    this.root = this.store.root;
    this.registryPath = join(this.root, 'registry.json');
    this.transactionsDir = join(this.root, '.transactions');
    this.lockPath = join(this.root, '.locks', 'registry.lock');
    this.now = options.now ?? nowIso;
    this.eventLog = options.eventLog ?? new ProfileEventLog(this.root, { now: this.now });
    mkdirSync(this.transactionsDir, { recursive: true });
  }

  public readState(): ProjectProfileRegistryState {
    if (!existsSync(this.registryPath)) return emptyRegistry();
    try {
      return projectProfileRegistrySchema.parse(readJsonFile(this.registryPath));
    } catch (error) {
      throw new ProfileRegistryError('REGISTRY_MALFORMED', `Project Profile registry is malformed: ${(error as Error).message}`);
    }
  }

  public list(): readonly RegisteredProjectProfile[] {
    return this.readState().projects.map((entry) => ({ entry, record: this.store.require(entry.projectId) }));
  }

  public listMetadata(): readonly ProjectProfileMetadata[] {
    return this.list().map(({ record }) => ({
      projectId: record.profile.projectId,
      displayName: record.profile.displayName,
      targetRoot: record.profile.targetRoot,
      targetRootIdentity: record.profile.targetRootIdentity,
      generation: record.generation,
      projectProfileHash: record.projectProfileHash,
      updatedAt: record.updatedAt,
      profilePath: this.store.pathFor(record.profile.projectId),
    }));
  }

  public get(projectId: string): RegisteredProjectProfile | null {
    const id = projectIdSchema.parse(projectId);
    const entry = this.readState().projects.find((candidate) => candidate.projectId === id);
    return entry === undefined ? null : { entry, record: this.store.require(id) };
  }

  public getProfile(projectId: string): ProjectProfileRecord {
    const registered = this.get(projectId);
    if (registered === null) {
      throw new ProfileRegistryError('PROJECT_NOT_REGISTERED', `Project ${projectId} is not registered.`, { projectId });
    }
    return registered.record;
  }

  public activeProjectId(): string | null {
    return this.readState().activeProjectId;
  }

  public active(): ActiveProjectPointer | null {
    const state = this.readState();
    if (state.activeProjectId === null || state.activatedAt === null) return null;
    const record = this.getProfile(state.activeProjectId);
    return Object.freeze({
      pointerVersion: 'clue-active-project-pointer/1',
      projectId: record.profile.projectId,
      targetRootIdentity: record.profile.targetRootIdentity,
      projectProfileHash: record.projectProfileHash,
      profileGeneration: record.generation,
      registryGeneration: state.generation,
      activatedAt: state.activatedAt,
    });
  }

  public create(profileInput: ProjectProfile | unknown, options?: ProjectProfileMutationOptions | Actor): ProjectProfileRecord {
    const profile = canonicalTargetProfile(profileInput);
    const operation = mutationOptions(options);
    return withExclusiveFileLock(this.lockPath, () => {
      this.recoverLocked();
      const state = this.readState();
      const duplicateId = state.projects.find((entry) => entry.projectId === profile.projectId);
      if (duplicateId !== undefined) {
        throw new ProfileRegistryError('PROJECT_ID_ALREADY_REGISTERED', `PROJECT ID ALREADY REGISTERED: ${profile.projectId}`, { projectId: profile.projectId, existingProjectId: duplicateId.projectId });
      }
      const duplicateRoot = state.projects.find((entry) => entry.targetRootIdentity === profile.targetRootIdentity);
      if (duplicateRoot !== undefined) {
        throw new ProfileRegistryError('TARGET_ROOT_ALREADY_REGISTERED', `TARGET ROOT ALREADY REGISTERED\nExisting Project: ${duplicateRoot.projectId}`, { projectId: profile.projectId, existingProjectId: duplicateRoot.projectId });
      }
      const entry: ProjectProfileRegistryEntry = {
        projectId: profile.projectId,
        targetRootIdentity: profile.targetRootIdentity,
        profileFile: `profiles/${profile.projectId}.json`,
        registeredAt: this.now(),
      };
      const afterRegistry = sortedRegistry({ ...state, generation: state.generation + 1, projects: [...state.projects, entry] });
      let transaction = this.makeTransaction({ operation: 'create', options: operation, profile, afterRegistry });
      this.writeTransaction(transaction);
      try {
        const record = this.store.create(profile);
        transaction = this.withRecord(transaction, record);
        this.writeTransaction(transaction);
        writeJsonAtomically(this.registryPath, afterRegistry);
        this.appendTransactionEvent(transaction);
        this.removeTransaction(transaction);
        return record;
      } catch (error) {
        if (error instanceof ProfileStoreError && error.code === 'PROFILE_EXISTS') this.removeTransaction(transaction);
        throw error;
      }
    });
  }

  public update(profileInput: ProjectProfile | unknown, expectedGeneration: number, options?: ProjectProfileMutationOptions | Actor): ProjectProfileRecord;
  public update(projectId: string, profileInput: ProjectProfile | unknown, expectedGeneration: number, options?: ProjectProfileMutationOptions | Actor): ProjectProfileRecord;
  public update(
    first: string | ProjectProfile | unknown,
    second: ProjectProfile | unknown | number,
    third?: number | ProjectProfileMutationOptions | Actor,
    fourth?: ProjectProfileMutationOptions | Actor,
  ): ProjectProfileRecord {
    const legacy = typeof first === 'string';
    const projectId = legacy ? projectIdSchema.parse(first) : canonicalizeProjectProfile(first).projectId;
    const profileInput = legacy ? second : first;
    const expectedGeneration = legacy ? third : second;
    const options = legacy ? fourth : third;
    if (typeof expectedGeneration !== 'number') throw new ProfileStoreError('INVALID_PROFILE', 'Expected one numeric profile generation.');
    const profile = canonicalTargetProfile(profileInput);
    const operation = mutationOptions(options as ProjectProfileMutationOptions | Actor | undefined);

    return withExclusiveFileLock(this.lockPath, () => {
      this.recoverLocked();
      const state = this.readState();
      const entry = state.projects.find((candidate) => candidate.projectId === projectId);
      if (entry === undefined) throw new ProfileRegistryError('PROJECT_NOT_REGISTERED', `Project ${projectId} is not registered.`, { projectId });
      if (profile.projectId !== projectId || profile.targetRootIdentity !== entry.targetRootIdentity) {
        throw new ProfileRegistryError('TARGET_ROOT_REBIND_FORBIDDEN', `Project ${projectId} cannot change Project ID or physical Target Root through update.`, { projectId });
      }
      const previous = this.store.require(projectId);
      const afterRegistry = sortedRegistry({ ...state, generation: state.generation + 1 });
      let transaction = this.makeTransaction({ operation: 'update', options: operation, profile, afterRegistry, previous });
      this.writeTransaction(transaction);
      const record = this.store.update(profile, expectedGeneration);
      transaction = this.withRecord(transaction, record);
      this.writeTransaction(transaction);
      writeJsonAtomically(this.registryPath, afterRegistry);
      this.appendTransactionEvent(transaction);
      this.removeTransaction(transaction);
      return record;
    });
  }

  public delete(projectId: string, expectedGeneration: number, options?: ProjectProfileMutationOptions | Actor): void {
    const id = projectIdSchema.parse(projectId);
    const operation = mutationOptions(options);
    withExclusiveFileLock(this.lockPath, () => {
      this.recoverLocked();
      const state = this.readState();
      const entry = state.projects.find((candidate) => candidate.projectId === id);
      if (entry === undefined) throw new ProfileRegistryError('PROJECT_NOT_REGISTERED', `Project ${id} is not registered.`, { projectId: id });
      const previous = this.store.require(id);
      if (previous.generation !== expectedGeneration) {
        throw new ProfileStoreError('GENERATION_CONFLICT', `Project Profile ${id} generation is ${previous.generation}, expected ${expectedGeneration}.`, id, previous.generation);
      }
      const afterRegistry = sortedRegistry({
        ...state,
        generation: state.generation + 1,
        activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
        activatedAt: state.activeProjectId === id ? null : state.activatedAt,
        projects: state.projects.filter((candidate) => candidate.projectId !== id),
      });
      const transaction = this.makeTransaction({ operation: 'delete', options: operation, profile: previous.profile, afterRegistry, previous });
      this.writeTransaction(transaction);
      writeJsonAtomically(this.registryPath, afterRegistry);
      this.store.delete(id, expectedGeneration, { projectId: id, deleteProfileDataOnly: true });
      this.appendTransactionEvent(transaction);
      this.removeTransaction(transaction);
    });
  }

  public activate(
    projectId: string,
    options?: ProjectProfileMutationOptions | Actor,
    expected?: ProjectProfileActivationPrecondition,
  ): ActiveProjectPointer {
    const id = projectIdSchema.parse(projectId);
    const operation = mutationOptions(options);
    return withExclusiveFileLock(this.lockPath, () => {
      this.recoverLocked();
      const state = this.readState();
      const record = this.getProfileFromState(state, id);
      if (expected !== undefined && (record.generation !== expected.generation ||
        record.projectProfileHash !== expected.projectProfileHash ||
        (expected.registryGeneration !== undefined && state.generation !== expected.registryGeneration))) {
        throw new ProfileRegistryError('ACTIVE_POINTER_CONFLICT',
          `Project Profile ${id} or its registry changed before activation. Read and verify the current generation.`,
          { projectId: id });
      }
      const activatedAt = this.now();
      const afterRegistry = sortedRegistry({ ...state, generation: state.generation + 1, activeProjectId: id, activatedAt });
      let transaction = this.makeTransaction({ operation: 'activate', options: operation, profile: record.profile, afterRegistry, previous: record });
      transaction = this.withRecord(transaction, record);
      this.writeTransaction(transaction);
      writeJsonAtomically(this.registryPath, afterRegistry);
      this.appendTransactionEvent(transaction);
      this.removeTransaction(transaction);
      return {
        pointerVersion: 'clue-active-project-pointer/1',
        projectId: id,
        targetRootIdentity: record.profile.targetRootIdentity,
        projectProfileHash: record.projectProfileHash,
        profileGeneration: record.generation,
        registryGeneration: afterRegistry.generation,
        activatedAt,
      };
    });
  }

  /** Compatibility alias for the pre-runtime-manager migration path. */
  public setLegacyActivePointer(projectId: string): ProjectProfileRegistryState {
    this.activate(projectId, { actor: 'creator', reason: 'legacy profile migration activation' });
    return this.readState();
  }

  public verifyIntegrity(): void {
    const state = this.readState();
    for (const entry of state.projects) {
      const record = this.store.require(entry.projectId);
      if (record.profile.targetRootIdentity !== entry.targetRootIdentity) {
        throw new ProfileRegistryError('REGISTRY_INTEGRITY_FAILED', `Registry target identity for ${entry.projectId} does not match the stored profile.`, { projectId: entry.projectId });
      }
      try {
        const resolved = resolvePathIdentity(record.profile.targetRoot, { zone: 'target', expectedKind: 'directory' });
        assertPathIdentity(entry.targetRootIdentity, resolved, `${entry.projectId} physical target root`);
      } catch (error) {
        throw new ProfileRegistryError('REGISTRY_INTEGRITY_FAILED', `Registered physical Target Root for ${entry.projectId} is unavailable or changed: ${(error as Error).message}`, { projectId: entry.projectId });
      }
    }
    if (state.activeProjectId !== null) this.getProfileFromState(state, state.activeProjectId);
  }

  public recover(): void {
    withExclusiveFileLock(this.lockPath, () => this.recoverLocked());
  }

  /** Holds the saved generation stable during an external workspace operation. */
  public withStableProfile<T>(projectId: string, work: (record: ProjectProfileRecord) => T): T {
    return withExclusiveFileLock(this.lockPath, () => {
      if (readdirSync(this.transactionsDir).some((name) => name.endsWith('.json'))) {
        throw new ProfileRegistryError('REGISTRY_INTEGRITY_FAILED', 'Recover the pending Project Profile transaction before initializing a workspace.');
      }
      return work(this.getProfile(projectId));
    });
  }

  private getProfileFromState(state: ProjectProfileRegistryState, projectId: string): ProjectProfileRecord {
    if (!state.projects.some((entry) => entry.projectId === projectId)) {
      throw new ProfileRegistryError('PROJECT_NOT_REGISTERED', `Project ${projectId} is not registered.`, { projectId });
    }
    return this.store.require(projectId);
  }

  private recoverLocked(): void {
    if (!existsSync(this.transactionsDir)) return;
    for (const fileName of readdirSync(this.transactionsDir).sort()) {
      if (!fileName.endsWith('.json')) continue;
      const path = join(this.transactionsDir, fileName);
      const transaction = profileTransactionSchema.parse(readJsonFile(path));
      const record = this.store.read(transaction.projectId);

      if (transaction.operation === 'create') {
        if (record === null) { removeFileDurably(path); continue; }
        this.assertTransactionRecord(transaction, record);
        writeJsonAtomically(this.registryPath, transaction.afterRegistry);
        this.appendTransactionEvent(this.withRecord(transaction, record));
        removeFileDurably(path);
        continue;
      }
      if (transaction.operation === 'delete') {
        writeJsonAtomically(this.registryPath, transaction.afterRegistry);
        if (record !== null) {
          if (transaction.previousGeneration === null || record.generation !== transaction.previousGeneration) {
            throw new ProfileRegistryError('REGISTRY_INTEGRITY_FAILED', `Delete transaction ${transaction.transactionId} refuses to remove successor generation ${record.generation}.`, { projectId: transaction.projectId });
          }
          this.store.delete(transaction.projectId, record.generation, { projectId: transaction.projectId, deleteProfileDataOnly: true });
        }
        this.appendTransactionEvent(transaction);
        removeFileDurably(path);
        continue;
      }
      if (transaction.operation === 'activate') {
        if (record === null) throw new ProfileRegistryError('REGISTRY_INTEGRITY_FAILED', `Activation transaction ${transaction.transactionId} lost its profile.`, { projectId: transaction.projectId });
        this.assertTransactionRecord(transaction, record);
        writeJsonAtomically(this.registryPath, transaction.afterRegistry);
        this.appendTransactionEvent(this.withRecord(transaction, record));
        removeFileDurably(path);
        continue;
      }
      // Update: if the successor exists, finish registry visibility and event; otherwise abandon.
      if (record !== null && transaction.previousGeneration !== null && record.generation === transaction.previousGeneration + 1) {
        writeJsonAtomically(this.registryPath, transaction.afterRegistry);
        this.appendTransactionEvent(this.withRecord(transaction, record));
      } else if (record !== null && transaction.previousGeneration !== null && record.generation > transaction.previousGeneration + 1) {
        throw new ProfileRegistryError('REGISTRY_INTEGRITY_FAILED', `Update transaction ${transaction.transactionId} is stale behind generation ${record.generation}.`, { projectId: transaction.projectId });
      }
      removeFileDurably(path);
    }
  }

  private makeTransaction(input: {
    readonly operation: ProfileTransaction['operation'];
    readonly options: ProjectProfileMutationOptions;
    readonly profile: ProjectProfile;
    readonly afterRegistry: ProjectProfileRegistryState;
    readonly previous?: ProjectProfileRecord;
  }): ProfileTransaction {
    return profileTransactionSchema.parse({
      transactionVersion: PROJECT_PROFILE_TRANSACTION_VERSION,
      transactionId: `PROFILE-TX-${randomUUID()}`,
      operation: input.operation,
      actor: input.options.actor,
      reason: input.options.reason ?? null,
      projectId: input.profile.projectId,
      targetRootIdentity: input.profile.targetRootIdentity,
      createdAt: this.now(),
      afterRegistry: input.afterRegistry,
      previousGeneration: input.previous?.generation ?? null,
      previousProfileHash: input.previous?.projectProfileHash ?? null,
      previousAuthorityHash: input.previous === undefined ? null : computeProjectAuthorityHash(input.previous.profile),
      generation: null,
      projectProfileHash: null,
      authorityHash: null,
    });
  }

  private withRecord(transaction: ProfileTransaction, record: ProjectProfileRecord): ProfileTransaction {
    return profileTransactionSchema.parse({
      ...transaction,
      generation: record.generation,
      projectProfileHash: record.projectProfileHash,
      authorityHash: computeProjectAuthorityHash(record.profile),
    });
  }

  private assertTransactionRecord(transaction: ProfileTransaction, record: ProjectProfileRecord): void {
    if (transaction.generation !== null && transaction.generation !== record.generation) {
      throw new ProfileRegistryError('REGISTRY_INTEGRITY_FAILED', `Transaction ${transaction.transactionId} generation mismatch.`, { projectId: transaction.projectId });
    }
    if (transaction.projectProfileHash !== null && transaction.projectProfileHash !== record.projectProfileHash) {
      throw new ProfileRegistryError('REGISTRY_INTEGRITY_FAILED', `Transaction ${transaction.transactionId} profile hash mismatch.`, { projectId: transaction.projectId });
    }
  }

  private transactionPath(transaction: ProfileTransaction): string {
    return join(this.transactionsDir, `${transaction.transactionId}.json`);
  }
  private writeTransaction(transaction: ProfileTransaction): void {
    writeJsonAtomically(this.transactionPath(transaction), transaction);
  }
  private removeTransaction(transaction: ProfileTransaction): void {
    removeFileDurably(this.transactionPath(transaction));
  }

  private appendTransactionEvent(transaction: ProfileTransaction): void {
    let type: ProfileEventInput['type'];
    if (transaction.operation === 'create') type = 'project-profile.created';
    else if (transaction.operation === 'update') type = 'project-profile.updated';
    else if (transaction.operation === 'delete') type = 'project-profile.deleted';
    else type = 'project-profile.activated';
    this.eventLog.append({
      transactionId: transaction.transactionId,
      type,
      actor: transaction.actor,
      projectId: transaction.projectId,
      targetRootIdentity: transaction.targetRootIdentity,
      previousGeneration: transaction.previousGeneration,
      generation: transaction.generation,
      previousProfileHash: transaction.previousProfileHash,
      projectProfileHash: transaction.projectProfileHash,
      previousAuthorityHash: transaction.previousAuthorityHash,
      authorityHash: transaction.authorityHash,
      registryGeneration: transaction.afterRegistry.generation,
      reasonCode: null,
    });
  }
}
