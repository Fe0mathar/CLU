/**
 * CLUE `graph` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is argument handling, one service call,
 *       and printing.
 *       §11.3 — `analysis/source/graph.ts` owns the durable graph projections and the
 *       classification, closure and impact queries. This module calls three of them and
 *       formats the result; it computes none of it.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. The header this replaces was written
 *          from a template and said only that behaviour was moved, not changed. That was true
 *          and useless: it described the extraction rather than the command.
 *
 * Inspects one semantic unit: how it is classified, what it reaches, and what reaches it.
 *
 * ## The identity is the thing operators get wrong
 *
 * The unit is named by its logical id under identity-v4 — `Class$class.method$method`, not
 * `Class.method`. The declaration kind is part of the identity, which is what keeps a method
 * and a same-named property from colliding (Directory §23). Guessing the id fails; `clue
 * recognize` prints the ids it committed, and those are the ones this accepts.
 *
 * An unknown id exits **1**, not 0. A unit absent from the snapshot is a failed lookup, not an
 * empty result, and a script that greps the output would otherwise treat the two alike.
 *
 * ## Two of the printed numbers are floors, not counts
 *
 * `impactSize`, `impactModules` and `impactSubsystems` come from a bounded traversal. When the
 * bound is hit, `classification.truncated` is set and the line is suffixed `(lower bound)`.
 * The number is then a floor: the true impact is at least this, and how much more is unknown.
 * Anything that compares two units on impact has to read the flag as well as the figure.
 *
 * The two lists below are bounded differently and for a different reason. `behaviour closure`
 * and `depended on by` print **at most 15 entries** with a `… and N more` tail — a display
 * limit, not a measurement limit. The authoritative sizes are the `closure` and `impact`
 * summary lines above them, which are computed over the whole set. Reading the list as the
 * answer under-reports; reading the summary as the answer does not.
 *
 * ## DEV-P1-38 — it no longer takes the writer lock
 *
 * `commandAuthority.ts` declares `graph` as `mutates: false`. It writes nothing, and it now
 * attaches that way: `withRuntime({ withLog: false })` opens projections, artifacts and audit
 * **read-only** and does not open the event log at all.
 *
 * It previously passed `withLog: true`, which acquires the **single-writer event-log lock**. An
 * inspection command therefore locked out a concurrent `recognize`, and a second `clue graph` in
 * another terminal — while the registry declared, correctly and inertly, that it was a reader.
 * The declaration and the attachment had simply never been compared.
 *
 * Nothing this command needs is behind the writer. `openRuntime` builds `GraphRegistry` on both
 * paths; without the writer it receives a read-only log stand-in that throws on any write, which
 * is the correct shape for a command that only queries projections. If a future edit here needs
 * to append, that stand-in turns the mistake into an exception rather than a silent write —
 * strictly better than the lock it used to hold, which permitted the write and merely blocked
 * everyone else.
 *
 * `auditCommands.ts` is the module this was modelled on. Four siblings still diverge —
 * `claims`, `conflicts`, `seeds` and `mission` — and each is its own turn, because an attachment
 * change is behavioural and earns its own proof rather than riding along with four others.
 */

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import { short, write } from '../output/formatter.js';
import { guarded as guardedWith, latestSnapshot } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue graph                                                                 */
/* ------------------------------------------------------------------------- */

function commandGraph(logicalId: string, snapshotOverride?: string): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const graph = runtime.requireGraph();
    const snapshotId = latestSnapshot(runtime, snapshotOverride);

    const classification = graph.classificationOf(snapshotId, logicalId);
    if (classification === null) {
      write(`${logicalId} is not in snapshot ${short(snapshotId)}.`);
      return 1;
    }

    write(`${logicalId}`);
    write('');
    write(`  shape        ${classification.quadrant}`);
    write(`  reach        ${classification.blastRadius}`);
    write(`  confidence   ${classification.confidence.toFixed(2)}`);
    write(`  percentile   ${classification.percentile.toFixed(3)}`);
    write(
      `  closure      ${classification.closureSize} unit(s) across ` +
        `${classification.closureModules} module(s), ${classification.externalModules} external`,
    );
    write(
      `  impact       ${classification.impactSize} unit(s), ${classification.impactModules} module(s), ` +
        `${classification.impactSubsystems} subsystem(s)${classification.truncated ? ' (lower bound)' : ''}`,
    );
    if (classification.protectedReason !== null) {
      write(`  protected    ${classification.protectedReason}`);
    }

    write('');
    write('  why:');
    for (const reason of classification.reasons) write(`    - ${reason}`);

    const closure = graph.closureOf(snapshotId, logicalId);
    if (closure !== null && closure.members.length > 1) {
      write('');
      write('  behaviour closure:');
      for (const member of closure.members.slice(0, 15)) write(`    ${member}`);
      if (closure.members.length > 15) write(`    … and ${closure.members.length - 15} more`);
    }

    const impact = graph.impactOf(snapshotId, logicalId);
    if (impact.dependents.length > 0) {
      write('');
      write('  depended on by:');
      for (const dependent of impact.dependents.slice(0, 15)) write(`    ${dependent}`);
      if (impact.dependents.length > 15) write(`    … and ${impact.dependents.length - 15} more`);
    }

    return 0;
  });
}

/** Registers the `graph` command. */
export function registerGraphCommands(program: Command): void {
  program
    .command('graph <logicalId>')
    .description('inspect one unit: its source anchor, dependencies and dependents')
    .option('--snapshot <id>', 'inspect a specific snapshot instead of the latest')
    .action((logicalId: string, options: { snapshot?: string }) => {
      process.exitCode = runGuarded(() => commandGraph(logicalId, options.snapshot));
    });
}
