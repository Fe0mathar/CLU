/**
 * `DEV-P1-17` — the shell's density preference.
 *
 * The constraint under test is Directory §3.6's: density is presentation, and it "cannot redefine
 * lifecycle states, measure meaning, Q1 classification, or verdicts." The surface assertions are
 * how that is held — the module can write one attribute and tell subscribers a relayout is due,
 * and that is all it can do.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DENSITY,
  DENSITY_MODES,
  createDensityControl,
} from '../components/densityControl.js';

function fakeRoot() {
  const attributes = new Map();
  return {
    setAttribute(key, value) {
      attributes.set(key, String(value));
    },
    getAttribute(key) {
      return attributes.has(key) ? attributes.get(key) : null;
    },
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
}

test('DEV-P1-17: density is one attribute on the root, applied immediately', () => {
  const root = fakeRoot();
  const control = createDensityControl({ root, storage: null });

  assert.equal(root.getAttribute('data-density'), 'comfortable');
  control.set('compact');
  assert.equal(root.getAttribute('data-density'), 'compact');
  assert.equal(control.current(), 'compact');
});

test('DEV-P1-17: the modes are closed, and an unknown one is refused by name', () => {
  const root = fakeRoot();
  const control = createDensityControl({ root, storage: null });

  const result = control.set('cozy');

  // Clamping "cozy" to something workable would hide the caller's bug under a working screen.
  assert.match(result.refused, /"cozy" is not a density/);
  assert.equal(control.current(), DEFAULT_DENSITY);
  assert.equal(root.getAttribute('data-density'), DEFAULT_DENSITY);
  assert.deepEqual(DENSITY_MODES, ['comfortable', 'compact']);
});

test('DEV-P1-17: the preference persists, and an unrecognised stored value is not applied blind', () => {
  const storage = fakeStorage();
  createDensityControl({ root: fakeRoot(), storage }).set('compact');
  assert.equal(storage.dump()['clue.density'], 'compact');

  const restored = createDensityControl({ root: fakeRoot(), storage });
  assert.equal(restored.current(), 'compact', 'a new session reads the preference back');

  const poisoned = createDensityControl({
    root: fakeRoot(),
    storage: fakeStorage({ 'clue.density': 'ultra-dense' }),
  });
  // Whatever wrote that was not this module; densities are closed.
  assert.equal(poisoned.current(), DEFAULT_DENSITY);
});

test('DEV-P1-17: absent or throwing storage degrades to the default silently', () => {
  const none = createDensityControl({ root: fakeRoot(), storage: null });
  assert.equal(none.current(), DEFAULT_DENSITY);
  assert.equal(none.set('compact').mode, 'compact', 'still a preference for the session');

  const throwing = createDensityControl({
    root: fakeRoot(),
    storage: {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
    },
  });
  assert.equal(throwing.current(), DEFAULT_DENSITY);
  assert.doesNotThrow(() => throwing.toggle());
});

test('DEV-P1-17: subscribers are told the mode so a canvas can relayout, on change only', () => {
  const control = createDensityControl({ root: fakeRoot(), storage: null });
  const seen = [];
  control.subscribe((mode) => seen.push(mode));
  control.subscribe(() => {
    throw new Error('a subscriber fault');
  });

  assert.doesNotThrow(() => control.set('compact'));
  control.set('compact');
  control.toggle();

  assert.deepEqual(seen, ['compact', 'comfortable'], 'setting what is set announces nothing');
});

test('DEV-P1-17: the surface can change presentation and nothing else', () => {
  const control = createDensityControl({ root: fakeRoot(), storage: null });

  // §3.6: density cannot redefine lifecycle states, measure meaning, Q1 classification, or
  // verdicts. The enforcement is that there is nothing here to redefine them *with* — no hook
  // takes content, no callback can veto or filter, no reader is offered to the quadrants.
  assert.deepEqual(Object.keys(control).sort(), ['current', 'modes', 'set', 'subscribe', 'toggle']);
});
