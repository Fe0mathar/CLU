/** PP-05 — atomic versioned Project Profile store. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProfileStoreError, ProjectProfileStore } from '../src/control/projectProfiles/profileStore.js';
import { FIXED_TIME, FIXED_TIME_2, makeProjectProfileFixture } from './project-profile-fixture.js';

function withRoot(work: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'clue-profile-store-'));
  try { work(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function codeOf(work: () => unknown): string | null {
  try { work(); return null; } catch (error) { return error instanceof ProfileStoreError ? error.code : null; }
}

test('PP-05 create/read/list/update use envelope generations and immutable creation time', () => {
  withRoot((root) => {
    const fixture = makeProjectProfileFixture(root);
    const times = [FIXED_TIME, FIXED_TIME_2];
    const store = new ProjectProfileStore(join(root, 'profiles-root'), { now: () => times.shift() ?? FIXED_TIME_2 });
    const created = store.create(fixture.profile);
    assert.equal(created.generation, 1);
    assert.equal(created.createdAt, FIXED_TIME);
    assert.equal(created.updatedAt, FIXED_TIME);
    assert.deepEqual(store.read('alpha'), created);
    assert.equal(store.listMetadata()[0]?.targetRoot, fixture.profile.targetRoot);

    const updated = store.update({ ...fixture.profile, displayName: 'Alpha successor' }, created.generation);
    assert.equal(updated.generation, 2);
    assert.equal(updated.createdAt, FIXED_TIME);
    assert.equal(updated.updatedAt, FIXED_TIME_2);
    assert.equal(updated.profile.displayName, 'Alpha successor');
  });
});

test('PP-05 duplicate create, stale update and tampered bytes fail closed', () => {
  withRoot((root) => {
    const fixture = makeProjectProfileFixture(root);
    const store = new ProjectProfileStore(join(root, 'profiles-root'), { now: () => FIXED_TIME });
    const created = store.create(fixture.profile);
    const path = store.pathFor('alpha');
    const before = readFileSync(path);
    assert.equal(codeOf(() => store.create(fixture.profile)), 'PROFILE_EXISTS');
    assert.equal(codeOf(() => store.update({ ...fixture.profile, displayName: 'stale' }, 99)), 'GENERATION_CONFLICT');
    assert.deepEqual(readFileSync(path), before);

    const parsed = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
    parsed['projectProfileHash'] = `profile:v1:${'f'.repeat(64)}`;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');
    assert.equal(codeOf(() => store.require('alpha')), 'PROFILE_INTEGRITY_FAILED');
    assert.equal(created.generation, 1);
  });
});

test('PP-05 delete needs exact profile-only confirmation and never removes project zones', () => {
  withRoot((root) => {
    const fixture = makeProjectProfileFixture(root);
    const store = new ProjectProfileStore(join(root, 'profiles-root'), { now: () => FIXED_TIME });
    const created = store.create(fixture.profile);
    assert.equal(codeOf(() => store.delete('alpha', created.generation, { projectId: 'other', deleteProfileDataOnly: true })), 'DELETE_CONFIRMATION_REQUIRED');
    store.delete('alpha', created.generation, { projectId: 'alpha', deleteProfileDataOnly: true });
    assert.equal(store.read('alpha'), null);
    assert.ok(existsSync(fixture.target));
    assert.ok(existsSync(fixture.workspace));
    assert.ok(existsSync(fixture.shadow));
  });
});

test('PP-05 read-only attachment creates nothing and permits no writes', () => {
  withRoot((root) => {
    const fixture = makeProjectProfileFixture(root);
    const storeRoot = join(root, 'absent-read-only-store');
    const store = new ProjectProfileStore(storeRoot, { readOnly: true });
    assert.equal(store.listMetadata().length, 0);
    assert.equal(codeOf(() => store.create(fixture.profile)), 'READ_ONLY');
    assert.equal(existsSync(storeRoot), false);
  });
});
