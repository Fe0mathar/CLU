/** GPT/OpenAI exact-model and credential-reference editor. */

import {
  badge,
  checkbox,
  escapeHtml,
  fieldMeta,
  fieldShell,
  isBusy,
  renderReadinessReceipt,
  sectionHeader,
  select,
  stateLine,
} from './viewPrimitives.js';
import { CREDENTIAL_REFERENCE_PATTERN } from './draftIssues.js';
import { renderStartupBindingLink } from './projectSelector.js';

export { CREDENTIAL_REFERENCE_PATTERN };

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

/** The AI connection state an operator should read first for the selected profile. */
export function gatewayStateOf(snapshot) {
  const gateway = snapshot.draft?.integrations?.gpt;
  const credential = credentialReferenceState(gateway?.credential);
  const invalidReference = credential.source === 'project-override' && !CREDENTIAL_REFERENCE_PATTERN.test(credential.value);
  const check = snapshot.dirty ? null : snapshot.connectionChecks?.gateway;
  const state = check?.state ?? (check?.operationallyReady ? 'READY' : 'UNVALIDATED');
  return { state: invalidReference ? 'INVALID' : state, check, invalidReference, credential };
}

export function renderGatewayEditor(snapshot) {
  const profile = snapshot.draft;
  const startup = renderStartupBindingLink(snapshot);
  const legacyKey = snapshot.legacyConnections?.ai;
  const legacy = snapshot.legacyConfiguration?.legacyConnectionControls === true ? `<div class="cfg-legacy-connection">
    <p class="cfg-card-copy">Save the active legacy target’s OpenAI key using the native Windows prompt. Reopen the dashboard to validate the connection.</p>
    <button type="button" data-cfg-action="set-legacy-openai-key"${snapshot.legacyConnections?.busy ? ' disabled' : ''}>SET / REPLACE LEGACY TARGET API KEY</button>
    ${legacyKey ? `<p class="cfg-connection-detail" role="status">${escapeHtml(legacyKey.detail)}</p>` : ''}
    ${renderReadinessReceipt(snapshot, 'ai', true)}
  </div>` : '';
  if (!profile) return `<section class="cfg-card" data-section="gpt-gateway">${sectionHeader({ kicker: 'GPT API KEY', title: 'OpenAI credentials' })}${startup}${legacy || '<p class="cfg-empty-copy">Select a saved Project Profile to configure its key.</p>'}</section>`;
  const gateway = profile.integrations?.gpt;
  const { state, check, invalidReference, credential } = gatewayStateOf(snapshot);
  const key = snapshot.dirty ? null : snapshot.connectionChecks?.openaiKey;
  const disabled = !snapshot.selectedRecord || snapshot.dirty || isBusy(snapshot);
  const catalogue = modelCatalogueFor(snapshot);
  const models = availableGatewayModels(snapshot);
  const currentModel = gateway?.modelId ?? '';
  const modelSelect = select('integrations.gpt.modelId', currentModel, modelOptions(currentModel, models, catalogue?.state === 'READY'), {
    disabled: models.length === 0 || Boolean(snapshot.pending),
  });
  const modelListMessage = catalogue?.state === 'READY'
    ? `${models.length} available model ID${models.length === 1 ? '' : 's'}. Choose an exact model, then save the profile.`
    : MODEL_LIST_MESSAGES[catalogue?.state] ?? 'Load the models available to the saved profile’s credential.';
  const blocked = !snapshot.selectedRecord
    ? 'Save the new profile before setting its key.'
    : snapshot.dirty
      ? 'Save or discard your changes first — the key and tests belong to the saved profile.'
      : '';
  const off = gateway?.enabled !== true;

  return `<section class="cfg-card" data-section="gpt-gateway">
    ${sectionHeader({
      kicker: 'AI MODEL · GPT API KEY',
      title: 'OpenAI credentials for this Project Profile',
      description: 'Which OpenAI key this profile uses and the one exact model it may call. CLU-E never substitutes another model, and never contacts OpenAI from this page until you press a button that says so.',
      badges: badge(off && !check ? 'NOT_REQUIRED' : state, off && !check ? 'OFF' : state === 'UNVALIDATED' ? 'NOT TESTED' : state),
    })}
    ${startup}${legacy}${renderReadinessReceipt(snapshot, 'ai')}
    ${check ? stateLine(state) : ''}
    <div class="cfg-group">
      <div class="cfg-check-row">${checkbox('integrations.gpt.enabled', gateway?.enabled, 'AI gateway enabled')}</div>
      <p class="cfg-note">Off: this profile makes no AI calls at all. Recognition, benchmarks and proof of hand-written candidates still work.</p>
    </div>
    ${blocked === '' ? '' : `<p class="cfg-note">${escapeHtml(blocked)}</p>`}
    <div class="cfg-group">
      <div class="cfg-group-head"><h4>1 · API key</h4><p>Set or replace the key in a masked Windows prompt. The browser receives the outcome only. Save any unsaved profile edits before opening the prompt.</p></div>
      ${snapshot.phase === 'waiting-for-windows-key-prompt' ? '<p class="cfg-connection-detail" role="status">Complete the Windows API key dialog or cancel it to return here.</p>' : ''}
      <div class="cfg-action-row is-start"><button type="button" data-cfg-action="set-openai-key"${disabled ? ' disabled' : ''}>SET / REPLACE API KEY</button><button type="button" data-cfg-action="check-openai-key"${disabled ? ' disabled' : ''}>CHECK SAVED KEY</button></div>
      ${key ? `<p class="cfg-connection-detail">${escapeHtml(String(key.state ?? '').toUpperCase())} · ${escapeHtml(key.detail ?? '')}</p>` : ''}
      <details data-cfg-details="gateway-credential"><summary>Advanced credential settings</summary>
        <p class="cfg-note">A profile stores a reference to a key, never the key. Use the installation default, or point this profile at its own environment variable or Windows credential.</p>
        <div class="cfg-override-banner"><span>${escapeHtml(credential.label)}</span><div><button type="button" data-cfg-action="use-gateway-global">USE GLOBAL</button><button type="button" data-cfg-action="use-gateway-override">SET REFERENCE</button></div></div>
        ${fieldShell({ label: 'Credential Reference', wide: true, control: `<input value="${escapeHtml(credential.source === 'project-override' ? credential.value : credential.label)}" readonly />`, note: 'Use SET REFERENCE to manage an external credential by reference.', ...fieldMeta(snapshot, 'integrations.gpt.credential'), path: 'integrations.gpt.credential' })}
      </details>
      ${invalidReference ? '<p class="cfg-connection-detail is-bad">Credential override must be env:NAME or credential-store:ID.</p>' : ''}
    </div>
    <div class="cfg-group">
      <div class="cfg-group-head"><h4>2 · Model</h4><p>Load the models this key can reach, pick one, then save. An enabled gateway needs an exact model.</p></div>
      <div class="cfg-action-row is-start"><button type="button" data-cfg-action="load-gateway-models"${disabled || invalidReference ? ' disabled' : ''}>LOAD AVAILABLE MODELS</button></div>
      <p class="cfg-connection-detail" role="status">${escapeHtml(snapshot.phase === 'reading-gateway-models' ? 'Loading the saved profile’s model list…' : modelListMessage)}</p>
      <div class="cfg-form-grid is-three">
        ${fieldShell({ label: 'Provider', control: '<input value="openai" readonly />' })}
        ${fieldShell({ label: 'Model ID', control: modelSelect, note: 'Changes are saved to this Project Profile. Activate the profile to use it in the runtime.', ...fieldMeta(snapshot, 'integrations.gpt.modelId') })}
        ${fieldShell({ label: 'Fallback Policy', control: '<input value="FORBID" readonly />', note: 'Fixed. If the model is unavailable the call fails; nothing else is used.' })}
      </div>
    </div>
    <div class="cfg-group cfg-test-block">
      <div class="cfg-group-head"><h4>3 · Test</h4><p>Sends one small request to OpenAI with the saved key and model. This can consume a little provider usage.</p></div>
      ${check ? `<p class="cfg-connection-detail">${escapeHtml(check.code ?? state)} · requested ${escapeHtml(check.requestedModel ?? gateway?.modelId ?? '—')} · effective ${escapeHtml(check.effectiveModel ?? '—')} · ${escapeHtml(check.detail ?? '')}</p>` : '<p class="cfg-note">The model list reports access to model metadata. TEST CONNECTION checks the saved exact model separately and refuses substitution.</p>'}
      <footer class="cfg-card-actions"><span></span><button type="button" data-cfg-action="test-gateway"${disabled || invalidReference ? ' disabled' : ''}>TEST CONNECTION</button></footer>
    </div>
  </section>`;
}
