/**
 * Browser-side draft state for Project Profile Configuration.
 *
 * This store is deliberately not authority. It remembers what the operator is editing and rejects
 * stale responses; the backend remains the only component allowed to persist, canonicalize,
 * validate or activate a Project Profile generation.
 */

import {
  cloneValue,
  operationIdentityOf,
  sameOperationIdentity,
  unwrapApiData,
  writePath,
} from './viewPrimitives.js';

function initialState() {
  return {
    phase: 'idle',
    registryGeneration: null,
    projects: [],
    active: null,
    selectedProjectId: null,
    selectedRecord: null,
    draft: null,
    draftMode: 'none',
    newProjectInput: null,
    dirty: false,
    legacyConfiguration: null,
    validation: null,
    readiness: null,
    readinessOperation: 'local-proof',
    connectionChecks: { host: null, git: null, browser: null, gateway: null },
    pending: null,
    notice: null,
    error: null,
    revision: 0,
  };
}

function freezeSnapshot(value) {
  const copy = cloneValue(value);
  return Object.freeze(copy);
}

function bodyObject(value) {
  const unwrapped = unwrapApiData(value);
  return unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped) ? unwrapped : {};
}

function recordFrom(value) {
  const body = bodyObject(value);
  const nested = bodyObject(body.data);
  const record = body.record ?? nested.record;
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
}

function pointerFrom(value) {
  const body = bodyObject(value);
  const nested = bodyObject(body.data);
  const pointer = body.pointer ?? body.active ?? nested.pointer ?? nested.active;
  return pointer && typeof pointer === 'object' && !Array.isArray(pointer) ? pointer : null;
}

function tokenMatchesSelection(token, state) {
  if (!token || token.selectionRevision !== state.selectionRevision) return false;
  if (!state.pending || state.pending.sequence !== token.sequence) return false;
  if (token.projectId === null) return state.selectedProjectId === null;
  return state.selectedProjectId === token.projectId;
}

export function activePointerIdentity(pointer) {
  if (!pointer || typeof pointer !== 'object') return null;
  if (
    typeof pointer.projectId !== 'string' ||
    typeof pointer.targetRootIdentity !== 'string' ||
    typeof pointer.projectProfileHash !== 'string' ||
    !Number.isSafeInteger(pointer.profileGeneration) ||
    pointer.profileGeneration < 1
  ) return null;
  return Object.freeze({
    projectId: pointer.projectId,
    targetRootIdentity: pointer.targetRootIdentity,
    projectProfileHash: pointer.projectProfileHash,
    profileGeneration: pointer.profileGeneration,
  });
}

export function recordMatchesActive(record, pointer) {
  return sameOperationIdentity(operationIdentityOf(record), activePointerIdentity(pointer));
}

export function createConfigurationState(options = {}) {
  let state = { ...initialState(), selectionRevision: 0 };
  let operationSequence = 0;
  const listeners = new Set();

  function emit() {
    state.revision += 1;
    const next = snapshot();
    for (const listener of [...listeners]) {
      try { listener(next); } catch { /* one renderer cannot corrupt the state machine */ }
    }
    return next;
  }

  function snapshot() {
    return freezeSnapshot(state);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function begin(kind, projectId = state.selectedProjectId) {
    const token = Object.freeze({
      kind,
      sequence: ++operationSequence,
      projectId,
      selectionRevision: state.selectionRevision,
      recordIdentity: operationIdentityOf(state.selectedRecord),
    });
    state.pending = token;
    state.phase = kind;
    state.error = null;
    emit();
    return token;
  }

  function applyListing(value) {
    const body = bodyObject(value);
    const projects = Array.isArray(body.projects) ? body.projects : [];
    const active = body.active && typeof body.active === 'object' ? body.active : null;
    const known = new Set(projects.map((project) => project?.projectId).filter((id) => typeof id === 'string'));
    let selected = state.selectedProjectId;
    if (selected !== null && !known.has(selected)) selected = null;
    const preserveNewDraft = state.draftMode === 'prepare' || state.draftMode === 'create';
    if (!preserveNewDraft && selected === null && typeof active?.projectId === 'string' && known.has(active.projectId)) selected = active.projectId;
    if (!preserveNewDraft && selected === null && projects.length > 0 && typeof projects[0]?.projectId === 'string') selected = projects[0].projectId;
    state.projects = cloneValue(projects);
    state.active = cloneValue(active);
    state.registryGeneration = Number.isSafeInteger(body.registryGeneration) ? body.registryGeneration : null;
    state.selectedProjectId = selected;
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    emit();
    return selected;
  }

  function setLegacyConfiguration(value) {
    state.legacyConfiguration = cloneValue(value);
    emit();
  }

  function selectProject(projectId) {
    const id = projectId === null ? null : String(projectId);
    if (id === state.selectedProjectId && state.draftMode !== 'create') return snapshot();
    state.selectionRevision += 1;
    state.selectedProjectId = id;
    state.selectedRecord = null;
    state.draft = null;
    state.draftMode = 'none';
    state.newProjectInput = null;
    state.dirty = false;
    state.validation = null;
    state.readiness = null;
    state.connectionChecks = { host: null, git: null, browser: null, gateway: null };
    state.pending = null;
    state.error = null;
    state.notice = null;
    emit();
    return snapshot();
  }

  function beginProjectRead(projectId) {
    selectProject(projectId);
    return begin('loading-project', projectId);
  }

  function applyProjectRead(token, value) {
    if (!tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_PROJECT_RESPONSE' };
    const record = recordFrom(value);
    if (record === null || record?.profile?.projectId !== token.projectId) {
      return applyFailure(token, 'PROJECT_RESPONSE_INVALID', 'The backend did not return the requested Project Profile record.');
    }
    state.selectedRecord = cloneValue(record);
    state.draft = cloneValue(record.profile);
    state.draftMode = 'update';
    state.dirty = false;
    state.validation = null;
    state.readiness = null;
    state.connectionChecks = { host: null, git: null, browser: null, gateway: null };
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    state.notice = null;
    emit();
    return { applied: true, record: cloneValue(record) };
  }

  function beginNewPreparation(templateProjectId = null) {
    const template = templateProjectId ?? state.selectedProjectId ?? state.active?.projectId ?? state.projects[0]?.projectId ?? null;
    state.selectionRevision += 1;
    state.selectedProjectId = null;
    state.selectedRecord = null;
    state.draft = null;
    state.draftMode = 'prepare';
    state.newProjectInput = {
      templateProjectId: template,
      projectId: '',
      displayName: '',
      targetRoot: '',
      workspaceRoot: '',
      shadowRoot: '',
      browserProfileDirectory: '',
    };
    state.dirty = false;
    state.validation = null;
    state.readiness = null;
    state.connectionChecks = { host: null, git: null, browser: null, gateway: null };
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    state.notice = { tone: 'local', message: 'Enter target paths. The backend will resolve physical identity and prepare a non-persistent canonical draft.' };
    emit();
    return { ok: true };
  }

  function updateNewProjectInput(field, value, options_ = {}) {
    if (state.draftMode !== 'prepare' || state.newProjectInput === null) return snapshot();
    state.newProjectInput = { ...state.newProjectInput, [field]: value };
    state.dirty = Object.entries(state.newProjectInput).some(([key, entry]) => key !== 'templateProjectId' && String(entry ?? '').trim() !== '');
    state.error = null;
    if (options_.notify !== false) emit();
    return snapshot();
  }

  function beginDraftPreparation() {
    return begin('preparing-project', null);
  }

  function applyPreparedDraft(token, value) {
    if (!tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_PREPARE_RESPONSE' };
    const body = bodyObject(value);
    const profile = body.profile;
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      return applyFailure(token, 'PROJECT_DRAFT_PREPARATION_INVALID', 'The backend did not return a strict Project Profile draft.');
    }
    state.draft = cloneValue(profile);
    state.draftMode = 'create';
    state.newProjectInput = null;
    state.dirty = true;
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    const warnings = Array.isArray(body.warnings) ? body.warnings.join(' ') : '';
    state.notice = { tone: 'local', message: warnings || 'Canonical new Project Profile draft prepared. Nothing is persisted until SAVE succeeds.' };
    emit();
    return { applied: true, profile: cloneValue(profile) };
  }

  function startNew(profile) {
    state.selectionRevision += 1;
    state.selectedProjectId = null;
    state.selectedRecord = null;
    state.draft = cloneValue(profile);
    state.draftMode = 'create';
    state.newProjectInput = null;
    state.dirty = true;
    state.validation = null;
    state.readiness = null;
    state.connectionChecks = { host: null, git: null, browser: null, gateway: null };
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    state.notice = { tone: 'local', message: 'New Project Profile draft. Nothing is persisted until SAVE succeeds.' };
    emit();
    return snapshot();
  }

  function replaceDraft(profile, options_ = {}) {
    if (state.draft === null) return snapshot();
    state.draft = cloneValue(profile);
    state.dirty = options_.dirty !== false;
    if (options_.notify !== false) emit();
    return snapshot();
  }

  function updateDraft(path, value, options_ = {}) {
    if (state.draft === null) return snapshot();
    state.draft = writePath(state.draft, path, value);
    state.dirty = true;
    state.validation = null;
    state.readiness = null;
    if (options_.notify !== false) emit();
    return snapshot();
  }

  function resetDraft() {
    if (state.selectedRecord === null) return snapshot();
    state.draft = cloneValue(state.selectedRecord.profile);
    state.dirty = false;
    state.validation = null;
    state.readiness = null;
    state.error = null;
    state.notice = null;
    emit();
    return snapshot();
  }

  function beginSave() {
    return begin(state.draftMode === 'create' ? 'creating-project' : 'saving-project');
  }

  function applySaved(token, value, connectionCheck = null) {
    if (!tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_SAVE_RESPONSE' };
    const record = recordFrom(value);
    if (record === null) return applyFailure(token, 'SAVE_RESPONSE_INVALID', 'The backend did not return a durable Project Profile record.');
    if (state.draftMode === 'update' && record.profile?.projectId !== state.selectedProjectId) {
      return { applied: false, reason: 'STALE_SAVE_RESPONSE' };
    }
    state.selectionRevision += 1;
    state.selectedProjectId = record.profile.projectId;
    state.selectedRecord = cloneValue(record);
    state.draft = cloneValue(record.profile);
    state.draftMode = 'update';
    state.dirty = false;
    state.validation = null;
    state.readiness = null;
    state.connectionChecks = { host: null, git: null, browser: null, gateway: null };
    if (connectionCheck) state.connectionChecks[connectionCheck.kind] = cloneValue(connectionCheck.value);
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    state.notice = { tone: 'good', message: `Saved ${record.profile.projectId} generation ${record.generation}.` };
    const existing = state.projects.findIndex((item) => item.projectId === record.profile.projectId);
    const metadata = {
      projectId: record.profile.projectId,
      displayName: record.profile.displayName,
      targetRoot: record.profile.targetRoot,
      targetRootIdentity: record.profile.targetRootIdentity,
      generation: record.generation,
      projectProfileHash: record.projectProfileHash,
      updatedAt: record.updatedAt,
    };
    if (existing < 0) state.projects.push(metadata);
    else state.projects[existing] = { ...state.projects[existing], ...metadata };
    state.projects.sort((left, right) => String(left.projectId).localeCompare(String(right.projectId)));
    emit();
    return { applied: true, record: cloneValue(record) };
  }

  function beginActivation() {
    return begin('activating-project');
  }

  function applyActivated(token, value) {
    if (!tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_ACTIVATION_RESPONSE' };
    const pointer = pointerFrom(value);
    const currentIdentity = operationIdentityOf(state.selectedRecord);
    if (pointer === null || !sameOperationIdentity(activePointerIdentity(pointer), currentIdentity)) {
      return applyFailure(token, 'ACTIVATION_RESPONSE_INVALID', 'The backend did not publish the selected Project Profile generation.');
    }
    state.active = cloneValue(pointer);
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    state.notice = { tone: 'good', message: `Active target is now ${pointer.projectId} generation ${pointer.profileGeneration}.` };
    emit();
    return { applied: true, pointer: cloneValue(pointer) };
  }

  function applyDeleted(token, value) {
    if (!tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_DELETE_RESPONSE' };
    const body = bodyObject(value);
    const projectId = typeof body.projectId === 'string' ? body.projectId : token.projectId;
    state.projects = state.projects.filter((item) => item.projectId !== projectId);
    state.selectionRevision += 1;
    state.selectedProjectId = null;
    state.selectedRecord = null;
    state.draft = null;
    state.draftMode = 'none';
    state.newProjectInput = null;
    state.dirty = false;
    state.validation = null;
    state.readiness = null;
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    state.notice = { tone: 'good', message: `Deleted CLU-E profile ${projectId}; target and workspace data were not deleted.` };
    emit();
    return { applied: true, projectId };
  }


  function applyFailure(token, code, message) {
    if (token && !tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_FAILURE' };
    state.phase = 'ready';
    state.pending = null;
    state.error = { code: String(code ?? 'OPERATION_FAILED'), message: String(message ?? 'Operation failed.') };
    state.notice = { tone: 'bad', message: `${state.error.code}: ${state.error.message}` };
    emit();
    return { applied: false, reason: state.error.code };
  }

  function clearError() {
    state.error = null;
    if (state.notice?.tone === 'bad') state.notice = null;
    emit();
  }

  function applyValidation(token, value) {
    if (!tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_VALIDATION_RESPONSE' };
    const body = bodyObject(value);
    if (body.projectId !== state.selectedProjectId || body.generation !== state.selectedRecord?.generation) {
      return applyFailure(token, 'VALIDATION_IDENTITY_MISMATCH', 'The backend validation did not match the selected Project Profile generation.');
    }
    state.validation = cloneValue(body);
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    emit();
    return { applied: true };
  }

  function applyReadiness(token, value) {
    if (!tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_READINESS_RESPONSE' };
    const body = bodyObject(value);
    const identity = body.projectIdentity;
    const current = operationIdentityOf(state.selectedRecord);
    if (!sameOperationIdentity({ ...identity, profileGeneration: body.profileGeneration }, current)) {
      return applyFailure(token, 'READINESS_IDENTITY_MISMATCH', 'The readiness response did not match the selected Project Profile generation.');
    }
    state.readiness = cloneValue(body);
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    emit();
    return { applied: true };
  }

  function applyConnectionCheck(token, kind, value) {
    if (!tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_CONNECTION_RESPONSE' };
    state.connectionChecks = { ...state.connectionChecks, [kind]: cloneValue(bodyObject(value)) };
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    emit();
    return { applied: true };
  }

  function complete(token, tone = 'good', message = '') {
    if (token && !tokenMatchesSelection(token, state)) return { applied: false, reason: 'STALE_COMPLETION' };
    state.phase = 'ready';
    state.pending = null;
    state.error = null;
    state.notice = message ? { tone, message } : null;
    emit();
    return { applied: true };
  }

  function setReadinessOperation(operation) {
    state.readinessOperation = operation;
    state.readiness = null;
    emit();
  }

  function setNotice(tone, message) {
    state.notice = message ? { tone, message } : null;
    emit();
  }

  return Object.freeze({
    snapshot,
    subscribe,
    begin,
    applyListing,
    setLegacyConfiguration,
    selectProject,
    beginProjectRead,
    applyProjectRead,
    beginNewPreparation,
    updateNewProjectInput,
    beginDraftPreparation,
    applyPreparedDraft,
    startNew,
    replaceDraft,
    updateDraft,
    resetDraft,
    beginSave,
    applySaved,
    beginActivation,
    applyActivated,
    applyDeleted,
    applyFailure,
    clearError,
    applyValidation,
    applyReadiness,
    applyConnectionCheck,
    complete,
    setReadinessOperation,
    setNotice,
  });
}
