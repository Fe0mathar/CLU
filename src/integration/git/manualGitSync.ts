/**
 * Manual, local-first Git synchronisation requested by the Dashboard operator.
 *
 * This is deliberately NOT the governed Git lifecycle promised for P4: it creates no
 * proof authority, landing permit, review object or automatic publication. It is one
 * explicit operator convenience action. Start CLU-E, proof, ACCEPT and cycle closure
 * never call this module.
 *
 * Safety rules:
 * - no recorded remote -> return a named refusal without spawning Git;
 * - only a clean, attached branch may sync;
 * - fetch first, then either fast-forward OR push an ahead-only branch;
 * - divergence is refused; no merge, rebase, conflict resolution or force push;
 * - credentials remain owned by the host Git credential helper/SSH agent.
 */

import { projectProfileRecordSchema, type ClueConfig, type ProjectProfileRecord } from '../../shared/schemas.js';
import { describeTargetPublication } from '../../shared/targetPublication.js';
import {
  assertProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import {
  defaultGitRunner,
  inspectProjectGitReadiness,
  type GitCommandRunner,
} from '../../control/projectProfiles/gitReadiness.js';
import { assertProjectProfileHash } from '../../control/projectProfiles/profileHash.js';

export type ManualGitSyncState =
  | 'refused'
  | 'unchanged'
  | 'fast_forwarded'
  | 'pushed';

export interface ManualGitSyncResult {
  readonly state: ManualGitSyncState;
  readonly code: string;
  readonly detail: string;
  readonly requestedAt: string;
  readonly branch: string | null;
  readonly beforeHead: string | null;
  readonly afterHead: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly remote: string | null;
  /** Always false: P4 remains the owner of governed Git lifecycle/status authority. */
  readonly governedGitLifecycle: false;
}

export type ManualGitCommandRunner = GitCommandRunner;

function safeRemoteLabel(remote: string): string {
  try {
    const url = new URL(remote);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    const scp = remote.match(/^[^@/\\]+@([A-Za-z0-9.-]+):(.+)$/u);
    return scp === null ? 'registered-remote' : `${scp[1]}:${scp[2]}`;
  }
}

function refusal(
  requestedAt: string,
  code: string,
  detail: string,
  remote: string | null = null,
): ManualGitSyncResult {
  return {
    state: 'refused',
    code,
    detail,
    requestedAt,
    branch: null,
    beforeHead: null,
    afterHead: null,
    ahead: null,
    behind: null,
    remote,
    governedGitLifecycle: false,
  };
}

function parseCount(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is not a count: ${value}`);
  return parsed;
}

export function manualGitSync(
  project: ClueConfig['project'],
  requestedAt = new Date().toISOString(),
  runGit: ManualGitCommandRunner = defaultGitRunner,
): ManualGitSyncResult {
  const publication = describeTargetPublication(
    project.remote,
    project.credential_env,
    project.remote_decision,
  );
  if (publication.decision !== 'REMOTE_REGISTERED' || publication.remote === null) {
    return refusal(
      requestedAt,
      'NO_REMOTE_CONFIGURED',
      'Local-first mode is active; no remote was contacted.',
    );
  }
  return syncRegisteredRemote(project.root, publication.remote, requestedAt, runGit);
}

/** Explicit Project Profile variant; stale project identity is refused before Git is spawned. */
export function manualProjectGitSync(
  recordInput: ProjectProfileRecord,
  expectedIdentity: ProjectOperationIdentity,
  requestedAt = new Date().toISOString(),
  runGit: ManualGitCommandRunner = defaultGitRunner,
): ManualGitSyncResult {
  let record: ProjectProfileRecord;
  try {
    record = projectProfileRecordSchema.parse(recordInput);
    assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  } catch (error) {
    return refusal(
      requestedAt,
      'PROJECT_PROFILE_INVALID',
      error instanceof Error ? error.message : String(error),
    );
  }
  const actualIdentity = operationIdentityFromProfileRecord(record);
  try {
    assertProjectOperationIdentity(expectedIdentity, actualIdentity, 'manual Project Git sync');
  } catch (error) {
    return refusal(
      requestedAt,
      'PROJECT_IDENTITY_MISMATCH',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (record.profile.integrations.git.publicationMode !== 'REMOTE_REGISTERED') {
    return refusal(
      requestedAt,
      'NO_REMOTE_CONFIGURED',
      'The active Project Profile is local-only; no Git process or remote was contacted.',
    );
  }

  const readiness = inspectProjectGitReadiness(record, { runGit, checkedAt: requestedAt });
  if (readiness.state !== 'READY' || readiness.remote === null) {
    return refusal(requestedAt, readiness.code, readiness.detail, readiness.remote);
  }
  return syncRegisteredRemote(
    readiness.repositoryRoot, readiness.remote, requestedAt, runGit,
    record.profile.integrations.git.defaultBranch,
  );
}

function syncRegisteredRemote(
  root: string,
  remote: string,
  requestedAt: string,
  runGit: ManualGitCommandRunner,
  expectedBranch?: string,
): ManualGitSyncResult {
  const remoteLabel = safeRemoteLabel(remote);
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    return refusal(requestedAt, 'NOT_A_GIT_WORKTREE', inside.stderr || 'Target root is not a Git worktree.', remoteLabel);
  }
  const dirty = runGit(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (!dirty.ok) return refusal(requestedAt, 'GIT_STATUS_FAILED', dirty.stderr, remoteLabel);
  if (dirty.stdout !== '') {
    return refusal(requestedAt, 'DIRTY_WORKTREE', 'Commit or discard local changes before manual sync.', remoteLabel);
  }
  const branchResult = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branchResult.ok || branchResult.stdout === '') {
    return refusal(requestedAt, 'DETACHED_HEAD', 'Manual sync requires an attached branch.', remoteLabel);
  }
  const branch = branchResult.stdout;
  if (expectedBranch !== undefined && branch !== expectedBranch) {
    return refusal(requestedAt, 'PROFILE_BRANCH_MISMATCH', 'Check out the branch selected in this Project Profile before synchronizing.', remoteLabel);
  }
  const validBranch = runGit(root, ['check-ref-format', '--branch', branch]);
  if (!validBranch.ok) return refusal(requestedAt, 'INVALID_BRANCH', validBranch.stderr, remoteLabel);
  const before = runGit(root, ['rev-parse', 'HEAD']);
  if (!before.ok || before.stdout === '') return refusal(requestedAt, 'HEAD_UNAVAILABLE', before.stderr, remoteLabel);

  const remoteRef = `refs/remotes/clue-sync/${branch}`;
  const fetchResult = runGit(root, [
    'fetch',
    '--no-tags',
    '--prune',
    remote,
    `+refs/heads/${branch}:${remoteRef}`,
  ]);
  if (!fetchResult.ok) {
    return {
      ...refusal(requestedAt, 'FETCH_FAILED', fetchResult.stderr || 'git fetch failed', remoteLabel),
      branch,
      beforeHead: before.stdout,
    };
  }
  const relation = runGit(root, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
  if (!relation.ok) {
    return {
      ...refusal(requestedAt, 'RELATION_FAILED', relation.stderr, remoteLabel),
      branch,
      beforeHead: before.stdout,
    };
  }
  const parts = relation.stdout.split(/\s+/u);
  if (parts.length !== 2) throw new Error(`Unexpected git relation: ${relation.stdout}`);
  const ahead = parseCount(parts[0] ?? '', 'ahead');
  const behind = parseCount(parts[1] ?? '', 'behind');

  if (ahead > 0 && behind > 0) {
    return {
      ...refusal(
        requestedAt,
        'DIVERGED',
        'Local and remote histories diverged; manual conflict resolution is required.',
        remoteLabel,
      ),
      branch,
      beforeHead: before.stdout,
      ahead,
      behind,
    };
  }

  let state: ManualGitSyncState = 'unchanged';
  let detail = 'Local and remote branch identities already agree.';
  if (behind > 0) {
    const merge = runGit(root, ['merge', '--ff-only', remoteRef]);
    if (!merge.ok) {
      return {
        ...refusal(requestedAt, 'FAST_FORWARD_FAILED', merge.stderr, remoteLabel),
        branch,
        beforeHead: before.stdout,
        ahead,
        behind,
      };
    }
    state = 'fast_forwarded';
    detail = `Fast-forwarded ${behind} remote commit(s).`;
  } else if (ahead > 0) {
    const push = runGit(root, ['push', remote, `HEAD:refs/heads/${branch}`]);
    if (!push.ok) {
      return {
        ...refusal(requestedAt, 'PUSH_FAILED', push.stderr, remoteLabel),
        branch,
        beforeHead: before.stdout,
        ahead,
        behind,
      };
    }
    state = 'pushed';
    detail = `Pushed ${ahead} local commit(s).`;
  }

  const after = runGit(root, ['rev-parse', 'HEAD']);
  if (!after.ok || after.stdout === '') throw new Error(`Git sync completed but HEAD cannot be read: ${after.stderr}`);
  return {
    state,
    code: 'OK',
    detail,
    requestedAt,
    branch,
    beforeHead: before.stdout,
    afterHead: after.stdout,
    ahead,
    behind,
    remote: remoteLabel,
    governedGitLifecycle: false,
  };
}
