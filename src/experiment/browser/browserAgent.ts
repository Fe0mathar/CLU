/**
 * CLUE browser agent.
 *
 * Spec: CLUE_implementation.md §16 (run leases), §96 (dedicated profile, localhost
 *       debugging, allowed origins).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.3, Part IX §36-40, Part X (test is
 *           not production), Deviation D3.
 *
 * Attaches to a Chromium instance over the DevTools Protocol and listens.
 *
 * **No dependency.** CDP is JSON-RPC over a WebSocket whose address comes from one HTTP
 * call, and Node 22 provides both `fetch` and `WebSocket` as globals. Writing the client
 * directly costs about two hundred lines and removes a package from the budget, keeps
 * the protocol's semantics visible instead of behind a wrapper, and means an unexpected
 * CDP behaviour shows up here rather than inside somebody else's abstraction. Deviation
 * D3 chose raw CDP over a browser driver; this is the same argument one step further.
 *
 * **Attach, never launch.** Starting a browser is process execution, and process
 * execution belongs behind the restricted PowerShell host with a capability token.
 * Spawning Chrome from the analysis plane because it would be convenient is precisely
 * the erosion risk R10 names. The dedicated profile is started by
 * `scripts/launch-test-browser.ps1`; this agent connects to what is already running and
 * refuses anything outside the configured origins.
 *
 * **Passive on the page.** The agent subscribes to what the page emits. It does not
 * install a console wrapper, and it does not evaluate anything the caller has not asked
 * for. Console capture through CDP rather than through a page hook also means an
 * application-level wrapper cannot hide entries from it, which is the point.
 *
 * Everything here is asynchronous, unlike the rest of CLUE. That is inherent to the
 * protocol rather than a choice, and this module is the boundary: callers receive
 * plain records and hand them to a synchronous ledger.
 *
 * Backlog: DEV-P1-24 — "origin/content-type/size/redirect/timeout policy for all
 * target/script/map fetches; bind browser/profile/navigation identity." Two halves, closed
 * separately. The fetch policy lives on {@link BrowserAgent.fetchRelative}. The identity half
 * is {@link BrowserSessionIdentity}: exchanges recorded from here named the CDP method and
 * nothing about who was driving, which profile, or what document was loaded, so two agents on
 * two profiles were indistinguishable in one append-only record.
 *
 * Boundary, and it is deliberate: identity binds onto the **operational console exchanges**
 * this module opens, not onto `RawConsoleEntry`. The Console Ledger is a separate contract
 * with its own provenance and invalidation rules (`DEV-P1-21`), and merging the two into one
 * event protocol is exactly what `navigatorEvents.ts` warns against in its own header.
 */

import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertProjectOperationIdentity,
  canonicalProjectOperationIdentity,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';

import { extractInlineSourceMap } from '../console/attribution.js';
import type { ConsoleLevel, RawConsoleEntry, StackFrame } from '../console/consoleLedger.js';
import {
  type OperationalConsoleExchange,
  OperationalConsoleRecorder,
} from '../../observability/operationalConsole/recorder.js';

/**
 * What a source map may announce itself as (`DEV-P1-24`).
 *
 * `application/json` is correct; `text/plain` and `application/octet-stream` are what static
 * servers commonly send for a `.map` file and refusing them would break ordinary setups. HTML is
 * the one that matters: it is what a login page, an error page, or a captive portal returns, and
 * none of those is a source map.
 */
const SOURCE_MAP_CONTENT_TYPES = [
  'application/json',
  'text/plain',
  'application/octet-stream',
  'application/x-json',
] as const;

/** Ceiling on a fetched source map. Large real maps exist; unbounded ones are not maps. */
const MAX_SOURCE_MAP_BYTES = 32 * 1024 * 1024;
const MAX_DEVTOOLS_TARGET_BYTES = 4 * 1024 * 1024;
const DEVTOOLS_RETRY_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);

function networkErrorCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)) return error.code;
  return null;
}

function readDevToolsTargetList(endpoint: URL, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Use one dedicated socket rather than the process-wide fetch pool or a proxy.
    const request = httpGet(endpoint, {
      agent: false, signal, headers: { Accept: 'application/json' },
    }, (response) => {
      const endpointLabel = `DevTools /json/list at ${endpoint.host}`;
      response.on('error', reject);
      if (response.statusCode !== 200) {
        reject(new BrowserAgentError('ENDPOINT_UNREACHABLE', `${endpointLabel} returned HTTP ${String(response.statusCode)}.`));
        response.destroy();
        return;
      }
      let length = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_DEVTOOLS_TARGET_BYTES) {
          reject(new BrowserAgentError('ENDPOINT_UNREACHABLE', `${endpointLabel} exceeded the response limit.`));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown);
        } catch {
          reject(new BrowserAgentError('ENDPOINT_UNREACHABLE', `${endpointLabel} returned invalid JSON.`));
        }
      });
    });
    request.on('error', reject);
  });
}

/* ------------------------------------------------------------------------- */
/* Platform surface                                                           */
/* ------------------------------------------------------------------------- */

interface MessageEventLike {
  readonly data: unknown;
}

interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
}

type SocketConstructor = new (url: string) => SocketLike;

/**
 * Feature-detects the platform WebSocket.
 *
 * One narrow cast, at the one place the platform is touched. Reported rather than
 * assumed, because a missing global here produces a failure that would otherwise look
 * like the browser being unreachable.
 */
function resolveSocketConstructor(): SocketConstructor {
  const candidate = (globalThis as { WebSocket?: SocketConstructor }).WebSocket;
  if (candidate === undefined) {
    throw new BrowserAgentError(
      'NO_WEBSOCKET',
      'This Node build provides no global WebSocket. Node 22.11 or later is required.',
    );
  }
  return candidate;
}

/* ------------------------------------------------------------------------- */
/* Errors                                                                     */
/* ------------------------------------------------------------------------- */

export type BrowserAgentErrorCode =
  | 'NO_WEBSOCKET'
  | 'ENDPOINT_UNREACHABLE'
  | 'NO_TARGET'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_DISCONNECTED'
  | 'ORIGIN_REFUSED'
  | 'PROJECT_IDENTITY_MISMATCH'
  | 'SESSION_NOT_ACTIVE'
  | 'NOT_CONNECTED'
  | 'PROTOCOL_ERROR'
  | 'TIMEOUT';

export class BrowserAgentError extends Error {
  public readonly code: BrowserAgentErrorCode;

  public constructor(code: BrowserAgentErrorCode, message: string) {
    super(message);
    this.name = 'BrowserAgentError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

export interface TargetInfo {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface AttachOptions {
  /** Remote debugging port of the dedicated profile. */
  readonly port: number;
  /** Origin globs the target URL must match. A target outside them is refused. */
  readonly allowedOrigins: readonly string[];
  /** Explicitly binds attach to one already-resolved target. */
  readonly expectedTargetId?: string;
  /** Optional operator selector. Without this or expectedTargetId, multiple matches are refused. */
  readonly selectTarget?: (targets: readonly TargetInfo[]) => TargetInfo | null;
  /** Exact active Project Profile identity owning this browser session. */
  readonly projectIdentity?: ProjectOperationIdentity;
  /** Exact durable Project Profile generation owning this browser session. */
  readonly profileGeneration?: number;
  /** Deterministic managed/attached Chrome instance identity from browser readiness. */
  readonly chromeInstanceId?: string;
  readonly host?: string;
  readonly requestTimeoutMs?: number;
  /** Optional source-faithful mirror of every exact CDP request and response. */
  readonly operationalConsole?: OperationalConsoleRecorder;
}

export interface GovernedBrowserExecution {
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly browserSessionId: string;
  readonly targetPageId: string;
  /** Require the live main-frame document at this exact URL. */
  readonly targetUrl?: string;
}

const browserKeys = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
} as const;

export type GovernedBrowserControl =
  | { readonly type: 'reload' }
  | { readonly type: 'move' | 'click'; readonly x: number; readonly y: number }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'key'; readonly key: keyof typeof browserKeys }
  | { readonly type: 'screenshot' };

export interface BrowserScreenshot {
  readonly data: string;
  readonly mimeType: 'image/jpeg';
}

export interface EnvironmentFingerprint {
  readonly browser: string;
  readonly protocolVersion: string;
  readonly userAgent: string;
  readonly targetUrl: string;
  readonly viewport: { width: number; height: number; devicePixelRatio: number } | null;
  readonly hardwareConcurrency: number | null;
  readonly deviceMemory: number | null;
  /** Whether the page can obtain a WebGPU adapter at all. */
  readonly webgpuAdapter: { vendor: string; architecture: string } | null;
  readonly capturedAt: string;
}

export type ConsoleListener = (entry: RawConsoleEntry) => void;

/* ------------------------------------------------------------------------- */
/* Session identity — DEV-P1-24                                               */
/* ------------------------------------------------------------------------- */

/**
 * Who was driving, which profile, and what the page had loaded — `DEV-P1-24`.
 *
 * Before this, a CDP exchange recorded the method and the bytes and nothing about the
 * agent that produced it. `userAgent` was captured once inside {@link EnvironmentFingerprint}
 * and never reached the operational console, so two concurrent agents on two profiles wrote
 * indistinguishable events into one append-only record, and a console entry could not be tied
 * to the document load it came from.
 *
 * **Profile identity is the endpoint, and that is a statement about what is knowable rather
 * than a shortcut.** This agent attaches and never launches, so the profile directory belongs
 * to whoever ran `scripts/launch-test-browser.ps1`. `Browser.getBrowserCommandLine` would carry
 * `--user-data-dir`, but it is a browser-target method and this is a page session, so calling
 * it here returns an error rather than a path. What is true and checkable is that the profile
 * is the thing listening on this host and port, and that is what gets recorded. A `profilePath`
 * field would have been a field we could not fill.
 */
export interface BrowserSessionIdentity {
  /** Active Project Profile identity, null only for legacy callers. */
  readonly projectIdentity: ProjectOperationIdentity | null;
  /** Exact durable Project Profile generation, null only for legacy callers. */
  readonly profileGeneration: number | null;
  /** Governed browser instance identity, null only for legacy callers. */
  readonly chromeInstanceId: string | null;
  /** One attachment. Distinguishes two agents driving the same page. */
  readonly sessionId: string;
  /** The DevTools endpoint of the dedicated profile: `host:port`. */
  readonly endpoint: string;
  /** CDP target id of the attached page. */
  readonly targetId: string;
  /** The page URL at attach time. `frameUrl` is the current one. */
  readonly targetUrl: string;
  /** `Browser.getVersion`. Null until the bootstrap call returns, and if it fails. */
  readonly product: string | null;
  readonly revision: string | null;
  readonly protocolVersion: string | null;
  readonly jsVersion: string | null;
  /** Main-frame navigation, from `Page.getFrameTree` then `Page.frameNavigated`. */
  readonly frameId: string | null;
  readonly loaderId: string | null;
  readonly frameUrl: string | null;
}

/**
 * Projects the identity into the durable source identities of one exchange.
 *
 * These ride in `sourceIds`, which the Operational Console contract already carries and
 * Directory §19.1 already describes as the source identities of an exchange. Binding them
 * there rather than adding fields to the event schema is deliberate: a new wire field is a
 * `STATUS_SCHEMA_VERSION` bump and ADR-0001's territory, and this obligation does not need
 * one. Every value here is read from the protocol, never derived or assumed, and an unknown
 * value is omitted rather than written as `unknown`.
 */
function identitySourceIds(
  identity: BrowserSessionIdentity | null,
  method: string,
): readonly string[] {
  const ids = [`cdp-method:${method}`];
  if (identity === null) return ids;
  if (identity.projectIdentity !== null) {
    ids.push(`project-id:${identity.projectIdentity.projectId}`);
    ids.push(`target-root-identity:${identity.projectIdentity.targetRootIdentity}`);
    ids.push(`project-profile-hash:${identity.projectIdentity.projectProfileHash}`);
  }
  if (identity.profileGeneration !== null) {
    ids.push(`project-profile-generation:${String(identity.profileGeneration)}`);
  }
  if (identity.chromeInstanceId !== null) ids.push(`chrome-instance:${identity.chromeInstanceId}`);
  ids.push(`browser-session:${identity.sessionId}`);
  ids.push(`browser-endpoint:${identity.endpoint}`);
  ids.push(`browser-target:${identity.targetId}`);
  if (identity.product !== null) ids.push(`browser-product:${identity.product}`);
  if (identity.revision !== null) ids.push(`browser-revision:${identity.revision}`);
  if (identity.frameId !== null) ids.push(`page-frame:${identity.frameId}`);
  if (identity.loaderId !== null) ids.push(`page-loader:${identity.loaderId}`);
  return ids;
}

/* ------------------------------------------------------------------------- */
/* Connection                                                                 */
/* ------------------------------------------------------------------------- */

interface PendingCall {
  readonly exchange: OperationalConsoleExchange | null;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * A CDP session over one WebSocket.
 *
 * Requests carry an integer id and are matched to responses; everything without an id is
 * an event. Pending calls hold a timeout so a protocol stall surfaces as a timeout on
 * the call that caused it rather than as a process that never finishes.
 */
class CdpConnection {
  private readonly socket: SocketLike;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private readonly timeoutMs: number;
  private readonly operationalConsole: OperationalConsoleRecorder | undefined;
  private identityProvider: (() => BrowserSessionIdentity | null) | null = null;
  private nextId = 1;
  private closed = false;

  private constructor(
    socket: SocketLike,
    timeoutMs: number,
    operationalConsole?: OperationalConsoleRecorder,
  ) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.operationalConsole = operationalConsole;

    socket.addEventListener('message', (event) => {
      this.receive(event.data);
    });
    socket.addEventListener('close', () => {
      this.failAll(new BrowserAgentError('NOT_CONNECTED', 'The debugging socket closed'));
    });
    socket.addEventListener('error', () => {
      this.failAll(new BrowserAgentError('PROTOCOL_ERROR', 'The debugging socket errored'));
    });
  }

  public static async open(
    url: string,
    timeoutMs: number,
    operationalConsole?: OperationalConsoleRecorder,
  ): Promise<CdpConnection> {
    const Socket = resolveSocketConstructor();
    const socket = new Socket(url);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BrowserAgentError('TIMEOUT', `Timed out opening ${url}`));
      }, timeoutMs);

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new BrowserAgentError('ENDPOINT_UNREACHABLE', `Could not open ${url}`));
      });
    });

    return new CdpConnection(socket, timeoutMs, operationalConsole);
  }

  /**
   * Supplies the session identity every exchange is recorded under — `DEV-P1-24`.
   *
   * A provider rather than a value, because navigation identity changes underneath a live
   * connection: `Page.frameNavigated` replaces the loader while the socket stays open. A
   * snapshot bound once would have recorded the first document's loader on every later
   * exchange, which is worse than recording none — it would be wrong rather than absent.
   */
  public bindIdentity(provider: () => BrowserSessionIdentity | null): void {
    this.identityProvider = provider;
  }

  public send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new BrowserAgentError('NOT_CONNECTED', 'The agent is closed'));
    }

    const id = this.nextId;
    this.nextId += 1;
    const exactRequest = JSON.stringify({ id, method, params });
    const identity = this.identityProvider?.() ?? null;
    const exchange = this.operationalConsole?.beginExchange({
      channel: 'CHROME_CDP',
      kind: 'request',
      title: `CDP request · ${method}`,
      what: `Transmit the exact Chrome DevTools Protocol request ${method}.`,
      why: 'Browser control and benchmark orchestration must remain visible and auditable.',
      status: 'TRANSMITTING TO CHROME / CDP',
      nextAction: 'Await the correlated CDP response.',
      exactPayload: exactRequest,
      payloadFormat: 'json',
      cinematicCue: method === 'Runtime.evaluate' ? 'benchmark_start' : 'transmit',
      physicalCallId: `CDP-${String(id)}`,
      logicalSessionId: identity?.sessionId ?? null,
      sourceIds: identitySourceIds(identity, method),
    }) ?? null;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new BrowserAgentError(
          'TIMEOUT',
          `${method} did not respond within ${this.timeoutMs} ms`,
        );
        exchange?.fail(error);
        reject(error);
      }, this.timeoutMs);

      this.pending.set(id, { exchange, resolve, reject, timer });
      try {
        this.socket.send(exactRequest);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        exchange?.fail(error);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public on(event: string, handler: (params: Record<string, unknown>) => void): void {
    const existing = this.listeners.get(event);
    if (existing === undefined) this.listeners.set(event, new Set([handler]));
    else existing.add(handler);
  }

  public close(): void {
    this.closed = true;
    this.failAll(new BrowserAgentError('NOT_CONNECTED', 'The agent was closed'));
    try {
      this.socket.close();
    } catch {
      // Already gone; nothing further to do.
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;

    let message: unknown;
    try {
      message = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;

    const record = message as Record<string, unknown>;
    const id = record['id'];

    if (typeof id === 'number') {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.exchange?.receive({
        title: `CDP response · ${String(id)}`,
        what: 'Receive the exact correlated Chrome DevTools Protocol response.',
        why: 'A request being sent is not evidence that Chrome executed it successfully.',
        status: record['error'] === undefined ? 'CDP RESPONSE RECEIVED' : 'CDP REPORTED FAILURE',
        nextAction: 'Validate the returned protocol result before using it as evidence.',
        exactPayload: data,
        payloadFormat: 'json',
        validationState: 'received',
        cinematicCue: record['error'] === undefined ? 'receive' : 'error_fracture',
        physicalCallId: `CDP-${String(id)}`,
      });

      const error = record['error'];
      if (typeof error === 'object' && error !== null) {
        const detail = (error as Record<string, unknown>)['message'];
        const protocolError = new BrowserAgentError(
          'PROTOCOL_ERROR',
          typeof detail === 'string' ? detail : 'CDP error',
        );
        pending.exchange?.summarize({
          title: 'CDP operation rejected',
          what: 'Chrome returned a protocol-level error.',
          why: 'A failed CDP operation cannot become benchmark or runtime evidence.',
          status: 'CDP OPERATION FAILED',
          nextAction: 'Inspect the exact redacted response and target context.',
          validationState: 'evidence_rejected',
          cinematicCue: 'error_fracture',
        });
        pending.reject(protocolError);
        return;
      }

      const result = record['result'];
      pending.exchange?.summarize({
        title: 'CDP response validated',
        what: 'The correlated Chrome response was structurally accepted.',
        why: 'Only validated browser responses may enter CLU-E runtime state or evidence.',
        status: 'CDP RESPONSE VALIDATED',
        nextAction: 'Continue with the operation-specific interpretation or proof step.',
        validationState: 'schema_validated',
        cinematicCue: 'checkpoint',
      });
      pending.resolve(
        typeof result === 'object' && result !== null
          ? (result as Record<string, unknown>)
          : {},
      );
      return;
    }

    const method = record['method'];
    if (typeof method !== 'string') return;
    const params = record['params'];
    const payload = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};

    for (const handler of this.listeners.get(method) ?? []) {
      // A listener that throws must not take the socket down with it, or one bad
      // console entry would end the session and lose everything captured so far.
      try {
        handler(payload);
      } catch {
        // Swallowed deliberately; the ledger records what it received.
      }
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.exchange?.fail(error);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/* ------------------------------------------------------------------------- */
/* Agent                                                                      */
/* ------------------------------------------------------------------------- */

interface ScriptRecord {
  readonly scriptId: string;
  readonly url: string;
  readonly sourceMapUrl: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SCREENSHOT_BASE64_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_COORDINATE = 16_384;
const MAX_WHEEL_DELTA = 10_000;
const MAX_INSERTED_TEXT_BYTES = 4_096;

interface FrameIdentity {
  readonly frameId: string;
  readonly loaderId: string;
  readonly frameUrl: string;
}

function frameIdentityOf(value: unknown): FrameIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  const frameId = readString(frame, 'id');
  const loaderId = readString(frame, 'loaderId');
  const url = readString(frame, 'url');
  if (!frameId || !loaderId || !url) return null;
  const fragment = readString(frame, 'urlFragment');
  return { frameId, loaderId, frameUrl: url.includes('#') ? url : url + (fragment ?? '') };
}

function allowedPageUrl(value: string, allowedOrigins: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserAgentError('ORIGIN_REFUSED', 'The governed page does not have a valid URL.');
  }
  if (url.username || url.password || !originAllowed(url.href, allowedOrigins)) {
    throw new BrowserAgentError('ORIGIN_REFUSED', 'The governed page is outside the allowed HTTP(S) origins.');
  }
  return url.href;
}

function finiteInRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

export class BrowserAgent {
  private readonly connection: CdpConnection;
  private readonly listeners = new Set<ConsoleListener>();
  private readonly scripts = new Map<string, ScriptRecord>();
  private readonly sourceMaps = new Map<string, string | null>();
  private readonly defaultContexts = new Map<string, { id: number; uniqueId: string }>();
  public readonly target: TargetInfo;

  /**
   * The origins this agent may fetch from — `DEV-P1-24`.
   *
   * Retained rather than used once at attach time. `attach` checks the *page's* origin and then
   * discarded the list, but the agent goes on to fetch other URLs afterwards, and those had no
   * policy at all. See {@link BrowserAgent.fetchRelative}.
   */
  private readonly allowedOrigins: readonly string[];

  /** One timeout policy covers discovery, CDP calls and later source-map requests. */
  private readonly requestTimeoutMs: number;

  /**
   * The identity every recorded exchange is bound to — `DEV-P1-24`.
   *
   * Three parts arriving at three different moments, which is why this is mutable state and
   * not a constructor argument. Endpoint, target and session are known at attach. Browser
   * product and revision arrive when the bootstrap `Browser.getVersion` returns. Frame and
   * loader arrive from `Page.getFrameTree` and are replaced on every main-frame navigation.
   * Each field is null until the protocol has actually said it.
   */
  private readonly sessionId = `BROWSER-${randomUUID()}`;
  private readonly endpoint: string;
  private readonly projectIdentity: ProjectOperationIdentity | null;
  private readonly profileGeneration: number | null;
  private readonly chromeInstanceId: string | null;
  private parked = false;
  private closed = false;
  private browser: {
    product: string | null;
    revision: string | null;
    protocolVersion: string | null;
    jsVersion: string | null;
  } = { product: null, revision: null, protocolVersion: null, jsVersion: null };
  private navigation: {
    frameId: string | null;
    loaderId: string | null;
    frameUrl: string | null;
  } = { frameId: null, loaderId: null, frameUrl: null };

  private constructor(
    connection: CdpConnection,
    target: TargetInfo,
    allowedOrigins: readonly string[],
    endpoint: string,
    requestTimeoutMs: number,
    projectIdentity: ProjectOperationIdentity | null,
    profileGeneration: number | null,
    chromeInstanceId: string | null,
  ) {
    this.connection = connection;
    this.target = target;
    this.allowedOrigins = allowedOrigins;
    this.endpoint = endpoint;
    this.requestTimeoutMs = requestTimeoutMs;
    this.projectIdentity = projectIdentity;
    this.profileGeneration = profileGeneration;
    this.chromeInstanceId = chromeInstanceId;
    this.connection.bindIdentity(() => this.identity());
  }

  /** The current session identity. Read by the connection on every exchange it opens. */
  public identity(): BrowserSessionIdentity {
    return {
      projectIdentity: this.projectIdentity,
      profileGeneration: this.profileGeneration,
      chromeInstanceId: this.chromeInstanceId,
      sessionId: this.sessionId,
      endpoint: this.endpoint,
      targetId: this.target.id,
      targetUrl: this.target.url,
      product: this.browser.product,
      revision: this.browser.revision,
      protocolVersion: this.browser.protocolVersion,
      jsVersion: this.browser.jsVersion,
      frameId: this.navigation.frameId,
      loaderId: this.navigation.loaderId,
      frameUrl: this.navigation.frameUrl,
    };
  }

  /**
   * Attaches to a running Chromium.
   *
   * Refuses any target whose URL falls outside the configured origins. The browser is
   * meant to be pointed at the shadow clone's dev server; attaching to whatever page
   * happened to be open would measure something other than what CLUE is about to reason
   * over, and would do it silently.
   */
  public static async attach(options: AttachOptions): Promise<BrowserAgent> {
    const governedIdentityFields = [
      options.projectIdentity !== undefined,
      options.profileGeneration !== undefined,
      options.chromeInstanceId !== undefined,
    ];
    const governedIdentityFieldCount = governedIdentityFields.filter(Boolean).length;
    if (governedIdentityFieldCount !== 0 && governedIdentityFieldCount !== governedIdentityFields.length) {
      throw new BrowserAgentError(
        'PROJECT_IDENTITY_MISMATCH',
        'projectIdentity, profileGeneration, and chromeInstanceId must be supplied together.',
      );
    }
    if (options.profileGeneration !== undefined &&
        (!Number.isSafeInteger(options.profileGeneration) || options.profileGeneration <= 0)) {
      throw new BrowserAgentError(
        'PROJECT_IDENTITY_MISMATCH',
        'profileGeneration must be a positive safe integer.',
      );
    }
    if (options.chromeInstanceId !== undefined && options.chromeInstanceId.trim().length === 0) {
      throw new BrowserAgentError(
        'PROJECT_IDENTITY_MISMATCH',
        'chromeInstanceId must not be empty.',
      );
    }
    const projectIdentity = options.projectIdentity === undefined
      ? null
      : canonicalProjectOperationIdentity(options.projectIdentity);

    const host = options.host ?? '127.0.0.1';
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (governedIdentityFieldCount > 0 &&
        (!['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
         !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535)) {
      throw new BrowserAgentError('ORIGIN_REFUSED', 'A governed debugger must use an exact loopback host and valid port.');
    }
    const targets = await BrowserAgent.listTargets(host, options.port, timeoutMs);

    const pages = targets.filter(
      (target) => target.type === 'page' && target.webSocketDebuggerUrl.length > 0,
    );
    if (pages.length === 0) {
      throw new BrowserAgentError(
        'NO_TARGET',
        `No debuggable page on ${host}:${options.port}. Start the dedicated profile first.`,
      );
    }

    const allowed = pages.filter((target) => originAllowed(target.url, options.allowedOrigins));
    if (allowed.length === 0) {
      throw new BrowserAgentError(
        'ORIGIN_REFUSED',
        `No open page matches the allowed origins (${options.allowedOrigins.join(', ')}). ` +
          `Open pages: ${pages.map((target) => target.url).join(', ')}`,
      );
    }

    let chosen: TargetInfo | null = null;
    if (options.expectedTargetId !== undefined) {
      chosen = allowed.find((target) => target.id === options.expectedTargetId) ?? null;
      if (chosen === null) {
        const stillPresent = pages.some((target) => target.id === options.expectedTargetId);
        throw new BrowserAgentError(
          stillPresent ? 'ORIGIN_REFUSED' : 'TARGET_DISCONNECTED',
          stillPresent
            ? `The selected target ${options.expectedTargetId} is outside the allowed origins.`
            : `The selected target ${options.expectedTargetId} is no longer present.`,
        );
      }
    } else if (options.selectTarget !== undefined) {
      chosen = options.selectTarget(allowed);
    } else if (allowed.length === 1) {
      chosen = allowed[0] ?? null;
    } else {
      throw new BrowserAgentError(
        'TARGET_AMBIGUOUS',
        `${allowed.length} eligible browser targets match the allowed origins; an exact target must be selected.`,
      );
    }
    if (
      chosen === null ||
      !allowed.some((target) => target.id === chosen?.id) ||
      !originAllowed(chosen.url, options.allowedOrigins)
    ) {
      throw new BrowserAgentError('ORIGIN_REFUSED', 'The selected target is outside the allowed origins');
    }

    if (governedIdentityFieldCount > 0) {
      const discovered = allowed.find((target) => target.id === chosen?.id);
      if (discovered === undefined || discovered.url !== chosen.url ||
          discovered.webSocketDebuggerUrl !== chosen.webSocketDebuggerUrl ||
          !/^[a-z0-9_-]{1,128}$/iu.test(chosen.id) ||
          chosen.webSocketDebuggerUrl !== new URL(`ws://${host}:${String(options.port)}/devtools/page/${chosen.id}`).href) {
        throw new BrowserAgentError('ORIGIN_REFUSED', 'The debugger socket does not match the governed loopback page endpoint.');
      }
      allowedPageUrl(chosen.url, options.allowedOrigins);
    }

    const connection = await CdpConnection.open(
      chosen.webSocketDebuggerUrl,
      timeoutMs,
      options.operationalConsole,
    );
    const agent = new BrowserAgent(
      connection,
      chosen,
      options.allowedOrigins,
      `${host}:${String(options.port)}`,
      timeoutMs,
      projectIdentity,
      options.profileGeneration ?? null,
      options.chromeInstanceId ?? null,
    );
    try {
      await agent.enableDomains();
      return agent;
    } catch (error) {
      agent.close();
      throw error;
    }
  }

  /** Enumerates targets without attaching. Useful for `clue doctor`. */
  public static async listTargets(
    host: string,
    port: number,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<TargetInfo[]> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new BrowserAgentError('ENDPOINT_UNREACHABLE', 'The DevTools host or port is invalid.');
    }
    const endpoint = URL.parse(`http://${host}:${port}/json/list`);
    if (!endpoint || endpoint.username || endpoint.password || endpoint.pathname !== '/json/list' ||
        endpoint.search || endpoint.hash || Number(endpoint.port || 80) !== port) {
      throw new BrowserAgentError('ENDPOINT_UNREACHABLE', 'The DevTools host or port is invalid.');
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let raw: unknown;
    try {
      try {
        raw = await readDevToolsTargetList(endpoint, signal);
      } catch (error) {
        if (signal.aborted || !DEVTOOLS_RETRY_CODES.has(networkErrorCode(error) ?? '')) throw error;
        await delay(150, undefined, { signal });
        raw = await readDevToolsTargetList(endpoint, signal);
      }
    } catch (error) {
      if (error instanceof BrowserAgentError) throw error;
      const detail = signal.aborted ? `timed out after ${timeoutMs} ms` : `failed (${networkErrorCode(error) ?? 'unknown socket error'})`;
      throw new BrowserAgentError(
        'ENDPOINT_UNREACHABLE',
        `DevTools /json/list at ${host}:${port} ${detail}.`,
      );
    }
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => ({
        id: readString(entry, 'id') ?? '',
        type: readString(entry, 'type') ?? '',
        title: readString(entry, 'title') ?? '',
        url: readString(entry, 'url') ?? '',
        webSocketDebuggerUrl: readString(entry, 'webSocketDebuggerUrl') ?? '',
      }));
  }

  /* ------------------------------ listening --------------------------- */

  public onConsole(listener: ConsoleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribes to everything the page can say.
   *
   * Three separate CDP surfaces, because they carry different things. `consoleAPICalled`
   * is application `console.*` output; `Log.entryAdded` is the browser's own reporting —
   * network failures, deprecation notices, CSP violations — which never passes through
   * the console API; and `exceptionThrown` is an uncaught error, which may appear in
   * neither. Subscribing to only the first would miss most of what actually goes wrong.
   */
  private async enableDomains(): Promise<void> {
    this.connection.on('Debugger.scriptParsed', (params) => {
      const url = readString(params, 'url');
      const scriptId = readString(params, 'scriptId');
      if (url === null || scriptId === null || url.length === 0) return;
      this.scripts.set(url, {
        scriptId,
        url,
        sourceMapUrl: readString(params, 'sourceMapURL') ?? '',
      });
    });

    this.connection.on('Runtime.consoleAPICalled', (params) => {
      this.emit(consoleApiToEntry(params));
    });
    this.connection.on('Log.entryAdded', (params) => {
      const entry = logEntryToEntry(params);
      if (entry !== null) this.emit(entry);
    });
    this.connection.on('Runtime.exceptionThrown', (params) => {
      const entry = exceptionToEntry(params);
      if (entry !== null) this.emit(entry);
    });
    this.connection.on('Runtime.executionContextCreated', (params) => {
      const value = params['context'];
      if (typeof value !== 'object' || value === null) return;
      const context = value as Record<string, unknown>;
      const metadata = context['auxData'];
      if (typeof metadata !== 'object' || metadata === null) return;
      const aux = metadata as Record<string, unknown>;
      const frameId = readString(aux, 'frameId');
      const id = readNumber(context, 'id');
      const uniqueId = readString(context, 'uniqueId');
      if (aux['isDefault'] === true && frameId && id !== null && uniqueId) {
        this.defaultContexts.set(frameId, { id, uniqueId });
      }
    });
    this.connection.on('Runtime.executionContextDestroyed', (params) => {
      const id = readNumber(params, 'executionContextId');
      const uniqueId = readString(params, 'executionContextUniqueId');
      for (const [frameId, context] of this.defaultContexts) {
        if (uniqueId === null ? context.id === id : context.uniqueId === uniqueId) {
          this.defaultContexts.delete(frameId);
        }
      }
    });
    this.connection.on('Runtime.executionContextsCleared', () => this.defaultContexts.clear());

    // DEV-P1-24: navigation identity. Main frame only — a subframe navigating is an ad or
    // a widget reloading, and letting it overwrite the loader would attribute the page's
    // console output to whatever last happened in an iframe.
    this.connection.on('Page.frameNavigated', (params) => {
      const frame = params['frame'];
      if (typeof frame !== 'object' || frame === null) return;
      const record = frame as Record<string, unknown>;
      if (readString(record, 'parentId') !== null) return;
      this.navigation = frameIdentityOf(record) ?? { frameId: null, loaderId: null, frameUrl: null };
    });

    // Page is enabled for `frameNavigated` alone, on the same terms as the others: it
    // subscribes to what the page announces and navigates nothing itself. It goes first so
    // that identity is captured before the remaining enables, which leaves exactly two
    // exchanges — the two bootstrap calls themselves — recorded without a loader. Enabling
    // Page before `getFrameTree` rather than after is deliberate: the frame tree is only
    // reliably answerable once the domain is on.
    await this.connection.send('Page.enable');
    await this.captureSessionIdentity();

    await this.connection.send('Runtime.enable');
    await this.connection.send('Log.enable');
    // Debugger is enabled for `scriptParsed` alone. No breakpoints are ever set: pausing
    // the page would change what is being measured, which is the one thing a probe must
    // not do.
    await this.connection.send('Debugger.enable');
  }

  /**
   * Reads the identity the protocol can tell us, once, at attach — `DEV-P1-24`.
   *
   * Both calls tolerate failure and leave their fields null. An agent that refused to attach
   * because `Browser.getVersion` was unavailable would trade a complete recording for no
   * recording, and a null here is honest: it says the browser did not tell us, which is
   * different from saying the value is unknown-shaped or zero.
   *
   * `Page.getFrameTree` matters more than it looks. Without it, navigation identity would be
   * null until the page happened to navigate, so an agent attached to an already-loaded page
   * — the ordinary case, since this agent attaches and never launches — would record every
   * exchange with no loader at all.
   */
  private async captureSessionIdentity(): Promise<void> {
    const version = await this.connection.send('Browser.getVersion').catch(() => null);
    if (version !== null) {
      this.browser = {
        product: readString(version, 'product'),
        revision: readString(version, 'revision'),
        protocolVersion: readString(version, 'protocolVersion'),
        jsVersion: readString(version, 'jsVersion'),
      };
    }

    await this.readMainFrame().catch(() => null);
  }

  private emit(entry: RawConsoleEntry): void {
    for (const listener of this.listeners) listener(entry);
  }

  /* ---------------------------- source maps --------------------------- */

  /**
   * Returns the source map for a script URL, or null.
   *
   * Read through `Debugger.scriptParsed` and `getScriptSource` rather than by fetching
   * the URL again. A dev server can serve a different transform on a second request, and
   * a map that does not correspond to the code the browser actually loaded would produce
   * attributions that are wrong in a way nothing downstream could detect.
   */
  public async sourceMapFor(scriptUrl: string): Promise<string | null> {
    const cached = this.sourceMaps.get(scriptUrl);
    if (cached !== undefined) return cached;

    const record = this.scripts.get(scriptUrl);
    let json: string | null = null;

    if (record !== undefined && record.sourceMapUrl.startsWith('data:')) {
      json = decodeDataUri(record.sourceMapUrl);
    }

    if (json === null && record !== undefined) {
      try {
        const result = await this.connection.send('Debugger.getScriptSource', {
          scriptId: record.scriptId,
        });
        const text = readString(result, 'scriptSource');
        if (text !== null) {
          const extracted = extractInlineSourceMap(text);
          if (extracted?.kind === 'inline') json = extracted.json;
          else if (extracted?.kind === 'url') json = await this.fetchRelative(scriptUrl, extracted.url);
        }
      } catch {
        json = null;
      }
    }

    this.sourceMaps.set(scriptUrl, json);
    return json;
  }

  /** Every script URL seen so far. Feeds `assessAttribution`. */
  public knownScripts(): string[] {
    return [...this.scripts.keys()].sort();
  }

  /**
   * Fetches a source map named by the page, under policy — `DEV-P1-24`.
   *
   * `reference` is the value of a `//# sourceMappingURL=` comment inside a script the page loaded.
   * It is chosen by the code under analysis, which is the code CLU-E exists to be suspicious of.
   * Before this, it was fetched with a timeout and nothing else: no origin check, no redirect
   * policy, no content-type check, and `await response.text()` with no size limit. A page could
   * name any address reachable from this machine — including hosts on the operator's network that
   * the operator's browser can see and the internet cannot — and CLU-E would request it and read
   * the whole response into memory.
   *
   * Five clauses, each of which closes a different way in:
   *
   *   **origin**       the resolved URL must be inside the configured origins, the same list
   *                    `attach` uses to choose a page. The agent had checked the page and then
   *                    stopped checking.
   *   **redirect**     `error`, not `follow`. Following is the bypass: an allowed origin that
   *                    answers with a 302 elsewhere would otherwise defeat the origin clause
   *                    entirely, and a source map is not a resource that legitimately moves.
   *   **content-type** a source map is JSON. A response announcing HTML is not one, and fetching
   *                    it means the URL was not what it claimed.
   *   **size**         bounded by declared length first, then by what is actually read — a
   *                    `Content-Length` is a claim by the same server the URL came from.
   *   **timeout**      already present, kept.
   *
   * A refusal returns null, which is the same result as a map that does not exist. Attribution
   * degrades to unmapped frames, which is exactly what should happen: an unfetchable source map
   * is missing evidence, not a reason to fail a run.
   */
  private async fetchRelative(scriptUrl: string, reference: string): Promise<string | null> {
    try {
      const resolved = new URL(reference, scriptUrl).toString();
      if (!originAllowed(resolved, this.allowedOrigins)) return null;

      const response = await fetch(resolved, {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        redirect: 'error',
      });
      if (!response.ok || response.redirected) return null;
      if (response.url.length > 0) {
        const finalUrl = new URL(response.url).toString();
        if (finalUrl !== resolved || !originAllowed(finalUrl, this.allowedOrigins)) return null;
      }
      if (!contentTypeAllowed(response, SOURCE_MAP_CONTENT_TYPES)) return null;

      // Read against the budget, in chunks, and abandon as soon as it is exceeded.
      //
      // `await response.arrayBuffer()` was the first attempt and it is not a size limit: it
      // buffers the entire body and only then reports its length. Measured against a chunked
      // response with no `Content-Length` — the shape the declared-length check above cannot
      // see — it accepted 401 MB into memory before the check could reject it. A bound that
      // fires after the cost has been paid is a report, not a limit.
      return await readBoundedUtf8(response, MAX_SOURCE_MAP_BYTES);
    } catch {
      return null;
    }
  }

  /* ---------------------------- interaction --------------------------- */

  /**
   * Evaluates an expression in the page.
   *
   * Used for feature detection and fingerprinting. Scenario steps will use it too, and
   * only against surfaces they have declared and probed for — an expression that assumes
   * `window.__murugan` exists is a scenario that fails confusingly on a build where it
   * does not.
   */
  public async evaluate(expression: string): Promise<unknown> {
    this.assertExecutionActive();
    return this.evaluateExpression(expression);
  }

  private async evaluateExpression(expression: string, uniqueContextId?: string): Promise<unknown> {
    const result = await this.connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(uniqueContextId === undefined ? {} : { uniqueContextId, timeout: this.requestTimeoutMs }),
    });

    const details = result['exceptionDetails'];
    if (typeof details === 'object' && details !== null) {
      const text = readString(details as Record<string, unknown>, 'text');
      throw new BrowserAgentError('PROTOCOL_ERROR', text ?? 'evaluation threw');
    }

    const value = result['result'];
    if (typeof value !== 'object' || value === null) return undefined;
    return (value as Record<string, unknown>)['value'];
  }

  /**
   * Executes only when the caller still owns the exact project/session/target generation.
   * This is the governed execution entry point used by the durable browser ledger.
   */
  public async evaluateGoverned(
    expression: string,
    expected: GovernedBrowserExecution,
  ): Promise<unknown> {
    this.assertGovernedExecution(expected);
    if (expected.targetUrl === undefined) return this.evaluate(expression);

    const frame = await this.requireExactFrame(expected.targetUrl);
    const context = this.defaultContexts.get(frame.frameId);
    if (context === undefined) {
      throw new BrowserAgentError('TARGET_DISCONNECTED', 'The governed page has no pinned main-world execution context.');
    }
    // Pin the main world across renderer swaps, and check same-document URL changes in
    // that world immediately before running the caller's expression.
    const source = `(() => {
      if (globalThis.location.href !== ${JSON.stringify(frame.frameUrl)}) throw new Error('Governed target URL changed');
      return (\n${expression}\n);
    })()`;
    const result = await this.evaluateExpression(source, context.uniqueId);
    await this.requireExactFrame(expected.targetUrl, frame);
    return result;
  }

  private assertGovernedExecution(expected: GovernedBrowserExecution): void {
    this.assertExecutionActive();
    if (this.projectIdentity === null) {
      throw new BrowserAgentError(
        'PROJECT_IDENTITY_MISMATCH',
        'This browser session was attached without a Project Profile identity.',
      );
    }
    if (this.profileGeneration !== expected.profileGeneration) {
      throw new BrowserAgentError(
        'PROJECT_IDENTITY_MISMATCH',
        `Project Profile generation changed from ${String(expected.profileGeneration)} to ${String(this.profileGeneration)}.`,
      );
    }
    try {
      assertProjectOperationIdentity(
        expected.projectIdentity,
        this.projectIdentity,
        'governed browser execution',
      );
    } catch (error) {
      throw new BrowserAgentError(
        'PROJECT_IDENTITY_MISMATCH',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (expected.browserSessionId !== this.sessionId) {
      throw new BrowserAgentError(
        'PROJECT_IDENTITY_MISMATCH',
        `Browser session changed from ${expected.browserSessionId} to ${this.sessionId}.`,
      );
    }
    if (expected.targetPageId !== this.target.id) {
      throw new BrowserAgentError(
        'TARGET_DISCONNECTED',
        `Governed target ${expected.targetPageId} is not the attached target ${this.target.id}.`,
      );
    }
  }

  private async readMainFrame(): Promise<FrameIdentity> {
    const result = await this.connection.send('Page.getFrameTree');
    const tree = result['frameTree'];
    const frame = frameIdentityOf(
      typeof tree === 'object' && tree !== null ? (tree as Record<string, unknown>)['frame'] : null,
    );
    if (frame === null) {
      throw new BrowserAgentError('TARGET_DISCONNECTED', 'Chrome did not return the main-frame document identity.');
    }
    this.navigation = frame;
    return frame;
  }

  private async requireExactFrame(targetUrl: string, previous?: FrameIdentity): Promise<FrameIdentity> {
    this.assertExecutionActive();
    const expected = allowedPageUrl(targetUrl, this.allowedOrigins);
    const frame = await this.readMainFrame();
    if (allowedPageUrl(frame.frameUrl, this.allowedOrigins) !== expected ||
        allowedPageUrl(this.target.url, this.allowedOrigins) !== expected) {
      throw new BrowserAgentError('ORIGIN_REFUSED', 'The live document does not match the governed target URL.');
    }
    if (previous !== undefined && (frame.frameId !== previous.frameId || frame.loaderId !== previous.loaderId)) {
      throw new BrowserAgentError('TARGET_DISCONNECTED', 'The governed document changed during the browser operation.');
    }
    this.assertExecutionActive();
    return frame;
  }

  /** Named browser operations only. Every operation is bound to the exact live page. */
  public async controlGoverned(
    action: GovernedBrowserControl,
    expected: GovernedBrowserExecution & { readonly targetUrl: string },
  ): Promise<BrowserScreenshot | void> {
    this.assertGovernedExecution(expected);
    const frame = await this.requireExactFrame(expected.targetUrl);
    let screenshot: BrowserScreenshot | undefined;
    switch (action.type) {
      case 'reload':
        await this.reloadGoverned(expected, frame);
        return;
      case 'move':
      case 'click':
      case 'wheel':
        await this.controlPointer(action, expected.targetUrl, frame);
        break;
      case 'text':
        if (typeof action.text !== 'string' || Buffer.byteLength(action.text, 'utf8') > MAX_INSERTED_TEXT_BYTES) {
          throw new BrowserAgentError('PROTOCOL_ERROR', 'Text input exceeds the browser control limit.');
        }
        await this.connection.send('Input.insertText', { text: action.text });
        break;
      case 'key':
        await this.controlKey(action.key, expected.targetUrl, frame);
        break;
      case 'screenshot':
        screenshot = await this.captureViewport();
        break;
      default:
        throw new BrowserAgentError('PROTOCOL_ERROR', 'Unsupported named browser control.');
    }
    await this.requireExactFrame(expected.targetUrl, frame);
    return screenshot;
  }

  private async reloadGoverned(
    expected: GovernedBrowserExecution & { readonly targetUrl: string },
    original: FrameIdentity,
  ): Promise<void> {
    await this.connection.send('Page.reload', { ignoreCache: true, loaderId: original.loaderId });
    const deadline = Date.now() + this.requestTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.requireExactFrame(expected.targetUrl);
      if (current.frameId !== original.frameId) {
        throw new BrowserAgentError('TARGET_DISCONNECTED', 'The governed frame changed during reload.');
      }
      if (current.loaderId !== original.loaderId && this.defaultContexts.has(current.frameId) &&
          await this.evaluateGoverned('document.readyState', expected) === 'complete') return;
      await delay(50);
    }
    throw new BrowserAgentError('TIMEOUT', 'The governed page did not finish reloading within the browser deadline.');
  }

  private async controlPointer(
    action: Extract<GovernedBrowserControl, { readonly x: number }>,
    targetUrl: string,
    frame: FrameIdentity,
  ): Promise<void> {
    const { x, y } = action;
    if (!finiteInRange(x, 0, MAX_INPUT_COORDINATE) || !finiteInRange(y, 0, MAX_INPUT_COORDINATE)) {
      throw new BrowserAgentError('PROTOCOL_ERROR', 'Pointer coordinates are outside the browser control bounds.');
    }
    if (action.type === 'wheel' &&
        (!finiteInRange(action.deltaX, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA) ||
         !finiteInRange(action.deltaY, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA))) {
      throw new BrowserAgentError('PROTOCOL_ERROR', 'Wheel delta is outside the browser control bounds.');
    }
    const layout = await this.connection.send('Page.getLayoutMetrics');
    const viewport = layout['cssVisualViewport'];
    const dimensions = typeof viewport === 'object' && viewport !== null ? viewport as Record<string, unknown> : null;
    const width = readNumber(dimensions, 'clientWidth');
    const height = readNumber(dimensions, 'clientHeight');
    if (width === null || height === null || x >= width || y >= height) {
      throw new BrowserAgentError('PROTOCOL_ERROR', 'Pointer coordinates must be inside the active CSS viewport.');
    }
    await this.requireExactFrame(targetUrl, frame);
    if (action.type === 'move') {
      await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    } else if (action.type === 'wheel') {
      await this.connection.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: action.deltaX, deltaY: action.deltaY,
      });
    } else {
      const click = { x, y, button: 'left', clickCount: 1 };
      await this.connection.send('Input.dispatchMouseEvent', { ...click, type: 'mousePressed', buttons: 1 });
      await this.requireExactFrame(targetUrl, frame);
      await this.connection.send('Input.dispatchMouseEvent', { ...click, type: 'mouseReleased', buttons: 0 });
    }
  }

  private async controlKey(
    key: keyof typeof browserKeys,
    targetUrl: string,
    frame: FrameIdentity,
  ): Promise<void> {
    if (!Object.hasOwn(browserKeys, key)) {
      throw new BrowserAgentError('PROTOCOL_ERROR', 'Key is outside the browser control allowlist.');
    }
    const event = { code: key, key: key === 'Space' ? ' ' : key, windowsVirtualKeyCode: browserKeys[key] };
    const text = key === 'Space' ? ' ' : key === 'Enter' ? '\r' : null;
    await this.connection.send('Input.dispatchKeyEvent', {
      ...event, type: text === null ? 'rawKeyDown' : 'keyDown', ...(text === null ? {} : { text }),
    });
    await this.requireExactFrame(targetUrl, frame);
    await this.connection.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
  }

  private async captureViewport(): Promise<BrowserScreenshot> {
    const response = await this.connection.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 55, fromSurface: true, captureBeyondViewport: false,
    });
    const data = readString(response, 'data');
    if (data === null || data.length > MAX_SCREENSHOT_BASE64_BYTES || data.length % 4 !== 0 ||
        !data.startsWith('/9j/') || !/^[a-z0-9+/]+={0,2}$/iu.test(data)) {
      throw new BrowserAgentError('PROTOCOL_ERROR', 'Chrome returned an invalid or oversized JPEG screenshot.');
    }
    return { data, mimeType: 'image/jpeg' };
  }

  /** Whether a debug surface exists, without assuming it does. */
  public async hasSurface(path: string): Promise<boolean> {
    const value = await this.evaluate(`typeof ${path} !== 'undefined'`);
    return value === true;
  }

  /* --------------------------- fingerprinting ------------------------- */

  /**
   * Captures the environment a measurement was taken in.
   *
   * Two runs are only comparable within the same envelope. Recording it at capture time
   * is what lets a later verdict say whether a difference was the patch or the machine.
   */
  public async fingerprint(): Promise<EnvironmentFingerprint> {
    const version = await this.connection.send('Browser.getVersion').catch(() => ({}));

    const page = (await this.evaluate(
      `(() => ({
         userAgent: navigator.userAgent,
         width: window.innerWidth,
         height: window.innerHeight,
         dpr: window.devicePixelRatio,
         cores: navigator.hardwareConcurrency ?? null,
         memory: navigator.deviceMemory ?? null,
       }))()`,
    ).catch(() => null)) as Record<string, unknown> | null;

    // Adapter info rather than a rendered frame: enough to tell two machines apart, and
    // it costs nothing and changes nothing on the page.
    const adapter = (await this.evaluate(
      `(async () => {
         if (!('gpu' in navigator)) return null;
         try {
           const a = await navigator.gpu.requestAdapter();
           if (!a) return null;
           const i = a.info ?? {};
           return { vendor: i.vendor ?? 'unknown', architecture: i.architecture ?? 'unknown' };
         } catch { return null; }
       })()`,
    ).catch(() => null)) as Record<string, unknown> | null;

    return {
      browser: readString(version, 'product') ?? 'unknown',
      protocolVersion: readString(version, 'protocolVersion') ?? 'unknown',
      userAgent: page === null ? 'unknown' : (readString(page, 'userAgent') ?? 'unknown'),
      targetUrl: this.target.url,
      viewport:
        page === null
          ? null
          : {
              width: readNumber(page, 'width') ?? 0,
              height: readNumber(page, 'height') ?? 0,
              devicePixelRatio: readNumber(page, 'dpr') ?? 1,
            },
      hardwareConcurrency: page === null ? null : readNumber(page, 'cores'),
      deviceMemory: page === null ? null : readNumber(page, 'memory'),
      webgpuAdapter:
        adapter === null
          ? null
          : {
              vendor: readString(adapter, 'vendor') ?? 'unknown',
              architecture: readString(adapter, 'architecture') ?? 'unknown',
            },
      capturedAt: new Date().toISOString(),
    };
  }

  /** Parks this session during an atomic Project Profile transition. */
  public park(): void {
    if (this.closed) return;
    this.parked = true;
  }

  /** Restores a parked session only when activation rolled back to its original project. */
  public resume(): void {
    if (this.closed) {
      throw new BrowserAgentError('NOT_CONNECTED', 'A closed browser session cannot be resumed.');
    }
    this.parked = false;
  }

  public get isParked(): boolean {
    return this.parked;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.parked = true;
    this.connection.close();
    this.listeners.clear();
  }

  private assertExecutionActive(): void {
    if (this.closed) {
      throw new BrowserAgentError('NOT_CONNECTED', 'The browser session is closed.');
    }
    if (this.parked) {
      throw new BrowserAgentError(
        'SESSION_NOT_ACTIVE',
        'The browser session is parked during a Project Profile transition.',
      );
    }
  }
}

/* ------------------------------------------------------------------------- */
/* CDP payload conversion                                                     */
/* ------------------------------------------------------------------------- */

function consoleApiToEntry(params: Record<string, unknown>): RawConsoleEntry {
  const type = readString(params, 'type') ?? 'log';
  const args = params['args'];

  return {
    level: consoleTypeToLevel(type),
    text: Array.isArray(args) ? args.map(renderRemoteObject).join(' ') : '',
    frames: framesOf(params['stackTrace']),
    timestamp: new Date().toISOString(),
    scenarioId: null,
    stepIndex: null,
    checkpointId: null,
  };
}

function logEntryToEntry(params: Record<string, unknown>): RawConsoleEntry | null {
  const entry = params['entry'];
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;

  const text = readString(record, 'text');
  if (text === null) return null;

  const url = readString(record, 'url');
  const line = readNumber(record, 'lineNumber');
  const frames = framesOf(record['stackTrace']);

  // The browser's own reports often carry a url and line but no stack. Synthesising a
  // single frame from them keeps the entry attributable instead of discarding the only
  // position information it had.
  const fallback: StackFrame[] =
    frames.length > 0 || url === null
      ? frames
      : [{ url, line: (line ?? 0) + 1, column: 1, functionName: null }];

  return {
    level: logLevelToLevel(readString(record, 'level') ?? 'info'),
    text,
    frames: fallback,
    timestamp: new Date().toISOString(),
    scenarioId: null,
    stepIndex: null,
    checkpointId: null,
  };
}

function exceptionToEntry(params: Record<string, unknown>): RawConsoleEntry | null {
  const details = params['exceptionDetails'];
  if (typeof details !== 'object' || details === null) return null;
  const record = details as Record<string, unknown>;

  const exception = record['exception'];
  const described =
    typeof exception === 'object' && exception !== null
      ? readString(exception as Record<string, unknown>, 'description')
      : null;

  return {
    level: 'error',
    text: described ?? readString(record, 'text') ?? 'uncaught exception',
    frames: framesOf(record['stackTrace']),
    timestamp: new Date().toISOString(),
    scenarioId: null,
    stepIndex: null,
    checkpointId: null,
  };
}

/**
 * Converts a CDP stack trace to CLUE frames.
 *
 * CDP counts lines and columns from zero; every anchor in CLUE counts from one. The
 * conversion happens here and in the attributor, and nowhere else.
 */
function framesOf(stackTrace: unknown): StackFrame[] {
  if (typeof stackTrace !== 'object' || stackTrace === null) return [];
  const callFrames = (stackTrace as Record<string, unknown>)['callFrames'];
  if (!Array.isArray(callFrames)) return [];

  return callFrames
    .filter((frame): frame is Record<string, unknown> => typeof frame === 'object' && frame !== null)
    .map((frame) => ({
      url: readString(frame, 'url') ?? '',
      line: (readNumber(frame, 'lineNumber') ?? 0) + 1,
      column: (readNumber(frame, 'columnNumber') ?? 0) + 1,
      functionName: readString(frame, 'functionName'),
    }));
}

function consoleTypeToLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warning';
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    default:
      return 'log';
  }
}

function logLevelToLevel(level: string): ConsoleLevel {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'verbose':
      return 'debug';
    default:
      return 'info';
  }
}

/**
 * Renders a CDP RemoteObject as text.
 *
 * `returnByValue` is not used for console arguments — serialising a live object graph
 * from a running page is both expensive and capable of throwing. The description Chrome
 * already computed is enough to identify a recurring message, which is all the ledger
 * needs.
 */
function renderRemoteObject(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value);
  const record = value as Record<string, unknown>;

  if ('value' in record) {
    const inner = record['value'];
    if (inner === null) return 'null';
    if (typeof inner === 'object') return readString(record, 'description') ?? '[object]';
    return String(inner);
  }

  const description = readString(record, 'description');
  if (description !== null) return description;

  const type = readString(record, 'type') ?? 'unknown';
  const subtype = readString(record, 'subtype');
  return subtype === null ? `[${type}]` : `[${type}:${subtype}]`;
}

function decodeDataUri(uri: string): string | null {
  const base64 = /^data:application\/json;(?:charset=[^;]+;)?base64,(.*)$/i.exec(uri);
  const encoded = base64?.[1];
  if (encoded !== undefined) {
    try {
      return Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  const comma = uri.indexOf(',');
  if (comma === -1) return null;
  try {
    return decodeURIComponent(uri.slice(comma + 1));
  } catch {
    return null;
  }
}

/** Returns the normalized MIME type without parameters. */
function responseMimeType(response: Response): string | null {
  const value = response.headers.get('content-type');
  if (value === null) return null;
  const [mime] = value.split(';', 1);
  const normalized = mime?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function contentTypeAllowed(response: Response, accepted: readonly string[]): boolean {
  const actual = responseMimeType(response);
  return actual !== null && accepted.includes(actual);
}

/**
 * Reads one HTTP body under a hard byte ceiling.
 *
 * The declared length is an early refusal only. The streamed count is the authority because the
 * peer controls the header. Returning null means missing/refused evidence, never a partial body.
 */
async function readBoundedUtf8(response: Response, maxBytes: number): Promise<string | null> {
  const declaredRaw = response.headers.get('content-length');
  if (declaredRaw !== null) {
    const normalized = declaredRaw.trim();
    if (/^\d+$/.test(normalized)) {
      const declared = Number(normalized);
      if (!Number.isSafeInteger(declared) || declared > maxBytes) return null;
    }
  }

  const stream = response.body;
  if (stream === null) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    // On a refusal, stop the peer instead of leaving it writing a body nobody reads.
    await reader.cancel().catch(() => undefined);
  }
}

/** A parsed origin allowlist entry. Paths and credentials are never part of an origin. */
interface AllowedOriginPattern {
  readonly protocol: string;
  readonly hostname: string;
  readonly wildcardSubdomain: boolean;
  readonly port: number | '*';
}

/**
 * Parses one configured origin pattern without ever treating it as a URL prefix.
 *
 * The configuration currently uses `http://localhost:*`. Exact hosts and a leading
 * `*.` subdomain wildcard are also accepted. Everything after the authority except an
 * optional trailing slash is refused: an "origin" carrying a path would otherwise turn
 * an origin policy into an ambiguous URL-prefix policy again.
 */
function parseAllowedOriginPattern(pattern: string): AllowedOriginPattern | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(\*\.)?(\[[^\]]+\]|[^\/:?#*]+)(?::(\*|[0-9]{1,5}))?\/?$/i.exec(
    pattern.trim(),
  );
  if (match === null) return null;

  const protocol = match[1]?.toLowerCase();
  const hostname = match[3]?.toLowerCase();
  const portText = match[4];
  if (protocol === undefined || hostname === undefined) return null;
  if (protocol !== 'http' && protocol !== 'https') return null;

  if (portText === '*') {
    return {
      protocol,
      hostname,
      wildcardSubdomain: match[2] !== undefined,
      port: '*',
    };
  }

  const port = Number(portText ?? defaultPort(protocol));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return null;

  return {
    protocol,
    hostname,
    wildcardSubdomain: match[2] !== undefined,
    port,
  };
}

function defaultPort(protocol: string): number {
  if (protocol === 'http') return 80;
  if (protocol === 'https') return 443;
  return -1;
}

function effectivePort(url: URL): number {
  if (url.port.length > 0) return Number(url.port);
  return defaultPort(url.protocol.slice(0, -1).toLowerCase());
}

/**
 * Whether a target or source-map URL is inside the configured allowed **origins**.
 *
 * This must compare parsed URL components, not text prefixes. The previous glob turned
 * `http://localhost:*` into a regular-expression prefix and therefore accepted a URL such
 * as `http://localhost:5173@evil.example/map`: `localhost:5173` was user-info, while the
 * real network host was `evil.example`. It also made path and authority boundaries depend
 * on string spelling rather than URL semantics.
 *
 * The replacement:
 *
 * - parses the candidate URL and refuses credentials;
 * - compares protocol, normalized hostname and effective port independently;
 * - supports only an exact host or a leading `*.` subdomain wildcard;
 * - treats `:*` as a port wildcard, not as an arbitrary authority wildcard;
 * - ignores path/query/fragment because an origin has none of those components.
 *
 * An invalid candidate or invalid allowlist entry is a non-match. Refusal remains the
 * default because measuring or fetching from the wrong origin can produce plausible but
 * false evidence.
 */
export function originAllowed(url: string, patterns: readonly string[]): boolean {
  let candidate: URL;
  try {
    candidate = new URL(url);
  } catch {
    return false;
  }

  if (candidate.username.length > 0 || candidate.password.length > 0) return false;
  const protocol = candidate.protocol.slice(0, -1).toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') return false;
  const hostname = candidate.hostname.toLowerCase();
  const port = effectivePort(candidate);
  if (port < 0) return false;

  for (const rawPattern of patterns) {
    const pattern = parseAllowedOriginPattern(rawPattern);
    if (pattern === null || pattern.protocol !== protocol) continue;

    const hostMatches = pattern.wildcardSubdomain
      ? hostname !== pattern.hostname && hostname.endsWith(`.${pattern.hostname}`)
      : hostname === pattern.hostname;
    if (!hostMatches) continue;

    if (pattern.port === '*' || pattern.port === port) return true;
  }

  return false;
}

/* ------------------------------------------------------------------------- */
/* Field reading                                                              */
/* ------------------------------------------------------------------------- */

function readString(record: Record<string, unknown> | null, field: string): string | null {
  if (record === null) return null;
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown> | null, field: string): number | null {
  if (record === null) return null;
  const value = record[field];
  return typeof value === 'number' ? value : null;
}
