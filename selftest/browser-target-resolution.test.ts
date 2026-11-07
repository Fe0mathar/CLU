/** PP-23 — deterministic browser target resolution and explicit readiness refusals. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testProjectBrowserReadiness } from '../src/control/projectProfiles/browserReadiness.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import {
  resolveGovernedBrowserTarget,
} from '../src/experiment/browser/browserTargetResolver.js';
import {
  BrowserAgent,
  BrowserAgentError,
  type BrowserSessionIdentity,
  type TargetInfo,
} from '../src/experiment/browser/browserAgent.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

function target(id: string, url: string): TargetInfo {
  return {
    id,
    type: 'page',
    title: id,
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

function fixtureRecord() {
  const fixture = makeProjectProfileFixture();
  const registry = new ProjectProfileRegistry(fixture.profiles);
  return { fixture, record: registry.create(fixture.profile, { actor: 'creator' }) };
}

function sessionFor(
  record: ReturnType<typeof fixtureRecord>['record'],
  resolved: NonNullable<ReturnType<typeof resolveGovernedBrowserTarget>['target']>,
): BrowserSessionIdentity {
  return {
    projectIdentity: operationIdentityFromProfileRecord(record),
    profileGeneration: record.generation,
    chromeInstanceId: resolved.chromeInstanceId,
    sessionId: 'BROWSER-fixture',
    endpoint: resolved.debugEndpoint,
    targetId: resolved.targetPageId,
    targetUrl: resolved.targetUrl,
    product: 'Chrome/151.0.0.0',
    revision: '@fixture',
    protocolVersion: '1.3',
    jsVersion: '15.1',
    frameId: 'FRAME-main',
    loaderId: 'LOADER-main',
    frameUrl: resolved.targetUrl,
  };
}

test('PP-23 resolves the unique exact configured URL and binds Project Profile identity', () => {
  const { fixture, record } = fixtureRecord();
  try {
    const result = resolveGovernedBrowserTarget({
      record,
      targets: [
        target('A', 'http://127.0.0.1:8080'),
        target('OTHER', 'http://example.test/'),
      ],
    });
    assert.equal(result.state, 'READY');
    assert.equal(result.selectedBy, 'EXACT_TARGET_URL');
    assert.equal(result.target?.targetPageId, 'A');
    assert.deepEqual(result.target?.projectIdentity, operationIdentityFromProfileRecord(record));
  } finally {
    fixture.dispose();
  }
});

test('PP-23 refuses multiple exact matches instead of selecting the first tab', () => {
  const { fixture, record } = fixtureRecord();
  try {
    const result = resolveGovernedBrowserTarget({
      record,
      targets: [
        target('A', 'http://127.0.0.1:8080'),
        target('B', 'http://127.0.0.1:8080'),
      ],
    });
    assert.equal(result.state, 'TARGET AMBIGUOUS');
    assert.equal(result.code, 'BROWSER_TARGET_AMBIGUOUS');
    assert.equal(result.target, null);
  } finally {
    fixture.dispose();
  }
});

test('PP-23 refuses a wrong-origin tab and a disappeared pinned target', () => {
  const { fixture, record } = fixtureRecord();
  try {
    const forbidden = resolveGovernedBrowserTarget({
      record,
      targets: [target('X', 'https://unrelated.example/')],
    });
    assert.equal(forbidden.state, 'ORIGIN FORBIDDEN');

    const disconnected = resolveGovernedBrowserTarget({
      record,
      targets: [target('A', 'http://127.0.0.1:8080')],
      selectedTargetPageId: 'GONE',
    });
    assert.equal(disconnected.state, 'TARGET DISCONNECTED');
    assert.equal(disconnected.target, null);
  } finally {
    fixture.dispose();
  }
});

test('PP-23 readiness proves endpoint, exact target, session and capture without exposing page data', async () => {
  const { fixture, record } = fixtureRecord();
  try {
    const result = await testProjectBrowserReadiness(record, {
      globalChromeExecutable: process.execPath,
      checkedAt: '2026-08-14T22:00:00.000Z',
      listTargets: async () => [target('A', 'http://127.0.0.1:8080')],
      probeSession: async (resolved) => sessionFor(record, resolved),
    });
    assert.equal(result.state, 'READY');
    assert.equal(result.ready, true);
    assert.equal(result.resolvedTarget?.targetPageId, 'A');
    assert.equal(result.sessionIdentity?.projectIdentity?.projectId, 'alpha');
  } finally {
    fixture.dispose();
  }
});

test('PP-23 readiness distinguishes endpoint failure and target ambiguity', async () => {
  const { fixture, record } = fixtureRecord();
  try {
    const endpoint = await testProjectBrowserReadiness(record, {
      globalChromeExecutable: process.execPath,
      listTargets: async () => {
        throw new Error('connection refused');
      },
    });
    assert.equal(endpoint.state, 'DEBUG ENDPOINT UNAVAILABLE');

    const ambiguous = await testProjectBrowserReadiness(record, {
      globalChromeExecutable: process.execPath,
      listTargets: async () => [
        target('A', 'http://127.0.0.1:8080'),
        target('B', 'http://127.0.0.1:8080'),
      ],
      probeSession: async () => {
        throw new Error('must not be called');
      },
    });
    assert.equal(ambiguous.state, 'TARGET AMBIGUOUS');
  } finally {
    fixture.dispose();
  }
});


test('PP-23 refuses partial governed browser identity before any endpoint access', async () => {
  await assert.rejects(
    BrowserAgent.attach({
      port: 9_222,
      allowedOrigins: ['http://127.0.0.1:8080'],
      profileGeneration: 1,
    }),
    (error: unknown) =>
      error instanceof BrowserAgentError &&
      error.code === 'PROJECT_IDENTITY_MISMATCH' &&
      /must be supplied together/u.test(error.message),
  );
});
