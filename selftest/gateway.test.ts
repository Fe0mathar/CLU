/**
 * DEV-P2-09 — governed Model Gateway, budget/routing authority and Status truth.
 *
 * The live installation declares one exact OpenAI model but remains fail-closed without the named
 * environment key. Fixtures separately exercise legacy local budgets and provider-side budget
 * authority without persisting a credential.
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  GATEWAY_EVENT_TYPES,
  GATEWAY_PROJECTION,
  readGatewayAggregateFacts,
  readGatewayCall,
} from '../src/ai/gateway/gatewayProjection.js';
import {
  gatewayBudgetPolicySchema,
  gatewayRoutingPolicySchema,
  GATEWAY_TASK_TYPES,
  assessGatewayPolicy,
  bindProjectGatewayModel,
  loadGatewayPolicies,
  priceForUsage,
  type GatewayRoutingPolicy,
} from '../src/ai/gateway/policy.js';
import {
  OpenAiGatewayError,
  OpenAiResponsesAdapter,
  type GatewayFetch,
} from '../src/ai/gateway/openaiAdapter.js';
import {
  invokeGateway,
  readGatewayStatus,
  reconcileGatewayBatch,
  resumeGatewayProvider,
  type GatewayRequest,
} from '../src/ai/gateway/modelGateway.js';
import { authorityFor } from '../src/cli/commandAuthority.js';
import { buildProgram } from '../src/cli/index.js';
import { loadConfig, withRuntime } from '../src/control/runtime.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { windowsOpenAiCredentialReference } from '../src/control/projectProfiles/windowsOpenAiCredential.js';
import { EventLog, type AppendEventInput } from '../src/memory/eventLog.js';
import { CycleRegistry } from '../src/cycle/cycleRegistry.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { ProjectionStore } from '../src/memory/db.js';
import { isBranchUnavailable } from '../src/status/statusContractV5.js';
import { projectStatusFromRuntime } from '../src/status/statusFromRuntime.js';
import { cloneProfile, makeProjectProfileFixture } from './project-profile-fixture.js';

const SECRET = `sk-test-${'x'.repeat(32)}`;
const AT = '2026-08-13T20:00:00.000Z';
const H = (char: string): string => char.repeat(64).slice(0, 64);

function productionRouting(): GatewayRoutingPolicy {
  return gatewayRoutingPolicySchema.parse(
    parseYaml(readFileSync(join(process.cwd(), 'config', 'policies', 'routing.yaml'), 'utf8')),
  );
}

function responseJson(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function completedProviderBody(model = 'fixture-model'): Record<string, unknown> {
  return {
    id: 'resp_fixture_001',
    model,
    output_text: 'fixture answer',
    usage: {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 3,
      total_tokens: 15,
    },
  };
}

function recursiveFiles(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) output.push(...recursiveFiles(path));
    else output.push(path);
  }
  return output;
}

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly mode?: 'interactive' | 'batch';
  readonly tinyTaskBudget?: boolean;
  readonly providerAuthority?: boolean;
  readonly validateModel?: boolean;
}

function writeGatewayFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-gateway-'));
  const target = join(root, 'target');
  const workspace = join(root, 'workspace');
  mkdirSync(join(target, 'src'), { recursive: true });
  mkdirSync(join(root, 'config', 'policies'), { recursive: true });
  mkdirSync(join(root, 'config', 'measurements'), { recursive: true });
  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(workspace, directory), { recursive: true });
  }

  writeFileSync(join(root, 'CLUE.md'), '# Gateway fixture constitution\n', 'utf8');
  writeFileSync(join(root, 'package.json'), '{"name":"gateway-fixture","private":true}', 'utf8');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8');
  writeFileSync(
    join(root, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true},"include":["src"]}',
    'utf8',
  );
  writeFileSync(join(target, 'src', 'index.ts'), 'export const fixture = true;\n', 'utf8');
  writeFileSync(join(root, 'config', 'policies', 'patching.yaml'), 'mode: NOTIFY\n', 'utf8');
  writeFileSync(join(root, 'config', 'policies', 'equilibrium.yaml'), 'version: 1\n', 'utf8');
  writeFileSync(
    join(root, 'config', 'measurements', 'catalogue.yaml'),
    readFileSync(join(process.cwd(), 'config', 'measurements', 'catalogue.yaml'), 'utf8'),
    'utf8',
  );

  const budget = gatewayBudgetPolicySchema.parse(
    parseYaml(readFileSync(join(process.cwd(), 'config', 'policies', 'budget.yaml'), 'utf8')),
  );
  const routing = productionRouting();
  const enabled = options.enabled === true;
  const mode = options.mode ?? 'interactive';
  const providerAuthority = options.providerAuthority === true;

  const fixtureBudget = {
    ...budget,
    spend_authority: providerAuthority ? 'openai_platform' as const : 'clue' as const,
    require_explicit_caps: !providerAuthority,
    caps: {
      ...budget.caps,
      monthly_hard: enabled && !providerAuthority ? 100 : 0,
      daily_soft: enabled && !providerAuthority ? 50 : 0,
      daily_hard: enabled && !providerAuthority ? 100 : 0,
      per_task_default: enabled && !providerAuthority ? 5 : 0,
      per_task_max: enabled && !providerAuthority ? 10 : 0,
    },
    per_task_budgets: {
      ...budget.per_task_budgets,
      DOC_EXTRACT: enabled ? (options.tinyTaskBudget === true ? 0.000001 : 5) : 0,
    },
    call_modes: {
      ...budget.call_modes,
      default: mode,
      interactive_allowed_tasks:
        mode === 'interactive'
          ? [...new Set([...budget.call_modes.interactive_allowed_tasks, 'DOC_EXTRACT'])]
          : budget.call_modes.interactive_allowed_tasks,
    },
  };
  const disabledRoutes = Object.fromEntries(
    GATEWAY_TASK_TYPES.map((task) => [task, {
      ...routing.routes[task],
      enabled: false,
      model: null,
      pricing: null,
      note: 'fixture route disabled',
    }]),
  ) as GatewayRoutingPolicy['routes'];
  const fixtureRouting = {
    ...routing,
    local_pricing_authoritative: !providerAuthority,
    validate_model_before_use: options.validateModel ?? false,
    price_schedule_version: enabled ? 'FIXTURE-1' : routing.price_schedule_version,
    routes: {
      ...disabledRoutes,
      DOC_EXTRACT: {
        ...routing.routes.DOC_EXTRACT,
        enabled,
        lane: 'extraction' as const,
        mode,
        model: enabled ? 'fixture-model' : null,
        pricing: enabled
          ? {
              input_usd_per_million: 1,
              cached_input_usd_per_million: 0.25,
              output_usd_per_million: 2,
            }
          : null,
        note: enabled ? 'fixture route' : routing.routes.DOC_EXTRACT.note,
      },
    },
  };
  gatewayBudgetPolicySchema.parse(fixtureBudget);
  gatewayRoutingPolicySchema.parse(fixtureRouting);
  writeFileSync(
    join(root, 'config', 'policies', 'budget.yaml'),
    stringifyYaml(fixtureBudget),
    'utf8',
  );
  writeFileSync(
    join(root, 'config', 'policies', 'routing.yaml'),
    stringifyYaml(fixtureRouting),
    'utf8',
  );

  const config = {
    version: 2,
    project: {
      id: 'target',
      name: 'Gateway fixture',
      root: target,
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
      remote: null,
      credential_env: null,
      inputs: { description: null, benchmark: null },
      active_target: null,
    },
    workspace: { root: workspace },
    shadow: {
      root: join(root, 'shadow'),
      clone_mode: 'copy',
      persistent: true,
      install_on_lockfile_change: false,
      install_command: 'node -e "process.exit(0)"',
    },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md'] },
    runtime: {
      package_manager: 'npm',
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        build: 'node -e "process.exit(0)"',
      },
    },
    browser: {
      executable: join(root, 'chrome.exe'),
      remote_debugging_port: 9222,
      profile_dir: join(root, 'browser-profile'),
      allowed_origins: ['http://localhost:*'],
      require_webgpu: true,
    },
    powershell: { executable: 'pwsh.exe', autonomous_profile: 'restricted' },
    analysis: {
      max_context_tokens: 120000,
      reserve_output_tokens: 20000,
      dynamic_edge_confidence_threshold: 0.75,
      monodependency_percentile: 0.35,
    },
    proof: {
      require_frozen_contract: true,
      inconclusive_counts_as_improvement: false,
      require_baseline: true,
      require_guardrails: true,
    },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: {
      mode: 'NOTIFY',
      policy_file: 'config/policies/patching.yaml',
      landing_branch_prefix: 'clue/accepted/',
      merge_strategy: 'fast_forward_only',
      post_land_verify: ['typecheck'],
      auto_revert_on_post_land_failure: true,
    },
    notifications: { status_document: true, windows_toast: false, webhook_url_env: null },
    gateway: {
      enabled,
      provider: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_mode: mode,
      batch_poll_interval_seconds: 300,
      prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] },
      budget_policy_file: 'config/policies/budget.yaml',
      routing_file: 'config/policies/routing.yaml',
    },
    backup: {
      remote: 'origin',
      push_on_verdict: true,
      push_on_landing: true,
      max_remote_staleness_hours: 24,
    },
    security: {
      canonical_source_writes: 'denied',
      real_settlement: 'denied',
      redact_environment: true,
    },
    logging: { level: 'info' },
  };
  writeFileSync(join(root, 'config', 'clue.config.yaml'), stringifyYaml(config), 'utf8');

  withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
    assert.ok(runtime.mission !== null);
    runtime.mission.bootstrap();
    return 0;
  });
  return root;
}

function request(): GatewayRequest {
  return {
    version: 1,
    task_type: 'DOC_EXTRACT',
    input: 'Summarize the fixture.',
    instructions: 'Return one sentence.',
    metadata: { fixture: 'true' },
    attribution: {
      task_id: 'TASK-000001',
      experiment_id: 'EXP-000001',
      finding_id: 'FIND-000001',
    },
    max_output_tokens: 64,
  };
}

test('profile gateway invokes the saved exact model and credential with the existing task policy', async (t) => {
  const root = writeGatewayFixture({ enabled: true, providerAuthority: true, validateModel: true });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const fixture = makeProjectProfileFixture(join(root, 'profile'), { targetRoot: join(root, 'profile', 'alpha') });
  const model = 'gpt-5-mini';
  const reference = windowsOpenAiCredentialReference(fixture.profile.projectId);
  const record = new ProjectProfileRegistry(fixture.profiles).create(cloneProfile(fixture.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const gpt = integrations['gpt'] as Record<string, unknown>;
    gpt['modelId'] = model;
    gpt['credential'] = { source: 'project-override', defaultKey: 'gateway.credential', value: reference };
  }), { actor: 'creator' });
  const runtimeOptions = { repoRoot: root, projectProfile: record };
  withRuntime({ ...runtimeOptions, withLog: true, workspaceIdentityOnMissing: 'initialize-new' }, (runtime) => {
    assert.ok(runtime.mission !== null);
    runtime.mission.bootstrap();
  });

  const installation = loadGatewayPolicies(root, loadConfig(root));
  const bound = bindProjectGatewayModel(installation, model);
  assert.notEqual(bound.routingHash, installation.routingHash);
  assert.notEqual(bound.routingHash, bindProjectGatewayModel(installation, 'gpt-5').routingHash);
  assert.equal(installation.routing.routes.DOC_EXTRACT.model, 'fixture-model');
  assert.deepEqual(bound.routing.routes.UNIT_SUMMARIZE, installation.routing.routes.UNIT_SUMMARIZE);
  assert.deepEqual(bound.routing.routes.DOC_EXTRACT, {
    ...installation.routing.routes.DOC_EXTRACT, model, pricing: null,
  });

  const options = {
    ...runtimeOptions,
    environment: { OPENAI_API_KEY: 'different-installation-key' },
    credentialResolver: { resolve: (received: string) => {
      assert.equal(received, reference);
      return SECRET;
    } },
  };
  let requests = 0;
  const result = await invokeGateway(request(), {
    ...options,
    fetchImpl: async (url, init) => {
      requests += 1;
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${SECRET}`);
      if (requests === 1) {
        assert.equal(init?.method, 'GET');
        assert.equal(String(url), `https://api.openai.com/v1/models/${model}`);
        return responseJson({ id: model });
      }
      assert.equal(init?.method, 'POST');
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(payload['model'], model);
      assert.equal(payload['max_output_tokens'], request().max_output_tokens);
      return responseJson(completedProviderBody(model));
    },
  });
  assert.equal(requests, 2);
  if (result.state !== 'completed') assert.fail(JSON.stringify(result));
  assert.equal(result.record.model, model);
  assert.equal(result.record.lane, 'extraction');
  assert.equal(result.record.profileGeneration, record.generation);
  assert.equal(result.record.pricing.inputUsdPerMillion, 0);
  withRuntime({ ...runtimeOptions, readOnly: true, withLog: false }, (runtime) => {
    const status = readGatewayStatus(runtime, AT, options.environment, options.credentialResolver);
    assert.equal(status.operationallyReady, true);
    assert.equal(status.requestedModel, model);
    assert.equal(status.effectiveModel, model);
    assert.equal(status.routingHash, bound.routingHash);
    assert.equal(status.credentialReference, reference);
    assert.equal(JSON.stringify(status).includes(SECRET), false);
  });

  const disabled = await invokeGateway({ ...request(), task_type: 'UNIT_SUMMARIZE' }, {
    ...options,
    fetchImpl: async () => assert.fail('profile model must not enable disabled tasks'),
  });
  assert.equal(disabled.state, 'refused');
  if (disabled.state === 'refused') assert.equal(disabled.code, 'ROUTE_DISABLED');

  const substitution = await invokeGateway(request(), {
    ...options,
    fetchImpl: async (_url, init) => init?.method === 'GET'
      ? responseJson({ id: model })
      : responseJson(completedProviderBody('fixture-model')),
  });
  assert.equal(substitution.state, 'failed');
  if (substitution.state === 'failed') assert.equal(substitution.code, 'PROVIDER_MODEL_ID_MISMATCH');

  const changedPolicy = await invokeGateway(request(), {
    ...options,
    fetchImpl: async (_url, init) => {
      if (init?.method === 'GET') return responseJson({ id: model });
      appendFileSync(installation.routingPath, '\n# Routing authority changed during request\n');
      return responseJson(completedProviderBody(model));
    },
  });
  assert.equal(changedPolicy.state, 'failed');
  if (changedPolicy.state === 'failed') assert.equal(changedPolicy.code, 'GATEWAY_POLICY_DRIFT');
});

function gatewayStack(): {
  readonly root: string;
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'clue-gateway-projection-'));
  mkdirSync(join(root, 'events'), { recursive: true });
  const projections = new ProjectionStore(join(root, 'clue.db'), {
    modules: [GATEWAY_PROJECTION],
  });
  const { log } = EventLog.open(join(root, 'events'));
  return {
    root,
    log,
    projections,
    close(): void {
      log.close();
      projections.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function append(log: EventLog, input: AppendEventInput): void {
  log.append(input);
}

test('DEV-P2-09: shipped policies are complete, content-addressed and fail-closed', () => {
  const config = loadConfig(process.cwd());
  const policies = loadGatewayPolicies(process.cwd(), config);
  const assessment = assessGatewayPolicy(config, policies, { OPENAI_API_KEY: SECRET });
  assert.equal(config.gateway.enabled, true);
  assert.equal(assessment.enabled, true);
  assert.equal(assessment.operationallyReady, true);
  assert.equal(assessment.enabledRouteCount, GATEWAY_TASK_TYPES.length);
  assert.equal(policies.budget.spend_authority, 'openai_platform');
  assert.equal(assessment.spendAuthority, 'openai_platform');
  assert.equal(assessment.localBudgetEnforced, false);
  assert.equal(assessment.localPricingAuthoritative, false);
  assert.equal(assessment.preferredModel, 'gpt-5.6-sol');
  assert.equal(policies.routing.validate_model_before_use, true);
  assert.equal(config.gateway.default_mode, 'interactive');
  assert.equal(policies.budget.caps.daily_hard, 0);
  assert.equal(policies.budget.caps.monthly_hard, 0);
  assert.deepEqual(Object.keys(policies.routing.routes).sort(), [...GATEWAY_TASK_TYPES].sort());
  assert.ok(Object.values(policies.routing.routes).every((route) =>
    route.enabled && route.model === 'gpt-5.6-sol' && route.pricing === null,
  ));
  assert.match(policies.budgetHash, /^[0-9a-f]{64}$/u);
  assert.match(policies.routingHash, /^[0-9a-f]{64}$/u);
});

test('DEV-P2-09: policy schemas refuse an enabled route without model and incoherent allocations', () => {
  const routing = parseYaml(
    readFileSync(join(process.cwd(), 'config', 'policies', 'routing.yaml'), 'utf8'),
  ) as Record<string, any>;
  const routingRecord = routing as { routes: { DOC_EXTRACT: { enabled: boolean; model: string | null; pricing: unknown } } };
  routingRecord.routes.DOC_EXTRACT.enabled = true;
  routingRecord.routes.DOC_EXTRACT.model = null;
  routingRecord.routes.DOC_EXTRACT.pricing = null;
  assert.equal(gatewayRoutingPolicySchema.safeParse(routing).success, false);

  const budget = parseYaml(
    readFileSync(join(process.cwd(), 'config', 'policies', 'budget.yaml'), 'utf8'),
  ) as Record<string, any>;
  const budgetRecord = budget as { lane_allocation: { extraction: number } };
  budgetRecord.lane_allocation.extraction = 0.25;
  const result = gatewayBudgetPolicySchema.safeParse(budget);
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /sum to 1\.0/);
});

test('DEV-P2-09: price accounting separates cached input and batch discount', () => {
  const price = priceForUsage(
    {
      input_usd_per_million: 10,
      cached_input_usd_per_million: 2,
      output_usd_per_million: 20,
    },
    { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 },
    0.5,
  );
  assert.equal(price, ((600 * 10 + 400 * 2 + 200 * 20) / 1_000_000) * 0.5);
});

test('DEV-P2-09: interactive Responses request is bounded, store:false and keeps the key out of the body', async () => {
  const routing = productionRouting();
  let called = 0;
  const fetchImpl: GatewayFetch = async (input, init) => {
    called += 1;
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${SECRET}`);
    const body = String(init?.body);
    assert.equal(body.includes(SECRET), false);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed['store'], false);
    assert.equal(parsed['model'], 'fixture-model');
    return responseJson(completedProviderBody(), 200, { 'x-request-id': 'req_header_1' });
  };
  const adapter = new OpenAiResponsesAdapter({ apiKey: SECRET, routing, fetchImpl });
  const result = await adapter.invokeInteractive({
    callId: `GWCALL-${'a'.repeat(32)}`,
    model: 'fixture-model',
    input: 'input',
    instructions: 'instruction',
    maxOutputTokens: 64,
    metadata: { clue_call_id: 'fixture' },
  });
  assert.equal(called, 1);
  assert.equal(result.outputText, 'fixture answer');
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    cachedInputTokens: 4,
    outputTokens: 3,
    totalTokens: 15,
  });
});

test('DEV-P2-09: provider HTTP failures are typed/retryable and oversized bodies are refused before reading', async () => {
  const routing = productionRouting();
  const http = new OpenAiResponsesAdapter({
    apiKey: SECRET,
    routing,
    fetchImpl: async () => responseJson({ error: { message: 'rate limited' } }, 429),
  });
  await assert.rejects(
    () =>
      http.invokeInteractive({
        callId: `GWCALL-${'b'.repeat(32)}`,
        model: 'fixture-model',
        input: 'input',
        instructions: null,
        maxOutputTokens: 8,
        metadata: {},
      }),
    (error: unknown) =>
      error instanceof OpenAiGatewayError &&
      error.code === 'PROVIDER_RATE_LIMIT' &&
      error.retryable,
  );

  const oversized = new OpenAiResponsesAdapter({
    apiKey: SECRET,
    routing: {
      ...routing,
      api: { ...routing.api, max_response_bytes: 1024 },
    },
    fetchImpl: async () =>
      new Response('not read', {
        status: 200,
        headers: { 'content-length': '2048' },
      }),
  });
  await assert.rejects(
    () =>
      oversized.invokeInteractive({
        callId: `GWCALL-${'c'.repeat(32)}`,
        model: 'fixture-model',
        input: 'input',
        instructions: null,
        maxOutputTokens: 8,
        metadata: {},
      }),
    (error: unknown) =>
      error instanceof OpenAiGatewayError && error.code === 'PROVIDER_RESPONSE_TOO_LARGE',
  );
});

test('DEV-P2-09: Batch upload/submission/reconciliation binds the call row and treats cancelling as pending', async () => {
  const routing = productionRouting();
  const calls: string[] = [];
  const fetchImpl: GatewayFetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/files') && init?.method === 'POST') {
      assert.ok(init.body instanceof FormData);
      assert.equal(new Headers(init.headers).has('content-type'), false, 'fetch owns the multipart boundary');
      return responseJson({ id: 'file_input_1' });
    }
    if (url.endsWith('/batches') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body['input_file_id'], 'file_input_1');
      assert.equal(body['endpoint'], '/responses');
      assert.equal(body['completion_window'], '24h');
      return responseJson({ id: 'batch_1', status: 'in_progress' });
    }
    if (url.endsWith('/batches/batch_1')) {
      return responseJson({ id: 'batch_1', status: 'completed', output_file_id: 'file_output_1' });
    }
    if (url.endsWith('/files/file_output_1/content')) {
      return new Response(
        `${JSON.stringify({
          custom_id: `GWCALL-${'d'.repeat(32)}`,
          response: { status_code: 200, request_id: 'req_batch_1', body: completedProviderBody() },
          error: null,
        })}\n`,
        { status: 200, headers: { 'content-type': 'application/jsonl' } },
      );
    }
    throw new Error(`Unexpected fixture URL ${url}`);
  };
  const adapter = new OpenAiResponsesAdapter({ apiKey: SECRET, routing, fetchImpl });
  const callId = `GWCALL-${'d'.repeat(32)}`;
  const submitted = await adapter.submitBatch({
    callId,
    model: 'fixture-model',
    input: 'input',
    instructions: null,
    maxOutputTokens: 64,
    metadata: {},
  });
  assert.equal(submitted.providerBatchId, 'batch_1');
  const completed = await adapter.reconcileBatch('batch_1', callId);
  assert.equal(completed.state, 'completed');
  if (completed.state === 'completed') assert.equal(completed.response.outputText, 'fixture answer');
  assert.equal(calls.length, 4);

  const cancelling = new OpenAiResponsesAdapter({
    apiKey: SECRET,
    routing,
    fetchImpl: async () => responseJson({ id: 'batch_2', status: 'cancelling' }),
  });
  const state = await cancelling.reconcileBatch('batch_2', callId);
  assert.equal(state.state, 'pending');
});

test('DEV-P2-09: event projection is replayable and accounts refusals separately from submitted calls', () => {
  const s = gatewayStack();
  try {
    const callId = `GWCALL-${'e'.repeat(32)}`;
    append(s.log, {
      type: GATEWAY_EVENT_TYPES.callStarted,
      actor: 'gateway',
      missionVersion: 'MISSION-000001',
      subjectId: 'TASK-000001',
      payload: {
        call_id: callId,
        target_id: 'target',
        task_type: 'DOC_EXTRACT',
        lane: 'extraction',
        mode: 'interactive',
        model: 'fixture-model',
        attribution: {
          task_id: 'TASK-000001',
          experiment_id: 'EXP-000001',
          finding_id: 'FIND-000001',
        },
        policy_hash: H('1'),
        routing_hash: H('2'),
        price_schedule_version: 'FIXTURE-1',
        request_artifact_hash: H('3'),
        request_hash: H('4'),
        estimated_input_tokens: 10,
        max_output_tokens: 20,
        estimated_usd: 0.01,
        pricing: {
          input_usd_per_million: 1,
          cached_input_usd_per_million: 0.25,
          output_usd_per_million: 2,
          batch_discount_fraction: 0,
        },
        started_at: AT,
      },
    });
    append(s.log, {
      type: GATEWAY_EVENT_TYPES.callCompleted,
      actor: 'gateway',
      missionVersion: 'MISSION-000001',
      subjectId: 'TASK-000001',
      payload: {
        call_id: callId,
        provider_request_id: 'resp_1',
        provider_batch_id: null,
        provider_model: 'fixture-model',
        response_artifact_hash: H('5'),
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4, total_tokens: 14 },
        actual_usd: 0.0000165,
        completed_at: '2026-08-13T20:01:00.000Z',
      },
    });
    append(s.log, {
      type: GATEWAY_EVENT_TYPES.callRefused,
      actor: 'gateway',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: {
        call_id: `GWCALL-${'f'.repeat(32)}`,
        target_id: 'target',
        task_type: 'DOC_EXTRACT',
        lane: 'extraction',
        mode: 'batch',
        model: null,
        attribution: { task_id: null, experiment_id: null, finding_id: null },
        policy_hash: H('1'),
        routing_hash: H('2'),
        price_schedule_version: 'FIXTURE-1',
        code: 'ROUTE_DISABLED',
        reason: 'route disabled',
        requested_at: '2026-08-13T20:02:00.000Z',
      },
    });
    s.projections.sync(s.log);
    const record = readGatewayCall(s.projections, callId);
    assert.equal(record?.state, 'completed');
    assert.deepEqual(record?.attribution, {
      taskId: 'TASK-000001',
      experimentId: 'EXP-000001',
      findingId: 'FIND-000001',
    });
    const facts = readGatewayAggregateFacts(s.projections, 'target', '2026-08-13T20:03:00.000Z');
    assert.deepEqual(
      {
        submitted: facts.submitted,
        completed: facts.completed,
        failed: facts.failed,
        refused: facts.refused,
        pending: facts.pending,
      },
      { submitted: 1, completed: 1, failed: 0, refused: 1, pending: 0 },
    );
    s.projections.rebuild(s.log);
    assert.deepEqual(readGatewayAggregateFacts(s.projections, 'target', '2026-08-13T20:03:00.000Z'), facts);
  } finally {
    s.close();
  }
});

test('DEV-P2-09: disabled production choreography records one refusal and performs no fetch', async () => {
  const root = writeGatewayFixture({ enabled: false });
  let fetches = 0;
  try {
    const result = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async () => {
        fetches += 1;
        throw new Error('disabled gateway must not fetch');
      },
    });
    assert.equal(result.state, 'refused');
    if (result.state === 'refused') assert.equal(result.code, 'GATEWAY_DISABLED');
    assert.equal(fetches, 0);
    withRuntime({ withLog: false, readOnly: true, requireMission: false, repoRoot: root }, (runtime) => {
      const status = readGatewayStatus(runtime, AT, { OPENAI_API_KEY: SECRET });
      assert.equal(status.submitted, 0);
      assert.equal(status.refused, 1);
      assert.equal(status.pending, 0);
      assert.equal(status.enabled, false);
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P2-09: enabled interactive call is event-first, exactly accounted and never persists the credential', async () => {
  const root = writeGatewayFixture({ enabled: true, mode: 'interactive' });
  const previous = process.env['OPENAI_API_KEY'];
  process.env['OPENAI_API_KEY'] = SECRET;
  let fetches = 0;
  try {
    const result = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async (_input, init) => {
        fetches += 1;
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${SECRET}`);
        return responseJson(completedProviderBody());
      },
    });
    assert.equal(result.state, 'completed');
    assert.equal(fetches, 1);
    if (result.state !== 'completed') return;
    assert.equal(result.record.state, 'completed');
    assert.equal(result.record.actualUsd, (8 * 1 + 4 * 0.25 + 3 * 2) / 1_000_000);
    assert.deepEqual(result.record.attribution, {
      taskId: 'TASK-000001',
      experimentId: 'EXP-000001',
      findingId: 'FIND-000001',
    });

    withRuntime({ withLog: false, readOnly: true, requireMission: false, repoRoot: root }, (runtime) => {
      const status = readGatewayStatus(runtime, new Date().toISOString(), process.env);
      assert.equal(status.submitted, 1);
      assert.equal(status.completed, 1);
      assert.equal(status.failed, 0);
      assert.equal(status.pending, 0);
      const snapshot = projectStatusFromRuntime(runtime, { capturedAt: new Date().toISOString() }).snapshot;
      assert.equal(snapshot.schemaVersion, '5.8.0');
      assert.equal(snapshot.seal.consistent, true, snapshot.seal.inconsistencies.join('; '));
      assert.equal(isBranchUnavailable(snapshot.aiOrchestration), false);
      if (!isBranchUnavailable(snapshot.aiOrchestration)) {
        assert.equal(snapshot.aiOrchestration.calls.completed, 1);
        assert.equal(snapshot.aiOrchestration.calls.pending, 0);
        assert.equal(snapshot.aiOrchestration.apiKeyEnv, 'OPENAI_API_KEY');
        assert.equal('apiKey' in snapshot.aiOrchestration, false);
      }
      return 0;
    });

    const secretBytes = Buffer.from(SECRET, 'utf8');
    for (const file of recursiveFiles(join(root, 'workspace'))) {
      assert.equal(readFileSync(file).includes(secretBytes), false, `secret not persisted in ${file}`);
    }
  } finally {
    if (previous === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = previous;
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P2-09: per-task budget refusal occurs before provider I/O', async () => {
  const root = writeGatewayFixture({ enabled: true, mode: 'interactive', tinyTaskBudget: true });
  let fetches = 0;
  try {
    const result = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async () => {
        fetches += 1;
        throw new Error('budget refusal must precede fetch');
      },
    });
    assert.equal(result.state, 'refused');
    if (result.state === 'refused') assert.equal(result.code, 'TASK_BUDGET_EXCEEDED');
    assert.equal(fetches, 0);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('DEV-P2-09: batch polling is cadence-bound and timeout becomes one durable failure without resubmission', async () => {
  const root = writeGatewayFixture({ enabled: true, mode: 'batch' });
  try {
    const submitted = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/files') && init?.method === 'POST') return responseJson({ id: 'file_1' });
        if (url.endsWith('/batches') && init?.method === 'POST') {
          return responseJson({ id: 'batch_fixture', status: 'in_progress' });
        }
        throw new Error(`unexpected submission URL ${url}`);
      },
    });
    assert.equal(submitted.state, 'batch_pending');
    if (submitted.state !== 'batch_pending') return;

    let polls = 0;
    const tooSoon = await reconcileGatewayBatch(submitted.callId, {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      now: () => new Date(Date.parse(submitted.record.updatedAt) + 60_000).toISOString(),
      fetchImpl: async () => {
        polls += 1;
        throw new Error('poll interval not reached');
      },
    });
    assert.equal(tooSoon.state, 'batch_pending');
    assert.equal(polls, 0);

    const dueAt = new Date(Date.parse(submitted.record.updatedAt) + 301_000).toISOString();
    const polled = await reconcileGatewayBatch(submitted.callId, {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      now: () => dueAt,
      fetchImpl: async () => {
        polls += 1;
        return responseJson({ id: 'batch_fixture', status: 'cancelling' });
      },
    });
    assert.equal(polled.state, 'batch_pending');
    assert.equal(polls, 1);

    const timedOut = await reconcileGatewayBatch(submitted.callId, {
      repoRoot: root,
      environment: {},
      now: () => new Date(Date.parse(submitted.record.submittedAt) + 27 * 60 * 60 * 1000).toISOString(),
      fetchImpl: async () => {
        polls += 1;
        throw new Error('timeout must not poll or resubmit');
      },
    });
    assert.equal(timedOut.state, 'failed');
    if (timedOut.state === 'failed') assert.equal(timedOut.code, 'BATCH_TIMEOUT');
    assert.equal(polls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});



test('ADR-0017: provider-side budget authority ignores zero local caps and validates the exact model before use', async () => {
  const root = writeGatewayFixture({
    enabled: true,
    mode: 'interactive',
    providerAuthority: true,
    validateModel: true,
  });
  const urls: string[] = [];
  try {
    const result = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async (input, init) => {
        const url = String(input);
        urls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/models/fixture-model')) {
          return responseJson({ id: 'fixture-model', object: 'model', owned_by: 'openai' });
        }
        if (url.endsWith('/responses')) return responseJson(completedProviderBody());
        throw new Error(`unexpected provider URL ${url}`);
      },
    });
    assert.equal(result.state, 'completed');
    assert.deepEqual(urls, [
      'GET https://api.openai.com/v1/models/fixture-model',
      'POST https://api.openai.com/v1/responses',
    ]);
    withRuntime({ withLog: false, readOnly: true, requireMission: false, repoRoot: root }, (runtime) => {
      const status = readGatewayStatus(runtime, new Date().toISOString(), { OPENAI_API_KEY: SECRET });
      assert.equal(status.budgetAuthority, 'openai_platform');
      assert.equal(status.localBudgetEnforced, false);
      assert.equal(status.localPricingAuthoritative, false);
      assert.equal(status.dailyHardUsd, 0);
      assert.equal(status.monthlyHardUsd, 0);
      assert.equal(status.operationallyReady, true);
      assert.deepEqual(status.usage, {
        inputTokens: 12,
        cachedInputTokens: 4,
        outputTokens: 3,
        totalTokens: 15,
        providerRemainingTokens: null,
        providerRemainingTokensAuthoritative: false,
      });
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('ADR-0017: explicit provider billing exhaustion durably pauses new submissions until a successful model probe resumes them', async () => {
  const root = writeGatewayFixture({ enabled: true, mode: 'interactive', providerAuthority: true });
  let calls = 0;
  try {
    withRuntime({ withLog: true, requireMission: true, repoRoot: root }, (runtime) => {
      const log = runtime.requireLog();
      const registry = new CycleRegistry({
        log,
        projections: runtime.projections,
        missionVersion: () => runtime.currentMissionId(),
      });
      const opened = registry.open();
      assert.equal(opened.stage, 'OPENED');
      return 0;
    });

    const failed = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async () => {
        calls += 1;
        return responseJson({
          error: {
            code: 'insufficient_quota',
            type: 'insufficient_quota',
            message: 'Project credit balance is exhausted.',
          },
        }, 429);
      },
    });
    assert.equal(failed.state, 'failed');
    if (failed.state === 'failed') assert.equal(failed.code, 'PROVIDER_BUDGET_EXHAUSTED');
    assert.equal(calls, 1);

    withRuntime({ withLog: false, readOnly: true, requireMission: false, repoRoot: root }, (runtime) => {
      const status = readGatewayStatus(runtime, new Date().toISOString(), { OPENAI_API_KEY: SECRET });
      assert.equal(status.providerPaused, true);
      assert.equal(status.providerBudgetExhausted, true);
      assert.equal(status.operationallyReady, false);
      return 0;
    });
    withRuntime({ withLog: true, requireMission: false, repoRoot: root }, (runtime) => {
      const cycle = new CycleOrchestrator(runtime).status();
      assert.equal(cycle?.stage, 'SUSPENDED');
      assert.equal(cycle?.suspended_from, 'OPENED');
      return 0;
    });

    const blocked = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async () => {
        calls += 1;
        throw new Error('controlled pause must refuse before provider I/O');
      },
    });
    assert.equal(blocked.state, 'refused');
    if (blocked.state === 'refused') assert.equal(blocked.code, 'PROVIDER_BUDGET_PAUSED');
    assert.equal(calls, 1);

    const resumed = await resumeGatewayProvider({
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async (input, init) => {
        calls += 1;
        assert.equal(init?.method, 'GET');
        assert.equal(String(input), 'https://api.openai.com/v1/models/fixture-model');
        return responseJson({ id: 'fixture-model', object: 'model', owned_by: 'openai' });
      },
    });
    assert.equal(resumed.model, 'fixture-model');
    assert.match(resumed.eventId, /^EVENT-/u);
    withRuntime({ withLog: false, readOnly: true, requireMission: false, repoRoot: root }, (runtime) => {
      const status = readGatewayStatus(runtime, new Date().toISOString(), { OPENAI_API_KEY: SECRET });
      assert.equal(status.providerPaused, false);
      assert.equal(status.providerState, 'ready');
      assert.equal(status.operationallyReady, true);
      return 0;
    });
    withRuntime({ withLog: true, requireMission: false, repoRoot: root }, (runtime) => {
      const cycle = new CycleOrchestrator(runtime).status();
      assert.equal(cycle?.stage, 'SUSPENDED', 'provider recovery never resumes the operator-owned cycle');
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('ADR-0017: generic rate limiting is retryable but never mislabelled LACK OF $', async () => {
  const root = writeGatewayFixture({ enabled: true, mode: 'interactive', providerAuthority: true });
  try {
    const result = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async () => responseJson({
        error: { code: 'rate_limit_exceeded', type: 'requests', message: 'Too many requests.' },
      }, 429),
    });
    assert.equal(result.state, 'failed');
    if (result.state === 'failed') {
      assert.equal(result.code, 'PROVIDER_RATE_LIMIT');
      assert.equal(result.retryable, true);
    }
    withRuntime({ withLog: false, readOnly: true, requireMission: false, repoRoot: root }, (runtime) => {
      const status = readGatewayStatus(runtime, new Date().toISOString(), { OPENAI_API_KEY: SECRET });
      assert.equal(status.providerPaused, false);
      assert.equal(status.providerBudgetExhausted, false);
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('ADR-0017: model validation fails closed and never silently substitutes another model', async () => {
  const root = writeGatewayFixture({
    enabled: true,
    mode: 'interactive',
    providerAuthority: true,
    validateModel: true,
  });
  let fetches = 0;
  try {
    const result = await invokeGateway(request(), {
      repoRoot: root,
      environment: { OPENAI_API_KEY: SECRET },
      fetchImpl: async () => {
        fetches += 1;
        return responseJson({ id: 'different-model', object: 'model', owned_by: 'openai' });
      },
    });
    assert.equal(result.state, 'failed');
    if (result.state === 'failed') assert.equal(result.code, 'PROVIDER_MODEL_ID_MISMATCH');
    assert.equal(fetches, 1);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
test('DEV-P2-09: CLI and command authority expose status, invoke, reconcile and controlled resume', () => {
  const group = buildProgram().commands.find((command) => command.name() === 'gateway');
  assert.ok(group !== undefined);
  assert.deepEqual(group?.commands.map((command) => command.name()).sort(), ['invoke', 'reconcile', 'resume', 'status']);
  assert.deepEqual(authorityFor('gateway status'), {
    command: 'gateway status',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale:
      'reads governed routing/budget identities and the rebuildable gateway_calls projection; ' +
      'it must remain usable while the gateway is deliberately disabled',
  });
  assert.equal(authorityFor('gateway invoke')?.capability, 'model.call');
  assert.equal(authorityFor('gateway reconcile')?.capability, 'model.call');
  assert.equal(authorityFor('gateway resume')?.capability, 'model.call');
});
