/**
 * Benchmark run — the control seam between the runner and durable evidence (DEV-P2-07, B4).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §18 (the closing run this seam will serve in B5) and
 *       §11 of the contract (execution-cost honesty); `CLUE_Architecture_v9.md` §8 (the CLI
 *       is a veneer over services; evidence is recorded once, by one owner); ADR-0010 (one
 *       artifact — the event binds the contract by content hash and the approved body by
 *       its integrity hash).
 * Precedent: `src/control/recognitionRun.ts` — the recognize command and the cycle
 *       orchestrator share one proven path so neither can fork it. The benchmark has the
 *       same two callers (`clue benchmark run` now, `stepClosingEvidence` in B5), so the
 *       resolve → run → record sequence lives here and nowhere else.
 *
 * ## The lock inversion, stated
 *
 * The harness drives `clue` itself as child processes, and those children take the
 * event-log writer lock (`recognize`, `metrics`, `init` all mutate). A parent that held
 * the lock across the run would deadlock its own scenarios. So the sequence is inverted
 * relative to most mutating commands:
 *
 *   1. **Unlocked:** resolve the contract, note the log head, execute the run — every
 *      child locks and releases on its own.
 *   2. **Locked (the caller's `withRuntime`):** append `benchmark.run_recorded` and store
 *      the result artifact — a short, ordinary mutation.
 *
 * The payload carries `log_head_before` (the head observed before the first scenario).
 * The head may move as the benchmark children and other legitimate writers append.
 * Subject identity is captured separately before any child and checked before recording.
 *
 * ## What is recorded, and what is not
 *
 * A completed run — scored or honestly incomplete — is recorded. A **refusal** is not: a
 * run that never ran left its explanation on the operator's console and its absence in
 * the log, and manufacturing an event for it would put a non-measurement where only
 * measurements belong. The §18 cycle step records absences its own way (`stated_absence`
 * in the closing evidence), which is the right ledger for them.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ClueConfig, EventRecord, ArtifactRef } from '../shared/schemas.js';
import { canonicalJson, hashBytes, hashCanonicalJson, requireSha256, type Sha256 } from '../shared/ids.js';
import { EventLog } from '../memory/eventLog.js';
import type { Runtime } from './runtime.js';
import {
  projectGovernanceBasisFromBinding,
  type ProjectGovernanceBasis,
} from './projectProfiles/projectGovernanceBasis.js';
import { resolveProjectRecognition } from './projectProfiles/projectRecognition.js';
import {
  captureBenchmarkProfileInputs,
  isBenchmarkProfileContract,
  type PreparedBenchmarkProfileInputs,
} from './projectProfiles/benchmarkProfileInputs.js';
import { requireCurrentProjectAuthority } from './projectProfiles/projectAuthority.js';
import { readActiveProjectProfileForBenchmark } from './projectProfiles/projectProfileStartup.js';
import { captureSnapshot } from '../analysis/source/snapshot.js';
import { requireProofExecutionBoundary } from '../benchmark/restrictedExecution.js';
import { assertExactRunInputs, captureExactRunInputs, type ExactRunInputs } from './exactRunInputs.js';
import {
  isCompleteCluBenchmarkV020,
  runMasterBenchmark,
  type BenchmarkMeasure,
  type RunOutcome,
} from '../benchmark/benchmarkRunner.js';

export const BENCHMARK_EVENT_TYPES = {
  runRecorded: 'benchmark.run_recorded',
} as const;

/** Where the contract came from: the registered input, or a path the operator named. */
export interface ResolvedContract {
  readonly path: string;
  readonly registered: boolean;
}

/**
 * Resolves which contract governs this run.
 *
 * With no explicit path, the registered input (`project.inputs.benchmark`) is the only
 * authority, and its absence refuses with the registration named — an unregistered
 * benchmark is a decision (`null` in the profile), and this seam does not quietly
 * substitute a file for a decision. A named out-of-registration file can be identified
 * for diagnostics, but the production execution seam refuses to run it.
 */
export function resolveContract(
  config: ClueConfig,
  explicitPath: string | undefined,
  cwd: string,
): ResolvedContract | { readonly error: string } {
  if (explicitPath !== undefined && explicitPath.trim() !== '') {
    const path = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    if (!existsSync(path)) return { error: `no contract at ${path}` };
    return { path, registered: false };
  }
  const registered = config.project.inputs.benchmark;
  if (registered === null) {
    return {
      error:
        'the Master Benchmark is unregistered — targets/' +
        `${config.project.active_target}/profile.yaml declares inputs.benchmark: null. ` +
        'Register the contract (template: templates/benchmark.template_v9.txt).',
    };
  }
  const path = isAbsolute(registered) ? registered : join(config.project.root, registered);
  if (!existsSync(path)) {
    return { error: `the registered benchmark at ${path} does not exist — a registration that lies` };
  }
  return { path, registered: true };
}

export interface PerformedRun {
  readonly outcome: RunOutcome;
  readonly contract: ResolvedContract;
  readonly log_head_before: { readonly sequence: number; readonly hash: string } | null;
  readonly subject: BenchmarkRunSubject | null;
}

export interface BenchmarkRunSubject {
  readonly snapshot_id: Sha256;
  readonly inputs: ExactRunInputs;
  readonly mission_version: string;
  readonly project_basis: ProjectGovernanceBasis | null;
  readonly config_sha256: Sha256;
  readonly registered: boolean;
  readonly contract_path: string;
  readonly contract_sha256: Sha256;
  readonly repo_root: string;
  readonly project_root: string;
  readonly workspace_root: string;
  readonly executable_inputs: {
    readonly node_sha256: Sha256;
    readonly engine_dist_id: Sha256 | null;
    readonly target_dist_id: Sha256 | null;
    readonly engine_dependencies_id: Sha256 | null;
    readonly target_dependencies_id: Sha256 | null;
  };
}

function recognitionSnapshot(runtime: Runtime): Sha256 {
  const recognition = resolveProjectRecognition(runtime);
  const manifest = captureSnapshot({
    root: recognition.targetRoot,
    sourceRoots: recognition.sourceRoots,
    exclude: recognition.excludedPaths,
  });
  return requireSha256(manifest.id, 'benchmark recognition snapshot');
}

function runnerDistIdentity(root: string): Sha256 | null {
  const dist = join(root, 'dist');
  if (!existsSync(dist)) return null;
  const manifest = captureSnapshot({ root: dist, sourceRoots: ['.'], excludeExtensions: ['tsbuildinfo'] });
  const skipped = manifest.skipped[0];
  if (skipped !== undefined) throw new Error(`Cannot pin benchmark build output: ${skipped.path} (${skipped.reason}).`);
  return requireSha256(manifest.id, 'benchmark build output');
}

function installedDependenciesIdentity(root: string): Sha256 | null {
  const directory = join(root, 'node_modules');
  if (!existsSync(directory)) return null;
  const physicalRoot = realpathSync.native(directory);
  const entries: Array<{ readonly path: string; readonly identity: string; readonly mode: number }> = [];
  const walk = (parent: string, prefix: string): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name === right.name ? 0 : 1,
    )) {
      const path = prefix + entry.name;
      const absolute = join(parent, entry.name);
      if (entry.isSymbolicLink()) {
        // npm's POSIX .bin links are normal. Their actual bytes are measured at their
        // destination within this same dependency tree.
        const target = relative(physicalRoot, realpathSync.native(absolute));
        if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) {
          throw new Error(`Cannot pin an installed dependency link outside node_modules: ${path}.`);
        }
        entries.push({ path, identity: `link:${target.split(sep).join('/')}`, mode: 0 });
      } else if (entry.isDirectory()) {
        walk(absolute, `${path}/`);
      } else if (entry.isFile()) {
        entries.push({ path, identity: hashBytes(readFileSync(absolute)), mode: statSync(absolute).mode & 0o111 });
      } else {
        throw new Error(`Cannot pin a non-file installed dependency: ${path}.`);
      }
    }
  };
  walk(physicalRoot, '');
  return hashCanonicalJson(entries);
}

export function captureBenchmarkExecutableInputs(
  repoRoot: string,
  projectRoot: string,
): BenchmarkRunSubject['executable_inputs'] {
  const engineDist = runnerDistIdentity(repoRoot);
  const engineDependencies = installedDependenciesIdentity(repoRoot);
  return {
    node_sha256: hashBytes(readFileSync(process.execPath)),
    engine_dist_id: engineDist,
    target_dist_id: repoRoot === projectRoot ? engineDist : runnerDistIdentity(projectRoot),
    engine_dependencies_id: engineDependencies,
    target_dependencies_id: repoRoot === projectRoot ? engineDependencies : installedDependenciesIdentity(projectRoot),
  };
}

function projectBasis(runtime: Runtime): ProjectGovernanceBasis | null {
  return runtime.projectBinding === null ? null : projectGovernanceBasisFromBinding(runtime.projectBinding);
}

function assertRegisteredContract(config: ClueConfig, path: string): void {
  const registered = resolveContract(config, undefined, config.project.root);
  if ('error' in registered) throw new Error(registered.error);
  if (realpathSync.native(registered.path) !== path) {
    throw new Error('The benchmark contract is not the current registered Master Benchmark.');
  }
}

/** Pins the run's subject while no benchmark child has started. */
export function prepareBenchmarkRunSubject(
  runtime: Runtime,
  contract: ResolvedContract,
  bytes?: Uint8Array,
): BenchmarkRunSubject {
  runtime.requireMission();
  const repoRoot = realpathSync.native(runtime.repoRoot);
  const projectRoot = realpathSync.native(runtime.config.project.root);
  const contractPath = realpathSync.native(contract.path);
  if (contract.registered) assertRegisteredContract(runtime.config, contractPath);
  const contractHash = hashBytes(readFileSync(contractPath));
  if (bytes !== undefined && hashBytes(bytes) !== contractHash) {
    throw new Error('Benchmark contract changed while its input was captured. Run the benchmark again.');
  }
  return {
    snapshot_id: recognitionSnapshot(runtime),
    inputs: captureExactRunInputs(projectRoot),
    mission_version: runtime.currentMissionId(),
    project_basis: projectBasis(runtime),
    config_sha256: hashCanonicalJson(runtime.config),
    registered: contract.registered,
    contract_path: contractPath,
    contract_sha256: contractHash,
    repo_root: repoRoot,
    project_root: projectRoot,
    workspace_root: realpathSync.native(runtime.workspaceRoot),
    executable_inputs: captureBenchmarkExecutableInputs(repoRoot, projectRoot),
  };
}

/** Refuses a completed run whose subject no longer matches the live locked recording context. */
export function assertBenchmarkRunSubject(runtime: Runtime, performed: PerformedRun): BenchmarkRunSubject {
  const { subject, outcome, contract } = performed;
  if (!outcome.ok || subject === null) throw new Error('Benchmark run has no pinned subject.');
  runtime.requireMission();
  if (
    runtime.currentMissionId() !== subject.mission_version ||
    canonicalJson(projectBasis(runtime)) !== canonicalJson(subject.project_basis) ||
    hashCanonicalJson(runtime.config) !== subject.config_sha256 ||
    realpathSync.native(runtime.repoRoot) !== subject.repo_root ||
    realpathSync.native(runtime.config.project.root) !== subject.project_root ||
    realpathSync.native(runtime.workspaceRoot) !== subject.workspace_root
  ) {
    throw new Error('Benchmark mission, project or workspace changed during execution. Run the benchmark again.');
  }
  if (contract.registered !== subject.registered) throw new Error('Benchmark registration changed during execution.');
  if (subject.registered) assertRegisteredContract(runtime.config, subject.contract_path);
  if (
    realpathSync.native(contract.path) !== subject.contract_path ||
    realpathSync.native(outcome.contract.path) !== subject.contract_path ||
    outcome.contract.sha256 !== subject.contract_sha256 ||
    hashBytes(readFileSync(subject.contract_path)) !== subject.contract_sha256
  ) {
    throw new Error('Benchmark contract changed during execution. Run the benchmark again.');
  }
  if (recognitionSnapshot(runtime) !== subject.snapshot_id) {
    throw new Error('Benchmark recognition snapshot changed during execution. Run the benchmark again.');
  }
  assertExactRunInputs(subject.project_root, subject.inputs, 'Benchmark subject');
  if (
    canonicalJson(captureBenchmarkExecutableInputs(subject.repo_root, subject.project_root)) !==
    canonicalJson(subject.executable_inputs)
  ) {
    throw new Error('Benchmark executable inputs changed during execution. Rebuild and run the benchmark again.');
  }
  return subject;
}

/**
 * Phase 1 — the unlocked run. Reads the head (statically, no lock), then executes the
 * harness with the runner's own execution authority. The caller must not hold the writer
 * lock across this call; the children need it.
 */
export async function performBenchmarkRun(deps: {
  readonly repoRoot: string;
  readonly config: ClueConfig;
  readonly contract: ResolvedContract;
  readonly expectedContractSha256?: string;
  readonly expectedMissionVersion?: string;
  readonly baseline?: readonly BenchmarkMeasure[] | null;
  readonly log?: (line: string) => void;
}): Promise<PerformedRun> {
  let prepared: {
    readonly bytes: Buffer;
    readonly subject: BenchmarkRunSubject;
    readonly head: PerformedRun['log_head_before'];
    readonly profileInputs: PreparedBenchmarkProfileInputs | null;
  };
  try {
    if (!deps.contract.registered) throw new Error('Execution requires the registered Master Benchmark. Run clue benchmark run without --contract.');
    requireProofExecutionBoundary();
    // Runtime assembles the proof-board projection, which imports the event identity here.
    // The preparation phase runs only after those modules have finished loading.
    const { withRuntime } = await import('./runtime.js');
    const activeProfile = process.platform === 'win32' ? readActiveProjectProfileForBenchmark(deps.repoRoot) : null;
    prepared = withRuntime({
      repoRoot: deps.repoRoot,
      withLog: false,
      requireMission: true,
      ...(activeProfile === null ? {} : { projectProfile: activeProfile }),
    }, (runtime) => {
      const bytes = readFileSync(deps.contract.path);
      const subject = prepareBenchmarkRunSubject(runtime, deps.contract, bytes);
      if (
        subject.project_root !== realpathSync.native(resolve(deps.repoRoot, deps.config.project.root)) ||
        subject.workspace_root !== realpathSync.native(resolve(deps.repoRoot, deps.config.workspace.root)) ||
        (deps.expectedContractSha256 !== undefined && subject.contract_sha256 !== deps.expectedContractSha256) ||
        (deps.expectedMissionVersion !== undefined && subject.mission_version !== deps.expectedMissionVersion)
      ) {
        throw new Error('Benchmark project, workspace, mission or locked contract changed before execution.');
      }
      const eventsDir = runtime.projectState?.eventLogRoot ?? join(runtime.workspaceRoot, 'events');
      const head = existsSync(eventsDir) ? EventLog.readHead(eventsDir) : null;
      let profileInputs: PreparedBenchmarkProfileInputs | null = null;
      if (activeProfile !== null && isBenchmarkProfileContract(subject.contract_sha256)) {
        const binding = runtime.projectBinding;
        if (binding === null || binding.authority.manifest === null ||
            binding.authorityConflicts.state !== 'CLEAR' || binding.benchmarkRuntime.state !== 'READY') {
          throw new Error('Supervised benchmark needs current and verified Project Profile authority.');
        }
        const manifest = binding.authority.manifest;
        profileInputs = {
          bytes: captureBenchmarkProfileInputs({
            repoRoot: subject.repo_root,
            missionVersion: subject.mission_version,
            record: activeProfile,
            documents: manifest.documents,
          }),
          verifyCurrent: () => {
            const current = readActiveProjectProfileForBenchmark(subject.repo_root);
            if (current === null || canonicalJson(current) !== canonicalJson(activeProfile) ||
                requireCurrentProjectAuthority(current).manifestHash !== manifest.manifestHash) {
              throw new Error('Active profile or exact authority changed during the supervised benchmark.');
            }
          },
        };
      }
      return {
        bytes,
        subject,
        head: head === null ? null : { sequence: head.sequence, hash: head.hash },
        profileInputs,
      };
    });
  } catch (error) {
    return {
      outcome: { ok: false, stage: 'subject', reason: error instanceof Error ? error.message : String(error) },
      contract: deps.contract,
      log_head_before: null,
      subject: null,
    };
  }
  let outcome = await runMasterBenchmark({
    repoRoot: prepared.subject.repo_root,
    projectRoot: prepared.subject.project_root,
    workspaceRoot: prepared.subject.workspace_root,
    contractPath: prepared.subject.contract_path,
    contractBytes: prepared.bytes,
    ...(prepared.profileInputs === null ? {} : { benchmarkProfileInputs: prepared.profileInputs }),
    baseline: deps.baseline ?? null,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });
  if (outcome.ok && prepared.profileInputs !== null) {
    try {
      prepared.profileInputs.verifyCurrent();
    } catch (error) {
      outcome = { ok: false, stage: 'subject', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    outcome,
    contract: deps.contract,
    log_head_before: prepared.head,
    subject: prepared.subject,
  };
}

export interface BenchmarkRunReceipt {
  readonly event: EventRecord;
  readonly artifact: ArtifactRef;
}

/**
 * The moved-world gate before a §18 closing run (B5).
 *
 * The lock is the world (§2/§3.3): a closing run must exercise exactly the contract the
 * cycle locked, byte for byte, so the file is re-hashed with the same `hashBytes` the lock
 * used and any disagreement refuses **before** ninety minutes of measurement, not after.
 * A drifted contract is §21.3 territory — restart or a new cycle over the moved world —
 * never something a closing run quietly absorbs.
 */
export function verifyLockedContract(
  projectRoot: string,
  locked: { readonly path: string; readonly sha256: string },
): { readonly path: string } | { readonly error: string } {
  const absolute = isAbsolute(locked.path) ? locked.path : join(projectRoot, ...locked.path.split('/'));
  if (!existsSync(absolute)) {
    return {
      error: `the locked Master Benchmark (${locked.path}) is absent on disk — a registration that lies; §21.3 applies`,
    };
  }
  const onDisk = hashBytes(readFileSync(absolute));
  if (onDisk !== locked.sha256) {
    return {
      error:
        `the Master Benchmark on disk (${onDisk.slice(0, 12)}…) differs from the one this cycle ` +
        `locked (${locked.sha256.slice(0, 12)}…) — a moved world; restart under §21.3 or open a new ` +
        'cycle over it',
    };
  }
  return { path: absolute };
}

/**
 * Phase 2 — the locked record. One event, one artifact. The event carries the summary a
 * projector or a human scans (identity, score, counts, the protective quartet); the
 * artifact carries the whole outcome — measures with raw samples, policy, timing, budget —
 * exactly as §18 requires native units and raw evidence preserved.
 */
export function recordBenchmarkRun(runtime: Runtime, performed: PerformedRun): BenchmarkRunReceipt {
  if (!performed.outcome.ok) {
    throw new Error(
      `a refused run is not recordable (stage ${performed.outcome.stage}): ${performed.outcome.reason}`,
    );
  }
  const log = runtime.log;
  if (log === null) throw new Error('recordBenchmarkRun needs a runtime opened with the log.');
  const { result, contract, timing, policy, budget } = performed.outcome;

  // The mission gate: recording against nothing is refused, and the event binds the same
  // canonical mission-id string every other appender uses (`runtime.currentMissionId()`).
  const subject = assertBenchmarkRunSubject(runtime, performed);
  const boundary = performed.outcome.execution_boundary;
  const proofEligible = performed.contract.registered && boundary !== undefined && !budget.exhausted &&
    result.measures.some((measure) => measure.warmup_samples !== undefined) &&
    (contract.benchmark_id !== 'clu-master' || contract.benchmark_version !== '0.2.0' ||
      isCompleteCluBenchmarkV020(result));

  const artifact = runtime.artifacts.putJson(
    {
      result,
      contract,
      timing,
      policy,
      budget,
      inputs: subject.inputs,
      executable_inputs: subject.executable_inputs,
      config_sha256: subject.config_sha256,
      proof_eligible: proofEligible,
      ...(boundary === undefined ? {} : { execution_boundary: boundary }),
      ...(subject.project_basis === null ? {} : { project_basis: subject.project_basis }),
    },
    { label: `benchmark-run-${contract.benchmark_version}-${timing.started_at}.json` },
  );

  const event = log.append({
    type: BENCHMARK_EVENT_TYPES.runRecorded,
    actor: 'cli',
    missionVersion: subject.mission_version,
    subjectId: null,
    payload: {
      registered: performed.contract.registered,
      proof_eligible: proofEligible,
      ...(boundary === undefined ? {} : { execution_boundary: boundary }),
      snapshot_id: subject.snapshot_id,
      inputs_id: subject.inputs.id,
      executable_inputs: subject.executable_inputs,
      config_sha256: subject.config_sha256,
      ...(subject.project_basis === null ? {} : { project_basis: subject.project_basis }),
      contract: {
        path: subject.contract_path,
        sha256: contract.sha256,
        benchmark_id: contract.benchmark_id,
        benchmark_version: contract.benchmark_version,
        block_id: contract.block_id,
        runner_adapter: contract.runner_adapter,
        integrity_sha256: contract.integrity_sha256,
      },
      result_artifact: artifact,
      unified_score: result.unifiedScore,
      measures_count: result.measures.length,
      incomplete_count: result.incomplete.length,
      protective: result.protective,
      environment: result.environment,
      log_head_before: performed.log_head_before,
      started_at: timing.started_at,
      finished_at: timing.finished_at,
      wall_ms: Math.round(timing.wall_ms),
      budget_exhausted: budget.exhausted,
    },
  });
  runtime.projections.sync(log);
  return { event, artifact };
}
