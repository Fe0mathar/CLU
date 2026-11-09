/** PP-19 — project recognition artifacts and caches never cross Project Profile identity. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRecognition } from '../src/control/recognitionRun.js';
import {
  ProjectRecognitionError,
  resolveProjectRecognitionConfiguration,
} from '../src/control/projectProfiles/projectRecognition.js';
import { ProjectRecognitionIdentityError } from '../src/shared/projectRecognitionIdentity.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { readGraphPointer } from '../src/analysis/source/navigatorEvents.js';
import { readRepositoryInventoryPointer } from '../src/analysis/source/repositoryInventory.js';
import { cloneProfile, makeProjectProfileFixture, makeSiblingProjectProfile } from './project-profile-fixture.js';
import {
  openRecognitionProfileRuntime,
  writeProfileRuntimeInstallation,
  writeRecognitionTarget,
} from './project-recognition-fixture.js';

function streamProjectIds(path: string): ReadonlySet<string> {
  const ids = readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { payload?: { projectId?: unknown } })
    .map((event) => event.payload?.projectId)
    .filter((value): value is string => typeof value === 'string');
  return new Set(ids);
}

test('Project A graph, inventory pointer and Navigator stream refuse Project B identity', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  writeProfileRuntimeInstallation(fixture.root);
  writeRecognitionTarget(fixture.target, 'alphaMarker');
  const betaProfile = makeSiblingProjectProfile(fixture, 'beta');
  writeRecognitionTarget(betaProfile.targetRoot, 'betaMarker');

  const registry = new ProjectProfileRegistry(fixture.profiles);
  const alpha = registry.create(fixture.profile, { actor: 'creator' });
  const beta = registry.create(betaProfile, { actor: 'creator' });

  const alphaRuntime = openRecognitionProfileRuntime(fixture.root, alpha, 'initialize-new');
  fixture.deferCleanup(() => alphaRuntime.dispose());
  const betaRuntime = openRecognitionProfileRuntime(fixture.root, beta, 'initialize-new');
  fixture.deferCleanup(() => betaRuntime.dispose());

  const alphaNavigator = join(alpha.profile.workspaceRoot, 'graph', 'system-navigator.ndjson');
  const betaNavigator = join(beta.profile.workspaceRoot, 'graph', 'system-navigator.ndjson');
  const alphaRun = runRecognition(alphaRuntime, { force: true, navigatorPath: alphaNavigator });
  const betaRun = runRecognition(betaRuntime, { force: true, navigatorPath: betaNavigator });

  assert.ok(alphaRun.projectRecognition !== null);
  assert.ok(betaRun.projectRecognition !== null);
  assert.notDeepEqual(alphaRun.projectRecognition, betaRun.projectRecognition);
  assert.deepEqual([...streamProjectIds(alphaNavigator)], ['alpha']);
  assert.deepEqual([...streamProjectIds(betaNavigator)], ['beta']);

  assert.ok(readGraphPointer(alphaNavigator, alphaRun.projectRecognition) !== null);
  assert.equal(readGraphPointer(alphaNavigator, betaRun.projectRecognition), null);
  assert.ok(readRepositoryInventoryPointer(alphaNavigator, alphaRun.projectRecognition) !== null);
  assert.equal(readRepositoryInventoryPointer(alphaNavigator, betaRun.projectRecognition), null);

  const alphaGraph = alphaRuntime.requireGraph();
  assert.ok(alphaGraph.resultOf(alphaRun.snapshotId, alphaRun.projectRecognition) !== null);
  assert.throws(
    () => alphaGraph.resultOf(alphaRun.snapshotId, betaRun.projectRecognition ?? undefined),
    (error: unknown) =>
      error instanceof ProjectRecognitionIdentityError &&
      error.code === 'PROJECT_RECOGNITION_IDENTITY_MISMATCH',
    'a Project B recognition basis is rejected before Project A evidence is returned',
  );

  assert.equal(betaRun.plan.fullRescan, true, 'Project B starts from its own empty cache');
  assert.notEqual(alpha.profile.state.databasePath, beta.profile.state.databasePath);
  assert.notEqual(alpha.profile.state.recognitionRoot, beta.profile.state.recognitionRoot);
});


test('profile recognition rejects a missing source root before activation', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  writeRecognitionTarget(fixture.target, 'sourceRootMarker');
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const initial = registry.create(fixture.profile, { actor: 'creator' });
  const profile = cloneProfile(initial.profile, (draft) => {
    const recognition = draft['recognition'] as Record<string, unknown>;
    recognition['sourceRoots'] = ['missing-source'];
  });
  const record = registry.update(profile, initial.generation, { actor: 'creator' });

  assert.throws(
    () => resolveProjectRecognitionConfiguration(record),
    (error) =>
      error instanceof ProjectRecognitionError &&
      error.code === 'PROJECT_RECOGNITION_SOURCE_ROOT_INVALID',
  );
});


test('project-relative nested exclusions are honored by snapshot and semantic recognition', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  writeProfileRuntimeInstallation(fixture.root);
  writeRecognitionTarget(fixture.target, 'nestedExclusionMarker');
  const generated = join(fixture.target, 'src', 'generated');
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, 'ignored.ts'), 'export const mustNotAppear = true;\n', 'utf8');

  const registry = new ProjectProfileRegistry(fixture.profiles);
  const profile = cloneProfile(fixture.profile, (draft) => {
    const recognition = draft['recognition'] as Record<string, unknown>;
    recognition['excludedPaths'] = ['dist', 'node_modules', 'src/generated'];
  });
  const record = registry.create(profile, { actor: 'creator' });
  const runtime = openRecognitionProfileRuntime(fixture.root, record, 'initialize-new');
  fixture.deferCleanup(() => runtime.dispose());
  const navigator = join(record.profile.workspaceRoot, 'graph', 'system-navigator.ndjson');
  const result = runRecognition(runtime, { force: true, navigatorPath: navigator });

  const manifest = runtime.snapshots?.manifestOf(result.snapshotId);
  assert.ok(manifest !== null && manifest !== undefined);
  assert.equal(manifest.files.some((file) => file.path.includes('src/generated/')), false);
  assert.equal(result.result.units.some((unit) => unit.modulePath.includes('src/generated/')), false);
});
