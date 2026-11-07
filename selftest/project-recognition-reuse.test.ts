/** PP-19 — switching away and back reuses unchanged project-owned recognition state. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';

import { runRecognition } from '../src/control/recognitionRun.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { RuntimeRegistrySource } from '../src/daemon/runtimeRegistrySource.js';
import { readGraphPointer } from '../src/analysis/source/navigatorEvents.js';
import { readRepositoryInventoryPointer } from '../src/analysis/source/repositoryInventory.js';
import { cloneProfile, makeProjectProfileFixture, makeSiblingProjectProfile } from './project-profile-fixture.js';
import {
  openRecognitionProfileRuntime,
  writeProfileRuntimeInstallation,
  writeRecognitionTarget,
} from './project-recognition-fixture.js';

const READINESS = {
  status: 'ready' as const,
  firstBlocking: null,
  sections: [],
};

test('unchanged Project A reactivation exposes A durable graph/inventory without running recognition', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  writeProfileRuntimeInstallation(fixture.root);
  writeRecognitionTarget(fixture.target, 'alphaStableMarker');
  const betaProfile = makeSiblingProjectProfile(fixture, 'beta');
  writeRecognitionTarget(betaProfile.targetRoot, 'betaStableMarker');

  const registry = new ProjectProfileRegistry(fixture.profiles);
  const alpha = registry.create(fixture.profile, { actor: 'creator' });
  const beta = registry.create(betaProfile, { actor: 'creator' });
  const alphaNavigator = join(alpha.profile.workspaceRoot, 'graph', 'system-navigator.ndjson');
  const betaNavigator = join(beta.profile.workspaceRoot, 'graph', 'system-navigator.ndjson');

  const alphaFirstRuntime = openRecognitionProfileRuntime(fixture.root, alpha, 'initialize-new');
  const alphaFirst = runRecognition(alphaFirstRuntime, { force: true, navigatorPath: alphaNavigator });
  const alphaEventCount = Number(
    (alphaFirstRuntime.projections.db.prepare('SELECT COUNT(*) AS count FROM events_index').get() as { count: number }).count,
  );
  alphaFirstRuntime.dispose();

  const betaRuntime = openRecognitionProfileRuntime(fixture.root, beta, 'initialize-new');
  const betaRun = runRecognition(betaRuntime, { force: true, navigatorPath: betaNavigator });
  betaRuntime.dispose();

  // Opening A again is the activation step. No recognizer is called here.
  const alphaAgainRuntime = openRecognitionProfileRuntime(fixture.root, alpha, 'reject');
  t.after(() => alphaAgainRuntime.dispose());
  const alphaAgainEvents = Number(
    (alphaAgainRuntime.projections.db.prepare('SELECT COUNT(*) AS count FROM events_index').get() as { count: number }).count,
  );
  assert.equal(alphaAgainEvents, alphaEventCount, 'activation itself writes no recognition work');

  const source = new RuntimeRegistrySource(alphaAgainRuntime, {
    navigatorPath: alphaNavigator,
    readiness: READINESS,
    sources: ['project-reactivation-test'],
  });
  const latest = source.latestSnapshot();
  assert.equal(latest?.snapshotId, alphaFirst.snapshotId);
  const recognition = source.recognitionFor(alphaFirst.snapshotId);
  assert.equal(recognition?.resultHash, alphaFirst.recorded.record.result_hash);
  assert.equal(source.runIdForSnapshot(alphaFirst.snapshotId), alphaFirst.runId);
  assert.deepEqual(source.projectRecognitionIdentity(), alphaFirst.projectRecognition);
  assert.notDeepEqual(source.projectRecognitionIdentity(), betaRun.projectRecognition);

  assert.ok(alphaFirst.projectRecognition !== null);
  assert.ok(readGraphPointer(alphaNavigator, alphaFirst.projectRecognition) !== null);
  assert.ok(readRepositoryInventoryPointer(alphaNavigator, alphaFirst.projectRecognition) !== null);
  assert.equal(alphaAgainRuntime.snapshots?.latest('canonical')?.id, alphaFirst.snapshotId);
  assert.equal(
    alphaAgainRuntime.requireGraph().recognition(alphaFirst.snapshotId)?.result_hash,
    alphaFirst.recorded.record.result_hash,
  );
});


test('fullScanOnActivation is applied only when the caller marks an activation run', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  writeProfileRuntimeInstallation(fixture.root);
  writeRecognitionTarget(fixture.target, 'activationPolicyMarker');
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const initialProfile = cloneProfile(fixture.profile, (draft) => {
    const recognition = draft['recognition'] as Record<string, unknown>;
    const policy = recognition['policy'] as Record<string, unknown>;
    policy['fullScanOnActivation'] = true;
  });
  const record = registry.create(initialProfile, { actor: 'creator' });
  const navigator = join(record.profile.workspaceRoot, 'graph', 'system-navigator.ndjson');
  const runtime = openRecognitionProfileRuntime(fixture.root, record, 'initialize-new');
  t.after(() => runtime.dispose());

  runRecognition(runtime, { force: true, navigatorPath: navigator });
  appendFileSync(join(fixture.target, 'src', 'value.ts'), '\nexport const ordinaryDelta = 1;\n');
  const ordinary = runRecognition(runtime, { force: false, activated: false, navigatorPath: navigator });
  assert.equal(ordinary.plan.fullRescan, false);

  appendFileSync(join(fixture.target, 'src', 'value.ts'), '\nexport const activationDelta = 2;\n');
  const activation = runRecognition(runtime, { force: false, activated: true, navigatorPath: navigator });
  assert.equal(activation.plan.fullRescan, true);
  assert.equal(activation.plan.fullRescanReason, 'requested');
});
