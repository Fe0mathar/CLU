import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalHarnessBody } from '../src/benchmark/harnessBlock.js';
import { ProjectProfileStore } from '../src/control/projectProfiles/profileStore.js';
import { hashBytes, hashText } from '../src/shared/ids.js';
import { projectProfileSchema, type ProjectProfile, type ProjectProfileRecord } from '../src/shared/schemas.js';
import {
  FIXED_AT,
  cloneProfile,
  type ProjectProfileFixture,
} from './project-profile-fixture.js';

export function proofReadyBenchmarkText(
  benchmarkId = 'fixture-master',
  scenario = benchmarkId,
  version = '1.0.0',
): string {
  const body = [
    `return { benchmarkVersion: ${JSON.stringify(version)}, unifiedScore: null,`,
    '  measures: [], protective: [], environment: context.environment, incomplete: [] };',
  ].join('\n');
  return [
    'default_timeout_seconds = 600',
    'default_warmup_runs = 1',
    'default_repetitions = 3',
    'maximum_total_runtime_seconds = 600',
    `benchmark_id = ${benchmarkId}`,
    `benchmark_version = ${version}`,
    'runner_adapter = cli-node',
    '',
    '[harness.HRN-001]',
    'runner_adapter = cli-node',
    `scenario_ids = ${scenario}`,
    'language = javascript',
    `integrity = ${hashText(canonicalHarnessBody(body))}`,
    '--- begin harness ---',
    body,
    '--- end harness ---',
    '',
  ].join('\n');
}

export function proofReadyProfile(
  fixture: ProjectProfileFixture,
  options: {
    readonly profile?: ProjectProfile;
    readonly benchmarkId?: string;
    readonly scenario?: string;
    readonly version?: string;
  } = {},
): ProjectProfile {
  const source = options.profile ?? fixture.profile;
  const benchmarkId = options.benchmarkId ?? source.authority.masterBenchmark?.benchmarkId ?? 'fixture-master';
  const scenario = options.scenario ?? benchmarkId;
  const version = options.version ?? '1.0.0';
  const benchmarkPath = source.authority.masterBenchmark?.canonicalPath ?? fixture.masterBenchmark;
  writeFileSync(benchmarkPath, proofReadyBenchmarkText(benchmarkId, scenario, version), 'utf8');

  const draft = cloneProfile(source, (profile) => {
    const authority = profile['authority'] as Record<string, unknown>;
    const benchmark = authority['masterBenchmark'] as Record<string, unknown>;
    benchmark['sha256'] = hashBytes(readFileSync(benchmarkPath));
    benchmark['benchmarkId'] = benchmarkId;
    benchmark['benchmarkVersion'] = version;
    benchmark['validationState'] = 'VALID';
    benchmark['lastValidated'] = FIXED_AT;
    const runtime = profile['benchmarkRuntime'] as Record<string, unknown>;
    runtime['scenario'] = scenario;
    runtime['warmupRuns'] = 1;
    runtime['repetitions'] = 3;
    runtime['timeoutSeconds'] = 600;
  });
  return projectProfileSchema.parse(draft);
}

export function recordForProfile(
  fixture: ProjectProfileFixture,
  profile: ProjectProfile,
  storeName = `governance-${profile.projectId}`,
): ProjectProfileRecord {
  return new ProjectProfileStore(join(fixture.root, storeName), { now: () => FIXED_AT }).create(
    profile,
    FIXED_AT,
  );
}
