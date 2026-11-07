import type { BaselinePackage } from './baselineRegistry.js';
import type { ProofContract } from './proofContract.js';

type Aggregation = ProofContract['execution']['statistic'] | 'exact';

/** Statistics are recomputed from retained observations before verdict arithmetic. */
export function aggregateSamples(statistic: Aggregation, samples: readonly number[]): number {
  switch (statistic) {
    case 'exact':
      return samples[0] ?? Number.NaN;
    case 'min':
      return samples.reduce((smallest, sample) => Math.min(smallest, sample), Infinity);
    case 'mean':
      return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    case 'median': {
      const ordered = [...samples].sort((left, right) => left - right);
      const middle = Math.floor(ordered.length / 2);
      const upper = ordered[middle] ?? Number.NaN;
      return ordered.length % 2 === 1 ? upper : ((ordered[middle - 1] ?? Number.NaN) + upper) / 2;
    }
  }
}

/** Checks evidence for all frozen measurements, including measurements used only by gates. */
export function measurementProtocolRefusals(contract: ProofContract, run: BaselinePackage): readonly string[] {
  const reasons: string[] = [];
  const execution = contract.execution;
  const measures = new Map<string, BaselinePackage['measures'][number]>();
  const duplicates = new Set<string>();
  for (const measure of run.measures) {
    if (measures.has(measure.id)) duplicates.add(measure.id);
    else measures.set(measure.id, measure);
  }
  const incompletes = new Map(run.incomplete.map((entry) => [entry.id, entry.reason]));

  const maxWallMs = execution.max_duration_seconds * 1000;
  if (run.run_wall_ms === undefined || !Number.isFinite(run.run_wall_ms) || run.run_wall_ms < 0) {
    reasons.push('missing observed run duration for the frozen execution protocol');
  } else if (run.run_wall_ms > maxWallMs) {
    reasons.push(`run took ${run.run_wall_ms} ms, exceeding the frozen duration limit of ${maxWallMs} ms`);
  }

  for (const declared of [...contract.target_measurements, ...contract.regression_measurements]) {
    const incomplete = incompletes.get(declared.id);
    const measure = measures.get(declared.id);
    if (incomplete !== undefined) {
      reasons.push(`noisy or invalid at capture: ${declared.id} landed incomplete (${incomplete})`);
    }
    if (duplicates.has(declared.id)) reasons.push(`duplicate observations for ${declared.id}`);
    if (measure === undefined) {
      if (incomplete === undefined) reasons.push(`${declared.id} was never collected`);
      continue;
    }

    const expectedAggregation = declared.aggregation ?? execution.statistic;
    if (measure.native_unit !== declared.native_unit) {
      reasons.push(`${declared.id} used unit ${measure.native_unit}; frozen unit is ${declared.native_unit}`);
    }
    if (measure.aggregation !== expectedAggregation) {
      reasons.push(`${declared.id} used aggregation ${measure.aggregation}; frozen aggregation is ${expectedAggregation}`);
    }
    if (measure.samples.length !== execution.repetitions) {
      reasons.push(`${declared.id} has ${measure.samples.length} retained observations; frozen repetitions require ${execution.repetitions}`);
    }
    if (measure.warmup_samples?.length !== execution.warmup_runs) {
      reasons.push(`${declared.id} has ${measure.warmup_samples?.length ?? 'no recorded'} warm-up observations; frozen warm-ups require ${execution.warmup_runs}`);
    }

    const aggregate = aggregateSamples(expectedAggregation, measure.samples);
    const agrees = aggregate === measure.value || Math.abs(aggregate - measure.value) <=
      8 * Number.EPSILON * Math.max(Math.abs(aggregate), Math.abs(measure.value));
    if (!Number.isFinite(aggregate) || !Number.isFinite(measure.value) || !agrees) {
      reasons.push(`${declared.id} value does not match the ${expectedAggregation} of its retained observations`);
    }
    if (expectedAggregation === 'exact' && measure.samples.some((sample) => sample !== measure.value)) {
      reasons.push(`${declared.id} exact observations disagree across retained repetitions`);
    }
  }
  return reasons;
}
