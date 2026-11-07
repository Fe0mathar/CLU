/** PP-17 — project basis is inseparable from proof, baseline, verdict, and cycle closure. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RunOutcome } from '../src/benchmark/benchmarkRunner.js';
import {
  assessBaselineValidity,
  captureBaseline,
  type BaselinePackage,
} from '../src/proof/baselineRegistry.js';
import {
  freezeProofContract,
  proofContractHash,
  proofContractSchema,
  type ProofContract,
} from '../src/proof/proofContract.js';
import { decide } from '../src/proof/verdict.js';
import { deriveProofClosure } from '../src/cycle/proofClosure.js';
import { inspectProjectAuthority } from '../src/control/projectProfiles/projectAuthority.js';
import { resolveProjectBenchmarkRuntime } from '../src/control/projectProfiles/benchmarkRuntime.js';
import { projectGovernanceBasisFromState } from '../src/control/projectProfiles/projectGovernanceBasis.js';
import type { ProjectGovernanceBasis } from '../src/shared/projectGovernanceBasis.js';
import type { ArtifactRef, EventRecord } from '../src/shared/schemas.js';
import type { Sha256 } from '../src/shared/ids.js';
import {
  makeProjectProfileFixture,
  makeSiblingProjectProfile,
} from './project-profile-fixture.js';
import { proofReadyProfile, recordForProfile } from './project-governance-fixture.js';

const H = (char: string): Sha256 => char.repeat(64).slice(0, 64) as Sha256;
const AT = '2026-08-14T14:00:00.000Z';

function basisFor(
  fixture: ReturnType<typeof makeProjectProfileFixture>,
  profile: Parameters<typeof recordForProfile>[1],
  storeName: string,
): ProjectGovernanceBasis {
  const record = recordForProfile(fixture, profile, storeName);
  const authority = inspectProjectAuthority(record);
  const benchmarkRuntime = resolveProjectBenchmarkRuntime(record, authority.manifest);
  const basis = projectGovernanceBasisFromState({ record, authority, benchmarkRuntime });
  assert.ok(basis !== null);
  if (basis === null) throw new Error('fixture did not produce a governance basis');
  return basis;
}

function contract(projectBasis: ProjectGovernanceBasis): ProofContract {
  return proofContractSchema.parse({
    contract_version: 2,
    mission_version: 'MISSION-000001',
    cycle_id: 'CYCLE-000001',
    snapshot_id: H('a'),
    project_basis: projectBasis,
    hypothesis: {
      id: 'HYP-PROJECT-ISOLATION',
      causal_claim: 'The candidate lowers project-local cost while preserving the guard.',
      target_units: ['src/cost.ts'],
    },
    baseline_state: 'exact project-local baseline snapshot and benchmark run',
    candidate_state: 'the same project-local world plus one candidate patch',
    representative_inputs: ['fixture'],
    target_measurements: [{ id: 'SIG-COST', native_unit: 'ms', direction: 'lower_is_better' }],
    regression_measurements: [{ id: 'SIG-GUARD', native_unit: 'count', direction: 'higher_is_better', aggregation: 'exact' }],
    mandatory_gates: [{ kind: 'must_not_decrease', measure_id: 'SIG-GUARD' }],
    execution: { warmup_runs: 1, repetitions: 3, max_duration_seconds: 600, statistic: 'median' },
    invalid_run_rules: ['instrument failure invalidates the run'],
    confounder_rules: ['project basis must remain exact'],
    required_instruments: ['benchmark:fixture-master'],
    thresholds: {
      success: { measure_id: 'SIG-COST', kind: 'improve_pct_at_least', pct: 2 },
      non_inferiority: null,
      rejection: { measure_id: 'SIG-COST', kind: 'worsen_pct_at_least', pct: 2 },
    },
    environment_fingerprint: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    rollback_conditions: ['guard decreases'],
  });
}

function run(cost: number, guard = 10): Extract<RunOutcome, { ok: true }> {
  return {
    ok: true,
    result: {
      benchmarkVersion: '1.0.0',
      unifiedScore: null,
      measures: [
        { id: 'SIG-COST', name: 'cost', scenario: 'fixture-master', native_unit: 'ms', aggregation: 'median', value: cost, samples: [cost, cost, cost], warmup_samples: [cost] },
        { id: 'SIG-GUARD', name: 'guard', scenario: 'fixture-master', native_unit: 'count', aggregation: 'exact', value: guard, samples: [guard, guard, guard], warmup_samples: [guard] },
      ],
      protective: [],
      environment: { node_version: process.version, platform: process.platform, arch: process.arch },
      incomplete: [],
    },
    contract: {
      path: '/fixture/master-benchmark.md',
      sha256: H('b'),
      benchmark_id: 'fixture-master',
      benchmark_version: '1.0.0',
      block_id: 'HRN-001',
      runner_adapter: 'cli-node',
      integrity_sha256: H('c'),
    },
    timing: { started_at: AT, finished_at: AT, wall_ms: 10 },
    policy: { warmupRuns: 1, repetitions: 3, scenarioTimeoutSeconds: 600, maxTotalRuntimeSeconds: 600 },
    budget: { spent_ms: 10, exhausted: false },
  };
}

function artifact(char: string): ArtifactRef {
  return {
    hash: H(char),
    bytes: 10,
    media_type: 'application/json; charset=utf-8',
    label: 'fixture.json',
    created_at: AT,
  };
}

function baseline(projectBasis: ProjectGovernanceBasis, cost: number, snapshot = H('a')): BaselinePackage {
  return captureBaseline({
    outcome: run(cost),
    snapshot_id: snapshot,
    mission_version: 'MISSION-000001',
    project_basis: projectBasis,
    run_artifact: artifact(cost < 100 ? 'e' : 'd'),
  });
}

function event(projectBasis: ProjectGovernanceBasis): EventRecord {
  return {
    id: 'EVENT-000001',
    sequence: 1,
    timestamp: AT,
    type: 'proof.verdict_recorded',
    mission_version: 'MISSION-000001',
    actor: 'cli',
    subject_id: 'CYCLE-000001',
    payload: {
      cycle_id: 'CYCLE-000001',
      project_basis: projectBasis,
      disposition: 'ACCEPT',
      improvement: true,
    },
    previous_hash: null,
    hash: H('f'),
  };
}

test('PP-17: contract freeze and baseline reuse refuse a different active project basis', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const alpha = proofReadyProfile(fixture);
  const sibling = makeSiblingProjectProfile(fixture, 'beta');
  const beta = proofReadyProfile(fixture, { profile: sibling, benchmarkId: 'beta-master', scenario: 'beta-master' });
  const basisA = basisFor(fixture, alpha, 'basis-alpha');
  const basisB = basisFor(fixture, beta, 'basis-beta');
  const contractA = contract(basisA);

  const frozenA = freezeProofContract({
    contract: contractA,
    policy: { require_frozen_contract: true, inconclusive_counts_as_improvement: false, require_baseline: true, require_guardrails: true },
    capabilities: ['benchmark:fixture-master'],
    expectedProjectBasis: basisA,
  });
  assert.equal('refusals' in frozenA, false);

  const frozenAsB = freezeProofContract({
    contract: contractA,
    policy: { require_frozen_contract: true, inconclusive_counts_as_improvement: false, require_baseline: true, require_guardrails: true },
    capabilities: ['benchmark:fixture-master'],
    expectedProjectBasis: basisB,
  });
  assert.ok('refusals' in frozenAsB);
  if ('refusals' in frozenAsB) assert.match(frozenAsB.refusals.join('\n'), /project_basis does not match/);

  const baselineA = baseline(basisA, 100);
  assert.equal(assessBaselineValidity(contractA, baselineA).valid, true);
  const contractB = contract(basisB);
  const invalidReuse = assessBaselineValidity(contractB, baselineA);
  assert.equal(invalidReuse.valid, false);
  if (!invalidReuse.valid) assert.match(invalidReuse.reasons.join('\n'), /project_basis identities differ/);
});

test('PP-17: candidate and closure verdict cannot cross Project Profile generations', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const alpha = proofReadyProfile(fixture);
  const sibling = makeSiblingProjectProfile(fixture, 'beta');
  const beta = proofReadyProfile(fixture, { profile: sibling, benchmarkId: 'beta-master', scenario: 'beta-master' });
  const basisA = basisFor(fixture, alpha, 'verdict-alpha');
  const basisB = basisFor(fixture, beta, 'verdict-beta');
  const contractA = contract(basisA);

  const verdict = decide({
    contract: contractA,
    contract_hash: proofContractHash(contractA),
    baseline: baseline(basisA, 100),
    candidate: baseline(basisB, 90, H('9')),
    anomalies: [],
  });
  assert.equal(verdict.disposition, 'INVALID');
  assert.match(verdict.reasons.join('\n'), /Project Profile bases differ/);

  assert.throws(
    () => deriveProofClosure([event(basisB)], 'CYCLE-000001', basisA),
    /project_basis does not match the cycle input lock/,
  );
  assert.equal(deriveProofClosure([event(basisA)], 'CYCLE-000001', basisA).acceptedCount, 1);
  assert.throws(
    () => deriveProofClosure([event(basisA)], 'CYCLE-000001', null),
    /legacy cycle cannot borrow/,
  );
});
