/**
 * CLUE `seeds` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is argument handling, one service call,
 *       and printing.
 *       §11.5 — test seeds are derived from registered claims by
 *       `analysis/documents/testSeeds.ts`. This module lists what that produced.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`.
 *          DEV-P1-33 — two option flags the body reads were never registered on the command,
 *          so one of its two modes was unreachable. Fixed here; see below.
 *
 * Lists test seeds derived from document claims.
 *
 * A seed is a claim stated precisely enough that a test could be written from it. `readiness`
 * records how far it is from being one, and the honest majority are not ready — a document
 * that says a thing clearly is not the same as a document that says a measurable thing.
 *
 * ## DEV-P1-33 — the mode that could not be reached
 *
 * `SeedsOptions` declared `advisory` and `rejections`, and the body branched on both: a truthy
 * `--rejections` prints the rejection summary instead of the listing, and `includeAdvisory` is
 * passed straight into the query. **Neither flag was registered on the command.** Commander
 * therefore never set them, so `options.rejections` was always `undefined` — the rejection
 * summary was dead code that no invocation could reach — and `includeAdvisory` received
 * `undefined` rather than a boolean on every call.
 *
 * `--rejections` and `--advisory` are now declared, with `false` defaults so the boolean the
 * query receives is a boolean. This is a behavioural change, not a header repair, and it is
 * recorded as its own backlog item rather than folded into `DEV-P1-07`.
 *
 * The loss was not cosmetic. The rejection summary is the only surface that answers *what the
 * corpus failed to promise testably* — it counts claims the seed generator refused and why,
 * which is the negative space around every readiness figure this command prints. Without it an
 * operator can see which seeds exist and never learn how many claims produced none.
 *
 * ## Two exits that look alike and are not
 *
 * `Seed registry unavailable.` exits **1** — the registry could not be opened, and nothing is
 * known. `No seeds match.` exits **0** — the registry answered, and the answer was empty.
 * `--kind` and `--readiness` are cast to their registry types without validation, so a
 * misspelled value produces the second of those: an empty list, exit 0, no complaint.
 *
 * `--count` defaults to 25 and the trailing `N seed(s).` counts what was printed rather than
 * what matched. `statement` is cut at 96 characters and `falsifier` at 82 — a seed whose
 * falsifier is long is displayed without the part that would make it falsifiable.
 *
 * ## DEV-P1-38 — it no longer takes the writer lock
 *
 * `withRuntime({ withLog: false })`: projections and artifacts read-only, the event log not
 * opened. `commandAuthority.ts` declared `seeds` as `mutates: false` all along; only the
 * attachment disagreed, and listing seeds could block a concurrent `recognize`.
 *
 * This file is the reason the dependency had to be fixed first, and it shows why more plainly
 * than its siblings do. It reads `runtime.seeds` directly rather than through a `require*`
 * accessor, and a null registry lands on `Seed registry unavailable.` with **exit 1**. Until
 * `runtime.ts` revision 6 built `TestSeedRegistry` on the read-only path, flipping this flag
 * would have turned every invocation into that error — and the error is honest, correctly
 * worded, and would have looked like a workspace problem rather than a wiring one. A defect
 * that reports itself in the vocabulary of a different defect is the expensive kind.
 *
 * The two exits below keep their meanings exactly. `Seed registry unavailable.` still means the
 * registry could not be opened; it simply no longer means "you asked for this read-only".
 */

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import type { SeedKind, SeedReadiness } from '../../analysis/documents/testSeeds.js';
import { truncate, write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

interface SeedsOptions {
  readonly kind?: string;
  readonly readiness?: string;
  readonly advisory: boolean;
  readonly rejections: boolean;
  readonly count: string;
}

function commandSeeds(options: SeedsOptions): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const registry = runtime.seeds;
    if (registry === null) {
      write('Seed registry unavailable.');
      return 1;
    }

    if (options.rejections) {
      const entries = Object.entries(registry.rejectionSummary());
      if (entries.length === 0) {
        write('No rejections recorded.');
        return 0;
      }
      for (const [reason, count] of entries.sort((a, b) => b[1] - a[1])) {
        write(`${String(count).padStart(6)}  ${reason}`);
      }
      write('');
      write('A rejection is a claim the corpus could not promise in a testable form.');
      return 0;
    }

    const seeds = registry.seeds({
      ...(options.kind === undefined ? {} : { kind: options.kind as SeedKind }),
      ...(options.readiness === undefined ? {} : { readiness: options.readiness as SeedReadiness }),
      includeAdvisory: options.advisory,
      limit: Number.parseInt(options.count, 10),
    });

    if (seeds.length === 0) {
      write('No seeds match.');
      return 0;
    }
    for (const seed of seeds) {
      write(
        `${seed.id}  ${seed.kind.padEnd(11)} ${seed.instrument.padEnd(18)} ` +
          `${seed.readiness.padEnd(16)} ${seed.confidence.toFixed(2)}`,
      );
      write(`            ${truncate(seed.statement, 96)}`);
      write(`            falsified by: ${truncate(seed.falsifier, 82)}`);
      write('');
    }
    write(`${seeds.length} seed(s).`);
    return 0;
  });
}

/** Registers the `seeds` command. */
export function registerSeedsCommands(program: Command): void {
  program
    .command('seeds')
    .description('list test seeds derived from document claims')
    .option('--kind <kind>', 'restrict to one seed kind')
    .option('--readiness <state>', 'restrict to one readiness state')
    // DEV-P1-33: both were read by the body and never declared here. `false` defaults keep
    // `includeAdvisory` a boolean rather than `undefined` when the flag is absent.
    .option('--advisory', 'include advisory seeds', false)
    .option('--rejections', 'summarise the claims that produced no seed, and why', false)
    .option('--count <n>', 'how many to list', '25')
    .action((options: SeedsOptions) => {
      process.exitCode = runGuarded(() => commandSeeds(options));
    });
}
