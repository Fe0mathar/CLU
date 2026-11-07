/** PP-03 — current clue-project-profile/1 schema. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectProfileSchema } from '../src/shared/schemas.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

test('PP-03 accepts one canonical, secret-free Project Profile', () => {
  const fixture = makeProjectProfileFixture();
  try {
    assert.deepEqual(projectProfileSchema.parse(fixture.profile), fixture.profile);
  } finally {
    fixture.dispose();
  }
});

test('PP-03 rejects raw credential bytes and duplicate authority order', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const rawSecret = {
      ...fixture.profile,
      integrations: {
        ...fixture.profile.integrations,
        gpt: {
          ...fixture.profile.integrations.gpt,
          credential: { source: 'project-override', defaultKey: 'gateway.credential', value: 'sk-proj-not-allowed' },
        },
      },
    };
    assert.equal(projectProfileSchema.safeParse(rawSecret).success, false);

    const benchmark = fixture.profile.authority.masterBenchmark;
    assert.ok(benchmark !== null);
    const duplicateOrder = {
      ...fixture.profile,
      authority: {
        ...fixture.profile.authority,
        additionalDocuments: [{
          ...benchmark,
          bindingId: 'extra',
          kind: 'additional',
          role: 'other',
          order: 1,
        }],
      },
    };
    assert.equal(projectProfileSchema.safeParse(duplicateOrder).success, false);
  } finally {
    fixture.dispose();
  }
});
