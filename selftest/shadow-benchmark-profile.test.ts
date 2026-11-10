import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import {
  assertBenchmarkProfileWorkspace,
  benchmarkWorkerProfile,
  withBenchmarkProfileInputs,
} from '../src/control/projectProfiles/benchmarkProfileInputs.js';
import { requireCurrentProjectAuthority } from '../src/control/projectProfiles/projectAuthority.js';
import { prepareShadowBenchmarkProfileInputs } from '../src/control/projectProfiles/shadowBenchmarkProfile.js';
import { loadConfig, rehearseProjectionRebuild, verifyBenchmarkEventChain, withRuntime } from '../src/control/runtime.js';
import { hashBytes } from '../src/shared/ids.js';
import { proofReadyProfile, recordForProfile } from './project-governance-fixture.js';
import { cloneProfile, makeProjectProfileFixture } from './project-profile-fixture.js';
import { writeProfileRuntimeInstallation, writeRecognitionTarget } from './project-recognition-fixture.js';

test('supervised shadow profile pins an independent workspace, mission, and exact staged authority', async (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const canonical = recordForProfile(fixture, cloneProfile(proofReadyProfile(fixture), (draft) => {
    (draft['benchmarkRuntime'] as Record<string, unknown>)['browserProfile'] = fixture.browserProfile;
  }));
  const shadow = join(fixture.shadow, 'proof-fixture');
  const workspace = `${shadow}-workspace`;
  mkdirSync(join(shadow, 'selftest'), { recursive: true });
  mkdirSync(workspace);
  writeProfileRuntimeInstallation(shadow);
  writeRecognitionTarget(shadow, 'shadowWork');
  const selector = join(shadow, 'config', 'project-profiles.yaml');
  writeFileSync(selector, 'invalid copied selector');
  const canonicalManifest = requireCurrentProjectAuthority(canonical);
  let active = true;
  const prepared = await prepareShadowBenchmarkProfileInputs({
    canonical, shadow, workspace,
    verifyActiveProfile: () => assert.ok(active, 'active profile changed'),
  });
  const digest = hashBytes(prepared.bytes);
  assert.equal(prepared.receipt.canonicalAuthoritySha256, canonicalManifest.manifestHash);
  assert.equal(prepared.receipt.capsuleSha256, digest);
  const capsule = join(fixture.root, 'candidate-capsule.json');
  writeFileSync(capsule, prepared.bytes);
  assert.doesNotThrow(() => assertBenchmarkProfileWorkspace(prepared.bytes, digest, shadow, workspace));
  assert.throws(() => assertBenchmarkProfileWorkspace(prepared.bytes, digest, shadow, fixture.workspace), /granted workspace/u);
  assert.equal(existsSync(canonical.profile.state.databasePath), false);
  assert.equal(readFileSync(selector, 'utf8'), 'invalid copied selector');

  withBenchmarkProfileInputs(capsule, digest, shadow, (mission) => {
    const local = benchmarkWorkerProfile(shadow);
    assert.ok(local !== null);
    assert.equal(relative(shadow, local.profile.targetRoot), '');
    assert.equal(relative(workspace, local.profile.workspaceRoot), '');
    assert.notEqual(local.profile.targetRootIdentity, canonical.profile.targetRootIdentity);
    assert.notEqual(local.projectProfileHash, canonical.projectProfileHash);
    assert.equal(local.profile.integrations.git.remote, null);
    assert.equal(local.profile.integrations.gpt.enabled, false);
    assert.notEqual(local.profile.benchmarkRuntime.browserProfile, canonical.profile.benchmarkRuntime.browserProfile);
    assert.deepEqual(local.profile.recognition, canonical.profile.recognition);
    assert.equal(relative(workspace, loadConfig(shadow).workspace.root), '');
    const authority = requireCurrentProjectAuthority(local);
    assert.deepEqual(authority.documents.map(({ sha256 }) => sha256), canonicalManifest.documents.map(({ sha256 }) => sha256));
    assert.ok(authority.documents.every(({ canonicalPath }) => relative(workspace, canonicalPath).startsWith('proof-authority')));
    withRuntime({ repoRoot: shadow, withLog: false, readOnly: true }, (runtime) => {
      assert.equal(runtime.currentMissionId(), mission);
      assert.equal(runtime.projections.workspaceIdentity()?.origin, 'new-workspace');
    });
    assert.ok(verifyBenchmarkEventChain({ repoRoot: shadow }) !== null);
    assert.ok(rehearseProjectionRebuild({ repoRoot: shadow }).eventCount > 0);
  });

  active = false;
  assert.throws(() => prepared.verifyCurrent(), /active profile changed/u);
  active = true;
  writeFileSync(fixture.targetDescription, 'changed canonical authority');
  assert.throws(() => prepared.verifyCurrent(), /authority/u);
});
