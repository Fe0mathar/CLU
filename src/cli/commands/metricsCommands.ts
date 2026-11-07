/**
 * CLUE `metrics` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is argument handling, one service call,
 *       and printing.
 *       `CLUE_Canonical_Measurement_Catalogue_v9.md` — metric identities, coordinates and
 *       applicability. This module computes nothing itself: `analysis/metrics/families.ts`
 *       measures, `analysis/metrics/ranking.ts` ranks, and the registry stores both.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. The header this replaces was
 *          templated and, unlike its siblings, understated the command: it read as a query
 *          when this is the heaviest writer in the read-only-looking part of the CLI.
 *
 * Computes the metric families over a committed graph and records them.
 *
 * Metrics calculate and record facts. They do not form an RPI verdict — that belongs to the
 * evaluation state machine, which this build does not have. A number here is an observation,
 * not a judgement, and nothing downstream should treat it as one.
 *
 * ## It is the only command in this group behind the full mission gate
 *
 * `withRuntime({ withLog: true, requireMission: true })`. The second flag is not decoration:
 * it makes `withRuntime` call `requireMission()` **and** `requireFreshProjections()` before the
 * body runs, so a metric set cannot be recorded against a stale projection or while no
 * committed mission is in force. Recording a measurement is evidence production, and evidence
 * has to be attributable to a mission that was actually current when it was produced.
 *
 * `candidates` — which reads what this writes — does not pass the flag. That asymmetry is
 * correct: the freshness of a projection matters at the moment evidence is made, not at the
 * moment it is read back.
 *
 * ## Two writes, one command, and neither is announced
 *
 * `metrics.record(computed)` stores the measurement set; `metrics.recordRanking(ranked,
 * DEFAULT_WEIGHTS)` stores the ranking **with the weights it was produced under**. The weights
 * are persisted beside the ranking rather than referenced, so a ranking stays interpretable
 * after `DEFAULT_WEIGHTS` changes — a later run is a different ranking, not a silent
 * re-scoring of the old one.
 *
 * The output names neither write. `values stored` is the measurement count; the ranking's
 * existence is implied only by the four candidate totals. An operator reading the summary
 * would not know two records were appended.
 *
 * ## `classify(snapshotId, { only: [] })` is deliberate, and reads like a bug
 *
 * An empty surface list means *measure nothing new*, so every classification is served from
 * storage instead of re-running the closure and impact traversals. The comment in the body
 * says so because the call is otherwise indistinguishable from a mistake — an empty array
 * where a filter is expected usually means the filter was lost.
 *
 * ## The honest line in the output is `observed evidence`
 *
 * When the console ledger is absent, `ranked.stats.observedEvidenceAvailable` is false and the
 * summary says every score is a static inference. That is the normal state in this build, and
 * it is printed at `info` rather than hidden: a ranking built without observed evidence is a
 * ranking of what the code *looks* like, and the operator is told so at the point of reading.
 *
 * ## Contested subjects, and one silent degradation
 *
 * Claims in an **unresolved** conflict contribute their subject to a contested set, and units
 * on those subjects are diverted to `clarificationCandidates` rather than ranked as patch
 * work. `conflicts(true)` is `onlyUnresolved = true`, so resolving a conflict releases its
 * subject back into ordinary ranking — the diversion lasts exactly as long as the
 * contradiction does. A unit the corpus disagrees about is not a proof target until someone
 * with authority decides which side is right.
 *
 * The degradation is in the `?? []`. If the claim registry is unavailable, the contested set
 * is empty and ranking proceeds as though nothing were contested — no warning, no `info` line.
 * That is the one place in this command where absent input is indistinguishable in the output
 * from input that said nothing was wrong.
 *
 * Behaviour is moved, not changed.
 */


import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import { computeAllMetrics, type MetricInput } from '../../analysis/metrics/families.js';
import { DEFAULT_WEIGHTS, rank } from '../../analysis/metrics/ranking.js';
import { printChecks, short, write } from '../output/formatter.js';
import { guarded as guardedWith, latestSnapshot } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue metrics                                                               */
/* ------------------------------------------------------------------------- */

function commandMetrics(snapshotOverride?: string): number {
  // DEV-P0-07: metrics recording is evidence production — it must run under a current, non-drifted
  // mission, so the gate (mission-basis + fresh projections) is required here.
  return withRuntime({ withLog: true, requireMission: true }, (runtime) => {
    const graph = runtime.requireGraph();
    const metrics = runtime.metrics;
    if (metrics === null) {
      write('Metric registry unavailable.');
      return 1;
    }

    const snapshotId = latestSnapshot(runtime, snapshotOverride);
    const stored = graph.resultOf(snapshotId);
    if (stored === null) {
      write(`No recognition for snapshot ${short(snapshotId)}. Run \`clue recognize\` first.`);
      return 1;
    }

    // An empty surface means every measurement is reused from storage, so this loads the
    // full classification set without repeating the expensive traversals.
    const classifications = graph.classify(snapshotId, { only: [] });

    // DEV-P2-10 (Stage G2): the observed-evidence supply, from the one ledger. `null`
    // means never exercised — the input omits the field and the family states the
    // absence; a present-but-empty list is an exercised, quiet console, which is
    // evidence of the opposite kind. The `observed evidence` check line below flips on
    // exactly this, via the ranking's `observedEvidenceAvailable`.
    const observed = runtime.requireConsole().observedSummaries();

    const input: MetricInput = {
      snapshotId,
      units: stored.units,
      edges: stored.edges,
      classifications,
      coverage: graph.coverage(snapshotId),
      isProtected: runtime.isProtected,
      ...(observed === null ? {} : { consoleSignatures: observed }),
    };

    const computed = computeAllMetrics(input);
    const metricRecord = metrics.record(computed);

    const contested = new Set(
      (runtime.claims?.conflicts(true) ?? [])
        .flatMap((conflict) => conflict.claim_ids)
        .map((claimId) => runtime.claims?.getClaim(claimId)?.subject_key ?? '')
        .filter((subject) => subject.length > 0),
    );

    const ranked = rank({
      metrics: computed,
      units: stored.units,
      classifications,
      isProtected: runtime.isProtected,
      contestedSubjects: contested,
    });
    metrics.recordRanking(ranked, DEFAULT_WEIGHTS);

    printChecks([
      { level: 'ok', label: 'snapshot', detail: short(snapshotId) },
      { level: 'ok', label: 'units scored', detail: String(computed.corpusSize) },
      { level: 'ok', label: 'values stored', detail: String(metricRecord.value_count) },
      {
        level: ranked.stats.observedEvidenceAvailable ? 'ok' : 'info',
        label: 'observed evidence',
        detail: ranked.stats.observedEvidenceAvailable
          ? 'console ledger present'
          : 'none — every score is a static inference (Stage G1)',
      },
      {
        level: 'info',
        label: 'corrections',
        detail: `${ranked.stats.correctionsApplied} cross-family`,
      },
    ]);

    write('');
    write(`patch candidates          ${ranked.patchCandidates.length}`);
    write(`instrumentation needed    ${ranked.instrumentationCandidates.length}`);
    write(`blocked by contradiction  ${ranked.clarificationCandidates.length}`);
    write(`excluded                  ${ranked.excluded.length}`);

    if (ranked.stats.familiesUnavailable.length > 0) {
      write('');
      write(`families unavailable: ${ranked.stats.familiesUnavailable.join(', ')}`);
    }

    write('');
    write('Next: clue candidates');
    return 0;
  });
}

/** Registers the `metrics` command. */
export function registerMetricsCommands(program: Command): void {
  program
    .command('metrics')
    .description('compute and record the metric families over the committed graph')
    .option('--snapshot <id>', 'measure a specific snapshot instead of the latest')
    .action((options: { snapshot?: string }) => {
      process.exitCode = runGuarded(() => commandMetrics(options.snapshot));
    });
}
