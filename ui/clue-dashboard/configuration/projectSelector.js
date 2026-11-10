/**
 * Profile context bar: which profile is being edited, which one CLU-E is running, and the three
 * things an operator does to the set of profiles (refresh, create, activate).
 *
 * "Editing" and "running" are different facts and are shown as different things. Choosing a profile
 * in the selector never activates it; saving never activates it. The relation between the two is
 * spelled out in a sentence by {@link renderRelationBanner} whenever they differ.
 */

import { badge, escapeHtml, sectionHeader, shortIdentity } from './viewPrimitives.js';

function legacyStartupBinding(snapshot) {
  const configuration = snapshot?.legacyConfiguration;
  if (configuration?.projectProfiles?.runtimeMode !== 'legacy-v2') return null;
  return {
    runningTarget: configuration.project?.id ?? 'unknown',
    active: snapshot.registryGeneration == null ? configuration.projectProfiles.active : snapshot.active,
    localControls: configuration.legacyConnectionControls === true,
  };
}

export function isLegacyStartup(snapshot) {
  return legacyStartupBinding(snapshot) !== null;
}

export function renderStartupBinding(snapshot) {
  const binding = legacyStartupBinding(snapshot);
  if (!binding) return '';
  const { runningTarget, active, localControls } = binding;
  const id = active?.projectId;
  const generation = active?.profileGeneration;

  return `<section id="cfgStartupBinding" class="cfg-card cfg-startup-binding" data-section="startup" aria-labelledby="cfgStartupBindingTitle" tabindex="-1">
    <header class="cfg-card-head"><div><span class="cfg-kicker">STARTUP BINDING</span><h3 id="cfgStartupBindingTitle">Dashboard is running in legacy mode</h3><p class="cfg-card-lede">This dashboard was started for a legacy target, not for a registry profile. Profiles can be edited and saved here; they take effect on a profile-bound launch.</p></div>${badge('INCOMPLETE', 'LEGACY V2')}</header>
    <p class="cfg-card-copy">Running target <strong>${escapeHtml(runningTarget)}</strong> · Registry active profile <strong>${id ? `${escapeHtml(id)} · g${escapeHtml(generation)}` : 'none'}</strong></p>
    <p class="cfg-card-copy">The ribbon checks Git and AI for the running legacy target. A profile-bound launch uses the registry active profile’s settings.</p>
    ${localControls && id ? `<details data-cfg-details="startup-instructions">
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

/** The saved/unsaved state of the profile being edited. Re-rendered alone while the operator types. */
export function renderSelectionBadges(state) {
  const model = projectSelectorModel(state);
  if (model.draftMode === 'prepare' || model.draftMode === 'create') return badge('UNVALIDATED', 'NEW DRAFT');
  if (model.dirty) return badge('DRIFTED', 'UNSAVED');
  return badge(model.selectedProjectId ? 'VALID' : 'INCOMPLETE', model.selectedProjectId ? 'SAVED' : 'NO SELECTION');
}

function activateDisabledReason(model) {
  if (!model.selectedProjectId) return 'Select a saved profile first.';
  if (model.dirty) return 'Save or discard your changes before activating.';
  if (model.selectedProjectId === model.active?.projectId) return 'This profile is already the running target.';
  return '';
}

export function renderProjectSelector(state) {
  const model = projectSelectorModel(state);
  const legacy = legacyStartupBinding(state) !== null;
  const options = model.projects.map((project) => {
    const active = project.projectId === model.active?.projectId ? (legacy ? ' · REGISTRY ACTIVE' : ' · ACTIVE') : '';
    const selected = project.projectId === model.selectedProjectId ? ' selected' : '';
    return `<option value="${escapeHtml(project.projectId)}"${selected}>${escapeHtml(project.displayName || project.projectId)} · g${project.generation}${active}</option>`;
  }).join('');
  const creating = model.draftMode === 'prepare' || model.draftMode === 'create';
  const placeholder = creating
    ? '<option value="" selected>New profile (not saved)</option>'
    : model.selectedProjectId === null && model.projects.length > 0
      ? '<option value="" selected disabled>Choose a profile…</option>'
      : '';
  const activeState = model.active
    ? (legacy ? badge('UNVALIDATED', 'REGISTRY ACTIVE') : badge('READY', 'RUNNING'))
    : badge('INCOMPLETE', 'NOTHING RUNNING');
  const activeProject = model.active?.projectId ?? 'none';
  const activeHash = model.active?.projectProfileHash ?? '';
  const activeGeneration = model.active?.profileGeneration ?? null;
  const reason = activateDisabledReason(model);
  const registry = state?.registryGeneration;

  return `<section class="cfg-command-bar cfg-project-selector" data-config-section="selector" aria-label="Profile selection">
    <div class="cfg-context-editing">
      <label class="cfg-selector-label"><span>EDITING PROFILE</span>
        <select id="cfgProjectSelector"${model.projects.length === 0 ? ' disabled' : ''} title="Choosing a profile here opens it for editing. It does not change what CLU-E is running.">
          ${placeholder}${options || (placeholder === '' ? '<option value="">No Project Profiles registered</option>' : '')}
        </select>
      </label>
      <div class="cfg-badge-row" data-cfg-region="selection-badges">${renderSelectionBadges(state)}</div>
    </div>
    <div class="cfg-command-identity" title="${escapeHtml(activeHash)}">
      <span class="cfg-kicker">${legacy ? 'REGISTRY ACTIVE PROFILE' : 'ACTIVE TARGET'}</span>
      <div class="cfg-running-line"><strong>${escapeHtml(activeProject.toUpperCase())}</strong>${activeState}</div>
      <span>${activeGeneration === null ? 'No Project Profile generation is active.' : `generation ${activeGeneration} · ${escapeHtml(shortIdentity(activeHash, 24))}`}${Number.isSafeInteger(registry) ? ` · registry g${registry}` : ''}</span>
    </div>
    <div class="cfg-command-controls">
      <button type="button" data-cfg-action="reload-projects" title="Reload every profile from the registry">REFRESH</button>
      <button type="button" data-cfg-action="new-project" title="Prepare a profile for another target">NEW PROFILE</button>
      <button type="button" class="is-primary" data-cfg-action="activate-project"${reason === '' ? '' : ' disabled'} title="${escapeHtml(reason === '' ? 'Make the profile you are editing the running target' : reason)}">ACTIVATE…</button>
    </div>
  </section>`;
}

/**
 * One sentence that relates the profile being edited to the profile that is running.
 *
 * Returns an empty string when they are the same saved generation, because then there is nothing
 * to explain. Every other case is a state an operator has to understand before acting.
 */
export function renderRelationBanner(snapshot) {
  const banner = (tone, text, action = '') => `<div class="cfg-relation is-${tone}" role="note"><p>${text}</p>${action}</div>`;
  const go = (target, label) => `<button type="button" data-cfg-action="go-section" data-section-target="${target}">${label}</button>`;

  const legacy = legacyStartupBinding(snapshot);
  if (legacy) {
    return banner('warn',
      `The dashboard is running the legacy target <strong>${escapeHtml(legacy.runningTarget)}</strong>, not a registry profile. Profiles saved here apply on a profile-bound launch.`,
      go('startup', 'STARTUP MODE'));
  }
  const mode = snapshot?.draftMode ?? 'none';
  if (mode === 'prepare') {
    return banner('local', 'You are setting up a new profile. Enter its folders below; nothing is written until you create it.');
  }
  if (mode === 'create') {
    return banner('local', 'This new profile exists only in this browser tab. Review its sections, then press <strong>CREATE PROFILE</strong> to save it.');
  }
  const record = snapshot?.selectedRecord ?? null;
  const active = snapshot?.active ?? null;
  if (!record) return '';
  const name = escapeHtml(record.profile?.displayName || record.profile?.projectId || 'this profile');
  if (!active) {
    return banner('warn', `No profile is running. <strong>${name}</strong> is saved but inactive; activate it to work with it.`);
  }
  if (active.projectId !== record.profile?.projectId) {
    return banner('local',
      `You are editing <strong>${name}</strong>. CLU-E is running <strong>${escapeHtml(active.projectId)}</strong>, which your edits do not touch. Activate <strong>${name}</strong> to switch to it.`);
  }
  if (active.profileGeneration !== record.generation || active.projectProfileHash !== record.projectProfileHash) {
    return banner('warn',
      `Generation ${escapeHtml(record.generation)} of this profile is saved, but CLU-E is still running generation ${escapeHtml(active.profileGeneration)}. Restart the dashboard (close it, then open CLUE-Dashboard.bat) to load the saved generation. Connection tests stay unavailable until then.`);
  }
  return '';
}

/** Every registered profile at a glance, with the one being edited and the one running marked. */
export function renderProfilesIndex(snapshot) {
  const model = projectSelectorModel(snapshot);
  const rows = model.projects.map((project) => {
    const running = project.projectId === model.active?.projectId;
    const editing = project.projectId === model.selectedProjectId;
    const updated = typeof project.updatedAt === 'string' ? new Date(project.updatedAt) : null;
    return `<tr class="${editing ? 'is-editing' : ''}">
      <th scope="row"><strong>${escapeHtml(project.displayName || project.projectId)}</strong><span>${escapeHtml(project.projectId)}</span></th>
      <td title="${escapeHtml(project.targetRoot ?? '')}">${escapeHtml(project.targetRoot ?? '—')}</td>
      <td>g${escapeHtml(project.generation)}</td>
      <td>${updated && Number.isFinite(updated.getTime()) ? `<time datetime="${escapeHtml(updated.toISOString())}">${escapeHtml(updated.toLocaleString())}</time>` : '—'}</td>
      <td><div class="cfg-badge-row">${running ? badge('READY', 'RUNNING') : ''}${editing ? badge('READY_LOCAL_ONLY', 'EDITING') : ''}</div></td>
      <td>${editing ? '' : `<button type="button" data-cfg-action="edit-profile" data-project-id="${escapeHtml(project.projectId)}">EDIT</button>`}</td>
    </tr>`;
  }).join('');
  return `<section class="cfg-card" data-section="profiles">
    ${sectionHeader({
      kicker: 'ALL PROFILES',
      title: 'Registered profiles',
      description: 'One profile describes one target: its folders, documents and connections. CLU-E runs exactly one profile at a time.',
      badges: badge(model.projects.length ? 'VALID' : 'INCOMPLETE', `${model.projects.length} REGISTERED`),
    })}
    ${model.projects.length === 0
      ? '<p class="cfg-empty-copy">No profile is registered yet. Create the first one to tell CLU-E which program to work on.</p>'
      : `<div class="cfg-table-wrap"><table class="cfg-table"><thead><tr><th scope="col">Profile</th><th scope="col">Target folder</th><th scope="col">Saved</th><th scope="col">Last change</th><th scope="col">State</th><th scope="col"><span class="cfg-sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`}
    <footer class="cfg-card-actions"><p class="cfg-note">EDIT opens a profile here without changing what CLU-E is running.</p><div class="cfg-action-row"><button type="button" data-cfg-action="reload-projects">REFRESH</button><button type="button" class="is-primary" data-cfg-action="new-project">NEW PROFILE</button></div></footer>
  </section>`;
}
