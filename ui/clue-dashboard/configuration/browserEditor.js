/** Governed Chrome/browser instance, target and evidence boundary. */

import { badge, escapeHtml, fieldShell, lineText, select, textarea, textInput } from './viewPrimitives.js';

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
  const check = snapshot.connectionChecks?.browser;
  const state = check?.state ?? (check?.ready ? 'READY' : 'UNVALIDATED');
  const disabled = !snapshot.selectedRecord || snapshot.dirty || Boolean(snapshot.pending);
  return `<section class="cfg-card" data-section="browser">
    <header class="cfg-card-head"><div><span class="cfg-kicker">CHROME / BROWSER EXECUTION & CAPTURE</span><h3>One project, one permitted browser identity</h3></div>${badge(state)}</header>
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
    ${check ? `<p class="cfg-connection-detail">${escapeHtml(check.code ?? state)} · ${escapeHtml(check.detail ?? '')}</p>` : '<p class="cfg-note">The browser test never targets an arbitrary ordinary Chrome window. Multiple matching tabs produce TARGET_AMBIGUOUS.</p>'}
    ${check?.resolvedTarget ? `<p class="cfg-connection-detail">Verified page · ${escapeHtml(check.resolvedTarget.targetUrl)} · ${escapeHtml(check.debugEndpoint ?? '')}</p>` : ''}
    <p class="cfg-note">Open a dedicated visible Chrome window in CLU-E Managed mode. Press F12 in that window to observe the connection test in DevTools Console.</p>
    <footer class="cfg-card-actions"><div class="cfg-action-row"><button type="button" data-cfg-action="open-test-chrome"${disabled || browser?.launchMode !== 'CLUE_MANAGED' || !browser?.targetUrl ? ' disabled' : ''}>OPEN TEST CHROME</button><button type="button" data-cfg-action="test-browser"${disabled ? ' disabled' : ''}>TEST CONNECTION</button></div></footer>
  </section>`;
}
