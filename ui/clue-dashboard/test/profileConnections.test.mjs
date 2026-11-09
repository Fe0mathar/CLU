import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import { createActionClient } from '../configuration/actionContracts.js';
import { mountConfigurationPanel } from '../configuration/configurationPanel.js';
import { renderGitEditor } from '../configuration/gitEditor.js';
import { metadata, pointer, record } from './projectProfileUiFixture.mjs';

test('GitHub mismatch retains only the attempted repository and branch for the selected profile', () => {
  const saved = record('alpha');
  const repositories = [
    { nameWithOwner: 'owner/alpha', defaultBranch: 'main' },
    { nameWithOwner: 'owner/beta', defaultBranch: 'main' },
  ];
  const snapshot = {
    draft: saved.profile, selectedRecord: saved, phase: 'ready',
    connectionChecks: {
      githubDirectory: { repositories },
      githubConnection: { state: 'CHECKOUT_MISMATCH', repository: repositories[0], branch: 'work' },
    },
  };
  const html = renderGitEditor(snapshot);
  assert.match(html, /value="owner\/alpha" data-default-branch="main" selected/);
  assert.match(html, /value="owner\/beta" data-default-branch="main">/);
  assert.match(html, /id="cfgGitHubBranch" value="work"/);
  const beta = record('beta');
  const other = renderGitEditor({ ...snapshot, draft: beta.profile, selectedRecord: beta, connectionChecks: {} });
  assert.doesNotMatch(other, /owner\/alpha|value="work"/);
});

test('profile connection controls register a verified GitHub checkout and ask Windows to store the OpenAI key', async () => {
  let saved = record('alpha');
  const calls = [];
  const listeners = new Map();
  const values = new Map([
    ['#cfgGitHubRepository', { value: 'owner/repository' }],
    ['#cfgGitHubBranch', { value: 'work' }],
  ]);
  const root = {
    innerHTML: '',
    addEventListener(name, listener) { listeners.set(name, listener); },
    querySelector(selector) { return values.get(selector) ?? null; },
  };
  const actionClient = createActionClient({ request: async (request) => {
    calls.push(request);
    switch (`${request.method} ${request.path}`) {
      case 'GET /api/config': return {};
      case 'GET /api/projects': return { projects: [metadata('alpha', saved.generation)], registryGeneration: saved.generation };
      case 'GET /api/projects/alpha': return { record: saved };
      case 'POST /api/projects/alpha/github-sign-in': return { state: 'SIGN_IN_STARTED', detail: 'Finish signing in on Windows.' };
      case 'GET /api/projects/alpha/github-repositories':
        return { state: 'CONNECTED', account: 'operator', repositories: [{ nameWithOwner: 'owner/repository', defaultBranch: 'main', private: true }] };
      case 'POST /api/projects/alpha/github-connect': {
        saved = record('alpha', 2);
        saved.profile.integrations.git.remote = 'https://github.com/owner/repository.git';
        saved.profile.integrations.git.defaultBranch = 'work';
        return { state: 'CONNECTED', detail: 'Checkout verified.', record: saved };
      }
      case 'GET /api/projects/alpha/openai-key': return { state: 'unavailable', detail: 'No key stored.' };
      case 'POST /api/projects/alpha/openai-key': {
        saved = { ...structuredClone(saved), generation: 3 };
        saved.profile.integrations.gpt.credential.value = 'credential-store:CLU-E/OpenAI/alpha';
        return { state: 'stored', detail: 'Key saved in Windows.', record: saved };
      }
      case 'POST /api/projects/alpha/test-gpt': return { state: 'READY', requestedModel: 'gpt-5.6', effectiveModel: 'gpt-5.6' };
      default: throw new Error(`Unexpected request ${request.method} ${request.path}`);
    }
  } });
  const panel = mountConfigurationPanel({ root, actionClient });
  const click = async (action) => {
    listeners.get('click')({ preventDefault() {}, target: { closest: () => ({ dataset: { cfgAction: action } }) } });
    await setImmediate();
  };

  try {
    assert.match(root.innerHTML, /Select a saved Project Profile to connect its checkout/);
    assert.match(root.innerHTML, /Select a saved Project Profile to configure its key/);
    await panel.load();
    await click('activate-project');
    assert.match(root.innerHTML, /PROJECT_VALIDATION_REQUIRED/);
    assert.ok(calls.every(({ path }) => !path.endsWith('/activate')));
    await click('sign-in-github');
    assert.match(root.innerHTML, /SIGN_IN_STARTED/);
    await click('list-github-repositories');
    assert.match(root.innerHTML, /GitHub account · operator/);
    assert.match(root.innerHTML, /data-default-branch="main">owner\/repository · private/);
    await click('connect-github');
    assert.match(root.innerHTML, /Checkout verified/);
    assert.match(root.innerHTML, /https:\/\/github.com\/owner\/repository.git/);
    await click('check-openai-key');
    assert.match(root.innerHTML, /No key stored/);
    await click('set-openai-key');
    assert.match(root.innerHTML, /Key saved in Windows/);
    assert.doesNotMatch(root.innerHTML, /type="password"/);
    await click('test-gateway');
    assert.match(root.innerHTML, /requested gpt-5.6 · effective gpt-5.6/);
    assert.deepEqual(calls.find(({ path }) => path.endsWith('/github-connect'))?.payload, {
      repository: 'owner/repository', branch: 'work', expectedGeneration: 1,
    });
    assert.deepEqual(calls.find(({ method, path }) => method === 'POST' && path.endsWith('/openai-key'))?.payload, {
      expectedGeneration: 2,
    });
    assert.ok(calls.every(({ path }) => path !== '/api/control/git-sync'));
  } finally {
    panel.destroy();
  }
});

test('Test Chrome starts one scripted test for the active saved generation and publishes its evidence', async () => {
  const saved = record('alpha');
  const active = pointer('alpha');
  const receipt = {
    state: 'ready', summary: 'Dedicated Chrome and the WebGPU canary passed.', checks: [],
    projectIdentity: {
      projectId: active.projectId,
      targetRootIdentity: active.targetRootIdentity,
      projectProfileHash: active.projectProfileHash,
    },
    profileGeneration: active.profileGeneration,
    executionId: 'BEXEC-1234', gpuReadbacks: [42, 42, 42],
  };
  let finishTest;
  const testResult = new Promise((resolve) => { finishTest = resolve; });
  const calls = [];
  const listeners = new Map();
  const document = Object.assign(new EventTarget(), { defaultView: { CustomEvent } });
  const results = [];
  document.addEventListener('clue:chrome-readiness', (event) => results.push(event.detail));
  const root = {
    innerHTML: '', ownerDocument: document,
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  const actionClient = createActionClient({ request: async (request) => {
    calls.push(request);
    switch (`${request.method} ${request.path}`) {
      case 'GET /api/config': return {};
      case 'GET /api/projects': return { active, projects: [metadata('alpha')], registryGeneration: 1 };
      case 'GET /api/projects/alpha': return { record: saved };
      case 'POST /api/control/chrome-test': return testResult;
      default: throw new Error(`Unexpected request ${request.method} ${request.path}`);
    }
  } });
  const panel = mountConfigurationPanel({ root, actionClient });
  const click = () => listeners.get('click')({
    preventDefault() {}, target: { closest: () => ({ dataset: { cfgAction: 'test-chrome' } }) },
  });

  try {
    await panel.load();
    assert.match(root.innerHTML, /data-cfg-action="test-chrome">TEST CHROME</);
    const browserCard = root.innerHTML.match(/<section [^>]*data-section="browser"[\s\S]*?<\/section>/u)?.[0];
    assert.ok(browserCard);
    assert.doesNotMatch(browserCard, /OPEN TEST CHROME|TEST CONNECTION/);
    click();
    click();
    assert.match(root.innerHTML, /data-cfg-action="test-chrome" disabled/);
    assert.match(root.innerHTML, /running the WebGPU canary/);
    assert.deepEqual(calls.filter(({ method }) => method === 'POST'), [{
      method: 'POST', path: '/api/control/chrome-test',
      payload: { projectId: 'alpha', expectedGeneration: saved.generation, expectedProfileHash: saved.projectProfileHash },
    }]);
    assert.equal(results.length, 0);

    finishTest(receipt);
    await setImmediate();
    assert.deepEqual(results, [{ record: saved, receipt }]);
    assert.match(root.innerHTML, /canary passed/);
    assert.match(root.innerHTML, /GPU readbacks · 42, 42, 42/);
    assert.match(root.innerHTML, /Evidence ID · BEXEC-1234/);
  } finally {
    panel.destroy();
  }
});

test('Test Console uses the running saved generation and publishes the completed host receipt', async () => {
  const saved = record('alpha');
  const active = pointer('alpha');
  const receipt = {
    state: 'ready', summary: 'The PowerShell host round trip passed.',
    checks: [{ label: 'PowerShell host', state: 'Verified' }],
    projectIdentity: active, profileGeneration: active.profileGeneration,
    testedAt: '2026-11-09T20:09:28.000Z',
  };
  let finishTest;
  const testResult = new Promise((resolve) => { finishTest = resolve; });
  const calls = [];
  const listeners = new Map();
  const document = Object.assign(new EventTarget(), { defaultView: { CustomEvent } });
  const results = [];
  document.addEventListener('clue:console-readiness', (event) => results.push(event.detail));
  const root = {
    innerHTML: '', ownerDocument: document,
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  const actionClient = createActionClient({ request: async (request) => {
    calls.push(request);
    switch (`${request.method} ${request.path}`) {
      case 'GET /api/config': return { projectProfiles: { runtimeMode: 'project-profile' } };
      case 'GET /api/projects': return { active, projects: [metadata('alpha')], registryGeneration: 1 };
      case 'GET /api/projects/alpha': return { record: saved };
      case 'POST /api/control/console-test': return testResult;
      default: throw new Error(`Unexpected request ${request.method} ${request.path}`);
    }
  } });
  const panel = mountConfigurationPanel({ root, actionClient });
  const click = () => listeners.get('click')({
    preventDefault() {}, target: { closest: () => ({ dataset: { cfgAction: 'test-console' } }) },
  });

  try {
    await panel.load();
    assert.match(root.innerHTML, /data-cfg-action="test-console">TEST CONSOLE</);
    click();
    click();
    assert.match(root.innerHTML, /data-cfg-action="test-console" disabled/);
    assert.match(root.innerHTML, /Running the PowerShell host test/);
    assert.deepEqual(calls.filter(({ method }) => method === 'POST'), [{
      method: 'POST', path: '/api/control/console-test',
      payload: { projectId: 'alpha', expectedGeneration: saved.generation, expectedProfileHash: saved.projectProfileHash },
    }]);
    assert.deepEqual(results, []);

    finishTest(receipt);
    await setImmediate();
    assert.deepEqual(results, [{ record: saved, receipt }]);
    assert.match(root.innerHTML, /PowerShell host round trip passed/);
    assert.match(root.innerHTML, /PowerShell host · Verified/);
  } finally {
    panel.destroy();
  }
});
