/**
 * `DEV-P1-16` — the quadrant selection and cross-highlighting bus.
 *
 * The assertions here are mostly about what the bus refuses to carry. §20.1 forbids the shell
 * recreating quadrant state locally, and a highlighting bus is the natural place for that to
 * happen by accident: publishing the selected *object* would be more convenient at every call
 * site and would hand each quadrant a copy of another's state.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSelectionBus, selectionIdentity } from '../state/selectionBus.js';

test('DEV-P1-16: a selection carries identity and nothing else', () => {
  const bus = createSelectionBus();
  const file = selectionIdentity('q1', 'file', 'src/world.ts');

  bus.select(file);

  assert.deepEqual(bus.get().selection, { quadrant: 'q1', kind: 'file', id: 'src/world.ts' });
  // Three fields, and no fourth. An entity published here would age in every quadrant that
  // received it, and two panels would disagree about one thing with no way to say which was right.
  assert.deepEqual(Object.keys(bus.get().selection).sort(), ['id', 'kind', 'quadrant']);
});

test('DEV-P1-16: cross-highlighting is asked of quadrants, not known by the bus', () => {
  const bus = createSelectionBus();
  bus.registerResolver('q2', (selection) =>
    selection.kind === 'file' ? [{ kind: 'measure', id: 'MH03' }] : [],
  );
  bus.registerResolver('q3', () => []);

  bus.select(selectionIdentity('q1', 'file', 'src/world.ts'));

  assert.deepEqual(bus.highlightsFor('q2'), [{ quadrant: 'q2', kind: 'measure', id: 'MH03' }]);
  // Nothing related is a recorded answer, not an absence of one.
  assert.deepEqual(bus.highlightsFor('q3'), []);
  assert.equal(bus.failureFor('q3'), null);
});

test('DEV-P1-16: the originating quadrant is never told to highlight its own selection', () => {
  const bus = createSelectionBus();
  let asked = 0;
  bus.registerResolver('q1', () => {
    asked += 1;
    return [{ kind: 'file', id: 'src/world.ts' }];
  });

  bus.select(selectionIdentity('q1', 'file', 'src/world.ts'));

  assert.equal(asked, 0, 'q1 owns the selection');
  assert.deepEqual(bus.highlightsFor('q1'), []);
});

test('DEV-P1-16: a resolver that fails is recorded as failed, not as finding nothing', () => {
  const bus = createSelectionBus();
  bus.registerResolver('q2', () => {
    throw new Error('projection unavailable');
  });
  bus.registerResolver('q4', () => [{ kind: 'exchange', id: 'EXC-1' }]);

  bus.select(selectionIdentity('q1', 'file', 'src/world.ts'));

  // A broken panel read as an empty one is the failure this separation prevents.
  assert.match(bus.failureFor('q2'), /projection unavailable/);
  assert.deepEqual(bus.highlightsFor('q2'), []);
  // And one failure does not cost the others their answer.
  assert.deepEqual(bus.highlightsFor('q4'), [{ quadrant: 'q4', kind: 'exchange', id: 'EXC-1' }]);
});

test('DEV-P1-16: selecting what is already selected publishes nothing', () => {
  const bus = createSelectionBus();
  let published = 0;
  bus.subscribe(() => {
    published += 1;
  });

  const file = selectionIdentity('q1', 'file', 'src/world.ts');
  bus.select(file);
  assert.equal(published, 1);

  // A distinct object with the same three fields is the same selection.
  bus.select(selectionIdentity('q1', 'file', 'src/world.ts'));
  assert.equal(published, 1, 'clicking the same thing twice must not redraw every quadrant');

  bus.select(selectionIdentity('q1', 'file', 'src/other.ts'));
  assert.equal(published, 2);
});

test('DEV-P1-16: clearing drops the selection and every highlight with it', () => {
  const bus = createSelectionBus();
  bus.registerResolver('q2', () => [{ kind: 'measure', id: 'MH03' }]);
  bus.select(selectionIdentity('q1', 'file', 'src/world.ts'));
  assert.equal(bus.highlightsFor('q2').length, 1);

  bus.clear();

  assert.equal(bus.get().selection, null);
  assert.deepEqual(bus.highlightsFor('q2'), [], 'a highlight without a selection is a ghost');
  assert.equal(bus.clear(), bus.get(), 'clearing twice publishes nothing');
});

test('DEV-P1-16: refresh re-asks, so a quadrant whose data changed is not left stale', () => {
  const bus = createSelectionBus();
  let related = [];
  bus.registerResolver('q2', () => related);
  bus.select(selectionIdentity('q1', 'file', 'src/world.ts'));
  assert.deepEqual(bus.highlightsFor('q2'), []);

  related = [{ kind: 'measure', id: 'MG08' }];
  bus.refresh();

  assert.deepEqual(bus.highlightsFor('q2'), [{ quadrant: 'q2', kind: 'measure', id: 'MG08' }]);
});

test('DEV-P1-16: one failing subscriber neither silences the others nor escapes', () => {
  const bus = createSelectionBus();
  const seen = [];
  bus.subscribe(() => {
    throw new Error('a subscriber fault');
  });
  bus.subscribe((state) => seen.push(state.selection?.id ?? null));

  assert.doesNotThrow(() => bus.select(selectionIdentity('q1', 'file', 'src/world.ts')));
  assert.deepEqual(seen, ['src/world.ts']);
});

test('DEV-P1-16: what a consumer reads is frozen, so the bus cannot be written through', () => {
  const bus = createSelectionBus();
  bus.registerResolver('q2', () => [{ kind: 'measure', id: 'MH03' }]);
  bus.select(selectionIdentity('q1', 'file', 'src/world.ts'));

  const state = bus.get();
  assert.throws(() => {
    'use strict';
    state.selection = null;
  });
  assert.throws(() => {
    'use strict';
    bus.highlightsFor('q2').push({ quadrant: 'q2', kind: 'measure', id: 'FORGED' });
  });
  assert.equal(bus.highlightsFor('q2').length, 1);
});
