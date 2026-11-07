/**
 * Console serve orchestrator.
 *
 * Spec: CLUE_Strategy_v5 — Workstream B, checkpoint B1 Step 3 ("clue console serve"). This
 *       is the running assembly the read side was built toward: it composes the three
 *       read-side pieces (RuntimeRegistrySource → collector → projector, via
 *       {@link ConsoleStateService}) with the read-only transport ({@link ConsoleDaemon})
 *       and stands up the endpoints the browser visualization layer connects to — the same
 *       sealed, validated snapshot revision consumed by Dashboard, Navigator, and status.
 *
 * What this module is, and is not:
 *   - It does NOT own the runtime lifecycle. The runtime is injected, and its event-log
 *     lock must stay held for the server's whole life, so the caller opens it with
 *     {@link withRuntimeAsync} and disposes it only after `stop()` returns. Disposing while
 *     the server runs would release the lock under a live process — the exact hazard
 *     withRuntimeAsync exists to prevent.
 *   - It DOES own the transport lifecycle: it constructs the daemon, publishes an initial
 *     revision before the socket opens (so the first client never sees empty state),
 *     starts listening, optionally re-derives state on a cadence, and tears the server (and
 *     any poll timer) down on `stop()`.
 *
 * Validation is not optional here, and this is where P0.4 pays off: the daemon is
 * unconstructable without a validator, and the one injected is the compiled
 * `parseConsoleSnapshot` — the same schema authority the projector seals with. Nothing
 * unvalidated can reach the endpoints.
 *
 * The `.mjs` boundary: the daemon deliberately lives outside the TypeScript build (node
 * built-ins only, a sibling to the Navigator SSE server), so it is never compiled into
 * dist. This orchestrator therefore loads it dynamically from the source tree, resolved
 * against the runtime's discovered `repoRoot` rather than a brittle count of `../` between
 * dist and src — an honest dependency on the fact that this architecture ships `src/*.mjs`
 * to run at all. The compiled validator crosses the boundary by injection, never by the
 * daemon reaching back into dist.
 *
 * Liveness is opt-in and honest. With no interval (the default) the server publishes one
 * revision and serves it — correct for a static inspection. With `refreshIntervalMs > 0`
 * the orchestrator re-derives state on that cadence; because the collector and projector
 * are deterministic over unchanged durable state, an unchanged tick re-seals identically
 * and the daemon holds its revision, so SSE stays quiet until state actually moves. Cross
 * process liveness is bounded by what the injected runtime re-reads; this module does not
 * claim real-time beyond that.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConsoleStateService, type ConsoleStateServiceOptions } from './consoleStateService.js';
import { parseConsoleSnapshot, type ConsoleSnapshot, type ConsoleTab } from '../ui/viewModel.js';
import type { Runtime } from '../control/runtime.js';

/** The read-only endpoint URLs the daemon exposes, echoed back for the operator to open. */
export interface ConsoleServeUrls {
  readonly snapshot: string;
  readonly events: string;
  readonly status: string;
}

export interface ConsoleServeOptions {
  /** Operator identity shown in the console shell. */
  readonly operator: string;
  /** Bind host; defaults to the daemon's loopback default. */
  readonly host?: string;
  /** Bind port; defaults to the daemon's default. A fixed port keeps the echoed URLs exact. */
  readonly port?: number;
  /** Which tab the console shows by default. */
  readonly activeTab?: ConsoleTab;
  /** Display title for the mission; falls back to the config project id. */
  readonly missionTitle?: string;
  /**
   * Absolute path to the navigator live stream, used to locate `graph/current.json`.
   * Defaults to the canonical `<workspace>/graph/system-navigator.ndjson` that `recognize`
   * writes, so a served console and a recognition run agree on where the pointer lives.
   */
  readonly navigatorPath?: string;
  /**
   * Re-derive-and-republish cadence in milliseconds. 0 (default) disables polling: the
   * initial revision is served as-is. A positive value publishes only when durable state
   * actually changes — unchanged ticks are no-ops by construction.
   */
  readonly refreshIntervalMs?: number;
  /** Clock for the snapshot's `capturedAt`; injected for deterministic tests. */
  readonly now?: () => string;
}

/**
 * A started console server. `stop()` tears down the transport (poll timer + socket) but
 * deliberately leaves the runtime open — the caller that opened it owns disposing it.
 */
export interface ConsoleServeHandle {
  readonly urls: ConsoleServeUrls;
  /** The revision published before the socket opened. */
  readonly initialRevision: number;
  /** Forces one re-derive-and-publish; returns the revision now current. */
  refresh(): number;
  /** Stops polling and closes the server. Does not dispose the runtime. */
  stop(): Promise<void>;
}

/* ------------------------------------------------------------------------- */
/* Structural seam over the .mjs daemon                                       */
/* ------------------------------------------------------------------------- */

interface ConsoleDaemonInstance {
  /** In-process hand-off of an already-projected snapshot; the daemon re-validates it. */
  publish(snapshot: ConsoleSnapshot): number;
  start(): Promise<ConsoleServeUrls>;
  stop(): Promise<void>;
  readonly revision: number;
}

interface ConsoleDaemonModule {
  readonly ConsoleDaemon: new (options: {
    validateSnapshot: (input: unknown) => object;
    host?: string;
    port?: number;
  }) => ConsoleDaemonInstance;
}

/* ------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Loads the read-only console daemon from the source tree. The daemon is not part of the
 * TypeScript build, so it is resolved against the runtime's discovered repo root and
 * imported as a URL — the same bridge the daemon's own tests use.
 */
async function loadConsoleDaemon(repoRoot: string): Promise<ConsoleDaemonModule['ConsoleDaemon']> {
  const daemonUrl = pathToFileURL(join(repoRoot, 'src', 'daemon', 'consoleDaemon.mjs')).href;
  const daemonModule = (await import(daemonUrl)) as ConsoleDaemonModule;
  return daemonModule.ConsoleDaemon;
}

/**
 * Stands up the read-only console endpoints over live durable state and returns a handle to
 * the running server. The runtime is borrowed, not owned: keep it open until `stop()`.
 */
export async function serveConsole(
  runtime: Runtime,
  options: ConsoleServeOptions,
): Promise<ConsoleServeHandle> {
  const ConsoleDaemon = await loadConsoleDaemon(runtime.repoRoot);

  const daemon = new ConsoleDaemon({
    // P0.4: the schema authority the projector seals with, injected — an unvalidating
    // daemon cannot be constructed, and nothing unvalidated reaches the endpoints.
    validateSnapshot: parseConsoleSnapshot,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
  });

  const navigatorPath =
    options.navigatorPath ?? join(runtime.workspaceRoot, 'graph', 'system-navigator.ndjson');

  const serviceOptions: ConsoleStateServiceOptions = {
    operator: options.operator,
    navigatorPath,
    ...(options.activeTab !== undefined ? { activeTab: options.activeTab } : {}),
    ...(options.missionTitle !== undefined ? { missionTitle: options.missionTitle } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  const service = new ConsoleStateService(runtime, daemon, serviceOptions);

  // Publish real state before the socket opens: the first client to connect must never be
  // handed an empty or absent snapshot.
  const { revision: initialRevision } = service.refresh();

  const urls = await daemon.start();

  let timer: ReturnType<typeof setInterval> | null = null;
  const interval = options.refreshIntervalMs ?? 0;
  if (interval > 0) {
    timer = setInterval(() => {
      // Idempotent by design: unchanged durable state re-seals identically and the daemon
      // holds its revision. A read that races a concurrent write simply retries next tick.
      try {
        service.refresh();
      } catch {
        /* transient read/write race; the next tick recovers */
      }
    }, interval);
  }

  return {
    urls,
    initialRevision,
    refresh: (): number => service.refresh().revision,
    stop: async (): Promise<void> => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await daemon.stop();
    },
  };
}
