/**
 * Helpers shared across CLU-E's command modules.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 — the CLI owns command parsing, local confirmation,
 *       human-readable output, exit codes, and "selection of a registered project and command
 *       profile". Resolving which snapshot a command operates on is that last responsibility.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`.
 *
 * ## A note on this file's name
 *
 * This paragraph used to be a confession. §7 enumerated eight command files and this was not
 * among them, so the file argued for itself in its own header — which is drift with a paper
 * trail, and the precedent ADR-0003 was written to stop repeating.
 *
 * It is now sanctioned rather than excused. §7 as amended governs `commands/` by a rule: one
 * module per command domain named `<domain>Commands.ts`, plus presentation helpers in
 * `output/`. `shared.ts` implements no domain and its unsuffixed name says so — under the
 * amended rule that is what a shared helper looks like, and
 * `selftest/cli-layout-conformance.test.ts` declares it as one rather than tolerating it.
 *
 * The reason it exists is unchanged and still worth knowing. `latestSnapshot` was already
 * defined twice — in `index.ts` and in `consoleCommands.ts` — and extracting the `task` domain
 * would have made a third copy. A third copy of a five-line function is how the formatter
 * ended up printing at two different widths.
 *
 * The alternatives were worse. Exporting it from `index.ts` makes every command module import
 * the entry point it is being extracted *from*, which is a cycle waiting to happen. Putting it
 * on `Runtime` moves a CLI convenience into the control plane, where §8 gives it no home.
 */

import { RuntimeError, type Runtime } from '../../control/runtime.js';

/**
 * The snapshot a command should operate on: the caller's override, or the latest canonical
 * capture.
 *
 * `absentReason` is a parameter rather than a constant because the two existing copies did
 * not agree, and their disagreement was meaningful rather than drift: the console's copy
 * explains that nothing can be *attributed* without a snapshot, which is the specific thing
 * its caller was about to do. Collapsing the two into one generic message would have made the
 * error less useful in exactly the place someone reads it. Both messages are preserved by
 * their callers passing them.
 */
export function latestSnapshot(
  runtime: Runtime,
  override: string | undefined,
  absentReason = 'No snapshot has been captured. Run `clue snapshot` first.',
): string {
  if (override !== undefined) return override;
  const latest = runtime.snapshots?.latest('canonical') ?? null;
  if (latest === null) {
    throw new RuntimeError('LOG_REQUIRED', absentReason);
  }
  return latest.id;
}

/**
 * Runs a command body, turning a thrown error into a message and a non-zero exit code.
 *
 * Extracted for the same reason as {@link latestSnapshot}: each command module needs it, and
 * three private copies of an error-to-exit-code wrapper is three chances for them to disagree
 * about what a failed command prints.
 */
export function guarded(work: () => number, write: (line: string) => void): number {
  try {
    return work();
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
