/** P43 — exact accepted-ref landing and rollback on disposable repositories. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import type { Runtime } from '../src/control/runtime.js';
import { observeLocalLandingBase } from '../src/integration/git/landableProofBasis.js';
import { inspectLandingEvidence } from '../src/integration/git/localLandingEvidence.js';
import {
  applyLocalLanding,
  inspectLocalLanding,
  inspectLocalLandingBase,
  prepareLocalLanding,
  revertLocalLanding,
  type LocalLandingOperation,
} from '../src/integration/git/localLandingGit.js';
import { ProjectionStore } from '../src/memory/db.js';
import { EventLog } from '../src/memory/eventLog.js';
import { PROOF_EVENT_TYPES } from '../src/proof/proofContract.js';
import { hashBytes } from '../src/shared/ids.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

const targetBranch = 'main';
const landingPrefix = 'clue/accepted/';
const landingBranch = 'clue/accepted/p43-fixture';
const landingRef = `refs/heads/${landingBranch}`;
const first = Buffer.from('export const count = 1;\n');
const successor = Buffer.from('export const count = 2;\n');
const unchanged = Buffer.from('export const label = "fixture";\n');

const gitExe = process.platform === 'win32'
  ? join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe')
  : '/usr/bin/git';

function runGitBytes(cwd: string, args: readonly string[]): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/iu.test(key)));
  const out = spawnSync(gitExe, ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ALLOW_PROTOCOL: '',
      GIT_TERMINAL_PROMPT: '0',
    },
    shell: false, windowsHide: true, timeout: 30_000,
  });
  assert.equal(out.status, 0, `git ${args.join(' ')}\n${String(out.error ?? out.stderr)}`);
  return out.stdout;
}

function runGit(cwd: string, args: readonly string[]): string {
  return runGitBytes(cwd, args).toString('utf8').trimEnd();
}

function initializeGit(root: string): void {
  runGit(root, ['init', '--initial-branch=main', '--template=']);
  runGit(root, ['config', 'user.email', 'p43-fixture@example.invalid']);
  runGit(root, ['config', 'user.name', 'P43 disposable fixture']);
  runGit(root, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'count.ts'), first);
  writeFileSync(join(root, 'src', 'unchanged.ts'), unchanged);
  runGit(root, ['add', '--all']);
  runGit(root, ['commit', '-m', 'Disposable baseline']);
}

function fixture(run: (root: string) => void): void {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'clue-p43-')));
  try {
    initializeGit(root);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

function prepare(root: string, overrides: Partial<Parameters<typeof prepareLocalLanding>[0]> = {}) {
  const operations: readonly LocalLandingOperation[] = [{ op: 'write', path: 'src/count.ts', content: successor,
    sha256: hashBytes(successor), baseSha256: hashBytes(first) }];
  return prepareLocalLanding({
    repositoryRoot: root, targetBranch, landingBranchPrefix: landingPrefix, landingBranch,
    ...inspectLocalLandingBase(root, targetBranch), proofId: 'EVENT-000001', proofTimestamp: '2026-11-14T10:00:00.000Z',
    operations, ...overrides,
  });
}

function assertWorktree(root: string, head: string): void {
  assert.equal(runGit(root, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
  assert.equal(runGit(root, ['rev-parse', 'HEAD']), head);
  assert.equal(runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.deepEqual(readFileSync(join(root, 'src', 'count.ts')), first);
  assert.deepEqual(readFileSync(join(root, 'src', 'unchanged.ts')), unchanged);
}

test('P43 lands an exact one-parent commit and restores the base tree with an append-only rollback', () => {
  fixture((root) => {
    const plan = prepare(root);
    assert.equal(inspectLocalLanding(plan).state, 'not_applied');
    assert.equal(runGit(root, ['for-each-ref', '--format=%(refname)', landingRef]), '');

    assert.equal(applyLocalLanding(plan).state, 'applied');
    assert.equal(runGit(root, ['rev-parse', landingRef]), plan.acceptedCommit);
    assert.equal(runGit(root, ['rev-parse', `${landingRef}^`]), plan.baseCommit);
    assert.equal(runGit(root, ['rev-parse', `${landingRef}^{tree}`]), plan.acceptedTree);
    assert.deepEqual(runGitBytes(root, ['cat-file', 'blob', `${landingRef}:src/count.ts`]), successor);
    assert.deepEqual(runGitBytes(root, ['cat-file', 'blob', `${landingRef}:src/unchanged.ts`]), unchanged);
    assert.equal(runGit(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', landingRef]), 'src/count.ts');
    assert.equal(applyLocalLanding({ ...plan }).state, 'applied');
    assertWorktree(root, plan.baseCommit);

    assert.equal(revertLocalLanding(plan).state, 'rolled_back');
    assert.equal(runGit(root, ['rev-parse', landingRef]), plan.rollbackCommit);
    assert.equal(runGit(root, ['rev-parse', `${landingRef}^`]), plan.acceptedCommit);
    assert.equal(runGit(root, ['rev-parse', `${landingRef}^{tree}`]), plan.baseTree);
    assert.equal(revertLocalLanding({ ...plan }).state, 'rolled_back');
    assert.throws(() => applyLocalLanding(plan));
    assertWorktree(root, plan.baseCommit);
  });
});

test('P43 proof basis records only a clean Project Profile Git parent on the expected branch', (t) => {
  const project = makeProjectProfileFixture();
  t.after(() => project.dispose());
  initializeGit(project.target);
  const record = new ProjectProfileRegistry(project.profilesRoot).create(project.profile);
  const base = inspectLocalLandingBase(project.target, targetBranch);
  assert.deepEqual(observeLocalLandingBase(record, project.target),
    { branch: targetBranch, commit: base.baseCommit, tree: base.baseTree });
  assert.equal(observeLocalLandingBase(null, project.target), null);
  assert.equal(observeLocalLandingBase(record, project.workspace), null);
  const wrongPin = {
    ...record,
    profile: {
      ...record.profile,
      integrations: {
        ...record.profile.integrations,
        git: { ...record.profile.integrations.git, currentBasePin: '0'.repeat(base.baseCommit.length) },
      },
    },
  };
  assert.equal(observeLocalLandingBase(wrongPin, project.target), null);
  runGit(project.target, ['checkout', '--detach']);
  assert.equal(observeLocalLandingBase(record, project.target), null);
  runGit(project.target, ['checkout', targetBranch]);
  writeFileSync(join(project.target, 'src', 'count.ts'), 'local work\n');
  assert.equal(observeLocalLandingBase(record, project.target), null);
});

test('P43 never treats a durable benchmark refusal or a rejected verdict as landing authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-p43-proof-refusal-'));
  try {
    const eventLogRoot = join(root, 'events');
    const { log } = EventLog.open(eventLogRoot);
    try {
      const projections = new ProjectionStore(join(root, 'clue.db'));
      try {
        const scope = { actor: 'cli' as const, missionVersion: 'MISSION-000001', subjectId: 'CYCLE-000001' };
        const refused = log.append({ ...scope, type: PROOF_EVENT_TYPES.executionRefused,
          payload: { stage: 'instrument', reason: 'The timing spread exceeded the allowed limit.' } });
        const rejected = log.append({ ...scope, type: PROOF_EVENT_TYPES.verdictRecorded,
          payload: { disposition: 'REJECT' } });
        projections.sync(log);
        const observer = { log: null, projectState: { eventLogRoot }, projections } as unknown as Runtime;
        const head = log.getHead();
        for (const eventId of [refused.id, rejected.id, 'EVENT-999999']) {
          assert.throws(() => inspectLandingEvidence(observer, eventId, []), /requires a recorded ACCEPT verdict/u);
        }
        assert.deepEqual(log.getHead(), head);
      } finally {
        projections.close();
      }
    } finally {
      log.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('P43 refuses bad bytes or a destination outside the authorized landing namespace', () => {
  fixture((root) => {
    const base = inspectLocalLandingBase(root, targetBranch);
    assert.throws(() => prepare(root, { operations: [{ op: 'write', path: 'src/count.ts', content: successor,
      sha256: hashBytes(first), baseSha256: hashBytes(first) }] }));
    assert.throws(() => prepare(root, { operations: [{ op: 'write', path: 'src/count.ts', content: successor,
      sha256: hashBytes(successor), baseSha256: hashBytes(successor) }] }));
    for (const forbidden of ['main', 'clue/accepted/../main', 'clue/accepted/bad.lock']) {
      assert.throws(() => prepare(root, { landingBranch: forbidden }), forbidden);
    }
    assert.equal(runGit(root, ['for-each-ref', '--format=%(refname)', `refs/heads/${landingPrefix}`]), '');
    assertWorktree(root, base.baseCommit);
  });
});

test('P43 round-trips additions and deletions and derives the same plan for a repeated review', () => {
  fixture((root) => {
    const operations: readonly LocalLandingOperation[] = [
      { op: 'write', path: 'src/replacement.ts', content: successor,
        sha256: hashBytes(successor), baseSha256: null },
      { op: 'delete', path: 'src/count.ts', baseSha256: hashBytes(first) },
    ];
    const plan = prepare(root, { operations });
    assert.deepEqual(prepare(root, { operations }), plan);
    assert.equal(applyLocalLanding(plan).state, 'applied');
    assert.equal(runGit(root, ['ls-tree', '-r', '--name-only', landingRef]), 'src/replacement.ts\nsrc/unchanged.ts');
    assert.deepEqual(runGitBytes(root, ['cat-file', 'blob', `${landingRef}:src/replacement.ts`]), successor);
    assert.equal(revertLocalLanding(plan).state, 'rolled_back');
    assert.equal(runGit(root, ['ls-tree', '-r', '--name-only', landingRef]), 'src/count.ts\nsrc/unchanged.ts');
    assertWorktree(root, plan.baseCommit);
  });
});

test('P43 checks repository and branch drift before mutation and preserves a newer landing ref', () => {
  fixture((root) => {
    const plan = prepare(root);
    writeFileSync(join(root, 'src', 'count.ts'), 'local work\n');
    assert.throws(() => applyLocalLanding(plan));
    assert.equal(readFileSync(join(root, 'src', 'count.ts'), 'utf8'), 'local work\n');
    writeFileSync(join(root, 'src', 'count.ts'), first);
    runGit(root, ['update-ref', landingRef, plan.baseCommit]);
    assert.throws(() => applyLocalLanding(plan));
    assert.equal(runGit(root, ['rev-parse', landingRef]), plan.baseCommit);
    runGit(root, ['update-ref', '-d', landingRef, plan.baseCommit]);

    runGit(root, ['symbolic-ref', landingRef, 'refs/heads/main']);
    assert.throws(() => applyLocalLanding(plan));
    assert.equal(runGit(root, ['symbolic-ref', landingRef]), 'refs/heads/main');
    runGit(root, ['symbolic-ref', '--delete', landingRef]);

    applyLocalLanding(plan);
    const newer = runGit(root, ['commit-tree', plan.baseTree, '-p', plan.acceptedCommit, '-m', 'A newer owner action']);
    runGit(root, ['update-ref', landingRef, newer, plan.acceptedCommit]);
    assert.throws(() => revertLocalLanding(plan));
    assert.equal(runGit(root, ['rev-parse', landingRef]), newer);
    assertWorktree(root, plan.baseCommit);
  });
});

test('P43 refuses to roll back a landing branch checked out by another worktree', () => {
  fixture((root) => {
    const plan = prepare(root);
    applyLocalLanding(plan);
    const linked = mkdtempSync(join(tmpdir(), 'clue-p43-linked-'));
    try {
      runGit(root, ['worktree', 'add', '--quiet', linked, landingBranch]);
      assert.throws(() => revertLocalLanding(plan));
      assert.equal(runGit(root, ['rev-parse', landingRef]), plan.acceptedCommit);
      assert.deepEqual(readFileSync(join(linked, 'src', 'count.ts')), successor);
      runGit(root, ['worktree', 'remove', linked]);
      assert.equal(revertLocalLanding(plan).state, 'rolled_back');
      assertWorktree(root, plan.baseCommit);
    } finally {
      rmSync(linked, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test('P43 refuses to turn line-converted baseline bytes into a raw Git proof or use custom filters', () => {
  fixture((root) => {
    const converted = Buffer.from(first.toString().replace(/\n/gu, '\r\n'));
    runGit(root, ['config', 'core.autocrlf', 'true']);
    rmSync(join(root, 'src', 'count.ts'));
    runGit(root, ['checkout', '--', 'src/count.ts']);
    assert.deepEqual(readFileSync(join(root, 'src', 'count.ts')), converted);
    assert.equal(runGit(root, ['status', '--porcelain=v1']), '', 'Git considers line-converted bytes clean');
    assert.throws(() => prepare(root, { operations: [{ op: 'write', path: 'src/count.ts', content: successor,
      sha256: hashBytes(successor), baseSha256: hashBytes(converted) }] }));
    assert.equal(runGit(root, ['for-each-ref', '--format=%(refname)', landingRef]), '');

    runGit(root, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(root, 'src', 'count.ts'), first);
    runGit(root, ['config', 'filter.p43-fixture.clean', 'exit 0']);
    assert.throws(() => prepare(root));
    assert.equal(runGit(root, ['for-each-ref', '--format=%(refname)', landingRef]), '');
  });
});

test('P43 does not execute ref hooks or use Git context inherited from the caller', () => {
  fixture((root) => {
    const base = inspectLocalLandingBase(root, targetBranch);
    const hooks = join(root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const marker = join(root, '.git', 'reference-hook-ran');
    writeFileSync(join(hooks, 'reference-transaction'), '#!/bin/sh\nprintf fired > .git/reference-hook-ran\n', { mode: 0o755 });
    const oldDir = process.env['GIT_DIR'];
    const oldIndex = process.env['GIT_INDEX_FILE'];
    process.env['GIT_DIR'] = join(root, 'not-a-git-dir');
    process.env['GIT_INDEX_FILE'] = join(root, 'not-a-git-index');
    try {
      const plan = prepare(root);
      assert.equal(applyLocalLanding(plan).state, 'applied');
      assert.equal(revertLocalLanding(plan).state, 'rolled_back');
    } finally {
      if (oldDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = oldDir;
      if (oldIndex === undefined) delete process.env['GIT_INDEX_FILE'];
      else process.env['GIT_INDEX_FILE'] = oldIndex;
    }
    assert.equal(existsSync(marker), false);
    assertWorktree(root, base.baseCommit);
  });
});

test('P43 permits inactive operating-system Git LFS defaults and refuses an affected path with a filter', () => {
  fixture((root) => {
    const home = mkdtempSync(join(tmpdir(), 'clue-p43-home-'));
    const formerHome = process.env['HOME'];
    try {
      // Git for Windows may register these defaults system-wide even when the target does not use LFS.
      writeFileSync(join(home, '.gitconfig'), '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\trequired = true\n');
      process.env['HOME'] = home;
      const plan = prepare(root);
      assert.equal(inspectLocalLanding(plan).state, 'not_applied');
      writeFileSync(join(root, '.gitattributes'), 'src/count.ts filter=lfs\n');
      runGit(root, ['add', '--', '.gitattributes']);
      runGit(root, ['commit', '-m', 'Mark fixture as filter-managed']);
      assert.throws(() => prepare(root));
      assert.equal(runGit(root, ['for-each-ref', '--format=%(refname)', landingRef]), '');
    } finally {
      if (formerHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = formerHome;
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
