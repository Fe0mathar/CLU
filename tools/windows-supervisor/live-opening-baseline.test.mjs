import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requireCompleteOpeningOutcome, requireReviewedQualification } from './live-opening-baseline.mjs';
import { hashBytes } from '../../dist/src/shared/ids.js';

function sample() {
  const reviewed = {
    missionId: 'MISSION-000006', snapshotId: 'snapshot', inputsId: 'inputs',
    configSha256: 'config', executableInputs: { engine_dist_id: 'dist' }, benchmarkSha256: 'contract',
  };
  const boundary = { kind: 'windows-supervisor', sha256: 'supervisor', qualificationSha256: 'receipt' };
  const performed = {
    subject: {
      mission_version: reviewed.missionId, snapshot_id: reviewed.snapshotId, inputs: { id: reviewed.inputsId },
      config_sha256: reviewed.configSha256, executable_inputs: reviewed.executableInputs,
    },
    outcome: {
      ok: true,
      contract: { benchmark_id: 'clu-master', benchmark_version: '0.2.0', sha256: 'contract', runner_adapter: 'cli-node' },
      execution_boundary: { ...boundary },
      result: {
        environment: { platform: 'win32' },
        incomplete: [],
        measures: Array.from({ length: 13 }, (_, index) =>
          ({ id: 'SIG-' + String(index + 1).padStart(3, '0'), warmup_samples: [1] })),
      },
      budget: { exhausted: false },
      policy: { warmupRuns: 1, repetitions: 3 },
    },
  };
  return { reviewed, boundary, performed };
}

test('the live baseline requires all thirteen signals and the reviewed Windows basis', () => {
  const { reviewed, boundary, performed } = sample();
  assert.doesNotThrow(() => requireCompleteOpeningOutcome(performed, boundary, reviewed));
  performed.outcome.result.measures[12].id = 'SIG-012';
  assert.throws(() => requireCompleteOpeningOutcome(performed, boundary, reviewed), /13 required measurements/);
});

test('incomplete, one-pass or exhausted runs cannot become the opening baseline', () => {
  for (const alter of [
    (run) => { run.outcome.result.incomplete = [{ id: 'SIG-013', reason: 'fixture refusal' }]; },
    (run) => { run.outcome.policy.repetitions = 1; },
    (run) => { run.outcome.budget.exhausted = true; },
  ]) {
    const { reviewed, boundary, performed } = sample();
    alter(performed);
    assert.throws(() => requireCompleteOpeningOutcome(performed, boundary, reviewed), /13 required measurements/);
  }
});

test('changes to reviewed execution pins or the screened snapshot refuse the opening baseline', () => {
  const { reviewed, boundary, performed } = sample();
  performed.outcome.execution_boundary.qualificationSha256 = 'other';
  assert.throws(() => requireCompleteOpeningOutcome(performed, boundary, reviewed), /Windows execution boundary/);
  performed.outcome.execution_boundary = boundary;
  performed.subject.snapshot_id = 'other';
  assert.throws(() => requireCompleteOpeningOutcome(performed, boundary, reviewed), /different opening basis/);
});

test('a pinned qualification must authorize the exact baseline review', () => {
  const bytes = Buffer.from(JSON.stringify({
    operatorReview: { operation: 'live-opening-baseline', commit: 'commit', reviewDigest: 'digest' },
  }));
  const boundary = { kind: 'windows-supervisor', qualificationSha256: hashBytes(bytes) };
  assert.doesNotThrow(() => requireReviewedQualification(bytes, boundary, 'commit', 'digest'));
  assert.throws(() => requireReviewedQualification(bytes, boundary, 'other-commit', 'digest'), /does not authorize/);
  assert.throws(() => requireReviewedQualification(Buffer.concat([bytes, Buffer.from('\n')]), boundary, 'commit', 'digest'), /exact Windows/);
});
