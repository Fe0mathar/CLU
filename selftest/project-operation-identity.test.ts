import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashText } from '../src/shared/ids.js';
import {
  ProjectOperationIdentityError,
  assertProjectOperationIdentity,
  canonicalProjectOperationIdentity,
  projectOperationIdentitiesEqual,
  projectOperationIdentityHash,
} from '../src/shared/projectOperationIdentity.js';

const IDENTITY = {
  projectId: 'clu',
  targetRootIdentity: `path:v1:test:${hashText('target')}`,
  projectProfileHash: `profile:v1:${hashText('profile')}`,
};

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof ProjectOperationIdentityError ? error.code : null;
  }
}

test('PP-02: governed operation identity has one deterministic canonical form and hash', () => {
  const reordered = {
    projectProfileHash: IDENTITY.projectProfileHash,
    targetRootIdentity: IDENTITY.targetRootIdentity,
    projectId: IDENTITY.projectId,
  };
  assert.deepEqual(canonicalProjectOperationIdentity(reordered), IDENTITY);
  assert.equal(projectOperationIdentityHash(reordered), projectOperationIdentityHash(IDENTITY));
  assert.ok(projectOperationIdentitiesEqual(reordered, IDENTITY));
});

test('PP-02: missing, unknown, and secret-bearing fields are refused', () => {
  assert.equal(
    codeOf(() => canonicalProjectOperationIdentity({ ...IDENTITY, projectProfileHash: undefined })),
    'INVALID_IDENTITY',
  );
  assert.equal(
    codeOf(() => canonicalProjectOperationIdentity({ ...IDENTITY, apiKey: 'sk-not-allowed' })),
    'INVALID_IDENTITY',
  );
  assert.equal(
    codeOf(() => canonicalProjectOperationIdentity({ ...IDENTITY, projectId: 'CLU' })),
    'INVALID_IDENTITY',
  );
});

test('PP-02: stale or cross-project identities fail closed and name only mismatched fields', () => {
  assert.equal(
    codeOf(() =>
      assertProjectOperationIdentity(IDENTITY, {
        ...IDENTITY,
        projectProfileHash: `profile:v1:${hashText('successor')}`,
      }),
    ),
    'IDENTITY_MISMATCH',
  );
  assert.throws(
    () =>
      assertProjectOperationIdentity(
        IDENTITY,
        {
          projectId: 'murugan',
          targetRootIdentity: `path:v1:test:${hashText('other-target')}`,
          projectProfileHash: `profile:v1:${hashText('other-profile')}`,
        },
        'proof request',
      ),
    /proof request identity mismatch in projectId, targetRootIdentity, projectProfileHash/u,
  );
});
