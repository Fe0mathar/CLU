import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  acceptanceTestRuntimePath,
  loadProjectProfilesAcceptanceMatrix,
  uniqueAcceptanceTestPaths,
  validateProjectProfilesAcceptanceMatrix,
  ProjectProfilesAcceptanceMatrixError,
} from '../src/control/projectProfiles/acceptanceMatrix.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

test('PP-36 acceptance matrix covers every numbered Project Profiles Definition-of-Done gate', () => {
  const matrix = loadProjectProfilesAcceptanceMatrix(process.cwd());
  assert.equal(matrix.requirements.length, 28);
  assert.deepEqual(
    matrix.requirements.map((item) => item.id),
    Array.from({ length: 28 }, (_, index) => `PP-DOD-${String(index + 1).padStart(2, '0')}`),
  );
  assert.ok(uniqueAcceptanceTestPaths(matrix).length >= 40);
  assert.ok(matrix.authoritativeWindowsGates.length >= 7);
});

test('PP-36 acceptance matrix test paths map deterministically to built or browser locations', () => {
  assert.equal(
    acceptanceTestRuntimePath('selftest/project-switching.test.ts'),
    'dist/selftest/project-switching.test.js',
  );
  assert.equal(
    acceptanceTestRuntimePath('ui/clue-dashboard/test/configurationState.test.mjs'),
    'ui/clue-dashboard/test/configurationState.test.mjs',
  );
});

test('PP-36 matrix validation rejects duplicate IDs and missing evidence', () => {
  const base = loadProjectProfilesAcceptanceMatrix(process.cwd());
  const duplicated = structuredClone(base) as unknown as Record<string, unknown>;
  const requirements = duplicated['requirements'] as Record<string, unknown>[];
  requirements[1]!['id'] = requirements[0]!['id'];
  assert.throws(
    () => validateProjectProfilesAcceptanceMatrix(duplicated),
    ProjectProfilesAcceptanceMatrixError,
  );

  const empty = structuredClone(base) as unknown as Record<string, unknown>;
  const emptyRequirements = empty['requirements'] as Record<string, unknown>[];
  emptyRequirements[0]!['tests'] = [];
  emptyRequirements[0]!['commands'] = [];
  emptyRequirements[0]!['liveWindows'] = [];
  assert.throws(
    () => validateProjectProfilesAcceptanceMatrix(empty),
    /must not be empty|has no acceptance evidence/u,
  );
});

test('PP-36 loader rejects a matrix referencing a missing test', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const matrix = loadProjectProfilesAcceptanceMatrix(process.cwd());
  const changed = structuredClone(matrix) as unknown as Record<string, unknown>;
  const requirements = changed['requirements'] as Record<string, unknown>[];
  requirements[0]!['tests'] = ['selftest/does-not-exist.test.ts'];
  const config = join(fixture.root, 'matrix.json');
  writeFileSync(config, `${JSON.stringify(changed)}\n`, 'utf8');
  assert.throws(
    () => loadProjectProfilesAcceptanceMatrix(fixture.root, 'matrix.json'),
    /referenced test does not exist/u,
  );
});
