const INPUT_LIMIT = 2048;
const RESPONSE_LIMIT = 8192;
const HISTORY_LIMIT = 8;
const SCROLLBACK_LIMIT = 160;
const RECALL_LIMIT = 40;
const RECEIPT_LIMIT = 12;
const HELP = '/start — run the governed cycle\n/git sync — synchronize Git on explicit request\n/status — show run status\n/help — list CLU-E commands\nPlain text opens a conversation with the Master Agent.';

function parseInput(value) {
  const message = value.trim();
  if (!message) return null;
  if (!message.startsWith('/')) return { command: 'chat', message };
  return { command: message.toLowerCase().replace(/\s+/gu, ' '), message };
}

function boundedText(value, limit = RESPONSE_LIMIT) {
  if (typeof value !== 'string') return '';
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function responseText(result) {
  if (typeof result === 'string') return boundedText(result);
  return boundedText(result?.reply || result?.message || result?.reason || result?.detail || result?.receipt?.detail);
}

/** Mounts one in-memory, project-scoped terminal over the program's existing control callbacks. */
export function mountQ4Terminal({ root, start, gitSync, status, chat }) {
  const form = root.querySelector('#q4-terminal-form');
  const input = root.querySelector('#q4-terminal-input');
  const send = root.querySelector('#q4-terminal-submit');
  const log = root.querySelector('#q4-terminal-log');
  const receipts = root.querySelector('#q4-command-receipts');
  const document = root.ownerDocument;
  const history = [];
  const recall = [];
  let recallIndex = 0;
  let draft = '';
  let active = null;

  function append(kind, label, text, forceScroll = false) {
    const following = log.scrollHeight - log.clientHeight - log.scrollTop <= 24;
    const row = document.createElement('li');
    row.dataset.kind = kind;
    const tag = document.createElement('span');
    tag.className = 'q4-terminal-source';
    tag.textContent = `${label} › `;
    row.append(tag, document.createTextNode(boundedText(text)));
    log.append(row);
    while (log.childElementCount > SCROLLBACK_LIMIT) log.firstElementChild.remove();
    if (forceScroll || following) log.scrollTop = log.scrollHeight;
  }

  function recordReceipt(action, receipt) {
    if (!receipt || typeof receipt !== 'object') return;
    const label = boundedText(receipt.action || action, 90);
    const outcome = boundedText(receipt.state || receipt.code, 90)
      || (receipt.started === true ? 'accepted' : receipt.started === false ? 'refused' : '');
    const detail = boundedText(receipt.detail || receipt.reason || receipt.message, 360);
    if (!label || (!outcome && !detail)) return;
    const row = document.createElement('li');
    row.textContent = [label, outcome, detail].filter(Boolean).join(' · ');
    receipts.prepend(row);
    while (receipts.childElementCount > RECEIPT_LIMIT) receipts.lastElementChild.remove();
    receipts.hidden = false;
  }

  function setBusy(value) {
    send.disabled = value;
    form.setAttribute('aria-busy', String(value));
  }

  function reset() {
    active?.abort();
    active = null;
    history.length = 0;
    recall.length = 0;
    recallIndex = 0;
    draft = '';
    input.value = '';
    setBusy(false);
    receipts.replaceChildren();
    receipts.hidden = true;
    log.replaceChildren();
    append('system', 'CLU-E', 'Console ready. Enter /help for commands, or ask the Master Agent a question.');
  }

  const actions = new Map([
    ['/start', { label: 'Cycle drive', run: start }],
    ['/git sync', { label: 'Git sync', run: gitSync }],
    ['/status', { label: 'Status', run: status }],
  ]);

  async function submit(event) {
    event.preventDefault();
    if (active) return;
    const parsed = parseInput(input.value);
    if (!parsed) return;
    const { command, message } = parsed;
    if (message.length > INPUT_LIMIT) {
      append('error', 'CLU-E', `Enter at most ${INPUT_LIMIT} characters.`);
      return;
    }
    recall.push(message);
    if (recall.length > RECALL_LIMIT) recall.shift();
    recallIndex = recall.length;
    draft = '';
    input.value = '';
    append('operator', 'YOU', message, true);
    if (command === '/help') {
      append('system', 'CLU-E', HELP);
      return;
    }

    const action = actions.get(command);
    const isChat = command === 'chat';
    if (!isChat && !action) {
      append('error', 'CLU-E', 'Unknown CLU-E command. Enter /help to list the supported commands.');
      return;
    }
    if (isChat ? typeof chat !== 'function' : typeof action.run !== 'function') {
      append('error', 'CLU-E', `${isChat ? 'The Master Agent' : action.label} is unavailable.`);
      return;
    }

    const controller = new AbortController();
    active = controller;
    setBusy(true);
    try {
      const result = isChat
        ? await chat({ message, history: history.slice(), signal: controller.signal })
        : await action.run({ signal: controller.signal });
      if (active !== controller) return;
      const reply = responseText(result);
      if (!reply) {
        append('error', 'CLU-E', 'The dashboard returned no response text.');
      } else if (isChat) {
        const failed = result?.ok === false;
        append(failed ? 'error' : 'agent', failed ? 'CLU-E' : 'MASTER AGENT', reply);
        if (!failed) {
          history.push({ role: 'user', text: message }, { role: 'assistant', text: boundedText(reply, INPUT_LIMIT) });
          if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
        }
      } else {
        append(result?.ok === false ? 'error' : 'system', 'CLU-E', reply);
      }
      recordReceipt(result?.action || action?.label, result?.receipt);
    } catch (error) {
      if (active === controller) append('error', 'CLU-E', error instanceof Error ? error.message : 'Request failed.');
    } finally {
      if (active === controller) {
        active = null;
        setBusy(false);
      }
    }
  }

  function recallInput(event) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !recall.length) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (input.selectionStart !== input.selectionEnd) return;
    event.preventDefault();
    if (recallIndex === recall.length) draft = input.value;
    recallIndex = Math.max(0, Math.min(recall.length, recallIndex + (event.key === 'ArrowUp' ? -1 : 1)));
    input.value = recall[recallIndex] ?? draft;
    input.setSelectionRange(input.value.length, input.value.length);
  }

  form.addEventListener('submit', submit);
  input.addEventListener('keydown', recallInput);
  reset();
  return {
    reset,
    recordReceipt(receipt) { recordReceipt(undefined, receipt); },
    destroy() {
      reset();
      form.removeEventListener('submit', submit);
      input.removeEventListener('keydown', recallInput);
    },
  };
}
