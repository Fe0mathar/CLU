/**
 * `DEV-P1-16` — the quadrant controller contract.
 *
 * Wired to the real store, the real bus and the real fullscreen contract rather than to stubs of
 * them: the seam is only worth anything if the three pieces compose, and three modules that each
 * pass alone can still fail to fit. Only the browser-side transports are faked, because nothing
 * here can run a browser.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQuadrantController } from '../quadrants/quadrantController.js';
import { createSelectionBus } from '../state/selectionBus.js';
import { createStatusStore } from '../state/statusStore.js';
import { createFullscreenContract } from '../fullscreen/fullscreenContract.js';

const SCHEMA = '5.1.0';

function realStore() {
  return createStatusStore({
    fetchJson: async (url) =>
      url.endsWith('/schema')
        ? { schemaVersion: SCHEMA }
        : {
            schemaVersion: SCHEMA,
            repositoryInventory: { state: 'backed', fileCount: 600 },
            benchmark: { state: 'unsupported', reason: 'no src/benchmark/ domain in this build' },
          },
    createEventSource: () => ({ addEventListener() {}, close() {} }),
  });
}

function fakeDocument() {
  const handlers = [];
  const doc = {
    fullscreenElement: null,
    addEventListener(type, listener) {
      if (type === 'fullscreenchange') handlers.push(listener);
    },
    async exitFullscreen() {
      doc.fullscreenElement = null;
      for (const listener of handlers) listener();
    },
  };
  return doc;
}

test('DEV-P1-16: a controller reads the branches it declared', async () => {
  const store = realStore();
  await store.refresh();
  const controller = createQuadrantController({
    id: 'q1',
    store,
    bus: createSelectionBus(),
    branches: ['repositoryInventory'],
  });

  assert.deepEqual(controller.declaredBranches, ['repositoryInventory']);
  assert.deepEqual(controller.context().branch('repositoryInventory'), {
    state: 'backed',
    fileCount: 600,
  });
});

test('DEV-P1-16: reaching for an undeclared branch is refused by name', async () => {
  const store = realStore();
  await store.refresh();
  const controller = createQuadrantController({
    id: 'q1',
    store,
    bus: createSelectionBus(),
    branches: ['repositoryInventory'],
  });

  // §20.1's prohibition, made checkable. The first undeclared read is always reasonable in
  // context; the tenth is a second copy of another quadrant's state.
  assert.throws(
    () => controller.context().branch('benchmark'),
    /q1 did not declare Status branch "benchmark"; declared: repositoryInventory/,
  );
});

test('DEV-P1-16: a controller has no transport, so it cannot fetch its own state', () => {
  const controller = createQuadrantController({
    id: 'q2',
    store: realStore(),
    bus: createSelectionBus(),
  });

  // The six endpoints scattered through app.js are what "a controller that could fetch" looks
  // like after two years. The surface is the argument.
  assert.deepEqual(Object.keys(controller).sort(), [
    'context',
    'declaredBranches',
    'draw',
    'get',
    'id',
    'mount',
    'subscribe',
    'unmount',
  ]);
  const ctx = controller.context();
  assert.deepEqual(Object.keys(ctx).sort(), [
    'branch',
    'branches',
    'highlights',
    'id',
    'select',
    'selection',
    'statusState',
  ]);
});

test('DEV-P1-16: a render that throws fails one quadrant, not the shell', async () => {
  const store = realStore();
  await store.refresh();
  const bus = createSelectionBus();

  const healthy = createQuadrantController({
    id: 'q3',
    store,
    bus,
    render: () => {},
  });
  const broken = createQuadrantController({
    id: 'q4',
    store,
    bus,
    render: () => {
      throw new Error('canvas context lost');
    },
  });
  healthy.mount();
  broken.mount();

  // §10.1.3: failed is an explicit state, not a blank panel.
  assert.equal(broken.get().status, 'failed');
  assert.match(broken.get().reason, /canvas context lost/);
  assert.equal(healthy.get().status, 'ready', 'three working quadrants keep working');

  // And a later store change still reaches the healthy one.
  const before = healthy.get().renders;
  await store.refresh();
  bus.select({ quadrant: 'q1', kind: 'file', id: 'src/world.ts' });
  assert.ok(healthy.get().renders > before);
});

test('DEV-P1-16: selection made in one quadrant highlights another, by identity', async () => {
  const store = realStore();
  await store.refresh();
  const bus = createSelectionBus();

  const q1 = createQuadrantController({ id: 'q1', store, bus, render: () => {} });
  const q2 = createQuadrantController({
    id: 'q2',
    store,
    bus,
    render: () => {},
    resolveRelated: (selection) =>
      selection.kind === 'file' ? [{ kind: 'measure', id: 'MH03' }] : [],
  });
  q1.mount();
  q2.mount();

  q1.context().select('file', 'src/world.ts');

  assert.deepEqual(q2.context().highlights(), [
    { quadrant: 'q2', kind: 'measure', id: 'MH03' },
  ]);
  assert.deepEqual(q1.context().selection, {
    quadrant: 'q1',
    kind: 'file',
    id: 'src/world.ts',
  });
});

test('DEV-P1-16: unmount releases everything, so an unmounted quadrant stops drawing', async () => {
  const store = realStore();
  await store.refresh();
  const bus = createSelectionBus();
  const doc = fakeDocument();
  const fullscreen = createFullscreenContract({ documentLike: doc });

  const controller = createQuadrantController({
    id: 'q1',
    store,
    bus,
    fullscreen,
    element: {},
    render: () => {},
    resolveRelated: () => [{ kind: 'file', id: 'src/world.ts' }],
  });
  controller.mount();
  const drawn = controller.get().renders;

  controller.unmount();

  await store.refresh();
  bus.select({ quadrant: 'q2', kind: 'measure', id: 'MH03' });
  await fullscreen.enter('q1');

  // A quadrant that keeps drawing after it is gone makes hot-swapping a panel impossible, and it
  // is invisible until the second swap.
  assert.equal(controller.get().renders, drawn, 'no draw after unmount');
  assert.equal(controller.get().mounted, false);
  assert.deepEqual(bus.highlightsFor('q1'), [], 'its resolver is gone');
  assert.equal((await fullscreen.enter('q1')).entered, false, 'its fullscreen window is gone');
});

test('DEV-P1-16: entering fullscreen redraws the quadrant and disturbs no state', async () => {
  const store = realStore();
  await store.refresh();
  const bus = createSelectionBus();
  const doc = fakeDocument();
  const fullscreen = createFullscreenContract({ documentLike: doc });
  const panel = {};
  panel.requestFullscreen = async () => {
    doc.fullscreenElement = panel;
  };

  const controller = createQuadrantController({
    id: 'q1',
    store,
    bus,
    fullscreen,
    // The element must actually become the document's fullscreen element, as a real one does:
    // the contract derives its state from the document rather than from the call returning.
    element: panel,
    branches: ['repositoryInventory'],
    render: () => {},
  });
  controller.mount();
  bus.select({ quadrant: 'q1', kind: 'file', id: 'src/world.ts' });
  const before = controller.get().renders;

  await fullscreen.enter('q1');

  assert.ok(controller.get().renders > before, 'the panel relaid out');
  // §10.1.5: the same status snapshot and the same selection identity across the transition.
  assert.equal(controller.context().branch('repositoryInventory').fileCount, 600);
  assert.deepEqual(controller.context().selection, {
    quadrant: 'q1',
    kind: 'file',
    id: 'src/world.ts',
  });
});
