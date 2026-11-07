/**
 * DEV-P0-09 — capability tokens are bound to subject, purpose, and attempt, and those bindings are
 * enforced through the production host-call path.
 *
 * `PolicyEngine.evaluate` already refuses a bound token used for any other subject, purpose, attempt,
 * or a host-confirmed zone that disagrees with its own classification. The gap was that
 * `HostClient.authorise` never carried the operation context into evaluation, so the bindings were
 * inert in production. The client now passes its operation subject/purpose/attempt, so a token minted
 * for task A cannot authorise a host call for task B — the call is denied before anything is sent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PolicyEngine, SecretRegistry, type PolicyRequest } from '../src/control/policy.js';
import { type ClueConfig } from '../src/shared/schemas.js';
import { HostClient } from '../src/experiment/host/hostClient.js';

const config = {
  project: { root: '/srv/proj' },
  workspace: { root: '/srv/ws' },
  shadow: { root: '/srv/shadow' },
  browser: { profile_dir: '/srv/profile' },
  security: { canonical_source_writes: 'denied' },
  patching: { landing_branch_prefix: 'clue/accepted/' },
} as unknown as ClueConfig;

function freshPolicy(): PolicyEngine {
  return new PolicyEngine(config, new SecretRegistry());
}

test('a bound token is refused for any other subject, purpose, attempt, or resolved zone', () => {
  const policy = freshPolicy();
  const token = policy.issueToken('daemon', ['fs.read.workspace', 'fs.write.workspace'], {
    subjectId: 'TASK-A',
    purpose: 'refute',
    attempt: 1,
  });
  const base: PolicyRequest = {
    actor: 'daemon',
    capability: 'fs.write.workspace',
    command: 'test',
    target: '/srv/ws/out.txt',
    tokenSecret: token.secret,
  };
  const evalWith = (extra: Partial<PolicyRequest>) => policy.evaluate({ ...base, ...extra });

  assert.equal(evalWith({ subjectId: 'TASK-A', purpose: 'refute', attempt: 1 }).decision, 'allowed');
  assert.equal(evalWith({ subjectId: 'TASK-B', purpose: 'refute', attempt: 1 }).code, 'TOKEN_SUBJECT_MISMATCH');
  assert.equal(evalWith({ subjectId: 'TASK-A', purpose: 'synthesize', attempt: 1 }).code, 'TOKEN_PURPOSE_MISMATCH');
  assert.equal(evalWith({ subjectId: 'TASK-A', purpose: 'refute', attempt: 2 }).code, 'TOKEN_ATTEMPT_MISMATCH');
  assert.equal(
    evalWith({ subjectId: 'TASK-A', purpose: 'refute', attempt: 1, hostZone: 'shadow' }).code,
    'HOST_ZONE_MISMATCH',
  );
});

test('the production host path carries the bindings: a client bound to the wrong subject is denied before sending', async () => {
  const policy = freshPolicy();
  const token = policy.issueToken('daemon', ['fs.read.workspace'], { subjectId: 'TASK-A', purpose: 'refute', attempt: 1 });

  const clientFor = (subjectId: string): HostClient =>
    new HostClient({
      executable: '/nonexistent/pwsh',
      scriptPath: '/nonexistent/host.ps1',
      policy,
      actor: 'daemon',
      tokenSecret: token.secret,
      operationSubjectId: subjectId,
      operationPurpose: 'refute',
      operationAttempt: 1,
    });

  // The token is bound to TASK-A; a client built for TASK-B is refused at authorisation (no spawn).
  const wrong = await clientFor('TASK-B').statPath({ zone: 'workspace', path: '/srv/ws/out.txt' });
  assert.equal(wrong.ok, false, 'the wrong-subject call is denied');
  if (wrong.ok === false) {
    assert.match(`${wrong.error.code} ${wrong.error.message}`, /POLICY_DENIED|subject/i);
  }

  // The correct subject is not denied by policy (it would proceed to spawn the host).
  const right = await clientFor('TASK-A').statPath({ zone: 'workspace', path: '/srv/ws/out.txt' });
  const policyDenied = right.ok === false && right.error.code === 'POLICY_DENIED';
  assert.equal(policyDenied, false, 'the correct-subject call is not denied by policy');
});
