/**
 * CLUE `audit` commands.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is argument handling, one service call,
 *       and printing.
 *       §22 — `workspace/audit/` holds durable action and execution receipts. This module
 *       reads them and owns none of them.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. The templated header this replaces
 *          missed the property that makes this module the reference for the rest of the
 *          directory: it is the only read command here that attaches read-only.
 *
 * Reads the audit log: what CLU-E attempted, and what was refused.
 *
 * `denials` is the more useful of the two. A refused action is the system's authority model
 * working, and a run with no denials is not evidence of correctness — it may equally mean
 * nothing was attempted that could have been refused.
 *
 * ## The one command in this directory that does not take the writer lock
 *
 * `withRuntime({ withLog: false })` opens projections, artifacts and audit **read-only** and
 * does not open the event log at all, so this cannot perturb a running daemon or block a
 * concurrent `recognize`. Its siblings — `graph`, `claims`, `conflicts`, `seeds`, `mission` —
 * are declared `mutates: false` in `commandAuthority.ts` and nonetheless open `withLog: true`,
 * acquiring the single-writer lock to read. This module is what they should look like.
 *
 * The property matters most here specifically. An operator reaches for `audit denials` when
 * something is already wrong, often while a long operation is running; a diagnostic that has
 * to take the writer lock is unusable at exactly the moment it is wanted.
 *
 * ## The output is reversed, and both modes share one path
 *
 * `tail` and `denials` differ by one call — `runtime.audit.denials(count)` against
 * `runtime.audit.tail(count)`. The registry returns newest-first and the printer reverses it,
 * so the display reads oldest-first within the window: a sequence, not a stack. `--count`
 * bounds what is fetched, so the window is the last N entries, printed in the order they
 * happened.
 *
 * `--count` is `Number.parseInt`'d without validation; a non-numeric value yields `NaN` and
 * whatever the registry does with it. Empty exits **0** with `No audit entries.` — an audit
 * log with nothing in it is a valid state, not a failure to read one.
 *
 * `DENIED ` carries a trailing space so it column-aligns with `allowed`. That is deliberate:
 * denials and allowances are meant to be scannable in one vertical pass.
 */

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import { write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

function commandAudit(mode: 'tail' | 'denials', count: number): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const entries = mode === 'denials' ? runtime.audit.denials(count) : runtime.audit.tail(count);
    if (entries.length === 0) {
      write('No audit entries.');
      return 0;
    }
    for (const entry of [...entries].reverse()) {
      const decision = entry.decision === 'denied' ? 'DENIED ' : 'allowed';
      const target = entry.target === null ? '' : ` ${entry.target}`;
      const reason = entry.reason === null ? '' : ` — ${entry.reason}`;
      write(
        `${entry.timestamp} ${decision} ${entry.actor}/${entry.command} [${entry.capability}]${target}${reason}`,
      );
    }
    return 0;
  });
}

/** Registers the `audit` commands. */
export function registerAuditCommands(program: Command): void {
  const audit = program.command('audit').description('inspect what CLUE has attempted');
  audit
    .command('tail')
    .description('the most recent audited actions')
    .option('--count <n>', 'how many entries', '20')
    .action((options: { count: string }) => {
      process.exitCode = runGuarded(() => commandAudit('tail', Number.parseInt(options.count, 10)));
    });
  audit
    .command('denials')
    .description('actions that were refused, and why')
    .option('--count <n>', 'how many entries', '20')
    .action((options: { count: string }) => {
      process.exitCode = runGuarded(() =>
        commandAudit('denials', Number.parseInt(options.count, 10)),
      );
    });
}
