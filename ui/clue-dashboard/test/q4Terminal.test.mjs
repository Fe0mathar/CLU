import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountQ4Terminal } from '../quadrants/q4Terminal.js';

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
  const mounted = mountQ4Terminal({ root, ...callbacks });
  return {
    ...mounted, input, form, log, receipts, send,
    submit(value) { input.value = value; return form.dispatch('submit'); },
  };
}

test('Q4 keeps the existing operational feed and a separate accessible command pane', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../quadrants/q4Terminal.css', import.meta.url), 'utf8');
  assert.match(html, /class="q4-operation-pane"[\s\S]*id="work"[\s\S]*id="feed"[\s\S]*class="q4-command-pane"/);
  assert.match(html, /id="q4-terminal-log"[^>]+role="log"/);
  assert.match(html, /id="q4-terminal-input"[^>]+aria-label="CLU-E command or message"/);
  assert.match(css, /\.q4-operation-pane,\s*#q4 \.q4-terminal-log \{\s*overflow-y: auto/);
});

test('Q4 dispatches only explicit program commands and publishes their receipts', async () => {
  const calls = [];
  const ui = mount({
    start: async () => {
      calls.push('start');
      return { reply: 'Cycle drive accepted', receipt: { started: true } };
    },
    gitSync: async () => {
      calls.push('git sync');
      return { ok: false, reply: 'Remote unavailable', receipt: { state: 'refused', detail: 'No remote' } };
    },
    status: async () => { calls.push('status'); return 'Run idle'; },
    chat: async () => { calls.push('chat'); return { reply: 'Understood' }; },
  });
  await ui.submit('/START');
  await ui.submit('  /git    sync  ');
  await ui.submit('/status');
  await ui.submit('/help');
  await ui.submit('/cmd whoami');
  await ui.submit('/start extra');
  assert.deepEqual(calls, ['start', 'git sync', 'status']);
  assert.match(ui.log.textContent, /Cycle drive accepted.*Remote unavailable.*Run idle/s);
  assert.match(ui.log.textContent, /Unknown CLU-E command/);
  assert.deepEqual(ui.receipts.children.map(row => row.textContent), ['Git sync · refused · No remote', 'Cycle drive · accepted']);
  ui.recordReceipt({ action: 'Cycle drive', state: 'completed', detail: 'Cycle recorded' });
  assert.equal(ui.receipts.firstElementChild.textContent, 'Cycle drive · completed · Cycle recorded');
});

test('Q4 passes plain-text conversation and bounded role history to the Master Agent', async () => {
  const calls = [];
  const ui = mount({ chat: async payload => {
    calls.push(payload);
    return { reply: '<b>A literal answer</b>' };
  } });
  for (let index = 0; index < 7; index++) await ui.submit(`Question ${index}`);
  assert.equal(calls[0].history.length, 0);
  assert.deepEqual(calls[1].history, [
    { role: 'user', text: 'Question 0' }, { role: 'assistant', text: '<b>A literal answer</b>' },
  ]);
  assert.equal(calls.at(-1).history.length, 8);
  assert.equal(calls.at(-1).history[0].text, 'Question 2');
  assert.match(ui.log.textContent, /MASTER AGENT › <b>A literal answer<\/b>/);
});

test('Q4 resets the conversation and drops a late response from the previous project', async () => {
  let resolve;
  let signal;
  const ui = mount({ chat: payload => {
    signal = payload.signal;
    return new Promise(done => { resolve = done; });
  } });
  const pending = ui.submit('Old project question');
  assert.equal(ui.send.disabled, true);
  ui.reset();
  assert.equal(signal.aborted, true);
  assert.equal(ui.send.disabled, false);
  resolve({ reply: 'Late answer', action: 'start', receipt: { started: true } });
  await pending;
  assert.doesNotMatch(ui.log.textContent, /Old project question|Late answer/);
  assert.equal(ui.receipts.hidden, true);
});

test('Q4 can recall the previous input without losing a partially typed line', async () => {
  const ui = mount();
  await ui.submit('/help');
  ui.input.value = 'Draft question';
  ui.input.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(ui.input.value, '/help');
  ui.input.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(ui.input.value, 'Draft question');
});
