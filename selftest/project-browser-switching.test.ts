/** PP-25 — browser identity is switched atomically with the active Project Profile. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectBrowserSessionCoordinator } from '../src/control/projectProfiles/projectBrowserSessions.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import type { BrowserSessionIdentity } from '../src/experiment/browser/browserAgent.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { makeProjectProfileFixture, makeSiblingProjectProfile } from './project-profile-fixture.js';

function session(
  record: ReturnType<ProjectProfileRegistry['create']>,
  suffix: string,
): BrowserSessionIdentity {
  return {
    projectIdentity: operationIdentityFromProfileRecord(record),
    profileGeneration: record.generation,
    chromeInstanceId: `chrome-${suffix}`,
    sessionId: `browser-session-${suffix}`,
    endpoint: `127.0.0.1:${suffix === 'a' ? '9222' : '9223'}`,
    targetId: `target-${suffix}`,
    targetUrl: `http://127.0.0.1:808${suffix === 'a' ? '0' : '1'}/`,
    product: 'Chrome/151.0.0.0',
    revision: 'fixture',
    protocolVersion: '1.3',
    jsVersion: '15.1',
    frameId: `frame-${suffix}`,
    loaderId: `loader-${suffix}`,
    frameUrl: `http://127.0.0.1:808${suffix === 'a' ? '0' : '1'}/`,
  };
}

test('PP-25: Project A is parked before Project B becomes active', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const a = registry.create(fixture.profile, { actor: 'creator' });
  const b = registry.create(makeSiblingProjectProfile(fixture, 'beta'), { actor: 'creator' });
  const coordinator = new ProjectBrowserSessionCoordinator();
  const order: string[] = [];
  coordinator.register(a, {
    session: session(a, 'a'),
    onActivate: () => order.push('A activate'),
    onPark: () => order.push('A park'),
  });
  coordinator.register(b, {
    session: session(b, 'b'),
    onActivate: () => order.push('B activate'),
    onPark: () => order.push('B park'),
  });

  coordinator.begin(a).commit();
  coordinator.begin(b).commit();
  assert.deepEqual(order, ['A activate', 'A park', 'B activate']);
  assert.equal(coordinator.active?.projectIdentity.projectId, 'beta');
  assert.equal(coordinator.active?.profileGeneration, b.generation);
  assert.equal(coordinator.active?.targetPageId, 'target-b');
  assert.equal(coordinator.isActiveFor(operationIdentityFromProfileRecord(a)), false);
  assert.equal(coordinator.isActiveFor(operationIdentityFromProfileRecord(b)), true);
});

test('PP-25: failed Project B activation restores Project A and never publishes mixed browser identity', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const a = registry.create(fixture.profile, { actor: 'creator' });
  const b = registry.create(makeSiblingProjectProfile(fixture, 'beta'), { actor: 'creator' });
  const coordinator = new ProjectBrowserSessionCoordinator();
  const order: string[] = [];
  coordinator.register(a, {
    session: session(a, 'a'),
    onActivate: () => order.push('A activate'),
    onPark: () => order.push('A park'),
  });
  coordinator.register(b, {
    session: session(b, 'b'),
    onActivate: () => {
      order.push('B activate');
      throw new Error('fixture activation failure');
    },
  });
  coordinator.begin(a).commit();

  assert.throws(() => coordinator.begin(b).commit(), /fixture activation failure/u);
  assert.deepEqual(order, ['A activate', 'A park', 'B activate', 'A activate']);
  assert.equal(coordinator.active?.projectIdentity.projectId, 'alpha');
  assert.equal(coordinator.active?.targetPageId, 'target-a');
});

test('PP-25: a stale browser session generation cannot be registered for a newer Project Profile record', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });
  const coordinator = new ProjectBrowserSessionCoordinator();
  const stale = { ...session(record, 'a'), profileGeneration: record.generation + 1 };

  assert.throws(
    () => coordinator.register(record, { session: stale }),
    /generation/u,
  );
  assert.equal(coordinator.active, null);
});


test('PP-25: an active browser registration cannot be silently replaced or orphaned', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });
  const coordinator = new ProjectBrowserSessionCoordinator();
  let releases = 0;
  coordinator.register(record, {
    session: session(record, 'a'),
    onRelease: () => { releases += 1; },
  });
  coordinator.begin(record).commit();

  const replacement = {
    ...session(record, 'a'),
    sessionId: 'browser-session-replacement',
  } satisfies BrowserSessionIdentity;
  assert.throws(
    () => coordinator.register(record, { session: replacement }),
    /cannot replace an active browser session registration/u,
  );
  assert.equal(coordinator.active?.browserSessionId, 'browser-session-a');
  assert.equal(releases, 0);
  coordinator.dispose();
  assert.equal(releases, 1);
});
