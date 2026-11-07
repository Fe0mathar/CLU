/** Project-scoped Git repository and publication readiness. No network operation occurs here. */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

import { assertSamePathIdentity, resolveTargetRootIdentity } from '../../shared/pathIdentity.js';
import {
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import { projectProfileRecordSchema, type ProjectProfileRecord } from '../../shared/schemas.js';
import { assertProjectProfileHash } from './profileHash.js';

export const PROJECT_GIT_READINESS_STATES = [
  'READY',
  'READY_LOCAL_ONLY',
  'INVALID',
  'BLOCKED',
] as const;
export type ProjectGitReadinessState = (typeof PROJECT_GIT_READINESS_STATES)[number];

export interface GitCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitCommandRunner = (
  root: string,
  args: readonly string[],
  timeoutMs?: number,
) => GitCommandResult;

export interface ProjectGitReadiness {
  readonly state: ProjectGitReadinessState;
  readonly code: string;
  readonly detail: string;
  readonly projectIdentity: ProjectOperationIdentity;
  readonly repositoryRoot: string;
  readonly repositoryTopLevel: string | null;
  readonly publicationMode: 'NO_REMOTE_YET' | 'LOCAL_ONLY' | 'REMOTE_REGISTERED';
  readonly remote: string | null;
  readonly provider: 'github' | 'gitlab' | 'azure-devops' | 'other' | null;
  readonly defaultBranch: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly dirty: boolean | null;
  readonly localOperationsReady: boolean;
  readonly explicitSyncReady: boolean;
  readonly publicationReady: boolean;
  readonly checkedAt: string;
}

export interface ProjectGitReadinessOptions {
  readonly runGit?: GitCommandRunner;
  readonly checkedAt?: string;
}

/**
 * Validates repository identity and local state only. It deliberately does not fetch, push, merge,
 * or probe a remote endpoint. `START CLU-E` can therefore call this safely without synchronising Git.
 */
export function inspectProjectGitReadiness(
  recordInput: ProjectProfileRecord,
  options: ProjectGitReadinessOptions = {},
): ProjectGitReadiness {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const runGit = options.runGit ?? defaultGitRunner;
  const record = projectProfileRecordSchema.parse(recordInput);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  const profile = record.profile;
  const git = profile.integrations.git;
  const identity = operationIdentityFromProfileRecord(record);
  const base = {
    projectIdentity: identity,
    repositoryRoot: git.repositoryRoot,
    publicationMode: git.publicationMode,
    remote: git.remote,
    provider: git.provider,
    defaultBranch: git.defaultBranch,
    checkedAt,
  } as const;

  if (!isDirectory(git.repositoryRoot)) {
    return result('INVALID', 'GIT_REPOSITORY_PATH_INVALID', 'Git repository root is not a directory.', base);
  }
  try {
    const target = resolveTargetRootIdentity(profile.targetRoot);
    const repository = resolveTargetRootIdentity(git.repositoryRoot);
    assertSamePathIdentity(
      target,
      repository,
      'Project Profile Git repository root',
    );
  } catch (error) {
    return result('INVALID', 'GIT_TARGET_ROOT_MISMATCH', errorMessage(error), base);
  }

  if (git.protectedLandingPolicy !== null && !isFile(git.protectedLandingPolicy)) {
    return result(
      'INVALID',
      'GIT_LANDING_POLICY_INVALID',
      `Protected landing policy is not a file: ${git.protectedLandingPolicy}`,
      base,
    );
  }

  const available = runGit(git.repositoryRoot, ['--version'], 10_000);
  if (!available.ok) {
    return result('BLOCKED', 'GIT_UNAVAILABLE', available.stderr || 'git executable is unavailable', base);
  }
  const inside = runGit(git.repositoryRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    return result(
      'INVALID',
      'NOT_A_GIT_WORKTREE',
      inside.stderr || 'Target Root is not a Git worktree.',
      base,
    );
  }
  const top = runGit(git.repositoryRoot, ['rev-parse', '--show-toplevel']);
  if (!top.ok || top.stdout === '') {
    return result('INVALID', 'GIT_TOP_LEVEL_UNAVAILABLE', top.stderr, base);
  }
  try {
    assertSamePathIdentity(
      resolveTargetRootIdentity(git.repositoryRoot),
      resolveTargetRootIdentity(top.stdout),
      'Git reported repository top level',
    );
  } catch (error) {
    return result('INVALID', 'GIT_TOP_LEVEL_MISMATCH', errorMessage(error), base, {
      repositoryTopLevel: top.stdout,
    });
  }

  const branchResult = runGit(git.repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchResult.ok && branchResult.stdout !== '' ? branchResult.stdout : null;
  const headResult = runGit(git.repositoryRoot, ['rev-parse', 'HEAD']);
  const head = headResult.ok && headResult.stdout !== '' ? headResult.stdout : null;
  const status = runGit(git.repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const dirty = status.ok ? status.stdout !== '' : null;

  if (head === null || dirty === null) {
    return result('BLOCKED', 'GIT_STATE_UNAVAILABLE', headResult.stderr || status.stderr, base, {
      repositoryTopLevel: top.stdout,
      branch,
      head,
      dirty,
    });
  }
  const branchFormat = runGit(git.repositoryRoot, ['check-ref-format', '--branch', git.defaultBranch]);
  if (!branchFormat.ok) {
    return result('INVALID', 'GIT_DEFAULT_BRANCH_INVALID', branchFormat.stderr, base, {
      repositoryTopLevel: top.stdout,
      branch,
      head,
      dirty,
    });
  }
  if (git.currentBasePin !== null && head !== git.currentBasePin) {
    return result(
      'BLOCKED',
      'GIT_BASE_PIN_MISMATCH',
      `Current HEAD ${head} does not match the recorded base pin ${git.currentBasePin}.`,
      base,
      { repositoryTopLevel: top.stdout, branch, head, dirty },
    );
  }

  const explicitSyncReady = branch !== null && !dirty;
  if (git.publicationMode !== 'REMOTE_REGISTERED') {
    return result(
      'READY_LOCAL_ONLY',
      git.publicationMode,
      'Local recognition, proof, Great Book, and optimization are available; publication remains explicit and unavailable.',
      base,
      {
        repositoryTopLevel: top.stdout,
        branch,
        head,
        dirty,
        localOperationsReady: true,
        explicitSyncReady: false,
        publicationReady: false,
      },
    );
  }

  if (git.remote === null || git.provider === null) {
    return result(
      'INVALID',
      'GIT_REMOTE_IDENTITY_INCOMPLETE',
      'REMOTE_REGISTERED requires both a remote and provider identity.',
      base,
      { repositoryTopLevel: top.stdout, branch, head, dirty },
    );
  }
  const inferred = inferProvider(git.remote);
  if (inferred !== null && git.provider !== 'other' && inferred !== git.provider) {
    return result(
      'INVALID',
      'GIT_PROVIDER_MISMATCH',
      `Configured provider ${git.provider} disagrees with the registered remote (${inferred}).`,
      base,
      { repositoryTopLevel: top.stdout, branch, head, dirty },
    );
  }
  if (!explicitSyncReady) {
    return result(
      'BLOCKED',
      branch === null ? 'DETACHED_HEAD' : 'DIRTY_WORKTREE',
      branch === null
        ? 'Explicit synchronization requires an attached branch.'
        : 'Explicit synchronization requires a clean worktree.',
      base,
      { repositoryTopLevel: top.stdout, branch, head, dirty },
    );
  }

  if (branch !== git.defaultBranch) {
    return result(
      'BLOCKED',
      'PROFILE_BRANCH_MISMATCH',
      'Check out the branch selected in this Project Profile before synchronizing.',
      base,
      { repositoryTopLevel: top.stdout, branch, head, dirty, localOperationsReady: true },
    );
  }

  return result(
    'READY',
    'GIT_READY',
    'Repository identity, branch, base pin, and registered publication metadata are valid.',
    base,
    {
      repositoryTopLevel: top.stdout,
      branch,
      head,
      dirty,
      localOperationsReady: true,
      explicitSyncReady: true,
      publicationReady: true,
    },
  );
}

export const defaultGitRunner: GitCommandRunner = (
  root,
  args,
  timeoutMs = 30_000,
): GitCommandResult => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'OPENAI_API_KEY') delete env[name];
  }
  const child = spawnSync('git', [...args], {
    cwd: root,
    env,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: child.status === 0 && child.error === undefined,
    stdout: String(child.stdout ?? '').trim(),
    stderr: String(child.stderr ?? child.error?.message ?? '').trim(),
  };
};

function result(
  state: ProjectGitReadinessState,
  code: string,
  detail: string,
  base: Pick<
    ProjectGitReadiness,
    | 'projectIdentity'
    | 'repositoryRoot'
    | 'publicationMode'
    | 'remote'
    | 'provider'
    | 'defaultBranch'
    | 'checkedAt'
  >,
  partial: Partial<
    Pick<
      ProjectGitReadiness,
      | 'repositoryTopLevel'
      | 'branch'
      | 'head'
      | 'dirty'
      | 'localOperationsReady'
      | 'explicitSyncReady'
      | 'publicationReady'
    >
  > = {},
): ProjectGitReadiness {
  return Object.freeze({
    state,
    code,
    detail,
    ...base,
    repositoryTopLevel: partial.repositoryTopLevel ?? null,
    branch: partial.branch ?? null,
    head: partial.head ?? null,
    dirty: partial.dirty ?? null,
    localOperationsReady: partial.localOperationsReady ?? state === 'READY_LOCAL_ONLY',
    explicitSyncReady: partial.explicitSyncReady ?? false,
    publicationReady: partial.publicationReady ?? false,
  });
}

function inferProvider(remote: string): 'github' | 'gitlab' | 'azure-devops' | null {
  const lower = remote.toLowerCase();
  if (lower.includes('github.com')) return 'github';
  if (lower.includes('gitlab.com')) return 'gitlab';
  if (lower.includes('dev.azure.com') || lower.includes('visualstudio.com')) return 'azure-devops';
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
