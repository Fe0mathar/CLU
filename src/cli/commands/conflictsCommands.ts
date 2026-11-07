/**
 * CLUE `conflicts` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is argument handling, one service call,
 *       and printing.
 *       §11.5 — conflicts are preserved durable evidence with their own lifecycle. This
 *       module reads them; nothing in the CLI resolves one.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. The templated header this replaces
 *          stated the doctrine correctly and omitted the two things a reader needs: that the
 *          default view hides resolved conflicts, and that this command reads the same
 *          registry `metrics` uses to divert ranking.
 *
 * Lists claims that contradict one another.
 *
 * A conflict is durable evidence, not a problem to be tidied away: two governed documents
 * disagreeing is a fact about the corpus, and resolving it requires deciding which is right —
 * an act with authority attached, not a cleanup. The closing line of the output says the same
 * thing to the operator: both sides are preserved, and CLU-E does not choose.
 *
 * ## The default is a filtered view, and the empty message says which
 *
 * `registry.conflicts(!all)` — without `--all` the query is `onlyUnresolved = true`. The two
 * empty states are therefore different facts and are printed differently: *No unresolved
 * conflicts* means some may exist and have been decided; *No conflicts recorded* (under
 * `--all`) means the corpus contradicted itself nowhere. Collapsing them into one message
 * would have made a resolved corpus look like an unexamined one.
 *
 * This is the same filter `metricsCommands.ts` applies when it builds its contested set, which
 * is what ties the two together: a conflict listed here without `--all` is also a conflict
 * currently keeping its subject out of patch ranking.
 *
 * ## What the display drops
 *
 * Each conflicting claim's text is truncated to 84 characters, and a claim whose id no longer
 * resolves is **skipped silently** (`if (claim === null) continue`) — the conflict still
 * prints, with fewer sides than it has. The trailing count is of conflicts, not of the claims
 * shown beneath them.
 *
 * `resolution` is printed verbatim as the registry stores it, so `unresolved` is a value here
 * and not an absence.
 *
 * ## DEV-P1-38 — it no longer takes the writer lock
 *
 * `withRuntime({ withLog: false })`: projections, artifacts and audit read-only, the event log
 * not opened at all. `commandAuthority.ts` declared `conflicts` as `mutates: false` throughout;
 * only the attachment disagreed.
 *
 * The disagreement mattered more here than the word "listing" suggests. A conflict is read when
 * the corpus is already known to contradict itself and someone is deciding which side is right —
 * frequently while a recognition or an ingest is running, which is what produced the conflict.
 * A command that had to take the writer lock to show two claims was unusable at the moment it
 * was wanted, and the operator's alternative was to stop the run they were trying to understand.
 *
 * Ordering note: this depended on `runtime.ts` revision 6. Until the read-only attach built the
 * claim registry, `requireClaims()` would have thrown on every invocation and the lock was the
 * only route to this command's own data.
 */

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import { truncate, write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

function commandConflicts(all: boolean): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const registry = runtime.requireClaims();
    const conflicts = registry.conflicts(!all);

    if (conflicts.length === 0) {
      write(all ? 'No conflicts recorded.' : 'No unresolved conflicts.');
      return 0;
    }
    for (const conflict of conflicts) {
      write(
        `${conflict.id}  ${conflict.severity.toUpperCase().padEnd(6)} ${conflict.kind}/${conflict.scope}`,
      );
      write(`            ${conflict.summary}`);
      for (const claimId of conflict.claim_ids) {
        const claim = registry.getClaim(claimId);
        if (claim === null) continue;
        write(`            ${claimId}: ${truncate(claim.raw_text, 84)}`);
      }
      write(`            resolution: ${conflict.resolution}`);
      write('');
    }
    write(`${conflicts.length} conflict(s). Both sides are preserved; CLUE does not choose.`);
    return 0;
  });
}

/** Registers the `conflicts` command. */
export function registerConflictsCommands(program: Command): void {
  program
    .command('conflicts')
    .description('list contradictions between registered claims')
    .option('--all', 'include resolved conflicts', false)
    .action((options: { all: boolean }) => {
      process.exitCode = runGuarded(() => commandConflicts(options.all));
    });
}
