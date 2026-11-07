/** Project Profiles PP-10 — physical state isolation plus stale-request guards. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import { requireSha256 } from '../src/shared/ids.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import {
  makeProjectProfileFixture,
  makeSiblingProjectProfile,
} from './project-profile-fixture.js';

test('Project A events, artifacts and projection state never appear in Project B', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const a = registry.create(fixture.profile, { actor: 'creator' });
  const b = registry.create(makeSiblingProjectProfile(fixture, 'beta'), { actor: 'creator' });
  const aId = operationIdentityFromProfileRecord(a);
  const bId = operationIdentityFromProfileRecord(b);

  const aStore = new ProjectionStore(a.profile.state.databasePath, {
    workspaceIdentity: {
      expected: {
        projectId: aId.projectId,
        targetRootIdentity: aId.targetRootIdentity,
        profileVersion: a.profile.profileVersion,
        initialProfileHash: aId.projectProfileHash,
      },
      onMissing: 'initialize-new',
    },
  });
  const bStore = new ProjectionStore(b.profile.state.databasePath, {
    workspaceIdentity: {
      expected: {
        projectId: bId.projectId,
        targetRootIdentity: bId.targetRootIdentity,
        profileVersion: b.profile.profileVersion,
        initialProfileHash: bId.projectProfileHash,
      },
      onMissing: 'initialize-new',
    },
  });
  const aArtifacts = new ArtifactStore(a.profile.state.artifactStoreRoot, { projectIdentity: aId });
  const bArtifacts = new ArtifactStore(b.profile.state.artifactStoreRoot, { projectIdentity: bId });
  const { log: aLog } = EventLog.open(a.profile.state.eventLogRoot, { projectIdentity: aId });
  const { log: bLog } = EventLog.open(b.profile.state.eventLogRoot, { projectIdentity: bId });
  t.after(() => {
    aLog.close();
    bLog.close();
    aStore.close();
    bStore.close();
  });

  const artifact = aArtifacts.putText('alpha-only', { operationIdentity: aId });
  aLog.append({
    operationIdentity: aId,
    type: 'fixture.alpha',
    actor: 'daemon',
    missionVersion: 'MISSION-000001',
    payload: { project: 'alpha' },
  });
  aStore.sync(aLog);

  const artifactHash = requireSha256(artifact.hash, 'fixture artifact');
  assert.equal(aArtifacts.has(artifactHash, aId), true);
  assert.equal(bArtifacts.has(artifactHash, bId), false);
  assert.equal(Array.from(aLog.replay()).length, 1);
  assert.equal(Array.from(bLog.replay()).length, 0);
  assert.equal(aStore.status().indexedEvents, 1);
  assert.equal(bStore.status().indexedEvents, 0);
  assert.notEqual(
    join(a.profile.workspaceRoot, 'db'),
    join(b.profile.workspaceRoot, 'db'),
    'physical state roots are disjoint',
  );

  assert.throws(() => bArtifacts.putText('stale', { operationIdentity: aId }), /identity mismatch/u);
  assert.throws(
    () =>
      bLog.append({
        operationIdentity: aId,
        type: 'fixture.stale',
        actor: 'daemon',
        missionVersion: 'MISSION-000001',
        payload: {},
      }),
    /identity mismatch/u,
  );
});
