/**
 * DEV-P0-09 — every Git operation's ref is validated by the client's own policy.
 *
 * Landing already required a ref inside the configured branch prefix. The gap was that a *read* (fetch)
 * ref was not checked at all — a malicious ref (a leading-dash option, a traversal, a pattern) would
 * pass the client and be left for the host to catch. Now the engine safety-checks the ref of every Git
 * capability, so a read ref may target any branch but can never be an injection shape, and a land ref
 * must additionally sit inside the landing prefix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PolicyEngine, SecretRegistry } from '../src/control/policy.js';
import { type ClueConfig } from '../src/shared/schemas.js';

const config = {
  project: { root: '/srv/canonical' },
  workspace: { root: '/srv/ws' },
  shadow: { root: '/srv/shadow' },
  browser: { profile_dir: '/srv/profile' },
  security: { canonical_source_writes: 'denied' },
  patching: { landing_branch_prefix: 'clue/accepted/' },
} as unknown as ClueConfig;

test('a Git read ref that is an injection shape is refused by the client policy', () => {
  const policy = new PolicyEngine(config, new SecretRegistry());
  const token = policy.issueToken('daemon', ['git.read.canonical'], { subjectId: 'TASK-A', purpose: 'refute', attempt: 1 });
  const base = {
    actor: 'daemon' as const,
    capability: 'git.read.canonical' as const,
    command: 'git.fetch',
    target: '/srv/canonical/repo',
    tokenSecret: token.secret,
    subjectId: 'TASK-A',
    purpose: 'refute' as const,
    attempt: 1,
  };

  for (const ref of ['--upload-pack=evil', '../escape', 'refs/heads/x@{0}', 'has space', 'refs/heads/x..y', '-oProxyCommand=x']) {
    const d = policy.evaluate({ ...base, gitRef: ref });
    assert.equal(d.code, 'GIT_REF_FORBIDDEN', `ref "${ref}" must be refused`);
  }

  // A safe read ref on any branch — not the landing prefix — is not a ref error.
  const good = policy.evaluate({ ...base, gitRef: 'refs/heads/main' });
  assert.notEqual(good.code, 'GIT_REF_FORBIDDEN', 'a safe read ref is accepted on any branch');
  assert.equal(good.decision, 'allowed', 'and the read is authorised');
});

test('a land ref must be safe AND inside the landing prefix', () => {
  // Injection syntax is caught before authorisation is even considered (denied config is fine here).
  const denied = new PolicyEngine(config, new SecretRegistry());
  const injection = denied.evaluate({
    actor: 'custodian',
    capability: 'git.land.canonical',
    command: 'git.land',
    target: '/srv/canonical/repo',
    gitRef: '--exec=evil',
    subjectId: 'TASK-A',
    purpose: 'synthesize',
    attempt: 1,
  });
  assert.equal(injection.code, 'GIT_REF_FORBIDDEN', 'an injection-shaped land ref is refused for its syntax');

  // With landing authorised, the prefix constraint is what refuses a syntactically safe off-prefix ref.
  const landingConfig = { ...config, security: { canonical_source_writes: 'custodian_only' } } as unknown as ClueConfig;
  const policy = new PolicyEngine(landingConfig, new SecretRegistry());
  const token = policy.issueToken('custodian', ['git.land.canonical'], { subjectId: 'TASK-A', purpose: 'synthesize', attempt: 1 });
  const base = {
    actor: 'custodian' as const,
    capability: 'git.land.canonical' as const,
    command: 'git.land',
    target: '/srv/canonical/repo',
    tokenSecret: token.secret,
    subjectId: 'TASK-A',
    purpose: 'synthesize' as const,
    attempt: 1,
  };

  const outside = policy.evaluate({ ...base, gitRef: 'refs/heads/main' });
  assert.equal(outside.code, 'GIT_REF_FORBIDDEN', 'a safe ref outside the landing prefix is refused for a land');

  const inside = policy.evaluate({ ...base, gitRef: 'clue/accepted/patch-1' });
  assert.notEqual(inside.code, 'GIT_REF_FORBIDDEN', 'a safe ref inside the landing prefix passes the ref check');
});

test('DEV-P0-11: a shadow write requires the shadow root as its target', () => {
  const policy = new PolicyEngine(config, new SecretRegistry());
  const token = policy.issueToken('daemon', ['fs.write.shadow'], { subjectId: 'TASK-A', purpose: 'refute', attempt: 1 });
  const base = {
    actor: 'daemon' as const,
    capability: 'fs.write.shadow' as const,
    command: 'shadow.refresh',
    tokenSecret: token.secret,
    subjectId: 'TASK-A',
    purpose: 'refute' as const,
    attempt: 1,
  };

  // With the shadow clone as the target, the refresh is authorised.
  assert.equal(policy.evaluate({ ...base, target: '/srv/shadow/clue' }).decision, 'allowed', 'a shadow write with its root is authorised');
  // With no target it is refused for a missing target — the exact refusal the client used to hit before
  // it was fixed to pass the shadow root through.
  assert.equal(policy.evaluate({ ...base, target: null }).code, 'TARGET_REQUIRED', 'a null target is refused');
});
