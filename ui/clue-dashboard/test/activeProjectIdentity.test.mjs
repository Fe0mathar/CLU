/**
 * Batch 4 source-contract test: the global dashboard identity rail exposes the
 * backend-owned active Project Profile identity without changing the Q1 design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('PP-20: the dashboard rail exposes the active Project ID', () => {
  assert.match(appSource, /snapshot\.configuration\?\.project\?\.activeProject/);
  assert.match(appSource, /operationIdentity\?\.projectId/);
  assert.match(appSource, /ACTIVE TARGET/);
});
