/** Governed Chrome/browser instance, target and evidence boundary. */

import {
  badge,
  escapeHtml,
  fieldGroup,
  fieldMeta,
  fieldShell,
  inheritedPathControl,
  lineText,
  sectionHeader,
  select,
  stateLine,
  textarea,
  textInput,
} from './viewPrimitives.js';
import { recordMatchesActive } from './configurationState.js';

export function canTestChrome(snapshot) {
  return !snapshot.pending && !snapshot.dirty &&
    snapshot.legacyConfiguration?.projectProfiles?.runtimeMode !== 'legacy-v2' &&
    recordMatchesActive(snapshot.selectedRecord, snapshot.active) &&
    snapshot.selectedRecord?.profile?.integrations?.chrome?.launchMode === 'CLUE_MANAGED';
}

/** Why TEST CHROME is unavailable, in the operator's terms. Empty when it can run. */
export function chromeTestBlocker(snapshot) {
  if (canTestChrome(snapshot)) return '';
  if (snapshot.pending) return 'Another operation is running.';
  if (snapshot.dirty) return 'Save or discard your changes first — the test runs against the saved profile.';
  if (snapshot.legacyConfiguration?.projectProfiles?.runtimeMode === 'legacy-v2') return 'Open the dashboard with the active Project Profile to test its browser.';
  if (snapshot.selectedRecord?.profile?.integrations?.chrome?.launchMode !== 'CLUE_MANAGED') return 'The scripted test needs Launch Mode CLUE_MANAGED, where CLU-E starts the browser itself.';
  if (!recordMatchesActive(snapshot.selectedRecord, snapshot.active)) return 'The test runs for the running profile generation only. Activate this profile, or restart the dashboard if you just saved it.';
  return '';
}

/** The most relevant browser test evidence for the selected saved generation, or null. */
export function browserCheckOf(snapshot) {
  const stored = snapshot.legacyConfiguration?.chromeTest;
  const sessionCheck = stored && recordMatchesActive(snapshot.selectedRecord, {
    ...stored.projectIdentity, profileGeneration: stored.profileGeneration,
  }) ? stored : null;
  const check = snapshot.connectionChecks?.browser ?? sessionCheck;
  const testing = snapshot.pending?.kind === 'testing-chrome';
  const state = testing ? 'TESTING' : String(check?.state ?? 'UNVALIDATED').toUpperCase();
  return { check, testing, state };
}

export function renderBrowserEditor(snapshot) {
  const profile = snapshot.draft;
  if (!profile) return `<section class="cfg-card" data-section="browser">${sectionHeader({ kicker: 'CHROME / BROWSER', title: 'Dedicated test Chrome' })}<p class="cfg-empty-copy">Create or select a Project Profile to set its Chrome window, debugging port and target URL.</p></section>`;
  const browser = profile.integrations?.chrome;
  const { check, testing, state } = browserCheckOf(snapshot);
  const tone = state === 'FAILED' ? 'BLOCKED' : state === 'PENDING' || testing ? 'INCOMPLETE' : state;
  const readbacks = Array.isArray(check?.gpuReadbacks) ? check.gpuReadbacks.filter(Number.isFinite) : [];
  const blocker = chromeTestBlocker(snapshot);
  const field = (path, spec) => fieldShell({ ...spec, ...fieldMeta(snapshot, path) });
  return `<section class="cfg-card" data-section="browser">
    ${sectionHeader({
      kicker: 'TEST BROWSER · CHROME EXECUTION & CAPTURE',
      title: 'One dedicated Chrome window for this profile',
      description: 'Browser benchmarks run in a Chrome that belongs to this profile alone: its own profile folder, its own debugging port, and a fixed list of pages it may touch. CLU-E never attaches to your everyday browser tabs.',
      badges: badge(tone, state === 'READY' ? 'PASSED' : state === 'UNVALIDATED' ? 'NOT TESTED' : state),
    })}
    ${testing ? '' : stateLine(check ? state : null)}
    ${fieldGroup({
      title: 'Browser',
      body: `<div class="cfg-form-grid">
        ${field('integrations.chrome.executable', { label: 'Chrome Executable', wide: true, control: inheritedPathControl({ setting: browser?.executable, path: 'integrations.chrome.executable', defaultKey: 'browser.executable', globalAction: 'use-browser-global', overrideAction: 'use-browser-override', name: 'Chrome executable', placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }), note: 'Use the installation default unless this target needs a specific Chrome build.' })}
        ${field('integrations.chrome.launchMode', { label: 'Launch Mode', control: select('integrations.chrome.launchMode', browser?.launchMode, ['CLUE_MANAGED', 'ATTACH_TO_EXISTING']), note: 'CLUE_MANAGED: CLU-E starts and stops the window. ATTACH_TO_EXISTING: you start it; the scripted test is unavailable.' })}
        ${field('integrations.chrome.remoteDebuggingPort', { label: 'Remote Debugging Port', control: textInput('integrations.chrome.remoteDebuggingPort', browser?.remoteDebuggingPort ?? 9222, { type: 'number', min: 1, max: 65535 }), note: 'Dedicated per project. Two profiles must not share a port.' })}
        ${field('integrations.chrome.dedicatedProfileDirectory', { label: 'Dedicated Profile Directory', wide: true, required: true, control: textInput('integrations.chrome.dedicatedProfileDirectory', browser?.dedicatedProfileDirectory ?? ''), note: 'Chrome’s own data folder for this profile. Keep it separate from your personal Chrome profile.' })}
      </div>`,
    })}
    ${fieldGroup({
      title: 'Pages it may use',
      body: `<div class="cfg-form-grid">
        ${field('integrations.chrome.allowedOrigins', { label: 'Allowed Origins', required: true, control: textarea('integrations.chrome.allowedOrigins', lineText(browser?.allowedOrigins), { kind: 'lines', rows: 4, placeholder: 'http://127.0.0.1:8080' }), note: 'One origin per line. A page from any other origin is refused.' })}
        ${field('integrations.chrome.targetUrl', { label: 'Target URL', control: textInput('integrations.chrome.targetUrl', browser?.targetUrl ?? '', { placeholder: 'http://127.0.0.1:8080' }), note: 'Blank is allowed until a browser benchmark is configured.' })}
        ${fieldShell({ label: 'Selection Rule', wide: true, control: `<input value="${escapeHtml(browser?.targetSelectionRule ?? '')}" readonly />`, note: 'Exact Page ID → exact URL → unique allowed origin → otherwise block as ambiguous.' })}
      </div>`,
    })}
    <div class="cfg-group cfg-test-block">
      <div class="cfg-group-head"><h4>Test</h4><p>Opens the dedicated window for the running profile and runs a small WebGPU check in it. The ribbon bulb shows the result for this dashboard session.</p></div>
      ${testing ? '<p class="cfg-connection-detail" role="status">Launching dedicated Chrome and running the WebGPU canary…</p>' : check ? `<p class="cfg-connection-detail${['FAILED', 'TARGET_AMBIGUOUS', 'ORIGIN_FORBIDDEN'].includes(state) ? ' is-bad' : ''}" role="status">${check.code ? `${escapeHtml(check.code)} · ` : ''}${escapeHtml(check.summary ?? check.detail ?? '')}</p>` : ''}
      ${!testing && readbacks.length ? `<p class="cfg-connection-detail">GPU readbacks · ${escapeHtml(readbacks.join(', '))}</p>` : ''}
      ${!testing && check?.executionId ? `<p class="cfg-connection-detail">Evidence ID · ${escapeHtml(check.executionId)}</p>` : ''}
      ${blocker === '' ? '' : `<p class="cfg-note">${escapeHtml(blocker)}</p>`}
      <footer class="cfg-card-actions"><div class="cfg-action-row"><button type="button" data-cfg-action="test-chrome"${canTestChrome(snapshot) ? '' : ' disabled'}>TEST CHROME</button></div></footer>
    </div>
  </section>`;
}
