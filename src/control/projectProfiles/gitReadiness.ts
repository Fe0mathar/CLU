/** Project-scoped Git repository and publication readiness. No network operation occurs here. */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';

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
  readonly refusalCode?: string;
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
    return result('BLOCKED', status.refusalCode ?? 'GIT_STATE_UNAVAILABLE', headResult.stderr || status.stderr, base, {
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
  const { ok, stdout, stderr } = runGitCommand(root, args, timeoutMs, false);
  return { ok, stdout, stderr };
};

/** Read-only runner used by P01. Refuses repository code that Git status could otherwise invoke. */
export const preflightGitRunner: GitCommandRunner = (root, args, timeoutMs = 30_000) => {
  if (args[0] === 'status') {
    const safety = inspectPreflightStatusSafety(root, timeoutMs);
    if ('refusalCode' in safety) return safety;
    return runGitCommand(root, [...safety.overrides, ...args, '--ignore-submodules=all'], timeoutMs, true);
  }
  return runGitCommand(root, args, timeoutMs, true);
};

function inspectPreflightStatusSafety(root: string, timeoutMs: number):
  { readonly overrides: readonly string[] } | (GitCommandResult & { readonly refusalCode: string }) {
  const refused = (refusalCode: string, stderr: string) => ({ ok: false, stdout: '', stderr, refusalCode });
  const index = runGitCommand(root, ['ls-files', '--stage', '-z'], timeoutMs, true);
  if (!index.ok) return refused('GIT_INDEX_UNVERIFIED', 'Git index entries could not be verified.');
  const trackedPaths = new Set<string>();
  for (const entry of index.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || entry.includes('\uFFFD')) return refused('GIT_INDEX_UNVERIFIED', 'Git index entries could not be decoded.');
    if (entry.startsWith('160000 ')) {
      return refused('GIT_SUBMODULES_REQUIRE_REVIEW', 'Submodule worktrees require a separate local inspection.');
    }
    trackedPaths.add(entry.slice(tab + 1));
  }

  const filters = runGitCommand(root, [
    'config', '--name-only', '--null', '--get-regexp', '^filter\\..*\\.(clean|process)$',
  ], timeoutMs, true);
  if (!filters.ok && filters.exitCode === 1 && filters.stderr === '') return { overrides: [] };
  const keys = filters.stdout.split('\0').filter(Boolean);
  if (!filters.ok || keys.length === 0 || keys.some((key) => key.includes('\uFFFD') || !/^filter\..+\.(?:clean|process)$/u.test(key))) {
    return refused('GIT_FILTER_CONFIGURATION_UNVERIFIED', 'Git filter configuration could not be verified.');
  }
  const names = new Set(keys.map((key) => key.slice('filter.'.length, key.lastIndexOf('.'))));
  if (trackedPaths.size > 0) {
    const paths = [...trackedPaths];
    const attributes = runGitCommand(root, ['check-attr', '--stdin', '-z', 'filter'], timeoutMs, true, `${paths.join('\0')}\0`);
    const fields = attributes.stdout.split('\0');
    if (!attributes.ok || fields.length !== paths.length * 3 + 1 || fields.at(-1) !== '' ||
        paths.some((path, index) => fields[index * 3] !== path || fields[index * 3 + 1] !== 'filter')) {
      return refused('GIT_FILTER_CONFIGURATION_UNVERIFIED', 'Tracked-file filter attributes could not be verified.');
    }
    if (paths.some((_, index) => names.has(fields[index * 3 + 2] ?? ''))) {
      return refused('GIT_EXTERNAL_FILTER_CONFIGURED', 'Git status could execute an external filter on a tracked file.');
    }
  }
  // Disable observed drivers in the status process as well, should an attribute change after inspection.
  return { overrides: [...names].flatMap((name) => [
    '-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=true`,
  ]) };
}

function runGitCommand(
  root: string,
  args: readonly string[],
  timeoutMs: number,
  offline: boolean,
  input?: string,
): GitCommandResult & { readonly exitCode: number | null } {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const key = name.toUpperCase();
    if (GIT_HOST_ENV.has(key)) env[process.platform === 'win32' ? key : name] = value;
  }
  const tool = locateGit(root, env);
  if (tool === null) return { ok: false, stdout: '', stderr: 'A host Git executable is required outside the target checkout.', exitCode: null };
  const child = spawnSync(tool.executable, [
    '--no-optional-locks', '--no-replace-objects',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'push.recurseSubmodules=no',
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    ...args,
  ], {
    cwd: root,
    env: {
      ...env, PATH: tool.path, GIT_ALLOW_PROTOCOL: offline ? '' : 'http:https:ssh:git:file',
      ...(offline ? { GIT_NO_LAZY_FETCH: '1' } : {}),
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    },
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  const stdout = String(child.stdout ?? '');
  const nulSeparated = offline && (args.includes('-z') || args.includes('--null'));
  return {
    ok: child.status === 0 && child.error === undefined,
    stdout: nulSeparated ? stdout : stdout.trim(),
    stderr: String(child.stderr ?? child.error?.message ?? '').trim(),
    exitCode: child.status,
  };
}

const GIT_HOST_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'USER', 'XDG_CONFIG_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSH_AUTH_SOCK',
  'LANG', 'LC_ALL', 'LC_CTYPE',
]);

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function locateGit(root: string, env: NodeJS.ProcessEnv): { executable: string; path: string } | null {
  let target: string;
  try { target = realpathSync.native(root); } catch { return null; }
  const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
  const trustedEntries: string[] = [];
  let executable: string | null = null;
  for (const raw of (env['PATH'] ?? '').split(delimiter)) {
    const entry = raw.trim().replace(/^"(.*)"$/u, '$1');
    if (!isAbsolute(entry) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(entry))) continue;
    try {
      const physical = realpathSync.native(entry);
      if (isWithin(target, physical) || !statSync(physical).isDirectory()) continue;
      trustedEntries.push(physical);
      if (executable !== null) continue;
      const candidate = realpathSync.native(join(physical, executableName));
      if (isWithin(target, candidate) || !statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      executable = candidate;
    } catch {
      // Skip stale directories and unavailable executables.
    }
  }
  return executable === null ? null : { executable, path: trustedEntries.join(delimiter) };
}

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
