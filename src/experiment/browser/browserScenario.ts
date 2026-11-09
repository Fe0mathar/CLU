/** Execute a reviewed scenario against one exact browser page and return comparable samples. */

import { performance } from 'node:perf_hooks';
import { z } from 'zod';

import { assertNoSecretMaterial, redactSecretText } from '../../shared/secretSafety.js';
import type { RawConsoleEntry } from '../console/consoleLedger.js';
import type { BrowserAgent, GovernedBrowserExecution } from './browserAgent.js';
import { probeChromeConsole } from './browserConsoleProbe.js';

const version = 'clue-browser-scenario/1';
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
const expression = z.string().trim().min(1).max(32 * 1024);
const coordinate = z.number().finite().min(0).max(32768);
const delta = z.number().finite().min(-32768).max(32768);
const key = z.enum([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
]);
const step = z.union([
  z.object({ type: z.literal('reload') }).strict(),
  z.object({ type: z.literal('move'), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('click'), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('wheel'), x: coordinate, y: coordinate, deltaX: delta, deltaY: delta }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(1024) }).strict(),
  z.object({ type: z.literal('key'), key }).strict(),
  z.object({ type: z.literal('evaluate'), expression }).strict(),
]);

export const browserScenarioSchema = z.object({
  version: z.literal(version),
  id: identifier,
  warmups: z.number().int().min(0).max(5),
  repetitions: z.number().int().min(1).max(20),
  steps: z.array(step).max(24),
  measure: expression,
  screenshot: z.boolean().optional(),
}).strict();
export type BrowserScenario = z.infer<typeof browserScenarioSchema>;

const metricSchema = z.object({
  name: identifier,
  unit: z.string().regex(/^[a-zA-Z0-9%][a-zA-Z0-9 .%/_-]{0,23}$/u),
  value: z.number().finite().min(-1e15).max(1e15),
}).strict();
const measurementSchema = z.object({
  buildId: identifier,
  webgpuWorkload: z.boolean(),
  metrics: z.array(metricSchema).min(1).max(16),
}).strict();
const environmentSchema = z.object({
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
  devicePixelRatio: z.number().finite().min(0.01).max(16),
  visibility: z.enum(['visible', 'hidden']),
  adapter: z.object({
    vendor: z.string().max(128),
    architecture: z.string().max(128),
    isFallbackAdapter: z.boolean().nullable(),
  }).strict(),
}).strict();
type Metric = z.infer<typeof metricSchema>;
type ExactBrowserExecution = GovernedBrowserExecution & { readonly targetUrl: string };
type ScenarioAgent = Pick<BrowserAgent, 'controlGoverned' | 'evaluateGoverned' | 'onConsole' | 'identity'>;

export interface BrowserScenarioOptions {
  readonly expected: ExactBrowserExecution;
  readonly buildId: string;
  readonly redact: (text: string) => string;
  readonly assertCurrent?: () => void;
  readonly timeoutMs?: number;
  readonly onScreenshot?: (screenshot: { readonly data: string; readonly mimeType: 'image/jpeg' }) => void | Promise<void>;
}

export interface BrowserScenarioReport {
  readonly version: typeof version;
  readonly scenarioId: string;
  readonly buildId: string;
  readonly warmups: number;
  readonly repetitions: number;
  readonly samples: readonly (readonly Metric[])[];
  readonly metrics: readonly {
    readonly name: string;
    readonly unit: string;
    readonly min: number;
    readonly median: number;
    readonly max: number;
  }[];
  readonly webgpuWorkloadReported: true;
  readonly environment: z.infer<typeof environmentSchema> & {
    readonly browser: string;
    readonly protocolVersion: string | null;
  };
  readonly commandExecuted: true;
  readonly consoleCaptured: true;
  readonly console: {
    readonly warnings: number;
    readonly errors: number;
    readonly omitted: number;
    readonly entries: readonly Pick<RawConsoleEntry, 'level' | 'text' | 'timestamp'>[];
  };
  readonly screenshotCaptured: boolean;
  readonly wallMs: number;
}

export class BrowserScenarioError extends Error {
  public constructor(
    public readonly code:
      | 'BROWSER_SCENARIO_INVALID'
      | 'BROWSER_SCENARIO_TIMEOUT'
      | 'BROWSER_CONSOLE_ROUND_TRIP_FAILED'
      | 'BROWSER_MEASUREMENT_INVALID'
      | 'BROWSER_BUILD_MISMATCH'
      | 'BROWSER_GPU_WORKLOAD_UNVERIFIED'
      | 'BROWSER_GPU_ENVIRONMENT_UNAVAILABLE'
      | 'BROWSER_METRIC_SET_CHANGED',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserScenarioError';
  }
}

const maxMeasurementBytes = 16 * 1024;
const maxConsoleEntries = 96;
const maxConsoleText = 512;
const likelyConsoleSecret = /(?:[\w-]*(?:password|passwd|api[_-]?key|authorization|cookie|secret|token)[\w-]*["']?\s*[:=]|\b(?:gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|:\/\/[^\s/@]+:[^\s/@]+@)/iu;

function consoleText(input: string, redact: BrowserScenarioOptions['redact']): string {
  if (input.length > 4096) return '[OVERSIZE CONSOLE ENTRY]';
  if (likelyConsoleSecret.test(input)) return '[REDACTED CONSOLE ENTRY]';
  return redactSecretText(redact(input)).text.slice(0, maxConsoleText);
}

function parseMeasurement(value: unknown, buildId: string, sample: string): Metric[] {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxMeasurementBytes) {
    throw new BrowserScenarioError('BROWSER_MEASUREMENT_INVALID', `${sample} did not return bounded JSON.`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new BrowserScenarioError('BROWSER_MEASUREMENT_INVALID', `${sample} did not return valid JSON.`);
  }
  const result = measurementSchema.safeParse(decoded);
  if (!result.success || new Set(result.data.metrics.map((metric) => metric.name)).size !== result.data.metrics.length) {
    throw new BrowserScenarioError('BROWSER_MEASUREMENT_INVALID', `${sample} must return a build ID, WebGPU workload flag and uniquely named numeric metrics.`);
  }
  if (result.data.buildId !== buildId) {
    throw new BrowserScenarioError('BROWSER_BUILD_MISMATCH', `${sample} ran a different build than the supplied build ID.`);
  }
  if (!result.data.webgpuWorkload) {
    throw new BrowserScenarioError('BROWSER_GPU_WORKLOAD_UNVERIFIED', `${sample} did not report completed WebGPU work.`);
  }
  const metrics = result.data.metrics.sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
  assertNoSecretMaterial(metrics, 'browser scenario metrics');
  return metrics;
}

function summarize(samples: readonly (readonly Metric[])[]): BrowserScenarioReport['metrics'] {
  return samples[0]!.map((metric, index) => {
    const values = samples.map((sample) => sample[index]!.value).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 === 1
      ? values[middle]!
      : (values[middle - 1]! + values[middle]!) / 2;
    return { name: metric.name, unit: metric.unit, min: values[0]!, median, max: values.at(-1)! };
  });
}

export async function runBrowserScenario(
  agent: ScenarioAgent,
  scenarioInput: BrowserScenario,
  options: BrowserScenarioOptions,
): Promise<BrowserScenarioReport> {
  const parsed = browserScenarioSchema.safeParse(scenarioInput);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!parsed.success || !identifier.safeParse(options.buildId).success ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000 ||
      (parsed.data.screenshot === true && options.onScreenshot === undefined)) {
    throw new BrowserScenarioError('BROWSER_SCENARIO_INVALID', 'The scenario, build identity, deadline or screenshot sink is invalid.');
  }
  const scenario = parsed.data;
  assertNoSecretMaterial(scenario, 'browser scenario');
  assertNoSecretMaterial(options.buildId, 'browser scenario build ID');
  const start = performance.now();
  const timeout = new BrowserScenarioError('BROWSER_SCENARIO_TIMEOUT', 'The browser scenario exceeded its run-wide deadline.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(timeout);
    }, timeoutMs);
  });
  const console = { warnings: 0, errors: 0, omitted: 0, entries: [] as BrowserScenarioReport['console']['entries'][number][] };
  const unsubscribe = agent.onConsole((entry) => {
    if (entry.level === 'warning') console.warnings += 1;
    if (entry.level === 'error') console.errors += 1;
    if (console.entries.length >= maxConsoleEntries) {
      console.omitted += 1;
      return;
    }
    console.entries.push({
      level: entry.level,
      text: consoleText(entry.text, options.redact),
      timestamp: entry.timestamp,
    });
  });
  function requireCurrent(): void {
    if (expired || performance.now() - start >= timeoutMs) throw timeout;
    options.assertCurrent?.();
  }
  async function call<T>(operation: () => Promise<T>): Promise<T> {
    requireCurrent();
    const result = await operation();
    requireCurrent();
    return result;
  }
  const evaluate = (source: string) => call(() => agent.evaluateGoverned(source, options.expected));
  const control = (action: Parameters<ScenarioAgent['controlGoverned']>[0]) =>
    call(() => agent.controlGoverned(action, options.expected));
  async function run(): Promise<BrowserScenarioReport> {
    const channels = await call(() => probeChromeConsole(agent, evaluate));
    if (!channels.executed || !channels.captured) {
      throw new BrowserScenarioError('BROWSER_CONSOLE_ROUND_TRIP_FAILED', 'Chrome did not complete both command execution and independent console capture.');
    }
    const browser = agent.identity();
    const fingerprint = environmentSchema.safeParse(await evaluate(`(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      const info = adapter.info;
      const fallback = info?.isFallbackAdapter ?? adapter.isFallbackAdapter;
      return {
        width: innerWidth, height: innerHeight, devicePixelRatio,
        visibility: document.visibilityState,
        adapter: {
          vendor: typeof info?.vendor === 'string' ? info.vendor.slice(0, 128) : '',
          architecture: typeof info?.architecture === 'string' ? info.architecture.slice(0, 128) : '',
          isFallbackAdapter: typeof fallback === 'boolean' ? fallback : null,
        },
      };
    })()`));
    if (!fingerprint.success || browser.product === null || fingerprint.data.visibility !== 'visible') {
      throw new BrowserScenarioError('BROWSER_GPU_ENVIRONMENT_UNAVAILABLE', 'The target page must be visible and provide a WebGPU adapter and Chrome version.');
    }
    const environment = { ...fingerprint.data, browser: browser.product, protocolVersion: browser.protocolVersion };
    assertNoSecretMaterial(environment, 'browser scenario environment');

    const samples: Metric[][] = [];
    let metricSet: string | undefined;
    const { width, height, devicePixelRatio } = environment;
    const viewportGuard = `if (innerWidth !== ${width} || innerHeight !== ${height} ||
      devicePixelRatio !== ${devicePixelRatio} || document.visibilityState !== 'visible') {
      throw new Error('The visible viewport changed during the WebGPU scenario.');
    }`;
    const measurementSource = `(async () => {
      ${viewportGuard}
      const result = JSON.stringify(await (${scenario.measure}\n));
      ${viewportGuard}
      return typeof result === 'string' && result.length <= ${maxMeasurementBytes} ? result : null;
    })()`;
    for (let index = 0; index < scenario.warmups + scenario.repetitions; index += 1) {
      for (const action of scenario.steps) {
        if (action.type === 'evaluate') {
          await evaluate(`(async () => { await (${action.expression}\n); return true; })()`);
        } else {
          await control(action);
        }
      }
      const warmup = index < scenario.warmups;
      const label = warmup ? `Warmup ${index + 1}` : `Sample ${index - scenario.warmups + 1}`;
      const sample = parseMeasurement(await evaluate(measurementSource), options.buildId, label);
      const actualMetricSet = JSON.stringify(sample.map(({ name, unit }) => [name, unit]));
      metricSet ??= actualMetricSet;
      if (metricSet !== actualMetricSet) {
        throw new BrowserScenarioError('BROWSER_METRIC_SET_CHANGED', `${label} changed the metric names or units.`);
      }
      if (!warmup) samples.push(sample);
    }

    let screenshotCaptured = false;
    if (scenario.screenshot && options.onScreenshot !== undefined) {
      const screenshot = await control({ type: 'screenshot' });
      if (screenshot === undefined) {
        throw new BrowserScenarioError('BROWSER_MEASUREMENT_INVALID', 'Chrome did not return the requested screenshot.');
      }
      requireCurrent();
      await options.onScreenshot(screenshot);
      requireCurrent();
      screenshotCaptured = true;
    }
    return {
      version, scenarioId: scenario.id, buildId: options.buildId, warmups: scenario.warmups,
      repetitions: scenario.repetitions, samples, metrics: summarize(samples),
      webgpuWorkloadReported: true, environment, commandExecuted: true, consoleCaptured: true,
      console, screenshotCaptured, wallMs: Math.round(performance.now() - start),
    };
  }
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
  }
}
