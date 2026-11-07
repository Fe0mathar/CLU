import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Runtime } from '../src/control/runtime.js';
import { RuntimeRegistrySource } from '../src/daemon/runtimeRegistrySource.js';
import type { RegistrySource } from '../src/daemon/consoleStateCollector.js';
import { ProjectionStore } from '../src/memory/db.js';
import { PROOF_EVENT_TYPES } from '../src/proof/proofContract.js';
import { projectStatus, type ProjectStatusOptions } from '../src/status/statusProjector.js';
import {
  BACKED_BRANCHES,
  STATUS_SCHEMA_VERSION,
  UNSUPPORTED_BRANCHES,
  isBranchUnavailable,
  parseStatusSnapshot,
} from '../src/status/statusContractV5.js';
import { CYCLE_PROJECTION } from '../src/cycle/cycleRegistry.js';

const AT = '2026-08-13T12:00:00.000Z';
const SNAPSHOT = 'a'.repeat(64);

function source(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    currentMission: () => ({
      missionId: 'MISSION-000014',
      title: 'clu',
      constitutionHash: 'b'.repeat(64),
      lastChange: 'unchanged',
    }),
    latestSnapshot: () => ({
      snapshotId: SNAPSHOT,
      fileCount: 1,
      capturedAt: AT,
      languageCensus: { typescript: 1 },
    }),
    recognitionFor: () => null,
    runIdForSnapshot: () => null,
    configReadiness: () => ({ ready: true, sections: [] }) as never,
    stateSources: () => ['events:100'],
    proofPipelineFacts: () => ({
      cycleId: 'CYCLE-000014',
      contractFrozen: { eventId: 'EVENT-000101', sequence: 101, occurredAt: AT },
      baselineBound: { eventId: 'EVENT-000102', sequence: 102, occurredAt: AT },
      executionRefused: null,
      verdictRecorded: { eventId: 'EVENT-000103', sequence: 103, occurredAt: AT },
    }),
    ...overrides,
  } as RegistrySource;
}

function options(): ProjectStatusOptions {
  return {
    capturedAt: AT,
    targetId: 'clu',
    targetName: 'CLU-E',
    canonicalRoot: 'F:/CLU/CLU',
    missionBasisHash: 'c'.repeat(64),
    recognizerVersion: 'clue-recognizer/4',
    catalogue: null,
    q1: null,
    provenance: {
      eventLogFrom: 0,
      eventLogTo: 103,
      projectionVersion: '5',
      goldenDefinitionHash: null,
    },
  };
}

test('DEV-P2-11 / ADR-0011: proofPipeline is a backed Status 5.8.0 branch', () => {
  assert.equal(STATUS_SCHEMA_VERSION, '5.8.0');
  assert.ok(BACKED_BRANCHES.includes('proofPipeline'));
  assert.equal((UNSUPPORTED_BRANCHES as readonly string[]).includes('proofPipeline'), false);

  const snapshot = parseStatusSnapshot(projectStatus(source(), options()).snapshot);
  assert.equal(snapshot.schemaVersion, '5.8.0');
  assert.equal(isBranchUnavailable(snapshot.proofPipeline), false);
  if (isBranchUnavailable(snapshot.proofPipeline)) return;
  assert.equal(snapshot.proofPipeline.cycleId, 'CYCLE-000014');
  assert.equal(snapshot.proofPipeline.contractFrozen?.eventId, 'EVENT-000101');
  assert.equal(snapshot.proofPipeline.baselineBound?.eventId, 'EVENT-000102');
  assert.equal(snapshot.proofPipeline.executionRefused, null);
  assert.equal(snapshot.proofPipeline.verdictRecorded?.eventId, 'EVENT-000103');
  assert.equal(snapshot.proofPipeline.freshness.observedAt, AT);
  assert.ok(snapshot.capability.backedBranches.includes('proofPipeline'));
});

test('DEV-P2-11 / ADR-0011: a virgin proof domain is backed and truthfully empty', () => {
  const snapshot = projectStatus(
    source({
      proofPipelineFacts: () => ({
        cycleId: null,
        contractFrozen: null,
        baselineBound: null,
        executionRefused: null,
        verdictRecorded: null,
      }),
    }),
    options(),
  ).snapshot;
  assert.equal(isBranchUnavailable(snapshot.proofPipeline), false);
  if (isBranchUnavailable(snapshot.proofPipeline)) return;
  assert.equal(snapshot.proofPipeline.cycleId, null);
  assert.equal(snapshot.proofPipeline.contractFrozen, null);
  assert.equal(snapshot.proofPipeline.verdictRecorded, null);
});

test('DEV-P2-11 / ADR-0011: a missing or failing proof reader never fabricates progress', () => {
  const absentSource = source() as RegistrySource & {
    proofPipelineFacts?: RegistrySource['proofPipelineFacts'];
  };
  delete absentSource.proofPipelineFacts;
  const absent = projectStatus(absentSource, options()).snapshot;
  assert.equal(isBranchUnavailable(absent.proofPipeline), true);
  if (!isBranchUnavailable(absent.proofPipeline)) return;
  assert.equal(absent.proofPipeline.state, 'unavailable');

  const failed = projectStatus(
    source({
      proofPipelineFacts: () => {
        throw new Error('proof index unreadable');
      },
    }),
    options(),
  );
  assert.equal(isBranchUnavailable(failed.snapshot.proofPipeline), true);
  assert.equal(failed.faults.some((fault) => fault.branch === 'proofPipeline'), true);
});

test('DEV-P2-11 / ADR-0011: the runtime reader selects one coherent latest attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-pipeline-source-'));
  const projections = new ProjectionStore(join(root, 'clue.db'), {
    modules: [CYCLE_PROJECTION],
  });
  try {
    let sequence = 0;
    const insert = (type: string, subjectId: string | null): string => {
      sequence += 1;
      const id = `EVENT-${String(sequence).padStart(6, '0')}`;
      projections.db
        .prepare(
          `INSERT INTO events_index
             (sequence, id, timestamp, type, actor, subject_id, mission_version, hash)
           VALUES (?, ?, ?, ?, 'selftest', ?, 'MISSION-000014', ?)`,
        )
        .run(sequence, id, `2026-08-13T12:00:${String(sequence).padStart(2, '0')}.000Z`, type, subjectId, 'd'.repeat(64));
      return id;
    };

    // Attempt one reached a verdict.
    insert(PROOF_EVENT_TYPES.contractFrozen, 'CYCLE-000014');
    insert(PROOF_EVENT_TYPES.baselineBound, 'CYCLE-000014');
    insert(PROOF_EVENT_TYPES.verdictRecorded, 'CYCLE-000014');
    // A pre-ADR unattributed event is ignored even though it is newer.
    insert(PROOF_EVENT_TYPES.contractFrozen, null);
    // Attempt two has only just frozen. It must not inherit attempt one's baseline/verdict.
    const latestContract = insert(PROOF_EVENT_TYPES.contractFrozen, 'CYCLE-000014');

    const runtime = {
      projections,
      config: { project: { id: 'clu' } },
      repoRoot: root,
      workspaceRoot: root,
    } as unknown as Runtime;
    const reader = new RuntimeRegistrySource(runtime, {
      readiness: { ready: true, sections: [] } as never,
      sources: [],
    });

    const freshAttempt = reader.proofPipelineFacts();
    assert.equal(freshAttempt.cycleId, 'CYCLE-000014');
    assert.equal(freshAttempt.contractFrozen?.eventId, latestContract);
    assert.equal(freshAttempt.baselineBound, null);
    assert.equal(freshAttempt.executionRefused, null);
    assert.equal(freshAttempt.verdictRecorded, null);

    const baseline = insert(PROOF_EVENT_TYPES.baselineBound, 'CYCLE-000014');
    const refusal = insert(PROOF_EVENT_TYPES.executionRefused, 'CYCLE-000014');
    const refusedAttempt = reader.proofPipelineFacts();
    assert.equal(refusedAttempt.baselineBound?.eventId, baseline);
    assert.equal(refusedAttempt.executionRefused?.eventId, refusal);
    assert.equal(refusedAttempt.verdictRecorded, null);

    // A contradictory terminal history is not rendered as a healthy pipeline.
    insert(PROOF_EVENT_TYPES.verdictRecorded, 'CYCLE-000014');
    assert.throws(() => reader.proofPipelineFacts(), /both execution refusal and verdict/);
  } finally {
    projections.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P2-11 / ADR-0011: an active cycle is shown empty rather than borrowing old proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-pipeline-current-cycle-'));
  const projections = new ProjectionStore(join(root, 'clue.db'), {
    modules: [CYCLE_PROJECTION],
  });
  try {
    projections.db
      .prepare(
        `INSERT INTO events_index
           (sequence, id, timestamp, type, actor, subject_id, mission_version, hash)
         VALUES (1, 'EVENT-000001', ?, ?, 'selftest', 'CYCLE-000014', 'MISSION-000014', ?)`,
      )
      .run(AT, PROOF_EVENT_TYPES.contractFrozen, 'e'.repeat(64));
    projections.db
      .prepare(
        `INSERT INTO cycles
           (id, mission_version, stage, suspended_from, grade, lock_digest,
            opened_at, updated_at, closed_at, criteria_met, unmet_count)
         VALUES ('CYCLE-000015', 'MISSION-000014', 'SCREENED', NULL, 'diagnostic', NULL,
                 ?, ?, NULL, NULL, NULL)`,
      )
      .run(AT, AT);

    const runtime = {
      projections,
      config: { project: { id: 'clu' } },
      repoRoot: root,
      workspaceRoot: root,
    } as unknown as Runtime;
    const reader = new RuntimeRegistrySource(runtime, {
      readiness: { ready: true, sections: [] } as never,
      sources: [],
    });
    const facts = reader.proofPipelineFacts();
    assert.equal(facts.cycleId, 'CYCLE-000015');
    assert.equal(facts.contractFrozen, null);
    assert.equal(facts.baselineBound, null);
    assert.equal(facts.verdictRecorded, null);
  } finally {
    projections.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
