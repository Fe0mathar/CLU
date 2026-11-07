/**
 * CLUE CLI output formatting.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 — the CLI owns "human-readable output", and
 *       `src/cli/output/formatter.ts` is the named owner of it.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. This is the first extraction, and it
 *          comes first because the alternative was making a third copy.
 *
 * `index.ts` and `consoleCommands.ts` each carried their own `CheckLevel`, `SYMBOL`, `write`,
 * `truncate` and `short`. Two copies of a formatter is not obviously a defect until you look
 * at what they had already become:
 *
 *     index.ts          label.padEnd(34)
 *     consoleCommands   label.padEnd(28)
 *
 * The two command families print their check lines at different alignments. Nobody decided
 * that; it is what two copies do. The drift is preserved rather than resolved here — see
 * {@link CHECK_LABEL_WIDTH} — because DEV-P1-07 is a move-without-changing-behaviour
 * decomposition, and quietly re-aligning half the CLI's output inside a refactor would be
 * exactly the kind of change that is impossible to review. It is now one visible constant
 * with one decision attached to it instead of two invisible ones.
 */

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  readonly level: CheckLevel;
  readonly label: string;
  readonly detail: string;
}

export const SYMBOL: Record<CheckLevel, string> = {
  ok: '  OK ',
  warn: 'WARN ',
  fail: 'FAIL ',
  info: 'INFO ',
};

/**
 * The label column width. One number, decided rather than inherited.
 *
 * DEV-P1-07 found this at two values — 34 in `index.ts`, 28 in `consoleCommands.ts` — which
 * nobody had chosen; it is what two copies of a formatter do. The extraction preserved both
 * so that moving a file did not silently re-align half the CLI's output, and the choice was
 * then made separately, which is the only way a change like this is reviewable: as a two-line
 * diff rather than as a side effect buried in a refactor.
 *
 * 34 wins because the main command surface is the large majority of the output and the wider
 * column keeps long detail strings from crowding the label.
 */
export const CHECK_LABEL_WIDTH = 34;

export function write(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** One check line at the given label width. */
export function checkLine(
  level: CheckLevel,
  label: string,
  detail: string,
  labelWidth: number = CHECK_LABEL_WIDTH,
): void {
  write(`${SYMBOL[level]} ${label.padEnd(labelWidth)} ${detail}`);
}

/** Prints a group of checks. The main command surface's default width. */
export function printChecks(
  checks: readonly Check[],
  labelWidth: number = CHECK_LABEL_WIDTH,
): void {
  for (const check of checks) checkLine(check.level, check.label, check.detail, labelWidth);
}

/** Collapses whitespace and caps length, for text that must fit one line. */
export function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** Abbreviates a long identity for display. Never used where the full value matters. */
export function short(value: string, width = 12): string {
  return value.length > width ? `${value.slice(0, width)}…` : value;
}
