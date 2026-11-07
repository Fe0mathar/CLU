import { z } from 'zod';

import {
  CANONICAL_GRID_SIZE,
  METRIC_COORDINATES,
  type CanonicalMetricFamily,
} from '../shared/measurementCoordinates.js';

/** How many canonical cells the catalogue in force still reserves. Derived, never asserted. */
const RESERVED_COORDINATE_COUNT = METRIC_COORDINATES.filter(
  (coordinate) => coordinate.family === 'RESERVED',
).length;

export type GreatBookAggregationMode =
  | 'CURRENT_CERTIFIED'
  | 'SELECTED_CYCLE'
  | 'HISTORICAL_NET'
  | 'CONFIDENCE_ADJUSTED'
  | 'AVERAGE_PER_EXPERIMENT'
  | 'EXPERIMENT_COUNT'
  | 'COVERAGE'
  | 'EQUILIBRIUM';

export type FieldEvidenceState =
  | 'available'
  | 'unknown'
  | 'stale'
  | 'not_applicable'
  | 'reserved';

export interface NativeMetricEvidence {
  readonly baseline: number | string | null;
  readonly result: number | string | null;
  readonly delta: number | string | null;
  readonly unit: string | null;
  readonly display: string;
}

export interface GreatBookFieldSegment {
  readonly contributionId: string;
  readonly greatBookEntryId: string;
  readonly measurementId: string;
  readonly scopeId: string;
  readonly cycleId: string | null;
  readonly normalizedContribution: number;
  readonly native: NativeMetricEvidence;
  readonly confidence: number;
  readonly freshness: number;
  readonly certified: boolean;
  readonly invalidated: boolean;
  readonly verdict: string;
  readonly proofContractId: string | null;
  readonly benchmarkRunId: string | null;
  readonly recordedAt: string;
}

export interface GreatBookFieldCell {
  readonly gridIndex: number;
  readonly x: number;
  readonly y: number;
  readonly measurementId: string;
  readonly legacyId: string | null;
  readonly name: string;
  readonly family: CanonicalMetricFamily;
  readonly familyColor: string;
  readonly state: FieldEvidenceState;
  readonly positiveHeight: number | null;
  readonly negativeDepth: number | null;
  readonly netContribution: number | null;
  readonly confidence: number | null;
  readonly coverage: number | null;
  readonly freshness: number | null;
  readonly contributionCount: number;
  readonly segments: readonly GreatBookFieldSegment[];
}

export interface GreatBookFamilySummary {
  readonly family: CanonicalMetricFamily;
  readonly familyColor: string;
  readonly positiveContribution: number | null;
  readonly negativeContribution: number | null;
  readonly netContribution: number | null;
  readonly certifiedEvidencePercent: number | null;
  readonly activeMetricCount: number;
}

export interface GreatBookImprovementFieldView {
  readonly schemaVersion: '1.0.0';
  readonly capturedAt: string;
  readonly targetId: string | null;
  readonly cycleId: string | null;
  readonly catalogueVersion: string | null;
  readonly catalogueHash: string | null;
  readonly normalizationVersion: string | null;
  readonly normalizationHash: string | null;
  readonly aggregationMode: GreatBookAggregationMode;
  readonly selectedMeasurementId: string | null;
  readonly grid: {
    readonly rows: 10;
    readonly columns: 10;
    readonly activeCells: number;
    /**
     * DEV-P1-20: a count, not a literal. This was typed `4`, which froze catalogue v3's reservation
     * into the type system — after v6 activated cells 97-100 the only assignable value was the wrong
     * one. Rows and columns stay literal because the 10 × 10 floor is genuinely fixed; how many of its
     * cells are reserved is a property of the catalogue in force.
     */
    readonly reservedCells: number;
  };
  readonly families: readonly GreatBookFamilySummary[];
  readonly cells: readonly GreatBookFieldCell[];
  readonly warnings: readonly string[];
}

const familySchema = z.enum([
  'TARGET_QUALITY',
  'EVIDENCE_ASSURANCE',
  'ACCEPTANCE_GATES',
  'CLUE_SELF',
  'RESERVED',
]);

const nativeMetricEvidenceSchema = z
  .object({
    baseline: z.union([z.number(), z.string()]).nullable(),
    result: z.union([z.number(), z.string()]).nullable(),
    delta: z.union([z.number(), z.string()]).nullable(),
    unit: z.string().nullable(),
    display: z.string(),
  })
  .strict();

const segmentSchema = z
  .object({
    contributionId: z.string(),
    greatBookEntryId: z.string(),
    measurementId: z.string(),
    scopeId: z.string(),
    cycleId: z.string().nullable(),
    normalizedContribution: z.number().min(-100).max(100),
    native: nativeMetricEvidenceSchema,
    confidence: z.number().min(0).max(1),
    freshness: z.number().min(0).max(1),
    certified: z.boolean(),
    invalidated: z.boolean(),
    verdict: z.string(),
    proofContractId: z.string().nullable(),
    benchmarkRunId: z.string().nullable(),
    recordedAt: z.string(),
  })
  .strict();

const cellSchema = z
  .object({
    gridIndex: z.number().int().min(1).max(100),
    x: z.number().int().min(1).max(10),
    y: z.number().int().min(1).max(10),
    measurementId: z.string(),
    legacyId: z.string().nullable(),
    name: z.string(),
    family: familySchema,
    familyColor: z.string(),
    state: z.enum(['available', 'unknown', 'stale', 'not_applicable', 'reserved']),
    positiveHeight: z.number().min(0).max(100).nullable(),
    negativeDepth: z.number().min(-100).max(0).nullable(),
    netContribution: z.number().min(-100).max(100).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    coverage: z.number().min(0).max(1).nullable(),
    freshness: z.number().min(0).max(1).nullable(),
    contributionCount: z.number().int().nonnegative(),
    segments: z.array(segmentSchema),
  })
  .strict();

const familySummarySchema = z
  .object({
    family: familySchema,
    familyColor: z.string(),
    positiveContribution: z.number().nullable(),
    negativeContribution: z.number().nullable(),
    netContribution: z.number().nullable(),
    certifiedEvidencePercent: z.number().min(0).max(100).nullable(),
    activeMetricCount: z.number().int().nonnegative(),
  })
  .strict();

export const greatBookImprovementFieldSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    capturedAt: z.string(),
    targetId: z.string().nullable(),
    cycleId: z.string().nullable(),
    catalogueVersion: z.string().nullable(),
    catalogueHash: z.string().nullable(),
    normalizationVersion: z.string().nullable(),
    normalizationHash: z.string().nullable(),
    aggregationMode: z.enum([
      'CURRENT_CERTIFIED',
      'SELECTED_CYCLE',
      'HISTORICAL_NET',
      'CONFIDENCE_ADJUSTED',
      'AVERAGE_PER_EXPERIMENT',
      'EXPERIMENT_COUNT',
      'COVERAGE',
      'EQUILIBRIUM',
    ]),
    selectedMeasurementId: z.string().nullable(),
    grid: z
      .object({
        rows: z.literal(10),
        columns: z.literal(10),
        // DEV-P1-20: bounded by the canonical grid, not by catalogue v3's 96/4 split. `max(96)` and
        // `literal(4)` rejected a valid v6 field, so runtime validation contradicted the catalogue.
        activeCells: z.number().int().min(0).max(CANONICAL_GRID_SIZE),
        reservedCells: z.number().int().min(0).max(CANONICAL_GRID_SIZE),
      })
      .strict(),
    families: z.array(familySummarySchema),
    cells: z.array(cellSchema).length(100),
    warnings: z.array(z.string()),
  })
  .strict();

export function parseGreatBookImprovementField(input: unknown): GreatBookImprovementFieldView {
  return greatBookImprovementFieldSchema.parse(input) as GreatBookImprovementFieldView;
}

const FAMILY_COLORS: Readonly<Record<CanonicalMetricFamily, string>> = {
  TARGET_QUALITY: '#00a3e0',
  EVIDENCE_ASSURANCE: '#f4af2d',
  ACCEPTANCE_GATES: '#ff5500',
  CLUE_SELF: '#39ff88',
  RESERVED: '#07111c',
};

export function emptyGreatBookImprovementField(capturedAt: string): GreatBookImprovementFieldView {
  const cells: GreatBookFieldCell[] = METRIC_COORDINATES.map((coordinate) => ({
    gridIndex: coordinate.gridIndex,
    x: coordinate.x,
    y: coordinate.y,
    measurementId: coordinate.measurementId,
    legacyId: coordinate.legacyId,
    name: coordinate.name,
    family: coordinate.family,
    familyColor: FAMILY_COLORS[coordinate.family],
    state: coordinate.family === 'RESERVED' ? 'reserved' : 'unknown',
    positiveHeight: null,
    negativeDepth: null,
    netContribution: null,
    confidence: null,
    coverage: null,
    freshness: null,
    contributionCount: 0,
    segments: [],
  }));

  return {
    schemaVersion: '1.0.0',
    capturedAt,
    targetId: null,
    cycleId: null,
    catalogueVersion: null,
    catalogueHash: null,
    normalizationVersion: null,
    normalizationHash: null,
    aggregationMode: 'CURRENT_CERTIFIED',
    selectedMeasurementId: null,
    grid: { rows: 10, columns: 10, activeCells: 0, reservedCells: RESERVED_COORDINATE_COUNT },
    families: [
      { family: 'TARGET_QUALITY', familyColor: '#00a3e0', positiveContribution: null, negativeContribution: null, netContribution: null, certifiedEvidencePercent: null, activeMetricCount: 0 },
      { family: 'EVIDENCE_ASSURANCE', familyColor: '#f4af2d', positiveContribution: null, negativeContribution: null, netContribution: null, certifiedEvidencePercent: null, activeMetricCount: 0 },
      { family: 'ACCEPTANCE_GATES', familyColor: '#ff5500', positiveContribution: null, negativeContribution: null, netContribution: null, certifiedEvidencePercent: null, activeMetricCount: 0 },
      { family: 'CLUE_SELF', familyColor: '#39ff88', positiveContribution: null, negativeContribution: null, netContribution: null, certifiedEvidencePercent: null, activeMetricCount: 0 },
    ],
    cells,
    warnings: ['Great Book evidence is not connected.'],
  };
}
