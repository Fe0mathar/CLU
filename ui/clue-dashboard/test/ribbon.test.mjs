import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountRibbon, projectRibbonStatus } from '../components/ribbon.js';
import { createSealReveal } from '../components/ribbonSeal.js';

const hash = (digit) => digit.repeat(64);

function sealHarness(reducedMotion = false) {
  const events = [];
  const timers = new Map();
  let sequence = 0;
  const seal = createSealReveal({
    onStart: (value, previous) => events.push(['start', value, previous]),
    onCommit: value => events.push(['commit', value]),
    reducedMotion: () => reducedMotion,
    schedule(action, delay) { timers.set(++sequence, { action, delay }); return sequence; },
    cancel(id) { timers.delete(id); },
  });
  function step(delay) {
    assert.equal(timers.size, 1);
    const [id, task] = timers.entries().next().value;
    assert.equal(task.delay, delay);
    timers.delete(id);
    task.action();
  }
  return { events, timers, seal, step };
}

test('the seal finishes a reveal, holds it, and skips intermediate updates', () => {
  const { events, timers, seal, step } = sealHarness();
  seal.offer(hash('a'));
  seal.offer('invalid');
  seal.offer(hash('b'));
  assert.deepEqual(events, []);
  step(240);
  assert.deepEqual(events, [['start', hash('B'), null]]);
  seal.offer(hash('c'));
  seal.offer(hash('d'));
  step(2807);
  assert.deepEqual(events.at(-1), ['commit', hash('B')]);
  seal.offer(hash('e'));
  step(2200);
  assert.deepEqual(events.at(-1), ['start', hash('E'), hash('B')]);
  step(2807);
  assert.deepEqual(events.at(-1), ['commit', hash('E')]);
  seal.offer(hash('e'));
  step(2200);
  assert.equal(timers.size, 0);
});

test('a project reset cancels a reveal before it can commit old status', () => {
  const { events, timers, seal, step } = sealHarness();
  seal.offer(hash('a'));
  step(240);
  seal.reset();
  assert.equal(timers.size, 0);
  assert.deepEqual(events, [['start', hash('A'), null], ['commit', null]]);
  seal.offer(hash('b'));
  step(240);
  assert.deepEqual(events.at(-1), ['start', hash('B'), null]);
});

test('reduced motion displays a complete seal without a flip sequence', () => {
  const { events, seal, step } = sealHarness(true);
  seal.offer(hash('a'));
  step(240);
  assert.deepEqual(events, [['commit', hash('A')]]);
  step(2200);
});

test('status preserves stream and run as separate detail and gives failures priority', () => {
  assert.equal(projectRibbonStatus().state, 'unknown');
  assert.equal(projectRibbonStatus({ stream: false, run: { state: 'idle' } }).state, 'pending');
  const idle = projectRibbonStatus({ stream: true, run: { state: 'idle' }, project: 'clu · generation 3' });
  assert.equal(idle.state, 'ready');
  assert.deepEqual(idle.checks.map(({ label, state, detail }) => [label, state ?? detail]), [
    ['Stream', 'Live'], ['Run', 'Idle'], ['Project', 'clu · generation 3'],
  ]);
  assert.equal(projectRibbonStatus({ stream: true, run: { state: 'running' } }).state, 'working');
  assert.equal(projectRibbonStatus({ stream: false, run: { state: 'timeout' } }).state, 'failed');
  assert.equal(projectRibbonStatus({ stream: true, run: { state: 'idle' }, sealConsistent: false }).state, 'failed');
});

test('the actual ribbon markup exposes five bulbs, an original vector wordmark, and seal glyphs', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ribbon = html.slice(html.indexOf('<header id="rail"'), html.indexOf('</header>'));
  assert.deepEqual([...ribbon.matchAll(/data-ribbon-capability="([^"]+)"/g)].map(match => match[1]),
    ['status', 'git', 'ai', 'chrome', 'console']);
  assert.match(ribbon, /clue-ribbon-seal-glyphs/);
  assert.match(ribbon, /class="clue-ribbon-wordmark"/);
  assert.match(ribbon, /class="clue-ribbon-brand"[\s\S]*<canvas/);
  assert.doesNotMatch(ribbon, /ribbonDetailsRefresh|Run live check/);
  assert.doesNotMatch(ribbon, /id="(?:mission|activeTargetPill|streamPill|runPill|densityBtn|start|gitSync)"/);
});

class Element extends EventTarget {
  dataset = {};
  attributes = new Map();
  nodes = new Map();
  classList = { add() {}, remove() {} };
  textContent = '';
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  toggleAttribute(key, enabled) {
    if (enabled) this.setAttribute(key, ''); else this.attributes.delete(key);
  }
  querySelector(selector) { return this.nodes.get(selector); }
  replaceChildren(...children) { this.children = children; }
  append() {}
  click() { this.dispatchEvent(new Event('click')); }
}

function makeRibbon() {
  const root = new Element();
  root.ownerDocument = Object.assign(new EventTarget(), {
    defaultView: new EventTarget(),
    visibilityState: 'visible',
    createElement: () => new Element(),
    createElementNS: () => new Element(),
  });
  const capabilities = ['status', 'git', 'ai', 'chrome', 'console'];
  const buttons = capabilities.map(capability => Object.assign(new Element(), { dataset: { ribbonCapability: capability } }));
  root.querySelectorAll = () => buttons;
  for (const key of ['Details', 'DetailsTitle', 'DetailsSummary', 'DetailsChecks', 'DetailsClose']) {
    root.nodes.set(`#ribbon${key}`, new Element());
  }
  const seal = new Element();
  seal.ownerDocument = root.ownerDocument;
  const glyphs = new Element();
  seal.nodes.set('.clue-ribbon-seal-value', new Element());
  seal.nodes.set('.clue-ribbon-seal-glyphs', glyphs);
  root.nodes.set('.clue-ribbon-seal', seal);
  return { root, buttons };
}

const profileHash = `profile:v1:${hash('a')}`;
const rootIdentity = `path:v1:win32:${hash('b')}`;

const frame = projectId => ({
  snapshot: { configuration: { project: { activeProject: {
    operationIdentity: { projectId, projectProfileHash: profileHash, targetRootIdentity: rootIdentity },
    profileGeneration: 1,
  } } } },
});

function chromeReadiness(projectId) {
  const record = {
    profile: { projectId, targetRootIdentity: rootIdentity, integrations: { chrome: { launchMode: 'CLUE_MANAGED' } } },
    projectProfileHash: profileHash,
    generation: 1,
  };
  const receipt = {
    projectIdentity: { projectId, projectProfileHash: profileHash, targetRootIdentity: rootIdentity },
    profileGeneration: 1,
    state: 'ready',
    summary: 'Dedicated Chrome and the WebGPU canary passed.',
    checks: [],
  };
  return { record, receipt };
}

test('each capability runs once on startup, and non-green clicks go to Configuration', async () => {
  const { root, buttons } = makeRibbon();
  const [status, git] = buttons;
  const calls = [];
  const navigations = [];
  const ribbon = mountRibbon({
    root,
    checkCapability: (capability, { signal }) => new Promise(resolve => calls.push({ capability, signal, resolve })),
    openConfiguration: (capability, receipt) => navigations.push([capability, receipt.state]),
  });
  assert.equal(calls.length, 0);
  status.click();
  assert.equal(calls.length, 0);
  git.click();
  assert.deepEqual(navigations, [['git', 'unknown']]);
  assert.equal(calls.length, 0);
  ribbon.updateFrame(frame('first'));
  ribbon.updateFrame(frame('first'));
  assert.deepEqual(calls.map(call => call.capability), ['git', 'ai', 'chrome', 'console']);
  git.click();
  assert.deepEqual(navigations, [['git', 'unknown'], ['git', 'pending']]);
  assert.equal(calls.length, 4);
  assert.equal(git.dataset.state, 'pending');
  calls[0].resolve({ state: 'ready', summary: 'Current Git ready' });
  for (const call of calls.slice(1)) call.resolve({ state: 'failed', summary: 'Unavailable' });
  await Promise.resolve();
  assert.equal(git.dataset.state, 'ready');
  git.click();
  assert.equal(root.nodes.get('#ribbonDetailsSummary').textContent, 'Current Git ready');
  buttons[2].click();
  assert.deepEqual(navigations.at(-1), ['ai', 'failed']);
  assert.equal(calls.length, 4);
});

test('changing the project invalidates in-flight receipts until dashboard reopening', async () => {
  const { root, buttons } = makeRibbon();
  const calls = [];
  const ribbon = mountRibbon({
    root,
    checkCapability: (capability, { signal }) => new Promise(resolve => calls.push({ capability, signal, resolve })),
  });
  ribbon.updateFrame(frame('first'));
  ribbon.updateFrame(frame('second'));
  assert.equal(calls.length, 4);
  assert.equal(calls.every(call => call.signal.aborted), true);
  for (const call of calls) call.resolve({ state: 'ready', summary: 'Stale project ready' });
  await Promise.resolve();
  assert.equal(buttons[1].dataset.state, 'pending');
  assert.match(buttons[1].title, /Reopen the dashboard/);
  ribbon.updateFrame(frame('second'));
  assert.equal(calls.length, 4);
});

test('a verified Configuration Chrome result takes precedence over a late startup check', async () => {
  const { root, buttons } = makeRibbon();
  const chrome = buttons.find(button => button.dataset.ribbonCapability === 'chrome');
  const calls = [];
  const ribbon = mountRibbon({
    root,
    checkCapability: (capability, { signal }) => new Promise(resolve => calls.push({ capability, signal, resolve })),
  });
  ribbon.updateFrame(frame('clue'));
  const { record, receipt } = chromeReadiness('clue');
  try {
    root.ownerDocument.dispatchEvent(new CustomEvent('clue:chrome-readiness', { detail: { record, receipt } }));
    assert.equal(chrome.dataset.state, 'ready');
    assert.equal(chrome.title, receipt.summary);
    assert.deepEqual(calls.filter(call => call.signal.aborted).map(call => call.capability), ['chrome']);
  } finally {
    for (const call of calls) call.resolve({ state: 'pending', summary: 'The startup window was unavailable.' });
  }
  await Promise.resolve();
  assert.equal(chrome.dataset.state, 'ready');
  assert.equal(chrome.title, receipt.summary);
  assert.deepEqual(calls.map(call => call.capability), ['git', 'ai', 'chrome', 'console']);
});

test('Chrome results from another profile, generation, root, or attach mode cannot turn the bulb green', async () => {
  const { root, buttons } = makeRibbon();
  const chrome = buttons.find(button => button.dataset.ribbonCapability === 'chrome');
  const ribbon = mountRibbon({
    root,
    checkCapability: async () => ({ state: 'pending', summary: 'Open the managed test window.' }),
  });
  ribbon.updateFrame(frame('clue'));
  await Promise.resolve();
  const { record, receipt } = chromeReadiness('clue');
  const other = chromeReadiness('other');
  const refused = [
    [other.record, other.receipt],
    [{ ...record, generation: 2 }, { ...receipt, profileGeneration: 2 }],
    [record, { ...receipt, profileGeneration: 2 }],
    [record, { ...receipt, projectIdentity: { ...receipt.projectIdentity, projectProfileHash: `profile:v1:${hash('d')}` } }],
    [record, { ...receipt, projectIdentity: { ...receipt.projectIdentity, targetRootIdentity: `path:v1:win32:${hash('d')}` } }],
    [{ ...record, profile: {
      ...record.profile,
      integrations: { chrome: { launchMode: 'ATTACH_TO_EXISTING' } },
    } }, receipt],
  ];
  for (const [candidate, result] of refused) {
    ribbon.applyChromeReadiness(candidate, result);
    assert.equal(chrome.dataset.state, 'pending');
    assert.equal(chrome.title, 'Open the managed test window.');
  }
});

test('a completed failed Chrome test replaces the prior result and shows the reason', async () => {
  const { root, buttons } = makeRibbon();
  const chrome = buttons.find(button => button.dataset.ribbonCapability === 'chrome');
  const ribbon = mountRibbon({ root, checkCapability: async () => ({ state: 'ready', summary: 'Previously verified' }) });
  ribbon.updateFrame(frame('clue'));
  await Promise.resolve();
  assert.equal(chrome.dataset.state, 'ready');

  const { record, receipt } = chromeReadiness('clue');
  const summary = 'The dedicated Chrome debugger did not respond.';
  ribbon.applyChromeReadiness(record, { ...receipt, state: 'failed', summary });
  assert.equal(chrome.dataset.state, 'failed');
  assert.equal(chrome.title, summary);
});

test('focus and visibility preserve the Chrome and Console results and a reconnect reads the server session', async () => {
  const { root, buttons } = makeRibbon();
  const chrome = buttons.find(button => button.dataset.ribbonCapability === 'chrome');
  const consoleBulb = buttons.find(button => button.dataset.ribbonCapability === 'console');
  const document = root.ownerDocument;
  const focus = () => document.defaultView.dispatchEvent(new Event('focus'));
  const visibility = () => document.dispatchEvent(new Event('visibilitychange'));
  const { record, receipt } = chromeReadiness('clue');
  const consoleReceipt = { ...receipt, summary: 'PowerShell host round trip passed.' };
  const sessionResults = { chrome: receipt, console: consoleReceipt };
  const calls = [];
  const ribbon = mountRibbon({
    root,
    async checkCapability(capability) {
      calls.push(capability);
      return sessionResults[capability] ?? { state: 'ready', summary: 'Verified' };
    },
  });
  focus();
  assert.deepEqual(calls, []);
  ribbon.updateFrame(frame('clue'));
  await Promise.resolve();
  ribbon.applyChromeReadiness(record, receipt);
  document.dispatchEvent(new CustomEvent('clue:console-readiness', {
    detail: { record, receipt: { ...consoleReceipt, state: 'failed', profileGeneration: 2 } },
  }));
  assert.equal(consoleBulb.dataset.state, 'ready');
  document.dispatchEvent(new CustomEvent('clue:console-readiness', {
    detail: { record, receipt: { ...consoleReceipt, summary: 'New Console test passed.' } },
  }));
  assert.equal(consoleBulb.title, 'New Console test passed.');
  focus();
  assert.deepEqual(calls, ['git', 'ai', 'chrome', 'console']);

  document.visibilityState = 'hidden';
  visibility();
  focus();
  assert.equal(calls.length, 4);
  assert.equal(chrome.dataset.state, 'ready');
  assert.equal(consoleBulb.dataset.state, 'ready');
  document.visibilityState = 'visible';
  visibility();
  focus();
  await Promise.resolve();
  assert.equal(calls.length, 4);
  assert.equal(chrome.dataset.state, 'ready');
  assert.equal(consoleBulb.dataset.state, 'ready');

  ribbon.updateStream(false);
  ribbon.updateStream(true);
  assert.deepEqual(calls, ['git', 'ai', 'chrome', 'console', 'chrome', 'console']);
  assert.equal(chrome.dataset.state, 'ready');
  assert.equal(consoleBulb.dataset.state, 'ready');
  await Promise.resolve();
  assert.equal(chrome.dataset.state, 'ready');
  assert.equal(consoleBulb.title, consoleReceipt.summary);

  sessionResults.chrome = { state: 'pending', summary: 'Run Test Chrome in Configuration.' };
  sessionResults.console = { state: 'pending', summary: 'Run Test Console in Configuration.' };
  ribbon.updateStream(false);
  ribbon.updateStream(true);
  assert.deepEqual(calls, ['git', 'ai', 'chrome', 'console', 'chrome', 'console', 'chrome', 'console']);
  await Promise.resolve();
  assert.equal(chrome.dataset.state, 'pending');
  assert.equal(chrome.title, sessionResults.chrome.summary);
  assert.equal(consoleBulb.dataset.state, 'pending');
  assert.equal(consoleBulb.title, sessionResults.console.summary);
});
