/** PP-13 — exact Project Authority bindings, disabled-document exclusion, and drift. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  inspectProjectAuthority,
  readActiveAuthorityDocuments,
  requireCurrentProjectAuthority,
  ProjectAuthorityError,
} from '../src/control/projectProfiles/projectAuthority.js';
import { computeProjectAuthorityHash } from '../src/control/projectProfiles/profileHash.js';
import { hashBytes } from '../src/shared/ids.js';
import { normalisePathDisplay } from '../src/shared/pathIdentity.js';
import { projectProfileSchema } from '../src/shared/schemas.js';
import { cloneProfile, FIXED_AT, makeProjectProfileFixture } from './project-profile-fixture.js';
import { proofReadyProfile, recordForProfile } from './project-governance-fixture.js';

test('PP-13: active authority is deterministic and disabled documents cannot enter its basis', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const profile = proofReadyProfile(fixture);

  const disabledPath = join(fixture.target, 'disabled-guidance.md');
  writeFileSync(disabledPath, '# Disabled\nThis is not active authority.\n', 'utf8');
  const withDisabled = projectProfileSchema.parse(
    cloneProfile(profile, (draft) => {
      const authority = draft['authority'] as Record<string, unknown>;
      authority['additionalDocuments'] = [
        {
          bindingId: 'disabled-guidance',
          kind: 'additional',
          path: 'disabled-guidance.md',
          canonicalPath: normalisePathDisplay(disabledPath),
          sha256: hashBytes(readFileSync(disabledPath)),
          role: 'creator-instruction',
          enabled: false,
          order: 100,
          validationState: 'UNVALIDATED',
          lastValidated: null,
        },
      ];
    }),
  );
  const record = recordForProfile(fixture, withDisabled);

  const first = inspectProjectAuthority(record);
  const second = inspectProjectAuthority(record);
  assert.equal(first.state, 'CURRENT');
  assert.equal(first.proofReady, true);
  assert.deepEqual(second, first, 'unchanged bytes produce the same manifest and state');
  assert.equal(first.configuredAuthorityHash, computeProjectAuthorityHash(withDisabled));
  assert.deepEqual(
    first.manifest?.documents.map((document) => document.bindingId),
    ['target-description', 'master-benchmark'],
    'disabled guidance remains stored but is excluded from active law',
  );
  assert.equal(
    first.documents.find((document) => document.bindingId === 'disabled-guidance')?.state,
    'DISABLED',
  );

  const texts = readActiveAuthorityDocuments(record);
  assert.equal(texts.length, 2);
  assert.match(texts[0]?.text ?? '', /Target description\./);
  assert.match(texts[1]?.text ?? '', /benchmark_id = fixture-master/);
  assert.equal(requireCurrentProjectAuthority(record).manifestHash, first.manifest?.manifestHash);
});

test('PP-13: changed bytes make authority DRIFTED until a successor profile binds the new hash', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const profile = proofReadyProfile(fixture);
  const record = recordForProfile(fixture, profile);
  const original = requireCurrentProjectAuthority(record);

  writeFileSync(fixture.targetDescription, '# Target\nChanged outside profile governance.\n', 'utf8');
  const drifted = inspectProjectAuthority(record);
  assert.equal(drifted.state, 'DRIFTED');
  assert.equal(drifted.proofReady, false);
  assert.equal(drifted.manifest, null);
  assert.equal(drifted.issues.some((issue) => issue.code === 'DOCUMENT_HASH_MISMATCH'), true);
  assert.throws(
    () => requireCurrentProjectAuthority(record),
    (error: unknown) => error instanceof ProjectAuthorityError && error.snapshot.state === 'DRIFTED',
  );

  const successorProfile = projectProfileSchema.parse(
    cloneProfile(profile, (draft) => {
      const authority = draft['authority'] as Record<string, unknown>;
      const target = authority['targetDescription'] as Record<string, unknown>;
      target['sha256'] = hashBytes(readFileSync(fixture.targetDescription));
      target['lastValidated'] = FIXED_AT;
    }),
  );
  const successor = recordForProfile(fixture, successorProfile, 'governance-successor');
  const current = requireCurrentProjectAuthority(successor);
  assert.notEqual(current.manifestHash, original.manifestHash);
  assert.equal(current.targetDescriptionHash, hashBytes(readFileSync(fixture.targetDescription)));
});

test('PP-13: a canonical-path mismatch is INVALID rather than silently following another file', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const profile = proofReadyProfile(fixture);
  const other = join(fixture.target, 'other-description.md');
  writeFileSync(other, '# Other\n', 'utf8');
  const mismatched = projectProfileSchema.parse(
    cloneProfile(profile, (draft) => {
      const authority = draft['authority'] as Record<string, unknown>;
      const target = authority['targetDescription'] as Record<string, unknown>;
      target['canonicalPath'] = normalisePathDisplay(other);
      target['sha256'] = hashBytes(readFileSync(fixture.targetDescription));
    }),
  );
  const snapshot = inspectProjectAuthority(recordForProfile(fixture, mismatched, 'path-mismatch'));
  assert.equal(snapshot.state, 'INVALID');
  assert.equal(snapshot.issues.some((issue) => issue.code === 'DOCUMENT_PATH_MISMATCH'), true);
});
