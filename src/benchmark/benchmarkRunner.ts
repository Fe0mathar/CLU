/**
 * Master Benchmark runner — execution authority over the contract's harness (DEV-P2-07, B3).
 *
 * Spec: ADR-0010 (one artifact; the runner "extracts the fenced body, verifies `integrity`
 *       against it, syntax-checks it, and refuses rather than scoring on a body that does
 *       not parse"); `CLUE_Execution_Model_v9.md` §17–§18 (what a run is for) and §11
 *       governance of the draft contract (`execution_cost_budget` — a run exceeding it is
 *       incomplete, not slow); `CLUE_Project_Directory_v9.md` §15.3 (runner owns
 *       deterministic execution; the harness gets no execution authority of its own);
 *       `targets/clu/benchmark/master-benchmark.md` §11a (the context contract this module
 *       implements, field for field).
 *
 * ## The refusal ladder, in order
 *
 * Every way a run can fail to be a run is named before any body executes, and each is a
 * distinct `stage` so the suite can pin them one by one:
 *
 *   `read`      the contract file is missing or unreadable — a registration that lies
 *   `contract`  the document's grammar refused (`readBenchmarkContract`)
 *   `select`    no block — or more than one — for this adapter
 *   `language`  the block declares a language this runner cannot execute
 *   `integrity` unrecorded (draft never approved) or mismatched (body is not the body approved)
 *   `syntax`    the body does not parse — fails at extraction, never a silent zero
 *   `execute`   the body threw at runtime
 *   `shape`     the returned value is not the contract's result shape
 *   `version`   the body's `benchmarkVersion` disagrees with the document's — the run is VOID
 *
 * A refusal is an outcome, not an exception: `runMasterBenchmark` returns the union and
 * throws only on defects in its own machinery.
 *
 * ## Execution authority
 *
 * The harness body executes in a permission-restricted Node worker. It has no access to
 * parent objects, process environment, native modules or commands. Its command requests
 * pass through the parent broker and an independently restricted execution boundary.
 * The parent bounds command and worker time and accounts for the approved executions.
 *
 * On Windows, `npm` is a `.cmd` shim that `spawn` refuses without a shell (the
 * CVE-2024-27980 hardening), so an `npm`-prefixed argv is translated to
 * `cmd.exe /d /s /c npm …`. The arguments involved are fixed strings from the harness, not
 * interpolated user input, which is what makes the translation safe to do at all.
 *
 * ## Execution policy
 *
 * §4 governs from the contract: `readExecutionPolicy` (the grammar owner) supplies the
 * four numbers, and precedence is fixed and narrow — `DEFAULT_EXECUTION_POLICY` fills
 * only what the contract omits, and the caller's explicit `options.policy` overrides both
 * (that override exists for tests and diagnostics; a recorded run passes none). The
 * constant carries §4's shipped values so a contract silent on a field still runs under
 * the reviewed numbers rather than an invented zero.
 *
 * ## Gate evaluation
 *
 * `evaluateGates` renders §7 of `clu-master` 0.1.x and 0.2.0 executable: two invalidate-run gates,
 * two block-equilibrium gates, one advisory. The contract states the rules as reviewed
 * prose rather than machine blocks, so the executable rendering lives here **and refuses
 * any other contract identity** — a different benchmark or a different major must bring its
 * own rendering rather than inherit this one silently. A mandatory gate that cannot be
 * evaluated (a protective signal missing on either side) fails conservatively: protection
 * that cannot be proven is not protection.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { z } from 'zod';

import { hashBytes, nowIso, type Sha256 } from '../shared/ids.js';
import { executeBenchmarkHarness } from './benchmarkHarnessProcess.js';
import { createRestrictedExecution, type ExecutionBoundary } from './restrictedExecution.js';
import {
  isBenchmarkProfileContract,
  type PreparedBenchmarkProfileInputs,
} from '../control/projectProfiles/benchmarkProfileInputs.js';
import {
  readBenchmarkContract,
  readExecutionPolicy,
  selectHarnessBlock,
  verifyHarnessIntegrity,
  type ContractIdentity,
  type ExecutionPolicyRead,
  type HarnessBlock,
} from './harnessBlock.js';

/* ------------------------------------------------------------------------- */
/* Execution primitive                                                        */
/* ------------------------------------------------------------------------- */

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
  readonly timedOut: boolean;
}

export interface ExecOptions {
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

export type ExecFn = (argv: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

/** §4's values, as the executable copy of the draft's prose rendering (see header). */
export const DEFAULT_EXECUTION_POLICY = {
  repetitions: 3,
  warmupRuns: 1,
  scenarioTimeoutSeconds: 1800,
  maxTotalRuntimeSeconds: 5400,
} as const;

export interface ExecutionPolicy {
  readonly repetitions: number;
  readonly warmupRuns: number;
  readonly scenarioTimeoutSeconds: number;
  readonly maxTotalRuntimeSeconds: number;
}

const KILL_GRACE_MS = 5000;

/** Maps §4's read fields onto the runner's policy, dropping nulls so defaults fill only true absences. */
function contractPolicy(read: ExecutionPolicyRead): Partial<ExecutionPolicy> {
  const partial: {
    repetitions?: number;
    warmupRuns?: number;
    scenarioTimeoutSeconds?: number;
    maxTotalRuntimeSeconds?: number;
  } = {};
  if (read.default_repetitions !== null) partial.repetitions = read.default_repetitions;
  if (read.default_warmup_runs !== null) partial.warmupRuns = read.default_warmup_runs;
  if (read.default_timeout_seconds !== null) partial.scenarioTimeoutSeconds = read.default_timeout_seconds;
  if (read.maximum_total_runtime_seconds !== null) partial.maxTotalRuntimeSeconds = read.maximum_total_runtime_seconds;
  return partial;
}

/** Windows: `npm` is a `.cmd` shim spawn refuses shell-less; translate (fixed args only). */
export function platformArgv(argv: readonly string[], platform: NodeJS.Platform): readonly string[] {
  if (platform === 'win32' && argv[0] === 'npm') {
    return ['cmd.exe', '/d', '/s', '/c', ...argv];
  }
  return argv;
}

/**
 * Builds the runner's exec: cwd pinned to the target, timeout enforced with
 * SIGTERM→SIGKILL, wall time measured here, and the cumulative budget applied *before*
 * each spawn so an exhausted run stops cleanly instead of starting work it cannot finish.
 */
export function makeExec(deps: {
  readonly cwd: string;
  readonly policy: ExecutionPolicy;
  readonly platform?: NodeJS.Platform;
  readonly onSpend?: (wallMs: number) => void;
}): { readonly exec: ExecFn; readonly spentMs: () => number; readonly exhausted: () => boolean } {
  const platform = deps.platform ?? process.platform;
  let spent = 0;
  let exhausted = false;

  const exec: ExecFn = async (argv, opts) => {
    if (exhausted || spent >= deps.policy.maxTotalRuntimeSeconds * 1000) {
      exhausted = true;
      return {
        code: -1,
        stdout: '',
        stderr: `maximum_total_runtime_seconds (${deps.policy.maxTotalRuntimeSeconds}) exhausted — the run is incomplete, not slow`,
        wallMs: 0,
        timedOut: true,
      };
    }
    const [command, ...args] = platformArgv(argv, platform);
    if (command === undefined) {
      return { code: -1, stdout: '', stderr: 'empty argv', wallMs: 0, timedOut: false };
    }
    const timeoutMs = (opts?.timeoutSeconds ?? deps.policy.scenarioTimeoutSeconds) * 1000;
    const started = performance.now();

    return await new Promise<ExecResult>((resolvePromise) => {
      const child = spawn(command, args, { cwd: deps.cwd, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      }, timeoutMs);
      killTimer.unref();

      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        const wallMs = performance.now() - started;
        spent += wallMs;
        deps.onSpend?.(wallMs);
        resolvePromise({ code, stdout, stderr, wallMs, timedOut });
      };

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', (error) => {
        stderr += String(error.message);
        settle(-1);
      });
      child.on('close', (code) => settle(code ?? -1));
    });
  };

  return { exec, spentMs: () => spent, exhausted: () => exhausted };
}

/* ------------------------------------------------------------------------- */
/* The result shape — the contract's, validated strictly                      */
/* ------------------------------------------------------------------------- */

export const benchmarkMeasureSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    scenario: z.string().min(1),
    native_unit: z.string().min(1),
    aggregation: z.string().min(1),
    value: z.number().finite(),
    samples: z.array(z.number().finite()).min(1),
    /** Raw observations from the warm-up phase, excluded from the aggregate. */
    warmup_samples: z.array(z.number().finite()).optional(),
  })
  .strict();

export const benchmarkResultSchema = z
  .object({
    benchmarkVersion: z.string().min(1),
    unifiedScore: z.number().finite().positive().nullable(),
    measures: z.array(benchmarkMeasureSchema),
    protective: z.array(z.object({ id: z.string().min(1), value: z.number().finite().nullable() }).strict()),
    environment: z
      .object({ node_version: z.string().min(1), platform: z.string().min(1), arch: z.string().min(1) })
      .strict(),
    incomplete: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) }).strict()),
  })
  .strict();

export type BenchmarkMeasure = z.infer<typeof benchmarkMeasureSchema>;
export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;

/** clu-master 0.2.0 declares all thirteen signals required for proof. */
export function isCompleteCluBenchmarkV020(result: BenchmarkResult): boolean {
  const ids = new Set(result.measures.map((measure) => measure.id));
  return result.incomplete.length === 0 && result.measures.length === 13 &&
    Array.from({ length: 13 }, (_, index) => `SIG-${String(index + 1).padStart(3, '0')}`)
      .every((id) => ids.has(id));
}

/* ------------------------------------------------------------------------- */
/* Running                                                                    */
/* ------------------------------------------------------------------------- */

export interface RunOptions {
  /** CLU-E repository root (locates the built CLI the harness drives). */
  readonly repoRoot: string;
  /** The target repository — cwd of every spawned process. */
  readonly projectRoot: string;
  /** The CLU-E workspace for this target (the harness reads the graph pointer under it). */
  readonly workspaceRoot: string;
  /** Absolute path of the registered Master Benchmark contract. */
  readonly contractPath: string;
  /** Bytes captured before execution when a caller has pinned the contract. */
  readonly contractBytes?: Uint8Array;
  /** The runner adapter to select a block for. This module executes `cli-node`. */
  readonly runnerAdapter?: string;
  /** Opening run's measures, when scoring a closing run; null on a baseline run. */
  readonly baseline?: readonly BenchmarkMeasure[] | null;
  readonly policy?: Partial<ExecutionPolicy>;
  /** A frozen proof may shorten the benchmark's runtime budget. */
  readonly maxProofDurationSeconds?: number;
  /** Tests inject a fake; production uses the restricted broker. */
  readonly execImpl?: ExecFn;
  /** Production candidate callers may supply an already-bound restricted command broker. */
  readonly executionBoundary?: ExecutionBoundary;
  readonly mode?: 'baseline' | 'candidate';
  /** Captured by the host from the verified v3 self-target mission. */
  readonly benchmarkProfileInputs?: PreparedBenchmarkProfileInputs;
  readonly environment?: BenchmarkResult['environment'];
  readonly log?: (line: string) => void;
}

export type RunRefusalStage =
  | 'read'
  | 'subject'
  | 'contract'
  | 'select'
  | 'language'
  | 'integrity'
  | 'syntax'
  | 'execute'
  | 'shape'
  | 'version';

export type RunOutcome =
  | {
      readonly ok: true;
      readonly result: BenchmarkResult;
      readonly contract: {
        readonly path: string;
        readonly sha256: Sha256;
        readonly benchmark_id: string;
        readonly benchmark_version: string;
        readonly block_id: string;
        readonly runner_adapter: string;
        readonly integrity_sha256: Sha256;
      };
      readonly timing: { readonly started_at: string; readonly finished_at: string; readonly wall_ms: number };
      readonly policy: ExecutionPolicy;
      readonly budget: { readonly spent_ms: number; readonly exhausted: boolean };
      readonly execution_boundary?: ExecutionBoundary;
    }
  | { readonly ok: false; readonly stage: RunRefusalStage; readonly reason: string };

/**
 * Runs the Master Benchmark for one adapter, refusals first.
 *
 * The happy path binds the run to the contract by content (`contract.sha256` over the
 * whole document — the same identity the cycle lock hashes) and by the approved body
 * (`integrity_sha256`), so the event this run becomes can say exactly which measuring
 * stick measured.
 */
export async function runMasterBenchmark(options: RunOptions): Promise<RunOutcome> {
  let bytes: Buffer;
  try {
    bytes = options.contractBytes === undefined
      ? readFileSync(options.contractPath)
      : Buffer.from(options.contractBytes);
  } catch (error) {
    return {
      ok: false,
      stage: 'read',
      reason: `the registered contract at ${options.contractPath} could not be read: ${String((error as Error).message)}`,
    };
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return { ok: false, stage: 'read', reason: `contract at ${options.contractPath} is not valid UTF-8` };
  }

  const read = readBenchmarkContract(text);
  if ('error' in read) return { ok: false, stage: 'contract', reason: read.error };
  if (options.benchmarkProfileInputs !== undefined && (!isBenchmarkProfileContract(hashBytes(bytes)) ||
      read.identity.benchmark_id !== 'clu-master' || read.identity.benchmark_version !== '0.2.0')) {
    return { ok: false, stage: 'contract', reason: 'Supervised profile inputs require the exact clu-master@0.2.0 contract.' };
  }

  const policyRead = readExecutionPolicy(text);
  if ('error' in policyRead) return { ok: false, stage: 'contract', reason: policyRead.error };

  const adapter = options.runnerAdapter ?? 'cli-node';
  const selected = selectHarnessBlock(read, adapter);
  if ('error' in selected) return { ok: false, stage: 'select', reason: selected.error };
  const block: HarnessBlock = selected;

  if (block.language !== 'javascript') {
    return {
      ok: false,
      stage: 'language',
      reason: `harness ${block.id} declares language ${JSON.stringify(block.language)}; this runner executes javascript only`,
    };
  }

  const integrity = verifyHarnessIntegrity(block);
  if (!integrity.ok) return { ok: false, stage: 'integrity', reason: integrity.reason };
  // Narrowed by the check above: an unrecorded integrity cannot reach here.
  const integritySha = block.integrity.state === 'declared' ? block.integrity.sha256 : block.body_sha256;

  const policy: ExecutionPolicy = {
    ...DEFAULT_EXECUTION_POLICY,
    ...contractPolicy(policyRead),
    ...options.policy,
  };
  const context = {
    repoRoot: options.repoRoot,
    workspaceRoot: options.workspaceRoot,
    cliArgv: [process.execPath, `${options.repoRoot}/dist/src/cli/index.js`],
    npmArgv: ['npm'],
    nodeArgv: [process.execPath],
    baseline: options.baseline ?? null,
    repetitions: policy.repetitions,
    warmupRuns: policy.warmupRuns,
    environment:
      options.environment ??
      ({ node_version: process.version, platform: process.platform, arch: process.arch } as const),
  };

  const startedAt = nowIso();
  const startedMs = performance.now();
  let returned: unknown;
  let restricted: ReturnType<typeof createRestrictedExecution> | null = null;
  let boundary = options.executionBoundary;
  let spentMs = 0;
  let exhausted = false;
  const totalMs = Math.min(policy.maxTotalRuntimeSeconds, options.maxProofDurationSeconds ?? 7200, 7200) * 1000;
  try {
    if (options.execImpl === undefined) {
      restricted = createRestrictedExecution({
        repoRoot: options.repoRoot,
        projectRoot: options.projectRoot,
        workspaceRoot: options.workspaceRoot,
        mode: options.mode ?? 'baseline',
        ...(options.benchmarkProfileInputs === undefined ? {} : {
          benchmarkProfileInputs: options.benchmarkProfileInputs,
        }),
      });
      boundary = restricted.boundary;
    }
    const command = options.execImpl ?? restricted?.exec;
    if (command === undefined) throw new Error('Benchmark command broker is absent.');
    const result = await executeBenchmarkHarness({
      body: block.body,
      context,
      deadlineMs: totalMs,
      ...(options.log === undefined ? {} : { log: options.log }),
      exec: async (argv, opts) => {
        const remaining = totalMs - spentMs;
        if (remaining <= 0) {
          exhausted = true;
          return { code: -1, stdout: '', stderr: 'Benchmark execution budget exhausted.', wallMs: 0, timedOut: true };
        }
        const commandResult = await command(argv, {
          ...opts,
          timeoutSeconds: Math.min(
            opts?.timeoutSeconds ?? policy.scenarioTimeoutSeconds,
            policy.scenarioTimeoutSeconds,
            remaining / 1000,
          ),
        });
        spentMs += commandResult.wallMs;
        if (spentMs >= totalMs) exhausted = true;
        return commandResult;
      },
    });
    if (!result.ok) return { ...result, reason: `harness ${block.id}: ${result.reason}` };
    returned = result.value;
  } catch (error) {
    return {
      ok: false,
      stage: 'execute',
      reason: `harness ${block.id}: ${String(error instanceof Error ? error.message : error).slice(0, 400)}`,
    };
  } finally {
    restricted?.dispose();
  }
  const finishedAt = nowIso();
  const wallMs = performance.now() - startedMs;

  const parsed = benchmarkResultSchema.safeParse(returned);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      stage: 'shape',
      reason: `harness ${block.id} returned a value that is not the contract's result shape: ${issue === undefined ? 'unknown issue' : `${issue.path.join('.')} — ${issue.message}`}`,
    };
  }

  if (parsed.data.benchmarkVersion !== read.identity.benchmark_version) {
    return {
      ok: false,
      stage: 'version',
      reason:
        `VOID — the body reports benchmarkVersion ${JSON.stringify(parsed.data.benchmarkVersion)} but the ` +
        `document governs ${JSON.stringify(read.identity.benchmark_version)}; a run whose body and contract ` +
        'disagree about which version measured has no version',
    };
  }

  return {
    ok: true,
    result: parsed.data,
    contract: {
      path: options.contractPath,
      sha256: hashBytes(bytes),
      benchmark_id: read.identity.benchmark_id,
      benchmark_version: read.identity.benchmark_version,
      block_id: block.id,
      runner_adapter: block.runner_adapter,
      integrity_sha256: integritySha,
    },
    timing: { started_at: startedAt, finished_at: finishedAt, wall_ms: wallMs },
    policy,
    budget: {
      spent_ms: spentMs,
      exhausted,
    },
    ...(boundary === undefined ? {} : { execution_boundary: boundary }),
  };
}

/* ------------------------------------------------------------------------- */
/* §7 gates — the executable rendering for clu-master 0.1.x and 0.2.0         */
/* ------------------------------------------------------------------------- */

export interface GateEvaluation {
  readonly id: string;
  readonly severity: 'mandatory' | 'advisory';
  readonly failure_action: 'invalidate-run' | 'block-equilibrium' | 'create-candidate-seed';
  readonly outcome: 'pass' | 'fail' | 'unevaluable';
  readonly detail: string;
}

export interface GateReport {
  readonly run_verdict: 'valid' | 'void';
  readonly equilibrium_blocked: boolean;
  readonly candidate_seed: boolean;
  readonly gates: readonly GateEvaluation[];
}

const GATE_TIMING_IDS = ['SIG-001', 'SIG-006', 'SIG-007', 'SIG-009', 'SIG-010', 'SIG-011'] as const;

function valueOf(measures: readonly BenchmarkMeasure[], id: string): number | undefined {
  return measures.find((measure) => measure.id === id)?.value;
}

/**
 * Evaluates §7's five gates between an opening and a closing run.
 *
 * Refuses any contract identity other than `clu-master` 0.1.x or 0.2.0 — see the header for why
 * the rendering is identity-bound. `declared_removal` is GATE-002's escape hatch as
 * written in the contract ("without a declared removal"); the caller asserts it, this
 * function records it, and the gate then passes with the deltas named rather than hidden.
 */
export function evaluateGates(input: {
  readonly identity: ContractIdentity;
  readonly opening: readonly BenchmarkMeasure[];
  readonly closing: readonly BenchmarkMeasure[];
  readonly declared_removal?: boolean;
}): GateReport | { readonly error: string } {
  const { identity, opening, closing } = input;
  if (identity.benchmark_id !== 'clu-master' ||
      (!identity.benchmark_version.startsWith('0.1.') && identity.benchmark_version !== '0.2.0')) {
    return {
      error:
        `no executable gate rendering for ${identity.benchmark_id}@${identity.benchmark_version} — ` +
        'this evaluator renders §7 of clu-master 0.1.x and 0.2.0',
    };
  }

  const gates: GateEvaluation[] = [];
  const pair = (id: string): { open: number; close: number } | null => {
    const open = valueOf(opening, id);
    const close = valueOf(closing, id);
    return open === undefined || close === undefined ? null : { open, close };
  };

  // GATE-001 — SIG-012 must not decrease and SIG-013 must not increase.
  {
    const pass12 = pair('SIG-012');
    const pass13 = pair('SIG-013');
    if (pass12 === null || pass13 === null) {
      gates.push({
        id: 'GATE-001',
        severity: 'mandatory',
        failure_action: 'invalidate-run',
        outcome: 'unevaluable',
        detail: 'tests-passing or tests-skipped missing on one side — protection unproven is protection failed',
      });
    } else {
      const ok = pass12.close >= pass12.open && pass13.close <= pass13.open;
      gates.push({
        id: 'GATE-001',
        severity: 'mandatory',
        failure_action: 'invalidate-run',
        outcome: ok ? 'pass' : 'fail',
        detail: `SIG-012 ${pass12.open}→${pass12.close}, SIG-013 ${pass13.open}→${pass13.close}`,
      });
    }
  }

  // GATE-002 — SIG-003/SIG-004 must not decrease by more than 0.5% without a declared removal.
  {
    const units = pair('SIG-003');
    const edges = pair('SIG-004');
    if (units === null || edges === null) {
      gates.push({
        id: 'GATE-002',
        severity: 'mandatory',
        failure_action: 'invalidate-run',
        outcome: 'unevaluable',
        detail: 'units or edges missing on one side',
      });
    } else {
      const withinUnits = units.close >= units.open * 0.995;
      const withinEdges = edges.close >= edges.open * 0.995;
      const detail = `SIG-003 ${units.open}→${units.close}, SIG-004 ${edges.open}→${edges.close}`;
      if (withinUnits && withinEdges) {
        gates.push({ id: 'GATE-002', severity: 'mandatory', failure_action: 'invalidate-run', outcome: 'pass', detail });
      } else if (input.declared_removal === true) {
        gates.push({
          id: 'GATE-002',
          severity: 'mandatory',
          failure_action: 'invalidate-run',
          outcome: 'pass',
          detail: `${detail} — beyond 0.5% but covered by a declared removal`,
        });
      } else {
        gates.push({
          id: 'GATE-002',
          severity: 'mandatory',
          failure_action: 'invalidate-run',
          outcome: 'fail',
          detail: `${detail} — decrease beyond 0.5% with no declared removal`,
        });
      }
    }
  }

  // GATE-003 — SIG-005 must not increase.
  {
    const unresolved = pair('SIG-005');
    gates.push(
      unresolved === null
        ? {
            id: 'GATE-003',
            severity: 'mandatory',
            failure_action: 'block-equilibrium',
            outcome: 'unevaluable',
            detail: 'unresolved-imports missing on one side',
          }
        : {
            id: 'GATE-003',
            severity: 'mandatory',
            failure_action: 'block-equilibrium',
            outcome: unresolved.close <= unresolved.open ? 'pass' : 'fail',
            detail: `SIG-005 ${unresolved.open}→${unresolved.close}`,
          },
    );
  }

  // GATE-004 — SIG-008 must not decrease.
  {
    const stored = pair('SIG-008');
    gates.push(
      stored === null
        ? {
            id: 'GATE-004',
            severity: 'mandatory',
            failure_action: 'block-equilibrium',
            outcome: 'unevaluable',
            detail: 'metric-values-stored missing on one side',
          }
        : {
            id: 'GATE-004',
            severity: 'mandatory',
            failure_action: 'block-equilibrium',
            outcome: stored.close >= stored.open ? 'pass' : 'fail',
            detail: `SIG-008 ${stored.open}→${stored.close}`,
          },
    );
  }

  // GATE-005 — advisory: no timing signal regresses more than 10% against the opening run.
  {
    const offenders: string[] = [];
    let comparable = 0;
    for (const id of GATE_TIMING_IDS) {
      const timing = pair(id);
      if (timing === null) continue;
      comparable += 1;
      if (timing.close > timing.open * 1.1) offenders.push(`${id} ${Math.round(timing.open)}→${Math.round(timing.close)} ms`);
    }
    gates.push(
      comparable === 0
        ? {
            id: 'GATE-005',
            severity: 'advisory',
            failure_action: 'create-candidate-seed',
            outcome: 'unevaluable',
            detail: 'no timing signal present on both sides',
          }
        : {
            id: 'GATE-005',
            severity: 'advisory',
            failure_action: 'create-candidate-seed',
            outcome: offenders.length === 0 ? 'pass' : 'fail',
            detail: offenders.length === 0 ? `${comparable} timing signal(s) within 10%` : offenders.join('; '),
          },
    );
  }

  const failedOrUnprovable = (gate: GateEvaluation) => gate.outcome === 'fail' || gate.outcome === 'unevaluable';
  const voided = gates.some((gate) => gate.failure_action === 'invalidate-run' && failedOrUnprovable(gate));
  const blocked = gates.some((gate) => gate.failure_action === 'block-equilibrium' && failedOrUnprovable(gate));
  const seeded = gates.some((gate) => gate.failure_action === 'create-candidate-seed' && gate.outcome === 'fail');

  return {
    run_verdict: voided ? 'void' : 'valid',
    equilibrium_blocked: voided || blocked,
    candidate_seed: seeded,
    gates,
  };
}
