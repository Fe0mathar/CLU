/**
 * Project Profiles Configuration control plane.
 *
 * Browser state is a draft/interaction aid only. Every canonical path, hash, uniqueness check,
 * durable generation, readiness verdict and activation receipt comes from the backend API.
 *
 * This module is composition and request routing. It owns one piece of state the backend never
 * sees — `ui`: which section is on screen, the search text, the open dialog — and nothing else.
 * The profile draft and every stale-response guard remain in configurationState.js, unchanged.
 *
 * The markup itself is shellView.js: a profile context bar, a section sidebar, one section at a
 * time in the main pane, and a save bar that is always on screen. Rendering is one HTML string per
 * state change; uiContinuity.js carries focus, scroll, open disclosures and half-typed inputs
 * across the replacement.
 */

import { createConfigurationState, recordMatchesActive } from './configurationState.js';
import { findCredentialLeak } from './actionContracts.js';
import { renderSelectionBadges } from './projectSelector.js';
import {
  newProjectSuggestions,
  normalizeProjectIdDraft,
  projectDraftProblems,
  renderPreparationFooter,
} from './projectEditor.js';
import { canonicalAdditionalDocuments, distinguishedPathInputId, nextAdditionalOrder } from './authorityEditor.js';
import { canTestConsole } from './hostEditor.js';
import { canTestChrome } from './browserEditor.js';
import { availableGatewayModels, CREDENTIAL_REFERENCE_PATTERN } from './gatewayEditor.js';
import { renderNavigationList, resolveSection, sectionAvailable } from './navigation.js';
import { CAPABILITY_SECTIONS, DEFAULT_SECTION } from './sectionRegistry.js';
import { exactDeletePhrase } from './configurationDialogs.js';
import { changedSections, draftChanges } from './draftChanges.js';
import { draftIssues } from './draftIssues.js';
import { HOSTED_LAYOUT_CONTROL_ID, renderSaveBar, renderShell } from './shellView.js';
import { captureContinuity, describeActiveFocus, restoreContinuity } from './uiContinuity.js';
import {
  cloneValue,
  escapeHtml,
  integer,
  isBusy,
  lines,
  nullableText,
  readPath,
  unwrapApiData,
} from './viewPrimitives.js';

export { escapeHtml };
export { configurationRows, renderConfigurationRows } from './installationRows.js';

export function focusCapabilitySection(root, capability, result) {
  if (!Object.hasOwn(CAPABILITY_SECTIONS, capability)) return false;
  const section = root.querySelector(`[data-section="${CAPABILITY_SECTIONS[capability]}"]`);
  if (!section) return false;
  section.style.scrollMarginTop = '12px';
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

/** A form control, recognised by shape so the handlers also work outside a browser. */
function isFormControl(target) {
  return Boolean(target) && typeof target === 'object' && target.dataset !== undefined && 'value' in target;
}

function valueFromControl(control, path) {
  const kind = control.dataset.valueKind;
  if (kind === 'boolean') return Boolean(control.checked);
  if (kind === 'lines') return lines(control.value);
  if (kind === 'integer' || INTEGER_PATHS.has(path)) return integer(control.value, 0);
  if (kind === 'nullable' || NULLABLE_PATHS.has(path)) return nullableText(control.value);
  return control.value;
}

/**
 * Mounts the complete Configuration surface.
 *
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {{invoke: Function}} options.actionClient
 * @param {(url:string, init?:object)=>Promise<unknown>} [options.fetchJson]
 * @param {(message:string, initial?:string)=>string|null} [options.promptText] when supplied, text is
 *   asked through it instead of the built-in dialogs and inline inputs (a host or test seam)
 * @param {(message:string)=>boolean} [options.confirmAction] when supplied, discarding a draft is
 *   confirmed through it instead of the built-in dialog
 * @param {(record:object, validation:object)=>boolean|void} [options.onActivationPending]
 * @param {()=>void} [options.onActivationCancelled]
 * @param {(detail:object)=>void} [options.onActiveProjectChanged]
 * @param {(host:HTMLElement)=>{destroy?:Function}|void} [options.mountAgents]
 */
export function mountConfigurationPanel(options) {
  const root = options.root;
  const actionClient = options.actionClient;
  const state = createConfigurationState();
  const fetchJson = options.fetchJson ?? (async () => { throw new Error('fetchJson unavailable'); });
  const promptText = typeof options.promptText === 'function' ? options.promptText : null;
  const confirmAction = typeof options.confirmAction === 'function' ? options.confirmAction : null;
  const catalogue = { activeSource: globalThis.window?.__clueMetricsMeta?.source ?? 'canonical', entries: null };
  const legacyConnections = { ai: null, git: null, busy: null };
  let readinessReceipts = {};
  let destroyed = false;

  /** Presentation-only state. Nothing here is persisted or sent to the backend. */
  const ui = {
    section: DEFAULT_SECTION,
    search: '',
    dialog: null,
    ribbonChecks: {},
    templateRoots: null,
    returnFocus: null,
    pendingFocus: null,
    pendingReveal: null,
    dropTransient: new Set(),
  };
  let renderedSection = null;

  const query = (selector) => {
    try {
      return typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
    } catch {
      return null;
    }
  };

  /** The snapshot the renderers see: backend-derived state plus the facts computed from it. */
  function view(snapshot = state.snapshot()) {
    const issues = snapshot.draft ? draftIssues(snapshot.draft) : [];
    const changes = snapshot.draftMode === 'update' && snapshot.selectedRecord
      ? draftChanges(snapshot.selectedRecord.profile, snapshot.draft)
      : [];
    ui.section = resolveSection(ui.section, snapshot);
    return {
      ...snapshot,
      legacyConnections,
      readinessReceipts,
      issues,
      changes,
      changedPaths: changes.map((change) => change.path),
      changedSections: changedSections(changes),
      ui: {
        section: ui.section,
        search: ui.search,
        dialog: ui.dialog,
        ribbonChecks: ui.ribbonChecks,
        templateRoots: ui.templateRoots,
      },
    };
  }

  /** Opens the disclosure that hides a field, then focuses the field. DOM only. */
  function revealField(path) {
    const escaped = String(path).replace(/"/gu, '\\"');
    const target = query(`[data-profile-path="${escaped}"]`)
      ?? query(`[data-cfg-override="${escaped}"]`)
      ?? query(`[data-field-path="${escaped}"] input, [data-field-path="${escaped}"] select, [data-field-path="${escaped}"] textarea`)
      ?? query(`[data-pane="${ui.section}"] [data-section]`);
    if (!target) return;
    let parent = typeof target.closest === 'function' ? target.closest('details') : null;
    while (parent) {
      parent.open = true;
      parent = parent.parentElement && typeof parent.parentElement.closest === 'function' ? parent.parentElement.closest('details') : null;
    }
    try {
      if (target.tabIndex < 0 && !('value' in target)) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch { /* focus is a convenience */ }
  }

  /** An open dialog always holds keyboard focus, so Escape and Tab keep working. DOM only. */
  function keepFocusInDialog() {
    if (ui.dialog === null) return;
    const dialog = query('.cfg-dialog');
    const active = root.ownerDocument?.activeElement ?? null;
    if (!dialog || typeof dialog.contains !== 'function' || dialog.contains(active)) return;
    try { dialog.focus({ preventScroll: true }); } catch { /* focus is a convenience */ }
  }

  /** Keeps controls that depend on what is typed in a dialog in step with it. DOM only. */
  function syncDialogControls() {
    if (ui.dialog?.kind !== 'delete') return;
    const input = query('#cfgDialogConfirmInput');
    const confirm = query('[data-cfg-action="confirm-delete-profile"]');
    if (input && confirm && !isBusy(state.snapshot())) confirm.disabled = input.value !== input.getAttribute('data-confirm-phrase');
  }

  /**
   * Hosts the dashboard shell's window-composition control in the Dashboard layout section.
   *
   * The shell (app.js) creates that control, owns its state and handles its clicks, and puts it at
   * the top of the Configuration panel. This moves the same element — listeners and all — into the
   * section's slot after every paint, so replacing the markup never destroys it. If the element is
   * not there, the section says so and nothing else changes. DOM only.
   */
  let hostedLayoutControl = null;
  let hostedAgentsPanel = null;
  let agentsController = null;
  let hostedAgentsBinding = null;

  function focusInsideHostedControl() {
    const active = root.ownerDocument?.activeElement ?? null;
    return active && [hostedLayoutControl, hostedAgentsPanel].some((host) => host?.contains?.(active)) ? active : null;
  }

  function adoptLayoutControl() {
    const document_ = root.ownerDocument;
    if (typeof document_?.getElementById !== 'function') return;
    const slot = query('[data-cfg-slot="layout-switch"]');
    if (!slot || typeof slot.appendChild !== 'function') return;
    // Connected: the shell's element, wherever it currently sits. Otherwise the one this paint
    // has just detached by replacing the markup around it.
    const control = document_.getElementById(HOSTED_LAYOUT_CONTROL_ID) ?? hostedLayoutControl;
    if (!control) return;
    hostedLayoutControl = control;
    if (control.parentElement !== slot) slot.appendChild(control);
    const fallback = typeof slot.querySelector === 'function' ? slot.querySelector('[data-cfg-slot-fallback]') : null;
    if (fallback) fallback.hidden = true;
  }

  function disposeAgentsPanel() {
    agentsController?.destroy?.();
    agentsController = null;
    hostedAgentsPanel = null;
    hostedAgentsBinding = null;
  }

  function adoptAgentsPanel(snapshot) {
    const slot = query('[data-cfg-slot="agents"]');
    if (typeof slot?.appendChild !== 'function' || typeof options.mountAgents !== 'function') return;
    const active = snapshot.active;
    const binding = JSON.stringify([active?.projectId, active?.profileGeneration, active?.projectProfileHash]);
    if (hostedAgentsPanel && hostedAgentsBinding !== binding) disposeAgentsPanel();
    if (!hostedAgentsPanel) {
      if (ui.section !== 'agents' || typeof root.ownerDocument?.createElement !== 'function') return;
      const host = root.ownerDocument.createElement('div');
      agentsController = options.mountAgents(host);
      hostedAgentsPanel = host;
      hostedAgentsBinding = binding;
    }
    if (hostedAgentsPanel.parentElement !== slot) slot.appendChild(hostedAgentsPanel);
    const fallback = slot.querySelector?.('[data-cfg-slot-fallback]');
    if (fallback) fallback.hidden = true;
  }

  /**
   * When the markup may be replaced.
   *
   * The surface renders by replacing one HTML string, which replaces every control. Doing that at
   * the wrong moment breaks the interaction in progress, so three moments are excluded:
   *
   *   1. While a replacement is already running. Removing the focused control makes a browser fire
   *      its pending `change` event during the removal; the handler asks for another render.
   *   2. While a `change` handler runs. `change` fires in the middle of a focus move (Tab, or a
   *      click on another control). Replacing the markup there destroys the control focus was
   *      moving to: Tab lands on nothing, and a click on SAVE never becomes a click.
   *   3. While a pointer button is down. A click is a press and a release on the same element; a
   *      replacement between the two means no click is ever delivered.
   *
   * A render asked for in one of those moments is recorded and performed as soon as it is safe,
   * from the then-current state. Outside a browser none of them occurs and rendering is immediate.
   */
  const liveDom = typeof root.contains === 'function' && typeof root.querySelectorAll === 'function'
    && typeof globalThis.setTimeout === 'function';
  let rendering = false;
  let renderRequested = false;
  let changeDepth = 0;
  let pointerHeld = false;
  let pointerTimer = null;

  function render(snapshot = state.snapshot()) {
    if (destroyed) return;
    if (rendering || (liveDom && (changeDepth > 0 || pointerHeld))) {
      renderRequested = true;
      return;
    }
    rendering = true;
    try {
      paint(snapshot);
    } finally {
      rendering = false;
    }
    if (renderRequested) {
      renderRequested = false;
      render();
    }
  }

  function flushRender() {
    if (!renderRequested || destroyed) return;
    renderRequested = false;
    render();
  }

  function releasePointer() {
    if (pointerTimer !== null) globalThis.clearTimeout(pointerTimer);
    pointerTimer = null;
    if (!pointerHeld) return;
    pointerHeld = false;
    // The click that follows a release is delivered in the same task; render after it.
    globalThis.setTimeout(flushRender, 0);
  }

  function paint(snapshot) {
    catalogue.activeSource = globalThis.window?.__clueMetricsMeta?.source ?? 'canonical';
    try {
      const model = view(snapshot);
      const memo = captureContinuity(root);
      const hostedFocus = focusInsideHostedControl();
      root.innerHTML = renderShell(model, catalogue);
      adoptLayoutControl();
      adoptAgentsPanel(snapshot);
      if (hostedFocus && ui.pendingFocus === null && root.contains?.(hostedFocus)) {
        try { hostedFocus.focus({ preventScroll: true }); } catch { /* focus is a convenience */ }
      }
      restoreContinuity(root, memo, {
        resetScroll: renderedSection !== null && renderedSection !== ui.section ? ['main'] : [],
        dropTransient: ui.dropTransient,
        focus: ui.pendingFocus,
      });
      renderedSection = ui.section;
      ui.pendingFocus = null;
      ui.dropTransient = new Set();
      if (ui.pendingReveal !== null) {
        const path = ui.pendingReveal;
        ui.pendingReveal = null;
        revealField(path);
      }
      syncDialogControls();
      keepFocusInDialog();
    } catch (error) {
      // A renderer that throws must not leave a silently stale page: say so, where it can be seen.
      globalThis.console?.error?.('[Configuration] render failed', error);
      root.innerHTML = `<div class="cfg-shell"><div class="cfg-notice is-bad" role="alert"><span>CONFIGURATION_RENDER_FAILED: ${escapeHtml(error instanceof Error ? error.message : String(error))}. Reload the dashboard; no profile data was changed.</span></div></div>`;
    }
  }

  /** Refreshes only the parts that reflect the draft, so the control being typed in is untouched. */
  function patchDraftRegions() {
    if (destroyed || typeof root.querySelector !== 'function') return;
    const model = view();
    const regions = [
      ['savebar', () => renderSaveBar(model)],
      ['navlist', () => renderNavigationList(model)],
      ['selection-badges', () => renderSelectionBadges(model)],
      ['prepare-footer', () => renderPreparationFooter(model)],
    ];
    for (const [name, html] of regions) {
      const element = query(`[data-cfg-region="${name}"]`);
      if (element) element.innerHTML = html();
    }
  }

  const unsubscribe = state.subscribe(render);
  render();

  /* ----------------------------- dialogs ------------------------------ */

  function openDialog(dialog) {
    ui.returnFocus = describeActiveFocus(root);
    ui.dialog = dialog;
    ui.pendingFocus = [
      '.cfg-dialog input:not([readonly])',
      '.cfg-dialog select',
      '.cfg-dialog [data-cfg-dialog-primary]:not([disabled])',
      '.cfg-dialog .cfg-dialog-actions button:not([disabled])',
      '.cfg-dialog',
    ];
    render();
  }

  function closeDialog({ rerender = true } = {}) {
    if (ui.dialog === null) return;
    ui.dialog = null;
    if (ui.returnFocus) ui.pendingFocus = [ui.returnFocus];
    ui.returnFocus = null;
    if (rerender) render();
  }

  function goSection(id, { focusPane = false } = {}) {
    const snapshot = state.snapshot();
    const target = resolveSection(id, snapshot);
    if (!sectionAvailable(target, snapshot)) return;
    ui.section = target;
    if (focusPane) ui.pendingFocus = [`[data-pane="${target}"] [data-section]`];
    render();
  }

  /* ------------------------- backend operations ------------------------ */

  async function invoke(name, input, token, apply) {
    const result = await actionClient.invoke(name, input);
    if (!result.ok) {
      const error = safeError(result);
      state.applyFailure(token, error.code, error.message);
      return null;
    }
    return apply(result.result);
  }

  /** Runs `proceed` now, or after the operator agrees to lose the unsaved draft. */
  function guardUnsaved(consequence, proceed, { allowSave = true } = {}) {
    const snapshot = state.snapshot();
    if (!snapshot.dirty) {
      proceed();
      return;
    }
    if (confirmAction) {
      if (confirmAction(`Discard the unsaved Project Profile draft? ${consequence}`)) proceed();
      else render();
      return;
    }
    openDialog({ kind: 'discard', label: consequence, proceed, allowSave });
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

  /* ----------------------------- draft edits --------------------------- */

  /** A draft edited back to the saved values is not a draft: clear the flag that blocks tests. */
  function settleDraft() {
    const snapshot = state.snapshot();
    if (snapshot.draftMode !== 'update' || !snapshot.dirty || !snapshot.selectedRecord) return false;
    if (draftChanges(snapshot.selectedRecord.profile, snapshot.draft).length > 0) return false;
    state.resetDraft();
    return true;
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

  function updateOverrideControl(control, notify = true) {
    const path = control.dataset.cfgOverride;
    if (!path || state.snapshot().draft === null) return;
    state.updateDraft(path, {
      source: 'project-override',
      defaultKey: control.dataset.defaultKey ?? readPath(state.snapshot().draft, path)?.defaultKey ?? path,
      value: String(control.value ?? '').trim(),
    }, { notify });
  }

  function updateNewControl(control, notify = true) {
    const field = control.dataset.newProjectField;
    if (!field) return;
    const value = field === 'projectId' ? normalizeProjectIdDraft(control.value) : control.value;
    state.updateNewProjectInput(field, value, { notify });
  }

  /** Marks the field being typed in as changed without re-rendering it. DOM only. */
  function markFieldModified(control) {
    const shell = typeof control.closest === 'function' ? control.closest('.cfg-field') : null;
    if (!shell?.classList) return;
    const path = control.dataset.profilePath ?? control.dataset.cfgOverride;
    const snapshot = state.snapshot();
    if (snapshot.draftMode !== 'update' || !snapshot.selectedRecord) return;
    const changed = draftChanges(snapshot.selectedRecord.profile, snapshot.draft)
      .some((change) => change.path === path || path.startsWith(`${change.path}.`) || change.path.startsWith(`${path}.`));
    shell.classList.toggle('is-modified', changed);
  }

  root.addEventListener('input', (event) => {
    const control = event.target;
    if (!isFormControl(control)) return;
    if (control.id === 'cfgNavSearch') {
      ui.search = String(control.value ?? '');
      const list = query('[data-cfg-region="navlist"]');
      if (list) list.innerHTML = renderNavigationList(view());
      return;
    }
    if (control.id === 'cfgDialogConfirmInput') {
      syncDialogControls();
      return;
    }
    if (control.id === 'cfgDialogCredentialName') {
      // Credential bytes never reach browser state: a key-shaped value is removed from the
      // field the moment it appears, before anything reads it.
      if (findCredentialLeak(String(control.value ?? '')) !== null) {
        control.value = '';
        const message = query('#cfgDialogError');
        if (message) {
          message.hidden = false;
          message.textContent = 'That looked like an API key and was cleared. Enter the name of the reference, not the key.';
        }
      }
      return;
    }
    // Credential bytes are never copied into browser state. The field is accepted only on a
    // completed change after it has passed the same reference-only grammar as the backend schema.
    if (control.dataset.profilePath && control.dataset.profilePath !== 'integrations.gpt.credential.value') {
      updateProfileControl(control, false);
      markFieldModified(control);
      patchDraftRegions();
    }
    if (control.dataset.cfgOverride) {
      updateOverrideControl(control, false);
      markFieldModified(control);
      patchDraftRegions();
    }
    if (control.dataset.newProjectField) {
      updateNewControl(control, false);
      patchDraftRegions();
    }
  });

  root.addEventListener('change', (event) => {
    const control = event.target;
    if (!isFormControl(control)) return;
    changeDepth += 1;
    try {
      handleChange(control);
    } finally {
      changeDepth -= 1;
      // After the focus move that caused this event has completed.
      if (liveDom) globalThis.setTimeout(flushRender, 0);
    }
  });

  function handleChange(control) {
    if (control.dataset.profilePath === 'integrations.gpt.credential.value') {
      const reference = String(control.value ?? '').trim();
      if (!CREDENTIAL_REFERENCE_PATTERN.test(reference)) {
        state.setNotice('bad', 'CREDENTIAL_REFERENCE_INVALID: only env:VARIABLE_NAME or credential-store:ID is accepted; raw bytes were discarded.');
        render();
        return;
      }
      control.value = reference;
    }
    if (control.dataset.profilePath) {
      updateProfileControl(control, true);
      settleDraft();
    }
    if (control.dataset.cfgOverride) {
      updateOverrideControl(control, true);
      settleDraft();
    }
    if (control.dataset.newProjectField) updateNewControl(control, true);

    if (control.id === 'cfgProjectSelector') {
      const projectId = control.value;
      if (!projectId) return;
      guardUnsaved(`Opening ${projectId} discards them.`, () => { void readProject(projectId); });
    }
    if (control.id === 'cfgReadinessOperation') state.setReadinessOperation(control.value);
    if (control.id === 'cfgGitHubRepository') {
      const branch = query('#cfgGitHubBranch');
      if (branch) branch.value = control.selectedOptions?.[0]?.dataset.defaultBranch ?? '';
    }
    if (control.dataset.additionalRoleIndex) {
      const index = Number(control.dataset.additionalRoleIndex);
      const profile = cloneValue(state.snapshot().draft);
      if (profile?.authority?.additionalDocuments?.[index]) {
        profile.authority.additionalDocuments[index].role = control.value;
        state.replaceDraft(profile);
        settleDraft();
      }
    }
    if (control.dataset.additionalEnabledIndex) {
      const index = Number(control.dataset.additionalEnabledIndex);
      const profile = cloneValue(state.snapshot().draft);
      if (profile?.authority?.additionalDocuments?.[index]) {
        profile.authority.additionalDocuments[index].enabled = Boolean(control.checked);
        state.replaceDraft(profile);
        settleDraft();
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
  }

  if (liveDom) {
    root.addEventListener('pointerdown', (event) => {
      // A native <select> list swallows the release, so a press on one is not tracked.
      if (String(event.target?.tagName ?? '').toLowerCase() === 'select') return;
      pointerHeld = true;
      if (pointerTimer !== null) globalThis.clearTimeout(pointerTimer);
      pointerTimer = globalThis.setTimeout(releasePointer, 1500);
    });
    root.ownerDocument?.addEventListener?.('pointerup', releasePointer, true);
    root.ownerDocument?.addEventListener?.('pointercancel', releasePointer, true);
  }

  async function prepareDocument(spec, clearInputs = []) {
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
    for (const id of clearInputs) ui.dropTransient.add(id);
    state.replaceDraft(profile, { notify: false });
    state.complete(token, 'good', `Bound ${binding.bindingId} at ${binding.sha256.slice(0, 12)}… Save to keep it.`);
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
    const repository = query('#cfgGitHubRepository')?.value;
    const branch = query('#cfgGitHubBranch')?.value.trim();
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
    if (!snapshot.draft || snapshot.pending || (!creating && !snapshot.dirty) || projectDraftProblems(snapshot.draft).length) return null;
    const token = state.beginSave();
    const action = creating ? 'createProject' : 'updateProject';
    const input = creating
      ? { profile: snapshot.draft }
      : { params: { projectId: snapshot.selectedRecord.profile.projectId }, payload: { profile: snapshot.draft, expectedGeneration: snapshot.selectedRecord.generation } };
    return invoke(action, input, token, async (value) => {
      const applied = state.applySaved(token, value);
      if (applied?.applied) {
        ui.templateRoots = null;
        if (ui.dialog?.kind === 'changes') closeDialog({ rerender: false });
        await loadProjects({ readSelected: false });
      }
      return applied;
    });
  }

  async function deleteProfile(typed) {
    const snapshot = state.snapshot();
    const record = snapshot.selectedRecord;
    if (!record || snapshot.active?.projectId === record.profile.projectId) return;
    const phrase = exactDeletePhrase(record);
    if (typed !== phrase) {
      if (ui.dialog?.kind === 'delete') {
        ui.dialog = { ...ui.dialog, error: 'The phrase does not match. Enter it exactly, including capitals and spaces.' };
        render();
      } else {
        state.setNotice('bad', 'DELETE_CONFIRMATION_REQUIRED: exact state-bound phrase did not match.');
      }
      return;
    }
    closeDialog({ rerender: false });
    const token = state.begin('deleting-project');
    return invoke('deleteProject', { params: { projectId: record.profile.projectId }, payload: { expectedGeneration: record.generation, confirmation: phrase } }, token, async (value) => {
      state.applyDeleted(token, value);
      ui.section = 'profiles';
      await loadProjects();
      // Opening the remaining profile clears notices; the deletion receipt must outlive that.
      state.setNotice('good', `Deleted CLU-E profile ${record.profile.projectId}; target and workspace data were not deleted.`);
    });
  }

  /** Opens the guided activation dialog. Activation itself happens only on its confirm button. */
  function requestActivation() {
    const snapshot = state.snapshot();
    if (!snapshot.selectedRecord || snapshot.dirty) return;
    openDialog({ kind: 'activate' });
  }

  async function activateProfile() {
    const snapshot = state.snapshot();
    const record = snapshot.selectedRecord;
    if (!record || snapshot.dirty) return;
    if (snapshot.validation?.valid !== true) {
      state.setNotice('bad', 'PROJECT_VALIDATION_REQUIRED: Validate the saved profile before activation.');
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
      closeDialog({ rerender: false });
      options.onActiveProjectChanged?.({ record, pointer: applied.pointer, validation: snapshot.validation });
      await loadProjects({ readSelected: false });
    } else {
      options.onActivationCancelled?.();
    }
  }

  function setInheritedPath(path, defaultKey, mode, promptLabel) {
    if (mode === 'global') {
      state.updateDraft(path, { source: 'global-default', defaultKey, value: null });
      settleDraft();
      return;
    }
    const current = readPath(state.snapshot().draft, path);
    if (promptText) {
      const value = promptText(promptLabel, current?.source === 'project-override' ? current.value : '');
      if (value === null || value.trim() === '') return;
      state.updateDraft(path, { source: 'project-override', defaultKey, value: value.trim() });
      return;
    }
    // Switch to a custom value and hand the operator the field to type it in.
    ui.pendingFocus = [`[data-cfg-override="${path}"]`];
    if (current?.source === 'project-override') render();
    else state.updateDraft(path, { source: 'project-override', defaultKey, value: '' });
  }

  function applyCredentialReference(reference) {
    const trimmed = String(reference ?? '').trim();
    if (!CREDENTIAL_REFERENCE_PATTERN.test(trimmed)) return false;
    state.updateDraft('integrations.gpt.credential', { source: 'project-override', defaultKey: 'gateway.credential', value: trimmed });
    return true;
  }

  function setCredential(mode) {
    if (mode === 'global') {
      state.updateDraft('integrations.gpt.credential', { source: 'global-default', defaultKey: 'gateway.credential', value: null });
      settleDraft();
      return;
    }
    if (!promptText) {
      openDialog({ kind: 'credential', error: null });
      return;
    }
    const current = state.snapshot().draft?.integrations?.gpt?.credential;
    const value = promptText('Credential reference only (env:NAME or credential-store:ID). Raw secret bytes are forbidden.', current?.source === 'project-override' ? current.value : 'env:OPENAI_API_KEY');
    if (value === null) return;
    if (!applyCredentialReference(value)) {
      state.setNotice('bad', 'CREDENTIAL_REFERENCE_INVALID: raw keys and ungoverned values are refused before transport.');
    }
  }

  function confirmCredentialReference() {
    const kind = query('#cfgDialogCredentialKind')?.value === 'credential-store' ? 'credential-store' : 'env';
    const input = query('#cfgDialogCredentialName');
    const typed = String(input?.value ?? '').trim();
    // Accept a complete reference pasted into the name field as well as a bare name.
    const reference = CREDENTIAL_REFERENCE_PATTERN.test(typed) ? typed : `${kind}:${typed}`;
    if (!applyCredentialReference(reference)) {
      if (input) input.value = '';
      ui.dialog = {
        kind: 'credential',
        error: 'CREDENTIAL_REFERENCE_INVALID: an environment variable is capitals, digits and underscore (OPENAI_API_KEY); a credential-store ID starts with a letter or digit. The field was cleared.',
      };
      ui.pendingFocus = ['#cfgDialogCredentialName'];
      render();
      return;
    }
    closeDialog();
  }

  function revertChange(path) {
    const snapshot = state.snapshot();
    if (!path || !snapshot.selectedRecord || snapshot.draftMode !== 'update') return;
    const saved = readPath(snapshot.selectedRecord.profile, path);
    if (saved === undefined) return;
    state.updateDraft(path, cloneValue(saved));
    settleDraft();
  }

  function beginNewProfile() {
    const profile = state.snapshot().selectedRecord?.profile ?? null;
    ui.templateRoots = profile ? {
      projectId: profile.projectId,
      workspaceRoot: profile.workspaceRoot,
      shadowRoot: profile.shadowRoot,
      browserProfileDirectory: profile.integrations?.chrome?.dedicatedProfileDirectory ?? '',
    } : null;
    ui.section = 'project';
    ui.pendingFocus = ['[data-new-project-field="projectId"]'];
    state.beginNewPreparation();
  }

  function cancelNewProfile() {
    const snapshot = state.snapshot();
    const selected = snapshot.active?.projectId ?? snapshot.projects[0]?.projectId ?? null;
    ui.templateRoots = null;
    state.selectProject(selected);
    if (selected) void readProject(selected);
    else render();
  }

  function discardDraft() {
    const snapshot = state.snapshot();
    if (snapshot.draftMode === 'prepare' || snapshot.draftMode === 'create') {
      guardUnsaved('Discarding the new profile cannot be undone.', cancelNewProfile, { allowSave: false });
      return;
    }
    if (!snapshot.dirty) return;
    guardUnsaved('Discarding cannot be undone.', () => state.resetDraft(), { allowSave: false });
  }

  /* -------------------------------- clicks ----------------------------- */

  root.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-cfg-action], [data-config-action]');
    if (!button) return;
    const action = button.dataset.cfgAction ?? button.dataset.configAction;
    event.preventDefault?.();
    const snapshot = state.snapshot();

    switch (action) {
      /* ---- navigation and presentation ---- */
      case 'go-section':
        goSection(button.dataset.sectionTarget);
        break;
      case 'go-issue': {
        if (ui.dialog !== null) closeDialog({ rerender: false });
        ui.section = resolveSection(button.dataset.sectionTarget, snapshot);
        ui.pendingFocus = null;
        ui.pendingReveal = button.dataset.issuePath ?? '';
        render();
        break;
      }
      case 'clear-search':
        ui.search = '';
        ui.pendingFocus = ['#cfgNavSearch'];
        render();
        break;
      case 'dismiss-notice':
        state.setNotice('neutral', '');
        break;
      case 'show-startup-binding': {
        ui.section = resolveSection('startup', snapshot);
        ui.pendingFocus = ['#cfgStartupBinding'];
        render();
        const instructions = query('#cfgStartupBinding details');
        if (instructions) instructions.open = true;
        break;
      }
      case 'reload-installation':
        void loadLegacyConfiguration();
        break;

      /* ---- dialogs ---- */
      case 'dialog-cancel':
        closeDialog();
        break;
      case 'dialog-discard': {
        const proceed = ui.dialog?.proceed;
        closeDialog({ rerender: false });
        if (typeof proceed === 'function') proceed();
        render();
        break;
      }
      case 'dialog-save-continue': {
        const proceed = ui.dialog?.proceed;
        closeDialog({ rerender: false });
        void saveProfile().then(() => {
          if (state.snapshot().dirty === false && typeof proceed === 'function') proceed();
        });
        break;
      }
      case 'open-changes':
        openDialog({ kind: 'changes' });
        break;
      case 'revert-change':
        revertChange(button.dataset.changePath);
        break;
      case 'discard-draft':
        discardDraft();
        break;
      case 'confirm-delete-profile':
        void deleteProfile(String(query('#cfgDialogConfirmInput')?.value ?? ''));
        break;
      case 'confirm-activate-project':
        void activateProfile();
        break;
      case 'confirm-credential-reference':
        confirmCredentialReference();
        break;

      /* ---- profiles ---- */
      case 'reload-projects':
        guardUnsaved('Reloading the profiles discards them.', () => { void loadProjects(); });
        break;
      case 'new-project':
        guardUnsaved('Starting a new profile discards them.', beginNewProfile);
        break;
      case 'edit-profile': {
        const projectId = button.dataset.projectId;
        if (!projectId) break;
        guardUnsaved(`Opening ${projectId} discards them.`, () => {
          ui.section = 'overview';
          void readProject(projectId);
        });
        break;
      }
      case 'cancel-new-project':
        guardUnsaved('Discarding the new profile cannot be undone.', cancelNewProfile, { allowSave: false });
        break;
      case 'fill-new-suggestions': {
        const suggestions = newProjectSuggestions(snapshot.newProjectInput, ui.templateRoots);
        const fields = Object.entries(suggestions);
        fields.forEach(([field, value], index) => {
          state.updateNewProjectInput(field, value, { notify: index === fields.length - 1 });
        });
        break;
      }
      case 'pick-new-path': {
        const field = button.dataset.newPathField;
        if (promptText) {
          const value = promptText(`Enter ${field} path. The backend will canonicalize and validate it.`, snapshot.newProjectInput?.[field] ?? '');
          if (value !== null) state.updateNewProjectInput(field, value.trim());
        } else {
          query(`[data-new-project-field="${field}"]`)?.focus?.();
        }
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
        }, token, (value) => {
          const applied = state.applyPreparedDraft(token, value);
          if (applied?.applied) goSection('overview');
          return applied;
        });
        break;
      }
      case 'reset-profile':
        if (ui.dialog?.kind === 'changes') closeDialog({ rerender: false });
        state.resetDraft();
        break;
      case 'save-profile': void saveProfile(); break;
      case 'delete-profile': {
        const record = snapshot.selectedRecord;
        if (!record || snapshot.active?.projectId === record.profile.projectId) break;
        if (promptText) {
          void deleteProfile(promptText(`Deleting a profile removes CLU-E-owned registration only. Type exactly:\n\n${exactDeletePhrase(record)}`, ''));
        } else {
          openDialog({ kind: 'delete', error: null });
        }
        break;
      }
      case 'validate-profile': void validateSelected(); break;
      case 'read-readiness': void readinessSelected(); break;
      case 'activate-project': requestActivation(); break;

      /* ---- connections ---- */
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

      /* ---- governing documents ---- */
      case 'prepare-distinguished-document': {
        const field = button.dataset.authorityField;
        const inputId = distinguishedPathInputId(field);
        const path = promptText
          ? promptText(`Select ${button.dataset.authorityKind} Markdown path. Relative paths resolve against Target Root.`, '')
          : String(query(`#${inputId}`)?.value ?? '').trim();
        if (!path) {
          if (!promptText) {
            ui.pendingFocus = [`#${inputId}`];
            state.setNotice('bad', 'GOVERNED_DOCUMENT_PATH_REQUIRED: type the path of the Markdown file in the box next to the button, then press it again.');
          }
          break;
        }
        void prepareDocument({
          field,
          kind: button.dataset.authorityKind,
          bindingId: button.dataset.bindingId,
          role: button.dataset.bindingRole,
          order: Number(button.dataset.bindingOrder),
          enabled: true,
          path,
        }, [inputId]);
        break;
      }
      case 'remove-distinguished-document': {
        const profile = cloneValue(snapshot.draft);
        profile.authority[button.dataset.authorityField] = null;
        state.replaceDraft(profile);
        settleDraft();
        break;
      }
      case 'add-additional-document': {
        const path = query('#cfgAdditionalDocumentPath')?.value?.trim();
        if (!path) {
          ui.pendingFocus = ['#cfgAdditionalDocumentPath'];
          state.setNotice('bad', 'GOVERNED_DOCUMENT_PATH_REQUIRED: type the path of the Markdown file to add.');
          break;
        }
        const requestedId = query('#cfgAdditionalBindingId')?.value;
        const existing = new Set((snapshot.draft?.authority?.additionalDocuments ?? []).map((item) => item.bindingId));
        let bindingId = normalizeBindingId(requestedId, basenameWithoutMd(path));
        let suffix = 2;
        while (existing.has(bindingId)) bindingId = `${normalizeBindingId(requestedId, basenameWithoutMd(path))}-${suffix++}`.slice(0, 128);
        void prepareDocument({
          field: null,
          kind: 'additional',
          bindingId,
          role: query('#cfgAdditionalRole')?.value ?? 'other',
          enabled: Boolean(query('#cfgAdditionalEnabled')?.checked),
          order: nextAdditionalOrder(snapshot.draft?.authority?.additionalDocuments),
          path,
        }, ['cfgAdditionalDocumentPath', 'cfgAdditionalBindingId']);
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
        settleDraft();
        break;
      }
      case 'local-catalogue':
        globalThis.window?.__clueImport?.pickFile?.() ?? globalThis.window?.__clueImport?.open?.();
        break;
      default:
        state.setNotice('bad', `UNDECLARED_CONFIGURATION_ACTION: ${action}`);
    }
  });

  /* ------------------------------- keyboard ---------------------------- */

  function isTypingTarget(target) {
    const tag = String(target?.tagName ?? '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true;
  }

  root.addEventListener('keydown', (event) => {
    const key = event.key;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && String(key).toLowerCase() === 's') {
      event.preventDefault?.();
      if (hostedAgentsPanel?.contains?.(event.target)) return;
      // Commit the field being typed in first, exactly as leaving it would.
      const active = root.ownerDocument?.activeElement;
      if (isFormControl(active) && typeof active.blur === 'function' && typeof root.contains === 'function' && root.contains(active)) {
        active.blur();
        active.focus?.({ preventScroll: true });
      }
      void saveProfile();
      return;
    }
    if (ui.dialog !== null) {
      if (key === 'Escape') {
        event.preventDefault?.();
        if (state.snapshot().phase !== 'activating-project') closeDialog();
        return;
      }
      if (key === 'Enter' && String(event.target?.tagName ?? '').toLowerCase() === 'input') {
        event.preventDefault?.();
        const primary = query('.cfg-dialog [data-cfg-dialog-primary]');
        if (primary && !primary.disabled) primary.click?.();
        return;
      }
      if (key === 'Tab') {
        // Keep keyboard focus inside the dialog while it is open.
        const dialog = query('.cfg-dialog');
        const focusable = dialog && typeof dialog.querySelectorAll === 'function'
          ? Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'))
          : [];
        if (focusable.length === 0) return;
        const active = root.ownerDocument?.activeElement;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
          event.preventDefault?.();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault?.();
          first.focus();
        }
      }
      return;
    }
    if (key === '/' && !isTypingTarget(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const search = query('#cfgNavSearch');
      if (search) {
        event.preventDefault?.();
        search.focus();
        search.select?.();
      }
      return;
    }
    if (key === 'Escape' && event.target?.id === 'cfgNavSearch' && ui.search !== '') {
      event.preventDefault?.();
      ui.search = '';
      render();
      return;
    }
    if ((key === 'ArrowDown' || key === 'ArrowUp') && (event.target?.id === 'cfgNavSearch' || event.target?.classList?.contains?.('cfg-nav-item'))) {
      const items = typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll('.cfg-nav-item:not([disabled])')) : [];
      if (items.length === 0) return;
      event.preventDefault?.();
      const index = items.indexOf(event.target);
      const next = key === 'ArrowDown' ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
      items[next].focus();
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
    /**
     * Opens the section that configures one ribbon capability and focuses it. The ribbon's own
     * check summary is kept with the section until the panel is reloaded.
     */
    focusCapability(capability, result) {
      if (!Object.hasOwn(CAPABILITY_SECTIONS, capability)) return false;
      if (typeof result?.summary === 'string' && result.summary) ui.ribbonChecks = { ...ui.ribbonChecks, [capability]: result.summary };
      if (ui.dialog !== null) return false;
      ui.section = resolveSection(CAPABILITY_SECTIONS[capability], state.snapshot());
      ui.search = '';
      render();
      return typeof root.querySelector === 'function' ? focusCapabilitySection(root, capability) : false;
    },
    showSection: (id) => goSection(id, { focusPane: true }),
    reload: loadProjects,
    snapshot: state.snapshot,
    state,
    destroy() {
      destroyed = true;
      unsubscribe();
      globalThis.window?.removeEventListener?.('beforeunload', beforeUnload);
      if (liveDom) {
        root.ownerDocument?.removeEventListener?.('pointerup', releasePointer, true);
        root.ownerDocument?.removeEventListener?.('pointercancel', releasePointer, true);
        if (pointerTimer !== null) globalThis.clearTimeout(pointerTimer);
      }
      // Hand the shell's control back to where the shell put it.
      if (hostedLayoutControl && typeof root.parentElement?.prepend === 'function') root.parentElement.prepend(hostedLayoutControl);
      hostedLayoutControl = null;
      disposeAgentsPanel();
      root.innerHTML = '';
    },
  });
}
