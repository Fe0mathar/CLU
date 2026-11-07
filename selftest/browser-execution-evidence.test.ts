/** PP-24 — project-isolated browser request/response evidence. */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BrowserExecutionLedger } from '../src/experiment/browser/browserExecutionLedger.js';
import { resolveGovernedBrowserTarget } from '../src/experiment/browser/browserTargetResolver.js';
import type { BrowserSessionIdentity, TargetInfo } from '../src/experiment/browser/browserAgent.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
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

function sessionFor(
  record: ReturnType<ProjectProfileRegistry['create']>,
  resolved: NonNullable<ReturnType<typeof resolveGovernedBrowserTarget>['target']>,
): BrowserSessionIdentity {
  return {
    projectIdentity: operationIdentityFromProfileRecord(record),
    profileGeneration: record.generation,
    chromeInstanceId: resolved.chromeInstanceId,
    sessionId: 'BROWSER-session',
    endpoint: resolved.debugEndpoint,
    targetId: resolved.targetPageId,
    targetUrl: resolved.targetUrl,
    product: 'Chrome/151',
    revision: '@fixture',
    protocolVersion: '1.3',
    jsVersion: '15.1',
    frameId: 'FRAME-main',
    loaderId: 'LOADER-main',
    frameUrl: resolved.targetUrl,
  };
}

test('PP-24 persists one immutable request/response pair under the exact target identity', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
    const identity = operationIdentityFromProfileRecord(record);
    const resolved = resolveGovernedBrowserTarget({
      record,
      targets: [target('TARGET-A', 'http://127.0.0.1:8080')],
    });
    assert.equal(resolved.state, 'READY');
    assert.ok(resolved.target !== null);

    const ledger = new BrowserExecutionLedger(record, {
      root: join(fixture.workspace, 'browser-executions-test'),
    });
    const begun = ledger.begin({
      target: resolved.target,
      session: sessionFor(record, resolved.target),
      command: 'globalThis.__clueBenchmark.run()',
      timeoutMs: 5_000,
      missionBinding: 'MISSION-1',
      scenarioBinding: 'SCENARIO-1',
      proofBinding: 'PROOF-1',
      startedAt: '2026-08-14T22:00:00.000Z',
    });
    assert.equal(begun.request.targetPageId, 'TARGET-A');
    assert.deepEqual(begun.request.projectIdentity, identity);
    assert.equal(begun.response, null);

    const completed = ledger.complete({
      projectIdentity: identity,
      browserExecutionId: begun.browserExecutionId,
      status: 'COMPLETED',
      resultSummary: { fps: 60 },
      performanceEvidenceReferences: ['artifact:fps-report'],
      completedAt: '2026-08-14T22:00:01.000Z',
    });
    assert.equal(completed.response?.status, 'COMPLETED');
    assert.equal(completed.response?.requestSha256, begun.requestSha256);
    assert.equal(completed.response?.resultSha256?.length, 64);
    assert.equal(completed.responseSha256?.length, 64);

    const reread = ledger.read(begun.browserExecutionId);
    assert.deepEqual(reread.response?.resultSummary, { fps: 60 });
    assert.equal(reread.request.targetOrigin, 'http://127.0.0.1:8080');
  } finally {
    fixture.dispose();
  }
});

test('PP-24 records timeout/failure states and refuses another project identity', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
    const identity = operationIdentityFromProfileRecord(record);
    const resolved = resolveGovernedBrowserTarget({
      record,
      targets: [target('TARGET-A', 'http://127.0.0.1:8080')],
    });
    assert.equal(resolved.state, 'READY');
    assert.ok(resolved.target !== null);
    const ledger = new BrowserExecutionLedger(record, {
      root: join(fixture.workspace, 'browser-executions-test'),
    });
    const begun = ledger.begin({
      target: resolved.target,
      session: sessionFor(record, resolved.target),
      command: 'new Promise(() => {})',
      timeoutMs: 5,
    });
    const timeout = ledger.complete({
      projectIdentity: identity,
      browserExecutionId: begun.browserExecutionId,
      status: 'TIMED_OUT',
      errorCode: 'BROWSER_EXECUTION_TIMEOUT',
      errorDetail: 'Governed browser execution exceeded 5 ms.',
    });
    assert.equal(timeout.response?.status, 'TIMED_OUT');
    assert.equal(timeout.response?.resultSha256, null);

    assert.throws(
      () => ledger.complete({
        projectIdentity: { ...identity, projectId: 'other' },
        browserExecutionId: begun.browserExecutionId,
        status: 'FAILED',
        errorCode: 'WRONG_PROJECT',
        errorDetail: 'wrong project',
      }),
      /projectId/u,
    );
    assert.throws(
      () => ledger.complete({
        projectIdentity: identity,
        browserExecutionId: begun.browserExecutionId,
        status: 'FAILED',
        errorCode: 'SECOND_TERMINAL',
        errorDetail: 'must not overwrite',
      }),
      /terminal response/u,
    );
  } finally {
    fixture.dispose();
  }
});

test('PP-24 rejects secret-like command and result material before durable write', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
    const identity = operationIdentityFromProfileRecord(record);
    const resolved = resolveGovernedBrowserTarget({
      record,
      targets: [target('TARGET-A', 'http://127.0.0.1:8080')],
    });
    assert.equal(resolved.state, 'READY');
    assert.ok(resolved.target !== null);
    const ledger = new BrowserExecutionLedger(record, {
      root: join(fixture.workspace, 'browser-executions-test'),
    });
    assert.throws(
      () => ledger.begin({
        target: resolved.target!,
        session: sessionFor(record, resolved.target!),
        command: 'const apiKey = "sk-secret-material-1234567890";',
        timeoutMs: 100,
      }),
      /secret/u,
    );

    const begun = ledger.begin({
      target: resolved.target,
      session: sessionFor(record, resolved.target),
      command: '1 + 1',
      timeoutMs: 100,
    });
    assert.throws(
      () => ledger.complete({
        projectIdentity: identity,
        browserExecutionId: begun.browserExecutionId,
        status: 'COMPLETED',
        resultSummary: { authorization: 'Bearer secret-token-value' },
      }),
      /secret/u,
    );
    assert.equal(ledger.read(begun.browserExecutionId).response, null);
  } finally {
    fixture.dispose();
  }
});


test('PP-24 detects request/response/receipt tampering before evidence can be consumed', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
    const identity = operationIdentityFromProfileRecord(record);
    const resolved = resolveGovernedBrowserTarget({
      record,
      targets: [target('TARGET-A', 'http://127.0.0.1:8080')],
    });
    assert.equal(resolved.state, 'READY');
    assert.ok(resolved.target !== null);
    const ledger = new BrowserExecutionLedger(record, {
      root: join(fixture.workspace, 'browser-executions-tamper-test'),
    });
    const begun = ledger.begin({
      target: resolved.target,
      session: sessionFor(record, resolved.target),
      command: '2 + 2',
      timeoutMs: 100,
    });
    const completed = ledger.complete({
      projectIdentity: identity,
      browserExecutionId: begun.browserExecutionId,
      status: 'COMPLETED',
      resultSummary: { value: 4 },
    });

    const receiptPath = join(completed.directory, 'receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt['responseSha256'] = '0'.repeat(64);
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}
`, 'utf8');
    assert.throws(
      () => ledger.read(begun.browserExecutionId),
      /receipt\.json response hash does not match response\.json/u,
    );
  } finally {
    fixture.dispose();
  }
});
