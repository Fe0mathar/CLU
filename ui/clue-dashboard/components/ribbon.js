import { mountRibbonWordmark } from './ribbonWordmark.js';
import { mountRibbonSeal } from './ribbonSeal.js';

const names = Object.freeze({ status: 'STATUS', git: 'GIT', ai: 'AI', chrome: 'CHROME', console: 'CONSOLE' });
const sessionCapabilities = Object.freeze({ chrome: 'Chrome', console: 'Console' });
const resultStates = new Set(['unknown', 'pending', 'ready', 'failed']);
const unknown = Object.freeze({ state: 'unknown', summary: 'Awaiting the dashboard startup check.', checks: [] });
const reopen = Object.freeze({ state: 'pending', summary: 'Reopen the dashboard to verify the changed Project Profile.', checks: [] });

function projectKey(identity, generation) {
  return identity ? JSON.stringify([identity.projectId, identity.targetRootIdentity, identity.projectProfileHash, generation]) : null;
}

export function projectRibbonStatus({ stream = null, run = null, notice = null, sealConsistent = null, project = null } = {}) {
  const state = String(run?.state ?? 'unknown').toLowerCase();
  const running = state === 'running';
  const runFailed = state === 'failed' || state === 'timeout';
  const runText = state === 'unknown' ? 'Awaiting run telemetry' : state[0].toUpperCase() + state.slice(1);
  const streamText = stream === true ? 'Live' : stream === false ? 'Reconnecting' : 'Awaiting connection';
  const status = sealConsistent === false || runFailed || notice?.state === 'failed' ? 'failed'
    : stream === false || notice?.state === 'pending' ? 'pending'
    : stream === null && run === null ? 'unknown'
    : running ? 'working'
    : stream === true && run !== null ? 'ready'
    : 'pending';
  return {
    state: status,
    summary: notice?.text || (sealConsistent === false
      ? 'The sealed status reports an integrity problem.'
      : `Stream ${streamText.toLowerCase()} · Run ${runText.toLowerCase()}`),
    checks: [
      { label: 'Stream', state: streamText },
      { label: 'Run', state: runText, detail: [run?.phase, run?.lastLine].filter(Boolean).join(' · ') },
      ...(project ? [{ label: 'Project', detail: project }] : []),
    ],
  };
}

export function mountRibbon({
  root = document.getElementById('rail'),
  request = (...args) => fetch(...args),
  checkCapability,
  openConfiguration,
} = {}) {
  if (!root) return null;

  const document = root.ownerDocument;
  const buttons = new Map([...root.querySelectorAll('[data-ribbon-capability]')].map(button => [button.dataset.ribbonCapability, button]));
  const details = root.querySelector('#ribbonDetails');
  const title = root.querySelector('#ribbonDetailsTitle');
  const summary = root.querySelector('#ribbonDetailsSummary');
  const checks = root.querySelector('#ribbonDetailsChecks');
  const closeButton = root.querySelector('#ribbonDetailsClose');
  const reveal = mountRibbonSeal(root.querySelector('.clue-ribbon-seal'));
  mountRibbonWordmark(root.querySelector('.clue-ribbon-brand'));

  const results = new Map();
  const requests = new Map();
  const status = { stream: null, run: null, notice: null, sealConsistent: null, project: null };
  let selected = null;
  let projectIdentity;
  let detailSignature;
  let startupChecksStarted = false;

  function render(capability, result) {
    const button = buttons.get(capability);
    if (!button) return;
    if (button.dataset.state !== result.state) button.dataset.state = result.state;
    if (button.title !== result.summary) button.title = result.summary;
    const redirects = capability !== 'status' && result.state !== 'ready' && Boolean(openConfiguration);
    button.setAttribute('aria-controls', redirects ? 'cfg' : 'ribbonDetails');
    const label = `${names[capability]} · ${result.state} · ${result.summary}${redirects ? ' · Open Configuration' : ''}`;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (selected !== capability) return;

    title.textContent = names[capability];
    if (summary.textContent !== result.summary) summary.textContent = result.summary;
    const signature = JSON.stringify(result.checks);
    if (signature === detailSignature) return;
    detailSignature = signature;
    checks.replaceChildren(...result.checks.map(check => {
      const item = document.createElement('li');
      const heading = document.createElement('strong');
      heading.textContent = [check.label, check.state].filter(Boolean).join(' · ');
      item.append(heading);
      if (check.detail) {
        const detail = document.createElement('span');
        detail.textContent = check.detail;
        item.append(detail);
      }
      return item;
    }));
  }

  const renderStatus = () => render('status', projectRibbonStatus(status));

  function updateReadiness(capability, result) {
    if (!buttons.has(capability) || capability === 'status' || !resultStates.has(result?.state)) return;
    const next = {
      state: result.state,
      summary: String(result.summary ?? 'Live check returned no summary.'),
      checks: Array.isArray(result.checks) ? result.checks.filter(check => check && typeof check === 'object') : [],
    };
    results.set(capability, next);
    render(capability, next);
  }

  async function liveCheck(capability, { refreshSession = false } = {}) {
    if (!buttons.has(capability) || capability === 'status' || requests.has(capability)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    requests.set(capability, controller);
    if (!refreshSession) updateReadiness(capability, {
      state: 'pending',
      summary: Object.hasOwn(sessionCapabilities, capability)
        ? `Reading the dashboard’s ${sessionCapabilities[capability]} test result…`
        : 'Running dashboard startup check…',
    });
    let result;
    try {
      if (checkCapability) {
        result = await checkCapability(capability, { signal: controller.signal });
      } else {
        const response = await request('/api/control/readiness', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability }), signal: controller.signal,
        });
        result = await response.json();
        if (!response.ok && !resultStates.has(result?.state)) throw new Error('Readiness request failed.');
      }
      if (!resultStates.has(result?.state)) throw new Error('Invalid readiness receipt.');
    } catch {
      if (!refreshSession) result = {
        state: 'failed',
        summary: controller.signal.aborted ? 'Live readiness check timed out.' : 'Live readiness check unavailable.',
      };
    } finally {
      clearTimeout(timeout);
      if (requests.get(capability) === controller) {
        requests.delete(capability);
        updateReadiness(capability, result);
      }
    }
  }

  function applySessionReadiness(capability, record, receipt) {
    const profile = record?.profile;
    if (!profile ||
        (capability === 'chrome' && profile.integrations?.chrome?.launchMode !== 'CLUE_MANAGED') ||
        (capability === 'console' && profile.integrations?.powershell?.autonomousProfile === 'disabled') ||
        !profile.projectId || !profile.targetRootIdentity || !record.projectProfileHash ||
        !Number.isSafeInteger(record.generation) || record.generation < 1 ||
        projectIdentity !== projectKey({ ...profile, projectProfileHash: record.projectProfileHash }, record.generation)) return false;
    if (!resultStates.has(receipt?.state) ||
        projectIdentity !== projectKey(receipt.projectIdentity, receipt.profileGeneration)) return false;
    const pending = requests.get(capability);
    requests.delete(capability);
    pending?.abort();
    updateReadiness(capability, receipt);
    return true;
  }

  for (const capability of Object.keys(sessionCapabilities)) {
    document.addEventListener(`clue:${capability}-readiness`, (event) => {
      applySessionReadiness(capability, event.detail?.record, event.detail?.receipt);
    });
  }

  function close(returnFocus = false) {
    if (selected === null) return;
    const button = buttons.get(selected);
    button.setAttribute('aria-expanded', 'false');
    selected = null;
    details.hidden = true;
    if (returnFocus) button.focus();
  }

  for (const [capability, button] of buttons) {
    button.addEventListener('click', event => {
      const result = results.get(capability) ?? unknown;
      if (capability !== 'status' && result.state !== 'ready' && openConfiguration) {
        close();
        openConfiguration(capability, result);
        return;
      }
      if (selected === capability) { close(); return; }
      close();
      selected = capability;
      button.setAttribute('aria-expanded', 'true');
      details.hidden = false;
      if (capability === 'status') renderStatus();
      else render(capability, result);
      if (event.detail === 0) closeButton.focus();
    });
  }

  closeButton.addEventListener('click', () => close(true));
  document.addEventListener('pointerdown', event => {
    if (!details.contains(event.target) && !event.target.closest?.('[data-ribbon-capability]')) close();
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || selected === null) return;
    event.stopPropagation();
    close(true);
  });

  function resetReadiness() {
    for (const pending of requests.values()) pending.abort();
    requests.clear();
    results.clear();
    projectIdentity = undefined;
    Object.assign(status, { run: null, notice: null, sealConsistent: null, project: null });
    reveal.reset();
    renderStatus();
    for (const capability of buttons.keys()) {
      if (capability !== 'status') updateReadiness(capability, startupChecksStarted ? reopen : unknown);
    }
  }

  return {
    updateFrame(frame) {
      if (frame === null) { resetReadiness(); return; }
      const target = frame?.snapshot?.configuration?.project?.activeProject;
      const identity = target?.operationIdentity;
      const nextProject = projectKey(identity, target?.profileGeneration);
      if (projectIdentity !== undefined && projectIdentity !== nextProject) resetReadiness();
      projectIdentity = nextProject;
      const mission = frame?.snapshot?.shell?.identity ?? frame?.snapshot?.shell?.mission;
      status.project = identity ? `${identity.projectId} · generation ${target.profileGeneration}` : mission?.title ?? null;
      const stateSeal = frame?.seal ?? frame?.snapshot?.seal;
      status.sealConsistent = stateSeal?.consistent ?? null;
      renderStatus();
      reveal.offer(stateSeal?.statusHash);
      if (!startupChecksStarted) {
        startupChecksStarted = true;
        for (const capability of buttons.keys()) if (capability !== 'status') void liveCheck(capability);
      }
    },
    updateStream(connected) {
      const reconnected = status.stream === false && connected === true;
      status.stream = connected;
      renderStatus();
      if (reconnected && startupChecksStarted && projectIdentity !== undefined) {
        for (const capability of Object.keys(sessionCapabilities)) {
          void liveCheck(capability, { refreshSession: true });
        }
      }
    },
    updateRun(run) { status.run = run; renderStatus(); },
    notice(text, state = 'failed') { status.notice = text ? { text, state } : null; renderStatus(); },
    updateReadiness,
    applyChromeReadiness: (record, receipt) => applySessionReadiness('chrome', record, receipt),
    resetReadiness,
  };
}
