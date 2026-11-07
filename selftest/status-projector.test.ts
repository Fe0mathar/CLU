/**
 * Status projector acceptance tests.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §1 (the same durable state produces the same body),
 *       §2 (backed or explicitly a named non-value), §18 (a failed projection records a
 *       fault and does not remove the rest), §20 gate 1 and gate 26.
 *
 * Backlog: DEV-P1-12.
 *
 * Driven through a fixture `RegistrySource` rather than a live workspace. That is the point
 * of depending on the reader seam: determinism is a property of the projector, and proving
 * it against a real registry would be proving something about the registry instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectStatus, type ProjectStatusOptions } from '../src/status/statusProjector.js';
import {
  UNSUPPORTED_BRANCHES,
  isBranchUnavailable,
  parseStatusSnapshot,
} from '../src/status/statusContractV5.js';
import { verifySeal } from '../src/status/statusSeal.js';
import type { RegistrySource } from '../src/daemon/consoleStateCollector.js';

const AT = '2026-08-06T00:00:00.000Z';
const SNAPSHOT = 'b'.repeat(64);
const RESULT = 'c'.repeat(64);

function fixture(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    currentMission: () => ({
      missionId: 'MISSION-000001',
      title: 'CLUE',
      constitutionHash: 'd'.repeat(64),
      lastChange: 'initial',
    }),
    latestSnapshot: () => ({
      snapshotId: SNAPSHOT,
      fileCount: 3,
      capturedAt: AT,
      languageCensus: { typescript: 3 },
    }),
    recognitionFor: () => ({
      snapshotId: SNAPSHOT,
      resultHash: RESULT,
      unitCount: 9,
      edgeCount: 4,
      unresolvedCount: 0,
      filesInProgram: 3,
      filesRecognised: 3,
      semanticDiagnostics: 0,
      moduleCount: 3,
      classDistribution: {
        'monofile-monodependency': 3,
        'monofile-polydependency': 0,
        'polyfile-monodependency': 0,
        'polyfile-polydependency': 0,
      },
    }),
    runIdForSnapshot: () => 'RUN-1',
    configReadiness: () => ({ ready: true, sections: [] }) as unknown as ReturnType<RegistrySource['configReadiness']>,
    stateSources: () => ['events:0-42'],
    ...overrides,
  } as RegistrySource;
}

function options(overrides: Partial<ProjectStatusOptions> = {}): ProjectStatusOptions {
  return {
    capturedAt: AT,
    targetId: 'TGT-CLUE',
    targetName: 'CLU-E',
    canonicalRoot: '/repo',
    missionBasisHash: 'e'.repeat(64),
    recognizerVersion: 'clue-recognizer/4',
    catalogue: {
      version: '6.0',
      hash: 'f'.repeat(64),
      activeCount: 100,
      reservedCount: 0,
      coordinatesUnique: true,
      productionReady: true,
    },
    q1: {
      runId: 'RUN-1',
      snapshotId: SNAPSHOT,
      resultHash: RESULT,
      streamSha256: '1'.repeat(64),
      streamEventCount: 120,
      degraded: false,
      inventoryReconciles: true,
    },
    provenance: {
      eventLogFrom: 0,
      eventLogTo: 42,
      projectionVersion: 'clue.projections/7',
      goldenDefinitionHash: null,
    },
    ...overrides,
  };
}

test('DEV-P1-12: the same durable inputs produce a byte-identical body and seal', () => {
  // §20 gate 1, and the property that makes `statusSeal.ts`'s "a mismatch is a projector
  // defect" a usable diagnosis rather than a hope.
  const first = projectStatus(fixture(), options());
  const second = projectStatus(fixture(), options());
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.equal(first.snapshot.seal.statusHash, second.snapshot.seal.statusHash);
  assert.deepEqual(first.faults, []);
});

test('DEV-P1-12: the projected body validates and its seal verifies', () => {
  const { snapshot } = projectStatus(fixture(), options());
  const parsed = parseStatusSnapshot(snapshot);
  assert.equal(parsed.schemaVersion, '5.8.0');

  const verification = verifySeal(snapshot);
  assert.equal(verification.valid, true, verification.failures.map((f) => f.detail).join('; '));
  assert.equal(verification.consistency.consistent, true);
});

test('DEV-P1-12: no clock is read — the capture instant governs every timestamp', () => {
  // A projector that read `Date.now()` anywhere would still pass the determinism test above
  // if both calls landed in the same millisecond. This one forces the issue: a different
  // declared instant must move every time-bearing field, and nothing else.
  const early = projectStatus(fixture(), options()).snapshot;
  const late = projectStatus(fixture(), options({ capturedAt: '2027-01-01T00:00:00.000Z' })).snapshot;

  assert.notEqual(early.generatedAt, late.generatedAt);
  assert.equal(late.seal.generatedAt, '2027-01-01T00:00:00.000Z');
  assert.notEqual(early.seal.statusHash, late.seal.statusHash);
  // The durable facts are untouched by the passage of time.
  assert.deepEqual(early.repositoryInventory, {
    ...(late.repositoryInventory as object),
    freshness: (early.repositoryInventory as { freshness: unknown }).freshness,
  } as never);
});

test('DEV-P1-12: every unsupported branch states a reason and none is omitted', () => {
  const { snapshot } = projectStatus(fixture(), options());
  for (const name of UNSUPPORTED_BRANCHES) {
    const branch = (snapshot as unknown as Record<string, unknown>)[name];
    assert.ok(branch !== undefined, `${name} is present`);
    assert.equal(isBranchUnavailable(branch as never), true, `${name} is a stated non-value`);
    assert.equal(
      (branch as { state: string }).state,
      'unsupported',
      `${name} distinguishes "not implemented" from "could not be read"`,
    );
    assert.ok((branch as { reason: string }).reason.length > 0, `${name} says why`);
  }
});

test('DEV-P1-12: one failing reader costs exactly one branch, and is recorded as a fault', () => {
  // §18's first rule. A fault that removed the other thirty-four branches would be a worse
  // outcome than the fault itself.
  const report = projectStatus(
    fixture({
      recognitionFor: () => {
        throw new Error('graph projection table is missing');
      },
    }),
    options(),
  );

  assert.equal(isBranchUnavailable(report.snapshot.recognition), true);
  assert.equal(
    (report.snapshot.recognition as { reason: string }).reason,
    'graph projection table is missing',
    'the reason reaches the branch',
  );
  assert.equal(report.faults.length, 1, 'and the fault is recorded');
  assert.equal(report.faults[0]?.branch, 'recognition');

  // Everything else survived.
  assert.equal(isBranchUnavailable(report.snapshot.repositoryInventory), false);
  assert.equal(isBranchUnavailable(report.snapshot.measurementCatalogue), false);
  assert.equal(isBranchUnavailable(report.snapshot.target), false);

  // §13.2 and gate 5: a projection fault is a *runtime* fault, never an assessment result.
  const diagnostics = report.snapshot.runtimeDiagnostics as { health: string; faults: readonly string[] };
  assert.equal(diagnostics.health, 'degraded');
  assert.equal(diagnostics.faults.length, 1);
  assert.equal(isBranchUnavailable(report.snapshot.assessment), true);
});

test('DEV-P1-12: a null reader yields unavailable, not unsupported', () => {
  // The distinction gate 26 turns on. "Implemented but nothing recorded yet" and "this
  // build does not implement it" must not read the same.
  const { snapshot } = projectStatus(fixture({ latestSnapshot: () => null }), options());
  const inventory = snapshot.repositoryInventory as { state: string; expectedSource: string };
  assert.equal(inventory.state, 'unavailable');
  assert.equal(inventory.expectedSource, 'SnapshotRegistry');
  assert.equal((snapshot.benchmarks as { state: string }).state, 'unsupported');
});

test('DEV-P1-12: gate 38 is evaluated, and "not compared" is not "equal"', () => {
  const matching = projectStatus(fixture(), options()).snapshot.q1 as {
    inventoryReconciles: boolean | null;
  };
  assert.equal(matching.inventoryReconciles, true);

  const disagreeing = projectStatus(
    fixture(),
    options({ q1: { ...options().q1!, inventoryReconciles: false } }),
  ).snapshot.q1 as { inventoryReconciles: boolean | null };
  assert.equal(disagreeing.inventoryReconciles, false);

  // Not evaluated is null — a third state, because "we did not compare" is a different
  // fact from "we compared and they matched".
  const uncompared = projectStatus(
    fixture(),
    options({ q1: { ...options().q1!, inventoryReconciles: null } }),
  ).snapshot.q1 as { inventoryReconciles: boolean | null };
  assert.equal(uncompared.inventoryReconciles, null);

  for (const stale of [{ resultHash: '0'.repeat(64) }, { snapshotId: '0'.repeat(64) }, { degraded: true }]) {
    const { snapshot } = projectStatus(fixture(), options({ q1: { ...options().q1!, ...stale } }));
    assert.equal((snapshot.q1 as { inventoryReconciles: boolean | null }).inventoryReconciles, null);
  }
});

test('DEV-P1-12: the capability declaration matches the body it describes', () => {
  // Gate 26: the snapshot's account of itself is checked by the seal, so a mismatch here
  // would also make the body inconsistent. Proving both together is the point.
  const { snapshot } = projectStatus(fixture(), options());
  assert.equal(verifySeal(snapshot).consistency.consistent, true);

  const declared = new Set(snapshot.capability.backedBranches);
  for (const name of declared) {
    const branch = (snapshot as unknown as Record<string, unknown>)[name];
    assert.equal(isBranchUnavailable(branch as never), false, `${name} is declared backed and is`);
  }
  // Gates are claimed conservatively and by evidence: gate 3 cannot hold while the console
  // view-model carries a second seal (ADR-0002), and the snapshot says so itself.
  // Gates 3 and 4 are claimed as of ADR-0002 step 5 and DEV-P1-16: one integrity verdict
  // (the console reads `consistent` from this body), and one composition behind the CLI,
  // the HTTP API and the dashboard. Gate 7 remains out of reach — unit records are not
  // projected, only their counts.
  assert.deepEqual(snapshot.capability.satisfiedGates, [1, 2, 3, 4]);
  assert.ok(snapshot.capability.unreachableGates.some((entry) => entry.gate === 7));
});

test('DEV-P1-12: a partial scan is not projected as complete', () => {
  // §18, routed through freshness.ts so the projector cannot express a different answer
  // than the validator would.
  const partial = projectStatus(
    fixture({
      recognitionFor: () => ({
        snapshotId: SNAPSHOT,
        resultHash: RESULT,
        unitCount: 9,
        edgeCount: 4,
        unresolvedCount: 0,
        filesInProgram: 10,
        filesRecognised: 7,
        semanticDiagnostics: 0,
        moduleCount: 3,
        classDistribution: {
          'monofile-monodependency': 3,
          'monofile-polydependency': 0,
          'polyfile-monodependency': 0,
          'polyfile-polydependency': 0,
        },
      }),
    }),
    options(),
  ).snapshot.recognition as { complete: boolean };
  assert.equal(partial.complete, false);
});


test('DEV-P2-12 / ADR-0012: Great Book is backed by durable facts under Status 5.8.0', () => {
  const report = projectStatus(
    fixture({
      greatBookFacts: () => ({
        entryCount: 2,
        contributionCount: 6,
        recordingGapCount: 1,
        latestEntryId: `GBI-${'a'.repeat(32)}`,
        latestCycleId: 'CYCLE-000014',
        latestRecordedAt: AT,
        normalizationVersion: 'proof-delta-pct/v1',
        normalizationHash: 'b'.repeat(64),
      }),
    }),
    options(),
  );
  const parsed = parseStatusSnapshot(report.snapshot);
  assert.equal(isBranchUnavailable(parsed.greatBook), false);
  if (isBranchUnavailable(parsed.greatBook)) return;
  assert.deepEqual(
    {
      entryCount: parsed.greatBook.entryCount,
      contributionCount: parsed.greatBook.contributionCount,
      recordingGapCount: parsed.greatBook.recordingGapCount,
      latestEntryId: parsed.greatBook.latestEntryId,
      latestCycleId: parsed.greatBook.latestCycleId,
    },
    {
      entryCount: 2,
      contributionCount: 6,
      recordingGapCount: 1,
      latestEntryId: `GBI-${'a'.repeat(32)}`,
      latestCycleId: 'CYCLE-000014',
    },
  );
  assert.ok(parsed.capability.backedBranches.includes('greatBook'));
  assert.equal(parsed.capability.unsupportedBranches.includes('greatBook' as never), false);
  assert.deepEqual(report.faults, []);
});

test('DEV-P2-12 / ADR-0012: a failed Great Book reader is unavailable and faulted, not empty', () => {
  const report = projectStatus(
    fixture({
      greatBookFacts: () => {
        throw new Error('Great Book projection unreadable');
      },
    }),
    options(),
  );
  assert.equal(isBranchUnavailable(report.snapshot.greatBook), true);
  if (!isBranchUnavailable(report.snapshot.greatBook)) return;
  assert.equal(report.snapshot.greatBook.state, 'unavailable');
  assert.match(report.snapshot.greatBook.reason, /projection unreadable/);
  assert.equal(report.faults.some((fault) => fault.branch === 'greatBook'), true);
});

test('DEV-P2-09 / ADR-0013: aiOrchestration is backed by governed policy and event facts', () => {
  const report = projectStatus(
    fixture({
      aiOrchestrationFacts: () => ({
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
        budgetHash: '1'.repeat(64),
        routingHash: '2'.repeat(64),
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
        submitted: 0,
        completed: 0,
        failed: 0,
        refused: 0,
        pending: 0,
        todayActualUsd: 0,
        monthActualUsd: 0,
        reservedUsd: 0,
        dailyHardUsd: 0,
        monthlyHardUsd: 0,
        degradationAction: null,
        latest: null,
      }),
    }),
    options(),
  );
  const parsed = parseStatusSnapshot(report.snapshot);
  assert.equal(isBranchUnavailable(parsed.aiOrchestration), false);
  if (isBranchUnavailable(parsed.aiOrchestration)) return;
  assert.equal(parsed.aiOrchestration.configured, true);
  assert.equal(parsed.aiOrchestration.enabled, false);
  assert.equal(parsed.aiOrchestration.operationallyReady, false);
  assert.equal(parsed.aiOrchestration.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(parsed.aiOrchestration.enabledRouteCount, 0);
  assert.equal(parsed.aiOrchestration.calls.pending, 0);
  assert.ok(parsed.capability.backedBranches.includes('aiOrchestration'));
  assert.equal(parsed.capability.unsupportedBranches.includes('aiOrchestration' as never), false);
  assert.deepEqual(report.faults, []);
  assert.equal(verifySeal(parsed).consistency.consistent, true);
});

test('DEV-P2-09 / ADR-0013: a failed gateway reader is unavailable and faulted, not healthy-empty', () => {
  const report = projectStatus(
    fixture({
      aiOrchestrationFacts: () => {
        throw new Error('gateway projection unreadable');
      },
    }),
    options(),
  );
  assert.equal(isBranchUnavailable(report.snapshot.aiOrchestration), true);
  if (!isBranchUnavailable(report.snapshot.aiOrchestration)) return;
  assert.equal(report.snapshot.aiOrchestration.state, 'unavailable');
  assert.match(report.snapshot.aiOrchestration.reason, /projection unreadable/);
  assert.equal(report.faults.some((fault) => fault.branch === 'aiOrchestration'), true);
});
