/** Saved Project selector and active-target identity presentation. */

import { badge, escapeHtml, shortIdentity } from './viewPrimitives.js';

function legacyStartupBinding(snapshot) {
  const configuration = snapshot.legacyConfiguration;
  if (configuration?.projectProfiles?.runtimeMode !== 'legacy-v2') return null;
  return {
    runningTarget: configuration.project?.id ?? 'unknown',
    active: snapshot.registryGeneration == null ? configuration.projectProfiles.active : snapshot.active,
    localControls: configuration.legacyConnectionControls === true,
  };
}

export function renderStartupBinding(snapshot) {
  const binding = legacyStartupBinding(snapshot);
  if (!binding) return '';
  const { runningTarget, active, localControls } = binding;
  const id = active?.projectId;
  const generation = active?.profileGeneration;

  return `<section id="cfgStartupBinding" class="cfg-card cfg-startup-binding" aria-labelledby="cfgStartupBindingTitle" tabindex="-1">
    <header class="cfg-card-head"><div><span class="cfg-kicker">STARTUP BINDING</span><h3 id="cfgStartupBindingTitle">Dashboard is running in legacy mode</h3></div>${badge('INCOMPLETE', 'LEGACY V2')}</header>
    <p class="cfg-card-copy">Running target <strong>${escapeHtml(runningTarget)}</strong> · Registry active profile <strong>${id ? `${escapeHtml(id)} · g${escapeHtml(generation)}` : 'none'}</strong></p>
    <p class="cfg-card-copy">The ribbon checks Git and AI for the running legacy target. A profile-bound launch uses the registry active profile’s settings.</p>
    ${localControls && id ? `<details>
      <summary>Use the registry profile on the next launch</summary>
      <ol>
        <li>Close the running CLU-E Dashboard terminal.</li>
        <li>Open <code>CLUE-Dashboard.bat</code> again and choose <strong>Y</strong> when the launcher offers <strong>${escapeHtml(id)}</strong>. This uses the profile for future launches and initializes its workspace if needed.</li>
        <li>If setup is blocked, the launcher shows the reason in the terminal. Once the dashboard opens under this profile, it checks Git and AI using that profile’s settings.</li>
      </ol>
    </details>` : ''}
  </section>`;
}

export function renderStartupBindingLink(snapshot) {
  const binding = legacyStartupBinding(snapshot);
  if (!binding?.active) return '';
  return `<p class="cfg-connection-detail cfg-startup-binding-link">The ribbon checks legacy target <strong>${escapeHtml(binding.runningTarget)}</strong>. <button type="button" data-cfg-action="show-startup-binding">VIEW STARTUP BINDING</button></p>`;
}

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
  const legacy = legacyStartupBinding(state) !== null;
  const options = model.projects.map((project) => {
    const active = project.projectId === model.active?.projectId ? (legacy ? ' · REGISTRY ACTIVE' : ' · ACTIVE') : '';
    const selected = project.projectId === model.selectedProjectId ? ' selected' : '';
    return `<option value="${escapeHtml(project.projectId)}"${selected}>${escapeHtml(project.displayName || project.projectId)} · g${project.generation}${active}</option>`;
  }).join('');
  const activeState = model.active
    ? (legacy ? badge('UNVALIDATED', 'REGISTRY ACTIVE') : badge('READY', 'ACTIVE'))
    : badge('INCOMPLETE', 'NO ACTIVE PROJECT');
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
      <span class="cfg-kicker">${legacy ? 'REGISTRY ACTIVE PROFILE' : 'ACTIVE TARGET'}</span>
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
