import { z } from 'zod';

export type GaugeMetricFamily =
  | 'TARGET_QUALITY'
  | 'EVIDENCE_ASSURANCE'
  | 'ACCEPTANCE_GATES'
  | 'CLUE_SELF';

export type GaugeAggregationMode =
  | 'CURRENT_CERTIFIED'
  | 'SELECTED_CYCLE'
  | 'HISTORICAL_NET'
  | 'CONFIDENCE_ADJUSTED'
  | 'AVERAGE_PER_EXPERIMENT'
  | 'EXPERIMENT_COUNT'
  | 'COVERAGE'
  | 'EQUILIBRIUM';

export type GaugeProjectionType =
  | 'signed_score'
  | 'percentage'
  | 'count'
  | 'ratio'
  | 'ordinal'
  | 'gate_state'
  | 'distribution_summary';

export type GaugeTrend = 'improving' | 'stable' | 'worsening' | 'unknown';
export type GaugeAvailability = 'available' | 'stale' | 'unknown' | 'not_applicable';
export type GaugeGateState = 'PASS' | 'WARNING' | 'FAIL' | 'UNKNOWN';

export type GaugeSelection =
  | { readonly kind: 'metric'; readonly id: string }
  | { readonly kind: 'family_aggregate'; readonly id: GaugeMetricFamily }
  | { readonly kind: 'gate_summary'; readonly id: string }
  | { readonly kind: 'target_indicator'; readonly id: string; readonly mappedMetricId: string };

export interface GaugeNativeValue {
  readonly value: number | string | null;
  readonly unit: string | null;
  readonly display: string;
}

export interface NeonGaugeProjection {
  readonly slot: 1 | 2 | 3 | 4;
  readonly definitionId: string;
  readonly selection: GaugeSelection;
  readonly metricId: string;
  readonly metricName: string;
  readonly scope: { readonly kind: string; readonly id: string };
  readonly aggregationMode: GaugeAggregationMode;
  readonly family: GaugeMetricFamily;
  readonly familyColor: string;
  readonly projectionType: GaugeProjectionType;
  readonly nativeValue: GaugeNativeValue;
  readonly normalizedValue: number | null;
  readonly dialPosition: number | null;
  readonly gateState: GaugeGateState | null;
  readonly delta: number | null;
  readonly deltaUnit: string | null;
  readonly trend: GaugeTrend;
  readonly confidence: number | null;
  readonly coverage: number | null;
  readonly freshness: number | null;
  readonly availability: GaugeAvailability;
  readonly warning: string | null;
  readonly history: readonly number[];
  readonly evidenceRef: string | null;
}

export interface FourNeonGaugesView {
  readonly schemaVersion: '1.0.0';
  readonly capturedAt: string;
  readonly configurationHash: string | null;
  readonly gauges: readonly [
    NeonGaugeProjection,
    NeonGaugeProjection,
    NeonGaugeProjection,
    NeonGaugeProjection,
  ];
  readonly warnings: readonly string[];
}

const familySchema = z.enum([
  'TARGET_QUALITY',
  'EVIDENCE_ASSURANCE',
  'ACCEPTANCE_GATES',
  'CLUE_SELF',
]);

const aggregationModeSchema = z.enum([
  'CURRENT_CERTIFIED',
  'SELECTED_CYCLE',
  'HISTORICAL_NET',
  'CONFIDENCE_ADJUSTED',
  'AVERAGE_PER_EXPERIMENT',
  'EXPERIMENT_COUNT',
  'COVERAGE',
  'EQUILIBRIUM',
]);

const selectionSchema = z.union([
  z.object({ kind: z.literal('metric'), id: z.string() }).strict(),
  z.object({ kind: z.literal('family_aggregate'), id: familySchema }).strict(),
  z.object({ kind: z.literal('gate_summary'), id: z.string() }).strict(),
  z.object({ kind: z.literal('target_indicator'), id: z.string(), mappedMetricId: z.string() }).strict(),
]);

const nativeValueSchema = z
  .object({
    value: z.union([z.number(), z.string()]).nullable(),
    unit: z.string().nullable(),
    display: z.string(),
  })
  .strict();

export const neonGaugeProjectionSchema = z
  .object({
    slot: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    definitionId: z.string(),
    selection: selectionSchema,
    metricId: z.string(),
    metricName: z.string(),
    scope: z.object({ kind: z.string(), id: z.string() }).strict(),
    aggregationMode: aggregationModeSchema,
    family: familySchema,
    familyColor: z.string(),
    projectionType: z.enum([
      'signed_score',
      'percentage',
      'count',
      'ratio',
      'ordinal',
      'gate_state',
      'distribution_summary',
    ]),
    nativeValue: nativeValueSchema,
    normalizedValue: z.number().min(-100).max(100).nullable(),
    dialPosition: z.number().min(0).max(1).nullable(),
    gateState: z.enum(['PASS', 'WARNING', 'FAIL', 'UNKNOWN']).nullable(),
    delta: z.number().nullable(),
    deltaUnit: z.string().nullable(),
    trend: z.enum(['improving', 'stable', 'worsening', 'unknown']),
    confidence: z.number().min(0).max(1).nullable(),
    coverage: z.number().min(0).max(1).nullable(),
    freshness: z.number().min(0).max(1).nullable(),
    availability: z.enum(['available', 'stale', 'unknown', 'not_applicable']),
    warning: z.string().nullable(),
    history: z.array(z.number()),
    evidenceRef: z.string().nullable(),
  })
  .strict();

export const fourNeonGaugesSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    capturedAt: z.string(),
    configurationHash: z.string().nullable(),
    gauges: z.tuple([
      neonGaugeProjectionSchema,
      neonGaugeProjectionSchema,
      neonGaugeProjectionSchema,
      neonGaugeProjectionSchema,
    ]),
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((value, context) => {
    const slots = new Set(value.gauges.map((gauge) => gauge.slot));
    if (slots.size !== 4) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Gauge slots must be unique.' });
    }
  });

export function parseFourNeonGauges(input: unknown): FourNeonGaugesView {
  return fourNeonGaugesSchema.parse(input) as FourNeonGaugesView;
}

const DEFAULTS: readonly [
  { id: 'MC04'; name: 'Coupling and dependency surface'; family: 'TARGET_QUALITY'; color: '#00a3e0' },
  { id: 'MI05'; name: 'Causal attribution'; family: 'EVIDENCE_ASSURANCE'; color: '#f4af2d' },
  { id: 'MJ06'; name: 'Global regression guardrail'; family: 'ACCEPTANCE_GATES'; color: '#ff5500' },
  { id: 'MK17'; name: 'Conversation-orchestration integrity'; family: 'CLUE_SELF'; color: '#39ff88' },
] = [
  { id: 'MC04', name: 'Coupling and dependency surface', family: 'TARGET_QUALITY', color: '#00a3e0' },
  { id: 'MI05', name: 'Causal attribution', family: 'EVIDENCE_ASSURANCE', color: '#f4af2d' },
  { id: 'MJ06', name: 'Global regression guardrail', family: 'ACCEPTANCE_GATES', color: '#ff5500' },
  { id: 'MK17', name: 'Conversation-orchestration integrity', family: 'CLUE_SELF', color: '#39ff88' },
];

export function emptyFourNeonGauges(capturedAt: string): FourNeonGaugesView {
  const gauges = DEFAULTS.map((definition, index): NeonGaugeProjection => ({
    slot: (index + 1) as 1 | 2 | 3 | 4,
    definitionId: `GAUGE-${index + 1}`,
    selection: { kind: 'metric', id: definition.id },
    metricId: definition.id,
    metricName: definition.name,
    scope: { kind: 'program', id: 'UNREGISTERED' },
    aggregationMode: 'CURRENT_CERTIFIED',
    family: definition.family,
    familyColor: definition.color,
    projectionType: definition.family === 'ACCEPTANCE_GATES' ? 'gate_state' : 'signed_score',
    nativeValue: { value: null, unit: null, display: 'UNKNOWN' },
    normalizedValue: null,
    dialPosition: null,
    gateState: definition.family === 'ACCEPTANCE_GATES' ? 'UNKNOWN' : null,
    delta: null,
    deltaUnit: null,
    trend: 'unknown',
    confidence: null,
    coverage: null,
    freshness: null,
    availability: 'unknown',
    warning: 'No certified metric evidence is connected.',
    history: [],
    evidenceRef: null,
  }));

  const [g1, g2, g3, g4] = gauges;
  if (g1 === undefined || g2 === undefined || g3 === undefined || g4 === undefined) {
    throw new Error('Default gauge definition count is not four.');
  }

  return {
    schemaVersion: '1.0.0',
    capturedAt,
    configurationHash: null,
    gauges: [g1, g2, g3, g4],
    warnings: ['Gauge values are unavailable until metric projections are connected.'],
  };
}
