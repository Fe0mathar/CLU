/**
 * CLUE incremental scan cache.
 *
 * Spec: CLUE_Execution_Model_v8.md (incremental rescan economy; recognition completeness),
 *       CLUE_Architecture_v8.md (snapshot identity; ambiguity is reported).
 * Backlog: DEV-P0-04 — incremental persistence produces one complete merged recognition
 *          result that rehydrates identically to a full scan.
 *
 * Decides what a rescan actually has to redo — and, once it has run, merges the restricted
 * result back into one complete recognition result so the durable artifact a full scan
 * would have written is exactly the artifact an incremental scan writes.
 *
 * The word doing the work in that gate clause is **correct**, not *small*. A cache that
 * invalidates too much is slow; a cache that invalidates too little is wrong, and wrong
 * in the worst available way — it produces a graph that looks complete, carries stale
 * edges, and misleads every impact query, classification, and landing gate built on it.
 * Everything here is therefore biased toward invalidating more than strictly necessary,
 * and toward refusing to carry anything forward when it cannot prove the carry is safe.
 *
 * Two surfaces are computed, and they are not the same set:
 *
 *   Extraction surface — files whose units and edges must be re-derived. Changed files,
 *   plus files whose *resolution* could have changed even though their own bytes did
 *   not. A file that imports a renamed export is byte-identical and semantically
 *   different, which is precisely the case a naive "changed files only" cache gets
 *   wrong.
 *
 *   Classification surface — units whose impact set could have shifted. Impact is
 *   reverse reachability, so adding an edge X→Y changes the impact of everything Y
 *   depends on. The affected set is therefore the forward dependency closure of the
 *   re-extracted units, not the re-extracted units themselves.
 *
 * When the cache cannot reason safely — no prior recognition, changed compiler options,
 * an incomplete previous projection — it says so and asks for a full rescan. A full
 * rescan is expensive; a silently wrong graph is worse.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';

import { hashCanonicalJson, nowIso, requireSha256 } from '../../shared/ids.js';
import { parseOrThrow, recognitionBasisSchema } from '../../shared/schemas.js';
import {
  projectRecognitionIdentityEquals,
  projectRecognitionIdentitySchema,
  type ProjectRecognitionIdentity,
} from '../../shared/projectRecognitionIdentity.js';
import type { ArtifactStore } from '../../memory/artifactStore.js';
import type { EventLog } from '../../memory/eventLog.js';
import type { ProjectionStore, Projector } from '../../memory/db.js';
import type { SnapshotDiff } from './snapshot.js';
import type {
  RecognitionBasis,
  RecognitionResult,
  SourceEdge,
  SourceUnit,
  UnresolvedReference,
} from './recognizer.js';

type Db = Database.Database;

/**
 * Merge-algorithm version, recorded with every incremental merge. A change here means a
 * stored incremental result was produced by different merge logic and may not be
 * bit-comparable with a result merged under another version.
 */
const MERGE_VERSION = 'scan-merge/1';

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

export type FullRescanReason =
  | 'no-previous-recognition'
  | 'compiler-options-changed'
  | 'recognition-configuration-changed'
  | 'previous-artifact-unavailable'
  | 'previous-projection-incomplete'
  | 'previous-snapshot-missing'
  | 'requested';

export type SurfaceReason =
  | 'changed'
  | 'added'
  | 'removed'
  | 'imports-changed-module'
  | 'reexports-changed-module';

export interface ScanPlan {
  readonly fromSnapshot: string | null;
  readonly toSnapshot: string;
  /** Files whose bytes differ, straight from the snapshot diff. */
  readonly changedFiles: readonly string[];
  /** Files that must be re-extracted, with the reason each is included. */
  readonly extractionSurface: readonly string[];
  readonly surfaceReasons: Readonly<Record<string, SurfaceReason>>;
  /** Files whose previous units and edges can be reused verbatim. */
  readonly carriedFiles: readonly string[];
  /** Modules whose units must be dropped because the file no longer exists. */
  readonly droppedFiles: readonly string[];
  readonly fullRescan: boolean;
  readonly fullRescanReason: FullRescanReason | null;
  readonly estimatedSaving: number;
  /** Exact profile recognition generation that makes cache reuse admissible. */
  readonly projectRecognition: ProjectRecognitionIdentity | null;
}

export interface CarryResult {
  readonly unitsCarried: number;
  readonly edgesCarried: number;
  readonly classesCarried: number;
  readonly unresolvedCarried: number;
}

/**
 * The outcome of merging a restricted rescan back onto the previous complete result. The
 * `result` is a full recognition result — every unchanged file's units, edges, and
 * unresolved references carried verbatim, every re-extracted file's derived fresh, removed
 * files dropped — canonically ordered so its hash does not depend on traversal order.
 */
export interface IncrementalMerge {
  readonly result: RecognitionResult;
  /** Result hash of the base snapshot this was merged onto. */
  readonly previousResultHash: string;
  /** Hash of the merged result's (units, edges, unresolved); equals a full scan's. */
  readonly mergedResultHash: string;
  readonly mergeVersion: string;
  readonly carriedModules: readonly string[];
  readonly extractedModules: readonly string[];
  readonly droppedModules: readonly string[];
}

export interface ProjectionComparison {
  readonly unitsOnlyInA: readonly string[];
  readonly unitsOnlyInB: readonly string[];
  /** Units present in both whose version hash differs. */
  readonly unitsDiffering: readonly string[];
  readonly edgesOnlyInA: number;
  readonly edgesOnlyInB: number;
  readonly identical: boolean;
}

/* ------------------------------------------------------------------------- */
/* Records                                                                    */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const scanPlanRecordSchema = z
  .object({
    to_snapshot: sha256,
    from_snapshot: sha256.nullable(),
    planned_at: isoTime,
    /** Full plan, stored as an artifact; the event stays small enough to read. */
    plan_hash: sha256,
    changed_count: z.number().int().nonnegative(),
    extraction_count: z.number().int().nonnegative(),
    carried_count: z.number().int().nonnegative(),
    dropped_count: z.number().int().nonnegative(),
    full_rescan: z.boolean(),
    full_rescan_reason: z.string().nullable(),
    project_recognition: projectRecognitionIdentitySchema.nullable().optional(),
  })
  .strict();

export type ScanPlanRecord = z.infer<typeof scanPlanRecordSchema>;

/**
 * Provenance of an incremental merge: which base result it extended, the hash it produced,
 * and the merge-algorithm version. Recording it is what makes an incremental result
 * auditable — the previous result hash and merge version are the evidence that a complete
 * result was reconstructed rather than a fragment persisted (DEV-P0-04).
 */
export const scanMergeRecordSchema = z
  .object({
    to_snapshot: sha256,
    from_snapshot: sha256,
    merged_at: isoTime,
    previous_result_hash: sha256,
    merged_result_hash: sha256,
    merge_version: z.string().min(1),
    carried_count: z.number().int().nonnegative(),
    extracted_count: z.number().int().nonnegative(),
    dropped_count: z.number().int().nonnegative(),
    project_recognition: projectRecognitionIdentitySchema.nullable().optional(),
  })
  .strict();

export type ScanMergeRecord = z.infer<typeof scanMergeRecordSchema>;

export const SCAN_EVENT_TYPES = {
  scanPlanned: 'scan.planned',
  scanMerged: 'scan.merged',
} as const;

export const SCAN_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scan_plans (
  to_snapshot        TEXT PRIMARY KEY,
  from_snapshot      TEXT,
  planned_at         TEXT NOT NULL,
  plan_hash          TEXT NOT NULL,
  changed_count      INTEGER NOT NULL,
  extraction_count   INTEGER NOT NULL,
  carried_count      INTEGER NOT NULL,
  dropped_count      INTEGER NOT NULL,
  full_rescan        INTEGER NOT NULL,
  full_rescan_reason TEXT,
  project_recognition TEXT
);

-- One row per incremental merge: the base result it extended, the complete result it
-- produced, and the merge-algorithm version. This is the durable evidence that an
-- incremental scan reconstructed a complete result rather than persisting a fragment.
CREATE TABLE IF NOT EXISTS scan_merges (
  to_snapshot          TEXT PRIMARY KEY,
  from_snapshot        TEXT NOT NULL,
  merged_at            TEXT NOT NULL,
  previous_result_hash TEXT NOT NULL,
  merged_result_hash   TEXT NOT NULL,
  merge_version        TEXT NOT NULL,
  carried_count        INTEGER NOT NULL,
  extracted_count      INTEGER NOT NULL,
  dropped_count        INTEGER NOT NULL,
  project_recognition  TEXT
);
`;

export function ensureScanCacheSchema(db: Db): void {
  db.exec(SCAN_CACHE_SCHEMA_SQL);
  if (!hasColumn(db, 'scan_plans', 'project_recognition')) {
    db.exec('ALTER TABLE scan_plans ADD COLUMN project_recognition TEXT');
  }
  if (!hasColumn(db, 'scan_merges', 'project_recognition')) {
    db.exec('ALTER TABLE scan_merges ADD COLUMN project_recognition TEXT');
  }
}

function hasColumn(db: Db, table: string, column: string): boolean {
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    if (typeof row === 'object' && row !== null && (row as Record<string, unknown>)['name'] === column) {
      return true;
    }
  }
  return false;
}

export const SCAN_CACHE_PROJECTORS: Readonly<Record<string, Projector>> = {
  [SCAN_EVENT_TYPES.scanPlanned]: (db, record) => {
    const plan = parseOrThrow(scanPlanRecordSchema, record.payload, 'scan.planned');
    db.prepare(
      `INSERT INTO scan_plans (
         to_snapshot, from_snapshot, planned_at, plan_hash, changed_count,
         extraction_count, carried_count, dropped_count, full_rescan, full_rescan_reason,
         project_recognition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(to_snapshot) DO UPDATE SET
         planned_at = excluded.planned_at,
         plan_hash = excluded.plan_hash,
         extraction_count = excluded.extraction_count,
         carried_count = excluded.carried_count,
         full_rescan = excluded.full_rescan,
         full_rescan_reason = excluded.full_rescan_reason,
         project_recognition = excluded.project_recognition`,
    ).run(
      plan.to_snapshot,
      plan.from_snapshot,
      plan.planned_at,
      plan.plan_hash,
      plan.changed_count,
      plan.extraction_count,
      plan.carried_count,
      plan.dropped_count,
      plan.full_rescan ? 1 : 0,
      plan.full_rescan_reason,
      plan.project_recognition === undefined || plan.project_recognition === null
        ? null
        : JSON.stringify(plan.project_recognition),
    );
  },
  [SCAN_EVENT_TYPES.scanMerged]: (db, record) => {
    const merge = parseOrThrow(scanMergeRecordSchema, record.payload, 'scan.merged');
    db.prepare(
      `INSERT INTO scan_merges (
         to_snapshot, from_snapshot, merged_at, previous_result_hash, merged_result_hash,
         merge_version, carried_count, extracted_count, dropped_count, project_recognition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(to_snapshot) DO UPDATE SET
         merged_at = excluded.merged_at,
         previous_result_hash = excluded.previous_result_hash,
         merged_result_hash = excluded.merged_result_hash,
         merge_version = excluded.merge_version,
         carried_count = excluded.carried_count,
         extracted_count = excluded.extracted_count,
         dropped_count = excluded.dropped_count,
         project_recognition = excluded.project_recognition`,
    ).run(
      merge.to_snapshot,
      merge.from_snapshot,
      merge.merged_at,
      merge.previous_result_hash,
      merge.merged_result_hash,
      merge.merge_version,
      merge.carried_count,
      merge.extracted_count,
      merge.dropped_count,
      merge.project_recognition === undefined || merge.project_recognition === null
        ? null
        : JSON.stringify(merge.project_recognition),
    );
  },
};

/* ------------------------------------------------------------------------- */
/* Scan cache                                                                 */
/* ------------------------------------------------------------------------- */

export interface ScanCacheDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  readonly missionVersion: () => string;
}

export interface PlanOptions {
  /** Compiler options hash of the recognition about to run. */
  readonly compilerOptionsHash: string;
  /** Current compiler/configuration provenance when the full probe has established it. */
  readonly currentBasis?: RecognitionBasis;
  /** Exact Project Profile recognition generation governing this scan, when profile-bound. */
  readonly projectRecognition?: ProjectRecognitionIdentity;
  /** Force a full rescan regardless of what the diff says. */
  readonly force?: boolean;
}

export class ScanCache {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly artifacts: ArtifactStore;
  private readonly missionVersion: () => string;

  public constructor(deps: ScanCacheDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.artifacts = deps.artifacts;
    this.missionVersion = deps.missionVersion;
    ensureScanCacheSchema(this.projections.db);
  }

  /**
   * Works out what the next recognition must redo.
   *
   * Every path that cannot be justified ends in a full rescan. That is the asymmetry the
   * whole module is built around: being slow costs minutes, and being subtly stale costs
   * the credibility of every conclusion drawn from the graph afterwards.
   */
  public plan(diff: SnapshotDiff, options: PlanOptions): ScanPlan {
    const toSnapshot = diff.to;
    const fromSnapshot = diff.from;

    const fullRescanReason = this.checkFullRescan(fromSnapshot, options);
    if (fullRescanReason !== null) {
      const plan: ScanPlan = {
        fromSnapshot,
        toSnapshot,
        changedFiles: diff.changedPaths,
        // A full rescan has no partial surface: the recognizer runs unrestricted.
        extractionSurface: [],
        surfaceReasons: {},
        carriedFiles: [],
        droppedFiles: diff.removed.map((file) => file.path),
        fullRescan: true,
        fullRescanReason,
        estimatedSaving: 0,
        projectRecognition: options.projectRecognition ?? null,
      };
      this.recordPlan(plan);
      return plan;
    }

    const surfaceReasons: Record<string, SurfaceReason> = {};
    for (const file of diff.added) surfaceReasons[file.path] = 'added';
    for (const entry of diff.modified) surfaceReasons[entry.after.path] = 'changed';

    const changedModules = new Set(Object.keys(surfaceReasons));
    const removedModules = new Set(diff.removed.map((file) => file.path));

    this.expandDependents(
      fromSnapshot as string,
      new Set([...changedModules, ...removedModules]),
      surfaceReasons,
    );

    const extractionSurface = Object.keys(surfaceReasons)
      .filter((path) => !removedModules.has(path))
      .sort();

    const allModules = this.modulesOf(fromSnapshot as string);
    const surfaceSet = new Set(extractionSurface);
    const carriedFiles = allModules
      .filter((path) => !surfaceSet.has(path) && !removedModules.has(path))
      .sort();

    const total = extractionSurface.length + carriedFiles.length;
    const plan: ScanPlan = {
      fromSnapshot,
      toSnapshot,
      changedFiles: diff.changedPaths,
      extractionSurface,
      surfaceReasons,
      carriedFiles,
      droppedFiles: [...removedModules].sort(),
      fullRescan: false,
      fullRescanReason: null,
      estimatedSaving: total === 0 ? 0 : Number((carriedFiles.length / total).toFixed(3)),
      projectRecognition: options.projectRecognition ?? null,
    };

    this.recordPlan(plan);
    return plan;
  }

  /**
   * Expands the extraction surface to files whose resolution could have moved.
   *
   * Re-exports are followed transitively and plain imports for exactly one hop. The
   * asymmetry is not arbitrary: a barrel forwards symbols without naming them, so a
   * change behind a barrel reaches every consumer of that barrel, however deep the
   * chain. A plain import names what it takes, so a change two modules away cannot
   * alter what this file resolves to without also changing the module in between —
   * which would then be in the surface on its own account.
   */
  private expandDependents(
    fromSnapshot: string,
    seeds: ReadonlySet<string>,
    surfaceReasons: Record<string, SurfaceReason>,
  ): void {
    const importers = this.projections.db.prepare(
      `SELECT DISTINCT src.module_path AS module_path, e.kind AS kind
         FROM graph_edges e
         JOIN units src ON src.unit_id = e.from_unit AND src.snapshot_id = e.snapshot_id
         JOIN units dst ON dst.unit_id = e.to_unit   AND dst.snapshot_id = e.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.external = 0
          AND e.kind IN ('imports', 'reexports')
          AND dst.module_path = ?`,
    );

    const queue = [...seeds];
    const visited = new Set<string>(seeds);

    while (queue.length > 0) {
      const module = queue.shift();
      if (module === undefined) continue;

      for (const row of importers.all(fromSnapshot, module)) {
        const record = readObject(row, 'importer row');
        const importer = readString(record, 'module_path');
        const kind = readString(record, 'kind');

        if (surfaceReasons[importer] === undefined) {
          surfaceReasons[importer] =
            kind === 'reexports' ? 'reexports-changed-module' : 'imports-changed-module';
        }

        // Only a re-export chain keeps propagating; a plain import stops here.
        if (kind === 'reexports' && !visited.has(importer)) {
          visited.add(importer);
          queue.push(importer);
        }
      }
    }
  }

  /**
   * Copies the reusable part of a previous projection onto the new snapshot.
   *
   * Rows are copied rather than referenced so that each snapshot's projection stands
   * alone. A snapshot whose graph is only readable while its predecessor still exists
   * would make every historical finding depend on retention policy.
   */
  public carryForward(plan: ScanPlan): CarryResult {
    if (plan.fullRescan || plan.fromSnapshot === null || plan.carriedFiles.length === 0) {
      return { unitsCarried: 0, edgesCarried: 0, classesCarried: 0, unresolvedCarried: 0 };
    }

    const db = this.projections.db;
    const placeholders = plan.carriedFiles.map(() => '?').join(', ');

    db.exec('BEGIN IMMEDIATE');
    try {
      const units = db
        .prepare(
          `INSERT INTO units (
             snapshot_id, unit_id, kind, name, qualified_name, module_path, subsystem,
             exported, version_hash, start_line, end_line, start_byte, end_byte,
             parent_unit_id, line_count, byte_length, is_async, parameter_count)
           SELECT ?, unit_id, kind, name, qualified_name, module_path, subsystem,
                  exported, version_hash, start_line, end_line, start_byte, end_byte,
                  parent_unit_id, line_count, byte_length, is_async, parameter_count
             FROM units
            WHERE snapshot_id = ? AND module_path IN (${placeholders})
           ON CONFLICT(snapshot_id, unit_id) DO NOTHING`,
        )
        .run(plan.toSnapshot, plan.fromSnapshot, ...plan.carriedFiles);

      const edges = db
        .prepare(
          `INSERT INTO graph_edges
             (snapshot_id, from_unit, to_unit, kind, confidence, external, start_line, start_byte, end_byte)
           SELECT ?, e.from_unit, e.to_unit, e.kind, e.confidence, e.external, e.start_line, e.start_byte, e.end_byte
             FROM graph_edges e
             JOIN units src ON src.unit_id = e.from_unit AND src.snapshot_id = e.snapshot_id
            WHERE e.snapshot_id = ? AND src.module_path IN (${placeholders})
           ON CONFLICT(snapshot_id, from_unit, to_unit, kind, start_byte, end_byte) DO NOTHING`,
        )
        .run(plan.toSnapshot, plan.fromSnapshot, ...plan.carriedFiles);

      // Classifications are copied only as a starting point. The caller must recompute
      // whatever `classificationSurface` reports, or the carried classes will describe
      // a graph that no longer exists.
      const classes = db
        .prepare(
          `INSERT INTO unit_classes (
             snapshot_id, unit_id, class, confidence, percentile, impact_size,
             impact_modules, impact_subsystems, direct_dependents, reasons)
           SELECT ?, c.unit_id, c.class, c.confidence, c.percentile, c.impact_size,
                  c.impact_modules, c.impact_subsystems, c.direct_dependents, c.reasons
             FROM unit_classes c
             JOIN units u ON u.unit_id = c.unit_id AND u.snapshot_id = c.snapshot_id
            WHERE c.snapshot_id = ? AND u.module_path IN (${placeholders})
           ON CONFLICT(snapshot_id, unit_id) DO NOTHING`,
        )
        .run(plan.toSnapshot, plan.fromSnapshot, ...plan.carriedFiles);

      // Carried unresolved references are part of the graph's known uncertainty. Omitting
      // them (the DEV-P0-04 defect) made the incremental projection understate what the
      // recognizer could not resolve. Cleared first so a re-run of carryForward is idempotent.
      db.prepare(
        `DELETE FROM unresolved_refs
          WHERE snapshot_id = ? AND path IN (${placeholders})`,
      ).run(plan.toSnapshot, ...plan.carriedFiles);

      const unresolvedRefs = db
        .prepare(
          `INSERT INTO unresolved_refs (snapshot_id, kind, detail, path, start_line, from_unit)
           SELECT ?, kind, detail, path, start_line, from_unit
             FROM unresolved_refs
            WHERE snapshot_id = ? AND path IN (${placeholders})`,
        )
        .run(plan.toSnapshot, plan.fromSnapshot, ...plan.carriedFiles);

      db.exec('COMMIT');
      return {
        unitsCarried: units.changes,
        edgesCarried: edges.changes,
        classesCarried: classes.changes,
        unresolvedCarried: unresolvedRefs.changes,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Units whose classification must be recomputed.
   *
   * Impact is reverse reachability, so an edge appearing or vanishing inside a
   * re-extracted module changes the impact set of everything that module *depends on* —
   * not of the module itself. The surface is therefore the forward dependency closure
   * of the re-extracted units, plus those units, plus everything the removed files
   * pointed at.
   *
   * Percentiles are global and are deliberately not part of this set: recomputing them
   * is a sort over impact sizes that are already stored, so the cheap part of
   * classification is simply redone for every unit while the expensive traversals are
   * confined to this surface.
   */
  public classificationSurface(plan: ScanPlan): string[] {
    if (plan.fullRescan || plan.fromSnapshot === null) return [];

    const modules = [...plan.extractionSurface, ...plan.droppedFiles];
    if (modules.length === 0) return [];

    const placeholders = modules.map(() => '?').join(', ');
    const rows = this.projections.db
      .prepare(
        `WITH RECURSIVE seed(unit_id) AS (
           SELECT unit_id FROM units
            WHERE snapshot_id = ? AND module_path IN (${placeholders})
         ),
         closure(unit_id, depth) AS (
           SELECT unit_id, 0 FROM seed
           UNION
           SELECT e.to_unit, closure.depth + 1
             FROM graph_edges e
             JOIN closure ON e.from_unit = closure.unit_id
            WHERE e.snapshot_id = ? AND e.external = 0 AND closure.depth < 12
         )
         SELECT DISTINCT i.logical_id AS logical_id
           FROM closure c JOIN unit_ids i ON i.unit_id = c.unit_id`,
      )
      .all(plan.fromSnapshot, ...modules, plan.fromSnapshot);

    return rows.map((row) => readString(readObject(row, 'closure row'), 'logical_id')).sort();
  }

  /**
   * Compares two snapshots' projections.
   *
   * This is how the gate clause becomes testable rather than merely asserted: recognise
   * a tree fully, recognise it again incrementally after a change, recognise the changed
   * tree fully, and compare. If the incremental and full projections differ, the cache
   * invalidated the wrong surface — and the comparison names exactly which units.
   */
  public compareProjections(snapshotA: string, snapshotB: string): ProjectionComparison {
    const db = this.projections.db;

    const unitsOf = (snapshot: string): Map<string, string> => {
      const map = new Map<string, string>();
      for (const row of db
        .prepare(
          `SELECT i.logical_id AS logical_id, u.version_hash AS version_hash
             FROM units u JOIN unit_ids i ON i.unit_id = u.unit_id
            WHERE u.snapshot_id = ?`,
        )
        .all(snapshot)) {
        const record = readObject(row, 'units row');
        map.set(readString(record, 'logical_id'), readString(record, 'version_hash'));
      }
      return map;
    };

    const a = unitsOf(snapshotA);
    const b = unitsOf(snapshotB);

    const onlyInA: string[] = [];
    const onlyInB: string[] = [];
    const differing: string[] = [];

    for (const [logicalId, hash] of a) {
      const other = b.get(logicalId);
      if (other === undefined) onlyInA.push(logicalId);
      else if (other !== hash) differing.push(logicalId);
    }
    for (const logicalId of b.keys()) {
      if (!a.has(logicalId)) onlyInB.push(logicalId);
    }

    const edgeCount = (snapshot: string): number =>
      readNumber(
        readObject(
          db.prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ?').get(snapshot),
          'edge count row',
        ),
        'n',
      );

    const edgesA = edgeCount(snapshotA);
    const edgesB = edgeCount(snapshotB);

    return {
      unitsOnlyInA: onlyInA.sort(),
      unitsOnlyInB: onlyInB.sort(),
      unitsDiffering: differing.sort(),
      edgesOnlyInA: Math.max(0, edgesA - edgesB),
      edgesOnlyInB: Math.max(0, edgesB - edgesA),
      identical:
        onlyInA.length === 0 && onlyInB.length === 0 && differing.length === 0 && edgesA === edgesB,
    };
  }

  public planOf(snapshotId: string): ScanPlanRecord | null {
    const row = this.projections.db
      .prepare('SELECT * FROM scan_plans WHERE to_snapshot = ?')
      .get(snapshotId);
    if (row === undefined) return null;
    const record = readObject(row, 'scan_plans row');
    return parseOrThrow(
      scanPlanRecordSchema,
      {
        ...record,
        full_rescan: record['full_rescan'] === 1,
        project_recognition: parseNullableRecognition(record['project_recognition']),
      },
      'scan_plans row',
    );
  }

  /**
   * Records that an incremental merge produced a complete result. Append this after the
   * merged result has been handed to the graph registry, so the provenance (base result
   * hash, produced hash, merge version) is durable evidence of a reconstructed — not
   * fragmentary — recognition.
   */
  public recordMerge(fromSnapshot: string, toSnapshot: string, merge: IncrementalMerge): void {
    const record = parseOrThrow(
      scanMergeRecordSchema,
      {
        to_snapshot: toSnapshot,
        from_snapshot: fromSnapshot,
        merged_at: nowIso(),
        previous_result_hash: merge.previousResultHash,
        merged_result_hash: merge.mergedResultHash,
        merge_version: merge.mergeVersion,
        carried_count: merge.carriedModules.length,
        extracted_count: merge.extractedModules.length,
        dropped_count: merge.droppedModules.length,
        project_recognition: merge.result.basis.projectRecognition ?? null,
      },
      `scan merge for ${toSnapshot}`,
    );

    this.log.append({
      type: SCAN_EVENT_TYPES.scanMerged,
      actor: 'daemon',
      missionVersion: this.missionVersion(),
      subjectId: null,
      payload: record,
    });
    this.projections.sync(this.log);
  }

  public mergeOf(snapshotId: string): ScanMergeRecord | null {
    const row = this.projections.db
      .prepare('SELECT * FROM scan_merges WHERE to_snapshot = ?')
      .get(snapshotId);
    if (row === undefined) return null;
    const record = readObject(row, 'scan_merges row');
    return parseOrThrow(
      scanMergeRecordSchema,
      { ...record, project_recognition: parseNullableRecognition(record['project_recognition']) },
      'scan_merges row',
    );
  }

  /* ------------------------------ internals --------------------------- */

  /** Every condition under which carrying anything forward would be unjustified. */
  private checkFullRescan(
    fromSnapshot: string | null,
    options: PlanOptions,
  ): FullRescanReason | null {
    if (options.force === true) return 'requested';
    if (fromSnapshot === null) return 'no-previous-recognition';

    const row = this.projections.db
      .prepare('SELECT compiler_options_hash, complete, artifact_hash, basis_hash FROM recognitions WHERE snapshot_id = ?')
      .get(fromSnapshot);
    if (row === undefined) return 'previous-snapshot-missing';

    const record = readObject(row, 'recognitions row');
    if (record['complete'] !== 1) return 'previous-projection-incomplete';

    // A tsconfig edit can change module resolution for files whose bytes never moved,
    // so nothing from the previous program can be trusted.
    if (readString(record, 'compiler_options_hash') !== options.compilerOptionsHash) {
      return 'compiler-options-changed';
    }

    const previousBasis = this.recognitionBasisOf(record);
    if (previousBasis === null) return 'previous-artifact-unavailable';
    const current = options.currentBasis;
    if (
      current !== undefined &&
      (
        current.tsconfigPath !== previousBasis.tsconfigPath ||
        current.tsconfigHash !== previousBasis.tsconfigHash ||
        current.tsCompilerVersion !== previousBasis.tsCompilerVersion ||
        current.recognizerVersion !== previousBasis.recognizerVersion ||
        current.identityAlgorithm !== previousBasis.identityAlgorithm ||
        current.lockfileHash !== previousBasis.lockfileHash
      )
    ) {
      return 'recognition-configuration-changed';
    }
    const previousRecognition = previousBasis.projectRecognition;
    if (options.projectRecognition !== undefined) {
      if (
        previousRecognition === undefined ||
        !projectRecognitionIdentityEquals(previousRecognition, options.projectRecognition)
      ) {
        return 'recognition-configuration-changed';
      }
    } else if (previousRecognition !== undefined) {
      // A legacy run must never reuse a Project Profile-bound recognition artifact.
      return 'recognition-configuration-changed';
    }

    return null;
  }

  private recognitionBasisOf(record: Record<string, unknown>): z.infer<typeof recognitionBasisSchema> | null {
    const artifactHash = record['artifact_hash'];
    if (typeof artifactHash !== 'string' || artifactHash.length === 0) return null;
    try {
      const raw = this.artifacts.getJson(requireSha256(artifactHash, 'recognition artifact hash'));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
      const artifact = raw as Record<string, unknown>;
      const parsed = recognitionBasisSchema.safeParse(artifact['basis']);
      if (!parsed.success) return null;
      const digest = hashCanonicalJson(parsed.data);
      if (digest !== artifact['basis_hash'] || digest !== record['basis_hash']) return null;
      return parsed.data;
    } catch {
      // Missing or unreadable evidence always requires a full scan.
      return null;
    }
  }

  private modulesOf(snapshotId: string): string[] {
    return this.projections.db
      .prepare('SELECT DISTINCT module_path FROM units WHERE snapshot_id = ?')
      .all(snapshotId)
      .map((row) => readString(readObject(row, 'units row'), 'module_path'));
  }

  private recordPlan(plan: ScanPlan): void {
    const artifact = this.artifacts.putJson(plan, {
      label: `scan-plan-${plan.toSnapshot.slice(0, 12)}.json`,
    });

    const record = parseOrThrow(
      scanPlanRecordSchema,
      {
        to_snapshot: plan.toSnapshot,
        from_snapshot: plan.fromSnapshot,
        planned_at: nowIso(),
        plan_hash: artifact.hash,
        changed_count: plan.changedFiles.length,
        extraction_count: plan.extractionSurface.length,
        carried_count: plan.carriedFiles.length,
        dropped_count: plan.droppedFiles.length,
        full_rescan: plan.fullRescan,
        full_rescan_reason: plan.fullRescanReason,
        project_recognition: plan.projectRecognition,
      },
      `scan plan for ${plan.toSnapshot}`,
    );

    this.log.append({
      type: SCAN_EVENT_TYPES.scanPlanned,
      actor: 'daemon',
      missionVersion: this.missionVersion(),
      subjectId: null,
      payload: record,
    });
    this.projections.sync(this.log);
  }
}

/* ------------------------------------------------------------------------- */
/* Complete-result merge (DEV-P0-04)                                          */
/* ------------------------------------------------------------------------- */

/**
 * Canonically orders a recognition result's units, edges, and unresolved references.
 *
 * The result artifact is hashed as canonical JSON, which fixes object-key order but
 * preserves array order — so two results are bit-identical only when their arrays are. A
 * full scan emits in traversal order and an incremental merge in a different order; sorting
 * both by a stable key is what lets an incremental scan and a full scan of the same tree
 * produce the same result hash. The graph registry applies this same ordering before it
 * stores a result, so the full and incremental paths share one canonical form.
 */
export function canonicaliseRecognitionResult(result: RecognitionResult): RecognitionResult {
  const units = [...result.units].sort((a, b) => compareStrings(a.logicalId, b.logicalId));
  const edges = [...result.edges].sort((a, b) => compareStrings(edgeSortKey(a), edgeSortKey(b)));
  const unresolved = [...result.unresolved].sort((a, b) =>
    compareStrings(unresolvedSortKey(a), unresolvedSortKey(b)),
  );
  return { ...result, units, edges, unresolved };
}

/**
 * Merges a restricted rescan back onto the previous complete result.
 *
 * The output is one complete result: every re-extracted file's units, edges, and
 * unresolved references taken fresh; every carried file's taken verbatim from the base
 * result; removed files dropped. This is the artifact the graph registry persists, so a
 * rehydration after the database is deleted reconstructs the whole graph rather than only
 * the re-extracted fragment. Carried files never reference re-extracted or removed files —
 * a dependency on a changed module puts the dependent into the extraction surface — so the
 * carried units and edges remain internally consistent under the merge.
 */
export function mergeIncrementalResult(args: {
  readonly plan: ScanPlan;
  readonly fresh: RecognitionResult;
  // Only the carried units/edges/unresolved are read from the base result, so the graph's stored
  // {units, edges, unresolved} suffices — the caller need not reconstruct a full RecognitionResult.
  readonly previous: Pick<RecognitionResult, 'units' | 'edges' | 'unresolved'>;
  readonly previousResultHash: string;
}): IncrementalMerge {
  const { plan, fresh, previous, previousResultHash } = args;
  const carried = new Set(plan.carriedFiles);
  const extracted = new Set(plan.extractionSurface);

  const units: SourceUnit[] = [
    ...fresh.units.filter((unit) => extracted.has(unit.modulePath)),
    ...previous.units.filter((unit) => carried.has(unit.modulePath)),
  ];
  const edges: SourceEdge[] = [
    ...fresh.edges.filter((edge) => extracted.has(moduleOfEdge(edge))),
    ...previous.edges.filter((edge) => carried.has(moduleOfEdge(edge))),
  ];
  const unresolved: UnresolvedReference[] = [
    ...fresh.unresolved.filter((reference) => extracted.has(reference.anchor.path)),
    ...previous.unresolved.filter((reference) => carried.has(reference.anchor.path)),
  ];

  // The merged result covers the whole program (carried + re-extracted), so its basis must declare a
  // FULL extraction scope — the fresh run's basis names only the restricted surface it re-extracted.
  // Every other field already describes the whole program on the fresh run (the same ts.Program was
  // compiled; only extraction was restricted), so only the scope changes and the hash is recomputed to
  // stay consistent (DEV-P0-04). This is what lets the graph registry recognise the merged artifact as a
  // complete result and replace the snapshot's rows exactly, rather than merging it as a subset.
  const mergedBasis: RecognitionBasis = { ...fresh.basis, extractionScope: { mode: 'full' } };

  const merged = canonicaliseRecognitionResult({
    projectRoot: fresh.projectRoot,
    tsconfigPath: fresh.tsconfigPath,
    compilerOptionsHash: fresh.compilerOptionsHash,
    basis: mergedBasis,
    basisHash: hashCanonicalJson(mergedBasis),
    units,
    edges,
    unresolved,
    stats: {
      // The program is the same whole program on the fresh run; only extraction was
      // restricted. Diagnostics and program size therefore carry from the fresh run, while
      // the by-kind tallies and recognised-file count describe the complete merged graph.
      filesInProgram: fresh.stats.filesInProgram,
      filesRecognised: units.filter((unit) => unit.kind === 'module').length,
      unitsByKind: tally(units, (unit) => unit.kind),
      edgesByKind: tally(edges, (edge) => edge.kind),
      unresolvedByKind: tally(unresolved, (reference) => reference.kind),
      syntacticDiagnostics: fresh.stats.syntacticDiagnostics,
      semanticDiagnostics: fresh.stats.semanticDiagnostics,
      elapsedMs: fresh.stats.elapsedMs,
    },
    // The whole program is the fresh run's program; only extraction was restricted (DEV-P0-03).
    programFiles: fresh.programFiles,
  });

  return {
    result: merged,
    previousResultHash,
    mergedResultHash: hashCanonicalJson({
      units: merged.units,
      edges: merged.edges,
      unresolved: merged.unresolved,
    }),
    mergeVersion: MERGE_VERSION,
    carriedModules: [...carried].sort(compareStrings),
    extractedModules: [...plan.extractionSurface].sort(compareStrings),
    droppedModules: [...new Set(plan.droppedFiles)].sort(compareStrings),
  };
}

/**
 * Full-oracle parity check (DEV-P0-04). The incremental merge is an optimisation; the full-extraction
 * probe — the whole program recognised fresh — is the oracle. Returns true when the merged graph's
 * basis and content match the probe, so the incremental result may be recorded. False means some
 * file's resolution moved in a way the extraction surface did not capture (an added module shadowing a
 * directory index, say), so the merged result carries a stale edge whose endpoints both exist — invisible
 * to endpoint validation — and the caller must record the probe instead. This is the safety net that
 * makes the incremental path's final artifact equal to a full scan even under adversarial resolution.
 */
export function incrementalMatchesOracle(merge: IncrementalMerge, probe: RecognitionResult): boolean {
  if (merge.result.basisHash !== probe.basisHash) return false;
  const oracle = canonicaliseRecognitionResult(probe);
  const oracleHash = hashCanonicalJson({
    units: oracle.units,
    edges: oracle.edges,
    unresolved: oracle.unresolved,
  });
  return merge.mergedResultHash === oracleHash;
}

/** Source module of an edge: the part of its `from` id before `#`, or the whole module id. */
function moduleOfEdge(edge: SourceEdge): string {
  const hash = edge.from.indexOf('#');
  return hash === -1 ? edge.from : edge.from.slice(0, hash);
}

function edgeSortKey(edge: SourceEdge): string {
  return JSON.stringify([
    edge.from,
    edge.to,
    edge.kind,
    edge.anchor.startLine,
    edge.anchor.startByte,
    edge.external,
    edge.confidence,
  ]);
}

function unresolvedSortKey(reference: UnresolvedReference): string {
  return JSON.stringify([
    reference.kind,
    reference.anchor.path,
    reference.anchor.startLine,
    reference.anchor.startByte,
    reference.fromLogicalId,
    reference.detail,
  ]);
}

function tally<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const bucket = key(item);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------------- */
/* Row reading                                                                */
/* ------------------------------------------------------------------------- */

function parseNullableRecognition(value: unknown): ProjectRecognitionIdentity | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Expected project_recognition JSON or null');
  return projectRecognitionIdentitySchema.parse(JSON.parse(value));
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

function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number') throw new Error(`Expected numeric field "${field}"`);
  return value;
}
