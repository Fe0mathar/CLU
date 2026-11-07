/**
 * `DEV-P1-16` — the shared fullscreen contract.
 *
 * A fake document stands in for the browser's fullscreen authority, which is what lets this run
 * headlessly. The interesting cases are the ones where the browser acts without being asked:
 * Escape, a refused request, a policy exit. Those are the ones a private state mirror gets wrong,
 * and they are unreachable by reading the code.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFullscreenContract } from '../fullscreen/fullscreenContract.js';

/** A document whose fullscreen element the test controls, as the browser would. */
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
    /** The browser leaving fullscreen on its own — Escape, a policy, a navigation. */
    browserExits() {
      doc.fullscreenElement = null;
      for (const listener of handlers) listener();
    },
  };
  return doc;
}

/** A window element. `refuse` makes requestFullscreen reject, as a real one can. */
function fakeWindow(doc, { refuse = false, native = true } = {}) {
  const element = {};
  if (native) {
    element.requestFullscreen = async () => {
      if (refuse) throw new Error('fullscreen request refused');
      doc.fullscreenElement = element;
    };
  }
  return element;
}

test('DEV-P1-16: a registered window enters natively and is reported as fullscreen', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });
  const q1 = fakeWindow(doc);
  fs.register('q1', q1);

  const result = await fs.enter('q1');

  assert.deepEqual(result, { entered: true, mode: 'native' });
  assert.deepEqual(fs.current(), { id: 'q1', mode: 'native' });
});

test('DEV-P1-16: a refused native request falls back to soft rather than doing nothing', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });
  fs.register('q2', fakeWindow(doc, { refuse: true }));

  const result = await fs.enter('q2');

  // A window that stayed small after the operator clicked expand would be a lie about a control
  // they just used.
  assert.deepEqual(result, { entered: true, mode: 'soft' });
  assert.deepEqual(fs.current(), { id: 'q2', mode: 'soft' });
});

test('DEV-P1-16: the browser leaving fullscreen is observed, not mirrored', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });
  fs.register('q1', fakeWindow(doc));
  await fs.enter('q1');
  assert.equal(fs.current().id, 'q1');

  // Escape. The page is never asked; a private flag would still say q1 is fullscreen.
  doc.browserExits();

  assert.deepEqual(fs.current(), { id: null, mode: null });
});

test('DEV-P1-16: exactly one window is fullscreen at a time', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });
  fs.register('q1', fakeWindow(doc));
  fs.register('q2', fakeWindow(doc));

  await fs.enter('q1');
  await fs.enter('q2');

  // Two fullscreen windows cannot both occupy the viewport, so the state is not merely undesirable
  // — it is unrenderable, and a contract that allowed it would be describing nothing.
  assert.deepEqual(fs.current(), { id: 'q2', mode: 'native' });
});

test('DEV-P1-16: entering an unregistered window is a named refusal, not a silent return', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });

  const result = await fs.enter('q9');

  assert.equal(result.entered, false);
  assert.match(result.reason, /no window is registered as "q9"/);
  assert.equal(fs.current().id, null);
});

test('DEV-P1-16: enter and leave hooks fire on the right windows, and a throwing one is contained', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });
  const events = [];
  fs.register('q1', fakeWindow(doc), {
    onEnter: () => events.push('q1:enter'),
    onLeave: () => {
      events.push('q1:leave');
      throw new Error('relayout failed');
    },
  });
  fs.register('q2', fakeWindow(doc), { onEnter: () => events.push('q2:enter') });

  await fs.enter('q1');
  await fs.enter('q2');

  // q1's failure while relaying out must not strand the transition: the browser has already moved,
  // and refusing to publish would leave every other window believing q1 is still fullscreen.
  assert.deepEqual(events, ['q1:enter', 'q1:leave', 'q2:enter']);
  assert.deepEqual(fs.current(), { id: 'q2', mode: 'native' });
});

test('DEV-P1-16: Escape releases soft fullscreen; native is the browser\u2019s to release', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });
  fs.register('q3', fakeWindow(doc, { native: false }));
  await fs.enter('q3');
  assert.equal(fs.current().mode, 'soft');

  assert.equal(fs.handleKey({ key: 'a' }), false, 'an unrelated key changes nothing');
  assert.equal(fs.current().id, 'q3');

  assert.equal(fs.handleKey({ key: 'Escape' }), true);
  assert.equal(fs.current().id, null);
});

test('DEV-P1-16: toggle enters, then leaves, and subscribers see both transitions', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });
  fs.register('q4', fakeWindow(doc));
  const seen = [];
  fs.subscribe((next) => seen.push(next.id));

  await fs.toggle('q4');
  await fs.toggle('q4');

  assert.deepEqual(seen, ['q4', null]);
  assert.equal(fs.current().id, null);
});

test('DEV-P1-16: the contract holds no status or selection, so it cannot disturb either', async () => {
  const doc = fakeDocument();
  const fs = createFullscreenContract({ documentLike: doc });
  fs.register('q1', fakeWindow(doc));

  // §10.1.5 requires the same status snapshot and selection identity across the transition. It is
  // met by there being no way to touch them — a save/restore would be a second copy of state the
  // shell is forbidden to keep, and wrong the moment it went stale.
  const surface = Object.keys(fs).sort();
  assert.deepEqual(surface, [
    'current',
    'enter',
    'handleKey',
    'leave',
    'register',
    'subscribe',
    'toggle',
  ]);

  await fs.enter('q1');
  await fs.leave();
  assert.deepEqual(fs.current(), { id: null, mode: null });
});
