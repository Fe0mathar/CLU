/**
 * Console snapshot projector acceptance tests.
 *
 * Spec: CLUE_Milestone_Review_and_Forward_Plan_v3.md §5.2 (the deterministic read-side
 *       projector) and its acceptance list. These are the behavioural memory (CLUE_v3.md,
 *       "a test is the memory of a behavior") for the one place CLUE state is assembled,
 *       sealed, and validated into a ConsoleSnapshot.
 *
 * The projector is pure, so these tests need no database, clock, or filesystem — they drive
 * it with literal durable inputs and assert the §5.2 properties directly: determinism,
 * exactly one seal, commit-gated recognition, coverage separation, contradiction rejection,
 * and self-validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectConsoleSnapshot,
  type ProjectorInput,
  type RecognitionRecordInput,
} from '../src/ui/consoleProjector.js';
import { parseConsoleSnapshot } from '../src/ui/viewModel.js';
import { projectStatus } from '../src/status/statusProjector.js';
import type { StatusSnapshot } from '../src/status/statusContractV5.js';
import type { RegistrySource } from '../src/daemon/consoleStateCollector.js';

/**
 * ADR-0002 step 4: the recognition topology is now sourced from sealed Status, so these
 * fixtures must state it there rather than in the recognition record. A test that kept
 * asserting topology from the record would be asserting a path that no longer exists.
 *
 * The Status body is projected from the same facts the record carries, which is exactly what
 * the production path does — the ordering is Status first, console downstream of it.
 */
function statusWith(
  facts: { unitCount: number; filesRecognised: number; unresolvedCount: number; moduleCount: number } | null,
): StatusSnapshot {
  const snapshotId = 's'.repeat(64);
  const source = {
    currentMission: () => ({
      missionId: 'mission_000001',
      title: 'Improve Murugan',
      constitutionHash: 'c'.repeat(64),
      lastChange: 'initial' as const,
    }),
    latestSnapshot: () => ({
      snapshotId,
      fileCount: 42,
      capturedAt: '2026-07-26T11:59:00.000Z',
      languageCensus: { typescript: 40, wgsl: 2 },
    }),
    recognitionFor: () =>
      facts === null
        ? null
        : {
            snapshotId,
            resultHash: 'r'.repeat(64),
            unitCount: facts.unitCount,
            edgeCount: 540,
            unresolvedCount: facts.unresolvedCount,
            filesInProgram: 42,
            filesRecognised: facts.filesRecognised,
            semanticDiagnostics: 7,
            moduleCount: facts.moduleCount,
            classDistribution: {
              'monofile-monodependency': 0,
              'monofile-polydependency': 0,
              'polyfile-monodependency': 0,
              'polyfile-polydependency': 0,
            },
          },
    runIdForSnapshot: () => null,
    configReadiness: () => ({ status: 'ready', sections: [] }) as never,
    stateSources: () => ['eventlog@128', 'db@v3'],
  } as unknown as RegistrySource;

  return projectStatus(source, {
    capturedAt: '2026-07-26T12:00:00.000Z',
    targetId: 'TGT',
    targetName: null,
    canonicalRoot: '/repo',
    missionBasisHash: null,
    recognizerVersion: null,
    catalogue: null,
    q1: null,
    provenance: {
      eventLogFrom: null,
      eventLogTo: null,
      projectionVersion: null,
      goldenDefinitionHash: null,
    },
  }).snapshot;
}

/** The Status body matching {@link committedRecognition}. */
const COMMITTED_STATUS = (): StatusSnapshot =>
  statusWith({ unitCount: 300, filesRecognised: 42, unresolvedCount: 13, moduleCount: 0 });

/** A complete, valid set of durable inputs with no active run. Overridden per test. */
function baseInput(): ProjectorInput {
  return {
    capturedAt: '2026-07-26T12:00:00.000Z',
    operator: 'operator',
    activeTab: 'dashboard',
    mission: {
      missionId: 'mission_000001',
      title: 'Improve Murugan',
      constitutionHash: 'c'.repeat(64),
      lastChange: 'initial',
    },
    snapshot: { snapshotId: 's'.repeat(64), fileCount: 42, capturedAt: '2026-07-26T11:59:00.000Z' },
    run: null,
    recognition: null,
    readiness: { status: 'ready', sections: [{ section: 'project_repository', ready: true }] },
    sources: ['eventlog@128', 'db@v3'],
    // No committed graph: Status states the absence, and the console renders its uncommitted
    // field. Both descend from the one reading rather than from two.
    status: statusWith(null),
  };
}

/** A committed recognition record: every file scanned, but references left unresolved. */
function committedRecognition(): RecognitionRecordInput {
  return {
    edgeCount: 540,
    unresolvedCount: 13,
    filesInProgram: 42,
    filesRecognised: 42,
    semanticDiagnostics: 7,
    languageCensus: { typescript: 40, wgsl: 2 },
  };
}

test('projects a schema-valid snapshot and validates its own output', () => {
  const snapshot = projectConsoleSnapshot(baseInput());
  // Re-validating must not throw: the projector already ran parseConsoleSnapshot internally.
  parseConsoleSnapshot(snapshot);
  assert.equal(snapshot.seal.sources.length, 2, 'the seal carries the source identities it was built from');
  assert.equal(snapshot.shell.operator, 'operator');
});

test('is deterministic: identical durable inputs and timestamp produce a byte-identical snapshot', () => {
  const a = projectConsoleSnapshot(baseInput());
  const b = projectConsoleSnapshot(baseInput());
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same inputs must produce the same semantic snapshot');
  assert.equal(a.seal.snapshotHash, b.seal.snapshotHash, 'the seal hash is a pure function of the inputs');
});

test('contains exactly one State Seal, on the snapshot and not on the shell', () => {
  const snapshot = projectConsoleSnapshot(baseInput());
  assert.ok(snapshot.seal, 'the snapshot carries a seal');
  assert.ok(!('seal' in (snapshot.shell as unknown as Record<string, unknown>)), 'the shell must not carry an independent seal');
});

test('a graph is not shown recognised before a committed record exists', () => {
  const idle = projectConsoleSnapshot(baseInput());
  assert.equal(idle.dashboard.recognition.topology.filesRecognized, 0, 'no run -> empty recognition topology');
  assert.equal(idle.dashboard.recognition.topology.functions, 0);
  assert.equal(idle.dashboard.progress.recognition, 0, 'no run -> recognition lane at 0');

  const committed = projectConsoleSnapshot({
    ...baseInput(),
    run: { runId: 'r1', snapshotId: 's'.repeat(64), committed: { graphSha256: 'g'.repeat(64), recognitionRecordId: 's'.repeat(64) } },
    recognition: committedRecognition(),
    status: COMMITTED_STATUS(),
  });
  assert.equal(committed.dashboard.recognition.topology.functions, 300, 'committed record populates the unit count');
  assert.equal(committed.dashboard.recognition.topology.filesRecognized, 42);
  assert.equal(committed.dashboard.progress.recognition, 100, 'recognised files -> recognition lane at 100');
});

test('100% file scan coexists with incomplete recognition (coverage separation preserved)', () => {
  // Every file recognised, but 13 references unresolved: the recognition topology reflects the
  // graph while the residual (hidden edges) makes clear recognition is not complete.
  const snapshot = projectConsoleSnapshot({
    ...baseInput(),
    run: { runId: 'r1', snapshotId: 's'.repeat(64), committed: { graphSha256: 'g'.repeat(64), recognitionRecordId: 's'.repeat(64) } },
    recognition: committedRecognition(),
    status: COMMITTED_STATUS(),
  });
  assert.equal(snapshot.dashboard.recognition.topology.filesRecognized, 42, 'all files recognised');
  assert.equal(snapshot.dashboard.recognition.topology.hiddenEdges, 13, 'unresolved references surface as hidden edges, not silence');
});

test('contradictory readiness is rejected by the sealed schema', () => {
  // blocked must name where; the projector passes readiness through parseConsoleSnapshot, so a
  // contradictory readiness cannot be sealed into a snapshot.
  assert.throws(
    () => projectConsoleSnapshot({ ...baseInput(), readiness: { status: 'blocked', sections: [] } as never }),
    /firstBlocking|invalid|Invalid|Required|unrecognized|Unrecognized/i,
    'blocked-without-firstBlocking must not seal',
  );
});

test('the seal binds the projected state: different state yields a different seal hash', () => {
  const ready = projectConsoleSnapshot(baseInput());
  const blocked = projectConsoleSnapshot({
    ...baseInput(),
    readiness: { status: 'blocked', sections: [{ section: 'powershell', ready: false }], firstBlocking: 'powershell' },
  });
  assert.notEqual(blocked.seal.snapshotHash, ready.seal.snapshotHash, 'a change in projected state changes the seal');
  assert.equal(blocked.shell.configurationNeedsAttention, true, 'blocked readiness raises the configuration attention flag');
  assert.equal(blocked.shell.systemHealth, 'degraded', 'blocked readiness derives degraded system health');
  assert.equal(ready.shell.systemHealth, 'ok', 'ready readiness derives ok system health');
});

test('two runs of the same snapshot are distinguished by run identity in the projection', () => {
  const run1 = projectConsoleSnapshot({
    ...baseInput(),
    run: { runId: 'run-1', snapshotId: 's'.repeat(64), committed: { graphSha256: 'a'.repeat(64), recognitionRecordId: null } },
    recognition: committedRecognition(),
    status: COMMITTED_STATUS(),
  });
  const run2 = projectConsoleSnapshot({
    ...baseInput(),
    run: { runId: 'run-2', snapshotId: 's'.repeat(64), committed: { graphSha256: 'a'.repeat(64), recognitionRecordId: null } },
    recognition: committedRecognition(),
    status: COMMITTED_STATUS(),
  });
  // Same snapshot and same graph hash: the sealed body is run-agnostic on purpose, so the
  // identical committed graph projects to the identical state hash whichever run produced
  // it — the daemon's revision must not churn on re-runs, and replay parity must hold.
  assert.equal(run1.dashboard.recognition.topology.functions, run2.dashboard.recognition.topology.functions);
  assert.equal(run1.seal.snapshotHash, run2.seal.snapshotHash, 'same committed graph -> same projected state');
  // And yet the runs ARE distinguished — by provenance beside the hash, which is where
  // identity belongs (P0.3). This is what the test's name promised all along.
  assert.equal(run1.seal.graph?.runId, 'run-1');
  assert.equal(run2.seal.graph?.runId, 'run-2');
  assert.notEqual(run1.seal.graph?.runId, run2.seal.graph?.runId, 'provenance names the run');
  assert.equal(run1.seal.graph?.graphSha256, run2.seal.graph?.graphSha256, 'both provenances name the same graph');
});

test('seal provenance is read, never minted, across all identity regimes', () => {
  // Idle: no run, no provenance — null, not an invented block.
  const idle = projectConsoleSnapshot(baseInput());
  assert.equal(idle.seal.graph, null, 'no run means no provenance');

  // A recorded run id travels as read; the absent record identity is declared null.
  const named = projectConsoleSnapshot({
    ...baseInput(),
    run: { runId: 'run-7f3a', snapshotId: 's'.repeat(64), committed: { graphSha256: 'a'.repeat(64), recognitionRecordId: null } },
    recognition: committedRecognition(),
    status: COMMITTED_STATUS(),
  });
  assert.equal(named.seal.graph?.runId, 'run-7f3a');
  assert.equal(named.seal.graph?.graphSha256, 'a'.repeat(64), 'the durable result hash is the graph identity');
  assert.equal(named.seal.graph?.recognitionRecordId, null, 'no distinct durable record id exists; absence is declared');

  // A run whose identity was never durably recorded seals as declared absence — the
  // exact place the old collector once substituted the result hash.
  const anonymous = projectConsoleSnapshot({
    ...baseInput(),
    run: { runId: null, snapshotId: 's'.repeat(64), committed: { graphSha256: 'a'.repeat(64), recognitionRecordId: null } },
    recognition: committedRecognition(),
    status: COMMITTED_STATUS(),
  });
  assert.equal(anonymous.seal.graph?.runId, null, 'a missing run id survives sealing as null');
  assert.notEqual(anonymous.seal.graph?.runId, 'a'.repeat(64), 'never the result hash dressed up as a run');

  // A provisional run — named, nothing committed yet — is shown as exactly that.
  const provisional = projectConsoleSnapshot({
    ...baseInput(),
    run: { runId: 'run-9b21', snapshotId: 's'.repeat(64), committed: null },
  });
  assert.equal(provisional.seal.graph?.runId, 'run-9b21');
  assert.equal(provisional.seal.graph?.graphSha256, null, 'no committed graph, no graph hash');
});

test('an unverified hash chain is declared, never asserted', () => {
  // Deep review §5.9: the chain was once shown valid without ledger evidence. Until a real
  // verification fact reaches the reader seam, the only honest value is null — and this
  // test exists so an asserted `true` cannot quietly come back.
  const snapshot = projectConsoleSnapshot(baseInput());
  assert.equal(snapshot.configuration.storage.hashChainValid, null, 'a positive integrity claim requires evidence');
  assert.notEqual(snapshot.configuration.storage.hashChainValid, true, 'the withdrawn claim must stay withdrawn');
});
