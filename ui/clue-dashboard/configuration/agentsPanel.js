/**
 * Configuration → Agents (ADR-0021).
 *
 * Edits the CLUE Identity Document for the running profile. The browser holds the text being
 * edited and nothing else: the server validates, versions, hashes and writes the file, and every
 * earlier version stays restorable. Credentials appear here only as references.
 */

function failure(invoked) {
  return invoked?.serverDetails?.reason ?? invoked?.serverDetails?.message ?? invoked?.reason ?? 'The request failed.';
}

export function mountAgentsPanel({ root, actionClient }) {
  root.classList?.add('agents-panel');
  const doc = root.ownerDocument;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, className) => {
    const node = make('button', className, label);
    node.type = 'button';
    return node;
  };

  const details = make('details');
  details.open = true;
  const summary = make('summary');
  const state = make('span', 'agents-state', 'loading…');
  summary.append(make('span', 'agents-title', 'AGENTS'), state);

  const reloadButton = button('RELOAD');
  const validateButton = button('VALIDATE');
  const applyButton = button('APPLY', 'is-primary');
  const testButton = button('TEST BRAIN');
  const haltButton = button('HALT', 'is-danger');
  const resumeButton = button('RESUME');
  const controls = make('div', 'agents-row');
  controls.append(reloadButton, validateButton, applyButton, testButton, haltButton, resumeButton);

  const guidance = make('p', 'agents-guidance', 'CLUE answers questions about the running dashboard. Set brain.model to the exact OpenAI model. For brain.credential, use env:CLUE_AGENT_OPENAI_API_KEY or the running profile’s saved credential reference.');
  const facts = make('div', 'agents-facts', '');
  const editor = make('textarea', 'agents-text');
  editor.spellcheck = false;
  editor.setAttribute('aria-label', 'Identity Document');
  const note = make('input', 'agents-note');
  note.type = 'text';
  note.maxLength = 200;
  note.placeholder = 'Change note for the log (optional)';
  note.setAttribute('aria-label', 'Change note');
  const dirty = make('span', 'agents-dirty', '');
  const noteRow = make('div', 'agents-row');
  noteRow.append(note, dirty);

  const versionSelect = make('select');
  versionSelect.setAttribute('aria-label', 'Retained versions');
  const revertButton = button('REVERT TO VERSION');
  const versionRow = make('div', 'agents-row');
  versionRow.append(versionSelect, revertButton);

  const message = make('ul', 'agents-message');
  message.setAttribute('role', 'status');
  const body = make('div', 'agents-body');
  body.append(guidance, controls, facts, editor, noteRow, versionRow, message);
  details.append(summary, body);
  root.replaceChildren(details);

  let loadedText = '';
  let expectedHash = null;
  let hasVersions = false;
  let busy = false;
  const lifetime = new AbortController();
  const editable = [reloadButton, validateButton, applyButton, testButton, haltButton, resumeButton, editor, note, versionSelect];

  function say(tone, lines) {
    message.dataset.tone = tone;
    message.replaceChildren(...lines.map((line) => make('li', '', line)));
  }

  function problems(list) {
    return (Array.isArray(list) ? list : []).map((problem) => `${problem?.path ?? 'document'}: ${problem?.message ?? 'invalid'}`);
  }

  function markDirty() {
    dirty.textContent = editor.value === loadedText ? '' : 'UNSAVED CHANGES';
  }

  async function call(name, input) {
    const invoked = await actionClient.invoke(name, input, { signal: lifetime.signal });
    if (lifetime.signal.aborted) throw new Error('The running profile changed.');
    if (!invoked.ok) throw new Error(failure(invoked));
    return invoked.result;
  }

  async function guarded(work) {
    if (busy || lifetime.signal.aborted) return;
    busy = true;
    for (const node of editable) node.disabled = true;
    revertButton.disabled = true;
    try {
      await work();
    } catch (error) {
      if (!lifetime.signal.aborted) say('error', [error instanceof Error ? error.message : String(error)]);
    } finally {
      busy = false;
      for (const node of editable) node.disabled = false;
      revertButton.disabled = !hasVersions;
    }
  }

  async function refreshState() {
    try {
      const view = await call('readAgentState');
      const identity = view?.identity ?? {};
      const brain = view?.brain ?? {};
      state.dataset.state = String(view?.state ?? 'unavailable');
      state.textContent = [
        `CLUE ${view?.state ?? 'unavailable'}${view?.reason ? ` — ${view.reason}` : ''}`,
        identity.valid ? `identity v${identity.version} ${String(identity.hash ?? '').slice(0, 12)}` : 'identity invalid',
        `brain ${brain.model ?? 'unbound'}`,
        `ledger ${view?.ledger?.records ?? 0} records`,
      ].join(' · ');
    } catch (error) {
      state.dataset.state = 'unavailable';
      state.textContent = `CLUE unavailable — ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function loadIdentity() {
    const view = await call('readAgentIdentity', { query: { id: 'clue' } });
    loadedText = typeof view?.text === 'string' ? view.text : '';
    expectedHash = typeof view?.hash === 'string' && /^[a-f0-9]{64}$/u.test(view.hash) ? view.hash : null;
    editor.value = loadedText;
    markDirty();
    const brain = view?.brain ?? {};
    facts.textContent = view?.text === null
      ? 'The CLUE identity is unavailable for this profile.'
      : [
          'Profile workspace · CLUE identity',
          view?.valid ? `version ${view.version}` : 'INVALID',
          view?.hash ? `sha256 ${view.hash}` : null,
          `brain ${brain.model ?? 'unbound'}`,
          brain.credential ? `credential ${brain.credential}` : null,
          view?.state ? `state ${view.state}` : null,
        ].filter(Boolean).join(' · ');
    const versions = Array.isArray(view?.versions) ? view.versions : [];
    versionSelect.replaceChildren(...versions.map((version) => {
      const option = make('option', '', `${String(version.hash).slice(0, 12)} · ${version.storedAt} · ${version.bytes} bytes${version.hash === view?.hash ? ' · current' : ''}`);
      option.value = version.hash;
      return option;
    }));
    hasVersions = versions.length > 0;
    if (view?.valid === false) say('error', ['This Identity Document is not valid and is not loaded:', ...problems(view.problems)]);
  }

  async function load() {
    await guarded(async () => {
      await loadIdentity();
      await refreshState();
    });
  }

  editor.addEventListener('input', markDirty);
  reloadButton.addEventListener('click', () => {
    say('info', []);
    void load();
  });
  validateButton.addEventListener('click', () => void guarded(async () => {
    const result = await call('validateAgentIdentity', { id: 'clue', text: editor.value });
    say(result?.valid ? 'ok' : 'error', result?.valid
      ? [`Valid. It would be recorded as version ${result.version}.`]
      : ['Not valid; applying it would be refused:', ...problems(result?.problems)]);
  }));
  applyButton.addEventListener('click', () => void guarded(async () => {
    const result = await call('applyAgentIdentity', { id: 'clue', expectedHash, text: editor.value, note: note.value.trim() });
    if (!result?.ok) {
      say('error', ['Refused; nothing changed:', ...problems(result?.problems)]);
      return;
    }
    note.value = '';
    await loadIdentity();
    await refreshState();
    say('ok', [result.unchanged
      ? 'No change: this is already the current Identity Document.'
      : `Applied as version ${result.version} (${String(result.hash).slice(0, 12)}). It takes effect on the next turn.`]);
  }));
  revertButton.addEventListener('click', () => void guarded(async () => {
    if (!versionSelect.value) return;
    const result = await call('revertAgentIdentity', { id: 'clue', expectedHash, hash: versionSelect.value });
    if (!result?.ok) {
      say('error', ['The revert was refused; nothing changed:', ...problems(result?.problems)]);
      return;
    }
    await loadIdentity();
    await refreshState();
    say('ok', [`Restored ${String(result.hash).slice(0, 12)} (version ${result.version}).`]);
  }));
  testButton.addEventListener('click', () => void guarded(async () => {
    say('info', ['Testing the brain…']);
    const result = await call('testAgentBrain', { id: 'clue' });
    say(result?.ok ? 'ok' : 'error', [String(result?.detail ?? 'The test returned no detail.')]);
    await refreshState();
  }));
  const consoleLine = (line) => void guarded(async () => {
    const result = await call('agentConsole', { line });
    say(result?.ok ? 'ok' : 'error', (Array.isArray(result?.lines) ? result.lines : []).map((entry) => String(entry?.text ?? '')));
    await refreshState();
  });
  haltButton.addEventListener('click', () => consoleLine('/halt halted from Configuration'));
  resumeButton.addEventListener('click', () => consoleLine('/resume'));
  return { load, refreshState, destroy() { lifetime.abort(); } };
}
