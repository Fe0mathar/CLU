import { strict as assert } from 'node:assert';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import {
  captureBenchmarkProfileInputs,
  isBenchmarkProfileCommand,
  isBenchmarkProfileContract,
  withBenchmarkProfileInputs,
} from '../src/control/projectProfiles/benchmarkProfileInputs.js';
import { inspectProjectAuthority } from '../src/control/projectProfiles/projectAuthority.js';
import {
  loadConfig,
  rehearseProjectionRebuild,
  verifyBenchmarkEventChain,
  withRuntime,
} from '../src/control/runtime.js';
import { hashBytes } from '../src/shared/ids.js';
import { normalisePathForStorage } from '../src/shared/pathIdentity.js';
import { proofReadyProfile, recordForProfile } from './project-governance-fixture.js';
import { cloneProfile, makeProjectProfileFixture } from './project-profile-fixture.js';
import { writeProfileRuntimeInstallation, writeRecognitionTarget } from './project-recognition-fixture.js';

test('profile-bound benchmark commands use exact staged external authority and the existing mission', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const repoRoot = fixture.target;
  writeProfileRuntimeInstallation(repoRoot);
  writeRecognitionTarget(repoRoot, 'fixture');
  const external = join(fixture.root, 'external-target-description.md');
  writeFileSync(external, readFileSync(fixture.targetDescription));
  const record = recordForProfile(fixture, cloneProfile(proofReadyProfile(fixture), (draft) => {
    const authority = draft['authority'] as Record<string, Record<string, unknown>>;
    const description = authority['targetDescription'];
    assert.ok(description);
    description['path'] = normalisePathForStorage(external);
    description['canonicalPath'] = normalisePathForStorage(external);
  }));
  const initialMission = withRuntime({
    repoRoot, projectProfile: record, withLog: true, workspaceIdentityOnMissing: 'initialize-new',
  }, (runtime) => {
    assert.ok(runtime.mission);
    return runtime.mission.bootstrap().mission;
  });
  const authority = inspectProjectAuthority(record);
  assert.ok(authority.manifest !== null);
  const capsulePath = join(fixture.root, 'inputs.json');
  const bytes = captureBenchmarkProfileInputs({
    repoRoot, missionVersion: initialMission.id, record, documents: authority.manifest.documents,
  });
  const digest = hashBytes(bytes);
  writeFileSync(capsulePath, bytes);

  // Represent the worker's unavailable external path and registry without moving the
  // persisted workspace or changing the logical canonical identity in the profile.
  renameSync(external, `${external}.outside`);
  writeFileSync(join(repoRoot, 'config', 'project-profiles.yaml'), 'unsupported selector');
  assert.throws(() => loadConfig(repoRoot), /selector/iu);
  assert.notEqual(inspectProjectAuthority(record).state, 'CURRENT');
  withBenchmarkProfileInputs(capsulePath, digest, repoRoot, (mission) => {
    assert.equal(mission, initialMission.id);
    assert.equal(loadConfig(repoRoot).project.id, record.profile.projectId);
    assert.deepEqual(inspectProjectAuthority(record).manifest, authority.manifest);
    withRuntime({ repoRoot, withLog: false, readOnly: true }, (runtime) => {
      assert.equal(runtime.currentMissionId(), initialMission.id);
      assert.ok(runtime.projectBinding);
      assert.equal(relative(runtime.projectBinding.state.databasePath, record.profile.state.databasePath), '');
    });
    assert.ok(verifyBenchmarkEventChain({ repoRoot }) !== null);
    const rebuilt = rehearseProjectionRebuild({ repoRoot });
    assert.ok(rebuilt.eventCount > 0);
  });
  assert.throws(() => loadConfig(repoRoot), /selector/iu);

  assert.throws(() => withBenchmarkProfileInputs(capsulePath, '0'.repeat(64), repoRoot, () => {}), /digest/u);
  const parse = () => JSON.parse(bytes.toString('utf8')) as {
    missionVersion: string;
    documents: Array<{ canonicalPath: string; base64: string }>;
  };
  const replaceCapsule = (value: unknown) => {
    const replacement = Buffer.from(JSON.stringify(value), 'utf8');
    writeFileSync(capsulePath, replacement);
    return hashBytes(replacement);
  };
  const wrongBytes = parse();
  wrongBytes.documents[0]!.base64 = Buffer.from('drifted authority').toString('base64');
  assert.throws(() => withBenchmarkProfileInputs(capsulePath, replaceCapsule(wrongBytes), repoRoot, () => {}), /authority/u);
  const wrongPath = parse();
  wrongPath.documents[0]!.canonicalPath += '.elsewhere';
  assert.throws(() => withBenchmarkProfileInputs(capsulePath, replaceCapsule(wrongPath), repoRoot, () => {}), /authority/u);
  const wrongMission = parse();
  wrongMission.missionVersion = 'MISSION-999999';
  assert.throws(
    () => withBenchmarkProfileInputs(capsulePath, replaceCapsule(wrongMission), repoRoot, () => {
      withRuntime({ repoRoot, withLog: false, readOnly: true }, () => assert.fail('refused mission reached command'));
    }),
    /mission changed/u,
  );
});

test('profile worker accepts only the exact CLU benchmark command forms', () => {
  const contract = readFileSync(new URL('../../targets/clu/benchmark/master-benchmark.md', import.meta.url));
  assert.equal(isBenchmarkProfileContract(hashBytes(contract)), true);
  const calls = [...contract.toString('utf8').matchAll(/\bclue\((\[[^\]\n]+\])/gu)]
    .map((match) => JSON.parse(match[1]!.replaceAll("'", '"')) as string[]);
  assert.deepEqual(calls, [
    ['snapshot'], ['recognize', '--full', '--navigator'], ['recognize', '--navigator'],
    ['metrics'], ['benchmark', 'rebuild-projections'], ['benchmark', 'verify-chain'],
  ]);
  for (const args of calls) assert.equal(isBenchmarkProfileCommand(args), true);
  for (const args of [
    ['project', 'save'], ['init'], ['proof', 'run'], ['benchmark', 'run'],
    ['snapshot', '--out', 'unexpected'], ['recognize', '--navigator', 'elsewhere'],
  ]) assert.equal(isBenchmarkProfileCommand(args), false);
});
