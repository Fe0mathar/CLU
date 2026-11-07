import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGreatBookEntry } from '../src/greatBook/greatBookEntry.js';
import { assessBaselineValidity, type BaselineMeasure, type BaselinePackage } from '../src/proof/baselineRegistry.js';
import { freezeProofContract, proofContractHash, type ProofContract } from '../src/proof/proofContract.js';
import { decide, type DeterministicVerdict } from '../src/proof/verdict.js';
import type { Sha256 } from '../src/shared/ids.js';

const at = '2026-11-07T12:00:00.000Z';
const hash = (hex: string): Sha256 => hex.repeat(64) as Sha256;
const artifact = { hash: hash('a'), bytes: 2, media_type: 'application/json', label: null, created_at: at };
const fingerprint = { node_version: process.version, platform: process.platform, arch: process.arch };

function contract(over: Partial<ProofContract> = {}): ProofContract {
  return {
    contract_version: 1,
    mission_version: 'MISSION-000001',
    cycle_id: 'CYCLE-000001',
    snapshot_id: hash('b'),
    hypothesis: {
      id: 'HYP-PROTOCOL',
      causal_claim: 'Memoization reduces the cost of repeated recognition on the locked input.',
      target_units: ['src/recognition.ts'],
    },
    baseline_state: 'The locked input with the original recognition implementation.',
    candidate_state: 'The same input and workload with the isolated memoization change.',
    representative_inputs: ['The exact locked source input tree.'],
    target_measurements: [{ id: 'SIG-006', native_unit: 'ms', direction: 'lower_is_better' }],
    regression_measurements: [{ id: 'SIG-013', native_unit: 'count', direction: 'lower_is_better', aggregation: 'exact' }],
    mandatory_gates: [{ kind: 'must_not_increase', measure_id: 'SIG-013' }],
    execution: { warmup_runs: 1, repetitions: 15, max_duration_seconds: 120, statistic: 'median' },
    invalid_run_rules: ['An instrument failure invalidates the run.'],
    confounder_rules: ['Run both sides with the same toolchain and representative input.'],
    required_instruments: ['benchmark:clu-master'],
    thresholds: {
      success: { kind: 'improve_pct_at_least', measure_id: 'SIG-006', pct: 0 },
      rejection: { kind: 'worsen_pct_at_least', measure_id: 'SIG-006', pct: 0 },
      non_inferiority: null,
    },
    environment_fingerprint: fingerprint,
    rollback_conditions: ['Roll back if required workload coverage drops.'],
    ...over,
  };
}

function observation(id: string, value: number, exact = false): BaselineMeasure {
  return {
    id,
    value,
    native_unit: exact ? 'count' : 'ms',
    aggregation: exact ? 'exact' : 'median',
    samples: Array<number>(15).fill(value),
    warmup_samples: [value],
    spread_pct: exact && value === 0 ? null : 0,
  };
}

function run(snapshot: Sha256, cost: number, skipCount = 0): BaselinePackage {
  return {
    package_version: 1,
    snapshot_id: snapshot,
    mission_version: 'MISSION-000001',
    benchmark: {
      benchmark_id: 'clu-master',
      benchmark_version: '0.1.0',
      contract_sha256: hash('c'),
      integrity_sha256: hash('d'),
    },
    environment_fingerprint: fingerprint,
    captured_at: at,
    run_wall_ms: 9_000,
    measures: [observation('SIG-006', cost), observation('SIG-013', skipCount, true)],
    incomplete: [],
    run_artifact: artifact,
  };
}

const baseline = run(hash('b'), 100);
const candidate = run(hash('e'), 80);

function assess(
  proof: ProofContract,
  candidateRun = candidate,
  baselineRun = baseline,
): DeterministicVerdict {
  return decide({
    contract: proof, contract_hash: proofContractHash(proof), baseline: baselineRun, candidate: candidateRun,
  });
}

test('single mean evidence cannot satisfy a frozen fifteen-run median on either side', () => {
  const wrongObservation = { ...observation('SIG-006', 80), aggregation: 'mean', samples: [80] };
  const wrongCandidate = { ...candidate, measures: [wrongObservation, observation('SIG-013', 0, true)] };
  const wrongBaseline = { ...wrongCandidate, snapshot_id: baseline.snapshot_id };
  for (const verdict of [
    assess(contract(), wrongCandidate),
    assess(contract(), candidate, wrongBaseline),
  ]) {
    assert.equal(verdict.disposition, 'INVALID');
    assert.equal(verdict.improvement, false);
    assert.match(verdict.reasons.join(' '), /used aggregation mean; frozen aggregation is median/u);
    assert.match(verdict.reasons.join(' '), /1 retained observations; frozen repetitions require 15/u);
  }
  assert.equal(assessBaselineValidity(contract(), wrongBaseline).valid, false);
});

test('protocol refuses wrong units, durations, warm-ups and inconsistent raw evidence', () => {
  const cost = observation('SIG-006', 80);
  const guard = observation('SIG-013', 0, true);
  const variations: readonly [BaselinePackage, RegExp][] = [
    [{ ...candidate, run_wall_ms: 120_001 }, /exceeding the frozen duration limit/u],
    [{ ...candidate, run_wall_ms: undefined }, /missing observed run duration/u],
    [{ ...candidate, measures: [{ ...cost, native_unit: 's' }, guard] }, /frozen unit is ms/u],
    [{ ...candidate, measures: [{ ...cost, warmup_samples: [] }, guard] }, /frozen warm-ups require 1/u],
    [{ ...candidate, measures: [{ ...cost, warmup_samples: undefined }, guard] }, /no recorded warm-up/u],
    [{ ...candidate, measures: [{ ...cost, value: 40 }, guard] }, /value does not match the median/u],
    [{ ...candidate, measures: [{ ...cost, aggregation: 'exact' }, guard] }, /frozen aggregation is median/u],
    [{ ...candidate, measures: [cost, guard, guard] }, /duplicate observations for SIG-013/u],
    [{ ...candidate, measures: [cost, { ...guard, samples: [1, ...guard.samples.slice(1)] }] }, /exact observations disagree/u],
    [{ ...candidate, measures: [cost] }, /SIG-013 was never collected/u],
    [{ ...candidate, incomplete: [{ id: 'SIG-013', reason: 'unstable' }] }, /SIG-013 landed incomplete/u],
  ];
  for (const [candidateRun, pattern] of variations) {
    const verdict = assess(contract(), candidateRun);
    assert.equal(verdict.disposition, 'INVALID');
    assert.match(verdict.reasons.join(' '), pattern);
  }
});

test('zero thresholds require a signed change and an observed gate can compare zero counts', () => {
  const proof = contract();
  const identical = assess(proof, run(hash('e'), 100));
  assert.equal(identical.disposition, 'REVISE');
  assert.equal(identical.thresholds?.success.met, false);
  assert.equal(identical.thresholds?.rejection.met, false);
  assert.equal(assess(proof, run(hash('e'), 101)).disposition, 'REJECT');
  assert.equal(assess(proof, run(hash('e'), 80, 1)).disposition, 'REJECT');
  const accepted = assess(proof);
  assert.equal(accepted.disposition, 'ACCEPT');
  assert.equal(accepted.gates[0]?.outcome, 'pass');
  assert.match(accepted.gates[0]?.detail ?? '', /0→0/u);
  assert.deepEqual(accepted.deltas.map((delta) => delta.measure_id), ['SIG-006']);
  const positiveThreshold = contract({ thresholds: { ...proof.thresholds, success: { ...proof.thresholds.success, pct: 20 } } });
  assert.equal(assess(positiveThreshold).disposition, 'ACCEPT');
  assert.equal(assess(positiveThreshold, run(hash('e'), 81)).disposition, 'REVISE');
  const nearEqual = { ...candidate, measures: [{ ...observation('SIG-006', 100), value: 100 - 1e-13 }, observation('SIG-013', 0, true)] };
  assert.equal(assess(proof, nearEqual).disposition, 'REVISE', 'verdict uses recomputed values');
});

test('a hash alone cannot validate duplicate declarations or an undeclared threshold', () => {
  const proof = contract();
  const duplicate = contract({ regression_measurements: [...proof.regression_measurements, ...proof.target_measurements] });
  const undeclared = contract({
    thresholds: { ...proof.thresholds, non_inferiority: { kind: 'not_worse_pct', measure_id: 'SIG-999', pct: 1 } },
  });
  assert.equal(assess(duplicate).disposition, 'INVALID');
  assert.equal(assess(undeclared).disposition, 'INVALID');
});

test('a valid measured ACCEPT builds exactly one matching Great Book entry', () => {
  const proof = contract();
  const frozen = freezeProofContract({
    contract: proof,
    policy: {
      require_frozen_contract: true, inconclusive_counts_as_improvement: false,
      require_baseline: true, require_guardrails: true,
    },
    capabilities: ['benchmark:clu-master'],
  });
  assert.ok(!('refusals' in frozen));

  const verdicts = [
    assess(frozen.contract),
    assess(frozen.contract, run(hash('e'), 100)),
    assess(frozen.contract, { ...candidate, measures: [] }),
  ];
  const entries = verdicts.flatMap((verdict) => {
    const result = buildGreatBookEntry({
      targetId: 'clu',
      missionVersion: frozen.contract.mission_version,
      cycleId: frozen.contract.cycle_id,
      contract: frozen.contract,
      contractHash: frozen.contract_hash,
      verdict,
      patchDigest: hash('f'),
      changeSet: [{ op: 'write', path: 'src/recognition.ts', sha256: hash('1'), bytes: 2 }],
      benchmarkRunId: 'EVENT-000010',
      artifacts: { contract: artifact, candidate_run: artifact, verdict: artifact },
      recordedAt: at,
    });
    return result.entry === null ? [] : [result.entry];
  });
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry?.disposition, 'ACCEPT');
  assert.equal(entry?.contract_hash, frozen.contract_hash);
  assert.equal(entry?.candidate_digest, verdicts[0]?.identity.candidate_digest);
  assert.equal(entry?.baseline_digest, verdicts[0]?.identity.baseline_digest);
});
