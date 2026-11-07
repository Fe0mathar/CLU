import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../configuration/configurationPanel.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const gateway = readFileSync(new URL('../configuration/gatewayEditor.js', import.meta.url), 'utf8');

test('PP-35: the shell mounts modular Configuration and does not persist profiles in app.js', () => {
  assert.match(app, /mountConfigurationPanel\(/);
  assert.match(index, /id="cfgBody"/);
  assert.match(index, /configuration\/configuration\.css/);
  assert.doesNotMatch(app, /localStorage\.(?:setItem|getItem)\([^\n]*project/i);
  assert.doesNotMatch(app, /projectProfileSchema|resolveTargetRootIdentity|createProjectProfile/);
});

test('PP-35: project activation parks every project-bound view until the backend confirms B', () => {
  assert.match(app, /parkForProjectTransition/);
  assert.match(app, /activateProjectIdentity/);
  assert.match(app, /cancelProjectTransition/);
  assert.match(app, /rejected stale\/cross-project frame/);
  assert.match(app, /window\.__q2Field\?\.setProjection\?\.\(null\)/);
  assert.match(app, /__q3Cluster\?\.clearTelemetry/);
  assert.match(app, /renderWork\(null\)/);
  assert.match(app, /renderFeed\(\[\]\)/);
});

test('PP-35: active target identity is visible outside Configuration', () => {
  assert.match(index, /id="activeTargetPill"/);
  assert.match(app, /TARGET \$\{pointer\.projectId\.toUpperCase\(\)\}/);
  assert.match(app, /clue:active-project-changed/);
});

test('PP-35: credential editing is reference-only and raw bytes have no editable form field', () => {
  assert.match(panel, /CREDENTIAL_REFERENCE_INVALID/);
  assert.match(gateway, /SET REFERENCE/);
  assert.match(gateway, /readonly/);
  assert.doesNotMatch(gateway, /type=\"password\"/);
  assert.doesNotMatch(gateway, /textInput\('integrations\.gpt\.credential\.value'/);
});
