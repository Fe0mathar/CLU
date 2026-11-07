/**
 * DEV-P1-24 identity probe — measures, it does not assert.
 *
 * Stands up a fake CDP endpoint (a stub `fetch` for /json/list and a stub global
 * WebSocket that answers protocol calls), attaches a real BrowserAgent to it with a real
 * OperationalConsoleRecorder, then navigates the fake page and issues one more call.
 *
 * Prints the sourceIds and logicalSessionId of every recorded exchange. Run once with the
 * identity binding present and once reverted; the difference is the proof.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactStore } from '../dist/src/memory/artifactStore.js';
import {
  OperationalConsoleEventStore,
  readOperationalConsoleEvents,
} from '../dist/src/observability/operationalConsole/store.js';
import { OperationalConsoleRecorder } from '../dist/src/observability/operationalConsole/recorder.js';

const TARGET = {
  id: 'TARGET-abc123',
  type: 'page',
  title: 'shadow clone',
  url: 'http://localhost:5173/index.html',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/TARGET-abc123',
};

/** Fake browser: answers the four bootstrap calls and lets us push events. */
class FakeSocket {
  static live = null;

  constructor() {
    this.handlers = { message: [], open: [], close: [], error: [] };
    FakeSocket.live = this;
    setTimeout(() => {
      for (const h of this.handlers.open) h();
    }, 0);
  }

  addEventListener(type, listener) {
    this.handlers[type].push(listener);
  }

  send(data) {
    const { id, method } = JSON.parse(data);
    let result = {};
    if (method === 'Browser.getVersion') {
      result = {
        product: 'Chrome/126.0.6478.127',
        revision: '@a7b3c9d',
        protocolVersion: '1.3',
        jsVersion: '12.6.228',
      };
    } else if (method === 'Page.getFrameTree') {
      result = {
        frameTree: {
          frame: { id: 'FRAME-main', loaderId: 'LOADER-first', url: TARGET.url },
        },
      };
    }
    setTimeout(() => this.deliver({ id, result }), 0);
  }

  deliver(message) {
    const data = JSON.stringify(message);
    for (const h of this.handlers.message) h({ data });
  }

  /** Push a CDP event, as the browser would. */
  event(method, params) {
    this.deliver({ method, params });
  }

  close() {}
}

globalThis.WebSocket = FakeSocket;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/json/list')) {
    return { json: async () => [TARGET] };
  }
  throw new Error(`unexpected fetch: ${String(url)}`);
};

const { BrowserAgent } = await import('../dist/src/experiment/browser/browserAgent.js');

const root = mkdtempSync(join(tmpdir(), 'p1-24-'));
const eventFile = join(root, 'events.ndjson');
const store = OperationalConsoleEventStore.open(eventFile);
const recorder = new OperationalConsoleRecorder(store, new ArtifactStore(join(root, 'blobs')), {
  environment: {},
});

console.log('--- DEV-P1-24 identity probe ---');

const agent = await BrowserAgent.attach({
  port: 9222,
  allowedOrigins: ['http://localhost:*'],
  operationalConsole: recorder,
});

console.log('identity after attach:');
console.log(JSON.stringify(agent.identity(), null, 2));

// The page navigates. A subframe navigates too, and must not overwrite the main loader.
FakeSocket.live.event('Page.frameNavigated', {
  frame: { id: 'FRAME-ad', parentId: 'FRAME-main', loaderId: 'LOADER-iframe', url: 'http://localhost:5173/ad' },
});
FakeSocket.live.event('Page.frameNavigated', {
  frame: { id: 'FRAME-main', loaderId: 'LOADER-second', url: 'http://localhost:5173/run/2' },
});

await agent.evaluate('1 + 1');

console.log('\nidentity after navigation:');
console.log(JSON.stringify(agent.identity(), null, 2));

const events = readOperationalConsoleEvents(eventFile);
console.log(`\nrecorded exchanges: ${events.length}`);
for (const event of events) {
  if (event.kind !== 'request') continue;
  const method = (event.sourceIds ?? []).find((id) => id.startsWith('cdp-method:')) ?? '?';
  console.log(`\n  ${method}`);
  console.log(`    logicalSessionId : ${event.logicalSessionId ?? 'null'}`);
  console.log(`    physicalCallId   : ${event.physicalCallId ?? 'null'}`);
  console.log(`    sourceIds        : ${(event.sourceIds ?? []).join('  ')}`);
}

agent.close();
store.close();
rmSync(root, { recursive: true, force: true });
