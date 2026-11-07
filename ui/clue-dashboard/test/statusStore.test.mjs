/**
 * `DEV-P1-16` — the shell's one sealed Status store.
 *
 * `ui/` has never had a test that executes it, because the dashboard is browser code and nothing
 * in a session can run a browser. It does not have to: the store takes its transports as
 * parameters, so the real module runs here against a fake status endpoint and a fake event
 * source. What cannot be proven this way is that the pixels are right — that stays the Creator's
 * acceptance — but everything about what the store *holds* can be.
 *
 * The assertions are mostly about refusals. §20.1's constraint is that the shell must not recreate
 * state locally, and the Status Contract's length is spent keeping `unsupported`, `unavailable`,
 * `stale` and a real zero apart. A store that substituted one for another would undo that at the
 * last hop, where no server-side test can see.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStatusStore } from '../state/statusStore.js';

const SCHEMA = '5.1.0';

/** A sealed body of the shape the projector emits: backed, unsupported and stale side by side. */
function body(overrides = {}) {
  return {
    schemaVersion: SCHEMA,
    target: { targetId: 'alpha', canonicalRoot: 'F:\\Targets\\Alpha' },
    repositoryInventory: { state: 'backed', fileCount: 600 },
    benchmark: { state: 'unsupported', reason: 'no src/benchmark/ domain in this build' },
    golden: { state: 'unavailable', reason: 'src/metrics/golden/ is absent' },
    versionControl: { state: 'stale', reason: 'head moved past the projection', ageMs: 90_000 },
    ...overrides,
  };
}

/** A controllable stand-in for EventSource. */
function fakeEventSource() {
  const handlers = { message: [], error: [] };
  let closed = false;
  return {
    source: {
      addEventListener(type, listener) {
        (handlers[type] ??= []).push(listener);
      },
      close() {
        closed = true;
      },
    },
    emit(frame) {
      for (const listener of handlers.message) listener({ data: JSON.stringify(frame) });
    },
    fail() {
      for (const listener of handlers.error) listener({});
    },
    get closed() {
      return closed;
    },
  };
}

function harness(responses) {
  const calls = [];
  const events = fakeEventSource();
  const store = createStatusStore({
    fetchJson: async (url) => {
      calls.push(url);
      const responder = responses[url];
      if (responder === undefined) throw new Error(`no stub for ${url}`);
      return typeof responder === 'function' ? responder() : responder;
    },
    createEventSource: () => events.source,
  });
  return { store, events, calls };
}

test('DEV-P1-16: the store holds the sealed body and reports each branch as written', async () => {
  const { store } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': body(),
  });

  assert.equal(store.get().state, 'idle');
  await store.refresh();

  const state = store.get();
  assert.equal(state.state, 'ready');
  assert.equal(state.schemaVersion, SCHEMA);

  // Each of the four states survives the hop intact. This is the whole job.
  assert.deepEqual(store.branch('repositoryInventory'), { state: 'backed', fileCount: 600 });
  assert.equal(store.branch('benchmark').state, 'unsupported');
  assert.equal(store.branch('golden').state, 'unavailable');
  assert.equal(store.branch('versionControl').state, 'stale');
  assert.match(store.branch('benchmark').reason, /no src\/benchmark/);

  assert.deepEqual(store.branchNames(), [
    'benchmark',
    'golden',
    'repositoryInventory',
    'schemaVersion',
    'target',
    'versionControl',
  ]);
});

test('DEV-P1-16: an absent branch is a named state, never undefined', async () => {
  const { store } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': body(),
  });
  await store.refresh();

  const missing = store.branch('cycle');
  // `undefined` is what a caller writes `?? 0` after, and a fabricated zero is the failure the
  // Status Contract is largely about. A named state cannot be defaulted away by accident.
  assert.notEqual(missing, undefined);
  assert.equal(missing.state, 'unknown-branch');
  assert.match(missing.reason, /declares no branch "cycle"/);
});

test('DEV-P1-16: a body whose schema disagrees with the server is refused, not rendered', async () => {
  const { store } = harness({
    '/api/status/schema': { schemaVersion: '5.1.0' },
    '/api/status/current': body({ schemaVersion: '5.0.0' }),
  });
  await store.refresh();

  const state = store.get();
  assert.equal(state.state, 'schema-mismatch');
  assert.match(state.reason, /body is 5\.0\.0, server declares 5\.1\.0/);
  // Nothing was adopted: a dashboard drawing a 5.0.0 body under 5.1.0 labels is worse than one
  // showing nothing, because the operator cannot tell.
  assert.equal(state.body, null);
  assert.equal(store.branch('repositoryInventory').state, 'unavailable');
});

test('DEV-P1-16: a failed read keeps the last body and labels it, rather than clearing it', async () => {
  let fail = false;
  const { store } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': () => {
      if (fail) throw new Error('ECONNREFUSED');
      return body();
    },
  });
  await store.refresh();
  assert.equal(store.get().state, 'ready');

  fail = true;
  await store.refresh();

  const state = store.get();
  assert.equal(state.state, 'unreachable');
  assert.match(state.reason, /ECONNREFUSED/);
  // Replacing a stale answer with no answer is a loss, which is why §18 labels staleness rather
  // than discarding it. The body survives; the state says not to trust its age.
  assert.equal(store.branch('repositoryInventory').fileCount, 600);
});

test('DEV-P1-16: a new frame revision re-reads Status; a repeated one does not', async () => {
  let reads = 0;
  const { store, events } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': () => {
      reads += 1;
      return body();
    },
  });

  store.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, 'connecting reads once');

  events.emit({ revision: 7, seal: { snapshotHash: 'a'.repeat(64) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(store.get().revision, 7);

  // The same revision again is not a change. Re-reading on every frame would put the store's
  // load in proportion to the console's animation rate rather than to actual state change.
  events.emit({ revision: 7, seal: { snapshotHash: 'a'.repeat(64) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);

  store.disconnect();
  assert.equal(events.closed, true);
});

test('DEV-P1-16: the store never reads a value out of the frame, only its revision', async () => {
  const { store, events } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': body(),
  });
  store.connect();
  await new Promise((resolve) => setImmediate(resolve));

  // A frame carrying a contradictory dashboard projection must not become Status. ADR-0002 makes
  // these two views of one workspace; the frame is the change signal, Status is the authority.
  events.emit({
    revision: 2,
    seal: { snapshotHash: 'b'.repeat(64) },
    snapshot: { dashboard: { repositoryInventory: { state: 'backed', fileCount: 999999 } } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.branch('repositoryInventory').fileCount, 600, 'Status won, not the frame');
  assert.equal(store.get().seal.snapshotHash, 'b'.repeat(64), 'the seal travels, as read');
});

test('DEV-P1-16: one failing subscriber neither silences the others nor escapes', async () => {
  const { store } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': body(),
  });

  const seen = [];
  store.subscribe(() => {
    throw new Error('a subscriber fault');
  });
  store.subscribe((state) => seen.push(state.state));

  await assert.doesNotReject(async () => store.refresh());
  assert.deepEqual(seen, ['ready']);
});

test('DEV-P1-16: what a consumer reads is frozen, so the store cannot be written through', async () => {
  const { store } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': body(),
  });
  await store.refresh();

  const state = store.get();
  assert.throws(() => {
    'use strict';
    state.state = 'ready-ish';
  });
  assert.equal(store.get().state, 'ready');
});


test('PP-20: Status target switching advances one project generation and drops the old frame seal', async () => {
  let active = body();
  const { store, events } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': () => active,
  });

  store.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.projectIdentity(), {
    projectId: 'alpha',
    canonicalRoot: 'F:\\Targets\\Alpha',
    key: JSON.stringify(['alpha', 'f:/targets/alpha']),
  });
  assert.equal(store.get().projectRevision, 1);

  events.emit({ revision: 9, seal: { snapshotHash: 'a'.repeat(64) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get().revision, 9);

  active = body({
    target: { targetId: 'beta', canonicalRoot: 'F:\\Targets\\Beta' },
  });
  await store.refresh();

  assert.equal(store.get().projectRevision, 2);
  assert.equal(store.get().revision, null, 'Project A frame revision is not Project B state');
  assert.equal(store.get().seal, null, 'Project A frame seal is not Project B evidence');
  assert.equal(store.projectIdentity()?.projectId, 'beta');
});

test('PP-20: a re-read of the same target does not manufacture a project switch', async () => {
  const { store } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': body(),
  });
  await store.refresh();
  await store.refresh();
  assert.equal(store.get().projectRevision, 1);
});


test('PP-20: losing the Status target invalidates the old project frame boundary', async () => {
  let active = body();
  const { store, events } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': () => active,
  });

  store.connect();
  await new Promise((resolve) => setImmediate(resolve));
  events.emit({ revision: 11, seal: { snapshotHash: 'd'.repeat(64) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get().revision, 11);

  active = body({ target: null });
  await store.refresh();

  assert.equal(store.get().projectRevision, 2);
  assert.equal(store.get().projectIdentity, null);
  assert.equal(store.get().revision, null);
  assert.equal(store.get().seal, null);
});


test('PP-20: a Project B frame cannot be paired transiently with Project A Status', async () => {
  let active = body();
  const { store, events } = harness({
    '/api/status/schema': { schemaVersion: SCHEMA },
    '/api/status/current': () => active,
  });
  store.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.projectIdentity()?.projectId, 'alpha');

  active = body({ target: { targetId: 'beta', canonicalRoot: 'F:\\Targets\\Beta' } });
  events.emit({
    revision: 20,
    seal: { snapshotHash: 'e'.repeat(64) },
    snapshot: {
      configuration: {
        project: {
          activeProject: { operationIdentity: { projectId: 'beta' } },
        },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.projectIdentity()?.projectId, 'beta');
  assert.equal(store.get().revision, null, 'B seal was not adopted while A body was current');
  assert.equal(store.get().seal, null);

  events.emit({
    revision: 21,
    seal: { snapshotHash: 'f'.repeat(64) },
    snapshot: {
      configuration: {
        project: {
          activeProject: { operationIdentity: { projectId: 'beta' } },
        },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get().revision, 21);
  assert.equal(store.get().seal.snapshotHash, 'f'.repeat(64));
});
