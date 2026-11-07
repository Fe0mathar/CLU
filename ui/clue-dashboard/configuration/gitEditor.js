/** Git integration editor. Synchronisation remains an explicit operator action. */

import { badge, escapeHtml, fieldShell, select, textInput } from './viewPrimitives.js';

function connectionDetail(check) {
  if (!check) return '';
  return `<p class="cfg-connection-detail">${escapeHtml(check.state)} · ${escapeHtml(check.detail ?? '')}</p>`;
}

export function renderGitEditor(snapshot) {
  const profile = snapshot.draft;
  if (!profile) return `<section class="cfg-card" data-section="git"><header class="cfg-card-head"><div><span class="cfg-kicker">GIT SYNC</span><h3>Connect a Project Profile to GitHub</h3></div></header><p class="cfg-empty-copy">Select a saved Project Profile to connect its checkout.</p></section>`;
  const git = profile.integrations?.git;
  const check = snapshot.connectionChecks?.git ?? snapshot.validation?.git ?? null;
  const directory = snapshot.connectionChecks?.githubDirectory;
  const connection = snapshot.dirty ? null : snapshot.connectionChecks?.githubConnection;
  const repositories = Array.isArray(directory?.repositories) ? directory.repositories : [];
  const state = connection?.state ?? check?.state ?? git?.publicationMode ?? 'UNVALIDATED';
  const disabled = !snapshot.selectedRecord || snapshot.dirty || !['idle', 'ready'].includes(snapshot.phase);
  const account = connection?.account ?? directory?.account;
  return `<section class="cfg-card" data-section="git">
    <header class="cfg-card-head"><div><span class="cfg-kicker">GIT SYNC</span><h3>Connect this Project Profile to GitHub</h3></div>${badge(state === 'CONNECTED' ? 'READY' : state, state)}</header>
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'Local checkout path', wide: true, control: `<input value="${escapeHtml(git?.repositoryRoot ?? profile.targetRoot)}" readonly />`, note: 'The selected repository must match this existing checkout.' })}
      ${fieldShell({ label: 'Registered remote', wide: true, control: `<input value="${escapeHtml(git?.remote ?? '')}" readonly />` })}
      ${fieldShell({ label: 'Registered branch', control: `<input value="${escapeHtml(git?.defaultBranch ?? '')}" readonly />` })}
    </div>
    ${account ? `<p class="cfg-connection-detail">GitHub account · ${escapeHtml(account)}</p>` : ''}
    ${connectionDetail(directory)}
    ${connectionDetail(connection)}
    <div class="cfg-action-row">
      <button type="button" data-cfg-action="sign-in-github"${disabled ? ' disabled' : ''}>SIGN IN TO GITHUB</button>
      <button type="button" data-cfg-action="list-github-repositories"${disabled ? ' disabled' : ''}>LIST REPOSITORIES</button>
    </div>
    ${repositories.length > 0 ? `<div class="cfg-form-grid">
      ${fieldShell({ label: 'GitHub repository', wide: true, control: `<select id="cfgGitHubRepository"${disabled ? ' disabled' : ''}><option value="">Select a repository</option>${repositories.map((entry) => `<option value="${escapeHtml(entry.nameWithOwner)}" data-default-branch="${escapeHtml(entry.defaultBranch ?? '')}">${escapeHtml(entry.nameWithOwner)}${entry.private ? ' · private' : ''}</option>`).join('')}</select>` })}
      ${fieldShell({ label: 'Branch to connect', control: `<input id="cfgGitHubBranch" placeholder="Select a repository first"${disabled ? ' disabled' : ''} />` })}
    </div>
    <div class="cfg-action-row"><button type="button" data-cfg-action="connect-github"${disabled ? ' disabled' : ''}>TEST &amp; CONNECT REPOSITORY</button></div>` : ''}
    <p class="cfg-note">Complete sign-in on the Windows host, then list repositories. Connecting verifies access and saves the profile. Use the separate Sync Git action to synchronize the active checkout.</p>
    <details><summary>Advanced Git settings</summary><div class="cfg-form-grid">
      ${fieldShell({ label: 'Publication Mode', control: select('integrations.git.publicationMode', git?.publicationMode, ['NO_REMOTE_YET', 'LOCAL_ONLY', 'REMOTE_REGISTERED']) })}
      ${fieldShell({ label: 'Provider', control: select('integrations.git.provider', git?.provider ?? '', [{ value: '', label: 'NONE' }, 'github', 'gitlab', 'azure-devops', 'other'], { kind: 'nullable' }) })}
      ${fieldShell({ label: 'Remote', wide: true, control: textInput('integrations.git.remote', git?.remote ?? '', { placeholder: 'origin URL or registered remote identity' }), note: 'Must remain blank when publication mode is NO_REMOTE_YET.' })}
      ${fieldShell({ label: 'Default Branch', control: textInput('integrations.git.defaultBranch', git?.defaultBranch ?? 'main') })}
      ${fieldShell({ label: 'Current Base Pin', control: textInput('integrations.git.currentBasePin', git?.currentBasePin ?? '', { placeholder: '40/64 lowercase hex' }) })}
      ${fieldShell({ label: 'Protected / Landing Policy', wide: true, control: textInput('integrations.git.protectedLandingPolicy', git?.protectedLandingPolicy ?? '', { placeholder: 'optional absolute policy path' }) })}
    </div></details>
    ${check ? `<p class="cfg-connection-detail">${escapeHtml(check.code ?? state)} · ${escapeHtml(check.detail ?? '')}</p>` : '<p class="cfg-note">NO_REMOTE_YET is legitimate for local recognition, proof and Great Book work. START CLU-E never synchronizes Git.</p>'}
    <footer class="cfg-card-actions"><span></span><button type="button" data-cfg-action="test-git"${disabled ? ' disabled' : ''}>VALIDATE LOCAL CHECKOUT</button></footer>
  </section>`;
}
