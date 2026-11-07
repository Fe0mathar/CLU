/** Read-only HTTP/SSE/static server for the CLU-E Operational Console. */

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import { ArtifactStore } from '../memory/artifactStore.js';
import { asSha256 } from '../shared/ids.js';
import { projectOperationalConsole } from '../observability/operationalConsole/projection.js';
import { readOperationalConsoleTail } from '../observability/operationalConsole/store.js';

export interface OperationalConsoleServerOptions {
  readonly eventFile: string;
  readonly blobsDir: string;
  readonly staticRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly projectionLimit?: number;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wgsl':
      return 'text/plain; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

export class OperationalConsoleServer {
  private readonly host: string;
  private readonly port: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly projectionLimit: number;
  private readonly artifactStore: ArtifactStore;
  private readonly clients = new Map<string, ServerResponse>();
  private server: ReturnType<typeof createServer> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private lastSequence = -1;

  public constructor(private readonly options: OperationalConsoleServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 47833;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.pollMs = options.pollMs ?? 120;
    this.projectionLimit = options.projectionLimit ?? 300;
    this.artifactStore = new ArtifactStore(options.blobsDir);
  }

  public async start(): Promise<{ readonly root: string; readonly events: string }> {
    if (this.server !== null) return this.addresses();
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolvePromise, reject) => {
      const server = this.server;
      if (server === null) {
        reject(new Error('Server was not created.'));
        return;
      }
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
    this.heartbeat = setInterval(() => {
      for (const response of this.clients.values()) response.write(': heartbeat\n\n');
    }, this.heartbeatMs);
    this.heartbeat.unref();
    this.poller = setInterval(() => this.publishNewEvents(), this.pollMs);
    this.poller.unref();
    this.publishNewEvents();
    return this.addresses();
  }

  public async stop(): Promise<void> {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.poller !== null) clearInterval(this.poller);
    this.heartbeat = null;
    this.poller = null;
    for (const response of this.clients.values()) response.end();
    this.clients.clear();
    if (this.server !== null) {
      const server = this.server;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      this.server = null;
    }
  }

  private addresses(): { readonly root: string; readonly events: string } {
    const base = `http://${this.host}:${this.port}`;
    return { root: `${base}/`, events: `${base}/api/operational-console-events` };
  }

  private originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    try {
      const url = new URL(origin);
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    } catch {
      return false;
    }
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    if (!this.originAllowed(request)) {
      this.text(response, 403, 'Origin not allowed.');
      return;
    }
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end('Operational Console server is read-only.');
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? this.host}`);

    if (url.pathname === '/api/operational-console') {
      this.json(
        request,
        response,
        projectOperationalConsole(this.options.eventFile, { limit: this.projectionLimit }),
      );
      return;
    }
    if (url.pathname === '/api/operational-console-events') {
      this.openSse(request, response, url);
      return;
    }
    if (url.pathname === '/api/operational-console-status') {
      this.json(request, response, {
        ok: true,
        clients: this.clients.size,
        lastSequence: this.lastSequence < 0 ? null : this.lastSequence,
        eventFile: this.options.eventFile,
      });
      return;
    }
    if (url.pathname.startsWith('/api/operational-console-artifacts/')) {
      const raw = url.pathname.slice('/api/operational-console-artifacts/'.length);
      const hash = asSha256(raw);
      if (hash === undefined || !this.artifactStore.has(hash)) {
        this.text(response, 404, 'Artifact not found.');
        return;
      }
      const bytes = this.artifactStore.getBytes(hash);
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') response.end();
      else response.end(bytes);
      return;
    }
    this.serveStatic(request, response, url.pathname);
  }

  private openSse(request: IncomingMessage, response: ServerResponse, url: URL): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': request.headers.origin ?? '*',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 1200\n\n');
    const since = Number.parseInt(url.searchParams.get('since') ?? '-1', 10);
    // DEV-P1-22: bounded replay. This previously parsed and re-hashed the entire history
    // on every connect to emit the tail of it. The window is read backwards from the end,
    // and what the limit excluded is announced rather than silently omitted (Status §8.3).
    const window = readOperationalConsoleTail(this.options.eventFile, {
      afterSequence: Number.isFinite(since) ? since : -1,
    });
    if (window.droppedEvents > 0) {
      response.write(
        `event: replay-bounded\ndata: ${JSON.stringify({
          droppedEvents: window.droppedEvents,
          firstSequence: window.firstSequence,
          headSequence: window.headSequence,
          joinVerified: window.joinVerified,
        })}\n\n`,
      );
    }
    for (const event of window.events) {
      response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    const id = randomUUID();
    this.clients.set(id, response);
    request.on('close', () => this.clients.delete(id));
  }

  private publishNewEvents(): void {
    let events;
    try {
      // Only what is new since the last tick — the poll cost no longer grows with history.
      events = readOperationalConsoleTail(this.options.eventFile, {
        afterSequence: this.lastSequence,
      }).events;
    } catch {
      return;
    }
    for (const event of events) {
      if (event.sequence <= this.lastSequence) continue;
      const frame = `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const response of this.clients.values()) response.write(frame);
      this.lastSequence = event.sequence;
    }
  }

  private serveStatic(request: IncomingMessage, response: ServerResponse, requested: string): void {
    const relative = requested === '/' ? 'demo/index.html' : requested.replace(/^\//, '');
    const candidate = resolve(this.options.staticRoot, relative);
    const root = resolve(this.options.staticRoot);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      this.text(response, 403, 'Path not allowed.');
      return;
    }
    let file = candidate;
    if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) {
      this.text(response, 404, 'Not found.');
      return;
    }
    response.writeHead(200, {
      'content-type': contentType(file),
      'cache-control': file.endsWith('.html') ? 'no-store' : 'public, max-age=60',
    });
    if ((request.method ?? 'GET') === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  private json(request: IncomingMessage, response: ServerResponse, value: unknown): void {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': request.headers.origin ?? '*',
    });
    if ((request.method ?? 'GET') === 'HEAD') response.end();
    else response.end(JSON.stringify(value));
  }

  private text(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(text);
  }
}
