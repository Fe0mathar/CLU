/**
 * `DEV-P1-17` — the two-tab shell.
 *
 * A minimal element stand-in records what was written to it, which is enough to hold the whole
 * obligation: "exactly two top-level tabs, accessible focus/landmarks" is a statement about
 * attributes and focus, and both are observable without a browser. What is not observable here is
 * whether it looks right, which stays the Creator's acceptance.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { TOP_LEVEL_TABS, createTabShell } from '../components/tabShell.js';

/** Records attributes and focus, as a real element would expose them. */
function fakeElement(name, id) {
  const attributes = new Map();
  if (id !== undefined) attributes.set('id', id);
  return {
    name,
    focused: 0,
    setAttribute(key, value) {
      attributes.set(key, String(value));
    },
    removeAttribute(key) {
      attributes.delete(key);
    },
    getAttribute(key) {
      return attributes.has(key) ? attributes.get(key) : null;
    },
    has(key) {
      return attributes.has(key);
    },
    focus() {
      this.focused += 1;
    },
  };
}

function shell(options = {}) {
  const parts = {
    dashboardTab: fakeElement('dashboardTab'),
    dashboardPanel: fakeElement('dashboardPanel'),
    configurationTab: fakeElement('configurationTab'),
    configurationPanel: fakeElement('configurationPanel'),
  };
  const instance = createTabShell({
    tabs: [
      { id: 'dashboard', tab: parts.dashboardTab, panel: parts.dashboardPanel },
      { id: 'configuration', tab: parts.configurationTab, panel: parts.configurationPanel },
    ],
    ...options,
  });
  return { ...parts, shell: instance };
}

test('DEV-P1-17: a third tab is refused, by name and with the count', () => {
  const tab = () => fakeElement('t');
  assert.throws(
    () =>
      createTabShell({
        tabs: [
          { id: 'dashboard', tab: tab(), panel: tab() },
          { id: 'configuration', tab: tab(), panel: tab() },
          { id: 'diagnostics', tab: tab(), panel: tab() },
        ],
      }),
    /exactly two top-level tabs \(Directory §20.1\); received 3/,
  );

  // One is equally wrong, and an unrecognised name is not a top-level tab at all.
  assert.throws(() => createTabShell({ tabs: [{ id: 'dashboard', tab: tab(), panel: tab() }] }), /received 1/);
  assert.throws(
    () =>
      createTabShell({
        tabs: [
          { id: 'dashboard', tab: tab(), panel: tab() },
          { id: 'diagnostics', tab: tab(), panel: tab() },
        ],
      }),
    /"diagnostics" is not a top-level tab/,
  );
  assert.deepEqual(TOP_LEVEL_TABS, ['dashboard', 'configuration']);
});

test('DEV-P1-17: roles and relationships are written onto the elements', () => {
  const s = shell();

  assert.equal(s.dashboardTab.getAttribute('role'), 'tab');
  assert.equal(s.dashboardTab.getAttribute('aria-controls'), 'panel-dashboard');
  assert.equal(s.dashboardPanel.getAttribute('role'), 'tabpanel');
  assert.equal(s.dashboardPanel.getAttribute('aria-labelledby'), 'tab-dashboard');
  // A panel that cannot be reached by name is a panel a screen reader announces as nothing.
  assert.equal(s.configurationPanel.getAttribute('id'), 'panel-configuration');
});

test('DEV-P1-17: an element that already has an id keeps it', () => {
  const dashboardTab = fakeElement('dashboardTab', 'tabDashboard');
  const dashboardPanel = fakeElement('dashboardPanel', 'grid');
  const configurationTab = fakeElement('configurationTab', 'tabConfiguration');
  const configurationPanel = fakeElement('configurationPanel', 'cfg');

  createTabShell({
    tabs: [
      { id: 'dashboard', tab: dashboardTab, panel: dashboardPanel },
      { id: 'configuration', tab: configurationTab, panel: configurationPanel },
    ],
  });

  // Handed the live dashboard, overwriting these renamed `#grid` to `#panel-dashboard`. Every
  // stylesheet rule keyed on it stopped matching — including the one giving the quadrants their
  // grid — and every getElementById('grid') afterwards returned null.
  assert.equal(dashboardPanel.getAttribute('id'), 'grid');
  assert.equal(configurationPanel.getAttribute('id'), 'cfg');
  assert.equal(dashboardTab.getAttribute('id'), 'tabDashboard');

  // The relationships point at the ids the elements actually answer to.
  assert.equal(dashboardTab.getAttribute('aria-controls'), 'grid');
  assert.equal(dashboardPanel.getAttribute('aria-labelledby'), 'tabDashboard');
  assert.equal(configurationTab.getAttribute('aria-controls'), 'cfg');
});

test('DEV-P1-17: exactly one tab is selected, and the other panel is hidden', () => {
  const s = shell();

  assert.equal(s.dashboardTab.getAttribute('aria-selected'), 'true');
  assert.equal(s.configurationTab.getAttribute('aria-selected'), 'false');
  assert.equal(s.dashboardPanel.has('hidden'), false);
  assert.equal(s.configurationPanel.has('hidden'), true);

  s.shell.select('configuration');

  assert.equal(s.dashboardTab.getAttribute('aria-selected'), 'false');
  assert.equal(s.configurationTab.getAttribute('aria-selected'), 'true');
  assert.equal(s.dashboardPanel.has('hidden'), true);
  assert.equal(s.configurationPanel.has('hidden'), false);
});

test('DEV-P1-17: the tablist is one tab stop, not two', () => {
  const s = shell();

  // Both focusable puts every panel behind an extra Tab press and makes the arrow keys dead —
  // backwards, since arrows are how a tablist is meant to be driven.
  assert.equal(s.dashboardTab.getAttribute('tabindex'), '0');
  assert.equal(s.configurationTab.getAttribute('tabindex'), '-1');

  s.shell.select('configuration');

  assert.equal(s.dashboardTab.getAttribute('tabindex'), '-1');
  assert.equal(s.configurationTab.getAttribute('tabindex'), '0');
});

test('DEV-P1-17: arrows move between tabs and take focus with them', () => {
  const s = shell();

  assert.equal(s.shell.handleKey({ key: 'ArrowRight' }), true);
  assert.equal(s.shell.current(), 'configuration');
  // Focus must follow, or the next arrow press starts from the wrong place.
  assert.equal(s.configurationTab.focused, 1);

  assert.equal(s.shell.handleKey({ key: 'ArrowRight' }), true, 'wraps');
  assert.equal(s.shell.current(), 'dashboard');

  assert.equal(s.shell.handleKey({ key: 'ArrowLeft' }), true);
  assert.equal(s.shell.current(), 'configuration');

  assert.equal(s.shell.handleKey({ key: 'Home' }), true);
  assert.equal(s.shell.current(), 'dashboard');
  assert.equal(s.shell.handleKey({ key: 'End' }), true);
  assert.equal(s.shell.current(), 'configuration');

  assert.equal(s.shell.handleKey({ key: 'q' }), false, 'an unrelated key is not consumed');
  assert.equal(s.shell.current(), 'configuration');
});

test('DEV-P1-17: a programmatic selection does not steal focus', () => {
  const s = shell();

  s.shell.select('configuration');

  // Restoring a remembered tab on load must not take focus from wherever the operator is.
  assert.equal(s.configurationTab.focused, 0);
  assert.equal(s.shell.current(), 'configuration');
});

test('DEV-P1-17: onChange fires on a real change only, and a throwing listener is contained', () => {
  const seen = [];
  const s = shell({
    onChange: (id) => {
      seen.push(id);
      if (id === 'configuration') throw new Error('a listener fault');
    },
  });

  assert.doesNotThrow(() => s.shell.select('configuration'));
  s.shell.select('configuration');

  assert.deepEqual(seen, ['configuration'], 'selecting what is selected changes nothing');
  // The tab still changed even though the listener failed; the DOM is the record, not the callback.
  assert.equal(s.configurationTab.getAttribute('aria-selected'), 'true');
});

test('DEV-P1-17: an unknown tab is refused and the selection is untouched', () => {
  const s = shell();

  const result = s.shell.select('diagnostics');

  assert.match(result.refused, /"diagnostics" is not one of dashboard, configuration/);
  assert.equal(s.shell.current(), 'dashboard');
});

test('DEV-P1-17: state lives in the DOM, so nothing can drift from it', () => {
  const s = shell({ initial: 'configuration' });

  // Something else writes the attribute behind the shell's back, as a stray script would.
  s.dashboardPanel.removeAttribute('hidden');
  s.shell.select('configuration');
  s.shell.select('dashboard');
  s.shell.select('configuration');

  // Every change rewrites the attributes rather than trusting a remembered value, so the DOM is
  // correct again regardless of what touched it in between.
  assert.equal(s.configurationPanel.has('hidden'), false);
  assert.equal(s.dashboardPanel.has('hidden'), true);
});
