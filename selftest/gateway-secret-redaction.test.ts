/** PP-26 — provider transport must never leak credential bytes into public errors or bodies. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parse as parseYaml } from 'yaml';

import {
  OpenAiGatewayError,
  OpenAiResponsesAdapter,
  type GatewayFetch,
} from '../src/ai/gateway/openaiAdapter.js';
import {
  gatewayRoutingPolicySchema,
  type GatewayRoutingPolicy,
} from '../src/ai/gateway/policy.js';

const SECRET = `sk-test-${'r'.repeat(32)}`;

function productionRouting(): GatewayRoutingPolicy {
  return gatewayRoutingPolicySchema.parse(
    parseYaml(readFileSync(join(process.cwd(), 'config', 'policies', 'routing.yaml'), 'utf8')),
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

test('PP-26: provider HTTP error text is redacted while Authorization is confined to transport headers', async () => {
  let observedAuthorization: string | null = null;
  const fetchImpl: GatewayFetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    observedAuthorization = headers.get('authorization');
    assert.equal(JSON.stringify(init?.body ?? null).includes(SECRET), false);
    return new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_api_key',
          message: `provider rejected api_key=${SECRET}`,
        },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  };
  const adapter = new OpenAiResponsesAdapter({
    apiKey: SECRET,
    routing: productionRouting(),
    fetchImpl,
  });

  await assert.rejects(
    adapter.probeModel('gpt-5.6'),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiGatewayError);
      const text = errorText(error);
      assert.equal(text.includes(SECRET), false);
      assert.match(text, /REDACTED/u);
      return true;
    },
  );
  assert.equal(observedAuthorization, `Bearer ${SECRET}`);
});

test('PP-26: network failures that echo a credential are redacted before leaving the adapter', async () => {
  const fetchImpl: GatewayFetch = async () => {
    throw new Error(`socket rejected Authorization: Bearer ${SECRET}`);
  };
  const adapter = new OpenAiResponsesAdapter({
    apiKey: SECRET,
    routing: productionRouting(),
    fetchImpl,
  });

  await assert.rejects(
    adapter.probeModel('gpt-5.6'),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiGatewayError);
      assert.equal(error.code, 'PROVIDER_NETWORK_ERROR');
      const text = errorText(error);
      assert.equal(text.includes(SECRET), false);
      assert.match(text, /REDACTED/u);
      return true;
    },
  );
});
