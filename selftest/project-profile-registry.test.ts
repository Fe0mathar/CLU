/** PP-06/PP-07 — registry uniqueness, activation and durable authority events. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProfileRegistryError, ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { ProfileStoreError, ProjectProfileStore } from '../src/control/projectProfiles/profileStore.js';
import { ProfileEventLog } from '../src/control/projectProfiles/profileEventLog.js';
import { asTargetRootIdentity, resolvePathIdentity } from '../src/shared/pathIdentity.js';
import { FIXED_TIME, makeProjectProfileFixture } from './project-profile-fixture.js';

function withRoot(work: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'clue-profile-registry-'));
  try { work(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function registryAt(root: string): ProjectProfileRegistry {
  const profileRoot = join(root, 'profile-control-plane');
  return new ProjectProfileRegistry(new ProjectProfileStore(profileRoot, { now: () => FIXED_TIME }), { now: () => FIXED_TIME });
}
function codeOf(work: () => unknown): string | null {
  try { work(); return null; } catch (error) { return error instanceof ProfileRegistryError ? error.code : null; }
}

test('PP-06 couples one Project ID to one physical Target Root', () => {
  withRoot((root) => {
    const registry = registryAt(root);
    const alpha = makeProjectProfileFixture(root, { projectId: 'alpha' });
    const created = registry.create(alpha.profile);
    assert.equal(created.profile.projectId, 'alpha');
    assert.doesNotThrow(() => registry.verifyIntegrity());

    const sameId = makeProjectProfileFixture(root, { projectId: 'alpha', targetRoot: join(root, 'other-target') });
    assert.equal(codeOf(() => registry.create(sameId.profile)), 'PROJECT_ID_ALREADY_REGISTERED');
    const sameRoot = makeProjectProfileFixture(root, { projectId: 'beta', targetRoot: alpha.target });
    assert.throws(() => registry.create(sameRoot.profile), (error: unknown) => error instanceof ProfileRegistryError && error.code === 'TARGET_ROOT_ALREADY_REGISTERED' && error.existingProjectId === 'alpha');
  });
});

test('PP-06 aliases and caller-forged physical identity cannot split a target', () => {
  withRoot((root) => {
    const registry = registryAt(root);
    const alpha = makeProjectProfileFixture(root, { projectId: 'alpha' });
    registry.create(alpha.profile);
    const link = join(root, 'target-link');
    try { symlinkSync(alpha.target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { return; }
    const linkedFixture = makeProjectProfileFixture(root, { projectId: 'beta', targetRoot: link });
    const linked = { ...linkedFixture.profile, targetRoot: link, targetRootIdentity: asTargetRootIdentity(resolvePathIdentity(link, { zone: 'target', expectedKind: 'directory' }).identity) };
    assert.equal(codeOf(() => registry.create(linked)), 'TARGET_ROOT_ALREADY_REGISTERED');

    const gamma = makeProjectProfileFixture(root, { projectId: 'gamma' });
    assert.equal(codeOf(() => registry.create({ ...gamma.profile, targetRootIdentity: alpha.profile.targetRootIdentity })), 'TARGET_ROOT_IDENTITY_MISMATCH');
  });
});

test('two profiles cannot share a workspace or nest a future state root under an alias', () => {
  withRoot((root) => {
    const registry = registryAt(root);
    const alpha = makeProjectProfileFixture(root, { projectId: 'alpha' });
    registry.create(alpha.profile);
    const beta = makeProjectProfileFixture(root, { projectId: 'beta', workspaceRoot: alpha.workspace });
    assert.throws(() => registry.create(beta.profile), { code: 'PROJECT_ZONE_CONFLICT', existingProjectId: 'alpha' });

    const alias = join(root, 'alpha-workspace-alias');
    symlinkSync(alpha.workspace, alias, 'junction');
    const candidate = makeProjectProfileFixture(root, { projectId: 'gamma' }).profile;
    assert.throws(() => registry.create({
      ...candidate,
      shadowRoot: join(alias, 'not-created', 'shadow'),
      integrations: {
        ...candidate.integrations,
        powershell: { ...candidate.integrations.powershell, shadowRoot: join(alias, 'not-created', 'shadow') },
      },
    }), { code: 'PROJECT_ZONE_CONFLICT', existingProjectId: 'alpha' });
    assert.deepEqual(registry.listMetadata().map(({ projectId }) => projectId), ['alpha']);
  });
});

test('PP-06 update cannot rebind identity; activation and delete remain coherent', () => {
  withRoot((root) => {
    const registry = registryAt(root);
    const alpha = makeProjectProfileFixture(root, { projectId: 'alpha' });
    const created = registry.create(alpha.profile);
    const other = makeProjectProfileFixture(root, { projectId: 'other' });
    const rebound = {
      ...other.profile,
      projectId: 'alpha',
      state: { ...other.profile.state, greatBookScope: 'alpha' },
    };
    assert.equal(codeOf(() => registry.update('alpha', rebound, created.generation)), 'TARGET_ROOT_REBIND_FORBIDDEN');
    const pointer = registry.activate('alpha', { actor: 'creator' });
    assert.equal(pointer.projectId, 'alpha');
    assert.equal(registry.active()?.projectProfileHash, created.projectProfileHash);

    assert.throws(() => registry.delete('alpha', created.generation + 1), (error: unknown) => error instanceof ProfileStoreError && error.code === 'GENERATION_CONFLICT');
    registry.delete('alpha', created.generation);
    assert.equal(registry.active(), null);
    assert.equal(registry.get('alpha'), null);
  });
});

test('PP-07 writers append a sanitized hash-chained event log', () => {
  withRoot((root) => {
    const profileRoot = join(root, 'profile-control-plane');
    const registry = new ProjectProfileRegistry(profileRoot, { now: () => FIXED_TIME });
    const fixture = makeProjectProfileFixture(root, { projectId: 'alpha' });
    const created = registry.create(fixture.profile);
    registry.activate('alpha', { actor: 'creator' });
    const events = new ProfileEventLog(profileRoot).replay();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.projectProfileHash, created.projectProfileHash);
    assert.equal(events[1]?.type, 'project-profile.activated');
  });
});
