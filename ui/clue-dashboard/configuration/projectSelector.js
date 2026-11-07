/** Saved Project selector and active-target identity presentation. */

import { badge, escapeHtml, shortIdentity } from './viewPrimitives.js';

export function projectSelectorModel(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const active = state?.active ?? null;
  return Object.freeze({
    projects,
    active,
    selectedProjectId: state?.selectedProjectId ?? null,
    dirty: state?.dirty === true,
    draftMode: state?.draftMode ?? 'none',
    phase: state?.phase ?? 'idle',
  });
}

export function renderProjectSelector(state) {
  const model = projectSelectorModel(state);
  const options = model.projects.map((project) => {
    const active = project.projectId === model.active?.projectId ? ' · ACTIVE' : '';
    const selected = project.projectId === model.selectedProjectId ? ' selected' : '';
    return `<option value="${escapeHtml(project.projectId)}"${selected}>${escapeHtml(project.displayName || project.projectId)} · g${project.generation}${active}</option>`;
  }).join('');
  const activeState = model.active ? badge('READY', 'ACTIVE') : badge('INCOMPLETE', 'NO ACTIVE PROJECT');
  const selectionState = model.draftMode === 'prepare' || model.draftMode === 'create'
    ? badge('UNVALIDATED', 'NEW DRAFT')
    : model.dirty
      ? badge('DRIFTED', 'UNSAVED')
      : badge(model.selectedProjectId ? 'VALID' : 'INCOMPLETE', model.selectedProjectId ? 'SELECTED' : 'NO SELECTION');
  const activeProject = model.active?.projectId ?? 'none';
  const activeHash = model.active?.projectProfileHash ?? '';
  const activeGeneration = model.active?.profileGeneration ?? null;

  return `<section class="cfg-command-bar cfg-project-selector" data-config-section="selector">
    <div class="cfg-command-identity">
      <span class="cfg-kicker">ACTIVE TARGET</span>
      <strong>${escapeHtml(activeProject.toUpperCase())}</strong>
      <span title="${escapeHtml(activeHash)}">${activeGeneration === null ? 'No Project Profile generation is active.' : `generation ${activeGeneration} · ${escapeHtml(shortIdentity(activeHash, 24))}`}</span>
    </div>
    <div class="cfg-command-controls">
      <label class="cfg-selector-label"><span>SAVED PROJECT</span>
        <select id="cfgProjectSelector"${model.projects.length === 0 ? ' disabled' : ''}>
          ${options || '<option value="">No Project Profiles registered</option>'}
        </select>
      </label>
      <div class="cfg-badge-row">${activeState}${selectionState}</div>
      <button type="button" data-cfg-action="reload-projects">REFRESH</button>
      <button type="button" data-cfg-action="new-project">CREATE NEW</button>
      <button type="button" data-cfg-action="activate-project" class="is-primary"${!model.selectedProjectId || model.dirty || model.selectedProjectId === model.active?.projectId ? ' disabled' : ''}>ACTIVATE</button>
    </div>
    ${model.dirty ? '<p class="cfg-unsaved-warning">UNSAVED PROFILE DRAFT — activation, validation and connection tests remain blocked until SAVE succeeds.</p>' : ''}
  </section>`;
}
