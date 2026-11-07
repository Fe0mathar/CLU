/**
 * CLUE `claims` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is argument handling, one service call,
 *       and printing.
 *       §11.5 — the claim registry owns content identity, location identity, lifecycle and
 *       conflict. This module filters and prints; `clue docs ingest` is what populates it.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. The templated header this replaces
 *          described the registry accurately and the command not at all — none of the six
 *          filters, the silent limit, or the writer lock appeared in it.
 *
 * Queries the claim registry: what the governed documents assert, and where.
 *
 * A claim is what a document says, not what is true. `status` records how far a claim has
 * been taken — asserted, supported, refuted — and the registry keeps content identity
 * (`content_id`, what is asserted) separate from location, so two documents making the same
 * statement are one claim in two places rather than two claims.
 *
 * ## Every filter is passed through unvalidated
 *
 * `--modality`, `--status`, `--domain`, `--subject` and `--min-strength` are cast to their
 * registry types at the boundary (`options.modality as ClaimModality`) with no check that the
 * value is one the registry knows. A misspelled modality is not rejected — it matches nothing
 * and the command prints `No claims match.` and exits **0**.
 *
 * That failure is indistinguishable from a correct query over an empty result, which is the
 * one thing an operator needs to tell apart here. `--min-strength` is worse in the same way:
 * `Number.parseFloat` of a non-number yields `NaN`, every comparison against it is false, and
 * the result is again an empty list with a zero exit.
 *
 * ## The listing is truncated twice, and neither limit is announced
 *
 * `--count` defaults to **25**, so an unqualified `clue claims` over a corpus of thousands
 * shows twenty-five rows and reports `25 claim(s).` — a count of what was printed, not what
 * matched. Nothing in the output says more exist. Separately, each claim's text is cut to 96
 * characters, so the printed assertion may not be the whole assertion.
 *
 * Neither is a defect in the registry: both are display decisions made here. They are worth
 * knowing before anyone treats this output as a corpus census.
 *
 * ## DEV-P1-38 — it no longer takes the writer lock
 *
 * `commandAuthority.ts` declares `claims` as `mutates: false`. It writes nothing, and it now
 * attaches that way: `withRuntime({ withLog: false })` opens projections, artifacts and audit
 * read-only and does not open the event log at all, so listing claims cannot block a concurrent
 * `recognize` or a second copy of itself.
 *
 * It could not be changed on its own. Until `runtime.ts` revision 6 the read-only attach built
 * `mission`, `snapshots` and `graph` and stopped — `claims` stayed `null` there, an omission
 * inherited from the branch being written for the dashboard. Flipping this flag before that was
 * fixed would have compiled, passed the suite, and sent every invocation down
 * `requireClaims()`'s failure path. The lock was load-bearing here by accident: it was the only
 * way this command could reach its own registry.
 *
 * `requireClaims()` still throws when the registry is genuinely absent. What changed is that a
 * read-only runtime is no longer one of the cases where it is.
 */

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import type { ClaimModality, ClaimStatus } from '../../analysis/documents/claimExtractor.js';
import { truncate, write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

interface ClaimsOptions {
  readonly modality?: string;
  readonly domain?: string;
  readonly status?: string;
  readonly subject?: string;
  readonly minStrength?: string;
  readonly count: string;
}

function commandClaims(options: ClaimsOptions): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const records = runtime.requireClaims().claims({
      ...(options.modality === undefined ? {} : { modality: options.modality as ClaimModality }),
      ...(options.status === undefined ? {} : { status: options.status as ClaimStatus }),
      ...(options.domain === undefined ? {} : { domain: options.domain }),
      ...(options.subject === undefined ? {} : { subjectKey: options.subject }),
      ...(options.minStrength === undefined
        ? {}
        : { minimumStrength: Number.parseFloat(options.minStrength) }),
      limit: Number.parseInt(options.count, 10),
    });

    if (records.length === 0) {
      write('No claims match.');
      return 0;
    }
    for (const claim of records) {
      write(
        `${claim.id}  ${claim.modality.padEnd(14)} ${claim.strength.toFixed(2)}  ` +
          `${claim.document_path}:${claim.start_line}`,
      );
      write(`            ${truncate(claim.raw_text, 96)}`);
    }
    write('');
    write(`${records.length} claim(s).`);
    return 0;
  });
}

/** Registers the `claims` command. */
export function registerClaimsCommands(program: Command): void {
  program
    .command('claims')
    .description('query what the governed documents assert')
    .option('--modality <modality>', 'restrict to one modality')
    .option('--status <status>', 'restrict to one lifecycle status')
    .option('--domain <domain>', 'restrict to one domain')
    .option('--subject <key>', 'restrict to one subject')
    .option('--min-strength <value>', 'minimum claim strength')
    .option('--count <n>', 'how many to list', '25')
    .action((options: ClaimsOptions) => {
      process.exitCode = runGuarded(() => commandClaims(options));
    });
}
