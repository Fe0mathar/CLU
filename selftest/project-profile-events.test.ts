import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalJson, hashCanonicalJson, hashText } from '../src/shared/ids.js';
import {
  ProfileEventLog,
  ProfileEventLogError,
  profileEventInputSchema,
  type ProfileEventInput,
} from '../src/control/projectProfiles/profileEventLog.js';
import { FIXED_TIME, FIXED_TIME_2 } from './project-profile-fixture.js';

const ROOT_ID = `path:v1:test:${hashText('target')}`;
const PROFILE_1 = `profile:v1:${hashText('profile-1')}`;
const PROFILE_2 = `profile:v1:${hashText('profile-2')}`;
const AUTH_1 = hashText('authority-1');
const AUTH_2 = hashText('authority-2');

function withRoot(action: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'clue-profile-events-'));
  try {
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createdInput(transactionId = 'TX-CREATE-1'): ProfileEventInput {
  return profileEventInputSchema.parse({
    transactionId,
    type: 'project-profile.created',
    actor: 'creator',
    projectId: 'alpha',
    targetRootIdentity: ROOT_ID,
    previousGeneration: null,
    generation: 1,
    previousProfileHash: null,
    projectProfileHash: PROFILE_1,
    previousAuthorityHash: null,
    authorityHash: AUTH_1,
    registryGeneration: 1,
    reasonCode: null,
  });
}

function updatedInput(transactionId = 'TX-UPDATE-1'): ProfileEventInput {
  return profileEventInputSchema.parse({
    transactionId,
    type: 'project-profile.updated',
    actor: 'creator',
    projectId: 'alpha',
    targetRootIdentity: ROOT_ID,
    previousGeneration: 1,
    generation: 2,
    previousProfileHash: PROFILE_1,
    projectProfileHash: PROFILE_2,
    previousAuthorityHash: AUTH_1,
    authorityHash: AUTH_2,
    registryGeneration: 1,
    reasonCode: null,
  });
}

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof ProfileEventLogError ? error.code : null;
  }
}

test('PP-07: sanitized events append in order and replay through one verified hash chain', () => {
  withRoot((root) => {
    const times = [FIXED_TIME, FIXED_TIME_2];
    const log = new ProfileEventLog(root, { now: () => times.shift() ?? FIXED_TIME_2 });
    const created = log.append(createdInput());
    const updated = log.append(updatedInput());

    assert.equal(created.sequence, 1);
    assert.equal(created.previousEventHash, null);
    assert.equal(updated.sequence, 2);
    assert.equal(updated.previousEventHash, created.eventHash);
    assert.deepEqual(log.replay(), [created, updated]);

    const stored = readFileSync(log.eventsPath, 'utf8');
    assert.doesNotMatch(stored, /OPENAI_API_KEY|sk-|password|api[_-]?key/iu);
  });
});

test('PP-07: a transaction ID is idempotent only for the identical event payload', () => {
  withRoot((root) => {
    const log = new ProfileEventLog(root, { now: () => FIXED_TIME });
    const first = log.append(createdInput());
    assert.deepEqual(log.append(createdInput()), first);
    assert.equal(log.replay().length, 1);
    assert.equal(
      codeOf(() => log.append({ ...createdInput(), projectProfileHash: PROFILE_2 })),
      'TRANSACTION_CONFLICT',
    );
  });
});

test('PP-07: event semantics require old/new identities appropriate to each event type', () => {
  assert.ok(
    !profileEventInputSchema.safeParse({
      ...createdInput(),
      generation: null,
      projectProfileHash: null,
    }).success,
  );
  assert.ok(
    !profileEventInputSchema.safeParse({
      ...updatedInput(),
      previousGeneration: null,
      previousProfileHash: null,
    }).success,
  );
  assert.ok(
    !profileEventInputSchema.safeParse({
      ...updatedInput(),
      type: 'project-profile.validation_failed',
      reasonCode: null,
    }).success,
  );
  assert.ok(
    profileEventInputSchema.safeParse({
      ...updatedInput(),
      type: 'project-authority.changed',
    }).success,
  );
});

test('PP-07: unknown credential/secret fields are refused by the closed event schema', () => {
  assert.ok(
    !profileEventInputSchema.safeParse({
      ...createdInput(),
      credentialReference: 'env:OPENAI_API_KEY',
    }).success,
  );
  assert.ok(
    !profileEventInputSchema.safeParse({
      ...createdInput(),
      apiKey: 'sk-raw-secret',
    }).success,
  );
});

test('PP-07: payload tampering, sequence gaps, and chain rewrites are detected on replay', () => {
  withRoot((root) => {
    const log = new ProfileEventLog(root, { now: () => FIXED_TIME });
    log.append(createdInput());
    log.append(updatedInput());
    const original = readFileSync(log.eventsPath, 'utf8');
    const lines = original.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

    const payloadTamper = structuredClone(lines);
    const first = payloadTamper[0];
    assert.ok(first !== undefined);
    first['projectId'] = 'beta';
    writeFileSync(log.eventsPath, `${payloadTamper.map(canonicalJson).join('\n')}\n`, 'utf8');
    assert.equal(codeOf(() => log.replay()), 'HASH_MISMATCH');

    writeFileSync(log.eventsPath, original, 'utf8');
    const sequenceTamper = structuredClone(lines);
    const second = sequenceTamper[1];
    assert.ok(second !== undefined);
    second['sequence'] = 3;
    writeFileSync(log.eventsPath, `${sequenceTamper.map(canonicalJson).join('\n')}\n`, 'utf8');
    assert.equal(codeOf(() => log.replay()), 'SEQUENCE_GAP');

    writeFileSync(log.eventsPath, original, 'utf8');
    const chainTamper = structuredClone(lines);
    const chained = chainTamper[1];
    assert.ok(chained !== undefined);
    chained['previousEventHash'] = hashText('unrelated');
    const { eventHash: _eventHash, ...basis } = chained;
    chained['eventHash'] = hashCanonicalJson(basis);
    writeFileSync(log.eventsPath, `${chainTamper.map(canonicalJson).join('\n')}\n`, 'utf8');
    assert.equal(codeOf(() => log.replay()), 'CHAIN_BROKEN');
  });
});
