import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { listOpenAiModels } from '../src/ai/gateway/openaiModelCatalogue.js';
import type { GatewayFetch } from '../src/ai/gateway/openaiAdapter.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import type { Runtime } from '../src/control/runtime.js';
import {
  handleProjectProfilesApiRequest,
  ProjectProfilesApiService,
} from '../src/daemon/projectProfilesApi.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

const credentialEnv = 'CLU_TEST_MODEL_CATALOGUE_CREDENTIAL';
const credential = 'sk-test-model-catalogue-credential-not-real';
const eligible = [
  'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra',
];

function setup(fetchImpl: GatewayFetch, allowHostConnections = true, projectMode = false) {
  const fixture = makeProjectProfileFixture();
  const registry = new ProjectProfileRegistry(fixture.profilesRoot);
  const profile = fixture.profile;
  const record = registry.create({
    ...profile,
    integrations: { ...profile.integrations, gpt: {
      ...profile.integrations.gpt,
      credential: projectMode
        ? { source: 'global-default', defaultKey: 'gateway.credential', value: null }
        : { source: 'project-override', defaultKey: 'gateway.credential', value: `env:${credentialEnv}` },
    } },
  }, { actor: 'daemon', reason: 'CATALOGUE_TEST' });
  const policyDirectory = join(fixture.root, 'config', 'policies');
  mkdirSync(policyDirectory, { recursive: true });
  for (const name of ['budget.yaml', 'routing.yaml']) {
    writeFileSync(join(policyDirectory, name), readFileSync(join('config', 'policies', name)));
  }
  if (projectMode) {
    const legacyProfilePath = join('targets', 'clu', 'profile.yaml');
    mkdirSync(join(fixture.root, 'targets', 'clu'), { recursive: true });
    writeFileSync(join(fixture.root, legacyProfilePath), readFileSync(legacyProfilePath));
    const installationConfig = join('config', 'clue.config.yaml');
    writeFileSync(join(fixture.root, installationConfig), readFileSync(installationConfig, 'utf8')
      .replace(/api_key_env: "[^"]+"/u, `api_key_env: "${credentialEnv}"`));
  }
  const runtime = {
    repoRoot: fixture.root,
    profileMode: projectMode ? 'project-profile' : 'legacy-v2',
    config: { gateway: {
      enabled: !projectMode,
      provider: 'openai',
      api_key_env: projectMode ? 'CLU_TEST_ACTIVE_PROFILE_OVERRIDE' : 'OPENAI_API_KEY',
      budget_policy_file: 'config/policies/budget.yaml',
      routing_file: 'config/policies/routing.yaml',
    } },
  } as unknown as Runtime;
  const service = new ProjectProfilesApiService({ registry, runtime, allowHostConnections, openAiModelsFetch: fetchImpl });
  const url = new URL(`http://127.0.0.1/api/projects/${record.profile.projectId}/gpt/models`);
  url.searchParams.set('expectedGeneration', String(record.generation));
  url.searchParams.set('expectedProfileHash', record.projectProfileHash);
  return { fixture, registry, record, service, url, routingPath: join(policyDirectory, 'routing.yaml') };
}

async function get(service: ProjectProfilesApiService, url: URL) {
  let status = 0;
  let headers: Record<string, string> = {};
  let raw = '';
  const response = {
    writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
    end(value: string) { raw = value; },
  } as unknown as ServerResponse;
  const request = { method: 'GET' } as IncomingMessage;
  assert.equal(await handleProjectProfilesApiRequest(request, response, service, url), true);
  return { status, headers, raw, body: JSON.parse(raw) };
}

function catalogue(ids: readonly string[]): Response {
  return Response.json({ object: 'list', data: ids.map((id) => ({ id, owned_by: credential })) });
}

test('model catalogue GET checks saved generation, sends metadata-only auth, and exposes all returned eligible IDs', async (t) => {
  const previous = process.env[credentialEnv];
  process.env[credentialEnv] = credential;
  t.after(() => { if (previous === undefined) delete process.env[credentialEnv]; else process.env[credentialEnv] = previous; });
  let requests = 0;
  const { fixture, registry, record, service, url } = setup(async (input, init) => {
    requests++;
    assert.equal(input, 'https://api.openai.com/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential}`);
    return catalogue([
      ...eligible, 'gpt-5.6-sol', 'gpt-5.6-sol-2026-10-01', 'gpt-5.6-cyber', 'gpt-6-cyber',
      'gpt-4o-transcribe', 'gpt-realtime', 'gpt-image-2', 'gpt-5.6-chat-latest', 'gpt-4o-mini-search-preview',
      'text-embedding-3-small', 'o4-mini', `ft:gpt-4.1:${credential}`, credential,
    ]);
  });
  t.after(() => fixture.dispose());

  const missing = new URL(url);
  missing.searchParams.delete('expectedProfileHash');
  assert.equal((await get(service, missing)).status, 400);
  const stale = new URL(url);
  stale.searchParams.set('expectedGeneration', String(record.generation + 1));
  assert.equal((await get(service, stale)).status, 409);
  assert.equal(requests, 0);

  const result = await get(service, url);
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(requests, 1);
  assert.equal(result.raw.includes(credential), false);
  assert.deepEqual(result.body.data, {
    projectId: record.profile.projectId,
    generation: record.generation,
    projectProfileHash: record.projectProfileHash,
    state: 'READY',
    models: [...eligible, 'gpt-5.6-sol-2026-10-01'].sort(),
  });
  assert.deepEqual(registry.getProfile(record.profile.projectId), record);
  assert.equal(registry.active(), null);
});

test('model catalogue refuses nonlocal callers and alternate hosts without sending a credential', async (t) => {
  let requests = 0;
  const fetchImpl: GatewayFetch = async () => { requests++; return catalogue(eligible); };
  const remote = setup(fetchImpl, false);
  t.after(() => remote.fixture.dispose());
  const refused = await get(remote.service, remote.url);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'LOCAL_DASHBOARD_REQUIRED');
  const local = setup(fetchImpl);
  t.after(() => local.fixture.dispose());
  writeFileSync(local.routingPath, readFileSync(local.routingPath, 'utf8')
    .replace('https://api.openai.com/v1', 'https://api.openai.com.example.invalid/v1'));
  assert.equal((await get(local.service, local.url)).body.data.state, 'POLICY_MISMATCH');
  assert.equal(requests, 0);
});

test('model catalogue suppresses results when the saved generation moves during the provider request', async (t) => {
  const previous = process.env[credentialEnv];
  process.env[credentialEnv] = credential;
  t.after(() => { if (previous === undefined) delete process.env[credentialEnv]; else process.env[credentialEnv] = previous; });
  let sent!: () => void;
  let finish!: (response: Response) => void;
  const requestSent = new Promise<void>((resolve) => { sent = resolve; });
  const { fixture, registry, record, service, url } = setup(() => {
    sent();
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  t.after(() => fixture.dispose());
  const pending = get(service, url);
  await requestSent;
  registry.update(record.profile.projectId, { ...record.profile, displayName: 'Successor' }, record.generation, {
    actor: 'daemon', reason: 'CATALOGUE_TEST_MOVE',
  });
  finish(catalogue(eligible));
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'PROFILE_PRECONDITION_FAILED');
  assert.equal(result.raw.includes(eligible[0]!), false);
});

test('saved profile catalogue inherits installation credentials and enablement across an active profile override', async (t) => {
  const previous = process.env[credentialEnv];
  process.env[credentialEnv] = credential;
  t.after(() => { if (previous === undefined) delete process.env[credentialEnv]; else process.env[credentialEnv] = previous; });
  let requests = 0;
  const { fixture, service, url } = setup(async (_input, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential}`);
    return catalogue(eligible);
  }, true, true);
  t.after(() => fixture.dispose());
  const result = await get(service, url);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.state, 'READY');
  assert.deepEqual(result.body.data.models, [...eligible].sort());
  assert.equal(requests, 1);
});

test('model catalogue never relays provider error text, broken JSON, or oversized metadata', async () => {
  const refused = await listOpenAiModels(credential, async () => new Response(credential, { status: 401 }));
  assert.deepEqual(refused, { state: 'AUTH_REFUSED', models: [] });
  const unreachable = await listOpenAiModels(credential, async () => { throw new Error(credential); });
  assert.deepEqual(unreachable, { state: 'PROVIDER_UNREACHABLE', models: [] });
  const malformed = await listOpenAiModels(credential, async () => new Response(`{${credential}`));
  assert.deepEqual(malformed, { state: 'CATALOGUE_INVALID', models: [] });
  const oversized = await listOpenAiModels(credential, async () => new Response(credential, {
    headers: { 'content-length': String(1024 * 1024 + 1) },
  }));
  assert.deepEqual(oversized, { state: 'CATALOGUE_INVALID', models: [] });
});
