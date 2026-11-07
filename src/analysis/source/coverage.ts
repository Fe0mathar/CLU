/**
 * Recognition coverage — distinct from file-scan progress.
 *
 * Spec: CLUE_Implementation_v3.md §24 (recognition is a projection of source truth, honest
 *       about what it could not resolve) and the CLUE status-precision principle
 *       (CLUE_v3.md: visible progress must represent proven state, not optimistic
 *       interpretation). A completed *file scan* is not completed *recognition*: every
 *       file can be read while dynamic edges, unsupported languages, ambiguous symbols and
 *       runtime behaviour remain unknown.
 *
 * This module derives a small set of named, separately reported measures from the values
 * the recognizer already produces ({@link RecognitionStats}, unresolved references) and,
 * optionally, the snapshot's language census. It performs no scanning and owns no state; it
 * is the one place that turns raw counts into an honest coverage report so the CLI and the
 * Navigator present the same numbers with the same meaning.
 *
 * The measures are deliberately orthogonal:
 *
 *   - **fileScan** — did we read every file we set out to read? This can legitimately reach
 *     100% while everything below remains incomplete. It is *scan* progress, never
 *     "recognition".
 *   - **staticRecognition** — of the full known source surface, how many files did the
 *     recognizer actually extract units from. The denominator includes files the pipeline
 *     cannot statically analyse (from the language census), because a file present but
 *     unrecognised — unsupported language, parse refusal — is named residual uncertainty,
 *     not a silent gap. This is what separates it from fileScan: a complete scan of the
 *     TypeScript program can sit inside a project whose .mjs, .yaml and script surface
 *     static recognition never touched.
 *   - **dependencyResolution** — of all references seen, how many resolved to a known unit.
 *     Unresolved references are the dynamic/ambiguous edges a static pass cannot follow.
 *   - **runtimeEnrichment** — observed runtime behaviour over the recognised unit-bearing
 *     surface. The static pass observes nothing, so this is 0/N until the experiment plane
 *     runs — and 0 of a real surface must read as 0%, never as “nothing to miss”. The
 *     denominator is the recognised unit count when known, falling back to recognised
 *     files when the caller (e.g. a durable record) carries no unit census.
 *
 * Each ratio is reported with the raw numerator and denominator beside it: a coverage
 * number nobody can decompose is a number nobody can challenge.
 */

import type { RecognitionStats, UnresolvedReference } from './recognizer.js';

/** One coverage dimension: a ratio in [0,1] with the counts that produced it. */
export interface CoverageMeasure {
  /** Covered count (numerator). */
  readonly covered: number;
  /** Total count (denominator). Zero denominators report a ratio of 1 (nothing to miss). */
  readonly total: number;
  /** covered / total, clamped to [0,1]; 1 when total is 0. */
  readonly ratio: number;
}

/** Residual uncertainty that a completed scan does not remove. */
export interface RecognitionResidual {
  /** Files in the program the recognizer did not extract units from. */
  readonly unrecognisedFiles: number;
  /** References that did not resolve to a known unit, by kind. */
  readonly unresolvedByKind: Readonly<Record<string, number>>;
  /** Total unresolved references. */
  readonly unresolvedTotal: number;
  /** Source files whose language the pipeline does not statically analyse. */
  readonly unsupportedLanguageFiles: number;
  /** Semantic diagnostics counted during recognition (counted, never fatal). */
  readonly semanticDiagnostics: number;
}

/**
 * A complete coverage report. `scanComplete` and `recognitionComplete` are separate booleans
 * on purpose: the first says the scan finished, the second says nothing was left unresolved.
 */
export interface CoverageReport {
  readonly fileScan: CoverageMeasure;
  readonly staticRecognition: CoverageMeasure;
  readonly dependencyResolution: CoverageMeasure;
  readonly runtimeEnrichment: CoverageMeasure;
  readonly residual: RecognitionResidual;
  /** Every file intended for the program was read. */
  readonly scanComplete: boolean;
  /**
   * Recognition left no residual uncertainty: every file recognised, every reference
   * resolved, no runtime enrichment outstanding. Almost always false for real projects,
   * and that is the honest answer.
   */
  readonly recognitionComplete: boolean;
}

/** Static language set the recognizer extracts units from. Others are residual, not gaps. */
const STATICALLY_ANALYSED_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'tsx',
  'javascript',
]);

function measure(covered: number, total: number): CoverageMeasure {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeCovered = Math.max(0, Math.min(safeTotal, Math.trunc(covered)));
  const ratio = safeTotal === 0 ? 1 : safeCovered / safeTotal;
  return { covered: safeCovered, total: safeTotal, ratio };
}

function sumValues(record: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(record)) total += Math.max(0, value);
  return total;
}

/** Total edges seen across all kinds, used as the dependency-resolution denominator base. */
function resolvedReferenceCount(stats: RecognitionStats): number {
  return sumValues(stats.edgesByKind);
}

export interface CoverageInput {
  readonly stats: RecognitionStats;
  readonly unresolved: readonly UnresolvedReference[];
  /**
   * Optional per-language file census from the snapshot manifest (`stats.by_language`).
   * When present, files in languages the pipeline does not statically analyse are reported
   * as residual uncertainty. Absent input reports zero unsupported-language files rather
   * than guessing.
   */
  readonly languageCensus?: Readonly<Record<string, number>>;
}

/**
 * Derives the coverage report from one recognition result. Pure: identical input yields
 * identical output, and it never reads the filesystem.
 */
export function computeCoverage(input: CoverageInput): CoverageReport {
  const { stats, unresolved, languageCensus } = input;

  let unsupportedLanguageFiles = 0;
  if (languageCensus !== undefined) {
    for (const [language, count] of Object.entries(languageCensus)) {
      if (!STATICALLY_ANALYSED_LANGUAGES.has(language)) {
        unsupportedLanguageFiles += Math.max(0, count);
      }
    }
  }

  const fileScan = measure(stats.filesRecognised, stats.filesInProgram);
  // Static recognition is scoped to the full known source surface, not just the program:
  // census files the pipeline cannot statically analyse are present-but-unrecognised, so
  // they must lower this ratio rather than vanish from it. Without a census the surface
  // degrades to the program itself — no unsupported files are invented.
  const staticRecognition = measure(
    stats.filesRecognised,
    stats.filesInProgram + unsupportedLanguageFiles,
  );

  const resolved = resolvedReferenceCount(stats);
  const unresolvedTotal = unresolved.length;
  const referenceTotal = resolved + unresolvedTotal;
  const dependencyResolution = measure(resolved, referenceTotal);

  // Runtime enrichment is not produced by the static pass: covered is 0 by construction.
  // The denominator is the real unit-bearing surface — recognised units when the caller
  // knows them, recognised files otherwise (durable records carry no unit census) — so
  // zero evidence over a real surface reads as 0%, never as a fabricated 0/0 = 100%.
  const unitTotal = sumValues(stats.unitsByKind);
  const enrichmentSurface = unitTotal > 0 ? unitTotal : stats.filesRecognised;
  const runtimeEnrichment = measure(0, enrichmentSurface);

  const unresolvedByKind: Record<string, number> = {};
  for (const reference of unresolved) {
    unresolvedByKind[reference.kind] = (unresolvedByKind[reference.kind] ?? 0) + 1;
  }

  const residual: RecognitionResidual = {
    unrecognisedFiles: Math.max(0, stats.filesInProgram - stats.filesRecognised),
    unresolvedByKind,
    unresolvedTotal,
    unsupportedLanguageFiles,
    semanticDiagnostics: Math.max(0, stats.semanticDiagnostics),
  };

  const scanComplete = fileScan.ratio >= 1;
  // “No runtime enrichment outstanding” is part of this flag's documented meaning; a
  // static-only pass over a real surface therefore reports false, and that is the honest
  // answer until the experiment plane has observed the recognised units.
  const recognitionComplete =
    staticRecognition.ratio >= 1 &&
    dependencyResolution.ratio >= 1 &&
    runtimeEnrichment.ratio >= 1 &&
    residual.unrecognisedFiles === 0 &&
    residual.unresolvedTotal === 0;

  return {
    fileScan,
    staticRecognition,
    dependencyResolution,
    runtimeEnrichment,
    residual,
    scanComplete,
    recognitionComplete,
  };
}

/** Formats a measure as `covered/total (NN.N%)` for terminal reporting. */
export function formatMeasure(m: CoverageMeasure): string {
  return `${m.covered}/${m.total} (${(m.ratio * 100).toFixed(1)}%)`;
}
