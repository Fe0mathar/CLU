/**
 * CLUE unit graph.
 *
 * Spec: CLUE_Architecture_v8.md (integer-id adjacency; unit identity & behaviour closure;
 *       edge taxonomy; compact export), CLUE_Execution_Model_v8.md (rescan & rehydration).
 * Backlog: DEV-P0-05 — identity schema (identity-v4 in force), recognition-run key,
 *          complete-artifact validation, exact idempotent rehydration, and endpoint integrity.
 *          DEV-P1-28 (phase 3) — the recognition stage of the evidence spine: `spineLink`/
 *          `spineSeal` bind a recorded run's key, basis hash, result hash, and artifact hash to
 *          the snapshot seal, and `verifyRecognitionLink` checks a presented link against the
 *          snapshot predecessor and this registry's own durable run history.
 *
 * Revision 3 — the classification model is corrected to the Creator's definition.
 *
 * Revisions 1 and 2 collapsed two independent questions into a single enum and lost one
 * of them entirely. The Creator's model has **two axes**:
 *
 *     file span            monofile   | polyfile
 *     dependency surface   monodependency | polydependency
 *
 * which yields four quadrants, and a **separate** blast-radius class — local, systemic,
 * foundational, protected — that describes reach rather than shape. Blast radius does
 * not replace the quadrant; a unit has both, and they answer different questions:
 *
 *     quadrant      how hard is this to change *correctly*
 *     blast radius  how much breaks if I get it wrong
 *
 * A small helper called from one place is monofile-monodependency with a local blast
 * radius: the ideal pilot. A small helper called from everywhere is the same quadrant
 * with a foundational blast radius: equally easy to edit, and nothing like as safe. The
 * old single enum could not express that difference, which is precisely why the
 * distinction was worth restoring.
 *
 * `unitClass` survives as a compatibility projection so that consumers written against
 * revision 2 continue to compile. It is derived, not stored reasoning, and it is
 * scheduled for removal once `ranking.ts` consumes the quadrant directly. Nothing new
 * should be built on it.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';

import { hashCanonicalJson, nowIso, requireSha256 } from '../../shared/ids.js';
import {
  EvidenceChainError,
  requireSpineHash,
  requireSpineId,
  sealLink as sealEvidenceLink,
  verifyLink as verifyEvidenceLink,
  type BindingHash,
  type RecognitionLink,
  type SnapshotLink,
} from '../../shared/evidenceIdentity.js';
import { parseOrThrow, recognitionBasisSchema } from '../../shared/schemas.js';
import type { ArtifactStore } from '../../memory/artifactStore.js';
import type { EventLog } from '../../memory/eventLog.js';
import type { ProjectionStore, Projector } from '../../memory/db.js';
import {
  assertProjectRecognitionIdentity,
  type ProjectRecognitionIdentity,
} from '../../shared/projectRecognitionIdentity.js';
import { canonicaliseRecognitionResult } from './scanCache.js';
import type {
  EdgeKind,
  RecognitionResult,
  SourceEdge,
  SourceUnit,
  UnitKind,
  UnresolvedReference,
} from './recognizer.js';

type Db = Database.Database;

/**
 * Raised when a recognition result would violate a graph invariant — a duplicate unit or
 * edge key, or an internal edge with no unit endpoint. Every rejection writes a diagnostic
 * artifact first, whose hash is carried here, so the violation is durable evidence rather
 * than a lost exception.
 */
export class GraphIntegrityError extends Error {
  public readonly code:
    | 'duplicate-unit-key'
    | 'duplicate-edge-key'
    | 'dangling-edge-endpoint'
    | 'artifact-content-mismatch';
  public readonly diagnosticHash: string;

  public constructor(code: GraphIntegrityError['code'], message: string, diagnosticHash: string) {
    super(message);
    this.name = 'GraphIntegrityError';
    this.code = code;
    this.diagnosticHash = diagnosticHash;
  }
}

/* ------------------------------------------------------------------------- */
/* Classification vocabulary                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Whether a unit's behaviour is confined to one file.
 *
 * A *declaration* always lives in one file, so this is a statement about the behaviour
 * closure: the unit plus the private collaborators that exist only to serve it. A unit
 * whose helpers live beside it is monofile; one whose implementation is spread across
 * modules is polyfile, and changing it means changing several files coherently.
 */
export type FileSpan = 'monofile' | 'polyfile';

/**
 * How many distinct modules the behaviour closure reaches out to.
 *
 * At most one is `monodependency` — the shape that can be changed and proven without
 * dragging other subsystems into the experiment.
 */
export type DependencySurface = 'monodependency' | 'polydependency';

export type Quadrant =
  | 'monofile-monodependency'
  | 'monofile-polydependency'
  | 'polyfile-monodependency'
  | 'polyfile-polydependency';

/**
 * How far a mistake would travel.
 *
 *   local        contained within one subsystem
 *   systemic     reaches across subsystems; a change here is a design decision
 *   foundational most of the project sits downstream
 *   protected    deliberate, declared by the Creator, never changed automatically
 */
export type BlastRadius = 'local' | 'systemic' | 'foundational' | 'protected';

/**
 * Compatibility projection of the revision-2 enum.
 *
 * Derived from the quadrant and the blast radius so that existing consumers keep
 * compiling. Do not extend it; use `quadrant` and `blastRadius`.
 */
export type UnitClass = 'monodependency' | 'local' | 'systemic' | 'foundational';

export interface ClassificationThresholds {
  /** Impact percentile at or above which a unit is foundational. */
  readonly foundationalPercentile: number;
  /** Subsystem count at or above which a unit is foundational regardless of percentile. */
  readonly foundationalSubsystems: number;
  /** How close to a boundary counts as "near it" when reducing confidence. */
  readonly boundaryMargin: number;
  /** Distinct external modules a closure may reach and still be monodependency. */
  readonly monodependencyLimit: number;
  /** Depth limit when walking a behaviour closure. */
  readonly closureDepth: number;
}

export const DEFAULT_THRESHOLDS: ClassificationThresholds = {
  foundationalPercentile: 0.95,
  foundationalSubsystems: 3,
  boundaryMargin: 0.05,
  monodependencyLimit: 1,
  closureDepth: 6,
};

/** Minimal shape a protected-surface matcher needs. `SourceUnit` satisfies it. */
export type ProtectedMatcher = (unit: {
  logicalId: string;
  modulePath: string;
  name: string;
  kind: string;
}) => string | null;

/* ------------------------------------------------------------------------- */
/* Records                                                                    */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const recognitionRecordSchema = z
  .object({
    snapshot_id: sha256,
    recognised_at: isoTime,
    result_hash: sha256,
    compiler_options_hash: sha256,
    unit_count: z.number().int().nonnegative(),
    edge_count: z.number().int().nonnegative(),
    unresolved_count: z.number().int().nonnegative(),
    syntactic_diagnostics: z.number().int().nonnegative(),
    semantic_diagnostics: z.number().int().nonnegative(),
    files_in_program: z.number().int().nonnegative(),
    files_recognised: z.number().int().nonnegative(),
    elapsed_ms: z.number().int().nonnegative(),
    complete: z.boolean(),
    /** Content hash of the recognition basis (identity algorithm, program files, options). */
    basis_hash: z.string().optional(),
    /** Identity of this recognition run: binds snapshot, result, options, and basis. */
    run_key: z.string().optional(),
    /** Hash of the complete stored artifact (envelope + content); distinct from result_hash. */
    artifact_hash: z.string().optional(),
  })
  .strict();

export type RecognitionRecord = z.infer<typeof recognitionRecordSchema>;

/** Current schema version of the complete recognition artifact. */
export const RECOGNITION_ARTIFACT_VERSION = 1;

/**
 * Strict schema for the complete stored recognition artifact (DEV-P0-05). The artifact is a full,
 * versioned record — basis, basis hash, run identity, completeness, stats, merge provenance, and the
 * graph content — not just `{ units, edges, unresolved }`. Every read parses through this schema and
 * verifies `content_hash`, so a corrupt or truncated artifact, or one missing fields, is refused
 * rather than silently returning a partial graph. The nested structures are validated to the exact
 * recognizer shapes — a unit with an invalid kind, an edge missing an endpoint, or a basis with a
 * malformed hash is rejected on read even when the content hash matches, which the shallow
 * `z.record(z.unknown())` fields it replaces could not do.
 */
const unitAnchorSchema = z
  .object({
    path: z.string(),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().nonnegative(),
  })
  .strict();

const unitKindSchema = z.enum([
  'module',
  'function',
  'class',
  'method',
  'interface',
  'typeAlias',
  'enum',
  'variable',
  'property',
]);
const edgeKindSchema = z.enum([
  'imports',
  'reexports',
  'calls',
  'instantiates',
  'extends',
  'implements',
  'references',
  'declares',
]);
const unresolvedKindSchema = z.enum([
  'dynamic-import',
  'module-unresolved',
  'call-target-unknown',
  'symbol-ambiguous',
  'declaration-missing',
]);

/** A recognised unit, validated to the exact recognizer SourceUnit shape (DEV-P0-05). */
const artifactUnitSchema = z
  .object({
    logicalId: z.string().min(1),
    versionHash: sha256,
    kind: unitKindSchema,
    name: z.string(),
    qualifiedName: z.string(),
    modulePath: z.string(),
    exported: z.boolean(),
    anchor: unitAnchorSchema,
    parentLogicalId: z.string().nullable(),
    lineCount: z.number().int().nonnegative(),
    byteLength: z.number().int().nonnegative(),
    isAsync: z.boolean(),
    parameterCount: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** A recognised edge, validated to the exact recognizer SourceEdge shape (DEV-P0-05). */
const artifactEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: edgeKindSchema,
    confidence: z.number(),
    external: z.boolean(),
    anchor: unitAnchorSchema,
  })
  .strict();

/** An unresolved reference, validated to the exact recognizer shape (DEV-P0-05). */
const artifactUnresolvedSchema = z
  .object({
    kind: unresolvedKindSchema,
    detail: z.string(),
    anchor: unitAnchorSchema,
    fromLogicalId: z.string().nullable(),
  })
  .strict();

/** Recognition statistics, validated to the exact recognizer RecognitionStats shape (DEV-P0-05). */
const artifactStatsSchema = z
  .object({
    filesInProgram: z.number().int().nonnegative(),
    filesRecognised: z.number().int().nonnegative(),
    unitsByKind: z.record(z.string(), z.number().int().nonnegative()),
    edgesByKind: z.record(z.string(), z.number().int().nonnegative()),
    unresolvedByKind: z.record(z.string(), z.number().int().nonnegative()),
    syntacticDiagnostics: z.number().int().nonnegative(),
    semanticDiagnostics: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();

/** Merge provenance embedded when an incremental scan produced the result (DEV-P0-05). */
const artifactMergeSchema = z
  .object({
    previousResultHash: z.string(),
    mergeVersion: z.string(),
    carriedCount: z.number().int().nonnegative(),
    extractedCount: z.number().int().nonnegative(),
    droppedCount: z.number().int().nonnegative(),
  })
  .strict();

export const recognitionArtifactSchema = z
  .object({
    schema_version: z.literal(RECOGNITION_ARTIFACT_VERSION),
    content_hash: sha256,
    basis: recognitionBasisSchema,
    basis_hash: sha256,
    run_key: sha256,
    complete: z.boolean(),
    stats: artifactStatsSchema,
    merge: artifactMergeSchema.nullable(),
    units: z.array(artifactUnitSchema),
    edges: z.array(artifactEdgeSchema),
    unresolved: z.array(artifactUnresolvedSchema),
  })
  .strict();

/** Provenance of an incremental run, embedded in the complete artifact when a merge produced it. */
export interface RecognitionMergeProvenance {
  readonly previousResultHash: string;
  readonly mergeVersion: string;
  readonly carriedCount: number;
  readonly extractedCount: number;
  readonly droppedCount: number;
}

/**
 * A classification, reported with every component that produced it.
 *
 * Both axes and the blast radius are present, along with the closure measurements that
 * decided them. A number nobody can decompose is a number nobody can challenge, and a
 * wrong class silently blocks or permits a landing.
 */
export interface UnitClassification {
  readonly logicalId: string;

  readonly fileSpan: FileSpan;
  readonly dependencySurface: DependencySurface;
  readonly quadrant: Quadrant;
  readonly blastRadius: BlastRadius;
  /** @deprecated Compatibility projection of revisions 1-2. Use quadrant and blastRadius. */
  readonly unitClass: UnitClass;

  readonly confidence: number;
  /** Rank of this unit's impact size among all units, 0-1. */
  readonly percentile: number;

  /** Units in the behaviour closure, the subject included. */
  readonly closureSize: number;
  /** Distinct modules the closure occupies. One means monofile. */
  readonly closureModules: number;
  /** Distinct modules outside the closure that it depends on. */
  readonly externalModules: number;

  readonly impactSize: number;
  readonly impactModules: number;
  readonly impactSubsystems: number;
  readonly directDependents: number;
  /** True when the impact traversal stopped at the depth limit; size is a lower bound. */
  readonly truncated: boolean;
  readonly protectedReason: string | null;
  readonly reasons: readonly string[];
}

export interface CoverageEntry {
  readonly subsystem: string;
  readonly modules: number;
  readonly units: number;
  readonly edges: number;
  readonly unresolved: number;
  readonly unitsPerModule: number;
  readonly coverage: number;
}

export interface ImpactResult {
  readonly logicalId: string;
  readonly depth: number;
  readonly dependents: readonly string[];
  readonly modules: readonly string[];
  readonly subsystems: readonly string[];
  readonly truncated: boolean;
}

/** The behaviour closure of a unit: itself plus its private collaborators. */
export interface ClosureResult {
  readonly members: readonly string[];
  readonly modules: readonly string[];
  readonly externalModules: readonly string[];
  readonly truncated: boolean;
}

/* ------------------------------------------------------------------------- */
/* Schema                                                                     */
/* ------------------------------------------------------------------------- */

export const GRAPH_EVENT_TYPES = {
  recognitionCompleted: 'recognition.completed',
} as const;

export const GRAPH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recognitions (
  snapshot_id           TEXT PRIMARY KEY,
  recognised_at         TEXT NOT NULL,
  result_hash           TEXT NOT NULL,
  compiler_options_hash TEXT NOT NULL,
  unit_count            INTEGER NOT NULL,
  edge_count            INTEGER NOT NULL,
  unresolved_count      INTEGER NOT NULL,
  syntactic_diagnostics INTEGER NOT NULL,
  semantic_diagnostics  INTEGER NOT NULL,
  files_in_program      INTEGER NOT NULL,
  files_recognised      INTEGER NOT NULL,
  elapsed_ms            INTEGER NOT NULL,
  complete              INTEGER NOT NULL,
  basis_hash            TEXT NOT NULL DEFAULT '',
  run_key               TEXT NOT NULL DEFAULT '',
  artifact_hash         TEXT NOT NULL DEFAULT ''
);

-- DEV-P0-05: durable per-run history. \`recognitions\` is the current-run pointer for a snapshot
-- (snapshot_id primary key, overwritten when a snapshot is recognised again); \`recognition_runs\`
-- appends every distinct run keyed by run_key, so re-recognitions under a changed basis remain
-- separately queryable rather than silently replacing one another.
CREATE TABLE IF NOT EXISTS recognition_runs (
  run_key               TEXT PRIMARY KEY,
  snapshot_id           TEXT NOT NULL,
  recognised_at         TEXT NOT NULL,
  result_hash           TEXT NOT NULL,
  artifact_hash         TEXT NOT NULL,
  compiler_options_hash TEXT NOT NULL,
  basis_hash            TEXT NOT NULL,
  unit_count            INTEGER NOT NULL,
  edge_count            INTEGER NOT NULL,
  unresolved_count      INTEGER NOT NULL,
  complete              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS recognition_runs_snapshot ON recognition_runs(snapshot_id, recognised_at);

CREATE TABLE IF NOT EXISTS unit_ids (
  unit_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  logical_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS units (
  snapshot_id     TEXT NOT NULL,
  unit_id         INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,
  module_path     TEXT NOT NULL,
  subsystem       TEXT NOT NULL,
  exported        INTEGER NOT NULL,
  version_hash    TEXT NOT NULL,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  start_byte      INTEGER NOT NULL,
  end_byte        INTEGER NOT NULL,
  parent_unit_id  INTEGER,
  line_count      INTEGER NOT NULL,
  byte_length     INTEGER NOT NULL,
  is_async        INTEGER NOT NULL,
  parameter_count INTEGER,
  PRIMARY KEY (snapshot_id, unit_id)
);
CREATE INDEX IF NOT EXISTS units_module  ON units(snapshot_id, module_path);
CREATE INDEX IF NOT EXISTS units_kind    ON units(snapshot_id, kind);
CREATE INDEX IF NOT EXISTS units_version ON units(version_hash);

CREATE TABLE IF NOT EXISTS graph_edges (
  snapshot_id TEXT NOT NULL,
  from_unit   INTEGER NOT NULL,
  to_unit     INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  confidence  REAL NOT NULL,
  external    INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  start_byte  INTEGER NOT NULL,
  end_byte    INTEGER NOT NULL,
  -- DEV-P0-05: the key is the exact source anchor (start_byte, end_byte), not the line. Two calls to
  -- the same target on one line are distinct source observations and must both survive; start_line
  -- alone silently collapsed them.
  PRIMARY KEY (snapshot_id, from_unit, to_unit, kind, start_byte, end_byte)
);
CREATE INDEX IF NOT EXISTS graph_edges_to   ON graph_edges(snapshot_id, to_unit);
CREATE INDEX IF NOT EXISTS graph_edges_from ON graph_edges(snapshot_id, from_unit);

CREATE TABLE IF NOT EXISTS unresolved_refs (
  snapshot_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL,
  path        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  from_unit   INTEGER
);
CREATE INDEX IF NOT EXISTS unresolved_snapshot ON unresolved_refs(snapshot_id, path);

CREATE TABLE IF NOT EXISTS unit_classes (
  snapshot_id       TEXT NOT NULL,
  unit_id           INTEGER NOT NULL,
  class             TEXT NOT NULL,
  confidence        REAL NOT NULL,
  percentile        REAL NOT NULL,
  impact_size       INTEGER NOT NULL,
  impact_modules    INTEGER NOT NULL,
  impact_subsystems INTEGER NOT NULL,
  direct_dependents INTEGER NOT NULL,
  truncated         INTEGER NOT NULL DEFAULT 0,
  reasons           TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, unit_id)
);
CREATE INDEX IF NOT EXISTS unit_classes_class ON unit_classes(snapshot_id, class);
`;

/** Columns added after revision 2. Applied additively so an existing database survives. */
const ADDED_COLUMNS: readonly { table: string; column: string; definition: string }[] = [
  { table: 'unit_classes', column: 'file_span', definition: "TEXT NOT NULL DEFAULT 'monofile'" },
  {
    table: 'unit_classes',
    column: 'dependency_surface',
    definition: "TEXT NOT NULL DEFAULT 'monodependency'",
  },
  {
    table: 'unit_classes',
    column: 'quadrant',
    definition: "TEXT NOT NULL DEFAULT 'monofile-monodependency'",
  },
  { table: 'unit_classes', column: 'blast_radius', definition: "TEXT NOT NULL DEFAULT 'local'" },
  { table: 'unit_classes', column: 'closure_size', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'unit_classes', column: 'closure_modules', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'unit_classes', column: 'external_modules', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'unit_classes', column: 'protected_reason', definition: 'TEXT' },
  { table: 'recognitions', column: 'basis_hash', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'recognitions', column: 'run_key', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'recognitions', column: 'artifact_hash', definition: "TEXT NOT NULL DEFAULT ''" },
];

/**
 * Creates the schema, adding columns introduced after revision 2.
 *
 * `CREATE TABLE IF NOT EXISTS` will not alter a table that already exists, so a
 * workspace built under revision 2 would silently lack the new columns and fail on the
 * first insert. Projections are disposable and deleting the database would also work,
 * but forcing that on every schema change teaches the operator that losing state is
 * routine — which is the opposite of the habit this system depends on.
 */
export function ensureGraphSchema(db: Db): void {
  db.exec(GRAPH_SCHEMA_SQL);

  // graph_edges gained a byte-precise primary key (DEV-P0-05). A primary key cannot be altered in
  // place, and pre-byte rows carry no byte anchor to migrate, so when the old start_line-keyed table
  // is present the (disposable) edge projection is rebuilt: dropped here and repopulated on the next
  // recognize or rehydrate from the stored artifact, which carries the byte anchors.
  if (!hasColumn(db, 'graph_edges', 'start_byte')) {
    db.exec('DROP TABLE IF EXISTS graph_edges');
    db.exec(GRAPH_SCHEMA_SQL);
  }

  for (const { table, column, definition } of ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS unit_classes_quadrant ON unit_classes(snapshot_id, quadrant)');
  db.exec('CREATE INDEX IF NOT EXISTS unit_classes_blast ON unit_classes(snapshot_id, blast_radius)');
}

function hasColumn(db: Db, table: string, column: string): boolean {
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    if (typeof row === 'object' && row !== null) {
      const name = (row as Record<string, unknown>)['name'];
      if (name === column) return true;
    }
  }
  return false;
}

export const GRAPH_PROJECTORS: Readonly<Record<string, Projector>> = {
  [GRAPH_EVENT_TYPES.recognitionCompleted]: (db, record) => {
    const recognition = parseOrThrow(recognitionRecordSchema, record.payload, 'recognition.completed');
    const basisHash = recognition.basis_hash ?? '';
    const runKey =
      recognition.run_key ??
      hashCanonicalJson({
        snapshot_id: recognition.snapshot_id,
        result_hash: recognition.result_hash,
        compiler_options_hash: recognition.compiler_options_hash,
        basis_hash: basisHash,
      });
    const artifactHash = recognition.artifact_hash ?? '';
    // The current-run pointer for the snapshot: overwritten when the snapshot is recognised again.
    db.prepare(
      `INSERT INTO recognitions (
         snapshot_id, recognised_at, result_hash, compiler_options_hash, unit_count,
         edge_count, unresolved_count, syntactic_diagnostics, semantic_diagnostics,
         files_in_program, files_recognised, elapsed_ms, complete, basis_hash, run_key, artifact_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id) DO UPDATE SET
         recognised_at = excluded.recognised_at,
         result_hash = excluded.result_hash,
         compiler_options_hash = excluded.compiler_options_hash,
         unit_count = excluded.unit_count,
         edge_count = excluded.edge_count,
         unresolved_count = excluded.unresolved_count,
         syntactic_diagnostics = excluded.syntactic_diagnostics,
         semantic_diagnostics = excluded.semantic_diagnostics,
         files_in_program = excluded.files_in_program,
         files_recognised = excluded.files_recognised,
         elapsed_ms = excluded.elapsed_ms,
         complete = excluded.complete,
         basis_hash = excluded.basis_hash,
         run_key = excluded.run_key,
         artifact_hash = excluded.artifact_hash`,
    ).run(
      recognition.snapshot_id,
      recognition.recognised_at,
      recognition.result_hash,
      recognition.compiler_options_hash,
      recognition.unit_count,
      recognition.edge_count,
      recognition.unresolved_count,
      recognition.syntactic_diagnostics,
      recognition.semantic_diagnostics,
      recognition.files_in_program,
      recognition.files_recognised,
      recognition.elapsed_ms,
      recognition.complete ? 1 : 0,
      basisHash,
      runKey,
      artifactHash,
    );
    // Durable per-run history: a distinct run_key (a new result, or the same result under a changed
    // basis) appends a row; an identical re-run is idempotent. This keeps two runs of one snapshot
    // separately queryable rather than one silently replacing the other.
    db.prepare(
      `INSERT INTO recognition_runs (
         run_key, snapshot_id, recognised_at, result_hash, artifact_hash,
         compiler_options_hash, basis_hash, unit_count, edge_count, unresolved_count, complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key) DO NOTHING`,
    ).run(
      runKey,
      recognition.snapshot_id,
      recognition.recognised_at,
      recognition.result_hash,
      artifactHash,
      recognition.compiler_options_hash,
      basisHash,
      recognition.unit_count,
      recognition.edge_count,
      recognition.unresolved_count,
      recognition.complete ? 1 : 0,
    );
  },
};

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */

export interface GraphRegistryDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  readonly missionVersion: () => string;
  readonly thresholds?: ClassificationThresholds;
  /** Declares deliberate surfaces. A match sets the blast radius to `protected`. */
  readonly isProtected?: ProtectedMatcher;
}

export interface RecordResult {
  readonly record: RecognitionRecord;
  readonly classifications: readonly UnitClassification[];
  readonly coverage: readonly CoverageEntry[];}

/** One row of durable recognition-run history for a snapshot (see `GraphRegistry.runsOf`). */
export interface RecognitionRunSummary {
  readonly runKey: string;
  readonly snapshotId: string;
  readonly recognisedAt: string;
  readonly resultHash: string;
  readonly artifactHash: string;
  readonly compilerOptionsHash: string;
  readonly basisHash: string;
  readonly unitCount: number;
  readonly edgeCount: number;
  readonly unresolvedCount: number;
  readonly complete: boolean;
}

export interface ClassifyOptions {
  /** Logical ids whose measurements must be recomputed. Omit to recompute everything. */
  readonly only?: readonly string[];
}

const DEFAULT_IMPACT_DEPTH = 12;
/** Shared empty reverse-edge set for units nothing depends on (no per-unit allocation). */
const EMPTY_DEPENDENTS: ReadonlySet<number> = new Set<number>();

/** Edge kinds that carry implementation, and therefore build a behaviour closure. */
const CLOSURE_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'calls',
  'instantiates',
  'references',
  'extends',
  'implements',
]);

export class GraphRegistry {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly artifacts: ArtifactStore;
  private readonly missionVersion: () => string;
  private readonly thresholds: ClassificationThresholds;
  private readonly isProtected: ProtectedMatcher | null;

  public constructor(deps: GraphRegistryDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.artifacts = deps.artifacts;
    this.missionVersion = deps.missionVersion;
    this.thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
    this.isProtected = deps.isProtected ?? null;
    ensureGraphSchema(this.projections.db);
  }

  /* ------------------------------ recording --------------------------- */

  public record(
    snapshotId: string,
    result: RecognitionResult,
    options: {
      complete?: boolean;
      classify?: ClassifyOptions;
      merge?: RecognitionMergeProvenance | null;
    } = {},
  ): RecordResult {
    const complete = options.complete ?? true;

    // Canonical ordering so a full scan and an incremental merge of the same tree produce the same
    // content hash: the DEV-P0-04 seam. result_hash is the hash of the graph content alone (units,
    // edges, unresolved), so it stays stable across full vs incremental. The complete artifact stored
    // below additionally carries basis, stats, run identity, and merge provenance, and hashes to a
    // distinct artifact_hash — putJson(content).hash equals hashCanonicalJson(content), so result_hash
    // keeps the exact value the content-only artifact had.
    const canonical = canonicaliseRecognitionResult(result);
    const content = {
      units: canonical.units,
      edges: canonical.edges,
      unresolved: canonical.unresolved,
    };
    const contentHash = hashCanonicalJson(content);

    // Reject a violating result before it is ever recorded. Pure checks on logical ids and byte
    // anchors that write no projection rows, so they are safe to run before the event is appended.
    this.assertResultIntegrity(snapshotId, canonical.units, canonical.edges, {
      complete,
      resultHash: contentHash,
    });

    const runKey = hashCanonicalJson({
      snapshot_id: snapshotId,
      result_hash: contentHash,
      compiler_options_hash: canonical.compilerOptionsHash,
      basis_hash: canonical.basisHash,
    });

    // DEV-P0-05: persist ONE complete, versioned recognition artifact — basis, basis hash, run
    // identity, completeness, stats, merge provenance, and the graph content — and parse it strictly
    // on every read. content_hash pins the graph content inside the envelope.
    const artifact = this.artifacts.putJson(
      {
        schema_version: RECOGNITION_ARTIFACT_VERSION,
        content_hash: contentHash,
        basis: canonical.basis,
        basis_hash: canonical.basisHash,
        run_key: runKey,
        complete,
        stats: canonical.stats,
        merge: options.merge ?? null,
        ...content,
      },
      { label: `recognition-${snapshotId.slice(0, 12)}.json` },
    );

    const record = parseOrThrow(
      recognitionRecordSchema,
      {
        snapshot_id: snapshotId,
        recognised_at: nowIso(),
        result_hash: contentHash,
        compiler_options_hash: canonical.compilerOptionsHash,
        unit_count: canonical.units.length,
        edge_count: canonical.edges.length,
        unresolved_count: canonical.unresolved.length,
        syntactic_diagnostics: canonical.stats.syntacticDiagnostics,
        semantic_diagnostics: canonical.stats.semanticDiagnostics,
        files_in_program: canonical.stats.filesInProgram,
        files_recognised: canonical.stats.filesRecognised,
        elapsed_ms: canonical.stats.elapsedMs,
        complete,
        basis_hash: canonical.basisHash,
        run_key: runKey,
        artifact_hash: artifact.hash,
      },
      `recognition of ${snapshotId}`,
    );

    this.log.append({
      type: GRAPH_EVENT_TYPES.recognitionCompleted,
      actor: 'daemon',
      missionVersion: this.missionVersion(),
      subjectId: null,
      payload: record,
    });
    this.projections.sync(this.log);

    // Hydrate strictly after sync: the first sync rebuilds projections from zero, which would clear
    // rows written before it. Integrity was already checked. DEV-P0-05: a FULL-scope result covers the
    // entire program, so it replaces the snapshot's graph exactly (clearAll) and no stale row from a
    // prior recognition of the same snapshot survives. A RESTRICTED result is a subset — an incremental
    // re-extraction of only the changed surface — and must merge, preserving the rows carryForward wrote
    // for files it did not re-extract. Note this is the extraction SCOPE of THIS result, a different axis
    // from the `complete` flag (which records whether the resulting projection is complete, and is set
    // even for a restricted re-extraction once carried rows are already present); scope is what decides
    // replace-vs-merge, so a full re-recognition can no longer leave a stale edge behind.
    const fullScope = canonical.basis.extractionScope.mode === 'full';
    this.hydrate(snapshotId, canonical.units, canonical.edges, canonical.unresolved, {
      clearAll: fullScope,
    });
    const classifications = this.classify(snapshotId, options.classify ?? {});

    return { record, classifications, coverage: this.coverage(snapshotId) };
  }

  /**
   * Rebuilds the unit, edge, and unresolved tables from the stored artifact.
   *
   * Replay restores only the `recognitions` row, because the bulk of a recognition lives
   * in an artifact rather than in the event. This closes that loop, without which
   * "projections are disposable" would not be true of the graph.
   */
  public rehydrate(snapshotId: string): boolean {
    const recognition = this.recognition(snapshotId);
    if (recognition === null) return false;

    // Validate the artifact is complete before hydrating. Rehydrating an incomplete result
    // would rebuild a partial graph and present it as whole — precisely the failure DEV-P0-04
    // and this file exist to prevent. An incomplete record is a no-op with a diagnostic.
    if (!recognition.complete) {
      this.writeIntegrityDiagnostic(snapshotId, 'incomplete-artifact', {
        detail: 'recognition marked incomplete; refusing to rehydrate a partial graph',
        result_hash: recognition.result_hash,
        run_key: recognition.run_key ?? null,
      });
      return false;
    }

    const stored = this.resultOf(snapshotId);
    if (stored === null) return false;

    // Validate the stored artifact's endpoints on read before rebuilding from it.
    this.assertResultIntegrity(snapshotId, stored.units, stored.edges, {
      complete: true,
      resultHash: recognition.result_hash,
    });
    this.hydrate(snapshotId, stored.units, stored.edges, stored.unresolved, { clearAll: true });
    // Rehydration restores the whole committed graph, classifications included, so the
    // recovered state matches the state that was recorded rather than an unclassified subset.
    this.classify(snapshotId);
    return true;
  }

  /**
   * Rebuilds the artifact-backed bulk tables (units, edges, ids, unresolved refs, classes) for
   * every complete recognition. Event replay restores only the `recognitions` receipt — a projector
   * has no artifact access — so a full projection rebuild leaves the bulk tables empty until this
   * runs. Called from the projection module's rehydrate hook after replay. Reads and writes
   * projection rows only; it appends no events and triggers no sync, so it is safe mid-rebuild.
   */
  public rehydrateAll(): number {
    const rows = this.projections.db
      .prepare('SELECT snapshot_id FROM recognitions WHERE complete = 1')
      .all() as ReadonlyArray<{ snapshot_id: string }>;
    let restored = 0;
    for (const row of rows) {
      if (this.rehydrate(row.snapshot_id)) restored += 1;
    }
    return restored;
  }

  /**
   * Rejects a recognition result that would violate a graph invariant, writing a diagnostic
   * artifact and throwing before anything is recorded. Pure — it reasons over logical ids and
   * writes no projection rows, so callers run it before appending the recognition event.
   *
   *   - a duplicate unit logical id means two distinct declarations collided (the identity
   *     grammar in force guarantees uniqueness, so this is a hard error, never a silent
   *     ON CONFLICT merge);
   *   - every edge must have a real source unit, and a complete result must additionally
   *     resolve every internal target to a unit (a fragment may name a carried target that is
   *     outside the batch, so target integrity is enforced only for complete results);
   *   - two edges under one key carrying different payloads are ambiguous.
   */
  private assertResultIntegrity(
    snapshotId: string,
    units: readonly SourceUnit[],
    edges: readonly SourceEdge[],
    context: { readonly complete: boolean; readonly resultHash: string },
  ): void {
    const unitIds = new Set<string>();
    const duplicateUnits: string[] = [];
    for (const unit of units) {
      if (unitIds.has(unit.logicalId)) duplicateUnits.push(unit.logicalId);
      else unitIds.add(unit.logicalId);
    }
    if (duplicateUnits.length > 0) {
      this.rejectWithDiagnostic(snapshotId, 'duplicate-unit-key', {
        result_hash: context.resultHash,
        duplicate_count: duplicateUnits.length,
        duplicate_logical_ids: [...new Set(duplicateUnits)].slice(0, 50),
      });
    }

    const dangling: string[] = [];
    for (const edge of edges) {
      if (!unitIds.has(edge.from)) dangling.push(`${edge.from} (missing source)`);
      if (context.complete && !edge.external && !unitIds.has(edge.to)) {
        dangling.push(`${edge.from} -> ${edge.to} (${edge.kind})`);
      }
    }
    if (dangling.length > 0) {
      this.rejectWithDiagnostic(snapshotId, 'dangling-edge-endpoint', {
        result_hash: context.resultHash,
        complete: context.complete,
        dangling_count: dangling.length,
        dangling: [...new Set(dangling)].slice(0, 50),
      });
    }

    const seenEdges = new Set<string>();
    const duplicateEdges: string[] = [];
    for (const edge of edges) {
      // The persistence key is the exact source anchor. Any two edges sharing it are one source
      // observation recorded twice — rejected outright, never silently merged. Distinct calls to the
      // same target sit at different byte ranges, so they remain distinct rather than collapsing.
      const key = `${edge.from}|${edge.to}|${edge.kind}|${edge.anchor.startByte}|${edge.anchor.endByte}`;
      if (seenEdges.has(key)) {
        duplicateEdges.push(`${edge.from} -> ${edge.to} (${edge.kind}) @${edge.anchor.startByte}`);
      } else {
        seenEdges.add(key);
      }
    }
    if (duplicateEdges.length > 0) {
      this.rejectWithDiagnostic(snapshotId, 'duplicate-edge-key', {
        result_hash: context.resultHash,
        duplicate_count: duplicateEdges.length,
        duplicate: [...new Set(duplicateEdges)].slice(0, 50),
      });
    }
  }

  /**
   * Inserts a snapshot's units, edges, and unresolved references. Two modes serve two callers:
   *
   *   - `clearAll: true` (rehydration) clears every row the snapshot owns first, so rebuilding
   *     from the stored artifact is exact and idempotent — no stale row can survive.
   *   - `clearAll: false` (recording) merges: it refreshes only unresolved references and
   *     upserts units and edges, so rows an incremental scan carried forward into this snapshot
   *     (`ScanCache.carryForward`) are preserved rather than wiped by a restricted re-extraction.
   *
   * Either way the caller has already run assertResultIntegrity. Units and edges are upserted;
   * because the identity grammar keeps logical ids unique and the edge key is the exact byte anchor, an
   * ON CONFLICT can only be the identical row (idempotent replay or a carried edge re-seen), never a
   * silent merge of two distinct source observations as the old start_line key allowed. In merge
   * mode the snapshot's edges are preserved so a restricted re-extraction keeps carried edges.
   */
  private hydrate(
    snapshotId: string,
    units: readonly SourceUnit[],
    edges: readonly SourceEdge[],
    unresolved: readonly UnresolvedReference[],
    options: { readonly clearAll: boolean },
  ): void {
    const db = this.projections.db;
    const idOf = this.makeIdResolver();

    const unitRows = units.map((unit) => ({
      unit,
      id: idOf(unit.logicalId),
      parentId: unit.parentLogicalId === null ? null : idOf(unit.parentLogicalId),
    }));
    const edgeRows = edges.map((edge) => ({ edge, from: idOf(edge.from), to: idOf(edge.to) }));
    const unresolvedRows = unresolved.map((reference) => ({
      reference,
      fromId: reference.fromLogicalId === null ? null : idOf(reference.fromLogicalId),
    }));

    const insertUnit = db.prepare(
      `INSERT INTO units (
         snapshot_id, unit_id, kind, name, qualified_name, module_path, subsystem,
         exported, version_hash, start_line, end_line, start_byte, end_byte,
         parent_unit_id, line_count, byte_length, is_async, parameter_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, unit_id) DO UPDATE SET
         version_hash = excluded.version_hash,
         start_line = excluded.start_line, end_line = excluded.end_line,
         start_byte = excluded.start_byte, end_byte = excluded.end_byte,
         line_count = excluded.line_count, byte_length = excluded.byte_length`,
    );

    const insertEdge = db.prepare(
      `INSERT INTO graph_edges
         (snapshot_id, from_unit, to_unit, kind, confidence, external, start_line, start_byte, end_byte)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, from_unit, to_unit, kind, start_byte, end_byte) DO NOTHING`,
    );

    const insertUnresolved = db.prepare(
      `INSERT INTO unresolved_refs (snapshot_id, kind, detail, path, start_line, from_unit)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    // Re-entrancy: a rehydrate invoked from within ProjectionStore.rebuild() is already inside
    // that rebuild's transaction; join it (atomic with the rebuild) instead of opening a nested one.
    const ownsTx = !db.inTransaction;
    if (ownsTx) db.exec('BEGIN IMMEDIATE');
    try {
      if (options.clearAll) {
        // Exact rebuild: nothing this snapshot owned may survive.
        db.prepare('DELETE FROM units WHERE snapshot_id = ?').run(snapshotId);
        db.prepare('DELETE FROM graph_edges WHERE snapshot_id = ?').run(snapshotId);
        db.prepare('DELETE FROM unit_classes WHERE snapshot_id = ?').run(snapshotId);
      }
      // Unresolved references are always rebuilt for this snapshot: they are appended (never
      // upserted), so replacing them keeps the set from doubling on a re-record.
      db.prepare('DELETE FROM unresolved_refs WHERE snapshot_id = ?').run(snapshotId);

      for (const { unit, id, parentId } of unitRows) {
        insertUnit.run(
          snapshotId,
          id,
          unit.kind,
          unit.name,
          unit.qualifiedName,
          unit.modulePath,
          subsystemOf(unit.modulePath),
          unit.exported ? 1 : 0,
          unit.versionHash,
          unit.anchor.startLine,
          unit.anchor.endLine,
          unit.anchor.startByte,
          unit.anchor.endByte,
          parentId,
          unit.lineCount,
          unit.byteLength,
          unit.isAsync ? 1 : 0,
          unit.parameterCount,
        );
      }

      for (const { edge, from, to } of edgeRows) {
        insertEdge.run(
          snapshotId,
          from,
          to,
          edge.kind,
          edge.confidence,
          edge.external ? 1 : 0,
          edge.anchor.startLine,
          edge.anchor.startByte,
          edge.anchor.endByte,
        );
      }

      for (const { reference, fromId } of unresolvedRows) {
        insertUnresolved.run(
          snapshotId,
          reference.kind,
          reference.detail,
          reference.anchor.path,
          reference.anchor.startLine,
          fromId,
        );
      }

      if (ownsTx) db.exec('COMMIT');
    } catch (error) {
      if (ownsTx) db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Writes a durable diagnostic artifact for an integrity event and returns its hash. */
  private writeIntegrityDiagnostic(
    snapshotId: string,
    code: string,
    detail: Record<string, unknown>,
  ): string {
    const artifact = this.artifacts.putJson(
      {
        kind: 'graph-integrity-violation',
        code,
        snapshot_id: snapshotId,
        at: nowIso(),
        ...detail,
      },
      { label: `graph-integrity-${code}-${snapshotId.slice(0, 12)}.json` },
    );
    return artifact.hash;
  }

  /** Writes a diagnostic artifact and throws — a violating result is never recorded. */
  private rejectWithDiagnostic(
    snapshotId: string,
    code: GraphIntegrityError['code'],
    detail: Record<string, unknown>,
  ): never {
    const hash = this.writeIntegrityDiagnostic(snapshotId, code, detail);
    throw new GraphIntegrityError(
      code,
      `Graph integrity violation (${code}) for snapshot ${snapshotId}; diagnostic ${hash.slice(0, 12)}`,
      hash,
    );
  }

  private makeIdResolver(): (logicalId: string) => number {
    const db = this.projections.db;
    const cache = new Map<string, number>();
    const select = db.prepare('SELECT unit_id FROM unit_ids WHERE logical_id = ?');
    const insert = db.prepare('INSERT INTO unit_ids (logical_id) VALUES (?)');

    return (logicalId: string): number => {
      const cached = cache.get(logicalId);
      if (cached !== undefined) return cached;

      const existing = select.get(logicalId);
      if (existing !== undefined) {
        const id = readNumber(readObject(existing, 'unit_ids row'), 'unit_id');
        cache.set(logicalId, id);
        return id;
      }

      const id = Number(insert.run(logicalId).lastInsertRowid);
      cache.set(logicalId, id);
      return id;
    };
  }

  /* --------------------------- impact queries ------------------------- */

  public impactOf(
    snapshotId: string,
    logicalId: string,
    maxDepth = DEFAULT_IMPACT_DEPTH,
  ): ImpactResult {
    const unitId = this.unitIdOf(logicalId);
    if (unitId === null) {
      return { logicalId, depth: 0, dependents: [], modules: [], subsystems: [], truncated: false };
    }

    const rows = this.projections.db
      .prepare(
        `WITH RECURSIVE impact(unit_id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT e.from_unit, impact.depth + 1
             FROM graph_edges e
             JOIN impact ON e.to_unit = impact.unit_id
            WHERE e.snapshot_id = ? AND e.external = 0 AND impact.depth < ?
         )
         SELECT i.depth AS depth, u.logical_id AS logical_id, s.module_path AS module_path
           FROM impact i
           JOIN unit_ids u ON u.unit_id = i.unit_id
           LEFT JOIN units s ON s.unit_id = i.unit_id AND s.snapshot_id = ?
          WHERE i.unit_id != ?`,
      )
      .all(unitId, snapshotId, maxDepth, snapshotId, unitId);

    const dependents: string[] = [];
    const modules = new Set<string>();
    const subsystems = new Set<string>();
    let deepest = 0;

    for (const row of rows) {
      const record = readObject(row, 'impact row');
      dependents.push(readString(record, 'logical_id'));
      deepest = Math.max(deepest, readNumber(record, 'depth'));

      const modulePath = record['module_path'];
      if (typeof modulePath === 'string') {
        modules.add(modulePath);
        subsystems.add(subsystemOf(modulePath));
      }
    }

    return {
      logicalId,
      depth: deepest,
      dependents: dependents.sort(),
      modules: [...modules].sort(),
      subsystems: [...subsystems].sort(),
      truncated: deepest >= maxDepth,
    };
  }

  public dependenciesOf(
    snapshotId: string,
    logicalId: string,
    maxDepth = DEFAULT_IMPACT_DEPTH,
  ): readonly string[] {
    const unitId = this.unitIdOf(logicalId);
    if (unitId === null) return [];

    return this.projections.db
      .prepare(
        `WITH RECURSIVE deps(unit_id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT e.to_unit, deps.depth + 1
             FROM graph_edges e
             JOIN deps ON e.from_unit = deps.unit_id
            WHERE e.snapshot_id = ? AND e.external = 0 AND deps.depth < ?
         )
         SELECT u.logical_id AS logical_id
           FROM deps d JOIN unit_ids u ON u.unit_id = d.unit_id
          WHERE d.unit_id != ?`,
      )
      .all(unitId, snapshotId, maxDepth, unitId)
      .map((row) => readString(readObject(row, 'dependency row'), 'logical_id'))
      .sort();
  }

  /* --------------------------- classification ------------------------- */

  /**
   * Classifies every unit in a snapshot on both axes and stores the result.
   *
   * The adjacency is loaded into memory once, because a behaviour closure has to ask
   * "does anything other than me reach this helper" for every candidate, and answering
   * that with one query per unit turns a linear pass into a quadratic one.
   *
   * With `only`, impact traversals run for that surface and other units reuse stored
   * measurements. Percentiles and classes are then recomputed for everyone regardless:
   * a percentile is a global statistic, so one new unit shifts the distribution for all
   * of them, and the cheap part staying exact is worth more than the saving.
   */
  public classify(snapshotId: string, options: ClassifyOptions = {}): UnitClassification[] {
    const adjacency = this.loadAdjacency(snapshotId);
    if (adjacency.units.size === 0) return [];

    const cached = options.only === undefined ? new Map() : this.cachedMeasurements(snapshotId);
    const surface = options.only === undefined ? null : new Set(options.only);
    const unresolvedModules = this.modulesWithUnresolvedReferences(snapshotId);

    const measured: MeasuredUnit[] = [];

    for (const [unitId, unit] of adjacency.units) {
      const stored = cached.get(unitId);
      const mustRecompute = surface === null || surface.has(unit.logicalId) || stored === undefined;

      const closure = this.computeClosure(adjacency, unitId);

      if (!mustRecompute && stored !== undefined) {
        measured.push({ unitId, unit, closure, measurement: stored });
        continue;
      }

      const impact = this.impactFromAdjacency(adjacency, unitId, DEFAULT_IMPACT_DEPTH);
      measured.push({
        unitId,
        unit,
        closure,
        measurement: {
          impactSize: impact.size,
          impactModules: impact.modules,
          impactSubsystems: impact.subsystems,
          truncated: impact.truncated,
        },
      });
    }

    const sortedSizes = measured.map((entry) => entry.measurement.impactSize).sort((a, b) => a - b);

    const classifications = measured.map((entry) => {
      const { impactSize, impactModules, impactSubsystems, truncated } = entry.measurement;
      const percentile = percentileOf(sortedSizes, impactSize);
      const direct = adjacency.directDependents.get(entry.unitId)?.size ?? 0;
      const reasons: string[] = [];

      const fileSpan: FileSpan = entry.closure.modules.length > 1 ? 'polyfile' : 'monofile';
      const dependencySurface: DependencySurface =
        entry.closure.externalModules.length > this.thresholds.monodependencyLimit
          ? 'polydependency'
          : 'monodependency';
      const quadrant: Quadrant = `${fileSpan}-${dependencySurface}`;

      reasons.push(
        `closure of ${entry.closure.members.length} unit(s) across ${entry.closure.modules.length} module(s)`,
      );
      reasons.push(`reaches ${entry.closure.externalModules.length} module(s) outside the closure`);

      const protectedReason =
        this.isProtected?.({
          logicalId: entry.unit.logicalId,
          modulePath: entry.unit.modulePath,
          name: entry.unit.name,
          kind: entry.unit.kind,
        }) ?? null;

      const blastRadius = decideBlastRadius(
        { percentile, subsystems: impactSubsystems, protectedReason },
        this.thresholds,
        reasons,
      );

      const confidence = scoreConfidence({
        percentile,
        thresholds: this.thresholds,
        truncated,
        closureTruncated: entry.closure.truncated,
        moduleHasUnresolved: unresolvedModules.has(entry.unit.modulePath),
        reasons,
      });

      return {
        unitId: entry.unitId,
        logicalId: entry.unit.logicalId,
        fileSpan,
        dependencySurface,
        quadrant,
        blastRadius,
        unitClass: projectLegacyClass(quadrant, blastRadius),
        confidence,
        percentile,
        closureSize: entry.closure.members.length,
        closureModules: entry.closure.modules.length,
        externalModules: entry.closure.externalModules.length,
        impactSize,
        impactModules,
        impactSubsystems,
        directDependents: direct,
        truncated,
        protectedReason,
        reasons,
      } satisfies UnitClassification & { unitId: number };
    });

    this.storeClassifications(snapshotId, classifications);
    return classifications.map(({ unitId: _unitId, ...rest }) => rest);
  }

  /**
   * The behaviour closure of a unit: itself plus the collaborators that exist only to
   * serve it.
   *
   * A helper reached by exactly one unit is part of that unit's implementation; a helper
   * reached by several is a shared dependency, and pulling it into the closure would
   * make every caller look polyfile because they happen to share a utility. That single
   * rule is what separates "this behaviour is spread across three files" from "this
   * behaviour uses a library".
   */
  private computeClosure(adjacency: Adjacency, rootId: number): ClosureResult {
    const members = new Set<number>([rootId]);
    const queue: { id: number; depth: number }[] = [{ id: rootId, depth: 0 }];
    const externalModules = new Set<string>();
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;

      if (current.depth >= this.thresholds.closureDepth) {
        truncated = true;
        continue;
      }

      for (const edge of adjacency.outgoing.get(current.id) ?? []) {
        if (!CLOSURE_EDGE_KINDS.has(edge.kind)) continue;
        if (edge.external) continue;

        const target = adjacency.units.get(edge.to);
        if (target === undefined || target.kind === 'module') continue;
        if (members.has(edge.to)) continue;

        const dependents = adjacency.directDependents.get(edge.to) ?? new Set<number>();
        const servesOnlyThisClosure = [...dependents].every((dependent) => members.has(dependent));

        if (servesOnlyThisClosure) {
          members.add(edge.to);
          queue.push({ id: edge.to, depth: current.depth + 1 });
        } else {
          externalModules.add(target.modulePath);
        }
      }
    }

    const modules = new Set<string>();
    for (const memberId of members) {
      const member = adjacency.units.get(memberId);
      if (member !== undefined) modules.add(member.modulePath);
    }
    for (const moduleName of modules) externalModules.delete(moduleName);

    const memberIds: string[] = [];
    for (const memberId of members) {
      const member = adjacency.units.get(memberId);
      if (member !== undefined) memberIds.push(member.logicalId);
    }

    return {
      members: memberIds.sort(),
      modules: [...modules].sort(),
      externalModules: [...externalModules].sort(),
      truncated,
    };
  }

  /**
   * Reverse reachability ("what depends on this unit"), computed in memory from the
   * adjacency already loaded for classification instead of by a recursive SQL query per
   * unit.
   *
   * This is the commit hot path — classify runs it once for every unit. The former
   * per-unit recursive CTE was keyed on (unit_id, depth), so on a cyclic import graph
   * (which real TypeScript has in abundance) every unit reachable through a cycle was
   * re-expanded at each depth up to the limit of 12, turning a single commit into an
   * O(units) sequence of expensive, redundant traversals. Measured at ~232 ms/unit on a
   * 500-unit cyclic graph — tens of minutes to hours at real repository scale, observed
   * as the commit "hang". A visited set makes each traversal linear in the reachable
   * subgraph regardless of cycles, and the reverse edges are already in memory, so there
   * is no SQL round-trip. Reverse edges exclude external and `declares` edges, matching
   * both the closure walk that shares this adjacency and the impact semantics (a module
   * declaring a unit is not a dependent of it).
   */
  private impactFromAdjacency(
    adjacency: Adjacency,
    rootId: number,
    maxDepth: number,
  ): { size: number; modules: number; subsystems: number; truncated: boolean } {
    const visited = new Set<number>([rootId]);
    const queue: { id: number; depth: number }[] = [{ id: rootId, depth: 0 }];
    let head = 0;
    const modules = new Set<string>();
    const subsystems = new Set<string>();
    let size = 0;
    let truncated = false;

    while (head < queue.length) {
      const current = queue[head];
      head += 1;
      if (current === undefined) continue;
      if (current.depth >= maxDepth) {
        truncated = true;
        continue;
      }
      for (const dependent of adjacency.directDependents.get(current.id) ?? EMPTY_DEPENDENTS) {
        if (visited.has(dependent)) continue;
        visited.add(dependent);
        size += 1;
        const unit = adjacency.units.get(dependent);
        if (unit !== undefined) {
          modules.add(unit.modulePath);
          subsystems.add(subsystemOf(unit.modulePath));
        }
        queue.push({ id: dependent, depth: current.depth + 1 });
      }
    }

    return { size, modules: modules.size, subsystems: subsystems.size, truncated };
  }

  /** Public form of the closure computation, for context packs and explanations. */
  public closureOf(snapshotId: string, logicalId: string): ClosureResult | null {
    const adjacency = this.loadAdjacency(snapshotId);
    const unitId = this.unitIdOf(logicalId);
    if (unitId === null || !adjacency.units.has(unitId)) return null;
    return this.computeClosure(adjacency, unitId);
  }

  private loadAdjacency(snapshotId: string): Adjacency {
    const units = new Map<number, AdjacencyUnit>();
    const outgoing = new Map<number, { to: number; kind: EdgeKind; external: boolean }[]>();
    const directDependents = new Map<number, Set<number>>();

    for (const row of this.projections.db
      .prepare(
        `SELECT u.unit_id AS unit_id, i.logical_id AS logical_id, u.module_path AS module_path,
                u.kind AS kind, u.name AS name
           FROM units u JOIN unit_ids i ON i.unit_id = u.unit_id
          WHERE u.snapshot_id = ?`,
      )
      .all(snapshotId)) {
      const record = readObject(row, 'units row');
      units.set(readNumber(record, 'unit_id'), {
        logicalId: readString(record, 'logical_id'),
        modulePath: readString(record, 'module_path'),
        kind: readString(record, 'kind'),
        name: readString(record, 'name'),
      });
    }

    for (const row of this.projections.db
      .prepare(
        `SELECT from_unit, to_unit, kind, external FROM graph_edges
          WHERE snapshot_id = ? AND kind != 'declares'`,
      )
      .all(snapshotId)) {
      const record = readObject(row, 'graph_edges row');
      const from = readNumber(record, 'from_unit');
      const to = readNumber(record, 'to_unit');
      const external = readNumber(record, 'external') === 1;
      const kind = readString(record, 'kind') as EdgeKind;

      const list = outgoing.get(from);
      if (list === undefined) outgoing.set(from, [{ to, kind, external }]);
      else list.push({ to, kind, external });

      if (!external) {
        const dependents = directDependents.get(to);
        if (dependents === undefined) directDependents.set(to, new Set([from]));
        else dependents.add(from);
      }
    }

    return { units, outgoing, directDependents };
  }

  private cachedMeasurements(snapshotId: string): Map<number, Measurement> {
    const cache = new Map<number, Measurement>();
    for (const row of this.projections.db
      .prepare(
        `SELECT unit_id, impact_size, impact_modules, impact_subsystems, truncated
           FROM unit_classes WHERE snapshot_id = ?`,
      )
      .all(snapshotId)) {
      const record = readObject(row, 'unit_classes row');
      cache.set(readNumber(record, 'unit_id'), {
        impactSize: readNumber(record, 'impact_size'),
        impactModules: readNumber(record, 'impact_modules'),
        impactSubsystems: readNumber(record, 'impact_subsystems'),
        truncated: record['truncated'] === 1,
      });
    }
    return cache;
  }

  private storeClassifications(
    snapshotId: string,
    classifications: readonly (UnitClassification & { unitId: number })[],
  ): void {
    const db = this.projections.db;
    const insert = db.prepare(
      `INSERT INTO unit_classes (
         snapshot_id, unit_id, class, confidence, percentile, impact_size, impact_modules,
         impact_subsystems, direct_dependents, truncated, reasons, file_span,
         dependency_surface, quadrant, blast_radius, closure_size, closure_modules,
         external_modules, protected_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, unit_id) DO UPDATE SET
         class = excluded.class, confidence = excluded.confidence,
         percentile = excluded.percentile, impact_size = excluded.impact_size,
         impact_modules = excluded.impact_modules,
         impact_subsystems = excluded.impact_subsystems,
         direct_dependents = excluded.direct_dependents, truncated = excluded.truncated,
         reasons = excluded.reasons, file_span = excluded.file_span,
         dependency_surface = excluded.dependency_surface, quadrant = excluded.quadrant,
         blast_radius = excluded.blast_radius, closure_size = excluded.closure_size,
         closure_modules = excluded.closure_modules,
         external_modules = excluded.external_modules,
         protected_reason = excluded.protected_reason`,
    );

    // Re-entrancy: a rehydrate invoked from within ProjectionStore.rebuild() is already inside
    // that rebuild's transaction; join it (atomic with the rebuild) instead of opening a nested one.
    const ownsTx = !db.inTransaction;
    if (ownsTx) db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of classifications) {
        insert.run(
          snapshotId,
          entry.unitId,
          entry.unitClass,
          entry.confidence,
          entry.percentile,
          entry.impactSize,
          entry.impactModules,
          entry.impactSubsystems,
          entry.directDependents,
          entry.truncated ? 1 : 0,
          JSON.stringify(entry.reasons),
          entry.fileSpan,
          entry.dependencySurface,
          entry.quadrant,
          entry.blastRadius,
          entry.closureSize,
          entry.closureModules,
          entry.externalModules,
          entry.protectedReason,
        );
      }
      if (ownsTx) db.exec('COMMIT');
    } catch (error) {
      if (ownsTx) db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Units that are safe shapes to change, best first.
   *
   * Filters on the quadrant and the blast radius independently, because they answer
   * different questions and a pilot wants a specific combination of both: easy to change
   * correctly *and* cheap to get wrong.
   */
  public candidates(
    snapshotId: string,
    options: {
      quadrants?: readonly Quadrant[];
      blastRadii?: readonly BlastRadius[];
      minimumConfidence?: number;
      limit?: number;
    } = {},
  ): UnitClassification[] {
    const quadrants = options.quadrants ?? (['monofile-monodependency'] as const);
    const blastRadii = options.blastRadii ?? (['local'] as const);

    return this.projections.db
      .prepare(
        `SELECT i.logical_id AS logical_id, c.*
           FROM unit_classes c
           JOIN unit_ids i ON i.unit_id = c.unit_id
          WHERE c.snapshot_id = ?
            AND c.quadrant IN (${quadrants.map(() => '?').join(', ')})
            AND c.blast_radius IN (${blastRadii.map(() => '?').join(', ')})
            AND c.confidence >= ?
          ORDER BY c.confidence DESC, c.impact_size ASC, i.logical_id
          LIMIT ?`,
      )
      .all(
        snapshotId,
        ...quadrants,
        ...blastRadii,
        options.minimumConfidence ?? 0.6,
        Math.max(1, options.limit ?? 25),
      )
      .map(readClassificationRow);
  }

  public classificationOf(snapshotId: string, logicalId: string): UnitClassification | null {
    const row = this.projections.db
      .prepare(
        `SELECT i.logical_id AS logical_id, c.*
           FROM unit_classes c JOIN unit_ids i ON i.unit_id = c.unit_id
          WHERE c.snapshot_id = ? AND i.logical_id = ?`,
      )
      .get(snapshotId, logicalId);
    return row === undefined ? null : readClassificationRow(row);
  }

  /* ------------------------------ coverage ---------------------------- */

  public coverage(snapshotId: string): CoverageEntry[] {
    const rows = this.projections.db
      .prepare(
        `SELECT subsystem, COUNT(DISTINCT module_path) AS modules, COUNT(*) AS units
           FROM units WHERE snapshot_id = ? GROUP BY subsystem ORDER BY subsystem`,
      )
      .all(snapshotId);

    const unresolvedBySubsystem = new Map<string, number>();
    for (const row of this.projections.db
      .prepare('SELECT path FROM unresolved_refs WHERE snapshot_id = ?')
      .all(snapshotId)) {
      const subsystem = subsystemOf(readString(readObject(row, 'unresolved row'), 'path'));
      unresolvedBySubsystem.set(subsystem, (unresolvedBySubsystem.get(subsystem) ?? 0) + 1);
    }

    const edgesBySubsystem = new Map<string, number>();
    for (const row of this.projections.db
      .prepare(
        `SELECT u.subsystem AS subsystem, COUNT(*) AS edges
           FROM graph_edges e
           JOIN units u ON u.unit_id = e.from_unit AND u.snapshot_id = e.snapshot_id
          WHERE e.snapshot_id = ? GROUP BY u.subsystem`,
      )
      .all(snapshotId)) {
      const record = readObject(row, 'edge count row');
      edgesBySubsystem.set(readString(record, 'subsystem'), readNumber(record, 'edges'));
    }

    return rows.map((row) => {
      const record = readObject(row, 'coverage row');
      const subsystem = readString(record, 'subsystem');
      const modules = readNumber(record, 'modules');
      const units = readNumber(record, 'units');
      const unresolved = unresolvedBySubsystem.get(subsystem) ?? 0;

      return {
        subsystem,
        modules,
        units,
        edges: edgesBySubsystem.get(subsystem) ?? 0,
        unresolved,
        unitsPerModule: modules === 0 ? 0 : Number((units / modules).toFixed(2)),
        coverage: units === 0 ? 0 : Number(Math.max(0, 1 - unresolved / units).toFixed(3)),
      };
    });
  }

  /* ------------------------------- export ----------------------------- */

  public exportCompact(
    snapshotId: string,
    options: { around?: string; radius?: number; limit?: number } = {},
  ): string {
    const limit = options.limit ?? 200;
    const scope =
      options.around === undefined
        ? null
        : new Set<string>([
            options.around,
            ...this.impactOf(snapshotId, options.around, options.radius ?? 2).dependents,
            ...this.dependenciesOf(snapshotId, options.around, options.radius ?? 2),
          ]);

    const lines: string[] = [`# graph ${snapshotId}`];
    const rows = this.projections.db
      .prepare(
        `SELECT i.logical_id AS logical_id, u.kind AS kind, u.line_count AS line_count,
                c.quadrant AS quadrant, c.blast_radius AS blast_radius,
                c.confidence AS confidence, c.impact_size AS impact_size
           FROM units u
           JOIN unit_ids i ON i.unit_id = u.unit_id
           LEFT JOIN unit_classes c ON c.unit_id = u.unit_id AND c.snapshot_id = u.snapshot_id
          WHERE u.snapshot_id = ?
          ORDER BY i.logical_id`,
      )
      .all(snapshotId);

    let emitted = 0;
    for (const row of rows) {
      if (emitted >= limit) {
        lines.push(`# … truncated at ${limit} units`);
        break;
      }
      const record = readObject(row, 'export row');
      const logicalId = readString(record, 'logical_id');
      if (scope !== null && !scope.has(logicalId)) continue;

      const quadrant = record['quadrant'];
      const blast = record['blast_radius'];
      const confidence = record['confidence'];
      const impact = record['impact_size'];

      lines.push(
        `${logicalId} [${readString(record, 'kind')} lines=${readNumber(record, 'line_count')}` +
          (typeof quadrant === 'string' ? ` ${quadrant}` : '') +
          (typeof blast === 'string' ? ` blast=${blast}` : '') +
          (typeof confidence === 'number' ? ` conf=${confidence.toFixed(2)}` : '') +
          (typeof impact === 'number' ? ` impact=${impact}` : '') +
          ']',
      );
      emitted += 1;
    }

    return lines.join('\n');
  }

  /* ------------------------------ internals --------------------------- */

  private unitIdOf(logicalId: string): number | null {
    const row = this.projections.db
      .prepare('SELECT unit_id FROM unit_ids WHERE logical_id = ?')
      .get(logicalId);
    return row === undefined ? null : readNumber(readObject(row, 'unit_ids row'), 'unit_id');
  }

  private modulesWithUnresolvedReferences(snapshotId: string): Set<string> {
    const modules = new Set<string>();
    for (const row of this.projections.db
      .prepare('SELECT DISTINCT path FROM unresolved_refs WHERE snapshot_id = ?')
      .all(snapshotId)) {
      modules.add(readString(readObject(row, 'unresolved row'), 'path'));
    }
    return modules;
  }

  public resultOf(
    snapshotId: string,
    expectedProjectRecognition?: ProjectRecognitionIdentity,
  ): {
    units: SourceUnit[];
    edges: SourceEdge[];
    unresolved: UnresolvedReference[];
  } | null {
    const row = this.projections.db
      .prepare('SELECT result_hash, artifact_hash FROM recognitions WHERE snapshot_id = ?')
      .get(snapshotId);
    if (row === undefined) return null;
    const record = readObject(row, 'recognitions row');
    const resultHash = requireSha256(readString(record, 'result_hash'), 'result hash');
    const artifactHash = readString(record, 'artifact_hash');

    // Pre-DEV-P0-05 artifacts stored only { units, edges, unresolved } under result_hash and carry no
    // artifact_hash. Read those directly; everything recorded since is a complete, versioned artifact.
    if (artifactHash === '') {
      if (expectedProjectRecognition !== undefined) {
        throw new Error(
          `recognition artifact for ${snapshotId} predates Project Profile identity and cannot satisfy a profile-bound read`,
        );
      }
      const legacy = this.artifacts.getJson(resultHash);
      if (typeof legacy !== 'object' || legacy === null) return null;
      const value = legacy as Record<string, unknown>;
      return {
        units: (value['units'] ?? []) as SourceUnit[],
        edges: (value['edges'] ?? []) as SourceEdge[],
        unresolved: (value['unresolved'] ?? []) as UnresolvedReference[],
      };
    }

    // Parse the complete artifact through the strict schema and verify its content hash. A corrupt,
    // truncated, or field-missing artifact is refused here rather than yielding a partial graph.
    const raw = this.artifacts.getJson(requireSha256(artifactHash, 'artifact hash'));
    const artifact = parseOrThrow(
      recognitionArtifactSchema,
      raw,
      `recognition artifact for ${snapshotId}`,
    );
    if (expectedProjectRecognition !== undefined) {
      assertProjectRecognitionIdentity(
        expectedProjectRecognition,
        artifact.basis.projectRecognition,
        `recognition artifact ${snapshotId}`,
      );
    }
    const content = {
      units: artifact.units,
      edges: artifact.edges,
      unresolved: artifact.unresolved,
    };
    const contentHash = hashCanonicalJson(content);
    if (contentHash !== artifact.content_hash || contentHash !== resultHash) {
      throw new GraphIntegrityError(
        'artifact-content-mismatch',
        `recognition artifact for ${snapshotId} failed content-hash verification`,
        contentHash,
      );
    }
    return {
      units: artifact.units as unknown as SourceUnit[],
      edges: artifact.edges as unknown as SourceEdge[],
      unresolved: artifact.unresolved as unknown as UnresolvedReference[],
    };
  }

  public recognition(snapshotId: string): RecognitionRecord | null {
    const row = this.projections.db
      .prepare('SELECT * FROM recognitions WHERE snapshot_id = ?')
      .get(snapshotId);
    if (row === undefined) return null;
    const record = readObject(row, 'recognitions row');
    return parseOrThrow(
      recognitionRecordSchema,
      { ...record, complete: record['complete'] === 1 },
      'recognitions row',
    );
  }

  /**
   * Every recorded recognition run for a snapshot, newest first — the durable run history.
   *
   * `recognition()` returns the current-run pointer (one row per snapshot); this returns the full
   * history from `recognition_runs`. Two runs of one snapshot that differ in result or basis carry
   * distinct run keys and both appear here, so re-recognising a snapshot (for example after a
   * dependency lock changed) no longer erases the prior run.
   */
  public runsOf(snapshotId: string): RecognitionRunSummary[] {
    const rows = this.projections.db
      .prepare(
        `SELECT run_key, snapshot_id, recognised_at, result_hash, artifact_hash,
                compiler_options_hash, basis_hash, unit_count, edge_count, unresolved_count, complete
           FROM recognition_runs WHERE snapshot_id = ? ORDER BY recognised_at DESC, run_key`,
      )
      .all(snapshotId);
    return rows.map((raw) => {
      const row = readObject(raw, 'recognition_runs row');
      return {
        runKey: readString(row, 'run_key'),
        snapshotId: readString(row, 'snapshot_id'),
        recognisedAt: readString(row, 'recognised_at'),
        resultHash: readString(row, 'result_hash'),
        artifactHash: readString(row, 'artifact_hash'),
        compilerOptionsHash: readString(row, 'compiler_options_hash'),
        basisHash: readString(row, 'basis_hash'),
        unitCount: readNumber(row, 'unit_count'),
        edgeCount: readNumber(row, 'edge_count'),
        unresolvedCount: readNumber(row, 'unresolved_count'),
        complete: readNumber(row, 'complete') === 1,
      };
    });
  }

  /**
   * The recognition link for a recorded run, bound to the snapshot seal (DEV-P1-28, phase 3).
   *
   * All four identities come from the durable run history (`runsOf`): the run key, the versioned
   * recognition-basis hash (the exact state under which recognition ran), the content-only result
   * hash, and the complete-artifact hash. `snapshotSeal` is the snapshot registry's `spineSeal(...)`.
   */
  public spineLink(run: RecognitionRunSummary, snapshotSeal: BindingHash): RecognitionLink {
    return {
      stage: 'recognition',
      boundTo: snapshotSeal,
      recognitionRunId: requireSpineId(run.runKey, 'RecognitionRunId'),
      recognitionStateKey: requireSpineHash(run.basisHash, 'RecognitionStateKey'),
      resultHash: requireSpineHash(run.resultHash, 'ResultHash'),
      artifactHash: requireSpineHash(run.artifactHash, 'ArtifactHash'),
    };
  }

  /** The sealed binding hash of the recognition link — the value the task stage binds to. */
  public spineSeal(run: RecognitionRunSummary, snapshotSeal: BindingHash): BindingHash {
    return sealEvidenceLink(this.spineLink(run, snapshotSeal));
  }

  /**
   * Verifies a presented recognition link against both its snapshot predecessor and this registry's
   * own durable run history (DEV-P1-28, phase 3).
   *
   * Two independent checks. The link must bind to the given snapshot link — recomputed, so a
   * snapshot altered after the fact is caught — and its run key must name a run this registry
   * actually recorded for that snapshot's content id, with exactly the basis, result, and artifact
   * hashes the history holds. A link cannot claim a run that never happened, nor pair a real run
   * with hashes that were never its own.
   */
  public verifyRecognitionLink(link: RecognitionLink, snapshotLink: SnapshotLink): void {
    verifyEvidenceLink(link, snapshotLink);
    const runs = this.runsOf(snapshotLink.snapshotContentId);
    const run = runs.find((candidate) => candidate.runKey === link.recognitionRunId);
    if (run === undefined) {
      throw new EvidenceChainError(
        `recognition link references run ${link.recognitionRunId}, which this registry never ` +
          `recorded for snapshot ${snapshotLink.snapshotContentId}`,
      );
    }
    if (run.basisHash !== link.recognitionStateKey) {
      throw new EvidenceChainError(
        `recognition link state ${link.recognitionStateKey} does not match the recorded basis ` +
          `${run.basisHash} of run ${run.runKey}`,
      );
    }
    if (run.resultHash !== link.resultHash) {
      throw new EvidenceChainError(
        `recognition link result ${link.resultHash} does not match the recorded result ` +
          `${run.resultHash} of run ${run.runKey}`,
      );
    }
    if (run.artifactHash !== link.artifactHash) {
      throw new EvidenceChainError(
        `recognition link artifact ${link.artifactHash} does not match the recorded artifact ` +
          `${run.artifactHash} of run ${run.runKey}`,
      );
    }
  }

  /**
   * Structural topology counts for the committed graph of a snapshot, read from the
   * persisted `units` and `unit_classes` tables (no reclassification): distinct module
   * paths and the four-quadrant classification distribution. Lets the Status projector
   * report real module and mono/poly distributions in Quadrant 1 rather than zeros.
   */
  public topologyOf(snapshotId: string): {
    readonly moduleCount: number;
    readonly classDistribution: Readonly<Record<Quadrant, number>>;
  } {
    const db = this.projections.db;
    const moduleRow = db
      .prepare('SELECT COUNT(DISTINCT module_path) AS n FROM units WHERE snapshot_id = ?')
      .get(snapshotId) as { n?: number } | undefined;
    const distribution: Record<Quadrant, number> = {
      'monofile-monodependency': 0,
      'monofile-polydependency': 0,
      'polyfile-monodependency': 0,
      'polyfile-polydependency': 0,
    };
    const rows = db
      .prepare('SELECT quadrant, COUNT(*) AS n FROM unit_classes WHERE snapshot_id = ? GROUP BY quadrant')
      .all(snapshotId) as ReadonlyArray<{ quadrant?: string; n?: number }>;
    for (const row of rows) {
      const quadrant = row.quadrant as Quadrant | undefined;
      if (quadrant !== undefined && quadrant in distribution) {
        distribution[quadrant] = Number(row.n ?? 0);
      }
    }
    return { moduleCount: Number(moduleRow?.n ?? 0), classDistribution: distribution };
  }
}

/* ------------------------------------------------------------------------- */
/* Classification logic                                                       */
/* ------------------------------------------------------------------------- */

interface AdjacencyUnit {
  readonly logicalId: string;
  readonly modulePath: string;
  readonly kind: string;
  readonly name: string;
}

interface Adjacency {
  readonly units: Map<number, AdjacencyUnit>;
  readonly outgoing: Map<number, { to: number; kind: EdgeKind; external: boolean }[]>;
  readonly directDependents: Map<number, Set<number>>;
}

interface Measurement {
  readonly impactSize: number;
  readonly impactModules: number;
  readonly impactSubsystems: number;
  readonly truncated: boolean;
}

interface MeasuredUnit {
  readonly unitId: number;
  readonly unit: AdjacencyUnit;
  readonly closure: ClosureResult;
  readonly measurement: Measurement;
}

/**
 * How far a mistake would travel.
 *
 * Ordered most to least dangerous, so a unit matching two descriptions gets the more
 * cautious one. `protected` outranks everything: a deliberate surface is never changed
 * automatically no matter how contained it looks.
 */
function decideBlastRadius(
  inputs: { percentile: number; subsystems: number; protectedReason: string | null },
  thresholds: ClassificationThresholds,
  reasons: string[],
): BlastRadius {
  if (inputs.protectedReason !== null) {
    reasons.push(`protected surface: ${inputs.protectedReason}`);
    return 'protected';
  }
  if (inputs.percentile >= thresholds.foundationalPercentile) {
    reasons.push(`impact percentile ${inputs.percentile.toFixed(2)} is in the top tier`);
    return 'foundational';
  }
  if (inputs.subsystems >= thresholds.foundationalSubsystems) {
    reasons.push(`reaches ${inputs.subsystems} subsystems`);
    return 'foundational';
  }
  if (inputs.subsystems > 1) {
    reasons.push(`crosses ${inputs.subsystems} subsystems`);
    return 'systemic';
  }
  reasons.push('impact confined to one subsystem');
  return 'local';
}

/**
 * Projects the two axes onto the revision-2 enum.
 *
 * Lossy by construction — that is the point of retiring it. It exists so consumers
 * written against revision 2 keep compiling while they migrate, and it should not be
 * consulted by anything new.
 */
function projectLegacyClass(quadrant: Quadrant, blastRadius: BlastRadius): UnitClass {
  if (blastRadius === 'foundational') return 'foundational';
  if (blastRadius === 'systemic') return 'systemic';
  if (blastRadius === 'protected') return 'systemic';
  return quadrant === 'monofile-monodependency' ? 'monodependency' : 'local';
}

/**
 * How much to trust the classification.
 *
 * Lowered wherever the graph knows it is uncertain: a truncated impact traversal
 * understates reach, a truncated closure understates span, a module with unresolved
 * references has edges CLUE could not follow, and a unit on a threshold could fall
 * either side next scan. A confident class drawn from an incomplete graph is the most
 * expensive kind of wrong, because it is the kind that gets acted on.
 */
function scoreConfidence(input: {
  percentile: number;
  thresholds: ClassificationThresholds;
  truncated: boolean;
  closureTruncated: boolean;
  moduleHasUnresolved: boolean;
  reasons: string[];
}): number {
  let confidence = 1;

  if (input.truncated) {
    confidence -= 0.25;
    input.reasons.push('impact traversal hit the depth limit; the size is a lower bound');
  }
  if (input.closureTruncated) {
    confidence -= 0.15;
    input.reasons.push('behaviour closure hit the depth limit; the file span may be understated');
  }
  if (input.moduleHasUnresolved) {
    confidence -= 0.15;
    input.reasons.push('the declaring module contains references the recognizer could not resolve');
  }
  if (Math.abs(input.percentile - input.thresholds.foundationalPercentile) <= input.thresholds.boundaryMargin) {
    confidence -= 0.1;
    input.reasons.push('percentile sits within the margin of the foundational boundary');
  }

  return Number(Math.min(1, Math.max(0.3, confidence)).toFixed(3));
}

function percentileOf(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return 0;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? 0) <= value) low = middle + 1;
    else high = middle;
  }
  return Number((low / sorted.length).toFixed(4));
}

/** Top-level directory pair of a module path; the unit of "subsystem". */
export function subsystemOf(modulePath: string): string {
  const index = modulePath.indexOf('/');
  if (index === -1) return '.';
  const second = modulePath.indexOf('/', index + 1);
  return second === -1 ? modulePath.slice(0, index) : modulePath.slice(0, second);
}

/** Convenience for callers assembling a quadrant from the two axes. */
export function quadrantOf(fileSpan: FileSpan, dependencySurface: DependencySurface): Quadrant {
  return `${fileSpan}-${dependencySurface}`;
}

/* ------------------------------------------------------------------------- */
/* Row reading                                                                */
/* ------------------------------------------------------------------------- */

function readClassificationRow(row: unknown): UnitClassification {
  const record = readObject(row, 'unit_classes row');
  const reasons = record['reasons'];

  const fileSpan = (readOptionalString(record, 'file_span') ?? 'monofile') as FileSpan;
  const dependencySurface = (readOptionalString(record, 'dependency_surface') ??
    'monodependency') as DependencySurface;
  const quadrant = (readOptionalString(record, 'quadrant') ??
    quadrantOf(fileSpan, dependencySurface)) as Quadrant;
  const blastRadius = (readOptionalString(record, 'blast_radius') ?? 'local') as BlastRadius;

  return {
    logicalId: readString(record, 'logical_id'),
    fileSpan,
    dependencySurface,
    quadrant,
    blastRadius,
    unitClass: readString(record, 'class') as UnitClass,
    confidence: readNumber(record, 'confidence'),
    percentile: readNumber(record, 'percentile'),
    closureSize: readOptionalNumber(record, 'closure_size') ?? 1,
    closureModules: readOptionalNumber(record, 'closure_modules') ?? 1,
    externalModules: readOptionalNumber(record, 'external_modules') ?? 0,
    impactSize: readNumber(record, 'impact_size'),
    impactModules: readNumber(record, 'impact_modules'),
    impactSubsystems: readNumber(record, 'impact_subsystems'),
    directDependents: readNumber(record, 'direct_dependents'),
    truncated: record['truncated'] === 1,
    protectedReason: readOptionalString(record, 'protected_reason'),
    reasons: typeof reasons === 'string' ? (JSON.parse(reasons) as string[]) : [],
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

function readOptionalNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' ? value : null;
}

export type { SourceUnit, SourceEdge, UnitKind, EdgeKind };