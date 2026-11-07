/**
 * CLUE console ledger.
 *
 * Spec: CLUE_implementation.md §14.1 (artifact store), §41 (validated records).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.3, Part IX §39-43 — the console
 *           ledger, attribution, the taxonomy, and what "clean" means.
 * Audit: v2.1 §3.4.
 *
 * What Murugan says while it is running, kept as evidence.
 *
 * This is the first source of *observed* fact in the whole system. Every metric before
 * it reads structure and forms a suspicion; a console error says something went wrong,
 * at a named line, during a named action, and it arrives with a falsifier already
 * attached — *this no longer occurs in this scenario*. That is exactly the shape a proof
 * contract needs, which is why the first pilot target may well come from here rather
 * than from a static ranking.
 *
 * Four properties make the ledger usable rather than merely full.
 *
 * **Deduplication is essential, not cosmetic.** A warning emitted once per frame would
 * drown everything else within a minute. Entries collapse to a signature — the
 * normalised message plus the topmost project frame — carrying an occurrence count and
 * a rate. Rate is kept because it is diagnostic: once per session and once per frame are
 * different problems with different urgencies, and a bare count hides which one you have.
 *
 * **Normalisation is lossy, so the original is kept.** "failed to load tile 47" and
 * "tile 92" must collapse to one signature, which means throwing away the number. A
 * sample of the exact text is stored alongside, because the number is sometimes the
 * whole story.
 *
 * **Unattributable entries are kept and counted.** Source maps will sometimes fail —
 * a callback inside `requestAnimationFrame` with a collapsed stack is the classic case.
 * An unattributable console error is still a real defect, and discarding what cannot be
 * filed turns the ledger into an inventory of the easy half of the problem.
 *
 * **Intentional is declared, never inferred.** FrameDoctor, the HUD, and CLUE's own
 * probes are supposed to speak. Marking their output as intentional is a recorded
 * decision with a reason, not a pattern the ledger guesses at — otherwise "clean" would
 * quietly come to mean "we stopped counting the noisy ones".
 *
 * ---
 *
 * **Residue, stated rather than hidden (`DEV-P1-21`, run binding).** Batches bind to
 * snapshot, scenario and checkpoint; they do not bind to a run, because there is no run
 * to name. `src/cycle/` does not exist and nothing issues a `RUN-` identity. A `run_id`
 * column that is null by construction would make the binding *look* closed while
 * recording nothing — the same shape this module already refused for scenario counting,
 * where a derived number existed precisely so replay could not inflate it. When
 * `src/cycle/` lands, the binding follows the checkpoint's pattern exactly: a nullable
 * column on `console_batches`, the id threaded through `beginSession`, a
 * `PROJECTION_SCHEMA_VERSION` bump, and a CLI supplier so the binding is fillable rather
 * than decorative. This is the recorder's `-23` shape: correlatable today, bound the day
 * a run exists. Decision recorded 2026-08-09 (Creator-delegated).
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';

import { hashText, nowIso } from '../../shared/ids.js';
import { parseOrThrow } from '../../shared/schemas.js';
import type { ArtifactStore } from '../../memory/artifactStore.js';
import type { EventLog } from '../../memory/eventLog.js';
import type { ProjectionStore, Projector } from '../../memory/db.js';
import type { ConsoleSignatureSummary } from '../../analysis/metrics/families.js';

type Db = Database.Database;

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug' | 'log';

/**
 * The four buckets of Part IX §41.
 *
 *   actionable    attributed to a Murugan unit — blocks a clean console
 *   unclassified  not yet triaged — also blocks, because unknown is not the same as fine
 *   external      a dependency or the browser itself — counted, listed, does not block
 *   intentional   a declared diagnostic — declaration recorded, does not block
 */
export type ConsoleClassification = 'actionable' | 'external' | 'intentional' | 'unclassified';

export type AttributionOutcome = 'attributed' | 'external' | 'unattributable';

export interface StackFrame {
  readonly url: string;
  readonly line: number;
  readonly column: number;
  readonly functionName: string | null;
}

/** What the collector produces, before any interpretation. */
export interface RawConsoleEntry {
  readonly level: ConsoleLevel;
  readonly text: string;
  readonly frames: readonly StackFrame[];
  readonly timestamp: string;
  readonly scenarioId?: string | null;
  readonly stepIndex?: number | null;
  readonly checkpointId?: string | null;
}

/** What the attribution pass concludes about one entry's stack. */
export interface AttributionResult {
  readonly outcome: AttributionOutcome;
  /** Logical id of the unit the top project frame resolved to, when there is one. */
  readonly logicalId: string | null;
  readonly path: string | null;
  readonly line: number | null;
  /** Why attribution ended where it did. Present even on success. */
  readonly detail: string;
}

/** Supplied by the attribution module. Absent before Stage G1's source-map pass exists. */
export type Attributor = (entry: RawConsoleEntry) => AttributionResult;

/** The honest default: nothing is attributed, and the ledger says so per entry. */
export const NO_ATTRIBUTION: Attributor = () => ({
  outcome: 'unattributable',
  logicalId: null,
  path: null,
  line: null,
  detail: 'no attributor configured; source-map resolution has not run',
});

/**
 * A declared diagnostic surface.
 *
 * Matching moves an entry to `intentional`, which excludes it from the clean-console
 * criterion. Every declaration carries a reason, and the reason is stored with every
 * signature it silences, so an audit of "what are we not counting" is one query.
 */
export interface IntentionalDeclaration {
  readonly id: string;
  readonly reason: string;
  /** Matched against the raw text, case-insensitively. */
  readonly textPrefixes?: readonly string[];
  readonly textPatterns?: readonly RegExp[];
  /** Matched against the attributed logical id. */
  readonly unitPatterns?: readonly RegExp[];
}

/* ------------------------------------------------------------------------- */
/* Records                                                                    */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const consoleSessionSchema = z
  .object({
    id: z.string().regex(/^CSESS-[0-9]{6,}$/),
    started_at: isoTime,
    ended_at: isoTime.nullable(),
    snapshot_id: sha256.nullable(),
    scenario_id: z.string().nullable(),
    /** Where the browser was pointed. `shadow` for measurement, `canonical` never. */
    origin: z.enum(['shadow', 'external']),
    /**
     * The newest ingested batch, and only that.
     *
     * `DEV-P1-21`: it was documented as "the full raw entry log for this session" and never
     * was — every ingest overwrote it. `console_batches` is the manifest; this stays because
     * the session row is what the console reads for a one-line summary.
     */
    raw_log_hash: sha256.nullable(),
    entry_count: z.number().int().nonnegative(),
    signature_count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    warning_count: z.number().int().nonnegative(),
    unattributable_count: z.number().int().nonnegative(),
  })
  .strict();

export type ConsoleSessionRecord = z.infer<typeof consoleSessionSchema>;

export const consoleSignatureSchema = z
  .object({
    signature: sha256,
    level: z.enum(['error', 'warning', 'info', 'debug', 'log']),
    /** The message with varying parts removed. What deduplication compares. */
    normalised_text: z.string().min(1),
    /** One exact original. The removed number is sometimes the whole story. */
    sample_text: z.string().min(1),
    classification: z.enum(['actionable', 'external', 'intentional', 'unclassified']),
    /** Set when a declared diagnostic silenced this signature. */
    intentional_reason: z.string().nullable(),
    attribution_outcome: z.enum(['attributed', 'external', 'unattributable']),
    attributed_to: z.string().nullable(),
    attributed_path: z.string().nullable(),
    attributed_line: z.number().int().positive().nullable(),
    attribution_detail: z.string().min(1),
    top_frame: z.string().nullable(),
    first_seen_at: isoTime,
    last_seen_at: isoTime,
    occurrences: z.number().int().nonnegative(),
    session_count: z.number().int().nonnegative(),
    scenario_count: z.number().int().nonnegative(),
    /** Whether a human has looked at it. Untriaged is not the same as harmless. */
    triaged: z.boolean(),
  })
  .strict();

export type ConsoleSignatureRecord = z.infer<typeof consoleSignatureSchema>;

/**
 * One ingested batch of raw entries — `DEV-P1-21`.
 *
 * The obligation asks for an *immutable ordered raw-batch manifest*, and there was one
 * pointer instead: `console_sessions.raw_log_hash`, overwritten by every ingest. Measured
 * on the running ledger, a session that ingested twice reported `entry_count = 2` while
 * `rawEntries()` could return one — the first batch's artifact survived in the store with
 * nothing pointing at it, so the evidence existed and was unreachable. Batches also had no
 * order: even had both hashes been kept, nothing recorded which came first.
 *
 * `sequence` is per session and dense from 1. It is the manifest's ordering and it is
 * assigned once, at ingest, from the batches already recorded — never recomputed from
 * timestamps, which two batches inside one millisecond would tie.
 */
export const consoleBatchSchema = z
  .object({
    session_id: z.string().regex(/^CSESS-[0-9]{6,}$/),
    /** Position within the session, from 1. */
    sequence: z.number().int().positive(),
    captured_at: isoTime,
    /** The whole batch, exactly as collected, before any deduplication. */
    artifact_hash: sha256,
    entry_count: z.number().int().nonnegative(),
  })
  .strict();

export type ConsoleBatchRecord = z.infer<typeof consoleBatchSchema>;

/**
 * One recorded state of a signature's attribution — `DEV-P1-21`.
 *
 * The obligation asks that *all attribution revisions* be preserved. They were, in exactly
 * one place nothing could reach: the append-only event log. Every `signature_observed`
 * event carries the full attribution of that observation, and the projector overwrote
 * `attribution_outcome`, `attributed_to`, `attributed_path`, `attributed_line` and
 * `attribution_detail` on conflict. Measured: three observations progressing from
 * unattributable to attributed left one row saying `attributed`, three raw NDJSON lines,
 * and no way to ask whether attribution had ever changed — a rebuild reproduced only the
 * last, because last writer wins under replay too.
 *
 * A revision is a *change*, not an observation. A signature seen a thousand times with the
 * same attribution has one revision; the occurrence count is where repetition is recorded.
 * Comparison is against the latest revision only, so an attribution that goes A to B and
 * back to A records three revisions — returning to a previous answer is itself a change,
 * and flattening it would lose the fact that B was ever believed.
 */
export const consoleAttributionSchema = z
  .object({
    signature: sha256,
    /** Position in this signature's history, from 1. */
    revision: z.number().int().positive(),
    observed_at: isoTime,
    /** The session whose ingest produced this attribution. */
    session_id: z.string().regex(/^CSESS-[0-9]{6,}$/),
    attribution_outcome: z.enum(['attributed', 'external', 'unattributable']),
    attributed_to: z.string().nullable(),
    attributed_path: z.string().nullable(),
    attributed_line: z.number().int().positive().nullable(),
    attribution_detail: z.string().min(1),
  })
  .strict();

export type ConsoleAttributionRecord = z.infer<typeof consoleAttributionSchema>;

export interface SessionIngestResult {
  readonly sessionId: string;
  readonly entriesIngested: number;
  readonly signaturesTouched: number;
  readonly newSignatures: readonly string[];
  readonly byClassification: Readonly<Record<ConsoleClassification, number>>;
}

export interface CleanlinessReport {
  readonly scope: string;
  /** Zero actionable and zero unclassified across the scope. */
  readonly clean: boolean;
  readonly actionable: number;
  readonly unclassified: number;
  readonly external: number;
  readonly intentional: number;
  /** The signatures standing between the scope and a clean console. */
  readonly blocking: readonly ConsoleSignatureRecord[];
  /** The sentence that must accompany any clean claim. */
  readonly qualifier: string;
}

const CLEANLINESS_QUALIFIER =
  'A clean console means zero actionable and zero unclassified signatures across the ' +
  'scenarios exercised, with every excluded entry excluded by a recorded decision. It is ' +
  'not a claim that the application emits nothing.';

/* ------------------------------------------------------------------------- */
/* Events and schema                                                          */
/* ------------------------------------------------------------------------- */

export const CONSOLE_EVENT_TYPES = {
  sessionStarted: 'console.session_started',
  sessionEnded: 'console.session_ended',
  batchRecorded: 'console.batch_recorded',
  signatureObserved: 'console.signature_observed',
  signatureClassified: 'console.signature_classified',
} as const;

export const CONSOLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS console_sessions (
  id                   TEXT PRIMARY KEY,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  snapshot_id          TEXT,
  scenario_id          TEXT,
  origin               TEXT NOT NULL,
  raw_log_hash         TEXT,
  entry_count          INTEGER NOT NULL,
  signature_count      INTEGER NOT NULL,
  error_count          INTEGER NOT NULL,
  warning_count        INTEGER NOT NULL,
  unattributable_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS console_sessions_snapshot ON console_sessions(snapshot_id);

-- The raw-batch manifest: every batch ingested into a session, in the order it arrived.
--
-- DEV-P1-21. Immutable in the sense that matters: the projector inserts and never updates,
-- so a recorded batch cannot be re-pointed at different bytes. That is a property of the
-- projector rather than of SQLite, which is why the DO NOTHING there is load-bearing and
-- not defensive noise.
--
-- console_sessions.raw_log_hash remains, and now means only what it can mean: the newest
-- batch. This table is the authority for what a session collected.
CREATE TABLE IF NOT EXISTS console_batches (
  session_id    TEXT NOT NULL,
  sequence      INTEGER NOT NULL,
  captured_at   TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  entry_count   INTEGER NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
CREATE INDEX IF NOT EXISTS console_batches_artifact ON console_batches(artifact_hash);

CREATE TABLE IF NOT EXISTS console_signatures (
  signature           TEXT PRIMARY KEY,
  level               TEXT NOT NULL,
  normalised_text     TEXT NOT NULL,
  sample_text         TEXT NOT NULL,
  classification      TEXT NOT NULL,
  intentional_reason  TEXT,
  attribution_outcome TEXT NOT NULL,
  attributed_to       TEXT,
  attributed_path     TEXT,
  attributed_line     INTEGER,
  attribution_detail  TEXT NOT NULL,
  top_frame           TEXT,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  occurrences         INTEGER NOT NULL,
  session_count       INTEGER NOT NULL,
  scenario_count      INTEGER NOT NULL,
  triaged             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS console_signatures_class ON console_signatures(classification);
CREATE INDEX IF NOT EXISTS console_signatures_unit  ON console_signatures(attributed_to);

-- Every attribution a signature has been given, in order. DEV-P1-21.
--
-- console_signatures carries the current answer; this carries how it was arrived at. The
-- rows are derived from console.signature_observed, which already carried the whole
-- progression, so no new event was needed - only somewhere for it to land that a query can
-- reach. Insert-only, like console_batches: a revision that could be edited would be a
-- record of the present rather than of the past.
CREATE TABLE IF NOT EXISTS console_attributions (
  signature           TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  observed_at         TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  attribution_outcome TEXT NOT NULL,
  attributed_to       TEXT,
  attributed_path     TEXT,
  attributed_line     INTEGER,
  attribution_detail  TEXT NOT NULL,
  PRIMARY KEY (signature, revision)
);

-- Which signatures appeared in which session, in which scenario, at which checkpoint,
-- with counts. The join that turns a lifetime total into a per-session rate.
--
-- DEV-P1-21: the key includes the scenario and the checkpoint, and it included neither. It was
-- PRIMARY KEY (session_id, signature), so one session that saw a signature in two
-- scenarios kept one row and the second scenario was silently discarded - measured:
-- boot then combat produced scenario=SCEN-boot occurrences=3, and scenario_count,
-- derived as COUNT(DISTINCT scenario_id) precisely so replay could not inflate it,
-- reported 1 instead of 2. A signature that reproduces in two scenarios and one that
-- reproduces in one are different findings with different urgencies, which is the same
-- reason occurrence rate is kept beside occurrence count. The checkpoint is the same
-- argument one level finer: a warning at every checkpoint of a scenario and a warning at
-- one of them are different problems, and only the second is a lead.
--
-- A unique index over ifnull(...) rather than a wider PRIMARY KEY, because SQLite treats
-- NULLs as distinct in a unique constraint: entries with no scenario or no checkpoint would
-- each have inserted a fresh row and their counts would have fragmented. The columns keep
-- NULL for absence — no sentinel is written — while the index treats absence as the one
-- bucket it truthfully is.
CREATE TABLE IF NOT EXISTS console_sightings (
  session_id    TEXT NOT NULL,
  signature     TEXT NOT NULL,
  scenario_id   TEXT,
  checkpoint_id TEXT,
  occurrences   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS console_sightings_key
  ON console_sightings(
    session_id, signature, ifnull(scenario_id, ''), ifnull(checkpoint_id, ''));
CREATE INDEX IF NOT EXISTS console_sightings_signature ON console_sightings(signature);
`;

export function ensureConsoleSchema(db: Db): void {
  db.exec(CONSOLE_SCHEMA_SQL);
}

export const CONSOLE_PROJECTORS: Readonly<Record<string, Projector>> = {
  [CONSOLE_EVENT_TYPES.sessionStarted]: (db, record) => {
    const session = parseOrThrow(consoleSessionSchema, record.payload, 'console.session_started');
    db.prepare(
      `INSERT INTO console_sessions (
         id, started_at, ended_at, snapshot_id, scenario_id, origin, raw_log_hash,
         entry_count, signature_count, error_count, warning_count, unattributable_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      session.id,
      session.started_at,
      session.ended_at,
      session.snapshot_id,
      session.scenario_id,
      session.origin,
      session.raw_log_hash,
      session.entry_count,
      session.signature_count,
      session.error_count,
      session.warning_count,
      session.unattributable_count,
    );
  },

  [CONSOLE_EVENT_TYPES.sessionEnded]: (db, record) => {
    const session = parseOrThrow(consoleSessionSchema, record.payload, 'console.session_ended');
    db.prepare(
      `UPDATE console_sessions
          SET ended_at = ?, raw_log_hash = ?, entry_count = ?, signature_count = ?,
              error_count = ?, warning_count = ?, unattributable_count = ?
        WHERE id = ?`,
    ).run(
      session.ended_at,
      session.raw_log_hash,
      session.entry_count,
      session.signature_count,
      session.error_count,
      session.warning_count,
      session.unattributable_count,
      session.id,
    );
  },

  [CONSOLE_EVENT_TYPES.batchRecorded]: (db, record) => {
    const batch = parseOrThrow(consoleBatchSchema, record.payload, 'console.batch_recorded');
    // DO NOTHING rather than DO UPDATE, and that is the immutability. A replay of the same
    // event is a no-op; an event claiming a sequence another batch already holds cannot
    // overwrite it. The projection can only ever be re-derived into the same shape.
    db.prepare(
      `INSERT INTO console_batches (session_id, sequence, captured_at, artifact_hash, entry_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, sequence) DO NOTHING`,
    ).run(
      batch.session_id,
      batch.sequence,
      batch.captured_at,
      batch.artifact_hash,
      batch.entry_count,
    );
  },

  [CONSOLE_EVENT_TYPES.signatureObserved]: (db, record) => {
    const payload = readObject(record.payload, 'console.signature_observed');
    const signature = parseOrThrow(
      consoleSignatureSchema,
      payload['signature_record'],
      'signature record',
    );
    const sessionId = readString(payload, 'session_id');
    const occurrences = readNumber(payload, 'occurrences');

    db.prepare(
      `INSERT INTO console_signatures (
         signature, level, normalised_text, sample_text, classification, intentional_reason,
         attribution_outcome, attributed_to, attributed_path, attributed_line,
         attribution_detail, top_frame, first_seen_at, last_seen_at, occurrences,
         session_count, scenario_count, triaged)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signature) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         occurrences = console_signatures.occurrences + excluded.occurrences,
         sample_text = console_signatures.sample_text,
         classification = CASE
           WHEN console_signatures.triaged = 1 THEN console_signatures.classification
           ELSE excluded.classification END,
         attribution_outcome = excluded.attribution_outcome,
         attributed_to = excluded.attributed_to,
         attributed_path = excluded.attributed_path,
         attributed_line = excluded.attributed_line,
         attribution_detail = excluded.attribution_detail`,
    ).run(
      signature.signature,
      signature.level,
      signature.normalised_text,
      signature.sample_text,
      signature.classification,
      signature.intentional_reason,
      signature.attribution_outcome,
      signature.attributed_to,
      signature.attributed_path,
      signature.attributed_line,
      signature.attribution_detail,
      signature.top_frame,
      signature.first_seen_at,
      signature.last_seen_at,
      occurrences,
      1,
      signature.scenario_count,
      signature.triaged ? 1 : 0,
    );

    db.prepare(
      `INSERT INTO console_sightings (
         session_id, signature, scenario_id, checkpoint_id, occurrences)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, signature, ifnull(scenario_id, ''), ifnull(checkpoint_id, ''))
         DO UPDATE SET occurrences = console_sightings.occurrences + excluded.occurrences`,
    ).run(
      sessionId,
      signature.signature,
      readOptionalString(payload, 'scenario_id'),
      readOptionalString(payload, 'checkpoint_id'),
      occurrences,
    );

    // Derived rather than incremented, so a replay cannot inflate it.
    //
    // DEV-P1-21: `session_count` counts distinct sessions, not rows, and `scenario_count`
    // distinct scenarios. Rows fan out by scenario and checkpoint, so `COUNT(*)` would have
    // reported a signature seen twice in one session — once per scenario, or twice at two
    // checkpoints of one scenario — as two sessions. Widening the sighting key without
    // widening these would trade a silent undercount for a silent overcount.
    db.prepare(
      `UPDATE console_signatures SET
         session_count = (SELECT COUNT(DISTINCT session_id) FROM console_sightings
                           WHERE signature = ?),
         scenario_count = (SELECT COUNT(DISTINCT scenario_id) FROM console_sightings
                            WHERE signature = ? AND scenario_id IS NOT NULL)
       WHERE signature = ?`,
    ).run(signature.signature, signature.signature, signature.signature);

    // DEV-P1-21: the attribution history.
    //
    // Compared against the latest revision only. An unchanged attribution adds nothing —
    // repetition is what `occurrences` records — while a changed one, including a return to
    // an earlier answer, is appended. Both the comparison and the revision number come from
    // rows this projector wrote, so replaying the same events reproduces the same history.
    const previous = db
      .prepare(
        `SELECT revision, attribution_outcome, attributed_to, attributed_path,
                attributed_line, attribution_detail
           FROM console_attributions
          WHERE signature = ?
          ORDER BY revision DESC
          LIMIT 1`,
      )
      .get(signature.signature);

    const previousRow = previous === undefined ? null : readObject(previous, 'console_attributions row');
    const unchanged =
      previousRow !== null &&
      previousRow['attribution_outcome'] === signature.attribution_outcome &&
      (previousRow['attributed_to'] ?? null) === signature.attributed_to &&
      (previousRow['attributed_path'] ?? null) === signature.attributed_path &&
      (previousRow['attributed_line'] ?? null) === signature.attributed_line &&
      previousRow['attribution_detail'] === signature.attribution_detail;

    if (!unchanged) {
      const nextRevision =
        previousRow === null ? 1 : (readNumber(previousRow, 'revision') as number) + 1;
      const revision = parseOrThrow(
        consoleAttributionSchema,
        {
          signature: signature.signature,
          revision: nextRevision,
          observed_at: signature.last_seen_at,
          session_id: sessionId,
          attribution_outcome: signature.attribution_outcome,
          attributed_to: signature.attributed_to,
          attributed_path: signature.attributed_path,
          attributed_line: signature.attributed_line,
          attribution_detail: signature.attribution_detail,
        },
        'console attribution revision',
      );
      db.prepare(
        `INSERT INTO console_attributions (
           signature, revision, observed_at, session_id, attribution_outcome,
           attributed_to, attributed_path, attributed_line, attribution_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(signature, revision) DO NOTHING`,
      ).run(
        revision.signature,
        revision.revision,
        revision.observed_at,
        revision.session_id,
        revision.attribution_outcome,
        revision.attributed_to,
        revision.attributed_path,
        revision.attributed_line,
        revision.attribution_detail,
      );
    }
  },

  [CONSOLE_EVENT_TYPES.signatureClassified]: (db, record) => {
    const payload = readObject(record.payload, 'console.signature_classified');
    db.prepare(
      `UPDATE console_signatures
          SET classification = ?, intentional_reason = ?, triaged = 1
        WHERE signature = ?`,
    ).run(
      readString(payload, 'classification'),
      readOptionalString(payload, 'reason'),
      readString(payload, 'signature'),
    );
  },
};

/* ------------------------------------------------------------------------- */
/* Normalisation and signatures                                               */
/* ------------------------------------------------------------------------- */

/**
 * Removes the parts of a message that vary between occurrences of the same problem.
 *
 * Numbers, hex ids, UUIDs, timestamps, blob and object URLs, and quoted line references
 * all collapse to placeholders. The result is what deduplication compares; the original
 * is stored beside it, because a message is sometimes only interesting for the number
 * that was removed.
 */
export function normaliseMessage(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '«uuid»')
    .replace(/\b0x[0-9a-f]+\b/gi, '«hex»')
    .replace(/\bblob:[^\s'"]+/gi, '«blob»')
    .replace(/\b[a-z]+:\/\/[^\s'"]+/gi, '«url»')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '«time»')
    .replace(/:\d+:\d+/g, ':«pos»')
    .replace(/-?\b\d+(\.\d+)?\b/g, '«n»')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/**
 * Identity of a recurring message.
 *
 * The normalised text plus the topmost project frame. Including the frame matters: the
 * same generic message emitted from two places is two problems, and merging them would
 * attribute half the occurrences to the wrong unit.
 */
export function signatureOf(normalisedText: string, topFrame: string | null, level: ConsoleLevel): string {
  return hashText(`${level}\0${normalisedText}\0${topFrame ?? ''}`);
}

/** First frame that looks like project code rather than a dependency or the browser. */
export function topProjectFrame(frames: readonly StackFrame[]): StackFrame | null {
  for (const frame of frames) {
    if (frame.url.length === 0) continue;
    if (/node_modules|chrome-extension:|^chrome:|\/\.vite\//i.test(frame.url)) continue;
    return frame;
  }
  return frames[0] ?? null;
}

function matchIntentional(
  entry: RawConsoleEntry,
  attribution: AttributionResult,
  declarations: readonly IntentionalDeclaration[],
): IntentionalDeclaration | null {
  const text = entry.text.toLowerCase();

  for (const declaration of declarations) {
    for (const prefix of declaration.textPrefixes ?? []) {
      if (text.startsWith(prefix.toLowerCase())) return declaration;
    }
    for (const pattern of declaration.textPatterns ?? []) {
      if (pattern.test(entry.text)) return declaration;
    }
    if (attribution.logicalId !== null) {
      for (const pattern of declaration.unitPatterns ?? []) {
        if (pattern.test(attribution.logicalId)) return declaration;
      }
    }
  }
  return null;
}

/**
 * Places an entry in one of the four buckets.
 *
 * `unclassified` is the honest resting place for anything the attribution pass could not
 * resolve. It blocks a clean console for the same reason `actionable` does: an entry
 * nobody can file is not an entry anybody has judged harmless.
 */
export function classifyEntry(
  attribution: AttributionResult,
  intentional: IntentionalDeclaration | null,
): { classification: ConsoleClassification; reason: string | null } {
  if (intentional !== null) {
    return { classification: 'intentional', reason: `${intentional.id}: ${intentional.reason}` };
  }
  switch (attribution.outcome) {
    case 'attributed':
      return { classification: 'actionable', reason: null };
    case 'external':
      return { classification: 'external', reason: null };
    default:
      return { classification: 'unclassified', reason: null };
  }
}

/* ------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* ------------------------------------------------------------------------- */

export interface ConsoleLedgerDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  readonly missionVersion: () => string;
  readonly attributor?: Attributor;
  readonly intentional?: readonly IntentionalDeclaration[];
}

export interface BeginSessionInput {
  readonly snapshotId?: string | null;
  readonly scenarioId?: string | null;
  /** `shadow` for measurement runs; `external` for a session the Creator drove. */
  readonly origin: 'shadow' | 'external';
}

export class ConsoleLedger {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly artifacts: ArtifactStore;
  private readonly missionVersion: () => string;
  private readonly attributor: Attributor;
  private readonly intentional: readonly IntentionalDeclaration[];

  public constructor(deps: ConsoleLedgerDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.artifacts = deps.artifacts;
    this.missionVersion = deps.missionVersion;
    this.attributor = deps.attributor ?? NO_ATTRIBUTION;
    this.intentional = deps.intentional ?? [];
    ensureConsoleSchema(this.projections.db);
  }

  /* ------------------------------ sessions ---------------------------- */

  public beginSession(input: BeginSessionInput): ConsoleSessionRecord {
    const session = parseOrThrow(
      consoleSessionSchema,
      {
        id: `CSESS-${String(this.nextSessionSequence()).padStart(6, '0')}`,
        started_at: nowIso(),
        ended_at: null,
        snapshot_id: input.snapshotId ?? null,
        scenario_id: input.scenarioId ?? null,
        origin: input.origin,
        raw_log_hash: null,
        entry_count: 0,
        signature_count: 0,
        error_count: 0,
        warning_count: 0,
        unattributable_count: 0,
      },
      'console session',
    );

    this.append(CONSOLE_EVENT_TYPES.sessionStarted, session, session.id);
    this.projections.sync(this.log);
    return session;
  }

  /**
   * Ingests a batch of raw entries.
   *
   * The full raw batch is stored as one artifact before anything is deduplicated, so the
   * lossy parts of normalisation are recoverable. The signature table is an index over
   * that artifact, not a replacement for it.
   */
  public ingest(sessionId: string, entries: readonly RawConsoleEntry[]): SessionIngestResult {
    const timestamp = nowIso();
    const existingSignatures = new Set(
      this.projections.db
        .prepare('SELECT signature FROM console_signatures')
        .all()
        .map((row) => readString(readObject(row, 'console_signatures row'), 'signature')),
    );

    /**
     * DEV-P1-21: keyed by signature **and** scenario, not by signature alone.
     *
     * Grouping on the signature collapsed a batch that saw one problem in two scenarios into
     * a single `signature_observed` event carrying whichever scenario happened to arrive
     * first. Widening the sighting key in the projector would have been half a fix: the
     * second scenario was already gone before the projector ran.
     *
     * The signature remains the unit of deduplication and of identity — `newSignatures`,
     * `signaturesTouched` and the session's `signature_count` all count distinct signatures,
     * because a problem seen in two scenarios is one problem.
     */
    const grouped = new Map<
      string,
      {
        record: ConsoleSignatureRecord;
        occurrences: number;
        scenarioId: string | null;
        checkpointId: string | null;
        signature: string;
      }
    >();
    const byClassification: Record<ConsoleClassification, number> = {
      actionable: 0,
      external: 0,
      intentional: 0,
      unclassified: 0,
    };
    let errors = 0;
    let warnings = 0;
    let unattributable = 0;

    for (const entry of entries) {
      const attribution = this.attributor(entry);
      const declaration = matchIntentional(entry, attribution, this.intentional);
      const { classification, reason } = classifyEntry(attribution, declaration);

      const normalised = normaliseMessage(entry.text);
      const frame = topProjectFrame(entry.frames);
      const frameKey = frame === null ? null : `${frame.url}:${frame.line}:${frame.column}`;
      const signature = signatureOf(normalised, frameKey, entry.level);

      if (entry.level === 'error') errors += 1;
      if (entry.level === 'warning') warnings += 1;
      if (attribution.outcome === 'unattributable') unattributable += 1;
      byClassification[classification] += 1;

      const scenarioId = entry.scenarioId ?? null;
      const checkpointId = entry.checkpointId ?? null;
      const groupKey = `${signature}\u0000${scenarioId ?? ''}\u0000${checkpointId ?? ''}`;
      const existing = grouped.get(groupKey);
      if (existing !== undefined) {
        existing.occurrences += 1;
        continue;
      }

      grouped.set(groupKey, {
        signature,
        occurrences: 1,
        scenarioId,
        checkpointId,
        record: parseOrThrow(
          consoleSignatureSchema,
          {
            signature,
            level: entry.level,
            normalised_text: normalised.length === 0 ? '«empty»' : normalised,
            sample_text: entry.text.slice(0, 2000),
            classification,
            intentional_reason: reason,
            attribution_outcome: attribution.outcome,
            attributed_to: attribution.logicalId,
            attributed_path: attribution.path,
            attributed_line: attribution.line,
            attribution_detail: attribution.detail,
            top_frame: frameKey,
            first_seen_at: timestamp,
            last_seen_at: timestamp,
            occurrences: 1,
            session_count: 1,
            scenario_count: scenarioId === null ? 0 : 1,
            triaged: false,
          },
          `console signature ${signature.slice(0, 12)}`,
        ),
      });
    }

    // Bulk first, index second. A signature that cannot be traced back to the exact text
    // that produced it is a summary, not evidence.
    const rawLog = this.artifacts.putJson(
      { sessionId, capturedAt: timestamp, entries },
      { label: `${sessionId}-console.json` },
    );

    // DEV-P1-21: the batch enters the manifest before the signatures that index it, so
    // there is no ordering in which a signature exists while the bytes behind it do not.
    this.append(
      CONSOLE_EVENT_TYPES.batchRecorded,
      parseOrThrow(
        consoleBatchSchema,
        {
          session_id: sessionId,
          sequence: this.nextBatchSequence(sessionId),
          captured_at: timestamp,
          artifact_hash: rawLog.hash,
          entry_count: entries.length,
        },
        'console batch',
      ),
      sessionId,
    );

    // A signature seen in two scenarios is two sightings but one signature, so the emit
    // loop walks the rows while `newSignatures` stays a set of signatures.
    const seenSignatures = new Set<string>();
    const newSignatures: string[] = [];
    for (const group of grouped.values()) {
      if (!existingSignatures.has(group.signature) && !seenSignatures.has(group.signature)) {
        newSignatures.push(group.signature);
      }
      seenSignatures.add(group.signature);
      this.append(
        CONSOLE_EVENT_TYPES.signatureObserved,
        {
          session_id: sessionId,
          scenario_id: group.scenarioId,
          checkpoint_id: group.checkpointId,
          occurrences: group.occurrences,
          signature_record: group.record,
        },
        sessionId,
      );
    }

    const session = this.session(sessionId);
    if (session !== null) {
      this.append(
        CONSOLE_EVENT_TYPES.sessionEnded,
        {
          ...session,
          ended_at: timestamp,
          raw_log_hash: rawLog.hash,
          entry_count: session.entry_count + entries.length,
          signature_count: session.signature_count + seenSignatures.size,
          error_count: session.error_count + errors,
          warning_count: session.warning_count + warnings,
          unattributable_count: session.unattributable_count + unattributable,
        },
        sessionId,
      );
    }

    this.projections.sync(this.log);

    return {
      sessionId,
      entriesIngested: entries.length,
      signaturesTouched: seenSignatures.size,
      newSignatures,
      byClassification,
    };
  }

  /**
   * Records a human triage decision.
   *
   * Triage is sticky: a later ingest will not silently reclassify a signature the Creator
   * has already judged. The judgement is the point, and an attribution pass improving
   * later should not quietly overturn it.
   *
   * `DEV-P1-21`: the subject is null, and that is the truthful answer rather than a
   * workaround. This used to pass `signature` — a 64-character sha256 — as the event's
   * `subject_id`, which `entityIdSchema` rejected, so every call threw and no signature
   * could ever be triaged. The field is for sequential entity ids; a console signature is
   * content-addressed and has none, the same separation `DEV-P1-05` draws between content
   * identity and location identity. The signature travels in the payload, which is where
   * the projector has always read it from — `subject_id` was never consulted on this event.
   */
  public classify(
    signature: string,
    classification: ConsoleClassification,
    reason: string | null,
  ): void {
    this.append(
      CONSOLE_EVENT_TYPES.signatureClassified,
      { signature, classification, reason },
      null,
    );
    this.projections.sync(this.log);
  }

  /* ------------------------------- queries ---------------------------- */

  public session(sessionId: string): ConsoleSessionRecord | null {
    const row = this.projections.db
      .prepare('SELECT * FROM console_sessions WHERE id = ?')
      .get(sessionId);
    return row === undefined ? null : parseOrThrow(consoleSessionSchema, row, 'console_sessions row');
  }

  public signatures(
    filter: {
      classification?: ConsoleClassification;
      level?: ConsoleLevel;
      attributedTo?: string;
      onlyUntriaged?: boolean;
      limit?: number;
    } = {},
  ): ConsoleSignatureRecord[] {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (filter.classification !== undefined) {
      conditions.push('classification = ?');
      parameters.push(filter.classification);
    }
    if (filter.level !== undefined) {
      conditions.push('level = ?');
      parameters.push(filter.level);
    }
    if (filter.attributedTo !== undefined) {
      conditions.push('attributed_to = ?');
      parameters.push(filter.attributedTo);
    }
    if (filter.onlyUntriaged === true) conditions.push('triaged = 0');

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    return this.projections.db
      .prepare(`SELECT * FROM console_signatures ${where} ORDER BY occurrences DESC LIMIT ?`)
      .all(...parameters, Math.max(1, filter.limit ?? 100))
      .map(readSignatureRow);
  }

  /**
   * The observed-evidence supply for metric screening (DEV-P2-10, Stage G2).
   *
   * `null` when no session has ever been recorded — the application has not been
   * exercised, and the metric family's contract makes that a *stated absence*
   * (`consoleSignatures` omitted → every unit "unavailable: not exercised"), never an
   * empty list masquerading as a clean console. An exercised-but-quiet ledger returns
   * `[]`, which is real evidence of the opposite kind. The distinction lives here, with
   * the owner, so both screening sites (the `metrics` command and the cycle's screening
   * step) consume one contract instead of re-deriving it.
   */
  public observedSummaries(): ConsoleSignatureSummary[] | null {
    const row = readObject(
      this.projections.db.prepare('SELECT COUNT(*) AS n FROM console_sessions').get(),
      'session count row',
    );
    return readNumber(row, 'n') === 0 ? null : this.summaries();
  }

  /**
   * Produces the summaries the observed-defect metric family consumes.
   *
   * The per-session rate is computed here rather than stored, because it is a ratio of
   * two numbers that both keep changing and a stored ratio would be stale the moment
   * either moved.
   */
  public summaries(): ConsoleSignatureSummary[] {
    return this.projections.db
      .prepare(
        `SELECT s.signature AS signature, s.level AS level, s.attributed_to AS attributed_to,
                s.occurrences AS occurrences, s.classification AS classification,
                s.session_count AS session_count, s.scenario_count AS scenario_count
           FROM console_signatures s
          WHERE s.classification IN ('actionable', 'unclassified')`,
      )
      .all()
      .map((row) => {
        const record = readObject(row, 'summary row');
        const occurrences = readNumber(record, 'occurrences');
        const sessions = Math.max(1, readNumber(record, 'session_count'));
        const level = readString(record, 'level');

        return {
          signature: readString(record, 'signature'),
          level: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
          attributedTo: readOptionalString(record, 'attributed_to'),
          occurrences,
          perSessionRate: Number((occurrences / sessions).toFixed(2)),
          scenarioCount: readNumber(record, 'scenario_count'),
          classification: readString(record, 'classification') as ConsoleSignatureSummary['classification'],
        } satisfies ConsoleSignatureSummary;
      });
  }

  /**
   * Whether a scope's console is clean, and what is standing in the way.
   *
   * `external` and `intentional` are counted and reported but do not block, provided each
   * was excluded by a recorded decision. The qualifier travels with the answer so that a
   * clean result is never quietly upgraded into "the application emits nothing".
   */
  public cleanliness(scope = 'all'): CleanlinessReport {
    const counts: Record<ConsoleClassification, number> = {
      actionable: 0,
      external: 0,
      intentional: 0,
      unclassified: 0,
    };

    for (const row of this.projections.db
      .prepare('SELECT classification, COUNT(*) AS n FROM console_signatures GROUP BY classification')
      .all()) {
      const record = readObject(row, 'cleanliness row');
      const key = readString(record, 'classification') as ConsoleClassification;
      counts[key] = readNumber(record, 'n');
    }

    const blocking = this.projections.db
      .prepare(
        `SELECT * FROM console_signatures
          WHERE classification IN ('actionable', 'unclassified')
          ORDER BY level = 'error' DESC, occurrences DESC
          LIMIT 50`,
      )
      .all()
      .map(readSignatureRow);

    return {
      scope,
      clean: counts.actionable === 0 && counts.unclassified === 0,
      actionable: counts.actionable,
      unclassified: counts.unclassified,
      external: counts.external,
      intentional: counts.intentional,
      blocking,
      qualifier: CLEANLINESS_QUALIFIER,
    };
  }

  /** Raw entries of a session, read back from the artifact store. */
  /**
   * Every attribution this signature has been given, oldest first — `DEV-P1-21`.
   *
   * One entry for a signature that has never been re-attributed; more only where the answer
   * actually changed. An empty result means the signature is unknown, not that it has no
   * attribution: every observed signature records revision 1.
   */
  public attributionHistory(signature: string): ConsoleAttributionRecord[] {
    return this.projections.db
      .prepare('SELECT * FROM console_attributions WHERE signature = ? ORDER BY revision')
      .all(signature)
      .map((row) => parseOrThrow(consoleAttributionSchema, row, 'console_attributions row'));
  }

  /**
   * The manifest for a session: every batch it ingested, in the order it arrived.
   *
   * `DEV-P1-21`. Empty for a session that has ingested nothing, which is different from a
   * session that does not exist — `session()` answers that question.
   */
  public batches(sessionId: string): ConsoleBatchRecord[] {
    return this.projections.db
      .prepare('SELECT * FROM console_batches WHERE session_id = ? ORDER BY sequence')
      .all(sessionId)
      .map((row) => parseOrThrow(consoleBatchSchema, row, 'console_batches row'));
  }

  /**
   * Every raw entry the session collected, in ingest order.
   *
   * `DEV-P1-21`: this used to read `session.raw_log_hash` — the newest batch — and return
   * only that. A session that ingested twice reported two entries and could produce one,
   * with the first batch's artifact still in the store and nothing pointing at it. It now
   * walks the manifest, so the count the session reports and the entries it can produce are
   * the same evidence.
   *
   * A batch whose artifact cannot be read is skipped rather than fatal, and the gap is
   * visible by comparing this length against `session.entry_count`. Throwing here would
   * mean one unreadable blob costs every other batch in the session.
   */
  public rawEntries(sessionId: string): RawConsoleEntry[] {
    const collected: RawConsoleEntry[] = [];
    for (const batch of this.batches(sessionId)) {
      let raw: unknown;
      try {
        raw = this.artifacts.getJson(batch.artifact_hash as never);
      } catch {
        continue;
      }
      if (typeof raw !== 'object' || raw === null) continue;
      const entries = (raw as Record<string, unknown>)['entries'];
      if (Array.isArray(entries)) collected.push(...(entries as RawConsoleEntry[]));
    }
    return collected;
  }

  /* ------------------------------ internals --------------------------- */

  private nextBatchSequence(sessionId: string): number {
    const row = this.projections.db
      .prepare('SELECT MAX(sequence) AS max_sequence FROM console_batches WHERE session_id = ?')
      .get(sessionId);
    const value = readObject(row ?? {}, 'max batch row')['max_sequence'];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value + 1 : 1;
  }

  private nextSessionSequence(): number {
    const row = this.projections.db.prepare('SELECT MAX(id) AS max_id FROM console_sessions').get();
    const value = readObject(row ?? {}, 'max row')['max_id'];
    if (typeof value !== 'string') return 1;
    const parsed = Number.parseInt(value.slice('CSESS-'.length), 10);
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

function readSignatureRow(row: unknown): ConsoleSignatureRecord {
  const record = readObject(row, 'console_signatures row');
  return parseOrThrow(
    consoleSignatureSchema,
    { ...record, triaged: record['triaged'] === 1 },
    'console_signatures row',
  );
}

function readObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected an object for ${context}`);
  }
  return value as Record<string, unknown>;
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
