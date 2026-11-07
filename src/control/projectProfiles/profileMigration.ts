/**
 * Explicit, fail-closed migration from configuration-v2's one active target into one
 * clue-project-profile/1 record. Normal startup never invokes this module.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { hashBytes, nowIso } from '../../shared/ids.js';
import {
  asTargetRootIdentity,
  assertPathZonesDisjoint,
  normalisePathForStorage,
  resolvePathIdentity,
} from '../../shared/pathIdentity.js';
import {
  absolutePathForm,
  clueConfigSchema,
  PROJECT_PROFILE_VERSION,
  projectIdSchema,
  projectProfileSchema,
  targetProfileSchema,
  type Actor,
  type ClueConfig,
  type GovernedDocumentBinding,
  type MasterBenchmarkBinding,
  type ProjectProfile,
  type ProjectProfileRecord,
  type TargetProfile,
} from '../../shared/schemas.js';
import { computeProjectProfileHash } from './profileHash.js';
import { ProfileRegistryError, ProjectProfileRegistry } from './profileRegistry.js';

const routingSchema = z
  .object({
    provider: z.literal('openai'),
    routes: z.record(z.object({ enabled: z.boolean(), model: z.string().min(1) }).passthrough()),
  })
  .passthrough();

const legacySelectorSchema = z
  .object({ project: z.object({ active_target: z.string().min(1) }).passthrough() })
  .passthrough();

export type ProjectProfileMigrationErrorCode =
  | 'LEGACY_CONFIG_MISSING'
  | 'LEGACY_CONFIG_MALFORMED'
  | 'ACTIVE_TARGET_INVALID'
  | 'PATH_PLATFORM_MISMATCH'
  | 'LEGACY_PROFILE_MISSING'
  | 'LEGACY_PROFILE_MALFORMED'
  | 'ACTIVE_TARGET_MISMATCH'
  | 'TARGET_ROOT_UNAVAILABLE'
  | 'WORKSPACE_UNAVAILABLE'
  | 'SHADOW_UNAVAILABLE'
  | 'ROOT_ZONE_OVERLAP'
  | 'AUTHORITY_DOCUMENT_MISSING'
  | 'ROUTING_MISSING'
  | 'ROUTING_MALFORMED'
  | 'MODEL_ID_AMBIGUOUS'
  | 'PUBLICATION_STATE_AMBIGUOUS'
  | 'MIGRATION_CONFLICT';

export class ProjectProfileMigrationError extends Error {
  public readonly code: ProjectProfileMigrationErrorCode;
  public readonly path: string | null;
  public constructor(code: ProjectProfileMigrationErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = 'ProjectProfileMigrationError';
    this.code = code;
    this.path = path;
  }
}

export interface LegacyProjectProfileMigrationOptions {
  readonly repoRoot: string;
  readonly registry: ProjectProfileRegistry;
  readonly actor?: Actor;
  readonly now?: () => string;
  readonly configPath?: string;
}

export interface LegacyProjectProfileMigrationResult {
  readonly state: 'created' | 'unchanged';
  readonly registered: ProjectProfileRecord;
  readonly sourceConfigPath: string;
  readonly sourceConfigHash: string;
  readonly sourceProfilePath: string;
  readonly sourceProfileHash: string;
}

interface LegacyInputs {
  readonly config: ClueConfig;
  readonly profile: TargetProfile;
  readonly configPath: string;
  readonly configBytes: Buffer;
  readonly profilePath: string;
  readonly profileBytes: Buffer;
}

function resolveConfiguredPath(value: string, base: string): string {
  const absoluteForm = absolutePathForm(value);
  if (absoluteForm !== null && !isAbsolute(value)) {
    throw new ProjectProfileMigrationError(
      'PATH_PLATFORM_MISMATCH',
      `Configured path ${JSON.stringify(value)} is absolute under ${absoluteForm} rules but cannot be resolved on ${process.platform}.`,
      value,
    );
  }
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function parseYamlFile(path: string, missingCode: 'LEGACY_CONFIG_MISSING' | 'LEGACY_PROFILE_MISSING'): { readonly bytes: Buffer; readonly parsed: unknown } {
  if (!existsSync(path)) throw new ProjectProfileMigrationError(missingCode, `Required migration source is missing: ${path}`, path);
  const bytes = readFileSync(path);
  try {
    return { bytes, parsed: parseYaml(bytes.toString('utf8')) as unknown };
  } catch (error) {
    throw new ProjectProfileMigrationError(
      missingCode === 'LEGACY_CONFIG_MISSING' ? 'LEGACY_CONFIG_MALFORMED' : 'LEGACY_PROFILE_MALFORMED',
      `Cannot parse YAML migration source ${path}: ${(error as Error).message}`,
      path,
    );
  }
}

function readLegacyInputs(repoRoot: string, configPath: string): LegacyInputs {
  const configSource = parseYamlFile(configPath, 'LEGACY_CONFIG_MISSING');
  const selector = legacySelectorSchema.safeParse(configSource.parsed);
  if (!selector.success) {
    throw new ProjectProfileMigrationError('LEGACY_CONFIG_MALFORMED', `Legacy configuration does not contain one valid project.active_target: ${selector.error.message}`, configPath);
  }
  const activeTarget = selector.data.project.active_target;
  if (!projectIdSchema.safeParse(activeTarget).success) {
    throw new ProjectProfileMigrationError('ACTIVE_TARGET_INVALID', `Legacy active_target ${JSON.stringify(activeTarget)} is not a canonical Project ID. Migration never silently renames IDs.`, configPath);
  }

  const profilePath = join(repoRoot, 'targets', activeTarget, 'profile.yaml');
  const profileSource = parseYamlFile(profilePath, 'LEGACY_PROFILE_MISSING');
  const profileResult = targetProfileSchema.safeParse(profileSource.parsed);
  if (!profileResult.success) {
    throw new ProjectProfileMigrationError('LEGACY_PROFILE_MALFORMED', `Legacy target profile is invalid: ${profileResult.error.message}`, profilePath);
  }
  if (profileResult.data.id !== activeTarget) {
    throw new ProjectProfileMigrationError('ACTIVE_TARGET_MISMATCH', `Legacy selector names ${activeTarget}, but ${profilePath} declares ${profileResult.data.id}.`, profilePath);
  }

  const rawConfig = configSource.parsed as Record<string, unknown>;
  const resolvedConfig = { ...rawConfig, project: { ...profileResult.data, active_target: activeTarget } };
  const configResult = clueConfigSchema.safeParse(resolvedConfig);
  if (!configResult.success) {
    throw new ProjectProfileMigrationError('LEGACY_CONFIG_MALFORMED', `Resolved legacy configuration is invalid: ${configResult.error.message}`, configPath);
  }
  return {
    config: configResult.data,
    profile: profileResult.data,
    configPath,
    configBytes: configSource.bytes,
    profilePath,
    profileBytes: profileSource.bytes,
  };
}

function exactModelId(repoRoot: string, config: ClueConfig): string {
  const routingPath = resolveConfiguredPath(config.gateway.routing_file, repoRoot);
  if (!existsSync(routingPath)) throw new ProjectProfileMigrationError('ROUTING_MISSING', `Configured GPT routing policy is missing: ${routingPath}`, routingPath);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(routingPath, 'utf8')) as unknown;
  } catch (error) {
    throw new ProjectProfileMigrationError('ROUTING_MALFORMED', `Cannot parse GPT routing policy ${routingPath}: ${(error as Error).message}`, routingPath);
  }
  const routing = routingSchema.safeParse(parsed);
  if (!routing.success) throw new ProjectProfileMigrationError('ROUTING_MALFORMED', `GPT routing policy is incompatible with explicit migration: ${routing.error.message}`, routingPath);
  const models = new Set(Object.values(routing.data.routes).filter((route) => route.enabled).map((route) => route.model.trim()));
  if (models.size !== 1) {
    throw new ProjectProfileMigrationError('MODEL_ID_AMBIGUOUS', `Migration requires one exact enabled GPT model, found ${models.size}: ${[...models].join(', ') || '<none>'}.`, routingPath);
  }
  return [...models][0] as string;
}

function publicationMode(profile: TargetProfile): 'NO_REMOTE_YET' | 'REMOTE_REGISTERED' {
  if (profile.remote !== null) return 'REMOTE_REGISTERED';
  if (profile.remote_decision.state === 'NO_REMOTE_YET') return 'NO_REMOTE_YET';
  throw new ProjectProfileMigrationError('PUBLICATION_STATE_AMBIGUOUS', 'Legacy target has no Git remote and no explicit NO_REMOTE_YET decision.');
}

function documentBinding(input: {
  readonly targetRoot: string;
  readonly configuredPath: string | null;
  readonly kind: 'target-description' | 'master-benchmark';
  readonly role: 'product-requirements' | 'testing';
  readonly order: number;
  readonly validatedAt: string;
}): GovernedDocumentBinding | MasterBenchmarkBinding | null {
  if (input.configuredPath === null) return null;
  const resolved = resolveConfiguredPath(input.configuredPath, input.targetRoot);
  if (!existsSync(resolved)) throw new ProjectProfileMigrationError('AUTHORITY_DOCUMENT_MISSING', `Legacy ${input.kind} file is missing: ${resolved}`, resolved);
  const identity = resolvePathIdentity(resolved, { zone: 'clue-state', expectedKind: 'file' });
  const base = {
    bindingId: input.kind,
    kind: input.kind,
    path: input.configuredPath.replace(/\\/gu, '/'),
    canonicalPath: identity.displayPath,
    sha256: hashBytes(readFileSync(resolved)),
    role: input.role,
    enabled: true,
    order: input.order,
    validationState: 'VALID' as const,
    lastValidated: input.validatedAt,
  };
  return input.kind === 'master-benchmark'
    ? { ...base, kind: 'master-benchmark', benchmarkId: null, benchmarkVersion: null }
    : { ...base, kind: 'target-description' };
}

function buildProfile(repoRoot: string, inputs: LegacyInputs, migratedAt: string): ProjectProfile {
  const targetRoot = resolveConfiguredPath(inputs.profile.root, repoRoot);
  const workspaceRoot = resolveConfiguredPath(inputs.config.workspace.root, repoRoot);
  const shadowRoot = resolveConfiguredPath(inputs.config.shadow.root, repoRoot);
  let target;
  let workspace;
  let shadow;
  try { target = resolvePathIdentity(targetRoot, { zone: 'target', expectedKind: 'directory' }); }
  catch (error) { throw new ProjectProfileMigrationError('TARGET_ROOT_UNAVAILABLE', (error as Error).message, targetRoot); }
  try { workspace = resolvePathIdentity(workspaceRoot, { zone: 'workspace', expectedKind: 'directory' }); }
  catch (error) { throw new ProjectProfileMigrationError('WORKSPACE_UNAVAILABLE', (error as Error).message, workspaceRoot); }
  try { shadow = resolvePathIdentity(shadowRoot, { zone: 'shadow', expectedKind: 'directory' }); }
  catch (error) { throw new ProjectProfileMigrationError('SHADOW_UNAVAILABLE', (error as Error).message, shadowRoot); }
  try { assertPathZonesDisjoint([target, workspace, shadow]); }
  catch (error) { throw new ProjectProfileMigrationError('ROOT_ZONE_OVERLAP', `Legacy target/workspace/shadow roots overlap: ${(error as Error).message}`); }

  const description = documentBinding({ targetRoot: target.canonicalPath, configuredPath: inputs.profile.inputs.description, kind: 'target-description', role: 'product-requirements', order: 0, validatedAt: migratedAt });
  const benchmark = documentBinding({ targetRoot: target.canonicalPath, configuredPath: inputs.profile.inputs.benchmark, kind: 'master-benchmark', role: 'testing', order: 1, validatedAt: migratedAt });
  if (description === null || benchmark === null) {
    throw new ProjectProfileMigrationError('AUTHORITY_DOCUMENT_MISSING', 'Legacy profile migration requires explicit Target Description and Master Benchmark bindings.', inputs.profilePath);
  }

  const browserProfile = normalisePathForStorage(resolveConfiguredPath(inputs.config.browser.profile_dir, repoRoot));
  const workspaceDisplay = workspace.displayPath;
  const projectId = inputs.profile.id;
  const stateRoot = (name: string): string => normalisePathForStorage(join(workspaceDisplay, name));
  const profile: ProjectProfile = {
    profileVersion: PROJECT_PROFILE_VERSION,
    projectId,
    displayName: inputs.profile.name ?? projectId,
    targetRoot: target.displayPath,
    targetRootIdentity: asTargetRootIdentity(target.identity),
    workspaceRoot: workspaceDisplay,
    shadowRoot: shadow.displayPath,
    authority: {
      targetDescription: description as GovernedDocumentBinding,
      masterBenchmark: benchmark as MasterBenchmarkBinding,
      projectIntent: null,
      additionalDocuments: [],
    },
    recognition: {
      sourceRoots: inputs.profile.source_roots,
      excludedPaths: inputs.profile.exclude,
      buildConfig: null,
      adapters: ['javascript', 'typescript'],
      policy: {
        policyVersion: 'recognition-policy/1',
        fullScanOnActivation: false,
        reuseUnchangedSnapshot: true,
        followSymlinks: false,
      },
    },
    benchmarkRuntime: {
      workingDirectory: target.displayPath,
      command: null,
      scenario: null,
      warmupRuns: 0,
      repetitions: 1,
      timeoutSeconds: 5_400,
      targetUrl: null,
      browserProfile,
      resolution: null,
      additionalRuntimeArgs: [],
    },
    integrations: {
      powershell: {
        executable: { source: 'global-default', defaultKey: 'powershell.executable', value: null },
        hostScript: normalisePathForStorage(join(repoRoot, 'scripts', 'clue-host.ps1')),
        hostRootAuthority: 'project-profile',
        projectRoot: target.displayPath,
        workspaceRoot: workspaceDisplay,
        shadowRoot: shadow.displayPath,
        autonomousProfile: inputs.config.powershell.autonomous_profile,
      },
      git: {
        repositoryRoot: target.displayPath,
        remote: inputs.profile.remote,
        provider: null,
        defaultBranch: inputs.profile.main_branch,
        protectedLandingPolicy: null,
        currentBasePin: null,
        publicationMode: publicationMode(inputs.profile),
      },
      chrome: {
        executable: { source: 'global-default', defaultKey: 'chrome.executable', value: null },
        launchMode: 'CLUE_MANAGED',
        dedicatedProfileDirectory: browserProfile,
        remoteDebuggingPort: inputs.config.browser.remote_debugging_port,
        allowedOrigins: inputs.config.browser.allowed_origins,
        targetUrl: null,
        targetSelectionRule: 'EXACT_PAGE_ID_THEN_URL_THEN_UNIQUE_ORIGIN',
      },
      gpt: {
        provider: 'openai',
        modelId: exactModelId(repoRoot, inputs.config),
        credential: { source: 'project-override', defaultKey: 'gateway.credential', value: `env:${inputs.config.gateway.api_key_env}` },
        enabled: inputs.config.gateway.enabled,
        fallbackPolicy: 'FORBID',
      },
    },
    state: {
      databasePath: normalisePathForStorage(join(workspaceDisplay, 'db', 'clue.db')),
      eventLogRoot: stateRoot('events'),
      artifactStoreRoot: stateRoot('artifacts'),
      greatBookScope: projectId,
      recognitionRoot: stateRoot('recognition'),
      proofRoot: stateRoot('proof'),
      cycleRoot: stateRoot('cycles'),
      snapshotRoot: stateRoot('snapshots'),
    },
    provenance: {
      source: 'legacy-target-profile',
      legacyConfigPath: normalisePathForStorage(inputs.configPath),
      legacyConfigSha256: hashBytes(inputs.configBytes),
      legacyProfilePath: normalisePathForStorage(inputs.profilePath),
      legacyProfileSha256: hashBytes(inputs.profileBytes),
    },
  };
  return projectProfileSchema.parse(profile);
}

export function migrateLegacyActiveTarget(options: LegacyProjectProfileMigrationOptions): LegacyProjectProfileMigrationResult {
  const repoRoot = resolve(options.repoRoot);
  const configPath = options.configPath === undefined ? join(repoRoot, 'config', 'clue.config.yaml') : resolveConfiguredPath(options.configPath, repoRoot);
  const inputs = readLegacyInputs(repoRoot, configPath);
  const profile = buildProfile(repoRoot, inputs, (options.now ?? nowIso)());
  const sourceConfigHash = hashBytes(inputs.configBytes);
  const sourceProfileHash = hashBytes(inputs.profileBytes);
  const expectedHash = computeProjectProfileHash(profile);
  const existing = options.registry.get(profile.projectId)?.record ?? null;

  if (existing !== null) {
    const provenance = existing.profile.provenance;
    if (
      provenance.source !== 'legacy-target-profile' ||
      provenance.legacyConfigSha256 !== sourceConfigHash ||
      provenance.legacyProfileSha256 !== sourceProfileHash ||
      existing.profile.workspaceRoot !== profile.workspaceRoot ||
      existing.projectProfileHash !== expectedHash
    ) {
      throw new ProjectProfileMigrationError('MIGRATION_CONFLICT', `Project ${profile.projectId} is already registered, but it is not the identical legacy migration result.`);
    }
    options.registry.activate(profile.projectId, { actor: options.actor ?? 'creator', reason: 'idempotent legacy migration activation' });
    return {
      state: 'unchanged',
      registered: existing,
      sourceConfigPath: normalisePathForStorage(inputs.configPath),
      sourceConfigHash,
      sourceProfilePath: normalisePathForStorage(inputs.profilePath),
      sourceProfileHash,
    };
  }

  try {
    const registered = options.registry.create(profile, { actor: options.actor ?? 'creator', reason: 'explicit legacy configuration migration' });
    options.registry.activate(profile.projectId, { actor: options.actor ?? 'creator', reason: 'activate explicitly migrated legacy project' });
    return {
      state: 'created',
      registered,
      sourceConfigPath: normalisePathForStorage(inputs.configPath),
      sourceConfigHash,
      sourceProfilePath: normalisePathForStorage(inputs.profilePath),
      sourceProfileHash,
    };
  } catch (error) {
    if (error instanceof ProfileRegistryError) throw new ProjectProfileMigrationError('MIGRATION_CONFLICT', error.message);
    throw error;
  }
}
