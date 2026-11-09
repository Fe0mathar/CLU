/** P2 B6 — durable benchmark/proof read model and its dashboard-safe view. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Runtime } from '../src/control/runtime.js';
import { BENCHMARK_EVENT_TYPES } from '../src/control/benchmarkRun.js';
import { EventLog } from '../src/memory/eventLog.js';
import { PROJECTION_SCHEMA_VERSION, ProjectionStore } from '../src/memory/db.js';
import { GREAT_BOOK_PROJECTION } from '../src/greatBook/greatBookProjection.js';
import { PROOF_EVENT_TYPES } from '../src/proof/proofContract.js';
import {
  PROOF_BOARD_PROJECTION,
  describeRegisteredBenchmark,
  readProofBoard,
} from '../src/daemon/proofBoardProjection.js';
import type { ArtifactRef } from '../src/shared/schemas.js';
import type { Sha256 } from '../src/shared/ids.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AT = '2026-08-14T05:00:00.000Z';
const H = (char: string): Sha256 => char.repeat(64).slice(0, 64) as Sha256;

function artifact(char: string, label: string): ArtifactRef {
  return {
    hash: H(char),
    bytes: 123,
    media_type: 'application/json; charset=utf-8',
    label,
    created_at: AT,
  };
}

function stack() {
  const root = mkdtempSync(join(tmpdir(), 'clue-proof-board-'));
  mkdirSync(join(root, 'events'), { recursive: true });
  const projections = new ProjectionStore(join(root, 'clue.db'), {
    modules: [PROOF_BOARD_PROJECTION, GREAT_BOOK_PROJECTION],
  });
  const { log } = EventLog.open(join(root, 'events'));
  const runtime = {
    projections,
    config: {
      project: {
        id: 'clu',
        root: REPO_ROOT,
        inputs: { benchmark: 'targets/clu/benchmark/master-benchmark.md' },
      },
    },
    mission: { current: () => ({ id: 'MISSION-000014' }) },
  } as unknown as Runtime;
  return {
    root,
    projections,
    log,
    runtime,
    close() {
      log.close();
      projections.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function appendBenchmark(log: EventLog) {
  return log.append({
    type: BENCHMARK_EVENT_TYPES.runRecorded,
    actor: 'cli',
    missionVersion: 'MISSION-000014',
    subjectId: null,
    payload: {
      registered: true,
      snapshot_id: H('a'),
      contract: {
        path: 'targets/clu/benchmark/master-benchmark.md',
        sha256: H('b'),
        benchmark_id: 'clu-master',
        benchmark_version: '0.1.0',
        block_id: 'HRN-001',
        runner_adapter: 'cli-node',
        integrity_sha256: H('c'),
      },
      result_artifact: artifact('d', 'benchmark result'),
      unified_score: 91.25,
      measures_count: 13,
      incomplete_count: 0,
      protective: [{ id: 'SIG-GUARD', value: 497 }],
      environment: { node: process.version },
      log_head_before: null,
      started_at: AT,
      finished_at: '2026-08-14T05:00:01.000Z',
      wall_ms: 1000,
      budget_exhausted: false,
    },
  });
}

function appendContract(log: EventLog, hypothesisId: string, cycleId = 'CYCLE-000014') {
  return log.append({
    type: PROOF_EVENT_TYPES.contractFrozen,
    actor: 'cli',
    missionVersion: 'MISSION-000014',
    subjectId: cycleId,
    payload: {
      target_id: 'clu',
      contract_hash: H('e'),
      hypothesis_id: hypothesisId,
      cycle_id: cycleId,
      snapshot_id: H('f'),
      contract_artifact: artifact('1', 'proof contract'),
      frozen_at: AT,
    },
  });
}

function appendBaseline(log: EventLog, benchmarkEventId: string) {
  return log.append({
    type: PROOF_EVENT_TYPES.baselineBound,
    actor: 'cli',
    missionVersion: 'MISSION-000014',
    subjectId: 'CYCLE-000014',
    payload: {
      contract_hash: H('e'),
      baseline_digest: H('2'),
      source_event_id: benchmarkEventId,
      run_artifact_hash: H('d'),
      reused: true,
    },
  });
}

function appendVerdict(log: EventLog) {
  return log.append({
    type: PROOF_EVENT_TYPES.verdictRecorded,
    actor: 'cli',
    missionVersion: 'MISSION-000014',
    subjectId: 'CYCLE-000014',
    payload: {
      target_id: 'clu',
      contract_hash: H('e'),
      hypothesis_id: 'HYP-B6-000001',
      cycle_id: 'CYCLE-000014',
      disposition: 'ACCEPT',
      improvement: true,
      reasons: ['success threshold met; every mandatory gate held'],
      deltas: [{ measure_id: 'SIG-COST', direction: 'lower_is_better', baseline: 100, candidate: 80, delta_pct: 20 }],
      baseline_digest: H('2'),
      candidate_digest: H('3'),
      candidate_snapshot_id: H('4'),
      patch_digest: H('5'),
      artifacts: {
        contract: artifact('1', 'proof contract'),
        candidate_run: artifact('6', 'candidate run'),
        verdict: artifact('7', 'verdict'),
      },
    },
  });
}

test('P2-B6: the registered benchmark identity is parsed and integrity-verified from the governed file', () => {
  const fixture = stack();
  try {
    const identity = describeRegisteredBenchmark(fixture.runtime);
    assert.equal(identity.state, 'registered');
    assert.equal(identity.benchmarkId, 'clu-master');
    assert.equal(identity.benchmarkVersion, '0.2.0');
    assert.equal(identity.runnerAdapter, 'cli-node');
    assert.equal(identity.harnessId, 'HRN-001');
    assert.equal(identity.integrityVerified, true);
    assert.match(identity.sha256 ?? '', /^[0-9a-f]{64}$/u);
  } finally {
    fixture.close();
  }
});

test('P2-B6: benchmark, contract, baseline and verdict replay into one read-only board', () => {
  const fixture = stack();
  try {
    const benchmark = appendBenchmark(fixture.log);
    appendContract(fixture.log, 'HYP-B6-000001');
    appendBaseline(fixture.log, benchmark.id);
    const verdict = appendVerdict(fixture.log);
    fixture.projections.sync(fixture.log);

    const board = readProofBoard(fixture.runtime, AT);
    assert.equal(board.schemaVersion, '1.0.0');
    assert.equal(board.projection.schemaVersion, PROJECTION_SCHEMA_VERSION);
    assert.equal(board.summary.benchmarkRuns, 1);
    assert.equal(board.summary.proofAttempts, 1);
    assert.equal(board.summary.accepts, 1);
    assert.equal(board.summary.rejects, 0);
    assert.equal(board.summary.latestBenchmarkEventId, benchmark.id);
    assert.equal(board.summary.latestVerdictEventId, verdict.id);
    assert.equal(board.benchmarkRuns[0]?.unifiedScore, 91.25);
    assert.equal(board.proofAttempts[0]?.verdict?.disposition, 'ACCEPT');
    assert.equal(board.proofAttempts[0]?.verdict?.eventId, verdict.id);
    assert.equal(board.proofAttempts[0]?.verdict?.greatBookState, 'legacy_unrecorded');
    assert.equal(board.proofAttempts[0]?.baseline?.sourceBenchmarkEventId, benchmark.id);

    // The Great Book module consumes the same verdict event too. Its intentional no-op for a
    // pre-Great-Book payload proves the proof-board projector did not overwrite it.
    const rows = fixture.projections.db.prepare('SELECT COUNT(*) AS n FROM great_book_entries').get() as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    fixture.close();
  }
});

test('P2-B6: a newer freeze starts a clean attempt boundary and cannot inherit the old verdict', () => {
  const fixture = stack();
  try {
    const benchmark = appendBenchmark(fixture.log);
    appendContract(fixture.log, 'HYP-B6-000001');
    appendBaseline(fixture.log, benchmark.id);
    appendVerdict(fixture.log);
    const latest = appendContract(fixture.log, 'HYP-B6-000002');
    fixture.projections.sync(fixture.log);

    const board = readProofBoard(fixture.runtime, AT);
    assert.equal(board.proofAttempts.length, 2);
    assert.equal(board.proofAttempts[0]?.contract.eventId, latest.id);
    assert.equal(board.proofAttempts[0]?.state, 'frozen');
    assert.equal(board.proofAttempts[0]?.baseline, null);
    assert.equal(board.proofAttempts[0]?.verdict, null);
    assert.equal(board.proofAttempts[1]?.verdict?.disposition, 'ACCEPT');
    assert.equal(board.summary.openAttempts, 1);
    assert.equal(board.summary.accepts, 1);
  } finally {
    fixture.close();
  }
});

test('closure scope retains a closed cycle proof beyond the dashboard history limit', () => {
  const fixture = stack();
  try {
    const benchmark = appendBenchmark(fixture.log);
    appendContract(fixture.log, 'HYP-B6-000001');
    appendBaseline(fixture.log, benchmark.id);
    const verdict = appendVerdict(fixture.log);
    for (let index = 0; index < 100; index += 1) {
      appendContract(fixture.log, `HYP-NEW-${index}`, 'CYCLE-000015');
    }
    fixture.projections.sync(fixture.log);

    assert.equal(readProofBoard(fixture.runtime, AT).summary.accepts, 0);
    const closureBoard = readProofBoard(fixture.runtime, AT, 'CYCLE-000014');
    assert.equal(closureBoard.summary.proofAttempts, 1);
    assert.equal(closureBoard.proofAttempts[0]?.verdict?.eventId, verdict.id);
  } finally {
    fixture.close();
  }
});

test('P2-B6: disposition/improvement contradictions fail projection atomically', () => {
  const fixture = stack();
  try {
    appendContract(fixture.log, 'HYP-B6-000001');
    appendBaseline(fixture.log, 'EVENT-000000');
    fixture.log.append({
      type: PROOF_EVENT_TYPES.verdictRecorded,
      actor: 'cli',
      missionVersion: 'MISSION-000014',
      subjectId: 'CYCLE-000014',
      payload: {
        target_id: 'clu', contract_hash: H('e'), hypothesis_id: 'HYP-B6-000001', cycle_id: 'CYCLE-000014',
        disposition: 'ACCEPT', improvement: false, reasons: ['contradiction'], deltas: [],
        baseline_digest: H('2'), candidate_digest: H('3'), candidate_snapshot_id: H('4'), patch_digest: H('5'),
        artifacts: { contract: artifact('1', 'contract'), candidate_run: artifact('6', 'candidate'), verdict: artifact('7', 'verdict') },
      },
    });
    assert.throws(() => fixture.projections.sync(fixture.log), /disposition\/improvement contradiction/);
    const eventCount = fixture.projections.db.prepare('SELECT COUNT(*) AS n FROM events_index').get() as { n: number };
    const contractCount = fixture.projections.db.prepare('SELECT COUNT(*) AS n FROM proof_board_contracts').get() as { n: number };
    assert.equal(eventCount.n, 0);
    assert.equal(contractCount.n, 0);
  } finally {
    fixture.close();
  }
});

test('P2-B6: a verdict cannot be attached to a different hypothesis with the same contract hash', () => {
  const fixture = stack();
  try {
    const benchmark = appendBenchmark(fixture.log);
    appendContract(fixture.log, 'HYP-B6-000001');
    appendBaseline(fixture.log, benchmark.id);
    fixture.log.append({
      type: PROOF_EVENT_TYPES.verdictRecorded,
      actor: 'cli',
      missionVersion: 'MISSION-000014',
      subjectId: 'CYCLE-000014',
      payload: {
        target_id: 'clu', contract_hash: H('e'), hypothesis_id: 'HYP-B6-DIFFERENT', cycle_id: 'CYCLE-000014',
        disposition: 'REJECT', improvement: false, reasons: ['different hypothesis'], deltas: [],
        baseline_digest: H('2'), candidate_digest: H('3'), candidate_snapshot_id: H('4'), patch_digest: H('5'),
        artifacts: { contract: artifact('1', 'contract'), candidate_run: artifact('6', 'candidate'), verdict: artifact('7', 'verdict') },
      },
    });
    fixture.projections.sync(fixture.log);
    assert.throws(() => readProofBoard(fixture.runtime, AT), /different hypothesis/);
  } finally {
    fixture.close();
  }
});

test('P2-B6: a verdict cannot substitute a different baseline digest', () => {
  const fixture = stack();
  try {
    const benchmark = appendBenchmark(fixture.log);
    appendContract(fixture.log, 'HYP-B6-000001');
    appendBaseline(fixture.log, benchmark.id);
    fixture.log.append({
      type: PROOF_EVENT_TYPES.verdictRecorded,
      actor: 'cli',
      missionVersion: 'MISSION-000014',
      subjectId: 'CYCLE-000014',
      payload: {
        target_id: 'clu', contract_hash: H('e'), hypothesis_id: 'HYP-B6-000001', cycle_id: 'CYCLE-000014',
        disposition: 'REJECT', improvement: false, reasons: ['different baseline'], deltas: [],
        baseline_digest: H('8'), candidate_digest: H('3'), candidate_snapshot_id: H('4'), patch_digest: H('5'),
        artifacts: { contract: artifact('1', 'contract'), candidate_run: artifact('6', 'candidate'), verdict: artifact('7', 'verdict') },
      },
    });
    fixture.projections.sync(fixture.log);
    assert.throws(() => readProofBoard(fixture.runtime, AT), /does not bind the recorded baseline/);
  } finally {
    fixture.close();
  }
});

test('P2-B6: corrupted SQLite boolean values are refused rather than coerced truthy', () => {
  const fixture = stack();
  try {
    appendBenchmark(fixture.log);
    fixture.projections.sync(fixture.log);
    fixture.projections.db.prepare('UPDATE proof_board_benchmark_runs SET registered = 2').run();
    assert.throws(() => readProofBoard(fixture.runtime, AT), /must be stored as 0 or 1/);
  } finally {
    fixture.close();
  }
});

test('P2-B6: compact ZIP-03 closure signals remain valid but are not misrepresented as full proof attempts', () => {
  const fixture = stack();
  try {
    fixture.log.append({
      type: PROOF_EVENT_TYPES.verdictRecorded,
      actor: 'cli',
      missionVersion: 'MISSION-000014',
      subjectId: 'CYCLE-000014',
      payload: { cycle_id: 'CYCLE-000014', disposition: 'ACCEPT', improvement: false },
    });
    assert.doesNotThrow(() => fixture.projections.sync(fixture.log));
    const board = readProofBoard(fixture.runtime, AT);
    assert.equal(board.summary.proofAttempts, 0);
    assert.equal(board.summary.accepts, 0);
    const rows = fixture.projections.db.prepare('SELECT COUNT(*) AS n FROM proof_board_verdicts').get() as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    fixture.close();
  }
});
