/** PROJECT identity, canonical roots and durable lifecycle controls. */

import {
  badge,
  escapeHtml,
  fieldShell,
  shortIdentity,
  textInput,
} from './viewPrimitives.js';

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
export const TARGET_ROOT_IDENTITY_PATTERN = /^path:v1:[a-z0-9._-]+:[0-9a-f]{64}$/u;
export const PROJECT_PROFILE_HASH_PATTERN = /^profile:v1:[0-9a-f]{64}$/u;

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

export function projectDraftProblems(profile) {
  if (!profile || typeof profile !== 'object') return ['No Project Profile draft is loaded.'];
  const problems = [];
  if (!PROJECT_ID_PATTERN.test(String(profile.projectId ?? ''))) problems.push('Project ID is invalid.');
  if (String(profile.targetRoot ?? '').trim() === '') problems.push('Target Root is required.');
  if (!TARGET_ROOT_IDENTITY_PATTERN.test(String(profile.targetRootIdentity ?? ''))) problems.push('Target Root identity must be resolved by the backend.');
  if (String(profile.workspaceRoot ?? '').trim() === '') problems.push('Workspace Root is required.');
  if (String(profile.shadowRoot ?? '').trim() === '') problems.push('Shadow Root is required.');
  if (String(profile.integrations?.powershell?.hostScript ?? '').trim() === '') problems.push('PowerShell Host Script is required.');
  if (String(profile.integrations?.chrome?.dedicatedProfileDirectory ?? '').trim() === '') problems.push('Dedicated browser profile directory is required.');
  const resolution = profile.benchmarkRuntime?.resolution;
  if (resolution !== null && resolution !== undefined) {
    if (!Number.isSafeInteger(resolution.width) || resolution.width < 1 || !Number.isSafeInteger(resolution.height) || resolution.height < 1) {
      problems.push('Benchmark resolution requires both a positive width and height, or neither.');
    }
  }
  const credential = profile.integrations?.gpt?.credential;
  if (credential?.source === 'project-override' && !/^(?:env:[A-Z][A-Z0-9_]{0,63}|credential-store:[A-Za-z0-9][A-Za-z0-9._:/-]{0,191})$/u.test(String(credential.value ?? ''))) {
    problems.push('GPT override must be an env:/credential-store: reference, never secret bytes.');
  }
  return problems;
}

function renderProblems(problems) {
  return problems.length === 0
    ? '<span class="cfg-inline-ok">profile shape complete</span>'
    : `<details class="cfg-inline-problems"><summary>${problems.length} issue(s)</summary><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul></details>`;
}

function renderPreparation(snapshot) {
  const input = snapshot.newProjectInput ?? {};
  const problems = newProjectInputProblems(input);
  return `<section class="cfg-card cfg-project-card" data-section="project">
    <header class="cfg-card-head"><div><span class="cfg-kicker">PROJECT</span><h3>Prepare a canonical Project Profile</h3></div>${badge('INCOMPLETE', 'NON-PERSISTENT DRAFT')}</header>
    <p class="cfg-card-copy">Enter the human-facing roots. The backend resolves physical Target Root identity, rejects aliases/duplicates and constructs the strict profile. Nothing is written by this step.</p>
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'Starting settings', control: `<input value="${escapeHtml(input.templateProjectId ?? 'Installation defaults')}" readonly />`, note: 'Each profile starts with its own target, authority bindings and connections.' })}
      ${fieldShell({ label: 'Project ID', control: `<input data-new-project-field="projectId" value="${escapeHtml(input.projectId ?? '')}" placeholder="murugan-webgpu" />`, note: 'Keyboard editable and normalized to lowercase by the backend.' })}
      ${fieldShell({ label: 'Display name', control: `<input data-new-project-field="displayName" value="${escapeHtml(input.displayName ?? '')}" placeholder="MURUGAN WEBGPU" />` })}
      ${fieldShell({ label: 'Target Root', wide: true, control: `<div class="cfg-path-control"><input data-new-project-field="targetRoot" value="${escapeHtml(input.targetRoot ?? '')}" placeholder="F:\\Murugan\\Murugan" /><button type="button" data-cfg-action="pick-new-path" data-new-path-field="targetRoot">SELECT</button></div>` })}
      ${fieldShell({ label: 'Workspace Root', wide: true, control: `<div class="cfg-path-control"><input data-new-project-field="workspaceRoot" value="${escapeHtml(input.workspaceRoot ?? '')}" placeholder="F:\\CLU\\workspace\\murugan" /><button type="button" data-cfg-action="pick-new-path" data-new-path-field="workspaceRoot">SELECT</button></div>` })}
      ${fieldShell({ label: 'Shadow Root', wide: true, control: `<div class="cfg-path-control"><input data-new-project-field="shadowRoot" value="${escapeHtml(input.shadowRoot ?? '')}" placeholder="F:\\CLU\\shadow\\murugan" /><button type="button" data-cfg-action="pick-new-path" data-new-path-field="shadowRoot">SELECT</button></div>` })}
      ${fieldShell({ label: 'Browser profile directory', wide: true, control: `<div class="cfg-path-control"><input data-new-project-field="browserProfileDirectory" value="${escapeHtml(input.browserProfileDirectory ?? '')}" placeholder="optional; backend derives a safe default" /><button type="button" data-cfg-action="pick-new-path" data-new-path-field="browserProfileDirectory">SELECT</button></div>` })}
    </div>
    <footer class="cfg-card-actions"><div>${renderProblems(problems)}</div><div class="cfg-action-row"><button type="button" data-cfg-action="cancel-new-project">CANCEL</button><button type="button" data-cfg-action="prepare-new-project" class="is-primary"${problems.length ? ' disabled' : ''}>RESOLVE & PREPARE</button></div></footer>
  </section>`;
}

export function renderProjectEditor(snapshot) {
  if (snapshot.draftMode === 'prepare') return renderPreparation(snapshot);
  const profile = snapshot.draft;
  const record = snapshot.selectedRecord;
  if (!profile) {
    return `<section class="cfg-card cfg-project-card" data-section="project"><header class="cfg-card-head"><div><span class="cfg-kicker">PROJECT</span><h3>No Project Profile selected</h3></div>${badge('INCOMPLETE')}</header><p class="cfg-empty-copy">Select a saved profile or use CREATE NEW to prepare the first target from installation defaults.</p></section>`;
  }

  const problems = projectDraftProblems(profile);
  const generation = record?.generation ?? null;
  const identity = record?.projectProfileHash ?? null;
  const modeLabel = snapshot.draftMode === 'create' ? 'NEW / NOT SAVED' : snapshot.dirty ? 'UNSAVED SUCCESSOR' : 'DURABLE GENERATION';
  const busy = !['idle', 'ready'].includes(snapshot.phase);
  const canSave = problems.length === 0 && !busy && (snapshot.draftMode === 'create' || snapshot.dirty);
  const canDelete = Boolean(record && snapshot.active?.projectId !== profile.projectId && !busy);

  return `<section class="cfg-card cfg-project-card" data-section="project">
    <header class="cfg-card-head"><div><span class="cfg-kicker">PROJECT</span><h3>${escapeHtml(profile.displayName || profile.projectId)}</h3></div><div class="cfg-badge-row">${badge(snapshot.dirty ? 'DRIFTED' : 'VALID', modeLabel)}${snapshot.active?.projectId === profile.projectId ? badge('READY', 'ACTIVE') : badge('NOT_REQUIRED', 'INACTIVE')}</div></header>
    <div class="cfg-identity-strip">
      <span><b>Generation</b>${generation ?? 'draft'}</span>
      <span title="${escapeHtml(identity ?? '')}"><b>Profile hash</b>${escapeHtml(shortIdentity(identity, 24))}</span>
      <span title="${escapeHtml(profile.targetRootIdentity ?? '')}"><b>Target identity</b>${escapeHtml(shortIdentity(profile.targetRootIdentity, 24))}</span>
    </div>
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'Project ID', control: textInput('projectId', profile.projectId, { readonly: true }), note: 'Stable namespace; changing identity requires a new profile.' })}
      ${fieldShell({ label: 'Display name', control: textInput('displayName', profile.displayName ?? '', { placeholder: profile.projectId }) })}
      ${fieldShell({ label: 'Target Root', wide: true, control: textInput('targetRoot', profile.targetRoot, { readonly: true }), note: 'Canonical target roots are immutable in-place; prepare a new profile to target another repository.' })}
      ${fieldShell({ label: 'Target Root identity', wide: true, control: textInput('targetRootIdentity', profile.targetRootIdentity, { readonly: true }) })}
      ${fieldShell({ label: 'Workspace Root', wide: true, control: textInput('workspaceRoot', profile.workspaceRoot, { readonly: true }) })}
      ${fieldShell({ label: 'Shadow Root', wide: true, control: textInput('shadowRoot', profile.shadowRoot, { readonly: true }) })}
    </div>
    <footer class="cfg-card-actions"><div>${renderProblems(problems)}</div><div class="cfg-action-row"><button type="button" data-cfg-action="reset-profile"${!snapshot.dirty || snapshot.draftMode === 'create' ? ' disabled' : ''}>RESET</button><button type="button" data-cfg-action="delete-profile" class="is-danger"${canDelete ? '' : ' disabled'}>DELETE</button><button type="button" data-cfg-action="validate-profile"${!record || snapshot.dirty || busy ? ' disabled' : ''}>VALIDATE</button><button type="button" data-cfg-action="save-profile" class="is-primary"${canSave ? '' : ' disabled'}>SAVE</button></div></footer>
  </section>`;
}
