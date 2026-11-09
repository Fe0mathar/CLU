import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { focusCapabilitySection } from '../configuration/configurationPanel.js';
import { renderGatewayEditor } from '../configuration/gatewayEditor.js';
import { renderGitEditor } from '../configuration/gitEditor.js';
import { renderProjectSelector, renderStartupBinding } from '../configuration/projectSelector.js';
import { renderReadinessReceipt } from '../configuration/viewPrimitives.js';

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

test('PP-35: active target changes still publish identity after the ribbon label is removed', () => {
  assert.doesNotMatch(index, /id="activeTargetPill"/);
  assert.match(app, /window\.__clueActiveProject = Object\.freeze\(/);
  assert.match(app, /clue:active-project-changed/);
});

test('PP-35: credential editing is reference-only and raw bytes have no editable form field', () => {
  assert.match(panel, /CREDENTIAL_REFERENCE_INVALID/);
  assert.match(gateway, /SET REFERENCE/);
  assert.match(gateway, /readonly/);
  assert.doesNotMatch(gateway, /type=\"password\"/);
  assert.doesNotMatch(gateway, /textInput\('integrations\.gpt\.credential\.value'/);
});

test('non-green ribbon capabilities focus their own Configuration card', () => {
  for (const [capability, sectionId] of [['git', 'git'], ['ai', 'gpt-gateway'], ['chrome', 'browser'], ['console', 'powershell-host']]) {
    const calls = [];
    const card = { style: {}, focus: (options) => calls.push(['focus', options]), scrollIntoView: (options) => calls.push(['scroll', options]) };
    const root = { querySelector: (selector) => selector === `[data-section="${sectionId}"]` ? card : null };
    assert.equal(focusCapabilitySection(root, capability), true);
    assert.equal(card.tabIndex, -1);
    assert.deepEqual(calls, [['focus', { preventScroll: true }], ['scroll', { block: 'start', inline: 'nearest' }]]);
  }
  assert.equal(focusCapabilitySection({ querySelector: () => null }, 'unknown'), false);
});

test('persisted readiness metadata is labelled as a past check and stays with the active profile generation', () => {
  const snapshot = {
    active: { projectId: 'clu', profileGeneration: 4, projectProfileHash: 'hash' },
    selectedRecord: { profile: { projectId: 'clu' }, generation: 4, projectProfileHash: 'hash' },
    readinessReceipts: { ai: { state: 'ready', checkedAt: '2026-11-09T15:00:00.000Z' } },
  };
  assert.match(renderReadinessReceipt(snapshot, 'ai'), /Last check · READY/);
  assert.equal(renderReadinessReceipt({ ...snapshot, selectedRecord: { ...snapshot.selectedRecord, generation: 5 } }, 'ai'), '');
});

test('legacy startup distinguishes the registry profile even when both targets have the same ID', () => {
  const active = { projectId: 'clu', profileGeneration: 6, projectProfileHash: `profile:v1:${'09eff493609f'.padEnd(64, '0')}` };
  const configuration = {
    project: { id: 'clu' }, legacyConnectionControls: true,
    projectProfiles: { runtimeMode: 'legacy-v2', active },
  };
  const snapshot = { legacyConfiguration: configuration, registryGeneration: 7, active };
  const markup = renderStartupBinding(snapshot);
  assert.match(markup, /Running target <strong>clu<\/strong> · Registry active profile <strong>clu · g6<\/strong>/);
  assert.match(markup, /Close the running CLU-E Dashboard terminal/);
  assert.match(markup, /Open <code>CLUE-Dashboard\.bat<\/code> again and choose <strong>Y<\/strong> when the launcher offers <strong>clu<\/strong>/);
  assert.doesNotMatch(markup, /cutover-v3|project validate|project init/);
  assert.match(renderProjectSelector(snapshot), /REGISTRY ACTIVE PROFILE/);
  for (const renderEditor of [renderGitEditor, renderGatewayEditor]) {
    assert.match(renderEditor(snapshot), /ribbon checks legacy target <strong>clu<\/strong>/);
    assert.match(renderEditor(snapshot), /data-cfg-action="show-startup-binding"/);
  }
  const updated = { ...snapshot, active: { ...active, profileGeneration: 7 } };
  assert.match(renderStartupBinding(updated), /clu · g7/);
  assert.equal(renderStartupBinding({ legacyConfiguration: { ...configuration, projectProfiles: { runtimeMode: 'project-profile', active } } }), '');
});

test('launcher instructions require a local legacy dashboard and a saved registry profile', () => {
  const configuration = {
    project: { id: '<running>' }, legacyConnectionControls: true,
    projectProfiles: { runtimeMode: 'legacy-v2' },
  };
  const active = { projectId: 'clue1', profileGeneration: 6, projectProfileHash: `profile:v1:${'a'.repeat(64)}` };
  const snapshot = { legacyConfiguration: configuration, registryGeneration: 7, active };
  const escaped = renderStartupBinding({ ...snapshot, active: { ...active, projectId: '<saved>' } });
  assert.match(escaped, /&lt;running&gt;.*&lt;saved&gt;/);
  assert.doesNotMatch(escaped, /<running>|<saved>/);
  assert.match(renderStartupBinding(snapshot), /CLUE-Dashboard\.bat/);
  assert.doesNotMatch(renderStartupBinding({ ...snapshot, active: null }), /CLUE-Dashboard\.bat/);
  assert.doesNotMatch(renderStartupBinding({ ...snapshot, legacyConfiguration: { ...configuration, legacyConnectionControls: false } }), /CLUE-Dashboard\.bat/);
});
