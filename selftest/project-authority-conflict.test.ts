/** PP-14 — deterministic structural and explicitly declared authority conflict state. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import {
  assessAuthorityConflicts,
  AuthorityConflictError,
  requireAuthorityConflictClear,
  type AuthorityConflictRecord,
} from '../src/control/projectProfiles/authorityConflict.js';
import { inspectProjectAuthority } from '../src/control/projectProfiles/projectAuthority.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';
import { proofReadyProfile, recordForProfile } from './project-governance-fixture.js';

const AT = '2026-08-14T13:00:00.000Z';

test('PP-14: an unresolved declared conflict blocks the exact authority generation', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = recordForProfile(fixture, proofReadyProfile(fixture));
  const snapshot = inspectProjectAuthority(record);
  assert.ok(snapshot.manifest !== null);
  if (snapshot.manifest === null) return;

  const conflict: AuthorityConflictRecord = {
    conflictVersion: 'clue-authority-conflict/1',
    conflictId: 'AUTH-CONFLICT-0001',
    projectId: record.profile.projectId,
    authorityHash: snapshot.manifest.manifestHash,
    kind: 'semantic-declared',
    description: 'Performance guidance and protected fidelity require Creator resolution.',
    bindingIds: ['target-description', 'master-benchmark'],
    detectedAt: AT,
    resolution: null,
  };
  const assessment = assessAuthorityConflicts(snapshot, [conflict]);
  assert.equal(assessment.state, 'AUTHORITY CONFLICT');
  assert.deepEqual(assessment.unresolved.map((item) => item.conflictId), ['AUTH-CONFLICT-0001']);
  assert.throws(
    () => requireAuthorityConflictClear(assessment),
    (error: unknown) => error instanceof AuthorityConflictError,
  );
});

test('PP-14: a resolution cannot bless the authority generation it says must be superseded', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = recordForProfile(fixture, proofReadyProfile(fixture));
  const snapshot = inspectProjectAuthority(record);
  assert.ok(snapshot.manifest !== null);
  if (snapshot.manifest === null) return;

  const conflict: AuthorityConflictRecord = {
    conflictVersion: 'clue-authority-conflict/1',
    conflictId: 'AUTH-CONFLICT-0002',
    projectId: record.profile.projectId,
    authorityHash: snapshot.manifest.manifestHash,
    kind: 'semantic-declared',
    description: 'A successor authority generation is required.',
    bindingIds: ['target-description'],
    detectedAt: AT,
    resolution: {
      resolutionId: 'AUTH-RESOLUTION-0002',
      resolvedAt: '2026-08-14T13:01:00.000Z',
      resolvedBy: 'creator',
      statement: 'The target description will be amended and rebound.',
      successorAuthorityHash: 'f'.repeat(64),
    },
  };
  const assessment = assessAuthorityConflicts(snapshot, [conflict]);
  assert.equal(assessment.state, 'AUTHORITY CONFLICT');
  assert.deepEqual(assessment.staleResolutions.map((item) => item.conflictId), ['AUTH-CONFLICT-0002']);
});


test('PP-14: a resolution cannot self-bless the conflicted authority hash', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = recordForProfile(fixture, proofReadyProfile(fixture));
  const snapshot = inspectProjectAuthority(record);
  assert.ok(snapshot.manifest !== null);
  if (snapshot.manifest === null) return;

  const conflict: AuthorityConflictRecord = {
    conflictVersion: 'clue-authority-conflict/1',
    conflictId: 'AUTH-CONFLICT-SELF-BLESS',
    projectId: record.profile.projectId,
    authorityHash: snapshot.manifest.manifestHash,
    kind: 'semantic-declared',
    description: 'The conflicted authority generation cannot resolve itself.',
    bindingIds: ['target-description'],
    detectedAt: AT,
    resolution: {
      resolutionId: 'AUTH-RESOLUTION-SELF-BLESS',
      resolvedAt: '2026-08-14T13:02:00.000Z',
      resolvedBy: 'creator',
      statement: 'A successor generation is required.',
      successorAuthorityHash: snapshot.manifest.manifestHash,
    },
  };
  const assessment = assessAuthorityConflicts(snapshot, [conflict]);
  assert.equal(assessment.state, 'AUTHORITY CONFLICT');
  assert.deepEqual(
    assessment.staleResolutions.map((item) => item.conflictId),
    ['AUTH-CONFLICT-SELF-BLESS'],
  );
});

test('PP-14: authority drift remains AUTHORITY CHANGED, not a fabricated semantic conflict', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = recordForProfile(fixture, proofReadyProfile(fixture));
  writeFileSync(fixture.targetDescription, '# Target\nDrifted authority.\n', 'utf8');
  const snapshot = inspectProjectAuthority(record);
  const assessment = assessAuthorityConflicts(snapshot);
  assert.equal(snapshot.state, 'DRIFTED');
  assert.equal(assessment.state, 'CLEAR');
  assert.deepEqual(assessment.structuralReasons, []);
});

test('PP-14: a physically duplicated active authority binding is a structural conflict', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = recordForProfile(fixture, proofReadyProfile(fixture));
  const snapshot = inspectProjectAuthority(record);
  const first = snapshot.documents[0];
  assert.ok(first !== undefined);
  if (first === undefined) return;
  const forged = {
    ...snapshot,
    documents: [
      ...snapshot.documents,
      { ...first, bindingId: 'physical-alias', order: 101, kind: 'additional' as const },
    ],
  };
  const assessment = assessAuthorityConflicts(forged);
  assert.equal(assessment.state, 'AUTHORITY CONFLICT');
  assert.match(assessment.structuralReasons.join('\n'), /bound by both/);
});
