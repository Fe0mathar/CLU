import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import { createActionClient } from '../configuration/actionContracts.js';
import { mountConfigurationPanel } from '../configuration/configurationPanel.js';
import { renderGitEditor } from '../configuration/gitEditor.js';
import { metadata, record } from './projectProfileUiFixture.mjs';

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
