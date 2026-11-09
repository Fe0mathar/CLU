/** PP-20 — SURF/DIVE read-side rebinding across Project Profile generations. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRecognition } from '../src/control/recognitionRun.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { RuntimeRegistrySource } from '../src/daemon/runtimeRegistrySource.js';
import { graphPointerPath } from '../src/analysis/source/navigatorEvents.js';
import { makeProjectProfileFixture, makeSiblingProjectProfile } from './project-profile-fixture.js';
import {
  openRecognitionProfileRuntime,
  writeProfileRuntimeInstallation,
  writeRecognitionTarget,
} from './project-recognition-fixture.js';

const READINESS = { status: 'ready' as const, firstBlocking: null, sections: [] };

test('A → B publishes only B; stale A pointer is ignored; reopening A restores A', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  writeProfileRuntimeInstallation(fixture.root);
  writeRecognitionTarget(fixture.target, 'surfAlphaMarker');
  const betaProfile = makeSiblingProjectProfile(fixture, 'beta');
  writeRecognitionTarget(betaProfile.targetRoot, 'surfBetaMarker');

  const registry = new ProjectProfileRegistry(fixture.profiles);
  const alpha = registry.create(fixture.profile, { actor: 'creator' });
  const beta = registry.create(betaProfile, { actor: 'creator' });
  const alphaNavigator = join(alpha.profile.workspaceRoot, 'graph', 'system-navigator.ndjson');
  const betaNavigator = join(beta.profile.workspaceRoot, 'graph', 'system-navigator.ndjson');

  const alphaRuntime = openRecognitionProfileRuntime(fixture.root, alpha, 'initialize-new');
  const alphaRun = runRecognition(alphaRuntime, { force: true, navigatorPath: alphaNavigator });
  alphaRuntime.dispose();
  const betaRuntime = openRecognitionProfileRuntime(fixture.root, beta, 'initialize-new');
  const betaRun = runRecognition(betaRuntime, { force: true, navigatorPath: betaNavigator });

  const betaSource = new RuntimeRegistrySource(betaRuntime, {
    navigatorPath: betaNavigator,
    readiness: READINESS,
    sources: ['beta-runtime'],
  });
  assert.equal(betaSource.projectRecognitionIdentity()?.operationIdentity.projectId, 'beta');
  assert.equal(betaSource.latestSnapshot()?.snapshotId, betaRun.snapshotId);
  assert.equal(betaSource.runIdForSnapshot(betaRun.snapshotId), betaRun.runId);
  assert.equal(betaSource.recognitionFor(alphaRun.snapshotId), null, 'Project A graph is absent from B state');

  const betaPointerPath = graphPointerPath(betaNavigator);
  const betaPointer = readFileSync(betaPointerPath, 'utf8');
  const alphaPointer = readFileSync(graphPointerPath(alphaNavigator), 'utf8');
  writeFileSync(betaPointerPath, alphaPointer, 'utf8');
  assert.equal(
    betaSource.runIdForSnapshot(betaRun.snapshotId),
    null,
    'a delayed Project A pointer cannot attribute Project B recognition',
  );
  writeFileSync(betaPointerPath, betaPointer, 'utf8');
  assert.equal(betaSource.runIdForSnapshot(betaRun.snapshotId), betaRun.runId);
  betaRuntime.dispose();

  const alphaAgain = openRecognitionProfileRuntime(fixture.root, alpha, 'reject');
  fixture.deferCleanup(() => alphaAgain.dispose());
  const alphaSource = new RuntimeRegistrySource(alphaAgain, {
    navigatorPath: alphaNavigator,
    readiness: READINESS,
    sources: ['alpha-reactivated'],
  });
  assert.equal(alphaSource.projectRecognitionIdentity()?.operationIdentity.projectId, 'alpha');
  assert.equal(alphaSource.latestSnapshot()?.snapshotId, alphaRun.snapshotId);
  assert.equal(alphaSource.runIdForSnapshot(alphaRun.snapshotId), alphaRun.runId);
  assert.equal(alphaSource.recognitionFor(betaRun.snapshotId), null, 'Project B graph is absent from A state');
});
