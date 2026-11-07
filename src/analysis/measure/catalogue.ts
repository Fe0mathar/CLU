/**
 * catalogue.ts — Structured Measurement Catalogue registry (schema + loader).
 *
 * Workstream D. The machine-readable registry is the production source of truth
 * for the canonical measurement system; the human-readable Markdown catalogue is
 * generated from it and must embed the same content hash.
 *
 * Backlog: DEV-P1-18 — completeness is checked from revision 3 onward rather than only for v3, so a
 *          version bump can never switch validation off, and the v6 activation metrics are required.
 *          DEV-P1-19 — v6 schema enforcement (all 100 coordinates active, no reserved cell left free),
 *          explicit migration (`supersedes` must be declared), and a production-readiness gate that
 *          refuses to let a v3 registry govern a live run while keeping it loadable as history.
 *
 * Normative sources (cite by base name; always reconcile against the newest
 * revision in the project knowledge — version tags in filenames rotate):
 *   - CLUE constitution              (A8/A9: catalogue doctrine, canonical coordinates)
 *   - CLUE Canonical Measurement Catalogue (v3 grammar: M<Area><Ordinal>, four
 *     families, frozen 10 × 10 grid, legacy aliases, applicability states)
 *   - CLUE implementation            (records 19.27 MeasurementCatalogueVersion,
 *     19.28 MeasureApplicabilityRecord, 19.31 MeasureTerminalOutcome,
 *     19.33 CanonicalMetricDefinition; §45A catalogue ingest requirements)
 *   - CLUE Status Contract           (metric status projection, 96-active gate)
 *
 * Contract highlights enforced here:
 *   - Canonical ID grammar `M<Area><Ordinal>`; areas A–K; four families with a
 *     fixed color policy. IDs are immutable once referenced; retired IDs keep
 *     their grid cell; cross-version reuse checks belong to the registry
 *     history service (workspace/measurements/catalogue), not this pure loader.
 *   - The v3 coordinate map (cells 1–96) is FROZEN and derived deterministically
 *     from canonical order. Measures outside the frozen v3 set must explicitly
 *     declare a unique reserved cell (97–100); coordinates never shift.
 *   - Legacy aliases (Q/A/G/S → M...) are derived deterministically; a declared
 *     alias map, when present, must agree exactly.
 *   - Every load exposes a stable content hash plus grid-layout, alias-map and
 *     family-color-policy hashes, so every cycle can bind to an immutable
 *     catalogue identity. Same input ⇒ same hashes, independent of YAML order.
 *   - Applicability is the six-state model REQUIRED | APPLICABLE | CONDITIONAL |
 *     NOT_APPLICABLE | UNKNOWN | CONFLICTED (a reason is always required;
 *     UNKNOWN/CONFLICTED create recognition work, they never silently pass).
 *     CONTEXT_INSUFFICIENT / DEFERRED_WITH_REASON are terminal measure
 *     OUTCOMES, not applicability states — the two vocabularies are modeled
 *     separately on purpose.
 *   - Malformed registries are rejected strictly with structured issues.
 *
 * Pure module: no DB, no host, no I/O. Dependencies: zod, yaml, node:crypto.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Registry schema identity
// ---------------------------------------------------------------------------

/** Version of THIS registry schema (not of the catalogue data it validates). */
export const CATALOGUE_REGISTRY_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Canonical vocabularies
// ---------------------------------------------------------------------------

export const METRIC_FAMILIES = [
  'TARGET_QUALITY',
  'EVIDENCE_ASSURANCE',
  'ACCEPTANCE_GATES',
  'CLUE_SELF',
] as const;
export type MetricFamily = (typeof METRIC_FAMILIES)[number];

export const METRIC_AREAS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as const;
export type MetricArea = (typeof METRIC_AREAS)[number];

export const METRIC_STATUSES = ['ACTIVE', 'EXPERIMENTAL', 'DEPRECATED', 'RETIRED'] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

export const CATALOGUE_STATUSES = ['ACTIVE', 'DEPRECATED', 'RETIRED'] as const;
export type CatalogueStatus = (typeof CATALOGUE_STATUSES)[number];

export const PROJECTION_TYPES = [
  'signed_score',
  'percentage',
  'count',
  'ratio',
  'ordinal',
  'gate_state',
  'distribution',
  'categorical',
] as const;
export type ProjectionType = (typeof PROJECTION_TYPES)[number];

/** Six-state applicability model (Catalogue §3.2 / implementation 19.28). */
export const APPLICABILITY_STATES = [
  'REQUIRED',
  'APPLICABLE',
  'CONDITIONAL',
  'NOT_APPLICABLE',
  'UNKNOWN',
  'CONFLICTED',
] as const;
export type ApplicabilityState = (typeof APPLICABILITY_STATES)[number];

export const APPLICABILITY_RESOLVERS = ['deterministic', 'ai', 'creator', 'mixed'] as const;
export type ApplicabilityResolver = (typeof APPLICABILITY_RESOLVERS)[number];

/** Terminal measure-session outcomes (implementation 19.31). Distinct from applicability. */
export const TERMINAL_MEASURE_OUTCOMES = [
  'IMPROVEMENT_PROVEN',
  'NO_IMPERFECTION_FOUND',
  'HYPOTHESIS_REFUTED',
  'REGRESSION_DETECTED',
  'PURPOSE_VIOLATION',
  'CONTEXT_INSUFFICIENT',
  'INCONCLUSIVE',
  'INVALID_EXPERIMENT',
  'DUPLICATE_OR_SUBSUMED',
  'EXPERT_OMITTED',
  'DEFERRED_WITH_REASON',
] as const;
export type TerminalMeasureOutcome = (typeof TERMINAL_MEASURE_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Canonical structural constants (frozen by the v3 catalogue)
// ---------------------------------------------------------------------------

/** Family color policy — categorical family identity, never verdict authority. */
export const FAMILY_COLOR_POLICY = {
  TARGET_QUALITY: '#00a3e0',
  EVIDENCE_ASSURANCE: '#f4af2d',
  ACCEPTANCE_GATES: '#ff5500',
  CLUE_SELF: '#39ff88',
} as const satisfies Record<MetricFamily, string>;

/** Area → family mapping (areas A–H target quality; I evidence; J gates; K self). */
export const AREA_FAMILY = {
  A: 'TARGET_QUALITY',
  B: 'TARGET_QUALITY',
  C: 'TARGET_QUALITY',
  D: 'TARGET_QUALITY',
  E: 'TARGET_QUALITY',
  F: 'TARGET_QUALITY',
  G: 'TARGET_QUALITY',
  H: 'TARGET_QUALITY',
  I: 'EVIDENCE_ASSURANCE',
  J: 'ACCEPTANCE_GATES',
  K: 'CLUE_SELF',
} as const satisfies Record<MetricArea, MetricFamily>;

/** Per-area metric cardinalities frozen by catalogue v3 (96 canonical metrics). */
export const V3_AREA_CARDINALITIES = {
  A: 6,
  B: 7,
  C: 15,
  D: 10,
  E: 7,
  F: 6,
  G: 7,
  H: 2,
  I: 11,
  J: 7,
  K: 18,
} as const satisfies Record<MetricArea, number>;

/** Grid cells 97–100 are reserved for future catalogue expansion. */
export const RESERVED_GRID_INDICES = [97, 98, 99, 100] as const;

/**
 * The four metrics catalogue v6 activates in the cells v3 reserved (DEV-P1-18).
 * They sit outside the frozen v3 per-area cardinalities, so each must declare its reserved grid
 * cell; from revision 6.0 onward their presence is required, not optional.
 */
export const V6_ACTIVATED_METRIC_IDS = ['MH03', 'MG08', 'MI12', 'MK19'] as const;

export const GRID_ROWS = 10;
export const GRID_COLUMNS = 10;
export const GRID_CELL_COUNT = GRID_ROWS * GRID_COLUMNS;

/** Legacy alias prefix per area group (catalogue §2.7). */
const LEGACY_PREFIX_TARGET_QUALITY = 'Q';
const LEGACY_PREFIX_EVIDENCE = 'A';
const LEGACY_PREFIX_GATES = 'G';
const LEGACY_PREFIX_SELF = 'S';

export const CANONICAL_METRIC_ID_PATTERN = /^M[A-K][0-9]{2}$/;
export const LEGACY_METRIC_ID_PATTERN = /^[QAGS][0-9]{2}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const NORMALIZATION_PROFILE_ID_PATTERN = /^NORM-[A-Za-z0-9._-]+$/;
const CATALOGUE_ID_PATTERN = /^MCAT-[A-Za-z0-9._-]+$/;
const APPLICABILITY_ID_PATTERN = /^MAP-[A-Za-z0-9._-]+$/;
const UNIT_VERSION_ID_PATTERN = /^UVR-[A-Za-z0-9._-]+$/;
const SNAPSHOT_ID_PATTERN = /^SNP-[A-Za-z0-9._-]+$/;
const CATALOGUE_VERSION_PATTERN = /^[0-9]+\.[0-9]+(\.[0-9]+)?$/;

// ---------------------------------------------------------------------------
// ID grammar helpers
// ---------------------------------------------------------------------------

export interface ParsedMetricId {
  area: MetricArea;
  ordinal: number;
}

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

export function isCanonicalMetricId(value: string): boolean {
  if (!CANONICAL_METRIC_ID_PATTERN.test(value)) return false;
  return value.slice(2) !== '00';
}

export function formatCanonicalMetricId(area: MetricArea, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 99) {
    throw new RangeError(`Metric ordinal out of range: ${String(ordinal)}`);
  }
  return `M${area}${pad2(ordinal)}`;
}

export function parseCanonicalMetricId(value: string): ParsedMetricId | null {
  if (!isCanonicalMetricId(value)) return null;
  const areaChar = value.charAt(1);
  const area = (METRIC_AREAS as readonly string[]).includes(areaChar)
    ? (areaChar as MetricArea)
    : null;
  if (area === null) return null;
  const ordinal = Number.parseInt(value.slice(2), 10);
  return { area, ordinal };
}

// ---------------------------------------------------------------------------
// Frozen v3 coordinate map and legacy alias derivation
// ---------------------------------------------------------------------------

export interface GridCell {
  index: number;
  x: number;
  y: number;
}

/** gridIndex 1..100 → (x, y) per the canonical formula (catalogue §2.8). */
export function gridCellForIndex(index: number): GridCell {
  if (!Number.isInteger(index) || index < 1 || index > GRID_CELL_COUNT) {
    throw new RangeError(`Grid index out of range: ${String(index)}`);
  }
  return {
    index,
    x: ((index - 1) % GRID_COLUMNS) + 1,
    y: Math.floor((index - 1) / GRID_COLUMNS) + 1,
  };
}

function cumulativeOffsetBeforeArea(area: MetricArea): number {
  let offset = 0;
  for (const candidate of METRIC_AREAS) {
    if (candidate === area) break;
    offset += V3_AREA_CARDINALITIES[candidate];
  }
  return offset;
}

/**
 * Frozen v3 grid index for a canonical (area, ordinal), or null when the ID is
 * outside the frozen v3 set (such measures must declare a reserved cell).
 */
export function frozenV3GridIndexFor(area: MetricArea, ordinal: number): number | null {
  if (ordinal < 1 || ordinal > V3_AREA_CARDINALITIES[area]) return null;
  return cumulativeOffsetBeforeArea(area) + ordinal;
}

/**
 * Deterministic legacy alias (catalogue §2.7): Q01–Q60 → target quality in
 * canonical order; A01–A11 → MI; G01–G07 → MJ; S01–S18 → MK. Null outside the
 * frozen v3 set.
 */
export function legacyAliasFor(area: MetricArea, ordinal: number): string | null {
  if (ordinal < 1 || ordinal > V3_AREA_CARDINALITIES[area]) return null;
  const family = AREA_FAMILY[area];
  if (family === 'TARGET_QUALITY') {
    return `${LEGACY_PREFIX_TARGET_QUALITY}${pad2(cumulativeOffsetBeforeArea(area) + ordinal)}`;
  }
  if (family === 'EVIDENCE_ASSURANCE') return `${LEGACY_PREFIX_EVIDENCE}${pad2(ordinal)}`;
  if (family === 'ACCEPTANCE_GATES') return `${LEGACY_PREFIX_GATES}${pad2(ordinal)}`;
  return `${LEGACY_PREFIX_SELF}${pad2(ordinal)}`;
}

/** All 96 canonical v3 metric IDs in canonical (grid) order. */
export function expectedV3MetricIds(): string[] {
  const ids: string[] = [];
  for (const area of METRIC_AREAS) {
    const count = V3_AREA_CARDINALITIES[area];
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      ids.push(formatCanonicalMetricId(area, ordinal));
    }
  }
  return ids;
}

/** Deterministic legacy → canonical map for the frozen v3 set. */
export function derivedLegacyAliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const area of METRIC_AREAS) {
    const count = V3_AREA_CARDINALITIES[area];
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const alias = legacyAliasFor(area, ordinal);
      if (alias !== null) map[alias] = formatCanonicalMetricId(area, ordinal);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Raw (input) registry schemas — strict, zod-validated
// ---------------------------------------------------------------------------

const rawGridSchema = z
  .object({
    index: z.number().int().min(1).max(GRID_CELL_COUNT),
    x: z.number().int().min(1).max(GRID_COLUMNS).optional(),
    y: z.number().int().min(1).max(GRID_ROWS).optional(),
  })
  .strict();

const rawMeasureRecordSchema = z
  .object({
    id: z.string().regex(CANONICAL_METRIC_ID_PATTERN, 'expected canonical ID M<Area><Ordinal>'),
    name: z.string().min(1),
    question: z.string().min(1),
    evidenceSources: z.array(z.string().min(1)).default([]),
    failurePatterns: z.array(z.string().min(1)).default([]),
    verdictImpact: z.string().min(1).nullable().default(null),
    projectionType: z.enum(PROJECTION_TYPES),
    normalizationProfileId: z.string().regex(NORMALIZATION_PROFILE_ID_PATTERN),
    status: z.enum(METRIC_STATUSES),
    family: z.enum(METRIC_FAMILIES).optional(),
    legacyId: z.string().regex(LEGACY_METRIC_ID_PATTERN).nullable().optional(),
    grid: rawGridSchema.optional(),
  })
  .strict();

const rawCatalogueSchema = z
  .object({
    catalogueId: z.string().regex(CATALOGUE_ID_PATTERN),
    version: z.string().regex(CATALOGUE_VERSION_PATTERN),
    status: z.enum(CATALOGUE_STATUSES),
    effectiveFromCycle: z.string().min(1).nullable().default(null),
    supersedes: z.string().min(1).nullable().default(null),
    sourceArtifactHash: z.string().regex(SHA256_HEX_PATTERN).nullable().default(null),
    targetProfileIds: z.array(z.string().min(1)).default([]),
    declaredLegacyAliases: z.record(z.string(), z.string()).optional(),
    measures: z.array(rawMeasureRecordSchema).min(1),
  })
  .strict();

type RawCatalogue = z.infer<typeof rawCatalogueSchema>;
type RawMeasureRecord = z.infer<typeof rawMeasureRecordSchema>;

// ---------------------------------------------------------------------------
// Derived (output) record types + drift-locked schemas
// ---------------------------------------------------------------------------

/** Compile-time equality drift lock (project standard for schema/type pairs). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

export interface CanonicalMetricDefinition {
  metricId: string;
  legacyId: string | null;
  family: MetricFamily;
  area: MetricArea;
  ordinal: number;
  name: string;
  question: string;
  evidenceSources: string[];
  failurePatterns: string[];
  verdictImpact: string | null;
  grid: GridCell;
  familyColor: string;
  projectionType: ProjectionType;
  normalizationProfileId: string;
  status: MetricStatus;
}

export const canonicalMetricDefinitionSchema = z
  .object({
    metricId: z.string().regex(CANONICAL_METRIC_ID_PATTERN),
    legacyId: z.string().regex(LEGACY_METRIC_ID_PATTERN).nullable(),
    family: z.enum(METRIC_FAMILIES),
    area: z.enum(METRIC_AREAS),
    ordinal: z.number().int().min(1).max(99),
    name: z.string().min(1),
    question: z.string().min(1),
    evidenceSources: z.array(z.string()),
    failurePatterns: z.array(z.string()),
    verdictImpact: z.string().nullable(),
    grid: z
      .object({
        index: z.number().int().min(1).max(GRID_CELL_COUNT),
        x: z.number().int().min(1).max(GRID_COLUMNS),
        y: z.number().int().min(1).max(GRID_ROWS),
      })
      .strict(),
    familyColor: z.string(),
    projectionType: z.enum(PROJECTION_TYPES),
    normalizationProfileId: z.string().regex(NORMALIZATION_PROFILE_ID_PATTERN),
    status: z.enum(METRIC_STATUSES),
  })
  .strict();

export type MetricDefinitionSchemaDriftLock = Assert<
  Equals<z.infer<typeof canonicalMetricDefinitionSchema>, CanonicalMetricDefinition>
>;

/** Measure applicability record (implementation 19.28). Reason is always required. */
export interface MeasureApplicabilityRecord {
  applicabilityId: string;
  unitVersionId: string;
  measureId: string;
  catalogueHash: string;
  state: ApplicabilityState;
  reason: string;
  evidence: string[];
  confidence: number;
  resolvedBy: ApplicabilityResolver;
  snapshotId: string;
}

export const measureApplicabilityRecordSchema = z
  .object({
    applicabilityId: z.string().regex(APPLICABILITY_ID_PATTERN),
    unitVersionId: z.string().regex(UNIT_VERSION_ID_PATTERN),
    measureId: z.string().regex(CANONICAL_METRIC_ID_PATTERN),
    catalogueHash: z.string().regex(SHA256_HEX_PATTERN),
    state: z.enum(APPLICABILITY_STATES),
    reason: z.string().min(1),
    evidence: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    resolvedBy: z.enum(APPLICABILITY_RESOLVERS),
    snapshotId: z.string().regex(SNAPSHOT_ID_PATTERN),
  })
  .strict();

export type ApplicabilityRecordSchemaDriftLock = Assert<
  Equals<z.infer<typeof measureApplicabilityRecordSchema>, MeasureApplicabilityRecord>
>;

/** Only REQUIRED / APPLICABLE pairs become Measure Assessment Tasks. */
export function applicabilitySchedulesAssessment(state: ApplicabilityState): boolean {
  return state === 'REQUIRED' || state === 'APPLICABLE';
}

/** UNKNOWN / CONFLICTED create recognition or instrumentation work — never a pass. */
export function applicabilityCreatesRecognitionTask(state: ApplicabilityState): boolean {
  return state === 'UNKNOWN' || state === 'CONFLICTED';
}

/** NOT_APPLICABLE avoids the model call entirely (with its durable reason). */
export function applicabilityAvoidsAssessment(state: ApplicabilityState): boolean {
  return state === 'NOT_APPLICABLE';
}

/** CONDITIONAL requires its condition to be resolved before scheduling. */
export function applicabilityRequiresConditionResolution(state: ApplicabilityState): boolean {
  return state === 'CONDITIONAL';
}

// ---------------------------------------------------------------------------
// Catalogue identity and loaded shape
// ---------------------------------------------------------------------------

export interface MeasurementCatalogueIdentity {
  catalogueId: string;
  version: string;
  schemaVersion: string;
  contentHash: string;
  gridLayoutHash: string;
  legacyAliasMapHash: string;
  familyColorPolicyHash: string;
}

export interface LoadedMeasurementCatalogue {
  identity: MeasurementCatalogueIdentity;
  status: CatalogueStatus;
  effectiveFromCycle: string | null;
  supersedes: string | null;
  sourceArtifactHash: string | null;
  targetProfileIds: string[];
  /** Canonically ordered: frozen v3 order first, then reserved-cell measures by grid index. */
  measures: CanonicalMetricDefinition[];
  measuresById: ReadonlyMap<string, CanonicalMetricDefinition>;
  measuresByLegacyId: ReadonlyMap<string, CanonicalMetricDefinition>;
  familyMetricIds: Record<MetricFamily, string[]>;
  activeMeasureCount: number;
  reservedGridIndicesFree: number[];
}

export interface CatalogueValidationIssue {
  code: string;
  path: string;
  message: string;
}

export class CatalogueValidationError extends Error {
  readonly issues: readonly CatalogueValidationIssue[];

  constructor(issues: readonly CatalogueValidationIssue[]) {
    const preview = issues
      .slice(0, 3)
      .map((issue) => `${issue.code}@${issue.path}: ${issue.message}`)
      .join('; ');
    const suffix = issues.length > 3 ? ` (+${String(issues.length - 3)} more)` : '';
    super(`Measurement catalogue rejected: ${preview}${suffix}`);
    this.name = 'CatalogueValidationError';
    this.issues = issues;
  }
}

export type CatalogueLoadResult =
  | { ok: true; catalogue: LoadedMeasurementCatalogue }
  | { ok: false; issues: CatalogueValidationIssue[] };

// ---------------------------------------------------------------------------
// Canonical serialization and hashing
// ---------------------------------------------------------------------------

type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson };

/**
 * Deterministic serialization: sorted object keys, arrays in given order,
 * finite numbers only, undefined rejected. Same value ⇒ same string.
 */
export function stableStringify(value: CanonicalJson): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('stableStringify: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = value[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
  }
  return `{${parts.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function metricToCanonicalJson(metric: CanonicalMetricDefinition): CanonicalJson {
  return {
    metricId: metric.metricId,
    legacyId: metric.legacyId,
    family: metric.family,
    area: metric.area,
    ordinal: metric.ordinal,
    name: metric.name,
    question: metric.question,
    evidenceSources: [...metric.evidenceSources],
    failurePatterns: [...metric.failurePatterns],
    verdictImpact: metric.verdictImpact,
    grid: { index: metric.grid.index, x: metric.grid.x, y: metric.grid.y },
    familyColor: metric.familyColor,
    projectionType: metric.projectionType,
    normalizationProfileId: metric.normalizationProfileId,
    status: metric.status,
  };
}

/** Hash of the family color policy constant (stable across catalogues). */
export const FAMILY_COLOR_POLICY_HASH = sha256Hex(
  stableStringify({ ...FAMILY_COLOR_POLICY }),
);

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function issue(code: string, path: string, message: string): CatalogueValidationIssue {
  return { code, path, message };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') deepFreeze(child);
    }
  }
  return value;
}

interface DerivedMeasure {
  definition: CanonicalMetricDefinition;
  parsed: ParsedMetricId;
  inFrozenSet: boolean;
}

function deriveMeasure(
  raw: RawMeasureRecord,
  index: number,
  issues: CatalogueValidationIssue[],
): DerivedMeasure | null {
  const path = `measures[${String(index)}](${raw.id})`;
  const parsed = parseCanonicalMetricId(raw.id);
  if (parsed === null) {
    issues.push(issue('METRIC_ID_GRAMMAR', path, 'invalid canonical metric ID'));
    return null;
  }

  const derivedFamily = AREA_FAMILY[parsed.area];
  if (raw.family !== undefined && raw.family !== derivedFamily) {
    issues.push(
      issue(
        'FAMILY_MISMATCH',
        path,
        `declared family ${raw.family} conflicts with area ${parsed.area} → ${derivedFamily}`,
      ),
    );
  }

  const frozenIndex = frozenV3GridIndexFor(parsed.area, parsed.ordinal);
  const inFrozenSet = frozenIndex !== null;

  let gridIndex: number | null = null;
  if (inFrozenSet) {
    gridIndex = frozenIndex;
    if (raw.grid !== undefined && raw.grid.index !== frozenIndex) {
      issues.push(
        issue(
          'GRID_FROZEN_MISMATCH',
          path,
          `declared grid index ${String(raw.grid.index)} conflicts with frozen v3 cell ${String(frozenIndex)}`,
        ),
      );
    }
  } else if (raw.grid === undefined) {
    issues.push(
      issue(
        'GRID_RESERVED_REQUIRED',
        path,
        'metric outside the frozen v3 set must declare a reserved grid cell (97–100)',
      ),
    );
  } else if (!(RESERVED_GRID_INDICES as readonly number[]).includes(raw.grid.index)) {
    issues.push(
      issue(
        'GRID_RESERVED_RANGE',
        path,
        `metric outside the frozen v3 set must occupy a reserved cell 97–100, got ${String(raw.grid.index)}`,
      ),
    );
  } else {
    gridIndex = raw.grid.index;
  }

  const derivedAlias = legacyAliasFor(parsed.area, parsed.ordinal);
  if (raw.legacyId !== undefined && raw.legacyId !== null && raw.legacyId !== derivedAlias) {
    issues.push(
      issue(
        'LEGACY_ALIAS_MISMATCH',
        path,
        `declared legacy ID ${raw.legacyId} conflicts with derived ${derivedAlias ?? 'null'}`,
      ),
    );
  }

  if (gridIndex === null) return null;

  const cell = gridCellForIndex(gridIndex);
  if (raw.grid !== undefined) {
    if (raw.grid.x !== undefined && raw.grid.x !== cell.x) {
      issues.push(issue('GRID_XY_MISMATCH', path, `declared x=${String(raw.grid.x)} expected ${String(cell.x)}`));
    }
    if (raw.grid.y !== undefined && raw.grid.y !== cell.y) {
      issues.push(issue('GRID_XY_MISMATCH', path, `declared y=${String(raw.grid.y)} expected ${String(cell.y)}`));
    }
  }

  const definition: CanonicalMetricDefinition = {
    metricId: raw.id,
    legacyId: derivedAlias,
    family: derivedFamily,
    area: parsed.area,
    ordinal: parsed.ordinal,
    name: raw.name,
    question: raw.question,
    evidenceSources: [...raw.evidenceSources],
    failurePatterns: [...raw.failurePatterns],
    verdictImpact: raw.verdictImpact,
    grid: cell,
    familyColor: FAMILY_COLOR_POLICY[derivedFamily],
    projectionType: raw.projectionType,
    normalizationProfileId: raw.normalizationProfileId,
    status: raw.status,
  };
  return { definition, parsed, inFrozenSet };
}

function validateStructure(
  raw: RawCatalogue,
  derived: DerivedMeasure[],
  issues: CatalogueValidationIssue[],
): void {
  // Duplicate canonical IDs (also guards against retired-ID takeover inside one catalogue).
  const seenIds = new Set<string>();
  for (const measure of derived) {
    const id = measure.definition.metricId;
    if (seenIds.has(id)) {
      issues.push(issue('METRIC_ID_DUPLICATE', `measures(${id})`, 'duplicate canonical metric ID'));
    }
    seenIds.add(id);
  }

  // Grid collisions invalidate the entire projection.
  const cellOwners = new Map<number, string>();
  for (const measure of derived) {
    const cellIndex = measure.definition.grid.index;
    const owner = cellOwners.get(cellIndex);
    if (owner !== undefined && owner !== measure.definition.metricId) {
      issues.push(
        issue(
          'GRID_COLLISION',
          `grid[${String(cellIndex)}]`,
          `cell claimed by both ${owner} and ${measure.definition.metricId}`,
        ),
      );
    }
    cellOwners.set(cellIndex, measure.definition.metricId);
  }

  // Ordinal contiguity per area: ordinals must be exactly 1..n with no gaps.
  const ordinalsByArea = new Map<MetricArea, number[]>();
  for (const measure of derived) {
    const list = ordinalsByArea.get(measure.parsed.area);
    if (list === undefined) ordinalsByArea.set(measure.parsed.area, [measure.parsed.ordinal]);
    else list.push(measure.parsed.ordinal);
  }
  for (const [area, ordinals] of ordinalsByArea) {
    const sorted = [...ordinals].sort((a, b) => a - b);
    for (let position = 0; position < sorted.length; position += 1) {
      if (sorted[position] !== position + 1) {
        issues.push(
          issue(
            'ORDINAL_GAP',
            `area(${area})`,
            `ordinals must be contiguous from 1; got [${sorted.map(String).join(', ')}]`,
          ),
        );
        break;
      }
    }
  }

  // The frozen 96-metric set is a floor, not a v3 quirk: every catalogue from v3 onward inherits
  // those cells unchanged, so absence is always a defect. DEV-P1-18: this check was gated on
  // `major === '3'`, which meant bumping the version to 6.0 silently switched completeness checking
  // off — a migration would have validated more weakly than the thing it replaced. From v6 the
  // expansion cells 97-100 are active too, so their presence is required as well.
  const major = Number.parseInt(raw.version.split('.')[0] ?? '0', 10);
  if (Number.isFinite(major) && major >= 3) {
    const presentIds = new Set(derived.map((measure) => measure.definition.metricId));
    for (const expectedId of expectedV3MetricIds()) {
      if (!presentIds.has(expectedId)) {
        issues.push(issue('V3_INCOMPLETE', `measures(${expectedId})`, 'frozen v3 metric missing'));
      }
    }
    if (major >= 6) {
      for (const expectedId of V6_ACTIVATED_METRIC_IDS) {
        if (!presentIds.has(expectedId)) {
          issues.push(
            issue('V6_INCOMPLETE', `measures(${expectedId})`, 'catalogue v6 activation metric missing'),
          );
        }
      }

      // DEV-P1-19: a v6 catalogue must say what it replaces. The revision that activates the last
      // four cells is a migration, and an undeclared migration is indistinguishable from a catalogue
      // authored from nothing — which is exactly the ambiguity that makes historic records unsafe to
      // compare. `supersedes` is the declaration; absence is a defect, not a default.
      if (raw.supersedes === null || raw.supersedes.trim() === '') {
        issues.push(
          issue(
            'V6_MIGRATION_UNDECLARED',
            'supersedes',
            'catalogue v6 must declare the revision it supersedes',
          ),
        );
      }

      // v6 activates every cell, so no reserved cell may remain free and the active count is exact.
      const activeCount = derived.filter((measure) => measure.definition.status === 'ACTIVE').length;
      if (activeCount !== GRID_CELL_COUNT) {
        issues.push(
          issue(
            'V6_GRID_INCOMPLETE',
            'measures',
            `catalogue v6 requires ${String(GRID_CELL_COUNT)} active coordinates, found ${String(activeCount)}`,
          ),
        );
      }
    }
  }

  // Declared alias map, when present, must equal the derived map exactly.
  if (raw.declaredLegacyAliases !== undefined) {
    const derivedMap = derivedLegacyAliasMap();
    const declaredEntries = Object.entries(raw.declaredLegacyAliases);
    for (const [legacyId, metricId] of declaredEntries) {
      const expected = derivedMap[legacyId];
      if (expected === undefined) {
        issues.push(issue('ALIAS_UNKNOWN', `declaredLegacyAliases(${legacyId})`, 'unknown legacy ID'));
      } else if (expected !== metricId) {
        issues.push(
          issue(
            'ALIAS_MISMATCH',
            `declaredLegacyAliases(${legacyId})`,
            `maps to ${metricId}, derived ${expected}`,
          ),
        );
      }
    }
    const declaredCount = declaredEntries.length;
    const derivedCount = Object.keys(derivedMap).length;
    if (declaredCount !== derivedCount) {
      issues.push(
        issue(
          'ALIAS_INCOMPLETE',
          'declaredLegacyAliases',
          `declared ${String(declaredCount)} aliases, derived map has ${String(derivedCount)}`,
        ),
      );
    }
  }
}

function buildLoaded(
  raw: RawCatalogue,
  derived: DerivedMeasure[],
): LoadedMeasurementCatalogue {
  const measures = derived
    .map((measure) => measure.definition)
    .sort((a, b) => a.grid.index - b.grid.index);

  const measuresById = new Map<string, CanonicalMetricDefinition>();
  const measuresByLegacyId = new Map<string, CanonicalMetricDefinition>();
  const familyMetricIds: Record<MetricFamily, string[]> = {
    TARGET_QUALITY: [],
    EVIDENCE_ASSURANCE: [],
    ACCEPTANCE_GATES: [],
    CLUE_SELF: [],
  };
  let activeMeasureCount = 0;
  const occupiedReserved = new Set<number>();

  for (const metric of measures) {
    measuresById.set(metric.metricId, metric);
    if (metric.legacyId !== null) measuresByLegacyId.set(metric.legacyId, metric);
    familyMetricIds[metric.family].push(metric.metricId);
    if (metric.status === 'ACTIVE') activeMeasureCount += 1;
    if ((RESERVED_GRID_INDICES as readonly number[]).includes(metric.grid.index)) {
      occupiedReserved.add(metric.grid.index);
    }
  }

  const reservedGridIndicesFree = RESERVED_GRID_INDICES.filter(
    (index) => !occupiedReserved.has(index),
  );

  const sortedTargetProfileIds = [...raw.targetProfileIds].sort();

  const contentBody: CanonicalJson = {
    schemaVersion: CATALOGUE_REGISTRY_SCHEMA_VERSION,
    catalogueId: raw.catalogueId,
    version: raw.version,
    status: raw.status,
    effectiveFromCycle: raw.effectiveFromCycle,
    supersedes: raw.supersedes,
    sourceArtifactHash: raw.sourceArtifactHash,
    targetProfileIds: sortedTargetProfileIds,
    familyColorPolicyHash: FAMILY_COLOR_POLICY_HASH,
    measures: measures.map((metric) => metricToCanonicalJson(metric)),
  };
  const contentHash = sha256Hex(stableStringify(contentBody));

  const gridLayoutHash = sha256Hex(
    stableStringify(
      measures.map((metric) => ({
        metricId: metric.metricId,
        index: metric.grid.index,
        x: metric.grid.x,
        y: metric.grid.y,
      })),
    ),
  );

  const aliasPairs = measures
    .filter((metric) => metric.legacyId !== null)
    .map((metric) => ({ legacyId: metric.legacyId, metricId: metric.metricId }))
    .sort((a, b) => (a.legacyId ?? '').localeCompare(b.legacyId ?? ''));
  const legacyAliasMapHash = sha256Hex(stableStringify(aliasPairs as CanonicalJson));

  const loaded: LoadedMeasurementCatalogue = {
    identity: {
      catalogueId: raw.catalogueId,
      version: raw.version,
      schemaVersion: CATALOGUE_REGISTRY_SCHEMA_VERSION,
      contentHash,
      gridLayoutHash,
      legacyAliasMapHash,
      familyColorPolicyHash: FAMILY_COLOR_POLICY_HASH,
    },
    status: raw.status,
    effectiveFromCycle: raw.effectiveFromCycle,
    supersedes: raw.supersedes,
    sourceArtifactHash: raw.sourceArtifactHash,
    targetProfileIds: sortedTargetProfileIds,
    measures,
    measuresById,
    measuresByLegacyId,
    familyMetricIds,
    activeMeasureCount,
    reservedGridIndicesFree,
  };
  deepFreeze(loaded.measures);
  deepFreeze(loaded.familyMetricIds);
  deepFreeze(loaded.identity);
  return loaded;
}

/** Load and strictly validate a catalogue from a parsed value (object form). */
export function tryLoadMeasurementCatalogueFromValue(value: unknown): CatalogueLoadResult {
  const parsedRaw = rawCatalogueSchema.safeParse(value);
  if (!parsedRaw.success) {
    const issues = parsedRaw.error.issues.map((zodIssue) =>
      issue('SCHEMA', zodIssue.path.map(String).join('.') || '(root)', zodIssue.message),
    );
    return { ok: false, issues };
  }

  const issues: CatalogueValidationIssue[] = [];
  const derived: DerivedMeasure[] = [];
  for (let index = 0; index < parsedRaw.data.measures.length; index += 1) {
    const rawMeasure = parsedRaw.data.measures[index];
    if (rawMeasure === undefined) continue;
    const measure = deriveMeasure(rawMeasure, index, issues);
    if (measure !== null) derived.push(measure);
  }

  validateStructure(parsedRaw.data, derived, issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, catalogue: buildLoaded(parsedRaw.data, derived) };
}

/** Load and strictly validate a catalogue from YAML text. */
export function tryLoadMeasurementCatalogue(yamlText: string): CatalogueLoadResult {
  let value: unknown;
  try {
    value = parseYaml(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [issue('YAML_PARSE', '(document)', message)] };
  }
  return tryLoadMeasurementCatalogueFromValue(value);
}

/** Throwing variant for call sites that treat a bad registry as fatal.
 *
 * DEV-P1-19: this variant also enforces production readiness by default, because every caller of it
 * is a running system (the daemon and the dashboard server), and a running system that quietly
 * accepts a v3 registry would measure the target against a catalogue that no longer describes it.
 * Tooling that legitimately reads historic revisions — the Markdown generator, migration scripts,
 * archive inspection — uses `tryLoadMeasurementCatalogue`, which validates but does not gate, or
 * passes `requireProductionReadiness: false` here.
 */
export function loadMeasurementCatalogue(
  yamlText: string,
  options: { readonly requireProductionReadiness?: boolean } = {},
): LoadedMeasurementCatalogue {
  const result = tryLoadMeasurementCatalogue(yamlText);
  if (!result.ok) throw new CatalogueValidationError(result.issues);
  if (options.requireProductionReadiness !== false) {
    assertProductionCatalogue(result.catalogue);
  }
  return result.catalogue;
}

// ---------------------------------------------------------------------------
// Production readiness (DEV-P1-19)
// ---------------------------------------------------------------------------

/**
 * The catalogue revision production requires.
 *
 * v3 is not merely older: it leaves cells 97–100 reserved, so a v3 registry cannot express method
 * adequacy (`MH03`), cross-environment contract integrity (`MG08`), evidence-plan validity (`MI12`)
 * or RPI value yield (`MK19`). Running against it does not produce slightly stale measurement — it
 * produces measurement that is silently blind to four questions the mission is obliged to ask.
 */
export const PRODUCTION_CATALOGUE_MAJOR = 6;

export interface CatalogueReadiness {
  readonly ready: boolean;
  /** Major revision parsed from the catalogue version, or null when unparseable. */
  readonly major: number | null;
  /** Every reason the catalogue is unfit for production, in stable order. Empty when ready. */
  readonly reasons: readonly string[];
}

/**
 * Reports whether a loaded catalogue may govern a production run.
 *
 * Separate from validation on purpose. A v3 catalogue is a *valid* historic artifact and must stay
 * loadable — old Great Book records were written against it and remain readable. What it may not do
 * is govern new measurement. Keeping the two judgements apart is what lets CLUE read its own history
 * without pretending that history is current.
 */
export function assessCatalogueReadiness(catalogue: LoadedMeasurementCatalogue): CatalogueReadiness {
  const reasons: string[] = [];
  const majorText = catalogue.identity.version.split('.')[0] ?? '';
  const parsed = Number.parseInt(majorText, 10);
  const major = Number.isFinite(parsed) ? parsed : null;

  if (major === null) {
    reasons.push(`catalogue version "${catalogue.identity.version}" has no parseable major revision`);
  } else if (major < PRODUCTION_CATALOGUE_MAJOR) {
    reasons.push(
      `catalogue revision ${String(major)} is below the production minimum ` +
        `${String(PRODUCTION_CATALOGUE_MAJOR)}; cells 97-100 are not active`,
    );
  }

  if (catalogue.status !== 'ACTIVE') {
    reasons.push(`catalogue status is ${catalogue.status}, not ACTIVE`);
  }
  if (catalogue.activeMeasureCount !== GRID_CELL_COUNT) {
    reasons.push(
      `${String(catalogue.activeMeasureCount)} active coordinates, expected ${String(GRID_CELL_COUNT)}`,
    );
  }
  if (catalogue.reservedGridIndicesFree.length > 0) {
    reasons.push(
      `grid cells ${catalogue.reservedGridIndicesFree.join(', ')} are still reserved`,
    );
  }
  for (const metricId of V6_ACTIVATED_METRIC_IDS) {
    if (!catalogue.measuresById.has(metricId)) {
      reasons.push(`activation metric ${metricId} is absent`);
    }
  }
  // A production catalogue pins the normative document it was generated from; without that pin the
  // registry cannot be tied back to a reviewed artifact.
  if (catalogue.sourceArtifactHash === null) {
    reasons.push('no sourceArtifactHash pins the normative catalogue document');
  }

  return { ready: reasons.length === 0, major, reasons };
}

/** Throws unless the catalogue may govern a production run. */
export function assertProductionCatalogue(catalogue: LoadedMeasurementCatalogue): void {
  const readiness = assessCatalogueReadiness(catalogue);
  if (readiness.ready) return;
  throw new CatalogueValidationError(
    readiness.reasons.map((reason) => issue('NOT_PRODUCTION_READY', 'catalogue', reason)),
  );
}

// ---------------------------------------------------------------------------
// Generated-Markdown agreement (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Convention: the generated human-readable catalogue embeds one line
 * `Catalogue-Content-Hash: <64-hex>`. Runtime code must reject a registry whose
 * generated Markdown disagrees.
 */
export const MARKDOWN_CONTENT_HASH_LABEL = 'Catalogue-Content-Hash';

const markdownHashPattern = /Catalogue-Content-Hash:\s*([0-9a-f]{64})/;

export function extractMarkdownContentHash(markdownText: string): string | null {
  const match = markdownHashPattern.exec(markdownText);
  const captured = match === null ? undefined : match[1];
  return captured ?? null;
}

export interface MarkdownAgreementResult {
  agrees: boolean;
  embeddedHash: string | null;
  expectedHash: string;
}

export function verifyGeneratedMarkdownAgreement(
  markdownText: string,
  catalogue: LoadedMeasurementCatalogue,
): MarkdownAgreementResult {
  const embeddedHash = extractMarkdownContentHash(markdownText);
  return {
    agrees: embeddedHash !== null && embeddedHash === catalogue.identity.contentHash,
    embeddedHash,
    expectedHash: catalogue.identity.contentHash,
  };
}
