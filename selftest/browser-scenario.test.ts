import assert from 'node:assert/strict';
import test from 'node:test';

import type { BrowserSessionIdentity, GovernedBrowserControl } from '../src/experiment/browser/browserAgent.js';
import { browserScenarioSchema, runBrowserScenario, type BrowserScenario } from '../src/experiment/browser/browserScenario.js';
import type { RawConsoleEntry } from '../src/experiment/console/consoleLedger.js';

const expected = {
  projectIdentity: { projectId: 'fixture', targetRootIdentity: 'fixture-root', projectProfileHash: 'fixture-profile' },
  profileGeneration: 1, browserSessionId: 'fixture-browser', targetPageId: 'fixture-page',
  targetUrl: 'http://127.0.0.1:9000/',
};
const identity: BrowserSessionIdentity = {
  ...expected,
  sessionId: expected.browserSessionId,
  targetId: expected.targetPageId,
  chromeInstanceId: 'fixture-chrome',
  endpoint: '127.0.0.1:9222',
  product: 'Chrome/136.0.0.0', revision: null, protocolVersion: '1.3', jsVersion: null,
  frameId: 'frame', loaderId: 'loader', frameUrl: expected.targetUrl,
};
const scenario: BrowserScenario = {
  version: 'clue-browser-scenario/1', id: 'fixture-scenario', warmups: 1, repetitions: 2,
  steps: [{ type: 'reload' }, { type: 'click', x: 24, y: 24 }, { type: 'evaluate', expression: 'true' }],
  measure: 'measureFixture()',
};
const options = { expected, buildId: 'fixture-build', redact: (text: string) => text.replaceAll('known-private-value', '[REDACTED]') };

function measurement(value: number, override: Record<string, unknown> = {}): string {
  return JSON.stringify({
    buildId: options.buildId, webgpuWorkload: true, metrics: [{ name: 'frame', unit: 'ms', value }],
    ...override,
  });
}

function makeAgent(measurements: readonly unknown[]) {
  const listeners = new Set<(entry: RawConsoleEntry) => void>();
  const actions: GovernedBrowserControl[] = [];
  let measurementCount = 0;
  function emit(text: string, level: RawConsoleEntry['level'] = 'info'): void {
    const entry: RawConsoleEntry = { text, level, timestamp: '2026-01-01T00:00:00.000Z', frames: [] };
    for (const listener of listeners) listener(entry);
  }
  const agent = {
    identity: () => identity,
    onConsole(listener: (entry: RawConsoleEntry) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async controlGoverned(action: GovernedBrowserControl, binding: typeof expected) {
      assert.deepEqual(binding, expected);
      actions.push(action);
      if (action.type === 'screenshot') return { data: '/9j/2Q==', mimeType: 'image/jpeg' as const };
      return undefined;
    },
    async evaluateGoverned(source: string, binding: typeof expected): Promise<unknown> {
      assert.deepEqual(binding, expected);
      const marker = /CLU-E console verification [a-f0-9-]+/u.exec(source)?.[0];
      if (marker !== undefined) {
        emit(marker);
        return marker;
      }
      if (source.includes('requestAdapter')) {
        return {
          width: 1024, height: 768, devicePixelRatio: 1, visibility: 'visible',
          adapter: { vendor: 'fixture', architecture: 'test-adapter', isFallbackAdapter: false },
        };
      }
      if (source.includes('measureFixture')) {
        emit('Authorization: Bearer abcdefghij123', 'error');
        emit('known-private-value', 'warning');
        return measurements[measurementCount++];
      }
      return true;
    },
  };
  return { agent, listeners, actions, measurementCount: () => measurementCount };
}

test('scenario repeats setup, excludes warmups from medians, and redacts observed Chrome errors', async () => {
  const { agent, listeners, actions } = makeAgent([measurement(42), measurement(8), measurement(10)]);
  const screenshots: string[] = [];
  const report = await runBrowserScenario(agent, { ...scenario, screenshot: true }, {
    ...options,
    onScreenshot: (screenshot) => { screenshots.push(screenshot.data); },
  });
  assert.deepEqual(actions.map(({ type }) => type), ['reload', 'click', 'reload', 'click', 'reload', 'click', 'screenshot']);
  assert.equal(report.samples.length, 2);
  assert.deepEqual(report.metrics, [{ name: 'frame', unit: 'ms', min: 8, median: 9, max: 10 }]);
  assert.equal(report.environment.adapter.vendor, 'fixture');
  assert.equal(report.webgpuWorkloadReported, true);
  assert.equal(report.console.errors, 3);
  assert.equal(report.console.warnings, 3);
  assert.doesNotMatch(JSON.stringify(report), /abcdefghij123|known-private-value/u);
  assert.deepEqual(screenshots, ['/9j/2Q==']);
  assert.equal(listeners.size, 0);
});

test('scenario rejects ambiguous metrics, missing GPU activity and another loaded build', async () => {
  const results = [
    [measurement(1, { buildId: 'other-build' }), 'BROWSER_BUILD_MISMATCH'],
    [measurement(1, { webgpuWorkload: false }), 'BROWSER_GPU_WORKLOAD_UNVERIFIED'],
    [measurement(1, { metrics: [{ name: 'frame', unit: 'ms', value: 1 }, { name: 'frame', unit: 'ms', value: 2 }] }), 'BROWSER_MEASUREMENT_INVALID'],
  ] as const;
  for (const [value, code] of results) {
    const { agent, listeners } = makeAgent([value]);
    await assert.rejects(runBrowserScenario(agent, scenario, options), { code });
    assert.equal(listeners.size, 0);
  }
  const { agent } = makeAgent([measurement(1), measurement(1, { metrics: [{ name: 'frame', unit: 'fps', value: 1 }] })]);
  await assert.rejects(runBrowserScenario(agent, scenario, options), { code: 'BROWSER_METRIC_SET_CHANGED' });
});

test('scenario deadline ends the run without issuing later commands', async () => {
  const { agent, listeners, measurementCount } = makeAgent([]);
  agent.controlGoverned = async () => new Promise<never>(() => {});
  await assert.rejects(runBrowserScenario(agent, scenario, { ...options, timeoutMs: 100 }), { code: 'BROWSER_SCENARIO_TIMEOUT' });
  assert.equal(measurementCount(), 0);
  assert.equal(listeners.size, 0);
});

test('scenario schema excludes unknown operations and non-finite input coordinates', () => {
  assert.equal(browserScenarioSchema.safeParse({ ...scenario, steps: [{ type: 'navigate', url: 'https://example.com/' }] }).success, false);
  assert.equal(browserScenarioSchema.safeParse({ ...scenario, steps: [{ type: 'click', x: Infinity, y: 0 }] }).success, false);
});
