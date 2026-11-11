/**
 * P2 closure assessment — pure refusal/closure semantics.
 *
 * The assessment may report CLOSED only when engineering truth, Creator policy,
 * governance and durable cycle evidence all agree. These tests pin the distinctions so
 * a later UI or runbook cannot turn absence into success.
 */

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse as parseYaml } from 'yaml';

import type { ProofBoardView } from '../src/daemon/proofBoardProjection.js';

import {
  decideP2Closure,
  p2ClosurePolicySchema,
  proofFactsForLatestClosure,
  type P2ClosureFacts,
  type P2ClosurePolicy,
} from '../src/closure/p2ClosureAssessment.js';

const safeDisabledPolicy: P2ClosurePolicy = p2ClosurePolicySchema.parse({
  version: 1,
  phase: 'P2',
  gateway: {
    decision: 'SAFE_DISABLED_DEFERRED',
    decision_id: 'P2-D4-SAFE-DISABLED',
    recorded_at: '2026-08-14',
    recorded_by: 'creator',
    reason: 'Gateway engineering is accepted; provider activation, routes and spend remain intentionally deferred.',
  },
  p3_deferrals: {
    project_intent_model: true,
    environment_adapters: true,
  },
});

const completeFacts: P2ClosureFacts = {
  statusSchemaVersion: '5.8.0',
  statusConsistent: true,
  runtimeHealth: 'healthy',
  proofPipelineBacked: true,
  greatBookBacked: true,
  aiOrchestrationBacked: true,
  versionControlUnsupported: true,
  benchmarkRegistered: true,
  benchmarkIntegrity: true,
  remoteDecision: 'NO_REMOTE_YET',
  localOnly: true,
  publicationPermitted: false,
  gatewayEnabled: false,
  gatewayOperationallyReady: false,
  gatewayEnabledRouteCount: 0,
  gatewayBudgetAuthority: 'clue',
  gatewayLocalBudgetEnforced: true,
  gatewayModel: null,
  gatewayProviderPaused: false,
  gatewayDailyHard: 0,
  gatewayMonthlyHard: 0,
  currentMissionVersionId: 'MISSION-000100',
  lastCycleId: 'CYCLE-000100',
  lastCycleMissionCurrent: true,
  lastCycleClosureAfterEpoch: true,
  statusCycleAgreement: true,
  proofAttempts: 1,
  verdicts: 1,
  accepts: 1,
  greatBookEntries: 1,
  greatBookRecordingGaps: 0,
  lastCycleGrade: 'proof-authoritative',
  lastCycleCriteriaMet: true,
  ratificationCurrent: true,
  epochName: 'P2-authoritative',
  epochCurrent: true,
};

function withFacts(overrides: Partial<P2ClosureFacts>): P2ClosureFacts {
  return { ...completeFacts, ...overrides };
}

test('P2-CLOSURE-03: the shipped policy records explicit Creator decisions for the model and remote', () => {
  const parsed = p2ClosurePolicySchema.parse(
    parseYaml(readFileSync('config/policies/p2-closure.yaml', 'utf8')),
  );
  assert.equal(parsed.gateway.decision, 'OPERATIONAL');
  assert.equal(parsed.gateway.decision_id, 'P2-D4-OPENAI-GPT-6-ASTRA');
  assert.equal(parsed.gateway.recorded_at, '2026-11-11');
  assert.equal(parsed.gateway.recorded_by, 'creator');
  assert.equal(parsed.gateway.model, 'gpt-6-astra');
  assert.equal(parsed.gateway.budget_authority, 'OPENAI_PLATFORM');
  assert.equal(parsed.gateway.local_budget_enforced, false);
  assert.equal(parsed.gateway.provider_exhaustion_action, 'CONTROLLED_PAUSE');
  assert.equal(parsed.gateway.remaining_token_authority, 'PROVIDER_ONLY');
  assert.equal(parsed.publication?.decision, 'REMOTE_REGISTERED');
  assert.equal(parsed.publication?.decision_id, 'P2-D5-REGISTERED-REMOTE');
  assert.equal(parsed.publication?.recorded_at, '2026-11-11');
  assert.equal(parsed.publication?.recorded_by, 'creator');
  assert.deepEqual(parsed.p3_deferrals, {
    project_intent_model: true,
    environment_adapters: true,
  });
});

test('P07: explicit remote registration and the exact Astra model satisfy only their own gates', () => {
  const policy = p2ClosurePolicySchema.parse(parseYaml(readFileSync('config/policies/p2-closure.yaml', 'utf8')));
  const activeProfile = withFacts({
    remoteDecision: 'REMOTE_REGISTERED',
    localOnly: false,
    gatewayEnabled: true,
    gatewayOperationallyReady: true,
    gatewayEnabledRouteCount: 12,
    gatewayBudgetAuthority: 'openai_platform',
    gatewayLocalBudgetEnforced: false,
    gatewayModel: 'gpt-6-astra',
  });
  assert.deepEqual(decideP2Closure(policy, activeProfile), { state: 'CLOSED', closed: true, blockers: [] });
  for (const mismatch of [
    { remoteDecision: null },
    { remoteDecision: 'NO_REMOTE_YET', localOnly: true },
    { localOnly: true },
    { publicationPermitted: true },
  ]) {
    const decision = decideP2Closure(policy, { ...activeProfile, ...mismatch });
    assert.deepEqual(decision.blockers.map(({ id }) => id), ['P2-REMOTE-POLICY']);
    assert.equal(decision.closed, false);
  }
  assert.deepEqual(
    decideP2Closure(policy, { ...activeProfile, gatewayModel: 'gpt-5.6-sol' }).blockers.map(({ id }) => id),
    ['P2-D4-OPERATIONAL-CONTRADICTION'],
  );
  assert.deepEqual(
    decideP2Closure(policy, { ...activeProfile, ratificationCurrent: false }).blockers.map(({ id }) => id),
    ['P2-RATIFICATION'],
  );
  assert.ok(!p2ClosurePolicySchema.safeParse({
    ...policy, publication: { decision: 'REMOTE_REGISTERED' },
  }).success);
});

test('P07: legacy policy without an explicit D5 choice still refuses a registered remote', () => {
  const decision = decideP2Closure(safeDisabledPolicy, withFacts({
    remoteDecision: 'REMOTE_REGISTERED',
    localOnly: false,
  }));
  assert.deepEqual(decision.blockers.map(({ id }) => id), ['P2-REMOTE-ABSENCE']);
});

test('P2-CLOSURE-03: a pending D4 decision cannot be called ready or closed', () => {
  const pending = p2ClosurePolicySchema.parse({
    ...safeDisabledPolicy,
    gateway: {
      decision: 'PENDING_CREATOR_DECISION',
      decision_id: null,
      recorded_at: null,
      recorded_by: null,
      reason: 'The Creator has not selected activation or explicit deferral.',
    },
  });
  const result = decideP2Closure(pending, completeFacts);
  assert.equal(result.state, 'AWAITING_CREATOR_DECISION');
  assert.equal(result.closed, false);
  assert.deepEqual(result.blockers.map((item) => item.id), ['P2-D4-GATEWAY-DECISION']);
});

test('P2-CLOSURE-03: completed engineering without governance/evidence is ready only for ceremony', () => {
  const result = decideP2Closure(
    safeDisabledPolicy,
    withFacts({
      proofAttempts: 0,
      verdicts: 0,
      accepts: 0,
      greatBookEntries: 0,
      lastCycleGrade: null,
      lastCycleCriteriaMet: null,
      ratificationCurrent: false,
      epochName: null,
      epochCurrent: false,
    }),
  );
  assert.equal(result.state, 'READY_FOR_CEREMONY');
  assert.equal(result.closed, false);
  assert.deepEqual(
    new Set(result.blockers.map((item) => item.id)),
    new Set([
      'P2-RATIFICATION',
      'P2-EPOCH',
      'P2-PROOF-AUTHORITATIVE-CYCLE',
      'P2-FIRST-PROVEN-IMPROVEMENT',
      'P2-CYCLE-CLOSURE',
    ]),
  );
});

test('P2 closure accepts an explicitly current successor epoch for its exact mission', () => {
  const epochName = 'P2-authoritative-MISSION-000100';
  assert.ok(!decideP2Closure(safeDisabledPolicy, withFacts({ epochName }))
    .blockers.some(({ id }) => id === 'P2-EPOCH'));
  for (const facts of [
    withFacts({ epochName, epochCurrent: false }),
    withFacts({ epochName: 'P2-authoritative-MISSION-000099' }),
    withFacts({ epochName, currentMissionVersionId: null }),
  ]) {
    assert.ok(decideP2Closure(safeDisabledPolicy, facts).blockers.some(({ id }) => id === 'P2-EPOCH'));
  }
});

test('P2-CLOSURE-03: one engineering contradiction dominates later ceremony blockers', () => {
  const result = decideP2Closure(
    safeDisabledPolicy,
    withFacts({
      statusConsistent: false,
      ratificationCurrent: false,
      epochName: null,
      epochCurrent: false,
    }),
  );
  assert.equal(result.state, 'ENGINEERING_BLOCKED');
  assert.equal(result.closed, false);
  assert.ok(result.blockers.some((item) => item.id === 'P2-STATUS-CONSISTENCY'));
});

test('P2-CLOSURE-03: SAFE_DISABLED_DEFERRED must agree with exact live zero-authority policy', () => {
  const result = decideP2Closure(
    safeDisabledPolicy,
    withFacts({ gatewayEnabledRouteCount: 1 }),
  );
  assert.equal(result.state, 'AWAITING_CREATOR_DECISION');
  assert.equal(result.closed, false);
  assert.ok(result.blockers.some((item) => item.id === 'P2-D4-SAFE-DISABLED-CONTRADICTION'));
});

test('P2-CLOSURE-03: CLOSED is emitted only for the fully corroborated state', () => {
  const result = decideP2Closure(safeDisabledPolicy, completeFacts);
  assert.deepEqual(result, { state: 'CLOSED', closed: true, blockers: [] });
});

test('P2-CLOSURE-03: a real operational decision must have a live operational gateway', () => {
  const operational = p2ClosurePolicySchema.parse({
    ...safeDisabledPolicy,
    gateway: {
      decision: 'OPERATIONAL',
      decision_id: 'P2-D4-OPERATIONAL',
      recorded_at: '2026-08-14',
      recorded_by: 'creator',
      reason: 'The Creator approved exact model and external OpenAI billing authority.',
      model: 'gpt-5.6-sol',
      budget_authority: 'OPENAI_PLATFORM',
      local_budget_enforced: false,
      provider_exhaustion_action: 'CONTROLLED_PAUSE',
      remaining_token_authority: 'PROVIDER_ONLY',
    },
  });
  const refused = decideP2Closure(operational, completeFacts);
  assert.equal(refused.state, 'AWAITING_CREATOR_DECISION');
  assert.ok(refused.blockers.some((item) => item.id === 'P2-D4-OPERATIONAL-CONTRADICTION'));

  const accepted = decideP2Closure(
    operational,
    withFacts({
      gatewayEnabled: true,
      gatewayOperationallyReady: true,
      gatewayEnabledRouteCount: 12,
      gatewayBudgetAuthority: 'openai_platform',
      gatewayLocalBudgetEnforced: false,
      gatewayModel: 'gpt-5.6-sol',
      gatewayProviderPaused: false,
    }),
  );
  assert.equal(accepted.state, 'CLOSED');
  assert.equal(accepted.closed, true);
  const olderDecision = p2ClosurePolicySchema.parse({
    ...operational,
    gateway: { ...operational.gateway, model: 'gpt-5.6' },
  });
  const superseded = decideP2Closure(olderDecision, withFacts({ gatewayModel: 'gpt-5.6' }));
  assert.ok(superseded.blockers.some((item) => item.id === 'P2-D4-CREATOR-POLICY-CONTRADICTION'));
});


test('P2-CLOSURE-03: only a proof from the latest closed cycle and current mission counts', () => {
  const verdict = {
    sequence: 12,
    disposition: 'ACCEPT',
    greatBookState: 'recorded',
    greatBookEntryId: 'GBI-test',
  };
  const board = {
    missionVersionId: 'MISSION-000010',
    proofAttempts: [
      { cycleId: 'CYCLE-old', missionVersion: 'MISSION-000010', contract: { sequence: 9 }, verdict },
      { cycleId: 'CYCLE-new', missionVersion: 'MISSION-000009', contract: { sequence: 9 }, verdict },
      { cycleId: 'CYCLE-new', missionVersion: 'MISSION-000010', contract: { sequence: 9 }, verdict },
    ],
  } as unknown as ProofBoardView;
  assert.deepEqual(proofFactsForLatestClosure(board, 'CYCLE-new'), {
    currentMissionVersionId: 'MISSION-000010',
    lastCycleId: 'CYCLE-new',
    proofAttempts: 1,
    verdicts: 1,
    accepts: 1,
    greatBookEntries: 1,
  });
});

test('P2-CLOSURE-03: a global historical ACCEPT cannot close a cycle with no own proof', () => {
  const board = {
    missionVersionId: 'MISSION-000010',
    proofAttempts: [{
      cycleId: 'CYCLE-old',
      missionVersion: 'MISSION-000010',
      contract: { sequence: 9 },
      verdict: {
        sequence: 12,
        disposition: 'ACCEPT',
        greatBookState: 'recorded',
        greatBookEntryId: 'GBI-old',
      },
    }],
  } as unknown as ProofBoardView;
  assert.deepEqual(proofFactsForLatestClosure(board, 'CYCLE-new'), {
    currentMissionVersionId: 'MISSION-000010',
    lastCycleId: 'CYCLE-new',
    proofAttempts: 0,
    verdicts: 0,
    accepts: 0,
    greatBookEntries: 0,
  });
});

test('P2-CLOSURE-03: proof before the current epoch cannot satisfy the closure cycle', () => {
  const verdict = {
    sequence: 90,
    disposition: 'ACCEPT',
    greatBookState: 'recorded',
    greatBookEntryId: 'GBI-old-epoch',
  };
  const board = {
    missionVersionId: 'MISSION-000010',
    proofAttempts: [{
      cycleId: 'CYCLE-new',
      missionVersion: 'MISSION-000010',
      contract: { sequence: 80 },
      verdict,
    }],
  } as unknown as ProofBoardView;
  assert.deepEqual(proofFactsForLatestClosure(board, 'CYCLE-new', 100), {
    currentMissionVersionId: 'MISSION-000010',
    lastCycleId: 'CYCLE-new',
    proofAttempts: 0,
    verdicts: 0,
    accepts: 0,
    greatBookEntries: 0,
  });
});

test('P2-CLOSURE-03: a proof-authoritative closure must be current-mission and later than the epoch', () => {
  for (const overrides of [
    { lastCycleMissionCurrent: false },
    { lastCycleClosureAfterEpoch: false },
  ]) {
    const result = decideP2Closure(safeDisabledPolicy, withFacts(overrides));
    assert.equal(result.closed, false);
    assert.ok(result.blockers.some((item) => item.id === 'P2-CYCLE-CLOSURE'));
  }
});

test('P2 closure cannot borrow a verdict written after the cycle closed', () => {
  const board = {
    missionVersionId: 'MISSION-000010',
    proofAttempts: [
      {
        cycleId: 'CYCLE-new',
        missionVersion: 'MISSION-000010',
        contract: { sequence: 102 },
        verdict: { sequence: 105, disposition: 'ACCEPT', greatBookState: 'recorded', greatBookEntryId: 'GBI-late' },
      },
      {
        cycleId: 'CYCLE-new',
        missionVersion: 'MISSION-000010',
        contract: { sequence: 106 },
        verdict: null,
      },
    ],
  } as unknown as ProofBoardView;
  assert.deepEqual(proofFactsForLatestClosure(board, 'CYCLE-new', 100, 104), {
    currentMissionVersionId: 'MISSION-000010',
    lastCycleId: 'CYCLE-new',
    proofAttempts: 1,
    verdicts: 0,
    accepts: 0,
    greatBookEntries: 0,
  });
});
