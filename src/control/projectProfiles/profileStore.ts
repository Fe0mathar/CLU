/** Atomic, versioned Project Profile store for clue-project-profile-record/1. */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { nowIso } from '../../shared/ids.js';
import {
  PROJECT_PROFILE_RECORD_VERSION,
  projectIdSchema,
  projectProfileRecordSchema,
  type ProjectProfile,
  type ProjectProfileRecord,
} from '../../shared/schemas.js';
import {
  canonicalizeProjectProfile,
  type ProjectProfileCanonicalizationOptions,
} from './profileCanonicalization.js';
import { computeProjectProfileHash } from './profileHash.js';
import {
  ProfilePersistenceError,
  readJsonFile,
  removeFileDurably,
  withExclusiveFileLock,
  writeJsonAtomically,
} from './profileFileSystem.js';

export type { ProjectProfileRecord } from '../../shared/schemas.js';

export interface ProjectProfileMetadata {
  readonly projectId: string;
  readonly displayName: string | null;
  readonly targetRoot: string;
  readonly targetRootIdentity: string;
  readonly generation: number;
  readonly projectProfileHash: string;
  readonly updatedAt: string;
  readonly profilePath: string;
}

export type ProfileStoreErrorCode =
  | 'READ_ONLY'
  | 'PROFILE_EXISTS'
  | 'PROFILE_NOT_FOUND'
  | 'GENERATION_CONFLICT'
  | 'PROFILE_INTEGRITY_FAILED'
  | 'DELETE_CONFIRMATION_REQUIRED'
  | 'INVALID_PROFILE';

export class ProfileStoreError extends Error {
  public readonly code: ProfileStoreErrorCode;
  public readonly projectId: string | null;
  public readonly currentGeneration: number | null;

  public constructor(
    code: ProfileStoreErrorCode,
    message: string,
    projectId: string | null = null,
    currentGeneration: number | null = null,
  ) {
    super(message);
    this.name = 'ProfileStoreError';
    this.code = code;
    this.projectId = projectId;
    this.currentGeneration = currentGeneration;
  }
}

export interface ProjectProfileStoreOptions extends ProjectProfileCanonicalizationOptions {
  readonly readOnly?: boolean;
  readonly now?: () => string;
}

export interface DeleteProfileConfirmation {
  readonly projectId: string;
  readonly deleteProfileDataOnly: true;
}

export class ProjectProfileStore {
  public readonly root: string;
  public readonly profilesDir: string;
  private readonly locksDir: string;
  private readonly readOnly: boolean;
  private readonly now: () => string;

  public constructor(profilesRoot: string, options: ProjectProfileStoreOptions = {}) {
    this.root = profilesRoot;
    this.profilesDir = join(profilesRoot, 'profiles');
    this.locksDir = join(profilesRoot, '.locks');
    this.readOnly = options.readOnly === true;
    this.now = options.now ?? nowIso;
    if (!this.readOnly) {
      mkdirSync(this.profilesDir, { recursive: true });
      mkdirSync(this.locksDir, { recursive: true });
    }
  }

  public pathFor(projectId: string): string {
    return join(this.profilesDir, `${projectIdSchema.parse(projectId)}.json`);
  }

  public has(projectId: string): boolean {
    return existsSync(this.pathFor(projectId));
  }

  public read(projectId: string): ProjectProfileRecord | null {
    const id = projectIdSchema.parse(projectId);
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    let record: ProjectProfileRecord;
    try {
      record = projectProfileRecordSchema.parse(readJsonFile(path));
    } catch (error) {
      if (error instanceof ProfilePersistenceError) throw error;
      throw new ProfileStoreError(
        'INVALID_PROFILE',
        `Stored Project Profile ${id} is malformed: ${(error as Error).message}`,
        id,
      );
    }
    if (record.profile.projectId !== id) {
      throw new ProfileStoreError(
        'PROFILE_INTEGRITY_FAILED',
        `Profile file ${path} declares projectId ${record.profile.projectId}.`,
        id,
      );
    }
    const actual = computeProjectProfileHash(record.profile);
    if (actual !== record.projectProfileHash) {
      throw new ProfileStoreError(
        'PROFILE_INTEGRITY_FAILED',
        `Stored Project Profile ${id} hash mismatch: expected ${record.projectProfileHash}, computed ${actual}.`,
        id,
        record.generation,
      );
    }
    return record;
  }

  public require(projectId: string): ProjectProfileRecord {
    const record = this.read(projectId);
    if (record === null) {
      throw new ProfileStoreError(
        'PROFILE_NOT_FOUND',
        `Project Profile ${projectId} is not registered in the profile store.`,
        projectId,
      );
    }
    return record;
  }

  public listMetadata(): readonly ProjectProfileMetadata[] {
    if (!existsSync(this.profilesDir)) return [];
    return readdirSync(this.profilesDir)
      .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
      .sort()
      .map((name) => this.require(name.slice(0, -'.json'.length)))
      .map((record) => ({
        projectId: record.profile.projectId,
        displayName: record.profile.displayName,
        targetRoot: record.profile.targetRoot,
        targetRootIdentity: record.profile.targetRootIdentity,
        generation: record.generation,
        projectProfileHash: record.projectProfileHash,
        updatedAt: record.updatedAt,
        profilePath: this.pathFor(record.profile.projectId),
      }));
  }

  public create(profileInput: ProjectProfile | unknown, createdAt?: string): ProjectProfileRecord {
    this.assertWritable();
    const profile = canonicalizeProjectProfile(profileInput);
    const lockPath = join(this.locksDir, `${profile.projectId}.lock`);
    return withExclusiveFileLock(lockPath, () => {
      if (this.has(profile.projectId)) {
        throw new ProfileStoreError(
          'PROFILE_EXISTS',
          `Project Profile ${profile.projectId} already exists.`,
          profile.projectId,
        );
      }
      const timestamp = createdAt ?? this.now();
      const record = projectProfileRecordSchema.parse({
        recordVersion: PROJECT_PROFILE_RECORD_VERSION,
        generation: 1,
        projectProfileHash: computeProjectProfileHash(profile),
        createdAt: timestamp,
        updatedAt: timestamp,
        profile,
      });
      writeJsonAtomically(this.pathFor(profile.projectId), record, { createOnly: true });
      return record;
    });
  }

  public update(
    profileInput: ProjectProfile | unknown,
    expectedGeneration: number,
    updatedAt?: string,
  ): ProjectProfileRecord;
  public update(
    projectId: string,
    profileInput: ProjectProfile | unknown,
    expectedGeneration: number,
    updatedAt?: string,
  ): ProjectProfileRecord;
  public update(
    first: string | ProjectProfile | unknown,
    second: ProjectProfile | unknown | number,
    third?: number | string,
    fourth?: string,
  ): ProjectProfileRecord {
    this.assertWritable();
    const legacySignature = typeof first === 'string';
    const profileInput = legacySignature ? second : first;
    const expectedGeneration = legacySignature ? third : second;
    const updatedAt = legacySignature ? fourth : third;
    if (typeof expectedGeneration !== 'number') {
      throw new ProfileStoreError('INVALID_PROFILE', 'Expected one numeric profile generation.');
    }
    const profile = canonicalizeProjectProfile(profileInput);
    const projectId = legacySignature ? projectIdSchema.parse(first) : profile.projectId;
    if (profile.projectId !== projectId) {
      throw new ProfileStoreError(
        'INVALID_PROFILE',
        `Profile projectId ${profile.projectId} does not match requested ${projectId}.`,
        projectId,
      );
    }
    const lockPath = join(this.locksDir, `${projectId}.lock`);
    return withExclusiveFileLock(lockPath, () => {
      const previous = this.require(projectId);
      if (previous.generation !== expectedGeneration) {
        throw new ProfileStoreError(
          'GENERATION_CONFLICT',
          `Project Profile ${projectId} generation is ${previous.generation}, expected ${expectedGeneration}.`,
          projectId,
          previous.generation,
        );
      }
      const record = projectProfileRecordSchema.parse({
        recordVersion: PROJECT_PROFILE_RECORD_VERSION,
        generation: previous.generation + 1,
        projectProfileHash: computeProjectProfileHash(profile),
        createdAt: previous.createdAt,
        updatedAt: typeof updatedAt === 'string' ? updatedAt : this.now(),
        profile,
      });
      writeJsonAtomically(this.pathFor(projectId), record);
      return record;
    });
  }

  public delete(
    projectId: string,
    expectedGeneration: number,
    confirmation: DeleteProfileConfirmation,
  ): void {
    this.assertWritable();
    const id = projectIdSchema.parse(projectId);
    if (confirmation.projectId !== id || confirmation.deleteProfileDataOnly !== true) {
      throw new ProfileStoreError(
        'DELETE_CONFIRMATION_REQUIRED',
        `Deleting Project Profile ${id} requires exact profile-only confirmation.`,
        id,
      );
    }
    withExclusiveFileLock(join(this.locksDir, `${id}.lock`), () => {
      const record = this.require(id);
      if (record.generation !== expectedGeneration) {
        throw new ProfileStoreError(
          'GENERATION_CONFLICT',
          `Project Profile ${id} generation is ${record.generation}, expected ${expectedGeneration}.`,
          id,
          record.generation,
        );
      }
      removeFileDurably(this.pathFor(id));
    });
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new ProfileStoreError('READ_ONLY', 'Project Profile store is attached read-only.');
    }
  }
}
