/**
 * CLUE task queue.
 *
 * Architecture: CLUE_Architecture_v9.md (single-writer daemon; events as authority; tasks as projection).
 * Execution: CLUE_Execution_Model_v9.md (event-first transitions, atomic leases, attempt history, retry/backoff).
 * Backlog: DEV-P0-06 — atomic lease transitions and validated dependencies.
 *          DEV-P1-28 (phase 4) — the task stage of the evidence spine: `spineLink`/`spineSeal` bind
 *          a granted lease (task id, attempt, lease-token hash, expiry) to the recognition seal, and
 *          `verifyTaskLink` checks a presented link against the recognition predecessor and this
 *          registry's own durable attempt history.
 *
 * Revision 4 (INT-P0-01) — every task transition is now event-first. The queue reads the
 * current projection only to decide whether a command is admissible, appends one durable event
 * carrying the exact expected predecessor state, and only then synchronises SQLite. Projectors
 * compare that predecessor before applying the event. An event-append failure therefore leaves
 * no visible transition, while a projection failure leaves a durable transition that replay can
 * recover; SQLite can no longer become the sole home of a claim, heartbeat, release, reclaim,
 * completion, failure, abandonment, cancellation, or dependency transition.
 *
 * Revision 3 (DEV-P0-06) — lease transitions are compare-and-swaps. Claiming, renewing,
 * heartbeating, completing, failing, abandoning, and reclaiming all compare state, owner, and
 * an unexpired `lease_expires_at` before they act, so a worker whose lease has expired cannot
 * renew or write a result, and completion and reclaim are mutually exclusive on one lease.
 * Dependencies are validated at creation for existence, self-reference, and cycles.
 *
 * Revision 2 — `claimById` added.
 *
 * Revision 1 offered only "give me the next task", which is right for a worker and
 * wrong for an operator who has chosen one. The CLI worked around it by draining the
 * queue until the wanted task appeared and then expiring the leases it had taken along
 * the way — which incremented every drained task's attempt counter and wrote an
 * `expired` attempt row for each. Attempt history is evidence about a task: it is how
 * CLUE knows a task has failed the same way three times. Filling it with artefacts of a
 * command-line convenience corrupts exactly the record that makes the queue worth
 * having, so the queue grew the operation instead.
 *
 * The queue is what makes CLUE's sessions replaceable. A worker — a manually run session
 * packet today, an API call from Stage D2 onward — takes a task, does it, and returns a
 * result. If it dies halfway, the lease expires, the task returns with its history
 * intact, and a different worker picks it up knowing exactly what was tried before.
 *
 * Four properties earn the complexity, and each maps to a clause of the Stage D gate:
 *
 *   A task survives restart. State lives in the event log and its projection, never in
 *   a running process. Killing the daemon loses leases, which is correct: a lease is a
 *   claim by a process that no longer exists.
 *
 *   An expired lease returns to the queue with attempt history. A task that failed three
 *   times in the same way is a finding about the task, and discarding that would let
 *   CLUE retry forever while learning nothing.
 *
 *   Results are validated before they are integrated. A worker's output is provisional
 *   until it passes a schema and its provenance checks; conflicting results become
 *   conflict objects rather than a last-writer-wins overwrite.
 *
 *   No task depends on a chat transcript. Everything a worker needs is the task record
 *   plus content-addressed artifacts. The record has nowhere to put a conversation, and
 *   that absence is deliberate — it is the structural form of the guarantee.
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import { hashCanonicalJson, hashText, makeEntityId, nowIso, type Sha256 } from '../shared/ids.js';
import {
  EvidenceChainError,
  requireSpineHash,
  requireSpineId,
  sealLink as sealEvidenceLink,
  verifyLink as verifyEvidenceLink,
  type BindingHash,
  type RecognitionLink,
  type TaskLink,
} from '../shared/evidenceIdentity.js';
import { parseOrThrow } from '../shared/schemas.js';
import type { EventLog } from '../memory/eventLog.js';
import type { ProjectionStore, Projector } from '../memory/db.js';

type Db = Database.Database;

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Task lifecycle.
 *
 *   pending    ready to be claimed
 *   blocked    waiting on a dependency
 *   leased     claimed by a worker, with an expiry
 *   completed  finished with a validated result
 *   failed     finished without one, and eligible to retry
 *   dead       out of attempts; retained as evidence, never retried
 *   cancelled  withdrawn by the scheduler or the Creator
 *
 * `failed` and `dead` are distinct on purpose. A failure is a fact about one attempt; a
 * dead task is a fact about the task itself, and treating them alike would either hide a
 * persistent problem or abandon a transient one.
 */
export type TaskState =
  | 'pending'
  | 'blocked'
  | 'leased'
  | 'completed'
  | 'failed'
  | 'dead'
  | 'cancelled';

export type AttemptOutcome = 'completed' | 'failed' | 'expired' | 'abandoned';

type TaskTransitionAuthority = 'lease' | 'administrative' | 'expiry';

/** Budget lanes, matching config/policies/budget.yaml. */
export type TaskLane = 'extraction' | 'analysis' | 'patch_design' | 'refutation' | 'synthesis';

export const DEFAULT_LANE_WEIGHTS: Readonly<Record<TaskLane, number>> = {
  extraction: 1.0,
  analysis: 1.2,
  patch_design: 1.6,
  refutation: 1.4,
  synthesis: 1.1,
};

/* ------------------------------------------------------------------------- */
/* Records                                                                    */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const taskId = z.string().regex(/^TASK-[0-9]{6,}$/);

export const taskRecordSchema = z
  .object({
    id: taskId,
    /** Identity of the work, not of the request. Two identical asks are one task. */
    signature: sha256,
    type: z.string().min(1),
    lane: z.enum(['extraction', 'analysis', 'patch_design', 'refutation', 'synthesis']),
    lane_weight: z.number().positive(),
    priority: z.number().min(0).max(1),
    state: z.enum(['pending', 'blocked', 'leased', 'completed', 'failed', 'dead', 'cancelled']),
    parent_id: taskId.nullable(),
    subject_id: z.string().nullable(),
    snapshot_id: sha256.nullable(),
    mission_version: z.string().min(1),
    /**
     * Content hash of the task input. Everything a worker needs lives behind this hash.
     * There is deliberately no free-text field on a task: a place to paste conversation
     * is a place where mission state stops being reconstructible.
     */
    input_hash: sha256,
    output_hash: sha256.nullable(),
    budget: z.number().nonnegative(),
    spent: z.number().nonnegative(),
    attempts: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    /**
     * Genuine failures only (DEV-P0-06). The dead-letter budget is measured against THIS, not the
     * attempt sequence, so an administrative release that re-queues a task never consumes a retry.
     */
    failed_attempt_count: z.number().int().nonnegative().default(0),
    lease_owner: z.string().nullable(),
    lease_expires_at: isoTime.nullable(),
    /** Earliest time the task may be claimed; moved forward by retry backoff. */
    available_at: isoTime,
    created_at: isoTime,
    updated_at: isoTime,
    terminal_reason: z.string().nullable(),
  })
  .strict();

export type TaskRecord = z.infer<typeof taskRecordSchema>;

/**
 * Parses a `tasks` row into a TaskRecord, dropping `lease_token_hash`. The token hash is an internal
 * projection column that proves lease authority; it is deliberately not part of the public record, so
 * it is stripped here rather than added to the strict schema.
 */
function parseTaskRow(row: unknown): TaskRecord {
  if (typeof row !== 'object' || row === null) {
    return parseOrThrow(taskRecordSchema, row, 'tasks row');
  }
  const { lease_token_hash: _leaseTokenHash, ...rest } = row as Record<string, unknown>;
  return parseOrThrow(taskRecordSchema, rest, 'tasks row');
}

export const taskAttemptSchema = z
  .object({
    task_id: taskId,
    attempt: z.number().int().positive(),
    worker: z.string().min(1),
    started_at: isoTime,
    ended_at: isoTime.nullable(),
    outcome: z.enum(['completed', 'failed', 'expired', 'abandoned']).nullable(),
    detail: z.string().nullable(),
    tokens_in: z.number().int().nonnegative().nullable(),
    tokens_out: z.number().int().nonnegative().nullable(),
    cost: z.number().nonnegative().nullable(),
  })
  .strict();

export type TaskAttempt = z.infer<typeof taskAttemptSchema>;

export interface QueueStats {
  readonly byState: Readonly<Record<string, number>>;
  readonly byLane: Readonly<Record<string, number>>;
  readonly oldestPendingAgeSeconds: number | null;
  readonly leasedExpiringWithinMinute: number;
  readonly totalSpent: number;
}

/* ------------------------------------------------------------------------- */
/* Events and schema                                                          */
/* ------------------------------------------------------------------------- */

export const TASK_EVENT_TYPES = {
  taskCreated: 'task.created',
  attemptStarted: 'task.attempt_started',
  attemptEnded: 'task.attempt_ended',
  /** A same-worker lease renewal that extended expiry and rotated the token (DEV-P0-06). Durable so a
   * rebuild reconstructs the renewed token rather than resurrecting the one from attempt_started. */
  leaseRenewed: 'task.lease_renewed',
  /** A heartbeat extends the current lease without rotating its bearer token. */
  leaseExtended: 'task.lease_extended',
  taskBlocked: 'task.blocked',
  taskUnblocked: 'task.unblocked',
  taskCancelled: 'task.cancelled',
  taskDeadLettered: 'task.dead_lettered',
} as const;

export const TASK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  signature        TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL,
  lane             TEXT NOT NULL,
  lane_weight      REAL NOT NULL,
  priority         REAL NOT NULL,
  state            TEXT NOT NULL,
  parent_id        TEXT,
  subject_id       TEXT,
  snapshot_id      TEXT,
  mission_version  TEXT NOT NULL,
  input_hash       TEXT NOT NULL,
  output_hash      TEXT,
  budget           REAL NOT NULL,
  spent            REAL NOT NULL,
  attempts         INTEGER NOT NULL,
  max_attempts     INTEGER NOT NULL,
  failed_attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  lease_token_hash TEXT,
  available_at     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  terminal_reason  TEXT
);
CREATE INDEX IF NOT EXISTS tasks_ready ON tasks(state, available_at);
CREATE INDEX IF NOT EXISTS tasks_lane  ON tasks(lane, state);
CREATE INDEX IF NOT EXISTS tasks_lease ON tasks(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id    TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS task_dependencies_on ON task_dependencies(depends_on);

CREATE TABLE IF NOT EXISTS task_attempts (
  task_id    TEXT NOT NULL,
  attempt    INTEGER NOT NULL,
  worker     TEXT NOT NULL,
  lease_token_hash TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  outcome    TEXT,
  detail     TEXT,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  cost       REAL,
  PRIMARY KEY (task_id, attempt)
);
`;

export function ensureTaskSchema(db: Db): void {
  db.exec(TASK_SCHEMA_SQL);

  // DEV-P0-06: the opaque lease/attempt token hash was added after the initial schema. Applied
  // additively so an existing workspace gains the columns without losing its task history.
  for (const [table, column] of [
    ['tasks', 'lease_token_hash'],
    ['task_attempts', 'lease_token_hash'],
  ] as const) {
    if (!taskColumnExists(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }
}

function taskColumnExists(db: Db, table: string, column: string): boolean {
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    if (typeof row === 'object' && row !== null && (row as Record<string, unknown>)['name'] === column) {
      return true;
    }
  }
  return false;
}

/**
 * Projectors.
 *
 * Every current event carries enough predecessor identity to make replay fail loudly if the
 * projection no longer represents the state against which the command was authorised. Legacy
 * events remain readable: their older payloads take the unguarded compatibility path, while every
 * event emitted by this revision is guarded. Lease start, renewal, and heartbeat are durable facts;
 * an expired lease is returned by an explicit `task.attempt_ended` event from `reclaimExpired`.
 */
export const TASK_PROJECTORS: Readonly<Record<string, Projector>> = {
  [TASK_EVENT_TYPES.taskCreated]: (db, record) => {
    const payload = readObject(record.payload, 'task.created');
    const wrapped = hasOwnField(payload, 'task');
    const task = parseOrThrow(
      taskRecordSchema,
      wrapped ? payload['task'] : record.payload,
      'task.created task',
    );
    const dependencies = wrapped ? readStringArray(payload, 'depends_on') : [];

    if (wrapped && (task.state === 'blocked') !== (dependencies.length > 0)) {
      throw new Error(
        `Authoritative task.created for ${task.id} disagrees with its dependency set: ` +
          `state=${task.state}, dependencies=${dependencies.length}.`,
      );
    }

    const inserted = db.prepare(
      `INSERT INTO tasks (
         id, signature, type, lane, lane_weight, priority, state, parent_id, subject_id,
         snapshot_id, mission_version, input_hash, output_hash, budget, spent, attempts,
         max_attempts, failed_attempt_count, lease_owner, lease_expires_at, lease_token_hash,
         available_at, created_at, updated_at, terminal_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id,
      task.signature,
      task.type,
      task.lane,
      task.lane_weight,
      task.priority,
      task.state,
      task.parent_id,
      task.subject_id,
      task.snapshot_id,
      task.mission_version,
      task.input_hash,
      task.output_hash,
      task.budget,
      task.spent,
      task.attempts,
      task.max_attempts,
      task.failed_attempt_count,
      task.lease_owner,
      task.lease_expires_at,
      null,
      task.available_at,
      task.created_at,
      task.updated_at,
      task.terminal_reason,
    );
    assertProjectedTransition(inserted.changes, TASK_EVENT_TYPES.taskCreated, task.id);

    if (dependencies.length > 0) {
      const insertDependency = db.prepare(
        'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
      );
      for (const dependency of dependencies) insertDependency.run(task.id, dependency);
    }
  },

  [TASK_EVENT_TYPES.attemptStarted]: (db, record) => {
    const payload = readObject(record.payload, 'task.attempt_started');
    const id = readString(payload, 'task_id');
    const attempt = readNumber(payload, 'attempt');
    const worker = readString(payload, 'worker');
    const startedAt = readString(payload, 'started_at');
    const expiresAt = readString(payload, 'lease_expires_at');
    const tokenHash = readOptionalString(payload, 'lease_token_hash');
    const guarded =
      hasOwnField(payload, 'expected_attempts') &&
      hasOwnField(payload, 'expected_available_at') &&
      hasOwnField(payload, 'expected_lease_owner') &&
      hasOwnField(payload, 'expected_lease_expires_at') &&
      hasOwnField(payload, 'expected_lease_token_hash');

    if (guarded && tokenHash === null) {
      throw new Error(`Authoritative ${TASK_EVENT_TYPES.attemptStarted} for ${id} has no lease token hash.`);
    }

    const expectedAttempts = guarded ? readNumber(payload, 'expected_attempts') : null;
    const expectedAvailableAt = guarded ? readString(payload, 'expected_available_at') : null;
    const expectedOwner = guarded ? readOptionalString(payload, 'expected_lease_owner') : null;
    const expectedExpiry = guarded ? readOptionalString(payload, 'expected_lease_expires_at') : null;
    const expectedTokenHash = guarded ? readOptionalString(payload, 'expected_lease_token_hash') : null;

    if (expectedAttempts !== null && attempt !== expectedAttempts + 1) {
      throw new Error(
        `Authoritative ${TASK_EVENT_TYPES.attemptStarted} for ${id} names attempt ${attempt}, ` +
          `but predecessor attempt count ${expectedAttempts} requires ${expectedAttempts + 1}.`,
      );
    }

    const taskUpdate = guarded
      ? db.prepare(
          `UPDATE tasks
              SET state = 'leased', lease_owner = ?, lease_expires_at = ?, lease_token_hash = ?,
                  attempts = ?, updated_at = ?, terminal_reason = NULL
            WHERE id = ? AND state = 'pending' AND attempts = ?
              AND available_at IS ? AND available_at <= ?
              AND lease_owner IS ? AND lease_expires_at IS ? AND lease_token_hash IS ?`,
        ).run(
          worker,
          expiresAt,
          tokenHash,
          attempt,
          startedAt,
          id,
          expectedAttempts,
          expectedAvailableAt,
          startedAt,
          expectedOwner,
          expectedExpiry,
          expectedTokenHash,
        )
      : db.prepare(
          `UPDATE tasks
              SET state = 'leased', lease_owner = ?, lease_expires_at = ?, lease_token_hash = ?,
                  attempts = ?, updated_at = ?, terminal_reason = NULL
            WHERE id = ?`,
        ).run(worker, expiresAt, tokenHash, attempt, startedAt, id);
    if (guarded) assertProjectedTransition(taskUpdate.changes, TASK_EVENT_TYPES.attemptStarted, id);

    const attemptInsert = db.prepare(
      `INSERT INTO task_attempts (task_id, attempt, worker, lease_token_hash, started_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id, attempt) DO NOTHING`,
    ).run(id, attempt, worker, tokenHash, startedAt);
    if (guarded) assertProjectedTransition(attemptInsert.changes, TASK_EVENT_TYPES.attemptStarted, id);
  },

  [TASK_EVENT_TYPES.leaseRenewed]: (db, record) => {
    const payload = readObject(record.payload, 'task.lease_renewed');
    const id = readString(payload, 'task_id');
    const attempt = readNumber(payload, 'attempt');
    const worker = readString(payload, 'worker');
    const renewedAt = readString(payload, 'renewed_at');
    const expiresAt = readString(payload, 'lease_expires_at');
    const tokenHash = readString(payload, 'lease_token_hash');
    const previousTokenHash = readOptionalString(payload, 'previous_lease_token_hash');
    const previousExpiry = readOptionalString(payload, 'previous_lease_expires_at');

    const taskUpdate =
      previousTokenHash === null
        ? db.prepare(
            `UPDATE tasks SET lease_expires_at = ?, lease_token_hash = ?, updated_at = ?
              WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
          ).run(expiresAt, tokenHash, renewedAt, id, worker)
        : previousExpiry === null
          ? db.prepare(
              `UPDATE tasks SET lease_expires_at = ?, lease_token_hash = ?, updated_at = ?
                WHERE id = ? AND state = 'leased' AND lease_owner = ? AND attempts = ?
                  AND lease_token_hash IS ? AND lease_expires_at > ?`,
            ).run(
              expiresAt,
              tokenHash,
              renewedAt,
              id,
              worker,
              attempt,
              previousTokenHash,
              renewedAt,
            )
          : db.prepare(
              `UPDATE tasks SET lease_expires_at = ?, lease_token_hash = ?, updated_at = ?
                WHERE id = ? AND state = 'leased' AND lease_owner = ? AND attempts = ?
                  AND lease_token_hash IS ? AND lease_expires_at IS ? AND lease_expires_at > ?`,
            ).run(
              expiresAt,
              tokenHash,
              renewedAt,
              id,
              worker,
              attempt,
              previousTokenHash,
              previousExpiry,
              renewedAt,
            );
    if (previousTokenHash !== null) {
      assertProjectedTransition(taskUpdate.changes, TASK_EVENT_TYPES.leaseRenewed, id);
    }

    const attemptUpdate =
      previousTokenHash === null
        ? db.prepare(
            'UPDATE task_attempts SET lease_token_hash = ? WHERE task_id = ? AND attempt = ?',
          ).run(tokenHash, id, attempt)
        : db.prepare(
            `UPDATE task_attempts SET lease_token_hash = ?
              WHERE task_id = ? AND attempt = ? AND worker = ? AND lease_token_hash IS ?
                AND ended_at IS NULL`,
          ).run(tokenHash, id, attempt, worker, previousTokenHash);
    if (previousTokenHash !== null) {
      assertProjectedTransition(attemptUpdate.changes, TASK_EVENT_TYPES.leaseRenewed, id);
    }
  },

  [TASK_EVENT_TYPES.leaseExtended]: (db, record) => {
    const payload = readObject(record.payload, 'task.lease_extended');
    const id = readString(payload, 'task_id');
    const attempt = readNumber(payload, 'attempt');
    const worker = readString(payload, 'worker');
    const extendedAt = readString(payload, 'extended_at');
    const previousExpiry = readString(payload, 'previous_lease_expires_at');
    const expiresAt = readString(payload, 'lease_expires_at');
    const tokenHash = readString(payload, 'lease_token_hash');

    const updated = db.prepare(
      `UPDATE tasks SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_owner = ? AND attempts = ?
          AND lease_token_hash IS ? AND lease_expires_at IS ? AND lease_expires_at > ?`,
    ).run(expiresAt, extendedAt, id, worker, attempt, tokenHash, previousExpiry, extendedAt);
    assertProjectedTransition(updated.changes, TASK_EVENT_TYPES.leaseExtended, id);
  },

  [TASK_EVENT_TYPES.attemptEnded]: (db, record) => {
    const payload = readObject(record.payload, 'task.attempt_ended');
    const id = readString(payload, 'task_id');
    const attempt = readNumber(payload, 'attempt');
    const endedAt = readString(payload, 'ended_at');
    const outcome = readAttemptOutcome(payload, 'outcome');
    const nextState = readTaskState(payload, 'next_state');
    const outputHash = readOptionalString(payload, 'output_hash');
    const detail = readOptionalString(payload, 'detail');
    const tokensIn = readOptionalNumber(payload, 'tokens_in');
    const tokensOut = readOptionalNumber(payload, 'tokens_out');
    const cost = readOptionalNumber(payload, 'cost');
    const availableAt = readString(payload, 'available_at');
    const terminalReason = readOptionalString(payload, 'terminal_reason');
    const authority = readOptionalTransitionAuthority(payload, 'authority');

    if (authority === null) {
      db.prepare(
        `UPDATE task_attempts
            SET ended_at = ?, outcome = ?, detail = ?, tokens_in = ?, tokens_out = ?, cost = ?
          WHERE task_id = ? AND attempt = ?`,
      ).run(endedAt, outcome, detail, tokensIn, tokensOut, cost, id, attempt);

      db.prepare(
        `UPDATE tasks
            SET state = ?, output_hash = COALESCE(?, output_hash),
                spent = spent + ?, failed_attempt_count = failed_attempt_count + ?,
                lease_owner = NULL, lease_expires_at = NULL, lease_token_hash = NULL,
                available_at = ?, updated_at = ?,
                terminal_reason = COALESCE(?, terminal_reason)
          WHERE id = ?`,
      ).run(
        nextState,
        outputHash,
        cost ?? 0,
        outcome === 'failed' ? 1 : 0,
        availableAt,
        endedAt,
        terminalReason,
        id,
      );
      return;
    }

    const worker = readString(payload, 'worker');
    const tokenHash = readString(payload, 'lease_token_hash');
    const expectedExpiry = readOptionalString(payload, 'expected_lease_expires_at');
    if (authority === 'lease' && expectedExpiry === null) {
      throw new Error(`Authoritative ${TASK_EVENT_TYPES.attemptEnded} for ${id} has no live lease expiry.`);
    }

    const attemptUpdate = db.prepare(
      `UPDATE task_attempts
          SET ended_at = ?, outcome = ?, detail = ?, tokens_in = ?, tokens_out = ?, cost = ?
        WHERE task_id = ? AND attempt = ? AND worker = ? AND lease_token_hash IS ?
          AND ended_at IS NULL AND outcome IS NULL`,
    ).run(endedAt, outcome, detail, tokensIn, tokensOut, cost, id, attempt, worker, tokenHash);
    assertProjectedTransition(attemptUpdate.changes, TASK_EVENT_TYPES.attemptEnded, id);

    const commonSql =
      `UPDATE tasks
          SET state = ?, output_hash = COALESCE(?, output_hash), spent = spent + ?,
              failed_attempt_count = failed_attempt_count + ?,
              lease_owner = NULL, lease_expires_at = NULL, lease_token_hash = NULL,
              available_at = ?, updated_at = ?, terminal_reason = ?
        WHERE id = ? AND state = 'leased' AND lease_owner = ? AND attempts = ?
          AND lease_token_hash IS ? AND lease_expires_at IS ?`;
    const commonParams: Array<string | number | null> = [
      nextState,
      outputHash,
      cost ?? 0,
      outcome === 'failed' ? 1 : 0,
      availableAt,
      endedAt,
      terminalReason,
      id,
      worker,
      attempt,
      tokenHash,
      expectedExpiry,
    ];

    const taskUpdate =
      authority === 'lease'
        ? db.prepare(`${commonSql} AND lease_expires_at > ?`).run(...commonParams, endedAt)
        : authority === 'expiry'
          ? db.prepare(
              `${commonSql} AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
            ).run(...commonParams, endedAt)
          : db.prepare(commonSql).run(...commonParams);
    assertProjectedTransition(taskUpdate.changes, TASK_EVENT_TYPES.attemptEnded, id);
  },

  [TASK_EVENT_TYPES.taskBlocked]: (db, record) => {
    const payload = readObject(record.payload, 'task.blocked');
    const id = readString(payload, 'task_id');
    const dependencies = readStringArray(payload, 'depends_on');

    const insert = db.prepare(
      'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?) ON CONFLICT DO NOTHING',
    );
    for (const dependency of dependencies) insert.run(id, dependency);

    const updated = db.prepare(
      "UPDATE tasks SET state = 'blocked', updated_at = ? WHERE id = ? AND state IN ('pending','blocked')",
    ).run(readString(payload, 'at'), id);
    assertProjectedTransition(updated.changes, TASK_EVENT_TYPES.taskBlocked, id);
  },

  [TASK_EVENT_TYPES.taskUnblocked]: (db, record) => {
    const payload = readObject(record.payload, 'task.unblocked');
    const id = readString(payload, 'task_id');
    const updated = db.prepare(
      "UPDATE tasks SET state = 'pending', available_at = ?, updated_at = ? WHERE id = ? AND state = 'blocked'",
    ).run(readString(payload, 'at'), readString(payload, 'at'), id);
    assertProjectedTransition(updated.changes, TASK_EVENT_TYPES.taskUnblocked, id);
  },

  [TASK_EVENT_TYPES.taskCancelled]: (db, record) => {
    const payload = readObject(record.payload, 'task.cancelled');
    const id = readString(payload, 'task_id');
    const at = readString(payload, 'at');
    const expectedState = readOptionalTaskState(payload, 'expected_state');

    if (expectedState === null) {
      db.prepare(
        `UPDATE tasks
            SET state = 'cancelled', terminal_reason = ?, lease_owner = NULL,
                lease_expires_at = NULL, lease_token_hash = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(readString(payload, 'reason'), at, id);
      return;
    }

    const expectedAttempts = readNumber(payload, 'expected_attempts');
    const expectedOwner = readOptionalString(payload, 'expected_lease_owner');
    const expectedExpiry = readOptionalString(payload, 'expected_lease_expires_at');
    const expectedTokenHash = readOptionalString(payload, 'expected_lease_token_hash');

    if (expectedState === 'leased') {
      const attemptUpdate = db.prepare(
        `UPDATE task_attempts
            SET ended_at = ?, outcome = 'abandoned', detail = ?
          WHERE task_id = ? AND attempt = ? AND worker IS ? AND lease_token_hash IS ?
            AND ended_at IS NULL AND outcome IS NULL`,
      ).run(at, `cancelled: ${readString(payload, 'reason')}`, id, expectedAttempts, expectedOwner, expectedTokenHash);
      assertProjectedTransition(attemptUpdate.changes, TASK_EVENT_TYPES.taskCancelled, id);
    }

    const updated = db.prepare(
      `UPDATE tasks
          SET state = 'cancelled', terminal_reason = ?, lease_owner = NULL,
              lease_expires_at = NULL, lease_token_hash = NULL, updated_at = ?
        WHERE id = ? AND state = ? AND attempts = ? AND lease_owner IS ?
          AND lease_expires_at IS ? AND lease_token_hash IS ?`,
    ).run(
      readString(payload, 'reason'),
      at,
      id,
      expectedState,
      expectedAttempts,
      expectedOwner,
      expectedExpiry,
      expectedTokenHash,
    );
    assertProjectedTransition(updated.changes, TASK_EVENT_TYPES.taskCancelled, id);
  },

  [TASK_EVENT_TYPES.taskDeadLettered]: (db, record) => {
    const payload = readObject(record.payload, 'task.dead_lettered');
    db.prepare(
      `UPDATE tasks
          SET state = 'dead', terminal_reason = ?, lease_owner = NULL,
              lease_expires_at = NULL, lease_token_hash = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(readString(payload, 'reason'), readString(payload, 'at'), readString(payload, 'task_id'));
  },
};

/* ------------------------------------------------------------------------- */
/* Queue                                                                      */
/* ------------------------------------------------------------------------- */

export interface TaskQueueDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly missionVersion: () => string;
  readonly laneWeights?: Readonly<Record<TaskLane, number>>;
  readonly defaultLeaseMs?: number;
  readonly defaultMaxAttempts?: number;
}

export interface CreateTaskInput {
  readonly type: string;
  readonly lane: TaskLane;
  /** 0-1. Combined with the lane weight and waiting time when ordering. */
  readonly priority: number;
  /** Content hash of the input artifact. Required: a task with no input is not a task. */
  readonly inputHash: Sha256 | string;
  readonly subjectId?: string | null;
  readonly parentId?: string | null;
  readonly snapshotId?: string | null;
  readonly budget?: number;
  readonly maxAttempts?: number;
  /** Task ids that must reach `completed` before this one may be claimed. */
  readonly dependsOn?: readonly string[];
}

export interface LeasedTask {
  readonly task: TaskRecord;
  readonly attempt: number;
  readonly leaseExpiresAt: string;
  /**
   * The opaque bearer token for this lease (DEV-P0-06). Required to heartbeat, complete, fail, or
   * abandon the task. Only its hash is stored, so it is returned once, here, and cannot be recovered
   * later; a stale token from a prior attempt — even by the same worker name — is rejected.
   */
  readonly leaseToken: string;
  /** True when the lease was extended rather than newly taken. */
  readonly renewed: boolean;
}

export interface CompletionInput {
  readonly outputHash: Sha256 | string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cost?: number;
  readonly detail?: string;
}

export interface FailureInput {
  readonly detail: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cost?: number;
  /** Skip the remaining attempts, e.g. for an input the worker proved unusable. */
  readonly permanent?: boolean;
}

const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BUDGET = 0.5;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

export class TaskQueue {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly missionVersion: () => string;
  private readonly laneWeights: Readonly<Record<TaskLane, number>>;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  public constructor(deps: TaskQueueDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.missionVersion = deps.missionVersion;
    this.laneWeights = deps.laneWeights ?? DEFAULT_LANE_WEIGHTS;
    this.leaseMs = deps.defaultLeaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = deps.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    ensureTaskSchema(this.projections.db);
  }

  /* ------------------------------ creation ---------------------------- */

  /**
   * Creates a task, or returns the existing one with the same signature.
   *
   * Idempotence is not a convenience. The daemon re-derives work every cycle, so without
   * it a scope that keeps failing would accumulate a duplicate task per cycle until the
   * queue was mostly copies of the same unanswered question.
   */
  public create(input: CreateTaskInput): TaskRecord {
    this.syncForDecision();
    const signature = hashCanonicalJson({
      type: input.type,
      subject: input.subjectId ?? null,
      input: input.inputHash,
      snapshot: input.snapshotId ?? null,
      mission: this.missionVersion(),
    });

    const existing = this.bySignature(signature);
    if (existing !== null) return existing;

    const timestamp = nowIso();
    const id = makeEntityId('task', this.nextSequence());
    const dependencies = this.validateDependencies(id, input.dependsOn ?? []);
    const blocked = dependencies.length > 0;

    const task = parseOrThrow(
      taskRecordSchema,
      {
        id,
        signature,
        type: input.type,
        lane: input.lane,
        lane_weight: this.laneWeights[input.lane],
        priority: clamp01(input.priority),
        state: blocked ? 'blocked' : 'pending',
        parent_id: input.parentId ?? null,
        subject_id: input.subjectId ?? null,
        snapshot_id: input.snapshotId ?? null,
        mission_version: this.missionVersion(),
        input_hash: input.inputHash,
        output_hash: null,
        budget: input.budget ?? DEFAULT_BUDGET,
        spent: 0,
        attempts: 0,
        max_attempts: input.maxAttempts ?? this.maxAttempts,
        lease_owner: null,
        lease_expires_at: null,
        available_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
        terminal_reason: null,
      },
      'task record',
    );

    // Task identity, initial state, and dependencies are one authoritative fact. The previous
    // two-event form could commit task.created and then fail before task.blocked, leaving a blocked
    // task without the dependency edges that explain and eventually release it.
    this.appendAndSync(
      TASK_EVENT_TYPES.taskCreated,
      { task, depends_on: [...dependencies] },
      task.id,
    );

    const created = this.get(task.id);
    if (created === null) throw new Error(`Task ${task.id} was not projected after creation`);
    return created;
  }

  /* ------------------------------ claiming ---------------------------- */

  /**
   * Claims the highest-scoring available task for a worker.
   *
   * Selection is a projection read only. `claimById` re-reads the candidate, appends an
   * authoritative event containing its exact predecessor, and then projects that event. The
   * EventLog's single-writer ownership plus this synchronous command path is the serialisation
   * guard: no competing task command can interleave between the decision and append, and SQLite
   * never has to reserve a claim before authority exists.
   *
   * Ordering combines priority, lane weight, and waiting time. The waiting-time term is
   * not fairness for its own sake: without it, a lane that always has high-priority work
   * would starve every other lane indefinitely, and CLUE would become very good at one
   * kind of question.
   */
  public claim(
    worker: string,
    options: { lanes?: readonly TaskLane[]; leaseMs?: number } = {},
  ): LeasedTask | null {
    this.syncForDecision();
    const now = nowIso();
    const laneFilter =
      options.lanes === undefined || options.lanes.length === 0
        ? ''
        : `AND lane IN (${options.lanes.map(() => '?').join(', ')})`;
    const laneParams = options.lanes === undefined ? [] : [...options.lanes];

    const selected = this.projections.db
      .prepare(
        `SELECT id FROM tasks
          WHERE state = 'pending' AND available_at <= ? ${laneFilter}
          ORDER BY (priority * lane_weight)
                   + (julianday(?) - julianday(created_at)) * 0.25 DESC,
                   created_at ASC
          LIMIT 1`,
      )
      .get(now, ...laneParams, now);

    if (selected === undefined) return null;
    return this.claimById(readString(readObject(selected, 'tasks row'), 'id'), worker, options);
  }

  /**
   * Claims one named task.
   *
   * Exists so an operator who has already chosen a task can lease it directly. The
   * alternative — repeatedly calling `claim` until the wanted task surfaces — takes and
   * releases leases on unrelated tasks, and every one of those writes an attempt record.
   * Attempt history is how CLUE learns that a task keeps failing the same way; filling it
   * with the side effects of a search would make it useless for the one job it has.
   *
   * A task already leased by the same worker is **renewed**, not re-attempted. Exporting
   * the same packet twice is not two attempts at the work, and counting it as two would
   * bring the task closer to being dead-lettered for no reason.
   */
  public claimById(
    taskId: string,
    worker: string,
    options: { leaseMs?: number; leaseToken?: string } = {},
  ): LeasedTask | null {
    this.syncForDecision();
    const now = nowIso();
    const row = this.projections.db
      .prepare(
        `SELECT state, attempts, lease_owner, lease_expires_at, lease_token_hash, available_at
           FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    if (row === undefined) return null;

    const record = readObject(row, 'tasks row');
    const state = readString(record, 'state');
    const attempts = readNumber(record, 'attempts');
    const owner = readOptionalString(record, 'lease_owner');
    const currentExpiry = readOptionalString(record, 'lease_expires_at');
    const previousTokenHash = readOptionalString(record, 'lease_token_hash');
    const availableAt = readString(record, 'available_at');

    let renewed = false;
    if (state === 'leased' && owner === worker && currentExpiry !== null && currentExpiry > now) {
      const holdsToken =
        options.leaseToken !== undefined &&
        previousTokenHash !== null &&
        hashText(options.leaseToken) === previousTokenHash;
      if (!holdsToken) return null;
      renewed = true;
    } else if (state !== 'pending' || availableAt > now) {
      return null;
    }

    const expiresAt = new Date(Date.now() + (options.leaseMs ?? this.leaseMs)).toISOString();
    const token = randomBytes(24).toString('base64url');
    const tokenHash = hashText(token);

    if (renewed) {
      if (currentExpiry === null || previousTokenHash === null) {
        throw new Error(`Task ${taskId} has an incomplete live lease and cannot be renewed.`);
      }
      this.appendAndSync(
        TASK_EVENT_TYPES.leaseRenewed,
        {
          task_id: taskId,
          attempt: attempts,
          worker,
          renewed_at: now,
          lease_expires_at: expiresAt,
          lease_token_hash: tokenHash,
          previous_lease_token_hash: previousTokenHash,
          previous_lease_expires_at: currentExpiry,
        },
        taskId,
      );
    } else {
      this.appendAndSync(
        TASK_EVENT_TYPES.attemptStarted,
        {
          task_id: taskId,
          attempt: attempts + 1,
          worker,
          started_at: now,
          lease_expires_at: expiresAt,
          lease_token_hash: tokenHash,
          expected_attempts: attempts,
          expected_available_at: availableAt,
          expected_lease_owner: owner,
          expected_lease_expires_at: currentExpiry,
          expected_lease_token_hash: previousTokenHash,
        },
        taskId,
      );
    }

    const task = this.get(taskId);
    if (task === null) throw new Error(`Task ${taskId} vanished during claim`);
    return {
      task,
      attempt: renewed ? attempts : attempts + 1,
      leaseExpiresAt: expiresAt,
      leaseToken: token,
      renewed,
    };
  }

  /**
   * Extends a lease held by `worker` and proven by `leaseToken`. Returns false if the lease is no
   * longer theirs, has expired, or the token does not match. A successful extension is a durable
   * event before it becomes visible in SQLite, so a rebuild cannot silently shorten a heartbeat.
   */
  public heartbeat(taskId: string, worker: string, leaseToken: string, extendMs?: number): boolean {
    this.syncForDecision();
    const now = nowIso();
    const row = this.projections.db
      .prepare(
        `SELECT state, attempts, lease_owner, lease_expires_at, lease_token_hash
           FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    if (row === undefined) return false;

    const record = readObject(row, 'tasks row');
    const currentExpiry = readOptionalString(record, 'lease_expires_at');
    const tokenHash = hashText(leaseToken);
    if (
      readString(record, 'state') !== 'leased' ||
      readOptionalString(record, 'lease_owner') !== worker ||
      currentExpiry === null ||
      currentExpiry <= now ||
      readOptionalString(record, 'lease_token_hash') !== tokenHash
    ) {
      return false;
    }

    const expiresAt = new Date(Date.now() + (extendMs ?? this.leaseMs)).toISOString();
    this.appendAndSync(
      TASK_EVENT_TYPES.leaseExtended,
      {
        task_id: taskId,
        attempt: readNumber(record, 'attempts'),
        worker,
        extended_at: now,
        previous_lease_expires_at: currentExpiry,
        lease_expires_at: expiresAt,
        lease_token_hash: tokenHash,
      },
      taskId,
    );
    return true;
  }

  /**
   * True when `worker` currently holds an unexpired lease on `taskId` proven by `leaseToken`. A pure
   * check that changes nothing — unlike heartbeat it does not extend the lease. The packet import path
   * uses it to prove authority before it writes any evidence, so a wrong lease token is refused before a
   * result blob is stored rather than after it (DEV-P0-14). It mirrors the conditional transition in
   * `inspectLiveLease` exactly: leased state, matching owner, unexpired, and matching token hash.
   */
  public leaseHeldBy(taskId: string, worker: string, leaseToken: string): boolean {
    this.syncForDecision();
    const now = nowIso();
    const row = this.projections.db
      .prepare('SELECT state, lease_owner, lease_expires_at, lease_token_hash FROM tasks WHERE id = ?')
      .get(taskId);
    if (row === undefined) return false;
    const record = readObject(row, 'tasks row');
    const expiresAt = readOptionalString(record, 'lease_expires_at');
    return (
      readString(record, 'state') === 'leased' &&
      readOptionalString(record, 'lease_owner') === worker &&
      expiresAt !== null &&
      expiresAt > now &&
      readOptionalString(record, 'lease_token_hash') === hashText(leaseToken)
    );
  }

  /* ------------------------------ finishing --------------------------- */

  /**
   * Records a successful attempt.
   *
   * The output is referenced by hash, never inlined. A result large enough to matter is
   * large enough to bloat the event log, and a result stored by hash can be re-read and
   * re-validated years later against the schema it was accepted under.
   */
  public complete(
    taskId: string,
    worker: string,
    leaseToken: string,
    result: CompletionInput,
  ): TaskRecord {
    this.syncForDecision();
    const timestamp = nowIso();
    const lease = this.inspectLiveLease(taskId, worker, leaseToken, timestamp);
    if (!lease.ok) throw new Error(lease.reason);
    const outputHash = parseOrThrow(sha256, result.outputHash, 'completion output hash');

    this.appendAndSync(
      TASK_EVENT_TYPES.attemptEnded,
      {
        task_id: taskId,
        attempt: lease.attempt,
        worker,
        lease_token_hash: lease.tokenHash,
        expected_lease_expires_at: lease.expiresAt,
        authority: 'lease',
        outcome: 'completed',
        next_state: 'completed',
        ended_at: timestamp,
        available_at: timestamp,
        output_hash: outputHash,
        detail: result.detail ?? null,
        tokens_in: result.tokensIn ?? null,
        tokens_out: result.tokensOut ?? null,
        cost: result.cost ?? null,
        terminal_reason: null,
      },
      taskId,
    );
    this.unblockDependents(taskId);

    return this.requireTask(taskId);
  }

  /**
   * Records a failed attempt and decides whether the task retries.
   *
   * Backoff is exponential and capped. A task that fails instantly and retries instantly
   * turns a broken input into a spend loop, and a spend loop on an unattended system is
   * the failure mode that costs real money before anyone notices.
   */
  public fail(
    taskId: string,
    worker: string,
    leaseToken: string,
    failure: FailureInput,
  ): TaskRecord {
    this.syncForDecision();
    const timestamp = nowIso();
    const lease = this.inspectLiveLease(taskId, worker, leaseToken, timestamp);
    if (!lease.ok) throw new Error(lease.reason);

    // DEV-P0-06: exhaustion is measured against genuine failures, not the attempt sequence. This
    // failure is the (failedAttemptCount + 1)th; an administrative release never advances it.
    const exhausted = failure.permanent === true || lease.failedAttemptCount + 1 >= lease.maxAttempts;
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (lease.attempt - 1), BACKOFF_CAP_MS);
    const availableAt = exhausted ? timestamp : new Date(Date.now() + backoffMs).toISOString();
    const terminalReason = exhausted
      ? failure.permanent === true
        ? `permanent failure: ${failure.detail}`
        : `exhausted ${lease.maxAttempts} attempts; last: ${failure.detail}`
      : null;

    // One event closes the attempt and, when exhausted, dead-letters the task. The old two-event
    // sequence could commit attempt_ended and fail before task.dead_lettered, stranding an exhausted
    // task in an intermediate state that no lease-holder could finish.
    this.appendAndSync(
      TASK_EVENT_TYPES.attemptEnded,
      {
        task_id: taskId,
        attempt: lease.attempt,
        worker,
        lease_token_hash: lease.tokenHash,
        expected_lease_expires_at: lease.expiresAt,
        authority: 'lease',
        outcome: 'failed',
        next_state: exhausted ? 'dead' : 'pending',
        ended_at: timestamp,
        available_at: availableAt,
        output_hash: null,
        detail: failure.detail,
        tokens_in: failure.tokensIn ?? null,
        tokens_out: failure.tokensOut ?? null,
        cost: failure.cost ?? null,
        terminal_reason: terminalReason,
      },
      taskId,
    );

    return this.requireTask(taskId);
  }

  /**
   * Releases a lease without recording a failure.
   *
   * For an operator who exported a packet and decided not to run it. The attempt is
   * marked `abandoned` rather than `failed`, because nothing was tried and nothing was
   * learned, and a retry counter that cannot tell those apart will dead-letter a task
   * for the crime of being reconsidered.
   */
  public abandon(taskId: string, worker: string, leaseToken: string, reason: string): TaskRecord {
    this.syncForDecision();
    const timestamp = nowIso();
    const lease = this.inspectLiveLease(taskId, worker, leaseToken, timestamp);
    if (!lease.ok) throw new Error(lease.reason);

    this.appendAndSync(
      TASK_EVENT_TYPES.attemptEnded,
      {
        task_id: taskId,
        attempt: lease.attempt,
        worker,
        lease_token_hash: lease.tokenHash,
        expected_lease_expires_at: lease.expiresAt,
        authority: 'lease',
        outcome: 'abandoned',
        next_state: 'pending',
        ended_at: timestamp,
        available_at: timestamp,
        output_hash: null,
        detail: reason,
        tokens_in: null,
        tokens_out: null,
        cost: null,
        terminal_reason: null,
      },
      taskId,
    );
    return this.requireTask(taskId);
  }

  /**
   * Operator force-release of a leased task, returning it to the queue with its attempt history and
   * failure count unchanged.
   *
   * Unlike {@link abandon}, this needs no lease token: it is an explicit administrative authority.
   * The event records the exact lease predecessor it displaced, so replay either applies that one
   * release or fails loudly; no SQLite reservation occurs before the event exists.
   */
  public release(taskId: string, reason: string): TaskRecord {
    this.syncForDecision();
    const timestamp = nowIso();
    const row = this.projections.db
      .prepare(
        `SELECT state, attempts, lease_owner, lease_expires_at, lease_token_hash
           FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    if (row === undefined) throw new Error(`Unknown task ${taskId}`);

    const record = readObject(row, 'tasks row');
    const state = readString(record, 'state');
    if (state !== 'leased') throw new Error(`Task ${taskId} is ${state}, not leased`);
    const worker = readOptionalString(record, 'lease_owner');
    const tokenHash = readOptionalString(record, 'lease_token_hash');
    if (worker === null || tokenHash === null) {
      throw new Error(`Task ${taskId} has an incomplete leased projection and cannot be released.`);
    }

    this.appendAndSync(
      TASK_EVENT_TYPES.attemptEnded,
      {
        task_id: taskId,
        attempt: readNumber(record, 'attempts'),
        worker,
        lease_token_hash: tokenHash,
        expected_lease_expires_at: readOptionalString(record, 'lease_expires_at'),
        authority: 'administrative',
        outcome: 'abandoned',
        next_state: 'pending',
        ended_at: timestamp,
        available_at: timestamp,
        output_hash: null,
        detail: reason,
        tokens_in: null,
        tokens_out: null,
        cost: null,
        terminal_reason: null,
      },
      taskId,
    );
    return this.requireTask(taskId);
  }

  /**
   * Returns tasks whose leases have expired.
   *
   * Run on startup and periodically. Every reclaim is appended before any task row changes. Multiple
   * independent expired tasks may be appended as one batch and projected together; if an append fails
   * halfway, the already committed events remain authoritative and the projection is still untouched
   * until the next sync/restart applies exactly that committed prefix.
   */
  public reclaimExpired(): number {
    this.syncForDecision();
    const now = nowIso();
    const expired = this.projections.db
      .prepare(
        `SELECT id, attempts, max_attempts, lease_owner, lease_expires_at, lease_token_hash
           FROM tasks
          WHERE state = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .all(now);

    let reclaimed = 0;
    for (const row of expired) {
      const record = readObject(row, 'tasks row');
      const id = readString(record, 'id');
      const attempt = readNumber(record, 'attempts');
      const maxAttempts = readNumber(record, 'max_attempts');
      const worker = readOptionalString(record, 'lease_owner');
      const tokenHash = readOptionalString(record, 'lease_token_hash');
      if (worker === null || tokenHash === null) {
        throw new Error(`Task ${id} has an incomplete expired lease and cannot be reclaimed.`);
      }

      const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
      const exhausted = attempt >= maxAttempts;
      const availableAt = exhausted ? now : new Date(Date.now() + backoffMs).toISOString();
      const detail = `lease held by ${worker} expired without a result`;

      this.append(
        TASK_EVENT_TYPES.attemptEnded,
        {
          task_id: id,
          attempt,
          worker,
          lease_token_hash: tokenHash,
          expected_lease_expires_at: readOptionalString(record, 'lease_expires_at'),
          authority: 'expiry',
          outcome: 'expired',
          next_state: exhausted ? 'dead' : 'pending',
          ended_at: now,
          available_at: availableAt,
          output_hash: null,
          detail,
          tokens_in: null,
          tokens_out: null,
          cost: null,
          terminal_reason: exhausted ? 'lease expired on the final attempt' : null,
        },
        id,
      );
      reclaimed += 1;
    }

    if (reclaimed > 0) this.projections.sync(this.log);
    return reclaimed;
  }

  public cancel(taskId: string, reason: string): void {
    this.syncForDecision();
    const timestamp = nowIso();
    const row = this.projections.db
      .prepare(
        `SELECT state, attempts, lease_owner, lease_expires_at, lease_token_hash
           FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    if (row === undefined) throw new Error(`Unknown task ${taskId}`);

    const record = readObject(row, 'tasks row');
    const state = readTaskState(record, 'state');
    if (state === 'cancelled') return;

    this.appendAndSync(
      TASK_EVENT_TYPES.taskCancelled,
      {
        task_id: taskId,
        reason,
        at: timestamp,
        expected_state: state,
        expected_attempts: readNumber(record, 'attempts'),
        expected_lease_owner: readOptionalString(record, 'lease_owner'),
        expected_lease_expires_at: readOptionalString(record, 'lease_expires_at'),
        expected_lease_token_hash: readOptionalString(record, 'lease_token_hash'),
      },
      taskId,
    );
  }

  /* ----------------------------- dependencies ------------------------- */

  /** Moves blocked tasks to pending once every dependency has completed. */
  public unblockDependents(completedTaskId: string): number {
    this.syncForDecision();
    const candidates = this.projections.db
      .prepare('SELECT DISTINCT task_id FROM task_dependencies WHERE depends_on = ?')
      .all(completedTaskId);

    const timestamp = nowIso();
    let unblocked = 0;

    for (const row of candidates) {
      const id = readString(readObject(row, 'task_dependencies row'), 'task_id');
      const outstanding = this.projections.db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM task_dependencies d
             JOIN tasks t ON t.id = d.depends_on
            WHERE d.task_id = ? AND t.state != 'completed'`,
        )
        .get(id);

      if (readNumber(readObject(outstanding, 'count row'), 'n') > 0) continue;

      const task = this.get(id);
      if (task === null || task.state !== 'blocked') continue;

      this.append(TASK_EVENT_TYPES.taskUnblocked, { task_id: id, at: timestamp }, id);
      unblocked += 1;
    }

    if (unblocked > 0) this.projections.sync(this.log);
    return unblocked;
  }

  /* ------------------------------- queries ---------------------------- */

  public get(taskId: string): TaskRecord | null {
    const row = this.projections.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    return row === undefined ? null : parseTaskRow(row);
  }

  public bySignature(signature: string): TaskRecord | null {
    const row = this.projections.db.prepare('SELECT * FROM tasks WHERE signature = ?').get(signature);
    return row === undefined ? null : parseTaskRow(row);
  }

  public list(
    filter: { state?: TaskState; lane?: TaskLane; type?: string; limit?: number } = {},
  ): TaskRecord[] {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (filter.state !== undefined) {
      conditions.push('state = ?');
      parameters.push(filter.state);
    }
    if (filter.lane !== undefined) {
      conditions.push('lane = ?');
      parameters.push(filter.lane);
    }
    if (filter.type !== undefined) {
      conditions.push('type = ?');
      parameters.push(filter.type);
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    return this.projections.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...parameters, Math.max(1, filter.limit ?? 50))
      .map((row) => parseTaskRow(row));
  }

  /** Every attempt made on a task, oldest first. The task's own history. */
  public attempts(taskId: string): TaskAttempt[] {
    return this.projections.db
      .prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt')
      .all(taskId)
      .map((row) => {
        // lease_token_hash is internal lease-authority evidence, not part of the public attempt.
        const { lease_token_hash: _leaseTokenHash, ...rest } = readObject(row, 'task_attempts row');
        return parseOrThrow(taskAttemptSchema, rest, 'task_attempts row');
      });
  }

  /**
   * The task link for a granted lease, bound to the recognition seal (DEV-P1-28, phase 4).
   *
   * The lease-token hash is `hashText` of the bearer token the claimer holds — the same value the
   * registry persisted for this attempt — so a downstream artifact can be proven to have been produced
   * by work this exact lease authorised. `recognitionSeal` is the graph registry's `spineSeal(...)`.
   */
  public spineLink(leased: LeasedTask, recognitionSeal: BindingHash): TaskLink {
    return {
      stage: 'task',
      boundTo: recognitionSeal,
      taskId: requireSpineId(leased.task.id, 'TaskId'),
      attempt: leased.attempt,
      leaseTokenHash: requireSpineHash(hashText(leased.leaseToken), 'LeaseTokenHash'),
      leaseExpiry: leased.leaseExpiresAt,
    };
  }

  /** The sealed binding hash of the task link — the value the context stage binds to. */
  public spineSeal(leased: LeasedTask, recognitionSeal: BindingHash): BindingHash {
    return sealEvidenceLink(this.spineLink(leased, recognitionSeal));
  }

  /**
   * Verifies a presented task link against both its recognition predecessor and this registry's own
   * durable attempt history (DEV-P1-28, phase 4).
   *
   * Two independent checks. The link must bind to the given recognition run — recomputed, so a
   * recognition altered after the fact is caught — and its lease-token hash must match the hash this
   * registry recorded for that task's attempt. A link cannot claim an attempt that never ran, nor
   * present a lease token the registry never issued for that attempt.
   */
  public verifyTaskLink(link: TaskLink, recognitionLink: RecognitionLink): void {
    verifyEvidenceLink(link, recognitionLink);
    const storedHash = this.attemptLeaseHash(link.taskId, link.attempt);
    if (storedHash === null) {
      throw new EvidenceChainError(
        `task link references attempt ${link.attempt} of ${link.taskId}, which this registry never recorded`,
      );
    }
    if (storedHash !== link.leaseTokenHash) {
      throw new EvidenceChainError(
        `task link lease hash does not match the recorded lease of attempt ${link.attempt} of ${link.taskId}`,
      );
    }
  }

  /** The durable lease-token hash recorded for one attempt, or null if that attempt was never recorded. */
  private attemptLeaseHash(taskId: string, attempt: number): string | null {
    const row = this.projections.db
      .prepare('SELECT lease_token_hash FROM task_attempts WHERE task_id = ? AND attempt = ?')
      .get(taskId, attempt);
    if (row === undefined) return null;
    const value = readObject(row, 'task_attempts row')['lease_token_hash'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  public stats(): QueueStats {
    const byState: Record<string, number> = {};
    for (const row of this.projections.db
      .prepare('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state')
      .all()) {
      const record = readObject(row, 'state count row');
      byState[readString(record, 'state')] = readNumber(record, 'n');
    }

    const byLane: Record<string, number> = {};
    for (const row of this.projections.db
      .prepare(
        "SELECT lane, COUNT(*) AS n FROM tasks WHERE state IN ('pending','blocked','leased') GROUP BY lane",
      )
      .all()) {
      const record = readObject(row, 'lane count row');
      byLane[readString(record, 'lane')] = readNumber(record, 'n');
    }

    const oldest = this.projections.db
      .prepare(
        `SELECT (julianday('now') - julianday(MIN(created_at))) * 86400.0 AS age
           FROM tasks WHERE state = 'pending'`,
      )
      .get();
    const ageValue = readObject(oldest ?? {}, 'age row')['age'];

    const expiring = this.projections.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE state = 'leased' AND lease_expires_at <= datetime('now', '+60 seconds')`,
      )
      .get();

    const spent = this.projections.db
      .prepare('SELECT COALESCE(SUM(spent), 0) AS total FROM tasks')
      .get();

    return {
      byState,
      byLane,
      oldestPendingAgeSeconds: typeof ageValue === 'number' ? Math.round(ageValue) : null,
      leasedExpiringWithinMinute: readNumber(readObject(expiring, 'expiring row'), 'n'),
      totalSpent: readNumber(readObject(spent, 'spent row'), 'total'),
    };
  }

  /* ------------------------------ internals --------------------------- */

  private requireTask(taskId: string): TaskRecord {
    const task = this.get(taskId);
    if (task === null) throw new Error(`Unknown task ${taskId}`);
    return task;
  }

  /**
   * Validates a task's declared dependencies before it is created.
   *
   * A dependency the queue cannot satisfy is worse than no dependency: a task blocked on a
   * non-existent id waits forever, and a task that depends on itself — directly or through a
   * cycle — can never unblock. Rejecting these at creation keeps the queue from admitting work
   * it can prove will never run. Duplicates are folded away rather than rejected.
   */
  private validateDependencies(taskId: string, requested: readonly string[]): readonly string[] {
    const dependencies = [...new Set(requested)];
    if (dependencies.includes(taskId)) {
      throw new Error(`Task ${taskId} cannot depend on itself`);
    }
    for (const dependency of dependencies) {
      if (this.get(dependency) === null) {
        throw new Error(`Task ${taskId} depends on unknown task ${dependency}`);
      }
    }
    for (const dependency of dependencies) {
      // A cycle exists if a dependency already reaches this task through the graph. A freshly
      // created task has no dependents, so this cannot fire today; it holds the invariant for
      // any future path that adds dependencies to an existing task.
      if (this.dependsOnTransitively(dependency, taskId)) {
        throw new Error(`Task ${taskId} -> ${dependency} would create a dependency cycle`);
      }
    }
    return dependencies;
  }

  /** Whether `start` depends on `target`, following dependency edges transitively. */
  private dependsOnTransitively(start: string, target: string): boolean {
    const select = this.projections.db.prepare(
      'SELECT depends_on FROM task_dependencies WHERE task_id = ?',
    );
    const seen = new Set<string>();
    const stack: string[] = [start];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const row of select.all(current)) {
        stack.push(readString(readObject(row, 'task_dependencies row'), 'depends_on'));
      }
    }
    return false;
  }

  /**
   * Reads and validates a worker's live lease without changing SQLite.
   *
   * The returned predecessor fields are copied into the authoritative transition event. The event's
   * projector performs the compare-and-swap after the event is durable, inside the projection
   * transaction. This separation is the INT-P0-01 correction: decision reads may consult SQLite, but
   * no task state becomes visible there before its governing event exists.
   */
  private inspectLiveLease(
    taskId: string,
    worker: string,
    leaseToken: string,
    now: string,
  ):
    | {
        readonly ok: true;
        readonly attempt: number;
        readonly maxAttempts: number;
        readonly failedAttemptCount: number;
        readonly expiresAt: string;
        readonly tokenHash: string;
      }
    | { readonly ok: false; readonly reason: string } {
    const row = this.projections.db
      .prepare(
        `SELECT state, lease_owner, lease_expires_at, lease_token_hash, attempts,
                max_attempts, failed_attempt_count
           FROM tasks WHERE id = ?`,
      )
      .get(taskId);

    if (row === undefined) return { ok: false, reason: `Unknown task ${taskId}` };

    const record = readObject(row, 'tasks row');
    const reason = this.describeLeaseFailure(taskId, record, worker, now, leaseToken);
    if (reason !== null) return { ok: false, reason };

    const expiresAt = readOptionalString(record, 'lease_expires_at');
    const tokenHash = readOptionalString(record, 'lease_token_hash');
    if (expiresAt === null || tokenHash === null) {
      return { ok: false, reason: `Task ${taskId} has an incomplete live lease` };
    }

    return {
      ok: true,
      attempt: readNumber(record, 'attempts'),
      maxAttempts: readNumber(record, 'max_attempts'),
      failedAttemptCount: readNumber(record, 'failed_attempt_count'),
      expiresAt,
      tokenHash,
    };
  }

  /** Explains, from the task's current row, why a worker's lease is not authoritative. */
  private describeLeaseFailure(
    taskId: string,
    record: Record<string, unknown>,
    worker: string,
    now: string,
    leaseToken?: string,
  ): string | null {
    const state = readString(record, 'state');
    if (state !== 'leased') return `Task ${taskId} is ${state}, not leased`;
    const owner = readOptionalString(record, 'lease_owner');
    if (owner !== worker) {
      return `Task ${taskId} is leased by ${owner ?? 'nobody'}, not by ${worker}`;
    }
    const expiresAt = readOptionalString(record, 'lease_expires_at');
    if (expiresAt === null || expiresAt <= now) {
      return `Task ${taskId} lease for ${worker} has expired`;
    }
    if (
      leaseToken !== undefined &&
      readOptionalString(record, 'lease_token_hash') !== hashText(leaseToken)
    ) {
      return `Task ${taskId} lease token for ${worker} does not match the current lease`;
    }
    return null;
  }

  /** Replays any committed event prefix before using SQLite as the basis for a command decision. */
  private syncForDecision(): void {
    this.projections.sync(this.log);
  }

  /** Appends authority first; only a committed event may then alter the projection. */
  private appendAndSync(type: string, payload: unknown, subjectId: string | null): void {
    this.append(type, payload, subjectId);
    this.projections.sync(this.log);
  }

  private nextSequence(): number {
    const row = this.projections.db.prepare('SELECT MAX(id) AS max_id FROM tasks').get();
    const value = readObject(row ?? {}, 'max row')['max_id'];
    if (typeof value !== 'string') return 1;
    const parsed = Number.parseInt(value.slice('TASK-'.length), 10);
    return Number.isSafeInteger(parsed) ? parsed + 1 : 1;
  }

  private append(type: string, payload: unknown, subjectId: string | null): void {
    this.log.append({
      type,
      actor: 'daemon',
      missionVersion: this.missionVersion(),
      subjectId,
      payload,
    });
  }
}

/* ------------------------------------------------------------------------- */
/* Row reading                                                                */
/* ------------------------------------------------------------------------- */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function readObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected an object for ${context}`);
  }
  return value as Record<string, unknown>;
}

function hasOwnField(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function readStringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Expected string-array field "${field}"`);
  }
  return [...value] as string[];
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Expected string field "${field}"`);
  return value;
}

function readOptionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number') throw new Error(`Expected numeric field "${field}"`);
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' ? value : null;
}


function readTaskState(record: Record<string, unknown>, field: string): TaskState {
  const value = readString(record, field);
  switch (value) {
    case 'pending':
    case 'blocked':
    case 'leased':
    case 'completed':
    case 'failed':
    case 'dead':
    case 'cancelled':
      return value;
    default:
      throw new Error(`Expected task-state field "${field}"`);
  }
}

function readOptionalTaskState(
  record: Record<string, unknown>,
  field: string,
): TaskState | null {
  if (!hasOwnField(record, field) || record[field] === null) return null;
  return readTaskState(record, field);
}

function readAttemptOutcome(record: Record<string, unknown>, field: string): AttemptOutcome {
  const value = readString(record, field);
  switch (value) {
    case 'completed':
    case 'failed':
    case 'expired':
    case 'abandoned':
      return value;
    default:
      throw new Error(`Expected attempt-outcome field "${field}"`);
  }
}

function readOptionalTransitionAuthority(
  record: Record<string, unknown>,
  field: string,
): TaskTransitionAuthority | null {
  if (!hasOwnField(record, field) || record[field] === null) return null;
  const value = readString(record, field);
  switch (value) {
    case 'lease':
    case 'administrative':
    case 'expiry':
      return value;
    default:
      throw new Error(`Expected task-transition authority field "${field}"`);
  }
}

function assertProjectedTransition(changes: number, eventType: string, taskId: string): void {
  if (changes !== 1) {
    throw new Error(
      `Projection predecessor mismatch while applying ${eventType} for ${taskId}: ` +
        `expected exactly one row, changed ${changes}.`,
    );
  }
}
