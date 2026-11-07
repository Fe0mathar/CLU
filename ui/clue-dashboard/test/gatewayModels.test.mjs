import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { createActionClient } from '../configuration/actionContracts.js';
import { mountConfigurationPanel } from '../configuration/configurationPanel.js';
import { createConfigurationState } from '../configuration/configurationState.js';
import { renderGatewayEditor } from '../configuration/gatewayEditor.js';
import { metadata, record } from './projectProfileUiFixture.mjs';

function catalogue(saved, state = 'READY', models = ['gpt-5.6-sol', 'gpt-4o']) {
  return {
    apiVersion: 'clue-project-profiles-api/1',
    ok: true,
    data: {
      projectId: saved.profile.projectId,
      generation: saved.generation,
      projectProfileHash: saved.projectProfileHash,
      state,
      models,
    },
  };
}

function stateFor(saved) {
  const state = createConfigurationState();
  state.applyProjectRead(state.beginProjectRead(saved.profile.projectId), { record: saved });
  return state;
}

test('model lists are scoped to the saved generation and discarded after a selection or draft race', () => {
  const alpha = record('alpha');
  const beta = record('beta', 2);
  const state = stateFor(alpha);
  const stale = state.beginGatewayModels();
  state.applyProjectRead(state.beginProjectRead('beta'), { record: beta });
  assert.equal(state.applyGatewayModels(stale, catalogue(alpha)).reason, 'STALE_MODEL_LIST_RESPONSE');
  assert.doesNotMatch(renderGatewayEditor(state.snapshot()), /gpt-5\.6-sol|gpt-4o/);

  const wrongGeneration = state.beginGatewayModels();
  const otherRecord = { ...beta, generation: beta.generation + 1 };
  assert.equal(state.applyGatewayModels(wrongGeneration, catalogue(otherRecord)).reason, 'MODEL_LIST_IDENTITY_MISMATCH');
  assert.equal(state.snapshot().pending, null);

  const dirtyDuringRequest = state.beginGatewayModels();
  state.updateDraft('displayName', 'Local edit');
  assert.equal(state.applyGatewayModels(dirtyDuringRequest, catalogue(beta)).reason, 'DRAFT_CHANGED');
  assert.equal(state.snapshot().draft.displayName, 'Local edit');
  assert.equal(state.snapshot().pending, null);
  assert.doesNotMatch(renderGatewayEditor(state.snapshot()), /gpt-5\.6-sol|gpt-4o/);
});

test('unavailable or unsafe catalogue data retains the configured option without adding alternatives', () => {
  const saved = record('alpha');
  const state = stateFor(saved);
  const invalid = state.beginGatewayModels();
  assert.equal(state.applyGatewayModels(invalid, catalogue(saved, 'READY', ['sk-credential-shaped-value'])).reason,
    'MODEL_LIST_RESPONSE_INVALID');
  const missing = state.beginGatewayModels();
  assert.equal(state.applyGatewayModels(missing, catalogue(saved, 'CREDENTIAL_MISSING', [])).applied, true);
  const html = renderGatewayEditor(state.snapshot());
  assert.match(html, /<select data-profile-path="integrations\.gpt\.modelId" disabled>/);
  assert.match(html, /<option value="gpt-5\.6" selected>gpt-5\.6 · configured<\/option>/);
  assert.match(html, /Set or replace this profile’s API key/);
  assert.doesNotMatch(html, /sk-credential-shaped-value/);
});

test('model picker discovers on explicit action, edits a draft, and saves only on explicit SAVE', async (t) => {
  const previous = Object.fromEntries(['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const name of Object.keys(previous)) {
    Object.defineProperty(globalThis, name, { configurable: true, value: class {} });
  }
  t.after(() => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  });

  let saved = record('alpha');
  const calls = [];
  const listeners = new Map();
  let finishList;
  const root = {
    innerHTML: '',
    addEventListener(name, handler) { listeners.set(name, handler); },
    querySelector() { return null; },
  };
  const actionClient = createActionClient({ request: async (request) => {
    calls.push(request);
    const url = new URL(request.path, 'http://localhost');
    switch (request.method + ' ' + url.pathname) {
      case 'GET /api/config': return {};
      case 'GET /api/projects': return { projects: [metadata('alpha', saved.generation)], registryGeneration: saved.generation };
      case 'GET /api/projects/alpha': return { record: saved };
      case 'GET /api/projects/alpha/gpt/models':
        assert.equal(url.searchParams.get('expectedGeneration'), '1');
        assert.equal(url.searchParams.get('expectedProfileHash'), saved.projectProfileHash);
        assert.equal(request.payload, undefined);
        return await new Promise((resolve) => { finishList = () => resolve(catalogue(saved)); });
      case 'PUT /api/projects/alpha':
        assert.equal(request.payload.expectedGeneration, 1);
        assert.equal(request.payload.profile.integrations.gpt.modelId, 'gpt-5.6-sol');
        saved = { ...saved, profile: structuredClone(request.payload.profile), generation: 2 };
        return { record: saved };
      default: throw new Error('Unexpected request ' + request.method + ' ' + request.path);
    }
  } });
  const panel = mountConfigurationPanel({ root, actionClient });
  t.after(() => panel.destroy());

  const click = (action) => listeners.get('click')({
    preventDefault() {},
    target: { closest: () => ({ dataset: { cfgAction: action } }) },
  });
  const changeModel = (value) => {
    const target = Object.assign(new HTMLSelectElement(), { dataset: { profilePath: 'integrations.gpt.modelId' }, value });
    listeners.get('input')({ target });
    listeners.get('change')({ target });
  };

  await panel.load();
  assert.ok(calls.every((call) => !call.path.includes('/gpt/models')));
  assert.match(root.innerHTML, /<select data-profile-path="integrations\.gpt\.modelId" disabled>/);
  click('load-gateway-models');
  assert.match(root.innerHTML, /Loading the saved profile’s model list/);
  assert.match(root.innerHTML, /data-cfg-action="save-profile"[^>]* disabled/);
  click('save-profile');
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
  finishList();
  await setImmediate();
  assert.match(root.innerHTML, /<option value="gpt-5\.6" selected>gpt-5\.6 · configured, not listed<\/option>/);
  assert.match(root.innerHTML, /<option value="gpt-5\.6-sol">gpt-5\.6-sol<\/option>/);
  assert.equal(panel.snapshot().dirty, false);

  changeModel('gpt-not-listed');
  assert.equal(panel.snapshot().draft.integrations.gpt.modelId, 'gpt-5.6');
  changeModel('gpt-5.6-sol');
  assert.equal(panel.snapshot().draft.integrations.gpt.modelId, 'gpt-5.6-sol');
  assert.equal(panel.snapshot().selectedRecord.profile.integrations.gpt.modelId, 'gpt-5.6');
  assert.equal(panel.snapshot().dirty, true);
  assert.match(root.innerHTML, /<option value="gpt-5\.6-sol" selected>/);
  assert.match(root.innerHTML, /data-cfg-action="load-gateway-models" disabled/);
  click('load-gateway-models');
  click('test-gateway');
  assert.equal(calls.filter((call) => call.path.includes('/gpt/models')).length, 1);
  assert.equal(calls.filter((call) => call.path.includes('/test-gpt')).length, 0);

  click('save-profile');
  await setImmediate();
  assert.equal(panel.snapshot().selectedRecord.generation, 2);
  assert.equal(panel.snapshot().selectedRecord.profile.integrations.gpt.modelId, 'gpt-5.6-sol');
  assert.equal(panel.snapshot().dirty, false);
  assert.match(root.innerHTML, /<select data-profile-path="integrations\.gpt\.modelId" disabled>/);
  assert.ok(calls.every((call) => !call.path.includes('/activate')));
});
