/**
 * State Seal acceptance tests.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §15 (the seal binds the canonicalized body; the same
 *       durable inputs and declared timestamp reproduce the same seal, and a mismatch is a
 *       projector defect), §17 (`clue status validate`), §18 (an invalid seal blocks
 *       automation), §20 gates 3, 4 and 9.
 *
 * Backlog: DEV-P1-11 — Status had no seal; the only State Seal in the build was the
 *          console view-model's, one layer downstream of where Directory §19.2 places it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS_SCHEMA_VERSION,
  UNSUPPORTED_BRANCHES,
  unavailableGoldenMetrics,
  type BranchUnavailable,
  type RecognitionBranch,
  type RepositoryInventoryBranch,
  type StatusSnapshot,
} from '../src/status/statusContractV5.js';
import {
  bodyOf,
  evaluateConsistency,
  sealBodyDigest,
  sealSnapshot,
  verifySeal,
  type SealProvenance,
  type SealedBody,
} from '../src/status/statusSeal.js';
import type { Sha256 } from '../src/shared/ids.js';
import { buildGreatBookImprovementField } from '../src/analysis/metrics/improvementField/projection.js';

const SNAPSHOT_ID = 'b'.repeat(64);
const RESULT_HASH = 'c'.repeat(64) as unknown as Sha256;

const PROVENANCE: SealProvenance = {
  generatedAt: '2026-08-06T00:00:00.000Z',
  eventLogFrom: 0,
  eventLogTo: 42,
  projectionVersion: 'clue.projections/7',
  goldenDefinitionHash: null,
};

function gap(reason = 'no owning domain in this build'): BranchUnavailable {
  return { state: 'unsupported', reason, expectedSource: null, lastKnownAt: null };
}

const freshness = {
  observedAt: '2026-08-06T00:00:00.000Z',
  ageMs: 0,
  sourceHead: 'events:42',
  stale: false,
  limitMs: null,
} as const;

const inventory: RepositoryInventoryBranch = {
  snapshotId: SNAPSHOT_ID,
  fileCount: 3,
  capturedAt: '2026-08-06T00:00:00.000Z',
  languageCensus: { typescript: 3 },
  freshness,
};

const recognition: RecognitionBranch = {
  snapshotId: SNAPSHOT_ID,
  resultHash: RESULT_HASH,
  unitCount: 9,
  edgeCount: 4,
  unresolvedCount: 0,
  filesInProgram: 3,
  filesRecognised: 3,
  semanticDiagnostics: 0,
  moduleCount: 3,
  classDistribution: { 'monofile-monodependency': 3 },
  complete: true,
  freshness,
};

/** A body with the two branches the cross-checks actually use, and everything else honest. */
function body(overrides: Partial<SealedBody> = {}): SealedBody {
  const empty = gap();
  const base = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: '2026-08-06T00:00:00.000Z',
    target: empty,
    projectProfile: empty,
    projectInputs: empty,
    assessmentEnvelope: empty,
    rpi: empty,
    cycle: empty,
    repositoryInventory: inventory,
    recognition,
    q1: empty,
    environments: empty,
    universalProjectRepresentation: empty,
    crossEnvironment: empty,
    purposeAndCapabilities: empty,
    intentAndMethods: empty,
    solutionFrontier: empty,
    currentWork: empty,
    units: empty,
    functionalities: empty,
    measurementCatalogue: empty,
    goldenMetrics: unavailableGoldenMetrics('no Golden backend in this build'),
    measureSessions: empty,
    proofInstruments: empty,
    humanEvaluations: empty,
    improvementField: empty,
    gauges: empty,
    operationalConsole: empty,
    aiOrchestration: empty,
    findings: empty,
    proofPipeline: empty,
    benchmarks: empty,
    improvementEconomics: empty,
    versionControl: empty,
    integrations: empty,
    assessment: empty,
    runtimeDiagnostics: empty,
    greatBook: empty,
    equilibrium: empty,
    sources: ['events:0-42'],
    capability: {
      contractVersion: STATUS_SCHEMA_VERSION,
      backedBranches: ['repositoryInventory', 'recognition'],
      unsupportedBranches: [...UNSUPPORTED_BRANCHES],
      satisfiedGates: [2, 3],
      unreachableGates: [],
    },
  } as unknown as SealedBody;
  return { ...base, ...overrides } as SealedBody;
}

test('DEV-P1-11: the same inputs and declared timestamp reproduce the same seal', () => {
  // §15's determinism rule. This is the property that makes a mismatch diagnosable as a
  // projector defect rather than as ordinary variation.
  const first = sealSnapshot(body(), PROVENANCE);
  const second = sealSnapshot(body(), PROVENANCE);
  assert.deepEqual(first.seal, second.seal);
  assert.equal(first.seal.statusHash, second.seal.statusHash);
});

test('DEV-P1-11: property order does not change the hash, so UI, CLI and API agree', () => {
  // §20 gate 4: three surfaces serialise the same body through different paths.
  const original = body();
  const reordered = Object.fromEntries(
    Object.entries(original as unknown as Record<string, unknown>).reverse(),
  ) as unknown as SealedBody;
  assert.equal(sealBodyDigest(original), sealBodyDigest(reordered));
});

test('DEV-P1-11: the hash covers the whole body and nothing but the body', () => {
  const snapshot = sealSnapshot(body(), PROVENANCE);

  // Every non-seal member is covered: changing one moves the hash.
  const mutated = { ...bodyOf(snapshot), sources: ['events:0-43'] } as SealedBody;
  assert.notEqual(sealBodyDigest(mutated), snapshot.seal.statusHash);

  // The seal itself is not covered — it cannot be, and the exclusion is exactly one member.
  const covered = Object.keys(bodyOf(snapshot));
  assert.equal(covered.includes('seal'), false);
  assert.equal(covered.length, Object.keys(snapshot).length - 1);
});

test('DEV-P1-11: a tampered body and a foreign seal are both refused', () => {
  const snapshot = sealSnapshot(body(), PROVENANCE);
  assert.equal(verifySeal(snapshot).valid, true);

  // Tampering: one field changed after sealing.
  const tampered: StatusSnapshot = {
    ...snapshot,
    recognition: { ...recognition, unitCount: 9999 },
  };
  const tamperResult = verifySeal(tampered);
  assert.equal(tamperResult.valid, false);
  assert.ok(tamperResult.failures.some((failure) => failure.code === 'HASH_MISMATCH'));

  // A foreign seal: valid in itself, pasted onto a different body. Recomputation catches
  // it without needing to know anything about where it came from.
  const other = sealSnapshot(body({ sources: ['events:100-200'] }), PROVENANCE);
  const swapped: StatusSnapshot = { ...snapshot, seal: other.seal };
  assert.equal(verifySeal(swapped).valid, false);
});

test('DEV-P1-11: consistency is re-evaluated, never taken from the seal', () => {
  const snapshot = sealSnapshot(body(), PROVENANCE);
  // A seal that asserts consistency over a body whose branches disagree is §15's
  // "projector defect". Believing the seal's own flag would defeat the check entirely.
  const lying: StatusSnapshot = {
    ...snapshot,
    recognition: { ...recognition, snapshotId: 'd'.repeat(64) },
    seal: { ...snapshot.seal, consistent: true },
  };
  const result = verifySeal(lying);
  assert.equal(result.valid, false);
  assert.ok(result.failures.some((failure) => failure.code === 'CONSISTENCY_MISMATCH'));
  assert.equal(result.consistency.consistent, false);
});

test('DEV-P1-11: edited provenance is caught even when the hash is recomputed to match', () => {
  // The subtle attack: change a branch, then re-seal so the hash is internally valid, then
  // edit the seal's restated identity. The provenance check is the one that sees it.
  const snapshot = sealSnapshot(body(), PROVENANCE);
  const edited: StatusSnapshot = {
    ...snapshot,
    seal: { ...snapshot.seal, targetSnapshotId: 'e'.repeat(64) },
  };
  const result = verifySeal(edited);
  assert.equal(result.valid, false);
  assert.ok(result.failures.some((failure) => failure.code === 'PROVENANCE_MISMATCH'));
});

test('DEV-P1-11: cross-branch disagreement is found, not declared away', () => {
  // Recognition and inventory naming different captures: the snapshot would be describing
  // two trees as one.
  const mismatched = evaluateConsistency(
    body({ recognition: { ...recognition, snapshotId: 'f'.repeat(64) } }),
  );
  assert.equal(mismatched.consistent, false);
  assert.ok(mismatched.inconsistencies.some((line) => line.startsWith('snapshot-identity:')));

  // §18: a partial scan cannot present itself as committed-complete.
  const overclaiming = evaluateConsistency(
    body({ recognition: { ...recognition, filesRecognised: 2, complete: true } }),
  );
  assert.equal(overclaiming.consistent, false);
  assert.ok(
    overclaiming.inconsistencies.some((line) => line.startsWith('recognition-completeness:')),
  );

  // Gate 26: the snapshot's account of itself must match the snapshot.
  const misdeclared = evaluateConsistency(
    body({
      capability: {
        contractVersion: STATUS_SCHEMA_VERSION,
        backedBranches: ['recognition', 'gauges'],
        unsupportedBranches: [...UNSUPPORTED_BRANCHES],
        satisfiedGates: [],
        unreachableGates: [],
      },
    }),
  );
  assert.equal(misdeclared.consistent, false);
  assert.ok(misdeclared.inconsistencies.some((line) => line.includes('gauges')));
});

test('ADR-0014: contradictory target publication fields invalidate Status consistency', () => {
  const contradictory = evaluateConsistency(
    body({
      target: {
        targetId: 'clu',
        name: 'CLU-E',
        canonicalRoot: '/tmp/clu',
        snapshotId: SNAPSHOT_ID,
        missionVersionId: 'MISSION-000001',
        missionBasisHash: 'a'.repeat(64) as unknown as Sha256,
        constitutionHash: 'd'.repeat(64) as unknown as Sha256,
        catalogueVersion: null,
        catalogueHash: null,
        recognizerVersion: 'clue-recognizer/4',
        publication: {
          decision: 'NO_REMOTE_YET',
          decisionId: 'P2-D5-NO-REMOTE-YET',
          recordedAt: '2026-08-14',
          recordedBy: 'creator',
          remote: 'git@example.com:owner/repo.git',
          credentialEnv: null,
          localOnly: true,
          gitLifecycleImplemented: false,
          publicationPermitted: false,
          reason: 'contradictory fixture',
        },
        freshness,
      } as never,
      capability: {
        contractVersion: STATUS_SCHEMA_VERSION,
        backedBranches: ['target', 'repositoryInventory', 'recognition'],
        unsupportedBranches: [...UNSUPPORTED_BRANCHES],
        satisfiedGates: [],
        unreachableGates: [],
      },
    }),
  );
  assert.equal(contradictory.consistent, false);
  assert.ok(
    contradictory.inconsistencies.some((line) => line.startsWith('target-publication:')),
  );
});

test('DEV-P1-11: an empty snapshot cannot report perfect consistency', () => {
  // The failure this design exists to avoid: checks whose branches are missing must be
  // *skipped* and counted, not silently passed, or a snapshot with nothing in it looks
  // maximally consistent — the most confident possible statement about no evidence.
  const empty = evaluateConsistency(
    body({ recognition: gap(), repositoryInventory: gap(), capability: {
      contractVersion: STATUS_SCHEMA_VERSION,
      backedBranches: [],
      unsupportedBranches: [...UNSUPPORTED_BRANCHES],
      satisfiedGates: [],
      unreachableGates: [],
    } } as unknown as Partial<SealedBody>),
  );
  // The precise invariant: no data-dependent check may report `pass` while the branch it
  // depends on is unavailable. Counting skips is not enough — one check quietly assuming a
  // pass would still leave the count high.
  const dataDependent = [
    'snapshot-identity',
    'project-profile-identity',
    'q1-graph-parity',
    'inventory-reconciliation',
    'recognition-completeness',
    'target-publication',
    'catalogue-agreement',
    'great-book-agreement',
    'ai-orchestration-accounting',
    'catalogue-governance',
    'gauge-count',
  ];
  for (const id of dataDependent) {
    const check = empty.checks.find((candidate) => candidate.id === id);
    assert.ok(check !== undefined, `${id} is evaluated even when it cannot run`);
    assert.equal(check?.outcome, 'skipped', `${id} must not pass without the data it checks`);
  }
  assert.equal(empty.skipped, dataDependent.length);

  // And a populated body genuinely runs more of them.
  const populated = evaluateConsistency(body());
  assert.ok(
    populated.skipped < empty.skipped,
    'a populated body runs strictly more checks than an empty one',
  );
});

test('DEV-P1-11: the Golden branch cannot report a value while stating no result', () => {
  const golden = unavailableGoldenMetrics('no Golden backend');
  const invented = evaluateConsistency(
    body({
      goldenMetrics: {
        ...golden,
        items: [
          { ...golden.items[0], normalizedValue: 0 },
          golden.items[1],
          golden.items[2],
          golden.items[3],
        ],
      },
    } as unknown as Partial<SealedBody>),
  );
  // supplement §9.8 clause 8: missing values never become zero.
  assert.equal(invented.consistent, false);
  assert.ok(invented.inconsistencies.some((line) => line.includes('golden-no-invented-values')));
});


test('DEV-P2-12: Great Book and Improvement Field must be one coherent read model', () => {
  const normalizationHash = '9'.repeat(64) as unknown as Sha256;
  const field = buildGreatBookImprovementField({
    capturedAt: PROVENANCE.generatedAt,
    targetId: 'clu',
    cycleId: null,
    catalogueVersion: '6.0',
    catalogueHash: '8'.repeat(64),
    normalizationVersion: 'proof-delta-pct/v1',
    normalizationHash,
    aggregationMode: 'CURRENT_CERTIFIED',
    selectedMeasurementId: null,
    contributions: [],
  });
  const summary = {
    entryCount: 0,
    contributionCount: 0,
    recordingGapCount: 0,
    latestEntryId: null,
    latestCycleId: null,
    normalizationVersion: 'proof-delta-pct/v1',
    normalizationHash,
    freshness,
  } as const;

  const coherent = evaluateConsistency(body({ greatBook: summary, improvementField: field }));
  assert.equal(coherent.checks.find((check) => check.id === 'great-book-agreement')?.outcome, 'pass');

  const gap = evaluateConsistency(
    body({ greatBook: { ...summary, recordingGapCount: 1 }, improvementField: field }),
  );
  assert.equal(gap.consistent, false);
  assert.match(
    gap.checks.find((check) => check.id === 'great-book-agreement')?.detail ?? '',
    /lack a Great Book entry/,
  );
});

test('DEV-P2-09: Model Gateway Status accounting and readiness are one coherent statement', () => {
  const ai = {
    configured: true,
    enabled: false,
    provider: 'openai',
    projectIdentity: null,
    profileGeneration: null,
    credentialReference: 'env:OPENAI_API_KEY',
    requestedModel: null,
    effectiveModel: null,
    fallbackUsed: false,
    apiKeyEnv: 'OPENAI_API_KEY',
    apiKeyPresent: false,
    operationallyReady: false,
    policyProblems: ['gateway disabled by installation policy'],
    budgetHash: '1'.repeat(64) as unknown as Sha256,
    routingHash: '2'.repeat(64) as unknown as Sha256,
    priceScheduleVersion: 'UNCONFIGURED-2026-08-13',
    enabledRouteCount: 0,
    defaultMode: 'batch',
    model: null,
    budgetAuthority: 'clue',
    localBudgetEnforced: true,
    localPricingAuthoritative: true,
    providerState: 'unknown',
    providerPaused: false,
    providerBudgetExhausted: false,
    providerPauseReason: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerRemainingTokens: null,
      providerRemainingTokensAuthoritative: false,
    },
    calls: { submitted: 0, completed: 0, failed: 0, refused: 0, pending: 0 },
    spendUsd: { todayActual: 0, monthActual: 0, reserved: 0, dailyHard: 0, monthlyHard: 0 },
    degradationAction: null,
    latest: null,
    freshness,
  } as const;

  const coherent = evaluateConsistency(body({ aiOrchestration: ai }));
  assert.equal(
    coherent.checks.find((check) => check.id === 'ai-orchestration-accounting')?.outcome,
    'pass',
  );

  const impossibleAccounting = evaluateConsistency(
    body({
      aiOrchestration: {
        ...ai,
        calls: { submitted: 1, completed: 0, failed: 0, refused: 0, pending: 0 },
      },
    }),
  );
  assert.equal(impossibleAccounting.consistent, false);
  assert.match(
    impossibleAccounting.checks.find((check) => check.id === 'ai-orchestration-accounting')
      ?.detail ?? '',
    /submitted call/,
  );

  const inventedReadiness = evaluateConsistency(
    body({ aiOrchestration: { ...ai, operationallyReady: true } }),
  );
  assert.equal(inventedReadiness.consistent, false);
  assert.match(
    inventedReadiness.checks.find((check) => check.id === 'ai-orchestration-accounting')
      ?.detail ?? '',
    /claims operational readiness/,
  );
});

