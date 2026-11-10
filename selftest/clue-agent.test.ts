import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentService, type AgentServiceOptions } from '../src/agent/clueAgent.js';
import { EventLog } from '../src/memory/eventLog.js';

const template = readFileSync(new URL('../../agents/clue/identity.md', import.meta.url), 'utf8');
const scope = '1'.repeat(64);
const exactModel = 'operator-exact-model';
const key = 'sk-proj-operator-test-only';
const optionsTemplate = {
  scope, profileCredential: 'env:OPERATOR_PROFILE_KEY',
  environment: { OPERATOR_PROFILE_KEY: key },
  redact: (text: string): string => text,
  observe: () => ({
    cycleId: 'CYCLE-000001', cycleStage: 'RECOGNIZED', recoveryRequired: true,
    workerState: 'running', missionId: 'MISSION-000002', statusHash: null, capturedAt: null, readiness: 'running',
  }),
} satisfies Partial<AgentServiceOptions>;

function fixture(fetchImpl?: AgentServiceOptions['fetchImpl']) {
  const root = mkdtempSync(join(tmpdir(), 'clue-operator-agent-'));
  const repoRoot = join(root, 'repo');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(join(repoRoot, 'agents', 'clue'), { recursive: true });
  mkdirSync(workspaceRoot);
  const seed = join(repoRoot, 'agents', 'clue', 'identity.md');
  writeFileSync(seed, template);
  const options = {
    ...optionsTemplate, repoRoot, workspaceRoot,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };
  return {
    root, seed, options, workspaceRoot,
    journal: join(workspaceRoot, 'agents', scope, 'events'),
    configured: template.replace('model: null', 'model: ' + exactModel)
      .replace('env:CLUE_AGENT_OPENAI_API_KEY', 'env:OPERATOR_PROFILE_KEY'),
  };
}

function consoleLine(service: AgentService, text: string) {
  return service.console(text, new AbortController().signal, () => true);
}

test('operator identity remains in the selected workspace, validates least authority, and rejects stale edits', () => {
  const f = fixture();
  let service = new AgentService(f.options);
  try {
    const initial = service.readIdentity();
    assert.equal(initial.valid, true);
    assert.equal(service.state().state, 'unbound');
    assert.equal(existsSync(join(f.workspaceRoot, 'agents')), false, 'reads do not create an agent writer');
    for (const change of [
      f.configured.replace('commands: []', 'commands: ["proof run"]'),
      f.configured.replace('commands: []', 'commands: "*"'),
      f.configured.replace('knowledge: [dashboard_status]', 'knowledge: [file_read]'),
      f.configured.replace('env:OPERATOR_PROFILE_KEY', 'env:OTHER_PROFILE_KEY'),
      f.configured + '\nSecret: sk-project-do-not-persist\n',
      f.configured.replace('  fallback: FORBID', '  base_url: https://other.invalid/v1\n  fallback: FORBID'),
    ]) assert.equal(service.validateIdentity(change).ok, false);
    const saved = service.applyIdentity(f.configured, initial.hash, 'operator model binding');
    assert.equal(saved.ok, true);
    assert.equal(service.readIdentity().version, 2);
    assert.equal(service.applyIdentity(f.configured, initial.hash, 'outdated').ok, false);
    assert.equal(readFileSync(f.seed, 'utf8'), template, 'repository seed never changes');
    service.close();
    service = new AgentService(f.options);
    assert.equal(service.readIdentity().brain?.model, exactModel);
    assert.equal(service.readIdentity().versions.length, 2);
    assert.equal(service.revertIdentity(initial.hash!, service.readIdentity().hash).ok, true);
    assert.equal(service.readIdentity().text, template);
    const other = new AgentService({ ...f.options, scope: '2'.repeat(64) });
    try {
      assert.equal(other.readIdentity().text, template);
      assert.equal(other.readIdentity().versions.length, 1);
      assert.equal(other.state().ledger.records, 0);
    } finally {
      other.close();
    }
  } finally {
    service.close();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('operator turns use only bound model and projected facts, persist redacted dialogue, and run no tools', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const f = fixture(async (input, init) => {
    requests.push({ url: String(input), init });
    if (init?.method === 'GET') return Response.json({ id: exactModel });
    return Response.json({
      id: 'provider-request', model: exactModel, status: 'completed',
      usage: { input_tokens: 3, output_tokens: 4 },
      output_text: '{"action":"start","reply":"Do not dispatch this."} ' + key,
    });
  });
  let service = new AgentService(f.options);
  try {
    const saved = service.applyIdentity(f.configured, service.readIdentity().hash, '');
    assert.equal(saved.ok, true);
    assert.equal((await consoleLine(service, '/proof run')).ok, false);
    assert.equal((await consoleLine(service, '/start')).ok, false);
    assert.equal(requests.length, 0);
    assert.match((await consoleLine(service, '/cycle status')).lines[0]?.text ?? '', /RECOGNIZED/u);
    assert.equal((await service.testBrain(new AbortController().signal)).ok, true);
    const result = await consoleLine(service, 'Please start CLU-E. My accidental key is ' + key);
    assert.equal(result.ok, true);
    assert.deepEqual(result.receipts, []);
    assert.match(result.lines[0]?.text ?? '', /\[REDACTED\]/u);
    assert.deepEqual(requests.map(({ url }) => url), [
      'https://api.openai.com/v1/models/' + exactModel,
      'https://api.openai.com/v1/responses',
    ]);
    const call = requests[1]?.init;
    assert.equal(new Headers(call?.headers).get('authorization'), 'Bearer ' + key);
    assert.equal(call?.redirect, 'error');
    const payload = JSON.parse(String(call?.body));
    assert.equal(payload.model, exactModel);
    assert.equal(payload.store, false);
    assert.equal('tools' in payload, false);
    assert.equal('tool_choice' in payload, false);
    assert.equal(String(payload.input).includes(key), false);
    assert.equal(JSON.parse(String(payload.input)).facts.cycleStage, 'RECOGNIZED');
    assert.ok([...EventLog.replayReadOnly(f.journal)].length >= 3);
    assert.equal(readFileSync(join(f.journal, 'events.ndjson'), 'utf8').includes(key), false);
    service.close();
    service = new AgentService(f.options);
    assert.equal(service.dialogue().length, 1);
    assert.match(service.dialogue()[0]?.message ?? '', /\[REDACTED\]/u);
    assert.equal((await consoleLine(service, '/forget')).ok, true);
    assert.deepEqual(service.dialogue(), []);
    assert.ok(service.activity(-4).rows.some((row) => row.type === 'operator.dialogue_reset'));
  } finally {
    service.close();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('operator halt is durable, aborts an active request, and leaves the cycle untouched', async () => {
  let signal: AbortSignal | null | undefined;
  const f = fixture(async (_input, init) => {
    signal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  let service = new AgentService(f.options);
  try {
    assert.equal(service.applyIdentity(f.configured, service.readIdentity().hash, '').ok, true);
    const pending = consoleLine(service, 'What is happening?');
    assert.equal(service.state().state, 'working');
    assert.equal((await consoleLine(service, '/HALT Reason')).ok, true);
    assert.equal(signal?.aborted, true);
    assert.equal((await pending).ok, false);
    assert.equal(service.state().state, 'halted');
    assert.equal(existsSync(join(f.workspaceRoot, 'events')), false);
    service.close();
    service = new AgentService(f.options);
    assert.equal(service.state().state, 'halted');
    assert.equal((await consoleLine(service, '/resume')).ok, true);
    assert.equal(service.state().state, 'configured');
  } finally {
    service.close();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('operator conversation discards a provider result when its active profile changes', async () => {
  let returnResponse: ((response: Response) => void) | undefined;
  const f = fixture(async () => await new Promise<Response>((resolve) => {
    returnResponse = resolve;
  }));
  const service = new AgentService(f.options);
  try {
    assert.equal(service.applyIdentity(f.configured, service.readIdentity().hash, '').ok, true);
    let current = true;
    const pending = service.console('What is happening?', new AbortController().signal, () => current);
    assert.equal(service.state().state, 'working');
    current = false;
    assert.ok(returnResponse);
    returnResponse(Response.json({
      id: 'provider-request', model: exactModel, status: 'completed',
      usage: { input_tokens: 3, output_tokens: 4 },
      output_text: 'A result from the previous profile.',
    }));
    assert.equal((await pending).ok, false);
    assert.deepEqual(service.dialogue(), []);
    assert.equal(service.activity(0).rows.at(-1)?.type, 'operator.turn_started');
  } finally {
    service.close();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('operator journal refuses a workspace directory redirected to another root', async () => {
  const f = fixture();
  const service = new AgentService(f.options);
  try {
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(f.workspaceRoot, 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(consoleLine(service, '/halt'), /redirected/u);
    assert.equal(existsSync(join(outside, scope)), false);
  } finally {
    service.close();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 3 });
  }
});
