import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requirePassingOpening } from './live-candidate-proof.mjs';

function openingFixture() {
  const boundary = { kind: 'windows-supervisor', sha256: 'wrapper', qualificationSha256: 'qualification' };
  const executableInputs = { engine_dist_id: 'dist', engine_dependencies_id: 'deps' };
  const review = { sourceCommit: 'commit', inputsId: 'inputs', configSha256: 'config', benchmarkSha256: 'benchmark', executableInputs };
  const projectBasis = { profileGeneration: 9 };
  const planned = {
    review,
    reviewDigest: 'review',
    lock: { project_basis: projectBasis },
    matchingRuns: [{
      id: 'EVENT-000123', sequence: 123, hash: 'event',
      payload: {
        registered: true, proof_eligible: true, measures_count: 13, incomplete_count: 0, budget_exhausted: false,
        result_artifact: { hash: 'artifact' }, config_sha256: 'config', project_basis: projectBasis,
        executable_inputs: executableInputs, execution_boundary: boundary,
      },
    }],
  };
  const report = {
    schemaVersion: 'clue-windows-live-opening-baseline/2',
    state: 'PASS', phase: 'BASELINE_COMPLETE', sourceCommit: 'commit', reviewDigest: 'review',
    supervisorSha256: 'wrapper', qualificationReceiptSha256: 'qualification',
    inspection: { state: 'READY', reviewDigest: 'review', review: { ...review } },
    baseline: {
      state: 'PASS', sourceCommit: 'commit', reviewDigest: 'review', review: { ...review }, measures: 13, incomplete: 0,
      executionBoundary: { ...boundary }, eventId: 'EVENT-000123', sequence: 123, eventSha256: 'event', artifactSha256: 'artifact',
    },
  };
  const artifact = {
    proof_eligible: true, budget: { exhausted: false }, inputs: { id: 'inputs' }, contract: { sha256: 'benchmark' },
    config_sha256: 'config', executable_inputs: executableInputs, project_basis: projectBasis, execution_boundary: boundary,
    result: {
      incomplete: [],
      measures: Array.from({ length: 13 }, (_, index) => ({ id: 'SIG-' + String(index + 1).padStart(3, '0') })),
    },
  };
  const runtime = { artifacts: { getJson: (sha) => { assert.equal(sha, 'artifact'); return artifact; } } };
  return { report, planned, runtime, artifact };
}

test('candidate review requires a complete opening report, verified event and artifact', () => {
  const { report, planned, runtime } = openingFixture();
  assert.equal(requirePassingOpening(report, planned, runtime).baseline.eventId, 'EVENT-000123');
  report.schemaVersion = 'clue-windows-live-opening-baseline/1';
  assert.throws(() => requirePassingOpening(report, planned, runtime), /passing P05 opening report/);
});

test('candidate review refuses a different opening event, boundary or incomplete artifact', () => {
  for (const alter of [
    ({ report }) => { report.baseline.eventSha256 = 'other'; },
    ({ planned }) => { planned.matchingRuns[0].payload.execution_boundary = { kind: 'windows-supervisor', sha256: 'other' }; },
    ({ artifact }) => { artifact.result.measures.pop(); },
  ]) {
    const fixture = openingFixture();
    alter(fixture);
    assert.throws(() => requirePassingOpening(fixture.report, fixture.planned, fixture.runtime), /verified event log|verified opening artifact/);
  }
});
