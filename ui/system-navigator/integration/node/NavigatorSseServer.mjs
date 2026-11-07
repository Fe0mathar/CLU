import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

/**
 * Localhost-only static dashboard + SSE telemetry bridge.
 *
 * The bridge never executes commands and never writes Murugan. It can replay a durable
 * NDJSON recognition stream written by CLUE, so the browser may connect before, during,
 * or after a scan and receive the same graph truth.
 */
export class NavigatorSseServer {
  constructor(options = {}) {
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 47831,
      path: options.path ?? '/navigator/events',
      publishPath: options.publishPath ?? '/navigator/publish',
      statusPath: options.statusPath ?? '/navigator/status',
      staticRoot: options.staticRoot ? resolve(options.staticRoot) : null,
      eventFile: options.eventFile ? resolve(options.eventFile) : null,
      replayLimit: options.replayLimit ?? 100000,
      heartbeatMs: options.heartbeatMs ?? 15000,
      pollMs: options.pollMs ?? 180,
      maximumPostBytes: options.maximumPostBytes ?? 4 * 1024 * 1024,
      ...options,
    };
    this.server = null;
    this.clients = new Map();
    this.replay = [];
    this.heartbeat = null;
    this.poller = null;
    this.fileOffset = 0;
    this.partialLine = '';
    this.polling = false;
    this.published = 0;
  }

  async start() {
    if (this.server) return this.urls();
    await this.#loadExistingEventFile();
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise((resolveStart, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off('error', reject);
        resolveStart();
      });
    });
    this.heartbeat = setInterval(() => {
      for (const response of this.clients.values()) response.write(': heartbeat\n\n');
    }, this.options.heartbeatMs);
    this.heartbeat.unref?.();

    if (this.options.eventFile) {
      this.poller = setInterval(() => void this.#pollEventFile(), this.options.pollMs);
      this.poller.unref?.();
    }
    return this.urls();
  }

  async stop() {
    if (!this.server) return;
    clearInterval(this.heartbeat);
    clearInterval(this.poller);
    for (const response of this.clients.values()) response.end();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    await new Promise((resolveStop) => server.close(resolveStop));
  }

  publish(event) {
    this.#publishSerialized(JSON.stringify(event));
  }

  urls() {
    const base = `http://${this.options.host}:${this.options.port}`;
    return {
      base,
      dashboard: `${base}/`,
      events: `${base}${this.options.path}`,
      status: `${base}${this.options.statusPath}`,
    };
  }

  #publishSerialized(serialized, recordReplay = true) {
    const trimmed = String(serialized).trim();
    if (!trimmed) return;
    // Reject corrupt lines before they poison every connected projection.
    try {
      JSON.parse(trimmed);
    } catch {
      return;
    }
    if (recordReplay) {
      this.replay.push(trimmed);
      if (this.replay.length > this.options.replayLimit) {
        this.replay.splice(0, this.replay.length - this.options.replayLimit);
      }
    }
    this.published += 1;
    const frame = `data: ${trimmed}\n\n`;
    for (const [id, response] of this.clients) {
      try {
        response.write(frame);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  async #loadExistingEventFile() {
    const path = this.options.eventFile;
    if (!path || !existsSync(path)) return;
    const content = await readFile(path, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    this.replay = lines.slice(-this.options.replayLimit);
    this.fileOffset = Buffer.byteLength(content, 'utf8');
    this.partialLine = '';
  }

  async #pollEventFile() {
    if (this.polling) return;
    this.polling = true;
    try {
      const path = this.options.eventFile;
      if (!path || !existsSync(path)) return;
      const info = await stat(path);
      if (info.size < this.fileOffset) {
        // A new scan truncates the stream. New clients must see only the new truth.
        this.fileOffset = 0;
        this.partialLine = '';
        this.replay.length = 0;
      }
      if (info.size === this.fileOffset) return;

      const handle = await open(path, 'r');
      try {
        const length = info.size - this.fileOffset;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.fileOffset);
        this.fileOffset += bytesRead;
        const text = this.partialLine + buffer.subarray(0, bytesRead).toString('utf8');
        const lines = text.split(/\r?\n/);
        this.partialLine = lines.pop() ?? '';
        for (const line of lines) this.#publishSerialized(line);
      } finally {
        await handle.close();
      }
    } catch {
      // The file may be replaced between stat and open. The next poll retries.
    } finally {
      this.polling = false;
    }
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

    if (request.method === 'GET' && requestUrl.pathname === this.options.path) {
      this.#openSse(request, response);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === this.options.statusPath) {
      this.#sendJson(response, {
        ok: true,
        clients: this.clients.size,
        replay: this.replay.length,
        published: this.published,
        eventFile: this.options.eventFile,
        fileOffset: this.fileOffset,
      });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === this.options.publishPath) {
      await this.#acceptPublish(request, response);
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      await this.#serveStatic(requestUrl.pathname, request, response);
      return;
    }

    response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Method not allowed.');
  }

  #openSse(request, response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': request.headers.origin || '*',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 1500\n\n');
    for (const serialized of this.replay) response.write(`data: ${serialized}\n\n`);
    const id = randomUUID();
    this.clients.set(id, response);
    request.on('close', () => this.clients.delete(id));
  }

  async #acceptPublish(request, response) {
    let total = 0;
    const chunks = [];
    for await (const chunk of request) {
      total += chunk.length;
      if (total > this.options.maximumPostBytes) {
        response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Payload too large.');
        return;
      }
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const events = Array.isArray(body) ? body : [body];
      for (const event of events) this.publish(event);
      this.#sendJson(response, { ok: true, accepted: events.length });
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  }

  async #serveStatic(pathname, request, response) {
    const root = this.options.staticRoot;
    if (!root) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Static root is not configured.');
      return;
    }

    const requested = pathname === '/' ? '/demo/index.html' : decodeURIComponent(pathname);
    const candidate = resolve(root, `.${requested}`);
    const traversal = relative(root, candidate);
    if (traversal.startsWith(`..${sep}`) || traversal === '..' || traversal.includes(`..${sep}`)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Forbidden.');
      return;
    }
    let target = candidate;
    let targetStat = await stat(target).catch(() => null);
    if (targetStat?.isDirectory()) {
      // A directory route (e.g. /demo/) serves its index.html; a directory without
      // one is 404. Reading a directory raw raises EISDIR on the stream, which —
      // unhandled — killed the whole server (observed on the Windows host, D-011).
      target = resolve(target, 'index.html');
      targetStat = await stat(target).catch(() => null);
    }
    if (!targetStat || !targetStat.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found.');
      return;
    }

    const extension = extname(target).toLowerCase();
    response.writeHead(200, {
      'content-type': MIME[extension] ?? 'application/octet-stream',
      'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=60',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(target);
    stream.on('error', () => {
      // Defence in depth: a read failure (file removed mid-request, permissions)
      // must end this response only — an unhandled stream error is fatal to Node.
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end();
    });
    stream.pipe(response);
  }

  #sendJson(response, value) {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value));
  }
}
