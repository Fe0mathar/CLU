import assert from 'node:assert/strict';
import test from 'node:test';

import { DASHBOARD_ACTIONS, createActionClient } from '../configuration/actionContracts.js';
import { mountQ4Findings } from '../quadrants/q4Findings.js';

class Element {
  children = [];
  handlers = new Map();
  text = '';
  disabled = true;

  get textContent() { return this.text + this.children.map((child) => child.textContent).join(' '); }
  set textContent(value) { this.text = value; this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  addEventListener(type, listener) { this.handlers.set(type, listener); }
  refresh() { if (!this.disabled) this.handlers.get('click')?.(); }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
const scope = { projectId: 'clue1', projectProfileHash: `profile:v1:${a}`, profileGeneration: 9,
  missionId: 'MISSION-000009', cycleId: 'CYCLE-000008' };
const run = { cycleStage: 'SCREENED', cycleCurrent: true, cycleMissionMatches: true,
  missionId: scope.missionId, cycleId: scope.cycleId };

function frame(identity = scope) {
  return { snapshot: { configuration: { project: { activeProject: {
    operationIdentity: { projectId: identity.projectId, projectProfileHash: identity.projectProfileHash },
    profileGeneration: identity.profileGeneration,
  } } } } };
}

const selected = {
  schemaVersion: 'clue-cycle-findings/1', ...scope, outcome: 'SELECTED',
  reason: 'Highest eligible item under the recorded ranking.', evidenceSha256: a,
  screenedEvidenceSha256: b, rankingSha256: a, findingCount: 1, eventId: 'EVENT-012400',
  selected: { findingId: 'FIND-000001', unitId: 'unit-a', path: 'src/check.ts', line: 9,
    signalId: 'SIG-001', signalName: 'Cold recognition', reason: '<b>Measured selection</b>' },
};

function harness(read) {
  const content = new Element();
  const button = new Element();
  const root = { querySelector: (selector) => selector.endsWith('content') ? content : button,
    ownerDocument: { createElement: () => new Element() } };
  return { ...mountQ4Findings({ root, read }), content, button };
}

test('the Findings action reads one fixed route without a body or mutation', async () => {
  assert.equal(DASHBOARD_ACTIONS.readCurrentFindings.mutating, false);
  const sent = [];
  const client = createActionClient({ allowMutating: false, request: async (request) => { sent.push(request); return null; } });
  assert.equal((await client.invoke('readCurrentFindings')).ok, true);
  assert.deepEqual(sent, [{ method: 'GET', path: '/api/findings/current' }]);
});

test('the Q4 panel renders selected evidence for the exact screened scope as literal text', async () => {
  let reads = 0;
  const ui = harness(async () => { reads += 1; return selected; });
  ui.observe(run, frame());
  await settle();
  assert.match(ui.content.textContent, /Selected FIND-000001 · src\/check.ts:9/);
  assert.match(ui.content.textContent, /SIG-001 Cold recognition · <b>Measured selection<\/b>/);
  assert.match(ui.content.textContent, /clue1 · generation 9 · MISSION-000009 · CYCLE-000008/);
  assert.match(ui.content.textContent, /EVENT-012400/);
  assert.ok(ui.content.textContent.includes(a) && ui.content.textContent.includes(b));
  ui.observe(run, frame());
  assert.equal(reads, 1);
  ui.button.refresh();
  await settle();
  assert.equal(reads, 2);
});

test('the Q4 panel distinguishes an absent receipt from a recorded no-candidate outcome', async () => {
  let result = null;
  const ui = harness(async () => result);
  ui.observe(run, frame());
  await settle();
  assert.match(ui.content.textContent, /No findings decision recorded/);
  result = { ...selected, outcome: 'NO_CANDIDATE', selected: null, findingCount: 0, reason: 'No measured signal met the eligibility rules.' };
  ui.button.refresh();
  await settle();
  assert.match(ui.content.textContent, /No candidate selected. No measured signal/);
});

test('the Q4 panel clears stale evidence across scope transitions even if the fetch ignores abort', async () => {
  const requests = [];
  const ui = harness(({ signal }) => new Promise((resolve) => { requests.push({ resolve, signal }); }));
  ui.observe(run, frame());
  const changed = { ...scope, projectProfileHash: `profile:v1:${b}`, profileGeneration: 10 };
  ui.observe(run, frame(changed));
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(selected);
  requests[1].resolve(selected);
  await settle();
  assert.match(ui.content.textContent, /unavailable/);
  assert.doesNotMatch(ui.content.textContent, /FIND-000001/);
  ui.observe({ ...run, cycleStage: 'CLOSED' }, frame(changed));
  assert.match(ui.content.textContent, /Awaiting a screened cycle/);
  assert.equal(ui.button.disabled, true);
});
