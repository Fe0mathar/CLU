/** Batch 6 — explicit, reversible Configuration-v3 startup cutover. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, normalize } from 'node:path';

import { loadConfig, loadLegacyConfig } from '../src/control/runtime.js';
import {
  disableProjectProfileStartup,
  enableProjectProfileStartup,
  loadActiveProjectProfileForStartup,
  loadProjectProfileStartup,
  projectProfileCutoverConfirmation,
  projectProfileStartupPath,
  ProjectProfileRegistry,
  ProjectProfileStartupError,
} from '../src/control/projectProfiles/index.js';
import { FIXED_AT, makeProjectProfileFixture } from './project-profile-fixture.js';

function installLegacyConfiguration(repoRoot: string): Buffer {
  const configDirectory = join(repoRoot, 'config');
  mkdirSync(configDirectory, { recursive: true });
  const source = join(process.cwd(), 'config', 'clue.config.yaml');
  const destination = join(configDirectory, 'clue.config.yaml');
  copyFileSync(source, destination);
  const targetDirectory = join(repoRoot, 'targets', 'clu');
  mkdirSync(targetDirectory, { recursive: true });
  copyFileSync(
    join(process.cwd(), 'targets', 'clu', 'profile.yaml'),
    join(targetDirectory, 'profile.yaml'),
  );
  return readFileSync(destination);
}

test('Batch 6: startup remains legacy-v2 until an explicit state-bound cutover', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const legacyBytes = installLegacyConfiguration(fixture.root);
    const legacyConfig = loadConfig(fixture.root);
    const registry = new ProjectProfileRegistry(fixture.profilesRoot, {
      now: () => FIXED_AT,
    });
    const record = registry.create(fixture.profile, {
      actor: 'creator',
      reason: 'TEST_REGISTER',
    });

    assert.equal(loadProjectProfileStartup(fixture.root), null);
    assert.equal(loadActiveProjectProfileForStartup(fixture.root), null);
    assert.deepEqual(loadConfig(fixture.root), legacyConfig);

    assert.throws(
      () => enableProjectProfileStartup({
        repoRoot: fixture.root,
        registry,
        projectId: record.profile.projectId,
        confirmation: 'CUTOVER alpha wrong-hash',
        actor: 'creator',
        now: () => FIXED_AT,
      }),
      (error: unknown) =>
        error instanceof ProjectProfileStartupError &&
        error.code === 'CUTOVER_CONFIRMATION_REQUIRED',
    );
    assert.equal(loadProjectProfileStartup(fixture.root), null);
    assert.equal(registry.active(), null, 'a refused cutover must not publish an active profile');

    let workspaceVerified = false;
    const result = enableProjectProfileStartup({
      repoRoot: fixture.root,
      registry,
      projectId: record.profile.projectId,
      confirmation: projectProfileCutoverConfirmation(record),
      actor: 'creator',
      now: () => FIXED_AT,
      verifyWorkspace(candidate) {
        assert.deepEqual(candidate, record);
        assert.equal(loadProjectProfileStartup(fixture.root), null);
        assert.equal(registry.active(), null);
        assert.equal(existsSync(join(fixture.root, 'config', 'backups')), false);
        workspaceVerified = true;
      },
    });

    assert.equal(workspaceVerified, true);
    assert.equal(result.state, 'enabled');
    assert.equal(existsSync(result.selectorPath), true);
    assert.equal(existsSync(result.backupPath), true);
    assert.deepEqual(readFileSync(result.backupPath), legacyBytes, 'legacy backup is byte-exact');

    const active = loadActiveProjectProfileForStartup(fixture.root);
    assert.ok(active !== null);
    assert.equal(active.pointer.projectId, record.profile.projectId);
    assert.equal(active.pointer.profileGeneration, record.generation);
    assert.equal(active.pointer.projectProfileHash, record.projectProfileHash);
    assert.equal(active.record.projectProfileHash, record.projectProfileHash);

    const effective = loadConfig(fixture.root);
    assert.equal(effective.project.id, record.profile.projectId);
    assert.equal(effective.project.root, normalize(record.profile.targetRoot));
    assert.equal(effective.workspace.root, normalize(record.profile.workspaceRoot));
    assert.equal(effective.shadow.root, normalize(record.profile.shadowRoot));
    const resolved = loadConfig(fixture.root, { resolvePaths: true });
    assert.equal(resolved.project.id, record.profile.projectId);
    assert.equal(resolved.project.root, normalize(record.profile.targetRoot));

    assert.equal(disableProjectProfileStartup(fixture.root), true);
    assert.equal(disableProjectProfileStartup(fixture.root), false, 'rollback is idempotent');
    assert.equal(loadProjectProfileStartup(fixture.root), null);
    assert.deepEqual(loadConfig(fixture.root), legacyConfig, 'rollback restores legacy selection');
    assert.equal(registry.getProfile(record.profile.projectId).projectProfileHash, record.projectProfileHash);
  } finally {
    fixture.dispose();
  }
});

test('Batch 6: malformed Configuration-v3 selectors fail closed', () => {
  const fixture = makeProjectProfileFixture();
  try {
    installLegacyConfiguration(fixture.root);
    const selectorPath = projectProfileStartupPath(fixture.root);
    writeFileSync(selectorPath, 'version: 3\nmode: project-profile\n', 'utf8');
    assert.throws(
      () => loadProjectProfileStartup(fixture.root),
      (error: unknown) =>
        error instanceof ProjectProfileStartupError &&
        error.code === 'STARTUP_SELECTOR_MALFORMED',
    );
    assert.throws(
      () => loadConfig(fixture.root),
      (error: unknown) =>
        error instanceof ProjectProfileStartupError &&
        error.code === 'STARTUP_SELECTOR_MALFORMED',
    );
  } finally {
    fixture.dispose();
  }
});

test('a foreign registry selector is refused by startup while shipped defaults stay readable', {
  skip: process.platform === 'win32' ? 'Windows-drive registry paths are native to Windows' : false,
}, () => {
  const fixture = makeProjectProfileFixture();
  try {
    installLegacyConfiguration(fixture.root);
    const shipped = loadLegacyConfig(fixture.root);
    const registry = new ProjectProfileRegistry(fixture.profilesRoot, { now: () => FIXED_AT });
    const record = registry.create(fixture.profile);
    const { selector, selectorPath } = enableProjectProfileStartup({
      repoRoot: fixture.root,
      registry,
      projectId: record.profile.projectId,
      confirmation: projectProfileCutoverConfirmation(record),
      now: () => FIXED_AT,
    });
    writeFileSync(selectorPath, JSON.stringify({
      ...selector,
      profiles: { ...selector.profiles, registry_root: 'F:/CLU/profiles' },
    }), 'utf8');

    assert.deepEqual(loadLegacyConfig(fixture.root), shipped);
    assert.throws(
      () => loadConfig(fixture.root),
      (error: unknown) =>
        error instanceof ProjectProfileStartupError &&
        error.code === 'STARTUP_REGISTRY_PATH_FOREIGN',
    );
  } finally {
    fixture.dispose();
  }
});

test('Configuration-v3 cutover refuses workspace failures and changed confirmed generations', () => {
  const fixture = makeProjectProfileFixture();
  try {
    installLegacyConfiguration(fixture.root);
    const registry = new ProjectProfileRegistry(fixture.profilesRoot, { now: () => FIXED_AT });
    const record = registry.create(fixture.profile);
    const options = {
      repoRoot: fixture.root,
      registry,
      projectId: record.profile.projectId,
      confirmation: projectProfileCutoverConfirmation(record),
    };
    assert.match(options.confirmation, /^CUTOVER alpha 1 [0-9a-f]{12}$/u);
    assert.throws(() => enableProjectProfileStartup({
      ...options,
      verifyWorkspace() { throw new Error('profile database is not ready'); },
    }), /profile database is not ready/u);
    assert.equal(existsSync(join(fixture.root, 'config', 'backups')), false);
    assert.equal(registry.active(), null);

    assert.throws(() => enableProjectProfileStartup({
      ...options,
      verifyWorkspace(candidate) {
        registry.update({ ...candidate.profile, displayName: 'New generation' }, candidate.generation);
      },
    }), /changed during cutover verification/u);
    assert.equal(loadProjectProfileStartup(fixture.root), null);
    assert.equal(registry.active(), null);
    assert.equal(existsSync(join(fixture.root, 'config', 'backups')), false);
    assert.throws(() => registry.activate(options.projectId, 'cli', record), /changed before activation/u);
    assert.equal(registry.active(), null);
    assert.throws(() => enableProjectProfileStartup(options), /requires exact confirmation/u);
  } finally {
    fixture.dispose();
  }
});

test('Configuration-v3 removes its selector if publication no longer loads the verified generation', () => {
  const fixture = makeProjectProfileFixture();
  try {
    installLegacyConfiguration(fixture.root);
    const registry = new ProjectProfileRegistry(fixture.profilesRoot, { now: () => FIXED_AT });
    const record = registry.create(fixture.profile);
    assert.throws(() => enableProjectProfileStartup({
      repoRoot: fixture.root,
      registry,
      projectId: record.profile.projectId,
      confirmation: projectProfileCutoverConfirmation(record),
      now() {
        registry.update({ ...record.profile, displayName: 'Concurrent update' }, record.generation);
        return FIXED_AT;
      },
    }), /did not resolve the requested active project/u);
    assert.equal(loadProjectProfileStartup(fixture.root), null);
    assert.equal(registry.getProfile(record.profile.projectId).generation, record.generation + 1);
  } finally {
    fixture.dispose();
  }
});
