/**
 * `clue cycle` — the cycle domain (DEV-P2-08 S5; cycle-implementation-plan v1 §5, accepted
 * 2026-08-10 with D1–D5).
 *
 * Layout: ADR-0003 rev 2 — one module per domain, argument handling, one service call,
 * printing. The plan's S5 named `open|status|advance|suspend|resume`; `drive` supersedes
 * `open` and raw `advance` deliberately: the orchestrator's loop is the safe surface (it
 * opens when nothing is live, locks, and advances only along seams that exist), while a
 * hand-driven `advance` would invite arrows whose evidence nobody produced. The registry
 * would refuse those anyway — but a surface that invites refusals it could design away is
 * a worse surface.
 *
 * ## The D4 flip, visible here
 *
 * None of these commands passes `requireMission` to `withRuntime`. The mutating three are
 * gated purely by their `commandAuthority` declarations through the DEV-P1-36 flip — the
 * first commands whose mission gate flows from the registry alone. `cycle status` is
 * declared exempt like `status`/`doctor`: a pure read that emits nothing, so a drifted
 * basis can still be inspected.
 */

import type { Command } from 'commander';

import { findRepoRoot, loadConfig, withRuntime } from '../../control/runtime.js';
import {
  performBenchmarkRun,
  verifyLockedContract,
  type PerformedRun,
} from '../../control/benchmarkRun.js';
import { CycleOrchestrator } from '../../cycle/cycleOrchestrator.js';
import { readCurrentCycle } from '../../cycle/cycleRegistry.js';
import { hashCanonicalJson, requireSha256 } from '../../shared/ids.js';
import { resolveNavigatorPath } from './recognizeCommands.js';
import { printChecks, short, write, type Check } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue cycle status                                                          */
/* ------------------------------------------------------------------------- */

function commandCycleStatus(): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const cycle = readCurrentCycle(runtime.projections);
    if (cycle === null) {
      write('No cycle in progress. `clue cycle drive` opens one.');
      return 0;
    }
    const checks: Check[] = [
      { level: 'ok', label: 'cycle', detail: cycle.id },
      { level: 'info', label: 'mission', detail: cycle.mission_version },
      {
        level: cycle.stage === 'SUSPENDED' ? 'warn' : 'ok',
        label: 'stage',
        detail:
          cycle.stage +
          (cycle.suspended_from === null ? '' : ` (suspended from ${cycle.suspended_from})`),
      },
      {
        level: 'info',
        label: 'grade',
        detail: cycle.grade === null ? 'not locked yet' : cycle.grade,
      },
      {
        level: 'info',
        label: 'lock digest',
        detail: cycle.lock_digest ?? 'none',
      },
      { level: 'info', label: 'opened', detail: cycle.opened_at },
    ];
    printChecks(checks);
    return 0;
  });
}

/* ------------------------------------------------------------------------- */
/* clue cycle drive                                                           */
/* ------------------------------------------------------------------------- */

interface CycleDriveOptions {
  readonly navigator?: boolean;
  readonly expectRuntime?: string;
  readonly verifyRecovery?: boolean;
}

function commandCycleDrive(options: CycleDriveOptions): number {
  const verifyRecovery = options.verifyRecovery === true;
  return withRuntime({
    withLog: true,
    verifyLog: verifyRecovery ? 'full' : 'tail',
    measureEventAppends: verifyRecovery,
    allowStaleHeartbeatReclaim: !verifyRecovery,
    // Recovery must first restore a verified lagging projection before checking mission authority.
    ...(verifyRecovery ? { requireMission: false } : {}),
  }, (runtime) => {
    if (options.expectRuntime !== undefined && options.expectRuntime !== hashCanonicalJson([
      runtime.config.project.root,
      runtime.workspaceRoot,
      runtime.projectBinding?.recognition.identity ?? null,
    ])) {
      throw new Error('Active project or workspace changed after the dashboard started. Restart the dashboard before driving a cycle.');
    }
    if (verifyRecovery) {
      if (runtime.log === null) throw new Error('Cycle recovery requires the event-log writer.');
      runtime.projections.catchUpVerified(runtime.log);
      runtime.requireFreshProjections();
      runtime.requireMission();
    }
    const orchestrator = new CycleOrchestrator(runtime);
    const result = orchestrator.drive(resolveNavigatorPath(
      options.navigator === true, undefined, runtime.repoRoot, runtime.workspaceRoot,
    ), { verifyRecovery });
    if (result.performed.length === 0) {
      write(`Cycle ${result.cycle.id} already at ${result.cycle.stage}; nothing to drive.`);
    } else {
      if (result.lock !== null) {
        write(
          `locked ${result.lock.grade} — ${result.lock.absent.length} absence(s): ` +
            result.lock.absent.join('; '),
        );
      }
      printChecks(
        result.performed.map((step) => ({
          level: 'ok' as const,
          label: step.to,
          detail:
            step.summary + (step.evidence === null ? '' : `  [evidence ${short(step.evidence.hash)}]`),
        })),
      );
      write('');
      write(`Cycle ${result.cycle.id} at ${result.cycle.stage} (${result.cycle.grade ?? 'ungraded'}).`);
    }
    if (verifyRecovery) {
      write(JSON.stringify({ eventAppends: runtime.log?.appendTiming() ?? null }));
    }
    return 0;
  });
}

/* ------------------------------------------------------------------------- */
/* clue cycle suspend / resume                                                */
/* ------------------------------------------------------------------------- */

function commandCycleSuspend(reason: string): number {
  return withRuntime({ withLog: true, verifyLog: 'tail' }, (runtime) => {
    const cycle = new CycleOrchestrator(runtime).suspend(reason);
    write(`Cycle ${cycle.id} suspended from ${cycle.suspended_from ?? '?'} — ${reason}`);
    return 0;
  });
}

function commandCycleResume(): number {
  return withRuntime({ withLog: true, verifyLog: 'tail' }, (runtime) => {
    const cycle = new CycleOrchestrator(runtime).resume();
    write(`Cycle ${cycle.id} resumed at ${cycle.stage}.`);
    return 0;
  });
}

function commandCycleRestart(
  cycleId: string,
  options: { readonly expectMission: string; readonly expectLock: string },
): number {
  const lockDigest = requireSha256(options.expectLock, '--expect-lock');
  return withRuntime({
    withLog: true, verifyLog: 'full', allowStaleHeartbeatReclaim: false, requireMission: false,
  }, (runtime) => {
    runtime.projections.catchUpVerified(runtime.requireLog());
    const { cycle, created } = new CycleOrchestrator(runtime).restart({
      cycleId, missionVersion: options.expectMission, lockDigest,
    });
    write(`${cycleId} ${created ? 'superseded' : 'already superseded'} by ${cycle.id} under ${cycle.mission_version}.`);
    write(`Cycle ${cycle.id} at ${cycle.stage} (${cycle.grade ?? 'ungraded'}).`);
    return 0;
  });
}

/* ------------------------------------------------------------------------- */
/* clue cycle close                                                           */
/* ------------------------------------------------------------------------- */

export async function commandCycleClose(repoRoot = findRepoRoot()): Promise<number> {
  // Phase 0 — read what closing requires; this lock window opens and closes here.
  let cycleId: string;
  let lockedBenchmark: { readonly path: string; readonly sha256: string } | null;
  let missionVersion: string;
  try {
    ({ cycleId, lockedBenchmark, missionVersion } = withRuntime({ repoRoot, withLog: true, verifyLog: 'tail' }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      const cycle = orchestrator.status();
      if (cycle === null) throw new Error('No cycle in progress to close.');
      return {
        cycleId: cycle.id,
        lockedBenchmark: cycle.stage === 'SCREENED' ? orchestrator.lockedBenchmarkOf(cycle.id) : null,
        missionVersion: runtime.currentMissionId(),
      };
    }));
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Phase 1 — the §18 closing run, UNLOCKED: the harness drives `clue` as children and
  // they take the writer lock per act (the B4 inversion, shared via benchmarkRun.ts).
  let performed: PerformedRun | null = null;
  if (lockedBenchmark !== null) {
    const config = loadConfig(repoRoot);
    const verified = verifyLockedContract(config.project.root, lockedBenchmark);
    if ('error' in verified) {
      write(verified.error);
      return 1;
    }
    write(`Cycle ${cycleId}: performing the §18 closing run against the locked contract…`);
    performed = await performBenchmarkRun({
      repoRoot,
      config,
      contract: { path: verified.path, registered: true },
      expectedContractSha256: lockedBenchmark.sha256,
      expectedMissionVersion: missionVersion,
      log: (line) => write(`  … ${line}`),
    });
    if (!performed.outcome.ok) {
      write(`REFUSED at ${performed.outcome.stage}: ${performed.outcome.reason}`);
      return 1;
    }
  }

  // Phase 2 — locked: the walk records the run (or the stated absence) and closes.
  const closingRun = performed;
  return runGuarded(() =>
    withRuntime({ repoRoot, withLog: true, verifyLog: 'tail' }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      if (orchestrator.status()?.id !== cycleId || runtime.currentMissionId() !== missionVersion) {
        throw new Error(`Cycle ${cycleId} or its mission changed while preparing closure. Rerun \`clue cycle close\` for the current cycle.`);
      }
      const result = orchestrator.close(closingRun);
      printChecks(
        result.performed.map((step) => ({
          level: 'ok' as const,
          label: step.to,
          detail:
            step.summary + (step.evidence === null ? '' : `  [evidence ${short(step.evidence.hash)}]`),
        })),
      );
      write('');
      write(`Cycle ${result.cycle.id} CLOSED (${result.cycle.grade ?? 'ungraded'}) at ${result.cycle.closed_at ?? '?'}.`);
      return 0;
    }),
  );
}

/** Registers the `cycle` commands. */
export function registerCycleCommands(program: Command): void {
  const cycle = program.command('cycle').description('the RPI cycle stage machine');
  cycle
    .command('status')
    .description('the current cycle, its stage and grade')
    .action(() => {
      process.exitCode = runGuarded(() => commandCycleStatus());
    });
  cycle
    .command('drive')
    .description('advance the cycle to SCREENED through lock, snapshot, recognition and screening')
    .option('--navigator', 'publish the recognition stream to the workspace Navigator')
    .option('--expect-runtime <hash>', 'refuse if the project and workspace binding differ from the caller')
    .option('--verify-recovery', 'verify the cycle and its evidence before continuing an interrupted drive')
    .action((options: CycleDriveOptions) => {
      process.exitCode = runGuarded(() => commandCycleDrive(options));
    });
  cycle
    .command('suspend')
    .description("record the operator's suspension of the current cycle")
    .requiredOption('--reason <text>', 'why the cycle is being suspended')
    .action((options: { reason: string }) => {
      process.exitCode = runGuarded(() => commandCycleSuspend(options.reason));
    });
  cycle
    .command('close')
    .description('close the cycle: the §18 run when the lock names a benchmark, handoff, §24 honest')
    .action(async () => {
      process.exitCode = await commandCycleClose();
    });
  cycle
    .command('resume')
    .description('return a suspended cycle to the stage it remembers')
    .action(() => {
      process.exitCode = runGuarded(() => commandCycleResume());
    });
  cycle
    .command('restart <cycle-id>')
    .description('preserve a screened diagnostic cycle as history and open a new cycle for its successor mission')
    .requiredOption('--expect-mission <mission-id>', 'require this exact current successor mission')
    .requiredOption('--expect-lock <sha256>', 'require the complete lock digest from cycle status')
    .action((cycleId: string, options: { expectMission: string; expectLock: string }) => {
      process.exitCode = runGuarded(() => commandCycleRestart(cycleId, options));
    });
}
