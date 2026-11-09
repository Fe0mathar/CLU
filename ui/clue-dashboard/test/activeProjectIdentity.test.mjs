/**
 * The STATUS detail uses the backend-owned active Project Profile identity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ribbonSource = await readFile(new URL('../components/ribbon.js', import.meta.url), 'utf8');

test('PP-20: STATUS detail retains the active Project Profile from the sealed frame', () => {
  assert.match(ribbonSource, /snapshot\?\.configuration\?\.project\?\.activeProject/);
  assert.match(ribbonSource, /target\?\.operationIdentity/);
  assert.match(ribbonSource, /identity\.projectId/);
});
