import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_EXECUTION_LEDGER_VERSION, type BrowserExecutionReceipt } from '../src/experiment/browser/browserExecutionLedger.js';
import type { BrowserScenarioReport } from '../src/experiment/browser/browserScenario.js';
import { compareBrowserScenarioEvidence } from '../src/experiment/browser/browserScenarioComparison.js';

const sha256 = 'a'.repeat(64);
const id = 'BEXEC-' + 'a'.repeat(32);
const candidateId = 'BEXEC-' + 'b'.repeat(32);
const targetUrl = 'http://127.0.0.1:9000/';
const chromeVersion = 'Chrome/136.0.0.0';
const projectIdentity = { projectId: 'fixture', targetRootIdentity: 'fixture-root', projectProfileHash: 'fixture-profile' };
const request: BrowserExecutionReceipt['request'] = {
  ledgerVersion: BROWSER_EXECUTION_LEDGER_VERSION, browserExecutionId: id,
  projectIdentity, profileGeneration: 1, missionBinding: 'fixture-mission',
  scenarioBinding: `fixture-scenario:${sha256}`, proofBinding: null,
  chromeInstanceId: 'fixture-chrome', browserSessionId: 'fixture-session', targetPageId: 'fixture-page',
  targetUrl, targetOrigin: new URL(targetUrl).origin, chromeVersion, debugEndpoint: '127.0.0.1:9222',
  commandSha256: sha256, timeoutMs: 10_000, startedAt: '2026-01-01T00:00:00.000Z',
};

function report(buildId: string, median: number): BrowserScenarioReport {
  return {
    version: 'clue-browser-scenario/1', scenarioId: 'fixture-scenario', buildId,
    warmups: 1, repetitions: 1,
    samples: [[{ name: 'frame', unit: 'ms', value: median }]],
    metrics: [{ name: 'frame', unit: 'ms', min: median, median, max: median }],
    webgpuWorkloadReported: true,
    environment: {
      browser: chromeVersion, protocolVersion: '1.3', width: 1024, height: 768, devicePixelRatio: 1,
      visibility: 'visible', adapter: { vendor: 'fixture', architecture: 'test-adapter', isFallbackAdapter: false },
    },
    commandExecuted: true, consoleCaptured: true,
    console: { warnings: 0, errors: 0, omitted: 0, entries: [] }, screenshotCaptured: false, wallMs: 123,
  };
}

const baseline: BrowserExecutionReceipt = {
  browserExecutionId: id, request, requestSha256: sha256, responseSha256: sha256, directory: '/fixture/receipt',
  response: {
    ledgerVersion: BROWSER_EXECUTION_LEDGER_VERSION, browserExecutionId: id, projectIdentity, requestSha256: sha256,
    status: 'COMPLETED', resultSha256: sha256,
    resultSummary: { phase: 'baseline', buildId: 'fixture-baseline', scenarioSha256: sha256, report: report('fixture-baseline', 10) },
    consoleEvidenceReferences: [], performanceEvidenceReferences: [], artifactReferences: [],
    errorCode: null, errorDetail: null, completedAt: '2026-01-01T00:01:00.000Z',
  },
};
const candidate = {
  request: { ...request, browserExecutionId: candidateId, browserSessionId: 'other-session' },
  scenarioSha256: sha256, buildId: 'fixture-candidate', report: report('fixture-candidate', 8),
};

test('scenario evidence comparison shows raw candidate minus baseline without issuing a verdict', () => {
  assert.deepEqual(compareBrowserScenarioEvidence(baseline, candidate), {
    state: 'COMPARABLE', baselineExecutionId: id,
    metrics: [{ name: 'frame', unit: 'ms', baselineMedian: 10, candidateMedian: 8, delta: -2 }],
  });
});

test('scenario evidence comparison rejects a changed scenario, build, mission, URL, Chrome or adapter', () => {
  const report = candidate.report;
  for (const changed of [
    { ...candidate, scenarioSha256: 'c'.repeat(64) },
    { ...candidate, buildId: 'fixture-baseline' },
    { ...candidate, request: { ...candidate.request, missionBinding: null } },
    { ...candidate, request: { ...candidate.request, profileGeneration: 2 } },
    { ...candidate, request: { ...candidate.request, targetUrl: 'http://127.0.0.1:9000/other' } },
    { ...candidate, request: { ...candidate.request, chromeVersion: 'Chrome/135.0.0.0' } },
    { ...candidate, report: { ...report, environment: { ...report.environment, width: 900 } } },
    { ...candidate, report: { ...report, environment: { ...report.environment, adapter: { ...report.environment.adapter, isFallbackAdapter: true } } } },
  ]) {
    assert.equal(compareBrowserScenarioEvidence(baseline, changed).state, 'INCOMPARABLE');
  }
});

test('scenario evidence comparison verifies receipt phase and numeric summaries against samples', () => {
  assert.equal(compareBrowserScenarioEvidence({ ...baseline, response: null }, candidate).state, 'INCOMPARABLE');
  const wrongPhase = {
    ...baseline,
    response: { ...baseline.response!, resultSummary: { phase: 'candidate', buildId: 'fixture-baseline', scenarioSha256: sha256, report: report('fixture-baseline', 10) } },
  };
  assert.equal(compareBrowserScenarioEvidence(wrongPhase, candidate).state, 'INCOMPARABLE');
  const wrongMedian = { ...candidate.report, metrics: [{ name: 'frame', unit: 'ms', min: 8, median: 0, max: 8 }] };
  assert.equal(compareBrowserScenarioEvidence(baseline, { ...candidate, report: wrongMedian }).state, 'INCOMPARABLE');
});
