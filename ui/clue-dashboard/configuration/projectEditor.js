/** PROJECT identity, canonical roots and the new-profile preparation form. */

import {
  badge,
  escapeHtml,
  fieldGroup,
  fieldMeta,
  fieldShell,
  isBusy,
  sectionHeader,
  shortIdentity,
  textInput,
} from './viewPrimitives.js';
import {
  blockingProblems,
  PROJECT_ID_PATTERN,
  PROJECT_PROFILE_HASH_PATTERN,
  TARGET_ROOT_IDENTITY_PATTERN,
} from './draftIssues.js';

export { PROJECT_ID_PATTERN, PROJECT_PROFILE_HASH_PATTERN, TARGET_ROOT_IDENTITY_PATTERN };

export function normalizeProjectIdDraft(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function newProjectInputProblems(input) {
  if (!input || typeof input !== 'object') return ['No new-project preparation form is active.'];
  const problems = [];
  if (!PROJECT_ID_PATTERN.test(normalizeProjectIdDraft(input.projectId))) problems.push('Project ID must match [a-z0-9][a-z0-9._-]*.');
  for (const [field, label] of [['targetRoot', 'Target Root'], ['workspaceRoot', 'Workspace Root'], ['shadowRoot', 'Shadow Root']]) {
    if (String(input[field] ?? '').trim() === '') problems.push(`${label} is required.`);
  }
  return problems;
}

/**
 * The problems that block SAVE for a draft, as plain messages.
 *
 * Kept as the stable name callers already use; the per-field, per-section form of the same facts
 * is `draftIssues` in draftIssues.js.
 */
export function projectDraftProblems(profile) {
  return blockingProblems(profile);
}

function renderProblems(problems) {
  return problems.length === 0
    ? '<span class="cfg-inline-ok">Nothing blocks saving.</span>'
    : `<details class="cfg-inline-problems" data-cfg-details="project-problems"><summary>${problems.length} issue(s)</summary><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul></details>`;
}

function separatorOf(path) {
  return String(path).includes('\\') ? '\\' : '/';
}

/**
 * Suggests a sibling folder for a new profile from the folder an existing profile uses.
 *
 * `F:\CLU\workspace\alpha` + `beta` → `F:\CLU\workspace\beta`. Returned only when the existing
 * folder really ends in that profile's ID; otherwise there is no pattern to follow and nothing is
 * suggested. The backend still canonicalises and validates whatever is submitted.
 */
export function suggestSiblingPath(templatePath, templateProjectId, projectId) {
  const path = String(templatePath ?? '').trim();
  const from = String(templateProjectId ?? '').trim();
  const to = normalizeProjectIdDraft(projectId);
  if (path === '' || from === '' || !PROJECT_ID_PATTERN.test(to)) return '';
  const separator = separatorOf(path);
  const parts = path.split(/[\\/]/u);
  if ((parts.at(-1) ?? '').toLowerCase() !== from.toLowerCase()) return '';
  parts[parts.length - 1] = to;
  return parts.join(separator);
}

export function newProjectSuggestions(input, templateRoots) {
  if (!input || !templateRoots || typeof templateRoots !== 'object') return {};
  const suggestions = {};
  for (const field of ['workspaceRoot', 'shadowRoot', 'browserProfileDirectory']) {
    if (String(input[field] ?? '').trim() !== '') continue;
    const suggestion = suggestSiblingPath(templateRoots[field], templateRoots.projectId, input.projectId);
    if (suggestion !== '') suggestions[field] = suggestion;
  }
  return suggestions;
}

/** The footer of the preparation form. Re-rendered alone while the operator types. */
export function renderPreparationFooter(snapshot) {
  const input = snapshot.newProjectInput ?? {};
  const problems = newProjectInputProblems(input);
  const suggestions = newProjectSuggestions(input, snapshot.ui?.templateRoots ?? null);
  const suggested = Object.keys(suggestions).length;
  return `<div>${problems.length === 0
    ? '<span class="cfg-inline-ok">Ready to resolve. The backend checks the folders next.</span>'
    : `<ul class="cfg-inline-list">${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>`}</div>
    <div class="cfg-action-row">${suggested > 0 ? `<button type="button" data-cfg-action="fill-new-suggestions" title="${escapeHtml(Object.values(suggestions).join('\n'))}">FILL SUGGESTED FOLDERS</button>` : ''}<button type="button" data-cfg-action="cancel-new-project">CANCEL</button><button type="button" class="is-primary" data-cfg-action="prepare-new-project"${problems.length || isBusy(snapshot) ? ' disabled' : ''}>RESOLVE & PREPARE</button></div>`;
}

function newField(input, field, label, options = {}) {
  const value = input[field] ?? '';
  return fieldShell({
    label,
    wide: options.wide === true,
    required: options.required === true,
    note: options.note ?? '',
    control: `<input data-new-project-field="${field}" value="${escapeHtml(value)}" placeholder="${escapeHtml(options.placeholder ?? '')}" autocomplete="off" spellcheck="false" />`,
  });
}

function renderPreparation(snapshot) {
  const input = snapshot.newProjectInput ?? {};
  return `<section class="cfg-card cfg-project-card" data-section="project">
    ${sectionHeader({
      kicker: 'NEW PROFILE · STEP 1 OF 2',
      title: 'Tell CLU-E where the target lives',
      description: 'Enter a short ID and three folders. The backend then resolves the real folder identity, refuses duplicates and overlaps, and returns a complete draft for you to review. Nothing is written in this step.',
      badges: badge('INCOMPLETE', 'NOT SAVED'),
    })}
    ${fieldGroup({
      title: 'Identity',
      description: 'The ID is permanent and names this profile everywhere. The display name is only a label.',
      body: `<div class="cfg-form-grid">
        ${newField(input, 'projectId', 'Project ID', { required: true, placeholder: 'murugan-webgpu', note: 'Lowercase letters, digits, dot, dash, underscore. Cannot be changed later.' })}
        ${newField(input, 'displayName', 'Display Name', { placeholder: 'MURUGAN WEBGPU', note: 'Optional. Shown instead of the ID.' })}
      </div>`,
    })}
    ${fieldGroup({
      title: 'Folders',
      description: 'Three separate folders that must not overlap each other or another profile.',
      body: `<div class="cfg-form-grid">
        ${newField(input, 'targetRoot', 'Target Root', { wide: true, required: true, placeholder: 'F:\\Murugan\\Murugan', note: 'The repository CLU-E will study and improve. It is never modified outside governed landing.' })}
        ${newField(input, 'workspaceRoot', 'Workspace Root', { wide: true, required: true, placeholder: 'F:\\CLU\\workspace\\murugan', note: 'Where CLU-E keeps this profile’s events, database and evidence.' })}
        ${newField(input, 'shadowRoot', 'Shadow Root', { wide: true, required: true, placeholder: 'F:\\CLU\\shadow\\murugan', note: 'An isolated copy of the target where candidate changes are tried.' })}
        ${newField(input, 'browserProfileDirectory', 'Browser Profile Directory', { wide: true, placeholder: 'optional; the backend derives a safe default', note: 'Optional. The dedicated Chrome profile used for this target.' })}
      </div>`,
    })}
    ${input.templateProjectId ? `<p class="cfg-note">Starting settings are taken from <strong>${escapeHtml(input.templateProjectId)}</strong>. Governing documents, benchmark command, browser URL and Git remote start empty.</p>` : ''}
    <footer class="cfg-card-actions" data-cfg-region="prepare-footer">${renderPreparationFooter(snapshot)}</footer>
  </section>`;
}

/**
 * @param {object} snapshot
 * @param {{actions?: boolean}} [options] `actions: false` omits the card's own lifecycle buttons
 *   for hosts that provide them elsewhere (the Configuration shell's save bar and Overview).
 */
export function renderProjectEditor(snapshot, options = {}) {
  if (snapshot.draftMode === 'prepare') return renderPreparation(snapshot);
  const profile = snapshot.draft;
  const record = snapshot.selectedRecord;
  if (!profile) {
    return `<section class="cfg-card cfg-project-card" data-section="project">${sectionHeader({ kicker: 'PROJECT', title: 'No Project Profile selected', badges: badge('INCOMPLETE') })}<p class="cfg-empty-copy">Select a saved profile or use NEW PROFILE to prepare the first target from installation defaults.</p><div class="cfg-action-row is-start"><button type="button" class="is-primary" data-cfg-action="new-project">NEW PROFILE</button></div></section>`;
  }

  const problems = projectDraftProblems(profile);
  const generation = record?.generation ?? null;
  const identity = record?.projectProfileHash ?? null;
  const modeLabel = snapshot.draftMode === 'create' ? 'NEW · NOT SAVED' : snapshot.dirty ? 'UNSAVED CHANGES' : `SAVED · G${generation ?? '?'}`;
  const busy = isBusy(snapshot);
  const canSave = problems.length === 0 && !busy && (snapshot.draftMode === 'create' || snapshot.dirty);
  const canDelete = Boolean(record && snapshot.active?.projectId !== profile.projectId && !busy);
  const field = (path, spec) => fieldShell({ ...spec, ...fieldMeta(snapshot, path) });
  const footer = options.actions === false ? '' : `<footer class="cfg-card-actions"><div>${renderProblems(problems)}</div><div class="cfg-action-row"><button type="button" data-cfg-action="reset-profile"${!snapshot.dirty || snapshot.draftMode === 'create' ? ' disabled' : ''}>RESET</button><button type="button" data-cfg-action="delete-profile" class="is-danger"${canDelete ? '' : ' disabled'}>DELETE</button><button type="button" data-cfg-action="validate-profile"${!record || snapshot.dirty || busy ? ' disabled' : ''}>VALIDATE</button><button type="button" data-cfg-action="save-profile" class="is-primary"${canSave ? '' : ' disabled'}>SAVE</button></div></footer>`;

  return `<section class="cfg-card cfg-project-card" data-section="project">
    ${sectionHeader({
      kicker: 'PROJECT & PATHS',
      title: profile.displayName || profile.projectId,
      description: 'Who this profile is and where it works. The ID and folders are fixed once a profile exists; to point CLU-E at another repository, create another profile.',
      badges: `${badge(snapshot.dirty ? 'DRIFTED' : 'VALID', modeLabel)}${snapshot.active?.projectId === profile.projectId ? badge('READY', 'RUNNING') : badge('NOT_REQUIRED', 'NOT RUNNING')}`,
    })}
    ${fieldGroup({
      title: 'Name',
      body: `<div class="cfg-form-grid">
        ${field('projectId', { label: 'Project ID', control: textInput('projectId', profile.projectId, { readonly: true }), note: 'Permanent. Names this profile’s events, proofs and Great Book.' })}
        ${field('displayName', { label: 'Display Name', control: textInput('displayName', profile.displayName ?? '', { placeholder: profile.projectId }), note: 'A label only. Leave empty to show the ID.' })}
      </div>`,
    })}
    ${fieldGroup({
      title: 'Folders',
      description: 'Read-only. These were resolved by the backend when the profile was created.',
      body: `<div class="cfg-form-grid">
        ${field('targetRoot', { label: 'Target Root', wide: true, control: textInput('targetRoot', profile.targetRoot, { readonly: true }), note: 'The repository CLU-E studies and improves.' })}
        ${field('workspaceRoot', { label: 'Workspace Root', wide: true, control: textInput('workspaceRoot', profile.workspaceRoot, { readonly: true }), note: 'This profile’s events, database and evidence.' })}
        ${field('shadowRoot', { label: 'Shadow Root', wide: true, control: textInput('shadowRoot', profile.shadowRoot, { readonly: true }), note: 'The isolated copy where candidate changes are tried.' })}
      </div>`,
    })}
    <details class="cfg-technical" data-cfg-details="project-identity"><summary>Technical identity</summary>
      <div class="cfg-identity-strip">
        <span><b>Generation</b>${generation ?? 'draft'}</span>
        <span title="${escapeHtml(identity ?? '')}"><b>Profile hash</b>${escapeHtml(shortIdentity(identity, 24))}</span>
        <span title="${escapeHtml(profile.targetRootIdentity ?? '')}"><b>Target identity</b>${escapeHtml(shortIdentity(profile.targetRootIdentity, 24))}</span>
      </div>
      <div class="cfg-form-grid">
        ${field('targetRootIdentity', { label: 'Target Root Identity', wide: true, control: textInput('targetRootIdentity', profile.targetRootIdentity, { readonly: true }), note: 'The physical identity of the target folder. Two profiles can never share it.' })}
      </div>
      <p class="cfg-note">Every save creates a new generation with a new hash. Evidence is always bound to the exact generation that produced it.</p>
    </details>
    ${footer}
  </section>`;
}
