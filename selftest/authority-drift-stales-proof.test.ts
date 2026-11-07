/** PP-15 — changed authority bytes cannot be silently reused by an existing proof basis. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import {
  inspectProjectAuthority,
  ProjectAuthorityError,
  requireCurrentProjectAuthority,
} from '../src/control/projectProfiles/projectAuthority.js';
import { resolveProjectBenchmarkRuntime } from '../src/control/projectProfiles/benchmarkRuntime.js';
import { projectGovernanceBasisFromState } from '../src/control/projectProfiles/projectGovernanceBasis.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';
import { proofReadyProfile, recordForProfile } from './project-governance-fixture.js';

test('PP-15: authority drift removes proof readiness and cannot inherit the old project basis', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = recordForProfile(fixture, proofReadyProfile(fixture), 'authority-drift-proof');

  const current = inspectProjectAuthority(record);
  assert.equal(current.state, 'CURRENT');
  assert.ok(current.manifest !== null);
  const runtime = resolveProjectBenchmarkRuntime(record, current.manifest);
  const originalBasis = projectGovernanceBasisFromState({ record, authority: current, benchmarkRuntime: runtime });
  assert.ok(originalBasis !== null);

  writeFileSync(
    fixture.targetDescription,
    '# Target\nUnbound successor authority bytes.\n',
    'utf8',
  );

  const drifted = inspectProjectAuthority(record);
  assert.equal(drifted.state, 'DRIFTED');
  assert.equal(drifted.proofReady, false);
  assert.equal(drifted.manifest, null);
  assert.ok(drifted.issues.some((issue) => issue.code === 'DOCUMENT_HASH_MISMATCH'));

  const driftedRuntime = resolveProjectBenchmarkRuntime(record, drifted.manifest);
  assert.equal(
    projectGovernanceBasisFromState({ record, authority: drifted, benchmarkRuntime: driftedRuntime }),
    null,
    'a drifted profile generation must not mint a successor proof basis implicitly',
  );
  assert.throws(
    () => requireCurrentProjectAuthority(record),
    (error: unknown) => error instanceof ProjectAuthorityError && error.snapshot.state === 'DRIFTED',
  );
  assert.ok(originalBasis !== null, 'historical proof evidence remains readable under its original immutable basis');
});
