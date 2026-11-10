import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountAgentsPanel } from '../configuration/agentsPanel.js';
import { DASHBOARD_ACTIONS, createActionClient, findCredentialLeak } from '../configuration/actionContracts.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.handlers = new Map(); this.attributes = new Map(); this.dataset = {}; this.text = ''; this.value = ''; this.open = false; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  fire(name) { return this.handlers.get(name)?.({}); }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
}

const IDENTITY = readFileSync(new URL('../../../agents/clue/identity.md', import.meta.url), 'utf8');
const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };

function mount(responses) {
  const requests = [];
  const actionClient = createActionClient({
    request: async (request) => {
      requests.push(request);
      const key = `${request.method} ${request.path.split('?')[0]}`;
      const answer = responses[key];
      if (answer === undefined) throw new Error(`unexpected ${key}`);
      return typeof answer === 'function' ? answer(request) : answer;
    },
  });
  const root = new Node('div');
  root.ownerDocument = { createElement: tag => new Node(tag) };
  const panel = mountAgentsPanel({ root, actionClient });
  const byText = label => root.find(node => node.tag === 'button' && node.textContent === label);
  return { panel, root, requests, byText, editor: root.find(node => node.tag === 'textarea'), status: root.find(node => node.className === 'agents-state'), message: root.find(node => node.className === 'agents-message') };
}

const state = { name: 'CLUE', state: 'unbound', reason: 'CLUE has no brain bound.', identity: { valid: true, version: 1, hash: 'a'.repeat(64) }, brain: { model: null }, ledger: { records: 3 } };
const identity = { id: 'clue', state: 'commander', text: IDENTITY, valid: true, problems: [], version: 1, hash: 'a'.repeat(64), brain: { provider: 'openai', model: null, credential: 'env:CLUE_AGENT_OPENAI_API_KEY' }, versions: [{ hash: 'a'.repeat(64), storedAt: '2026-11-10T05:00:00.000Z', bytes: IDENTITY.length }] };

test('the agent actions are declared, and the shipped Identity Document passes the credential scan', () => {
  for (const name of ['agentConsole', 'readAgentState', 'readAgentActivity', 'readAgentDialogue', 'readAgentIdentity', 'validateAgentIdentity', 'applyAgentIdentity', 'revertAgentIdentity', 'testAgentBrain']) {
    assert.ok(DASHBOARD_ACTIONS[name], `${name} is not declared`);
    assert.match(DASHBOARD_ACTIONS[name].path, /^\/api\/agent\//);
  }
  assert.equal(DASHBOARD_ACTIONS.talkToAgent, undefined);
  assert.equal(findCredentialLeak({ payload: { id: 'clue', text: IDENTITY, note: '' } }), null);
  assert.notEqual(findCredentialLeak({ payload: { line: 'use sk-abcdefgh12345678 for the brain' } }), null);
});

test('the Agents panel loads the Identity Document and shows the state CLUE is in', async () => {
  const ui = mount({ 'GET /api/agent/state': state, 'GET /api/agent/identity': identity });
  await ui.panel.load();
  assert.equal(ui.editor.value, IDENTITY);
  assert.equal(ui.status.dataset.state, 'unbound');
  assert.match(ui.status.textContent, /CLUE unbound — CLUE has no brain bound\. · identity v1 aaaaaaaaaaaa · brain unbound · ledger 3 records/);
  assert.match(ui.root.textContent, /Profile workspace · CLUE identity · version 1 · sha256 a{64} · brain unbound · credential env:CLUE_AGENT_OPENAI_API_KEY/);
  assert.ok(ui.requests.some(request => request.path === '/api/agent/identity?id=clue'));
});

test('the Agents panel sends the edited text to the server and reports a refusal without changing anything', async () => {
  const applied = [];
  const ui = mount({
    'GET /api/agent/state': state,
    'GET /api/agent/identity': identity,
    'POST /api/agent/identity/validate': { valid: false, problems: [{ path: 'front matter.limits.max_steps_per_turn', message: 'must be at most 64' }] },
    'POST /api/agent/identity/apply': (request) => {
      applied.push(request.payload);
      return applied.length === 1
        ? { ok: false, problems: [{ path: 'front matter.commands', message: '"launch" is not a CLU-E command' }] }
        : { ok: true, problems: [], version: 2, hash: 'b'.repeat(64), previousHash: 'a'.repeat(64), unchanged: false };
    },
  });
  await ui.panel.load();
  ui.editor.value = `${IDENTITY}\nedited\n`;
  ui.editor.fire('input');
  assert.match(ui.root.textContent, /UNSAVED CHANGES/);

  ui.byText('VALIDATE').fire('click');
  await settle();
  assert.equal(ui.message.dataset.tone, 'error');
  assert.match(ui.message.textContent, /max_steps_per_turn: must be at most 64/);

  ui.byText('APPLY').fire('click');
  await settle();
  assert.deepEqual(applied[0], { id: 'clue', expectedHash: 'a'.repeat(64), text: `${IDENTITY}\nedited\n`, note: '' });
  assert.match(ui.message.textContent, /Refused; nothing changed:.*is not a CLU-E command/s);

  ui.byText('APPLY').fire('click');
  await settle();
  assert.equal(applied.length, 2);
  assert.equal(ui.message.dataset.tone, 'ok');
  assert.match(ui.message.textContent, /Applied as version 2 \(bbbbbbbbbbbb\)/);
});

test('Halt and Resume in the Agents panel are the exact console commands', async () => {
  const lines = [];
  const ui = mount({
    'GET /api/agent/state': state,
    'POST /api/agent/console': (request) => {
      lines.push(request.payload.line);
      return { kind: 'core', ok: true, lines: [{ source: 'CORE', tone: 'ok', text: 'done' }], receipts: [], turnId: null, basis: null, status: null };
    },
  });
  ui.byText('HALT').fire('click');
  await settle();
  ui.byText('RESUME').fire('click');
  await settle();
  assert.deepEqual(lines, ['/halt halted from Configuration', '/resume']);
});

test('the Agents panel pins a revert to the identity version it displayed', async () => {
  const requests = [];
  const ui = mount({
    'GET /api/agent/state': state,
    'GET /api/agent/identity': identity,
    'POST /api/agent/identity/revert': (request) => {
      requests.push(request.payload);
      return { ok: false, problems: [{ path: 'identity', message: 'Identity changed. Reload it first.' }] };
    },
  });
  await ui.panel.load();
  ui.root.find(node => node.tag === 'select').value = 'a'.repeat(64);
  ui.byText('REVERT TO VERSION').fire('click');
  await settle();
  assert.deepEqual(requests, [{ id: 'clue', expectedHash: 'a'.repeat(64), hash: 'a'.repeat(64) }]);
  assert.match(ui.message.textContent, /Reload it first/);
  assert.equal(ui.editor.value, IDENTITY);
});
