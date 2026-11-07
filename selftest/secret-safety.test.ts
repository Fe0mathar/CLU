/** Batch 6 — deterministic secret detection and externally safe redaction. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertNoSecretMaterial,
  isCredentialReference,
  looksLikeSecretValue,
  redactSecretText,
  SecretMaterialError,
} from '../src/shared/secretSafety.js';

const SECRET = `sk-test-${'x'.repeat(32)}`;

test('Batch 6: repeated secret checks are deterministic despite global replacement patterns', () => {
  for (let index = 0; index < 5; index += 1) {
    assert.equal(looksLikeSecretValue(SECRET), true);
    assert.equal(looksLikeSecretValue(`Bearer ${SECRET}`), true);
    assert.equal(looksLikeSecretValue(`api_key=${SECRET}`), true);
  }
  assert.equal(looksLikeSecretValue('ordinary diagnostic text'), false);
});

test('Batch 6: redacted provider errors are safe to expose and retain no secret-shaped assignment', () => {
  const result = redactSecretText(`provider rejected api_key=${SECRET}; Authorization: Bearer ${SECRET}`);
  assert.equal(result.redacted, true);
  assert.equal(result.text.includes(SECRET), false);
  assert.match(result.text, /REDACTED/u);
  assert.doesNotThrow(() => assertNoSecretMaterial({ detail: result.text }, 'public readiness'));
});

test('Batch 6: credential references are identity, while raw secret-bearing fields are refused', () => {
  assert.equal(isCredentialReference('env:OPENAI_API_KEY'), true);
  assert.equal(isCredentialReference('credential-store:OpenAI-Primary'), true);
  assert.doesNotThrow(() => assertNoSecretMaterial({ credentialReference: 'env:OPENAI_API_KEY' }));
  assert.throws(
    () => assertNoSecretMaterial({ apiKey: SECRET }),
    (error: unknown) => error instanceof SecretMaterialError,
  );
});
