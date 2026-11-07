import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAdditionalDocuments, renderAuthorityEditor } from '../configuration/authorityEditor.js';
import { CREDENTIAL_REFERENCE_PATTERN, renderGatewayEditor } from '../configuration/gatewayEditor.js';
import { renderBrowserEditor } from '../configuration/browserEditor.js';
import { renderGitEditor } from '../configuration/gitEditor.js';
import { renderProjectEditor } from '../configuration/projectEditor.js';
import { renderProjectReadinessPanel } from '../configuration/projectReadinessPanel.js';
import { renderProjectSelector } from '../configuration/projectSelector.js';
import { snapshot } from './projectProfileUiFixture.mjs';

test('PP-32: selector distinguishes active Project A from an unsaved Project B draft', () => {
  const state = snapshot('beta');
  state.dirty = true;
  const html = renderProjectSelector(state);
  assert.match(html, /ALPHA · g1 · ACTIVE/);
  assert.match(html, /UNSAVED/);
  assert.match(html, /id="cfgProjectSelector"/);
});

test('PP-32: Project ID is keyboard-editable only during creation preparation', () => {
  const state = snapshot();
  state.draftMode = 'prepare';
  state.draft = null;
  state.selectedRecord = null;
  state.newProjectInput = {
    templateProjectId: 'alpha', projectId: 'murugan', displayName: 'MURUGAN',
    targetRoot: 'F:/Murugan/Murugan', workspaceRoot: 'F:/CLU/workspace/murugan', shadowRoot: 'F:/CLU/shadow/murugan',
    browserProfileDirectory: '',
  };
  const preparation = renderProjectEditor(state);
  assert.match(preparation, /data-new-project-field="projectId"/);
  assert.doesNotMatch(preparation, /data-new-project-field="projectId"[^>]*readonly/);

  const durable = renderProjectEditor(snapshot());
  assert.match(durable, /data-profile-path="projectId"[^>]*readonly/);
  assert.match(durable, /data-profile-path="targetRootIdentity"[^>]*readonly/);
});

test('PP-33: additional authority order is deterministic and preserves disabled state', () => {
  const docs = canonicalAdditionalDocuments([
    { bindingId: 'zeta', order: 999, enabled: false },
    { bindingId: 'alpha', order: 3, enabled: true },
  ]);
  assert.deepEqual(docs.map((item) => [item.bindingId, item.order, item.enabled]), [
    ['zeta', 100, false],
    ['alpha', 101, true],
  ]);
});

test('PP-33: authority drift and unresolved conflict render fail-closed evidence', () => {
  const state = snapshot();
  state.validation = {
    authority: { state: 'DRIFTED', issues: [{ bindingId: 'target-description' }] },
    authorityConflicts: { state: 'CONFLICT', unresolved: [{ conflictId: 'C-1', description: 'Visual fidelity conflict' }], staleResolutions: [] },
  };
  state.draft.authority.additionalDocuments = [{
    bindingId: 'security-rules', kind: 'additional', path: 'security-rules.md',
    canonicalPath: 'F:/Targets/Alpha/security-rules.md', sha256: '5'.repeat(64), role: 'security',
    enabled: false, order: 100, validationState: 'VALID', lastValidated: '2026-08-15T00:00:00.000Z',
  }];
  state.draft.authority.additionalDocuments = [{
    bindingId: 'security-rules', kind: 'additional', path: 'security-rules.md',
    canonicalPath: `${state.draft.targetRoot}/security-rules.md`, sha256: '5'.repeat(64),
    role: 'security', enabled: false, order: 100, validationState: 'VALID',
    lastValidated: '2026-08-15T00:00:00.000Z',
  }];
  const html = renderAuthorityEditor(state);
  assert.match(html, /DRIFTED/);
  assert.match(html, /AUTHORITY CONFLICT — FAIL CLOSED/);
  assert.match(html, /Visual fidelity conflict/);
  assert.match(html, /data-additional-enabled-index/);
});

test('PP-34: NO_REMOTE_YET is presented as a legitimate local posture', () => {
  const state = snapshot();
  state.connectionChecks.git = { state: 'READY_LOCAL_ONLY', code: 'NO_REMOTE_YET', detail: 'Local operations ready; publication unavailable.' };
  const html = renderGitEditor(state);
  assert.match(html, /READY_LOCAL_ONLY/);
  assert.match(html, /NO_REMOTE_YET/);
  assert.doesNotMatch(html, /START CLU-E[^<]*synchron/i);
});

test('PP-34: browser ambiguity and wrong origin remain explicit refusal states', () => {
  const ambiguous = snapshot();
  ambiguous.connectionChecks.browser = { state: 'TARGET_AMBIGUOUS', code: 'TARGET_AMBIGUOUS', detail: 'Two eligible pages.' };
  assert.match(renderBrowserEditor(ambiguous), /TARGET_AMBIGUOUS/);

  const forbidden = snapshot();
  forbidden.connectionChecks.browser = { state: 'ORIGIN_FORBIDDEN', code: 'ORIGIN_FORBIDDEN', detail: 'The target origin is outside the profile allow-list.' };
  assert.match(renderBrowserEditor(forbidden), /ORIGIN_FORBIDDEN/);
});

test('PP-34: GPT editor accepts references, rejects raw keys, and never renders a secret fixture', () => {
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test('env:OPENAI_API_KEY'), true);
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test('credential-store:OpenAI/Primary'), true);
  assert.equal(CREDENTIAL_REFERENCE_PATTERN.test('sk-live-1234567890'), false);
  const state = snapshot();
  state.draft.integrations.gpt.credential.value = 'env:OPENAI_API_KEY';
  const html = renderGatewayEditor(state);
  assert.match(html, /env:OPENAI_API_KEY/);
  assert.doesNotMatch(html, /sk-live/);
  assert.match(html, /Fallback Policy/);
  assert.match(html, /FORBID/);
});

test('PP-34: operation-specific readiness keeps local proof ready while publication is unavailable', () => {
  const state = snapshot();
  state.validation = { state: 'VALID', authority: { state: 'CURRENT' }, authorityConflicts: { state: 'CLEAR' }, benchmarkRuntime: { state: 'VALID' } };
  state.readiness = {
    level: 'READY_LOCAL_ONLY', readyForLocalWork: true, readyForRequestedOperations: true,
    authorityState: 'CURRENT', authorityConflictState: 'CLEAR', benchmarkRuntimeState: 'VALID', blockers: [],
    capabilities: {
      recognition: { state: 'READY', required: true, ready: true, code: 'READY', detail: 'Project recognition ready.' },
      proof: { state: 'READY', required: true, ready: true, code: 'READY', detail: 'Local proof ready.' },
      gitPublication: { state: 'NO_REMOTE_YET', required: false, ready: false, code: 'NO_REMOTE_YET', detail: 'Publication not configured.' },
    },
  };
  const html = renderProjectReadinessPanel(state);
  assert.match(html, /READY_LOCAL_ONLY/);
  assert.match(html, /NO_REMOTE_YET/);
  assert.match(html, /NOT REQUIRED FOR THIS OPERATION/);
  assert.doesNotMatch(html, /class="cfg-blockers"/);
});
