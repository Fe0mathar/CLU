/** Project Profiles PP-12 — atomic activation, leases and rollback fault injection. */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectionStore, type WorkspaceIdentityMissingPolicy } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import type { Runtime } from '../src/control/runtime.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import {
  ProjectRuntimeManager,
  ProjectRuntimeManagerError,
  type ProjectRuntimeSwitchFaultPoint,
} from '../src/control/projectProfiles/projectRuntimeManager.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import type { ProjectProfileRecord } from '../src/shared/schemas.js';
import {
  makeProjectProfileFixture,
  makeSiblingProjectProfile,
} from './project-profile-fixture.js';

function setup(t: TestContext, faultPoint?: ProjectRuntimeSwitchFaultPoint, onFault?: (registry: ProjectProfileRegistry) => void) {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const alpha = registry.create(fixture.profile, { actor: 'creator' });
  const beta = registry.create(makeSiblingProjectProfile(fixture, 'beta'), { actor: 'creator' });
  registry.activate('alpha', { actor: 'creator' });
  let injected = false;
  const manager = new ProjectRuntimeManager(registry, {
    openRuntime: ({ record, workspaceIdentityOnMissing }) =>
      makeRuntime(record, workspaceIdentityOnMissing),
    ...(faultPoint === undefined
      ? {}
      : {
          faultInjector: (point, target) => {
            if (!injected && target.profile.projectId === 'beta' && point === faultPoint) {
              injected = true;
              if (onFault === undefined) throw new Error(`injected ${point}`);
              onFault(registry);
            }
          },
        }),
  });
  fixture.deferCleanup(() => {
    if (manager.state !== 'DISPOSED' && manager.activeLeaseCount === 0) manager.dispose();
  });
  return { fixture, registry, alpha, beta, manager };
}

function makeRuntime(
  record: ProjectProfileRecord,
  onMissing: WorkspaceIdentityMissingPolicy,
): Runtime {
  const identity = operationIdentityFromProfileRecord(record);
  const projections = new ProjectionStore(record.profile.state.databasePath, {
    workspaceIdentity: {
      expected: {
        projectId: identity.projectId,
        targetRootIdentity: identity.targetRootIdentity,
        profileVersion: record.profile.profileVersion,
        initialProfileHash: identity.projectProfileHash,
      },
      onMissing,
    },
  });
  const artifacts = new ArtifactStore(record.profile.state.artifactStoreRoot, {
    projectIdentity: identity,
  });
  const { log } = EventLog.open(record.profile.state.eventLogRoot, {
    projectIdentity: identity,
  });
  const projectState = {
    databasePath: record.profile.state.databasePath,
    eventLogRoot: record.profile.state.eventLogRoot,
    artifactStoreRoot: record.profile.state.artifactStoreRoot,
    greatBookScope: record.profile.state.greatBookScope,
    recognitionRoot: record.profile.state.recognitionRoot,
    proofRoot: record.profile.state.proofRoot,
    cycleRoot: record.profile.state.cycleRoot,
    snapshotRoot: record.profile.state.snapshotRoot,
  };
  return {
    projectProfile: record,
    projectIdentity: identity,
    projectState,
    projections,
    artifacts,
    log,
    workspaceRoot: record.profile.workspaceRoot,
    dispose(): void {
      log.close();
      projections.close();
    },
  } as unknown as Runtime;
}

test('all five target identities publish together and switching back reuses durable ownership', (t) => {
  const { registry, alpha, beta, manager } = setup(t);
  const first = manager.start();
  assert.equal(first?.projectId, 'alpha');
  const alphaIdentity = operationIdentityFromProfileRecord(alpha);

  const second = manager.activate({ projectId: 'beta', actor: 'creator', reason: 'switch target' });
  assert.equal(second.projectId, 'beta');
  assert.equal(registry.active()?.projectId, 'beta');
  assert.notEqual(second.databaseIdentity, first?.databaseIdentity);
  assert.notEqual(second.greatBookIdentity, first?.greatBookIdentity);
  assert.notEqual(second.targetRoot, first?.targetRoot);
  assert.notEqual(second.inventorySnapshotIdentity, first?.inventorySnapshotIdentity);
  assert.notEqual(second.projectProfileHash, first?.projectProfileHash);

  assert.throws(() => manager.lease(alphaIdentity), /identity mismatch/u, 'stale A request is refused');

  const lease = manager.lease(operationIdentityFromProfileRecord(beta));
  assert.throws(
    () => manager.activate({ projectId: 'alpha', actor: 'creator' }),
    (error: unknown) =>
      error instanceof ProjectRuntimeManagerError && error.code === 'PROJECT_RUNTIME_BUSY',
  );
  lease.release();

  const third = manager.activate({ projectId: 'alpha', actor: 'creator' });
  assert.equal(third.projectId, 'alpha');
  assert.equal(third.databaseIdentity, first?.databaseIdentity);
  assert.equal(third.inventorySnapshotIdentity, first?.inventorySnapshotIdentity);
  assert.ok(third.runtimeGeneration > second.runtimeGeneration);
});

test('an asynchronous operation keeps the project lease until settlement', async (t) => {
  const { manager } = setup(t);
  manager.start();
  let settle: () => void = () => {};
  const pending = new Promise<void>((resolve) => { settle = resolve; });
  const operation = manager.withLease(undefined, async (lease) => {
    await pending;
    return lease.identity.projectId;
  });
  assert.equal(manager.activeLeaseCount, 1);
  assert.throws(() => manager.activate({ projectId: 'beta', actor: 'creator' }), { code: 'PROJECT_RUNTIME_BUSY' });
  settle();
  assert.equal(await operation, 'alpha');
  assert.equal(manager.activeLeaseCount, 0);
  assert.equal(manager.activate({ projectId: 'beta', actor: 'creator' }).projectId, 'beta');
});

for (const point of ['before-registry-activation', 'before-runtime-publication'] as const) {
  test(`a competing project activation at ${point} is preserved`, (t) => {
    const { fixture, registry, manager } = setup(t, point, (registry) => registry.activate('gamma'));
    registry.create(makeSiblingProjectProfile(fixture, 'gamma'));
    manager.start();
    assert.throws(() => manager.activate({ projectId: 'beta', actor: 'creator' }), { code: 'PROJECT_RUNTIME_ROLLBACK_FAILED' });
    assert.equal(registry.active()?.projectId, 'gamma');
    assert.equal(manager.state, 'BLOCKED');
    assert.equal(manager.activeRuntime, null);
  });
}

for (const point of [
  'after-target-profile-load',
  'after-target-runtime-open',
  'before-registry-activation',
  'after-registry-activation',
  'before-runtime-publication',
] as const) {
  test(`failure at ${point} leaves Project A coherently active`, (t) => {
    const { registry, manager } = setup(t, point);
    manager.start();
    assert.throws(
      () => manager.activate({ projectId: 'beta', actor: 'creator' }),
      new RegExp(point),
    );
    assert.equal(manager.state, 'ACTIVE');
    assert.equal(manager.publication?.projectId, 'alpha');
    assert.equal(registry.active()?.projectId, 'alpha');
    const lease = manager.lease();
    assert.equal(lease.identity.projectId, 'alpha');
    lease.release();
  });
}

test('a target workspace owned by another project blocks activation before pointer publication', (t) => {
  const { registry, beta, manager } = setup(t);
  manager.start();
  const betaIdentity = operationIdentityFromProfileRecord(beta);
  const forged = {
    projectId: 'gamma',
    targetRootIdentity: `path:v1:${process.platform}:${'f'.repeat(64)}`,
    profileVersion: beta.profile.profileVersion,
    initialProfileHash: `profile:v1:${'f'.repeat(64)}`,
  } as const;
  const poisoned = new ProjectionStore(beta.profile.state.databasePath, {
    workspaceIdentity: { expected: forged, onMissing: 'initialize-new' },
  });
  poisoned.close();

  assert.throws(
    () => manager.activate({ projectId: 'beta', actor: 'creator' }),
    /ROOT\/WORKSPACE IDENTITY MISMATCH/u,
  );
  assert.equal(manager.publication?.projectId, 'alpha');
  assert.equal(registry.active()?.projectId, 'alpha');
  assert.notEqual(betaIdentity.projectId, forged.projectId);
});

test('metadata-only active profile updates refresh the receipt; behavior changes block stale runtime use', (t) => {
  const { registry, alpha, manager } = setup(t);
  const started = manager.start();
  assert.equal(started?.profileGeneration, alpha.generation);

  const metadataOnly = {
    ...alpha.profile,
    displayName: 'ALPHA UPDATED LABEL',
  };
  const metadataRecord = registry.update(metadataOnly, alpha.generation, { actor: 'creator' });
  assert.equal(metadataRecord.projectProfileHash, alpha.projectProfileHash);

  const safeLease = manager.lease();
  safeLease.release();
  assert.equal(manager.publication?.profileGeneration, metadataRecord.generation);
  assert.equal(manager.activeIdentity?.projectProfileHash, alpha.projectProfileHash);

  const behaviorChange = {
    ...metadataRecord.profile,
    benchmarkRuntime: {
      ...metadataRecord.profile.benchmarkRuntime,
      repetitions: metadataRecord.profile.benchmarkRuntime.repetitions + 1,
    },
  };
  const changed = registry.update(behaviorChange, metadataRecord.generation, { actor: 'creator' });
  assert.notEqual(changed.projectProfileHash, metadataRecord.projectProfileHash);

  assert.throws(
    () => manager.lease(),
    (error: unknown) =>
      error instanceof ProjectRuntimeManagerError &&
      error.code === 'PROJECT_RUNTIME_POINTER_CONTRADICTION',
  );
  assert.equal(manager.state, 'BLOCKED');
  assert.match(manager.blockReason ?? '', /without an atomic runtime transition/u);
});
