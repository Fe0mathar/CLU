const hash = /^[a-f0-9]{64}$/u;

function screenedScope(run, frame) {
  const active = frame?.snapshot?.configuration?.project?.activeProject;
  const project = active?.operationIdentity;
  if (!project || run?.cycleStage !== 'SCREENED' || run.cycleCurrent !== true ||
      run.cycleMissionMatches !== true || typeof run.cycleId !== 'string' || typeof run.missionId !== 'string' ||
      typeof project.projectId !== 'string' || typeof project.projectProfileHash !== 'string' ||
      !Number.isSafeInteger(active.profileGeneration)) return null;
  return {
    projectId: project.projectId,
    projectProfileHash: project.projectProfileHash,
    profileGeneration: active.profileGeneration,
    missionId: run.missionId,
    cycleId: run.cycleId,
  };
}

function matchesScope(receipt, scope) {
  return receipt?.schemaVersion === 'clue-cycle-findings/1' &&
    Object.keys(scope).every((key) => receipt[key] === scope[key]);
}

function presentText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function mountQ4Findings({ root, read }) {
  const content = root?.querySelector('#q4-findings-content');
  const button = root?.querySelector('#q4-findings-refresh');
  if (!content || !button) return { observe() {}, invalidate() {} };
  const doc = root.ownerDocument;
  let scope = null;
  let scopeKey = null;
  let pending = null;

  function message(text) {
    content.textContent = text;
  }

  function element(tag, text) {
    const node = doc.createElement(tag);
    node.textContent = text;
    return node;
  }

  function display(receipt) {
    if (!hash.test(receipt.evidenceSha256) || !hash.test(receipt.screenedEvidenceSha256) ||
        !hash.test(receipt.rankingSha256) || !presentText(receipt.reason) || !presentText(receipt.eventId) ||
        !Number.isSafeInteger(receipt.findingCount) || receipt.findingCount < 0) {
      message('The candidate selection receipt could not be verified.');
      return;
    }
    const selected = receipt.selected;
    const rows = [];
    if (receipt.outcome === 'SELECTED' && selected &&
        [selected.findingId, selected.path, selected.signalId, selected.signalName, selected.reason].every(presentText) &&
        Number.isSafeInteger(selected.line) && selected.line > 0) {
      rows.push(element('p', `Selected ${selected.findingId} · ${selected.path}:${selected.line}`));
      rows.push(element('p', `${selected.signalId} ${selected.signalName} · ${selected.reason}`));
      if (receipt.reason !== selected.reason) rows.push(element('p', receipt.reason));
    } else if (receipt.outcome === 'NO_CANDIDATE' && selected === null) {
      rows.push(element('p', `No candidate selected. ${receipt.reason}`));
    } else {
      message('The candidate selection receipt could not be verified.');
      return;
    }
    const details = doc.createElement('details');
    details.append(element('summary', 'Selection evidence'));
    const evidence = doc.createElement('dl');
    for (const [label, value] of [
      ['Scope', `${scope.projectId} · generation ${scope.profileGeneration} · ${scope.missionId} · ${scope.cycleId}`],
      ['Recorded findings', String(receipt.findingCount)],
      ['Recorded event', receipt.eventId],
      ['Decision SHA-256', receipt.evidenceSha256],
      ['Screening SHA-256', receipt.screenedEvidenceSha256],
      ['Ranking SHA-256', receipt.rankingSha256],
    ]) evidence.append(element('dt', label), element('dd', value));
    details.append(evidence);
    content.replaceChildren(...rows, details);
  }

  async function refresh() {
    if (scope === null || pending !== null) return;
    const request = new AbortController();
    pending = request;
    button.disabled = true;
    message('Reading the candidate selection receipt…');
    try {
      const receipt = await read({ signal: request.signal });
      if (pending !== request || scope === null) return;
      if (receipt === null) message('No findings decision recorded for this screened cycle.');
      else if (!matchesScope(receipt, scope)) message('A findings decision for this screened cycle is unavailable.');
      else display(receipt);
    } catch {
      if (pending === request) message('The candidate selection receipt is unavailable.');
    } finally {
      if (pending === request) {
        pending = null;
        button.disabled = false;
      }
    }
  }

  function invalidate(text = 'Awaiting a screened cycle.') {
    pending?.abort();
    pending = null;
    scope = null;
    scopeKey = null;
    button.disabled = true;
    message(text);
  }

  button.addEventListener('click', () => { void refresh(); });
  return {
    observe(run, frame) {
      const next = screenedScope(run, frame);
      const nextKey = next === null ? null : JSON.stringify(next);
      if (nextKey === scopeKey) return;
      invalidate();
      scope = next;
      scopeKey = nextKey;
      if (next !== null) void refresh();
    },
    invalidate,
  };
}
