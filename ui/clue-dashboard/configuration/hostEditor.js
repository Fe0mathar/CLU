/** PowerShell/Host project binding and readiness. */

import { badge, escapeHtml, fieldShell, select, textInput } from './viewPrimitives.js';

function inheritedPath(setting) {
  if (!setting || setting.source === 'global-default') {
    return { source: 'global-default', value: '', label: `GLOBAL DEFAULT · ${setting?.defaultKey ?? 'powershell.executable'}` };
  }
  return { source: 'project-override', value: setting.value ?? '', label: 'PROJECT OVERRIDE' };
}

export function renderHostEditor(snapshot) {
  const profile = snapshot.draft;
  if (!profile) return '<section class="cfg-card" data-section="powershell-host"><header class="cfg-card-head"><div><span class="cfg-kicker">POWERSHELL / HOST</span><h3>PowerShell host settings</h3></div></header><p class="cfg-empty-copy">Create or select a Project Profile to configure its PowerShell executable, host script and authorized roots.</p></section>';
  const host = profile.integrations?.powershell;
  const executable = inheritedPath(host?.executable);
  const check = snapshot.connectionChecks?.host;
  const state = check?.state ?? (check?.ready ? 'READY' : 'UNVALIDATED');
  return `<section class="cfg-card" data-section="powershell-host">
    <header class="cfg-card-head"><div><span class="cfg-kicker">POWERSHELL / HOST</span><h3>Exact host and root authority</h3></div>${badge(state)}</header>
    <div class="cfg-override-banner"><span>${escapeHtml(executable.label)}</span><div><button type="button" data-cfg-action="use-host-global">USE GLOBAL</button><button type="button" data-cfg-action="use-host-override">SET OVERRIDE</button></div></div>
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'PowerShell Executable', wide: true, control: `<input value="${escapeHtml(executable.value || executable.label)}" readonly />` })}
      ${fieldShell({ label: 'Host Script', wide: true, control: textInput('integrations.powershell.hostScript', host?.hostScript ?? '', { placeholder: 'F:\\CLU\\CLU\\scripts\\host.ps1' }) })}
      ${fieldShell({ label: 'Project Root', wide: true, control: `<input value="${escapeHtml(host?.projectRoot ?? '')}" readonly />` })}
      ${fieldShell({ label: 'Workspace Root', wide: true, control: `<input value="${escapeHtml(host?.workspaceRoot ?? '')}" readonly />` })}
      ${fieldShell({ label: 'Shadow Root', wide: true, control: `<input value="${escapeHtml(host?.shadowRoot ?? '')}" readonly />` })}
      ${fieldShell({ label: 'Autonomous Profile', control: select('integrations.powershell.autonomousProfile', host?.autonomousProfile, ['restricted', 'maintenance', 'disabled']) })}
    </div>
    ${check ? `<p class="cfg-connection-detail">${escapeHtml(check.code ?? state)} · ${escapeHtml(check.detail ?? '')}</p>` : '<p class="cfg-note">A live test proves executable availability, handshake and exact root parity.</p>'}
    ${check?.binding ? `<details><summary>Host handshake details</summary><dl class="cfg-binding-facts"><div><dt>Executable</dt><dd>${escapeHtml(check.binding.executable)}</dd></div><div><dt>Host script</dt><dd>${escapeHtml(check.binding.scriptPath)}</dd></div><div><dt>Checked at</dt><dd>${escapeHtml(check.checkedAt ?? '')}</dd></div></dl></details>` : ''}
    <p class="cfg-note">The host exchanges structured requests and replies with CLU-E. This connection test shows the verified executable, script and root parity.</p>
    <p class="cfg-note">The managed Windows launcher opens a separate PowerShell activity window for host requests and validated replies. The window stays open for review after the test.</p>
    <footer class="cfg-card-actions"><span></span><button type="button" data-cfg-action="test-host"${!snapshot.selectedRecord || snapshot.dirty || snapshot.pending ? ' disabled' : ''}>TEST CONNECTION</button></footer>
  </section>`;
}
