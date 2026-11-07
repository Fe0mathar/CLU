import type { GreatBookAggregationMode } from '../../../ui/greatBookImprovementField.js';
import type { GreatBookContributionInput } from './types.js';

export const FAMILY_COLORS = {
  TARGET_QUALITY: '#00a3e0',
  EVIDENCE_ASSURANCE: '#f4af2d',
  ACCEPTANCE_GATES: '#ff5500',
  CLUE_SELF: '#39ff88',
  RESERVED: '#07111c',
} as const;

function boundedSignedSum(values: readonly number[], scale = 100): number {
  if (values.length === 0) return 0;
  const raw = values.reduce((sum, value) => sum + value, 0);
  return Math.tanh(raw / scale) * 100;
}

export function selectContributions(
  contributions: readonly GreatBookContributionInput[],
  mode: GreatBookAggregationMode,
  selectedCycleId: string | null,
): readonly GreatBookContributionInput[] {
  switch (mode) {
    case 'CURRENT_CERTIFIED':
      return contributions.filter((entry) => entry.certified && !entry.invalidated);
    case 'SELECTED_CYCLE':
      return selectedCycleId === null
        ? []
        : contributions.filter((entry) => entry.cycleId === selectedCycleId);
    case 'CONFIDENCE_ADJUSTED':
    case 'HISTORICAL_NET':
    case 'AVERAGE_PER_EXPERIMENT':
    case 'EXPERIMENT_COUNT':
    case 'COVERAGE':
    case 'EQUILIBRIUM':
      return contributions.filter((entry) => !entry.invalidated);
    default:
      return [];
  }
}

export function aggregateCellValue(
  contributions: readonly GreatBookContributionInput[],
  mode: GreatBookAggregationMode,
): number | null {
  if (contributions.length === 0) return null;

  if (mode === 'EXPERIMENT_COUNT') {
    return Math.min(100, contributions.length);
  }
  if (mode === 'COVERAGE') {
    return contributions.reduce((sum, entry) => sum + entry.coverage, 0) / contributions.length * 100;
  }
  if (mode === 'AVERAGE_PER_EXPERIMENT') {
    return contributions.reduce((sum, entry) => sum + entry.normalizedContribution, 0) / contributions.length;
  }
  if (mode === 'CONFIDENCE_ADJUSTED') {
    return boundedSignedSum(
      contributions.map((entry) => entry.normalizedContribution * entry.confidence * entry.freshness),
    );
  }
  return boundedSignedSum(contributions.map((entry) => entry.normalizedContribution));
}
