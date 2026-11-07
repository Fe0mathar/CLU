/**
 * Status Contract v5.8.0 schema-owner acceptance tests.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §2 (every field durably backed or explicitly a named
 *       non-value), §3 (strict structure; unknown fields rejected), §20 gates 2 and 3.
 *       `supplementation_v9.md` §9 (wire schema 5.1.0; the `goldenMetrics` branch, four
 *       explicit items, no invented values).
 *
 * Backlog: DEV-P1-10 — Status Contract v5 had no machine owner; `src/ui/viewModel.ts` had
 *          become the de-facto sealed contract, inverting the Directory's layering.
 *
 * These drive the schema, not a mock of it. The compile-time half of the guarantee — that
 * the validator and the interface are mutually assignable — is proven by the typecheck
 * itself and cannot be asserted from here; it was verified by deliberate reversion in both
 * directions (drop a field from the schema, retype one on the interface) and is recorded
 * in the delivery note rather than claimed by a test that could not detect it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKED_BRANCHES,
  BRANCH_STATES,
  GOLDEN_METRIC_IDS,
  STATUS_SCHEMA_VERSION,
  UNSUPPORTED_BRANCHES,
  isBranchUnavailable,
  parseStatusSnapshot,
  statusSnapshotSchema,
  unavailableGoldenMetrics,
  type BranchUnavailable,
  type StatusSnapshot,
} from '../src/status/statusContractV5.js';
import type { Sha256 } from '../src/shared/ids.js';

const HASH = 'a'.repeat(64) as unknown as Sha256;

function unsupported(reason: string): BranchUnavailable {
  return { state: 'unsupported', reason, expectedSource: null, lastKnownAt: null };
}

/**
 * A minimal but complete snapshot: every branch present, every unbacked branch explicitly
 * unsupported. This is the honest shape this build actually produces.
 */
function snapshot(): StatusSnapshot {
  const gap = unsupported('no owning domain in this build');
  const fresh = {
    observedAt: '2026-08-06T00:00:00.000Z',
    ageMs: 0,
    sourceHead: null,
    stale: false,
    limitMs: null,
  };
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: '2026-08-06T00:00:00.000Z',

    target: gap,
    projectProfile: gap,
    projectInputs: gap,
    assessmentEnvelope: gap,
    rpi: gap,
    // ADR-0007: backed and truthfully empty — "the domain answers: nothing yet".
    cycle: { current: null, lastClosure: null, freshness: fresh },
    repositoryInventory: gap,
    recognition: gap,
    q1: gap,
    environments: gap,
    universalProjectRepresentation: gap,
    crossEnvironment: gap,
    purposeAndCapabilities: gap,
    intentAndMethods: gap,
    solutionFrontier: gap,
    currentWork: gap,
    units: gap,
    functionalities: gap,
    measurementCatalogue: gap,
    goldenMetrics: unavailableGoldenMetrics('no Golden backend in this build'),
    measureSessions: gap,
    proofInstruments: gap,
    humanEvaluations: gap,
    improvementField: gap,
    gauges: gap,
    operationalConsole: gap,
    aiOrchestration: gap,
    findings: gap,
    proofPipeline: {
      cycleId: null,
      contractFrozen: null,
      baselineBound: null,
      executionRefused: null,
      verdictRecorded: null,
      freshness: fresh,
    },
    benchmarks: gap,
    improvementEconomics: gap,
    versionControl: gap,
    integrations: gap,
    assessment: gap,
    runtimeDiagnostics: gap,
    greatBook: {
      entryCount: 0,
      contributionCount: 0,
      recordingGapCount: 0,
      latestEntryId: null,
      latestCycleId: null,
      normalizationVersion: 'proof-delta-pct/v1',
      normalizationHash: HASH,
      freshness: fresh,
    },
    equilibrium: gap,

    sources: ['events:0'],
    capability: {
      contractVersion: STATUS_SCHEMA_VERSION,
      backedBranches: [],
      unsupportedBranches: [...UNSUPPORTED_BRANCHES],
      satisfiedGates: [],
      unreachableGates: [{ gate: 3, reason: 'the view-model seal is still upstream' }],
    },
    seal: {
      statusHash: HASH,
      generatedAt: '2026-08-06T00:00:00.000Z',
      eventLogFrom: 0,
      eventLogTo: 0,
      projectionVersion: null,
      targetSnapshotId: null,
      missionHash: null,
      catalogueHash: null,
      goldenDefinitionHash: null,
      consistent: true,
      inconsistencies: [],
    },
  } as StatusSnapshot;
}

test('PP-28: the wire version is 5.8.0 and historical Status bodies are not reinterpreted', () => {
  assert.equal(STATUS_SCHEMA_VERSION, '5.8.0');
  const body = snapshot();
  assert.equal(parseStatusSnapshot(body).schemaVersion, '5.8.0');
  // Explicit migration: neither the original 5.0.0 nor the prior 5.7.0 wire is silently accepted.
  assert.throws(() => parseStatusSnapshot({ ...body, schemaVersion: '5.0.0' }));
  assert.throws(() => parseStatusSnapshot({ ...body, schemaVersion: '5.7.0' }));
});

test('DEV-P1-10: an unknown branch is rejected, not absorbed', () => {
  // §3: "Unknown additional fields are rejected until a schema revision defines them."
  // Silent absorption is how a second source of truth gets in.
  assert.throws(() => parseStatusSnapshot({ ...snapshot(), invented: { looksReal: true } }));
  // And a missing branch is equally a rejection: the shape is complete or it is nothing.
  const partial: Record<string, unknown> = { ...snapshot() };
  delete partial['equilibrium'];
  assert.throws(() => parseStatusSnapshot(partial));
});

test('DEV-P1-10: an unbacked branch must state a reason, never merely be empty', () => {
  const body = snapshot();
  // §2 and §18: absence carries a named non-value and an explanation.
  assert.throws(
    () => parseStatusSnapshot({ ...body, benchmarks: { state: 'unsupported', reason: '' } }),
    'an empty reason is not an explanation',
  );
  assert.throws(
    () => parseStatusSnapshot({ ...body, benchmarks: {} }),
    'a bare empty object cannot stand for an unavailable branch',
  );
  // §20 gate 26: "unsupported" and "unavailable" are distinct and both representable.
  assert.ok(BRANCH_STATES.includes('unsupported'));
  assert.ok(BRANCH_STATES.includes('unavailable'));
  assert.notEqual(
    BRANCH_STATES.indexOf('unsupported'),
    BRANCH_STATES.indexOf('unavailable'),
    'a specified-but-unimplemented capability must not read as a transient fault',
  );
});

test('DEV-P1-10: the Golden branch carries four explicit items and never a zero', () => {
  const golden = unavailableGoldenMetrics('no Golden backend in this build');

  // supplement §9.4: one item per Golden ID; an unavailable metric is stated, not omitted.
  assert.equal(golden.items.length, 4);
  assert.deepEqual(
    golden.items.map((item) => item.id),
    [...GOLDEN_METRIC_IDS],
  );
  assert.equal(new Set(golden.items.map((item) => item.id)).size, 4, 'four unique IDs');

  // supplement §9: a missing value is null, never zero, and never a healthy state.
  for (const item of golden.items) {
    assert.equal(item.normalizedValue, null);
    assert.equal(item.normalizedDelta, null);
    assert.equal(item.state, 'UNAVAILABLE');
    assert.ok(item.limitations.length > 0, 'the reason travels with the item');
  }
  assert.equal(golden.projectionState, 'UNAVAILABLE');
  assert.equal(golden.definitionSet, null, 'no definition set is claimed where none exists');

  // Three items is a rejection: the branch shape itself enforces the count.
  assert.throws(() =>
    parseStatusSnapshot({
      ...snapshot(),
      goldenMetrics: { ...golden, items: golden.items.slice(0, 3) },
    }),
  );
});

test('DEV-P1-10: the branch census matches the schema exactly', () => {
  // The failure mode this closes: a branch quietly leaving the declaration while staying
  // in the type, so the snapshot under-reports what it cannot do.
  const declared = new Set<string>([...UNSUPPORTED_BRANCHES, ...BACKED_BRANCHES]);
  const schemaKeys = Object.keys(statusSnapshotSchema.shape).filter(
    (key) => !['schemaVersion', 'generatedAt', 'sources', 'capability', 'seal', 'goldenMetrics'].includes(key),
  );

  assert.deepEqual(
    schemaKeys.filter((key) => !declared.has(key)),
    [],
    'every contract branch appears in exactly one census list',
  );
  assert.deepEqual(
    [...declared].filter((key) => !schemaKeys.includes(key)),
    [],
    'no census entry names a branch the schema does not have',
  );
  assert.equal(
    UNSUPPORTED_BRANCHES.length + BACKED_BRANCHES.length,
    schemaKeys.length,
    'the two lists partition the branches; none is counted twice',
  );
  // The honest headline: 20 of 36 contract branches have no owning domain in this build.
  // ADR-0011 backed `proofPipeline`; ADR-0012 backed `greatBook`; ADR-0013 backs
  // `aiOrchestration`. Each wire revision moves exactly one branch from unsupported to
  // backed without changing the complete census.
  assert.equal(UNSUPPORTED_BRANCHES.length, 20);
  assert.equal(BACKED_BRANCHES.length, 16);
  assert.ok(BACKED_BRANCHES.includes('cycle'), 'the cycle branch is backed as of 5.2.0');
  assert.ok(BACKED_BRANCHES.includes('proofPipeline'), 'proofPipeline remains backed');
  assert.ok(BACKED_BRANCHES.includes('greatBook'), 'greatBook remains backed');
  assert.ok(BACKED_BRANCHES.includes('aiOrchestration'), 'aiOrchestration remains backed');
  assert.ok(BACKED_BRANCHES.includes('projectProfile'), 'projectProfile is backed as of 5.8.0');
  assert.equal((UNSUPPORTED_BRANCHES as readonly string[]).includes('aiOrchestration'), false);
  assert.equal((UNSUPPORTED_BRANCHES as readonly string[]).includes('greatBook'), false);
});

test('DEV-P1-10: exactly one seal exists on a snapshot', () => {
  const body = parseStatusSnapshot(snapshot());
  // §20 gate 3. A second seal anywhere in the body is the drift this owner exists to stop,
  // so the only place a seal may appear is the top level.
  const seals = JSON.stringify(body).match(/"statusHash"/g) ?? [];
  assert.equal(seals.length, 1);
  assert.equal(body.seal.consistent, true);
  assert.deepEqual(body.seal.inconsistencies, []);
});

test('DEV-P1-10: isBranchUnavailable narrows correctly and does not misread data', () => {
  const body = parseStatusSnapshot(snapshot());
  assert.equal(isBranchUnavailable(body.benchmarks), true);
  assert.equal(isBranchUnavailable(body.recognition), true);
  // A populated branch that happens to carry a `state`-like field is not an unavailability:
  // the guard checks the value against the closed set, not merely the key's presence.
  assert.equal(
    isBranchUnavailable({ state: 'healthy' } as unknown as BranchUnavailable),
    false,
    'a domain value named `state` must not be mistaken for a non-value',
  );
});
