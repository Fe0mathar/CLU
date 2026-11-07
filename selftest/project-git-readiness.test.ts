/** PP-22 — Project Profile Git readiness and explicit local-first sync boundaries. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  inspectProjectGitReadiness,
  type GitCommandResult,
  type GitCommandRunner,
} from '../src/control/projectProfiles/gitReadiness.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { manualProjectGitSync } from '../src/integration/git/manualGitSync.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { cloneProfile, makeProjectProfileFixture } from './project-profile-fixture.js';

interface RunnerState {
  readonly top: string;
  readonly head?: string;
  readonly branch?: string | null;
  readonly dirty?: boolean;
  readonly unavailable?: boolean;
}

function runnerFor(state: RunnerState, calls: string[][] = []): GitCommandRunner {
  const ok = (stdout = ''): GitCommandResult => ({ ok: true, stdout, stderr: '' });
  const fail = (stderr: string): GitCommandResult => ({ ok: false, stdout: '', stderr });
  return (_root, args) => {
    calls.push([...args]);
    const command = args.join(' ');
    if (command === '--version') return state.unavailable ? fail('git not found') : ok('git version test');
    if (command === 'rev-parse --is-inside-work-tree') return ok('true');
    if (command === 'rev-parse --show-toplevel') return ok(state.top);
    if (command === 'symbolic-ref --quiet --short HEAD') {
      return state.branch === null ? fail('detached') : ok(state.branch ?? 'main');
    }
    if (command === 'rev-parse HEAD') return ok(state.head ?? 'a'.repeat(40));
    if (command === 'status --porcelain=v1 --untracked-files=normal') {
      return ok(state.dirty ? ' M src/value.ts' : '');
    }
    if (command.startsWith('check-ref-format --branch ')) return ok();
    return fail(`unexpected command: ${command}`);
  };
}

test('NO_REMOTE_YET is READY_LOCAL_ONLY and explicit sync spawns no Git process', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });
  const calls: string[][] = [];
  const readiness = inspectProjectGitReadiness(record, {
    checkedAt: '2026-08-14T21:00:00.000Z',
    runGit: runnerFor({ top: fixture.target }, calls),
  });

  assert.equal(readiness.state, 'READY_LOCAL_ONLY');
  assert.equal(readiness.code, 'NO_REMOTE_YET');
  assert.equal(readiness.localOperationsReady, true);
  assert.equal(readiness.explicitSyncReady, false);
  assert.equal(readiness.publicationReady, false);
  assert.equal(
    calls.some((args) => ['fetch', 'push', 'pull', 'ls-remote'].includes(args[0] ?? '')),
    false,
    'readiness performs local inspection only',
  );

  let syncRunnerCalled = false;
  const sync = manualProjectGitSync(
    record,
    operationIdentityFromProfileRecord(record),
    '2026-08-14T21:01:00.000Z',
    () => {
      syncRunnerCalled = true;
      throw new Error('NO_REMOTE_YET must return before Git is spawned');
    },
  );
  assert.equal(sync.state, 'refused');
  assert.equal(sync.code, 'NO_REMOTE_CONFIGURED');
  assert.equal(syncRunnerCalled, false);
});

test('registered metadata is READY only for exact clean attached repository state', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const initial = registry.create(fixture.profile, { actor: 'creator' });
  const remoteProfile = cloneProfile(initial.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const git = integrations['git'] as Record<string, unknown>;
    git['remote'] = 'file:///tmp/clue-profile-remote.git';
    git['provider'] = 'other';
    git['publicationMode'] = 'REMOTE_REGISTERED';
  });
  const remote = registry.update(remoteProfile, initial.generation, { actor: 'creator' });

  const ready = inspectProjectGitReadiness(remote, {
    runGit: runnerFor({ top: fixture.target, branch: 'main', dirty: false }),
  });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.code, 'GIT_READY');
  assert.equal(ready.explicitSyncReady, true);
  assert.equal(ready.publicationReady, true);

  const dirty = inspectProjectGitReadiness(remote, {
    runGit: runnerFor({ top: fixture.target, branch: 'main', dirty: true }),
  });
  assert.equal(dirty.state, 'BLOCKED');
  assert.equal(dirty.code, 'DIRTY_WORKTREE');

  const detached = inspectProjectGitReadiness(remote, {
    runGit: runnerFor({ top: fixture.target, branch: null, dirty: false }),
  });
  assert.equal(detached.state, 'BLOCKED');
  assert.equal(detached.code, 'DETACHED_HEAD');

  const wrongBranchCalls: string[][] = [];
  const wrongBranch = manualProjectGitSync(
    remote,
    operationIdentityFromProfileRecord(remote),
    undefined,
    runnerFor({ top: fixture.target, branch: 'other-branch' }, wrongBranchCalls),
  );
  assert.equal(wrongBranch.code, 'PROFILE_BRANCH_MISMATCH');
  assert.equal(wrongBranchCalls.some(([command]) => command === 'fetch' || command === 'push'), false);
});

test('top-level mismatch, base-pin drift and Git unavailability are explicit failures', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const initial = registry.create(fixture.profile, { actor: 'creator' });

  const wrongTop = inspectProjectGitReadiness(initial, {
    runGit: runnerFor({ top: join(fixture.root, 'another-repository') }),
  });
  assert.equal(wrongTop.state, 'INVALID');
  assert.equal(wrongTop.code, 'GIT_TOP_LEVEL_MISMATCH');

  const unavailable = inspectProjectGitReadiness(initial, {
    runGit: runnerFor({ top: fixture.target, unavailable: true }),
  });
  assert.equal(unavailable.state, 'BLOCKED');
  assert.equal(unavailable.code, 'GIT_UNAVAILABLE');

  const pinnedProfile = cloneProfile(initial.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const git = integrations['git'] as Record<string, unknown>;
    git['currentBasePin'] = 'b'.repeat(40);
  });
  const pinned = registry.update(pinnedProfile, initial.generation, { actor: 'creator' });
  const drift = inspectProjectGitReadiness(pinned, {
    runGit: runnerFor({ top: fixture.target, head: 'a'.repeat(40) }),
  });
  assert.equal(drift.state, 'BLOCKED');
  assert.equal(drift.code, 'GIT_BASE_PIN_MISMATCH');
});

test('stale Project Profile identity refuses manual sync before Git is spawned', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });
  const stale = {
    ...operationIdentityFromProfileRecord(record),
    projectProfileHash: `profile:v1:${'f'.repeat(64)}`,
  };
  let called = false;
  const result = manualProjectGitSync(record, stale, undefined, () => {
    called = true;
    throw new Error('stale identity must be refused before Git');
  });
  assert.equal(result.state, 'refused');
  assert.equal(result.code, 'PROJECT_IDENTITY_MISMATCH');
  assert.equal(called, false);
});
