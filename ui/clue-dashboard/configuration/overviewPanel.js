/**
 * Overview of the profile being edited: its health at a glance, the single next step, and the
 * lifecycle actions (validate, activate, delete). Also the installation-health page.
 *
 * Everything here is a reading of facts already in the snapshot. The "next step" is advice about
 * which control to use; it performs nothing and decides nothing.
 */

import { configurationRows, renderConfigurationRows } from './installationRows.js';
import { sectionStatus } from './navigation.js';
import { sectionById } from './sectionRegistry.js';
import { badge, escapeHtml, fieldGroup, isBusy, sectionHeader, shortIdentity, stateLine, timeText } from './viewPrimitives.js';

const CHECKLIST = Object.freeze([
  'project', 'project-authority', 'recognition', 'benchmark-runtime',
  'powershell-host', 'git', 'browser', 'gpt-gateway', 'project-readiness',
]);

function errorsOf(snapshot) {
  return (Array.isArray(snapshot.issues) ? snapshot.issues : []).filter((issue) => issue.severity === 'error');
}

/**
 * The one thing an operator should do next for this profile.
 *
 * @returns {{tone:string, title:string, text:string, action:null|{action:string, label:string, target?:string, path?:string}}}
 */
export function nextStep(snapshot) {
  const record = snapshot.selectedRecord ?? null;
  const active = snapshot.active ?? null;
  const errors = errorsOf(snapshot);
  if (snapshot.draftMode === 'prepare') {
    return { tone: 'local', title: 'Enter the folders for the new profile', text: 'Fill in the ID and three folders, then resolve them.', action: { action: 'go-section', label: 'OPEN PROJECT & PATHS', target: 'project' } };
  }
  if (!snapshot.draft) {
    const none = !Array.isArray(snapshot.projects) || snapshot.projects.length === 0;
    return none
      ? { tone: 'local', title: 'Create your first profile', text: 'A profile tells CLU-E which program to work on and where to keep its evidence.', action: { action: 'new-project', label: 'NEW PROFILE' } }
      : { tone: 'neutral', title: 'Choose a profile', text: 'Pick a profile in the bar above to see and edit it.', action: null };
  }
  if (errors.length > 0) {
    const first = errors[0];
    const where = sectionById(first.section)?.label ?? first.section;
    return { tone: 'bad', title: `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} before saving`, text: `${where}: ${first.message}`, action: { action: 'go-issue', label: `OPEN ${where.toUpperCase()}`, target: first.section, path: first.path } };
  }
  if (snapshot.draftMode === 'create') {
    return { tone: 'local', title: 'Create the profile', text: 'The draft is complete enough to save. Review the sections, then create it.', action: { action: 'save-profile', label: 'CREATE PROFILE' } };
  }
  if (snapshot.dirty) {
    return { tone: 'warn', title: 'Save your changes', text: 'Validation, activation and connection tests work on the saved profile, so they wait for a save.', action: { action: 'save-profile', label: 'SAVE CHANGES' } };
  }
  const validation = snapshot.validation ?? null;
  if (!validation) {
    return { tone: 'neutral', title: 'Validate the saved profile', text: 'Checks the saved generation against the files on disk: documents, recognition scope, benchmark runtime and Git.', action: { action: 'validate-profile', label: 'VALIDATE' } };
  }
  if (validation.valid !== true) {
    return { tone: 'bad', title: 'Validation found problems', text: 'See the validation result below, fix what it names, save, and validate again.', action: null };
  }
  if (!active || active.projectId !== record?.profile?.projectId) {
    return { tone: 'local', title: 'Activate this profile', text: active ? `CLU-E is running ${active.projectId}. Activating switches it to this profile.` : 'Nothing is running. Activating starts CLU-E on this profile.', action: { action: 'activate-project', label: 'ACTIVATE…' } };
  }
  if (active.profileGeneration !== record.generation || active.projectProfileHash !== record.projectProfileHash) {
    return { tone: 'warn', title: 'Restart the dashboard to load this generation', text: `Generation ${record.generation} is saved; CLU-E is still running generation ${active.profileGeneration}. Close the dashboard and open CLUE-Dashboard.bat again.`, action: null };
  }
  return { tone: 'good', title: 'This profile is running', text: 'Test its connections, or assess readiness for the work you intend.', action: { action: 'go-section', label: 'ASSESS READINESS', target: 'project-readiness' } };
}

function renderNextStep(snapshot) {
  const step = nextStep(snapshot);
  const disabled = isBusy(snapshot) ? ' disabled' : '';
  const button = step.action === null ? '' : `<button type="button" class="is-primary" data-cfg-action="${step.action.action}"${step.action.target ? ` data-section-target="${escapeHtml(step.action.target)}"` : ''}${step.action.path ? ` data-issue-path="${escapeHtml(step.action.path)}"` : ''}${disabled}>${escapeHtml(step.action.label)}</button>`;
  return `<div class="cfg-next is-${step.tone}"><div><span class="cfg-kicker">NEXT STEP</span><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.text)}</p></div>${button}</div>`;
}

function checklistItem(id, snapshot) {
  const entry = sectionById(id);
  if (!entry) return '';
  const errors = errorsOf(snapshot).filter((issue) => issue.section === id).length;
  const warnings = (Array.isArray(snapshot.issues) ? snapshot.issues : []).filter((issue) => issue.section === id && issue.severity === 'warning');
  const changed = Array.isArray(snapshot.changedSections) && snapshot.changedSections.includes(id);
  const status = errors > 0 ? { tone: 'bad', text: `${errors} to fix` } : sectionStatus(id, snapshot);
  return `<li><button type="button" class="cfg-check-item" data-section-target="${id}" data-cfg-action="go-section">
    <span class="cfg-nav-dot is-${status.tone}" aria-hidden="true"></span>
    <span class="cfg-check-text"><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(warnings[0]?.message ?? entry.summary)}</span></span>
    <span class="cfg-check-state">${changed ? '<em>unsaved</em>' : ''}<span class="cfg-nav-status is-${status.tone}">${escapeHtml(status.text || '—')}</span></span>
  </button></li>`;
}

function renderValidation(snapshot) {
  const validation = snapshot.validation;
  if (!validation) return '<p class="cfg-empty-copy">Not validated in this session. Validation is read-only: it compares the saved profile with the files on disk and changes nothing.</p>';
  const problems = Array.isArray(validation.problems) ? validation.problems : [];
  const issues = Array.isArray(validation.authority?.issues) ? validation.authority.issues : [];
  const checkedAt = timeText(validation.checkedAt);
  return `<div class="cfg-readiness-summary">
      <div><span>Result</span>${badge(validation.state ?? (validation.valid ? 'VALID' : 'INVALID'))}</div>
      <div><span>Governing documents</span>${badge(validation.authority?.state ?? 'UNVALIDATED')}</div>
      <div><span>Document conflicts</span>${badge(validation.authorityConflicts?.state ?? 'UNVALIDATED')}</div>
      <div><span>Code recognition</span>${badge(validation.recognitionError ? 'INVALID' : validation.recognition ? 'VALID' : 'UNVALIDATED')}</div>
      <div><span>Benchmark runtime</span>${badge(validation.benchmarkRuntime?.state ?? 'UNVALIDATED')}</div>
      <div><span>Git</span>${badge(validation.git?.state ?? 'UNVALIDATED')}</div>
    </div>
    ${stateLine(validation.state)}
    ${problems.length ? `<div class="cfg-blockers" role="alert"><strong>PROBLEMS</strong><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul></div>` : ''}
    ${issues.length ? `<ul class="cfg-inline-list">${issues.map((issue) => `<li>${escapeHtml([issue.code, issue.bindingId, issue.detail].filter(Boolean).join(' · '))}</li>`).join('')}</ul>` : ''}
    ${validation.recognitionError ? `<p class="cfg-connection-detail is-bad">${escapeHtml(validation.recognitionError.code ?? '')} · ${escapeHtml(validation.recognitionError.detail ?? '')}</p>` : ''}
    ${checkedAt ? `<p class="cfg-note">Validated ${checkedAt} · generation ${escapeHtml(validation.generation ?? '—')}</p>` : ''}`;
}

export function renderOverview(snapshot) {
  const profile = snapshot.draft;
  const record = snapshot.selectedRecord ?? null;
  if (!profile) {
    return `<section class="cfg-card" data-section="overview">
      ${sectionHeader({ kicker: 'OVERVIEW', title: 'No profile open', description: 'A profile is one complete description of a target program: its folders, the documents that govern it, and the connections CLU-E may use for it.' })}
      ${renderNextStep(snapshot)}
    </section>`;
  }
  const busy = isBusy(snapshot);
  const active = snapshot.active ?? null;
  const running = Boolean(active && active.projectId === profile.projectId);
  const sameGeneration = running && record && active.profileGeneration === record.generation && active.projectProfileHash === record.projectProfileHash;
  const stateBadges = [
    snapshot.draftMode === 'create' ? badge('UNVALIDATED', 'NEW · NOT SAVED') : snapshot.dirty ? badge('DRIFTED', 'UNSAVED CHANGES') : badge('VALID', `SAVED · G${record?.generation ?? '?'}`),
    running ? badge(sameGeneration ? 'READY' : 'INCOMPLETE', sameGeneration ? 'RUNNING' : `RUNNING G${active.profileGeneration}`) : badge('NOT_REQUIRED', 'NOT RUNNING'),
  ].join('');
  const canValidate = Boolean(record) && !snapshot.dirty && !busy;
  const canActivate = Boolean(record) && !snapshot.dirty && !busy && !running;
  const canDelete = Boolean(record) && !running && !busy;
  const activateReason = !record ? 'Save the profile first.' : snapshot.dirty ? 'Save or discard your changes first.' : running ? 'This profile is already the running target.' : '';
  const deleteReason = !record ? 'Nothing is saved yet.' : running ? 'The running profile cannot be deleted. Activate another profile first.' : '';

  return `<section class="cfg-card" data-section="overview">
    ${sectionHeader({
      kicker: 'OVERVIEW',
      title: profile.displayName || profile.projectId,
      description: `Profile ${profile.projectId} · target ${profile.targetRoot}`,
      badges: stateBadges,
    })}
    ${renderNextStep(snapshot)}
    ${fieldGroup({
      title: 'Sections',
      description: 'Each line opens the section. The dot shows the state of what it configures.',
      body: `<ul class="cfg-checklist">${CHECKLIST.map((id) => checklistItem(id, snapshot)).join('')}</ul>`,
    })}
    ${fieldGroup({
      title: 'Validation',
      description: 'Confirms the saved profile still matches reality. Required before activation.',
      body: `${renderValidation(snapshot)}<div class="cfg-action-row is-start"><button type="button" data-cfg-action="validate-profile"${canValidate ? '' : ' disabled'}>${snapshot.validation ? 'VALIDATE AGAIN' : 'VALIDATE'}</button></div>`,
    })}
    ${fieldGroup({
      title: 'Lifecycle',
      body: `<div class="cfg-lifecycle">
        <div><strong>Activate</strong><p>Makes this profile the one CLU-E runs. The dashboard clears and reloads from this profile’s own evidence.${activateReason === '' ? '' : ` <em>${escapeHtml(activateReason)}</em>`}</p><button type="button" data-cfg-action="activate-project"${canActivate ? '' : ' disabled'}>ACTIVATE…</button></div>
        <div><strong>Delete</strong><p>Removes CLU-E’s registration of this profile only. The target repository and the workspace folders are not deleted.${deleteReason === '' ? '' : ` <em>${escapeHtml(deleteReason)}</em>`}</p><button type="button" class="is-danger" data-cfg-action="delete-profile"${canDelete ? '' : ' disabled'}>DELETE…</button></div>
      </div>`,
    })}
    <details class="cfg-technical" data-cfg-details="overview-identity"><summary>Technical identity</summary>
      <div class="cfg-identity-strip">
        <span><b>Generation</b>${record?.generation ?? 'draft'}</span>
        <span title="${escapeHtml(record?.projectProfileHash ?? '')}"><b>Profile hash</b>${escapeHtml(shortIdentity(record?.projectProfileHash, 24))}</span>
        <span title="${escapeHtml(profile.targetRootIdentity ?? '')}"><b>Target identity</b>${escapeHtml(shortIdentity(profile.targetRootIdentity, 24))}</span>
      </div>
      ${record?.updatedAt ? `<p class="cfg-note">Last saved ${timeText(record.updatedAt)}</p>` : ''}
    </details>
  </section>`;
}

function fact(label, value) {
  return `<div class="row"><span>${escapeHtml(label)}</span><span class="mono">${escapeHtml(value)}</span></div>`;
}

export function renderInstallationHealth(snapshot) {
  const configuration = snapshot.legacyConfiguration ?? null;
  const profiles = configuration?.projectProfiles ?? null;
  const gateway = configuration?.gatewayControl ?? null;
  const mode = profiles?.runtimeMode ?? null;
  return `<section class="cfg-card" data-section="installation">
    ${sectionHeader({
      kicker: 'INSTALLATION HEALTH',
      title: 'What the running dashboard reports',
      description: 'Read-only facts from the dashboard process itself. Nothing here is editable; each line is either a value, a pass/fail check, or an absence with its reason.',
      badges: configuration === null ? badge('UNVALIDATED', 'NOT LOADED') : badge(configuration.startable ? 'READY' : 'INCOMPLETE', configuration.startable ? 'STARTABLE' : 'NOT STARTABLE'),
    })}
    ${fieldGroup({
      title: 'Running target',
      body: `<div class="cfg-rows">${renderConfigurationRows(configurationRows(configuration))}</div>`,
    })}
    ${fieldGroup({
      title: 'Profiles runtime',
      body: `<div class="cfg-rows">
        ${fact('runtime mode', mode ?? 'UNKNOWN — the dashboard did not report a runtime mode')}
        ${fact('registry root', profiles?.registryRoot ?? 'UNKNOWN — not reported')}
        ${fact('registry generation', Number.isSafeInteger(snapshot.registryGeneration) ? `g${snapshot.registryGeneration}` : 'UNKNOWN — not loaded')}
        ${fact('profiles API', profiles?.apiVersion ?? 'UNKNOWN — not reported')}
      </div>`,
    })}
    ${gateway ? fieldGroup({
      title: 'AI gateway control',
      body: `<div class="cfg-rows">
        ${fact('enabled', gateway.enabled ? 'yes' : 'no')}
        ${fact('provider paused', gateway.providerPaused ? `yes — ${gateway.providerPauseReason ?? 'no reason reported'}` : 'no')}
        ${fact('provider budget exhausted', gateway.providerBudgetExhausted ? 'yes' : 'no')}
        ${gateway.startRefusal ? fact('start refusal', gateway.startRefusal) : ''}
      </div>`,
    }) : ''}
    <footer class="cfg-card-actions"><p class="cfg-note">Captured when Configuration was opened.</p><button type="button" data-cfg-action="reload-installation">REFRESH</button></footer>
  </section>`;
}
