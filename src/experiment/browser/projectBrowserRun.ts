/** Run one reviewed scenario in the active managed Chrome instance and preserve its evidence. */

import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { acquireExclusiveFileLock, writeBytesAtomically } from '../../control/projectProfiles/profileFileSystem.js';
import { loadActiveProjectProfileForStartup, readActiveProjectProfileForBenchmark } from '../../control/projectProfiles/projectProfileStartup.js';
import { openProjectRuntime } from '../../control/runtime.js';
import { BrowserAgent, BrowserAgentError } from './browserAgent.js';
import { BrowserExecutionLedger } from './browserExecutionLedger.js';
import { BrowserScenarioError, browserScenarioSchema, runBrowserScenario, type BrowserScenarioReport } from './browserScenario.js';
import { compareBrowserScenarioEvidence, type BrowserScenarioComparison } from './browserScenarioComparison.js';
import { resolveGovernedBrowserTarget } from './browserTargetResolver.js';
import { attestManagedProjectChrome, openManagedProjectChrome } from './managedChromeHost.js';
import { hashBytes } from '../../shared/ids.js';
import { assertNoSecretMaterial, redactSecretText } from '../../shared/secretSafety.js';

const MAX_SCENARIO_BYTES = 64 * 1024;
const SCENARIO_TIMEOUT_MS = 120_000;

export interface BrowserRunOptions {
  readonly scenario: string;
  readonly sha256: string;
  readonly buildId: string;
  readonly phase: string;
  readonly baseline?: string;
}

export type ProjectBrowserRunResult =
  | {
    readonly status: 'COMPLETED';
    readonly browserExecutionId: string;
    readonly evidence: string;
    readonly comparison: BrowserScenarioComparison | null;
    readonly report: BrowserScenarioReport;
  }
  | {
    readonly status: 'FAILED' | 'TIMED_OUT';
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly evidence: string;
  };

function readScenario(options: BrowserRunOptions) {
  if (!/^[a-f0-9]{64}$/iu.test(options.sha256)) throw new Error('Supply the reviewed scenario SHA-256 with --sha256.');
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/iu.test(options.buildId)) throw new Error('Supply the expected served build identity with --build-id.');
  if (!['canary', 'baseline', 'candidate'].includes(options.phase)) throw new Error('--phase must be canary, baseline or candidate.');
  if (options.baseline !== undefined && options.phase !== 'candidate') throw new Error('--baseline requires --phase candidate.');
  if (!lstatSync(options.scenario).isFile()) throw new Error('The scenario must be a regular JSON file.');
  const fd = openSync(options.scenario, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_SCENARIO_BYTES) throw new Error('The scenario must be a regular JSON file of at most 64 KiB.');
    const buffer = Buffer.alloc(MAX_SCENARIO_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const sha256 = hashBytes(bytes);
    if (length > MAX_SCENARIO_BYTES || sha256 !== options.sha256.toLowerCase()) {
      throw new Error('Scenario SHA-256 mismatch. Review the file before authorizing its contents.');
    }
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const scenario = browserScenarioSchema.parse(JSON.parse(source) as unknown);
    assertNoSecretMaterial(scenario, 'browser scenario');
    return { source, scenario, sha256 };
  } finally {
    closeSync(fd);
  }
}

export async function runProjectBrowserScenario(
  repoRoot: string,
  projectId: string,
  options: BrowserRunOptions,
  assertRunning?: () => void,
): Promise<ProjectBrowserRunResult> {
  assertRunning?.();
  const { source, scenario, sha256 } = readScenario(options);
  const selected = loadActiveProjectProfileForStartup(repoRoot);
  if (selected === null || selected.record.profile.projectId !== projectId) {
    throw new Error('Start CLU-E under the requested saved Project Profile before running its browser scenario.');
  }
  const { record, pointer } = selected;
  const assertCurrent = (): void => {
    assertRunning?.();
    const current = readActiveProjectProfileForBenchmark(repoRoot);
    const active = selected.registry.active();
    if (current?.profile.projectId !== projectId || current.generation !== record.generation ||
        current.projectProfileHash !== record.projectProfileHash || active?.registryGeneration !== pointer.registryGeneration ||
        active.projectId !== projectId) {
      throw new Error('The active Project Profile or registry changed. Run the scenario again under the current binding.');
    }
  };
  const runtime = openProjectRuntime(record, { repoRoot, withLog: false, readOnly: true });
  try {
    const mission = runtime.requireMission().requireCurrent();
    runtime.requireFreshProjections();
    const artifactRoot = realpathSync(record.profile.state.artifactStoreRoot);
    const relativeRoot = relative(realpathSync(runtime.workspaceRoot), artifactRoot);
    if (relativeRoot === '' || relativeRoot === '..' || relativeRoot.startsWith(`..${sep}`) || isAbsolute(relativeRoot)) {
      throw new Error('Browser evidence must be stored under this profile’s workspace.');
    }
    const evidenceRoot = join(artifactRoot, 'browser-executions');
    if (existsSync(evidenceRoot) && !lstatSync(evidenceRoot).isDirectory()) {
      throw new Error('The browser evidence directory must be a regular workspace directory.');
    }
    const ledger = new BrowserExecutionLedger(record, { root: evidenceRoot });
    const baseline = options.baseline === undefined ? null : ledger.read(options.baseline);
    const release = acquireExclusiveFileLock(join(ledger.root, '.scenario.lock'));
    try {
      assertCurrent();
      const managed = await openManagedProjectChrome(runtime, record);
      assertCurrent();
      const targets = await BrowserAgent.listTargets('127.0.0.1', managed.port, 5_000);
      assertCurrent();
      const resolved = resolveGovernedBrowserTarget({ record, targets });
      if (resolved.target === null) throw new Error(resolved.detail);
      if (resolved.selectedBy !== 'EXACT_TARGET_URL' || resolved.target.targetUrl !== managed.targetUrl) {
        throw new Error('The exact configured page is unavailable in the dedicated Chrome instance.');
      }
      const target = { ...resolved.target, chromeInstanceId: managed.chromeInstanceId };
      const agent = await BrowserAgent.attach({
        host: '127.0.0.1',
        port: managed.port,
        allowedOrigins: record.profile.integrations.chrome.allowedOrigins,
        expectedTargetId: target.targetPageId,
        projectIdentity: target.projectIdentity,
        profileGeneration: target.profileGeneration,
        chromeInstanceId: target.chromeInstanceId,
        requestTimeoutMs: 30_000,
      });
      try {
        assertCurrent();
        const session = agent.identity();
        const request = ledger.begin({
          target, session, command: source, timeoutMs: SCENARIO_TIMEOUT_MS, missionBinding: mission.id,
          scenarioBinding: `${scenario.id}:${sha256}`,
        });
        const artifacts: string[] = [];
        const redact = (text: string): string => redactSecretText(runtime.secrets.redact(text)).text;
        try {
          let screenshot: Buffer | undefined;
          const report = await runBrowserScenario(agent, scenario, {
            expected: {
              projectIdentity: target.projectIdentity, profileGeneration: target.profileGeneration,
              browserSessionId: session.sessionId, targetPageId: target.targetPageId, targetUrl: target.targetUrl,
            },
            buildId: options.buildId, redact, assertCurrent, timeoutMs: SCENARIO_TIMEOUT_MS,
            onScreenshot: ({ data }) => { screenshot = Buffer.from(data, 'base64'); },
          });
          assertCurrent();
          const after = await attestManagedProjectChrome(runtime, record);
          if (after.chromeInstanceId !== managed.chromeInstanceId) throw new Error('The dedicated Chrome process changed during the scenario.');
          assertCurrent();
          if (runtime.requireMission().requireCurrent().id !== mission.id) throw new Error('The mission changed during the browser scenario.');
          const comparison = baseline === null ? null : compareBrowserScenarioEvidence(baseline, {
            request: request.request, buildId: options.buildId, scenarioSha256: sha256, report,
          });
          if (screenshot !== undefined) {
            const filename = 'page.jpg';
            writeBytesAtomically(join(request.directory, filename), screenshot, { createOnly: true });
            artifacts.push(`${filename}#sha256=${hashBytes(screenshot)}`);
          }
          ledger.complete({
            projectIdentity: target.projectIdentity, browserExecutionId: request.browserExecutionId, status: 'COMPLETED',
            resultSummary: { phase: options.phase, buildId: options.buildId, scenarioSha256: sha256, report, comparison },
            artifactReferences: artifacts,
          });
          return {
            status: 'COMPLETED', browserExecutionId: request.browserExecutionId,
            evidence: join(request.directory, 'response.json'), comparison, report,
          };
        } catch (error) {
          const errorCode = error instanceof BrowserAgentError || error instanceof BrowserScenarioError
            ? error.code : 'BROWSER_SCENARIO_FAILED';
          const detail = redact(error instanceof Error ? error.message : 'The browser scenario failed.').replace(/[\x00-\x1f\x7f]/gu, ' ').slice(0, 1_000);
          const status = /timed?[_ ]out|timeout/iu.test(errorCode) || /deadline exceeded/iu.test(detail) ? 'TIMED_OUT' : 'FAILED';
          ledger.complete({
            projectIdentity: target.projectIdentity, browserExecutionId: request.browserExecutionId,
            status, errorCode, errorDetail: detail, artifactReferences: artifacts,
          });
          return { status, errorCode, errorDetail: detail, evidence: request.directory };
        }
      } finally {
        agent.close();
      }
    } finally {
      release();
    }
  } finally {
    runtime.dispose();
  }
}
