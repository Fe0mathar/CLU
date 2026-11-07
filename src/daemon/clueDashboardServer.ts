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
 * recognition pipeline, and the control plane here launches it as a CHILD PROCESS
 * (`clue snapshot` then `clue recognize --navigator`), so the single-writer lock is
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
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { extname, join, relative, resolve, sep } from 'node:path';

import { ConsoleStateService } from './consoleStateService.js';
import { parseConsoleSnapshot, type ConsoleSnapshot } from '../ui/viewModel.js';
import { loadMeasurementCatalogue } from '../analysis/measure/catalogue.js';
import type { Runtime } from '../control/runtime.js';
import { projectStatusFromRuntime } from '../status/statusFromRuntime.js';
import { STATUS_SCHEMA_VERSION } from '../status/statusContractV5.js';
import { describeTargetPublication } from '../shared/targetPublication.js';
import { readProofBoard } from './proofBoardProjection.js';
import { assessP2Closure } from '../closure/p2ClosureAssessment.js';
import { manualGitSync, manualProjectGitSync } from '../integration/git/manualGitSync.js';
import { readGatewayStatus, type GatewayStatus } from '../ai/gateway/modelGateway.js';
import {
  configuredProjectProfilesRoot,
  ProjectProfileRegistry,
} from '../control/projectProfiles/index.js';
import {
  handleProjectProfilesApiRequest,
  PROJECT_PROFILES_API_VERSION,
  ProjectProfilesApiService,
} from './projectProfilesApi.js';
import type { Actor, ProjectProfileRecord } from '../shared/schemas.js';


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
  return LOOPBACK_HOSTS.has(bare) || bare.startsWith('127.');
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
  const expected = new Set([`${host.toLowerCase()}:${String(port)}`]);
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
  const allowed = new Set([`http://${host}:${String(port)}`]);
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
  /** Atomic live switch seam. Omitted by legacy single-runtime dashboard startup. */
  readonly activateProjectProfile?: (record: ProjectProfileRecord, actor: Actor) => Promise<unknown> | unknown;
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
  phase: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  lastLine: string | null;
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
  runtime: Runtime,
  options: ClueDashboardOptions,
): Promise<ClueDashboardHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 47900;
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

  const sink = new FrameSink();
  const serviceOptions = {
    operator: options.operator,
    navigatorPath: join(runtime.workspaceRoot, 'graph', 'system-navigator.ndjson'),
    ...(options.missionTitle !== undefined ? { missionTitle: options.missionTitle } : {}),
  };
  const service = new ConsoleStateService(runtime, sink, serviceOptions);
  service.refresh();

  const profilesRoot = configuredProjectProfilesRoot(
    runtime.repoRoot,
    runtime.workspaceRoot,
    options.profilesRoot,
  );
  const projectProfilesRegistry = new ProjectProfileRegistry(profilesRoot);
  const projectProfilesApi = new ProjectProfilesApiService({
    registry: projectProfilesRegistry,
    runtime,
    actor: 'daemon',
    allowHostConnections: isLoopbackHost(host),
    ...(options.activateProjectProfile === undefined
      ? {}
      : { activateProject: options.activateProjectProfile }),
  });

  const refreshTimer = setInterval(() => {
    try {
      service.refresh();
    } catch {
      /* transient read/write race while the recognition child writes; next tick recovers */
    }
  }, Math.max(250, refreshMs));

  /* ---------------------------- control plane ---------------------------- */

  const run: RunState = {
    state: 'idle',
    phase: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastLine: null,
    receipts: [],
  };
  let child: ChildProcess | null = null;
  const cliEntry = join(runtime.repoRoot, 'dist', 'src', 'cli', 'index.js');

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
  function launchPhase(phase: 'snapshot' | 'recognize', onDone: (code: number) => void): void {
    run.phase = phase;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const args =
      phase === 'snapshot' ? [cliEntry, 'snapshot'] : [cliEntry, 'recognize', '--navigator'];
    const env = { ...process.env };
    const gatewayCredential = runtime.config.gateway.api_key_env.toUpperCase();
    for (const name of Object.keys(env)) {
      if (name.toUpperCase() === gatewayCredential || name.toUpperCase() === 'OPENAI_API_KEY') delete env[name];
    }
    const spawned = spawn(process.execPath, args, { cwd: runtime.repoRoot, env });
    child = spawned;

    let timedOut = false;
    let phaseLastLine: string | null = null;
    const consume = (chunk: Buffer): void => {
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) {
        phaseLastLine = text.split('\n').at(-1) ?? text;
        run.lastLine = phaseLastLine;
      }
    };
    spawned.stdout?.on('data', consume);
    spawned.stderr?.on('data', consume);

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
      if (timedOut) {
        run.state = 'timeout';
        run.exitCode = code;
        run.finishedAt = finishedAt;
        run.phase = null;
        run.lastLine =
          `${phase} exceeded its ${String(childTimeoutMs)} ms budget and was terminated`;
        return; // the pipeline does not continue past a phase that never finished
      }
      onDone(code ?? 1);
    });
  }

  function startPipeline(): { started: boolean; reason?: string } {
    // Provider billing authority is fail-closed. Finish any already durable write, but refuse
    // a new pipeline before spawning a child while the event-backed controlled pause is active.
    if (runtime.config.gateway.enabled) {
      try {
        const gateway = readGatewayStatus(runtime);
        const pauseReason = gatewayPipelineStartRefusal(gateway);
        if (pauseReason !== null) {
          return { started: false, reason: `provider-budget-paused: ${pauseReason}` };
        }
      } catch (error) {
        return {
          started: false,
          reason: `gateway-status-unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    // Only an in-flight run blocks a new one. `timeout` deliberately does not: the child was
    // terminated, so nothing is holding the writer lock, and refusing forever would reproduce
    // the wedge this budget exists to prevent.
    if (run.state === 'running') return { started: false, reason: 'a run is already in progress' };
    run.state = 'running';
    run.startedAt = new Date().toISOString();
    run.finishedAt = null;
    run.exitCode = null;
    run.lastLine = null;
    launchPhase('snapshot', (snapshotCode) => {
      if (snapshotCode !== 0) {
        run.state = 'failed';
        run.exitCode = snapshotCode;
        run.finishedAt = new Date().toISOString();
        run.phase = null;
        return;
      }
      launchPhase('recognize', (recognizeCode) => {
        run.state = recognizeCode === 0 ? 'completed' : 'failed';
        run.exitCode = recognizeCode;
        run.finishedAt = new Date().toISOString();
        run.phase = null;
        try {
          service.refresh();
        } catch {
          /* next tick */
        }
      });
    });
    return { started: true };
  }

  /* ------------------------- config readiness view ------------------------ */

  function configView(): unknown {
    const config = runtime.config;
    const projectRoot = config.project.root;
    const tracked = config.constitution.tracked_documents.map((path: string) => ({
      path,
      present: existsSync(join(runtime.repoRoot, path)),
    }));
    const pointerPath = join(runtime.workspaceRoot, 'graph', 'current.json');
    let pointer: unknown = null;
    try {
      pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
    } catch {
      pointer = null;
    }
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

  function readRequestBody(request: IncomingMessage): Promise<string> {
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
        if (size > MAX_CATALOGUE_BYTES) {
          rejectOnce(new Error('catalogue exceeds the 2 MB limit'));
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

  function serveStatic(pathname: string, response: ServerResponse): boolean {
    const mapped =
      pathname === '/' ? { prefix: '/ui/', rest: 'index.html' } : matchStatic(pathname);
    if (mapped === null) return false;
    const rootEntry = staticRoots.find((entry) => entry.prefix === mapped.prefix);
    if (rootEntry === undefined) return false;
    const target = resolve(rootEntry.root, mapped.rest);
    const traversal = relative(rootEntry.root, target);
    if (traversal.startsWith(`..${sep}`) || traversal === '..') {
      response.writeHead(403).end('Forbidden.');
      return true;
    }
    let fileStat;
    try {
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
    });
    createReadStream(target).pipe(response);
    return true;
  }

  function matchStatic(pathname: string): { prefix: string; rest: string } | null {
    for (const entry of staticRoots) {
      if (pathname.startsWith(entry.prefix)) {
        return { prefix: entry.prefix, rest: decodeURIComponent(pathname.slice(entry.prefix.length)) };
      }
    }
    return null;
  }

  /* ---------------------- navigator stream: replay+tail ------------------- */

  const navigatorFile = join(runtime.workspaceRoot, 'graph', 'system-navigator.ndjson');

  // Every long-lived response is owned by the handle. `stop()` closes both console and
  // Navigator SSE clients before closing the listener; otherwise an open Navigator response
  // keeps `server.close()` pending indefinitely.
  const eventStreams = new Set<ServerResponse>();

  async function streamNavigator(response: ServerResponse): Promise<void> {
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

    await pumpOnce(); // replay everything already recorded
    if (closed) return;
    pumpTimer = setInterval(() => {
      void pumpOnce();
    }, 250);
    heartbeatTimer = setInterval(() => {
      // Do not add heartbeats behind an already backpressured data stream.
      if (!closed && !response.writableNeedDrain) response.write(': heartbeat\n\n');
    }, 15000);
  }

  /* ------------------------------ the server ------------------------------ */

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
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
    if (!hostHeaderMatches(hostHeader, host, port)) {
      return deny('Host header does not name this server');
    }

    const origin = request.headers.origin;
    if (!originAllowed(typeof origin === 'string' ? origin : undefined, host, port)) {
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

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (refuseIfDisallowed(request, response)) return;

    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    const pathname = url.pathname;

    if (await handleProjectProfilesApiRequest(request, response, projectProfilesApi, url)) return;

    if (request.method === 'GET' && pathname === '/api/frame') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(sink.current));
      return;
    }
    // SC2 §17 — specialized status endpoints. Each returns a projection OF THE SAME sealed
    // frame revision (never an independent registry read), so the Dashboard, CLI, and these
    // APIs cannot disagree: one revision, one seal, several views.
    // DEV-P1-16: this route is the Status Contract's own §17 endpoint and it served the
    // console projection — a different schema under the contract's name. Any consumer that
    // read §17 and called it got a `ConsoleSnapshot`, and §20 gate 4 ("the UI, CLI and API
    // return the same body/hash") could not hold while the API's Status route did not serve
    // Status. It now projects the sealed Status body through the same composition `clue
    // status` uses, so the three surfaces describe one workspace identically.
    //
    // The console projection did not lose its endpoint: it moved to `/api/console/current`,
    // which names what it actually is.
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
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
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
      await streamNavigator(response);
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
    if (request.method === 'GET' && pathname === '/api/config') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(configView()));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/run') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(run));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/control/start') {
      const result = startPipeline();
      response.writeHead(result.started ? 202 : 409, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify(result));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/control/git-sync') {
      if (run.state === 'running') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({
          state: 'refused',
          code: 'PIPELINE_RUNNING',
          detail: 'Git sync is manual and cannot overlap the CLU-E pipeline.',
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
      if (serveStatic(pathname, response)) return;
    }
    response.writeHead(request.method === 'GET' ? 404 : 405).end('Not found.');
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });

  return {
    url: `http://${host}:${port}/`,
    stop: async (): Promise<void> => {
      clearInterval(refreshTimer);
      for (const stream of eventStreams) stream.end();
      eventStreams.clear();
      if (child !== null) child.kill('SIGTERM');
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
