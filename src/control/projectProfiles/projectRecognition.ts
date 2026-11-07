/**
 * Resolves one active project's recognition authority into the recognizer runtime.
 *
 * A profile-bound runtime consumes the Project Profile's source roots, exclusions, build
 * configuration, adapter set and recognition policy. Legacy configuration remains supported for
 * the pre-profile single-project startup path, but it receives a separate deterministic basis and
 * can never be confused with a profile generation.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { Runtime } from '../runtime.js';
import { hashCanonicalJson, type Sha256 } from '../../shared/ids.js';
import {
  assertProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import {
  canonicalProjectRecognitionIdentity,
  type ProjectRecognitionIdentity,
} from '../../shared/projectRecognitionIdentity.js';
import type { ProjectProfileRecord } from '../../shared/schemas.js';
import { computeProjectRecognitionHash } from './profileHash.js';

export const SUPPORTED_STATIC_RECOGNITION_ADAPTERS = Object.freeze([
  'javascript',
  'typescript',
  'typescript-static',
] as const);

export type ProjectRecognitionMode = 'project-profile' | 'legacy-config';

export interface ResolvedProjectRecognitionConfiguration {
  /** Exact profile generation + recognition settings identity. */
  readonly identity: ProjectRecognitionIdentity;
  readonly targetRoot: string;
  readonly sourceRoots: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly buildConfigPath: string;
  readonly adapters: readonly string[];
  readonly unsupportedAdapters: readonly string[];
  readonly policy: {
    readonly policyVersion: 'recognition-policy/1';
    readonly fullScanOnActivation: boolean;
    readonly reuseUnchangedSnapshot: boolean;
    readonly followSymlinks: boolean;
  };
  readonly recognitionConfigHash: Sha256;
}

export interface ResolvedProjectRecognition {
  readonly mode: ProjectRecognitionMode;
  readonly operationIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
  readonly projectRecognitionIdentity: ProjectRecognitionIdentity | null;
  readonly targetRoot: string;
  readonly sourceRoots: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly buildConfigPath: string;
  readonly adapters: readonly string[];
  readonly unsupportedAdapters: readonly string[];
  readonly policy: {
    readonly policyVersion: 'recognition-policy/1';
    readonly fullScanOnActivation: boolean;
    readonly reuseUnchangedSnapshot: boolean;
    readonly followSymlinks: boolean;
  };
  readonly recognitionConfigHash: Sha256;
}

export type ProjectRecognitionErrorCode =
  | 'PROJECT_RECOGNITION_RUNTIME_IDENTITY_MISSING'
  | 'PROJECT_RECOGNITION_BUILD_CONFIG_MISSING'
  | 'PROJECT_RECOGNITION_SOURCE_ROOT_INVALID'
  | 'PROJECT_RECOGNITION_PATH_ESCAPE'
  | 'PROJECT_RECOGNITION_NO_SUPPORTED_ADAPTER'
  | 'PROJECT_RECOGNITION_SYMLINK_POLICY_UNSUPPORTED';

export class ProjectRecognitionError extends Error {
  public readonly code: ProjectRecognitionErrorCode;

  public constructor(code: ProjectRecognitionErrorCode, message: string) {
    super(message);
    this.name = 'ProjectRecognitionError';
    this.code = code;
  }
}

/** Resolves and validates the profile-owned recognition configuration before runtime activation. */
export function resolveProjectRecognitionConfiguration(
  record: ProjectProfileRecord,
): ResolvedProjectRecognitionConfiguration {
  const recognition = record.profile.recognition;
  const targetRoot = nativePath(record.profile.targetRoot);
  const sourceRoots = canonicalStrings(recognition.sourceRoots);
  for (const sourceRoot of sourceRoots) {
    const sourcePath = resolveProjectPath(targetRoot, sourceRoot, 'source root');
    assertSourceRoot(sourcePath);
  }
  const excludedPaths = canonicalStrings(recognition.excludedPaths);
  const buildConfigPath = resolveProjectPath(
    targetRoot,
    recognition.buildConfig ?? 'tsconfig.json',
    'build/compiler configuration',
  );
  assertBuildConfig(buildConfigPath);

  if (recognition.policy.followSymlinks) {
    throw new ProjectRecognitionError(
      'PROJECT_RECOGNITION_SYMLINK_POLICY_UNSUPPORTED',
      'recognition policy requests followSymlinks=true, but the governed snapshot implementation records links without following them',
    );
  }

  const adapters = canonicalStrings(recognition.adapters);
  const supported = new Set<string>(SUPPORTED_STATIC_RECOGNITION_ADAPTERS);
  const unsupportedAdapters = adapters.filter((adapter) => !supported.has(adapter));
  if (!adapters.some((adapter) => supported.has(adapter))) {
    throw new ProjectRecognitionError(
      'PROJECT_RECOGNITION_NO_SUPPORTED_ADAPTER',
      `Project ${record.profile.projectId} enables no supported static adapter; configured: ${adapters.join(', ') || '(none)'}`,
    );
  }

  const operationIdentity = operationIdentityFromProfileRecord(record);
  const recognitionConfigHash = computeProjectRecognitionHash(record.profile);
  const identity = canonicalProjectRecognitionIdentity({
    identityVersion: 'clue-project-recognition-identity/1',
    operationIdentity,
    profileGeneration: record.generation,
    recognitionConfigHash,
  });

  return Object.freeze({
    identity,
    targetRoot,
    sourceRoots,
    excludedPaths,
    buildConfigPath,
    adapters,
    unsupportedAdapters,
    policy: Object.freeze({ ...recognition.policy }),
    recognitionConfigHash,
  });
}

/** Returns the exact immutable recognition basis for the runtime's active target. */
export function resolveProjectRecognition(runtime: Runtime): ResolvedProjectRecognition {
  const profileRecord = runtime.projectProfile;
  if (profileRecord === null) return resolveLegacyRecognition(runtime);

  if (runtime.projectIdentity === null) {
    throw new ProjectRecognitionError(
      'PROJECT_RECOGNITION_RUNTIME_IDENTITY_MISSING',
      `Project Profile ${profileRecord.profile.projectId} is active but the runtime exposes no project identity`,
    );
  }
  const operationIdentity = assertProjectOperationIdentity(
    operationIdentityFromProfileRecord(profileRecord),
    runtime.projectIdentity,
    'project recognition runtime',
  );
  const configuration = runtime.projectBinding?.recognition ??
    resolveProjectRecognitionConfiguration(profileRecord);
  const projectRecognitionIdentity = canonicalProjectRecognitionIdentity(configuration.identity);
  assertProjectOperationIdentity(
    operationIdentity,
    projectRecognitionIdentity.operationIdentity,
    'project recognition configuration',
  );

  const { identity: _identity, ...settings } = configuration;
  void _identity;
  return Object.freeze({
    mode: 'project-profile',
    operationIdentity,
    profileGeneration: profileRecord.generation,
    projectRecognitionIdentity,
    ...settings,
  });
}

function resolveLegacyRecognition(runtime: Runtime): ResolvedProjectRecognition {
  const targetRoot = runtime.config.project.root;
  const sourceRoots = canonicalStrings(runtime.config.project.source_roots);
  const excludedPaths = canonicalStrings(runtime.config.project.exclude);
  const buildConfigPath = resolveProjectPath(
    targetRoot,
    'tsconfig.json',
    'build/compiler configuration',
  );
  assertBuildConfig(buildConfigPath);
  const policy = Object.freeze({
    policyVersion: 'recognition-policy/1' as const,
    fullScanOnActivation: false,
    reuseUnchangedSnapshot: true,
    followSymlinks: false,
  });
  const adapters = Object.freeze(['javascript', 'typescript'] as const);
  return Object.freeze({
    mode: 'legacy-config',
    operationIdentity: null,
    profileGeneration: null,
    projectRecognitionIdentity: null,
    targetRoot,
    sourceRoots,
    excludedPaths,
    buildConfigPath,
    adapters,
    unsupportedAdapters: Object.freeze([] as string[]),
    policy,
    recognitionConfigHash: hashCanonicalJson({
      version: 'legacy-project-recognition/1',
      projectId: runtime.config.project.id,
      targetRoot,
      sourceRoots,
      excludedPaths,
      buildConfigPath,
      adapters,
      policy,
    }),
  });
}

function resolveProjectPath(targetRoot: string, configuredPath: string, label: string): string {
  const candidate = isAbsolute(configuredPath) ? configuredPath : resolve(targetRoot, configuredPath);
  const delta = relative(resolve(targetRoot), resolve(candidate));
  if (delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new ProjectRecognitionError(
      'PROJECT_RECOGNITION_PATH_ESCAPE',
      `${label} ${configuredPath} resolves outside the active Target Root ${targetRoot}`,
    );
  }
  return candidate;
}


function assertSourceRoot(path: string): void {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error('not an existing directory');
    }
  } catch (error) {
    throw new ProjectRecognitionError(
      'PROJECT_RECOGNITION_SOURCE_ROOT_INVALID',
      `Recognition source root is invalid: ${path} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function assertBuildConfig(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new ProjectRecognitionError(
      'PROJECT_RECOGNITION_BUILD_CONFIG_MISSING',
      `Recognition build/compiler configuration is not a file: ${path}`,
    );
  }
}

function canonicalStrings(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.map((value) => value.replace(/\\/gu, '/').replace(/^\.\//u, '')))].sort(),
  );
}

function nativePath(value: string): string {
  return process.platform === 'win32' ? value.replace(/\//gu, '\\') : value;
}
