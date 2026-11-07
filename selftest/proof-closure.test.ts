/** P2 ZIP 03 — pure §24 proof-closure derivation. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveProofClosure,
  proofClosureUnmet,
} from '../src/cycle/proofClosure.js';
import { PROOF_EVENT_TYPES } from '../src/proof/proofContract.js';
import type { EventRecord } from '../src/shared/schemas.js';

const HASH = 'a'.repeat(64);

function verdictEvent(
  sequence: number,
  input: {
    readonly subject?: string;
    readonly payloadCycle?: string;
    readonly disposition?: string;
    readonly improvement?: unknown;
    readonly payload?: unknown;
  } = {},
): EventRecord {
  const subject = input.subject ?? 'CYCLE-000001';
  return {
    id: `EVENT-${String(sequence).padStart(6, '0')}`,
    sequence,
    timestamp: `2026-08-13T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    type: PROOF_EVENT_TYPES.verdictRecorded,
    mission_version: 'MISSION-000001',
    actor: 'cli',
    subject_id: subject,
    payload: Object.prototype.hasOwnProperty.call(input, 'payload')
      ? input.payload
      : {
          cycle_id: input.payloadCycle ?? subject,
          disposition: input.disposition ?? 'REJECT',
          improvement: input.improvement ?? input.disposition === 'ACCEPT',
        },
    previous_hash: null,
    hash: HASH,
  };
}

test('P2-ZIP-03 proof closure: empty and foreign histories do not execute this cycle', () => {
  const foreign = verdictEvent(1, { subject: 'CYCLE-999999', disposition: 'ACCEPT' });
  const state = deriveProofClosure([foreign], 'CYCLE-000001');
  assert.deepEqual(state, {
    cycleId: 'CYCLE-000001',
    verdictCount: 0,
    acceptedCount: 0,
    latestDisposition: null,
    latestEventId: null,
    candidateLoopExecuted: false,
    improvementDemonstrated: false,
  });
  assert.equal(proofClosureUnmet(state).length, 2);
  assert.match(proofClosureUnmet(state)[0] ?? '', /candidate loop/);
});

test('P2-ZIP-03 proof closure: a non-ACCEPT proves execution and records evaluated non-improvement', () => {
  const state = deriveProofClosure(
    [verdictEvent(1, { disposition: 'REJECT', improvement: false })],
    'CYCLE-000001',
  );
  assert.equal(state.candidateLoopExecuted, true);
  assert.equal(state.improvementDemonstrated, false);
  assert.equal(state.verdictCount, 1);
  assert.equal(state.latestDisposition, 'REJECT');
  const unmet = proofClosureUnmet(state);
  assert.equal(unmet.length, 1);
  assert.match(unmet[0] ?? '', /evaluated — 1 verdict\(s\), no ACCEPT/);
  assert.match(unmet[0] ?? '', /EVENT-000001/);
});

test('P2-ZIP-03 proof closure: any ACCEPT in the cycle demonstrates improvement', () => {
  const state = deriveProofClosure(
    [
      verdictEvent(1, { disposition: 'REVISE', improvement: false }),
      verdictEvent(2, { disposition: 'ACCEPT', improvement: true }),
      verdictEvent(3, { disposition: 'REJECT', improvement: false }),
    ],
    'CYCLE-000001',
  );
  assert.equal(state.verdictCount, 3);
  assert.equal(state.acceptedCount, 1);
  assert.equal(state.latestDisposition, 'REJECT', 'latest is explanatory, not an invalidation');
  assert.equal(state.improvementDemonstrated, true);
  assert.deepEqual(proofClosureUnmet(state), []);
});

test('P2-ZIP-03 proof closure: malformed or contradictory authority fails closed', () => {
  assert.throws(
    () => deriveProofClosure([verdictEvent(1, { payload: null })], 'CYCLE-000001'),
    /payload is not an object/,
  );
  assert.throws(
    () => deriveProofClosure([verdictEvent(1, { payloadCycle: 'CYCLE-000002' })], 'CYCLE-000001'),
    /payload cycle_id.*does not match/,
  );
  assert.throws(
    () => deriveProofClosure([verdictEvent(1, { disposition: 'DEFER', improvement: false })], 'CYCLE-000001'),
    /unknown disposition/,
  );
  assert.throws(
    () => deriveProofClosure([verdictEvent(1, { disposition: 'ACCEPT', improvement: false })], 'CYCLE-000001'),
    /ACCEPT requires improvement=true/,
  );
});
