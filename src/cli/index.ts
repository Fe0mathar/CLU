/**
 * CLUE command line interface.
 *
 * Spec: CLUE_Architecture_v9 (the CLI is a veneer over services; capability-bounded authority).
 * Backlog: DEV-P1-07 — a closed command-authority registry with read-only and mission defaults.
 *          Authority now lives in one reviewable table (./commandAuthority.ts) and is enforced by a
 *          single pre-action hook, so no command can run undeclared. Remaining under this item:
 *          decomposing this file into per-domain modules.
 *
 * Revision 4 — `clue task export` uses `TaskQueue.claimById`. Revision 3 searched for a
 * named task by repeatedly claiming whatever the queue offered and expiring the leases
 * it did not want, which wrote a spurious attempt record onto every task it passed over.
 * The queue grew the operation; this consumes it.
 *
 * Everything below is argument handling, one service call, and printing. When a command
 * starts containing logic, the logic belongs in a service, because the daemon and the
 * future service API will need it and neither of them reads argv.
 *
 * The loop this makes possible, end to end and by hand:
 *
 *     clue snapshot             capture the canonical tree
 *     clue recognize            units, edges, classification, coverage
 *     clue metrics              families, ranking, candidates
 *     clue candidates           what is worth spending a proof on
 *     clue task from-candidate  turn one into durable work
 *     clue task export          a portable packet to run in a session
 *     clue task import          validated, integrated, or refused with a reason
 *
 * That is Systematic Multithreading with the Creator as the transport. Stage D2 replaces
 * the transport and nothing else.
 */

import { realpathSync } from 'node:fs';

import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { withRuntimeAsync } from '../control/runtime.js';
import { serveConsole } from '../daemon/consoleServe.js';
import { startClueDashboard } from '../daemon/clueDashboardServer.js';
import { registerConsoleCommands } from './consoleCommands.js';
import { registerStatusCommands } from './commands/statusCommands.js';
import { registerTaskCommands } from './commands/taskCommands.js';
import { registerInitCommand } from './commands/initCommands.js';
import { registerDoctorCommand } from './commands/doctorCommands.js';
import { registerRecognizeCommand } from './commands/recognizeCommands.js';
import { registerDocsCommands } from './commands/docsCommands.js';
import { registerEpochCommands } from './commands/epochCommands.js';
import { registerCycleCommands } from './commands/cycleCommands.js';
import { registerBenchmarkCommands } from './commands/benchmarkCommands.js';
import { registerProofCommand } from './commands/proofCommands.js';
import { registerGatewayCommands } from './commands/gatewayCommands.js';
import { registerSnapshotCommands } from './commands/snapshotCommands.js';
import { registerGraphCommands } from './commands/graphCommands.js';
import { registerMetricsCommands } from './commands/metricsCommands.js';
import { registerCandidatesCommands } from './commands/candidatesCommands.js';
import { registerClaimsCommands } from './commands/claimsCommands.js';
import { registerConflictsCommands } from './commands/conflictsCommands.js';
import { registerSeedsCommands } from './commands/seedsCommands.js';
import { registerAuditCommands } from './commands/auditCommands.js';
import { registerMissionCommands } from './commands/missionCommands.js';
import { registerProjectCommands } from './commands/projectCommands.js';

import { requireAuthority } from './commandAuthority.js';
import { setActiveCommandMissionRequirement } from '../shared/commandContext.js';
import { write } from './output/formatter.js';



/* ------------------------------------------------------------------------- */
/* Reporting — owned by ./output/formatter.ts (Directory §7)                  */
/* ------------------------------------------------------------------------- */

// DEV-P1-07: these lived here and, separately, in consoleCommands.ts. Two copies of a
// formatter had already drifted to different label widths; the shared owner keeps both
// historical widths visible as one decision rather than two accidents.

/** Most recent canonical snapshot, or a clear failure. */






















/* ------------------------------------------------------------------------- */
/* Program                                                                    */
/* ------------------------------------------------------------------------- */

/** The full command path as declared in the authority registry, e.g. `task export`. */
function commandPathOf(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current !== null && current.parent !== null) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ');
}

/** Refuses to run a command the closed authority registry does not declare (DEV-P1-07). */
function assertDeclaredAuthority(commandPath: string): void {
  // DEV-P1-36 flip (D4): the declaration is consumed — its mission requirement becomes the
  // default gate for this dispatch (an explicit withRuntime option still wins).
  setActiveCommandMissionRequirement(requireAuthority(commandPath).requiresMission);
}

/* ------------------------------------------------------------------------- */
/* console serve — the one command body that cannot live in ./commands/       */
/* ------------------------------------------------------------------------- */

/*
 * DEV-P1-34: this block was inside `buildProgram`.
 *
 * A bulk edit in session 1 removed the composer's opening lines and left the interface and
 * the command body enclosed by it. TypeScript permits declarations inside a function body, so
 * the tree compiled and the suite stayed green while `index.ts` said something false about
 * itself: ADR-0003 gives the composer no bodies to own, and a fifty-line one was living in it.
 *
 * It also weakened the conformance check rather than tripping it.
 * `cli-layout-conformance.test.ts` matches `^function` at column zero and excludes
 * `commandConsoleServe` by name; the damage happened to leave the body unindented, so the
 * exclusion covered it. Indented by one level it would have left the check's sight entirely.
 *
 * Restored to module scope. Nothing about the command changed — the same declarations in the
 * same order, one nesting level out.
 */

interface ConsoleServeCliOptions {
  readonly operator: string;
  readonly host?: string;
  readonly port?: string;
  readonly refresh: string;
  readonly missionTitle?: string;
}

/**
 * Runs the read-only console server until interrupted.
 *
 * Opens the runtime WITHOUT the event-log writer lock: the console only reads durable
 * state, and a live dashboard must never lock out a concurrent `recognize`. The runtime is
 * held open for the server's whole life and disposed by withRuntimeAsync only after the
 * server stops — never while it runs, which would drop the lock under a live process.
 */
async function commandConsoleServe(options: ConsoleServeCliOptions): Promise<number> {
  const refreshIntervalMs = Number.parseInt(options.refresh, 10);
  if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs < 0) {
    throw new Error(`--refresh must be a non-negative integer (milliseconds); got "${options.refresh}".`);
  }

  return withRuntimeAsync({ withLog: false }, async (runtime) => {
    const handle = await serveConsole(runtime, {
      operator: options.operator,
      refreshIntervalMs,
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: Number.parseInt(options.port, 10) } : {}),
      ...(options.missionTitle !== undefined ? { missionTitle: options.missionTitle } : {}),
    });

    write('CLUE console — read-only, live.');
    write(`  snapshot  ${handle.urls.snapshot}`);
    write(`  events    ${handle.urls.events}`);
    write(`  status    ${handle.urls.status}`);
    write(
      refreshIntervalMs > 0
        ? `Publishing revision ${handle.initialRevision}; re-deriving every ${refreshIntervalMs} ms. Ctrl-C to stop.`
        : `Publishing revision ${handle.initialRevision}; polling disabled. Ctrl-C to stop.`,
    );

    await new Promise<void>((resolve) => {
      const onSignal = (): void => resolve();
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    });

    write('\nStopping console server…');
    await handle.stop();
    return 0;
  });
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('clue')
    .description('CLU-E — evidence-based improvement system for a registered target program')
    .version('0.1.0')
    .showHelpAfterError();

  // DEV-P1-07: one hook, checked before every action, rather than a check repeated per command.
  // A command absent from the closed authority registry fails here instead of running with whatever
  // authority the surrounding code happened to have — so adding a command without deciding what it
  // may do is a startup failure, not a silent grant.
  program.hook('preAction', (_thisCommand, actionCommand) => {
    assertDeclaredAuthority(commandPathOf(actionCommand));
  });

  registerConsoleCommands(program);
  registerProjectCommands(program);

  // DEV-P1-07: `init` and `doctor` live in ./commands/ (Directory §7 names both).
  registerInitCommand(program);
  registerDoctorCommand(program);

  // DEV-P1-07 / ADR-0003: one module per command domain, named for the domain as the
  // operator types it. `index.ts` composes the program and owns nothing else.
  registerDocsCommands(program);
  registerEpochCommands(program);
  registerCycleCommands(program);
  registerBenchmarkCommands(program);
  registerProofCommand(program);
  registerGatewayCommands(program);
  registerSnapshotCommands(program);
  registerGraphCommands(program);
  registerMetricsCommands(program);
  registerCandidatesCommands(program);
  registerClaimsCommands(program);
  registerConflictsCommands(program);
  registerSeedsCommands(program);
  registerAuditCommands(program);
  registerMissionCommands(program);
  registerRecognizeCommand(program);
  registerStatusCommands(program);
  registerTaskCommands(program);


  // The operational-console patch owns the single `console` command group
  // (registerConsoleCommands, above). The dashboard snapshot server attaches its `serve`
  // subcommand to that same group rather than declaring a second `console` — commander
  // rejects a duplicate group, and one namespace for every console subcommand is correct.
  const consoleGroup =
    program.commands.find((command) => command.name() === 'console') ??
    program.command('console').description('read-only console');
  consoleGroup
    .command('dashboard')
    .description('serve the unified four-quadrant CLU-E dashboard (single page, single port)')
    .option('--operator <name>', 'operator identity shown in the console', 'operator')
    .option('--host <host>', 'bind host (default 127.0.0.1)')
    .option('--port <number>', 'bind port (default 47900)')
    .option('--refresh <ms>', 'sealed-frame re-derive cadence in ms', '1000')
    .option('--mission-title <title>', 'display title for the mission')
    .action(async (options: ConsoleServeCliOptions) => {
      process.exitCode = await runGuardedAsync(async () => {
        const refreshIntervalMs = Number.parseInt(options.refresh, 10);
        if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs < 0) {
          throw new Error(`--refresh must be a non-negative integer (milliseconds); got "${options.refresh}".`);
        }
        return withRuntimeAsync({ withLog: false }, async (runtime) => {
          const handle = await startClueDashboard(runtime, {
            operator: options.operator,
            refreshIntervalMs,
            ...(options.host !== undefined ? { host: options.host } : {}),
            ...(options.port !== undefined ? { port: Number.parseInt(options.port, 10) } : {}),
            ...(options.missionTitle !== undefined ? { missionTitle: options.missionTitle } : {}),
          });
          write('CLU-E dashboard — four quadrants, one sealed snapshot.');
          write(`  open   ${handle.url}`);
          write('Start CLU-E from the dashboard. Ctrl-C here stops the server.');
          await new Promise<void>((resolveSignal) => {
            process.once('SIGINT', () => resolveSignal());
            process.once('SIGTERM', () => resolveSignal());
          });
          write('\nStopping dashboard…');
          await handle.stop();
          return 0;
        });
      });
    });

  consoleGroup
    .command('serve')
    .description('serve the live, read-only console snapshot and event stream')
    .option('--operator <name>', 'operator identity shown in the console', 'operator')
    .option('--host <host>', 'bind host (default 127.0.0.1)')
    .option('--port <number>', 'bind port (default 47832)')
    .option('--refresh <ms>', 're-derive cadence in ms; 0 disables polling', '1000')
    .option('--mission-title <title>', 'display title for the mission')
    .action(async (options: ConsoleServeCliOptions) => {
      process.exitCode = await runGuardedAsync(() => commandConsoleServe(options));
    });

  return program;
}

export function main(argv: readonly string[]): void {
  // parseAsync so the one long-lived async action (console serve) is awaited; synchronous
  // actions run exactly as before.
  void buildProgram().parseAsync([...argv]);
}

/**
 * Prints failures as one clear line rather than a stack trace.
 *
 * Every error raised at this layer is a validation failure naming its paths, a boundary
 * denial naming its code, or a runtime error naming what was missing. All three are more
 * useful than the frames that produced them.
 */
function runGuarded(work: () => number): number {
  try {
    return work();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

/**
 * Async form of {@link runGuarded}, for the one long-lived command (console serve) whose
 * work is a promise. Same contract: one clear line on failure, exit code 1.
 */
async function runGuardedAsync(work: () => Promise<number>): Promise<number> {
  try {
    return await work();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

/**
 * Runs only when invoked as the entry point.
 *
 * Real paths are compared so the npm bin shim — a symlink on POSIX, a shim script on
 * Windows — still resolves, while importing the module does not execute a command line.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // On Windows, the native lookup can resolve an allowed file through ancestors
    // whose metadata the process cannot read during a JavaScript path walk.
    const realpath = process.platform === 'win32' ? realpathSync.native : realpathSync;
    return realpath(entry) === realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv);
}