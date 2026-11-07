import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { projectProfileStartupPath } from '../src/control/projectProfiles/projectProfileStartup.js';
import { bootstrapProjectWorkspace } from '../src/control/projectProfiles/projectWorkspaceBootstrap.js';
import { openProjectRuntime, openRuntime } from '../src/control/runtime.js';
import type { ProjectProfileRecord } from '../src/shared/schemas.js';
import { makeProjectProfileFixture, makeSiblingProjectProfile } from './project-profile-fixture.js';
import { writeProfileRuntimeInstallation } from './project-recognition-fixture.js';

function setup(t: TestContext) {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  writeProfileRuntimeInstallation(fixture.root);
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const databasePath = join(fixture.workspace, 'custom', 'state', 'clue.db');
  const record = registry.create({ ...fixture.profile, state: { ...fixture.profile.state, databasePath } });
  const run = (saved: ProjectProfileRecord = record) => bootstrapProjectWorkspace({
    repoRoot: fixture.root,
    registry,
    projectId: saved.profile.projectId,
    expectedGeneration: saved.generation,
    expectedProfileHash: saved.projectProfileHash,
  });
  return { fixture, registry, record, databasePath, run };
}

test('native bootstrap initializes only the exact workspace, with a stable and refreshable mission', (t) => {
  const { fixture, registry, record, databasePath, run } = setup(t);
  assert.equal(existsSync(dirname(databasePath)), false);
  const initial = run();
  assert.equal(initial.state, 'INITIALIZED');
  assert.equal(initial.profileGeneration, record.generation);
  assert.equal(initial.projectProfileHash, record.projectProfileHash);
  assert.equal(initial.workspaceIdentityOrigin, 'new-workspace');
  assert.equal(initial.missionVersion, 1);
  assert.equal(existsSync(databasePath), true);
  assert.deepEqual(run(), { ...initial, state: 'ALREADY_INITIALIZED' });

  const successor = registry.update({
    ...record.profile,
    integrations: { ...record.profile.integrations, gpt: { ...record.profile.integrations.gpt, modelId: 'gpt-5.6-sol' } },
  }, record.generation);
  assert.throws(() => run(), { code: 'WORKSPACE_BOOTSTRAP_PROFILE_CHANGED' });
  const refreshed = run(successor);
  assert.equal(refreshed.state, 'REFRESHED');
  assert.equal(refreshed.missionVersion, 2);
  assert.deepEqual(run(successor), { ...refreshed, state: 'ALREADY_INITIALIZED' });
  assert.equal(registry.active(), null);
  assert.equal(existsSync(projectProfileStartupPath(fixture.root)), false);
  assert.equal(existsSync(join(fixture.root, 'legacy-workspace', 'db', 'clue.db')), false);
  const observer = openProjectRuntime(successor, { repoRoot: fixture.root, withLog: false, readOnly: true });
  try {
    assert.equal(observer.projections.workspaceIdentity()?.initialProfileHash, record.projectProfileHash);
    assert.equal(observer.mission?.requireCurrentBasis().id, refreshed.missionId);
  } finally {
    observer.dispose();
  }
});

test('native bootstrap refuses existing unowned SQLite bytes, historical roots, and redirected parents', (t) => {
  const { fixture, registry, record, databasePath, run } = setup(t);
  const legacy = openRuntime({ repoRoot: fixture.root, withLog: true });
  legacy.dispose();
  mkdirSync(dirname(databasePath), { recursive: true });
  copyFileSync(join(legacy.workspaceRoot, 'db', 'clue.db'), databasePath);
  const original = readFileSync(databasePath);
  assert.throws(() => run(), { code: 'WORKSPACE_IDENTITY_ADOPTION_REQUIRED' });
  assert.deepEqual(readFileSync(databasePath), original);
  assert.equal(existsSync(join(fixture.workspace, '.clue-workspace-bootstrap.json')), false);
  assert.equal(registry.active(), null);

  const other = registry.create(makeSiblingProjectProfile(fixture, 'other'));
  assert.equal(run(other).state, 'INITIALIZED');
  copyFileSync(other.profile.state.databasePath, databasePath);
  const foreign = readFileSync(databasePath);
  assert.throws(() => run(), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
  assert.deepEqual(readFileSync(databasePath), foreign);

  renameSync(databasePath, `${databasePath}.preserved`);
  const history = join(record.profile.state.eventLogRoot, 'existing.ndjson');
  writeFileSync(history, 'existing history');
  assert.throws(() => run(), { code: 'WORKSPACE_BOOTSTRAP_CONFLICT' });
  assert.equal(readFileSync(history, 'utf8'), 'existing history');
  assert.equal(existsSync(databasePath), false);

  symlinkSync(fixture.target, join(fixture.workspace, 'redirected'), 'junction');
  const redirected = registry.update({
    ...record.profile,
    state: { ...record.profile.state, databasePath: join(fixture.workspace, 'redirected', 'missing', 'clue.db') },
  }, record.generation);
  assert.throws(() => run(redirected), { code: 'WORKSPACE_BOOTSTRAP_PATH_UNSAFE' });
  assert.equal(existsSync(join(fixture.target, 'missing')), false);
});

test('native bootstrap leaves a recoverable marker after mission failure and refuses a concurrent registry writer', (t) => {
  const { fixture, registry, record, databasePath, run } = setup(t);
  registry.withStableProfile(record.profile.projectId, () => {
    assert.throws(() => run(), { code: 'WORKSPACE_BOOTSTRAP_LOCKED' });
  });
  assert.equal(existsSync(databasePath), false);

  const constitution = join(fixture.root, 'CLUE.md');
  renameSync(constitution, `${constitution}.temporarily-unavailable`);
  assert.throws(() => run(), /Tracked document CLUE\.md could not be read/u);
  assert.equal(existsSync(databasePath), true);
  const marker = join(fixture.workspace, '.clue-workspace-bootstrap.json');
  assert.equal(existsSync(marker), true);
  renameSync(`${constitution}.temporarily-unavailable`, constitution);
  assert.equal(run().state, 'RESUMED');
  assert.equal(run().state, 'ALREADY_INITIALIZED');
  assert.equal(existsSync(marker), false);
});

test('native bootstrap refuses unrelated history added after an interrupted attempt', (t) => {
  const { fixture, record, run } = setup(t);
  const constitution = join(fixture.root, 'CLUE.md');
  renameSync(constitution, `${constitution}.temporarily-unavailable`);
  assert.throws(() => run(), /Tracked document CLUE\.md could not be read/u);
  renameSync(`${constitution}.temporarily-unavailable`, constitution);

  const otherWriter = openProjectRuntime(record, { repoRoot: fixture.root, withLog: true });
  try {
    otherWriter.requireLog().append({
      type: 'workspace.unrelated',
      actor: 'daemon',
      missionVersion: 'MISSION-BOOTSTRAP',
      subjectId: null,
      payload: {},
    });
  } finally {
    otherWriter.dispose();
  }

  const events = join(record.profile.state.eventLogRoot, 'events.ndjson');
  const original = readFileSync(events);
  assert.throws(() => run(), { code: 'WORKSPACE_BOOTSTRAP_CONFLICT' });
  assert.deepEqual(readFileSync(events), original);
});
