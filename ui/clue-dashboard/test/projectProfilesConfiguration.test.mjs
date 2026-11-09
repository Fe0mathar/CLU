import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalAdditionalDocuments,
  renderAuthorityEditor,
} from '../configuration/authorityEditor.js';
import { renderBrowserEditor } from '../configuration/browserEditor.js';
import {
  CREDENTIAL_REFERENCE_PATTERN,
  renderGatewayEditor,
} from '../configuration/gatewayEditor.js';
import { projectDraftProblems, renderProjectEditor } from '../configuration/projectEditor.js';
import { renderProjectReadinessPanel } from '../configuration/projectReadinessPanel.js';
import { renderProjectSelector } from '../configuration/projectSelector.js';

const sha = (letter) => letter.repeat(64);
const profileHash = `profile:v1:${sha('a')}`;
const targetIdentity = `path:v1:posix:${sha('b')}`;

function baseProfile() {
  return {
    profileVersion: 'clue-project-profile/1', projectId: 'alpha', displayName: 'ALPHA',
    targetRoot: '/target/alpha', targetRootIdentity: targetIdentity, workspaceRoot: '/workspace/alpha', shadowRoot: '/shadow/alpha',
    authority: { targetDescription: null, masterBenchmark: null, projectIntent: null, additionalDocuments: [] },
    recognition: { sourceRoots: ['src'], excludedPaths: [], buildConfig: null, adapters: ['typescript'], policy: { policyVersion: 'recognition-policy/1', fullScanOnActivation: false, reuseUnchangedSnapshot: true, followSymlinks: false } },
    benchmarkRuntime: { workingDirectory: '/target/alpha', command: null, scenario: null, warmupRuns: 1, repetitions: 3, timeoutSeconds: 600, targetUrl: null, browserProfile: null, resolution: null, additionalRuntimeArgs: [] },
    integrations: {
      powershell: { executable: { source: 'global-default', defaultKey: 'powershell.executable', value: null }, hostScript: '/host.ps1', hostRootAuthority: 'project-profile', projectRoot: '/target/alpha', workspaceRoot: '/workspace/alpha', shadowRoot: '/shadow/alpha', autonomousProfile: 'restricted' },
      git: { repositoryRoot: '/target/alpha', remote: null, provider: null, defaultBranch: 'main', protectedLandingPolicy: null, currentBasePin: null, publicationMode: 'NO_REMOTE_YET' },
      chrome: { executable: { source: 'global-default', defaultKey: 'browser.executable', value: null }, launchMode: 'CLUE_MANAGED', dedicatedProfileDirectory: '/browser/alpha', remoteDebuggingPort: 9222, allowedOrigins: ['http://127.0.0.1:8080'], targetUrl: 'http://127.0.0.1:8080', targetSelectionRule: 'EXACT_PAGE_ID_THEN_URL_THEN_UNIQUE_ORIGIN' },
      gpt: { provider: 'openai', modelId: 'gpt-5.6', credential: { source: 'project-override', defaultKey: 'gateway.credential', value: 'env:OPENAI_API_KEY' }, enabled: true, fallbackPolicy: 'FORBID' },
    },
    state: { databasePath: '/workspace/alpha/db/clue.db', eventLogRoot: '/workspace/alpha/events', artifactStoreRoot: '/workspace/alpha/artifacts', greatBookScope: 'alpha', recognitionRoot: '/workspace/alpha/recognition', proofRoot: '/workspace/alpha/proof', cycleRoot: '/workspace/alpha/cycles', snapshotRoot: '/workspace/alpha/snapshots' },
    provenance: { source: 'native' },
  };
}

function selectedSnapshot(overrides = {}) {
  const profile = baseProfile();
  return {
    projects: [{ projectId: 'alpha', displayName: 'ALPHA', generation: 1, projectProfileHash: profileHash }],
    active: { projectId: 'alpha', targetRootIdentity: targetIdentity, projectProfileHash: profileHash, profileGeneration: 1 },
    selectedProjectId: 'alpha', selectedRecord: { generation: 1, projectProfileHash: profileHash, profile },
    draft: profile, draftMode: 'update', dirty: false, phase: 'ready', validation: null, readiness: null,
    readinessOperation: 'local-proof', connectionChecks: { host: null, git: null, browser: null, gateway: null },
    ...overrides,
  };
}

test('PP-32: selector exposes exact active identity and uses only declared Configuration actions', () => {
  const html = renderProjectSelector(selectedSnapshot());
  assert.match(html, /id="cfgProjectSelector"/);
  assert.match(html, /data-cfg-action="reload-projects"/);
  assert.match(html, /data-cfg-action="new-project"/);
  assert.match(html, /data-cfg-action="activate-project"/);
  assert.match(html, /ACTIVE TARGET/);
  assert.match(html, /ALPHA/);
  assert.match(html, /generation 1/);
  assert.doesNotMatch(html, /data-config-action=/);
});

test('PP-33: additional governed documents retain explicit deterministic order and disabled state', () => {
  const documents = canonicalAdditionalDocuments([
    { bindingId: 'security', order: 900, enabled: false },
    { bindingId: 'architecture', order: 100, enabled: true },
  ]);
  assert.deepEqual(documents.map((item) => [item.bindingId, item.order]), [
    ['security', 100],
    ['architecture', 101],
  ]);

  const snapshot = selectedSnapshot();
  snapshot.draft.authority.additionalDocuments = documents.map((item) => ({
    ...item, kind: 'additional', path: `${item.bindingId}.md`, canonicalPath: `/target/alpha/${item.bindingId}.md`,
    sha256: sha(item.bindingId === 'security' ? 'c' : 'd'), role: item.bindingId === 'security' ? 'security' : 'architecture',
    validationState: 'VALID', lastValidated: '2026-08-15T00:00:00.000Z',
  }));
  const html = renderAuthorityEditor(snapshot);
  assert.match(html, /security/);
  assert.match(html, /architecture/);
  assert.match(html, /data-additional-enabled-index="0"(?![^>]* checked)/);
  assert.match(html, /data-additional-enabled-index="1"[^>]* checked/);
});

test('PP-33: authority drift and conflicts are visible and fail closed', () => {
  const snapshot = selectedSnapshot({
    validation: {
      authority: { state: 'DRIFTED', issues: [{ bindingId: 'target-description', code: 'AUTHORITY_CHANGED' }] },
      authorityConflicts: {
        state: 'CONFLICTED',
        unresolved: [{ conflictId: 'AUTH-1', description: 'Visual fidelity requirements conflict.' }],
        staleResolutions: [],
      },
    },
  });
  snapshot.draft.authority.targetDescription = {
    bindingId: 'target-description', kind: 'target-description', path: 'target.md', canonicalPath: '/target/alpha/target.md',
    sha256: sha('e'), role: 'product-requirements', enabled: true, order: 0, validationState: 'VALID', lastValidated: '2026-08-15T00:00:00.000Z',
  };
  const html = renderAuthorityEditor(snapshot);
  assert.match(html, /DRIFTED/);
  assert.match(html, /AUTHORITY CONFLICT — FAIL CLOSED/);
  assert.match(html, /Visual fidelity requirements conflict/);
});

test('PP-34/35: credential references match backend syntax and no editable secret field is rendered', () => {
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test('env:OPENAI_API_KEY'), true);
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test('env:openai_api_key'), false);
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test('sk-live-1234567890'), false);
  const html = renderGatewayEditor(selectedSnapshot());
  assert.match(html, /env:OPENAI_API_KEY/);
  assert.match(html, /readonly/);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, /data-profile-path="integrations\.gpt\.credential\.value"/);
  assert.match(html, /data-cfg-action="use-gateway-override"/);
});

test('PP-34: browser ambiguity and wrong-origin refusals are rendered by name', () => {
  for (const [state, code] of [['TARGET_AMBIGUOUS', 'TARGET_AMBIGUOUS'], ['ORIGIN_FORBIDDEN', 'ORIGIN_FORBIDDEN']]) {
    const snapshot = selectedSnapshot();
    snapshot.connectionChecks.browser = { state, ready: false, code, detail: `${code} detail` };
    const html = renderBrowserEditor(snapshot);
    assert.match(html, new RegExp(code));
    assert.match(html, /TEST CHROME/);
  }
});

test('PP-34: NO_REMOTE_YET is represented as READY_LOCAL_ONLY for local proof, not as failure', () => {
  const snapshot = selectedSnapshot({
    readiness: {
      level: 'READY_LOCAL_ONLY', readyForLocalWork: true, readyForRequestedOperations: true,
      authorityState: 'CURRENT', authorityConflictState: 'CLEAR', benchmarkRuntimeState: 'READY', blockers: [],
      capabilities: {
        gitLocal: { state: 'READY_LOCAL_ONLY', ready: true, required: true, code: 'NO_REMOTE_YET', detail: 'Local Git is ready; publication is unavailable.' },
        gitPublication: { state: 'NOT_REQUIRED', ready: true, required: false, code: 'GIT_PUBLICATION_NOT_REQUIRED', detail: 'Not required for local proof.' },
      },
    },
    validation: { state: 'VALID', authority: { state: 'CURRENT' }, authorityConflicts: { state: 'CLEAR' }, benchmarkRuntime: { state: 'READY' } },
  });
  const html = renderProjectReadinessPanel(snapshot);
  assert.match(html, /READY_LOCAL_ONLY/);
  assert.match(html, /NO_REMOTE_YET/);
  assert.match(html, /cfg-badge is-local/);
  assert.doesNotMatch(html, /class="cfg-blockers"/);
});

test('PP-32/34: incomplete benchmark resolution blocks SAVE until both positive dimensions exist', () => {
  const snapshot = selectedSnapshot();
  snapshot.dirty = true;
  snapshot.draft.benchmarkRuntime.resolution = { width: 1920, height: null };
  assert.match(projectDraftProblems(snapshot.draft).join(' '), /both a positive width and height/);
  const html = renderProjectEditor(snapshot);
  assert.match(html, /data-cfg-action="save-profile"[^>]* disabled/);
});
