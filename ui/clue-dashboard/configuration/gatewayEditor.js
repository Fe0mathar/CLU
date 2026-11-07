/** GPT/OpenAI exact-model and credential-reference editor. */

import { badge, checkbox, escapeHtml, fieldShell, textInput } from './viewPrimitives.js';

export const CREDENTIAL_REFERENCE_PATTERN = /^(?:env:[A-Z][A-Z0-9_]{0,63}|credential-store:[A-Za-z0-9][A-Za-z0-9._:/-]{0,191})$/u;

export function credentialReferenceState(credential) {
  if (!credential || credential.source === 'global-default') {
    return { source: 'global-default', label: `GLOBAL DEFAULT · ${credential?.defaultKey ?? 'gateway.credential'}`, value: '' };
  }
  return {
    source: 'project-override',
    label: 'PROJECT OVERRIDE · REFERENCE ONLY',
    value: String(credential.value ?? ''),
  };
}

export function renderGatewayEditor(snapshot) {
  const profile = snapshot.draft;
  if (!profile) return `<section class="cfg-card" data-section="gpt-gateway"><header class="cfg-card-head"><div><span class="cfg-kicker">GPT API KEY</span><h3>OpenAI credentials for a Project Profile</h3></div></header><p class="cfg-empty-copy">Select a saved Project Profile to configure its key.</p></section>`;
  const gateway = profile.integrations?.gpt;
  const credential = credentialReferenceState(gateway?.credential);
  const check = snapshot.connectionChecks?.gateway;
  const key = snapshot.dirty ? null : snapshot.connectionChecks?.openaiKey;
  const state = check?.state ?? (check?.operationallyReady ? 'READY' : 'UNVALIDATED');
  const invalidReference = credential.source === 'project-override' && !CREDENTIAL_REFERENCE_PATTERN.test(credential.value);
  const disabled = !snapshot.selectedRecord || snapshot.dirty || !['idle', 'ready'].includes(snapshot.phase);
  return `<section class="cfg-card" data-section="gpt-gateway">
    <header class="cfg-card-head"><div><span class="cfg-kicker">GPT API KEY</span><h3>OpenAI credentials for this Project Profile</h3></div>${badge(invalidReference ? 'INVALID' : state)}</header>
    <p class="cfg-card-copy">Set or replace the key in a masked Windows prompt. The browser receives the outcome only. Save any unsaved profile edits before opening the prompt.</p>
    ${snapshot.phase === 'waiting-for-windows-key-prompt' ? '<p class="cfg-connection-detail">Complete the Windows API key dialog or cancel it to return here.</p>' : ''}
    <div class="cfg-action-row"><button type="button" data-cfg-action="set-openai-key"${disabled ? ' disabled' : ''}>SET / REPLACE API KEY</button><button type="button" data-cfg-action="check-openai-key"${disabled ? ' disabled' : ''}>CHECK SAVED KEY</button></div>
    ${key ? `<p class="cfg-connection-detail">${escapeHtml(String(key.state ?? '').toUpperCase())} · ${escapeHtml(key.detail ?? '')}</p>` : ''}
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'Provider', control: '<input value="openai" readonly />' })}
      ${fieldShell({ label: 'Model ID', control: textInput('integrations.gpt.modelId', gateway?.modelId ?? '', { placeholder: 'gpt-5.6' }), note: 'Requested and effective model must match exactly.' })}
      ${fieldShell({ label: 'Fallback Policy', control: '<input value="FORBID" readonly />' })}
    </div>
    <details><summary>Advanced credential settings</summary>
      <div class="cfg-override-banner"><span>${escapeHtml(credential.label)}</span><div><button type="button" data-cfg-action="use-gateway-global">USE GLOBAL</button><button type="button" data-cfg-action="use-gateway-override">SET REFERENCE</button></div></div>
      ${fieldShell({ label: 'Credential Reference', wide: true, control: `<input value="${escapeHtml(credential.source === 'project-override' ? credential.value : credential.label)}" readonly />`, note: 'Use SET REFERENCE to manage an external credential by reference.' })}
    </details>
    <div class="cfg-check-row">${checkbox('integrations.gpt.enabled', gateway?.enabled, 'AI gateway enabled')}</div>
    ${invalidReference ? '<p class="cfg-connection-detail is-bad">Credential override must be env:NAME or credential-store:ID.</p>' : ''}
    ${check ? `<p class="cfg-connection-detail">${escapeHtml(check.code ?? state)} · requested ${escapeHtml(check.requestedModel ?? gateway?.modelId ?? '—')} · effective ${escapeHtml(check.effectiveModel ?? '—')} · ${escapeHtml(check.detail ?? '')}</p>` : '<p class="cfg-note">Testing resolves the credential outside the browser, contacts the provider, and refuses model substitution.</p>'}
    <footer class="cfg-card-actions"><span></span><button type="button" data-cfg-action="test-gateway"${disabled || invalidReference ? ' disabled' : ''}>TEST CONNECTION</button></footer>
  </section>`;
}
