/**
 * Project Profiles Configuration control plane.
 *
 * Browser state is a draft/interaction aid only. Every canonical path, hash, uniqueness check,
 * durable generation, readiness verdict and activation receipt comes from the backend API.
 */

import { createConfigurationState, recordMatchesActive } from './configurationState.js';
import { renderProjectSelector, renderStartupBinding } from './projectSelector.js';
import {
  normalizeProjectIdDraft,
  projectDraftProblems,
  renderProjectEditor,
} from './projectEditor.js';
import {
  canonicalAdditionalDocuments,
  nextAdditionalOrder,
  renderAuthorityEditor,
} from './authorityEditor.js';
import { renderRecognitionEditor } from './recognitionEditor.js';
import { canTestConsole, renderHostEditor } from './hostEditor.js';
import { renderGitEditor } from './gitEditor.js';
import { canTestChrome, renderBrowserEditor } from './browserEditor.js';
import { availableGatewayModels, CREDENTIAL_REFERENCE_PATTERN, renderGatewayEditor } from './gatewayEditor.js';
import { renderBenchmarkRuntimeEditor } from './benchmarkRuntimeEditor.js';
import { renderProjectReadinessPanel } from './projectReadinessPanel.js';
import {
  cloneValue,
  escapeHtml,
  integer,
  lines,
  nullableText,
  readPath,
  unwrapApiData,
  writePath,
} from './viewPrimitives.js';

export { escapeHtml };

const CAPABILITY_SECTIONS = Object.freeze({
  git: 'git', ai: 'gpt-gateway', chrome: 'browser', console: 'powershell-host',
});

export function focusCapabilitySection(root, capability, result) {
  if (!Object.hasOwn(CAPABILITY_SECTIONS, capability)) return false;
  const section = root.querySelector(`[data-section="${CAPABILITY_SECTIONS[capability]}"]`);
  if (!section) return false;
  const commandBar = root.querySelector('.cfg-command-bar');
  section.style.scrollMarginTop = `${Math.ceil(commandBar?.getBoundingClientRect().height ?? 0) + 12}px`;
  if (typeof result?.summary === 'string' && result.summary) {
    let detail = section.querySelector('[data-ribbon-check]');
    if (!detail) {
      detail = section.ownerDocument.createElement('p');
      detail.className = 'cfg-connection-detail';
      detail.setAttribute('data-ribbon-check', '');
      detail.setAttribute('role', 'status');
      section.querySelector('header')?.after(detail);
    }
    detail.textContent = result.summary;
  }
  section.tabIndex = -1;
  section.focus({ preventScroll: true });
  section.scrollIntoView({ block: 'start', inline: 'nearest' });
  return true;
}

const NULLABLE_PATHS = new Set([
  'displayName',
  'recognition.buildConfig',
  'benchmarkRuntime.command',
  'benchmarkRuntime.scenario',
  'benchmarkRuntime.targetUrl',
  'benchmarkRuntime.browserProfile',
  'integrations.git.remote',
  'integrations.git.provider',
  'integrations.git.protectedLandingPolicy',
  'integrations.git.currentBasePin',
  'integrations.chrome.targetUrl',
  'integrations.gpt.modelId',
]);

const INTEGER_PATHS = new Set([
  'benchmarkRuntime.warmupRuns',
  'benchmarkRuntime.repetitions',
  'benchmarkRuntime.timeoutSeconds',
  'integrations.chrome.remoteDebuggingPort',
]);

function bodyObject(value) {
  const body = unwrapApiData(value);
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function safeError(result, fallback = 'OPERATION_FAILED') {
  return {
    code: String(result?.serverCode ?? result?.error?.code ?? result?.refused ?? fallback).toUpperCase().replaceAll('-', '_'),
    message: String(result?.error?.details?.message ?? result?.serverDetails?.summary ?? result?.reason ?? 'The governed backend operation failed.'),
  };
}

function normalizeBindingId(value, fallback = 'governed-document') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.md$/u, '')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const candidate = normalized || fallback;
  return /^[a-z0-9]/u.test(candidate) ? candidate.slice(0, 128) : `doc-${candidate}`.slice(0, 128);
}

function basenameWithoutMd(path) {
  const parts = String(path ?? '').replaceAll('\\', '/').split('/');
  return (parts.at(-1) ?? 'governed-document').replace(/\.md$/iu, '');
}

function exactDeletePhrase(record) {
  return `DELETE PROFILE ${record.profile.projectId} ${record.generation} ${record.projectProfileHash.slice(0, 12)}`;
}

function valueFromControl(control, path) {
  const kind = control.dataset.valueKind;
  if (kind === 'boolean') return Boolean(control.checked);
  if (kind === 'lines') return lines(control.value);
  if (kind === 'integer' || INTEGER_PATHS.has(path)) return integer(control.value, 0);
  if (kind === 'nullable' || NULLABLE_PATHS.has(path)) return nullableText(control.value);
  return control.value;
}

function renderMetricCatalogue(catalogue) {
  const current = catalogue.activeSource || 'canonical';
  const list = Array.isArray(catalogue.entries) ? catalogue.entries : null;
  const defaultOption = `<option value="canonical"${current === 'canonical' ? ' selected' : ''}>Default Metric Catalogue</option>`;
  const options = defaultOption + (list === null
    ? '<option value="" disabled>SERVER LIST UNAVAILABLE</option>'
    : list.length === 0
      ? '<option value="">NO SERVER CATALOGUES</option>'
      : `<option value=""${current === 'canonical' ? '' : ' selected'}>— SERVER CATALOGUE —</option>${list.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.catalogueId || entry.id)} (${entry.metricCount ?? '?'})</option>`).join('')}`);
  return `<section class="cfg-card cfg-metric-card" data-section="metric-catalogue">
    <header class="cfg-card-head"><div><span class="cfg-kicker">METRIC CATALOGUE</span><h3>Global measurement authority</h3></div><span class="cfg-badge is-good">UNCHANGED</span></header>
    <p class="cfg-card-copy">The Metric Catalogue remains installation-global. Project Authority does not duplicate or override it.</p>
    <div class="cfg-catalogue-controls"><span class="cfg-hash">ACTIVE · ${escapeHtml(current)}</span><select id="cfgCatalogueSelector">${options}</select><button type="button" data-cfg-action="local-catalogue">LOCAL .JSON…</button></div>
  </section>`;
}

function renderNotice(snapshot) {
  if (!snapshot.notice) return '';
  const tone = ['good', 'bad', 'local'].includes(snapshot.notice.tone) ? snapshot.notice.tone : 'neutral';
  return `<div class="cfg-notice is-${tone}" role="status">${escapeHtml(snapshot.notice.message)}</div>`;
}

function renderShell(snapshot, catalogue) {
  const phase = String(snapshot.phase ?? 'idle').replaceAll('-', ' ').toUpperCase();
  return `<div class="cfg-shell" data-phase="${escapeHtml(snapshot.phase)}" aria-busy="${!['idle', 'ready'].includes(snapshot.phase)}">
    <header class="cfg-shell-head"><div><span class="cfg-kicker">CONFIGURATION</span><h2>PROJECT PROFILE CONTROL PLANE</h2><p>One selected profile defines one complete target operating context. Drafts are local; the backend owns all authority and persistence.</p></div><div class="cfg-shell-status"><span class="cfg-badge is-neutral">REGISTRY g${snapshot.registryGeneration ?? '—'}</span><span class="cfg-badge is-local">${escapeHtml(phase)}</span></div></header>
    ${renderProjectSelector(snapshot)}
    ${renderStartupBinding(snapshot)}
    ${renderNotice(snapshot)}
    <div class="cfg-layout">
      <div class="cfg-column">
        ${renderProjectEditor(snapshot)}
        ${renderAuthorityEditor(snapshot)}
        ${renderRecognitionEditor(snapshot)}
        ${renderBenchmarkRuntimeEditor(snapshot)}
      </div>
      <div class="cfg-column">
        ${renderProjectReadinessPanel(snapshot)}
        ${renderHostEditor(snapshot)}
        ${renderGitEditor(snapshot)}
        ${renderBrowserEditor(snapshot)}
        ${renderGatewayEditor(snapshot)}
        ${renderMetricCatalogue(catalogue)}
      </div>
    </div>
  </div>`;
}

/**
 * Mounts the complete Configuration surface.
 *
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {{invoke: Function}} options.actionClient
 * @param {(url:string, init?:object)=>Promise<unknown>} [options.fetchJson]
 * @param {(message:string, initial?:string)=>string|null} [options.promptText]
 * @param {(message:string)=>boolean} [options.confirmAction]
 * @param {(record:object, validation:object)=>boolean|void} [options.onActivationPending]
 * @param {()=>void} [options.onActivationCancelled]
 * @param {(detail:object)=>void} [options.onActiveProjectChanged]
 */
export function mountConfigurationPanel(options) {
  const root = options.root;
  const actionClient = options.actionClient;
  const state = createConfigurationState();
  const fetchJson = options.fetchJson ?? (async () => { throw new Error('fetchJson unavailable'); });
  const promptText = options.promptText ?? ((message, initial = '') => window.prompt(message, initial));
  const confirmAction = options.confirmAction ?? ((message) => window.confirm(message));
  const catalogue = { activeSource: globalThis.window?.__clueMetricsMeta?.source ?? 'canonical', entries: null };
  const legacyConnections = { ai: null, git: null, busy: null };
  let readinessReceipts = {};
  let destroyed = false;

  function render(snapshot = state.snapshot()) {
    catalogue.activeSource = globalThis.window?.__clueMetricsMeta?.source ?? 'canonical';
    if (destroyed) return;
    root.innerHTML = renderShell({ ...snapshot, legacyConnections, readinessReceipts }, catalogue);
  }

  const unsubscribe = state.subscribe(render);
  render();

  async function invoke(name, input, token, apply) {
    const result = await actionClient.invoke(name, input);
    if (!result.ok) {
      const error = safeError(result);
      state.applyFailure(token, error.code, error.message);
      return null;
    }
    return apply(result.result);
  }

  function confirmDiscard(snapshot, actionLabel) {
    if (!snapshot.dirty) return true;
    return confirmAction(`Discard the unsaved Project Profile draft and ${actionLabel}?`);
  }

  async function readProject(projectId) {
    if (!projectId) return null;
    const token = state.beginProjectRead(projectId);
    return invoke('readProject', { params: { projectId } }, token, (value) => state.applyProjectRead(token, value));
  }

  async function loadProjects({ readSelected = true } = {}) {
    const token = state.begin('loading-projects');
    const result = await actionClient.invoke('listProjects');
    if (!result.ok) {
      const error = safeError(result, 'PROJECT_LIST_FAILED');
      state.applyFailure(token, error.code, error.message);
      return null;
    }
    const selected = state.applyListing(result.result);
    if (readSelected && selected) return readProject(selected);
    return selected;
  }

  async function loadLegacyConfiguration() {
    const result = await actionClient.invoke('readConfig');
    if (!result.ok) return;
    state.setLegacyConfiguration(result.result);
    if (result.result?.legacyConnectionControls === true) {
      const key = await actionClient.invoke('readLegacyOpenAiKey');
      if (key.ok) legacyConnections.ai = key.result;
      render();
    }
  }

  async function loadReadinessReceipts() {
    const result = await actionClient.invoke('readReadinessReceipts');
    if (result.ok) {
      readinessReceipts = bodyObject(result.result).receipts ?? {};
      render();
    }
  }

  async function configureLegacyConnection(kind, action) {
    if (state.snapshot().legacyConfiguration?.legacyConnectionControls !== true || legacyConnections.busy) return;
    legacyConnections.busy = kind;
    render();
    try {
      const result = await actionClient.invoke(action);
      legacyConnections[kind] = result.ok ? result.result : { state: 'failed', detail: safeError(result).message };
    } finally {
      legacyConnections.busy = null;
      render();
    }
  }

  async function loadCatalogues() {
    try {
      const value = await fetchJson('/api/catalogues', { cache: 'no-store' });
      catalogue.entries = Array.isArray(value?.catalogues) ? value.catalogues : [];
    } catch {
      catalogue.entries = null;
    }
    render();
  }

  async function load() {
    await Promise.allSettled([loadLegacyConfiguration(), loadReadinessReceipts(), loadCatalogues()]);
    return loadProjects();
  }

  function updateResolution(path, raw) {
    const snapshot = state.snapshot();
    const current = snapshot.draft?.benchmarkRuntime?.resolution ?? { width: null, height: null };
    const key = path.endsWith('.width') ? 'width' : 'height';
    const next = { ...current, [key]: raw === '' ? null : integer(raw, 0) };
    state.updateDraft(
      'benchmarkRuntime.resolution',
      next.width === null && next.height === null ? null : next,
    );
  }

  function updateProfileControl(control, notify = true) {
    const path = control.dataset.profilePath;
    if (!path) return;
    if (path === 'integrations.gpt.modelId') {
      const snapshot = state.snapshot();
      // A select can fire input and change. Apply it once and only when the chosen ID
      // came from the model list for this saved profile and credential.
      if (!notify || control.value === snapshot.draft?.integrations?.gpt?.modelId) return;
      if (!snapshot.pending && availableGatewayModels(snapshot).includes(control.value)) state.updateDraft(path, control.value);
      else render(snapshot);
      return;
    }
    if (path === 'benchmarkRuntime.resolution.width' || path === 'benchmarkRuntime.resolution.height') {
      if (notify) updateResolution(path, control.value);
      return;
    }
    state.updateDraft(path, valueFromControl(control, path), { notify });
  }

  function updateNewControl(control, notify = true) {
    const field = control.dataset.newProjectField;
    if (!field) return;
    const value = field === 'projectId' ? normalizeProjectIdDraft(control.value) : control.value;
    state.updateNewProjectInput(field, value, { notify });
  }

  root.addEventListener('input', (event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) return;
    // Credential bytes are never copied into browser state. The field is accepted only on a
    // completed change after it has passed the same reference-only grammar as the backend schema.
    if (control.dataset.profilePath && control.dataset.profilePath !== 'integrations.gpt.credential.value') {
      updateProfileControl(control, false);
    }
    if (control.dataset.newProjectField) updateNewControl(control, false);
  });

  root.addEventListener('change', (event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) return;
    if (control.dataset.profilePath === 'integrations.gpt.credential.value') {
      const reference = String(control.value ?? '').trim();
      if (!CREDENTIAL_REFERENCE_PATTERN.test(reference)) {
        state.setNotice('bad', 'CREDENTIAL_REFERENCE_INVALID: only env:VARIABLE_NAME or credential-store:ID is accepted; raw bytes were discarded.');
        render();
        return;
      }
      control.value = reference;
    }
    if (control.dataset.profilePath) updateProfileControl(control, true);
    if (control.dataset.newProjectField) updateNewControl(control, true);

    if (control.id === 'cfgProjectSelector') {
      const snapshot = state.snapshot();
      const projectId = control.value;
      if (!projectId) return;
      if (!confirmDiscard(snapshot, `select ${projectId}`)) { render(snapshot); return; }
      void readProject(projectId);
    }
    if (control.id === 'cfgReadinessOperation') state.setReadinessOperation(control.value);
    if (control.id === 'cfgGitHubRepository') {
      const branch = root.querySelector('#cfgGitHubBranch');
      if (branch) branch.value = control.selectedOptions[0]?.dataset.defaultBranch ?? '';
    }
    if (control.dataset.additionalRoleIndex) {
      const index = Number(control.dataset.additionalRoleIndex);
      const profile = cloneValue(state.snapshot().draft);
      if (profile?.authority?.additionalDocuments?.[index]) {
        profile.authority.additionalDocuments[index].role = control.value;
        state.replaceDraft(profile);
      }
    }
    if (control.dataset.additionalEnabledIndex) {
      const index = Number(control.dataset.additionalEnabledIndex);
      const profile = cloneValue(state.snapshot().draft);
      if (profile?.authority?.additionalDocuments?.[index]) {
        profile.authority.additionalDocuments[index].enabled = Boolean(control.checked);
        state.replaceDraft(profile);
      }
    }
    if (control.id === 'cfgCatalogueSelector' && control.value) {
      if (control.value === 'canonical') {
        globalThis.window?.__clueImport?.restoreCanonical?.();
        render();
        return;
      }
      void fetchJson(`/api/catalogues/${encodeURIComponent(control.value)}`)
        .then((document_) => globalThis.window?.__clueImport?.openWithCatalogue?.(document_, control.value))
        .catch(() => globalThis.window?.__clueImport?.open?.());
    }
  });

  async function prepareDocument(spec) {
    const snapshot = state.snapshot();
    if (!snapshot.draft) return;
    const token = state.begin('preparing-document');
    const result = await actionClient.invoke('prepareGovernedDocument', {
      targetRoot: snapshot.draft.targetRoot,
      path: spec.path,
      bindingId: spec.bindingId,
      kind: spec.kind,
      role: spec.role,
      enabled: spec.enabled,
      order: spec.order,
      ...(spec.kind === 'master-benchmark' ? { benchmarkId: null, benchmarkVersion: null } : {}),
    });
    if (!result.ok) {
      const error = safeError(result, 'GOVERNED_DOCUMENT_PREPARATION_FAILED');
      state.applyFailure(token, error.code, error.message);
      return;
    }
    const binding = bodyObject(result.result).binding;
    if (!binding) {
      state.applyFailure(token, 'GOVERNED_DOCUMENT_RESPONSE_INVALID', 'The backend returned no governed-document binding.');
      return;
    }
    const latest = state.snapshot();
    if (latest.pending?.sequence !== token.sequence || latest.draft?.projectId !== snapshot.draft.projectId) return;
    const profile = cloneValue(latest.draft);
    if (spec.kind === 'additional') {
      profile.authority.additionalDocuments = canonicalAdditionalDocuments([
        ...(profile.authority.additionalDocuments ?? []),
        binding,
      ]);
    } else {
      profile.authority[spec.field] = binding;
    }
    state.replaceDraft(profile, { notify: false });
    state.complete(token, 'good', `Bound ${binding.bindingId} at ${binding.sha256.slice(0, 12)}…`);
  }

  async function validateSelected() {
    const snapshot = state.snapshot();
    const record = snapshot.selectedRecord;
    if (!record || snapshot.dirty) return;
    const token = state.begin('validating-project');
    return invoke('validateProject', { params: { projectId: record.profile.projectId } }, token, (value) => state.applyValidation(token, value));
  }

  async function readinessSelected() {
    const snapshot = state.snapshot();
    const record = snapshot.selectedRecord;
    if (!record || snapshot.dirty) return;
    const token = state.begin('reading-readiness');
    return invoke('readProjectReadiness', { params: { projectId: record.profile.projectId }, query: { operation: snapshot.readinessOperation } }, token, (value) => state.applyReadiness(token, value));
  }

  function savedConnectionRecord() {
    const snapshot = state.snapshot();
    return snapshot.pending || snapshot.dirty ? null : snapshot.selectedRecord;
  }

  async function testConnection(kind, action, phase = `testing-${kind}`) {
    const record = savedConnectionRecord();
    if (!record) return;
    const token = state.begin(phase);
    return invoke(action, { params: { projectId: record.profile.projectId } }, token, (value) => state.applyConnectionCheck(token, kind, value));
  }

  async function testSessionCapability({ capability, label, canTest, action, kind }) {
    const snapshot = state.snapshot();
    if (!canTest(snapshot)) return;
    const record = snapshot.selectedRecord;
    const token = state.begin(`testing-${capability}`);
    return invoke(action, {
      projectId: record.profile.projectId,
      expectedGeneration: record.generation,
      expectedProfileHash: record.projectProfileHash,
    }, token, (value) => {
      const receipt = bodyObject(value);
      if (!['pending', 'ready', 'failed'].includes(receipt.state) ||
          !recordMatchesActive(record, { ...receipt.projectIdentity, profileGeneration: receipt.profileGeneration })) {
        return state.applyFailure(token, `${capability.toUpperCase()}_TEST_IDENTITY_MISMATCH`, `The ${label} test result did not match this saved Project Profile generation.`);
      }
      const result = state.applyConnectionCheck(token, kind, receipt);
      const document = root.ownerDocument;
      if (result.applied && document?.defaultView) {
        document.dispatchEvent(new document.defaultView.CustomEvent(`clue:${capability}-readiness`, { detail: { record, receipt } }));
      }
      return result;
    });
  }

  async function loadGatewayModels() {
    const record = savedConnectionRecord();
    if (!record) return;
    const token = state.beginGatewayModels();
    const result = await actionClient.invoke('listProjectGptModels', {
      params: { projectId: record.profile.projectId },
      query: { expectedGeneration: record.generation, expectedProfileHash: record.projectProfileHash },
    });
    if (!result.ok) {
      return state.applyFailure(token, 'MODEL_LIST_REQUEST_FAILED', 'Reload the saved profile and try loading its models again.');
    }
    return state.applyGatewayModels(token, result.result);
  }

  async function saveProfileConnection(kind, action, phase, record, fields = {}) {
    const token = state.begin(phase);
    return invoke(action, {
      params: { projectId: record.profile.projectId },
      payload: { ...fields, expectedGeneration: record.generation },
    }, token, async (value) => {
      const { record: updated, ...check } = bodyObject(value);
      if (!updated) return state.applyConnectionCheck(token, kind, check);
      const result = state.applySaved(token, { record: updated }, { kind, value: check });
      if (result?.applied) await loadProjects({ readSelected: false });
      return result;
    });
  }

  async function connectGitHub() {
    const record = savedConnectionRecord();
    if (!record) return;
    const repository = root.querySelector('#cfgGitHubRepository')?.value;
    const branch = root.querySelector('#cfgGitHubBranch')?.value.trim();
    const repositories = state.snapshot().connectionChecks.githubDirectory?.repositories;
    if (!branch || !Array.isArray(repositories) || !repositories.some((entry) => entry.nameWithOwner === repository)) {
      state.setNotice('bad', 'Select a listed GitHub repository and specify the branch checked out in this profile.');
      return;
    }
    return saveProfileConnection('githubConnection', 'connectProjectGitHub', 'connecting-github', record, { repository, branch });
  }

  async function setOpenAiKey() {
    const record = savedConnectionRecord();
    if (!record) return;
    return saveProfileConnection('openaiKey', 'setProjectOpenAiKey', 'waiting-for-windows-key-prompt', record);
  }

  async function saveProfile() {
    const snapshot = state.snapshot();
    const creating = snapshot.draftMode === 'create';
    if (!snapshot.draft || snapshot.pending || (!creating && !snapshot.dirty) || projectDraftProblems(snapshot.draft).length) return;
    const token = state.beginSave();
    const action = creating ? 'createProject' : 'updateProject';
    const input = creating
      ? { profile: snapshot.draft }
      : { params: { projectId: snapshot.selectedRecord.profile.projectId }, payload: { profile: snapshot.draft, expectedGeneration: snapshot.selectedRecord.generation } };
    return invoke(action, input, token, async (value) => {
      const applied = state.applySaved(token, value);
      if (applied?.applied) await loadProjects({ readSelected: false });
      return applied;
    });
  }

  async function deleteProfile() {
    const snapshot = state.snapshot();
    const record = snapshot.selectedRecord;
    if (!record || snapshot.active?.projectId === record.profile.projectId) return;
    const phrase = exactDeletePhrase(record);
    const typed = promptText(`Deleting a profile removes CLU-E-owned registration only. Type exactly:\n\n${phrase}`, '');
    if (typed !== phrase) {
      state.setNotice('bad', 'DELETE_CONFIRMATION_REQUIRED: exact state-bound phrase did not match.');
      return;
    }
    const token = state.begin('deleting-project');
    return invoke('deleteProject', { params: { projectId: record.profile.projectId }, payload: { expectedGeneration: record.generation, confirmation: phrase } }, token, async (value) => {
      state.applyDeleted(token, value);
      await loadProjects();
    });
  }

  async function activateProfile() {
    const snapshot = state.snapshot();
    const record = snapshot.selectedRecord;
    if (!record || snapshot.dirty) return;
    if (snapshot.validation?.valid !== true) {
      state.setNotice('bad', 'PROJECT_VALIDATION_REQUIRED: Validate the saved profile in the Project card before activation.');
      return;
    }
    const token = state.beginActivation();
    const allowed = options.onActivationPending?.(record, snapshot.validation);
    if (allowed === false) {
      state.applyFailure(token, 'Q1_GENERATION_GUARD_REFUSED', 'Q1 refused the successor Project Profile identity.');
      return;
    }
    const result = await actionClient.invoke('activateProject', {
      params: { projectId: record.profile.projectId },
      payload: { expectedGeneration: record.generation, expectedProfileHash: record.projectProfileHash },
    });
    if (!result.ok) {
      options.onActivationCancelled?.();
      const error = safeError(result, 'PROJECT_ACTIVATION_FAILED');
      state.applyFailure(token, error.code, error.message);
      return;
    }
    const applied = state.applyActivated(token, result.result);
    if (applied?.applied) {
      options.onActiveProjectChanged?.({ record, pointer: applied.pointer, validation: snapshot.validation });
      await loadProjects({ readSelected: false });
    } else {
      options.onActivationCancelled?.();
    }
  }

  function setInheritedPath(path, defaultKey, mode, promptLabel) {
    if (mode === 'global') {
      state.updateDraft(path, { source: 'global-default', defaultKey, value: null });
      return;
    }
    const current = readPath(state.snapshot().draft, path);
    const value = promptText(promptLabel, current?.source === 'project-override' ? current.value : '');
    if (value === null || value.trim() === '') return;
    state.updateDraft(path, { source: 'project-override', defaultKey, value: value.trim() });
  }

  function setCredential(mode) {
    if (mode === 'global') {
      state.updateDraft('integrations.gpt.credential', { source: 'global-default', defaultKey: 'gateway.credential', value: null });
      return;
    }
    const current = state.snapshot().draft?.integrations?.gpt?.credential;
    const value = promptText('Credential reference only (env:NAME or credential-store:ID). Raw secret bytes are forbidden.', current?.source === 'project-override' ? current.value : 'env:OPENAI_API_KEY');
    if (value === null) return;
    const trimmed = value.trim();
    if (!CREDENTIAL_REFERENCE_PATTERN.test(trimmed)) {
      state.setNotice('bad', 'CREDENTIAL_REFERENCE_INVALID: raw keys and ungoverned values are refused before transport.');
      return;
    }
    state.updateDraft('integrations.gpt.credential', { source: 'project-override', defaultKey: 'gateway.credential', value: trimmed });
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-cfg-action], [data-config-action]');
    if (!button) return;
    const action = button.dataset.cfgAction ?? button.dataset.configAction;
    event.preventDefault();
    const snapshot = state.snapshot();

    switch (action) {
      case 'show-startup-binding': {
        const binding = root.querySelector('#cfgStartupBinding');
        const instructions = binding?.querySelector('details');
        if (instructions) instructions.open = true;
        binding?.focus({ preventScroll: true });
        binding?.scrollIntoView({ block: 'center' });
        break;
      }
      case 'reload-projects':
        if (confirmDiscard(snapshot, 'reload authoritative state')) void loadProjects();
        break;
      case 'new-project':
        if (confirmDiscard(snapshot, 'create a new project')) state.beginNewPreparation();
        break;
      case 'cancel-new-project': {
        const selected = snapshot.active?.projectId ?? snapshot.projects[0]?.projectId ?? null;
        state.selectProject(selected);
        if (selected) void readProject(selected);
        break;
      }
      case 'pick-new-path': {
        const field = button.dataset.newPathField;
        const current = snapshot.newProjectInput?.[field] ?? '';
        const value = promptText(`Enter ${field} path. The backend will canonicalize and validate it.`, current);
        if (value !== null) state.updateNewProjectInput(field, value.trim());
        break;
      }
      case 'prepare-new-project': {
        const input = snapshot.newProjectInput;
        if (!input) break;
        const token = state.beginDraftPreparation();
        void invoke('prepareProjectDraft', {
          ...input,
          projectId: normalizeProjectIdDraft(input.projectId),
          displayName: nullableText(input.displayName),
          browserProfileDirectory: nullableText(input.browserProfileDirectory),
        }, token, (value) => state.applyPreparedDraft(token, value));
        break;
      }
      case 'reset-profile': state.resetDraft(); break;
      case 'save-profile': void saveProfile(); break;
      case 'delete-profile': void deleteProfile(); break;
      case 'validate-profile': void validateSelected(); break;
      case 'read-readiness': void readinessSelected(); break;
      case 'activate-project': void activateProfile(); break;
      case 'test-console': void testSessionCapability({ capability: 'console', label: 'Console', canTest: canTestConsole, action: 'runConsoleTest', kind: 'host' }); break;
      case 'test-git': void testConnection('git', 'testProjectGit'); break;
      case 'sign-in-github': void testConnection('githubDirectory', 'signInProjectGitHub', 'opening-github-sign-in'); break;
      case 'sign-in-legacy-github': void configureLegacyConnection('git', 'signInLegacyGitHub'); break;
      case 'list-github-repositories': void testConnection('githubDirectory', 'listProjectGitHubRepositories', 'listing-github-repositories'); break;
      case 'connect-github': void connectGitHub(); break;
      case 'test-chrome': void testSessionCapability({ capability: 'chrome', label: 'Chrome', canTest: canTestChrome, action: 'runChromeTest', kind: 'browser' }); break;
      case 'test-gateway': void testConnection('gateway', 'testProjectGpt'); break;
      case 'load-gateway-models': void loadGatewayModels(); break;
      case 'check-openai-key': void testConnection('openaiKey', 'readProjectOpenAiKey', 'checking-windows-key'); break;
      case 'set-openai-key': void setOpenAiKey(); break;
      case 'set-legacy-openai-key': void configureLegacyConnection('ai', 'setLegacyOpenAiKey'); break;
      case 'use-host-global': setInheritedPath('integrations.powershell.executable', 'powershell.executable', 'global', ''); break;
      case 'use-host-override': setInheritedPath('integrations.powershell.executable', 'powershell.executable', 'override', 'Absolute PowerShell executable path'); break;
      case 'use-browser-global': setInheritedPath('integrations.chrome.executable', 'browser.executable', 'global', ''); break;
      case 'use-browser-override': setInheritedPath('integrations.chrome.executable', 'browser.executable', 'override', 'Absolute Chrome executable path'); break;
      case 'use-gateway-global': setCredential('global'); break;
      case 'use-gateway-override': setCredential('override'); break;
      case 'prepare-distinguished-document': {
        const path = promptText(`Select ${button.dataset.authorityKind} Markdown path. Relative paths resolve against Target Root.`, '');
        if (!path) break;
        void prepareDocument({
          field: button.dataset.authorityField,
          kind: button.dataset.authorityKind,
          bindingId: button.dataset.bindingId,
          role: button.dataset.bindingRole,
          order: Number(button.dataset.bindingOrder),
          enabled: true,
          path,
        });
        break;
      }
      case 'remove-distinguished-document': {
        const profile = cloneValue(snapshot.draft);
        profile.authority[button.dataset.authorityField] = null;
        state.replaceDraft(profile);
        break;
      }
      case 'add-additional-document': {
        const path = root.querySelector('#cfgAdditionalDocumentPath')?.value?.trim();
        if (!path) { state.setNotice('bad', 'GOVERNED_DOCUMENT_PATH_REQUIRED'); break; }
        const requestedId = root.querySelector('#cfgAdditionalBindingId')?.value;
        const existing = new Set((snapshot.draft?.authority?.additionalDocuments ?? []).map((item) => item.bindingId));
        let bindingId = normalizeBindingId(requestedId, basenameWithoutMd(path));
        let suffix = 2;
        while (existing.has(bindingId)) bindingId = `${normalizeBindingId(requestedId, basenameWithoutMd(path))}-${suffix++}`.slice(0, 128);
        void prepareDocument({
          field: null,
          kind: 'additional',
          bindingId,
          role: root.querySelector('#cfgAdditionalRole')?.value ?? 'other',
          enabled: Boolean(root.querySelector('#cfgAdditionalEnabled')?.checked),
          order: nextAdditionalOrder(snapshot.draft?.authority?.additionalDocuments),
          path,
        });
        break;
      }
      case 'remove-additional-document':
      case 'move-additional-up':
      case 'move-additional-down': {
        const index = Number(button.dataset.additionalIndex);
        const profile = cloneValue(snapshot.draft);
        const documents = [...(profile.authority.additionalDocuments ?? [])];
        if (action === 'remove-additional-document') documents.splice(index, 1);
        else {
          const target = action === 'move-additional-up' ? index - 1 : index + 1;
          if (target >= 0 && target < documents.length) [documents[index], documents[target]] = [documents[target], documents[index]];
        }
        profile.authority.additionalDocuments = canonicalAdditionalDocuments(documents);
        state.replaceDraft(profile);
        break;
      }
      case 'local-catalogue':
        globalThis.window?.__clueImport?.pickFile?.() ?? globalThis.window?.__clueImport?.open?.();
        break;
      default:
        state.setNotice('bad', `UNDECLARED_CONFIGURATION_ACTION: ${action}`);
    }
  });

  const beforeUnload = (event) => {
    if (!state.snapshot().dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };
  globalThis.window?.addEventListener?.('beforeunload', beforeUnload);

  return Object.freeze({
    load,
    focusCapability: (capability, result) => focusCapabilitySection(root, capability, result),
    reload: loadProjects,
    snapshot: state.snapshot,
    state,
    destroy() {
      destroyed = true;
      unsubscribe();
      globalThis.window?.removeEventListener?.('beforeunload', beforeUnload);
      root.innerHTML = '';
    },
  });
}

/* ------------------------------------------------------------------------- */
/* Legacy installation-readiness rows retained as a stable compatibility API. */
/* ------------------------------------------------------------------------- */

function value(label, text) { return { kind: 'value', label, text: String(text) }; }
function absent(label, reason) { return { kind: 'absent', label, reason }; }
function check(label, ok, note) { return { kind: 'check', label, ok: Boolean(ok), ...(note === undefined ? {} : { note }) }; }
function readString(source, key) { const raw = source?.[key]; return typeof raw === 'string' && raw.length > 0 ? raw : null; }

export function configurationRows(config) {
  if (config === null || config === undefined || typeof config !== 'object') {
    return Object.freeze([absent('configuration', 'the daemon returned no configuration body')]);
  }
  const body = config;
  const project = body.project ?? {};
  const rows = [];
  const id = readString(project, 'id');
  rows.push(id === null ? absent('project id', 'the configuration declares no project id') : value('project id', id));
  const root = readString(project, 'root');
  rows.push(root === null ? absent('project root', 'the configuration declares no project root') : check('project root', project.rootPresent, root));
  rows.push(check('tsconfig.json', body.tsconfigPresent));
  rows.push(check('workspace initialised', body.workspaceInitialised));
  const documents = body.trackedDocuments;
  if (!Array.isArray(documents)) rows.push(absent('tracked documents', 'the configuration lists no tracked documents'));
  else for (const document of documents) {
    const path = readString(document, 'path');
    rows.push(path === null ? absent('tracked document', 'a tracked document has no path') : check(path, document?.present));
  }
  const graph = body.committedGraphPointer;
  if (graph === null || graph === undefined || typeof graph !== 'object') rows.push(absent('committed graph', 'no graph has been committed yet'));
  else {
    const hash = readString(graph, 'resultHash');
    const run = readString(graph, 'runId');
    rows.push(hash === null ? absent('committed graph', 'the pointer carries no result hash') : value('committed graph', `${hash.slice(0, 12)} · run ${run === null ? 'unknown' : run.slice(0, 8)}`));
  }
  rows.push(check('startable', body.startable));
  return Object.freeze(rows);
}

export function renderConfigurationRows(rows) {
  return rows.map((row) => {
    const label = escapeHtml(row.label);
    if (row.kind === 'value') return `<div class="row"><span>${label}</span><span class="mono">${escapeHtml(row.text)}</span></div>`;
    if (row.kind === 'check') return `<div class="row"><span>${label}</span><span>${row.note === undefined ? '' : `<span class="mono">${escapeHtml(row.note)}</span> `}${row.ok ? '<span class="ok">OK</span>' : '<span class="fail">FAIL</span>'}</span></div>`;
    if (row.kind === 'absent') return `<div class="row"><span>${label}</span><span class="mono" title="${escapeHtml(row.reason)}">UNKNOWN — ${escapeHtml(row.reason)}</span></div>`;
    return `<div class="row"><span>${label}</span><span class="fail">MALFORMED ROW</span></div>`;
  }).join('');
}
