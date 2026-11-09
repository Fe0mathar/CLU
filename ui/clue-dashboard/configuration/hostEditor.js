/** PowerShell/Host project binding and readiness. */

import { badge, escapeHtml, fieldShell, select, textInput } from './viewPrimitives.js';
import { recordMatchesActive } from './configurationState.js';

export function canTestConsole(snapshot) {
  return !snapshot.pending && !snapshot.dirty &&
    snapshot.legacyConfiguration?.projectProfiles?.runtimeMode === 'project-profile' &&
    recordMatchesActive(snapshot.selectedRecord, snapshot.active) &&
    snapshot.selectedRecord?.profile?.integrations?.powershell?.autonomousProfile !== 'disabled';
}

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
  const stored = snapshot.legacyConfiguration?.consoleTest;
  const sessionCheck = stored && recordMatchesActive(snapshot.selectedRecord, {
    ...stored.projectIdentity, profileGeneration: stored.profileGeneration,
  }) ? stored : null;
  const check = snapshot.connectionChecks?.host ?? sessionCheck;
  const testing = snapshot.pending?.kind === 'testing-console';
  const state = testing ? 'TESTING' : String(check?.state ?? 'UNVALIDATED').toUpperCase();
  const tone = state === 'FAILED' ? 'BLOCKED' : state === 'PENDING' || testing ? 'INCOMPLETE' : state;
  const checks = Array.isArray(check?.checks) ? check.checks : [];
  return `<section class="cfg-card" data-section="powershell-host">
    <header class="cfg-card-head"><div><span class="cfg-kicker">POWERSHELL / HOST</span><h3>Exact host and root authority</h3></div>${badge(tone, state === 'READY' ? 'PASSED' : state)}</header>
    <div class="cfg-override-banner"><span>${escapeHtml(executable.label)}</span><div><button type="button" data-cfg-action="use-host-global">USE GLOBAL</button><button type="button" data-cfg-action="use-host-override">SET OVERRIDE</button></div></div>
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'PowerShell Executable', wide: true, control: `<input value="${escapeHtml(executable.value || executable.label)}" readonly />` })}
      ${fieldShell({ label: 'Host Script', wide: true, control: textInput('integrations.powershell.hostScript', host?.hostScript ?? '', { placeholder: 'F:\\CLU\\CLU\\scripts\\host.ps1' }) })}
      ${fieldShell({ label: 'Project Root', wide: true, control: `<input value="${escapeHtml(host?.projectRoot ?? '')}" readonly />` })}
      ${fieldShell({ label: 'Workspace Root', wide: true, control: `<input value="${escapeHtml(host?.workspaceRoot ?? '')}" readonly />` })}
      ${fieldShell({ label: 'Shadow Root', wide: true, control: `<input value="${escapeHtml(host?.shadowRoot ?? '')}" readonly />` })}
      ${fieldShell({ label: 'Autonomous Profile', control: select('integrations.powershell.autonomousProfile', host?.autonomousProfile, ['restricted', 'maintenance', 'disabled']) })}
    </div>
    ${testing ? '<p class="cfg-connection-detail" role="status">Running the PowerShell host test…</p>' : check ? `<p class="cfg-connection-detail" role="status">${escapeHtml(check.summary ?? '')}</p>` : ''}
    ${!testing && checks.length ? `<details><summary>Console test details</summary>${check.testedAt ? `<p>Tested at ${escapeHtml(check.testedAt)}</p>` : ''}<ul>${checks.map(({ label, state, detail }) => `<li>${escapeHtml([label, state, detail].filter(Boolean).join(' · '))}</li>`).join('')}</ul></details>` : ''}
    <p class="cfg-note">Test Console verifies the PowerShell host for the active saved profile. CLU-E runs the test in the background and shows its result for this dashboard session.</p>
    ${snapshot.legacyConfiguration?.projectProfiles?.runtimeMode === 'legacy-v2' ? '<p class="cfg-note">Open the dashboard with the active Project Profile to test its console.</p>' : host?.autonomousProfile === 'disabled' ? '<p class="cfg-note">Enable the PowerShell host in the Project Profile to test its console.</p>' : ''}
    <footer class="cfg-card-actions"><span></span><button type="button" data-cfg-action="test-console"${canTestConsole(snapshot) ? '' : ' disabled'}>TEST CONSOLE</button></footer>
  </section>`;
}
