/**
 * Adapter from one durable `clue-project-profile/1` record to the existing CLU-E runtime shape.
 *
 * This is a migration seam, not a second configuration authority. Project-scoped values come only
 * from the profile. Installation-level values (Constitution, Metric Catalogue, default scripts,
 * policies and UI/logging defaults) remain in `config/clue.config.yaml` until later batches split
 * the global schema formally.
 */

import { dirname, relative } from 'node:path';

import {
  assertSamePathIdentity,
  normalisePathDisplay,
  resolveTargetRootIdentity,
} from '../../shared/pathIdentity.js';
import {
  projectProfileRecordSchema,
  type ClueConfig,
  type ProjectProfileRecord,
} from '../../shared/schemas.js';
import {
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import type { WorkspaceProjectIdentityInput } from '../../memory/db.js';
import { assertProjectProfileHash } from './profileHash.js';
import { assertProjectStatePaths } from './projectPathIsolation.js';
import { inspectProjectAuthority, type ProjectAuthoritySnapshot } from './projectAuthority.js';
import { assessAuthorityConflicts, type AuthorityConflictAssessment } from './authorityConflict.js';
import {
  resolveProjectBenchmarkRuntime,
  type ResolvedProjectBenchmarkRuntime,
} from './benchmarkRuntime.js';
import {
  resolveProjectRecognitionConfiguration,
  type ResolvedProjectRecognitionConfiguration,
} from './projectRecognition.js';

export type ProjectRuntimeBindingErrorCode =
  | 'PROFILE_TARGET_ROOT_IDENTITY_MISMATCH'
  | 'PROFILE_STATE_PATH_INVALID'
  | 'PROFILE_DEFAULT_KEY_UNSUPPORTED'
  | 'PROFILE_CREDENTIAL_REFERENCE_UNSUPPORTED';

export class ProjectRuntimeBindingError extends Error {
  public readonly code: ProjectRuntimeBindingErrorCode;

  public constructor(code: ProjectRuntimeBindingErrorCode, message: string) {
    super(message);
    this.name = 'ProjectRuntimeBindingError';
    this.code = code;
  }
}

export interface ProjectRuntimeStateBinding {
  readonly databasePath: string;
  readonly eventLogRoot: string;
  readonly artifactStoreRoot: string;
  readonly greatBookScope: string;
  readonly recognitionRoot: string;
  readonly proofRoot: string;
  readonly cycleRoot: string;
  readonly snapshotRoot: string;
}

export interface ResolvedProjectRuntimeBinding {
  readonly record: ProjectProfileRecord;
  readonly identity: ProjectOperationIdentity;
  readonly workspaceIdentity: WorkspaceProjectIdentityInput;
  readonly state: ProjectRuntimeStateBinding;
  readonly authority: ProjectAuthoritySnapshot;
  readonly authorityConflicts: AuthorityConflictAssessment;
  readonly benchmarkRuntime: ResolvedProjectBenchmarkRuntime;
  readonly recognition: ResolvedProjectRecognitionConfiguration;
  readonly config: ClueConfig;
}

/** Resolves and re-verifies one profile against the physical target before any state is opened. */
export function resolveProjectRuntimeBinding(
  installationConfig: ClueConfig,
  recordInput: ProjectProfileRecord,
): ResolvedProjectRuntimeBinding {
  const record = projectProfileRecordSchema.parse(recordInput);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  const liveTarget = resolveTargetRootIdentity(record.profile.targetRoot);
  try {
    assertSamePathIdentity(
      record.profile.targetRootIdentity,
      liveTarget,
      `Project Profile ${record.profile.projectId} Target Root`,
    );
  } catch (error) {
    throw new ProjectRuntimeBindingError(
      'PROFILE_TARGET_ROOT_IDENTITY_MISMATCH',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    assertProjectStatePaths(record.profile);
  } catch (error) {
    throw new ProjectRuntimeBindingError(
      'PROFILE_STATE_PATH_INVALID',
      error instanceof Error ? error.message : String(error),
    );
  }

  const identity = operationIdentityFromProfileRecord(record);
  const state: ProjectRuntimeStateBinding = {
    databasePath: nativePath(record.profile.state.databasePath),
    eventLogRoot: nativePath(record.profile.state.eventLogRoot),
    artifactStoreRoot: nativePath(record.profile.state.artifactStoreRoot),
    greatBookScope: record.profile.state.greatBookScope,
    recognitionRoot: nativePath(record.profile.state.recognitionRoot),
    proofRoot: nativePath(record.profile.state.proofRoot),
    cycleRoot: nativePath(record.profile.state.cycleRoot),
    snapshotRoot: nativePath(record.profile.state.snapshotRoot),
  };

  const authority = inspectProjectAuthority(record);
  const authorityConflicts = assessAuthorityConflicts(authority);
  const benchmarkRuntime = resolveProjectBenchmarkRuntime(record, authority.manifest);
  const recognition = resolveProjectRecognitionConfiguration(record);

  return {
    record,
    identity,
    workspaceIdentity: {
      projectId: identity.projectId,
      targetRootIdentity: identity.targetRootIdentity,
      profileVersion: record.profile.profileVersion,
      initialProfileHash: identity.projectProfileHash,
    },
    state,
    authority,
    authorityConflicts,
    benchmarkRuntime,
    recognition,
    config: configFromProfile(installationConfig, record),
  };
}

function configFromProfile(base: ClueConfig, record: ProjectProfileRecord): ClueConfig {
  const profile = record.profile;
  const git = profile.integrations.git;
  const publication = publicationDecision(record);
  const documentRoots = authorityDocumentRoots(record);
  const browserExecutable = resolveInheritedPath(
    profile.integrations.chrome.executable.defaultKey === 'chrome.executable'
      ? { ...profile.integrations.chrome.executable, defaultKey: 'browser.executable' }
      : profile.integrations.chrome.executable,
    'browser.executable',
    base.browser.executable,
  );
  const powershellExecutable = resolveInheritedPath(
    profile.integrations.powershell.executable,
    'powershell.executable',
    base.powershell.executable,
  );
  const apiKeyEnvironment = resolveCredentialEnvironment(record, base.gateway.api_key_env);

  return {
    ...base,
    project: {
      id: profile.projectId,
      ...(profile.displayName === null ? {} : { name: profile.displayName }),
      root: nativePath(profile.targetRoot),
      main_branch: git.defaultBranch,
      source_roots: [...profile.recognition.sourceRoots],
      document_roots: documentRoots,
      exclude: [...profile.recognition.excludedPaths],
      remote: git.remote,
      credential_env: null,
      remote_decision: publication,
      inputs: {
        description: profile.authority.targetDescription?.path ?? null,
        benchmark: profile.authority.masterBenchmark?.path ?? null,
      },
      active_target: null,
    },
    workspace: { root: nativePath(profile.workspaceRoot) },
    shadow: { ...base.shadow, root: nativePath(profile.shadowRoot) },
    browser: {
      ...base.browser,
      executable: nativePath(browserExecutable),
      remote_debugging_port: profile.integrations.chrome.remoteDebuggingPort,
      profile_dir: nativePath(profile.integrations.chrome.dedicatedProfileDirectory),
      allowed_origins: [...profile.integrations.chrome.allowedOrigins],
    },
    powershell: {
      ...base.powershell,
      executable: nativePath(powershellExecutable),
      autonomous_profile:
        profile.integrations.powershell.autonomousProfile === 'disabled'
          ? 'restricted'
          : profile.integrations.powershell.autonomousProfile,
    },
    gateway: {
      ...base.gateway,
      enabled: profile.integrations.gpt.enabled,
      provider: 'openai',
      api_key_env: apiKeyEnvironment,
    },
  };
}

function resolveInheritedPath(
  setting:
    | { readonly source: 'global-default'; readonly defaultKey: string; readonly value: null }
    | { readonly source: 'project-override'; readonly defaultKey: string; readonly value: string },
  supportedKey: string,
  globalValue: string,
): string {
  if (setting.defaultKey !== supportedKey) {
    throw new ProjectRuntimeBindingError(
      'PROFILE_DEFAULT_KEY_UNSUPPORTED',
      `Project Profile references ${setting.defaultKey}; this runtime binding supports ${supportedKey}`,
    );
  }
  return setting.source === 'global-default' ? globalValue : setting.value;
}

function resolveCredentialEnvironment(
  record: ProjectProfileRecord,
  globalEnvironment: string,
): string {
  const setting = record.profile.integrations.gpt.credential;
  if (setting.source === 'global-default') {
    if (setting.defaultKey !== 'gateway.credential') {
      throw new ProjectRuntimeBindingError(
        'PROFILE_DEFAULT_KEY_UNSUPPORTED',
        `Project Profile references ${setting.defaultKey}; this runtime binding supports gateway.credential`,
      );
    }
    return globalEnvironment;
  }
  if (setting.value.startsWith('env:')) return setting.value.slice('env:'.length);

  // ClueConfig v2 carries an environment-variable field for legacy consumers, while the
  // Project Profile gateway resolves the real credential reference directly from the profile.
  // Preserve the installation default here for schema compatibility; it is not used as the
  // effective Project Profile credential when a credential-store reference is configured.
  return globalEnvironment;
}

function publicationDecision(record: ProjectProfileRecord): ClueConfig['project']['remote_decision'] {
  const git = record.profile.integrations.git;
  const date = record.createdAt.slice(0, 10);
  const stem = record.profile.projectId.toUpperCase().replace(/[^A-Z0-9._-]/gu, '-');
  if (git.remote === null) {
    return {
      state: 'NO_REMOTE_YET',
      decision_id: `PP-${stem}-NO-REMOTE`.slice(0, 64),
      recorded_at: date,
      recorded_by: 'creator',
      reason: 'Project Profile explicitly records a local-only target with no registered remote.',
    };
  }
  return {
    state: 'REMOTE_REGISTERED',
    decision_id: `PP-${stem}-REMOTE`.slice(0, 64),
    recorded_at: date,
    recorded_by: 'creator',
    reason: 'Project Profile explicitly records the credential-free target remote identity.',
  };
}

function authorityDocumentRoots(record: ProjectProfileRecord): string[] {
  const profile = record.profile;
  const paths = [
    profile.authority.targetDescription?.canonicalPath ?? null,
    profile.authority.masterBenchmark?.canonicalPath ?? null,
    profile.authority.projectIntent?.canonicalPath ?? null,
    ...profile.authority.additionalDocuments
      .filter((document) => document.enabled)
      .map((document) => document.canonicalPath),
  ].filter((value): value is string => value !== null);

  const target = nativePath(profile.targetRoot);
  const roots = new Set<string>();
  for (const path of paths) {
    const delta = relative(target, dirname(nativePath(path)));
    if (delta === '' || delta === '.') roots.add('.');
    else if (delta !== '..' && !delta.startsWith(`..${separator()}`)) {
      roots.add(normalisePathDisplay(delta));
    }
  }
  return roots.size === 0 ? ['.'] : [...roots].sort((left, right) => left.localeCompare(right));
}

function nativePath(value: string): string {
  return process.platform === 'win32' ? value.replace(/\//gu, '\\') : value;
}

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
