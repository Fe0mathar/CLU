/** PP-18 — project-scoped Benchmark Runtime and Master Benchmark consistency. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  BenchmarkRuntimeError,
  requireProjectBenchmarkRuntimeReady,
  resolveProjectBenchmarkRuntime,
} from '../src/control/projectProfiles/benchmarkRuntime.js';
import { inspectProjectAuthority, requireCurrentProjectAuthority } from '../src/control/projectProfiles/projectAuthority.js';
import { hashBytes } from '../src/shared/ids.js';
import { projectProfileSchema } from '../src/shared/schemas.js';
import { cloneProfile, FIXED_AT, makeProjectProfileFixture } from './project-profile-fixture.js';
import {
  proofReadyBenchmarkText,
  proofReadyProfile,
  recordForProfile,
} from './project-governance-fixture.js';

test('PP-18: a consistent machine-readable Master Benchmark produces READY runtime identity', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = recordForProfile(fixture, proofReadyProfile(fixture));
  const authority = requireCurrentProjectAuthority(record);
  const runtime = resolveProjectBenchmarkRuntime(record, authority);

  assert.equal(runtime.state, 'READY');
  assert.deepEqual(runtime.issues, []);
  assert.equal(runtime.projectId, 'alpha');
  assert.equal(runtime.scenario, 'fixture-master');
  assert.equal(runtime.masterBenchmarkHash, authority.masterBenchmarkHash);
  assert.match(runtime.runtimeHash, /^[0-9a-f]{64}$/);
  assert.match(runtime.consistencyHash, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => requireProjectBenchmarkRuntimeReady(runtime));
});

test('PP-18: profile/contract scenario and execution-policy disagreement is INVALID', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const base = proofReadyProfile(fixture);
  const mismatched = projectProfileSchema.parse(
    cloneProfile(base, (draft) => {
      const runtime = draft['benchmarkRuntime'] as Record<string, unknown>;
      runtime['scenario'] = 'not-declared';
      runtime['repetitions'] = 5;
      runtime['timeoutSeconds'] = 601;
    }),
  );
  const record = recordForProfile(fixture, mismatched, 'benchmark-mismatch');
  const authority = requireCurrentProjectAuthority(record);
  const runtime = resolveProjectBenchmarkRuntime(record, authority);

  assert.equal(runtime.state, 'INVALID');
  assert.deepEqual(
    new Set(runtime.issues.map((issue) => issue.code)),
    new Set([
      'SCENARIO_NOT_DECLARED',
      'REPETITIONS_MISMATCH',
      'TIMEOUT_MISMATCH',
      'TIMEOUT_EXCEEDS_CONTRACT',
    ]),
  );
  assert.throws(
    () => requireProjectBenchmarkRuntimeReady(runtime),
    (error: unknown) => error instanceof BenchmarkRuntimeError && error.runtime.state === 'INVALID',
  );
});

test('PP-18: malformed or integrity-invalid benchmark remains authority bytes but blocks proof readiness', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const malformed = proofReadyBenchmarkText().replace(/integrity = [0-9a-f]{64}/u, `integrity = ${'0'.repeat(64)}`);
  writeFileSync(fixture.masterBenchmark, malformed, 'utf8');
  const profile = projectProfileSchema.parse(
    cloneProfile(fixture.profile, (draft) => {
      const authority = draft['authority'] as Record<string, unknown>;
      const binding = authority['masterBenchmark'] as Record<string, unknown>;
      binding['sha256'] = hashBytes(readFileSync(fixture.masterBenchmark));
      binding['benchmarkId'] = 'fixture-master';
      binding['benchmarkVersion'] = '1.0.0';
      binding['validationState'] = 'VALID';
      binding['lastValidated'] = FIXED_AT;
      const runtime = draft['benchmarkRuntime'] as Record<string, unknown>;
      runtime['scenario'] = 'fixture-master';
      runtime['warmupRuns'] = 1;
      runtime['repetitions'] = 3;
      runtime['timeoutSeconds'] = 600;
    }),
  );
  const record = recordForProfile(fixture, profile, 'benchmark-integrity');
  const authority = inspectProjectAuthority(record);
  assert.equal(authority.state, 'CURRENT', 'authority identity is about exact bytes, not benchmark validity');
  const runtime = resolveProjectBenchmarkRuntime(record, authority.manifest);
  assert.equal(runtime.state, 'INCOMPLETE');
  assert.equal(runtime.issues.some((issue) => issue.code === 'HARNESS_INTEGRITY_INVALID'), true);
});

test('PP-18: an internally contradictory execution policy is INCOMPLETE rather than silently ignored', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const base = proofReadyProfile(fixture);
  const contradictory = `${proofReadyBenchmarkText()}\ndefault_repetitions = 4\n`;
  writeFileSync(fixture.masterBenchmark, contradictory, 'utf8');
  const profile = projectProfileSchema.parse(
    cloneProfile(base, (draft) => {
      const authority = draft['authority'] as Record<string, unknown>;
      const binding = authority['masterBenchmark'] as Record<string, unknown>;
      binding['sha256'] = hashBytes(readFileSync(fixture.masterBenchmark));
      binding['lastValidated'] = FIXED_AT;
    }),
  );
  const record = recordForProfile(fixture, profile, 'benchmark-policy-conflict');
  const authority = requireCurrentProjectAuthority(record);
  const runtime = resolveProjectBenchmarkRuntime(record, authority);

  assert.equal(runtime.state, 'INCOMPLETE');
  assert.equal(runtime.issues.some((issue) => issue.code === 'EXECUTION_POLICY_INVALID'), true);
  assert.throws(() => requireProjectBenchmarkRuntimeReady(runtime), BenchmarkRuntimeError);
});


test('PP-18: a descriptive benchmark without the executable cli-node harness is not proof-ready', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const descriptive = [
    'default_timeout_seconds = 600',
    'default_warmup_runs = 1',
    'default_repetitions = 3',
    'maximum_total_runtime_seconds = 600',
    'benchmark_id = fixture-master',
    'benchmark_version = 1.0.0',
    '',
  ].join('\n');
  writeFileSync(fixture.masterBenchmark, descriptive, 'utf8');
  const profile = projectProfileSchema.parse(
    cloneProfile(fixture.profile, (draft) => {
      const authority = draft['authority'] as Record<string, unknown>;
      const binding = authority['masterBenchmark'] as Record<string, unknown>;
      binding['sha256'] = hashBytes(readFileSync(fixture.masterBenchmark));
      binding['validationState'] = 'VALID';
      binding['lastValidated'] = FIXED_AT;
    }),
  );
  const record = recordForProfile(fixture, profile, 'benchmark-no-harness');
  const authority = requireCurrentProjectAuthority(record);
  const runtime = resolveProjectBenchmarkRuntime(record, authority);

  assert.equal(runtime.state, 'INCOMPLETE');
  assert.equal(runtime.issues.some((issue) => issue.code === 'HARNESS_BLOCK_MISSING'), true);
  assert.equal(runtime.issues.some((issue) => issue.code === 'RUNNER_ADAPTER_UNAVAILABLE'), true);
});
