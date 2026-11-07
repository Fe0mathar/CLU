/**
 * Event-first Great Book projection — P2-12.
 *
 * Authority is the `great_book` recording embedded in `proof.verdict_recorded`; SQLite is
 * only a rebuildable read model. A read-only dashboard never opens the writer log, so the
 * complete entry JSON is projected here and can be replayed exactly after deleting the DB.
 *
 * An ACCEPT verdict that explicitly says it was not recorded is not silently discarded.
 * Its reason is projected as a gap, allowing Status and closure evidence to distinguish
 * “no accepted proof yet” from “an accepted proof exists without recursive memory”. The
 * production candidate arm introduced by P2-12 always supplies generic MI05/MJ06 mappings,
 * so a new ordinary ACCEPT is expected to create an entry and the gap count should stay 0.
 */

import type Database from 'better-sqlite3';

import type { GreatBookContributionInput } from '../analysis/metrics/improvementField/types.js';
import type { ProjectionModule, ProjectionStore } from '../memory/db.js';
import { PROOF_EVENT_TYPES } from '../proof/proofContract.js';
import { canonicalJson } from '../shared/ids.js';
import { projectGovernanceBasisSchema } from '../shared/projectGovernanceBasis.js';
import type { EventRecord } from '../shared/schemas.js';
import {
  GREAT_BOOK_NORMALIZATION_HASH,
  GREAT_BOOK_NORMALIZATION_VERSION,
  greatBookEntrySchema,
  greatBookRecordingSchema,
  type GreatBookEntry,
} from './greatBookEntry.js';

type Db = Database.Database;

export const GREAT_BOOK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS great_book_entries (
  entry_id          TEXT PRIMARY KEY,
  entry_hash        TEXT NOT NULL UNIQUE,
  source_event_id   TEXT NOT NULL UNIQUE,
  mission_version   TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  cycle_id          TEXT NOT NULL,
  contract_hash     TEXT NOT NULL,
  candidate_digest  TEXT NOT NULL,
  patch_digest      TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  entry_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS great_book_entries_target
  ON great_book_entries(target_id, recorded_at);
CREATE INDEX IF NOT EXISTS great_book_entries_cycle
  ON great_book_entries(cycle_id, recorded_at);
CREATE INDEX IF NOT EXISTS great_book_entries_contract
  ON great_book_entries(contract_hash);

CREATE TABLE IF NOT EXISTS great_book_recording_gaps (
  source_event_id   TEXT PRIMARY KEY,
  mission_version   TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  cycle_id          TEXT NOT NULL,
  contract_hash     TEXT NOT NULL,
  reason            TEXT NOT NULL,
  recorded_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS great_book_recording_gaps_target
  ON great_book_recording_gaps(target_id, recorded_at);
CREATE INDEX IF NOT EXISTS great_book_recording_gaps_cycle
  ON great_book_recording_gaps(cycle_id, recorded_at);
`;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(payload: Record<string, unknown>, field: string, eventId: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${eventId} proof verdict has no valid ${field}.`);
  }
  return value;
}

function assertPayloadProjectTarget(
  payload: Record<string, unknown>,
  targetId: string,
  eventId: string,
): void {
  if (payload['project_basis'] === undefined) return;
  const basis = projectGovernanceBasisSchema.parse(payload['project_basis']);
  if (basis.operationIdentity.projectId !== targetId) {
    throw new Error(
      `${eventId} target_id ${targetId} does not match Project Profile ${basis.operationIdentity.projectId}.`,
    );
  }
}

function projectGap(
  db: Db,
  record: EventRecord,
  payload: Record<string, unknown>,
  reason: string,
): void {
  // Only a verdict that actually established improvement is owed a Great Book entry.
  // REJECT/REVISE/INVALID are legitimate proof outcomes, not recursive-memory gaps.
  if (payload['disposition'] !== 'ACCEPT' || payload['improvement'] !== true) return;

  const cycleId = requiredString(payload, 'cycle_id', record.id);
  const targetId = requiredString(payload, 'target_id', record.id);
  assertPayloadProjectTarget(payload, targetId, record.id);
  const contractHash = requiredString(payload, 'contract_hash', record.id);
  if (record.subject_id !== cycleId) {
    throw new Error(
      `${record.id} Great Book gap cycle ${cycleId} does not match event subject ${record.subject_id ?? 'null'}.`,
    );
  }

  db.prepare(
    `INSERT INTO great_book_recording_gaps (
       source_event_id, mission_version, target_id, cycle_id,
       contract_hash, reason, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.mission_version,
    targetId,
    cycleId,
    contractHash,
    reason,
    record.timestamp,
  );
}

function projectVerdict(db: Db, record: EventRecord): void {
  const payload = asObject(record.payload);
  if (payload === null || !Object.prototype.hasOwnProperty.call(payload, 'great_book')) {
    // Pre-P2-12 verdict events remain readable proof history; they never claimed a Great Book consequence.
    return;
  }
  const recording = greatBookRecordingSchema.parse(payload['great_book']);
  if (recording.state === 'not_recorded') {
    projectGap(db, record, payload, recording.reason);
    return;
  }
  const entry = recording.entry;
  assertPayloadProjectTarget(payload, entry.target_id, record.id);

  if (record.subject_id !== entry.cycle_id) {
    throw new Error(
      `${record.id} Great Book cycle ${entry.cycle_id} does not match event subject ${record.subject_id ?? 'null'}.`,
    );
  }
  if (record.mission_version !== entry.mission_version) {
    throw new Error(
      `${record.id} Great Book mission ${entry.mission_version} does not match event mission ${record.mission_version}.`,
    );
  }
  if (
    canonicalJson(payload['project_basis'] ?? null) !==
    canonicalJson(entry.project_basis ?? null)
  ) {
    throw new Error(`${record.id} Great Book project_basis does not match the enclosing proof verdict payload.`);
  }
  const requiredParity: readonly [string, unknown][] = [
    ['target_id', entry.target_id],
    ['cycle_id', entry.cycle_id],
    ['disposition', entry.disposition],
    ['improvement', entry.improvement],
    ['contract_hash', entry.contract_hash],
    ['baseline_digest', entry.baseline_digest],
    ['candidate_digest', entry.candidate_digest],
    ['patch_digest', entry.patch_digest],
  ];
  for (const [field, expected] of requiredParity) {
    if (payload[field] !== expected) {
      throw new Error(
        `${record.id} Great Book ${field} does not match the enclosing proof verdict payload.`,
      );
    }
  }

  db.prepare(
    `INSERT INTO great_book_entries (
       entry_id, entry_hash, source_event_id, mission_version, target_id, cycle_id,
       contract_hash, candidate_digest, patch_digest, recorded_at, entry_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.entry_id,
    entry.entry_hash,
    record.id,
    entry.mission_version,
    entry.target_id,
    entry.cycle_id,
    entry.contract_hash,
    entry.candidate_digest,
    entry.patch_digest,
    entry.recorded_at,
    canonicalJson(entry),
  );
}

export const GREAT_BOOK_PROJECTION: ProjectionModule = {
  name: 'great-book',
  install(db: Db): void {
    db.exec(GREAT_BOOK_SCHEMA_SQL);
  },
  tables: ['great_book_entries', 'great_book_recording_gaps'],
  projectors: {
    [PROOF_EVENT_TYPES.verdictRecorded]: projectVerdict,
  },
};

function parseRow(row: { entryJson?: unknown }, label: string): GreatBookEntry {
  if (typeof row.entryJson !== 'string') throw new Error(`${label} has no entry_json.`);
  let value: unknown;
  try {
    value = JSON.parse(row.entryJson);
  } catch (error) {
    throw new Error(`${label} entry_json is not JSON: ${(error as Error).message}`);
  }
  return greatBookEntrySchema.parse(value);
}

export function readGreatBookEntries(
  projections: ProjectionStore,
  targetId: string,
): readonly GreatBookEntry[] {
  const rows = projections.db
    .prepare(
      `SELECT entry_json AS entryJson
         FROM great_book_entries
        WHERE target_id = ?
        ORDER BY recorded_at ASC, entry_id ASC`,
    )
    .all(targetId) as { entryJson?: unknown }[];
  return rows.map((row, index) => parseRow(row, `Great Book row ${index + 1}`));
}

export interface GreatBookFacts {
  readonly entryCount: number;
  readonly contributionCount: number;
  /** ACCEPT verdicts that explicitly could not become a canonical Great Book entry. */
  readonly recordingGapCount: number;
  readonly latestEntry: {
    readonly entryId: string;
    readonly sourceEventId: string;
    readonly cycleId: string;
    readonly contractHash: string;
    readonly recordedAt: string;
  } | null;
  readonly normalizationVersion: typeof GREAT_BOOK_NORMALIZATION_VERSION;
  readonly normalizationHash: typeof GREAT_BOOK_NORMALIZATION_HASH;
}

export function readGreatBookFacts(
  projections: ProjectionStore,
  targetId: string,
): GreatBookFacts {
  const entries = readGreatBookEntries(projections, targetId);
  const latestRow = projections.db
    .prepare(
      `SELECT entry_id AS entryId, source_event_id AS sourceEventId, cycle_id AS cycleId,
              contract_hash AS contractHash, recorded_at AS recordedAt
         FROM great_book_entries
        WHERE target_id = ?
        ORDER BY recorded_at DESC, entry_id DESC LIMIT 1`,
    )
    .get(targetId) as
    | {
        entryId?: unknown;
        sourceEventId?: unknown;
        cycleId?: unknown;
        contractHash?: unknown;
        recordedAt?: unknown;
      }
    | undefined;
  const latestEntry =
    latestRow === undefined
      ? null
      : (() => {
          if (
            typeof latestRow.entryId !== 'string' ||
            typeof latestRow.sourceEventId !== 'string' ||
            typeof latestRow.cycleId !== 'string' ||
            typeof latestRow.contractHash !== 'string' ||
            typeof latestRow.recordedAt !== 'string'
          ) {
            throw new Error('Malformed latest Great Book projection row.');
          }
          return {
            entryId: latestRow.entryId,
            sourceEventId: latestRow.sourceEventId,
            cycleId: latestRow.cycleId,
            contractHash: latestRow.contractHash,
            recordedAt: latestRow.recordedAt,
          };
        })();
  const gapRow = projections.db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM great_book_recording_gaps
        WHERE target_id = ?`,
    )
    .get(targetId) as { count?: unknown } | undefined;
  if (gapRow === undefined || typeof gapRow.count !== 'number') {
    throw new Error('Malformed Great Book recording-gap count.');
  }
  return {
    entryCount: entries.length,
    contributionCount: entries.reduce((sum, entry) => sum + entry.contributions.length, 0),
    recordingGapCount: gapRow.count,
    latestEntry,
    normalizationVersion: GREAT_BOOK_NORMALIZATION_VERSION,
    normalizationHash: GREAT_BOOK_NORMALIZATION_HASH,
  };
}

export function readGreatBookContributions(
  projections: ProjectionStore,
  targetId: string,
): readonly GreatBookContributionInput[] {
  return readGreatBookEntries(projections, targetId).flatMap((entry) =>
    entry.contributions.map((contribution) => ({
      contributionId: contribution.contribution_id,
      greatBookEntryId: entry.entry_id,
      measurementId: contribution.measurement_id,
      scopeId: contribution.scope_id,
      cycleId: entry.cycle_id,
      family: contribution.family,
      native: {
        baseline: contribution.native.baseline,
        result: contribution.native.result,
        delta: contribution.native.delta,
        unit: contribution.native.unit,
        display: contribution.native.display,
      },
      normalizedContribution: contribution.normalized_contribution,
      confidence: contribution.confidence,
      freshness: contribution.freshness,
      coverage: contribution.coverage,
      certified: contribution.certified,
      invalidated: contribution.invalidated,
      verdict: entry.disposition,
      proofContractId: entry.contract_hash,
      benchmarkRunId: entry.benchmark_run_id,
      recordedAt: entry.recorded_at,
    })),
  );
}
