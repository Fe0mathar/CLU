import {
  emptyGreatBookImprovementField,
  type GreatBookFamilySummary,
  type GreatBookFieldCell,
  type GreatBookFieldSegment,
  type GreatBookImprovementFieldView,
} from '../../../ui/greatBookImprovementField.js';
import {
  METRIC_COORDINATES,
  type CanonicalMetricFamily,
} from '../../../shared/measurementCoordinates.js';
import { aggregateCellValue, FAMILY_COLORS, selectContributions } from './aggregation.js';
import type { GreatBookContributionInput, ImprovementFieldBuildInput } from './types.js';

const ACTIVE_FAMILIES: readonly Exclude<CanonicalMetricFamily, 'RESERVED'>[] = [
  'TARGET_QUALITY',
  'EVIDENCE_ASSURANCE',
  'ACCEPTANCE_GATES',
  'CLUE_SELF',
];

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function segmentOf(entry: GreatBookContributionInput): GreatBookFieldSegment {
  return {
    contributionId: entry.contributionId,
    greatBookEntryId: entry.greatBookEntryId,
    measurementId: entry.measurementId,
    scopeId: entry.scopeId,
    cycleId: entry.cycleId,
    normalizedContribution: entry.normalizedContribution,
    native: entry.native,
    confidence: entry.confidence,
    freshness: entry.freshness,
    certified: entry.certified,
    invalidated: entry.invalidated,
    verdict: entry.verdict,
    proofContractId: entry.proofContractId,
    benchmarkRunId: entry.benchmarkRunId,
    recordedAt: entry.recordedAt,
  };
}

export function buildGreatBookImprovementField(
  input: ImprovementFieldBuildInput,
): GreatBookImprovementFieldView {
  if (input.contributions.length === 0) {
    const empty = emptyGreatBookImprovementField(input.capturedAt);
    return {
      ...empty,
      targetId: input.targetId,
      cycleId: input.cycleId,
      catalogueVersion: input.catalogueVersion,
      catalogueHash: input.catalogueHash,
      normalizationVersion: input.normalizationVersion,
      normalizationHash: input.normalizationHash,
      aggregationMode: input.aggregationMode,
      selectedMeasurementId: input.selectedMeasurementId,
      warnings: ['Great Book is connected; no accepted proof verdict has been recorded yet.'],
    };
  }

  const selected = selectContributions(input.contributions, input.aggregationMode, input.cycleId);
  const grouped = new Map<string, GreatBookContributionInput[]>();
  for (const contribution of selected) {
    const list = grouped.get(contribution.measurementId) ?? [];
    list.push(contribution);
    grouped.set(contribution.measurementId, list);
  }

  const cells: GreatBookFieldCell[] = METRIC_COORDINATES.map((coordinate) => {
    if (coordinate.family === 'RESERVED') {
      return {
        gridIndex: coordinate.gridIndex,
        x: coordinate.x,
        y: coordinate.y,
        measurementId: coordinate.measurementId,
        legacyId: coordinate.legacyId,
        name: coordinate.name,
        family: coordinate.family,
        familyColor: FAMILY_COLORS.RESERVED,
        state: 'reserved',
        positiveHeight: null,
        negativeDepth: null,
        netContribution: null,
        confidence: null,
        coverage: null,
        freshness: null,
        contributionCount: 0,
        segments: [],
      };
    }

    const entries = grouped.get(coordinate.measurementId) ?? [];
    const value = aggregateCellValue(entries, input.aggregationMode);
    return {
      gridIndex: coordinate.gridIndex,
      x: coordinate.x,
      y: coordinate.y,
      measurementId: coordinate.measurementId,
      legacyId: coordinate.legacyId,
      name: coordinate.name,
      family: coordinate.family,
      familyColor: FAMILY_COLORS[coordinate.family],
      state: value === null ? 'unknown' : 'available',
      positiveHeight: value === null ? null : Math.max(0, value),
      negativeDepth: value === null ? null : Math.min(0, value),
      netContribution: value,
      confidence: average(entries.map((entry) => entry.confidence)),
      coverage: average(entries.map((entry) => entry.coverage)),
      freshness: average(entries.map((entry) => entry.freshness)),
      contributionCount: entries.length,
      segments: entries.map(segmentOf),
    };
  });

  const families: GreatBookFamilySummary[] = ACTIVE_FAMILIES.map((family) => {
    const familyCells = cells.filter((cell) => cell.family === family && cell.netContribution !== null);
    const values = familyCells.flatMap((cell) => cell.netContribution === null ? [] : [cell.netContribution]);
    const familyEntries = selected.filter((entry) => entry.family === family);
    return {
      family,
      familyColor: FAMILY_COLORS[family],
      positiveContribution: values.length === 0 ? null : values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
      negativeContribution: values.length === 0 ? null : values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
      netContribution: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0),
      certifiedEvidencePercent: familyEntries.length === 0
        ? null
        : familyEntries.filter((entry) => entry.certified && !entry.invalidated).length / familyEntries.length * 100,
      activeMetricCount: familyCells.length,
    };
  });

  return {
    schemaVersion: '1.0.0',
    capturedAt: input.capturedAt,
    targetId: input.targetId,
    cycleId: input.cycleId,
    catalogueVersion: input.catalogueVersion,
    catalogueHash: input.catalogueHash,
    normalizationVersion: input.normalizationVersion,
    normalizationHash: input.normalizationHash,
    aggregationMode: input.aggregationMode,
    selectedMeasurementId: input.selectedMeasurementId,
    grid: {
      rows: 10,
      columns: 10,
      activeCells: cells.filter((cell) => cell.state === 'available').length,
      // DEV-P1-20: derived, never a literal. A hardcoded 4 kept reporting v3's reservation after
      // catalogue v6 activated cells 97-100, so the summary contradicted the grid it summarised.
      reservedCells: cells.filter((cell) => cell.state === 'reserved').length,
    },
    families,
    cells,
    warnings: [],
  };
}
