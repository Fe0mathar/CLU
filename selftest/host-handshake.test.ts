/**
 * DEV-P0-11 — startup handshake root parity.
 *
 * The client declares the authoritative operating roots (canonical, shadow, workspace, browser
 * profile) it requires; `start()` sends them in the hello, and the host echoes the roots it will
 * enforce. The handshake completes only when every echoed root matches. This proves the client sends
 * its roots, accepts a host that agrees, and refuses — before any command — a host that echoes a
 * different root or none at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PolicyEngine, SecretRegistry } from '../src/control/policy.js';
import { type ClueConfig } from '../src/shared/schemas.js';
import type { ProjectOperationIdentity } from '../src/shared/projectOperationIdentity.js';
import { HostClient, type HostRoots, type HostSpawn } from '../src/experiment/host/hostClient.js';

const config = {
  project: { root: '/srv/proj' },
  workspace: { root: '/srv/ws' },
  shadow: { root: '/srv/shadow' },
  browser: { profile_dir: '/srv/profile' },
  security: { canonical_source_writes: 'denied' },
  patching: { landing_branch_prefix: 'clue/accepted/' },
} as unknown as ClueConfig;

const ROOTS: HostRoots = {
  canonical: '/srv/proj',
  shadow: '/srv/shadow',
  workspace: '/srv/ws',
  browserProfile: '/srv/profile',
};

const PROJECT_IDENTITY: ProjectOperationIdentity = {
  projectId: 'alpha',
  targetRootIdentity: 'path:v1:linux:' + 'a'.repeat(64),
  projectProfileHash: 'profile:v1:' + 'b'.repeat(64),
};

/** A fake host that answers the hello with a banner carrying `replyRoots` (or none when null). */
function fakeSpawn(
  replyRoots: HostRoots | null,
  replyProjectIdentity?: ProjectOperationIdentity,
): { spawn: HostSpawn; captured: () => Record<string, unknown> | null } {
  let listener: (line: string) => void = () => {};
  let captured: Record<string, unknown> | null = null;
  const spawn: HostSpawn = () => ({
    writeLine(line: string): void {
      const request = JSON.parse(line) as Record<string, unknown>;
      captured = request;
      const result: Record<string, unknown> = { host: 'clue-host', protocol: 1, pwshVersion: '7.4.6', os: 'linux' };
      if (replyRoots !== null) result['roots'] = replyRoots;
      if (replyProjectIdentity !== undefined) result['projectIdentity'] = replyProjectIdentity;
      const reply = JSON.stringify({
        v: 1,
        id: request['id'],
        ok: true,
        result,
        ...(replyProjectIdentity === undefined ? {} : { projectIdentity: replyProjectIdentity }),
      });
      queueMicrotask(() => listener(reply));
    },
    onLine(l: (line: string) => void): void {
      listener = l;
    },
    onExit(): void {
      /* never exits under test */
    },
    kill(): void {
      /* nothing to tear down */
    },
  });
  return { spawn, captured: () => captured };
}

function clientWith(spawn: HostSpawn, projectIdentity?: ProjectOperationIdentity): HostClient {
  const policy = new PolicyEngine(config, new SecretRegistry());
  const token = policy.issueToken('daemon', ['process.run.host'], { subjectId: 'TASK-A', purpose: 'refute', attempt: 1 });
  return new HostClient({
    executable: 'pwsh',
    scriptPath: 'host.ps1',
    policy,
    actor: 'daemon',
    tokenSecret: token.secret,
    operationSubjectId: 'TASK-A',
    operationPurpose: 'refute',
    operationAttempt: 1,
    hostRoots: ROOTS,
    ...(projectIdentity === undefined ? {} : { projectIdentity }),
    spawn,
  });
}

test('the client sends its authoritative roots and accepts a host that echoes matching roots', async () => {
  const host = fakeSpawn(ROOTS);
  const client = clientWith(host.spawn);
  const started = await client.start();

  assert.equal(started.ok, true, 'the handshake completes when roots agree');
  if (started.ok) assert.deepEqual(started.value.roots, ROOTS);

  // The client actually put its roots on the wire.
  const sent = host.captured();
  assert.ok(sent !== null);
  const args = sent['args'] as Record<string, unknown> | undefined;
  assert.deepEqual(args?.['roots'], ROOTS, 'the hello carried the authoritative roots');
  client.stop();
});

test('the client refuses a host that echoes a different root', async () => {
  const host = fakeSpawn({ ...ROOTS, shadow: '/srv/somewhere-else' });
  const started = await clientWith(host.spawn).start();
  assert.equal(started.ok, false, 'a mismatched root fails the handshake');
  if (!started.ok) assert.equal(started.error.code, 'ROOT_PARITY_MISMATCH');
});

test('the client refuses a host that does not echo the roots at all', async () => {
  const host = fakeSpawn(null);
  const started = await clientWith(host.spawn).start();
  assert.equal(started.ok, false, 'a host that omits roots fails the handshake');
  if (!started.ok) assert.equal(started.error.code, 'ROOT_PARITY_MISMATCH');
});

test('DEV-P0-11 (§5.11): start passes the four mandatory host roots as startup parameters', async () => {
  const host = fakeSpawn(ROOTS);
  let spawnArgs: readonly string[] = [];
  const capturingSpawn: HostSpawn = (exe, args) => {
    spawnArgs = args;
    return host.spawn(exe, args);
  };
  const client = clientWith(capturingSpawn);
  const started = await client.start();
  assert.equal(started.ok, true, 'the handshake completes');

  // Without these, the real host script cannot start; each carries the client's authoritative root.
  const pairAt = (flag: string): string | undefined => spawnArgs[spawnArgs.indexOf(flag) + 1];
  assert.equal(pairAt('-CanonicalRoot'), ROOTS.canonical, 'the canonical root is passed to the host script');
  assert.equal(pairAt('-ShadowRoot'), ROOTS.shadow, 'the shadow root is passed');
  assert.equal(pairAt('-WorkspaceRoot'), ROOTS.workspace, 'the workspace root is passed');
  assert.equal(pairAt('-BrowserProfileDir'), ROOTS.browserProfile, 'the browser profile dir is passed');
  // DEV-P0-11/12: without this, a default Windows execution policy refuses to load the unsigned host
  // script and the host never starts.
  assert.equal(pairAt('-ExecutionPolicy'), 'Bypass', 'pwsh is invoked with -ExecutionPolicy Bypass');
  client.stop();
});


test('PP-21: a profile-bound client pins project identity in startup argv and every request', async () => {
  const host = fakeSpawn(ROOTS, PROJECT_IDENTITY);
  let spawnArgs: readonly string[] = [];
  const capturingSpawn: HostSpawn = (exe, args) => {
    spawnArgs = args;
    return host.spawn(exe, args);
  };
  const client = clientWith(capturingSpawn, PROJECT_IDENTITY);
  const started = await client.start();
  assert.equal(started.ok, true);
  const identityArgument = spawnArgs[spawnArgs.indexOf('-ProjectIdentityJson') + 1];
  assert.deepEqual(JSON.parse(identityArgument ?? '{}'), PROJECT_IDENTITY);
  const request = host.captured();
  assert.deepEqual(request?.['projectIdentity'], PROJECT_IDENTITY);
  client.stop();
});

test('PP-21: missing or mismatched host project identity fails before governed commands', async () => {
  const missing = await clientWith(fakeSpawn(ROOTS).spawn, PROJECT_IDENTITY).start();
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'PROJECT_IDENTITY_MISMATCH');

  const mismatched = await clientWith(
    fakeSpawn(ROOTS, { ...PROJECT_IDENTITY, projectProfileHash: 'profile:v1:' + 'c'.repeat(64) }).spawn,
    PROJECT_IDENTITY,
  ).start();
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.error.code, 'PROJECT_IDENTITY_MISMATCH');
});

test('DEV-P0-09 (§5.10): a land ref outside the landing prefix is POLICY_DENIED at the client, before the host', async () => {
  const landingConfig = { ...config, security: { canonical_source_writes: 'custodian_only' } } as unknown as ClueConfig;
  const policy = new PolicyEngine(landingConfig, new SecretRegistry());
  const token = policy.issueToken('custodian', ['git.land.canonical'], { subjectId: 'TASK-A', purpose: 'synthesize', attempt: 1 });
  const client = new HostClient({
    executable: 'pwsh',
    scriptPath: 'host.ps1',
    policy,
    actor: 'custodian',
    tokenSecret: token.secret,
    operationSubjectId: 'TASK-A',
    operationPurpose: 'synthesize',
    operationAttempt: 1,
  });

  // The host is never started: authorisation runs before the wire, so an off-prefix land ref is refused
  // as a policy denial — not the NOT_STARTED host-state error it slipped through to before the ref reached
  // the engine (§5.10). This is the exact counterexample the assessment reproduced.
  const offPrefix = await client.git({
    zone: 'canonical',
    root: '/srv/proj',
    verb: 'mergeFfOnly',
    params: { of: 'ref', ref: 'refs/heads/main' },
  });
  assert.equal(offPrefix.ok, false);
  if (!offPrefix.ok) {
    assert.equal(offPrefix.error.code, 'POLICY_DENIED', 'the off-prefix ref is denied by the engine, at the client');
  }

  // A ref inside the landing prefix clears the policy and only then meets the un-started host — proving the
  // denial is the ref's doing, not a blanket refusal of the verb.
  const inPrefix = await client.git({
    zone: 'canonical',
    root: '/srv/proj',
    verb: 'mergeFfOnly',
    params: { of: 'ref', ref: 'clue/accepted/patch-1' },
  });
  assert.equal(inPrefix.ok, false);
  if (!inPrefix.ok) {
    assert.notEqual(inPrefix.error.code, 'POLICY_DENIED', 'an in-prefix ref clears policy and reaches the host-state check');
  }
});