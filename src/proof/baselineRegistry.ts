/**
 * Baseline capture and reuse — §11 made a record and a refusal (DEV-P2-11, Stage H).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §11, clause for clause — the package carries "exact
 *       project … identity" (the snapshot, the Git Base Pin's stand-in until the governed Git lifecycle (P4)),
 *       "exact benchmark version", "environment and tool fingerprint", "raw artifacts"
 *       (by immutable reference — the recorded run's own artifact), a "deterministic
 *       digest", and "validity and variance state". And §11's closing law is this
 *       module's temper: *"A stale, incompatible, or noisy baseline must be rerun. It
 *       cannot be repaired by narrative explanation."* — every refusal here names the
 *       mismatch and names the remedy (rerun), never an override parameter.
 *
 * ## Where a baseline comes from
 *
 * A baseline is not a new kind of measurement — it is a **recorded Master Benchmark
 * run** (B4's `benchmark.run_recorded` artifact) rebound as §11's package. The run
 * already carries the contract identity, the fingerprint, the measures with their raw
 * samples, and the honest `incomplete[]`; this module adds the two bindings a run alone
 * lacks (which snapshot it measured, under which mission) and the derived variance
 * state.
 *
 * ## Why "noisy" is mostly already decided
 *
 * The harness's §6 quality gates are the variance authority: a timing signal whose
 * repetitions spread beyond the declared limit never entered `measures[]` — it landed in
 * `incomplete[]` with the spread named. So for reuse, *presence is the noise gate*: a
 * needed measure found in `incomplete[]` refuses with the harness's own recorded reason,
 * and one absent entirely refuses as never collected. The package still computes and
 * carries each present measure's spread (`variance` per measure) because §11 asks for
 * the variance *state*, and because the verdict's statistics deserve to see it — but no
 * second spread threshold is invented here to overrule the one the contract governs.
 *
 * ## Reuse, in one sentence
 *
 * A baseline is reusable for a frozen Proof Contract exactly when it measured the same
 * snapshot, under the same mission, on the same environment fingerprint, and carries
 * every measure the contract's targets, regressions, gates, and thresholds name — and
 * anything else is a rerun, stated.
 *
 * (Directory §14 names this concern `BaselineRegistry`; it lives under `src/proof/` per
 * the continuation brief's decided shape — the same placement note as the contract
 * module, amended in the next governed Directory batch.)
 */

import { z } from 'zod';

import { canonicalJson, hashText, type Sha256 } from '../shared/ids.js';
import { artifactRefSchema, sha256Schema } from '../shared/schemas.js';
import type { BenchmarkMeasure, RunOutcome } from '../benchmark/benchmarkRunner.js';
import { measurementProtocolRefusals } from './measurementProtocol.js';
import type { ProofContract } from './proofContract.js';
import {
  projectGovernanceBasisSchema,
  type ProjectGovernanceBasis,
} from '../shared/projectGovernanceBasis.js';

/* ------------------------------------------------------------------------- */
/* The package — §11's list, one field per clause                              */
/* ------------------------------------------------------------------------- */

/** One measure as the baseline carries it: value, raw samples, and its variance state. */
export const baselineMeasureSchema = z
  .object({
    id: z.string().min(1),
    native_unit: z.string().min(1),
    aggregation: z.string().min(1),
    value: z.number().finite(),
    samples: z.array(z.number().finite()).min(1),
    warmup_samples: z.array(z.number().finite()).optional(),
    /** (max−min)/median as a percentage; null for single-sample exact counts. */
    spread_pct: z.number().finite().nonnegative().nullable(),
  })
  .strict();

export const baselinePackageSchema = z
  .object({
    package_version: z.union([z.literal(1), z.literal(2)]),

    /* §11: exact project identity — the snapshot the run measured. */
    snapshot_id: sha256Schema,
    mission_version: z.string().min(1),
    project_basis: projectGovernanceBasisSchema.optional(),

    /* §11: exact benchmark version, bound by content. */
    benchmark: z
      .object({
        benchmark_id: z.string().min(1),
        benchmark_version: z.string().min(1),
        contract_sha256: sha256Schema,
        integrity_sha256: sha256Schema,
      })
      .strict(),

    /* §11: environment and tool fingerprint. */
    environment_fingerprint: z
      .object({ node_version: z.string().min(1), platform: z.string().min(1), arch: z.string().min(1) })
      .strict(),

    /* §11: input dataset/seed identity — the run's declared inputs are the contract's;
     * what varies per capture is when it ran. */
    captured_at: z.string().min(1),
    /** The runner's observed total time, distinct from configured execution limits. */
    run_wall_ms: z.number().finite().nonnegative().optional(),

    /* §11: measurements with raw samples, and the honest incompletes beside them. */
    measures: z.array(baselineMeasureSchema),
    incomplete: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) }).strict()),

    /* §11: raw artifacts remain immutable — carried by reference, never inlined. */
    run_artifact: artifactRefSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.package_version === 2
        ? value.project_basis !== undefined
        : value.project_basis === undefined,
    { message: 'package_version 2 requires project_basis; legacy version 1 must omit it' },
  );

export type BaselinePackage = z.infer<typeof baselinePackageSchema>;
export type BaselineMeasure = z.infer<typeof baselineMeasureSchema>;

/** §11's deterministic digest: canonical-JSON sha256 of the whole package. */
export function baselineDigest(baseline: BaselinePackage): Sha256 {
  return hashText(canonicalJson(baseline));
}

/* ------------------------------------------------------------------------- */
/* Capture — a recorded run, rebound                                          */
/* ------------------------------------------------------------------------- */

function spreadPct(samples: readonly number[]): number | null {
  if (samples.length < 2) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  if (median === undefined || median === 0) return null;
  return ((sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0)) / Math.abs(median) * 100;
}

export interface CaptureBaselineInput {
  /** A successful run — the caller resolves refusals before a baseline is even a question. */
  readonly outcome: Extract<RunOutcome, { ok: true }>;
  /** The snapshot the run measured — the binding a run alone does not carry. */
  readonly snapshot_id: Sha256;
  readonly mission_version: string;
  /** The recorded run's artifact — §11's raw evidence, by reference. */
  readonly run_artifact: z.infer<typeof artifactRefSchema>;
  readonly project_basis?: ProjectGovernanceBasis;
}

/** Rebinds a recorded benchmark run as §11's baseline package. */
export function captureBaseline(input: CaptureBaselineInput): BaselinePackage {
  const { result, contract, timing } = input.outcome;
  return baselinePackageSchema.parse({
    package_version: input.project_basis === undefined ? 1 : 2,
    snapshot_id: input.snapshot_id,
    mission_version: input.mission_version,
    ...(input.project_basis === undefined ? {} : { project_basis: input.project_basis }),
    benchmark: {
      benchmark_id: contract.benchmark_id,
      benchmark_version: contract.benchmark_version,
      contract_sha256: contract.sha256,
      integrity_sha256: contract.integrity_sha256,
    },
    environment_fingerprint: result.environment,
    captured_at: timing.finished_at,
    run_wall_ms: timing.wall_ms,
    measures: result.measures.map((measure: BenchmarkMeasure) => ({
      id: measure.id,
      native_unit: measure.native_unit,
      aggregation: measure.aggregation,
      value: measure.value,
      samples: measure.samples,
      ...(measure.warmup_samples === undefined ? {} : { warmup_samples: measure.warmup_samples }),
      spread_pct: spreadPct(measure.samples),
    })),
    incomplete: result.incomplete,
    run_artifact: input.run_artifact,
  });
}

/* ------------------------------------------------------------------------- */
/* Validity — reuse or rerun, nothing between                                  */
/* ------------------------------------------------------------------------- */

/** Every measure id the contract's targets, regressions, gates, and thresholds name. */
export function measuresNeededBy(contract: ProofContract): readonly string[] {
  const needed = new Set<string>();
  for (const measure of contract.target_measurements) needed.add(measure.id);
  for (const measure of contract.regression_measurements) needed.add(measure.id);
  for (const gate of contract.mandatory_gates) needed.add(gate.measure_id);
  needed.add(contract.thresholds.success.measure_id);
  needed.add(contract.thresholds.rejection.measure_id);
  if (contract.thresholds.non_inferiority !== null) needed.add(contract.thresholds.non_inferiority.measure_id);
  return [...needed].sort();
}

export type BaselineValidity =
  | {
      readonly valid: true;
      readonly needed: readonly string[];
      /** The variance state of what will be compared — §11's "variance state", surfaced. */
      readonly variance: readonly { readonly id: string; readonly spread_pct: number | null }[];
      readonly digest: Sha256;
    }
  | { readonly valid: false; readonly reasons: readonly string[] };

/**
 * §11's matching law: reuse only when the validity conditions match the frozen contract.
 *
 * Every failing condition is reported at once, each naming what disagreed and ending in
 * the only remedy §11 allows — rerun. There is deliberately no override, no waiver
 * field, no "accept anyway": the clause this module exists for is that narrative cannot
 * repair a baseline.
 */
export function assessBaselineValidity(contract: ProofContract, baseline: BaselinePackage): BaselineValidity {
  const reasons: string[] = [];
  const rerun = ' — §11: rerun; narrative cannot repair it';

  if (baseline.snapshot_id !== contract.snapshot_id) {
    reasons.push(
      `stale: the baseline measured snapshot ${baseline.snapshot_id.slice(0, 12)}… but the contract binds ` +
        `${contract.snapshot_id.slice(0, 12)}…${rerun}`,
    );
  }
  if (baseline.mission_version !== contract.mission_version) {
    reasons.push(
      `stale: the baseline was captured under mission ${baseline.mission_version}, the contract binds ` +
        `${contract.mission_version}${rerun}`,
    );
  }
  const contractBasis = contract.project_basis;
  const baselineBasis = baseline.project_basis;
  if (contractBasis === undefined && baselineBasis !== undefined) {
    reasons.push(`incompatible: a project-bound baseline cannot satisfy a legacy contract${rerun}`);
  } else if (contractBasis !== undefined && baselineBasis === undefined) {
    reasons.push(`incompatible: the Project Profile-bound contract has no project-bound baseline${rerun}`);
  } else if (
    contractBasis !== undefined &&
    baselineBasis !== undefined &&
    canonicalJson(projectGovernanceBasisSchema.parse(contractBasis)) !==
      canonicalJson(projectGovernanceBasisSchema.parse(baselineBasis))
  ) {
    reasons.push(`stale: baseline and contract project_basis identities differ${rerun}`);
  }
  const fp = contract.environment_fingerprint;
  const bp = baseline.environment_fingerprint;
  if (fp.node_version !== bp.node_version || fp.platform !== bp.platform || fp.arch !== bp.arch) {
    reasons.push(
      `incompatible: environment fingerprint differs (baseline ${bp.node_version}/${bp.platform}/${bp.arch}, ` +
        `contract ${fp.node_version}/${fp.platform}/${fp.arch})${rerun}`,
    );
  }

  const present = new Map(baseline.measures.map((measure) => [measure.id, measure]));
  const needed = measuresNeededBy(contract);
  reasons.push(...measurementProtocolRefusals(contract, baseline).map((reason) => `${reason}${rerun}`));

  if (reasons.length > 0) return { valid: false, reasons };
  return {
    valid: true,
    needed,
    variance: needed.map((id) => ({ id, spread_pct: present.get(id)?.spread_pct ?? null })),
    digest: baselineDigest(baseline),
  };
}
