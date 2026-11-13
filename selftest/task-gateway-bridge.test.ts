import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { GATEWAY_EVENT_TYPES, readGatewayCall } from '../src/ai/gateway/gatewayProjection.js';
import { resumeGatewayProvider } from '../src/ai/gateway/modelGateway.js';
import type { GatewayFetch } from '../src/ai/gateway/openaiAdapter.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import {
  enableProjectProfileStartup,
  projectProfileCutoverConfirmation,
} from '../src/control/projectProfiles/projectProfileStartup.js';
import { withRuntime } from '../src/control/runtime.js';
import { PACKET_EVENT_TYPES } from '../src/control/sessionPackets.js';
import { runTaskGatewayCheck } from '../src/control/taskGatewayBridge.js';
import { requireSha256 } from '../src/shared/ids.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { cloneProfile, makeProjectProfileFixture, makeSiblingProjectProfile } from './project-profile-fixture.js';
import { writeProfileRuntimeInstallation } from './project-recognition-fixture.js';

const MODEL = 'gpt-5-mini';
const SECRET = `sk-test-${'x'.repeat(32)}`;

function fixture(t: TestContext) {
  const profile = makeProjectProfileFixture();
  t.after(() => profile.dispose());
  const repoRoot = join(profile.root, 'installation');
  writeProfileRuntimeInstallation(repoRoot);
  for (const path of [
    'config/measurements/catalogue.yaml',
    'config/policies/budget.yaml',
    'config/policies/routing.yaml',
  ]) {
    const to = join(repoRoot, path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(process.cwd(), path), to);
  }

  const registry = new ProjectProfileRegistry(profile.profiles);
  const record = registry.create(cloneProfile(profile.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const gpt = integrations['gpt'] as Record<string, unknown>;
    gpt['modelId'] = MODEL;
  }), { actor: 'creator' });
  withRuntime({ repoRoot, projectProfile: record, withLog: true, workspaceIdentityOnMissing: 'initialize-new' }, (runtime) => {
    assert.ok(runtime.mission);
    runtime.mission.bootstrap();
  });
  enableProjectProfileStartup({
    repoRoot,
    registry,
    projectId: record.profile.projectId,
    confirmation: projectProfileCutoverConfirmation(record),
  });

  return { repoRoot, record, profile, registry, environment: { OPENAI_API_KEY: SECRET } };
}

function providerJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function providerCompleted(text: string): Response {
  return providerJson({
    id: 'resp_task_gateway_fixture',
    model: MODEL,
    output_text: text,
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
  });
}

function fakeProvider(reply: () => Response | Promise<Response>) {
  const requests = { probes: 0, submissions: 0 };
  const fetchImpl: GatewayFetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${SECRET}`);
    if (init?.method === 'GET') {
      requests.probes += 1;
      assert.equal(String(input), `https://api.openai.com/v1/models/${MODEL}`);
      return providerJson({ id: MODEL });
    }
    requests.submissions += 1;
    assert.equal(init?.method, 'POST');
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    const raw = String(init?.body);
    assert.equal(raw.includes(SECRET), false);
    assert.equal(raw.includes('lease_token'), false);
    const payload = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(payload['model'], MODEL);
    assert.equal(payload['store'], false);
    return reply();
  };
  return { fetchImpl, requests };
}

test('task bridge uses the saved model and imports one typed result for concurrent and repeated requests', async (t) => {
  const setup = fixture(t);
  let finishProvider!: () => void;
  let notifySubmitted!: () => void;
  const held = new Promise<void>((resolve) => { finishProvider = resolve; });
  const submitted = new Promise<void>((resolve) => { notifySubmitted = resolve; });
  const provider = fakeProvider(async () => {
    notifySubmitted();
    await held;
    return providerCompleted('{"outcome":"ready"}');
  });
  const options = { ...setup, fetchImpl: provider.fetchImpl };

  const first = runTaskGatewayCheck(options);
  await Promise.race([submitted, first.then(() => assert.fail('The task returned before the provider was called.'))]);
  try {
    const competing = await runTaskGatewayCheck(options);
    assert.equal(competing.state, 'BLOCKED');
    assert.equal(provider.requests.submissions, 1);
  } finally {
    finishProvider();
  }

  const result = await first;
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.code, null);
  assert.ok(result.taskId && result.callId && result.packetHash && result.responseArtifactHash && result.outputHash);
  const repeat = await runTaskGatewayCheck(options);
  assert.equal(repeat.state, 'ALREADY_COMPLETED');
  for (const key of ['taskId', 'callId', 'packetHash', 'responseArtifactHash', 'outputHash'] as const) {
    assert.equal(repeat[key], result[key]);
  }
  assert.deepEqual(provider.requests, { probes: 1, submissions: 1 });

  withRuntime({ repoRoot: setup.repoRoot, withLog: true, requireMission: true }, (runtime) => {
    assert.ok(result.taskId && result.callId && result.outputHash);
    const queue = runtime.requireQueue();
    const task = queue.get(result.taskId);
    assert.equal(task?.type, 'GATEWAY_CHECK');
    assert.equal(task?.state, 'completed');
    assert.equal(queue.attempts(result.taskId).length, 1);
    const call = readGatewayCall(runtime.projections, result.callId);
    assert.deepEqual(call?.projectIdentity, operationIdentityFromProfileRecord(setup.record));
    assert.equal(call?.profileGeneration, setup.record.generation);
    assert.equal(call?.attribution.taskId, task?.id);
    assert.equal(call?.taskType, 'METRIC_ANALYZE');
    assert.equal(call?.model, MODEL);
    assert.equal(call?.responseArtifactHash, result.responseArtifactHash);
    assert.deepEqual(runtime.artifacts.getJson(requireSha256(result.outputHash, 'bridge output hash')), { outcome: 'ready' });
    const events = [...runtime.requireLog().replay()];
    const imports = events.filter((event) => event.type === PACKET_EVENT_TYPES.resultImported && event.subject_id === task?.id);
    assert.equal(imports.length, 1);
    const receipt = imports[0]?.payload as Record<string, unknown>;
    assert.equal(receipt['gateway_call_id'], result.callId);
    assert.equal(receipt['gateway_response_artifact_hash'], result.responseArtifactHash);
    assert.equal(receipt['packet_hash'], result.packetHash);
    assert.equal(JSON.stringify(events).includes(SECRET), false);
  });
});

test('task bridge rejects extra provider fields without publishing an imported result', async (t) => {
  const setup = fixture(t);
  const provider = fakeProvider(() => providerCompleted('{"outcome":"ready","unexpected":true}'));
  const result = await runTaskGatewayCheck({ ...setup, fetchImpl: provider.fetchImpl });
  assert.equal(result.state, 'REJECTED');
  assert.equal(result.outputHash, null);
  assert.deepEqual(provider.requests, { probes: 1, submissions: 1 });
  withRuntime({ repoRoot: setup.repoRoot, withLog: true, requireMission: true }, (runtime) => {
    assert.ok(result.taskId);
    const task = runtime.requireQueue().get(result.taskId);
    assert.ok(task);
    assert.notEqual(task.state, 'completed');
    assert.equal(task.output_hash, null);
    const events = [...runtime.requireLog().replay()];
    assert.ok(events.some((event) => event.type === GATEWAY_EVENT_TYPES.callCompleted));
    assert.ok(!events.some((event) => event.type === PACKET_EVENT_TYPES.resultImported && event.subject_id === task.id));
  });
});

test('task bridge preserves its task across provider funding pause and explicit recovery', async (t) => {
  const setup = fixture(t);
  const pausedProvider = fakeProvider(() => providerJson({ error: {
    code: 'insufficient_quota',
    type: 'insufficient_quota',
    message: 'Project credit balance is exhausted.',
  } }, 429));
  const paused = await runTaskGatewayCheck({ ...setup, fetchImpl: pausedProvider.fetchImpl });
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.code, 'PROVIDER_BUDGET_EXHAUSTED');
  assert.ok(paused.taskId);
  const blocked = await runTaskGatewayCheck({ ...setup, fetchImpl: async () => assert.fail('Funding pause must prevent provider I/O.') });
  assert.equal(blocked.state, 'PAUSED');
  assert.equal(blocked.taskId, paused.taskId);
  assert.deepEqual(pausedProvider.requests, { probes: 1, submissions: 1 });

  const recoveredProvider = fakeProvider(() => providerCompleted('{"outcome":"ready"}'));
  const options = { ...setup, fetchImpl: recoveredProvider.fetchImpl };
  await resumeGatewayProvider(options);
  const recovered = await runTaskGatewayCheck(options);
  assert.equal(recovered.state, 'COMPLETED');
  assert.equal(recovered.taskId, paused.taskId);
  assert.notEqual(recovered.callId, paused.callId);
  assert.deepEqual(recoveredProvider.requests, { probes: 2, submissions: 1 });
  const repeat = await runTaskGatewayCheck(options);
  assert.equal(repeat.state, 'ALREADY_COMPLETED');
  assert.equal(repeat.callId, recovered.callId);
  assert.equal(recoveredProvider.requests.submissions, 1);
});

test('task bridge refuses to import a reply after the active profile changes', async (t) => {
  const setup = fixture(t);
  const other = setup.registry.create(makeSiblingProjectProfile(setup.profile, 'beta'), { actor: 'creator' });
  withRuntime({ repoRoot: setup.repoRoot, projectProfile: other, withLog: true, workspaceIdentityOnMissing: 'initialize-new' }, (runtime) => {
    assert.ok(runtime.mission);
    runtime.mission.bootstrap();
  });
  const provider = fakeProvider(() => {
    setup.registry.activate(other.profile.projectId, { actor: 'creator' });
    return providerCompleted('{"outcome":"ready"}');
  });
  const result = await runTaskGatewayCheck({ ...setup, fetchImpl: provider.fetchImpl });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.outputHash, null);
  assert.deepEqual(provider.requests, { probes: 1, submissions: 1 });

  for (const projectProfile of [setup.record, other]) {
    withRuntime({ repoRoot: setup.repoRoot, projectProfile, withLog: true, requireMission: true }, (runtime) => {
      const tasks = runtime.requireQueue().list();
      assert.ok(tasks.every((task) => task.state !== 'completed' && task.output_hash === null));
      const events = [...runtime.requireLog().replay()];
      assert.ok(!events.some((event) => event.type === PACKET_EVENT_TYPES.resultImported));
    });
  }

  setup.registry.activate(setup.record.profile.projectId, { actor: 'creator' });
  withRuntime({ repoRoot: setup.repoRoot, withLog: true, requireMission: true }, (runtime) => {
    assert.ok(result.taskId && result.callId);
    assert.equal(readGatewayCall(runtime.projections, result.callId)?.state, 'completed');
    runtime.requireQueue().release(result.taskId, 'Fixture clears the interrupted attempt lease.');
  });
  const recovered = await runTaskGatewayCheck({ ...setup, fetchImpl: async () => assert.fail('A persisted reply without an import must not be resubmitted.') });
  assert.equal(recovered.state, 'BLOCKED');
  assert.equal(recovered.code, 'TASK_GATEWAY_PRIOR_CALL_UNRESOLVED');
  assert.equal(recovered.taskId, result.taskId);
});

test('task bridge refuses provider submission when the profile changes during the model probe', async (t) => {
  const setup = fixture(t);
  const other = setup.registry.create(makeSiblingProjectProfile(setup.profile, 'beta'), { actor: 'creator' });
  let calls = 0;
  const result = await runTaskGatewayCheck({ ...setup, fetchImpl: async (_url, init) => {
    calls += 1;
    assert.equal(init?.method, 'GET');
    setup.registry.activate(other.profile.projectId, { actor: 'creator' });
    return providerJson({ id: MODEL });
  } });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.code, 'TASK_GATEWAY_PROFILE_CHANGED');
  assert.equal(calls, 1);
  withRuntime({ repoRoot: setup.repoRoot, projectProfile: setup.record, withLog: true, requireMission: true }, (runtime) => {
    assert.ok(result.callId);
    const call = readGatewayCall(runtime.projections, result.callId);
    assert.equal(call?.state, 'failed');
    assert.equal(call?.errorCode, 'GATEWAY_TASK_LEASE_CHANGED');
  });
});
