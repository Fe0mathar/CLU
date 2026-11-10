/**
 * The deterministic verdict — §14's hard-gate authority (DEV-P2-11, Stage H).
 *
 * Spec: `CLUE_Execution_Model_v9.md` §14 — the assessing intelligence weighs eight
 *       questions, and then "**Deterministic authority then enforces hard gates,
 *       identity integrity, … and policy**"; this module is that sentence. §15.2 (no
 *       retroactivity: the contract is re-verified at the decision point); §12.4 (a
 *       failed candidate may be revised only when failure evidence changes the next
 *       attempt — which is why REVISE here always carries the measured deltas); the two
 *       config literals, of which one is enforced in code below: an inconclusive result
 *       is **never** an improvement.
 *
 * ## What this layer decides, and what it refuses to
 *
 * Everything here is arithmetic over the frozen text and two measurement packages.
 * Dispositions produced: `ACCEPT` (the success threshold met and every mandatory gate
 * held), `REJECT` (a mandatory gate failed, or the rejection threshold met — a *valid*
 * run showing a bad candidate), `REVISE` (a valid run landing between rejection and
 * success — inconclusive, therefore not an improvement, and the deltas travel with the
 * disposition as §12.4's required failure evidence), and `INVALID` (the run cannot
 * stand: a moved contract, an unusable baseline, mismatched identities, instrument
 * anomalies, or a needed measure the candidate never collected). `DEFER` exists in the
 * disposition vocabulary because §14 names it, and this layer **never emits it** — a
 * deferral is a judgement about sufficiency and stakes, which belongs to the assessment
 * layer (the gateway slice) and to the operator, not to arithmetic.
 *
 * ## Direction-aware percentages, one convention
 *
 * Every delta is reported **improvement-positive**: for a `lower_is_better` measure,
 * `(baseline − candidate) / baseline × 100`; for `higher_is_better`, the mirror. One
 * sign convention means a reader never re-derives which way is good, and the threshold
 * rules reduce to plain comparisons against it. A zero baseline makes any percentage
 * rule undefined, and the verdict says so as INVALID rather than dividing by hope.
 *
 * ## Superiority accepts; non-inferiority only informs
 *
 * The success threshold is a superiority claim and the only road to ACCEPT. A declared
 * non-inferiority margin is evaluated and *reported* — it is exactly the kind of weaker
 * evidence the §14 assessment may weigh — but meeting it without superiority is still
 * inconclusive here, because the config literal says what inconclusive is worth.
 */

import { canonicalJson, type Sha256 } from '../shared/ids.js';
import { coordinateForMetric } from '../shared/measurementCoordinates.js';
import { projectGovernanceBasisSchema, type ProjectGovernanceBasis } from '../shared/projectGovernanceBasis.js';
import {
  proofContractSchema,
  verifyFrozenContract,
  type GuardrailRule,
  type ProofContract,
  type ThresholdRule,
} from './proofContract.js';
import {
  assessBaselineValidity,
  baselineDigest,
  type BaselinePackage,
} from './baselineRegistry.js';
import { aggregateSamples, measurementProtocolRefusals } from './measurementProtocol.js';

/** The candidate's measurements travel in the same §11 package shape as the baseline —
 *  same capture path, same variance honesty; only the tree it measured differs. */
export type CandidatePackage = BaselinePackage;

export type Disposition = 'ACCEPT' | 'REJECT' | 'REVISE' | 'DEFER' | 'INVALID';

export interface MeasureDelta {
  readonly measure_id: string;
  readonly direction: 'lower_is_better' | 'higher_is_better';
  readonly baseline: number;
  readonly candidate: number;
  /** Improvement-positive, per the one convention above. */
  readonly delta_pct: number;
}

export interface GateOutcome {
  readonly rule: GuardrailRule;
  readonly outcome: 'pass' | 'fail';
  readonly detail: string;
}

export interface ThresholdOutcome {
  readonly rule: ThresholdRule;
  readonly met: boolean;
  readonly detail: string;
}

export interface DeterministicVerdict {
  readonly disposition: Exclude<Disposition, 'DEFER'>;
  /** ACCEPT and nothing else — the config literal made a field. */
  readonly improvement: boolean;
  readonly reasons: readonly string[];
  readonly deltas: readonly MeasureDelta[];
  readonly gates: readonly GateOutcome[];
  readonly thresholds: {
    readonly success: ThresholdOutcome;
    readonly rejection: ThresholdOutcome;
    readonly non_inferiority: ThresholdOutcome | null;
  } | null;
  readonly identity: {
    readonly contract_hash: Sha256;
    readonly baseline_digest: Sha256;
    readonly candidate_digest: Sha256;
    readonly baseline_snapshot: Sha256;
    readonly candidate_snapshot: Sha256;
    readonly project_basis?: ProjectGovernanceBasis;
  };
}

export interface VerdictInput {
  readonly contract: ProofContract;
  /** What the result claims it was measured against — re-verified here, §15.2. */
  readonly contract_hash: Sha256;
  readonly baseline: BaselinePackage;
  readonly candidate: CandidatePackage;
  /** §13 instrument-health notes; environment failure is not candidate failure, so any
   *  anomaly invalidates the run rather than colouring the candidate. */
  readonly anomalies?: readonly string[];
}

/** Keep the durable opening baseline as authority, and require like-for-like shadow evidence for an acceptance. */
export function decideWithMatchedControl(input: VerdictInput, control: BaselinePackage | null): DeterministicVerdict {
  const openingVerdict = decide(input);
  if (openingVerdict.disposition !== 'ACCEPT' || control === null) return openingVerdict;
  const controlValidity = assessBaselineValidity(input.contract, control);
  const matchedVerdict = controlValidity.valid
    ? decide({ ...input, baseline: control })
    : { disposition: 'INVALID', reasons: controlValidity.reasons };
  if (matchedVerdict.disposition === 'ACCEPT') {
    return { ...openingVerdict, reasons: [...openingVerdict.reasons, `matched shadow control: ${matchedVerdict.reasons.join('; ')}`] };
  }
  return decide({
    ...input,
    anomalies: [
      ...(input.anomalies ?? []),
      `matched shadow control comparison did not establish the improvement (${matchedVerdict.disposition}): ${matchedVerdict.reasons.join('; ')}`,
    ],
  });
}

/* ------------------------------------------------------------------------- */
/* Arithmetic                                                                 */
/* ------------------------------------------------------------------------- */

function improvementPct(
  direction: 'lower_is_better' | 'higher_is_better',
  baseline: number,
  candidate: number,
): number {
  const change = candidate - baseline;
  const magnitude = Math.abs(baseline);
  const relative = Number.isFinite(change) ? change / magnitude : candidate / magnitude - baseline / magnitude;
  return (direction === 'lower_is_better' ? -relative : relative) * 100;
}

function directionOf(contract: ProofContract, measureId: string): 'lower_is_better' | 'higher_is_better' {
  const declared = [...contract.target_measurements, ...contract.regression_measurements].find(
    (measure) => measure.id === measureId,
  );
  // The contract schema refuses gates/thresholds over undeclared measures, so this is a
  // defect guard, not a reachable refusal.
  if (declared === undefined) throw new Error(`measure ${measureId} is not declared by the contract`);
  return declared.direction;
}

function evaluateGate(
  rule: GuardrailRule,
  contract: ProofContract,
  baseline: number,
  candidate: number,
): GateOutcome {
  const detail = `${rule.measure_id} ${baseline}→${candidate}`;
  switch (rule.kind) {
    case 'must_not_decrease':
      return { rule, outcome: candidate >= baseline ? 'pass' : 'fail', detail };
    case 'must_not_increase':
      return { rule, outcome: candidate <= baseline ? 'pass' : 'fail', detail };
    case 'must_not_regress_pct': {
      const improved = improvementPct(directionOf(contract, rule.measure_id), baseline, candidate);
      return {
        rule,
        outcome: improved >= -rule.pct ? 'pass' : 'fail',
        detail: `${detail} (${improved.toFixed(2)}% improvement-positive, limit −${rule.pct}%)`,
      };
    }
  }
}

function evaluateThreshold(
  rule: ThresholdRule,
  contract: ProofContract,
  baseline: number,
  candidate: number,
): ThresholdOutcome {
  const improved = improvementPct(directionOf(contract, rule.measure_id), baseline, candidate);
  const detail = `${rule.measure_id} ${baseline}→${candidate}: ${improved.toFixed(2)}% improvement-positive vs ${rule.pct}%`;
  switch (rule.kind) {
    case 'improve_pct_at_least':
      return { rule, met: improved > 0 && improved >= rule.pct, detail };
    case 'worsen_pct_at_least':
      return { rule, met: improved < 0 && improved <= -rule.pct, detail };
    case 'not_worse_pct':
      return { rule, met: improved >= -rule.pct, detail };
  }
}

/* ------------------------------------------------------------------------- */
/* The verdict                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Decides, or refuses to — never both, never neither.
 *
 * Order matters and is fixed: identity first (a moved contract or an unusable baseline
 * makes every number downstream meaningless), then run validity (anomalies, missing
 * needed measures, zero baselines), then the hard gates, then the thresholds. INVALID
 * therefore always means "the question was not answerable", REJECT always means "it was
 * answered, badly", and the two are never merged — §13's separation, kept at the end of
 * the pipeline too.
 */
export function decide(input: VerdictInput): DeterministicVerdict {
  const parsedBasis = projectGovernanceBasisSchema.safeParse(input.contract.project_basis);
  const identity = {
    contract_hash: input.contract_hash,
    baseline_digest: baselineDigest(input.baseline),
    candidate_digest: baselineDigest(input.candidate),
    baseline_snapshot: input.baseline.snapshot_id as Sha256,
    candidate_snapshot: input.candidate.snapshot_id as Sha256,
    ...(parsedBasis.success ? { project_basis: parsedBasis.data } : {}),
  };
  const invalid = (reasons: readonly string[]): DeterministicVerdict => ({
    disposition: 'INVALID',
    improvement: false,
    reasons,
    deltas: [],
    gates: [],
    thresholds: null,
    identity,
  });

  // 1. The contract itself — §15.2's retroactivity check at the decision point.
  const frozen = verifyFrozenContract(input.contract, input.contract_hash);
  if (!frozen.ok) return invalid([frozen.reason]);
  const parsedContract = proofContractSchema.safeParse(input.contract);
  if (!parsedContract.success) {
    return invalid(parsedContract.error.issues.map((issue) =>
      `frozen contract ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ));
  }
  const contract = parsedContract.data;

  // 2. The baseline must still be usable for this contract — §11's law, re-applied.
  const baselineValidity = assessBaselineValidity(contract, input.baseline);
  if (!baselineValidity.valid) return invalid(baselineValidity.reasons.map((reason) => `baseline: ${reason}`));

  // 3. Candidate coherence: same stick, same environment, same mission — a different
  //    snapshot is the whole point, everything else differing is a broken experiment.
  const reasons: string[] = [];
  const stickKeys = ['benchmark_id', 'benchmark_version', 'contract_sha256', 'integrity_sha256'] as const;
  for (const key of stickKeys) {
    if (input.candidate.benchmark[key] !== input.baseline.benchmark[key]) {
      reasons.push(
        `candidate and baseline were measured by different sticks: benchmark.${key} ` +
          `${input.baseline.benchmark[key]} vs ${input.candidate.benchmark[key]}`,
      );
    }
  }
  const cf = input.candidate.environment_fingerprint;
  const ef = contract.environment_fingerprint;
  if (cf.node_version !== ef.node_version || cf.platform !== ef.platform || cf.arch !== ef.arch) {
    reasons.push(
      `candidate environment ${cf.node_version}/${cf.platform}/${cf.arch} differs from the contract's ` +
        `${ef.node_version}/${ef.platform}/${ef.arch}`,
    );
  }
  if (input.candidate.mission_version !== contract.mission_version) {
    reasons.push(
      `candidate was measured under mission ${input.candidate.mission_version}, the contract binds ${contract.mission_version}`,
    );
  }
  const contractProjectBasis = contract.project_basis;
  const candidateProjectBasis = input.candidate.project_basis;
  if (contractProjectBasis === undefined && candidateProjectBasis !== undefined) {
    reasons.push('candidate carries a Project Profile basis but the contract is legacy');
  } else if (contractProjectBasis !== undefined && candidateProjectBasis === undefined) {
    reasons.push('candidate omitted the Project Profile basis required by the contract');
  } else if (
    contractProjectBasis !== undefined &&
    candidateProjectBasis !== undefined &&
    canonicalJson(projectGovernanceBasisSchema.parse(contractProjectBasis)) !==
      canonicalJson(projectGovernanceBasisSchema.parse(candidateProjectBasis))
  ) {
    reasons.push('candidate and contract Project Profile bases differ');
  }

  // 4. Anomalies — §13: instrument health is not target behaviour; it voids, it never colours.
  for (const anomaly of input.anomalies ?? []) {
    reasons.push(`instrument anomaly: ${anomaly}`);
  }

  // 5. Candidate observations must satisfy the same frozen protocol as the baseline.
  reasons.push(...measurementProtocolRefusals(contract, input.candidate).map((reason) => `candidate: ${reason}`));
  if (reasons.length > 0) return invalid(reasons);

  const declaredMeasures = new Map(
    [...contract.target_measurements, ...contract.regression_measurements].map((measure) => [measure.id, measure]),
  );
  const observedValues = (run: BaselinePackage): ReadonlyMap<string, number> => {
    const values = new Map<string, number>();
    for (const measure of run.measures) {
      const declared = declaredMeasures.get(measure.id);
      if (declared === undefined) continue;
      values.set(measure.id, aggregateSamples(declared.aggregation ?? contract.execution.statistic, measure.samples));
    }
    return values;
  };
  const baselineValues = observedValues(input.baseline);
  const candidateValues = observedValues(input.candidate);
  const needed = baselineValidity.needed;
  const percentageMeasures = new Set([
    contract.thresholds.success.measure_id,
    contract.thresholds.rejection.measure_id,
    ...(contract.thresholds.non_inferiority === null ? [] : [contract.thresholds.non_inferiority.measure_id]),
    ...contract.mandatory_gates.filter((gate) => gate.kind === 'must_not_regress_pct').map((gate) => gate.measure_id),
    ...(contract.great_book?.contributions.map((mapping) => mapping.source_measure_id) ??
      contract.target_measurements.flatMap((measurement) => {
        const coordinate = coordinateForMetric(measurement.id);
        return coordinate === null || coordinate.family === 'RESERVED' ? [] : [measurement.id];
      })),
  ]);
  const deltas: MeasureDelta[] = [];
  for (const id of needed) {
    const direction = directionOf(contract, id);
    const baseline = baselineValues.get(id) as number;
    const candidate = candidateValues.get(id) as number;
    if (baseline === 0) {
      if (!percentageMeasures.has(id)) continue;
      reasons.push(`baseline value for ${id} is 0 — percentage rules are undefined over a zero baseline`);
      continue;
    }
    const delta = improvementPct(direction, baseline, candidate);
    if (!Number.isFinite(delta)) {
      reasons.push(`percentage change for ${id} is outside the supported numeric range`);
      continue;
    }
    deltas.push({ measure_id: id, direction, baseline, candidate, delta_pct: delta });
  }
  if (reasons.length > 0) return invalid(reasons);

  // 6. Hard gates — a failed mandatory gate is a valid run showing a bad candidate.
  const gates = contract.mandatory_gates.map((rule) =>
    evaluateGate(rule, contract, baselineValues.get(rule.measure_id) as number, candidateValues.get(rule.measure_id) as number),
  );
  const thresholds = {
    success: evaluateThreshold(
      contract.thresholds.success,
      contract,
      baselineValues.get(contract.thresholds.success.measure_id) as number,
      candidateValues.get(contract.thresholds.success.measure_id) as number,
    ),
    rejection: evaluateThreshold(
      contract.thresholds.rejection,
      contract,
      baselineValues.get(contract.thresholds.rejection.measure_id) as number,
      candidateValues.get(contract.thresholds.rejection.measure_id) as number,
    ),
    non_inferiority:
      contract.thresholds.non_inferiority === null
        ? null
        : evaluateThreshold(
            contract.thresholds.non_inferiority,
            contract,
            baselineValues.get(contract.thresholds.non_inferiority.measure_id) as number,
            candidateValues.get(contract.thresholds.non_inferiority.measure_id) as number,
          ),
  };

  const failedGates = gates.filter((gate) => gate.outcome === 'fail');
  if (failedGates.length > 0) {
    return {
      disposition: 'REJECT',
      improvement: false,
      reasons: failedGates.map((gate) => `mandatory gate failed: ${gate.rule.kind} — ${gate.detail}`),
      deltas,
      gates,
      thresholds,
      identity,
    };
  }

  // 7. Rejection threshold — answered, badly.
  if (thresholds.rejection.met) {
    return {
      disposition: 'REJECT',
      improvement: false,
      reasons: [`rejection threshold met: ${thresholds.rejection.detail}`],
      deltas,
      gates,
      thresholds,
      identity,
    };
  }

  // 8. Success — the only road to improvement.
  if (thresholds.success.met) {
    return {
      disposition: 'ACCEPT',
      improvement: true,
      reasons: [`success threshold met: ${thresholds.success.detail}; every mandatory gate held`],
      deltas,
      gates,
      thresholds,
      identity,
    };
  }

  // 9. Between the bands: inconclusive, therefore — by the config literal — not an
  //    improvement. REVISE carries the deltas as §12.4's required failure evidence.
  return {
    disposition: 'REVISE',
    improvement: false,
    reasons: [
      `inconclusive: ${thresholds.success.detail} (success not met), ${thresholds.rejection.detail} ` +
        '(rejection not met) — an inconclusive result is never an improvement ' +
        '(proof.inconclusive_counts_as_improvement: false)' +
        (thresholds.non_inferiority !== null && thresholds.non_inferiority.met
          ? `; non-inferiority held (${thresholds.non_inferiority.detail}) — reported for the assessment layer, not an acceptance`
          : ''),
    ],
    deltas,
    gates,
    thresholds,
    identity,
  };
}
