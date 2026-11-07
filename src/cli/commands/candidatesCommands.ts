/**
 * CLUE `candidates` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is argument handling, one service call,
 *       and printing.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. The templated header this replaces
 *          opened "Ranks what is worth spending a proof on", which is what `clue metrics`
 *          does. This command reads that ranking back. See the authority note below — the
 *          same confusion is written into the authority registry.
 *
 * Reads the ranking `clue metrics` recorded, most valuable first.
 *
 * A ranked candidate is a *proposal*, not a finding: it says where evidence would be most
 * valuable, and says nothing about whether a defect is there. The separation is the point —
 * observation, hypothesis, proposal, implementation and proof stay distinct, and a candidate
 * is the third of those.
 *
 * ## DEV-P1-37 — the attachment is fixed; the declaration is not, yet
 *
 * `commandAuthority.ts` declares `candidates` as `mutates: true`, with the rationale "ranks
 * candidates and records the ranking with its weights". The body is a single bounded `SELECT`
 * over `ranked_candidates` — that rationale describes `metrics`, which is where both writes
 * happen. The declaration is *over*-restrictive rather than unsafe, so nothing is exposed by it,
 * but the closed registry is meant to be the one reviewable statement of what each command may
 * do, and a reviewer comparing it against this file would find it wrong.
 *
 * This turn corrects the half that costs an operator something. `withRuntime({ withLog: false })`
 * opens projections and artifacts read-only and does not open the event log, so reading a
 * ranking no longer takes the single-writer lock or blocks a concurrent `recognize`. It could
 * not be done earlier: `runtime.ts` built `MetricRegistry` only on the writable branch, so until
 * revision 7 the lock was the only route to this command's own data — the same shape as the five
 * commands in DEV-P1-38.
 *
 * The declaration is deliberately left alone for one more turn, and the order is not arbitrary.
 * `cli-attachment-conformance.test.ts` currently *excludes* `candidates`, naming it an open
 * question. Correcting the declaration first would have made that exclusion hide a live
 * violation — a command declared read-only that still takes the writer — and a conformance test
 * returning green for the wrong reason is worse than one that says nothing. Attachment first,
 * then declaration, then the exclusion is deleted and this command falls under the ordinary
 * rule. Relaxing a declared authority remains the Creator's signature; this attachment change is
 * not.
 *
 * `Metric registry unavailable.` keeps its meaning and stops carrying a second one: it no longer
 * also means "you attached read-only".
 *
 * ## What the printed line actually claims
 *
 * `priority` is a composite, not a measurement — magnitude, ease and confidence fold into it
 * under the weights stored with the ranking. The three are printed separately underneath
 * precisely so the composite can be disagreed with: a high priority built from high ease and
 * low confidence is a different proposition from the same number built the other way round.
 *
 * `observed` versus `inferred` is the one field that says whether anything was watched. In
 * this build the console ledger is usually absent, so every row reads `inferred` — the score
 * describes what the code looks like, not what it was seen to do.
 *
 * `corrections` are printed **at most two per candidate**, prefixed `!`. They are cross-family
 * disagreements the ranker resolved; a candidate carrying more than two has the remainder
 * dropped from the display. The full set lives in the stored ranking artifact.
 *
 * An empty result exits **0** with a hint, not 1. No candidates is a legitimate state — it
 * means no ranking has been recorded for this snapshot, which is a fact about the workflow
 * rather than a failure of the query.
 */

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import type { CandidateKind } from '../../analysis/metrics/ranking.js';
import { truncate, write } from '../output/formatter.js';
import { guarded as guardedWith, latestSnapshot } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue candidates                                                            */
/* ------------------------------------------------------------------------- */

interface CandidatesOptions {
  readonly kind?: string;
  readonly snapshot?: string;
  readonly count: string;
}

function commandCandidates(options: CandidatesOptions): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const metrics = runtime.metrics;
    if (metrics === null) {
      write('Metric registry unavailable.');
      return 1;
    }

    const snapshotId = latestSnapshot(runtime, options.snapshot);
    const rows = metrics.candidates(snapshotId, {
      ...(options.kind === undefined ? {} : { kind: options.kind as CandidateKind }),
      limit: Number.parseInt(options.count, 10),
    });

    if (rows.length === 0) {
      write('No candidates. Run `clue metrics` after a recognition.');
      return 0;
    }

    for (const candidate of rows) {
      write(
        `${candidate.priority.toFixed(4)}  ${candidate.kind.padEnd(15)} ` +
          `${candidate.evidence === 'observed' ? 'observed' : 'inferred'}  ${candidate.logicalId}`,
      );
      write(
        `          magnitude ${candidate.magnitude.toFixed(2)} · ease ${candidate.ease.toFixed(4)} · ` +
          `confidence ${candidate.confidence.toFixed(2)} · ${candidate.proofReadiness}`,
      );
      write(`          ${truncate(candidate.proposedAction, 92)}`);
      for (const correction of candidate.corrections.slice(0, 2)) {
        write(`          ! ${truncate(correction, 90)}`);
      }
      write('');
    }

    write(`${rows.length} candidate(s). A rank is a reason to look, never a reason to believe.`);
    return 0;
  });
}

/** Registers the `candidates` command. */
export function registerCandidatesCommands(program: Command): void {
  program
    .command('candidates')
    .description('rank units by where a proof would be worth the cost')
    .option('--snapshot <id>', 'rank against a specific snapshot instead of the latest')
    .option('--kind <kind>', 'restrict to one candidate kind')
    .option('--count <n>', 'how many to list', '20')
    .action((options: { snapshot?: string; kind?: string; count: string }) => {
      process.exitCode = runGuarded(() => commandCandidates(options));
    });
}
