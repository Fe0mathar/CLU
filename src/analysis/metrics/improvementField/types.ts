import type {
  GreatBookAggregationMode,
  GreatBookImprovementFieldView,
  NativeMetricEvidence,
} from '../../../ui/greatBookImprovementField.js';
import type { CanonicalMetricFamily } from '../../../shared/measurementCoordinates.js';

export interface GreatBookContributionInput {
  readonly contributionId: string;
  readonly greatBookEntryId: string;
  readonly measurementId: string;
  readonly scopeId: string;
  readonly cycleId: string | null;
  readonly family: Exclude<CanonicalMetricFamily, 'RESERVED'>;
  readonly native: NativeMetricEvidence;
  readonly normalizedContribution: number;
  readonly confidence: number;
  readonly freshness: number;
  readonly coverage: number;
  readonly certified: boolean;
  readonly invalidated: boolean;
  readonly verdict: string;
  readonly proofContractId: string | null;
  readonly benchmarkRunId: string | null;
  readonly recordedAt: string;
}

export interface ImprovementFieldBuildInput {
  readonly capturedAt: string;
  readonly targetId: string;
  readonly cycleId: string | null;
  readonly catalogueVersion: string;
  readonly catalogueHash: string;
  readonly normalizationVersion: string;
  readonly normalizationHash: string;
  readonly aggregationMode: GreatBookAggregationMode;
  readonly selectedMeasurementId: string | null;
  readonly contributions: readonly GreatBookContributionInput[];
}

export type { GreatBookImprovementFieldView };
