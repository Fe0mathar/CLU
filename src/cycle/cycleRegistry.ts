/**
 * Cycle registry — the durable stage machine (DEV-P2-08 S2).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §1 (a mission's cycles are serial campaigns), §21
 *       (suspend/resume without losing authority), §24 (completion recorded, met or
 *       honestly unmet); `CLUE_Project_Directory_v9.md` §18.2 ("the cycle modules own the
 *       durable stage machine"); `docs/cycle-implementation-plan_v1.md` §4 (the machine),
 *       accepted 2026-08-10 with D1–D5.
 *
 * ## What this module is
 *
 * The record of truth for cycles: it mints `CYCLE-######` ids, owns the `cycle.*` event
 * namespace (D5), holds the **one legality table** every arrow must pass, and projects the
 * events into a rebuildable `cycles` table. It contains no phase logic whatsoever — what
 * happens *inside* a stage belongs to the domain services the orchestrator invokes (S4);
 * this module only ever answers "where is the cycle, and is that move legal".
 *
 * ## The arrows, and who carries them
 *
 * Not every transition is a `stage_advanced` event — the special moves ride their own
 * types because their payloads carry different obligations:
 *
 *   OPENED           → INPUTS_LOCKED      `cycle.inputs_locked`  (carries the lock itself)
 *   INPUTS_LOCKED    → OPENING_EVIDENCE   `cycle.stage_advanced`
 *   OPENING_EVIDENCE → RECOGNIZED         `cycle.stage_advanced`
 *   RECOGNIZED       → SCREENED           `cycle.stage_advanced`
 *   SCREENED         → CANDIDATES         `cycle.stage_advanced`
 *   SCREENED         → CLOSING_EVIDENCE   `cycle.stage_advanced`  (the diagnostic path, D3:
 *                                          a cycle with no candidate loop closes honestly)
 *   CANDIDATES       → CLOSING_EVIDENCE   `cycle.stage_advanced`
 *   CLOSING_EVIDENCE → HANDOFF            `cycle.stage_advanced`
 *   HANDOFF          → CLOSED             `cycle.closed`          (carries §24, met or unmet)
 *   any live stage   → SUSPENDED          `cycle.suspended`       (remembers where it was)
 *   SUSPENDED        → suspended_from     `cycle.resumed`
 *   SCREENED        → new OPENED cycle   `cycle.restarted`       (preserves predecessor)
 *
 * Legality is enforced at write time; the projector replays trustingly, because an event
 * that reached the log passed the gate when it was written and the log is the truth.
 *
 * ## Serial by design
 *
 * Execution Model §1 makes cycles sequential: each accepted state is the next cycle's
 * baseline. `open()` therefore refuses while a cycle is active, even if suspended.
 * A restart replaces the active slot with a new cycle and keeps the predecessor's
 * stage and evidence intact. Two concurrent cycles would mean two competing baselines.
 */

import {
  cycleClosedSchema,
  cycleInputLockSchema,
  cycleInputsLockedSchema,
  cycleOpenedSchema,
  cycleRecordSchema,
  cycleRestartedSchema,
  cycleResumedSchema,
  cycleStageAdvancedSchema,
  cycleSuspendedSchema,
  parseOrThrow,
  type ArtifactRef,
  type Actor,
  type CycleInputLock,
  type CycleOpened,
  type CycleRecord,
  type CycleStage,
  type CycleClosed,
} from '../shared/schemas.js';
import { makeEntityId, nowIso, type Sha256 } from '../shared/ids.js';
import type { EventLog } from '../memory/eventLog.js';
import type Database from 'better-sqlite3';
import type { ProjectionModule, ProjectionStore } from '../memory/db.js';

type Db = Database.Database;
import type { EventRecord } from '../shared/schemas.js';

/* ------------------------------------------------------------------------- */
/* Events and errors                                                          */
/* ------------------------------------------------------------------------- */

/** The cycle domain's event namespace (plan D5), mirroring `authority.*`. */
export const CYCLE_EVENT_TYPES = {
  opened: 'cycle.opened',
  restarted: 'cycle.restarted',
  inputsLocked: 'cycle.inputs_locked',
  stageAdvanced: 'cycle.stage_advanced',
  suspended: 'cycle.suspended',
  resumed: 'cycle.resumed',
  closed: 'cycle.closed',
} as const;

/** An illegal move against the stage machine, refused with the whole story. */
export class CycleTransitionError extends Error {
  public readonly cycleId: string;
  public readonly from: CycleStage | null;
  public readonly to: CycleStage | null;

  public constructor(
    cycleId: string,
    from: CycleStage | null,
    to: CycleStage | null,
    reason: string,
  ) {
    super(`Cycle ${cycleId}: ${from ?? '(none)'} → ${to ?? '(none)'} refused — ${reason}`);
    this.name = 'CycleTransitionError';
    this.cycleId = cycleId;
    this.from = from;
    this.to = to;
  }
}

/* ------------------------------------------------------------------------- */
/* The one legality table                                                     */
/* ------------------------------------------------------------------------- */

/** Arrows carried by `cycle.stage_advanced`. The special moves have their own gates. */
const LEGAL_ADVANCES: ReadonlyMap<CycleStage, readonly CycleStage[]> = new Map([
  ['INPUTS_LOCKED', ['OPENING_EVIDENCE']],
  ['OPENING_EVIDENCE', ['RECOGNIZED']],
  ['RECOGNIZED', ['SCREENED']],
  ['SCREENED', ['CANDIDATES', 'CLOSING_EVIDENCE']],
  ['CANDIDATES', ['CLOSING_EVIDENCE']],
  ['CLOSING_EVIDENCE', ['HANDOFF']],
]);

/** Stages a cycle can be suspended from: anything live — not CLOSED, not already SUSPENDED. */
const SUSPENDABLE: ReadonlySet<CycleStage> = new Set([
  'OPENED',
  'INPUTS_LOCKED',
  'OPENING_EVIDENCE',
  'RECOGNIZED',
  'SCREENED',
  'CANDIDATES',
  'CLOSING_EVIDENCE',
  'HANDOFF',
]);

/* ------------------------------------------------------------------------- */
/* Projection                                                                 */
/* ------------------------------------------------------------------------- */

export const CYCLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cycles (
  id              TEXT PRIMARY KEY,
  mission_version TEXT NOT NULL,
  stage           TEXT NOT NULL,
  suspended_from  TEXT,
  grade           TEXT,
  lock_digest     TEXT,
  opened_at       TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  closed_at       TEXT,
  -- ADR-0007: the closure's §24 verdict, projected so log-free readers (Status opens with
  -- withLog: false) report it instead of silently reporting "no closure". The reasons stay
  -- in the closure event and the §19 handoff; the row carries the verdict and its weight.
  criteria_met    INTEGER,
  unmet_count     INTEGER
);
CREATE TABLE IF NOT EXISTS cycle_restarts (
  previous_cycle_id TEXT PRIMARY KEY,
  successor_cycle_id TEXT NOT NULL UNIQUE
);
`;

function projectOpenedCycle(db: Db, payload: CycleOpened): void {
  db.prepare(
    `INSERT INTO cycles (id, mission_version, stage, suspended_from, grade, lock_digest,
                         opened_at, updated_at, closed_at)
     VALUES (?, ?, 'OPENED', NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(payload.cycle_id, payload.mission_version, payload.opened_at, payload.opened_at);
}

/**
 * The cycle projection module. Registered into the `ProjectionStore` at construction, so a
 * full rebuild clears and replays `cycles` like every other derived table — the events are
 * the truth, the rows are a convenience.
 */
export const CYCLE_PROJECTION: ProjectionModule = {
  name: 'cycle',
  install(db: Db): void {
    db.exec(CYCLE_SCHEMA_SQL);
  },
  tables: ['cycles', 'cycle_restarts'],
  projectors: {
    [CYCLE_EVENT_TYPES.opened]: (db: Db, record: EventRecord): void => {
      const payload = parseOrThrow(cycleOpenedSchema, record.payload, `${record.id} cycle.opened`);
      projectOpenedCycle(db, payload);
    },
    [CYCLE_EVENT_TYPES.restarted]: (db: Db, record: EventRecord): void => {
      const payload = parseOrThrow(cycleRestartedSchema, record.payload, `${record.id} cycle.restarted`);
      const previous = db.prepare(
        `SELECT id FROM cycles
         WHERE id = ? AND mission_version = ? AND lock_digest = ?
           AND stage = 'SCREENED' AND grade = 'diagnostic'`,
      ).get(payload.previous_cycle_id, payload.previous_mission_version, payload.previous_lock_digest);
      if (previous === undefined || record.subject_id !== payload.successor.cycle_id ||
          record.mission_version !== payload.successor.mission_version ||
          record.actor !== 'cli' || payload.successor.opened_by !== 'cli') {
        throw new Error(`${record.id} cycle.restarted disagrees with its predecessor or event identity.`);
      }
      db.prepare(
        'INSERT INTO cycle_restarts (previous_cycle_id, successor_cycle_id) VALUES (?, ?)',
      ).run(payload.previous_cycle_id, payload.successor.cycle_id);
      projectOpenedCycle(db, payload.successor);
    },
    [CYCLE_EVENT_TYPES.inputsLocked]: (db: Db, record: EventRecord): void => {
      const payload = parseOrThrow(
        cycleInputsLockedSchema,
        record.payload,
        `${record.id} cycle.inputs_locked`,
      );
      db.prepare(
        `UPDATE cycles SET stage = 'INPUTS_LOCKED', grade = ?, lock_digest = ?, updated_at = ?
         WHERE id = ?`,
      ).run(payload.lock.grade, payload.lock.digest, payload.lock.computed_at, payload.cycle_id);
    },
    [CYCLE_EVENT_TYPES.stageAdvanced]: (db: Db, record: EventRecord): void => {
      const payload = parseOrThrow(
        cycleStageAdvancedSchema,
        record.payload,
        `${record.id} cycle.stage_advanced`,
      );
      db.prepare(`UPDATE cycles SET stage = ?, updated_at = ? WHERE id = ?`).run(
        payload.to,
        payload.advanced_at,
        payload.cycle_id,
      );
    },
    [CYCLE_EVENT_TYPES.suspended]: (db: Db, record: EventRecord): void => {
      const payload = parseOrThrow(
        cycleSuspendedSchema,
        record.payload,
        `${record.id} cycle.suspended`,
      );
      db.prepare(
        `UPDATE cycles SET stage = 'SUSPENDED', suspended_from = ?, updated_at = ? WHERE id = ?`,
      ).run(payload.from, payload.suspended_at, payload.cycle_id);
    },
    [CYCLE_EVENT_TYPES.resumed]: (db: Db, record: EventRecord): void => {
      const payload = parseOrThrow(
        cycleResumedSchema,
        record.payload,
        `${record.id} cycle.resumed`,
      );
      db.prepare(
        `UPDATE cycles SET stage = ?, suspended_from = NULL, updated_at = ? WHERE id = ?`,
      ).run(payload.to, payload.resumed_at, payload.cycle_id);
    },
    [CYCLE_EVENT_TYPES.closed]: (db: Db, record: EventRecord): void => {
      const payload = parseOrThrow(cycleClosedSchema, record.payload, `${record.id} cycle.closed`);
      db.prepare(
        `UPDATE cycles SET stage = 'CLOSED', closed_at = ?, updated_at = ?,
                           criteria_met = ?, unmet_count = ? WHERE id = ?`,
      ).run(
        payload.closed_at,
        payload.closed_at,
        payload.criteria_met ? 1 : 0,
        payload.unmet.length,
        payload.cycle_id,
      );
    },
  },
};

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Log-free read of the current cycle, for pure-read surfaces (`cycle status`) that must
 * not take the writer lock. Same row, same schema, no append path constructed.
 */
export function readCurrentCycle(projections: ProjectionStore): CycleRecord | null {
  const row = projections.db
    .prepare(
      `SELECT * FROM cycles WHERE stage != 'CLOSED' AND NOT EXISTS (
         SELECT 1 FROM cycle_restarts WHERE previous_cycle_id = cycles.id
       ) ORDER BY opened_at DESC LIMIT 1`,
    )
    .get();
  return row === undefined ? null : parseOrThrow(cycleRecordSchema, row, 'current cycle row');
}

/**
 * The latest `cycle.closed` payload in the log, or null — the shared reader for every
 * summary surface (doctor's cycle line, the Status `cycle` branch). Corrupt payloads are
 * skipped rather than thrown: the projector already refuses them at sync, so a summary
 * that cannot parse an old record still tells the truth about the ones it can.
 */
export function latestClosedCycle(log: EventLog): CycleClosed | null {
  let latest: CycleClosed | null = null;
  for (const record of log.replay()) {
    if (record.type !== CYCLE_EVENT_TYPES.closed) continue;
    const parsed = cycleClosedSchema.safeParse(record.payload);
    if (parsed.success) latest = parsed.data;
  }
  return latest;
}

/**
 * The last closed cycle as the projection holds it — the log-free twin of
 * {@link latestClosedCycle}, for surfaces opened without an event log (Status). Returns
 * the §24 verdict and its weight; the reasons live in the closure event and the handoff.
 */
export function readLastClosure(projections: ProjectionStore): {
  readonly cycleId: string;
  readonly closedAt: string;
  readonly grade: string;
  readonly criteriaMet: boolean;
  readonly unmetCount: number;
} | null {
  const row = projections.db
    .prepare(
      `SELECT id, closed_at, grade, criteria_met, unmet_count FROM cycles
       WHERE stage = 'CLOSED' AND closed_at IS NOT NULL
       ORDER BY closed_at DESC LIMIT 1`,
    )
    .get() as
    | {
        id: string;
        closed_at: string;
        grade: string | null;
        criteria_met: number | null;
        unmet_count: number | null;
      }
    | undefined;
  if (row === undefined || row.grade === null || row.criteria_met === null || row.unmet_count === null) {
    return null;
  }
  return {
    cycleId: row.id,
    closedAt: row.closed_at,
    grade: row.grade,
    criteriaMet: row.criteria_met === 1,
    unmetCount: row.unmet_count,
  };
}

export interface CycleRegistryDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  /** Supplies the mission version stamped on every event. */
  readonly missionVersion: () => string;
}

export interface CycleRestartExpectation {
  readonly cycleId: string;
  readonly missionVersion: string;
  readonly lockDigest: Sha256;
}

export class CycleRegistry {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly missionVersion: () => string;

  public constructor(deps: CycleRegistryDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.missionVersion = deps.missionVersion;
  }

  /* ------------------------------ queries ------------------------------ */

  public get(cycleId: string): CycleRecord | null {
    const row = this.projections.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId);
    return row === undefined ? null : parseOrThrow(cycleRecordSchema, row, `cycle row ${cycleId}`);
  }

  /** The active cycle, or null. Restarted predecessors remain historical. */
  public current(): CycleRecord | null {
    return readCurrentCycle(this.projections);
  }

  public list(): CycleRecord[] {
    return this.projections.db
      .prepare('SELECT * FROM cycles ORDER BY opened_at')
      .all()
      .map((row) => parseOrThrow(cycleRecordSchema, row, 'cycle row'));
  }

  /* ------------------------------- moves ------------------------------- */

  /** Opens a new cycle. Refused while a cycle is active (Execution Model §1). */
  public open(): CycleRecord {
    const unclosed = this.current();
    if (unclosed !== null) {
      throw new CycleTransitionError(
        unclosed.id,
        unclosed.stage,
        'OPENED',
        `a cycle is already in progress at ${unclosed.stage}; cycles are serial — close it first`,
      );
    }
    const cycleId = this.nextCycleId();
    const payload = parseOrThrow(
      cycleOpenedSchema,
      {
        cycle_id: cycleId,
        mission_version: this.missionVersion(),
        opened_by: 'daemon',
        opened_at: nowIso(),
      },
      'cycle.opened',
    );
    this.append(CYCLE_EVENT_TYPES.opened, payload, cycleId);
    return this.mustGet(cycleId);
  }

  /** Replaces an old diagnostic slot with a fresh cycle in one durable event (§21.3). */
  public restart(expected: CycleRestartExpectation): { readonly cycle: CycleRecord; readonly created: boolean } {
    const previous = this.get(expected.cycleId);
    const mission = this.missionVersion();
    if (previous === null || previous.stage !== 'SCREENED' || previous.grade !== 'diagnostic' ||
        previous.lock_digest !== expected.lockDigest || mission !== expected.missionVersion ||
        previous.mission_version === mission) {
      throw new CycleTransitionError(expected.cycleId, previous?.stage ?? null, 'OPENED',
        'restart requires the exact screened diagnostic cycle, its full lock digest, and a successor mission');
    }
    const existingId = this.restartSuccessorId(previous.id);
    if (existingId !== null) {
      const existing = this.get(existingId);
      if (existing === null || existing.mission_version !== mission) {
        throw new Error(`Restart of ${previous.id} disagrees with the current mission.`);
      }
      return { cycle: existing, created: false };
    }
    if (this.current()?.id !== previous.id) {
      throw new CycleTransitionError(previous.id, previous.stage, 'OPENED', 'only the active cycle can be restarted');
    }
    const successorId = this.nextCycleId();
    const payload = parseOrThrow(cycleRestartedSchema, {
      previous_cycle_id: previous.id,
      previous_mission_version: previous.mission_version,
      previous_lock_digest: previous.lock_digest,
      successor: {
        cycle_id: successorId,
        mission_version: mission,
        opened_by: 'cli',
        opened_at: nowIso(),
      },
    }, 'cycle.restarted');
    this.append(CYCLE_EVENT_TYPES.restarted, payload, successorId, 'cli');
    return { cycle: this.mustGet(successorId), created: true };
  }

  /** Locks the inputs (OPENED → INPUTS_LOCKED). The lock's own schema keeps the grade honest. */
  public lockInputs(cycleId: string, lock: CycleInputLock): CycleRecord {
    const cycle = this.mustGet(cycleId);
    if (cycle.stage !== 'OPENED') {
      throw new CycleTransitionError(
        cycleId,
        cycle.stage,
        'INPUTS_LOCKED',
        'inputs lock exactly once, from OPENED',
      );
    }
    const payload = parseOrThrow(
      cycleInputsLockedSchema,
      { cycle_id: cycleId, lock: parseOrThrow(cycleInputLockSchema, lock, 'cycle input lock') },
      'cycle.inputs_locked',
    );
    this.append(CYCLE_EVENT_TYPES.inputsLocked, payload, cycleId);
    return this.mustGet(cycleId);
  }

  /** Advances along a `stage_advanced` arrow; the legality table is the only authority. */
  public advance(cycleId: string, to: CycleStage, evidence: ArtifactRef | null): CycleRecord {
    const cycle = this.mustGet(cycleId);
    const allowed = LEGAL_ADVANCES.get(cycle.stage) ?? [];
    if (!allowed.includes(to)) {
      throw new CycleTransitionError(
        cycleId,
        cycle.stage,
        to,
        allowed.length === 0
          ? 'no stage_advanced arrow leaves this stage'
          : `legal targets from here: ${allowed.join(', ')}`,
      );
    }
    const payload = parseOrThrow(
      cycleStageAdvancedSchema,
      { cycle_id: cycleId, from: cycle.stage, to, advanced_at: nowIso(), evidence },
      'cycle.stage_advanced',
    );
    this.append(CYCLE_EVENT_TYPES.stageAdvanced, payload, cycleId);
    return this.mustGet(cycleId);
  }

  /** Suspends a live cycle, remembering where it was (Execution Model §21.1). */
  public suspend(cycleId: string, reason: string): CycleRecord {
    const cycle = this.mustGet(cycleId);
    if (!SUSPENDABLE.has(cycle.stage)) {
      throw new CycleTransitionError(
        cycleId,
        cycle.stage,
        'SUSPENDED',
        cycle.stage === 'SUSPENDED' ? 'already suspended' : 'a closed cycle is history',
      );
    }
    const payload = parseOrThrow(
      cycleSuspendedSchema,
      { cycle_id: cycleId, from: cycle.stage, suspended_at: nowIso(), reason },
      'cycle.suspended',
    );
    this.append(CYCLE_EVENT_TYPES.suspended, payload, cycleId);
    return this.mustGet(cycleId);
  }

  /** Resumes to exactly where the cycle was suspended from (Execution Model §21.2). */
  public resume(cycleId: string, verification: ArtifactRef | null): CycleRecord {
    const cycle = this.mustGet(cycleId);
    if (cycle.stage !== 'SUSPENDED' || cycle.suspended_from === null) {
      throw new CycleTransitionError(cycleId, cycle.stage, null, 'only a suspended cycle resumes');
    }
    const payload = parseOrThrow(
      cycleResumedSchema,
      { cycle_id: cycleId, to: cycle.suspended_from, resumed_at: nowIso(), verification },
      'cycle.resumed',
    );
    this.append(CYCLE_EVENT_TYPES.resumed, payload, cycleId);
    return this.mustGet(cycleId);
  }

  /**
   * Closes from HANDOFF, recording §24 as evaluated — met, or honestly unmet with every
   * reason enumerated. The payload schema itself refuses a closure whose `criteria_met`
   * disagrees with its `unmet` list.
   */
  public close(cycleId: string, unmet: readonly string[]): CycleRecord {
    const cycle = this.mustGet(cycleId);
    if (cycle.stage !== 'HANDOFF') {
      throw new CycleTransitionError(cycleId, cycle.stage, 'CLOSED', 'closure happens from HANDOFF');
    }
    if (cycle.grade === null) {
      throw new CycleTransitionError(cycleId, cycle.stage, 'CLOSED', 'a cycle without a lock has no grade to close under');
    }
    const payload = parseOrThrow(
      cycleClosedSchema,
      {
        cycle_id: cycleId,
        closed_at: nowIso(),
        stage_reached: cycle.stage,
        grade: cycle.grade,
        criteria_met: unmet.length === 0,
        unmet: [...unmet],
      },
      'cycle.closed',
    );
    this.append(CYCLE_EVENT_TYPES.closed, payload, cycleId);
    return this.mustGet(cycleId);
  }

  /* ----------------------------- internals ----------------------------- */

  private nextCycleId(): string {
    const { n } = this.projections.db.prepare('SELECT COUNT(*) AS n FROM cycles').get() as { n: number };
    return makeEntityId('cycle', n + 1);
  }

  private restartSuccessorId(cycleId: string): string | null {
    const row = this.projections.db.prepare(
      'SELECT successor_cycle_id FROM cycle_restarts WHERE previous_cycle_id = ?',
    ).get(cycleId) as { successor_cycle_id: string } | undefined;
    return row?.successor_cycle_id ?? null;
  }

  private mustGet(cycleId: string): CycleRecord {
    const cycle = this.get(cycleId);
    if (cycle === null) {
      throw new CycleTransitionError(cycleId, null, null, 'unknown cycle');
    }
    const successorId = this.restartSuccessorId(cycleId);
    if (successorId !== null) {
      throw new CycleTransitionError(cycleId, cycle.stage, null, `superseded by ${successorId}`);
    }
    return cycle;
  }

  private append(type: string, payload: unknown, subjectId: string, actor: Actor = 'daemon'): void {
    this.log.append({
      type,
      actor,
      missionVersion: this.missionVersion(),
      subjectId,
      payload,
    });
    this.projections.sync(this.log);
  }
}
