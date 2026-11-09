/**
 * Explicit Configuration-v3 selector for Project Profile startup.
 *
 * The existing configuration-v2 file remains the installation/global-default authority. The
 * selector is a small, separately versioned cutover receipt that makes the active Project Profile
 * registry authoritative for target-specific roots and state. Its absence means legacy-v2 mode;
 * normal startup never creates it or migrates a workspace implicitly.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import { hashBytes, nowIso } from '../../shared/ids.js';
import {
  PROJECT_PROFILE_HASH_VERSION,
  absolutePathForm,
  isoTimestampSchema,
  projectIdSchema,
  projectProfileHashSchema,
  sha256Schema,
  type Actor,
  type ProjectProfileRecord,
} from '../../shared/schemas.js';
import {
  removeFileDurably,
  writeBytesAtomically,
  writeTextAtomically,
} from './profileFileSystem.js';
import { assertProjectProfileHash } from './profileHash.js';
import {
  projectProfileRegistrySchema,
  ProjectProfileRegistry,
  type ActiveProjectPointer,
} from './profileRegistry.js';
import { ProjectProfileStore } from './profileStore.js';

export const PROJECT_PROFILE_STARTUP_VERSION = 3 as const;
export const PROJECT_PROFILE_STARTUP_RELATIVE_PATH = join('config', 'project-profiles.yaml');

export const projectProfileStartupSchema = z
  .object({
    version: z.literal(PROJECT_PROFILE_STARTUP_VERSION),
    mode: z.literal('project-profile'),
    profiles: z
      .object({
        registry_root: z.string().min(1),
        active_pointer: z.literal('registry'),
      })
      .strict(),
    cutover: z
      .object({
        project_id: projectIdSchema,
        project_profile_hash: projectProfileHashSchema,
        profile_generation: z.number().int().positive(),
        registry_generation: z.number().int().positive(),
        legacy_config_sha256: sha256Schema,
        legacy_backup: z.string().min(1),
        activated_at: isoTimestampSchema,
        recorded_at: isoTimestampSchema,
        recorded_by: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export type ProjectProfileStartup = z.infer<typeof projectProfileStartupSchema>;

export type ProjectProfileStartupErrorCode =
  | 'STARTUP_SELECTOR_MALFORMED'
  | 'STARTUP_REGISTRY_PATH_FOREIGN'
  | 'STARTUP_ACTIVE_PROFILE_MISSING'
  | 'STARTUP_POINTER_STALE'
  | 'CUTOVER_ALREADY_ENABLED'
  | 'CUTOVER_CONFIRMATION_REQUIRED'
  | 'LEGACY_CONFIG_MISSING'
  | 'CUTOVER_BACKUP_MISMATCH';

export class ProjectProfileStartupError extends Error {
  public constructor(
    public readonly code: ProjectProfileStartupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectProfileStartupError';
  }
}

export interface ActiveStartupProfile {
  readonly selector: ProjectProfileStartup;
  readonly selectorPath: string;
  readonly registry: ProjectProfileRegistry;
  readonly pointer: ActiveProjectPointer;
  readonly record: ProjectProfileRecord;
}

export interface ProjectProfileCutoverOptions {
  readonly repoRoot: string;
  readonly registry: ProjectProfileRegistry;
  readonly projectId: string;
  readonly confirmation: string;
  readonly actor?: Actor;
  readonly now?: () => string;
  readonly verifyWorkspace?: (record: ProjectProfileRecord) => void;
}

export interface ProjectProfileCutoverResult {
  readonly state: 'enabled';
  readonly selectorPath: string;
  readonly backupPath: string;
  readonly selector: ProjectProfileStartup;
  readonly record: ProjectProfileRecord;
  readonly pointer: ActiveProjectPointer;
}

export function projectProfileStartupPath(repoRoot: string): string {
  return join(repoRoot, PROJECT_PROFILE_STARTUP_RELATIVE_PATH);
}

/** Returns null only when Configuration-v3 has not been enabled. */
export function loadProjectProfileStartup(repoRoot: string): ProjectProfileStartup | null {
  const path = projectProfileStartupPath(repoRoot);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ProjectProfileStartupError(
      'STARTUP_SELECTOR_MALFORMED',
      `Cannot parse ${path}: ${(error as Error).message}`,
    );
  }
  const result = projectProfileStartupSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProjectProfileStartupError(
      'STARTUP_SELECTOR_MALFORMED',
      `Configuration-v3 selector ${path} is invalid: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Resolve the configured registry root under host path rules. A path that is absolute only on
 * another platform is refused rather than being joined below the repository root.
 */
export function resolveProjectProfilesRoot(repoRoot: string, configured: string): string {
  if (isAbsolute(configured)) return resolve(configured);
  const form = absolutePathForm(configured);
  if (form !== null) {
    throw new ProjectProfileStartupError(
      'STARTUP_REGISTRY_PATH_FOREIGN',
      `Project Profile registry root ${JSON.stringify(configured)} is absolute under ${form} rules but cannot be resolved on ${process.platform}.`,
    );
  }
  return resolve(repoRoot, configured);
}

/** Default used before cutover; explicit --profiles-root may override it. */
export function defaultProjectProfilesRoot(workspaceRoot: string): string {
  return resolve(dirname(dirname(workspaceRoot)), 'profiles');
}

export function configuredProjectProfilesRoot(
  repoRoot: string,
  legacyWorkspaceRoot: string,
  override?: string,
): string {
  if (override !== undefined) return resolveProjectProfilesRoot(repoRoot, override);
  const selector = loadProjectProfileStartup(repoRoot);
  if (selector !== null) {
    return resolveProjectProfilesRoot(repoRoot, selector.profiles.registry_root);
  }
  return defaultProjectProfilesRoot(legacyWorkspaceRoot);
}

/**
 * Loads and re-verifies the one active startup profile. The selector, registry pointer and record
 * must agree exactly; a newer profile generation requires an explicit activation before startup.
 */
export function loadActiveProjectProfileForStartup(repoRoot: string): ActiveStartupProfile | null {
  const selector = loadProjectProfileStartup(repoRoot);
  if (selector === null) return null;
  const selectorPath = projectProfileStartupPath(repoRoot);
  const registryRoot = resolveProjectProfilesRoot(repoRoot, selector.profiles.registry_root);
  const registry = new ProjectProfileRegistry(registryRoot);
  registry.recover();
  registry.verifyIntegrity();
  const pointer = registry.active();
  if (pointer === null) {
    throw new ProjectProfileStartupError(
      'STARTUP_ACTIVE_PROFILE_MISSING',
      `Configuration-v3 is enabled by ${selectorPath}, but the Project Profile registry has no active project.`,
    );
  }
  const record = registry.getProfile(pointer.projectId);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  if (!pointerMatchesRecord(pointer, record)) {
    throw new ProjectProfileStartupError(
      'STARTUP_POINTER_STALE',
      `Active Project Profile pointer for ${pointer.projectId} does not match the durable profile generation. Re-activate the project explicitly.`,
    );
  }
  return Object.freeze({ selector, selectorPath, registry, pointer, record });
}

/** Observe the active profile without creating registry directories or recovering a transaction. */
export function readActiveProjectProfileForBenchmark(repoRoot: string): ProjectProfileRecord | null {
  const selector = loadProjectProfileStartup(repoRoot);
  if (selector === null) return null;
  const root = resolveProjectProfilesRoot(repoRoot, selector.profiles.registry_root);
  const registryPath = join(root, 'registry.json');
  const transactions = join(root, '.transactions');
  const hasPendingTransaction = (): boolean =>
    existsSync(transactions) && readdirSync(transactions).some((name) => name.endsWith('.json'));
  const unstable = () => new ProjectProfileStartupError(
    'STARTUP_POINTER_STALE',
    'The active Project Profile is changing. Finish or recover its transaction before benchmarking.',
  );
  if (hasPendingTransaction()) throw unstable();
  const bytes = readFileSync(registryPath);
  const registry = projectProfileRegistrySchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  if (registry.activeProjectId === null) {
    throw new ProjectProfileStartupError(
      'STARTUP_ACTIVE_PROFILE_MISSING',
      'Configuration-v3 is enabled, but the Project Profile registry has no active project.',
    );
  }
  const record = new ProjectProfileStore(root, { readOnly: true }).require(registry.activeProjectId);
  const entry = registry.projects.find(({ projectId }) => projectId === record.profile.projectId);
  if (entry?.targetRootIdentity !== record.profile.targetRootIdentity ||
      !bytes.equals(readFileSync(registryPath)) || hasPendingTransaction()) {
    throw unstable();
  }
  return record;
}

function pointerMatchesRecord(pointer: ActiveProjectPointer, record: ProjectProfileRecord): boolean {
  return pointer.projectId === record.profile.projectId &&
    pointer.projectProfileHash === record.projectProfileHash &&
    pointer.profileGeneration === record.generation &&
    pointer.targetRootIdentity === record.profile.targetRootIdentity;
}

export function projectProfileCutoverConfirmation(record: ProjectProfileRecord): string {
  const digestOffset = PROJECT_PROFILE_HASH_VERSION.length + 1;
  const digestPrefix = record.projectProfileHash.slice(digestOffset, digestOffset + 12);
  return `CUTOVER ${record.profile.projectId} ${record.generation} ${digestPrefix}`;
}

/**
 * Enables explicit profile startup. The caller can check the exact workspace in read-only mode
 * before publication. This operation preserves the legacy configuration byte-for-byte.
 */
export function enableProjectProfileStartup(
  options: ProjectProfileCutoverOptions,
): ProjectProfileCutoverResult {
  const now = options.now ?? nowIso;
  const selectorPath = projectProfileStartupPath(options.repoRoot);
  if (existsSync(selectorPath)) {
    throw new ProjectProfileStartupError(
      'CUTOVER_ALREADY_ENABLED',
      `Configuration-v3 selector already exists at ${selectorPath}.`,
    );
  }
  options.registry.recover();
  options.registry.verifyIntegrity();
  const record = options.registry.getProfile(options.projectId);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  const expected = projectProfileCutoverConfirmation(record);
  if (options.confirmation !== expected) {
    throw new ProjectProfileStartupError(
      'CUTOVER_CONFIRMATION_REQUIRED',
      `Configuration-v3 cutover requires exact confirmation: ${expected}`,
    );
  }

  const legacyConfigPath = join(options.repoRoot, 'config', 'clue.config.yaml');
  if (!existsSync(legacyConfigPath)) {
    throw new ProjectProfileStartupError(
      'LEGACY_CONFIG_MISSING',
      `Legacy installation configuration is missing: ${legacyConfigPath}`,
    );
  }
  const legacyBytes = readFileSync(legacyConfigPath);
  options.verifyWorkspace?.(record);
  const verified = options.registry.getProfile(record.profile.projectId);
  if (verified.generation !== record.generation || verified.projectProfileHash !== record.projectProfileHash ||
    !readFileSync(legacyConfigPath).equals(legacyBytes)) {
    throw new ProjectProfileStartupError(
      'STARTUP_POINTER_STALE',
      'Project Profile or installation configuration changed during cutover verification. Read and verify the current state.',
    );
  }
  const legacyHash = hashBytes(legacyBytes);
  const backupRelative = join('config', 'backups', `clue.config.v2.${legacyHash.slice(0, 12)}.yaml`)
    .replace(/\\/gu, '/');
  const backupPath = join(options.repoRoot, ...backupRelative.split('/'));
  mkdirSync(dirname(backupPath), { recursive: true });
  if (existsSync(backupPath)) {
    const existing = readFileSync(backupPath);
    if (!existing.equals(legacyBytes)) {
      throw new ProjectProfileStartupError(
        'CUTOVER_BACKUP_MISMATCH',
        `Existing legacy backup ${backupPath} does not match config/clue.config.yaml.`,
      );
    }
  } else {
    writeBytesAtomically(backupPath, legacyBytes, { createOnly: true });
  }

  const previous = options.registry.active();
  let pointer: ActiveProjectPointer | null = null;
  let publishedText: string | null = null;
  try {
    pointer = options.registry.activate(record.profile.projectId, {
      actor: options.actor ?? 'creator',
      reason: 'CONFIGURATION_V3_CUTOVER',
    }, record);
    if (!pointerMatchesRecord(pointer, record)) {
      throw new ProjectProfileStartupError('STARTUP_POINTER_STALE', 'Cutover activated a different Project Profile generation.');
    }
    const recordedAt = now();
    const selector = projectProfileStartupSchema.parse({
      version: PROJECT_PROFILE_STARTUP_VERSION,
      mode: 'project-profile',
      profiles: {
        registry_root: options.registry.root.replace(/\\/gu, '/'),
        active_pointer: 'registry',
      },
      cutover: {
        project_id: record.profile.projectId,
        project_profile_hash: record.projectProfileHash,
        profile_generation: record.generation,
        registry_generation: pointer.registryGeneration,
        legacy_config_sha256: legacyHash,
        legacy_backup: backupRelative,
        activated_at: pointer.activatedAt,
        recorded_at: recordedAt,
        recorded_by: options.actor ?? 'creator',
      },
    });
    const selectorText = stringifyYaml(selector, { lineWidth: 0 });
    writeTextAtomically(selectorPath, selectorText, { createOnly: true });
    publishedText = selectorText;
    const loaded = loadActiveProjectProfileForStartup(options.repoRoot);
    if (loaded === null || !pointerMatchesRecord(loaded.pointer, record) ||
      loaded.pointer.registryGeneration !== pointer.registryGeneration || loaded.pointer.activatedAt !== pointer.activatedAt) {
      throw new ProjectProfileStartupError(
        'STARTUP_POINTER_STALE',
        'Configuration-v3 cutover verification did not resolve the requested active project.',
      );
    }
    return Object.freeze({
      state: 'enabled' as const,
      selectorPath,
      backupPath,
      selector,
      record,
      pointer,
    });
  } catch (error) {
    if (publishedText !== null && existsSync(selectorPath) && readFileSync(selectorPath, 'utf8') === publishedText) {
      removeFileDurably(selectorPath);
    }
    if (previous !== null && pointer !== null && previous.projectId !== pointer.projectId) {
      try {
        options.registry.activate(previous.projectId, {
          actor: options.actor ?? 'creator',
          reason: 'CONFIGURATION_V3_CUTOVER_ROLLBACK',
        }, {
          generation: previous.profileGeneration,
          projectProfileHash: previous.projectProfileHash,
          registryGeneration: pointer.registryGeneration,
        });
      } catch {
        // Preserve the cutover failure and any intervening registry mutation.
      }
    }
    throw error;
  }
}

/** Explicit rollback to legacy-v2 startup; Project Profile data and history remain untouched. */
export function disableProjectProfileStartup(repoRoot: string): boolean {
  const path = projectProfileStartupPath(repoRoot);
  if (!existsSync(path)) return false;
  removeFileDurably(path);
  // Remove an abandoned temporary selector from interrupted manual recovery, if present.
  rmSync(`${path}.pending`, { force: true });
  return true;
}
