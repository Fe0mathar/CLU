/**
 * Scenario runner — the target exercised, its diagnostics into the ledger (DEV-P2-10, G2).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §7 (evidence coverage for screening) and §8 (runtime
 *       failures among a hypothesis's inputs); `CLUE_Project_Directory_v9.md` §16 —
 *       `consoleLedger.ts` is the single owner of console evidence, and this runner is a
 *       *supplier* to it, never a second ledger.
 *
 * ## Where scenarios come from — decided from what the config already governs
 *
 * `config.runtime.scripts` is a governed, mission-bound map of approved command lines
 * (the schema requires `typecheck` and `build`; the record is open, so an installation
 * adds scenarios by adding entries — one config edit, already under the mission basis,
 * no new registration surface invented). Measured fact: **nothing executes these scripts
 * today** — the schema reserves them for the proof engine — so this module is their
 * first executor and the semantics are set here: each entry is one scenario, its name is
 * the `scenarioId`, and its value is a *simple* command line split on whitespace. A
 * value carrying shell quoting or operators is refused into `skipped` with the reason
 * stated, because guessing a shell dialect cross-platform is how a command runs
 * differently than it was reviewed. Direct CLU-E invocations are refused too: this
 * runner owns the writer lock, so a child `clue` process would deadlock against it.
 *
 * ## The evidence path — one authority, end to end
 *
 * Per scenario: `ledger.beginSession({snapshotId, scenarioId, origin: 'shadow'})` → the
 * child runs with the target as cwd → `captureProcessOutput` folds both streams into
 * `RawConsoleEntry[]` → one `ingest`, which attributes every entry through the **Node
 * attributor** built over the committed graph's units for this snapshot, dedups into
 * signatures, and finalizes the session. A failing script still ingests — a nonzero exit
 * with a stack on stderr is precisely the observed evidence this stage exists to
 * collect; the receipt records the code and the run moves on.
 *
 * `summaries()` is deliberately global (all sessions): the observed-defect family's own
 * vocabulary says "reproduced in one scenario is a report; in several, a property", and
 * logical ids are stable across snapshots by the identity grammar, so accumulation
 * across sessions is the design, not a leak.
 *
 * ## Locks, stated
 *
 * The runner holds the writer lock (the ledger appends). Scenario commands therefore
 * **must not invoke `clue`** — a child taking the writer lock against its parent is the
 * deadlock B4 inverted for the benchmark, and benchmark-shaped work belongs to that
 * seam. Toolchain commands (`npm`, `tsc`, `node` scripts) are exactly what
 * `runtime.scripts` declares and exactly what runs here.
 *
 * ## Execution primitive
 *
 * `makeExec` from the benchmark runner is reused rather than duplicated: it is the one
 * proven child-process primitive (cwd pinning, SIGTERM→SIGKILL timeouts, the Windows
 * `npm` translation). The cross-domain import is named here on purpose: when Directory
 * §16's `src/experiment/process/processRunner.ts` lands, both callers migrate to it and
 * this note is the reminder.
 */

import { basename } from 'node:path';

import type { Runtime } from '../../control/runtime.js';
import type { ClueConfig } from '../../shared/schemas.js';
import { nowIso } from '../../shared/ids.js';
import { DEFAULT_EXECUTION_POLICY, makeExec } from '../../benchmark/benchmarkRunner.js';
import { captureProcessOutput } from './nodeConsoleCapture.js';
import { makeNodeAttributor } from './nodeAttributor.js';

/** One runnable scenario: a governed script entry, argv-ready. */
export interface ScenarioSpec {
  readonly id: string;
  readonly argv: readonly string[];
  readonly timeoutSeconds?: number;
}

export interface SkippedScenario {
  readonly id: string;
  readonly reason: string;
}

/** Characters whose presence means the value needs a shell, which this runner refuses to be. */
const SHELL_SYNTAX = /["'`$;|&<>(){}\\]/;

const NODE_EXECUTABLES = new Set(['node', 'node.exe']);
const NPM_EXECUTABLES = new Set(['npm', 'npm.cmd', 'npm.exe']);
const NPX_EXECUTABLES = new Set(['npx', 'npx.cmd', 'npx.exe']);
const OTHER_PACKAGE_EXECUTABLES = new Set([
  'pnpm', 'pnpm.cmd', 'pnpm.exe', 'yarn', 'yarn.cmd', 'yarn.exe', 'bunx',
]);

function executableName(value: string): string {
  return basename(value.replace(/\\/g, '/')).toLocaleLowerCase('en-US');
}

/** True for reviewed direct shapes that would make the child acquire CLU-E's writer lock. */
export function invokesClueDirectly(argv: readonly string[]): boolean {
  const executable = executableName(argv[0] ?? '');
  const lower = argv.map((part) => part.replace(/\\/g, '/').toLocaleLowerCase('en-US'));

  if (executable === 'clue' || executable === 'clue.cmd' || executable === 'clue.exe') return true;

  if (NODE_EXECUTABLES.has(executable)) {
    const script = lower[1] ?? '';
    return (
      script === 'dist/src/cli/index.js' ||
      script.endsWith('/dist/src/cli/index.js') ||
      script === 'src/cli/index.ts' ||
      script.endsWith('/src/cli/index.ts')
    );
  }

  if (NPM_EXECUTABLES.has(executable)) {
    return (
      ((lower[1] === 'run' || lower[1] === 'run-script') && lower[2] === 'clue') ||
      (lower[1] === 'exec' && executableName(lower[2] ?? '') === 'clue')
    );
  }
  if (NPX_EXECUTABLES.has(executable)) {
    return executableName(lower[1] ?? '') === 'clue';
  }
  if (OTHER_PACKAGE_EXECUTABLES.has(executable)) {
    return (
      executableName(lower[1] ?? '') === 'clue' ||
      (lower[1] === 'run' && lower[2] === 'clue') ||
      (lower[1] === 'exec' && executableName(lower[2] ?? '') === 'clue')
    );
  }
  return false;
}

/**
 * The one grammar for a governed script command: plain argv, shell syntax refused by
 * name. Exported so the proof coordinator's §12.4 static preparation runs the *same*
 * parse as scenarios do — two parsers of one config field is how a command runs
 * differently than it was reviewed.
 */
export function parseScriptCommand(
  id: string,
  command: string,
): ScenarioSpec | SkippedScenario {
  if (SHELL_SYNTAX.test(command)) {
    return {
      id,
      reason: `command carries shell syntax (${JSON.stringify(command)}); scenarios run as plain argv — simplify the script or run it under the proof engine`,
    };
  }
  const argv = command.trim().split(/\s+/);
  if (argv.length === 0 || argv[0] === '') return { id, reason: 'empty command' };
  if (invokesClueDirectly(argv)) {
    return {
      id,
      reason:
        'command invokes clue directly; scenario execution owns the writer lock and a clue child would deadlock — use a target/toolchain script instead',
    };
  }
  return { id, argv };
}

/**
 * The governed scenario set: every `runtime.scripts` entry, name-sorted for a stable
 * run order, shell-syntax values refused by name rather than mis-run.
 */
export function scenariosFromConfig(config: ClueConfig): {
  readonly scenarios: readonly ScenarioSpec[];
  readonly skipped: readonly SkippedScenario[];
} {
  const scenarios: ScenarioSpec[] = [];
  const skipped: SkippedScenario[] = [];
  for (const [id, command] of Object.entries(config.runtime.scripts).sort(([a], [b]) => a.localeCompare(b))) {
    const parsed = parseScriptCommand(id, command);
    if ('reason' in parsed) skipped.push(parsed);
    else scenarios.push(parsed);
  }
  return { scenarios, skipped };
}

/** What one scenario left behind: the session it became, and how the child behaved. */
export interface ScenarioReceipt {
  readonly scenario_id: string;
  readonly session_id: string;
  readonly argv: readonly string[];
  readonly exit_code: number;
  readonly timed_out: boolean;
  readonly wall_ms: number;
  readonly entries_ingested: number;
  readonly signatures_touched: number;
  readonly new_signatures: number;
  readonly actionable: number;
  readonly unclassified: number;
}

export interface ScenarioRunResult {
  readonly snapshot_id: string;
  readonly receipts: readonly ScenarioReceipt[];
  readonly skipped: readonly SkippedScenario[];
  /** The ledger's summary count after this run — what the metric family will see. */
  readonly summaries_count: number;
}

export interface RunScenariosDeps {
  readonly runtime: Runtime;
  /** The committed snapshot whose units attribution joins against. */
  readonly snapshotId: string;
  /** Override the governed set (tests, or a single-scenario rerun); default reads the config. */
  readonly scenarios?: readonly ScenarioSpec[];
  /** Per-scenario timeout; scenarios are toolchain commands, so minutes, not the benchmark's half hour. */
  readonly defaultTimeoutSeconds?: number;
  readonly log?: (line: string) => void;
}

/**
 * Runs the scenario set against one committed snapshot and ingests everything observed.
 *
 * Refuses honestly when the snapshot has no committed recognition — attribution without
 * units would stamp every entry `unattributable` and call it evidence, which is worse
 * than saying "recognize first". Session identity, dedup, classification and summaries
 * all remain the ledger's; this function owns only the sequence.
 */
export async function runScenarios(deps: RunScenariosDeps): Promise<ScenarioRunResult> {
  const { runtime, snapshotId } = deps;
  const stored = runtime.requireGraph().resultOf(snapshotId);
  if (stored === null) {
    throw new Error(
      `No committed recognition for snapshot ${snapshotId.slice(0, 12)}… — run \`clue recognize\` before scenarios; ` +
        'observed evidence attributes against recognized units or it attributes against nothing.',
    );
  }

  const configured = scenariosFromConfig(runtime.config);
  const scenarios = deps.scenarios ?? configured.scenarios;
  const skipped = deps.scenarios === undefined ? configured.skipped : [];
  const timeoutSeconds = deps.defaultTimeoutSeconds ?? 600;
  const log = deps.log ?? (() => {});

  const attributor = makeNodeAttributor({
    projectRoot: runtime.config.project.root,
    units: stored.units,
  });
  const ledger = runtime.makeConsoleLedger(attributor);

  const { exec } = makeExec({
    cwd: runtime.config.project.root,
    policy: {
      ...DEFAULT_EXECUTION_POLICY,
      scenarioTimeoutSeconds: timeoutSeconds,
      maxTotalRuntimeSeconds: Math.max(timeoutSeconds * Math.max(1, scenarios.length), timeoutSeconds) + 60,
    },
  });

  const receipts: ScenarioReceipt[] = [];
  for (const scenario of scenarios) {
    log(`scenario ${scenario.id}: ${scenario.argv.join(' ')}`);
    const session = ledger.beginSession({ snapshotId, scenarioId: scenario.id, origin: 'shadow' });
    const run = await exec(scenario.argv, {
      timeoutSeconds: scenario.timeoutSeconds ?? timeoutSeconds,
    });
    const entries = captureProcessOutput(
      [
        { stream: 'stdout', text: run.stdout },
        { stream: 'stderr', text: run.stderr },
      ],
      { timestamp: nowIso(), scenarioId: scenario.id },
    );
    const ingested = ledger.ingest(session.id, entries);
    receipts.push({
      scenario_id: scenario.id,
      session_id: session.id,
      argv: scenario.argv,
      exit_code: run.code,
      timed_out: run.timedOut,
      wall_ms: Math.round(run.wallMs),
      entries_ingested: ingested.entriesIngested,
      signatures_touched: ingested.signaturesTouched,
      new_signatures: ingested.newSignatures.length,
      actionable: ingested.byClassification.actionable,
      unclassified: ingested.byClassification.unclassified,
    });
    log(
      `  ${scenario.id}: exit ${run.code}${run.timedOut ? ' (timed out)' : ''}, ` +
        `${ingested.entriesIngested} entr${ingested.entriesIngested === 1 ? 'y' : 'ies'}, ` +
        `${ingested.newSignatures.length} new signature(s)`,
    );
  }

  return {
    snapshot_id: snapshotId,
    receipts,
    skipped,
    summaries_count: ledger.summaries().length,
  };
}
