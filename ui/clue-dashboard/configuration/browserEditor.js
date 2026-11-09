/** Governed Chrome/browser instance, target and evidence boundary. */

import { badge, escapeHtml, fieldShell, lineText, select, textarea, textInput } from './viewPrimitives.js';
import { recordMatchesActive } from './configurationState.js';

export function canTestChrome(snapshot) {
  return !snapshot.pending && !snapshot.dirty &&
    snapshot.legacyConfiguration?.projectProfiles?.runtimeMode !== 'legacy-v2' &&
    recordMatchesActive(snapshot.selectedRecord, snapshot.active) &&
    snapshot.selectedRecord?.profile?.integrations?.chrome?.launchMode === 'CLUE_MANAGED';
}

function executableModel(setting) {
  return setting?.source === 'project-override'
    ? { label: 'PROJECT OVERRIDE', value: setting.value ?? '' }
    : { label: `GLOBAL DEFAULT · ${setting?.defaultKey ?? 'browser.executable'}`, value: '' };
}

export function renderBrowserEditor(snapshot) {
  const profile = snapshot.draft;
  if (!profile) return '<section class="cfg-card" data-section="browser"><header class="cfg-card-head"><div><span class="cfg-kicker">CHROME / BROWSER</span><h3>Dedicated test Chrome</h3></div></header><p class="cfg-empty-copy">Create or select a Project Profile to set its Chrome window, debugging port and target URL.</p></section>';
  const browser = profile.integrations?.chrome;
  const executable = executableModel(browser?.executable);
  const stored = snapshot.legacyConfiguration?.chromeTest;
  const sessionCheck = stored && recordMatchesActive(snapshot.selectedRecord, {
    ...stored.projectIdentity, profileGeneration: stored.profileGeneration,
  }) ? stored : null;
  const check = snapshot.connectionChecks?.browser ?? sessionCheck;
  const testing = snapshot.pending?.kind === 'testing-chrome';
  const state = testing ? 'TESTING' : String(check?.state ?? 'UNVALIDATED').toUpperCase();
  const tone = state === 'FAILED' ? 'BLOCKED' : state === 'PENDING' || testing ? 'INCOMPLETE' : state;
  const readbacks = Array.isArray(check?.gpuReadbacks) ? check.gpuReadbacks.filter(Number.isFinite) : [];
  return `<section class="cfg-card" data-section="browser">
    <header class="cfg-card-head"><div><span class="cfg-kicker">CHROME / BROWSER EXECUTION & CAPTURE</span><h3>One project, one permitted browser identity</h3></div>${badge(tone, state === 'READY' ? 'PASSED' : state)}</header>
    <div class="cfg-override-banner"><span>${escapeHtml(executable.label)}</span><div><button type="button" data-cfg-action="use-browser-global">USE GLOBAL</button><button type="button" data-cfg-action="use-browser-override">SET OVERRIDE</button></div></div>
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'Chrome Executable', wide: true, control: `<input value="${escapeHtml(executable.value || executable.label)}" readonly />` })}
      ${fieldShell({ label: 'Launch Mode', control: select('integrations.chrome.launchMode', browser?.launchMode, ['CLUE_MANAGED', 'ATTACH_TO_EXISTING']) })}
      ${fieldShell({ label: 'Remote Debugging Port', control: textInput('integrations.chrome.remoteDebuggingPort', browser?.remoteDebuggingPort ?? 9222, { type: 'number', min: 1, max: 65535 }), note: 'Dedicated per project.' })}
      ${fieldShell({ label: 'Dedicated Profile Directory', wide: true, control: textInput('integrations.chrome.dedicatedProfileDirectory', browser?.dedicatedProfileDirectory ?? '') })}
      ${fieldShell({ label: 'Allowed Origins', control: textarea('integrations.chrome.allowedOrigins', lineText(browser?.allowedOrigins), { kind: 'lines', rows: 4, placeholder: 'http://127.0.0.1:8080' }) })}
      ${fieldShell({ label: 'Target URL', control: textInput('integrations.chrome.targetUrl', browser?.targetUrl ?? '', { placeholder: 'http://127.0.0.1:8080' }), note: 'Blank is allowed until a browser benchmark is configured.' })}
      ${fieldShell({ label: 'Selection Rule', wide: true, control: `<input value="${escapeHtml(browser?.targetSelectionRule ?? '')}" readonly />`, note: 'Exact Page ID → exact URL → unique allowed origin → otherwise block as ambiguous.' })}
    </div>
    ${testing ? '<p class="cfg-connection-detail" role="status">Launching dedicated Chrome and running the WebGPU canary…</p>' : check ? `<p class="cfg-connection-detail" role="status">${check.code ? `${escapeHtml(check.code)} · ` : ''}${escapeHtml(check.summary ?? check.detail ?? '')}</p>` : ''}
    ${!testing && readbacks.length ? `<p class="cfg-connection-detail">GPU readbacks · ${escapeHtml(readbacks.join(', '))}</p>` : ''}
    ${!testing && check?.executionId ? `<p class="cfg-connection-detail">Evidence ID · ${escapeHtml(check.executionId)}</p>` : ''}
    <p class="cfg-note">Test Chrome opens the dedicated window and runs the WebGPU canary using the active saved CLU-E Managed profile. The bulb shows the test result for this dashboard session.</p>
    <footer class="cfg-card-actions"><div class="cfg-action-row"><button type="button" data-cfg-action="test-chrome"${canTestChrome(snapshot) ? '' : ' disabled'}>TEST CHROME</button></div></footer>
  </section>`;
}
