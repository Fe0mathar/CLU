/** PowerShell/Host project binding and readiness. */

import {
  badge,
  escapeHtml,
  fieldGroup,
  fieldMeta,
  fieldShell,
  inheritedPathControl,
  sectionHeader,
  select,
  textInput,
  timeText,
} from './viewPrimitives.js';
import { recordMatchesActive } from './configurationState.js';

export function canTestConsole(snapshot) {
  return !snapshot.pending && !snapshot.dirty &&
    snapshot.legacyConfiguration?.projectProfiles?.runtimeMode === 'project-profile' &&
    recordMatchesActive(snapshot.selectedRecord, snapshot.active) &&
    snapshot.selectedRecord?.profile?.integrations?.powershell?.autonomousProfile !== 'disabled';
}

/** Why TEST CONSOLE is unavailable, in the operator's terms. Empty when it can run. */
export function consoleTestBlocker(snapshot) {
  if (canTestConsole(snapshot)) return '';
  if (snapshot.pending) return 'Another operation is running.';
  if (snapshot.dirty) return 'Save or discard your changes first — the test runs against the saved profile.';
  if (snapshot.legacyConfiguration?.projectProfiles?.runtimeMode === 'legacy-v2') return 'Open the dashboard with the active Project Profile to test its console.';
  if (snapshot.selectedRecord?.profile?.integrations?.powershell?.autonomousProfile === 'disabled') return 'Enable the PowerShell host in the Project Profile to test its console.';
  if (!recordMatchesActive(snapshot.selectedRecord, snapshot.active)) return 'The test runs for the running profile generation only. Activate this profile, or restart the dashboard if you just saved it.';
  return 'The dashboard has not reported its runtime mode yet.';
}

/** The most relevant console test evidence for the selected saved generation, or null. */
export function hostCheckOf(snapshot) {
  const stored = snapshot.legacyConfiguration?.consoleTest;
  const sessionCheck = stored && recordMatchesActive(snapshot.selectedRecord, {
    ...stored.projectIdentity, profileGeneration: stored.profileGeneration,
  }) ? stored : null;
  const check = snapshot.connectionChecks?.host ?? sessionCheck;
  const testing = snapshot.pending?.kind === 'testing-console';
  const state = testing ? 'TESTING' : String(check?.state ?? 'UNVALIDATED').toUpperCase();
  return { check, testing, state };
}

export function renderHostEditor(snapshot) {
  const profile = snapshot.draft;
  if (!profile) return `<section class="cfg-card" data-section="powershell-host">${sectionHeader({ kicker: 'POWERSHELL / HOST', title: 'PowerShell host settings' })}<p class="cfg-empty-copy">Create or select a Project Profile to configure its PowerShell executable, host script and authorized roots.</p></section>`;
  const host = profile.integrations?.powershell;
  const { check, testing, state } = hostCheckOf(snapshot);
  const tone = state === 'FAILED' ? 'BLOCKED' : state === 'PENDING' || testing ? 'INCOMPLETE' : state;
  const checks = Array.isArray(check?.checks) ? check.checks : [];
  const blocker = consoleTestBlocker(snapshot);
  const field = (path, spec) => fieldShell({ ...spec, ...fieldMeta(snapshot, path) });
  return `<section class="cfg-card" data-section="powershell-host">
    ${sectionHeader({
      kicker: 'CONSOLE HOST · POWERSHELL',
      title: 'The host that runs commands for this profile',
      description: 'CLU-E never runs a shell command directly. Every file, process and Git operation goes through one restricted PowerShell host script, which only accepts work inside the three folders below.',
      badges: badge(tone, state === 'READY' ? 'PASSED' : state === 'UNVALIDATED' ? 'NOT TESTED' : state),
    })}
    ${fieldGroup({
      title: 'Executable and script',
      body: `<div class="cfg-form-grid">
        ${field('integrations.powershell.executable', { label: 'PowerShell Executable', wide: true, control: inheritedPathControl({ setting: host?.executable, path: 'integrations.powershell.executable', defaultKey: 'powershell.executable', globalAction: 'use-host-global', overrideAction: 'use-host-override', name: 'PowerShell executable', placeholder: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }), note: 'Use the installation default unless this target needs a specific PowerShell build.' })}
        ${field('integrations.powershell.hostScript', { label: 'Host Script', wide: true, required: true, control: textInput('integrations.powershell.hostScript', host?.hostScript ?? '', { placeholder: 'F:\\CLU\\CLU\\scripts\\clue-host.ps1' }), note: 'Absolute path of the restricted host script shipped with CLU-E.' })}
        ${field('integrations.powershell.autonomousProfile', { label: 'Autonomous Profile', control: select('integrations.powershell.autonomousProfile', host?.autonomousProfile, ['restricted', 'maintenance', 'disabled']), note: 'restricted: normal governed work. maintenance: wider set for repairs. disabled: the host is off for this profile.' })}
      </div>`,
    })}
    ${fieldGroup({
      title: 'Authorized folders',
      description: 'Read-only. The host refuses any path outside these.',
      body: `<div class="cfg-form-grid">
        ${fieldShell({ label: 'Project Root', wide: true, control: `<input value="${escapeHtml(host?.projectRoot ?? '')}" readonly />` })}
        ${fieldShell({ label: 'Workspace Root', wide: true, control: `<input value="${escapeHtml(host?.workspaceRoot ?? '')}" readonly />` })}
        ${fieldShell({ label: 'Shadow Root', wide: true, control: `<input value="${escapeHtml(host?.shadowRoot ?? '')}" readonly />` })}
      </div>`,
    })}
    <div class="cfg-group cfg-test-block">
      <div class="cfg-group-head"><h4>Test</h4><p>Runs one round trip through the host for the running profile and shows the result for this dashboard session.</p></div>
      ${testing ? '<p class="cfg-connection-detail" role="status">Running the PowerShell host test…</p>' : check ? `<p class="cfg-connection-detail${state === 'FAILED' ? ' is-bad' : ''}" role="status">${escapeHtml(check.summary ?? '')}</p>` : ''}
      ${!testing && checks.length ? `<details data-cfg-details="console-test"><summary>Console test details</summary>${check.testedAt ? `<p>Tested at ${timeText(check.testedAt) || escapeHtml(check.testedAt)}</p>` : ''}<ul>${checks.map(({ label, state: itemState, detail }) => `<li>${escapeHtml([label, itemState, detail].filter(Boolean).join(' · '))}</li>`).join('')}</ul></details>` : ''}
      ${blocker === '' ? '' : `<p class="cfg-note">${escapeHtml(blocker)}</p>`}
      <footer class="cfg-card-actions"><span></span><button type="button" data-cfg-action="test-console"${canTestConsole(snapshot) ? '' : ' disabled'}>TEST CONSOLE</button></footer>
    </div>
  </section>`;
}
