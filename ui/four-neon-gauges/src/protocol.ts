export type GaugeFamily = 'TARGET_QUALITY' | 'EVIDENCE_ASSURANCE' | 'ACCEPTANCE_GATES' | 'CLUE_SELF';
export type GaugeGateState = 'PASS' | 'WARNING' | 'FAIL' | 'UNKNOWN';
export type GaugeAvailability = 'available' | 'stale' | 'unknown' | 'not_applicable';
export type GaugeTrend = 'improving' | 'stable' | 'worsening' | 'unknown';

export interface GaugeProjection {
  readonly slot: 1 | 2 | 3 | 4;
  readonly definitionId: string;
  readonly metricId: string;
  readonly metricName: string;
  readonly family: GaugeFamily;
  readonly familyColor: string;
  readonly projectionType: string;
  readonly nativeValue: { readonly value: number | string | null; readonly unit: string | null; readonly display: string };
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
  readonly scope: { readonly kind: string; readonly id: string };
  readonly aggregationMode: string;
}

export interface FourNeonGaugesProjection {
  readonly schemaVersion: '1.0.0';
  readonly capturedAt: string;
  readonly configurationHash: string | null;
  readonly gauges: readonly [GaugeProjection, GaugeProjection, GaugeProjection, GaugeProjection];
  readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseGauge(value: unknown, expectedSlot: number): GaugeProjection {
  if (!isRecord(value)) throw new Error(`Gauge ${expectedSlot} is not an object.`);
  if (value['slot'] !== expectedSlot) throw new Error(`Gauge slot ${expectedSlot} is missing or out of order.`);
  if (typeof value['metricId'] !== 'string' || typeof value['metricName'] !== 'string') {
    throw new Error(`Gauge ${expectedSlot} lacks metric identity.`);
  }
  if (typeof value['familyColor'] !== 'string' || typeof value['family'] !== 'string') {
    throw new Error(`Gauge ${expectedSlot} lacks family metadata.`);
  }
  const dial = value['dialPosition'];
  if (dial !== null && (typeof dial !== 'number' || dial < 0 || dial > 1)) {
    throw new Error(`Gauge ${expectedSlot} has an invalid dial position.`);
  }
  return value as unknown as GaugeProjection;
}

export function parseFourNeonGaugesProjection(input: unknown): FourNeonGaugesProjection {
  if (!isRecord(input)) throw new Error('Gauge projection is not an object.');
  if (input['schemaVersion'] !== '1.0.0') throw new Error('Unsupported gauge schema version.');
  const gauges = input['gauges'];
  if (!Array.isArray(gauges) || gauges.length !== 4) {
    throw new Error('Exactly four gauge projections are required.');
  }
  const parsed = [
    parseGauge(gauges[0], 1),
    parseGauge(gauges[1], 2),
    parseGauge(gauges[2], 3),
    parseGauge(gauges[3], 4),
  ] as const;
  const capturedAt = input['capturedAt'];
  const configurationHash = input['configurationHash'];
  const warnings = input['warnings'];
  if (typeof capturedAt !== 'string') throw new Error('Gauge projection lacks capturedAt.');
  if (configurationHash !== null && typeof configurationHash !== 'string') {
    throw new Error('Gauge projection has invalid configurationHash.');
  }
  if (!Array.isArray(warnings) || warnings.some((item) => typeof item !== 'string')) {
    throw new Error('Gauge projection warnings are invalid.');
  }
  return {
    schemaVersion: '1.0.0',
    capturedAt,
    configurationHash,
    gauges: parsed,
    warnings: warnings as string[],
  };
}
