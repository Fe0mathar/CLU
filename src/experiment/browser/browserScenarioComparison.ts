/** Compare sample evidence only when both browser runs share the same measuring conditions. */

import { z } from 'zod';

import { hashCanonicalJson } from '../../shared/ids.js';
import type { BrowserExecutionReceipt } from './browserExecutionLedger.js';
import type { BrowserScenarioReport } from './browserScenario.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
const unit = z.string().regex(/^[a-zA-Z0-9%][a-zA-Z0-9 .%/_-]{0,23}$/u);
const value = z.number().finite().min(-1e15).max(1e15);
const sample = z.array(z.object({ name: id, unit, value }).strict()).min(1).max(16);
const reportSchema = z.object({
  version: z.literal('clue-browser-scenario/1'),
  scenarioId: id,
  buildId: id,
  warmups: z.number().int().min(0).max(5),
  repetitions: z.number().int().min(1).max(20),
  samples: z.array(sample).min(1).max(20),
  metrics: z.array(z.object({ name: id, unit, min: value, median: value, max: value }).strict()).min(1).max(16),
  webgpuWorkloadReported: z.literal(true),
  commandExecuted: z.literal(true),
  consoleCaptured: z.literal(true),
  environment: z.object({
    width: z.number().int().min(1).max(32768),
    height: z.number().int().min(1).max(32768),
    devicePixelRatio: z.number().finite().min(0.01).max(16),
    visibility: z.literal('visible'),
    adapter: z.object({
      vendor: z.string().max(128),
      architecture: z.string().max(128),
      isFallbackAdapter: z.boolean().nullable(),
    }).strict(),
    browser: z.string().min(1).max(128),
    protocolVersion: z.string().min(1).max(64).nullable(),
  }).strict(),
});
const summarySchema = z.object({
  phase: z.literal('baseline'),
  buildId: id,
  scenarioSha256: sha256,
  report: reportSchema,
});
type Report = z.infer<typeof reportSchema>;

export type BrowserScenarioComparison =
  | {
      readonly state: 'COMPARABLE';
      readonly baselineExecutionId: string;
      readonly metrics: readonly {
        readonly name: string;
        readonly unit: string;
        readonly baselineMedian: number;
        readonly candidateMedian: number;
        readonly delta: number;
      }[];
    }
  | {
      readonly state: 'INCOMPARABLE';
      readonly baselineExecutionId: string;
      readonly reason: string;
    };

function checkedMetrics(report: Report): Report['metrics'] | null {
  if (report.samples.length !== report.repetitions) return null;
  const metrics = [...report.metrics].sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
  const samples = report.samples.map((row) => new Map(row.map((metric) => [metric.name, metric])));
  if (new Set(metrics.map((metric) => metric.name)).size !== metrics.length ||
      report.samples.some((row, index) => row.length !== metrics.length || samples[index]!.size !== metrics.length)) return null;
  for (const metric of metrics) {
    const values: number[] = [];
    for (const row of samples) {
      const item = row.get(metric.name);
      if (item === undefined || item.unit !== metric.unit) return null;
      values.push(item.value);
    }
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 === 1
      ? values[middle]!
      : (values[middle - 1]! + values[middle]!) / 2;
    if (metric.min !== values[0] || metric.median !== median || metric.max !== values.at(-1)) return null;
  }
  return metrics;
}

export function compareBrowserScenarioEvidence(
  baseline: BrowserExecutionReceipt,
  candidate: {
    readonly request: BrowserExecutionReceipt['request'];
    readonly buildId: string;
    readonly scenarioSha256: string;
    readonly report: BrowserScenarioReport;
  },
): BrowserScenarioComparison {
  const baselineExecutionId = baseline.browserExecutionId;
  function incomparable(reason: string): BrowserScenarioComparison {
    return { state: 'INCOMPARABLE', baselineExecutionId, reason };
  }
  if (baseline.response?.status !== 'COMPLETED' || baseline.response.browserExecutionId !== baselineExecutionId ||
      baseline.response.requestSha256 !== baseline.requestSha256 || baseline.request.browserExecutionId !== baselineExecutionId ||
      baseline.response.resultSha256 === null || candidate.request.browserExecutionId === baselineExecutionId) {
    return incomparable('Select a separate, completed baseline receipt.');
  }

  const oldSummary = summarySchema.safeParse(baseline.response.resultSummary);
  const currentReport = reportSchema.safeParse(candidate.report);
  if (!oldSummary.success || !currentReport.success) {
    return incomparable('Both executions need complete, valid browser scenario evidence.');
  }
  const before = oldSummary.data;
  const after = currentReport.data;
  if (before.buildId !== before.report.buildId || candidate.buildId !== after.buildId || before.buildId === candidate.buildId) {
    return incomparable('Use distinct verified baseline and candidate build identities.');
  }

  const originalRequest = baseline.request;
  const currentRequest = candidate.request;
  const scenarioBinding = `${after.scenarioId}:${candidate.scenarioSha256}`;
  if (before.scenarioSha256 !== candidate.scenarioSha256 || before.report.scenarioId !== after.scenarioId ||
      originalRequest.commandSha256 !== before.scenarioSha256 || currentRequest.commandSha256 !== candidate.scenarioSha256 ||
      originalRequest.scenarioBinding !== scenarioBinding || currentRequest.scenarioBinding !== scenarioBinding ||
      before.report.repetitions !== after.repetitions || before.report.warmups !== after.warmups ||
      originalRequest.timeoutMs !== currentRequest.timeoutMs) {
    return incomparable('Use the same reviewed scenario, sample policy and timeout for both executions.');
  }
  if (originalRequest.missionBinding === null || originalRequest.missionBinding !== currentRequest.missionBinding ||
      originalRequest.proofBinding !== currentRequest.proofBinding ||
      originalRequest.profileGeneration !== currentRequest.profileGeneration ||
      hashCanonicalJson(originalRequest.projectIdentity) !== hashCanonicalJson(currentRequest.projectIdentity)) {
    return incomparable('Both executions must belong to the same mission and Project Profile generation.');
  }
  if (originalRequest.targetUrl !== currentRequest.targetUrl || originalRequest.targetOrigin !== currentRequest.targetOrigin ||
      originalRequest.chromeVersion !== before.report.environment.browser || currentRequest.chromeVersion !== after.environment.browser ||
      hashCanonicalJson(before.report.environment) !== hashCanonicalJson(after.environment) ||
      (after.environment.adapter.vendor === '' && after.environment.adapter.architecture === '')) {
    return incomparable('Use the same target URL, Chrome version, viewport and identifiable WebGPU adapter.');
  }

  const baselineMetrics = checkedMetrics(before.report);
  const candidateMetrics = checkedMetrics(after);
  if (baselineMetrics === null || candidateMetrics === null || baselineMetrics.length !== candidateMetrics.length ||
      baselineMetrics.some((metric, index) => metric.name !== candidateMetrics[index]!.name || metric.unit !== candidateMetrics[index]!.unit)) {
    return incomparable('Both runs need matching metric names and units and consistent sample summaries.');
  }
  return {
    state: 'COMPARABLE',
    baselineExecutionId,
    metrics: baselineMetrics.map((baselineMetric, index) => {
      const candidateMedian = candidateMetrics[index]!.median;
      return {
        name: baselineMetric.name,
        unit: baselineMetric.unit,
        baselineMedian: baselineMetric.median,
        candidateMedian,
        delta: candidateMedian - baselineMetric.median,
      };
    }),
  };
}
