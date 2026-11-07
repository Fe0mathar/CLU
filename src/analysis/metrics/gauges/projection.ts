import {
  parseFourNeonGauges,
  type FourNeonGaugesView,
  type GaugeGateState,
  type GaugeMetricFamily,
  type GaugeProjectionType,
  type GaugeSelection,
  type GaugeTrend,
  type NeonGaugeProjection,
} from '../../../ui/fourNeonGauges.js';

export interface GaugeDefinition {
  readonly slot: 1 | 2 | 3 | 4;
  readonly definitionId: string;
  readonly selection: GaugeSelection;
  readonly metricId: string;
  readonly metricName: string;
  readonly family: GaugeMetricFamily;
  readonly familyColor: string;
  readonly projectionType: GaugeProjectionType;
  readonly scope: { readonly kind: string; readonly id: string };
  readonly aggregationMode: NeonGaugeProjection['aggregationMode'];
}

export interface GaugeReading {
  readonly metricId: string;
  readonly nativeValue: { readonly value: number | string | null; readonly unit: string | null; readonly display: string };
  readonly normalizedValue: number | null;
  readonly gateState: GaugeGateState | null;
  readonly delta: number | null;
  readonly deltaUnit: string | null;
  readonly trend: GaugeTrend;
  readonly confidence: number | null;
  readonly coverage: number | null;
  readonly freshness: number | null;
  readonly warning: string | null;
  readonly history: readonly number[];
  readonly evidenceRef: string | null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function gateDial(state: GaugeGateState | null): number | null {
  switch (state) {
    case 'PASS':
      return 1;
    case 'WARNING':
      return 0.62;
    case 'FAIL':
      return 0.08;
    case 'UNKNOWN':
      return null;
    default:
      return null;
  }
}

function dialPosition(definition: GaugeDefinition, reading: GaugeReading): number | null {
  if (definition.projectionType === 'gate_state') return gateDial(reading.gateState);
  if (reading.normalizedValue === null) return null;
  if (definition.projectionType === 'percentage') return clamp01(reading.normalizedValue / 100);
  if (definition.projectionType === 'signed_score') return clamp01((reading.normalizedValue + 100) / 200);
  return clamp01(reading.normalizedValue / 100);
}

export function buildFourNeonGauges(input: {
  readonly capturedAt: string;
  readonly configurationHash: string;
  readonly definitions: readonly GaugeDefinition[];
  readonly readings: readonly GaugeReading[];
}): FourNeonGaugesView {
  if (input.definitions.length !== 4) {
    throw new Error(`Exactly four gauge definitions are required; received ${input.definitions.length}.`);
  }

  const byMetric = new Map(input.readings.map((reading) => [reading.metricId, reading]));
  const projected = input.definitions.map((definition): NeonGaugeProjection => {
    const reading = byMetric.get(definition.metricId);
    if (reading === undefined) {
      return {
        ...definition,
        nativeValue: { value: null, unit: null, display: 'UNKNOWN' },
        normalizedValue: null,
        dialPosition: null,
        gateState: definition.projectionType === 'gate_state' ? 'UNKNOWN' : null,
        delta: null,
        deltaUnit: null,
        trend: 'unknown',
        confidence: null,
        coverage: null,
        freshness: null,
        availability: 'unknown',
        warning: 'No metric reading is available.',
        history: [],
        evidenceRef: null,
      };
    }

    const stale = reading.freshness !== null && reading.freshness < 0.5;
    return {
      ...definition,
      nativeValue: reading.nativeValue,
      normalizedValue: reading.normalizedValue,
      dialPosition: dialPosition(definition, reading),
      gateState: reading.gateState,
      delta: reading.delta,
      deltaUnit: reading.deltaUnit,
      trend: reading.trend,
      confidence: reading.confidence,
      coverage: reading.coverage,
      freshness: reading.freshness,
      availability: stale ? 'stale' : 'available',
      warning: stale ? 'Evidence is stale.' : reading.warning,
      history: reading.history,
      evidenceRef: reading.evidenceRef,
    };
  });

  const [g1, g2, g3, g4] = projected;
  if (g1 === undefined || g2 === undefined || g3 === undefined || g4 === undefined) {
    throw new Error('Gauge projection did not produce exactly four slots.');
  }

  return parseFourNeonGauges({
    schemaVersion: '1.0.0',
    capturedAt: input.capturedAt,
    configurationHash: input.configurationHash,
    gauges: [g1, g2, g3, g4],
    warnings: projected.flatMap((gauge) => gauge.warning === null ? [] : [`${gauge.metricId}: ${gauge.warning}`]),
  });
}
