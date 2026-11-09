/** Session-scoped Chrome verdict for the active saved Project Profile. */

import type { ProjectBrowserRunResult } from '../experiment/browser/projectBrowserRun.js';
import type { ProjectProfileRecord } from '../shared/schemas.js';
import type { DashboardReadiness } from './dashboardReadiness.js';
import { createDashboardSessionTest, type DashboardSessionTestReceipt } from './dashboardSessionTest.js';

interface ChromeTestEvidence {
  readonly executionId: string;
  readonly gpuReadbacks: readonly number[];
}

export type DashboardChromeTestReceipt = DashboardSessionTestReceipt & Partial<ChromeTestEvidence>;

export type DashboardChromeTestRunner = (
  record: ProjectProfileRecord,
  assertRunning: () => void,
) => Promise<ProjectBrowserRunResult>;

export function createDashboardChromeTest(
  runScenario: DashboardChromeTestRunner,
  assertRunning: () => void,
  redact: (text: string) => string,
) {
  return createDashboardSessionTest(
    'Test Chrome',
    'Running Test Chrome. Keep the dedicated window open.',
    async (record, assertCurrent): Promise<DashboardReadiness & ChromeTestEvidence> => {
      const result = await runScenario(record, assertCurrent);
      if (result.status !== 'COMPLETED') throw new Error(`${result.errorCode}. ${result.errorDetail}`);
      const report = result.report;
      const readbacks = report.samples.map(sample =>
        sample.find(metric => metric.name === 'gpu-readback' && metric.unit === 'count')?.value);
      if (report.scenarioId !== 'dedicated-webgpu-canary' || report.buildId !== 'webgpu-canary-1' ||
          !report.commandExecuted || !report.consoleCaptured || !report.webgpuWorkloadReported ||
          !report.screenshotCaptured || readbacks.length !== 3 || !readbacks.every(value => value === 42)) {
        throw new Error('The canary did not verify both DevTools directions, three GPU readbacks of 42 and a screenshot.');
      }
      return {
        state: 'ready',
        summary: 'Test Chrome passed for this dashboard session. WebGPU returned 42 three times.',
        executionId: result.browserExecutionId,
        gpuReadbacks: [42, 42, 42],
        checks: [
          { label: 'Dedicated window', state: 'ready', detail: 'Verified visible Chrome and its loopback debugger.' },
          { label: 'DevTools command', state: 'ready', detail: 'Chrome executed the scripted actions and returned results.' },
          { label: 'Console capture', state: 'ready', detail: 'CLU-E received the independent matching console event.' },
          { label: 'WebGPU canary', state: 'ready', detail: 'Three GPU readbacks returned 42. Screenshot and execution evidence saved.' },
        ],
      };
    },
    assertRunning,
    redact,
  );
}
