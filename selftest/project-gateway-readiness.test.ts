/** PP-26 — exact-model project gateway readiness and credential-reference safety. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadGatewayPolicies } from '../src/ai/gateway/policy.js';
import { loadLegacyConfig } from '../src/control/runtime.js';
import { testProjectGatewayReadiness } from '../src/control/projectProfiles/gatewayReadiness.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { resolveProjectRuntimeBinding } from '../src/control/projectProfiles/projectRuntimeBinding.js';
import { cloneProfile, makeProjectProfileFixture } from './project-profile-fixture.js';

const SECRET = `sk-test-${'x'.repeat(32)}`;
const CHECKED_AT = '2026-08-15T01:00:00.000Z';

function setup() {
  const fixture = makeProjectProfileFixture();
  const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
  const config = loadLegacyConfig(process.cwd());
  const policies = loadGatewayPolicies(process.cwd(), config);
  return { fixture, record, config, policies };
}

test('PP-26: exact requested/effective model and credential reference produce READY without exposing secret bytes', async (t) => {
  const state = setup();
  t.after(() => state.fixture.dispose());
  const result = await testProjectGatewayReadiness(
    state.record,
    state.config,
    state.policies,
    {
      globalCredentialReference: 'env:OPENAI_API_KEY',
      environment: { OPENAI_API_KEY: SECRET },
      checkedAt: CHECKED_AT,
      providerState: 'ready',
      probeModel: async ({ model, credential }) => {
        assert.equal(model, 'gpt-5.6');
        assert.equal(credential, SECRET);
        return { id: model };
      },
    },
  );

  assert.equal(result.state, 'READY');
  assert.equal(result.ready, true);
  assert.equal(result.requestedModel, 'gpt-5.6');
  assert.equal(result.effectiveModel, 'gpt-5.6');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.providerState, 'ready');
  assert.equal(result.providerReachable, true);
  assert.equal(result.spendAuthority, 'openai_platform');
  assert.equal(result.localBudgetEnforced, false);
  assert.equal(result.credentialReference, 'env:OPENAI_API_KEY');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('PP-26: missing secret bytes remain CREDENTIAL MISSING while the safe reference stays visible', async (t) => {
  const state = setup();
  t.after(() => state.fixture.dispose());
  const result = await testProjectGatewayReadiness(
    state.record,
    state.config,
    state.policies,
    {
      globalCredentialReference: 'env:OPENAI_API_KEY',
      environment: {},
      checkedAt: CHECKED_AT,
    },
  );
  assert.equal(result.state, 'CREDENTIAL MISSING');
  assert.equal(result.ready, false);
  assert.equal(result.credentialReference, 'env:OPENAI_API_KEY');
  assert.equal(result.credentialPresent, false);
});

test('Project Profile checks the saved model against effective OpenAI routing', async (t) => {
  const state = setup();
  t.after(() => state.fixture.dispose());
  const registry = new ProjectProfileRegistry(state.fixture.profiles);
  const model = 'gpt-5-mini';
  const profile = cloneProfile(state.record.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const gpt = integrations['gpt'] as Record<string, unknown>;
    gpt['modelId'] = model;
  });
  const record = registry.update(profile, state.record.generation, { actor: 'creator', reason: 'test model selection' });
  const result = await testProjectGatewayReadiness(record, state.config, state.policies, {
    globalCredentialReference: 'env:OPENAI_API_KEY',
    environment: { OPENAI_API_KEY: SECRET },
    probeModel: async (input) => {
      assert.equal(input.model, model);
      return { id: model };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.profileGeneration, record.generation);
  assert.equal(result.requestedModel, model);
  assert.equal(result.effectiveModel, model);

  const incompatible = await testProjectGatewayReadiness(record, state.config, {
    ...state.policies,
    routing: { ...state.policies.routing, local_pricing_authoritative: true },
  }, {
    globalCredentialReference: 'env:OPENAI_API_KEY',
    environment: { OPENAI_API_KEY: SECRET },
    probeModel: async () => assert.fail('model with no governed local price must not reach the provider'),
  });
  assert.equal(incompatible.code, 'GATEWAY_POLICY_MISMATCH');
  assert.equal(incompatible.ready, false);
});

test('PP-26: provider model substitution fails closed instead of becoming a silent fallback', async (t) => {
  const state = setup();
  t.after(() => state.fixture.dispose());
  const result = await testProjectGatewayReadiness(
    state.record,
    state.config,
    state.policies,
    {
      globalCredentialReference: 'env:OPENAI_API_KEY',
      environment: { OPENAI_API_KEY: SECRET },
      checkedAt: CHECKED_AT,
      probeModel: async () => ({ id: 'gpt-other' }),
    },
  );
  assert.equal(result.state, 'MODEL UNAVAILABLE');
  assert.equal(result.ready, false);
  assert.equal(result.effectiveModel, 'gpt-other');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.providerState, 'ready');
  assert.equal(result.providerReachable, true);
});

test('PP-26: provider funding exhaustion is a controlled pause and performs no connection probe', async (t) => {
  const state = setup();
  t.after(() => state.fixture.dispose());
  let probes = 0;
  const result = await testProjectGatewayReadiness(
    state.record,
    state.config,
    state.policies,
    {
      globalCredentialReference: 'env:OPENAI_API_KEY',
      environment: { OPENAI_API_KEY: SECRET },
      checkedAt: CHECKED_AT,
      providerState: 'paused_budget',
      providerPauseReason: 'OpenAI Platform funding unavailable',
      probeModel: async ({ model }) => {
        probes += 1;
        return { id: model };
      },
    },
  );
  assert.equal(result.state, 'CONTROLLED PAUSE');
  assert.equal(result.ready, false);
  assert.equal(result.providerState, 'paused_budget');
  assert.equal(probes, 0);
});

test('PP-26: provider errors are redacted before readiness becomes externally visible', async (t) => {
  const state = setup();
  t.after(() => state.fixture.dispose());
  const result = await testProjectGatewayReadiness(
    state.record,
    state.config,
    state.policies,
    {
      globalCredentialReference: 'env:OPENAI_API_KEY',
      environment: { OPENAI_API_KEY: SECRET },
      checkedAt: CHECKED_AT,
      probeModel: async () => {
        throw new Error(`provider rejected api_key=${SECRET}`);
      },
    },
  );
  assert.equal(result.state, 'PROVIDER UNREACHABLE');
  assert.equal(result.providerState, 'unknown');
  assert.equal(result.providerReachable, false);
  assert.equal(result.credentialPresent, true);
  assert.equal(result.detail.includes(SECRET), false);
  assert.match(result.detail, /REDACTED/u);
});

test('PP-26: a local monetary authority is an explicit policy mismatch', async (t) => {
  const state = setup();
  t.after(() => state.fixture.dispose());
  const result = await testProjectGatewayReadiness(
    state.record,
    state.config,
    {
      ...state.policies,
      budget: {
        ...state.policies.budget,
        spend_authority: 'clue',
      },
    },
    {
      globalCredentialReference: 'env:OPENAI_API_KEY',
      environment: { OPENAI_API_KEY: SECRET },
      checkedAt: CHECKED_AT,
      probeModel: async () => {
        throw new Error('must not probe under the wrong monetary authority');
      },
    },
  );
  assert.equal(result.state, 'POLICY MISMATCH');
  assert.equal(result.code, 'GATEWAY_BUDGET_AUTHORITY_MISMATCH');
  assert.equal(result.spendAuthority, 'clue');
  assert.equal(result.localBudgetEnforced, true);
  assert.equal(result.providerReachable, false);
});

test('PP-26: credential-store references remain profile authority and resolve only through the injected OS-backed resolver', async (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const profile = cloneProfile(fixture.profile, (draft) => {
    const integrations = draft['integrations'] as Record<string, unknown>;
    const gpt = integrations['gpt'] as Record<string, unknown>;
    const credential = gpt['credential'] as Record<string, unknown>;
    credential['value'] = 'credential-store:openai-primary';
  });
  const record = registry.create(profile, { actor: 'creator' });
  const config = loadLegacyConfig(process.cwd());
  const policies = loadGatewayPolicies(process.cwd(), config);
  mkdirSync(join(fixture.target, 'src'), { recursive: true });
  assert.doesNotThrow(() => resolveProjectRuntimeBinding(config, record));

  let requestedReference: string | null = null;
  const result = await testProjectGatewayReadiness(record, config, policies, {
    globalCredentialReference: 'env:OPENAI_API_KEY',
    environment: {},
    checkedAt: CHECKED_AT,
    resolveCredentialReference: async (reference) => {
      requestedReference = reference;
      return SECRET;
    },
    probeModel: async ({ model, credential }) => {
      assert.equal(credential, SECRET);
      return { id: model };
    },
  });

  assert.equal(requestedReference, 'credential-store:openai-primary');
  assert.equal(result.state, 'READY');
  assert.equal(result.credentialReference, 'credential-store:openai-primary');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});
