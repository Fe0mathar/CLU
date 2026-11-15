/**
 * Cycle orchestrator — the driver (DEV-P2-08 S4, completed by S4b).
 *
 * Spec: `CLUE_Project_Directory_v9.md` §18.2 ("invokes recognition, screening, …; does not
 *       absorb logic"); `docs/cycle-implementation-plan_v1.md` §3/§5, accepted 2026-08-10.
 *
 * ## The one rule
 *
 * The orchestrator advances the stage machine by invoking domain services and recording
 * each advance with its evidence. It holds no domain logic and no state of its own — the
 * registry owns legality, the lock owns honesty, `runRecognition` owns the recognition
 * run, and the metrics seams (`computeAllMetrics`, `rank`, the registry's `record`s) own
 * screening exactly as `clue metrics` invokes them.
 *
 * ## The S4 halt, honoured and retired
 *
 * S4 shipped `drive()` halting before RECOGNIZED with the missing recognition seam named
 * as a return value. S4a extracted that seam (`src/control/recognitionRun.ts`); this
 * revision replaces the halt with the seam it named, and the drive now reaches SCREENED.
 * The design survives the halt: `drive()` is a loop over stage-keyed steps, so it
 * **resumes** a cycle from whatever live stage it rests at — including the very cycle the
 * S4 halt honestly parked — and each step records its own evidence artifact before the
 * registry moves the arrow. A SUSPENDED cycle is refused here: suspension is an operator's
 * act about time, and only the operator's resume undoes it.
 *
 * ## What each stage's evidence pins
 *
 *   OPENING_EVIDENCE   the canonical snapshot's identity and census, plus the lock digest
 *   RECOGNIZED         the recognition run — snapshot/capture/run ids, result hash, counts,
 *                      and any mid-run notices (the oracle-divergence fallback, verbatim)
 *   SCREENED           the measurement record and ranking census — values stored, corpus
 *                      size, candidate/instrumentation/clarification/excluded counts, and
 *                      the families that were unavailable, named
 */

import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import type { Runtime } from '../control/runtime.js';
import { runRecognition } from '../control/recognitionRun.js';
import {
  assertBenchmarkRunSubject,
  BENCHMARK_EVENT_TYPES,
  captureBenchmarkExecutableInputs,
  verifyLockedContract,
  type PerformedRun,
} from '../control/benchmarkRun.js';
import { requireProofExecutionBoundary } from '../benchmark/restrictedExecution.js';
import { isCompleteCluBenchmarkV020 } from '../benchmark/benchmarkRunner.js';
import { captureSnapshot, snapshotManifestSchema } from '../analysis/source/snapshot.js';
import { assertExactRunInputs, captureExactRunInputs } from '../control/exactRunInputs.js';
import { isBenchmarkProfileContract } from '../control/projectProfiles/benchmarkProfileInputs.js';
import { resolveProjectRecognition } from '../control/projectProfiles/projectRecognition.js';
import { observeLocalLandingBase, type LocalLandingBase } from '../integration/git/landableProofBasis.js';
import {
  PROOF_EVENT_TYPES,
  freezeProofContract,
} from '../proof/proofContract.js';
import {
  assessBaselineValidity,
  captureBaseline,
  type BaselinePackage,
} from '../proof/baselineRegistry.js';
import { decideWithMatchedControl, type DeterministicVerdict } from '../proof/verdict.js';
import { buildGreatBookEntry, type GreatBookRecording } from '../greatBook/greatBookEntry.js';
import {
  executeMatchedProofControl,
  executeProofPlan,
  type PatchOperation,
  type ProofExecutionDeps,
  type ProofExecutionRefusalStage,
} from '../experiment/proof/executionCoordinator.js';

/** What the candidate arm returns: a verdict recorded, or a named refusal. */
export type CandidateArmResult =
  | {
      readonly ok: true;
      readonly verdict: DeterministicVerdict;
      readonly contract_hash: Sha256;
      readonly events: { readonly frozen: string; readonly verdict: string };
      readonly artifacts: {
        readonly contract: unknown;
        readonly candidate_run: unknown;
        readonly verdict: unknown;
      };
      readonly great_book: GreatBookRecording;
    }
  | {
      readonly ok: false;
      readonly stage: 'freeze' | 'baseline' | ProofExecutionRefusalStage;
      readonly reasons: readonly string[];
      readonly evidence?: readonly string[];
      readonly recorded_event?: string;
    };
import { canonicalJson, hashCanonicalJson, nowIso, requireSha256, type Sha256 } from '../shared/ids.js';
import { computeAllMetrics, type MetricInput } from '../analysis/metrics/families.js';
import { DEFAULT_WEIGHTS, rank } from '../analysis/metrics/ranking.js';
import {
  cycleInputsLockedSchema,
  sha256Schema,
  type ArtifactRef,
  type CycleInputLock,
  type CycleRecord,
  type CycleStage,
} from '../shared/schemas.js';
import type { EventLog } from '../memory/eventLog.js';
import {
  CYCLE_EVENT_TYPES, CycleRegistry, type CycleRestartExpectation, type CycleSupersessionExpectation,
} from './cycleRegistry.js';
import { inspectCycleSupersession } from './cycleSupersession.js';
import { readCurrentCycleAuthority } from './cycleAuthority.js';
import { computeInputLock } from './cycleInputLock.js';
import { verifyResume } from './resumePlanner.js';
import { buildNextCycleVitalInput } from './nextCycleVitalInput.js';
import { compareClosingBenchmark } from './closingBenchmarkComparison.js';
import { deriveProofClosure, proofClosureUnmet, type ProofClosureState } from './proofClosure.js';

export interface DriveStep {
  readonly to: CycleStage;
  readonly evidence: ArtifactRef | null;
  readonly summary: string;
}

export interface DriveResult {
  readonly cycle: CycleRecord;
  /** The steps this call actually performed, in order — an already-SCREENED cycle performs none. */
  readonly performed: readonly DriveStep[];
  /** The lock, when this call computed it. */
  readonly lock: CycleInputLock | null;
}

const TARGET: CycleStage = 'SCREENED';
const RECOVERABLE_DRIVE_STAGES: ReadonlySet<CycleStage> = new Set([
  'OPENED', 'INPUTS_LOCKED', 'OPENING_EVIDENCE', 'RECOGNIZED',
]);

const openingCheckpointSchema = z.object({
  stage: z.literal('OPENING_EVIDENCE'),
  cycle_id: z.string(),
  lock_digest: sha256Schema,
  snapshot_id: sha256Schema,
  capture_id: sha256Schema,
});

const recognitionCheckpointSchema = z.object({
  stage: z.literal('RECOGNIZED'),
  cycle_id: z.string(),
  snapshot_id: sha256Schema,
  capture_id: sha256Schema,
  result_hash: sha256Schema,
  run_key: sha256Schema.optional(),
});

export class CycleOrchestrator {
  private readonly runtime: Runtime;
  private readonly registry: CycleRegistry;
  private readonly log: EventLog;

  public constructor(runtime: Runtime) {
    this.runtime = runtime;
    const log = runtime.log;
    if (log === null) {
      throw new Error('The cycle orchestrator needs the event log; open the runtime with one.');
    }
    this.log = log;
    this.registry = new CycleRegistry({
      log,
      projections: runtime.projections,
      // Every append re-passes the mission gate: a drifted basis refuses evidence
      // production mid-drive exactly as it refuses it anywhere else.
      missionVersion: () => {
        const mission = runtime.requireMission().current();
        if (mission === null) {
          throw new Error('No mission registered — run `clue init` before driving a cycle.');
        }
        return mission.id;
      },
    });
  }

  /** The stage machine's record of truth, for callers that only ask. */
  public status(): CycleRecord | null {
    return this.registry.current();
  }

  public restart(expected: CycleRestartExpectation): { readonly cycle: CycleRecord; readonly created: boolean } {
    this.runtime.requireFreshProjections();
    const missions = this.runtime.requireMission();
    const current = missions.requireCurrent();
    const previous = this.registry.get(expected.cycleId);
    const refusal = 'Restart requires the exact current mission to supersede the selected cycle mission through recorded successor links.';
    const priorMission = previous === null ? null : missions.get(previous.mission_version);
    if (current.id !== expected.missionVersion || priorMission === null || priorMission.version >= current.version) {
      throw new Error(refusal);
    }
    let predecessor = priorMission;
    while (predecessor.id !== current.id) {
      const successor = predecessor.superseded_by === null ? null : missions.get(predecessor.superseded_by);
      if (successor === null || successor.version <= predecessor.version || successor.version > current.version) {
        throw new Error(refusal);
      }
      predecessor = successor;
    }
    return this.registry.restart(expected);
  }

  public supersede(expected: CycleSupersessionExpectation): { readonly cycle: CycleRecord; readonly created: boolean } {
    this.runtime.requireFreshProjections();
    return this.registry.supersede(expected, (previous) => inspectCycleSupersession(this.runtime, previous));
  }

  /** The operator's suspension (§21.1): recorded with its reason, refused by the registry
   *  when nothing live exists to suspend. */
  public suspend(reason: string): CycleRecord {
    const cycle = this.registry.current();
    if (cycle === null) throw new Error('No cycle in progress to suspend.');
    return this.registry.suspend(cycle.id, reason);
  }

  /**
   * The operator's resume, verified (§21.2). The planner re-checks mission identity, lock
   * reproducibility, projection freshness, full-chain log integrity and artifact
   * integrity; the receipt — pass or fail — becomes an artifact, and only a passing one
   * lets the resumed event carry it. A failing verification refuses the resume quoting
   * every failed check, with §21.3/§21.4 named where they are the real answer. The
   * earlier stated absence (`verification: null`) is hereby closed.
   */
  public resume(): CycleRecord {
    const cycle = this.registry.current();
    if (cycle === null) throw new Error('No cycle in progress to resume.');

    const verification = verifyResume(this.runtime, cycle);
    const receipt = this.runtime.artifacts.putJson(verification, {
      label: `cycle-${cycle.id}-resume-verification.json`,
    });
    if (!verification.ok) {
      const failed = verification.checks.filter((check) => !check.ok);
      throw new Error(
        `Resume refused for ${cycle.id} — §21.2 verification failed ` +
          `(receipt ${receipt.hash.slice(0, 12)}…):\n` +
          failed.map((check) => `  ${check.name}: ${check.detail}`).join('\n'),
      );
    }
    return this.registry.resume(cycle.id, receipt);
  }

  /**
   * Closes the cycle honestly — see {@link close}. (The earlier `closeDiagnostic` name is
   * retired by B5: with the §18 switch the same walk records a real closing run when the
   * lock names one, and the honest diagnostic ending when it does not.)
   */
  /**
   * Closes the cycle honestly (SCREENED → CLOSING_EVIDENCE → HANDOFF → CLOSED) — DEV-P2-07 B5.
   *
   * **The §18 switch is the lock.** When the cycle's lock names no Master Benchmark, the
   * closing evidence is a closing canonical snapshot plus the explicit statement that the
   * run did not occur — recorded, not implied — and §24 carries the absence. When the lock
   * *does* name one, §18's closing run is **required**: the caller performs it UNLOCKED
   * (the harness drives `clue` as children and they take the writer lock; see
   * `src/control/benchmarkRun.ts`) and hands the `PerformedRun` in here, where three gates
   * stand before it becomes evidence — a run the lock never named is refused, a refused
   * run is refused, and a run whose contract hash differs from the locked one is refused
   * as a moved world (§21.3 territory, not closing-evidence territory).
   *
   * §19's handoff is assembled from the cycle's **own events** and evidence artifacts; §24
   * is derived from the same lock plus the structural gaps — and with a recorded closing
   * run, "closing Master Benchmark run (§18): not performed" leaves the unmet list, which
   * is how `criteria_met` becomes decidable rather than structurally false. Resume-safe:
   * later steps read the run from the recorded CLOSING_EVIDENCE artifact, never from this
   * call's parameter, so a close resumed at HANDOFF carries the truth it recorded.
   */
  public close(
    closingRun: PerformedRun | null = null,
  ): { readonly cycle: CycleRecord; readonly performed: readonly DriveStep[] } {
    const performed: DriveStep[] = [];
    let cycle = this.registry.current();
    if (cycle === null) throw new Error('No cycle in progress to close.');

    // Validate the proof history before closing evidence or handoff is written. A malformed
    // verdict is a corrupt authority claim, not a reason to partially advance the stage machine.
    // When a lock exists, its project basis is part of the closure authority: an A verdict
    // cannot close B, and a legacy verdict cannot close a profile-bound cycle.
    const proofLock = this.tryLockOf(cycle.id);
    const proofClosure = deriveProofClosure(
      this.log.replay(),
      cycle.id,
      proofLock === null ? undefined : (proofLock.project_basis ?? null),
    );

    if (cycle.stage !== 'SCREENED' && closingRun !== null) {
      throw new Error(
        `Cycle ${cycle.id} is at ${cycle.stage} — the closing evidence is already recorded (or not ` +
          'yet reachable), so the supplied run has no stage to enter; rerun `cycle close` without it.',
      );
    }
    if (cycle.stage === 'SCREENED') {
      const lock = this.lockOf(cycle.id);
      if (lock.master_benchmark === null && closingRun !== null) {
        throw new Error(
          `Cycle ${cycle.id}'s lock names no Master Benchmark — a run the lock never named cannot ` +
            'become its closing evidence.',
        );
      }
      if (lock.master_benchmark !== null) {
        if (closingRun === null) {
          throw new Error(
            `Cycle ${cycle.id}'s lock names a Master Benchmark (${lock.master_benchmark.path}, ` +
              `${lock.master_benchmark.sha256.slice(0, 12)}…) — §18's closing run is required. It must ` +
              'be performed UNLOCKED before closing; `clue cycle close` does this via ' +
              'src/control/benchmarkRun.ts.',
          );
        }
        if (!closingRun.outcome.ok) {
          throw new Error(
            `The supplied closing run was refused at ${closingRun.outcome.stage} ` +
              `(${closingRun.outcome.reason}) — a refusal is not closing evidence.`,
          );
        }
        if (closingRun.outcome.contract.sha256 !== lock.master_benchmark.sha256) {
          throw new Error(
            `The closing run measured a different contract than this cycle locked — locked ` +
              `${lock.master_benchmark.sha256.slice(0, 12)}…, ran ` +
              `${closingRun.outcome.contract.sha256.slice(0, 12)}…. A moved world closes nothing ` +
              '(§21.3: restart, or open a new cycle over it).',
          );
        }
        if (!closingRun.contract.registered) {
          throw new Error('A diagnostic benchmark cannot become closing evidence. Run the locked Master Benchmark.');
        }
        const { contract, result, budget } = closingRun.outcome;
        if (contract.benchmark_id === 'clu-master' && contract.benchmark_version === '0.2.0' &&
            (budget.exhausted || !isCompleteCluBenchmarkV020(result))) {
          throw new Error('The closing clu-master 0.2.0 run must complete all 13 required measures within its budget. Rerun `clue cycle close`.');
        }
        assertBenchmarkRunSubject(this.runtime, closingRun);
      }
    }

    for (;;) {
      switch (cycle.stage) {
        case 'SUSPENDED':
          throw new Error(
            `Cycle ${cycle.id} is suspended — resuming is the operator's act, not the closer's.`,
          );
        case 'OPENED':
        case 'INPUTS_LOCKED':
        case 'OPENING_EVIDENCE':
        case 'RECOGNIZED':
          throw new Error(
            `Cycle ${cycle.id} is at ${cycle.stage} — drive it to SCREENED before closing.`,
          );
        case 'SCREENED':
          performed.push(this.stepClosingEvidence(cycle, closingRun));
          break;
        case 'CLOSING_EVIDENCE':
          performed.push(this.stepHandoff(cycle));
          break;
        case 'HANDOFF':
          performed.push(this.stepClose(cycle, proofClosure));
          break;
        case 'CLOSED':
          return { cycle, performed };
      }
      const next = this.registry.get(cycle.id);
      if (next === null) throw new Error(`Cycle ${cycle.id} vanished mid-close.`);
      cycle = next;
    }
  }

  /**
   * The CANDIDATES arm (DEV-P2-11) — §8–§15's loop, hung off SCREENED.
   *
   * Deliberately **not a stage**: candidates repeat while the cycle stands at SCREENED,
   * and the close walk stays untouched. Misuse throws (wrong stage, no locked stick);
   * pipeline outcomes return — a freeze refusal returns unrecorded (nothing with
   * authority existed yet, the benchmark-refusal law), an execution refusal is
   * **recorded** (`proof.execution_refused`) because §12.4's failure evidence must
   * outlive the attempt, and a verdict always records with its full artifact.
   *
   * §11's reuse is implemented against the durable log itself: the newest
   * `benchmark.run_recorded` whose measured snapshot, stick hash, and mission all match
   * the frozen contract becomes the baseline package; none matching refuses by name —
   * *run `clue benchmark run`, then retry* — because the rerun path already exists as an
   * operator act and §11 forbids repairing the gap any other way. The stick is the
   * cycle's own locked Master Benchmark, so baseline and candidate are measured by the
   * same bytes the lock pinned.
   *
   * Tree-relative sticks run plain toolchain processes under this writer lock. The CLU-E
   * self-target's stick drives `clue`; the coordinator relocates only the leased shadow's
   * config/profile/workspace so those children use a distinct writer authority while the
   * canonical proof arm remains locked.
   */
  public candidate(input: {
    readonly contract: unknown;
    readonly capabilities: readonly string[];
    readonly patch: readonly PatchOperation[];
    readonly expectedBaselineEventId?: string;
    readonly log?: (line: string) => void;
  }): Promise<CandidateArmResult> {
    return this.candidateInner(input);
  }

  private async candidateInner(input: {
    readonly contract: unknown;
    readonly capabilities: readonly string[];
    readonly patch: readonly PatchOperation[];
    readonly expectedBaselineEventId?: string;
    readonly log?: (line: string) => void;
  }): Promise<CandidateArmResult> {
    const cycle = this.registry.current();
    if (cycle === null) throw new Error('No cycle in progress — the candidate arm hangs off SCREENED.');
    if (cycle.stage !== 'SCREENED') {
      throw new Error(`Cycle ${cycle.id} is at ${cycle.stage} — candidates run at SCREENED (§8–§15).`);
    }
    const lock = this.lockOf(cycle.id);
    if (lock.grade === 'proof-authoritative') {
      const missionId = this.runtime.requireMission().requireCurrent().id;
      const { ratification, epoch } = readCurrentCycleAuthority(this.log.replay(), missionId);
      if (cycle.mission_version !== missionId || ratification === null || epoch === null ||
          lock.ratification_event_id !== ratification.event_id || lock.epoch_name !== epoch.epoch_name) {
        return { ok: false, stage: 'freeze', reasons: ['The cycle lock does not bind the current mission ratification and evidence epoch.'] };
      }
    }
    if (lock.master_benchmark === null) {
      throw new Error(
        'The candidate arm needs a locked Master Benchmark stick (§13) — register the benchmark and open a cycle over it.',
      );
    }
    const config = this.runtime.config;
    let benchmarkContractPath: string;
    let executionBoundary;
    try {
      const benchmark = verifyLockedContract(config.project.root, lock.master_benchmark);
      if ('error' in benchmark) return { ok: false, stage: 'instrument', reasons: [benchmark.error] };
      benchmarkContractPath = benchmark.path;
      executionBoundary = requireProofExecutionBoundary();
    } catch (error) {
      return { ok: false, stage: 'instrument', reasons: [(error as Error).message] };
    }
    const log = this.log;
    const screenedRef = this.evidenceRefsOf(cycle.id)['SCREENED'];
    const screened = screenedRef === undefined || screenedRef === null
      ? null
      : this.runtime.artifacts.getJson(screenedRef.hash as unknown as Sha256) as { snapshot_id?: string; inputs?: unknown };
    const screenedInputs = snapshotManifestSchema.safeParse(screened?.inputs);
    if (!screenedInputs.success || typeof screened?.snapshot_id !== 'string') {
      return { ok: false, stage: 'freeze', reasons: ['This cycle was screened without an exact input manifest. Close the existing cycle and drive a fresh cycle before proving a candidate.'] };
    }
    const pinnedInputs = screenedInputs.data;
    try {
      assertExactRunInputs(config.project.root, pinnedInputs, 'Screened project');
    } catch (error) {
      return { ok: false, stage: 'freeze', reasons: [(error as Error).message] };
    }

    // Freeze — §10's single gate, plus the arm's own bindings: this cycle, this mission,
    // this screened world. A contract for elsewhere refuses before anything records.
    const frozen = freezeProofContract({
      contract: input.contract,
      policy: config.proof,
      capabilities: input.capabilities,
      ...(lock.project_basis === undefined ? {} : { expectedProjectBasis: lock.project_basis }),
    });
    if ('refusals' in frozen) return { ok: false, stage: 'freeze', reasons: frozen.refusals };
    const armReasons: string[] = [];
    if (frozen.contract.cycle_id !== cycle.id) {
      armReasons.push(`the contract binds cycle ${frozen.contract.cycle_id}, this cycle is ${cycle.id}`);
    }
    if (frozen.contract.mission_version !== this.runtime.currentMissionId()) {
      armReasons.push(
        `the contract binds mission ${frozen.contract.mission_version}, the runtime is ${this.runtime.currentMissionId()}`,
      );
    }
    if (frozen.contract.snapshot_id !== screened.snapshot_id) {
      armReasons.push(
        `the contract binds snapshot ${frozen.contract.snapshot_id.slice(0, 12)}…, the screened world is ` +
          `${screened.snapshot_id.slice(0, 12)}… — freeze over the world you screened`,
      );
    }
    if (armReasons.length > 0) return { ok: false, stage: 'freeze', reasons: armReasons };

    // Only proof-authoritative runs can supply a candidate's exact Git parent.
    const initialLandingBase = lock.grade === 'proof-authoritative' && lock.project_basis !== undefined
      ? observeLocalLandingBase(this.runtime.projectProfile, config.project.root)
      : null;

    const contractArtifact = this.runtime.artifacts.putJson(frozen.contract, {
      label: `proof-contract-${frozen.contract_hash.slice(0, 12)}.json`,
    });
    const frozenEvent = log.append({
      type: PROOF_EVENT_TYPES.contractFrozen,
      actor: 'cli',
      missionVersion: this.runtime.currentMissionId(),
      subjectId: cycle.id,
      payload: {
        target_id: config.project.id,
        ...(frozen.contract.project_basis === undefined
          ? {}
          : { project_basis: frozen.contract.project_basis }),
        contract_hash: frozen.contract_hash,
        hypothesis_id: frozen.contract.hypothesis.id,
        cycle_id: cycle.id,
        snapshot_id: frozen.contract.snapshot_id,
        inputs_id: pinnedInputs.id,
        ...(initialLandingBase === null ? {} : { local_landing_base: initialLandingBase }),
        contract_artifact: contractArtifact,
        frozen_at: frozen.frozen_at,
      },
    });

    // §11 reuse against the durable log: newest matching recorded run wins.
    let baselineSource: {
      readonly event_id: string;
      readonly artifact: { readonly hash: string };
      readonly executable_inputs: unknown;
    } | null = null;
    let baseline: BaselinePackage | null = null;
    const configSha = hashCanonicalJson(config);
    for (const record of log.replay()) {
      if (record.type !== BENCHMARK_EVENT_TYPES.runRecorded) continue;
      if (input.expectedBaselineEventId !== undefined && record.id !== input.expectedBaselineEventId) continue;
      const payload = record.payload as {
        snapshot_id?: string | null;
        registered?: boolean;
        proof_eligible?: boolean;
        inputs_id?: string;
        executable_inputs?: unknown;
        execution_boundary?: unknown;
        config_sha256?: string;
        contract?: { sha256?: string };
        project_basis?: unknown;
        result_artifact?: { hash?: string };
      };
      if (payload.registered !== true || payload.proof_eligible !== true || payload.inputs_id !== pinnedInputs.id ||
          payload.config_sha256 !== configSha || payload.executable_inputs === undefined ||
          canonicalJson(payload.execution_boundary ?? null) !== canonicalJson(executionBoundary)) continue;
      if (payload.snapshot_id !== frozen.contract.snapshot_id) continue;
      if (payload.contract?.sha256 !== lock.master_benchmark.sha256) continue;
      if (record.mission_version !== this.runtime.currentMissionId()) continue;
      if (
        frozen.contract.project_basis !== undefined &&
        canonicalJson(payload.project_basis) !== canonicalJson(frozen.contract.project_basis)
      ) continue;
      if (frozen.contract.project_basis === undefined && payload.project_basis !== undefined) continue;
      if (payload.result_artifact?.hash === undefined) continue;
      baselineSource = {
        event_id: record.id, artifact: { hash: payload.result_artifact.hash }, executable_inputs: payload.executable_inputs,
      };
    }
    if (baselineSource !== null) {
      const body = this.runtime.artifacts.getJson(baselineSource.artifact.hash as unknown as Sha256) as {
        result: unknown;
        contract: unknown;
        timing: { finished_at: string };
        policy: unknown;
        budget: unknown;
        inputs?: unknown;
        executable_inputs?: unknown;
        execution_boundary?: unknown;
        config_sha256?: string;
        proof_eligible?: boolean;
        project_basis?: unknown;
      };
      if (body.proof_eligible !== true || body.config_sha256 !== configSha ||
          canonicalJson(body.execution_boundary ?? null) !== canonicalJson(executionBoundary) ||
          canonicalJson(body.inputs ?? null) !== canonicalJson(pinnedInputs) ||
          canonicalJson(body.executable_inputs ?? null) !== canonicalJson(baselineSource.executable_inputs)) {
        return { ok: false, stage: 'baseline', reasons: ['The recorded baseline artifact disagrees with the pinned evidence. Run the registered benchmark again.'] };
      }
      try {
        const currentExecutableInputs = captureBenchmarkExecutableInputs(this.runtime.repoRoot, config.project.root);
        if (canonicalJson(currentExecutableInputs) !== canonicalJson(baselineSource.executable_inputs)) {
          throw new Error('Benchmark executable inputs changed since the baseline. Run the registered benchmark again.');
        }
      } catch (error) {
        return { ok: false, stage: 'baseline', reasons: [(error as Error).message] };
      }
      if (
        canonicalJson(body.project_basis ?? null) !==
        canonicalJson(frozen.contract.project_basis ?? null)
      ) {
        throw new Error(
          `Recorded benchmark event ${baselineSource.event_id} and its result artifact disagree on project_basis.`,
        );
      }
      baseline = captureBaseline({
        outcome: { ok: true, ...body } as Parameters<typeof captureBaseline>[0]['outcome'],
        snapshot_id: frozen.contract.snapshot_id as Sha256,
        mission_version: frozen.contract.mission_version,
        ...(frozen.contract.project_basis === undefined
          ? {}
          : { project_basis: frozen.contract.project_basis }),
        run_artifact: {
          hash: baselineSource.artifact.hash,
          bytes: 0,
          media_type: 'application/json; charset=utf-8',
          label: null,
          created_at: body.timing.finished_at,
        } as BaselinePackage['run_artifact'],
      });
    }
    if (baseline === null) {
      return {
        ok: false,
        stage: 'baseline',
        reasons: [
          `no reusable recorded run measures snapshot ${frozen.contract.snapshot_id.slice(0, 12)}… under the ` +
            `locked stick ${lock.master_benchmark.sha256.slice(0, 12)}… and this mission — run \`clue benchmark run\`, ` +
            'then retry (§11: rerun; narrative cannot repair the gap)',
        ],
      };
    }
    const validity = assessBaselineValidity(frozen.contract, baseline);
    if (!validity.valid) return { ok: false, stage: 'baseline', reasons: validity.reasons };
    log.append({
      type: PROOF_EVENT_TYPES.baselineBound,
      actor: 'cli',
      missionVersion: this.runtime.currentMissionId(),
      subjectId: cycle.id,
      payload: {
        contract_hash: frozen.contract_hash,
        baseline_digest: validity.digest,
        inputs_id: pinnedInputs.id,
        source_event_id: baselineSource?.event_id ?? null,
        run_artifact_hash: baselineSource?.artifact.hash ?? null,
        reused: true,
      },
    });

    // §12–§13 — the coordinator, over the cycle's own governed pieces.
    const typecheck = config.runtime.scripts['typecheck'];
    const build = config.runtime.scripts['build'];
    if (typecheck === undefined || build === undefined) {
      throw new Error('runtime.scripts.typecheck/build are schema-required and missing — the config is defective.');
    }
    const needsMatchedControl = executionBoundary.kind === 'windows-supervisor' && this.runtime.projectProfile !== null &&
      isBenchmarkProfileContract(lock.master_benchmark.sha256) &&
      relative(realpathSync.native(this.runtime.repoRoot), realpathSync.native(config.project.root)) === '';
    const executionDeps: Omit<ProofExecutionDeps, 'patch'> = {
      frozen,
      baseline,
      projectRoot: config.project.root,
      pinnedInputs,
      shadow: {
        root: config.shadow.root,
        // Both sides of the local comparison start with new dependency and workspace state.
        persistent: !needsMatchedControl && config.shadow.persistent,
        install_command: config.shadow.install_command ?? null,
        install_on_lockfile_change: config.shadow.install_on_lockfile_change,
      },
      scripts: { typecheck, build },
      benchmarkContractPath,
      repoRoot: this.runtime.repoRoot,
      ...(this.runtime.projectProfile === null ? {} : { projectProfile: this.runtime.projectProfile }),
    };
    const control = needsMatchedControl ? await executeMatchedProofControl({
      ...executionDeps,
      log: (line) => input.log?.(`Matched control: ${line}`),
    }) : null;
    let controlArtifact: ArtifactRef | null = null;
    let controlBaseline: BaselinePackage | null = null;
    let controlRefusal: string | null = null;
    if (control !== null) {
      if (!control.ok) {
        controlRefusal = `Matched shadow control refused at ${control.stage}: ${control.reason}`;
      } else if (control.anomalies.length !== 0 ||
          canonicalJson(control.outcome.execution_boundary ?? null) !== canonicalJson(executionBoundary) ||
          canonicalJson(control.candidate_inputs) !== canonicalJson(pinnedInputs) ||
          control.profile_relocation === undefined ||
          control.profile_relocation.canonicalProfileHash !== lock.project_basis?.operationIdentity.projectProfileHash ||
          control.profile_relocation.canonicalAuthoritySha256 !== lock.project_basis?.authorityHash ||
          !isCompleteCluBenchmarkV020(control.outcome.result)) {
        controlRefusal = 'Matched shadow control did not complete the same benchmark under the pinned Windows boundary, profile authority and screened inputs.';
      } else {
        controlArtifact = this.runtime.artifacts.putJson({
          role: 'unchanged-matched-shadow-control',
          result: control.outcome.result,
          contract: control.outcome.contract,
          timing: control.outcome.timing,
          policy: control.outcome.policy,
          budget: control.outcome.budget,
          inputs: control.candidate_inputs,
          executable_inputs: control.executable_inputs,
          execution_boundary: control.outcome.execution_boundary,
          profile_relocation: control.profile_relocation,
          recognition_timings: control.recognition_timings ?? [],
          instrumentation: control.instrumentation,
        }, { label: `proof-control-run-${frozen.contract_hash.slice(0, 12)}.json` });
        controlBaseline = captureBaseline({
          outcome: control.outcome,
          snapshot_id: requireSha256(frozen.contract.snapshot_id, 'matched control snapshot'),
          mission_version: frozen.contract.mission_version,
          ...(frozen.contract.project_basis === undefined ? {} : { project_basis: frozen.contract.project_basis }),
          run_artifact: controlArtifact,
        });
        const controlValidity = assessBaselineValidity(frozen.contract, controlBaseline);
        if (!controlValidity.valid) controlRefusal = `Matched shadow control is invalid: ${controlValidity.reasons.join('; ')}`;
      }
    }
    let execution = controlRefusal === null
      ? await executeProofPlan({ ...executionDeps, patch: input.patch, log: (line) => input.log?.(`Candidate: ${line}`) })
      : {
          ok: false as const, stage: 'instrument' as const, reason: controlRefusal,
          evidence: control !== null && !control.ok ? control.evidence ?? [] : [],
        };
    if (execution.ok) {
      try {
        if (canonicalJson(execution.outcome.execution_boundary ?? null) !== canonicalJson(executionBoundary)) {
          throw new Error('Candidate execution did not use the pinned benchmark isolation boundary.');
        }
        if (control?.ok === true) {
          const controlRelocation = control.profile_relocation;
          const candidateRelocation = execution.profile_relocation;
          if (controlRelocation === undefined || candidateRelocation === undefined ||
              controlRelocation.canonicalProfileHash !== candidateRelocation.canonicalProfileHash ||
              controlRelocation.canonicalAuthoritySha256 !== candidateRelocation.canonicalAuthoritySha256 ||
              controlRelocation.shadowProfileHash === candidateRelocation.shadowProfileHash ||
              controlRelocation.capsuleSha256 === candidateRelocation.capsuleSha256 ||
              controlRelocation.shadowMission !== candidateRelocation.shadowMission ||
              relative(realpathSync.native(control.shadow_dir), realpathSync.native(execution.shadow_dir)) === '') {
            throw new Error('Candidate and matched shadow control did not use distinct leases under the same verified project authority.');
          }
          const matched = control.executable_inputs;
          const observed = execution.executable_inputs;
          if (matched.node_sha256 !== observed.node_sha256 ||
              matched.engine_dependencies_id === null || matched.engine_dependencies_id !== observed.engine_dependencies_id ||
              matched.target_dependencies_id === null || matched.target_dependencies_id !== observed.target_dependencies_id) {
            throw new Error('Candidate and matched shadow control did not use the same Node binary and dependency bytes.');
          }
        }
        const currentExecutableInputs = captureBenchmarkExecutableInputs(this.runtime.repoRoot, config.project.root);
        if (canonicalJson(currentExecutableInputs) !== canonicalJson(baselineSource?.executable_inputs)) {
          throw new Error('Canonical executable inputs changed during candidate execution.');
        }
      } catch (error) {
        execution = {
          ok: false, stage: 'instrument', reason: (error as Error).message,
          evidence: (execution.recognition_timings ?? []).map((timing) => `BENCHMARK_TIMING ${JSON.stringify(timing)}`),
        };
      }
    }
    if (!execution.ok) {
      const evidence = [...(execution.evidence ?? []),
        ...(control?.ok === true ? (control.recognition_timings ?? []).map((timing) => `BENCHMARK_TIMING ${JSON.stringify(timing)}`) : [])];
      const refusedEvent = log.append({
        type: PROOF_EVENT_TYPES.executionRefused,
        actor: 'cli',
        missionVersion: this.runtime.currentMissionId(),
        subjectId: cycle.id,
        payload: {
          contract_hash: frozen.contract_hash,
          stage: execution.stage,
          reason: execution.reason,
          evidence,
        },
      });
      this.runtime.projections.sync(log);
      return {
        ok: false,
        stage: execution.stage,
        reasons: [execution.reason],
        ...(evidence.length === 0 ? {} : { evidence }),
        recorded_event: refusedEvent.id,
      };
    }

    // §14 — record everything, then let the deterministic authority speak.
    const candidateRunArtifact = this.runtime.artifacts.putJson(
      {
        result: execution.outcome.result,
        contract: execution.outcome.contract,
        timing: execution.outcome.timing,
        policy: execution.outcome.policy,
        budget: execution.outcome.budget,
        inputs: execution.candidate_inputs,
        executable_inputs: execution.executable_inputs,
        execution_boundary: execution.outcome.execution_boundary,
        recognition_timings: execution.recognition_timings ?? [],
        ...(execution.profile_relocation === undefined ? {} : { profile_relocation: execution.profile_relocation }),
        ...(controlArtifact === null ? {} : { matched_control: controlArtifact }),
        ...(frozen.contract.project_basis === undefined
          ? {}
          : { project_basis: frozen.contract.project_basis }),
      },
      { label: `proof-candidate-run-${execution.patch_digest.slice(0, 12)}.json` },
    );
    const candidate = captureBaseline({
      outcome: execution.outcome,
      snapshot_id: execution.candidate_snapshot_id,
      mission_version: frozen.contract.mission_version,
      ...(frozen.contract.project_basis === undefined
        ? {}
        : { project_basis: frozen.contract.project_basis }),
      run_artifact: candidateRunArtifact,
    });
    const verdictInput = {
      contract: frozen.contract,
      contract_hash: frozen.contract_hash,
      baseline,
      candidate,
      anomalies: execution.anomalies,
    };
    const verdict = decideWithMatchedControl(verdictInput, controlBaseline);
    let localLandingBase: LocalLandingBase | null = null;
    if (verdict.disposition === 'ACCEPT' && initialLandingBase !== null) {
      try {
        assertExactRunInputs(config.project.root, pinnedInputs, 'Screened project after proof');
        const observed = observeLocalLandingBase(this.runtime.projectProfile, config.project.root);
        if (canonicalJson(observed) === canonicalJson(initialLandingBase)) localLandingBase = observed;
      } catch {
        // The completed shadow proof still records its verdict. A stale base cannot land.
      }
    }
    const verdictArtifact = this.runtime.artifacts.putJson(verdict, {
      label: `proof-verdict-${frozen.contract_hash.slice(0, 12)}.json`,
    });
    const greatBookBuilt = buildGreatBookEntry({
      targetId: config.project.id,
      missionVersion: this.runtime.currentMissionId(),
      cycleId: cycle.id,
      contract: frozen.contract,
      contractHash: frozen.contract_hash,
      verdict,
      patchDigest: execution.patch_digest,
      changeSet: execution.change_set,
      benchmarkRunId: baselineSource?.event_id ?? null,
      artifacts: {
        contract: contractArtifact,
        candidate_run: candidateRunArtifact,
        verdict: verdictArtifact,
      },
      recordedAt: nowIso(),
    });
    const greatBook: GreatBookRecording =
      greatBookBuilt.entry === null
        ? { state: 'not_recorded', reason: greatBookBuilt.reason }
        : { state: 'recorded', entry: greatBookBuilt.entry };
    const verdictEvent = log.append({
      type: PROOF_EVENT_TYPES.verdictRecorded,
      actor: 'cli',
      missionVersion: this.runtime.currentMissionId(),
      subjectId: cycle.id,
      payload: {
        target_id: config.project.id,
        ...(frozen.contract.project_basis === undefined
          ? {}
          : { project_basis: frozen.contract.project_basis }),
        contract_hash: frozen.contract_hash,
        hypothesis_id: frozen.contract.hypothesis.id,
        cycle_id: cycle.id,
        disposition: verdict.disposition,
        improvement: verdict.improvement,
        reasons: verdict.reasons,
        deltas: verdict.deltas,
        baseline_digest: verdict.identity.baseline_digest,
        candidate_digest: verdict.identity.candidate_digest,
        candidate_snapshot_id: execution.candidate_snapshot_id,
        baseline_inputs_id: pinnedInputs.id,
        ...(localLandingBase === null ? {} : { local_landing_base: localLandingBase }),
        patch_digest: execution.patch_digest,
        change_set: execution.change_set,
        static_preparation: execution.static_preparation,
        installed: execution.installed,
        instrumentation: execution.instrumentation,
        anomalies: execution.anomalies,
        artifacts: {
          contract: contractArtifact,
          candidate_run: candidateRunArtifact,
          verdict: verdictArtifact,
        },
        great_book: greatBook,
      },
    });
    this.runtime.projections.sync(log);
    return {
      ok: true,
      verdict,
      contract_hash: frozen.contract_hash,
      events: { frozen: frozenEvent.id, verdict: verdictEvent.id },
      artifacts: { contract: contractArtifact, candidate_run: candidateRunArtifact, verdict: verdictArtifact },
      great_book: greatBook,
    };
  }

  /** The cycle's own lock, read back from its `cycle.inputs_locked` event. */
  private tryLockOf(cycleId: string): CycleInputLock | null {
    for (const record of this.log.replay()) {
      if (record.type !== CYCLE_EVENT_TYPES.inputsLocked) continue;
      const parsed = cycleInputsLockedSchema.safeParse(record.payload);
      if (parsed.success && parsed.data.cycle_id === cycleId) return parsed.data.lock;
    }
    return null;
  }

  private lockOf(cycleId: string): CycleInputLock {
    const lock = this.tryLockOf(cycleId);
    if (lock !== null) return lock;
    throw new Error(`Cycle ${cycleId} has no inputs_locked event — cannot derive §24 honestly.`);
  }

  /**
   * What the lock names as the Master Benchmark, for the caller that must perform §18's
   * run UNLOCKED before closing (B5's two-phase `cycle close`). Null both when the lock
   * names none and when no lock exists yet — a pre-lock cycle refuses in `close()` with
   * its own drive-first message, which is the better error.
   */
  public lockedBenchmarkOf(cycleId: string): { readonly path: string; readonly sha256: string } | null {
    try {
      return this.lockOf(cycleId).master_benchmark;
    } catch {
      return null;
    }
  }

  /** Evidence refs each stage recorded, read back from the cycle's own advance events. */
  private evidenceRefsOf(cycleId: string): Record<string, ArtifactRef | null> {
    const refs: Record<string, ArtifactRef | null> = {};
    for (const record of this.log.replay()) {
      if (record.type !== CYCLE_EVENT_TYPES.stageAdvanced) continue;
      const payload = record.payload as { cycle_id?: unknown; to?: unknown; evidence?: unknown };
      if (payload.cycle_id !== cycleId || typeof payload.to !== 'string') continue;
      refs[payload.to] = (payload.evidence ?? null) as ArtifactRef | null;
    }
    return refs;
  }

  private stepClosingEvidence(cycle: CycleRecord, closingRun: PerformedRun | null): DriveStep {
    const snapshots = this.runtime.snapshots;
    if (snapshots === null) {
      throw new Error('The snapshot registry is unavailable in this runtime; cannot close evidence.');
    }
    const recognition = resolveProjectRecognition(this.runtime);
    const captured = snapshots.capture({
      origin: 'canonical',
      root: recognition.targetRoot,
      sourceRoots: recognition.sourceRoots,
      exclude: recognition.excludedPaths,
    });

    // The §18 run, when performed: its full outcome becomes its own artifact, and the
    // closing evidence carries the summary plus the ref — native units and raw samples
    // preserved where §18 requires them, scannable identity where §24 reads it.
    let masterBenchmarkRun: Record<string, unknown> | null = null;
    let runSummary = '§18 run absent, stated';
    if (closingRun !== null && closingRun.outcome.ok) {
      const { result, contract, timing, policy, budget } = closingRun.outcome;
      const subject = assertBenchmarkRunSubject(this.runtime, closingRun);
      if (captured.record.id !== subject.snapshot_id) {
        throw new Error('Closing snapshot does not match the tree measured by the registered benchmark.');
      }
      const comparison = compareClosingBenchmark(this.runtime.artifacts, this.log.replay(), cycle, this.lockOf(cycle.id), closingRun);
      const runArtifact = this.runtime.artifacts.putJson(
        { result, contract, timing, policy, budget, inputs: subject.inputs, executable_inputs: subject.executable_inputs,
          ...(closingRun.outcome.execution_boundary === undefined ? {} : { execution_boundary: closingRun.outcome.execution_boundary }) },
        { label: `cycle-${cycle.id}-closing-benchmark.json` },
      );
      masterBenchmarkRun = {
        benchmark_id: contract.benchmark_id,
        benchmark_version: contract.benchmark_version,
        contract_sha256: contract.sha256,
        inputs_id: subject.inputs.id,
        integrity_sha256: contract.integrity_sha256,
        block_id: contract.block_id,
        runner_adapter: contract.runner_adapter,
        run_artifact: runArtifact,
        unified_score: comparison?.opening.unified_score ?? result.unifiedScore,
        measures_count: result.measures.length,
        incomplete_count: result.incomplete.length,
        protective: result.protective,
        budget_exhausted: budget.exhausted,
        log_head_before: closingRun.log_head_before,
        opening_comparison: comparison?.opening ?? null,
        gates: comparison?.gates ?? null,
        gates_reason: comparison === null ? 'no opening run matched the verified closing scope' : null,
      };
      const score = comparison?.opening.unified_score;
      runSummary =
        `§18 run recorded (${contract.benchmark_id}@${contract.benchmark_version}, ` +
        `score ${score === undefined ? 'unavailable — no verified comparison' : score.toFixed(4)}, ` +
        `${result.measures.length} measure(s), ${result.incomplete.length} incomplete)`;
    }

    const evidence = this.runtime.artifacts.putJson(
      {
        stage: 'CLOSING_EVIDENCE',
        cycle_id: cycle.id,
        closing_snapshot_id: captured.record.id,
        capture_id: captured.captureId,
        file_count: captured.record.file_count,
        total_bytes: captured.record.total_bytes,
        master_benchmark_run: masterBenchmarkRun,
        reason:
          masterBenchmarkRun !== null
            ? null
            : 'diagnostic cycle — the Master Benchmark is unregistered, so §18\'s closing run did ' +
              'not occur; recorded here and carried into §24 as unmet',
      },
      { label: `cycle-${cycle.id}-closing.json` },
    );
    this.registry.advance(cycle.id, 'CLOSING_EVIDENCE', evidence);
    return {
      to: 'CLOSING_EVIDENCE',
      evidence,
      summary: `closing snapshot ${captured.record.id.slice(0, 12)}… (${captured.record.file_count} files); ${runSummary}`,
    };
  }

  /** The recorded §18 run, read back from the CLOSING_EVIDENCE artifact — the resume-safe
   *  truth `stepClose` derives §24 from (never this call's parameter). */
  private closingRunRecordOf(cycleId: string): {
    readonly benchmark_version?: string;
    readonly gates?: { readonly equilibrium_blocked?: boolean } | null;
  } | null {
    const ref = this.evidenceRefsOf(cycleId)['CLOSING_EVIDENCE'] ?? null;
    if (ref === null) return null;
    try {
      const body = this.runtime.artifacts.getJson(ref.hash as unknown as Sha256) as {
        master_benchmark_run?: { benchmark_version?: string; gates?: { equilibrium_blocked?: boolean } | null } | null;
      };
      return body.master_benchmark_run ?? null;
    } catch {
      return null;
    }
  }

  /** §19 in full: the vital-input record built from the cycle's own evidence; the earlier
   *  stated-minimal subset is retired by the module it promised. */
  private stepHandoff(cycle: CycleRecord): DriveStep {
    const lock = this.lockOf(cycle.id);
    const record = buildNextCycleVitalInput({
      runtime: this.runtime,
      cycle,
      lock,
      stageEvidence: this.evidenceRefsOf(cycle.id),
    });
    const evidence = this.runtime.artifacts.putJson(record, {
      label: `cycle-${cycle.id}-handoff.json`,
    });
    this.registry.advance(cycle.id, 'HANDOFF', evidence);
    return {
      to: 'HANDOFF',
      evidence,
      summary:
        `§19 vital input — ${record.stated_absences.length} stated absence(s), ` +
        `${record.anomalies.length} anomaly(ies)`,
    };
  }

  private stepClose(cycle: CycleRecord, proof: ProofClosureState): DriveStep {
    const lock = this.lockOf(cycle.id);
    const closingRun = this.closingRunRecordOf(cycle.id);
    const unmet = [
      ...lock.absent,
      ...proofClosureUnmet(proof),
      ...(closingRun === null
        ? ['closing Master Benchmark run (§18): not performed — benchmark unregistered']
        : closingRun.gates?.equilibrium_blocked === true ? ['closing Master Benchmark (§18): mandatory comparison gate failed'] : []),
    ].sort();
    this.registry.close(cycle.id, unmet);
    return {
      to: 'CLOSED',
      evidence: null,
      summary:
        `§24 evaluated from ${proof.verdictCount} durable proof verdict(s), ` +
        `${proof.acceptedCount} ACCEPT — ${unmet.length} unmet reason(s)`,
    };
  }

  /**
   * Drives the current cycle to SCREENED, opening one if none is live. Resumable from any
   * live pre-SCREENED stage; refuses a suspended cycle (the operator resumes those); a
   * cycle already at or past SCREENED performs nothing and is returned as it stands.
   */
  public drive(
    navigatorPath: string | null = null,
    options: { readonly verifyRecovery?: boolean } = {},
  ): DriveResult {
    const performed: DriveStep[] = [];
    let lock: CycleInputLock | null = null;
    let openingSnapshotId: string | null = null;

    let cycle = this.registry.current();
    if (cycle === null) {
      cycle = this.registry.open();
      performed.push({ to: 'OPENED', evidence: null, summary: `${cycle.id} opened` });
    } else if (options.verifyRecovery === true) {
      if (RECOVERABLE_DRIVE_STAGES.has(cycle.stage)) {
        openingSnapshotId = this.verifyDriveCheckpoint(cycle);
      } else if (cycle.stage !== 'SUSPENDED' && cycle.mission_version !== this.runtime.currentMissionId()) {
        throw new Error(`Cycle ${cycle.id} at ${cycle.stage} belongs to a different mission.`);
      }
    }

    for (;;) {
      if (cycle.stage === 'SUSPENDED') {
        throw new Error(
          `Cycle ${cycle.id} is suspended — resuming is the operator's act, not the driver's.`,
        );
      }
      if (cycle.stage === TARGET || cycle.stage === 'CANDIDATES' ||
          cycle.stage === 'CLOSING_EVIDENCE' || cycle.stage === 'HANDOFF' ||
          cycle.stage === 'CLOSED') {
        return { cycle, performed, lock };
      }
      switch (cycle.stage) {
        case 'OPENED': {
          lock = this.stepLock(cycle);
          break;
        }
        case 'INPUTS_LOCKED': {
          const { snapshotId, ...step } = this.stepOpeningEvidence(cycle, options.verifyRecovery === true);
          if (options.verifyRecovery === true) openingSnapshotId = snapshotId;
          performed.push(step);
          break;
        }
        case 'OPENING_EVIDENCE': {
          performed.push(this.stepRecognition(cycle, navigatorPath, openingSnapshotId));
          break;
        }
        case 'RECOGNIZED': {
          performed.push(this.stepScreening(cycle, openingSnapshotId));
          break;
        }
      }
      const next = this.registry.get(cycle.id);
      if (next === null) throw new Error(`Cycle ${cycle.id} vanished mid-drive.`);
      cycle = next;
      if (lock !== null && performed.length === 0) {
        performed.push({ to: 'INPUTS_LOCKED', evidence: null, summary: `locked ${lock.grade} (${lock.absent.length} absences)` });
      }
    }
  }

  /* ------------------------------- steps ------------------------------- */

  private verifyDriveCheckpoint(cycle: CycleRecord): string | null {
    const verification = verifyResume(this.runtime, cycle, { allowUnsealedOpened: true });
    const label = `Recovery refused for ${cycle.id} at ${cycle.stage}`;
    if (!verification.ok) {
      const failures = verification.checks.filter((check) => !check.ok);
      throw new Error(`${label}: ${failures.map((check) => `${check.name}: ${check.detail}`).join('\n')}`);
    }

    const lock = this.tryLockOf(cycle.id);
    if ((lock?.digest ?? null) !== cycle.lock_digest) {
      throw new Error(`${label}: the projected lock differs from the cycle's recorded lock.`);
    }
    if (cycle.stage === 'OPENED' || cycle.stage === 'INPUTS_LOCKED') return null;

    const ref = this.evidenceRefsOf(cycle.id)['OPENING_EVIDENCE'];
    if (!ref) throw new Error(`${label}: the opening checkpoint has no evidence reference.`);
    const checkpoint = openingCheckpointSchema.parse(
      this.runtime.artifacts.getJson(requireSha256(ref.hash, 'opening checkpoint')),
    );
    const snapshots = this.runtime.snapshots;
    const manifest = snapshots?.manifestOf(checkpoint.snapshot_id);
    const capture = snapshots?.captures(checkpoint.snapshot_id).find(
      (entry) => entry.captureId === checkpoint.capture_id && entry.origin === 'canonical',
    );
    if (checkpoint.cycle_id !== cycle.id || checkpoint.lock_digest !== cycle.lock_digest ||
        manifest?.id !== checkpoint.snapshot_id || !capture) {
      throw new Error(`${label}: opening evidence does not bind this cycle, lock, and canonical snapshot.`);
    }
    if (cycle.stage === 'OPENING_EVIDENCE') {
      const recognition = resolveProjectRecognition(this.runtime);
      const source = captureSnapshot({
        root: recognition.targetRoot, sourceRoots: recognition.sourceRoots, exclude: recognition.excludedPaths,
      });
      if (source.id !== checkpoint.snapshot_id) {
        throw new Error(`${label}: source changed since opening evidence. Restore the opened source or restart the cycle with a new lock.`);
      }
    }
    return checkpoint.snapshot_id;
  }

  private verifyRecognitionCheckpoint(cycle: CycleRecord, openingSnapshotId: string): void {
    const label = `Recovery refused for ${cycle.id} at ${cycle.stage}`;
    const ref = this.evidenceRefsOf(cycle.id)['RECOGNIZED'];
    if (!ref) throw new Error(`${label}: the recognition checkpoint has no evidence reference.`);
    const checkpoint = recognitionCheckpointSchema.parse(
      this.runtime.artifacts.getJson(requireSha256(ref.hash, 'recognition checkpoint')),
    );
    const record = this.runtime.requireGraph().recognition(openingSnapshotId);
    const capture = this.runtime.snapshots?.captures(openingSnapshotId).find(
      (entry) => entry.captureId === checkpoint.capture_id && entry.origin === 'canonical',
    );
    if (checkpoint.cycle_id !== cycle.id || checkpoint.snapshot_id !== openingSnapshotId ||
        !capture || record?.result_hash !== checkpoint.result_hash ||
        (checkpoint.run_key !== undefined && record.run_key !== checkpoint.run_key)) {
      throw new Error(`${label}: recognition evidence does not match the opened snapshot and recorded graph run.`);
    }
  }

  private stepLock(cycle: CycleRecord): CycleInputLock {
    const missionRegistry = this.runtime.requireMission();
    const mission = missionRegistry.current();
    if (mission === null) {
      throw new Error('No mission registered — run `clue init` before driving a cycle.');
    }
    const lock = computeInputLock({
      repoRoot: this.runtime.repoRoot,
      config: this.runtime.config,
      mission,
      ...readCurrentCycleAuthority(this.log.replay(), mission.id),
      projectBinding: this.runtime.projectBinding,
    });
    this.registry.lockInputs(cycle.id, lock);
    return lock;
  }

  private stepOpeningEvidence(
    cycle: CycleRecord,
    bindRecognition: boolean,
  ): DriveStep & { readonly snapshotId: string } {
    const snapshots = this.runtime.snapshots;
    if (snapshots === null) {
      throw new Error('The snapshot registry is unavailable in this runtime; cannot open evidence.');
    }
    const recognition = bindRecognition ? resolveProjectRecognition(this.runtime) : null;
    const identity = recognition?.projectRecognitionIdentity ?? undefined;
    const captured = snapshots.capture({
      origin: 'canonical',
      root: recognition?.targetRoot ?? this.runtime.config.project.root,
      sourceRoots: recognition?.sourceRoots ?? this.runtime.config.project.source_roots,
      exclude: recognition?.excludedPaths ?? this.runtime.config.project.exclude,
      ...(identity === undefined ? {} : { projectRecognition: identity }),
    });
    const evidence = this.runtime.artifacts.putJson(
      {
        stage: 'OPENING_EVIDENCE',
        cycle_id: cycle.id,
        snapshot_id: captured.record.id,
        capture_id: captured.captureId,
        file_count: captured.record.file_count,
        total_bytes: captured.record.total_bytes,
        lock_digest: cycle.lock_digest,
      },
      { label: `cycle-${cycle.id}-opening.json` },
    );
    this.registry.advance(cycle.id, 'OPENING_EVIDENCE', evidence);
    return {
      to: 'OPENING_EVIDENCE',
      evidence,
      snapshotId: captured.record.id,
      summary: `snapshot ${captured.record.id.slice(0, 12)}… (${captured.record.file_count} files)`,
    };
  }

  private stepRecognition(
    cycle: CycleRecord,
    navigatorPath: string | null,
    openingSnapshotId: string | null,
  ): DriveStep {
    const outcome = runRecognition(this.runtime, {
      force: false,
      navigatorPath,
      ...(openingSnapshotId === null ? {} : { expectedSnapshotId: openingSnapshotId }),
    });
    const evidence = this.runtime.artifacts.putJson(
      {
        stage: 'RECOGNIZED',
        cycle_id: cycle.id,
        snapshot_id: outcome.snapshotId,
        capture_id: outcome.captureId,
        run_id: outcome.runId,
        result_hash: outcome.recorded.record.result_hash,
        run_key: outcome.recorded.record.run_key,
        unit_count: outcome.recorded.record.unit_count,
        edge_count: outcome.recorded.record.edge_count,
        unresolved_count: outcome.recorded.record.unresolved_count,
        full_rescan: outcome.plan.fullRescan,
        notices: outcome.notices,
      },
      { label: `cycle-${cycle.id}-recognition.json` },
    );
    this.registry.advance(cycle.id, 'RECOGNIZED', evidence);
    return {
      to: 'RECOGNIZED',
      evidence,
      summary:
        `${outcome.recorded.record.unit_count} units, ${outcome.recorded.record.edge_count} edges, ` +
        `${outcome.recorded.record.unresolved_count} unresolved`,
    };
  }

  private stepScreening(cycle: CycleRecord, openingSnapshotId: string | null): DriveStep {
    const graph = this.runtime.requireGraph();
    const metrics = this.runtime.metrics;
    const snapshots = this.runtime.snapshots;
    if (metrics === null || snapshots === null) {
      throw new Error('Metric or snapshot registry unavailable; cannot screen.');
    }
    const snapshotId = openingSnapshotId ?? snapshots.latest('canonical')?.id;
    if (snapshotId === undefined) {
      throw new Error('No canonical snapshot to screen against.');
    }
    if (openingSnapshotId !== null) this.verifyRecognitionCheckpoint(cycle, openingSnapshotId);
    const recognition = resolveProjectRecognition(this.runtime);
    const inputs = captureExactRunInputs(recognition.targetRoot);
    const source = captureSnapshot({
      root: recognition.targetRoot, sourceRoots: recognition.sourceRoots, exclude: recognition.excludedPaths,
    });
    if (source.id !== snapshotId) {
      throw new Error(openingSnapshotId === null
        ? 'Recognized source changed before screening. Capture and recognize the current tree.'
        : 'Recognized source changed before screening. Restore the opened source or restart the cycle with a new lock.');
    }
    assertExactRunInputs(recognition.targetRoot, inputs, 'Screened project');
    const stored = graph.resultOf(
      snapshotId,
      openingSnapshotId === null ? undefined : recognition.projectRecognitionIdentity ?? undefined,
    );
    if (stored === null) {
      throw new Error(`No recognition for snapshot ${snapshotId.slice(0, 12)}…; drive recognition first.`);
    }
    const classifications = graph.classify(snapshotId, { only: [] });
    // DEV-P2-10 (Stage G2): the same observed-evidence contract the `metrics` command
    // consumes — null is "never exercised", stated by omission; [] is an exercised,
    // quiet console. One owner (`observedSummaries`), two identical consumers.
    const observed = this.runtime.requireConsole().observedSummaries();
    const input: MetricInput = {
      snapshotId,
      units: stored.units,
      edges: stored.edges,
      classifications,
      coverage: graph.coverage(snapshotId),
      isProtected: this.runtime.isProtected,
      ...(observed === null ? {} : { consoleSignatures: observed }),
    };
    const computed = computeAllMetrics(input);
    const metricRecord = metrics.record(computed);

    const contested = new Set(
      (this.runtime.claims?.conflicts(true) ?? [])
        .flatMap((conflict) => conflict.claim_ids)
        .map((claimId) => this.runtime.claims?.getClaim(claimId)?.subject_key ?? '')
        .filter((subject) => subject.length > 0),
    );
    const ranked = rank({
      metrics: computed,
      units: stored.units,
      classifications,
      isProtected: this.runtime.isProtected,
      contestedSubjects: contested,
    });
    metrics.recordRanking(ranked, DEFAULT_WEIGHTS);

    const evidence = this.runtime.artifacts.putJson(
      {
        stage: 'SCREENED',
        cycle_id: cycle.id,
        snapshot_id: snapshotId,
        inputs,
        values_stored: metricRecord.value_count,
        corpus_size: computed.corpusSize,
        patch_candidates: ranked.patchCandidates.length,
        instrumentation_candidates: ranked.instrumentationCandidates.length,
        clarification_candidates: ranked.clarificationCandidates.length,
        excluded: ranked.excluded.length,
        families_unavailable: ranked.stats.familiesUnavailable,
        // DEV-P2-10: which evidence stage ranked. False is Stage G1 — every score a
        // static inference, stated; true is Stage G2 — the console ledger contributed.
        observed_evidence: ranked.stats.observedEvidenceAvailable,
        observed_signatures: observed?.length ?? 0,
      },
      { label: `cycle-${cycle.id}-screening.json` },
    );
    this.registry.advance(cycle.id, 'SCREENED', evidence);
    return {
      to: 'SCREENED',
      evidence,
      summary:
        `${metricRecord.value_count} values over ${computed.corpusSize} units; ` +
        `${ranked.patchCandidates.length} patch candidates; ` +
        (ranked.stats.observedEvidenceAvailable
          ? `${observed?.length ?? 0} observed signature(s) (Stage G2)`
          : 'observed evidence: none — Stage G1 static'),
    };
  }
}
