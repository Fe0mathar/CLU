/** GPT/OpenAI exact-model and credential-reference editor. */

import { badge, checkbox, escapeHtml, fieldShell, select } from './viewPrimitives.js';

export const CREDENTIAL_REFERENCE_PATTERN = /^(?:env:[A-Z][A-Z0-9_]{0,63}|credential-store:[A-Za-z0-9][A-Za-z0-9._:/-]{0,191})$/u;

const MODEL_LIST_MESSAGES = Object.freeze({
  CREDENTIAL_MISSING: 'Set or replace this profile’s API key before loading models.',
  CREDENTIAL_STORE_UNAVAILABLE: 'The saved credential store entry is unavailable.',
  DISABLED: 'Enable the profile gateway and save it before loading models.',
  POLICY_MISMATCH: 'The saved profile’s provider policy prevents model discovery.',
  PROVIDER_UNREACHABLE: 'OpenAI could not be reached. Try again later.',
  AUTH_REFUSED: 'OpenAI refused this profile’s credential.',
  RATE_LIMITED: 'OpenAI limited the model list request. Try again later.',
  PROVIDER_REFUSED: 'OpenAI refused the model list request.',
  CATALOGUE_INVALID: 'OpenAI did not return a usable model list.',
  EMPTY: 'OpenAI returned no supported model IDs for this credential.',
});

/** A list is usable only for its saved generation and its unchanged credential settings. */
function modelCatalogueFor(snapshot) {
  const catalogue = snapshot.connectionChecks?.gatewayModels;
  const record = snapshot.selectedRecord;
  const saved = record?.profile?.integrations?.gpt;
  const draft = snapshot.draft?.integrations?.gpt;
  if (!catalogue || !saved || !draft || catalogue.projectId !== record.profile.projectId ||
      catalogue.generation !== record.generation || catalogue.projectProfileHash !== record.projectProfileHash ||
      saved.enabled !== draft.enabled || saved.provider !== draft.provider || saved.fallbackPolicy !== draft.fallbackPolicy ||
      saved.credential?.source !== draft.credential?.source ||
      saved.credential?.defaultKey !== draft.credential?.defaultKey || saved.credential?.value !== draft.credential?.value) return null;
  return catalogue;
}

export function availableGatewayModels(snapshot) {
  const catalogue = modelCatalogueFor(snapshot);
  return catalogue?.state === 'READY' ? catalogue.models : [];
}

function modelOptions(current, models, catalogueReady) {
  const options = models.map((id) => ({ value: id, label: id }));
  if (current === '') options.unshift({ value: '', label: 'Select an available model' });
  else if (!models.includes(current)) options.unshift({
    value: current,
    label: catalogueReady ? `${current} · configured, not listed` : `${current} · configured`,
  });
  return options;
}

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
  const check = snapshot.dirty ? null : snapshot.connectionChecks?.gateway;
  const key = snapshot.dirty ? null : snapshot.connectionChecks?.openaiKey;
  const state = check?.state ?? (check?.operationallyReady ? 'READY' : 'UNVALIDATED');
  const invalidReference = credential.source === 'project-override' && !CREDENTIAL_REFERENCE_PATTERN.test(credential.value);
  const disabled = !snapshot.selectedRecord || snapshot.dirty || !['idle', 'ready'].includes(snapshot.phase);
  const catalogue = modelCatalogueFor(snapshot);
  const models = availableGatewayModels(snapshot);
  const currentModel = gateway?.modelId ?? '';
  const modelSelect = select('integrations.gpt.modelId', currentModel, modelOptions(currentModel, models, catalogue?.state === 'READY'), {
    disabled: models.length === 0 || Boolean(snapshot.pending),
  });
  const modelListMessage = catalogue?.state === 'READY'
    ? `${models.length} available model ID${models.length === 1 ? '' : 's'}. Choose an exact model, then save the profile.`
    : MODEL_LIST_MESSAGES[catalogue?.state] ?? 'Load the models available to the saved profile’s credential.';
  return `<section class="cfg-card" data-section="gpt-gateway">
    <header class="cfg-card-head"><div><span class="cfg-kicker">GPT API KEY</span><h3>OpenAI credentials for this Project Profile</h3></div>${badge(invalidReference ? 'INVALID' : state)}</header>
    <p class="cfg-card-copy">Set or replace the key in a masked Windows prompt. The browser receives the outcome only. Save any unsaved profile edits before opening the prompt.</p>
    ${snapshot.phase === 'waiting-for-windows-key-prompt' ? '<p class="cfg-connection-detail">Complete the Windows API key dialog or cancel it to return here.</p>' : ''}
    <div class="cfg-action-row"><button type="button" data-cfg-action="set-openai-key"${disabled ? ' disabled' : ''}>SET / REPLACE API KEY</button><button type="button" data-cfg-action="check-openai-key"${disabled ? ' disabled' : ''}>CHECK SAVED KEY</button></div>
    ${key ? `<p class="cfg-connection-detail">${escapeHtml(String(key.state ?? '').toUpperCase())} · ${escapeHtml(key.detail ?? '')}</p>` : ''}
    <div class="cfg-form-grid">
      ${fieldShell({ label: 'Provider', control: '<input value="openai" readonly />' })}
      ${fieldShell({ label: 'Model ID', control: modelSelect, note: 'Changes are saved to this Project Profile. Activate the profile to use it in the runtime.' })}
      ${fieldShell({ label: 'Fallback Policy', control: '<input value="FORBID" readonly />' })}
    </div>
    <div class="cfg-action-row"><button type="button" data-cfg-action="load-gateway-models"${disabled || invalidReference ? ' disabled' : ''}>LOAD AVAILABLE MODELS</button></div>
    <p class="cfg-connection-detail" role="status">${escapeHtml(snapshot.phase === 'reading-gateway-models' ? 'Loading the saved profile’s model list…' : modelListMessage)}</p>
    <details><summary>Advanced credential settings</summary>
      <div class="cfg-override-banner"><span>${escapeHtml(credential.label)}</span><div><button type="button" data-cfg-action="use-gateway-global">USE GLOBAL</button><button type="button" data-cfg-action="use-gateway-override">SET REFERENCE</button></div></div>
      ${fieldShell({ label: 'Credential Reference', wide: true, control: `<input value="${escapeHtml(credential.source === 'project-override' ? credential.value : credential.label)}" readonly />`, note: 'Use SET REFERENCE to manage an external credential by reference.' })}
    </details>
    <div class="cfg-check-row">${checkbox('integrations.gpt.enabled', gateway?.enabled, 'AI gateway enabled')}</div>
    ${invalidReference ? '<p class="cfg-connection-detail is-bad">Credential override must be env:NAME or credential-store:ID.</p>' : ''}
    ${check ? `<p class="cfg-connection-detail">${escapeHtml(check.code ?? state)} · requested ${escapeHtml(check.requestedModel ?? gateway?.modelId ?? '—')} · effective ${escapeHtml(check.effectiveModel ?? '—')} · ${escapeHtml(check.detail ?? '')}</p>` : '<p class="cfg-note">The model list reports access to model metadata. TEST CONNECTION checks the saved exact model separately and refuses substitution.</p>'}
    <footer class="cfg-card-actions"><span></span><button type="button" data-cfg-action="test-gateway"${disabled || invalidReference ? ' disabled' : ''}>TEST CONNECTION</button></footer>
  </section>`;
}
