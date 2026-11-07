/** ADR-0017 — manual, local-first Git sync is explicit and fail-closed. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { manualGitSync } from '../src/integration/git/manualGitSync.js';
import { projectConfigSchema, type ClueConfig } from '../src/shared/schemas.js';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${String(result.stderr)}`);
  return String(result.stdout ?? '').trim();
}

function project(root: string, remote: string | null): ClueConfig['project'] {
  return projectConfigSchema.parse({
    id: 'fixture',
    name: 'Git sync fixture',
    root,
    main_branch: 'main',
    source_roots: ['src'],
    document_roots: ['.'],
    exclude: ['node_modules'],
    remote,
    credential_env: null,
    remote_decision:
      remote === null
        ? {
            state: 'NO_REMOTE_YET',
            decision_id: 'P2-D5-NO-REMOTE-YET',
            recorded_at: '2026-08-14',
            recorded_by: 'creator',
            reason: 'The fixture is deliberately local-only and must not contact Git.',
          }
        : {
            state: 'REMOTE_REGISTERED',
            decision_id: 'ADR-0017-MANUAL-SYNC',
            recorded_at: '2026-08-14',
            recorded_by: 'creator',
            reason: 'The fixture remote is registered only for an explicit operator sync.',
          },
    inputs: { description: null, benchmark: null },
    active_target: null,
  });
}

test('ADR-0017: NO_REMOTE_YET refuses manual Git sync without requiring a repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-git-sync-no-remote-'));
  try {
    const result = manualGitSync(project(root, null), '2026-08-14T09:00:00.000Z');
    assert.deepEqual(
      {
        state: result.state,
        code: result.code,
        remote: result.remote,
        governed: result.governedGitLifecycle,
      },
      { state: 'refused', code: 'NO_REMOTE_CONFIGURED', remote: null, governed: false },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ADR-0017: explicit sync is unchanged, ahead-only push, behind-only fast-forward, and refuses dirty/diverged state', (t) => {
  const available = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (available.status !== 0) {
    t.skip('git is not available on this host');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'clue-git-sync-'));
  const local = join(root, 'local');
  const remote = join(root, 'remote.git');
  const peer = join(root, 'peer');
  const remoteUrl = pathToFileURL(remote).href;
  try {
    git(root, 'init', '--bare', remote);
    git(root, 'init', local);
    git(local, 'config', 'user.email', 'clue@example.invalid');
    git(local, 'config', 'user.name', 'CLU-E Selftest');
    git(local, 'checkout', '-b', 'main');
    writeFileSync(join(local, 'state.txt'), 'one\n', 'utf8');
    git(local, 'add', 'state.txt');
    git(local, 'commit', '-m', 'initial');
    git(local, 'push', remoteUrl, 'HEAD:refs/heads/main');

    const configured = project(local, remoteUrl);
    const unchanged = manualGitSync(configured, '2026-08-14T09:01:00.000Z');
    assert.equal(unchanged.state, 'unchanged');
    assert.equal(unchanged.code, 'OK');
    assert.equal(unchanged.ahead, 0);
    assert.equal(unchanged.behind, 0);

    writeFileSync(join(local, 'state.txt'), 'one\ntwo-local\n', 'utf8');
    git(local, 'add', 'state.txt');
    git(local, 'commit', '-m', 'local ahead');
    const pushed = manualGitSync(configured, '2026-08-14T09:02:00.000Z');
    assert.equal(pushed.state, 'pushed');
    assert.equal(pushed.ahead, 1);
    assert.equal(pushed.behind, 0);

    git(root, 'clone', '--branch', 'main', remoteUrl, peer);
    git(peer, 'config', 'user.email', 'peer@example.invalid');
    git(peer, 'config', 'user.name', 'Peer Selftest');
    writeFileSync(join(peer, 'remote.txt'), 'remote-only\n', 'utf8');
    git(peer, 'add', 'remote.txt');
    git(peer, 'commit', '-m', 'remote ahead');
    git(peer, 'push', 'origin', 'main');

    const fastForwarded = manualGitSync(configured, '2026-08-14T09:03:00.000Z');
    assert.equal(fastForwarded.state, 'fast_forwarded');
    assert.equal(fastForwarded.ahead, 0);
    assert.equal(fastForwarded.behind, 1);
    assert.equal(git(local, 'rev-parse', 'HEAD'), git(peer, 'rev-parse', 'HEAD'));

    writeFileSync(join(local, 'dirty.txt'), 'not committed\n', 'utf8');
    const dirty = manualGitSync(configured, '2026-08-14T09:04:00.000Z');
    assert.equal(dirty.state, 'refused');
    assert.equal(dirty.code, 'DIRTY_WORKTREE');
    rmSync(join(local, 'dirty.txt'));

    writeFileSync(join(local, 'local-diverge.txt'), 'local\n', 'utf8');
    git(local, 'add', 'local-diverge.txt');
    git(local, 'commit', '-m', 'local divergence');
    writeFileSync(join(peer, 'remote-diverge.txt'), 'remote\n', 'utf8');
    git(peer, 'add', 'remote-diverge.txt');
    git(peer, 'commit', '-m', 'remote divergence');
    git(peer, 'push', 'origin', 'main');

    const diverged = manualGitSync(configured, '2026-08-14T09:05:00.000Z');
    assert.equal(diverged.state, 'refused');
    assert.equal(diverged.code, 'DIVERGED');
    assert.equal(diverged.ahead, 1);
    assert.equal(diverged.behind, 1);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
