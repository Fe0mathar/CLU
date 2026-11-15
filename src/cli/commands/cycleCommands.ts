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

import { findRepoRoot, loadConfig, withProjectRuntimeSnapshot, withRuntime, type Runtime } from '../../control/runtime.js';
import {
  loadProjectProfileStartup, readActiveProjectProfileForBenchmark, resolveProjectProfilesRoot,
} from '../../control/projectProfiles/projectProfileStartup.js';
import {
  performBenchmarkRun,
  verifyLockedContract,
  type PerformedRun,
} from '../../control/benchmarkRun.js';
import { assessCurrentFindings, CycleFindingsError } from '../../control/cycleFindings.js';
import { findRecordedCycleAuthorityRecovery, inspectCycleAuthorityRecovery } from '../../cycle/cycleAuthorityRecovery.js';
import { CycleOrchestrator } from '../../cycle/cycleOrchestrator.js';
import { CycleRegistry, cycleAuthorityRecoveryConfirmation, readCurrentCycle } from '../../cycle/cycleRegistry.js';
import { hashCanonicalJson, requireSha256 } from '../../shared/ids.js';
import { redactSecretText } from '../../shared/secretSafety.js';
import { resolveNavigatorPath } from './recognizeCommands.js';
import { printChecks, short, truncate, write, type Check } from '../output/formatter.js';
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
  readonly assessFindings?: boolean;
}

export function commandCycleDrive(options: CycleDriveOptions, repoRoot = findRepoRoot()): number {
  const measureEventAppends = options.verifyRecovery === true;
  const verifyRecovery = measureEventAppends || options.assessFindings === true;
  return withRuntime({
    repoRoot,
    withLog: true,
    verifyLog: verifyRecovery ? 'full' : 'tail',
    measureEventAppends,
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
    let exitCode = 0;
    if (options.assessFindings === true) {
      let decision: {
        outcome: 'SELECTED' | 'NO_CANDIDATE' | 'BLOCKED';
        eventId: string | null;
        code: string | null;
        cycleId: string;
        reason: string;
      };
      try {
        // The assessor owns the profile, mission, stage, and source checks. It reuses a
        // receipt only after verifying the exact screened inputs under this writer lock.
        const receipt = assessCurrentFindings(runtime);
        decision = { outcome: receipt.outcome, eventId: receipt.eventId, code: null,
          cycleId: receipt.cycleId, reason: receipt.reason };
      } catch (error) {
        const known = error instanceof CycleFindingsError;
        decision = { outcome: 'BLOCKED', eventId: null,
          code: known ? error.code : 'FINDINGS_WORKSPACE_UNAVAILABLE', cycleId: result.cycle.id,
          reason: known ? error.message : 'The current workspace or its governed evidence could not be verified.' };
        exitCode = 1;
      }
      decision.reason = truncate(runtime.secrets.redact(decision.reason).replace(/[\x00-\x1f\x7f]/gu, ' '), 600);
      write(JSON.stringify({ cycleFindings: decision }));
      write(`Findings ${decision.outcome} · ${decision.eventId ?? decision.code} · ${decision.reason}`);
    }
    if (measureEventAppends) {
      write(JSON.stringify({ eventAppends: runtime.log?.appendTiming() ?? null }));
    }
    return exitCode;
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

function commandCycleSupersede(
  cycleId: string,
  options: { readonly expectMission: string; readonly expectLock: string; readonly reason: string; readonly confirmation: string },
): number {
  const lockDigest = requireSha256(options.expectLock, '--expect-lock');
  return withRuntime({
    withLog: true, verifyLog: 'full', allowStaleHeartbeatReclaim: false, requireMission: false,
  }, (runtime) => {
    runtime.projections.catchUpVerified(runtime.requireLog());
    const { cycle, created } = new CycleOrchestrator(runtime).supersede({
      cycleId, missionVersion: options.expectMission, lockDigest,
      reason: options.reason, confirmation: options.confirmation,
    });
    write(`${cycleId} ${created ? 'superseded' : 'already superseded'} by ${cycle.id} under ${cycle.mission_version}.`);
    write(`Cycle ${cycle.id} at ${cycle.stage} (${cycle.grade ?? 'ungraded'}).`);
    return 0;
  });
}

function commandCycleRecoverAuthority(
  cycleId: string,
  options: { readonly expectMission: string; readonly expectLock: string; readonly confirmation?: string },
): number {
  const schemaVersion = 'clue-cycle-authority-recovery/1';
  const previousCycleId = cycleId;
  try {
    if (!/^CYCLE-\d{6,}$/u.test(cycleId) || !/^MISSION-\d{6,}$/u.test(options.expectMission)) {
      throw new Error('Supply exact cycle and mission IDs.');
    }
    const expected = { cycleId, missionVersion: options.expectMission, lockDigest: requireSha256(options.expectLock, '--expect-lock') };
    const repoRoot = findRepoRoot();
    const profile = readActiveProjectProfileForBenchmark(repoRoot);
    const selector = loadProjectProfileStartup(repoRoot);
    if (profile === null || selector === null) throw new Error('Activate a saved Project Profile before cycle authority recovery.');
    const verifyProfile = () => {
      const active = readActiveProjectProfileForBenchmark(repoRoot);
      if (active?.profile.projectId !== profile.profile.projectId || active.generation !== profile.generation ||
          active.projectProfileHash !== profile.projectProfileHash) {
        throw new Error('The active Project Profile changed. Start a new review.');
      }
    };
    const preview = (runtime: Runtime) => {
      const existing = findRecordedCycleAuthorityRecovery(runtime, expected);
      if (existing !== null) {
        return { state: 'ALREADY_RECOVERED', successor: existing.successor, eventId: existing.event.id, eventSha256: existing.event.hash };
      }
      const evidence = inspectCycleAuthorityRecovery(runtime, expected);
      return { state: 'PREVIEW', evidence, confirmation: cycleAuthorityRecoveryConfirmation(expected, evidence) };
    };
    const confirmation = options.confirmation;
    const result = confirmation === undefined
      ? withProjectRuntimeSnapshot(profile, repoRoot, resolveProjectProfilesRoot(repoRoot, selector.profiles.registry_root), preview)
      : withRuntime({ repoRoot, projectProfile: profile, withLog: true, verifyLog: 'full',
        requireMission: false, allowStaleHeartbeatReclaim: false }, (runtime) => {
        const log = runtime.requireLog();
        runtime.projections.catchUpVerified(log);
        runtime.requireFreshProjections();
        runtime.requireMission();
        verifyProfile();
        const registry = new CycleRegistry({ log, projections: runtime.projections, missionVersion: runtime.currentMissionId });
        const { state, event, successor } = registry.recoverAuthority(expected, confirmation,
          () => inspectCycleAuthorityRecovery(runtime, expected));
        return { state, successor, eventId: event.id, eventSha256: event.hash };
      });
    if (confirmation === undefined) verifyProfile();
    write(JSON.stringify({ schemaVersion, previousCycleId, ...result }));
    return 0;
  } catch (error) {
    const reason = redactSecretText(error instanceof Error ? error.message : String(error)).text.slice(0, 2048);
    write(JSON.stringify({ schemaVersion, previousCycleId, state: 'BLOCKED', reason }));
    return 1;
  }
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
    .option('--assess-findings', 'record the evidence-bound findings decision after screening')
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
  cycle
    .command('supersede <cycle-id>')
    .description('preserve an unaccepted proof-authoritative cycle and open a new cycle over changed target inputs')
    .requiredOption('--expect-mission <mission-id>', 'require this exact current mission')
    .requiredOption('--expect-lock <sha256>', 'require the complete predecessor lock digest')
    .requiredOption('--reason <text>', 'record the Creator reason for replacing this cycle')
    .requiredOption('--confirmation <text>', 'require SUPERSEDE <cycle-id> <mission-id> <full-lock-digest>')
    .action((cycleId: string, options: Parameters<typeof commandCycleSupersede>[1]) => {
      process.exitCode = runGuarded(() => commandCycleSupersede(cycleId, options));
    });
  cycle
    .command('recover-authority <cycle-id>')
    .description('preview or explicitly recover a screened cycle that locked invalid mission authority')
    .requiredOption('--expect-mission <mission-id>', 'require the exact current mission recorded on the predecessor')
    .requiredOption('--expect-lock <sha256>', 'require the complete predecessor lock digest')
    .option('--confirmation <text>', 'apply the exact RECOVER AUTHORITY confirmation from the read-only preview')
    .action((cycleId: string, options: Parameters<typeof commandCycleRecoverAuthority>[1]) => {
      process.exitCode = commandCycleRecoverAuthority(cycleId, options);
    });
}
