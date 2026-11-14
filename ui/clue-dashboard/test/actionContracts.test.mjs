/**
 * `DEV-P1-16` — typed action contracts for the dashboard.
 *
 * The same discipline `DEV-P1-07` holds over CLI commands, applied to the UI's action surface: a
 * closed registry, declared authority, and an undeclared request refused rather than sent. The
 * dashboard is a second way into the same workspace and had none of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DASHBOARD_ACTIONS, createActionClient } from '../configuration/actionContracts.js';

function harness({ allowMutating = true } = {}) {
  const sent = [];
  const client = createActionClient({
    allowMutating,
    request: async (spec) => {
      sent.push(spec);
      return { accepted: true };
    },
  });
  return { client, sent };
}

test('DEV-P1-16: a declared action is sent with its declared method and path', async () => {
  const { client, sent } = harness();

  const result = await client.invoke('start');

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/control/start' }]);
});

test('DEV-P1-16: an undeclared action is refused by name and never sent', async () => {
  const { client, sent } = harness();

  const result = await client.invoke('deleteEverything');

  assert.equal(result.ok, false);
  assert.equal(result.refused, 'undeclared-action');
  assert.match(result.reason, /"deleteEverything" is not a declared dashboard action/);
  assert.deepEqual(sent, [], 'nothing reached the transport');
});

test('DEV-P1-16: the registry is closed, and inherited names are not actions', async () => {
  const { client } = harness();

  // `toString` and `constructor` exist on every object. A registry checked with `in` or a bare
  // property read would treat them as declared actions.
  for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    const result = await client.invoke(name);
    assert.equal(result.ok, false, `${name} must not be an action`);
    assert.equal(result.refused, 'undeclared-action');
  }
});

test('DEV-P1-16: a read-only client refuses the mutating actions and allows the rest', async () => {
  const { client, sent } = harness({ allowMutating: false });

  const mutating = await client.invoke('start');
  assert.equal(mutating.refused, 'read-only-client');
  assert.match(mutating.reason, /changes the workspace/);

  const reading = await client.invoke('readConfig');
  assert.equal(reading.ok, true);
  assert.deepEqual(sent, [{ method: 'GET', path: '/api/config' }]);
});

test('DEV-P1-16: every declared action states whether it mutates, and reads are the default', () => {
  for (const [name, action] of Object.entries(DASHBOARD_ACTIONS)) {
    assert.equal(typeof action.mutating, 'boolean', `${name} must declare mutating`);
    assert.ok(action.description.length > 0, `${name} must say what it does`);
    assert.match(action.method, /^(GET|POST|PUT|DELETE)$/);
    assert.match(action.path, /^\/api\//);
    // A GET that mutates would be a contract lying about itself, and caches and prefetchers
    // believe the method.
    if (action.method === 'GET') assert.equal(action.mutating, false, `${name}`);
  }
});

test('DEV-P1-16: a payload for an action that declares none is refused', async () => {
  const { client, sent } = harness();

  const result = await client.invoke('start', { force: true });

  assert.equal(result.refused, 'unexpected-payload');
  assert.deepEqual(sent, []);
});

test('DEV-P1-16: a payload that looks like a credential is refused before it is sent', async () => {
  const { client, sent } = harness();

  const result = await client.invoke('publishCatalogue', {
    catalogueId: 'v6',
    auth: { apiKey: 'sk-live-1234567890' },
  });

  // §5.1 keeps credentials out of the Dashboard entirely. This is the check that catches the day
  // someone adds a field in good faith — a secret in a request log, a proxy and a browser history
  // cannot be un-sent.
  assert.equal(result.refused, 'credential-in-payload');
  assert.match(result.reason, /auth\.apiKey/);
  assert.deepEqual(sent, []);
});

test('DEV-P1-16: an ordinary payload passes through untouched', async () => {
  const { client, sent } = harness();

  const result = await client.invoke('publishCatalogue', { catalogueId: 'v6', metricCount: 100 });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    {
      method: 'POST',
      path: '/api/catalogues',
      payload: { catalogueId: 'v6', metricCount: 100 },
    },
  ]);
});

test('DEV-P1-16: a transport failure is a named refusal, not an exception into the shell', async () => {
  const client = createActionClient({
    request: async () => {
      throw new Error('the daemon is not listening');
    },
  });

  const result = await client.invoke('refresh');

  assert.equal(result.ok, false);
  assert.equal(result.refused, 'transport-failed');
  assert.match(result.reason, /the daemon is not listening/);
});

test('ADR-0017: manual Git sync is one distinct declared action and Start never implies it', async () => {
  const { client, sent } = harness();

  const start = await client.invoke('start');
  assert.equal(start.ok, true);
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/control/start' }]);

  const sync = await client.invoke('syncGit');
  assert.equal(sync.ok, true);
  assert.deepEqual(sent, [
    { method: 'POST', path: '/api/control/start' },
    { method: 'POST', path: '/api/control/git-sync' },
  ]);
});

test('screening with findings is a distinct mutating action with a fixed route and no request body', async () => {
  const { client, sent } = harness();
  assert.equal((await client.invoke('startWithFindings', { args: ['--other'] })).refused, 'unexpected-payload');
  assert.equal((await harness({ allowMutating: false }).client.invoke('startWithFindings')).refused, 'read-only-client');
  assert.equal((await client.invoke('startWithFindings')).ok, true);
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/control/start-with-findings' }]);
});

test('PP-35: Project Profile routes bind explicit IDs, methods, bodies and readiness operation', async () => {
  const { client, sent } = harness();

  assert.equal((await client.invoke('readProject', { params: { projectId: 'alpha/beta' } })).ok, true);
  assert.equal((await client.invoke('updateProject', {
    params: { projectId: 'alpha' },
    payload: { profile: { projectId: 'alpha' }, expectedGeneration: 3 },
  })).ok, true);
  assert.equal((await client.invoke('readProjectReadiness', {
    params: { projectId: 'alpha' },
    query: { operation: 'browser-benchmark' },
  })).ok, true);

  assert.deepEqual(sent, [
    { method: 'GET', path: '/api/projects/alpha%2Fbeta' },
    {
      method: 'PUT',
      path: '/api/projects/alpha',
      payload: { profile: { projectId: 'alpha' }, expectedGeneration: 3 },
    },
    { method: 'GET', path: '/api/projects/alpha/readiness?operation=browser-benchmark' },
  ]);
});

test('PP-35: only governed credential references may cross the Configuration action boundary', async () => {
  const { client, sent } = harness();
  const safe = await client.invoke('createProject', {
    profile: {
      integrations: {
        gpt: {
          credential: {
            source: 'project-override',
            defaultKey: 'gateway.credential',
            value: 'env:OPENAI_API_KEY',
          },
        },
      },
    },
  });
  assert.equal(safe.ok, true);

  for (const value of ['env:openai_api_key', 'sk-live-1234567890', 'plain-text-secret']) {
    const refused = await client.invoke('createProject', {
      profile: {
        integrations: {
          gpt: {
            credential: {
              source: 'project-override',
              defaultKey: 'gateway.credential',
              value,
            },
          },
        },
      },
    });
    assert.equal(refused.ok, false, value);
    assert.equal(refused.refused, 'credential-in-payload', value);
  }
  assert.equal(sent.length, 1, 'only the reference-safe request reaches transport');
});

test('PP-35: Project Profile routes encode explicit identity and never trust the visible dropdown', async () => {
  const { client, sent } = harness();

  const result = await client.invoke('readProject', {
    params: { projectId: 'client/a' },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ method: 'GET', path: '/api/projects/client%2Fa' }]);
});

test('PP-35: successor saves use PUT with an optimistic generation body', async () => {
  const { client, sent } = harness();
  const payload = {
    profile: {
      projectId: 'alpha',
      integrations: {
        gpt: {
          credential: {
            source: 'project-override',
            defaultKey: 'gateway.credential',
            value: 'env:OPENAI_API_KEY',
          },
        },
      },
    },
    expectedGeneration: 7,
  };

  const result = await client.invoke('updateProject', {
    params: { projectId: 'alpha' },
    payload,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ method: 'PUT', path: '/api/projects/alpha', payload }]);
});

test('PP-35: approved credential references pass but raw key bytes never reach profile transport', async () => {
  const { client, sent } = harness();
  const safe = await client.invoke('createProject', {
    profile: {
      projectId: 'alpha',
      integrations: {
        gpt: {
          credential: {
            source: 'project-override',
            defaultKey: 'gateway.credential',
            value: 'credential-store:OpenAI/Primary',
          },
        },
      },
    },
  });
  assert.equal(safe.ok, true);
  assert.equal(sent.length, 1);

  const raw = await client.invoke('createProject', {
    profile: {
      projectId: 'beta',
      integrations: {
        gpt: {
          credential: {
            source: 'project-override',
            defaultKey: 'gateway.credential',
            value: 'sk-live-1234567890',
          },
        },
      },
    },
  });
  assert.equal(raw.refused, 'credential-in-payload');
  assert.equal(sent.length, 1, 'the raw-key request was never sent');
});

test('PP-35: draft preparation is a declared non-persistent backend calculation', async () => {
  const { client, sent } = harness({ allowMutating: false });
  const payload = {
    templateProjectId: 'alpha',
    projectId: 'beta',
    targetRoot: 'F:/Targets/Beta',
    workspaceRoot: 'F:/CLU/workspace/beta',
    shadowRoot: 'F:/CLU/shadow/beta',
  };

  const result = await client.invoke('prepareProjectDraft', payload);

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/projects/prepare-draft', payload }]);
  assert.equal(DASHBOARD_ACTIONS.prepareProjectDraft.mutating, false);
});
