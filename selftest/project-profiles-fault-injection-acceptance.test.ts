/**
 * PP-36 final fault-injection matrix.
 *
 * The test crosses the durable registry, project-owned SQLite/event/artifact state, browser
 * publication and in-memory runtime publication. Every declared switch boundary must either publish
 * B completely or leave A completely active. No test accepts a mixed generation as recovery.
 */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore, type WorkspaceIdentityMissingPolicy } from '../src/memory/db.js';
import type { Runtime } from '../src/control/runtime.js';
import { ProjectBrowserSessionCoordinator } from '../src/control/projectProfiles/projectBrowserSessions.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import {
  ProjectRuntimeManager,
  ProjectRuntimeManagerError,
  type ProjectRuntimeSwitchFaultPoint,
} from '../src/control/projectProfiles/projectRuntimeManager.js';
import type { BrowserSessionIdentity } from '../src/experiment/browser/browserAgent.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import type { ProjectProfileRecord } from '../src/shared/schemas.js';
import {
  makeProjectProfileFixture,
  makeSiblingProjectProfile,
} from './project-profile-fixture.js';

function runtimeFor(
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
  return {
    projectProfile: record,
    projectIdentity: identity,
    projectState: record.profile.state,
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

function browserSession(record: ProjectProfileRecord, suffix: 'a' | 'b'): BrowserSessionIdentity {
  const port = suffix === 'a' ? 9222 : 9223;
  const webPort = suffix === 'a' ? 8080 : 8081;
  return {
    projectIdentity: operationIdentityFromProfileRecord(record),
    profileGeneration: record.generation,
    chromeInstanceId: `chrome-${suffix}`,
    sessionId: `browser-${suffix}`,
    endpoint: `127.0.0.1:${String(port)}`,
    targetId: `page-${suffix}`,
    targetUrl: `http://127.0.0.1:${String(webPort)}/`,
    product: 'Chrome/151.0.0.0',
    revision: 'fixture',
    protocolVersion: '1.3',
    jsVersion: '15.1',
    frameId: `frame-${suffix}`,
    loaderId: `loader-${suffix}`,
    frameUrl: `http://127.0.0.1:${String(webPort)}/`,
  };
}

function setup(t: TestContext, faultPoint?: ProjectRuntimeSwitchFaultPoint) {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const alpha = registry.create(fixture.profile, { actor: 'creator', reason: 'FAULT_MATRIX_A' });
  const beta = registry.create(makeSiblingProjectProfile(fixture, 'beta'), {
    actor: 'creator',
    reason: 'FAULT_MATRIX_B',
  });
  registry.activate(alpha.profile.projectId, { actor: 'creator', reason: 'FAULT_MATRIX_START' });

  const browser = new ProjectBrowserSessionCoordinator();
  fixture.deferCleanup(() => browser.dispose());
  browser.register(alpha, { session: browserSession(alpha, 'a') });
  browser.register(beta, { session: browserSession(beta, 'b') });
  let injected = false;
  const manager = new ProjectRuntimeManager(registry, {
    browserSessions: browser,
    openRuntime: ({ record, workspaceIdentityOnMissing }) =>
      runtimeFor(record, workspaceIdentityOnMissing),
    ...(faultPoint === undefined
      ? {}
      : {
          faultInjector: (point, target) => {
            if (!injected && target.profile.projectId === 'beta' && point === faultPoint) {
              injected = true;
              throw new Error(`fault-matrix:${point}`);
            }
          },
        }),
  });
  fixture.deferCleanup(() => {
    if (manager.state !== 'DISPOSED' && manager.activeLeaseCount === 0) manager.dispose();
  });
  return { registry, alpha, beta, browser, manager };
}

const ALL_SWITCH_FAULTS: readonly ProjectRuntimeSwitchFaultPoint[] = [
  'after-target-profile-load',
  'after-target-runtime-open',
  'before-registry-activation',
  'after-registry-activation',
  'before-browser-publication',
  'after-browser-publication',
  'before-runtime-publication',
];

for (const point of ALL_SWITCH_FAULTS) {
  test(`PP-36 fault matrix: ${point} restores one coherent Project A generation`, (t) => {
    const { registry, alpha, browser, manager } = setup(t, point);
    const started = manager.start();
    assert.equal(started?.projectId, 'alpha');
    assert.equal(started?.browserSession.targetPageId, 'page-a');

    assert.throws(
      () => manager.activate({ projectId: 'beta', actor: 'creator', reason: point }),
      new RegExp(`fault-matrix:${point}`, 'u'),
    );

    assert.equal(manager.state, 'ACTIVE');
    assert.equal(manager.publication?.projectId, 'alpha');
    assert.equal(manager.publication?.projectProfileHash, alpha.projectProfileHash);
    assert.equal(manager.publication?.profileGeneration, alpha.generation);
    assert.equal(manager.publication?.browserSession.targetPageId, 'page-a');
    assert.equal(registry.active()?.projectId, 'alpha');
    assert.equal(browser.active?.projectIdentity.projectId, 'alpha');
    assert.equal(browser.active?.profileGeneration, alpha.generation);
    assert.equal(browser.active?.targetPageId, 'page-a');

    const lease = manager.lease(operationIdentityFromProfileRecord(alpha));
    assert.equal(lease.runtime.projectProfile?.profile.projectId, 'alpha');
    lease.release();
  });
}

test('PP-36 fault matrix: a governed lease blocks switching before any registry or browser mutation', (t) => {
  const { registry, alpha, browser, manager } = setup(t);
  manager.start();
  const pointerBefore = registry.active();
  const browserBefore = browser.active;
  const lease = manager.lease(operationIdentityFromProfileRecord(alpha));
  assert.throws(
    () => manager.activate({ projectId: 'beta', actor: 'creator' }),
    (error: unknown) =>
      error instanceof ProjectRuntimeManagerError && error.code === 'PROJECT_RUNTIME_BUSY',
  );
  assert.deepEqual(registry.active(), pointerBefore);
  assert.deepEqual(browser.active, browserBefore);
  assert.equal(manager.publication?.projectId, 'alpha');
  lease.release();
});

test('PP-36 fault matrix: browser rollback failure blocks the manager instead of publishing a mixed state', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const alpha = registry.create(fixture.profile, { actor: 'creator' });
  const beta = registry.create(makeSiblingProjectProfile(fixture, 'beta'), { actor: 'creator' });
  registry.activate('alpha', { actor: 'creator' });

  const browser = new ProjectBrowserSessionCoordinator();
  fixture.deferCleanup(() => browser.dispose());
  let alphaActivations = 0;
  browser.register(alpha, {
    session: browserSession(alpha, 'a'),
    onActivate: () => {
      alphaActivations += 1;
      if (alphaActivations > 1) throw new Error('alpha-browser-rollback-refused');
    },
  });
  browser.register(beta, { session: browserSession(beta, 'b') });
  const manager = new ProjectRuntimeManager(registry, {
    browserSessions: browser,
    openRuntime: ({ record, workspaceIdentityOnMissing }) =>
      runtimeFor(record, workspaceIdentityOnMissing),
    faultInjector: (point, target) => {
      if (target.profile.projectId === 'beta' && point === 'after-browser-publication') {
        throw new Error('post-browser-publication-failure');
      }
    },
  });
  fixture.deferCleanup(() => {
    if (manager.state !== 'DISPOSED' && manager.activeLeaseCount === 0) manager.dispose();
  });

  manager.start();
  assert.throws(
    () => manager.activate({ projectId: 'beta', actor: 'creator' }),
    (error: unknown) =>
      error instanceof ProjectRuntimeManagerError &&
      error.code === 'PROJECT_RUNTIME_ROLLBACK_FAILED' &&
      /alpha-browser-rollback-refused/u.test(error.message),
  );
  assert.equal(manager.state, 'BLOCKED');
  assert.equal(manager.publication, null);
  assert.equal(browser.active, null);
  assert.match(manager.blockReason ?? '', /browser rollback failed/u);
});
