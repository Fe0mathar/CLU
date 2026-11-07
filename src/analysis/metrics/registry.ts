/**
 * CLUE metric and ranking registry.
 *
 * Spec: CLUE_Architecture_v9 (metrics, ease, priority, lanes; content-addressed artifact store);
 *       CLUE_Execution_Model_v9 (projection rebuild; logical identity survives edits).
 * Backlog: DEV-P1-04 — event/artifact/bulk atomicity, complete field replacement on re-record, and
 *          durable multi-run history. Previously a re-measurement of the same snapshot overwrote the
 *          summary row and left several bulk columns carrying the previous run's values, so one row
 *          could mix two runs while looking entirely ordinary.
 *
 * Stores what the metric families computed and what the ranking concluded, so both can
 * be queried, compared across snapshots, and — most importantly — **argued with later**.
 *
 * Two properties make this more than a cache.
 *
 * **A metric can have a history.** A unit keeps its logical id while its body changes,
 * so the same measurement can be followed across snapshots. That is what turns "this
 * unit scores 0.8" into "this unit has scored 0.8 for six weeks and nothing has moved
 * it", which is a different and far more useful statement.
 *
 * **A comparison must be like for like, and this file refuses to pretend otherwise.**
 * Every value here is percentile-normalised against its own corpus, so a unit's score
 * moves when *other* units change. Raw values are stored alongside normalised ones for
 * exactly that reason, and a ranking records the hash of the weights that produced it.
 * A ranking that shifted because someone edited a weight is not evidence of improvement,
 * and `compareRankings` says so rather than letting the numbers imply progress.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';

import { canonicalJson, hashCanonicalJson, nowIso, requireSha256 } from '../../shared/ids.js';
import { parseOrThrow } from '../../shared/schemas.js';
import type { ArtifactStore } from '../../memory/artifactStore.js';
import type { EventLog } from '../../memory/eventLog.js';
import type { ProjectionStore, Projector } from '../../memory/db.js';
import type {
  EvidenceClass,
  MetricFamilyName,
  MetricSet,
  MetricValue,
  ProofReadiness,
} from './families.js';
import type { CandidateKind, RankedCandidate, RankingResult, RankingWeights, WorkLane } from './ranking.js';

type Db = Database.Database;

/* ------------------------------------------------------------------------- */
/* Records                                                                    */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const metricSetRecordSchema = z
  .object({
    snapshot_id: sha256,
    computed_at: isoTime,
    /** Full set including per-value components; the durable evidence. */
    artifact_hash: sha256,
    corpus_size: z.number().int().nonnegative(),
    value_count: z.number().int().nonnegative(),
    unavailable_families: z.array(z.string()),
  })
  .strict();

export type MetricSetRecord = z.infer<typeof metricSetRecordSchema>;

export const rankingRecordSchema = z
  .object({
    snapshot_id: sha256,
    ranked_at: isoTime,
    artifact_hash: sha256,
    /**
     * Hash of the weights used. Two rankings computed under different weights are not
     * comparable, and without this there is no way to know that they differ.
     */
    weights_hash: sha256,
    patch_count: z.number().int().nonnegative(),
    instrumentation_count: z.number().int().nonnegative(),
    clarification_count: z.number().int().nonnegative(),
    excluded_count: z.number().int().nonnegative(),
    corrections_applied: z.number().int().nonnegative(),
    observed_evidence_available: z.boolean(),
  })
  .strict();

export type RankingRecord = z.infer<typeof rankingRecordSchema>;

/** One point in a unit's history for one family. */
export interface TrendPoint {
  readonly snapshotId: string;
  readonly computedAt: string;
  readonly versionHash: string | null;
  readonly raw: number;
  readonly normalised: number;
  /** False when the unit's own bytes did not change between this point and the last. */
  readonly unitChanged: boolean;
}

export interface CandidateSummary {
  readonly logicalId: string;
  readonly modulePath: string;
  readonly subsystem: string;
  readonly kind: CandidateKind;
  readonly lane: WorkLane;
  readonly priority: number;
  readonly magnitude: number;
  readonly ease: number;
  readonly confidence: number;
  readonly evidence: EvidenceClass;
  readonly dominantFamily: string | null;
  readonly proofReadiness: ProofReadiness;
  readonly unitClass: string | null;
  readonly impactSize: number;
  readonly corrections: readonly string[];
  readonly exclusionReason: string | null;
  readonly proposedAction: string;
}

export interface RankingComparison {
  readonly from: string;
  readonly to: string;
  /** True when both rankings used identical weights. False makes the rest indicative only. */
  readonly comparable: boolean;
  readonly incomparableReason: string | null;
  /** Candidates present before and absent after. */
  readonly resolved: readonly string[];
  readonly introduced: readonly string[];
  readonly improved: readonly { logicalId: string; before: number; after: number; delta: number }[];
  readonly worsened: readonly { logicalId: string; before: number; after: number; delta: number }[];
  readonly unchanged: number;
}

/* ------------------------------------------------------------------------- */
/* Schema                                                                     */
/* ------------------------------------------------------------------------- */

export const METRIC_EVENT_TYPES = {
  metricsComputed: 'metrics.computed',
  rankingComputed: 'ranking.computed',
} as const;

export const METRIC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metric_sets (
  snapshot_id          TEXT PRIMARY KEY,
  computed_at          TEXT NOT NULL,
  artifact_hash        TEXT NOT NULL,
  corpus_size          INTEGER NOT NULL,
  value_count          INTEGER NOT NULL,
  unavailable_families TEXT NOT NULL
);

-- Summary rows for querying and trends. Components live in the artifact; duplicating
-- them here would multiply the table by a factor that buys nothing a join cannot.
-- DEV-P1-04: every metric-set and ranking run, not just the newest. \`metric_sets\` and \`rankings\`
-- stay the "current" pointer for queries; these tables are the history behind them. Written by the
-- projectors, so event replay reconstructs the full run history exactly rather than only the last run.
CREATE TABLE IF NOT EXISTS metric_set_runs (
  snapshot_id          TEXT NOT NULL,
  artifact_hash        TEXT NOT NULL,
  computed_at          TEXT NOT NULL,
  corpus_size          INTEGER NOT NULL,
  value_count          INTEGER NOT NULL,
  unavailable_families TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, artifact_hash, computed_at)
);
CREATE INDEX IF NOT EXISTS metric_set_runs_snapshot ON metric_set_runs(snapshot_id, computed_at);

CREATE TABLE IF NOT EXISTS ranking_runs (
  snapshot_id                 TEXT NOT NULL,
  artifact_hash               TEXT NOT NULL,
  ranked_at                   TEXT NOT NULL,
  weights_hash                TEXT NOT NULL,
  patch_count                 INTEGER NOT NULL,
  instrumentation_count       INTEGER NOT NULL,
  clarification_count         INTEGER NOT NULL,
  excluded_count              INTEGER NOT NULL,
  corrections_applied         INTEGER NOT NULL,
  observed_evidence_available INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, artifact_hash, ranked_at)
);
CREATE INDEX IF NOT EXISTS ranking_runs_snapshot ON ranking_runs(snapshot_id, ranked_at);

CREATE TABLE IF NOT EXISTS metric_values (
  snapshot_id     TEXT NOT NULL,
  logical_id      TEXT NOT NULL,
  family          TEXT NOT NULL,
  raw             REAL NOT NULL,
  normalised      REAL NOT NULL,
  percentile      REAL NOT NULL,
  confidence      REAL NOT NULL,
  evidence        TEXT NOT NULL,
  proof_readiness TEXT NOT NULL,
  available       INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, logical_id, family)
);
CREATE INDEX IF NOT EXISTS metric_values_family ON metric_values(family, normalised);
CREATE INDEX IF NOT EXISTS metric_values_unit   ON metric_values(logical_id, family);

CREATE TABLE IF NOT EXISTS rankings (
  snapshot_id                 TEXT PRIMARY KEY,
  ranked_at                   TEXT NOT NULL,
  artifact_hash               TEXT NOT NULL,
  weights_hash                TEXT NOT NULL,
  patch_count                 INTEGER NOT NULL,
  instrumentation_count       INTEGER NOT NULL,
  clarification_count         INTEGER NOT NULL,
  excluded_count              INTEGER NOT NULL,
  corrections_applied         INTEGER NOT NULL,
  observed_evidence_available INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ranked_candidates (
  snapshot_id      TEXT NOT NULL,
  logical_id       TEXT NOT NULL,
  module_path      TEXT NOT NULL,
  subsystem        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  lane             TEXT NOT NULL,
  priority         REAL NOT NULL,
  magnitude        REAL NOT NULL,
  ease             REAL NOT NULL,
  confidence       REAL NOT NULL,
  evidence         TEXT NOT NULL,
  dominant_family  TEXT,
  proof_readiness  TEXT NOT NULL,
  unit_class       TEXT,
  impact_size      INTEGER NOT NULL,
  corrections      TEXT NOT NULL,
  exclusion_reason TEXT,
  proposed_action  TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, logical_id)
);
CREATE INDEX IF NOT EXISTS ranked_candidates_priority  ON ranked_candidates(snapshot_id, kind, priority DESC);
CREATE INDEX IF NOT EXISTS ranked_candidates_subsystem ON ranked_candidates(snapshot_id, subsystem);
CREATE INDEX IF NOT EXISTS ranked_candidates_unit      ON ranked_candidates(logical_id);
`;

export function ensureMetricSchema(db: Db): void {
  db.exec(METRIC_SCHEMA_SQL);
}

export const METRIC_PROJECTORS: Readonly<Record<string, Projector>> = {
  [METRIC_EVENT_TYPES.metricsComputed]: (db, record) => {
    const entry = parseOrThrow(metricSetRecordSchema, record.payload, 'metrics.computed');
    db.prepare(
      `INSERT INTO metric_sets (snapshot_id, computed_at, artifact_hash, corpus_size, value_count, unavailable_families)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id) DO UPDATE SET
         computed_at = excluded.computed_at,
         artifact_hash = excluded.artifact_hash,
         corpus_size = excluded.corpus_size,
         value_count = excluded.value_count,
         unavailable_families = excluded.unavailable_families`,
    ).run(
      entry.snapshot_id,
      entry.computed_at,
      entry.artifact_hash,
      entry.corpus_size,
      entry.value_count,
      canonicalJson(entry.unavailable_families),
    );

    // DEV-P1-04: the summary row is a pointer to the newest run; this is the run itself. Recorded
    // from the same event, so a projection rebuild reconstructs every run, not just the last one.
    db.prepare(
      `INSERT INTO metric_set_runs (
         snapshot_id, artifact_hash, computed_at, corpus_size, value_count, unavailable_families)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, artifact_hash, computed_at) DO NOTHING`,
    ).run(
      entry.snapshot_id,
      entry.artifact_hash,
      entry.computed_at,
      entry.corpus_size,
      entry.value_count,
      canonicalJson(entry.unavailable_families),
    );
  },

  [METRIC_EVENT_TYPES.rankingComputed]: (db, record) => {
    const entry = parseOrThrow(rankingRecordSchema, record.payload, 'ranking.computed');
    db.prepare(
      `INSERT INTO rankings (
         snapshot_id, ranked_at, artifact_hash, weights_hash, patch_count,
         instrumentation_count, clarification_count, excluded_count,
         corrections_applied, observed_evidence_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id) DO UPDATE SET
         ranked_at = excluded.ranked_at,
         artifact_hash = excluded.artifact_hash,
         weights_hash = excluded.weights_hash,
         patch_count = excluded.patch_count,
         instrumentation_count = excluded.instrumentation_count,
         clarification_count = excluded.clarification_count,
         excluded_count = excluded.excluded_count,
         corrections_applied = excluded.corrections_applied,
         observed_evidence_available = excluded.observed_evidence_available`,
    ).run(
      entry.snapshot_id,
      entry.ranked_at,
      entry.artifact_hash,
      entry.weights_hash,
      entry.patch_count,
      entry.instrumentation_count,
      entry.clarification_count,
      entry.excluded_count,
      entry.corrections_applied,
      entry.observed_evidence_available ? 1 : 0,
    );

    // DEV-P1-04: durable per-run history behind the "current ranking" pointer, rebuilt by replay.
    db.prepare(
      `INSERT INTO ranking_runs (
         snapshot_id, artifact_hash, ranked_at, weights_hash, patch_count,
         instrumentation_count, clarification_count, excluded_count,
         corrections_applied, observed_evidence_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, artifact_hash, ranked_at) DO NOTHING`,
    ).run(
      entry.snapshot_id,
      entry.artifact_hash,
      entry.ranked_at,
      entry.weights_hash,
      entry.patch_count,
      entry.instrumentation_count,
      entry.clarification_count,
      entry.excluded_count,
      entry.corrections_applied,
      entry.observed_evidence_available ? 1 : 0,
    );
  },
};

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */

/** One recorded metric-set run (DEV-P1-04). */
export interface MetricSetRun {
  readonly snapshotId: string;
  readonly artifactHash: string;
  readonly computedAt: string;
  readonly corpusSize: number;
  readonly valueCount: number;
}

/** One recorded ranking run (DEV-P1-04). */
export interface RankingRun {
  readonly snapshotId: string;
  readonly artifactHash: string;
  readonly rankedAt: string;
  readonly weightsHash: string;
  readonly patchCount: number;
}

/** Whether a snapshot's summary row and its bulk value rows agree (DEV-P1-04). */
export interface ProjectionConsistency {
  readonly snapshotId: string;
  readonly expectedValues: number;
  readonly storedValues: number;
  readonly consistent: boolean;
}

export interface MetricRegistryDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  readonly missionVersion: () => string;
}

export class MetricRegistry {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly artifacts: ArtifactStore;
  private readonly missionVersion: () => string;

  public constructor(deps: MetricRegistryDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.artifacts = deps.artifacts;
    this.missionVersion = deps.missionVersion;
    ensureMetricSchema(this.projections.db);
  }

  /* ------------------------------ recording --------------------------- */

  /**
   * Stores a metric set.
   *
   * The full set, components and all, goes to one content-addressed artifact; summary
   * rows go to SQLite for querying. The split keeps the event log readable while
   * leaving every component available to anyone who wants to challenge a number.
   */
  public record(metrics: MetricSet): MetricSetRecord {
    const serialisable = serialiseMetricSet(metrics);
    const artifact = this.artifacts.putJson(serialisable, {
      label: `metrics-${metrics.snapshotId.slice(0, 12)}.json`,
    });

    let valueCount = 0;
    for (const values of metrics.byUnit.values()) valueCount += values.size;

    const record = parseOrThrow(
      metricSetRecordSchema,
      {
        snapshot_id: metrics.snapshotId,
        computed_at: nowIso(),
        artifact_hash: artifact.hash,
        corpus_size: metrics.corpusSize,
        value_count: valueCount,
        unavailable_families: metrics.unavailableFamilies.map((entry) => entry.family),
      },
      `metric set for ${metrics.snapshotId}`,
    );

    this.append(METRIC_EVENT_TYPES.metricsComputed, record);
    this.projections.sync(this.log);
    this.hydrateValues(metrics);

    return record;
  }

  /** Stores a ranking, together with the hash of the weights that produced it. */
  public recordRanking(result: RankingResult, weights: RankingWeights): RankingRecord {
    const artifact = this.artifacts.putJson(result, {
      label: `ranking-${result.snapshotId.slice(0, 12)}.json`,
    });

    const record = parseOrThrow(
      rankingRecordSchema,
      {
        snapshot_id: result.snapshotId,
        ranked_at: nowIso(),
        artifact_hash: artifact.hash,
        weights_hash: hashCanonicalJson(weights),
        patch_count: result.patchCandidates.length,
        instrumentation_count: result.instrumentationCandidates.length,
        clarification_count: result.clarificationCandidates.length,
        excluded_count: result.excluded.length,
        corrections_applied: result.stats.correctionsApplied,
        observed_evidence_available: result.stats.observedEvidenceAvailable,
      },
      `ranking for ${result.snapshotId}`,
    );

    this.append(METRIC_EVENT_TYPES.rankingComputed, record);
    this.projections.sync(this.log);
    this.hydrateCandidates(result);

    return record;
  }

  /**
   * Rebuilds the summary tables from stored artifacts.
   *
   * Same lesson as the graph: a table filled from an artifact rather than from an event
   * is not restored by replay, and without this "projections are disposable" would be
   * false for everything in this file.
   */
  public rehydrate(snapshotId: string): boolean {
    let restored = false;

    const metrics = this.metricSet(snapshotId);
    if (metrics !== null) {
      this.hydrateValues(metrics);
      restored = true;
    }

    const ranking = this.ranking(snapshotId);
    if (ranking !== null) {
      this.hydrateCandidates(ranking);
      restored = true;
    }

    return restored;
  }

  /**
   * Rehydrates the artifact-backed bulk tables (metric_values, ranked_candidates) for every
   * snapshot that has a stored metric set or ranking. Event replay restores only the summary
   * receipts, so a projection rebuild leaves the bulk tables empty until this runs. Invoked from
   * the projection module's rehydrate hook after replay; it appends no events and does not sync.
   */
  public rehydrateAll(): number {
    const ids = new Set<string>();
    for (const row of this.projections.db
      .prepare('SELECT snapshot_id FROM metric_sets')
      .all() as ReadonlyArray<{ snapshot_id: string }>) {
      ids.add(row.snapshot_id);
    }
    for (const row of this.projections.db
      .prepare('SELECT snapshot_id FROM rankings')
      .all() as ReadonlyArray<{ snapshot_id: string }>) {
      ids.add(row.snapshot_id);
    }
    let restored = 0;
    for (const id of ids) {
      if (this.rehydrate(id)) restored += 1;
    }
    return restored;
  }

  /* ------------------------------- reading ---------------------------- */

  /**
   * Every metric-set run recorded for a snapshot, newest first (DEV-P1-04).
   *
   * `metricSetRecord` answers "what is the current measurement"; this answers "how many times has
   * this snapshot been measured, and did the answer move". Re-measuring used to overwrite the
   * summary row, so the earlier run vanished — and a measurement you cannot compare against its own
   * predecessor cannot show that a number is stable rather than merely current.
   */
  public metricSetRuns(snapshotId: string): MetricSetRun[] {
    return this.projections.db
      .prepare(
        `SELECT snapshot_id, artifact_hash, computed_at, corpus_size, value_count
           FROM metric_set_runs WHERE snapshot_id = ? ORDER BY computed_at DESC, artifact_hash`,
      )
      .all(snapshotId)
      .map((row) => {
        const entry = row as Record<string, unknown>;
        return {
          snapshotId: String(entry['snapshot_id']),
          artifactHash: String(entry['artifact_hash']),
          computedAt: String(entry['computed_at']),
          corpusSize: Number(entry['corpus_size']),
          valueCount: Number(entry['value_count']),
        };
      });
  }

  /** Every ranking run recorded for a snapshot, newest first (DEV-P1-04). */
  public rankingRuns(snapshotId: string): RankingRun[] {
    return this.projections.db
      .prepare(
        `SELECT snapshot_id, artifact_hash, ranked_at, weights_hash, patch_count
           FROM ranking_runs WHERE snapshot_id = ? ORDER BY ranked_at DESC, artifact_hash`,
      )
      .all(snapshotId)
      .map((row) => {
        const entry = row as Record<string, unknown>;
        return {
          snapshotId: String(entry['snapshot_id']),
          artifactHash: String(entry['artifact_hash']),
          rankedAt: String(entry['ranked_at']),
          weightsHash: String(entry['weights_hash']),
          patchCount: Number(entry['patch_count']),
        };
      });
  }

  /**
   * Reports whether the summary rows and the artifact-backed bulk tables agree (DEV-P1-04).
   *
   * The event and its artifact commit before the bulk rows are written, and the bulk write is a
   * separate transaction, so a crash in between leaves a snapshot whose summary claims N values
   * while `metric_values` holds fewer. The event log and the artifact remain truth and `rehydrate`
   * repairs it — but only if something notices. This is that something: it makes a partial
   * projection visible instead of leaving a plausible, quietly incomplete table.
   */
  public verifyProjection(snapshotId: string): ProjectionConsistency {
    const summary = this.metricSetRecord(snapshotId);
    const row = this.projections.db
      .prepare('SELECT COUNT(*) AS n FROM metric_values WHERE snapshot_id = ?')
      .get(snapshotId) as { n: number } | undefined;
    const storedValues = row === undefined ? 0 : Number(row.n);
    const expectedValues = summary === null ? 0 : summary.value_count;

    return {
      snapshotId,
      expectedValues,
      storedValues,
      consistent: summary === null ? storedValues === 0 : storedValues === expectedValues,
    };
  }

  /** The full metric set, components included, read back from the artifact store. */
  public metricSet(snapshotId: string): MetricSet | null {
    const row = this.projections.db
      .prepare('SELECT artifact_hash FROM metric_sets WHERE snapshot_id = ?')
      .get(snapshotId);
    if (row === undefined) return null;

    const hash = requireSha256(readString(readObject(row, 'metric_sets row'), 'artifact_hash'), 'artifact hash');
    const raw = this.artifacts.getJson(hash);
    return deserialiseMetricSet(raw);
  }

  public ranking(snapshotId: string): RankingResult | null {
    const row = this.projections.db
      .prepare('SELECT artifact_hash FROM rankings WHERE snapshot_id = ?')
      .get(snapshotId);
    if (row === undefined) return null;

    const hash = requireSha256(readString(readObject(row, 'rankings row'), 'artifact_hash'), 'artifact hash');
    return this.artifacts.getJson(hash) as RankingResult;
  }

  public candidates(
    snapshotId: string,
    filter: { kind?: CandidateKind; lane?: WorkLane; subsystem?: string; limit?: number } = {},
  ): CandidateSummary[] {
    const conditions = ['snapshot_id = ?'];
    const parameters: (string | number)[] = [snapshotId];

    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      parameters.push(filter.kind);
    }
    if (filter.lane !== undefined) {
      conditions.push('lane = ?');
      parameters.push(filter.lane);
    }
    if (filter.subsystem !== undefined) {
      conditions.push('subsystem = ?');
      parameters.push(filter.subsystem);
    }

    return this.projections.db
      .prepare(
        `SELECT * FROM ranked_candidates
          WHERE ${conditions.join(' AND ')}
          ORDER BY priority DESC, logical_id
          LIMIT ?`,
      )
      .all(...parameters, Math.max(1, filter.limit ?? 50))
      .map(readCandidateRow);
  }

  /**
   * A unit's history for one family.
   *
   * Both `raw` and `normalised` are returned, and the distinction matters more than it
   * looks. Normalised values are percentiles against their own corpus, so a unit's score
   * can move while the unit is untouched — because everything around it changed. The
   * `unitChanged` flag says which happened, and a trend read without it will
   * occasionally credit CLUE for an improvement that was somebody else's regression.
   */
  public trend(logicalId: string, family: MetricFamilyName, limit = 20): TrendPoint[] {
    const rows = this.projections.db
      .prepare(
        `SELECT v.snapshot_id AS snapshot_id, s.computed_at AS computed_at,
                v.raw AS raw, v.normalised AS normalised,
                u.version_hash AS version_hash
           FROM metric_values v
           JOIN metric_sets s ON s.snapshot_id = v.snapshot_id
           LEFT JOIN unit_ids i ON i.logical_id = v.logical_id
           LEFT JOIN units u ON u.unit_id = i.unit_id AND u.snapshot_id = v.snapshot_id
          WHERE v.logical_id = ? AND v.family = ? AND v.available = 1
          ORDER BY s.computed_at ASC
          LIMIT ?`,
      )
      .all(logicalId, family, Math.max(1, limit));

    let previousVersion: string | null = null;
    const points: TrendPoint[] = [];

    for (const row of rows) {
      const record = readObject(row, 'trend row');
      const versionHash = readOptionalString(record, 'version_hash');
      points.push({
        snapshotId: readString(record, 'snapshot_id'),
        computedAt: readString(record, 'computed_at'),
        versionHash,
        raw: readNumber(record, 'raw'),
        normalised: readNumber(record, 'normalised'),
        unitChanged: previousVersion !== null && versionHash !== previousVersion,
      });
      previousVersion = versionHash;
    }

    return points;
  }

  /**
   * Compares two rankings.
   *
   * Refuses to imply progress it cannot support. If the weights differ, the comparison
   * is marked incomparable and the reason is given: a ranking that shifted because a
   * weight was edited says nothing about the codebase, and presenting it as movement
   * would be the most flattering possible way to be wrong.
   */
  public compareRankings(fromSnapshot: string, toSnapshot: string): RankingComparison {
    const before = this.rankingRecord(fromSnapshot);
    const after = this.rankingRecord(toSnapshot);

    const comparable = before !== null && after !== null && before.weights_hash === after.weights_hash;
    const incomparableReason =
      before === null || after === null
        ? 'one of the rankings is missing'
        : before.weights_hash === after.weights_hash
          ? null
          : 'the two rankings used different weights; differences reflect the change in weights as much as any change in the code';

    const priorities = (snapshotId: string): Map<string, number> => {
      const map = new Map<string, number>();
      for (const row of this.projections.db
        .prepare('SELECT logical_id, priority FROM ranked_candidates WHERE snapshot_id = ?')
        .all(snapshotId)) {
        const record = readObject(row, 'ranked_candidates row');
        map.set(readString(record, 'logical_id'), readNumber(record, 'priority'));
      }
      return map;
    };

    const beforeMap = priorities(fromSnapshot);
    const afterMap = priorities(toSnapshot);

    const resolved: string[] = [];
    const introduced: string[] = [];
    const improved: { logicalId: string; before: number; after: number; delta: number }[] = [];
    const worsened: { logicalId: string; before: number; after: number; delta: number }[] = [];
    let unchanged = 0;

    for (const [logicalId, priorBefore] of beforeMap) {
      const priorAfter = afterMap.get(logicalId);
      if (priorAfter === undefined) {
        resolved.push(logicalId);
        continue;
      }
      const delta = Number((priorAfter - priorBefore).toFixed(4));
      if (Math.abs(delta) < 0.01) unchanged += 1;
      else if (delta < 0) improved.push({ logicalId, before: priorBefore, after: priorAfter, delta });
      else worsened.push({ logicalId, before: priorBefore, after: priorAfter, delta });
    }

    for (const logicalId of afterMap.keys()) {
      if (!beforeMap.has(logicalId)) introduced.push(logicalId);
    }

    improved.sort((a, b) => a.delta - b.delta);
    worsened.sort((a, b) => b.delta - a.delta);

    return {
      from: fromSnapshot,
      to: toSnapshot,
      comparable,
      incomparableReason,
      resolved: resolved.sort(),
      introduced: introduced.sort(),
      improved,
      worsened,
      unchanged,
    };
  }

  public metricSetRecord(snapshotId: string): MetricSetRecord | null {
    const row = this.projections.db
      .prepare('SELECT * FROM metric_sets WHERE snapshot_id = ?')
      .get(snapshotId);
    if (row === undefined) return null;
    const record = readObject(row, 'metric_sets row');
    return parseOrThrow(
      metricSetRecordSchema,
      { ...record, unavailable_families: JSON.parse(readString(record, 'unavailable_families')) as unknown },
      'metric_sets row',
    );
  }

  public rankingRecord(snapshotId: string): RankingRecord | null {
    const row = this.projections.db.prepare('SELECT * FROM rankings WHERE snapshot_id = ?').get(snapshotId);
    if (row === undefined) return null;
    const record = readObject(row, 'rankings row');
    return parseOrThrow(
      rankingRecordSchema,
      { ...record, observed_evidence_available: record['observed_evidence_available'] === 1 },
      'rankings row',
    );
  }

  /* ------------------------------ internals --------------------------- */

  private hydrateValues(metrics: MetricSet): void {
    const db = this.projections.db;
    const insert = db.prepare(
      `INSERT INTO metric_values (
         snapshot_id, logical_id, family, raw, normalised, percentile, confidence,
         evidence, proof_readiness, available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- DEV-P1-04: every non-key column is replaced. \`evidence\` and \`proof_readiness\` were
       -- omitted, so a re-record kept the previous run's evidence beside the new numbers.
       ON CONFLICT(snapshot_id, logical_id, family) DO UPDATE SET
         raw = excluded.raw, normalised = excluded.normalised,
         percentile = excluded.percentile, confidence = excluded.confidence,
         evidence = excluded.evidence, proof_readiness = excluded.proof_readiness,
         available = excluded.available`,
    );

    // Re-entrancy: a rehydrate invoked from within ProjectionStore.rebuild() is already inside
    // that rebuild's transaction; join it (atomic with the rebuild) instead of opening a nested one.
    const ownsTx = !db.inTransaction;
    if (ownsTx) db.exec('BEGIN IMMEDIATE');
    try {
      for (const [logicalId, values] of metrics.byUnit) {
        for (const [family, value] of values) {
          insert.run(
            metrics.snapshotId,
            logicalId,
            family,
            value.raw,
            value.normalised,
            value.percentile,
            value.confidence,
            value.evidence,
            value.proofReadiness,
            value.available ? 1 : 0,
          );
        }
      }
      if (ownsTx) db.exec('COMMIT');
    } catch (error) {
      if (ownsTx) db.exec('ROLLBACK');
      throw error;
    }
  }

  private hydrateCandidates(result: RankingResult): void {
    const db = this.projections.db;
    const insert = db.prepare(
      `INSERT INTO ranked_candidates (
         snapshot_id, logical_id, module_path, subsystem, kind, lane, priority, magnitude,
         ease, confidence, evidence, dominant_family, proof_readiness, unit_class,
         impact_size, corrections, exclusion_reason, proposed_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- DEV-P1-04: every non-key column is replaced. module_path, subsystem, evidence,
       -- dominant_family, proof_readiness, unit_class and impact_size were omitted, so a unit that
       -- moved module or changed class kept its old location and classification after a re-rank.
       ON CONFLICT(snapshot_id, logical_id) DO UPDATE SET
         module_path = excluded.module_path, subsystem = excluded.subsystem,
         kind = excluded.kind, lane = excluded.lane, priority = excluded.priority,
         magnitude = excluded.magnitude, ease = excluded.ease,
         confidence = excluded.confidence, evidence = excluded.evidence,
         dominant_family = excluded.dominant_family,
         proof_readiness = excluded.proof_readiness, unit_class = excluded.unit_class,
         impact_size = excluded.impact_size, corrections = excluded.corrections,
         exclusion_reason = excluded.exclusion_reason,
         proposed_action = excluded.proposed_action`,
    );

    const all: RankedCandidate[] = [
      ...result.patchCandidates,
      ...result.instrumentationCandidates,
      ...result.clarificationCandidates,
      ...result.excluded,
    ];

    // Re-entrancy: a rehydrate invoked from within ProjectionStore.rebuild() is already inside
    // that rebuild's transaction; join it (atomic with the rebuild) instead of opening a nested one.
    const ownsTx = !db.inTransaction;
    if (ownsTx) db.exec('BEGIN IMMEDIATE');
    try {
      for (const candidate of all) {
        insert.run(
          result.snapshotId,
          candidate.logicalId,
          candidate.modulePath,
          candidate.subsystem,
          candidate.kind,
          candidate.lane,
          candidate.priority,
          candidate.magnitude,
          candidate.ease,
          candidate.confidence,
          candidate.evidence,
          candidate.dominantFamily,
          candidate.proofReadiness,
          candidate.unitClass,
          candidate.impactSize,
          canonicalJson(candidate.corrections),
          candidate.exclusionReason,
          candidate.proposedAction,
        );
      }
      if (ownsTx) db.exec('COMMIT');
    } catch (error) {
      if (ownsTx) db.exec('ROLLBACK');
      throw error;
    }
  }

  private append(type: string, payload: unknown): void {
    this.log.append({
      type,
      actor: 'daemon',
      missionVersion: this.missionVersion(),
      subjectId: null,
      payload,
    });
  }
}

/* ------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* ------------------------------------------------------------------------- */

interface SerialisedMetricSet {
  snapshotId: string;
  corpusSize: number;
  unavailableFamilies: { family: MetricFamilyName; reason: string }[];
  values: MetricValue[];
}

/** Maps do not survive JSON, so the set travels as a flat list and is rebuilt on read. */
function serialiseMetricSet(metrics: MetricSet): SerialisedMetricSet {
  const values: MetricValue[] = [];
  for (const perUnit of metrics.byUnit.values()) {
    for (const value of perUnit.values()) values.push(value);
  }
  return {
    snapshotId: metrics.snapshotId,
    corpusSize: metrics.corpusSize,
    unavailableFamilies: [...metrics.unavailableFamilies],
    values,
  };
}

function deserialiseMetricSet(raw: unknown): MetricSet | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Partial<SerialisedMetricSet>;
  if (typeof record.snapshotId !== 'string' || !Array.isArray(record.values)) return null;

  const byUnit = new Map<string, Map<MetricFamilyName, MetricValue>>();
  for (const value of record.values) {
    const existing = byUnit.get(value.logicalId);
    if (existing === undefined) byUnit.set(value.logicalId, new Map([[value.family, value]]));
    else existing.set(value.family, value);
  }

  return {
    snapshotId: record.snapshotId,
    corpusSize: record.corpusSize ?? 0,
    byUnit,
    unavailableFamilies: record.unavailableFamilies ?? [],
  };
}

/* ------------------------------------------------------------------------- */
/* Row reading                                                                */
/* ------------------------------------------------------------------------- */

function readCandidateRow(row: unknown): CandidateSummary {
  const record = readObject(row, 'ranked_candidates row');
  const corrections = record['corrections'];

  return {
    logicalId: readString(record, 'logical_id'),
    modulePath: readString(record, 'module_path'),
    subsystem: readString(record, 'subsystem'),
    kind: readString(record, 'kind') as CandidateKind,
    lane: readString(record, 'lane') as WorkLane,
    priority: readNumber(record, 'priority'),
    magnitude: readNumber(record, 'magnitude'),
    ease: readNumber(record, 'ease'),
    confidence: readNumber(record, 'confidence'),
    evidence: readString(record, 'evidence') as EvidenceClass,
    dominantFamily: readOptionalString(record, 'dominant_family'),
    proofReadiness: readString(record, 'proof_readiness') as ProofReadiness,
    unitClass: readOptionalString(record, 'unit_class'),
    impactSize: readNumber(record, 'impact_size'),
    corrections: typeof corrections === 'string' ? (JSON.parse(corrections) as string[]) : [],
    exclusionReason: readOptionalString(record, 'exclusion_reason'),
    proposedAction: readString(record, 'proposed_action'),
  };
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
