import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import test from 'node:test';

import { BrowserAgent, BrowserAgentError } from '../src/experiment/browser/browserAgent.js';

async function withEndpoint(
  handler: RequestListener,
  testEndpoint: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await testEndpoint(address.port);
  } finally {
    const closed = new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    server.closeAllConnections();
    await closed;
  }
}

const target = {
  id: 'clue-test-page',
  type: 'page',
  title: 'Test page',
  url: 'http://127.0.0.1:5179/',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/clue-test-page',
};

test('DevTools discovery uses a dedicated HTTP connection and ignores the process fetch pool', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Global fetch is unavailable'); });
  const remotePorts = new Set<number>();
  await withEndpoint((request, response) => {
    assert.equal(request.url, '/json/list');
    assert.equal(request.method, 'GET');
    assert.ok(request.socket.remotePort);
    remotePorts.add(request.socket.remotePort);
    response.end(JSON.stringify([target]));
  }, async (port) => {
    assert.deepEqual(await BrowserAgent.listTargets('127.0.0.1', port), [target]);
    assert.deepEqual(await BrowserAgent.listTargets('127.0.0.1', port), [target]);
  });
  assert.equal(remotePorts.size, 2);
});

test('DevTools discovery retries a transient reset once', async () => {
  let attempts = 0;
  await withEndpoint((request, response) => {
    attempts += 1;
    if (attempts === 1) request.socket.destroy();
    else response.end(JSON.stringify([target]));
  }, async (port) => {
    assert.deepEqual(await BrowserAgent.listTargets('127.0.0.1', port, 2_000), [target]);
  });
  assert.equal(attempts, 2);
});

test('DevTools discovery exposes a persistent connection reset and does not follow redirects', async () => {
  let attempts = 0;
  await withEndpoint((request) => {
    attempts += 1;
    request.socket.destroy();
  }, async (port) => {
    await assert.rejects(BrowserAgent.listTargets('127.0.0.1', port, 2_000),
      (error) => error instanceof BrowserAgentError && error.code === 'ENDPOINT_UNREACHABLE' && /ECONNRESET/u.test(error.message));
  });
  assert.equal(attempts, 2);

  const paths: (string | undefined)[] = [];
  await withEndpoint((request, response) => {
    paths.push(request.url);
    response.writeHead(302, { Location: '/other' }).end();
  }, async (port) => {
    await assert.rejects(BrowserAgent.listTargets('127.0.0.1', port), /returned HTTP 302/u);
  });
  assert.deepEqual(paths, ['/json/list']);
});

test('DevTools discovery enforces both the response limit and deadline', async () => {
  await withEndpoint((_request, response) => {
    response.end(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
  }, async (port) => {
    await assert.rejects(BrowserAgent.listTargets('127.0.0.1', port, 2_000), /exceeded the response limit/u);
  });
  await withEndpoint((_request, response) => {
    response.writeHead(200).write('[');
  }, async (port) => {
    await assert.rejects(BrowserAgent.listTargets('127.0.0.1', port, 80), /timed out after 80 ms/u);
  });
});
