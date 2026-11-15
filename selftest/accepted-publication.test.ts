/** P44 — exact publication and reconciliation, without contacting a hosted repository. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { enableProjectProfileStartup, projectProfileCutoverConfirmation } from '../src/control/projectProfiles/projectProfileStartup.js';
import { PolicyEngine } from '../src/control/policy.js';
import type { Runtime } from '../src/control/runtime.js';
import { previewAcceptedPublication, publishAcceptedSource } from '../src/integration/git/acceptedPublication.js';
import {
  makeAcceptedPublicationGit,
  normalizeAcceptedGitHubRemote,
} from '../src/integration/git/acceptedPublicationGit.js';
import {
  applyLocalLanding, inspectLocalLandingBase, prepareLocalLanding,
} from '../src/integration/git/localLandingGit.js';
import { ProjectionStore } from '../src/memory/db.js';
import { EventLog } from '../src/memory/eventLog.js';
import { PROOF_EVENT_TYPES } from '../src/proof/proofContract.js';
import { hashBytes } from '../src/shared/ids.js';
import type { ClueConfig } from '../src/shared/schemas.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

const remote = 'https://github.com/Example/Clue.git';
const branch = 'clue/accepted/cycle-000011-event-012565';
const ref = 'refs/heads/' + branch;
const baseRef = 'refs/heads/main';
const commit = 'a'.repeat(40);
const other = 'b'.repeat(40);
const baseCommit = 'c'.repeat(40);
const baseRow = `${baseCommit}\t${baseRef}\r\n`;
const observed = (oid: string | null) => ({ code: 0, stdout: baseRow + (oid === null ? '' : `${oid}\t${ref}\r\n`) });

type Invoke = Parameters<typeof makeAcceptedPublicationGit>[0]['invoke'];

function fake(replies: readonly ({ code: number; stdout: string } | Error)[], verifyLocal = () => {}): {
  readonly transport: ReturnType<typeof makeAcceptedPublicationGit>;
  readonly calls: readonly (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  const pending = [...replies];
  const invoke: Invoke = async (args) => {
    calls.push([...args]);
    const reply = pending.shift();
    assert.ok(reply, 'unexpected Git command');
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, transport: makeAcceptedPublicationGit({ remote, ref, commit, baseRef, baseCommit, verifyLocal, invoke }) };
}

test('P44 publishes only the exact accepted object to an absent approved ref and verifies the readback', async () => {
  const { transport, calls } = fake([observed(null), { code: 0, stdout: `*\t${commit}:${ref}\t[new branch]\n` }, observed(commit)]);
  const result = await transport.publish(null);
  assert.equal(result.remote, remote);
  assert.equal(result.ref, ref);
  assert.equal(result.commit, commit);
  assert.equal(result.baseRef, baseRef);
  assert.equal(result.baseCommit, baseCommit);
  assert.equal(result.disposition, 'CREATED');
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.[0], 'ls-remote');
  assert.equal(calls[2]?.[0], 'ls-remote');
  assert.deepEqual(calls[0]?.slice(-3), [remote, ref, baseRef]);
  const push = calls[1];
  assert.ok(push);
  assert.equal(push[0], 'push');
  assert.deepEqual(push.slice(-3), ['--', remote, `${commit}:${ref}`]);
  assert.ok(push.includes('--porcelain'));
  assert.ok(push.includes('--no-verify'));
  assert.ok(push.includes('--no-signed'));
  assert.ok(push.includes('--no-follow-tags'));
  assert.ok(push.includes('--recurse-submodules=no'));
  assert.ok(push.includes(`--force-with-lease=${ref}:`));
  assert.equal(push.some((arg) => ['--force', '-f', '--mirror', '--all', '--tags', '--delete'].includes(arg)), false);
});

test('P44 grants publication only to the Custodian for a concrete accepted branch', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const config = {
      project: { root: fixture.target }, workspace: { root: fixture.workspace }, shadow: { root: fixture.shadow },
      browser: { profile_dir: fixture.browserProfile }, security: { canonical_source_writes: 'custodian_only' },
      patching: { landing_branch_prefix: 'clue/accepted/' },
    } as unknown as ClueConfig;
    const policy = new PolicyEngine(config);
    const capability = 'git.push.accepted' as const;
    assert.throws(() => policy.issueToken('creator', [capability]), /cannot be granted/u);
    assert.throws(() => policy.issueToken('cli', [capability]), /cannot be granted/u);
    const token = policy.issueToken('custodian', [capability], { subjectId: 'EVENT-000011', purpose: 'publication' });
    const request = { actor: 'custodian' as const, capability, command: 'publication.push.accepted', target: fixture.target,
      subjectId: 'EVENT-000011', purpose: 'publication', tokenSecret: token.secret };
    for (const gitRef of [null, 'clue/accepted/', 'main', 'refs/heads/main', 'clue/accepted/../main']) {
      assert.equal(policy.evaluate({ ...request, gitRef }).code, 'GIT_REF_FORBIDDEN', String(gitRef));
    }
    assert.equal(policy.evaluate({ ...request, actor: 'creator', gitRef: branch }).code, 'LANDING_WRONG_ACTOR');
    assert.equal(policy.evaluate({ ...request, subjectId: 'EVENT-000012', gitRef: branch }).code, 'TOKEN_SUBJECT_MISMATCH');
    assert.equal(policy.evaluate({ ...request, gitRef: branch }).decision, 'allowed');
    assert.equal(policy.revokeToken(token.secret), true);
    assert.equal(policy.evaluate({ ...request, gitRef: branch }).code, 'TOKEN_UNKNOWN');
  } finally { fixture.dispose(); }
});

test('P44 treats an identical remote tip as idempotent and refuses a foreign ref without sending a push', async () => {
  for (const expected of [null, commit]) {
    const existing = fake([observed(commit)]);
    assert.equal((await existing.transport.publish(expected)).disposition, 'ALREADY_PRESENT');
    assert.equal(existing.calls.length, 1);
  }
  const moved = fake([observed(other)]);
  await assert.rejects(() => moved.transport.publish(null));
  assert.equal(moved.calls.some(([verb]) => verb === 'push'), false);
});

test('P44 refuses a different post-push tip, even after Git reported that the send succeeded', async () => {
  const { transport, calls } = fake([observed(null), { code: 0, stdout: 'send succeeded' }, observed(other)]);
  await assert.rejects(() => transport.publish(null));
  assert.equal(calls.filter(([verb]) => verb === 'push').length, 1);
});

test('P44 requires the exact registered remote base before and after a push', async () => {
  const movedBase = { code: 0, stdout: `${other}\t${baseRef}\n` };
  const movedBefore = fake([movedBase]);
  await assert.rejects(() => movedBefore.transport.publish(null));
  assert.equal(movedBefore.calls.some(([verb]) => verb === 'push'), false);
  const movedAfter = fake([observed(null), { code: 0, stdout: '' }, {
    code: 0, stdout: movedBase.stdout + `${commit}\t${ref}\n`,
  }]);
  await assert.rejects(() => movedAfter.transport.publish(null));
  assert.equal(movedAfter.calls.filter(([verb]) => verb === 'push').length, 1);
});

test('P44 reconciles a lost push response only from an exact remote readback', async () => {
  for (const failedReply of [{ code: 1, stdout: 'connection closed' }, new Error('transport lost')]) {
    const confirmed = fake([observed(null), failedReply, observed(commit)]);
    assert.equal((await confirmed.transport.publish(null)).disposition, 'RECOVERED');
    assert.equal(confirmed.calls.filter(([verb]) => verb === 'push').length, 1);
  }
  const missing = fake([observed(null), { code: 1, stdout: 'connection closed' }, observed(null)]);
  await assert.rejects(() => missing.transport.publish(null));
  assert.equal(missing.calls.filter(([verb]) => verb === 'push').length, 1);
});

test('P44 does not trust unexpected ref rows or arbitrary provider output', async () => {
  for (const stdout of [
    baseRow + `${commit}\trefs/heads/unknown\n`,
    baseRow + `${commit}\t${ref}\n${other}\t${ref}\n`,
    baseRow + `${commit}\t${ref}\nprovider message\n`,
    baseRow + `bad-object\t${ref}\n`,
    baseRow + baseRow,
  ]) {
    const { transport, calls } = fake([{ code: 0, stdout }]);
    await assert.rejects(() => transport.publish(null));
    assert.equal(calls.some(([verb]) => verb === 'push'), false);
  }
});

test('P44 rechecks live local eligibility before network operations', async () => {
  const blocked = fake([], () => { throw new Error('local accepted ref changed'); });
  await assert.rejects(() => blocked.transport.inspect(), /local accepted ref changed/u);
  await assert.rejects(() => blocked.transport.publish(null), /local accepted ref changed/u);
  assert.equal(blocked.calls.length, 0);
});

test('P44 accepts only canonical GitHub repository URLs and exact ref and object identities', async () => {
  assert.equal(normalizeAcceptedGitHubRemote(remote), remote);
  for (const invalid of [
    'http://github.com/Example/Clue.git',
    'https://github.com:443/Example/Clue.git',
    'https://github.com.evil.invalid/Example/Clue.git',
    'https://account@github.com/Example/Clue.git',
    'https://github.com/Example/Clue.git?token=abc',
    'https://github.com/Example/Clue.git#main',
    'https://github.com/Example/Clue.git/another',
    'https://github.com/Example/Clue.git\n',
    'https://github.com/Example/%43lue.git',
    'https://github.com/Example/../Clue.git',
    'https://github.com/Example/foo\\Clue.git',
    'ext::git host',
  ]) {
    assert.throws(() => normalizeAcceptedGitHubRemote(invalid), invalid);
  }
  for (const overrides of [
    { ref: 'refs/heads/main' },
    { ref: 'refs/heads/clue/accepted/../main' },
    { ref: 'refs/tags/accepted' },
    { ref: `+${ref}` },
    { commit: 'HEAD' },
    { commit: '0'.repeat(40) },
    { remote: 'https://somewhere.invalid/Example/Clue.git' },
  ]) {
    const calls: string[] = [];
    await assert.rejects(async () => {
      const transport = makeAcceptedPublicationGit({
        remote, ref, commit, baseRef, baseCommit, verifyLocal: () => {},
        invoke: async (args) => { calls.push(...args); return observed(null); },
        ...overrides,
      });
      return await transport.publish(null);
    });
    assert.deepEqual(calls, []);
  }
});

test('P44 refuses missing, declined, and incomplete P43 publication evidence without writing anything', async () => {
  const fixture = makeProjectProfileFixture();
  const eventLogRoot = fixture.profile.state.eventLogRoot;
  const { log } = EventLog.open(eventLogRoot);
  try {
    const projections = new ProjectionStore(join(fixture.root, 'p44-fixture.db'));
    try {
      const scope = { actor: 'cli' as const, missionVersion: 'MISSION-000001', subjectId: 'CYCLE-000001' };
      const refused = log.append({ ...scope, type: PROOF_EVENT_TYPES.executionRefused,
        payload: { stage: 'instrument', reason: 'No complete measurements.' } });
      const rejected = log.append({ ...scope, type: PROOF_EVENT_TYPES.verdictRecorded, payload: { disposition: 'REJECT' } });
      const accepted = log.append({ ...scope, type: PROOF_EVENT_TYPES.verdictRecorded, payload: { disposition: 'ACCEPT' } });
      projections.sync(log);
      const runtime = { log: null, projectState: { eventLogRoot }, projectProfile: null, projections };
      const observe = (id: string) => previewAcceptedPublication(runtime as unknown as Runtime, id);
      const head = log.getHead();
      for (const id of [refused.id, rejected.id, 'EVENT-999999']) {
        assert.throws(() => observe(id), /needs an ACCEPT verdict/u);
        await assert.rejects(() => publishAcceptedSource(runtime as unknown as Runtime, id, 'wrong confirmation'),
          /needs an ACCEPT verdict/u);
      }
      assert.throws(() => observe(accepted.id), /requires the active saved Project Profile/u);
      assert.deepEqual(log.getHead(), head);

      const registry = new ProjectProfileRegistry(fixture.profilesRoot);
      const profile = registry.create({ ...fixture.profile, integrations: { ...fixture.profile.integrations, git: {
        ...fixture.profile.integrations.git, publicationMode: 'REMOTE_REGISTERED', provider: 'github', remote,
      } } });
      mkdirSync(join(fixture.root, 'config'), { recursive: true });
      writeFileSync(join(fixture.root, 'config', 'clue.config.yaml'), '{}\n');
      enableProjectProfileStartup({ repoRoot: fixture.root, registry, projectId: profile.profile.projectId,
        confirmation: projectProfileCutoverConfirmation(profile) });
      const bound = { ...runtime, repoRoot: fixture.root, projectProfile: profile } as unknown as Runtime;
      assert.throws(() => previewAcceptedPublication(bound, accepted.id), /complete, verified P43 landing/u);
      assert.deepEqual(log.getHead(), head);

      for (const type of ['landing.local_prepared', 'landing.local_applied', 'landing.local_verified']) {
        log.append({ ...scope, actor: 'custodian', type, payload: { scope: { proofEventId: accepted.id } } });
      }
      projections.sync(log);
      const afterPoisonedReceipts = log.getHead();
      assert.throws(() => previewAcceptedPublication(bound, accepted.id));
      assert.deepEqual(log.getHead(), afterPoisonedReceipts);
    } finally { projections.close(); }
  } finally {
    log.close();
    fixture.dispose();
  }
});

const git = process.platform === 'win32' ? join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe') : '/usr/bin/git';

function runGit(root: string, args: readonly string[]) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)));
  const result = spawnSync(git, ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: { ...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' },
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, null, result.stderr);
  return { code: result.status!, stdout: result.stdout, stderr: result.stderr };
}

function mustGit(root: string, args: readonly string[]): string {
  const result = runGit(root, args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test('P44 Git refspec and empty-tip lease create exactly one ref on a disposable bare repository', async () => {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'clue-p44-publication-')));
  try {
    const root = join(sandbox, 'local');
    const bare = join(sandbox, 'remote.git');
    mkdirSync(root);
    mustGit(root, ['init', '--template=', '--initial-branch=main']);
    mustGit(root, ['config', 'user.name', 'CLU-E Publication Fixture']);
    mustGit(root, ['config', 'user.email', 'publication@example.invalid']);
    mustGit(root, ['config', 'core.autocrlf', 'false']);
    const before = Buffer.from('export const count = 1;\n');
    const after = Buffer.from('export const count = 2;\n');
    writeFileSync(join(root, 'count.ts'), before);
    mustGit(root, ['add', '--all']);
    mustGit(root, ['commit', '-m', 'Disposable baseline']);
    mustGit(sandbox, ['init', '--template=', '--bare', bare]);
    mustGit(root, ['push', '--', bare, `${baseRef}:${baseRef}`]);
    const plan = prepareLocalLanding({ repositoryRoot: root, targetBranch: 'main', landingBranchPrefix: 'clue/accepted/',
      landingBranch: branch, ...inspectLocalLandingBase(root, 'main'), proofId: 'EVENT-012565',
      proofTimestamp: '2026-11-14T13:56:46.889Z',
      operations: [{ op: 'write', path: 'count.ts', baseSha256: hashBytes(before), sha256: hashBytes(after), content: after }],
    });
    applyLocalLanding(plan);
    let beforePush = () => {};
    const invoke: Invoke = async (args) => {
      assert.equal(args.filter((arg) => arg === remote).length, 1);
      if (args[0] === 'push') beforePush();
      const { code, stdout } = runGit(root, args.map((arg) => arg === remote ? bare : arg));
      return { code, stdout };
    };
    const transport = makeAcceptedPublicationGit({
      remote, ref: plan.landingRef, commit: plan.acceptedCommit, baseRef, baseCommit: plan.baseCommit,
      verifyLocal: () => {
        assert.equal(mustGit(root, ['rev-parse', plan.landingRef]), plan.acceptedCommit);
      },
      invoke,
    });
    assert.equal((await transport.publish(null)).disposition, 'CREATED');
    assert.equal(mustGit(bare, ['for-each-ref', '--format=%(refname) %(objectname)']),
      `${plan.landingRef} ${plan.acceptedCommit}\n${baseRef} ${plan.baseCommit}`);
    assert.equal((await transport.publish(null)).disposition, 'ALREADY_PRESENT');
    assert.equal(mustGit(root, ['rev-parse', 'HEAD']), plan.baseCommit);

    // If another writer creates the ref after observation, an ordinary push would
    // fast-forward this parent. The empty-tip lease must preserve the other writer.
    mustGit(bare, ['update-ref', '-d', plan.landingRef, plan.acceptedCommit]);
    beforePush = () => { mustGit(bare, ['update-ref', plan.landingRef, plan.baseCommit]); };
    await assert.rejects(() => transport.publish(null));
    assert.equal(mustGit(bare, ['rev-parse', plan.landingRef]), plan.baseCommit);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  }
});
