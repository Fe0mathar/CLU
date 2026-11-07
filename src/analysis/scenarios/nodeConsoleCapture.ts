/**
 * Node console capture — a child process's diagnostics as ledger entries (DEV-P2-10, G2).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §7 (evidence coverage for screening) and §8
 *       ("runtime failures and long-tail behavior" among a hypothesis's inputs) — the
 *       observed-evidence supply Stage G2 ranking consumes; `CLUE_Project_Directory_v9.md`
 *       §16 gives the *browser* the console-evidence instrument (`consoleLedger.ts`
 *       owns the ledger; `browserAgent` collects for Murugan). A Node CLI target has no
 *       browser console, so this module is the Node-side collector for the **same**
 *       ledger: it produces `RawConsoleEntry[]` and nothing else, and every downstream
 *       right — sessions, dedup, classification, attribution history — stays with the
 *       one owner in `src/experiment/console/consoleLedger.ts`. A second evidence path
 *       would be a second authority on what was observed, which is the failure this
 *       codebase keeps refusing.
 *
 * ## What this module is, and is not
 *
 * Pure text → entries. No process is spawned here, no clock is read beyond the timestamps
 * the caller supplies, no ledger is touched. The scenario runner (a later slice of this
 * domain) owns execution and ingestion; keeping the grammar pure is what lets the suite
 * pin every stderr shape without running anything.
 *
 * ## The grammar, measured 2026-08-11 on Node 22
 *
 * Real captured shapes this parser reads (from a live corpus, not from memory):
 *
 *     TypeError: bad thing: x is not a function
 *         at boom ([eval]:3:24)
 *         at [eval]:4:7
 *         at runScriptInThisContext (node:internal/vm:209:10)
 *     plain warn line
 *     (node:5052) DeprecationWarning: legacy API used
 *     (Use `node --trace-deprecation ...` to show where the warning was created)
 *
 * Rules that fall out of it:
 *
 *   - **Stack folding.** A `    at …` line never stands alone; it belongs to the nearest
 *     preceding non-frame line, which becomes one entry carrying all its frames. An
 *     orphan frame block at the start of a chunk is folded into a synthesized entry that
 *     says so, rather than being dropped — dropped evidence is the one sin here.
 *   - **Level is content-first.** `X…Error:`-headed lines and `Unhandled…` are `error`;
 *     `(node:pid) …Warning:` and `Warning:`-headed lines are `warning`; everything else
 *     takes the stream's default (`stderr` → `info`, `stdout` → `log`). The stream is a
 *     tiebreak, not a verdict: Node writes warnings and errors to stderr alike.
 *   - **Frames come in two forms**, `at fn (loc)` and `at loc`, where `loc` is
 *     `path:line:col`. Windows drive letters (`C:\x\y.js:3:5`) mean the *first* colon is
 *     part of the path; the parser splits from the right. `async ` and `new ` prefixes on
 *     the function name are preserved inside `functionName`; `node:` internals, `[eval]`
 *     and `file://` URLs all parse (normalisation to project paths is the attributor's
 *     judgement, not the collector's).
 *   - **Noise lines are entries too.** `(Use \`node --trace-…\` …)` advice folds into the
 *     warning above it as a continuation, because it is the same diagnostic event; a
 *     continuation is any indented non-frame line following an entry that has frames or a
 *     recognised head. Unindented text is a new entry.
 *
 * ## The dist ↔ src caveat, stated
 *
 * A compiled target's frames name compiled paths under `dist/` (`.js`) while recognized
 * units anchor sources under `src/` (`.ts`). `tsconfig.json` has `sourceMap: true`
 * (verified), so exact mapping is
 * *possible* and belongs to the attributor slice; this collector records frames exactly
 * as printed and makes no path judgements at all.
 */

import type { ConsoleLevel, RawConsoleEntry, StackFrame } from '../../experiment/console/consoleLedger.js';

/** One captured stream chunk: which stream, and the text as received. */
export interface CapturedStream {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface CaptureOptions {
  /** ISO timestamp applied to every entry — the scenario runner's clock, one per capture. */
  readonly timestamp: string;
  readonly scenarioId?: string | null;
  readonly stepIndex?: number | null;
}

/* ------------------------------------------------------------------------- */
/* Frame grammar                                                              */
/* ------------------------------------------------------------------------- */

/** `    at fn (loc)` — fn may carry `async `, `new `, `Object.<anonymous>`, generics. */
const FRAME_WITH_NAME = /^\s+at\s+(.+?)\s+\((.+)\)\s*$/;
/** `    at loc` — no function name at all. */
const FRAME_BARE = /^\s+at\s+(.+?)\s*$/;

/**
 * Splits `path:line:col` from the right, so `C:\x\y.js:3:5` keeps its drive letter and
 * `file:///x/y.js:3:5` keeps its scheme. Returns null when the tail is not two integers —
 * `at Promise.all (index 1)` is a real Node shape and is not a code location.
 */
export function parseFrameLocation(
  location: string,
): { readonly url: string; readonly line: number; readonly column: number } | null {
  const lastColon = location.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const secondColon = location.lastIndexOf(':', lastColon - 1);
  if (secondColon <= 0) return null;
  const line = Number(location.slice(secondColon + 1, lastColon));
  const column = Number(location.slice(lastColon + 1));
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) return null;
  return { url: location.slice(0, secondColon), line, column };
}

/** Reads one line as a stack frame, or null when it is not one. */
export function parseStackFrameLine(line: string): StackFrame | null {
  const named = FRAME_WITH_NAME.exec(line);
  if (named !== null && named[1] !== undefined && named[2] !== undefined) {
    const location = parseFrameLocation(named[2]);
    if (location === null) {
      // `at Promise.all (index 1)` and friends: a frame by shape, not by location. It
      // still marks the line as stack-shaped so folding works; the location is void.
      return { url: named[2], line: 0, column: 0, functionName: named[1] };
    }
    return { ...location, functionName: named[1] };
  }
  const bare = FRAME_BARE.exec(line);
  if (bare !== null && bare[1] !== undefined) {
    const location = parseFrameLocation(bare[1]);
    if (location === null) return null;
    return { ...location, functionName: null };
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Level grammar                                                              */
/* ------------------------------------------------------------------------- */

const ERROR_HEAD = /^(?:[A-Z][A-Za-z0-9]*Error|AssertionError|UnhandledPromiseRejection|Uncaught)\b/;
const WARNING_HEAD = /^(?:\(node:\d+\)\s+)?(?:[A-Z][A-Za-z0-9]*Warning\b|Warning:)/;
const ERROR_WORD = /^error[:\s]/i;

/** Content-first level; the stream only breaks ties (measured grammar in the header). */
export function classifyLevel(text: string, stream: 'stdout' | 'stderr'): ConsoleLevel {
  if (ERROR_HEAD.test(text) || ERROR_WORD.test(text)) return 'error';
  if (WARNING_HEAD.test(text)) return 'warning';
  return stream === 'stderr' ? 'info' : 'log';
}

/* ------------------------------------------------------------------------- */
/* Capture                                                                    */
/* ------------------------------------------------------------------------- */

/** A continuation is indented, is not a frame, and follows an entry that can own it. */
function isContinuation(line: string): boolean {
  return /^\s+\S/.test(line) || /^\(Use `node --trace/.test(line);
}

/**
 * Folds one stream's text into entries: heads own their frames and continuations, and
 * nothing captured is dropped. Blank lines end nothing by themselves — Node interleaves
 * them freely — they are simply skipped between entries and preserved inside none.
 */
export function captureStream(chunk: CapturedStream, options: CaptureOptions): RawConsoleEntry[] {
  const entries: RawConsoleEntry[] = [];
  let head: { text: string; frames: StackFrame[]; level: ConsoleLevel } | null = null;

  const flush = (): void => {
    if (head === null) return;
    entries.push({
      level: head.level,
      text: head.text,
      frames: head.frames,
      timestamp: options.timestamp,
      scenarioId: options.scenarioId ?? null,
      stepIndex: options.stepIndex ?? null,
      checkpointId: null,
    });
    head = null;
  };

  for (const raw of chunk.text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;

    const frame = parseStackFrameLine(line);
    if (frame !== null) {
      if (head === null) {
        // An orphan frame block: the head scrolled out of this capture. The frames are
        // still evidence; the synthesized head says exactly what happened to it.
        head = {
          text: '(stack continuation — the owning message was not in this capture)',
          frames: [],
          level: classifyLevel('', chunk.stream),
        };
      }
      head.frames.push(frame);
      continue;
    }

    if (head !== null && (head.frames.length > 0 || isContinuation(line)) && isContinuation(line)) {
      head.text += `\n${line}`;
      continue;
    }

    flush();
    head = { text: line, frames: [], level: classifyLevel(line, chunk.stream) };
  }
  flush();
  return entries;
}

/**
 * Captures both streams of one scenario step in order (stdout first, then stderr —
 * interleaving across streams is not reconstructible after the fact, and pretending to a
 * finer ordering than the pipes preserved would be invented precision).
 */
export function captureProcessOutput(
  streams: readonly CapturedStream[],
  options: CaptureOptions,
): RawConsoleEntry[] {
  const entries: RawConsoleEntry[] = [];
  for (const chunk of streams) entries.push(...captureStream(chunk, options));
  return entries;
}
