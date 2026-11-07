/**
 * CLUE `recognize` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command domain,
 *       named `<domain>Commands.ts`; §11.3 — `recognizer.ts` coordinates adapters over an exact immutable basis,
 *       `scanCache.ts` decides safe incremental reuse, `graph.ts` owns the durable
 *       projections, and `navigatorEvents.ts` owns the Q1 stream. This module orchestrates
 *       those four and prints; it implements none of them.
 *       `CLUE_Q1_System_Navigator_v9.md` §14.5 — the stream binds snapshot, run and result
 *       identity, and only `graph.committed` lets Q1 claim committed knowledge.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. This was the largest single block
 *          left at 500 lines, and the most entangled: a recognition run drives the snapshot
 *          registry, the recognizer, the scan cache's incremental merge, the graph registry,
 *          the Navigator stream writer, and the Operational Console recorder, in an order
 *          where several of the couplings are load-bearing rather than incidental.
 *
 * Two of those orderings are worth knowing before editing anything here.
 *
 *   **Results are persisted before telemetry follows.** `awaitCommit` keeps the Navigator
 *   stream open past `scan.completed` so the durable-commit pair can be appended after the
 *   graph is actually written. A stream that sealed on completion would let Q1 claim
 *   committed knowledge for a graph that had not been committed.
 *
 *   **The seal verifies before the pointer is written.** `sealRunStream` refuses a stream
 *   whose bytes do not hash to what the writer accumulated, and only a sealed stream is
 *   named by `current.json` — so the pointer never references a file a failed seal did not
 *   create. A seal failure does not fail the recognition: the graph is already durable, and
 *   the failure is reported rather than silently swallowed.
 *
 * Behaviour is moved, not changed — twice now. DEV-P1-07 moved this block out of
 * `index.ts`; DEV-P2-08 S4a (2026-08-10) moved the run itself into
 * `src/control/recognitionRun.ts`, the one seam the CLI and the cycle orchestrator share,
 * so neither can fork the proven path. What remains here is exactly ADR-0003's ideal:
 * argument handling, one service call, printing. The two path helpers stay because they
 * are CLI flag conventions; the retention policy and lockfile-hash helper travelled with
 * the run they serve.
 */

import { isAbsolute, join, resolve } from 'node:path';

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import { runRecognition } from '../../control/recognitionRun.js';
import { runStreamPath } from '../../analysis/source/navigatorEvents.js';
import { computeCoverage, formatMeasure } from '../../analysis/source/coverage.js';
import { printChecks, short, write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue recognize                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Resolves where the System Navigator NDJSON stream is written, or null when it is off.
 *
 * The stream is enabled when `--navigator` is passed or an explicit `--navigator-events`
 * path is given. An explicit path is used as-is when absolute and resolved from the CLUE
 * repository root when relative (CLUE_Implementation_v3.md §24.4); with no explicit path
 * the default workspace location is used. Kept pure and exported so the branching can be
 * proven without running a full scan.
 */
export function resolveNavigatorPath(
  enabled: boolean,
  requested: string | undefined,
  repoRoot: string,
  workspaceRoot: string,
): string | null {
  const trimmed = requested?.trim();
  if (!enabled && (trimmed === undefined || trimmed.length === 0)) {
    return null;
  }
  if (trimmed !== undefined && trimmed.length > 0) {
    return isAbsolute(trimmed) ? trimmed : resolve(repoRoot, trimmed);
  }
  return join(workspaceRoot, 'graph', 'system-navigator.ndjson');
}

/**
 * Per-run immutable event stream for one recognition run: `graph/streams/<runId>.ndjson`.
 * The live pointer path (`system-navigator.ndjson`) is what the dashboard tails; the
 * per-run file is the durable, never-reused record.
 *
 * DEV-P1-06: the path rule, the sealing, the pointer and retention now live with the
 * stream's owner (`navigatorEvents.ts`, Project Directory §11.3). This wrapper only adds
 * the CLI's null-when-disabled convention.
 */
export function resolveRunStreamPath(livePath: string | null, runId: string): string | null {
  if (livePath === null) return null;
  return runStreamPath(livePath, runId);
}

function commandRecognize(
  force: boolean,
  navigatorEnabled = false,
  navigatorEvents?: string,
): number {
  return withRuntime({ withLog: true, requireMission: true }, (runtime) => {
    const outcome = runRecognition(runtime, {
      force,
      navigatorPath: resolveNavigatorPath(
        navigatorEnabled,
        navigatorEvents,
        runtime.repoRoot,
        runtime.workspaceRoot,
      ),
    });
    for (const notice of outcome.notices) write(notice);
    printChecks([
      { level: 'ok', label: 'snapshot', detail: short(outcome.snapshotId) },
      ...outcome.navigatorChecks,
      {
        level: 'info',
        label: 'scan',
        detail: outcome.plan.fullRescan
          ? `full (${outcome.plan.fullRescanReason})`
          : `incremental — ${outcome.plan.extractedCount} re-extracted, ${outcome.plan.carriedCount} reused`,
      },
      { level: 'ok', label: 'units', detail: String(outcome.recorded.record.unit_count) },
      { level: 'ok', label: 'edges', detail: String(outcome.recorded.record.edge_count) },
      {
        level: outcome.recorded.record.unresolved_count === 0 ? 'ok' : 'warn',
        label: 'unresolved',
        detail: `${outcome.recorded.record.unresolved_count} reference(s) the graph could not follow`,
      },
      {
        level: outcome.recorded.record.semantic_diagnostics === 0 ? 'ok' : 'info',
        label: 'diagnostics',
        detail:
          `${outcome.recorded.record.syntactic_diagnostics} syntactic, ` +
          `${outcome.recorded.record.semantic_diagnostics} semantic (counted, not fatal)`,
      },
      { level: 'info', label: 'elapsed', detail: `${outcome.recorded.record.elapsed_ms} ms` },
    ]);

    // Scan progress is not recognition coverage (critique P0): a finished file scan can
    // sit atop unresolved edges, unrecognised files and unsupported languages. Report the
    // separated measures with named residual uncertainty, derived from the recognizer's
    // own counts and the snapshot's language census.
    const coverage = computeCoverage({
      stats: outcome.result.stats,
      unresolved: outcome.result.unresolved,
      languageCensus: outcome.languageCensus,
    });
    write('');
    write('recognition coverage:');
    write(`  file scan               ${formatMeasure(coverage.fileScan)}${coverage.scanComplete ? '  SCANNED' : ''}`);
    write(`  static recognition      ${formatMeasure(coverage.staticRecognition)}`);
    write(`  dependency resolution   ${formatMeasure(coverage.dependencyResolution)}`);
    write(`  runtime enrichment      ${formatMeasure(coverage.runtimeEnrichment)}  (static pass — awaits experiment plane)`);
    write(
      `  recognition complete    ${coverage.recognitionComplete ? 'yes' : 'no'}` +
        (coverage.recognitionComplete ? '' : ' — residual uncertainty remains'),
    );
    if (!coverage.recognitionComplete) {
      const r = coverage.residual;
      if (r.unrecognisedFiles > 0) {
        write(`    unrecognised files      ${r.unrecognisedFiles} (in program, no units extracted)`);
      }
      if (r.unresolvedTotal > 0) {
        const byKind = Object.entries(r.unresolvedByKind)
          .sort()
          .map(([kind, count]) => `${kind} ${count}`)
          .join(', ');
        write(`    unresolved references   ${r.unresolvedTotal} (${byKind})`);
      }
      if (r.unsupportedLanguageFiles > 0) {
        write(`    unsupported languages   ${r.unsupportedLanguageFiles} file(s) outside static analysis`);
      }
    }

    write('');
    write('coverage by subsystem:');
    for (const entry of outcome.recorded.coverage) {
      write(
        `  ${entry.subsystem.padEnd(28)} ${String(entry.units).padStart(5)} units  ` +
          `${(entry.coverage * 100).toFixed(1)}%  ${entry.unresolved} gap(s)`,
      );
    }

    const quadrants = new Map<string, number>();
    for (const entry of outcome.recorded.classifications) {
      quadrants.set(entry.quadrant, (quadrants.get(entry.quadrant) ?? 0) + 1);
    }
    write('');
    write('shape:');
    for (const [quadrant, count] of [...quadrants].sort()) {
      write(`  ${quadrant.padEnd(28)} ${count}`);
    }

    if (outcome.navigatorPath !== null) {
      write('');
      write(`System Navigator stream: ${outcome.navigatorPath}`);
      write('View it with: npm run navigator');
    }

    write('');
    write('Next: clue metrics');
    return 0;
  });
}

/** Registers the `recognize` command. */
export function registerRecognizeCommand(program: Command): void {
  program
    .command('recognize')
    .description("build the unit graph from the project's own tsconfig")
    .option('--full', 'force a full rescan instead of using the scan cache', false)
    .option('--navigator', 'write a live, replayable System Navigator event stream', false)
    .option(
      '--navigator-events <path>',
      'override the Navigator NDJSON path; relative paths resolve from the CLUE repository',
    )
    .action((options: { full: boolean; navigator: boolean; navigatorEvents?: string }) => {
      process.exitCode = runGuarded(() =>
        commandRecognize(
          options.full,
          options.navigator || options.navigatorEvents !== undefined,
          options.navigatorEvents,
        ),
      );
    });
}
