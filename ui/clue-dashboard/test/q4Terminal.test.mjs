import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountQ4Terminal } from '../quadrants/q4Terminal.js';
import { describeDashboardRun, describeStartReceipt } from '../state/runPresentation.js';

class Element {
  children = [];
  handlers = new Map();
  attributes = new Map();
  dataset = {};
  text = '';
  value = '';
  scrollTop = 0;
  clientHeight = 300;
  selectionStart = 0;
  selectionEnd = 0;
  get scrollHeight() { return this.children.length * 20; }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  get textContent() { return this.text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.text = value; this.children = []; }
  append(...items) { this.insert(false, items); }
  prepend(...items) { this.insert(true, items); }
  insert(prepend, items) {
    for (const child of items) if (typeof child === 'object') child.parent = this;
    if (prepend) this.children.unshift(...items);
    else this.children.push(...items);
  }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  addEventListener(name, callback) { this.handlers.set(name, callback); }
  removeEventListener(name) { this.handlers.delete(name); }
  dispatch(name, fields = {}) { return this.handlers.get(name)?.({ preventDefault() {}, ...fields }); }
}

function mount(callbacks = {}) {
  const form = new Element();
  const input = new Element();
  const log = new Element();
  const send = new Element();
  const receipts = new Element();
  const elements = new Map([
    ['#q4-terminal-form', form], ['#q4-terminal-input', input], ['#q4-terminal-log', log],
    ['#q4-terminal-submit', send], ['#q4-command-receipts', receipts],
  ]);
  const root = {
    querySelector: selector => elements.get(selector),
    ownerDocument: { createElement: () => new Element(), createTextNode: text => text },
  };
  const mounted = mountQ4Terminal({ root, pollMs: 0, ...callbacks });
  return {
    ...mounted, input, form, log, receipts, send,
    submit(value) { input.value = value; return form.dispatch('submit'); },
  };
}

const core = (text, tone = 'info', ok = true) => ({ kind: 'core', ok, lines: [{ source: 'CORE', tone, text }], receipts: [], turnId: null, basis: null, status: null });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Q4 keeps the operational feed above and the CLUE console below, with no Master Agent left', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../quadrants/q4Terminal.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const terminal = readFileSync(new URL('../quadrants/q4Terminal.js', import.meta.url), 'utf8');
  assert.match(html, /class="q4-operation-pane"[\s\S]*id="work"[\s\S]*id="feed"[\s\S]*class="q4-command-pane"/);
  assert.match(html, /id="q4-terminal-title"[^>]*>CLUE</);
  assert.match(html, /id="q4-terminal-log"[^>]+role="log"/);
  assert.match(html, /id="q4-terminal-input"[^>]+aria-label="CLU-E command or message"/);
  assert.match(app, /mountAgents\(host\)[\s\S]*mountAgentsPanel\(\{ root: host, actionClient \}\)/);
  assert.match(css, /\.q4-operation-pane,\s*#q4 \.q4-terminal-log \{\s*overflow-y: auto/);
  for (const source of [html, app, terminal]) assert.doesNotMatch(source, /Master Agent|talkToAgent|\/api\/control\/agent/);
  assert.match(app, /invoke\('agentConsole', \{ line \}/);
  assert.match(app, /invoke\('start', undefined, \{ signal \}\)/);
  assert.match(app, /invoke\('startWithFindings', undefined, \{ signal \}\)/);
  assert.match(app, /invoke\('syncGit', undefined, \{ signal \}\)/);
});

test('Q4 passes approved typed commands and ordinary questions and refuses other slash commands', async () => {
  const lines = [];
  const ui = mount({ send: async ({ line, command }) => {
    lines.push([line, command]);
    return core(`received ${line}`, 'ok');
  } });
  await ui.submit('/START');
  await ui.submit('/START  --ASSESS-FINDINGS');
  await ui.submit('  /git    sync  ');
  await ui.submit('/help');
  await ui.submit('/cmd whoami');
  await ui.submit('/start extra');
  await ui.submit('/start --assess-findings extra');
  await ui.submit('Is the cycle running?');
  await ui.submit('use sk-abcdefgh12345678 for the brain');
  await ui.submit('   ');
  assert.deepEqual(lines, [['/START', '/start'], ['/START  --ASSESS-FINDINGS', '/start --assess-findings'],
    ['/git    sync', '/git sync'], ['Is the cycle running?', null]]);
  assert.match(ui.log.textContent, /YOU › \/START.*CORE › received \/START/s);
  assert.match(ui.log.textContent, /\/start --assess-findings — screen the cycle and assess findings/);
  assert.match(ui.log.textContent, /Unknown CLU-E command/);
  assert.doesNotMatch(ui.log.textContent, /sk-abcdefgh12345678/);
});

test('Q4 distinguishes Start acceptance and findings outcomes from the screening checkpoint', () => {
  const started = { started: true, disposition: 'started' };
  assert.match(describeStartReceipt(started).detail, /progress through screening/);
  assert.match(describeStartReceipt(started, true).detail, /screening and assessment/);
  const screened = { cycleStage: 'SCREENED', cycleId: 'CYCLE-000004' };
  const completed = describeDashboardRun({ ...screened, state: 'completed', findingsOutcome: 'NO_CANDIDATE',
    findingsEventId: 'EVENT-000028', lastLine: 'No measurable units.' });
  assert.match(completed.detail, /Screening reached \(SCREENED\).*Findings NO_CANDIDATE · EVENT-000028.*No measurable units/);
  const blocked = describeDashboardRun({ ...screened, state: 'failed', findingsOutcome: 'BLOCKED',
    findingsCode: 'FINDINGS_INPUTS_CHANGED', lastLine: 'The screened source differs.' });
  assert.match(blocked.detail, /Screening reached \(SCREENED\).*Findings blocked · FINDINGS_INPUTS_CHANGED.*screened source differs/);
});

test('Q4 keeps the canonical cycle and dispatch IDs on P02 command receipts', async () => {
  const replies = [
    { started: true, disposition: 'attached', dispatchId: 'dispatch-4' },
    { started: true, disposition: 'already-screened', cycleId: 'CYCLE-000004' },
  ];
  const ui = mount({ send: async () => {
    const receipt = replies.shift();
    return { ...core(describeStartReceipt(receipt).detail), receipts: [{ ...receipt, action: 'Cycle drive' }] };
  } });
  await ui.submit('/start');
  await ui.submit('/start');
  assert.match(ui.log.textContent, /Attached to the cycle drive already in progress.*already reached screening/s);
  assert.deepEqual(ui.receipts.children.map(row => row.textContent), [
    'Cycle drive · already-screened · Cycle CYCLE-000004',
    'Cycle drive · attached · Dispatch dispatch-4',
  ]);
});

test('Q4 renders a CLUE reply as literal text with its receipts and the Status it was based on', async () => {
  const settled = [];
  const ui = mount({
    send: async () => ({
      kind: 'clue', ok: true, status: 'done', turnId: 'TRN-000007',
      basis: { statusHash: 'bd9f3c0a11e2aa55ffee', capturedAt: '2026-11-10T05:00:00Z' },
      lines: [{ source: 'CLUE', tone: 'info', text: '<b>cycle status</b> exited 0.' }],
      receipts: [
        { kind: 'command', label: 'cycle status --json', ok: true, detail: 'exit 0', job: 'JOB-0001', exitCode: 0 },
        { kind: 'command', label: 'project list', ok: false, detail: 'exit 3', job: 'JOB-0002', exitCode: 3 },
      ],
    }),
    onSettled: result => settled.push(result.turnId),
  });
  await ui.submit('Check the cycle.');
  const text = ui.log.textContent;
  assert.match(text, /CLUE › <b>cycle status<\/b> exited 0\./);
  assert.match(text, /RECEIPT › ✓ cycle status --json — exit 0/);
  assert.match(text, /RECEIPT › ✗ project list — exit 3/);
  assert.match(text, /BASIS › TRN-000007 · done · Status bd9f3c0a11e2 · 2 actions/);
  assert.deepEqual(settled, ['TRN-000007']);
  assert.deepEqual(ui.log.children.map(row => row.dataset.kind), ['system', 'operator', 'agent', 'meta', 'error', 'meta']);
});

test('Q4 never blocks an exact command behind a running CLUE turn, so /halt gets through', async () => {
  const lines = [];
  let finishTurn;
  const ui = mount({ send: ({ line }) => {
    lines.push(line);
    if (line.startsWith('/')) return Promise.resolve(core('CLUE is halted.', 'ok'));
    return new Promise(resolve => { finishTurn = resolve; });
  } });
  const turn = ui.submit('Do something long.');
  assert.equal(ui.form.attributes.get('aria-busy'), 'true');
  await ui.submit('And another thing.');
  await ui.submit('/halt now');
  assert.deepEqual(lines, ['Do something long.', '/halt now']);
  assert.match(ui.log.textContent, /CLUE is still working on a turn/);
  assert.match(ui.log.textContent, /CORE › CLUE is halted\./);
  assert.equal(ui.form.attributes.get('aria-busy'), 'true');
  finishTurn({ kind: 'clue', ok: false, status: 'halted', turnId: 'TRN-000001', basis: null, lines: [{ source: 'CLUE', tone: 'error', text: 'Halted.' }], receipts: [] });
  await turn;
  assert.equal(ui.form.attributes.get('aria-busy'), 'false');
  assert.match(ui.log.textContent, /BASIS › TRN-000001 · halted · no sealed Status · 0 actions/);
});

test('Q4 reports a transport failure as CORE and stays usable', async () => {
  let fail = true;
  const ui = mount({ send: async () => {
    if (fail) throw new Error('The dashboard is stopping.');
    return core('ok', 'ok');
  } });
  await ui.submit('/status');
  assert.match(ui.log.textContent, /CORE › The dashboard is stopping\./);
  fail = false;
  await ui.submit('/status');
  assert.match(ui.log.textContent, /CORE › ok/);
  const unconnected = mount();
  await unconnected.submit('/status');
  assert.match(unconnected.log.textContent, /not connected to the dashboard server/);
});

test('Q4 resets on a project change and drops a late answer from the previous project', async () => {
  let resolve;
  let signal;
  const ui = mount({ send: payload => {
    signal = payload.signal;
    return new Promise(done => { resolve = done; });
  } });
  const pending = ui.submit('Old project question');
  ui.reset();
  assert.equal(signal.aborted, true);
  assert.equal(ui.form.attributes.get('aria-busy'), 'false');
  resolve({ kind: 'clue', ok: true, status: 'done', turnId: 'TRN-9', basis: null, lines: [{ source: 'CLUE', tone: 'info', text: 'Late answer' }], receipts: [] });
  await pending;
  assert.doesNotMatch(ui.log.textContent, /Old project question|Late answer/);
  assert.equal(ui.receipts.hidden, true);
});

test('Q4 shows agent ledger activity in the upper window, newest first, without repeating rows', async () => {
  const cursors = [];
  const pages = [
    { head: 3, rows: [
      { seq: 2, agent: 'clue', type: 'agent.turn_completed', tone: 'ok', text: 'Turn answered' },
      { seq: 3, agent: 'clue', type: 'agent.turn_failed', tone: 'error', text: 'Provider unavailable' },
    ] },
    { head: 3, rows: [] },
    { head: 4, rows: [{ seq: 4, agent: 'core', type: 'core.command', tone: 'info', text: '/halt' }] },
  ];
  const ui = mount({ activity: async ({ after }) => { cursors.push(after); return pages.shift() ?? { head: 4, rows: [] }; } });
  await settle();
  await ui.refresh();
  await ui.refresh();
  assert.deepEqual(cursors, [-12, 3, 3]);
  assert.deepEqual(ui.receipts.children.map(row => row.textContent), [
    'CORE · /halt', 'CLUE · Provider unavailable', 'CLUE · Turn answered',
  ]);
  assert.deepEqual(ui.receipts.children.map(row => row.dataset.tone), ['info', 'error', 'ok']);
  assert.equal(ui.receipts.hidden, false);
  ui.recordReceipt({ action: 'Cycle drive', state: 'completed', detail: 'Cycle recorded' });
  assert.equal(ui.receipts.firstElementChild.textContent, 'Cycle drive · completed · Cycle recorded');
});

test('Q4 restores the durable dialogue from the agent ledger after a reload', async () => {
  const ui = mount({ dialogue: async () => ({ turns: [
    { turnId: 'TRN-1', message: 'first', reply: 'one', status: 'done' },
    { turnId: 'TRN-2', message: 'second', reply: 'two', status: 'done' },
  ] }) });
  await settle();
  assert.match(ui.log.textContent, /Restored the last 2 of 2 turns from the agent ledger\..*YOU › first.*CLUE › one.*YOU › second.*CLUE › two/s);
});

test('Q4 can recall the previous input without losing a partially typed line', async () => {
  const ui = mount({ send: async () => core('ok') });
  await ui.submit('/help');
  ui.input.value = 'Draft question';
  ui.input.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(ui.input.value, '/help');
  ui.input.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(ui.input.value, 'Draft question');
});
