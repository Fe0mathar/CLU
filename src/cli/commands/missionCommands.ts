/**
 * CLUE `mission` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is argument handling, one service call,
 *       and printing.
 *       `CLUE_Execution_Model_v9.md` — the mission is the durable envelope every piece of
 *       evidence is attributable to. `control/mission.ts` owns the registry; this prints it.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. The templated header this replaces
 *          described the mission *basis*, which is the thing this command's output does not
 *          fully show. See below.
 *
 * Reports every mission the workspace has registered, current and superseded.
 *
 * The basis is what makes a mission checkable rather than declarative: it hashes the
 * documents and schemas that govern behaviour, so a change to any of them is visible as
 * drift rather than discovered later as an inconsistency.
 *
 * ## The per-document hashes exist and are not printed
 *
 * A `TrackedDocument` is `{ path, hash }`, and the registry stores both. This command prints
 * `mission.documents.map((d) => d.path)` — the paths only. The single hash it does print,
 * `constitution_hash`, is an aggregate over the whole tracked set, so a changed document is
 * *visible* as a changed aggregate but not *identifiable*: the output tells an operator that
 * the governed basis moved and not which document moved it.
 *
 * That is a display gap rather than a durability gap — the hashes are in the record — and it
 * is the reason the previous header's description of the basis overstated what this command
 * shows.
 *
 * ## It is history, not state
 *
 * `registry.history()` returns every mission, and each is labelled `current` or `superseded by
 * <id>` from its own `superseded_by` field. There is no single-mission mode and no `--current`
 * flag, so on a long-lived workspace the current mission is the one entry among many that
 * happens to say `current`. Amendments print as codes only.
 *
 * ## The branch is reachable, and what that revealed — DEV-P1-36
 *
 * A previous revision of this header left a question open: the body handles
 * `history().length === 0` with *No mission registered. Run `clue init`.* and exit 1, while
 * `commandAuthority.ts` declares `mission` as `requiresMission: true` — so the refusal should
 * have come from the pre-action hook and this branch should have been dead.
 *
 * It was settled by running the binary against a workspace with no mission. The branch ran. The
 * hook did not refuse.
 *
 * The reason is `DEV-P1-36`: `assertDeclaredAuthority` calls `requireAuthority`, which asserts
 * only that the command **is declared**. Nothing in `src/` reads `requiresMission` at all, and
 * `commandMutates` is called only from a self-test. The mission gate is enforced elsewhere
 * entirely — by `withRuntime({ requireMission: true })` — which exactly one command passes.
 *
 * So the declaration was not wrong; it was inert. Keep this branch. It is not defensive
 * duplication of a gate above it, it is currently the only gate there is, and it should not be
 * removed until something actually consumes the declaration.
 *
 * ## DEV-P1-38 — it no longer takes the writer lock
 *
 * `withRuntime({ withLog: false })`: projections and artifacts read-only, the event log not
 * opened. Declared `mutates: false`, and now attached that way.
 *
 * Unlike its four siblings this one was never blocked — `MissionRegistry` was already built on
 * the read-only branch, because the dashboard needs it. The flag could have been flipped at any
 * point in the last several revisions. Nobody compared the declaration with the call site, which
 * is the whole shape of this defect: five commands, four of them blocked behind a missing
 * constructor call and one behind nothing but the absence of a check.
 *
 * `Mission registry unavailable` therefore remains a real branch rather than a formality: a
 * read-only runtime supplies the registry, so reaching that message now means the projections
 * themselves could not be opened.
 */


import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import { write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

function commandMission(): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const registry = runtime.mission;
    if (registry === null) {
      write(`Mission registry unavailable: ${runtime.logUnavailable ?? 'unknown reason'}`);
      return 1;
    }

    const history = registry.history();
    if (history.length === 0) {
      write('No mission registered. Run `clue init`.');
      return 1;
    }

    for (const mission of history) {
      const state =
        mission.superseded_by === null ? 'current' : `superseded by ${mission.superseded_by}`;
      write(`${mission.id}  v${mission.version}  ${mission.created_at}  ${state}`);
      write(`  constitution ${mission.constitution_hash}`);
      write(`  documents    ${mission.documents.map((document) => document.path).join(', ')}`);
      write(
        `  amendments   ${
          mission.amendments.length === 0
            ? 'none'
            : mission.amendments.map((amendment) => amendment.code).join(', ')
        }`,
      );
      write('');
    }
    return 0;
  });
}

/** Registers the `mission` command. */
export function registerMissionCommands(program: Command): void {
  program
    .command('mission')
    .description('the mission version in force and the governed inputs it binds')
    .action(() => {
      process.exitCode = runGuarded(commandMission);
    });
}
