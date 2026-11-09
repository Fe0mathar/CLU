/**
 * `DEV-P1-24` — adversarial source-map fetch policy.
 *
 * The code under analysis chooses `sourceMappingURL`, so the URL, redirect, response headers and
 * body are all untrusted. These tests drive the public `sourceMapFor()` path through a loopback
 * discovery endpoint and fake CDP socket, then replace `fetch` for source maps.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { BrowserAgent } from '../src/experiment/browser/browserAgent.js';

const TARGET = {
  id: 'TARGET-fetch-policy',
  type: 'page',
  title: 'shadow clone',
  url: 'http://localhost:5173/index.html',
};
const SCRIPT_URL = 'http://localhost:5173/assets/app.js';
const VALID_MAP = JSON.stringify({ version: 3, sources: ['app.ts'], names: [], mappings: '' });
const SOURCE_MAP_LIMIT = 32 * 1024 * 1024;

interface MessageEventLike {
  readonly data: unknown;
}

class FakeSocket {
  public static instances: FakeSocket[] = [];
  public static scriptSource = '';

  private readonly messageHandlers: ((event: MessageEventLike) => void)[] = [];
  private readonly openHandlers: (() => void)[] = [];

  public constructor() {
    FakeSocket.instances.push(this);
    setTimeout(() => {
      for (const handler of this.openHandlers) handler();
    }, 0);
  }

  public addEventListener(type: string, listener: unknown): void {
    if (type === 'message') this.messageHandlers.push(listener as (event: MessageEventLike) => void);
    else if (type === 'open') this.openHandlers.push(listener as () => void);
  }

  public send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string };
    let result: Record<string, unknown> = {};
    if (request.method === 'Browser.getVersion') {
      result = {
        product: 'Chrome/test',
        revision: '@fetch-policy',
        protocolVersion: '1.3',
        jsVersion: 'test',
      };
    } else if (request.method === 'Page.getFrameTree') {
      result = {
        frameTree: { frame: { id: 'FRAME-main', loaderId: 'LOADER-main', url: TARGET.url } },
      };
    } else if (request.method === 'Debugger.getScriptSource') {
      result = { scriptSource: FakeSocket.scriptSource };
    }
    setTimeout(() => this.deliver({ id: request.id, result }), 0);
  }

  public event(method: string, params: Record<string, unknown>): void {
    this.deliver({ method, params });
  }

  public close(): void {
    // Nothing to release.
  }

  private deliver(message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const handler of this.messageHandlers) handler({ data });
  }
}

type MapFetch = (url: string, init: RequestInit | undefined) => Promise<Response>;

interface Harness {
  readonly agent: BrowserAgent;
  readonly socket: FakeSocket;
  readonly mapFetchCount: () => number;
  readonly close: () => Promise<void>;
}

async function harness(
  reference: string,
  mapFetch: MapFetch,
  requestTimeoutMs = 250,
): Promise<Harness> {
  const server = createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{
      ...TARGET,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${TARGET.id}`,
    }]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  const originalSocket = (globalThis as Record<string, unknown>)['WebSocket'];
  const originalFetch = globalThis.fetch;
  const restore = async (): Promise<void> => {
    globalThis.fetch = originalFetch;
    (globalThis as Record<string, unknown>)['WebSocket'] = originalSocket;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  let count = 0;

  FakeSocket.instances = [];
  FakeSocket.scriptSource = `console.log('loaded');\n//# sourceMappingURL=${reference}`;
  (globalThis as Record<string, unknown>)['WebSocket'] = FakeSocket;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    count += 1;
    return await mapFetch(url, init);
  }) as typeof fetch;

  try {
    const agent = await BrowserAgent.attach({
      port,
      allowedOrigins: ['http://localhost:*'],
      requestTimeoutMs,
    });
    const socket = FakeSocket.instances[0];
    assert.ok(socket !== undefined);
    socket.event('Debugger.scriptParsed', {
      scriptId: 'SCRIPT-1',
      url: SCRIPT_URL,
      sourceMapURL: reference,
    });

    return {
      agent,
      socket,
      mapFetchCount: () => count,
      close: async () => {
        agent.close();
        await restore();
      },
    };
  } catch (error) {
    await restore();
    throw error;
  }
}

function jsonResponse(
  body = VALID_MAP,
  headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' },
): Response {
  return new Response(body, { status: 200, headers });
}

test('DEV-P1-24: a same-origin JSON source map is accepted once and cached', async () => {
  const h = await harness('app.js.map', async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return jsonResponse();
  });
  try {
    assert.equal(await h.agent.sourceMapFor(SCRIPT_URL), VALID_MAP);
    assert.equal(await h.agent.sourceMapFor(SCRIPT_URL), VALID_MAP);
    assert.equal(h.mapFetchCount(), 1, 'the accepted evidence is stable for the attachment');
  } finally {
    await h.close();
  }
});

test('DEV-P1-24: an off-origin URL cannot disguise its network host as localhost user-info', async () => {
  const h = await harness('http://localhost:5173@evil.example/app.js.map', async () => {
    throw new Error('off-origin fetch must not happen');
  });
  try {
    assert.equal(await h.agent.sourceMapFor(SCRIPT_URL), null);
    assert.equal(h.mapFetchCount(), 0, 'origin policy runs before the network boundary');
  } finally {
    await h.close();
  }
});

test('DEV-P1-24: redirects are refused at the fetch boundary', async () => {
  const h = await harness('redirect.map', async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    throw new TypeError('redirect mode is set to error');
  });
  try {
    assert.equal(await h.agent.sourceMapFor(SCRIPT_URL), null);
    assert.equal(h.mapFetchCount(), 1);
  } finally {
    await h.close();
  }
});

test('DEV-P1-24: an HTML response cannot smuggle application/json inside a parameter', async () => {
  const h = await harness('login.map', async () =>
    jsonResponse('<html>login</html>', {
      'content-type': 'text/html; profile="application/json"',
    }),
  );
  try {
    assert.equal(await h.agent.sourceMapFor(SCRIPT_URL), null);
  } finally {
    await h.close();
  }
});

test('DEV-P1-24: a declared over-budget map is refused before its body is consumed', async () => {
  let readers = 0;
  const response = {
    ok: true,
    redirected: false,
    url: '',
    headers: new Headers({
      'content-type': 'application/json',
      'content-length': String(SOURCE_MAP_LIMIT + 1),
    }),
    body: {
      getReader() {
        readers += 1;
        throw new Error('the body must not be opened');
      },
    },
  } as unknown as Response;
  const h = await harness('declared-large.map', async () => response);
  try {
    assert.equal(await h.agent.sourceMapFor(SCRIPT_URL), null);
    assert.equal(readers, 0, 'the declared bound refuses before reading the body');
  } finally {
    await h.close();
  }
});

test('DEV-P1-24: a chunked map is cancelled as soon as the actual byte budget is exceeded', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const h = await harness('streamed-large.map', async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  try {
    assert.equal(await h.agent.sourceMapFor(SCRIPT_URL), null);
    assert.ok(pulls >= 33, 'the actual streamed count, not a header, crosses the bound');
    assert.equal(cancelled, true, 'the peer is stopped when the evidence is refused');
  } finally {
    await h.close();
  }
});

test('DEV-P1-24: the attachment timeout also bounds later source-map requests', async () => {
  const h = await harness(
    'slow.map',
    async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    100,
  );
  try {
    const result = await Promise.race([
      h.agent.sourceMapFor(SCRIPT_URL),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    assert.equal(result, null, 'the configured attachment timeout applies after attach as well');
  } finally {
    await h.close();
  }
});
