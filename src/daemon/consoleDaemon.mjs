/**
 * Console daemon — read-only ConsoleSnapshot transport.
 *
 * Spec: CLUE_Milestone_Review_and_Forward_Plan_v3.md §5.3 (a minimal local daemon endpoint
 *       exposing the current validated ConsoleSnapshot). Doctrine: the two-tab renderer and
 *       the System Navigator need one stable authority boundary; reading random files or
 *       importing backend internals into browser code would create a second, fragile
 *       integration architecture (§5.3 WHY). This daemon is that single boundary.
 *
 * It is deliberately the smallest sufficient transport, and it reuses the connection model
 * the Navigator SSE server already proved (localhost-only origin guard, SSE with replay and
 * heartbeat, unref'd timers, clean start/stop) rather than inventing a second one. Three
 * rules define it.
 *
 *   **It is strictly read-only.** There is no publish route, no static file serving, no
 *   mutation path of any kind. A UI can GET the current snapshot and subscribe to changes;
 *   it can never move mission, graph, repository, or experiment state. New snapshots enter
 *   only through {@link ConsoleDaemon.publish}, an in-process call made by whatever owns the
 *   projection — never over HTTP.
 *
 *   **It publishes only schema-valid, sealed snapshots, carrying a revision.** This is
 *   enforced at the boundary, not assumed (deep review, Integrity Patch 0, P0.4): `publish`
 *   runs every incoming snapshot through the injected validator — the compiled
 *   `parseConsoleSnapshot` from src/ui/viewModel.ts — and serves the validator's *return*
 *   value, so nothing unvalidated can ever sit behind the endpoints. The projector already
 *   validates on produce; the daemon re-validates on receive because a boundary is exactly
 *   where trust changes hands. The validator is a mandatory constructor option rather than
 *   an import, for one reason: this module deliberately lives outside the TypeScript build
 *   (a .mjs sibling to the Navigator SSE server, node built-ins only), and the schema
 *   authority must stay single-sourced in viewModel — injected from compiled code, never
 *   re-declared here and never reached through a brittle src→dist path. A daemon without a
 *   validator is unconstructable. A snapshot whose seal hash equals the current one is a
 *   no-op — the revision only advances when the projected state actually changed, so a
 *   reconnecting client and a live client agree on "current".
 *
 *   **A reconnecting client reconstructs the same state.** On SSE connect the daemon sends
 *   the current revision immediately, so a browser that dropped and returns obtains the
 *   present state without restarting recognition. A client may pass its last-seen revision;
 *   the daemon replays only if it is behind, and an out-of-order or duplicate revision is
 *   never emitted twice.
 *
 * This module runs under Node (it is the daemon process), so it is a .mjs sibling to the
 * Navigator SSE server rather than a kernel TypeScript module. The snapshot it serves is
 * produced by src/ui/consoleProjector.ts and validated by src/ui/viewModel.ts; the daemon
 * itself never assembles state, only transports it.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 47832,
  snapshotPath: '/api/console-snapshot',
  eventsPath: '/api/console-events',
  statusPath: '/api/console-status',
  heartbeatMs: 15000,
});

export class ConsoleDaemon {
  /**
   * @param {object} options
   * @param {(input: unknown) => object} options.validateSnapshot Mandatory. The strict
   *   ConsoleSnapshot validator — in production the compiled `parseConsoleSnapshot` from
   *   dist/src/ui/viewModel.js. Must return the validated snapshot or throw. Making it a
   *   constructor requirement makes an unvalidating daemon unconstructable (P0.4).
   */
  constructor(options = {}) {
    if (typeof options.validateSnapshot !== 'function') {
      throw new TypeError(
        'ConsoleDaemon requires options.validateSnapshot — the strict ConsoleSnapshot validator (parseConsoleSnapshot). A daemon that cannot validate must not exist.',
      );
    }
    this.options = {
      host: options.host ?? DEFAULTS.host,
      port: options.port ?? DEFAULTS.port,
      snapshotPath: options.snapshotPath ?? DEFAULTS.snapshotPath,
      eventsPath: options.eventsPath ?? DEFAULTS.eventsPath,
      statusPath: options.statusPath ?? DEFAULTS.statusPath,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
      validateSnapshot: options.validateSnapshot,
    };
    this.server = null;
    this.heartbeat = null;
    this.clients = new Map();
    // The current published state. revision advances only when the seal hash changes.
    this.current = null; // { revision, seal, snapshot }
    this.revision = 0;
  }

  /**
   * Publishes a new snapshot. Expects an already-validated ConsoleSnapshot from the projector.
   * No-op when the seal hash matches the current snapshot (state did not change). Returns the
   * revision now current. Read-only clients never call this — it is an in-process hand-off.
   */
  publish(snapshot) {
    // Boundary validation first, before any state is read or touched (P0.4). What gets
    // deduplicated, stored, and served is the validator's return value — never the raw
    // argument — so an object that merely resembles a ConsoleSnapshot cannot slip behind
    // the endpoints between the check and the store.
    let validated;
    try {
      validated = this.options.validateSnapshot(snapshot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TypeError(`ConsoleDaemon.publish rejected an invalid ConsoleSnapshot: ${detail}`, {
        cause: error,
      });
    }
    if (!validated || typeof validated !== 'object' || !validated.seal) {
      throw new TypeError('ConsoleDaemon.publish: the validator returned no sealed snapshot.');
    }
    const sealHash = validated.seal.snapshotHash;
    if (this.current && this.current.seal.snapshotHash === sealHash) {
      // Identical projected state — do not advance the revision or re-emit.
      return this.revision;
    }
    this.revision += 1;
    this.current = { revision: this.revision, seal: validated.seal, snapshot: validated };
    const frame = this.#frame(this.current);
    for (const response of this.clients.values()) {
      response.write(`data: ${frame}\n\n`);
    }
    return this.revision;
  }

  async start() {
    if (this.server) return this.address();
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.heartbeat = setInterval(() => {
      for (const response of this.clients.values()) response.write(': heartbeat\n\n');
    }, this.options.heartbeatMs);
    this.heartbeat.unref?.();
    return this.address();
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const response of this.clients.values()) {
      try {
        response.end();
      } catch {
        /* client already gone */
      }
    }
    this.clients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }

  address() {
    const base = `http://${this.options.host}:${this.options.port}`;
    return {
      snapshot: `${base}${this.options.snapshotPath}`,
      events: `${base}${this.options.eventsPath}`,
      status: `${base}${this.options.statusPath}`,
    };
  }

  #frame(entry) {
    return JSON.stringify({ revision: entry.revision, seal: entry.seal, snapshot: entry.snapshot });
  }

  #originAllowed(request) {
    const origin = request.headers.origin ?? '';
    if (!origin) return true;
    try {
      const url = new URL(origin);
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    } catch {
      return false;
    }
  }

  async #handle(request, response) {
    if (!this.#originAllowed(request)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Origin not allowed.');
      return;
    }
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const method = request.method ?? 'GET';

    // Read-only: every mutating method is refused outright, no exceptions.
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, {
        'content-type': 'text/plain; charset=utf-8',
        allow: 'GET, HEAD',
      });
      response.end('This daemon is read-only.');
      return;
    }

    if (requestUrl.pathname === this.options.snapshotPath) {
      this.#sendSnapshot(request, response);
      return;
    }
    if (requestUrl.pathname === this.options.eventsPath) {
      this.#openSse(request, requestUrl, response);
      return;
    }
    if (requestUrl.pathname === this.options.statusPath) {
      this.#sendJson(request, response, {
        ok: true,
        clients: this.clients.size,
        revision: this.revision,
        hasSnapshot: this.current !== null,
        sealHash: this.current ? this.current.seal.snapshotHash : null,
      });
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found.');
  }

  #sendSnapshot(request, response) {
    if (this.current === null) {
      // Honest absence: no snapshot has been projected yet. 503, not an empty object that a
      // renderer might mistake for real state.
      response.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ ok: false, reason: 'no snapshot available yet', revision: 0 }));
      return;
    }
    this.#sendJson(request, response, this.current);
  }

  #openSse(request, requestUrl, response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': request.headers.origin || '*',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 1500\n\n');
    // Replay the current revision on connect unless the client is already at or beyond it,
    // so a reconnecting browser reconstructs the present state without a duplicate.
    const since = Number(requestUrl.searchParams.get('since') ?? 'NaN');
    if (this.current !== null && !(Number.isFinite(since) && since >= this.current.revision)) {
      response.write(`data: ${this.#frame(this.current)}\n\n`);
    }
    const id = randomUUID();
    this.clients.set(id, response);
    request.on('close', () => this.clients.delete(id));
  }

  #sendJson(request, response, value) {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': request.headers.origin || '*',
    });
    if ((request.method ?? 'GET') === 'HEAD') {
      response.end();
      return;
    }
    response.end(JSON.stringify(value));
  }
}
