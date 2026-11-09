/**
 * Durable benchmark/proof read model for the dashboard Proof Board (P2 B6).
 *
 * Authority remains the append-only event log. These SQLite tables are rebuildable
 * projections only: benchmark runs and proof-attempt events are copied from their exact
 * event payloads, then joined at read time by cycle + contract hash + sequence boundary.
 * The browser never derives a verdict and never reads artifacts directly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import { readBenchmarkContract, selectHarnessBlock, verifyHarnessIntegrity } from '../benchmark/harnessBlock.js';
import { BENCHMARK_EVENT_TYPES } from '../control/benchmarkRun.js';
import type { Runtime } from '../control/runtime.js';
import type { ProjectionModule } from '../memory/db.js';
import { PROOF_EVENT_TYPES } from '../proof/proofContract.js';
import { hashBytes, requireSha256, type Sha256 } from '../shared/ids.js';
import {
  artifactRefSchema,
  isoTimestampSchema,
  sha256Schema,
  type EventRecord,
} from '../shared/schemas.js';
import { greatBookRecordingSchema } from '../greatBook/greatBookEntry.js';

export const PROOF_BOARD_SCHEMA_VERSION = '1.0.0' as const;
const BOARD_LIMIT = 100;

type Db = Database.Database;

const proofDispositionSchema = z.enum(['ACCEPT', 'REJECT', 'REVISE', 'INVALID']);

// ZIP 03 introduced a compact closure signal under the same event type. It is sufficient for
// §24 derivation but is not a complete proof attempt and therefore has no place on the B6 board.
// Accept that exact legacy shape without projecting it; a partial modern payload still fails closed.
const closureOnlyProofVerdictSchema = z
  .object({
    cycle_id: z.string().min(1),
    disposition: proofDispositionSchema,
    improvement: z.boolean(),
  })
  .strict();

const benchmarkProtectiveSchema = z
  .object({ id: z.string().min(1), value: z.number().finite().nullable() })
  .strict();

export const benchmarkRunRecordedPayloadSchema = z
  .object({
    registered: z.boolean(),
    snapshot_id: z.string().min(1).nullable(),
    contract: z
      .object({
        path: z.string().min(1),
        sha256: sha256Schema,
        benchmark_id: z.string().min(1),
        benchmark_version: z.string().min(1),
        block_id: z.string().min(1),
        runner_adapter: z.string().min(1),
        integrity_sha256: sha256Schema,
      })
      .passthrough(),
    result_artifact: artifactRefSchema,
    unified_score: z.number().finite().nullable(),
    measures_count: z.number().int().nonnegative(),
    incomplete_count: z.number().int().nonnegative(),
    protective: z.array(benchmarkProtectiveSchema),
    environment: z.unknown(),
    log_head_before: z
      .object({ sequence: z.number().int().nonnegative(), hash: sha256Schema })
      .strict()
      .nullable(),
    started_at: isoTimestampSchema,
    finished_at: isoTimestampSchema,
    wall_ms: z.number().int().nonnegative(),
    budget_exhausted: z.boolean(),
  })
  .passthrough();

export const proofContractFrozenPayloadSchema = z
  .object({
    target_id: z.string().min(1),
    contract_hash: sha256Schema,
    hypothesis_id: z.string().min(1),
    cycle_id: z.string().min(1),
    snapshot_id: z.string().min(1),
    contract_artifact: artifactRefSchema,
    frozen_at: isoTimestampSchema,
  })
  .passthrough();

export const proofBaselineBoundPayloadSchema = z
  .object({
    contract_hash: sha256Schema,
    baseline_digest: sha256Schema,
    source_event_id: z.string().min(1).nullable(),
    run_artifact_hash: sha256Schema.nullable(),
    reused: z.boolean(),
  })
  .passthrough();

export const proofExecutionRefusedPayloadSchema = z
  .object({
    contract_hash: sha256Schema,
    stage: z.string().min(1),
    reason: z.string().min(1),
    evidence: z.array(z.unknown()).optional().default([]),
  })
  .passthrough();

const proofDeltaSchema = z
  .object({
    measure_id: z.string().min(1),
    direction: z.enum(['lower_is_better', 'higher_is_better']),
    baseline: z.number().finite(),
    candidate: z.number().finite(),
    delta_pct: z.number().finite(),
  })
  .strict();

export const proofVerdictRecordedPayloadSchema = z
  .object({
    target_id: z.string().min(1),
    contract_hash: sha256Schema,
    hypothesis_id: z.string().min(1),
    cycle_id: z.string().min(1),
    disposition: proofDispositionSchema,
    improvement: z.boolean(),
    reasons: z.array(z.string()),
    deltas: z.array(proofDeltaSchema),
    baseline_digest: sha256Schema,
    candidate_digest: sha256Schema,
    candidate_snapshot_id: z.string().min(1),
    patch_digest: sha256Schema,
    artifacts: z
      .object({
        contract: artifactRefSchema,
        candidate_run: artifactRefSchema,
        verdict: artifactRefSchema,
      })
      .strict(),
    great_book: greatBookRecordingSchema.optional(),
  })
  .passthrough();

export const PROOF_BOARD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proof_board_benchmark_runs (
  event_id            TEXT PRIMARY KEY,
  sequence            INTEGER NOT NULL UNIQUE,
  recorded_at         TEXT NOT NULL,
  mission_version     TEXT NOT NULL,
  snapshot_id         TEXT,
  registered          INTEGER NOT NULL,
  benchmark_id        TEXT NOT NULL,
  benchmark_version   TEXT NOT NULL,
  block_id            TEXT NOT NULL,
  runner_adapter      TEXT NOT NULL,
  contract_sha256     TEXT NOT NULL,
  integrity_sha256    TEXT NOT NULL,
  result_artifact_hash TEXT NOT NULL,
  unified_score       REAL,
  measures_count      INTEGER NOT NULL,
  incomplete_count    INTEGER NOT NULL,
  protective_json     TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  finished_at         TEXT NOT NULL,
  wall_ms             INTEGER NOT NULL,
  budget_exhausted    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proof_board_benchmark_runs_time
  ON proof_board_benchmark_runs(recorded_at, sequence);
CREATE INDEX IF NOT EXISTS proof_board_benchmark_runs_contract
  ON proof_board_benchmark_runs(contract_sha256, sequence);

CREATE TABLE IF NOT EXISTS proof_board_contracts (
  event_id             TEXT PRIMARY KEY,
  sequence             INTEGER NOT NULL UNIQUE,
  recorded_at          TEXT NOT NULL,
  mission_version      TEXT NOT NULL,
  target_id            TEXT NOT NULL,
  cycle_id             TEXT NOT NULL,
  contract_hash        TEXT NOT NULL,
  hypothesis_id        TEXT NOT NULL,
  snapshot_id          TEXT NOT NULL,
  contract_artifact_hash TEXT NOT NULL,
  frozen_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proof_board_contracts_target_cycle
  ON proof_board_contracts(target_id, cycle_id, sequence);
CREATE INDEX IF NOT EXISTS proof_board_contracts_contract
  ON proof_board_contracts(contract_hash, sequence);

CREATE TABLE IF NOT EXISTS proof_board_baselines (
  event_id              TEXT PRIMARY KEY,
  sequence              INTEGER NOT NULL UNIQUE,
  recorded_at           TEXT NOT NULL,
  mission_version       TEXT NOT NULL,
  cycle_id              TEXT NOT NULL,
  contract_hash         TEXT NOT NULL,
  baseline_digest       TEXT NOT NULL,
  source_event_id       TEXT,
  run_artifact_hash     TEXT,
  reused                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proof_board_baselines_attempt
  ON proof_board_baselines(cycle_id, contract_hash, sequence);

CREATE TABLE IF NOT EXISTS proof_board_refusals (
  event_id              TEXT PRIMARY KEY,
  sequence              INTEGER NOT NULL UNIQUE,
  recorded_at           TEXT NOT NULL,
  mission_version       TEXT NOT NULL,
  cycle_id              TEXT NOT NULL,
  contract_hash         TEXT NOT NULL,
  stage                  TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  evidence_json          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proof_board_refusals_attempt
  ON proof_board_refusals(cycle_id, contract_hash, sequence);

CREATE TABLE IF NOT EXISTS proof_board_verdicts (
  event_id               TEXT PRIMARY KEY,
  sequence               INTEGER NOT NULL UNIQUE,
  recorded_at            TEXT NOT NULL,
  mission_version        TEXT NOT NULL,
  target_id              TEXT NOT NULL,
  cycle_id               TEXT NOT NULL,
  contract_hash          TEXT NOT NULL,
  hypothesis_id          TEXT NOT NULL,
  disposition            TEXT NOT NULL,
  improvement            INTEGER NOT NULL,
  reasons_json           TEXT NOT NULL,
  deltas_json            TEXT NOT NULL,
  baseline_digest        TEXT NOT NULL,
  candidate_digest       TEXT NOT NULL,
  candidate_snapshot_id  TEXT NOT NULL,
  patch_digest           TEXT NOT NULL,
  contract_artifact_hash TEXT NOT NULL,
  candidate_artifact_hash TEXT NOT NULL,
  verdict_artifact_hash  TEXT NOT NULL,
  great_book_state       TEXT NOT NULL,
  great_book_entry_id    TEXT
);
CREATE INDEX IF NOT EXISTS proof_board_verdicts_target_cycle
  ON proof_board_verdicts(target_id, cycle_id, sequence);
CREATE INDEX IF NOT EXISTS proof_board_verdicts_attempt
  ON proof_board_verdicts(cycle_id, contract_hash, sequence);
`;

function requireSubjectCycle(record: EventRecord, cycleId: string): void {
  if (record.subject_id !== cycleId) {
    throw new Error(
      `${record.id} cycle ${cycleId} does not match event subject ${record.subject_id ?? 'null'}.`,
    );
  }
}

function projectBenchmarkRun(db: Db, record: EventRecord): void {
  const payload = benchmarkRunRecordedPayloadSchema.parse(record.payload);
  db.prepare(
    `INSERT INTO proof_board_benchmark_runs (
       event_id, sequence, recorded_at, mission_version, snapshot_id, registered,
       benchmark_id, benchmark_version, block_id, runner_adapter, contract_sha256,
       integrity_sha256, result_artifact_hash, unified_score, measures_count,
       incomplete_count, protective_json, started_at, finished_at, wall_ms, budget_exhausted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sequence,
    record.timestamp,
    record.mission_version,
    payload.snapshot_id,
    payload.registered ? 1 : 0,
    payload.contract.benchmark_id,
    payload.contract.benchmark_version,
    payload.contract.block_id,
    payload.contract.runner_adapter,
    payload.contract.sha256,
    payload.contract.integrity_sha256,
    payload.result_artifact.hash,
    payload.unified_score,
    payload.measures_count,
    payload.incomplete_count,
    JSON.stringify(payload.protective),
    payload.started_at,
    payload.finished_at,
    payload.wall_ms,
    payload.budget_exhausted ? 1 : 0,
  );
}

function projectContractFrozen(db: Db, record: EventRecord): void {
  const payload = proofContractFrozenPayloadSchema.parse(record.payload);
  requireSubjectCycle(record, payload.cycle_id);
  db.prepare(
    `INSERT INTO proof_board_contracts (
       event_id, sequence, recorded_at, mission_version, target_id, cycle_id,
       contract_hash, hypothesis_id, snapshot_id, contract_artifact_hash, frozen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sequence,
    record.timestamp,
    record.mission_version,
    payload.target_id,
    payload.cycle_id,
    payload.contract_hash,
    payload.hypothesis_id,
    payload.snapshot_id,
    payload.contract_artifact.hash,
    payload.frozen_at,
  );
}

function projectBaselineBound(db: Db, record: EventRecord): void {
  const payload = proofBaselineBoundPayloadSchema.parse(record.payload);
  if (record.subject_id === null) throw new Error(`${record.id} baseline has no cycle subject.`);
  db.prepare(
    `INSERT INTO proof_board_baselines (
       event_id, sequence, recorded_at, mission_version, cycle_id, contract_hash,
       baseline_digest, source_event_id, run_artifact_hash, reused)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sequence,
    record.timestamp,
    record.mission_version,
    record.subject_id,
    payload.contract_hash,
    payload.baseline_digest,
    payload.source_event_id,
    payload.run_artifact_hash,
    payload.reused ? 1 : 0,
  );
}

function projectExecutionRefused(db: Db, record: EventRecord): void {
  const payload = proofExecutionRefusedPayloadSchema.parse(record.payload);
  if (record.subject_id === null) throw new Error(`${record.id} refusal has no cycle subject.`);
  db.prepare(
    `INSERT INTO proof_board_refusals (
       event_id, sequence, recorded_at, mission_version, cycle_id, contract_hash,
       stage, reason, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sequence,
    record.timestamp,
    record.mission_version,
    record.subject_id,
    payload.contract_hash,
    payload.stage,
    payload.reason,
    JSON.stringify(payload.evidence),
  );
}

export function projectProofVerdict(db: Db, record: EventRecord): void {
  const full = proofVerdictRecordedPayloadSchema.safeParse(record.payload);
  if (!full.success) {
    if (closureOnlyProofVerdictSchema.safeParse(record.payload).success) return;
    throw full.error;
  }
  const payload = full.data;
  requireSubjectCycle(record, payload.cycle_id);
  if ((payload.disposition === 'ACCEPT') !== payload.improvement) {
    throw new Error(
      `${record.id} disposition/improvement contradiction: ${payload.disposition}/${String(payload.improvement)}.`,
    );
  }
  const greatBookState = payload.great_book?.state ?? 'legacy_unrecorded';
  const greatBookEntryId =
    payload.great_book?.state === 'recorded' ? payload.great_book.entry.entry_id : null;
  db.prepare(
    `INSERT INTO proof_board_verdicts (
       event_id, sequence, recorded_at, mission_version, target_id, cycle_id,
       contract_hash, hypothesis_id, disposition, improvement, reasons_json, deltas_json,
       baseline_digest, candidate_digest, candidate_snapshot_id, patch_digest,
       contract_artifact_hash, candidate_artifact_hash, verdict_artifact_hash,
       great_book_state, great_book_entry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sequence,
    record.timestamp,
    record.mission_version,
    payload.target_id,
    payload.cycle_id,
    payload.contract_hash,
    payload.hypothesis_id,
    payload.disposition,
    payload.improvement ? 1 : 0,
    JSON.stringify(payload.reasons),
    JSON.stringify(payload.deltas),
    payload.baseline_digest,
    payload.candidate_digest,
    payload.candidate_snapshot_id,
    payload.patch_digest,
    payload.artifacts.contract.hash,
    payload.artifacts.candidate_run.hash,
    payload.artifacts.verdict.hash,
    greatBookState,
    greatBookEntryId,
  );
}

export const PROOF_BOARD_PROJECTION: ProjectionModule = {
  name: 'proof-board',
  install(db: Db): void {
    db.exec(PROOF_BOARD_SCHEMA_SQL);
  },
  tables: [
    'proof_board_benchmark_runs',
    'proof_board_contracts',
    'proof_board_baselines',
    'proof_board_refusals',
    'proof_board_verdicts',
  ],
  projectors: {
    [BENCHMARK_EVENT_TYPES.runRecorded]: projectBenchmarkRun,
    [PROOF_EVENT_TYPES.contractFrozen]: projectContractFrozen,
    [PROOF_EVENT_TYPES.baselineBound]: projectBaselineBound,
    [PROOF_EVENT_TYPES.executionRefused]: projectExecutionRefused,
    [PROOF_EVENT_TYPES.verdictRecorded]: projectProofVerdict,
  },
};

export interface RegisteredBenchmarkView {
  readonly state: 'registered' | 'unregistered' | 'invalid';
  readonly path: string | null;
  readonly sha256: Sha256 | null;
  readonly benchmarkId: string | null;
  readonly benchmarkVersion: string | null;
  readonly runnerAdapter: string | null;
  readonly harnessId: string | null;
  readonly integritySha256: Sha256 | null;
  readonly integrityVerified: boolean;
  readonly reason: string | null;
}

export interface BenchmarkRunView {
  readonly eventId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly missionVersion: string;
  readonly snapshotId: string | null;
  readonly registered: boolean;
  readonly benchmarkId: string;
  readonly benchmarkVersion: string;
  readonly blockId: string;
  readonly runnerAdapter: string;
  readonly contractSha256: Sha256;
  readonly integritySha256: Sha256;
  readonly resultArtifactHash: Sha256;
  readonly unifiedScore: number | null;
  readonly measuresCount: number;
  readonly incompleteCount: number;
  readonly protective: readonly { readonly id: string; readonly value: number | null }[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallMs: number;
  readonly budgetExhausted: boolean;
}

export interface ProofEventView {
  readonly eventId: string;
  readonly sequence: number;
  readonly recordedAt: string;
}

export interface ProofAttemptView {
  readonly cycleId: string;
  readonly missionVersion: string;
  readonly targetId: string;
  readonly contractHash: Sha256;
  readonly hypothesisId: string;
  readonly snapshotId: string;
  readonly contractArtifactHash: Sha256;
  readonly frozenAt: string;
  readonly contract: ProofEventView;
  readonly baseline: (ProofEventView & {
    readonly digest: Sha256;
    readonly sourceBenchmarkEventId: string | null;
    readonly runArtifactHash: Sha256 | null;
    readonly reused: boolean;
  }) | null;
  readonly refusal: (ProofEventView & {
    readonly stage: string;
    readonly reason: string;
    readonly evidenceCount: number;
  }) | null;
  readonly verdict: (ProofEventView & {
    readonly disposition: z.infer<typeof proofDispositionSchema>;
    readonly improvement: boolean;
    readonly reasons: readonly string[];
    readonly deltas: readonly z.infer<typeof proofDeltaSchema>[];
    readonly baselineDigest: Sha256;
    readonly candidateDigest: Sha256;
    readonly candidateSnapshotId: string;
    readonly patchDigest: Sha256;
    readonly verdictArtifactHash: Sha256;
    readonly greatBookState: 'recorded' | 'not_recorded' | 'legacy_unrecorded';
    readonly greatBookEntryId: string | null;
  }) | null;
  readonly state: 'frozen' | 'baseline_bound' | 'refused' | 'verdict_recorded';
}

export interface ProofBoardView {
  readonly schemaVersion: typeof PROOF_BOARD_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly targetId: string;
  readonly missionVersionId: string | null;
  readonly projection: {
    readonly schemaVersion: number;
    readonly lastSequence: number | null;
    readonly headHash: Sha256 | null;
  };
  readonly registeredBenchmark: RegisteredBenchmarkView;
  readonly summary: {
    readonly benchmarkRuns: number;
    readonly proofAttempts: number;
    readonly accepts: number;
    readonly rejects: number;
    readonly revises: number;
    readonly invalids: number;
    readonly refusals: number;
    readonly openAttempts: number;
    readonly latestBenchmarkEventId: string | null;
    readonly latestVerdictEventId: string | null;
  };
  readonly benchmarkRuns: readonly BenchmarkRunView[];
  readonly proofAttempts: readonly ProofAttemptView[];
}

function safeRelative(root: string, value: string): string | null {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(resolve(root), absolute);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
  return null;
}

export function describeRegisteredBenchmark(runtime: Runtime): RegisteredBenchmarkView {
  const configured = runtime.config.project.inputs.benchmark;
  if (configured === null) {
    return {
      state: 'unregistered',
      path: null,
      sha256: null,
      benchmarkId: null,
      benchmarkVersion: null,
      runnerAdapter: null,
      harnessId: null,
      integritySha256: null,
      integrityVerified: false,
      reason: 'project.inputs.benchmark is null',
    };
  }
  const absolute = isAbsolute(configured)
    ? configured
    : join(runtime.config.project.root, configured);
  const displayed = safeRelative(runtime.config.project.root, absolute) ?? '<external>';
  if (!existsSync(absolute)) {
    return {
      state: 'invalid',
      path: displayed,
      sha256: null,
      benchmarkId: null,
      benchmarkVersion: null,
      runnerAdapter: null,
      harnessId: null,
      integritySha256: null,
      integrityVerified: false,
      reason: 'registered benchmark file does not exist',
    };
  }
  try {
    const bytes = readFileSync(absolute);
    const text = bytes.toString('utf8');
    const parsed = readBenchmarkContract(text);
    if ('error' in parsed) throw new Error(parsed.error);
    const adapter = parsed.identity.runner_adapter ?? 'cli-node';
    const block = selectHarnessBlock(parsed, adapter);
    if ('error' in block) throw new Error(block.error);
    const integrity = verifyHarnessIntegrity(block);
    return {
      state: integrity.ok ? 'registered' : 'invalid',
      path: displayed,
      sha256: hashBytes(bytes),
      benchmarkId: parsed.identity.benchmark_id,
      benchmarkVersion: parsed.identity.benchmark_version,
      runnerAdapter: adapter,
      harnessId: block.id,
      integritySha256: block.integrity.state === 'declared' ? block.integrity.sha256 : null,
      integrityVerified: integrity.ok,
      reason: integrity.ok ? null : integrity.reason,
    };
  } catch (error) {
    return {
      state: 'invalid',
      path: displayed,
      sha256: hashBytes(readFileSync(absolute)),
      benchmarkId: null,
      benchmarkVersion: null,
      runnerAdapter: null,
      harnessId: null,
      integritySha256: null,
      integrityVerified: false,
      reason: (error as Error).message,
    };
  }
}

function jsonArray<T>(raw: unknown, schema: z.ZodType<T>, label: string): T {
  if (typeof raw !== 'string') throw new Error(`${label} is not JSON text.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${(error as Error).message}`);
  }
  return schema.parse(parsed);
}

function eventView(row: { eventId: string; sequence: number; recordedAt: string }): ProofEventView {
  return { eventId: row.eventId, sequence: row.sequence, recordedAt: row.recordedAt };
}

function databaseBoolean(value: number, label: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`${label} must be stored as 0 or 1, received ${String(value)}.`);
  }
  return value === 1;
}

export function readProofBoard(runtime: Runtime, generatedAt: string, cycleId?: string): ProofBoardView {
  const projections = runtime.projections;
  const db = projections.db;
  const targetId = runtime.config.project.id;

  const benchmarkRows = db
    .prepare(
      `SELECT event_id AS eventId, sequence, recorded_at AS recordedAt,
              mission_version AS missionVersion, snapshot_id AS snapshotId,
              registered, benchmark_id AS benchmarkId, benchmark_version AS benchmarkVersion,
              block_id AS blockId, runner_adapter AS runnerAdapter,
              contract_sha256 AS contractSha256, integrity_sha256 AS integritySha256,
              result_artifact_hash AS resultArtifactHash, unified_score AS unifiedScore,
              measures_count AS measuresCount, incomplete_count AS incompleteCount,
              protective_json AS protectiveJson, started_at AS startedAt,
              finished_at AS finishedAt, wall_ms AS wallMs, budget_exhausted AS budgetExhausted
         FROM proof_board_benchmark_runs
        ORDER BY sequence DESC LIMIT ?`,
    )
    .all(BOARD_LIMIT) as Array<Record<string, unknown>>;

  const benchmarkRuns: BenchmarkRunView[] = benchmarkRows.map((row, index) => {
    const parsed = z
      .object({
        eventId: z.string().min(1),
        sequence: z.number().int().nonnegative(),
        recordedAt: z.string().min(1),
        missionVersion: z.string().min(1),
        snapshotId: z.string().min(1).nullable(),
        registered: z.number().int(),
        benchmarkId: z.string().min(1),
        benchmarkVersion: z.string().min(1),
        blockId: z.string().min(1),
        runnerAdapter: z.string().min(1),
        contractSha256: sha256Schema,
        integritySha256: sha256Schema,
        resultArtifactHash: sha256Schema,
        unifiedScore: z.number().finite().nullable(),
        measuresCount: z.number().int().nonnegative(),
        incompleteCount: z.number().int().nonnegative(),
        protectiveJson: z.string(),
        startedAt: z.string().min(1),
        finishedAt: z.string().min(1),
        wallMs: z.number().int().nonnegative(),
        budgetExhausted: z.number().int(),
      })
      .strict()
      .parse(row);
    return {
      eventId: parsed.eventId,
      sequence: parsed.sequence,
      recordedAt: parsed.recordedAt,
      missionVersion: parsed.missionVersion,
      snapshotId: parsed.snapshotId,
      registered: databaseBoolean(parsed.registered, `benchmark row ${index + 1} registered`),
      benchmarkId: parsed.benchmarkId,
      benchmarkVersion: parsed.benchmarkVersion,
      blockId: parsed.blockId,
      runnerAdapter: parsed.runnerAdapter,
      contractSha256: requireSha256(parsed.contractSha256, `benchmark row ${index + 1} contractSha256`),
      integritySha256: requireSha256(parsed.integritySha256, `benchmark row ${index + 1} integritySha256`),
      resultArtifactHash: requireSha256(parsed.resultArtifactHash, `benchmark row ${index + 1} resultArtifactHash`),
      unifiedScore: parsed.unifiedScore,
      measuresCount: parsed.measuresCount,
      incompleteCount: parsed.incompleteCount,
      protective: jsonArray(parsed.protectiveJson, z.array(benchmarkProtectiveSchema), `benchmark row ${index + 1} protective`),
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt,
      wallMs: parsed.wallMs,
      budgetExhausted: databaseBoolean(parsed.budgetExhausted, `benchmark row ${index + 1} budgetExhausted`),
    };
  });

  const contracts = db
    .prepare(
      `SELECT event_id AS eventId, sequence, recorded_at AS recordedAt,
              mission_version AS missionVersion, target_id AS targetId,
              cycle_id AS cycleId, contract_hash AS contractHash,
              hypothesis_id AS hypothesisId, snapshot_id AS snapshotId,
              contract_artifact_hash AS contractArtifactHash, frozen_at AS frozenAt
         FROM proof_board_contracts
        WHERE target_id = ? AND (? IS NULL OR cycle_id = ?)
        ORDER BY sequence DESC LIMIT ?`,
    )
    .all(targetId, cycleId ?? null, cycleId ?? null, cycleId === undefined ? BOARD_LIMIT : -1) as Array<Record<string, unknown>>;
  const baselines = db
    .prepare(
      `SELECT event_id AS eventId, sequence, recorded_at AS recordedAt,
              mission_version AS missionVersion, cycle_id AS cycleId,
              contract_hash AS contractHash, baseline_digest AS baselineDigest,
              source_event_id AS sourceEventId, run_artifact_hash AS runArtifactHash,
              reused
         FROM proof_board_baselines
        WHERE ? IS NULL OR cycle_id = ?
        ORDER BY sequence ASC`,
    )
    .all(cycleId ?? null, cycleId ?? null) as Array<Record<string, unknown>>;
  const refusals = db
    .prepare(
      `SELECT event_id AS eventId, sequence, recorded_at AS recordedAt,
              mission_version AS missionVersion, cycle_id AS cycleId,
              contract_hash AS contractHash, stage, reason, evidence_json AS evidenceJson
         FROM proof_board_refusals
        WHERE ? IS NULL OR cycle_id = ?
        ORDER BY sequence ASC`,
    )
    .all(cycleId ?? null, cycleId ?? null) as Array<Record<string, unknown>>;
  const verdicts = db
    .prepare(
      `SELECT event_id AS eventId, sequence, recorded_at AS recordedAt,
              mission_version AS missionVersion, target_id AS targetId,
              cycle_id AS cycleId, contract_hash AS contractHash,
              hypothesis_id AS hypothesisId, disposition, improvement,
              reasons_json AS reasonsJson, deltas_json AS deltasJson,
              baseline_digest AS baselineDigest, candidate_digest AS candidateDigest,
              candidate_snapshot_id AS candidateSnapshotId, patch_digest AS patchDigest,
              verdict_artifact_hash AS verdictArtifactHash,
              great_book_state AS greatBookState, great_book_entry_id AS greatBookEntryId
         FROM proof_board_verdicts
        WHERE target_id = ? AND (? IS NULL OR cycle_id = ?)
        ORDER BY sequence ASC`,
    )
    .all(targetId, cycleId ?? null, cycleId ?? null) as Array<Record<string, unknown>>;

  const contractSchema = z
    .object({
      eventId: z.string().min(1), sequence: z.number().int().nonnegative(), recordedAt: z.string().min(1),
      missionVersion: z.string().min(1), targetId: z.string().min(1), cycleId: z.string().min(1),
      contractHash: sha256Schema, hypothesisId: z.string().min(1), snapshotId: z.string().min(1),
      contractArtifactHash: sha256Schema, frozenAt: z.string().min(1),
    })
    .strict();
  const baselineSchema = z
    .object({
      eventId: z.string().min(1), sequence: z.number().int().nonnegative(), recordedAt: z.string().min(1),
      missionVersion: z.string().min(1), cycleId: z.string().min(1), contractHash: sha256Schema,
      baselineDigest: sha256Schema, sourceEventId: z.string().min(1).nullable(),
      runArtifactHash: sha256Schema.nullable(), reused: z.number().int(),
    })
    .strict();
  const refusalSchema = z
    .object({
      eventId: z.string().min(1), sequence: z.number().int().nonnegative(), recordedAt: z.string().min(1),
      missionVersion: z.string().min(1), cycleId: z.string().min(1), contractHash: sha256Schema,
      stage: z.string().min(1), reason: z.string().min(1), evidenceJson: z.string(),
    })
    .strict();
  const verdictSchema = z
    .object({
      eventId: z.string().min(1), sequence: z.number().int().nonnegative(), recordedAt: z.string().min(1),
      missionVersion: z.string().min(1), targetId: z.string().min(1), cycleId: z.string().min(1),
      contractHash: sha256Schema, hypothesisId: z.string().min(1), disposition: proofDispositionSchema,
      improvement: z.number().int(), reasonsJson: z.string(), deltasJson: z.string(),
      baselineDigest: sha256Schema, candidateDigest: sha256Schema,
      candidateSnapshotId: z.string().min(1), patchDigest: sha256Schema,
      verdictArtifactHash: sha256Schema,
      greatBookState: z.enum(['recorded', 'not_recorded', 'legacy_unrecorded']),
      greatBookEntryId: z.string().min(1).nullable(),
    })
    .strict();

  const baselineValues = baselines.map((row) => baselineSchema.parse(row));
  const refusalValues = refusals.map((row) => refusalSchema.parse(row));
  const verdictValues = verdicts.map((row) => verdictSchema.parse(row));
  const contractValues = contracts.map((row) => contractSchema.parse(row));

  // Contracts arrive in descending sequence, so the prior row for a cycle bounds this attempt.
  const nextSequenceByCycle = new Map<string, number>();
  const proofAttempts: ProofAttemptView[] = contractValues.map((contract, index) => {
    const nextBoundary = nextSequenceByCycle.get(contract.cycleId);
    nextSequenceByCycle.set(contract.cycleId, contract.sequence);
    const inAttempt = <T extends { cycleId: string; contractHash: string; sequence: number }>(row: T): boolean =>
      row.cycleId === contract.cycleId &&
      row.contractHash === contract.contractHash &&
      row.sequence > contract.sequence &&
      (nextBoundary === undefined || row.sequence < nextBoundary);
    const attemptBaselines = baselineValues.filter(inAttempt);
    const attemptRefusals = refusalValues.filter(inAttempt);
    const attemptVerdicts = verdictValues.filter(inAttempt);
    if (attemptBaselines.length > 1) {
      throw new Error(`Proof attempt ${contract.eventId} has more than one baseline binding.`);
    }
    if (attemptRefusals.length > 1 || attemptVerdicts.length > 1) {
      throw new Error(`Proof attempt ${contract.eventId} has more than one terminal event of one kind.`);
    }
    const baselineRow = attemptBaselines[0] ?? null;
    const refusalRow = attemptRefusals[0] ?? null;
    const verdictRow = attemptVerdicts[0] ?? null;
    if (refusalRow !== null && verdictRow !== null) {
      throw new Error(`Proof attempt ${contract.eventId} has both refusal and verdict.`);
    }
    if ((refusalRow !== null || verdictRow !== null) && baselineRow === null) {
      throw new Error(`Proof attempt ${contract.eventId} reached a terminal event without baseline.`);
    }
    const terminalRow = refusalRow ?? verdictRow;
    if (baselineRow !== null && terminalRow !== null && baselineRow.sequence >= terminalRow.sequence) {
      throw new Error(`Proof attempt ${contract.eventId} records its baseline after its terminal event.`);
    }
    for (const row of [baselineRow, refusalRow, verdictRow]) {
      if (row !== null && row.missionVersion !== contract.missionVersion) {
        throw new Error(`Proof attempt ${contract.eventId} crosses mission authority.`);
      }
    }
    if (verdictRow !== null && verdictRow.hypothesisId !== contract.hypothesisId) {
      throw new Error(`Proof attempt ${contract.eventId} verdict names a different hypothesis.`);
    }
    if (baselineRow !== null && verdictRow !== null && baselineRow.baselineDigest !== verdictRow.baselineDigest) {
      throw new Error(`Proof attempt ${contract.eventId} verdict does not bind the recorded baseline.`);
    }
    const baseline = baselineRow === null ? null : {
      ...eventView(baselineRow),
      digest: requireSha256(baselineRow.baselineDigest, `proof attempt ${contract.eventId} baselineDigest`),
      sourceBenchmarkEventId: baselineRow.sourceEventId,
      runArtifactHash: baselineRow.runArtifactHash === null ? null : requireSha256(baselineRow.runArtifactHash, `proof attempt ${contract.eventId} runArtifactHash`),
      reused: databaseBoolean(baselineRow.reused, `proof attempt ${contract.eventId} baseline reused`),
    };
    const refusal = refusalRow === null ? null : {
      ...eventView(refusalRow),
      stage: refusalRow.stage,
      reason: refusalRow.reason,
      evidenceCount: jsonArray(refusalRow.evidenceJson, z.array(z.unknown()), `refusal row ${index + 1} evidence`).length,
    };
    const verdict = verdictRow === null ? null : {
      ...eventView(verdictRow),
      disposition: verdictRow.disposition,
      improvement: databaseBoolean(verdictRow.improvement, `proof attempt ${contract.eventId} improvement`),
      reasons: jsonArray(verdictRow.reasonsJson, z.array(z.string()), `verdict row ${index + 1} reasons`),
      deltas: jsonArray(verdictRow.deltasJson, z.array(proofDeltaSchema), `verdict row ${index + 1} deltas`),
      baselineDigest: requireSha256(verdictRow.baselineDigest, `proof attempt ${contract.eventId} verdict baselineDigest`),
      candidateDigest: requireSha256(verdictRow.candidateDigest, `proof attempt ${contract.eventId} candidateDigest`),
      candidateSnapshotId: verdictRow.candidateSnapshotId,
      patchDigest: requireSha256(verdictRow.patchDigest, `proof attempt ${contract.eventId} patchDigest`),
      verdictArtifactHash: requireSha256(verdictRow.verdictArtifactHash, `proof attempt ${contract.eventId} verdictArtifactHash`),
      greatBookState: verdictRow.greatBookState,
      greatBookEntryId: verdictRow.greatBookEntryId,
    };
    return {
      cycleId: contract.cycleId,
      missionVersion: contract.missionVersion,
      targetId: contract.targetId,
      contractHash: requireSha256(contract.contractHash, `proof contract ${contract.eventId} contractHash`),
      hypothesisId: contract.hypothesisId,
      snapshotId: contract.snapshotId,
      contractArtifactHash: requireSha256(contract.contractArtifactHash, `proof contract ${contract.eventId} artifactHash`),
      frozenAt: contract.frozenAt,
      contract: eventView(contract),
      baseline,
      refusal,
      verdict,
      state: verdict !== null ? 'verdict_recorded' : refusal !== null ? 'refused' : baseline !== null ? 'baseline_bound' : 'frozen',
    };
  });

  const dispositions = proofAttempts.map((attempt) => attempt.verdict?.disposition ?? null);
  const projection = projections.status();
  return {
    schemaVersion: PROOF_BOARD_SCHEMA_VERSION,
    generatedAt,
    targetId,
    missionVersionId: runtime.mission?.current()?.id ?? null,
    projection: {
      schemaVersion: projection.schemaVersion,
      lastSequence: projection.lastSequence,
      headHash: projection.headHash,
    },
    registeredBenchmark: describeRegisteredBenchmark(runtime),
    summary: {
      benchmarkRuns: benchmarkRuns.length,
      proofAttempts: proofAttempts.length,
      accepts: dispositions.filter((value) => value === 'ACCEPT').length,
      rejects: dispositions.filter((value) => value === 'REJECT').length,
      revises: dispositions.filter((value) => value === 'REVISE').length,
      invalids: dispositions.filter((value) => value === 'INVALID').length,
      refusals: proofAttempts.filter((attempt) => attempt.refusal !== null).length,
      openAttempts: proofAttempts.filter((attempt) => attempt.refusal === null && attempt.verdict === null).length,
      latestBenchmarkEventId: benchmarkRuns[0]?.eventId ?? null,
      latestVerdictEventId: proofAttempts.find((attempt) => attempt.verdict !== null)?.verdict?.eventId ?? null,
    },
    benchmarkRuns,
    proofAttempts,
  };
}
