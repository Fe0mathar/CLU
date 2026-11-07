/** Project-scoped Benchmark Runtime resolution and Master Benchmark consistency checks. */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import {
  readBenchmarkContract,
  readExecutionPolicy,
  selectHarnessBlock,
  verifyHarnessIntegrity,
} from '../../benchmark/harnessBlock.js';
import { hashCanonicalJson, type Sha256 } from '../../shared/ids.js';
import { normalisePathDisplay } from '../../shared/pathIdentity.js';
import type { ProjectProfileRecord } from '../../shared/schemas.js';
import { computeProjectBenchmarkRuntimeHash } from './profileHash.js';
import type { ProjectAuthorityManifest } from './projectAuthority.js';

export const PROJECT_BENCHMARK_RUNTIME_VERSION = 'clue-project-benchmark-runtime/1' as const;

export type BenchmarkRuntimeState = 'READY' | 'INCOMPLETE' | 'INVALID';

export interface BenchmarkRuntimeIssue {
  readonly code:
    | 'WORKING_DIRECTORY_MISSING'
    | 'WORKING_DIRECTORY_OUTSIDE_TARGET'
    | 'MASTER_BENCHMARK_UNAVAILABLE'
    | 'MASTER_BENCHMARK_CONTRACT_INVALID'
    | 'EXECUTION_POLICY_INVALID'
    | 'MASTER_BENCHMARK_ID_MISMATCH'
    | 'MASTER_BENCHMARK_VERSION_MISMATCH'
    | 'HARNESS_BLOCK_MISSING'
    | 'RUNNER_ADAPTER_UNAVAILABLE'
    | 'HARNESS_INTEGRITY_INVALID'
    | 'SCENARIO_NOT_DECLARED'
    | 'WARMUP_MISMATCH'
    | 'REPETITIONS_MISMATCH'
    | 'TIMEOUT_MISMATCH'
    | 'TIMEOUT_EXCEEDS_CONTRACT';
  readonly severity: 'incomplete' | 'invalid';
  readonly detail: string;
}

export interface ResolvedProjectBenchmarkRuntime {
  readonly runtimeVersion: typeof PROJECT_BENCHMARK_RUNTIME_VERSION;
  readonly projectId: string;
  readonly targetRootIdentity: string;
  readonly runtimeHash: Sha256;
  readonly consistencyHash: Sha256;
  readonly state: BenchmarkRuntimeState;
  readonly issues: readonly BenchmarkRuntimeIssue[];
  readonly workingDirectory: string;
  readonly command: string | null;
  readonly scenario: string | null;
  readonly warmupRuns: number;
  readonly repetitions: number;
  readonly timeoutSeconds: number;
  readonly targetUrl: string | null;
  readonly browserRequired: boolean;
  readonly browserProfile: string | null;
  readonly resolution: { readonly width: number; readonly height: number } | null;
  readonly additionalRuntimeArgs: readonly string[];
  readonly masterBenchmarkHash: Sha256 | null;
}

export class BenchmarkRuntimeError extends Error {
  public readonly code = 'PROJECT_BENCHMARK_RUNTIME_NOT_READY' as const;
  public readonly runtime: ResolvedProjectBenchmarkRuntime;

  public constructor(runtime: ResolvedProjectBenchmarkRuntime) {
    super(
      `Project ${runtime.projectId} benchmark runtime is ${runtime.state}: ${runtime.issues
        .map((issue) => `${issue.code}: ${issue.detail}`)
        .join('; ')}`,
    );
    this.name = 'BenchmarkRuntimeError';
    this.runtime = runtime;
  }
}

export function resolveProjectBenchmarkRuntime(
  record: ProjectProfileRecord,
  authority: ProjectAuthorityManifest | null,
): ResolvedProjectBenchmarkRuntime {
  const profile = record.profile;
  const runtime = profile.benchmarkRuntime;
  const issues: BenchmarkRuntimeIssue[] = [];
  const working = nativePath(runtime.workingDirectory);
  const target = nativePath(profile.targetRoot);

  if (!existsSync(working) || !statSync(working).isDirectory()) {
    issues.push({
      code: 'WORKING_DIRECTORY_MISSING',
      severity: 'invalid',
      detail: `Benchmark working directory does not exist or is not a directory: ${runtime.workingDirectory}`,
    });
  } else if (!inside(target, working)) {
    issues.push({
      code: 'WORKING_DIRECTORY_OUTSIDE_TARGET',
      severity: 'invalid',
      detail: `Benchmark working directory ${runtime.workingDirectory} is outside Target Root ${profile.targetRoot}.`,
    });
  }

  const binding = profile.authority.masterBenchmark;
  const activeBenchmark = authority?.documents.find((document) => document.kind === 'master-benchmark');
  if (binding === null || activeBenchmark === undefined) {
    issues.push({
      code: 'MASTER_BENCHMARK_UNAVAILABLE',
      severity: 'incomplete',
      detail: 'No current active Master Benchmark is available.',
    });
  } else {
    const text = readFileSync(nativePath(activeBenchmark.canonicalPath), 'utf8');
    const contract = readBenchmarkContract(text);
    if ('error' in contract) {
      issues.push({
        code: 'MASTER_BENCHMARK_CONTRACT_INVALID',
        severity: 'incomplete',
        detail: contract.error,
      });
    } else {
      if (binding.benchmarkId !== null && contract.identity.benchmark_id !== binding.benchmarkId) {
        issues.push({
          code: 'MASTER_BENCHMARK_ID_MISMATCH',
          severity: 'invalid',
          detail: `Profile binds ${binding.benchmarkId}; document declares ${contract.identity.benchmark_id}.`,
        });
      }
      if (
        binding.benchmarkVersion !== null &&
        contract.identity.benchmark_version !== binding.benchmarkVersion
      ) {
        issues.push({
          code: 'MASTER_BENCHMARK_VERSION_MISMATCH',
          severity: 'invalid',
          detail: `Profile binds ${binding.benchmarkVersion}; document declares ${contract.identity.benchmark_version}.`,
        });
      }
      if (contract.blocks.length === 0) {
        issues.push({
          code: 'HARNESS_BLOCK_MISSING',
          severity: 'incomplete',
          detail: 'The Master Benchmark declares no executable [harness.*] block.',
        });
      }
      for (const block of contract.blocks) {
        const integrity = verifyHarnessIntegrity(block);
        if (!integrity.ok) {
          issues.push({
            code: 'HARNESS_INTEGRITY_INVALID',
            severity: 'incomplete',
            detail: `${block.id}: ${integrity.reason}`,
          });
        }
      }
      const selected = selectHarnessBlock(contract, 'cli-node');
      if ('error' in selected) {
        issues.push({
          code: 'RUNNER_ADAPTER_UNAVAILABLE',
          severity: 'incomplete',
          detail: selected.error,
        });
      } else if (
        runtime.scenario !== null &&
        !selected.scenario_ids.includes(runtime.scenario)
      ) {
        issues.push({
          code: 'SCENARIO_NOT_DECLARED',
          severity: 'invalid',
          detail: `Scenario ${runtime.scenario} is not declared by the cli-node Master Benchmark harness block.`,
        });
      }
    }

    const policy = readExecutionPolicy(text);
    if ('error' in policy) {
      issues.push({
        code: 'EXECUTION_POLICY_INVALID',
        severity: 'incomplete',
        detail: policy.error,
      });
    } else {
      if (policy.default_warmup_runs !== null && policy.default_warmup_runs !== runtime.warmupRuns) {
        issues.push({
          code: 'WARMUP_MISMATCH',
          severity: 'invalid',
          detail: `Profile warmupRuns=${runtime.warmupRuns}; Master Benchmark declares ${policy.default_warmup_runs}.`,
        });
      }
      if (policy.default_repetitions !== null && policy.default_repetitions !== runtime.repetitions) {
        issues.push({
          code: 'REPETITIONS_MISMATCH',
          severity: 'invalid',
          detail: `Profile repetitions=${runtime.repetitions}; Master Benchmark declares ${policy.default_repetitions}.`,
        });
      }
      if (
        policy.default_timeout_seconds !== null &&
        policy.default_timeout_seconds !== runtime.timeoutSeconds
      ) {
        issues.push({
          code: 'TIMEOUT_MISMATCH',
          severity: 'invalid',
          detail: `Profile timeoutSeconds=${runtime.timeoutSeconds}; Master Benchmark declares ${policy.default_timeout_seconds}.`,
        });
      }
      if (
        policy.maximum_total_runtime_seconds !== null &&
        runtime.timeoutSeconds > policy.maximum_total_runtime_seconds
      ) {
        issues.push({
          code: 'TIMEOUT_EXCEEDS_CONTRACT',
          severity: 'invalid',
          detail: `Profile timeoutSeconds=${runtime.timeoutSeconds} exceeds Master Benchmark maximum ${policy.maximum_total_runtime_seconds}.`,
        });
      }
    }
  }

  const state: BenchmarkRuntimeState = issues.some((issue) => issue.severity === 'invalid')
    ? 'INVALID'
    : issues.length > 0
      ? 'INCOMPLETE'
      : 'READY';
  const body = {
    runtimeVersion: PROJECT_BENCHMARK_RUNTIME_VERSION,
    projectId: profile.projectId,
    targetRootIdentity: profile.targetRootIdentity,
    runtimeHash: computeProjectBenchmarkRuntimeHash(profile),
    state,
    issues,
    workingDirectory: normalisePathDisplay(runtime.workingDirectory),
    command: runtime.command,
    scenario: runtime.scenario,
    warmupRuns: runtime.warmupRuns,
    repetitions: runtime.repetitions,
    timeoutSeconds: runtime.timeoutSeconds,
    targetUrl: runtime.targetUrl,
    browserRequired: runtime.targetUrl !== null,
    browserProfile: runtime.browserProfile,
    resolution: runtime.resolution,
    additionalRuntimeArgs: [...runtime.additionalRuntimeArgs],
    masterBenchmarkHash: activeBenchmark?.sha256 ?? null,
  } as const;
  return { ...body, consistencyHash: hashCanonicalJson(body) };
}

export function requireProjectBenchmarkRuntimeReady(runtime: ResolvedProjectBenchmarkRuntime): void {
  if (runtime.state !== 'READY') throw new BenchmarkRuntimeError(runtime);
}

function inside(parent: string, child: string): boolean {
  const delta = relative(parent, child);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}

function nativePath(value: string): string {
  return process.platform === 'win32' ? value.replace(/\//gu, '\\') : value;
}
