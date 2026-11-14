import { findCredentialLeak } from '../configuration/actionContracts.js';
import { runIdentity } from '../state/runPresentation.js';

/** Only these typed operator commands are routed. CLUE receives ordinary conversation separately. */
const COMMANDS = new Set(['/start', '/start --assess-findings', '/git sync', '/status', '/cycle status', '/halt', '/resume', '/forget']);
const HELP = [
  '/start — drive or recover the governed cycle through screening',
  '/start --assess-findings — screen the cycle and assess findings',
  '/git sync — synchronize Git on explicit request',
  '/status or /cycle status — show the cycle checkpoint and process status',
  '/halt [reason] — pause CLUE and stop its active turn',
  '/resume — resume CLUE conversation',
  '/forget — clear CLUE’s conversation context',
  '/help — list these commands',
  'Ask CLUE about dashboard status in plain text.',
].join('\n');

const INPUT_LIMIT = 2048;
const TEXT_LIMIT = 8192;
const SCROLLBACK_LIMIT = 240;
const RECALL_LIMIT = 40;
const ACTIVITY_LIMIT = 40;
const ACTIVITY_TAIL = 12;
const RESTORED_TURNS = 4;
const DEFAULT_POLL_MS = 1500;
const READY = 'Console ready. /help lists the exact commands. Anything else is addressed to CLUE.';

function boundedText(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string') return '';
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function coreFailure(text) {
  return { kind: 'core', ok: false, lines: [{ source: 'CORE', tone: 'error', text }], receipts: [], turnId: null, basis: null, status: null };
}

function lineKind(line) {
  if (line?.tone === 'error') return 'error';
  if (line?.source === 'CORE') return line.tone === 'ok' ? 'ok' : 'system';
  return 'agent';
}

/**
 * Mounts the console over two transport callbacks.
 *
 *   send({ line, command, signal }) → a typed operator receipt or a CLUE reply
 *   activity({ after, signal }) → { rows, head } from the agent ledger
 *   dialogue({ signal })        → { turns } of the durable CLUE dialogue (optional)
 *   onSettled(result)           → called after every rendered result (optional)
 */
export function mountQ4Terminal({ root, send, activity, dialogue, onSettled, pollMs = DEFAULT_POLL_MS }) {
  const form = root.querySelector('#q4-terminal-form');
  const input = root.querySelector('#q4-terminal-input');
  const log = root.querySelector('#q4-terminal-log');
  const strip = root.querySelector('#q4-command-receipts');
  const document = root.ownerDocument;
  const pending = new Set();
  const recall = [];
  let recallIndex = 0;
  let draft = '';
  let turn = null;
  let generation = 0;
  let cursor = -ACTIVITY_TAIL;
  let polling = null;
  let restoring = null;
  let timer = null;

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

  function stripRow(text, tone) {
    const value = boundedText(text, 420);
    if (!value) return;
    const row = document.createElement('li');
    row.dataset.tone = tone;
    row.textContent = value;
    strip.prepend(row);
    while (strip.childElementCount > ACTIVITY_LIMIT) strip.lastElementChild.remove();
    strip.hidden = false;
  }

  /** A receipt the dashboard itself observed, such as a cycle drive finishing. */
  function recordReceipt(receipt) {
    if (!receipt || typeof receipt !== 'object') return;
    const label = boundedText(receipt.action, 90);
    const outcome = boundedText(receipt.state || receipt.disposition || receipt.code, 90)
      || (receipt.started === true ? 'accepted' : receipt.started === false ? 'refused' : '');
    const identity = boundedText(runIdentity(receipt), 140);
    const detail = boundedText(receipt.detail || receipt.reason || receipt.message, 320);
    if (!label || (!outcome && !identity && !detail)) return;
    stripRow([label, outcome, identity, detail].filter(Boolean).join(' · '), outcome === 'failed' || outcome === 'refused' || outcome === 'timeout' ? 'error' : 'ok');
  }

  function render(result) {
    const lines = Array.isArray(result?.lines) ? result.lines : [];
    if (lines.length === 0) {
      append('error', 'CORE', 'The dashboard returned no response.');
      return;
    }
    for (const line of lines) append(lineKind(line), boundedText(line?.source, 40) || 'CORE', line?.text);
    const receipts = Array.isArray(result?.receipts) ? result.receipts : [];
    if (result?.kind !== 'clue') {
      for (const receipt of receipts) recordReceipt(receipt);
      return;
    }
    for (const receipt of receipts) {
      append(receipt?.ok === false ? 'error' : 'meta', 'RECEIPT', `${receipt?.ok === false ? '✗' : '✓'} ${boundedText(receipt?.label, 200)} — ${boundedText(receipt?.detail, 400)}`);
    }
    const basis = typeof result?.basis?.statusHash === 'string' ? `Status ${result.basis.statusHash.slice(0, 12)}` : 'no sealed Status';
    append('meta', 'BASIS', [result?.turnId, result?.status, basis, `${receipts.length} action${receipts.length === 1 ? '' : 's'}`].filter(Boolean).join(' · '));
  }

  async function refresh() {
    if (polling || typeof activity !== 'function') return;
    const controller = new AbortController();
    polling = controller;
    const mine = generation;
    try {
      const page = await activity({ after: cursor, signal: controller.signal });
      if (mine !== generation || !page || !Array.isArray(page.rows)) return;
      for (const row of page.rows) {
        if (typeof row?.seq !== 'number' || (cursor >= 0 && row.seq <= cursor)) continue;
        stripRow(`${boundedText(row.agent, 32).toUpperCase()} · ${boundedText(row.text, 360)}`, row.tone === 'error' ? 'error' : row.tone === 'ok' ? 'ok' : 'info');
      }
      const last = page.rows.at(-1);
      cursor = Math.max(cursor, 0, typeof last?.seq === 'number' ? last.seq : 0, page.rows.length === 0 && typeof page.head === 'number' ? page.head : 0);
    } catch {
      // The strip shows what the ledger recorded; a failed poll is retried on the next tick.
    } finally {
      if (polling === controller) polling = null;
    }
  }

  async function restore() {
    if (typeof dialogue !== 'function') return;
    const controller = new AbortController();
    restoring = controller;
    const mine = generation;
    try {
      const turns = (await dialogue({ signal: controller.signal }))?.turns;
      if (mine !== generation || !Array.isArray(turns) || turns.length === 0 || log.childElementCount > 1) return;
      const recent = turns.slice(-RESTORED_TURNS);
      append('meta', 'CORE', `Restored the last ${recent.length} of ${turns.length} turn${turns.length === 1 ? '' : 's'} from the agent ledger.`);
      for (const entry of recent) {
        append('operator', 'YOU', entry?.message);
        append('agent', 'CLUE', entry?.reply);
      }
    } catch {
      // Without the ledger the console simply starts empty.
    } finally {
      if (restoring === controller) restoring = null;
    }
  }

  function cancelRequests() {
    generation += 1;
    for (const controller of pending) controller.abort();
    pending.clear();
    polling?.abort();
    restoring?.abort();
    polling = null;
    restoring = null;
    turn = null;
  }

  function reset() {
    cancelRequests();
    recall.length = 0;
    recallIndex = 0;
    draft = '';
    cursor = -ACTIVITY_TAIL;
    input.value = '';
    form.setAttribute('aria-busy', 'false');
    strip.replaceChildren();
    strip.hidden = true;
    log.replaceChildren();
    append('system', 'CORE', READY);
    void restore();
    void refresh();
  }

  async function submit(event) {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    if (message.length > INPUT_LIMIT) {
      append('error', 'CORE', `Enter at most ${INPUT_LIMIT} characters.`);
      return;
    }
    if (findCredentialLeak(message) !== null) {
      input.value = '';
      append('error', 'CORE', 'Credentials belong in the configured credential store.');
      return;
    }
    const normalized = message.startsWith('/') ? message.toLowerCase().replace(/\s+/gu, ' ') : null;
    const command = normalized?.startsWith('/halt ') ? '/halt' : normalized;
    if (command === null && turn !== null) {
      append('error', 'CORE', 'CLUE is still working on a turn. Exact commands still run; /halt aborts the turn.');
      return;
    }
    recall.push(message);
    if (recall.length > RECALL_LIMIT) recall.shift();
    recallIndex = recall.length;
    draft = '';
    input.value = '';
    append('operator', 'YOU', message, true);
    if (command === '/help') {
      append('system', 'CORE', HELP);
      return;
    }
    if (command !== null && !COMMANDS.has(command)) {
      append('error', 'CORE', 'Unknown CLU-E command. Enter /help to list the supported commands.');
      return;
    }
    if (typeof send !== 'function') {
      append('error', 'CORE', 'The console is not connected to the dashboard server.');
      return;
    }

    const controller = new AbortController();
    const mine = generation;
    pending.add(controller);
    if (command === null) {
      turn = controller;
      form.setAttribute('aria-busy', 'true');
    }
    let result = null;
    try {
      result = await send({ line: message, command, signal: controller.signal });
      if (mine !== generation) return;
      render(result);
    } catch (error) {
      if (mine !== generation) return;
      result = coreFailure(error instanceof Error ? error.message : 'The request failed.');
      render(result);
    } finally {
      pending.delete(controller);
      if (mine === generation) {
        if (turn === controller) {
          turn = null;
          form.setAttribute('aria-busy', 'false');
        }
        void refresh();
        if (typeof onSettled === 'function') onSettled(result);
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
  if (typeof activity === 'function' && pollMs > 0) timer = setInterval(() => { void refresh(); }, pollMs);
  return {
    reset,
    refresh,
    recordReceipt,
    destroy() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      cancelRequests();
      form.removeEventListener('submit', submit);
      input.removeEventListener('keydown', recallInput);
    },
  };
}
