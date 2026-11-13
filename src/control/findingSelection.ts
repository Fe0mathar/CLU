/** Select one proof candidate from the ranked evidence of a screened snapshot. */
import type { EvidenceClass, MetricFamilyName, ProofReadiness } from '../analysis/metrics/families.js';
import type { RankedCandidate, RankingResult } from '../analysis/metrics/ranking.js';
import type { ProtectedMatcher } from '../analysis/source/graph.js';
import type { SourceUnit } from '../analysis/source/recognizer.js';
import { makeEntityId, type Sha256 } from '../shared/ids.js';

const MAX_RECORDED_FINDINGS = 25;

/** Coverage explicitly bound to the exact source unit by the verified benchmark. */
export interface FindingSignalBinding {
  readonly signalId: string;
  readonly signalName: string;
  readonly evidenceReason: string;
  readonly objectiveIds?: readonly string[];
}

export interface RankedFinding {
  readonly findingId: string;
  readonly unitId: string;
  readonly unitVersion: Sha256;
  readonly path: string;
  readonly line: number;
  readonly endLine: number;
  readonly kind: 'patch' | 'instrumentation' | 'clarification';
  readonly priority: number;
  readonly confidence: number;
  readonly evidence: EvidenceClass;
  readonly metricFamily: MetricFamilyName | null;
  readonly proofReadiness: ProofReadiness;
  readonly reason: string;
}

export interface SelectedFinding {
  readonly findingId: string;
  readonly unitId: string;
  readonly path: string;
  readonly line: number;
  readonly signalId: string;
  readonly signalName: string;
  readonly objectiveIds: readonly string[];
  readonly reason: string;
}

interface FindingSelectionSummary {
  readonly reason: string;
  readonly findingCount: number;
  readonly findings: readonly RankedFinding[];
}

export type FindingSelection = FindingSelectionSummary & (
  | { readonly outcome: 'SELECTED'; readonly selected: SelectedFinding }
  | { readonly outcome: 'NO_CANDIDATE'; readonly selected: null }
);

export interface FindingSelectionInput {
  readonly ranking: RankingResult;
  readonly units: readonly SourceUnit[];
  readonly isProtected: ProtectedMatcher;
  readonly signalBindings: ReadonlyMap<string, FindingSignalBinding>;
  readonly firstFindingSequence: number;
}

function eligibleScope(row: RankedCandidate, unit: SourceUnit, isProtected: ProtectedMatcher): boolean {
  return row.kind === 'patch' && row.lane === 'safe-improvement' && row.proofReadiness === 'measurable' &&
    row.exclusionReason === null && row.blastRadius === 'local' &&
    (row.quadrant === 'monofile-monodependency' || row.quadrant === 'monofile-polydependency') &&
    isProtected(unit) === null;
}

function compareId(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function groundedRow(row: RankedCandidate, unit: SourceUnit | undefined): unit is SourceUnit {
  return unit !== undefined && unit.kind !== 'module' &&
    row.modulePath === unit.modulePath && unit.anchor.path === unit.modulePath &&
    !/[\\:\x00-\x1f\x7f]/u.test(unit.modulePath) &&
    unit.modulePath.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
    Number.isSafeInteger(unit.anchor.startLine) && unit.anchor.startLine >= 1 &&
    Number.isSafeInteger(unit.anchor.endLine) && unit.anchor.endLine >= unit.anchor.startLine &&
    Number.isFinite(row.priority) && row.priority > 0 && row.priority <= 1 &&
    Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1;
}

function verifiedSignal(binding: FindingSignalBinding | undefined): binding is FindingSignalBinding {
  return binding !== undefined && binding.signalId.trim() !== '' && binding.signalName.trim() !== '' &&
    binding.evidenceReason.trim() !== '';
}

export function selectFindingCandidate(input: FindingSelectionInput): FindingSelection {
  const { ranking, units, isProtected, signalBindings, firstFindingSequence } = input;
  const unitsById = new Map(units.map((unit) => [unit.logicalId, unit]));
  const ranked = [...ranking.patchCandidates, ...ranking.instrumentationCandidates, ...ranking.clarificationCandidates]
    .sort((a, b) => b.priority - a.priority || compareId(a.logicalId, b.logicalId));
  const seen = new Set<string>();
  const findings: RankedFinding[] = [];
  let findingCount = 0;
  let eligibleScopeCount = 0;
  let selected: SelectedFinding | null = null;

  for (const row of ranked) {
    const unit = unitsById.get(row.logicalId);
    if (row.kind === 'excluded' || !groundedRow(row, unit) || seen.has(row.logicalId)) continue;
    seen.add(row.logicalId);
    findingCount += 1;
    const eligible = eligibleScope(row, unit, isProtected);
    if (eligible) eligibleScopeCount += 1;
    const signal = eligible ? signalBindings.get(row.logicalId) : undefined;
    const select = selected === null && verifiedSignal(signal);
    if (findings.length === MAX_RECORDED_FINDINGS && !select) continue;
    if (findings.length === MAX_RECORDED_FINDINGS) findings.pop();
    const findingId = makeEntityId('finding', firstFindingSequence + findings.length);
    const reason = row.kind !== 'patch' || (eligible && verifiedSignal(signal)) ? row.proposedAction
      : eligible ? 'The unit needs a verified benchmark signal before candidate selection.'
        : 'This ranked patch falls outside the eligible single-file scope.';
    findings.push({
      findingId, unitId: row.logicalId, unitVersion: unit.versionHash, path: unit.modulePath,
      line: unit.anchor.startLine, endLine: unit.anchor.endLine, kind: row.kind,
      priority: row.priority, confidence: row.confidence, evidence: row.evidence,
      metricFamily: row.dominantFamily, proofReadiness: row.proofReadiness, reason,
    });
    if (select) {
      selected = {
        findingId, unitId: row.logicalId, path: unit.modulePath, line: unit.anchor.startLine,
        signalId: signal.signalId, signalName: signal.signalName,
        objectiveIds: [...new Set(signal.objectiveIds ?? [])].sort(compareId),
        reason: `Highest-ranked eligible finding with an exact benchmark signal. ${signal.evidenceReason}`,
      };
    }
  }

  if (selected !== null) return { outcome: 'SELECTED', reason: selected.reason, findingCount, selected, findings };
  const reason = findingCount === 0 ? 'Screening produced no anchored findings.' : eligibleScopeCount === 0
    ? 'Screening produced no measurable, unprotected patch candidate within a single source file.'
    : 'No eligible finding has a verified benchmark signal bound to its exact source unit.';
  return { outcome: 'NO_CANDIDATE', reason, findingCount, selected: null, findings };
}
