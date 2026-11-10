/** Git integration editor. Synchronisation remains an explicit operator action. */

import {
  badge,
  escapeHtml,
  fieldGroup,
  fieldMeta,
  fieldShell,
  isBusy,
  renderReadinessReceipt,
  sectionHeader,
  select,
  stateLine,
  textInput,
} from './viewPrimitives.js';
import { renderStartupBindingLink } from './projectSelector.js';

function connectionDetail(check) {
  if (!check || (check.state === undefined && !check.detail)) return '';
  return `<p class="cfg-connection-detail">${escapeHtml(check.state)} · ${escapeHtml(check.detail ?? '')}</p>`;
}

/** The Git state an operator should read first for the selected profile. */
export function gitStateOf(snapshot) {
  const git = snapshot.draft?.integrations?.git;
  const check = snapshot.connectionChecks?.git ?? snapshot.validation?.git ?? null;
  const connection = snapshot.dirty ? null : snapshot.connectionChecks?.githubConnection;
  return connection?.state ?? check?.state ?? git?.publicationMode ?? 'UNVALIDATED';
}

function step(number, title, body, done = false) {
  return `<li class="cfg-step${done ? ' is-done' : ''}"><span class="cfg-step-index" aria-hidden="true">${done ? '✓' : number}</span><div class="cfg-step-body"><strong>${escapeHtml(title)}</strong>${body}</div></li>`;
}

export function renderGitEditor(snapshot) {
  const profile = snapshot.draft;
  const startup = renderStartupBindingLink(snapshot);
  const legacyGit = snapshot.legacyConnections?.git;
  const remote = snapshot.legacyConfiguration?.project?.publication?.remote;
  const legacy = snapshot.legacyConfiguration?.legacyConnectionControls === true ? `<div class="cfg-legacy-connection">
    <p class="cfg-card-copy">Sign in through GitHub CLI on the Windows host. Reopen the dashboard to validate authentication and access to the registered remote.</p>
    <button type="button" data-cfg-action="sign-in-legacy-github"${snapshot.legacyConnections?.busy ? ' disabled' : ''}>SIGN IN TO GITHUB FOR LEGACY TARGET</button>
    <p class="cfg-note">${remote ? 'A remote is registered for the active legacy target.' : 'The active target is local-only. See CONFIG-EDIT.md for the target profile’s remote setting.'}</p>
    ${legacyGit ? `<p class="cfg-connection-detail" role="status">${escapeHtml(legacyGit.detail)}</p>` : ''}
    ${renderReadinessReceipt(snapshot, 'git', true)}
  </div>` : '';
  if (!profile) return `<section class="cfg-card" data-section="git">${sectionHeader({ kicker: 'GIT SYNC', title: 'GitHub connection' })}${startup}${legacy || '<p class="cfg-empty-copy">Select a saved Project Profile to connect its checkout.</p>'}</section>`;
  const git = profile.integrations?.git;
  const check = snapshot.connectionChecks?.git ?? snapshot.validation?.git ?? null;
  const directory = snapshot.connectionChecks?.githubDirectory;
  const connection = snapshot.dirty ? null : snapshot.connectionChecks?.githubConnection;
  const repositories = Array.isArray(directory?.repositories) ? directory.repositories : [];
  const attemptedRepository = connection?.repository?.nameWithOwner;
  const attemptedBranch = connection?.branch ?? '';
  const state = gitStateOf(snapshot);
  const disabled = !snapshot.selectedRecord || snapshot.dirty || isBusy(snapshot);
  const account = connection?.account ?? directory?.account;
  const field = (path, spec) => fieldShell({ ...spec, ...fieldMeta(snapshot, path) });
  const blocked = !snapshot.selectedRecord
    ? 'Save the new profile before connecting it.'
    : snapshot.dirty
      ? 'Save or discard your changes first — connecting works on the saved profile.'
      : '';

  return `<section class="cfg-card" data-section="git">
    ${sectionHeader({
      kicker: 'GIT SYNC · GITHUB',
      title: 'The checkout, and where it publishes',
      description: 'CLU-E works on the local checkout in the Target Root. A GitHub repository is optional: without one the profile is local-only, which is enough for recognition, proof and the Great Book. Synchronising is always a separate, explicit action.',
      badges: badge(state === 'CONNECTED' ? 'READY' : state, state),
    })}
    ${startup}${legacy}${renderReadinessReceipt(snapshot, 'git')}
    ${stateLine(state)}
    ${fieldGroup({
      title: 'Registered now',
      description: 'Read-only. What the saved profile currently points at.',
      body: `<div class="cfg-form-grid">
        ${fieldShell({ label: 'Local checkout path', wide: true, control: `<input value="${escapeHtml(git?.repositoryRoot ?? profile.targetRoot)}" readonly />`, note: 'The selected repository must match this existing checkout.' })}
        ${fieldShell({ label: 'Registered remote', wide: true, control: `<input value="${escapeHtml(git?.remote ?? '')}" placeholder="none — local only" readonly />` })}
        ${fieldShell({ label: 'Registered branch', control: `<input value="${escapeHtml(git?.defaultBranch ?? '')}" readonly />` })}
      </div>`,
    })}
    <div class="cfg-group">
      <div class="cfg-group-head"><h4>Connect to GitHub</h4><p>Three steps. Connecting saves the repository and branch into this profile; it does not push or pull anything.</p></div>
      ${blocked === '' ? '' : `<p class="cfg-note">${escapeHtml(blocked)}</p>`}
      ${account ? `<p class="cfg-connection-detail">GitHub account · ${escapeHtml(account)}</p>` : ''}
      ${connectionDetail(directory)}
      ${connectionDetail(connection)}
      <ol class="cfg-steps">
        ${step(1, 'Sign in', `<p>Opens GitHub CLI sign-in on the Windows host. Complete it there.</p><div class="cfg-action-row is-start"><button type="button" data-cfg-action="sign-in-github"${disabled ? ' disabled' : ''}>SIGN IN TO GITHUB</button></div>`, Boolean(account))}
        ${step(2, 'List repositories', `<p>Loads the repositories this account can reach.</p><div class="cfg-action-row is-start"><button type="button" data-cfg-action="list-github-repositories"${disabled ? ' disabled' : ''}>LIST REPOSITORIES</button></div>`, repositories.length > 0)}
        ${step(3, 'Choose and connect', repositories.length > 0 ? `<div class="cfg-form-grid">
      ${fieldShell({ label: 'GitHub repository', wide: true, control: `<select id="cfgGitHubRepository"${disabled ? ' disabled' : ''} data-cfg-transient><option value="">Select a repository</option>${repositories.map((entry) => `<option value="${escapeHtml(entry.nameWithOwner)}" data-default-branch="${escapeHtml(entry.defaultBranch ?? '')}"${entry.nameWithOwner === attemptedRepository ? ' selected' : ''}>${escapeHtml(entry.nameWithOwner)}${entry.private ? ' · private' : ''}</option>`).join('')}</select>` })}
      ${fieldShell({ label: 'Branch to connect', control: `<input id="cfgGitHubBranch" value="${escapeHtml(attemptedBranch)}" placeholder="Select a repository first"${disabled ? ' disabled' : ''} data-cfg-transient />`, note: 'The branch checked out in the Target Root.' })}
    </div>
    <div class="cfg-action-row is-start"><button type="button" class="is-primary" data-cfg-action="connect-github"${disabled ? ' disabled' : ''}>TEST &amp; CONNECT REPOSITORY</button></div>` : '<p>Available after the repositories are listed.</p>', state === 'CONNECTED')}
      </ol>
    </div>
    <details data-cfg-details="git-advanced"><summary>Advanced Git settings</summary>
      <p class="cfg-note">Edit these by hand only when the three steps above do not fit, for example a non-GitHub provider.</p>
      <div class="cfg-form-grid">
      ${field('integrations.git.publicationMode', { label: 'Publication Mode', control: select('integrations.git.publicationMode', git?.publicationMode, ['NO_REMOTE_YET', 'LOCAL_ONLY', 'REMOTE_REGISTERED']), note: 'NO_REMOTE_YET: none decided. LOCAL_ONLY: deliberately local. REMOTE_REGISTERED: publishes to the remote below.' })}
      ${field('integrations.git.provider', { label: 'Provider', control: select('integrations.git.provider', git?.provider ?? '', [{ value: '', label: 'NONE' }, 'github', 'gitlab', 'azure-devops', 'other'], { kind: 'nullable' }) })}
      ${field('integrations.git.remote', { label: 'Remote', wide: true, control: textInput('integrations.git.remote', git?.remote ?? '', { placeholder: 'origin URL or registered remote identity' }), note: 'Must remain blank when publication mode is NO_REMOTE_YET.' })}
      ${field('integrations.git.defaultBranch', { label: 'Default Branch', required: true, control: textInput('integrations.git.defaultBranch', git?.defaultBranch ?? 'main') })}
      ${field('integrations.git.currentBasePin', { label: 'Current Base Pin', control: textInput('integrations.git.currentBasePin', git?.currentBasePin ?? '', { placeholder: '40/64 lowercase hex' }), note: 'Optional commit the profile is pinned to.' })}
      ${field('integrations.git.protectedLandingPolicy', { label: 'Protected / Landing Policy', wide: true, control: textInput('integrations.git.protectedLandingPolicy', git?.protectedLandingPolicy ?? '', { placeholder: 'optional absolute policy path' }) })}
    </div></details>
    <div class="cfg-group cfg-test-block">
      <div class="cfg-group-head"><h4>Check</h4><p>Confirms the Target Root is a usable Git checkout and reports its publication posture. Nothing is fetched or pushed.</p></div>
      ${check ? `<p class="cfg-connection-detail">${escapeHtml(check.code ?? state)} · ${escapeHtml(check.detail ?? '')}</p>` : '<p class="cfg-note">NO_REMOTE_YET is legitimate for local recognition, proof and Great Book work.</p>'}
      <footer class="cfg-card-actions"><span></span><button type="button" data-cfg-action="test-git"${disabled ? ' disabled' : ''}>VALIDATE LOCAL CHECKOUT</button></footer>
    </div>
  </section>`;
}
