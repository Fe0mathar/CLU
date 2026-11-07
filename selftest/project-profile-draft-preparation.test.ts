/** Batch 7 — server-side Configuration draft preparation and governed-document hashing. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hashText } from '../src/shared/ids.js';
import {
  prepareGovernedDocument,
  prepareProjectProfileDraft,
  ProjectProfileDraftPreparationError,
  ProjectProfileRegistry,
} from '../src/control/projectProfiles/index.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

function errorCode(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    return error instanceof ProjectProfileDraftPreparationError ? error.code : null;
  }
}

test('PP-32: backend prepares a strict non-persistent successor and clears target-specific authority', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    const template = registry.create(fixture.profile, { actor: 'creator', reason: 'TEST_TEMPLATE' });
    const target = join(fixture.root, 'target-beta');
    const workspace = join(fixture.root, 'workspace-beta');
    const shadow = join(fixture.root, 'shadow-beta');
    mkdirSync(target, { recursive: true });

    const prepared = prepareProjectProfileDraft({
      templateProjectId: template.profile.projectId,
      projectId: ' BETA ',
      displayName: 'BETA TARGET',
      targetRoot: target,
      workspaceRoot: workspace,
      shadowRoot: shadow,
      browserProfileDirectory: null,
    }, registry);

    assert.equal(prepared.profile.projectId, 'beta');
    assert.equal(prepared.profile.displayName, 'BETA TARGET');
    assert.equal(prepared.profile.authority.targetDescription, null);
    assert.equal(prepared.profile.authority.masterBenchmark, null);
    assert.deepEqual(prepared.profile.authority.additionalDocuments, []);
    assert.equal(prepared.profile.integrations.git.publicationMode, 'NO_REMOTE_YET');
    assert.equal(prepared.profile.integrations.git.remote, null);
    assert.equal(prepared.profile.integrations.chrome.targetUrl, null);
    assert.equal(prepared.profile.benchmarkRuntime.command, null);
    assert.equal(prepared.profile.benchmarkRuntime.scenario, null);
    assert.equal(prepared.profile.state.greatBookScope, 'beta');
    assert.match(prepared.profile.state.databasePath, /workspace-beta[\\/]db[\\/]clue\.db$/u);
    assert.equal(registry.get('beta'), null, 'preparation must not persist or activate the draft');
    assert.equal(registry.active(), null);
  } finally {
    fixture.dispose();
  }
});

test('PP-32: duplicate Project ID and physical Target Root are refused during preparation', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    registry.create(fixture.profile, { actor: 'creator', reason: 'TEST_TEMPLATE' });
    const otherRoot = join(fixture.root, 'other-target');
    mkdirSync(otherRoot, { recursive: true });

    assert.equal(errorCode(() => prepareProjectProfileDraft({
      templateProjectId: 'alpha', projectId: 'alpha', targetRoot: otherRoot,
      workspaceRoot: join(fixture.root, 'workspace-2'), shadowRoot: join(fixture.root, 'shadow-2'),
    }, registry)), 'PROJECT_DRAFT_ID_ALREADY_REGISTERED');

    assert.equal(errorCode(() => prepareProjectProfileDraft({
      templateProjectId: 'alpha', projectId: 'beta', targetRoot: fixture.target,
      workspaceRoot: join(fixture.root, 'workspace-3'), shadowRoot: join(fixture.root, 'shadow-3'),
    }, registry)), 'PROJECT_DRAFT_TARGET_ALREADY_REGISTERED');
  } finally {
    fixture.dispose();
  }
});

test('PP-32: overlapping target, workspace, shadow or browser zones fail closed', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const registry = new ProjectProfileRegistry(fixture.profilesRoot);
    registry.create(fixture.profile, { actor: 'creator', reason: 'TEST_TEMPLATE' });
    const target = join(fixture.root, 'target-beta');
    mkdirSync(target, { recursive: true });

    assert.equal(errorCode(() => prepareProjectProfileDraft({
      templateProjectId: 'alpha', projectId: 'beta', targetRoot: target,
      workspaceRoot: join(target, 'workspace'), shadowRoot: join(fixture.root, 'shadow-beta'),
    }, registry)), 'PROJECT_DRAFT_PATH_INVALID');
  } finally {
    fixture.dispose();
  }
});

test('PP-33: governed Markdown is resolved and SHA-256-bound by the backend', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const content = '# Security rules\n\nNo secret bytes.\n';
    const documentPath = join(fixture.target, 'security-rules.md');
    writeFileSync(documentPath, content, 'utf8');

    const prepared = prepareGovernedDocument({
      targetRoot: fixture.target,
      path: 'security-rules.md',
      bindingId: 'security-rules',
      kind: 'additional',
      role: 'security',
      enabled: false,
      order: 117,
    }, '2026-08-15T10:00:00.000Z');

    assert.equal(prepared.binding.bindingId, 'security-rules');
    assert.equal(prepared.binding.path, 'security-rules.md');
    assert.equal(prepared.binding.sha256, hashText(content));
    assert.equal(prepared.binding.enabled, false);
    assert.equal(prepared.binding.order, 117);
    assert.equal(prepared.binding.validationState, 'VALID');
    assert.equal(prepared.binding.lastValidated, '2026-08-15T10:00:00.000Z');
  } finally {
    fixture.dispose();
  }
});

test('PP-33: distinguished order is server-owned and non-Markdown input is rejected', () => {
  const fixture = makeProjectProfileFixture();
  try {
    const benchmark = prepareGovernedDocument({
      targetRoot: fixture.target,
      path: 'master-benchmark.md',
      bindingId: 'master-benchmark',
      kind: 'master-benchmark',
      role: 'testing',
      enabled: false,
      order: 999,
      benchmarkId: 'master',
      benchmarkVersion: '1',
    });
    assert.equal(benchmark.binding.order, 1);
    assert.equal(benchmark.binding.enabled, true);

    const wrongType = join(fixture.target, 'not-governed.txt');
    writeFileSync(wrongType, 'not markdown\n', 'utf8');
    assert.equal(errorCode(() => prepareGovernedDocument({
      targetRoot: fixture.target, path: wrongType, bindingId: 'not-governed', kind: 'additional',
      role: 'other', enabled: true, order: 100,
    })), 'GOVERNED_DOCUMENT_INVALID');
  } finally {
    fixture.dispose();
  }
});
