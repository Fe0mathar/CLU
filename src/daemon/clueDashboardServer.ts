/**
 * CLUE unified dashboard server — the single entry point behind "Start CLU-E".
 *
 * Spec: CLUE_Interface_Design_v7 §§1, 9, 10–10C. One server, one port, one page: the
 * four-quadrant operator console (Q1 System Navigator, Q2 Great Book field, Q3 gauges,
 * Q4 Operational Console) all fed from ONE sealed ConsoleSnapshot plus the live
 * recognition event stream. No quadrant queries a registry independently (§9) — the
 * page reads this server, and this server reads durable state.
 *
 * Read/write discipline. The server itself opens the runtime WITHOUT the event-log
 * writer lock: a live dashboard must never lock out recognition. The one writer is the
 * cycle driver, and the control plane here launches it as a child process
 * (`clue cycle drive --navigator`), so the single-writer lock is
 * held by exactly the process doing the writing. While the child runs, this server
 * keeps re-deriving the sealed snapshot; SQLite WAL makes the concurrent reads safe,
 * and a read that races a write simply retries on the next tick.
 *
 * Liveness. Q1's live discovery does not wait for the refresh cadence: the navigator
 * stream endpoint tails `workspace/graph/system-navigator.ndjson` — on connect it
 * replays every recorded event (so a committed past run renders fully), then follows
 * growth, and when the file is truncated by a new run it starts over from the stream's
 * own `navigator.reset`. The sealed-frame endpoint pushes a new frame only when the
 * State Seal actually changes, so reconnecting and live clients agree on "current".
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { isIP } from 'node:net';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { ConsoleStateService } from './consoleStateService.js';
import { parseConsoleSnapshot, type ConsoleSnapshot } from '../ui/viewModel.js';
import { loadMeasurementCatalogue } from '../analysis/measure/catalogue.js';
import { readGraphPointer } from '../analysis/source/navigatorEvents.js';
import type { Runtime } from '../control/runtime.js';
import { readCurrentFindings } from '../control/cycleFindings.js';
import { projectStatusFromRuntime } from '../status/statusFromRuntime.js';
import { STATUS_SCHEMA_VERSION } from '../status/statusContractV5.js';
import { describeTargetPublication } from '../shared/targetPublication.js';
import { readProofBoard } from './proofBoardProjection.js';
import { assessP2Closure } from '../closure/p2ClosureAssessment.js';
import { manualGitSync, manualProjectGitSync } from '../integration/git/manualGitSync.js';
import { launchGitHubProfileSignIn } from '../integration/git/githubProfileConnection.js';
import { checkDashboardCmd, checkDashboardReadiness, readinessRequestSchema, type DashboardReadiness, type ReadinessCapability } from './dashboardReadiness.js';
import { createDashboardChromeTest, type DashboardChromeTestRunner } from './dashboardChromeTest.js';
import { probeDashboardConsole } from './dashboardConsoleProbe.js';
import { createDashboardSessionTest, dashboardSessionTestRequestSchema } from './dashboardSessionTest.js';
import { DASHBOARD_WEBGPU_CANARY_URL, withDashboardWebGpuCanary } from './dashboardWebGpuCanary.js';
import { runProjectBrowserScenario } from '../experiment/browser/projectBrowserRun.js';
import { originAllowed as chromeOriginAllowed } from '../experiment/browser/browserAgent.js';
import { dashboardReadinessScope, readDashboardReadinessReceipts, rememberDashboardReadiness } from './dashboardReadinessReceipt.js';
import { readGatewayStatus, type GatewayStatus } from '../ai/gateway/modelGateway.js';
import {
  hasWindowsOpenAiCredentialReference,
  legacyWindowsOpenAiCredentialReference,
  promptLegacyWindowsOpenAiCredential,
} from '../control/projectProfiles/windowsOpenAiCredential.js';
import {
  configuredProjectProfilesRoot,
  ProjectProfileRegistry,
} from '../control/projectProfiles/index.js';
import {
  ProjectRuntimeManagerError,
  type ProjectRuntimeLease,
  type ProjectRuntimeManager,
} from '../control/projectProfiles/projectRuntimeManager.js';
import {
  handleProjectProfilesApiRequest,
  PROJECT_PROFILES_API_VERSION,
  ProjectProfilesApiError,
  ProjectProfilesApiService,
} from './projectProfilesApi.js';
import type { Actor, ProjectProfileRecord } from '../shared/schemas.js';
import { hashCanonicalJson } from '../shared/ids.js';
import { createAgentApi } from './agentApi.js';
import { createDashboardCycleProgress } from './dashboardCycleProgress.js';
import type { EventAppendTiming } from '../memory/eventLog.js';


/** Controlled-pause gate shared by the start endpoint and its regression test. */
export function gatewayPipelineStartRefusal(
  status: Pick<GatewayStatus, 'enabled' | 'providerPaused' | 'providerPauseReason'>,
): string | null {
  if (!status.enabled || !status.providerPaused) return null;
  return (
    status.providerPauseReason ??
    'OpenAI Platform reported billing or credit exhaustion; new CLU-E work is paused.'
  );
}

/* ------------------------------------------------------------------------- */
/* DEV-P1-15 — exposure control                                               */
/* ------------------------------------------------------------------------- */

/**
 * Addresses that reach only this machine.
 *
 * Directory §19.4 gives daemons "loopback/authenticated HTTP and SSE exposure" — one clause with
 * two halves, and the second is what makes the first enforceable rather than a default someone
 * can pass an argument past. `0.0.0.0` and `::` are listed as *not* loopback deliberately: they
 * are the two values an operator reaches for when something will not connect, and they publish
 * the control plane to the whole network.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/gu, '').toLowerCase();
  return LOOPBACK_HOSTS.has(bare) || (isIP(bare) === 4 && bare.startsWith('127.'));
}

function httpHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * Whether a request's `Host` header names this server rather than some name that resolves to it.
 *
 * This is the DNS-rebinding check, and it is not theoretical for a localhost daemon: an attacker
 * page whose domain re-resolves to 127.0.0.1 becomes same-origin with this server, at which point
 * the Origin check below passes because the origin genuinely is the attacker's. Pinning the Host
 * header closes it — the browser sends the attacker's hostname, which is not the one we serve.
 */
function hostHeaderMatches(header: string | undefined, host: string, port: number): boolean {
  if (header === undefined) return false;
  const seen = header.toLowerCase();
  const expected = new Set([`${httpHost(host).toLowerCase()}:${String(port)}`]);
  if (isLoopbackHost(host)) {
    for (const alias of ['127.0.0.1', 'localhost', '[::1]']) {
      expected.add(`${alias}:${String(port)}`);
    }
  }
  return expected.has(seen);
}

/**
 * Whether a request's `Origin` is this server.
 *
 * Absent is allowed. A same-origin `GET` from the dashboard page sends no `Origin`, and neither
 * does a non-browser client such as `curl` or a test — which is the honest reading: `Origin` is a
 * browser-supplied fact about a browser context, and its absence means there is no browser
 * context to judge, not that the request is trusted. What must never be allowed is an `Origin`
 * that names somewhere else, because only a browser sends that, and only when a page the operator
 * did not write is driving the request.
 */
function originAllowed(origin: string | undefined, host: string, port: number): boolean {
  if (origin === undefined || origin === 'null') return origin === undefined;
  const allowed = new Set([`http://${httpHost(host)}:${String(port)}`]);
  if (isLoopbackHost(host)) {
    for (const alias of ['127.0.0.1', 'localhost', '[::1]']) {
      allowed.add(`http://${alias}:${String(port)}`);
    }
  }
  return allowed.has(origin.toLowerCase());
}

/** Constant-time-ish token comparison; short-circuiting on length is safe, on content is not. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || presented.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wgsl': 'text/plain; charset=utf-8',
};

export interface ClueDashboardOptions {
  readonly operator: string;
  readonly host?: string;
  readonly port?: number;
  readonly refreshIntervalMs?: number;
  readonly missionTitle?: string;
  /**
   * Bearer token required on every request. Mandatory when `host` is not a loopback address
   * (`DEV-P1-15`); optional and unused on loopback, where the OS is the boundary.
   */
  readonly authToken?: string;
  /** Time budget for one pipeline phase before it is terminated (`DEV-P1-15`). */
  readonly childTimeoutMs?: number;
  /** Grace between `SIGTERM` and `SIGKILL` for a phase that will not stop. */
  readonly childKillGraceMs?: number;
  /** Explicit Project Profile registry root. Defaults to the v3 selector or installation layout. */
  readonly profilesRoot?: string;
  /** Owns the active runtime for a registry-bound dashboard. */
  readonly projectRuntimeManager?: ProjectRuntimeManager;
  /** Optional activation seam for caller-managed runtimes. */
  readonly activateProjectProfile?: (record: ProjectProfileRecord, actor: Actor) => Promise<unknown> | unknown;
  /** Scenario runner seam for dashboard tests. The default runs the installed WebGPU canary. */
  readonly chromeTestRun?: DashboardChromeTestRunner;
  /** Probe seam for dashboard tests. The default verifies the governed PowerShell host. */
  readonly consoleTestRun?: (runtime: Runtime, record: ProjectProfileRecord) => Promise<DashboardReadiness>;
}

export interface ClueDashboardHandle {
  readonly url: string;
  stop(): Promise<void>;
}

interface Frame {
  readonly revision: number;
  readonly seal: ConsoleSnapshot['seal'];
  readonly snapshot: ConsoleSnapshot;
}

interface RunState {
  state: 'idle' | 'running' | 'completed' | 'failed' | 'timeout';
  dispatchId: string | null;
  phase: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  lastLine: string | null;
  eventAppends: EventAppendTiming | null;
  /** One receipt per launched phase, in order (`DEV-P1-15`, Directory §19.4). */
  receipts: PhaseReceipt[];
}

/**
 * What one child process actually did.
 *
 * §19.4 gives daemons "command request forwarding to typed control services" and the receipts
 * that go with it. Before this, a finished run left `exitCode` and nothing else: which phase
 * produced it, how long it took, and whether it exited or was killed were all unrecoverable once
 * the next phase overwrote `run.phase`. A receipt per phase is what lets the operator tell a
 * failing `recognize` from a failing `snapshot` after the fact.
 */
interface PhaseReceipt {
  readonly phase: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  /** The signal that ended it, when it did not exit on its own. */
  readonly signal: string | null;
  /** True when this daemon killed it for exceeding the budget rather than it ending. */
  readonly timedOut: boolean;
  readonly lastLine: string | null;
}

/**
 * In-process sealed-frame sink. Same boundary rule as the network daemon (P0.4): what is
 * stored and served is the validator's return value, and identical seals never advance
 * the revision — reconnecting and live clients agree on "current".
 */
class FrameSink {
  public revision = 0;
  public current: Frame | null = null;
  readonly #listeners = new Set<(frame: Frame) => void>();

  public publish(snapshot: ConsoleSnapshot): number {
    const validated = parseConsoleSnapshot(snapshot);
    if (this.current !== null && this.current.seal.snapshotHash === validated.seal.snapshotHash) {
      return this.revision;
    }
    this.revision += 1;
    this.current = { revision: this.revision, seal: validated.seal, snapshot: validated };
    for (const listener of this.#listeners) listener(this.current);
    return this.revision;
  }

  public subscribe(listener: (frame: Frame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export async function startClueDashboard(
  initialRuntime: Runtime,
  options: ClueDashboardOptions,
): Promise<ClueDashboardHandle> {
  const host = (options.host ?? '127.0.0.1').replace(/^\[([^\]]+)\]$/u, '$1');
  const port = options.port ?? 47900;
  let boundPort = port;
  const refreshMs = options.refreshIntervalMs ?? 1000;
  const authToken = options.authToken;
  // Generous by design: recognition over a large target legitimately takes minutes, and a budget
  // that fires on ordinary work is one an operator raises until it never fires at all. The point
  // is that a hung phase ends eventually, not that it ends quickly.
  const childTimeoutMs = options.childTimeoutMs ?? 30 * 60 * 1000;
  const childKillGraceMs = options.childKillGraceMs ?? 10 * 1000;

  // DEV-P1-15, Directory §19.4: exposure is loopback OR authenticated, never neither.
  //
  // Refused at start rather than per request, and that is the point: a server that binds to
  // 0.0.0.0 and then rejects everything has already published a listening port and its own
  // existence to the network. The failure has to happen before `listen`.
  //
  // The control plane makes this more than hygiene. `/api/control/start` spawns child processes
  // against the Creator's tree; unauthenticated reachability from the network is a remote
  // trigger for local execution.
  if (!isLoopbackHost(host) && (authToken === undefined || authToken.length < 16)) {
    throw new Error(
      `Refusing to bind the dashboard to non-loopback host "${host}" without authentication. ` +
        'Directory §19.4 permits loopback OR authenticated exposure. Supply `authToken` ' +
        '(at least 16 characters), or bind 127.0.0.1.',
    );
  }

  const runtimeManager = options.projectRuntimeManager;
  if (runtimeManager !== undefined && runtimeManager.activeRuntime !== initialRuntime) {
    throw new Error('The Project Runtime Manager does not own the initial dashboard runtime.');
  }
  let runtime = initialRuntime;
  const sink = new FrameSink();
  const makeService = (bound: Runtime): ConsoleStateService => new ConsoleStateService(bound, sink, {
    operator: options.operator,
    navigatorPath: join(bound.workspaceRoot, 'graph', 'system-navigator.ndjson'),
    ...(options.missionTitle !== undefined ? { missionTitle: options.missionTitle } : {}),
  });
  let service = makeService(runtime);
  service.refresh();

  const profilesRoot = configuredProjectProfilesRoot(
    runtime.repoRoot,
    runtime.workspaceRoot,
    options.profilesRoot,
  );
  const projectProfilesRegistry = new ProjectProfileRegistry(profilesRoot);
  function makeProfilesApi(bound: Runtime): ProjectProfilesApiService {
    const activateProject = runtimeManager === undefined
      ? options.activateProjectProfile
      : (record: ProjectProfileRecord, actor: Actor) => activateRuntime(bound, record, actor);
    return new ProjectProfilesApiService({
      registry: projectProfilesRegistry,
      runtime: bound,
      actor: 'daemon',
      allowHostConnections: isLoopbackHost(host),
      ...(activateProject === undefined ? {} : { activateProject }),
    });
  }
  let projectProfilesApi = makeProfilesApi(runtime);

  /* ---------------------------- control plane ---------------------------- */

  const idleRun = (): RunState => ({
    state: 'idle',
    dispatchId: null,
    phase: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastLine: null,
    eventAppends: null,
    receipts: [],
  });
  let run = idleRun();
  let cycleProgress = createDashboardCycleProgress(runtime);
  let precedingClosedCycleId: string | null = null;
  let child: ChildProcess | null = null;
  let stopping = false;
  const activeReadinessChecks = new Set<ReadinessCapability>();
  const makeChromeTest = (bound: Runtime) => createDashboardChromeTest(
    options.chromeTestRun ?? ((record, assertRunning) => withDashboardWebGpuCanary(
      bound.repoRoot,
      (scenario) => runProjectBrowserScenario(bound.repoRoot, record.profile.projectId, scenario, assertRunning),
      assertRunning,
    )),
    () => {
      if (stopping) throw new Error('The dashboard is shutting down.');
      if (bound !== runtime || !dashboardProfileCurrent()) throw new Error('Project settings changed. Restart the dashboard before testing Chrome.');
    },
    (text) => bound.secrets.redact(text),
  );
  let chromeTest = makeChromeTest(runtime);
  const makeConsoleTest = (bound: Runtime) => createDashboardSessionTest(
    'Test Console',
    'Running Test Console. The diagnostic host closes automatically.',
    async (record, assertRunning) => {
      const result = await (options.consoleTestRun ?? probeDashboardConsole)(bound, record);
      if (result.state !== 'ready') return result;
      assertRunning();
      const cmd = await checkDashboardCmd(bound);
      return {
        ...result,
        checks: [...result.checks, cmd, {
          label: 'Elevated operations', state: 'unknown', detail: 'This test verifies the governed host at its current privileges.',
        }],
      } satisfies DashboardReadiness;
    },
    () => {
      if (stopping) throw new Error('The dashboard is shutting down.');
      if (bound !== runtime || !dashboardProfileCurrent()) throw new Error('Project settings changed. Restart the dashboard before testing Console.');
    },
    (text) => bound.secrets.redact(text),
  );
  let consoleTest = makeConsoleTest(runtime);
  const cliEntry = join(initialRuntime.repoRoot, 'dist', 'src', 'cli', 'index.js');

  /**
   * Launches one pipeline phase as a child process, under a time budget.
   *
   * DEV-P1-15: there was no budget. A `recognize` that hung — waiting on a lock, a filesystem
   * that never answers, a target that never terminates — left `run.state` at `running` for the
   * life of the daemon, and `startPipeline` refuses to start while that is true. The daemon did
   * not crash; it became permanently unable to do the one thing its control plane exists for,
   * with no signal saying why and no way back except restarting it.
   *
   * Termination escalates rather than assuming. `SIGTERM` first, so the child can close its
   * event-log lock and flush its stream; `SIGKILL` only if it is still alive after the grace
   * period, because a killed writer leaves the lock behind for the next process to reclaim.
   * A timeout is reported as its own state, not folded into `failed`: "the run exceeded its
   * budget" and "the run returned a non-zero exit code" are different facts about different
   * problems, and collapsing them would send an operator to read a log that says nothing.
   */
  function launchCycle(): void {
    const phase = 'cycle';
    run.phase = phase;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const expectedRuntime = hashCanonicalJson([
      runtime.config.project.root,
      runtime.workspaceRoot,
      runtime.projectBinding?.recognition.identity ?? null,
    ]);
    const args = [cliEntry, 'cycle', 'drive', '--navigator', '--expect-runtime', expectedRuntime, '--verify-recovery'];
    const env = { ...process.env };
    const credentials = new Set([
      'OPENAI_API_KEY', 'CLUE_AGENT_OPENAI_API_KEY', runtime.config.gateway.api_key_env.toUpperCase(),
    ]);
    for (const name of Object.keys(env)) {
      if (credentials.has(name.toUpperCase())) delete env[name];
    }
    const lease = runtimeManager?.lease(runtime.projectIdentity ?? undefined);
    let spawned: ChildProcess;
    try {
      spawned = spawn(process.execPath, args, { cwd: runtime.repoRoot, env });
    } catch (error) {
      lease?.release();
      throw error;
    }
    child = spawned;

    let timedOut = false;
    let phaseLastLine: string | null = null;
    const consume = (line: string): void => {
      const text = line.trim();
      if (text.length > 0) {
        phaseLastLine = runtime.secrets.redact(text).slice(0, 1000);
        run.lastLine = phaseLastLine;
      }
    };
    if (spawned.stdout !== null) {
      createInterface({ input: spawned.stdout }).on('line', (line) => {
        if (line.startsWith('{"eventAppends":') && line.length <= 256) {
          try {
            const timing = JSON.parse(line).eventAppends as EventAppendTiming | null;
            if (timing !== null && Number.isSafeInteger(timing.count) && timing.count >= 0 &&
                Number.isFinite(timing.maxMs) && timing.maxMs >= 0 &&
                Number.isFinite(timing.totalMs) && timing.totalMs >= timing.maxMs) {
              run.eventAppends = { count: timing.count, totalMs: timing.totalMs, maxMs: timing.maxMs };
              return;
            }
          } catch { /* ordinary worker output */ }
        }
        consume(line);
      });
    }
    if (spawned.stderr !== null) createInterface({ input: spawned.stderr }).on('line', consume);
    spawned.once('error', (error) => {
      phaseLastLine = `Cycle process could not start: ${error.message}`;
      run.lastLine = phaseLastLine;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      spawned.kill('SIGTERM');
      // Escalation is armed here rather than after SIGTERM is observed, because a process that
      // ignores SIGTERM never produces an observation to react to.
      const escalation = setTimeout(() => {
        if (child === spawned) spawned.kill('SIGKILL');
      }, childKillGraceMs);
      escalation.unref();
    }, childTimeoutMs);
    killTimer.unref();

    spawned.once('close', (code, signal) => {
      clearTimeout(killTimer);
      child = null;
      const finishedAt = new Date().toISOString();
      run.receipts.push({
        phase,
        startedAt,
        finishedAt,
        durationMs: Date.now() - startedMs,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        lastLine: phaseLastLine,
      });
      run.state = timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed';
      run.exitCode = code;
      run.finishedAt = finishedAt;
      run.phase = null;
      if (timedOut) {
        run.lastLine =
          `${phase} exceeded its ${String(childTimeoutMs)} ms budget and was terminated`;
      }
      try {
        service.refresh();
      } catch {
        /* The next tick retries. */
      } finally {
        lease?.release();
      }
    });
  }

  type StartResult =
    | {
      readonly started: true;
      readonly disposition: 'started' | 'attached' | 'already-screened';
      readonly runId: string | null;
      readonly cycleId: string | null;
      readonly dispatchId: string | null;
    }
    | { readonly started: false; readonly code: string; readonly reason: string; readonly message: string };

  function startRefused(code: string, reason: string): StartResult {
    return { started: false, code, reason, message: reason };
  }

  function runSnapshot() {
    const latest = cycleProgress.read();
    const cycle = latest?.cycleId === precedingClosedCycleId ? null : latest;
    return {
      ...run,
      runId: cycle?.cycleId ?? null,
      cycleId: cycle?.cycleId ?? null,
      missionId: cycle?.missionId ?? null,
      cycleCurrent: cycle?.current ?? null,
      cycleMissionMatches: cycle?.missionMatches ?? null,
      cycleStage: cycle?.stage ?? null,
      cycleGrade: cycle?.grade ?? null,
      suspendedFrom: cycle?.suspendedFrom ?? null,
      checkpointAt: cycle?.checkpoint?.occurredAt ?? null,
      checkpoints: cycle?.checkpoints ?? [],
      recoveryRequired: cycle?.recoverable === true && run.state !== 'running',
    };
  }

  function startAccepted(
    disposition: 'started' | 'attached' | 'already-screened',
    cycleId: string | null,
  ): StartResult {
    return {
      started: true,
      disposition,
      runId: cycleId,
      cycleId,
      dispatchId: disposition === 'already-screened' ? null : run.dispatchId,
    };
  }

  function cycleProjectionIsFresh(): boolean {
    try {
      runtime.requireFreshProjections();
      return true;
    } catch {
      // The cycle writer catches up committed events before deciding what to drive.
      return false;
    }
  }

  function startPipeline(): StartResult {
    if (stopping) return startRefused('DASHBOARD_STOPPING', 'The dashboard is stopping.');
    if (!dashboardProfileCurrent()) {
      return startRefused('DASHBOARD_RUNTIME_CHANGED', 'Project settings changed. Restart the dashboard before starting a cycle.');
    }
    if (run.state === 'running') return startAccepted('attached', runSnapshot().cycleId);
    const cycle = cycleProgress.read();
    const useCurrentCycle = cycle?.current === true && cycleProjectionIsFresh();
    if (useCurrentCycle) {
      if (!cycle.missionMatches || cycle.checkpoint === null) {
        return startRefused('CYCLE_CHECKPOINT_UNVERIFIED', 'The current cycle has no checkpoint for the active mission. Inspect the cycle before starting again.');
      }
      if (cycle.stage === 'SUSPENDED') {
        return startRefused('CYCLE_SUSPENDED', 'The cycle is suspended. Use the CLU-E cycle resume CLI command to verify and resume it before using Start.');
      }
      if (!cycle.recoverable) return startAccepted('already-screened', cycle.cycleId);
    }
    // Provider billing authority is fail-closed. Finish any already durable write, but refuse
    // a new pipeline before spawning a child while the event-backed controlled pause is active.
    if (runtime.config.gateway.enabled) {
      try {
        const gateway = readGatewayStatus(runtime);
        const pauseReason = gatewayPipelineStartRefusal(gateway);
        if (pauseReason !== null) {
          return startRefused('PROVIDER_BUDGET_PAUSED', pauseReason);
        }
      } catch (error) {
        return startRefused(
          'GATEWAY_STATUS_UNAVAILABLE',
          `Gateway status unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    precedingClosedCycleId = cycle?.current === false ? cycle.cycleId : null;
    run.dispatchId = randomUUID();
    run.state = 'running';
    run.startedAt = new Date().toISOString();
    run.finishedAt = null;
    run.exitCode = null;
    run.lastLine = null;
    run.eventAppends = null;
    run.receipts.length = 0;
    try {
      launchCycle();
    } catch (error) {
      run.state = 'failed';
      run.phase = null;
      run.finishedAt = new Date().toISOString();
      run.lastLine = error instanceof Error ? error.message : String(error);
      return startRefused('CYCLE_LAUNCH_FAILED', run.lastLine);
    }
    return startAccepted('started', useCurrentCycle ? cycle.cycleId : null);
  }

  function makeOperatorAgent(bound: Runtime) {
    const credential = bound.projectProfile?.profile.integrations.gpt.credential;
    return createAgentApi({
      repoRoot: bound.repoRoot,
      workspaceRoot: bound.workspaceRoot,
      scope: hashCanonicalJson([
        bound.config.project.id,
        bound.projectIdentity?.targetRootIdentity ?? bound.config.project.root,
      ]),
      profileCredential: credential?.source === 'project-override'
        ? credential.value
        : `env:${bound.config.gateway.api_key_env}`,
      local: isLoopbackHost(host),
      readBody: readRequestBody,
      profileCurrent: () => bound === runtime && dashboardProfileCurrent(),
      stopping: () => stopping,
      redact: (text) => bound.secrets.redact(text),
      observe: () => {
        const current = runSnapshot();
        const frame = sink.current?.snapshot;
        return {
          cycleId: current.cycleId,
          cycleStage: current.cycleStage,
          recoveryRequired: current.recoveryRequired,
          workerState: current.state,
          missionId: current.missionId ?? frame?.shell.identity.missionId ?? null,
          statusHash: frame?.seal.statusHash ?? null,
          capturedAt: frame?.seal.capturedAt ?? null,
          readiness: frame?.dashboard.startStop.phase ?? null,
        };
      },
    });
  }
  let operatorAgent = makeOperatorAgent(runtime);

  function prepareDashboard(next: Runtime) {
    const nextService = makeService(next);
    return {
      runtime: next,
      service: nextService,
      frame: nextService.capture(),
      profilesApi: makeProfilesApi(next),
      cycleProgress: createDashboardCycleProgress(next),
      operatorAgent: makeOperatorAgent(next),
      chromeTest: makeChromeTest(next),
      consoleTest: makeConsoleTest(next),
    };
  }

  function activateRuntime(previous: Runtime, record: ProjectProfileRecord, actor: Actor) {
    if (stopping || runtimeManager === undefined || previous !== runtime) {
      throw new ProjectProfilesApiError(
        'DASHBOARD_RUNTIME_CHANGED', 'The dashboard runtime changed before this activation request was applied.', 409,
      );
    }

    const prepared: { value?: ReturnType<typeof prepareDashboard> } = {};
    let publication: ReturnType<ProjectRuntimeManager['activate']>;
    try {
      publication = runtimeManager.activate({
        projectId: record.profile.projectId,
        actor,
        reason: 'DASHBOARD_ACTIVATE_PROFILE',
        expectedCurrentIdentity: previous.projectIdentity,
        expectedTargetGeneration: record.generation,
        expectedTargetProfileHash: record.projectProfileHash,
        prepareRuntime: (next) => {
          prepared.value = prepareDashboard(next);
          operatorAgent.close();
        },
      });
    } catch (error) {
      if (runtimeManager.activeRuntime !== runtime) disconnectEventStreams();
      throw error;
    }
    const successor = prepared.value;
    if (successor === undefined) return publication; // Same verified active generation.

    // The manager already prepared the frame before moving the durable pointer. Replace all
    // server bindings in this turn, and have clients reconnect from the successor stream prefix.
    disconnectEventStreams();
    runtime = successor.runtime;
    service = successor.service;
    projectProfilesApi = successor.profilesApi;
    cycleProgress = successor.cycleProgress;
    operatorAgent = successor.operatorAgent;
    chromeTest = successor.chromeTest;
    consoleTest = successor.consoleTest;
    run = idleRun();
    precedingClosedCycleId = null;
    sink.publish(successor.frame);
    return publication;
  }

  function dashboardProfileCurrent(): boolean {
    if (runtimeManager !== undefined && runtimeManager.activeRuntime !== runtime) return false;
    const active = runtime.projectProfile;
    if (active === null) return true; // Gateway admission independently checks the runtime digest.
    try {
      const saved = projectProfilesRegistry.getProfile(active.profile.projectId);
      const pointer = projectProfilesRegistry.active();
      return saved.generation === active.generation && saved.projectProfileHash === active.projectProfileHash &&
        (pointer === null || (
          pointer.projectId === active.profile.projectId && pointer.profileGeneration === active.generation &&
          pointer.projectProfileHash === active.projectProfileHash &&
          pointer.targetRootIdentity === active.profile.targetRootIdentity
        ));
    } catch {
      return false;
    }
  }

  /* ------------------------- config readiness view ------------------------ */

  function configView(): unknown {
    const config = runtime.config;
    const projectRoot = config.project.root;
    const tracked = config.constitution.tracked_documents.map((path: string) => ({
      path,
      present: existsSync(join(runtime.repoRoot, path)),
    }));
    const pointer = readGraphPointer(
      join(runtime.workspaceRoot, 'graph', 'system-navigator.ndjson'),
      runtime.projectBinding?.recognition.identity,
    );
    const publication = describeTargetPublication(
      config.project.remote,
      config.project.credential_env,
      config.project.remote_decision,
    );
    let gatewayControl: {
      readonly enabled: boolean;
      readonly providerPaused: boolean;
      readonly providerBudgetExhausted: boolean;
      readonly providerPauseReason: string | null;
      readonly startRefusal: string | null;
    } | null = null;
    if (config.gateway.enabled) {
      try {
        const gateway = readGatewayStatus(runtime);
        gatewayControl = {
          enabled: gateway.enabled,
          providerPaused: gateway.providerPaused,
          providerBudgetExhausted: gateway.providerBudgetExhausted,
          providerPauseReason: gateway.providerPauseReason,
          startRefusal: gatewayPipelineStartRefusal(gateway),
        };
      } catch (error) {
        gatewayControl = {
          enabled: true,
          providerPaused: false,
          providerBudgetExhausted: false,
          providerPauseReason: null,
          startRefusal: `gateway-status-unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return {
      project: {
        id: config.project.id,
        root: projectRoot,
        rootPresent: existsSync(projectRoot),
        activeTarget: config.project.active_target,
        publication,
      },
      tsconfigPresent: existsSync(join(projectRoot, 'tsconfig.json')),
      trackedDocuments: tracked,
      workspaceInitialised: existsSync(join(runtime.workspaceRoot, 'db')),
      committedGraphPointer: pointer,
      gatewayControl,
      chromeTest: isLoopbackHost(host) && dashboardProfileCurrent() ? chromeTest.read(runtime.projectProfile) : null,
      consoleTest: isLoopbackHost(host) && dashboardProfileCurrent() ? consoleTest.read(runtime.projectProfile) : null,
      legacyConnectionControls: runtime.projectProfile === null && isLoopbackHost(host),
      projectProfiles: {
        apiVersion: PROJECT_PROFILES_API_VERSION,
        registryRoot: profilesRoot,
        runtimeMode: runtime.profileMode,
        active: projectProfilesRegistry.active(),
      },
      startable:
        existsSync(projectRoot) &&
        existsSync(join(projectRoot, 'tsconfig.json')) &&
        run.state !== 'running' &&
        (gatewayControl?.startRefusal ?? null) === null,
    };
  }

  /* -------------------- server-hosted metric catalogues -------------------
   * A library of target-program catalogues lives on the server under
   * config/measurements/catalogues/*.json. These helpers list, read and store
   * them for the Configure panel. Names are strictly sanitised (no traversal);
   * uploads are size-capped and must contain a non-empty "metrics" array. The
   * ENGINE still measures against config/measurements/catalogue.yaml — selecting
   * a catalogue here drives the browser view; deploying is a catalogue revision.
   * ------------------------------------------------------------------------ */

  const CATALOGUE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
  const MAX_CATALOGUE_BYTES = 2 * 1024 * 1024;

  // DEV-P1-15 — the Navigator is a stream, not a file download. Reads are deliberately
  // chunked and each NDJSON record is bounded so a large historical stream or a malformed
  // newline-free record cannot become a single allocation in the daemon. Backpressure is
  // honoured below before another chunk is read.
  const NAVIGATOR_READ_CHUNK_BYTES = 64 * 1024;
  const NAVIGATOR_IDENTITY_PROBE_BYTES = 64 * 1024;
  const MAX_NAVIGATOR_LINE_BYTES = 1024 * 1024;

  function cataloguesDir(): string {
    return join(runtime.repoRoot, 'config', 'measurements', 'catalogues');
  }

  function safeCataloguePath(idOrName: string): string | null {
    let name = idOrName.trim();
    if (name.toLowerCase().endsWith('.json')) name = name.slice(0, -5);
    if (name.length === 0 || name.length > 128 || name.includes('..') || !CATALOGUE_NAME_PATTERN.test(name)) return null;
    const dir = cataloguesDir();
    const file = resolve(dir, `${name}.json`);
    const rel = relative(dir, file);
    if (rel === '' || rel.startsWith('..') || rel.includes(sep)) return null;
    return file;
  }

  function listCatalogues(): unknown[] {
    const dir = cataloguesDir();
    if (!existsSync(dir)) return [];
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
    } catch {
      return [];
    }
    const catalogues: unknown[] = [];
    for (const filename of names.sort()) {
      const file = join(dir, filename);
      let sizeBytes = 0;
      let modifiedAt = '';
      try {
        const stat = statSync(file);
        sizeBytes = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch {
        continue;
      }
      let catalogueId: string | null = null;
      let version: string | null = null;
      let metricCount: number | null = null;
      let valid = false;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          const cid = parsed['catalogueId'];
          const ver = parsed['version'];
          const metrics = parsed['metrics'];
          catalogueId = typeof cid === 'string' ? cid : null;
          version = ver == null ? null : String(ver);
          metricCount = Array.isArray(metrics) ? metrics.length : null;
          valid = Array.isArray(metrics) && metrics.length > 0;
        }
      } catch {
        /* left marked invalid — still listed so the operator can see and replace it */
      }
      catalogues.push({ id: filename.slice(0, -5), filename, sizeBytes, modifiedAt, catalogueId, version, metricCount, valid });
    }
    return catalogues;
  }

  function readRequestBody(request: IncomingMessage, maxBytes = MAX_CATALOGUE_BYTES): Promise<string> {
    return new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        chunks.length = 0;
        rejectBody(error);
      };

      request.on('data', (chunk: Buffer | string) => {
        if (settled) return; // keep draining the socket without retaining any more bytes
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) {
          rejectOnce(new Error(maxBytes === MAX_CATALOGUE_BYTES
            ? 'catalogue exceeds the 2 MB limit'
            : 'request body exceeds the configured limit'));
          return;
        }
        chunks.push(bytes);
      });
      request.on('end', () => {
        if (settled) return;
        settled = true;
        resolveBody(Buffer.concat(chunks, size).toString('utf8'));
      });
      request.on('error', (error) => rejectOnce(error));
    });
  }

  /* ----------------------------- static roots ---------------------------- */

  const staticRoots: readonly { prefix: string; root: string }[] = [
    { prefix: '/ui/', root: join(runtime.repoRoot, 'ui', 'clue-dashboard') },
    { prefix: '/navigator-src/', root: join(runtime.repoRoot, 'ui', 'system-navigator', 'src') },
  ];

  function isOutsideRoot(root: string, target: string): boolean {
    const traversal = relative(root, target);
    return isAbsolute(traversal) || traversal.startsWith(`..${sep}`) || traversal === '..';
  }

  function serveStatic(pathname: string, response: ServerResponse, headOnly: boolean): boolean {
    const mapped =
      pathname === '/' ? { prefix: '/ui/', rest: 'index.html' } : matchStatic(pathname);
    if (mapped === null) return false;
    const rootEntry = staticRoots.find((entry) => entry.prefix === mapped.prefix);
    if (rootEntry === undefined) return false;
    let target: string;
    try {
      target = resolve(rootEntry.root, decodeURIComponent(mapped.rest));
    } catch {
      response.writeHead(400).end('Invalid asset path.');
      return true;
    }
    if (isOutsideRoot(rootEntry.root, target)) {
      response.writeHead(403).end('Forbidden.');
      return true;
    }
    let fileStat;
    try {
      const realRoot = realpathSync(rootEntry.root);
      target = realpathSync(target);
      if (isOutsideRoot(realRoot, target)) {
        response.writeHead(403).end('Forbidden.');
        return true;
      }
      fileStat = statSync(target);
    } catch {
      response.writeHead(404).end('Not found.');
      return true;
    }
    if (!fileStat.isFile()) {
      response.writeHead(404).end('Not found.');
      return true;
    }
    response.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (headOnly) {
      response.end();
    } else {
      const stream = createReadStream(target);
      stream.once('error', () => response.destroy());
      stream.pipe(response);
    }
    return true;
  }

  function matchStatic(pathname: string): { prefix: string; rest: string } | null {
    for (const entry of staticRoots) {
      if (pathname.startsWith(entry.prefix)) {
        return { prefix: entry.prefix, rest: pathname.slice(entry.prefix.length) };
      }
    }
    return null;
  }

  /* ---------------------- navigator stream: replay+tail ------------------- */

  // Every long-lived response is owned by the handle. `stop()` closes both console and
  // Navigator SSE clients before closing the listener; otherwise an open Navigator response
  // keeps `server.close()` pending indefinitely.
  const eventStreams = new Set<ServerResponse>();

  function disconnectEventStreams(): void {
    for (const stream of eventStreams) stream.destroy();
    eventStreams.clear();
  }

  function streamNavigator(response: ServerResponse): void {
    const navigatorFile = join(runtime.workspaceRoot, 'graph', 'system-navigator.ndjson');
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders();
    eventStreams.add(response);

    let offset = 0;
    let carry = Buffer.alloc(0);
    let activeStreamIdentity: string | null = null;
    let closed = false;
    let pumpTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (pumpTimer !== null) clearInterval(pumpTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      eventStreams.delete(response);
    };
    response.once('close', cleanup);
    response.once('finish', cleanup);
    response.once('error', cleanup);

    /**
     * Writes one SSE record and waits for the socket to drain when Node's writable buffer is
     * full. Without this boundary a slow or paused browser lets `response.write()` queue the
     * whole historical Navigator stream in process memory even though file reads are chunked.
     */
    const writeSse = async (payload: string): Promise<boolean> => {
      if (closed || response.destroyed || response.writableEnded) return false;
      if (response.write(payload)) return true;

      await new Promise<void>((resolveDrain) => {
        const finish = (): void => {
          response.off('drain', onDrain);
          response.off('close', onClosed);
          response.off('finish', onClosed);
          response.off('error', onClosed);
          resolveDrain();
        };
        const onDrain = (): void => finish();
        const onClosed = (): void => finish();
        response.once('drain', onDrain);
        response.once('close', onClosed);
        response.once('finish', onClosed);
        response.once('error', onClosed);
      });
      return !closed && !response.destroyed && !response.writableEnded;
    };

    const refuseOversizedLine = async (): Promise<false> => {
      await writeSse(
        `event: error\ndata: navigator record exceeds ${String(MAX_NAVIGATOR_LINE_BYTES)} bytes\n\n`,
      );
      response.end();
      return false;
    };

    /**
     * Reads the immutable identity carried by the first NDJSON record of the current run.
     *
     * Size-only truncation detection is insufficient: the recognizer opens the live stream with
     * `w`, and a fast new run can truncate and regrow the file beyond the old byte offset before
     * the 250 ms tail tick observes it. In that race `size < offset` is false and the old tailer
     * starts in the middle of the replacement stream, skipping exactly the reset/inventory prefix
     * SURF needs. Every governed stream has a run-qualified `streamId`; probing the first complete
     * line makes generation replacement observable even after such rapid regrowth.
     */
    const readStreamIdentity = async (size: number): Promise<string | null> => {
      if (size <= 0) return null;
      const requested = Math.min(size, NAVIGATOR_IDENTITY_PROBE_BYTES);
      const handle = await open(navigatorFile, 'r');
      try {
        const buffer = Buffer.allocUnsafe(requested);
        const { bytesRead } = await handle.read(buffer, 0, requested, 0);
        if (bytesRead === 0) return null;
        const bytes = buffer.subarray(0, bytesRead);
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) return null; // first record is still being written
        const firstLine = bytes.subarray(0, newline).toString('utf8').trim();
        if (firstLine.length === 0) return null;
        try {
          const envelope = JSON.parse(firstLine) as {
            readonly streamId?: unknown;
            readonly runId?: unknown;
            readonly snapshotId?: unknown;
          };
          if (typeof envelope.streamId === 'string' && envelope.streamId.length > 0) {
            return `stream:${envelope.streamId}`;
          }
          if (typeof envelope.runId === 'string' && envelope.runId.length > 0) {
            return `run:${envelope.runId}`;
          }
          if (typeof envelope.snapshotId === 'string' && envelope.snapshotId.length > 0) {
            return `snapshot:${envelope.snapshotId}:${firstLine}`;
          }
        } catch {
          /* legacy/malformed first records still get a stable raw-line generation identity */
        }
        return `line:${firstLine}`;
      } finally {
        await handle.close();
      }
    };

    /** Splits a bounded byte chunk into complete NDJSON records without breaking UTF-8. */
    const publishBytes = async (bytes: Buffer): Promise<boolean> => {
      const combined = carry.length === 0
        ? bytes
        : Buffer.concat([carry, bytes], carry.length + bytes.length);
      let lineStart = 0;

      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue; // LF; trim below removes a preceding CR
        const line = combined.subarray(lineStart, index);
        if (line.length > MAX_NAVIGATOR_LINE_BYTES) return refuseOversizedLine();
        const trimmed = line.toString('utf8').trim();
        if (trimmed.length > 0 && !(await writeSse(`data: ${trimmed}\n\n`))) return false;
        lineStart = index + 1;
      }

      // Copy only the unfinished tail. Holding a subarray would retain the complete chunk.
      carry = Buffer.from(combined.subarray(lineStart));
      if (carry.length > MAX_NAVIGATOR_LINE_BYTES) return refuseOversizedLine();
      return true;
    };

    const pump = async (): Promise<void> => {
      let size = 0;
      try {
        size = statSync(navigatorFile).size;
      } catch {
        return; // no stream yet — a run has not started
      }
      if (size === 0) {
        // A writer has truncated the stream but has not completed its first line yet.
        offset = 0;
        carry = Buffer.alloc(0);
        activeStreamIdentity = null;
        return;
      }

      const observedIdentity = await readStreamIdentity(size);
      if (offset > 0 && observedIdentity === null) {
        // Never advance an old offset while the replacement generation's first record is partial.
        return;
      }
      if (
        observedIdentity !== null &&
        activeStreamIdentity !== null &&
        observedIdentity !== activeStreamIdentity
      ) {
        offset = 0;
        carry = Buffer.alloc(0);
      } else if (size < offset) {
        // Slow truncate: size itself exposes the replacement before it regrows.
        offset = 0;
        carry = Buffer.alloc(0);
      }
      if (observedIdentity !== null) activeStreamIdentity = observedIdentity;
      if (size === offset || closed) return;

      // Snapshot the upper bound for this pump. Bytes appended while it runs belong to the next
      // pump, which keeps this invocation finite even when recognition is continuously writing.
      const targetOffset = size;
      const handle = await open(navigatorFile, 'r');
      try {
        while (offset < targetOffset && !closed) {
          const requested = Math.min(NAVIGATOR_READ_CHUNK_BYTES, targetOffset - offset);
          const buffer = Buffer.allocUnsafe(requested);
          const { bytesRead } = await handle.read(buffer, 0, requested, offset);
          if (bytesRead === 0) break; // file was truncated while open; the next stat repairs offset
          offset += bytesRead;
          if (!(await publishBytes(buffer.subarray(0, bytesRead)))) return;
        }
      } finally {
        await handle.close();
      }
    };

    // DEV-P1-15 — one pump at a time.
    //
    // The interval used to fire `void pump()` unconditionally. `pump` is async and mutates two
    // pieces of shared state, `offset` and `carry`, across an await. A pump that takes longer than
    // the 250 ms tick therefore overlaps its successor and can duplicate or splice events. A
    // skipped tick loses nothing; the next pump resumes from the same committed byte offset.
    let pumping = false;
    const pumpOnce = async (): Promise<void> => {
      if (pumping || closed) return;
      pumping = true;
      try {
        await pump();
      } catch {
        /* a read racing the recognition child's write; the next tick reads from the same offset */
      } finally {
        pumping = false;
      }
    };

    pumpTimer = setInterval(() => {
      void pumpOnce();
    }, 250);
    heartbeatTimer = setInterval(() => {
      // Do not add heartbeats behind an already backpressured data stream.
      if (!closed && !response.writableNeedDrain) response.write(': heartbeat\n\n');
    }, 15000);
    void pumpOnce(); // Replay asynchronously so an SSE client does not hold an operation lease.
  }

  /* ------------------------------ the server ------------------------------ */

  const pendingRequests = new Set<Promise<void>>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pending = dispatch(request, response).catch(() => {
      if (response.destroyed) return;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    pendingRequests.add(pending);
    void pending.finally(() => pendingRequests.delete(pending));
  });

  /**
   * Refuses a request that fails the exposure contract, and reports which clause refused it.
   *
   * Order is deliberate: Host before Origin, because a rebinding attack makes the Origin check
   * agree with the attacker. Auth last, because when a token is configured every route needs it
   * and the cheaper structural checks should have run first.
   *
   * Returns true when the request has been answered and the caller must stop.
   */
  function refuseIfDisallowed(request: IncomingMessage, response: ServerResponse): boolean {
    const deny = (reason: string): true => {
      // No detail beyond the clause name: a refusal message is read by whoever was refused.
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Refused: ${reason}\n`);
      return true;
    };

    const hostHeader = request.headers.host;
    if (!hostHeaderMatches(hostHeader, host, boundPort)) {
      return deny('Host header does not name this server');
    }

    const origin = request.headers.origin;
    if (!originAllowed(typeof origin === 'string' ? origin : undefined, host, boundPort)) {
      return deny('cross-origin request');
    }

    if (authToken !== undefined) {
      const header = request.headers.authorization;
      const presented =
        typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
          ? header.slice(7)
          : undefined;
      if (!tokenMatches(presented, authToken)) {
        response.writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'www-authenticate': 'Bearer',
        });
        response.end('Refused: authentication required\n');
        return true;
      }
    }

    return false;
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (refuseIfDisallowed(request, response)) return;

    const url = new URL(request.url ?? '/', `http://${httpHost(host)}:${boundPort}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const projectRoute = parts[0] === 'api' && parts[1] === 'projects';
    const activation = projectRoute && request.method === 'POST' && parts.length === 4 && parts[3] === 'activate';
    // The saved-profile editor can inspect the registry after changing a profile whose live
    // runtime now requires reopening. These reads never consume the active runtime.
    const registryRead = projectRoute && (
      (request.method === 'GET' && parts.length <= 3) ||
      (request.method === 'POST' && parts.length === 4 && parts[3] === 'validate')
    );
    let lease: ProjectRuntimeLease | undefined;
    if (runtimeManager !== undefined && parts[0] === 'api' && !activation && !registryRead) {
      try {
        lease = runtimeManager.lease(runtime.projectIdentity ?? undefined);
        if (lease.runtime !== runtime) {
          throw new ProjectProfilesApiError('DASHBOARD_RUNTIME_CHANGED', 'The dashboard runtime binding changed.', 409);
        }
      } catch (error) {
        lease?.release();
        if (runtimeManager.activeRuntime !== runtime) disconnectEventStreams();
        const code = error instanceof ProjectRuntimeManagerError || error instanceof ProjectProfilesApiError
          ? error.code : 'DASHBOARD_RUNTIME_UNAVAILABLE';
        response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ code, detail: 'The active Project Profile runtime is unavailable. Reopen the dashboard to bind the saved profile.' }));
        return;
      }
    }
    try {
      await handle(request, response, url);
    } finally {
      lease?.release();
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const pathname = url.pathname;

    if (await handleProjectProfilesApiRequest(request, response, projectProfilesApi, url)) return;
    if (await operatorAgent.handle(request, response, url)) return;

    if (request.method === 'GET' && pathname === '/api/frame') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(sink.current));
      return;
    }
    // Status is a fresh capture through the same composition as `clue status`. The
    // console-specific endpoints below instead serve the already-published frame revision.
    if (request.method === 'GET' && pathname === '/api/status/current') {
      const { snapshot: status } = projectStatusFromRuntime(runtime, {
        capturedAt: new Date().toISOString(),
      });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(status));
      return;
    }
    // §17 also requires the schema to be fetchable, so a consumer can validate independently
    // rather than trusting the shape it happens to receive.
    if (request.method === 'GET' && pathname === '/api/status/schema') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ schemaVersion: STATUS_SCHEMA_VERSION }));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/console/current') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(sink.current === null ? null : {
        revision: sink.current.revision,
        seal: sink.current.seal,
        snapshot: sink.current.snapshot,
      }));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/improvement-field') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(sink.current === null ? null : {
        revision: sink.current.revision,
        seal: sink.current.seal,
        improvementField: sink.current.snapshot.dashboard.improvementField,
      }));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/gauges') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(sink.current === null ? null : {
        revision: sink.current.revision,
        seal: sink.current.seal,
        gauges: sink.current.snapshot.dashboard.gauges,
      }));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/operational-console') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(sink.current === null ? null : {
        revision: sink.current.revision,
        seal: sink.current.seal,
        operationalConsole: sink.current.snapshot.dashboard.operationalConsole,
      }));
      return;
    }
    if (pathname === '/api/findings/current') {
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      if (request.method !== 'GET') {
        response.writeHead(405, { ...headers, allow: 'GET' });
        response.end(JSON.stringify({ code: 'FINDINGS_READ_ONLY' }));
        return;
      }
      if (url.search !== '') {
        response.writeHead(400, headers);
        response.end(JSON.stringify({ code: 'FINDINGS_SCOPE_FIXED' }));
        return;
      }
      if (!dashboardProfileCurrent()) {
        response.writeHead(409, headers);
        response.end(JSON.stringify({ code: 'DASHBOARD_RUNTIME_CHANGED' }));
        return;
      }
      let findings: string;
      try {
        findings = JSON.stringify(readCurrentFindings(runtime));
        if (Buffer.byteLength(findings) > 16 * 1024) throw new Error('Findings projection exceeds response limit.');
      } catch {
        response.writeHead(503, headers);
        response.end(JSON.stringify({ code: 'FINDINGS_UNAVAILABLE' }));
        return;
      }
      if (!dashboardProfileCurrent()) {
        response.writeHead(409, headers);
        response.end(JSON.stringify({ code: 'DASHBOARD_RUNTIME_CHANGED' }));
        return;
      }
      response.writeHead(200, headers);
      response.end(findings);
      return;
    }
    // P2 B6 / ADR-0015 — a read-only dashboard projection over durable benchmark and proof
    // events. The endpoint exposes recorded identities and dispositions only; the browser never
    // re-runs decide(), reads evidence artifacts, or manufactures a verdict from deltas.
    if (request.method === 'GET' && pathname === '/api/proof-board') {
      try {
        const board = readProofBoard(runtime, new Date().toISOString());
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(board));
      } catch (error) {
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({
          error: 'proof board projection unavailable',
          detail: (error as Error).message,
        }));
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/p2-closure') {
      try {
        const assessment = assessP2Closure(runtime, new Date().toISOString());
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(assessment));
      } catch (error) {
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({
          error: 'P2 closure assessment unavailable',
          detail: (error as Error).message,
        }));
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/console-events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.flushHeaders();
      eventStreams.add(response);
      if (sink.current !== null) response.write(`data: ${JSON.stringify(sink.current)}\n\n`);
      const unsubscribe = sink.subscribe((frame) => {
        if (!response.destroyed) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      });
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
      response.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        eventStreams.delete(response);
      });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/navigator-events') {
      streamNavigator(response);
      return;
    }
    if (request.method === 'GET' && pathname === '/api/catalogue') {
      const yamlPath = join(runtime.repoRoot, 'config', 'measurements', 'catalogue.yaml');
      try {
        const loaded = loadMeasurementCatalogue(readFileSync(yamlPath, 'utf8'));
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            contentHash: loaded.identity.contentHash,
            records: loaded.measures.map((measure) => ({
              id: measure.metricId,
              name: measure.name,
              family: measure.family,
              familyColor: measure.familyColor,
              grid: measure.grid,
              status: measure.status,
            })),
          }),
        );
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    // Server-hosted catalogue library (config/measurements/catalogues/*.json).
    if (request.method === 'GET' && pathname === '/api/catalogues') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ directory: relative(runtime.repoRoot, cataloguesDir()), catalogues: listCatalogues() }));
      return;
    }
    if (request.method === 'GET' && pathname.startsWith('/api/catalogues/')) {
      const file = safeCataloguePath(decodeURIComponent(pathname.slice('/api/catalogues/'.length)));
      if (file === null) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'invalid catalogue id' }));
        return;
      }
      if (!existsSync(file)) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'catalogue not found' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(readFileSync(file, 'utf8'));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/catalogues') {
      let raw: string;
      try {
        raw = await readRequestBody(request);
      } catch (error) {
        response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: (error as Error).message }));
        return;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: `body is not valid JSON: ${(error as Error).message}` }));
        return;
      }
      const envelope = payload && typeof payload === 'object' ? payload['catalogue'] : undefined;
      const doc = (envelope && typeof envelope === 'object' ? envelope : payload) as Record<string, unknown>;
      const metrics = doc['metrics'];
      if (!doc || typeof doc !== 'object' || !Array.isArray(metrics) || metrics.length === 0) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'catalogue must be a JSON object with a non-empty "metrics" array' }));
        return;
      }
      const nameValue = payload['name'];
      const providedName = typeof nameValue === 'string' ? nameValue : null;
      const catalogueIdValue = doc['catalogueId'];
      const requestedName = providedName ?? (typeof catalogueIdValue === 'string' ? catalogueIdValue : `catalogue-${Date.now()}`);
      const file = safeCataloguePath(requestedName);
      if (file === null) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'invalid catalogue name (letters, digits, dot, dash, underscore only)' }));
        return;
      }
      try {
        mkdirSync(cataloguesDir(), { recursive: true });
        writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: (error as Error).message }));
        return;
      }
      response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ stored: relative(runtime.repoRoot, file), catalogues: listCatalogues() }));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/control/readiness') {
      const receipts = isLoopbackHost(host) && dashboardProfileCurrent()
        ? readDashboardReadinessReceipts(runtime.workspaceRoot, dashboardReadinessScope(runtime)) : {};
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ receipts }));
      return;
    }
    if (request.method === 'POST' && (pathname === '/api/control/chrome-test' || pathname === '/api/control/console-test')) {
      const isChrome = pathname === '/api/control/chrome-test';
      const label = isChrome ? 'Test Chrome' : 'Test Console';
      const send = (status: number, body: DashboardReadiness): void => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(body));
      };
      if (!isLoopbackHost(host)) {
        send(403, { state: 'failed', summary: `${label} requires the local dashboard.`, checks: [] });
        return;
      }
      if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        send(415, { state: 'failed', summary: `${label} requires a JSON request.`, checks: [] });
        return;
      }
      let raw: string;
      try {
        raw = await readRequestBody(request, 512);
      } catch {
        send(413, { state: 'failed', summary: `The ${label} request exceeds its size limit.`, checks: [] });
        return;
      }
      let input: unknown;
      try { input = JSON.parse(raw); } catch { /* Invalid JSON is handled by the schema. */ }
      const payload = dashboardSessionTestRequestSchema.safeParse(input);
      if (!payload.success) {
        send(400, { state: 'failed', summary: `${label} requires one exact saved Project Profile.`, checks: [] });
        return;
      }
      const record = runtime.projectProfile;
      const expected = payload.data;
      if (stopping || record === null || !dashboardProfileCurrent() || record.profile.projectId !== expected.projectId ||
          record.generation !== expected.expectedGeneration || record.projectProfileHash !== expected.expectedProfileHash) {
        send(409, { state: 'pending', summary: `${label} requires the active saved profile. Restart the dashboard if its settings changed.`, checks: [] });
        return;
      }
      if (!isChrome) {
        if (record.profile.integrations.powershell.autonomousProfile === 'disabled') {
          send(409, { state: 'pending', summary: 'This Project Profile disables host shell operations.', checks: [] });
          return;
        }
        send(200, await consoleTest.run(record));
        return;
      }
      const chrome = record.profile.integrations.chrome;
      const target = DASHBOARD_WEBGPU_CANARY_URL;
      if (chrome.launchMode !== 'CLUE_MANAGED' || chrome.targetUrl === null ||
          new URL(chrome.targetUrl).href !== target || !chromeOriginAllowed(target, chrome.allowedOrigins)) {
        send(409, { state: 'pending', summary: 'Save CLUE_MANAGED with target http://127.0.0.1:5179/ and its allowed origin, then restart the dashboard.', checks: [] });
        return;
      }
      send(200, await chromeTest.run(record));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/control/readiness') {
      const send = (status: number, body: DashboardReadiness): void => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(body));
      };
      if (!isLoopbackHost(host)) {
        send(403, { state: 'pending', summary: 'Capability checks require the local CLU-E dashboard.', checks: [] });
        return;
      }
      if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        send(415, { state: 'failed', summary: 'A JSON readiness request is required.', checks: [] });
        return;
      }
      let raw: string;
      try {
        raw = await readRequestBody(request, 512);
      } catch {
        send(413, { state: 'failed', summary: 'The readiness request exceeds its size limit.', checks: [] });
        return;
      }
      let input: unknown;
      try { input = JSON.parse(raw); } catch { /* Invalid JSON is handled by the schema. */ }
      const payload = readinessRequestSchema.safeParse(input);
      if (!payload.success) {
        send(400, { state: 'failed', summary: 'Select one supported readiness capability.', checks: [] });
        return;
      }
      const { capability } = payload.data;
      if (activeReadinessChecks.has(capability)) {
        send(409, { state: 'pending', summary: 'This check is already running.', checks: [] });
        return;
      }
      if (capability === 'ai' && run.state === 'running') {
        send(409, { state: 'pending', summary: 'Wait for the active cycle before testing AI.', checks: [] });
        return;
      }
      const stale = { state: 'pending', summary: 'Project settings changed. Restart the dashboard before checking this configuration.', checks: [] } as const;
      if (!dashboardProfileCurrent()) {
        send(409, stale);
        return;
      }
      if (capability === 'chrome') {
        send(200, chromeTest.read(runtime.projectProfile));
        return;
      }
      if (capability === 'console') {
        send(200, consoleTest.read(runtime.projectProfile));
        return;
      }
      activeReadinessChecks.add(capability);
      try {
        const result = await checkDashboardReadiness(runtime, capability);
        if (dashboardProfileCurrent()) {
          rememberDashboardReadiness(runtime.workspaceRoot, dashboardReadinessScope(runtime), capability, result.state);
          send(200, result);
        } else send(409, stale);
      } catch {
        send(200, { state: 'failed', summary: 'The capability check could not complete. Review the active project configuration.', checks: [] });
      } finally {
        activeReadinessChecks.delete(capability);
      }
      return;
    }
    if (pathname === '/api/control/legacy-openai-key' || pathname === '/api/control/legacy-github-sign-in') {
      const send = (status: number, state: string, detail: string): void => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ state, detail }));
      };
      if (!isLoopbackHost(host) || runtime.projectProfile !== null) {
        send(403, 'unavailable', 'Use the configuration controls for the active Project Profile.');
        return;
      }
      const project = runtime.config.project;
      const name = runtime.config.gateway.api_key_env;
      if (request.method === 'GET' && pathname === '/api/control/legacy-openai-key') {
        if (typeof process.env[name] === 'string' && (process.env[name]?.trim().length ?? 0) >= 8) {
          send(200, 'environment', 'The current process has a configured key override.');
        } else if (hasWindowsOpenAiCredentialReference(legacyWindowsOpenAiCredentialReference(project.root, name))) {
          send(200, 'stored', 'The OpenAI key is saved in Windows Credential Manager for this target.');
        } else if (process.platform !== 'win32') {
          send(200, 'unsupported', 'Persistent key entry requires the interactive Windows dashboard.');
        } else {
          send(200, 'missing', 'Save the OpenAI key using the Windows key prompt.');
        }
        return;
      }
      if (request.method !== 'POST') {
        send(405, 'unavailable', 'This control requires an explicit operator request.');
        return;
      }
      if ((request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') ||
          request.headers['transfer-encoding'] !== undefined) {
        request.resume();
        send(400, 'failed', 'This control opens a host prompt and accepts no request body.');
        return;
      }
      if (pathname === '/api/control/legacy-github-sign-in') {
        const result = await launchGitHubProfileSignIn(project.root);
        send(200, result.state, result.state === 'SIGN_IN_STARTED'
          ? 'Complete GitHub sign-in in the Windows window. Reopen the dashboard for its live check.'
          : result.detail);
        return;
      }
      const result = await promptLegacyWindowsOpenAiCredential(project.root, name, project.id);
      const details = {
        stored: 'Key saved in Windows Credential Manager for this target. Reopen the dashboard for its live check.',
        cancelled: 'Key entry was cancelled.',
        unsupported: 'Key entry requires the interactive Windows dashboard.',
        failed: 'Windows could not save the key. Complete any existing key prompt and try again.',
      };
      send(200, result.state, details[result.state]);
      return;
    }
    if (request.method === 'GET' && pathname === '/api/config') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(configView()));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/run') {
      const snapshot = runSnapshot();
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(snapshot));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/control/start') {
      const result = activeReadinessChecks.has('ai')
        ? startRefused('AI_READINESS_BUSY', 'Wait for the active AI readiness check to finish before starting a cycle.')
        : startPipeline();
      response.writeHead(result.started ? 202 : 409, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(result));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/control/git-sync') {
      if (run.state === 'running' || activeReadinessChecks.has('ai')) {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({
          state: 'refused',
          code: run.state === 'running' ? 'PIPELINE_RUNNING' : 'AI_READINESS_BUSY',
          detail: 'Wait for the active cycle or AI readiness check before syncing Git.',
          governedGitLifecycle: false,
        }));
        return;
      }
      try {
        const result = runtime.projectIdentity === null || runtime.projectProfile === null
          ? manualGitSync(runtime.config.project)
          : manualProjectGitSync(
              projectProfilesRegistry.getProfile(runtime.projectProfile.profile.projectId),
              runtime.projectIdentity,
            );
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({
          state: 'refused',
          code: 'SYNC_INTERNAL_ERROR',
          detail: (error as Error).message,
          governedGitLifecycle: false,
        }));
      }
      return;
    }

    if (request.method === 'POST' && pathname === '/api/control/refresh') {
      try {
        const { revision } = service.refresh();
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ revision }));
      } catch (error) {
        response.writeHead(500).end((error as Error).message);
      }
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      if (serveStatic(pathname, response, request.method === 'HEAD')) return;
    }
    response.writeHead(request.method === 'GET' ? 404 : 405).end('Not found.');
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (address !== null && typeof address !== 'string') boundPort = address.port;
      resolveListen();
    });
  });

  const refreshTimer = setInterval(() => {
    try {
      if (runtimeManager === undefined) service.refresh();
      else runtimeManager.withLease(runtime.projectIdentity ?? undefined, (lease) => {
        if (lease.runtime === runtime) service.refresh();
        else disconnectEventStreams();
      });
    } catch {
      if (runtimeManager !== undefined && runtimeManager.activeRuntime !== runtime) disconnectEventStreams();
      /* transient read/write race while the cycle child writes; next tick recovers */
    }
  }, Math.max(250, refreshMs));

  return {
    url: `http://${httpHost(host)}:${boundPort}/`,
    stop: async (): Promise<void> => {
      stopping = true;
      operatorAgent.close();
      clearInterval(refreshTimer);
      disconnectEventStreams();
      const serverStopped = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      const activeChild = child;
      if (activeChild !== null) {
        await new Promise<void>((resolveChildClose) => {
          const escalation = setTimeout(() => activeChild.kill('SIGKILL'), childKillGraceMs);
          activeChild.once('close', () => {
            clearTimeout(escalation);
            resolveChildClose();
          });
          activeChild.kill('SIGTERM');
        });
      }
      await serverStopped;
      await Promise.all(pendingRequests);
    },
  };
}
