/**
 * `DEV-P1-24` — browser, profile and navigation identity on recorded exchanges.
 *
 * A loopback HTTP endpoint serves `/json/list`, and a fake WebSocket drives the CDP
 * exchange. This exercises the production attach path without starting Chromium.
 *
 * What is being held: an exchange must name the browser that produced it, the profile
 * endpoint it came through, and the document that was loaded when it happened. Before this,
 * a CDP exchange recorded the method and the bytes, so two agents on two profiles wrote
 * indistinguishable events into one append-only record.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BrowserAgent } from '../src/experiment/browser/browserAgent.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { OperationalConsoleRecorder } from '../src/observability/operationalConsole/recorder.js';
import {
  OperationalConsoleEventStore,
  readOperationalConsoleEvents,
} from '../src/observability/operationalConsole/store.js';

const TARGET = {
  id: 'TARGET-abc123',
  type: 'page',
  title: 'shadow clone',
  url: 'http://localhost:5173/index.html',
};

interface MessageEventLike {
  readonly data: unknown;
}

/**
 * A Chromium that answers the bootstrap calls and lets the test push events.
 *
 * `answerVersion` exists so the test can ask what happens when the browser declines to
 * identify itself, which is the difference between a null and an invented "unknown".
 */
class FakeSocket {
  public static instances: FakeSocket[] = [];
  public static answerVersion = true;
  public frameUrl = TARGET.url;
  public readonly requests: { id: number; method: string; params: Record<string, unknown> }[] = [];

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
    const request = JSON.parse(data) as (typeof this.requests)[number];
    this.requests.push(request);
    let result: Record<string, unknown> = {};
    if (request.method === 'Browser.getVersion') {
      if (!FakeSocket.answerVersion) {
        setTimeout(() => {
          this.deliver({ id: request.id, error: { message: 'not available on this target' } });
        }, 0);
        return;
      }
      result = {
        product: 'Chrome/126.0.6478.127',
        revision: '@a7b3c9d',
        protocolVersion: '1.3',
        jsVersion: '12.6.228',
      };
    } else if (request.method === 'Page.getFrameTree') {
      result = {
        frameTree: { frame: { id: 'FRAME-main', loaderId: 'LOADER-first', url: this.frameUrl } },
      };
    } else if (request.method === 'Runtime.enable') {
      this.event('Runtime.executionContextCreated', {
        context: { id: 1, uniqueId: 'UNIQUE-main', auxData: { isDefault: true, frameId: 'FRAME-main' } },
      });
    } else if (request.method === 'Runtime.evaluate') {
      result = { result: { value: 42 } };
    } else if (request.method === 'Page.getLayoutMetrics') {
      result = { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
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

interface Harness {
  readonly root: string;
  readonly store: OperationalConsoleEventStore;
  readonly recorder: OperationalConsoleRecorder;
  readonly eventFile: string;
  readonly port: number;
  readonly restore: () => Promise<void>;
}

async function harness(
  webSocketUrl = (port: number) => `ws://127.0.0.1:${port}/devtools/page/${TARGET.id}`,
): Promise<Harness> {
  const server = createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{
      ...TARGET,
      webSocketDebuggerUrl: webSocketUrl(port),
    }]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  const originalSocket = (globalThis as Record<string, unknown>)['WebSocket'];

  FakeSocket.instances = [];
  FakeSocket.answerVersion = true;
  (globalThis as Record<string, unknown>)['WebSocket'] = FakeSocket;

  const root = mkdtempSync(join(tmpdir(), 'clue-browser-identity-'));
  const eventFile = join(root, 'console', 'events.ndjson');
  const store = OperationalConsoleEventStore.open(eventFile);
  const recorder = new OperationalConsoleRecorder(store, new ArtifactStore(join(root, 'blobs')), {
    environment: {},
  });

  return {
    root,
    store,
    recorder,
    eventFile,
    port,
    restore: async () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
      (globalThis as Record<string, unknown>)['WebSocket'] = originalSocket;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

const governed = {
  projectIdentity: {
    projectId: 'browser-agent-fixture',
    targetRootIdentity: `path:v1:linux:${'1'.repeat(64)}`,
    projectProfileHash: `profile:v1:${'2'.repeat(64)}`,
  },
  profileGeneration: 1,
  chromeInstanceId: 'CHROME-fixture',
};

test('governed Chrome attachment refuses a debugger socket for a different page or host', async () => {
  for (const webSocketUrl of [
    (port: number) => `ws://127.0.0.1:${port}/devtools/page/other-page`,
    (port: number) => `ws://example.test:${port}/devtools/page/${TARGET.id}`,
  ]) {
    const fixture = await harness(webSocketUrl);
    try {
      await assert.rejects(
        BrowserAgent.attach({ ...attachOptions(fixture), ...governed }),
        { code: 'ORIGIN_REFUSED' },
      );
      assert.equal(FakeSocket.instances.length, 0);
    } finally {
      await fixture.restore();
    }
  }
});

test('strict page controls pin the main world and refuse action after same-origin target drift', async () => {
  const fixture = await harness();
  try {
    const agent = await BrowserAgent.attach({ ...attachOptions(fixture), ...governed });
    try {
      const socket = FakeSocket.instances[0];
      assert.ok(socket);
      const expected = {
        ...governed,
        browserSessionId: agent.identity().sessionId,
        targetPageId: TARGET.id,
        targetUrl: TARGET.url,
      };
      assert.equal(await agent.evaluateGoverned('40 + 2', expected), 42);
      const evaluation = socket.requests.find((request) => request.method === 'Runtime.evaluate');
      assert.equal(evaluation?.params['uniqueContextId'], 'UNIQUE-main');
      assert.match(String(evaluation?.params['expression']), /location\.href/);

      await agent.controlGoverned({ type: 'click', x: 10, y: 15 }, expected);
      const events = () => socket.requests.filter((request) => request.method === 'Input.dispatchMouseEvent');
      assert.deepEqual(events().map((event) => event.params['type']), ['mousePressed', 'mouseReleased']);
      await assert.rejects(agent.controlGoverned({ type: 'click', x: 800, y: 0 }, expected), { code: 'PROTOCOL_ERROR' });

      socket.frameUrl = 'http://localhost:5173/other.html';
      await assert.rejects(agent.controlGoverned({ type: 'click', x: 10, y: 15 }, expected), { code: 'ORIGIN_REFUSED' });
      await assert.rejects(agent.evaluateGoverned('1', expected), { code: 'ORIGIN_REFUSED' });
      assert.equal(events().length, 2);
      assert.equal(socket.requests.filter((request) => request.method === 'Runtime.evaluate').length, 1);
    } finally {
      agent.close();
    }
  } finally {
    await fixture.restore();
  }
});

function attachOptions({ port, recorder }: Harness): {
  port: number;
  allowedOrigins: readonly string[];
  operationalConsole: OperationalConsoleRecorder;
} {
  return { port, allowedOrigins: ['http://localhost:*'], operationalConsole: recorder };
}

/** The source ids of the last request exchange recorded. */
function lastRequestSourceIds(eventFile: string): readonly string[] {
  const requests = readOperationalConsoleEvents(eventFile).filter((event) => event.kind === 'request');
  return requests[requests.length - 1]?.sourceIds ?? [];
}

test('DEV-P1-24: attach binds browser, profile endpoint and the loaded document', async () => {
  const h = await harness();
  try {
    const agent = await BrowserAgent.attach(attachOptions(h));
    const identity = agent.identity();

    assert.equal(identity.endpoint, `127.0.0.1:${h.port}`, 'the profile is the endpoint it listens on');
    assert.equal(identity.targetId, TARGET.id);
    assert.match(identity.sessionId, /^BROWSER-/);
    assert.equal(identity.product, 'Chrome/126.0.6478.127');
    assert.equal(identity.revision, '@a7b3c9d');
    // Read at attach, not on the first navigation: this agent attaches to an already-loaded
    // page, so waiting for a navigation would leave every exchange without a document.
    assert.equal(identity.frameId, 'FRAME-main');
    assert.equal(identity.loaderId, 'LOADER-first');

    agent.close();
  } finally {
    await h.restore();
  }
});

test('DEV-P1-24: every recorded exchange names the session, endpoint and target', async () => {
  const h = await harness();
  try {
    const agent = await BrowserAgent.attach(attachOptions(h));
    const identity = agent.identity();
    const events = readOperationalConsoleEvents(h.eventFile);
    assert.ok(events.length > 0, 'attach records the calls it makes');

    for (const event of events) {
      assert.equal(
        event.logicalSessionId,
        identity.sessionId,
        `event ${event.sequence} is not attributable to a browser session`,
      );
      const ids = event.sourceIds;
      assert.ok(ids.includes(`browser-session:${identity.sessionId}`));
      assert.ok(ids.includes(`browser-endpoint:${identity.endpoint}`));
      assert.ok(ids.includes(`browser-target:${identity.targetId}`));
    }

    agent.close();
  } finally {
    await h.restore();
  }
});

test('DEV-P1-24: a main-frame navigation re-identifies the document; a subframe does not', async () => {
  const h = await harness();
  try {
    const agent = await BrowserAgent.attach(attachOptions(h));
    const socket = FakeSocket.instances[0];
    assert.ok(socket !== undefined);

    // An ad or a widget reloading. Letting this through would attribute the page's output
    // to whatever last happened inside an iframe.
    socket.event('Page.frameNavigated', {
      frame: {
        id: 'FRAME-ad',
        parentId: 'FRAME-main',
        loaderId: 'LOADER-iframe',
        url: 'http://localhost:5173/ad',
      },
    });
    assert.equal(agent.identity().loaderId, 'LOADER-first', 'a subframe is not the document');

    socket.event('Page.frameNavigated', {
      frame: { id: 'FRAME-main', loaderId: 'LOADER-second', url: 'http://localhost:5173/run/2' },
    });
    const identity = agent.identity();
    assert.equal(identity.loaderId, 'LOADER-second');
    assert.equal(identity.frameUrl, 'http://localhost:5173/run/2');

    await agent.evaluate('1 + 1');
    const ids = lastRequestSourceIds(h.eventFile);
    assert.ok(ids.includes('page-loader:LOADER-second'), 'the exchange names the current document');
    assert.ok(!ids.includes('page-loader:LOADER-iframe'));
    assert.ok(!ids.includes('page-loader:LOADER-first'), 'and not the one it replaced');

    agent.close();
  } finally {
    await h.restore();
  }
});

test('DEV-P1-24: two agents on one page are distinguishable in one record', async () => {
  const h = await harness();
  try {
    const first = await BrowserAgent.attach(attachOptions(h));
    const second = await BrowserAgent.attach(attachOptions(h));

    assert.notEqual(
      first.identity().sessionId,
      second.identity().sessionId,
      'this is the defect the item names: indistinguishable concurrent agents',
    );

    const sessions = new Set(
      readOperationalConsoleEvents(h.eventFile).map((event) => event.logicalSessionId),
    );
    assert.equal(sessions.size, 2, 'both sessions are separable in the append-only record');

    first.close();
    second.close();
  } finally {
    await h.restore();
  }
});

test('DEV-P1-24: a browser that declines to identify itself leaves null, not "unknown"', async () => {
  const h = await harness();
  try {
    FakeSocket.answerVersion = false;
    const agent = await BrowserAgent.attach(attachOptions(h));
    const identity = agent.identity();

    assert.equal(identity.product, null, 'a value the protocol never gave is absent, not invented');
    assert.equal(identity.revision, null);
    // The rest still binds: a browser that will not name itself is still on this endpoint,
    // driving this target, on this document.
    assert.equal(identity.endpoint, `127.0.0.1:${h.port}`);
    assert.equal(identity.loaderId, 'LOADER-first');

    const ids = lastRequestSourceIds(h.eventFile);
    assert.ok(!ids.some((id) => id.startsWith('browser-product:')), 'no empty product id is emitted');
    assert.ok(ids.includes('page-loader:LOADER-first'));

    agent.close();
  } finally {
    await h.restore();
  }
});
