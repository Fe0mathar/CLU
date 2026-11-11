/** P2 B6 — the dashboard Proof Board is a strict renderer over durable server rows. */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROOF_BOARD_VIEW_SCHEMA,
  mountProofBoard,
  normalizeProofBoard,
  renderProofBoard,
} from '../workspaces/proofBoard.js';

const H = (character) => character.repeat(64);
const AT = '2026-08-14T05:00:00.000Z';

function fixture() {
  return {
    schemaVersion: PROOF_BOARD_VIEW_SCHEMA,
    generatedAt: AT,
    targetId: 'clu',
    missionVersionId: 'MISSION-000014',
    projection: {
      schemaVersion: 8,
      lastSequence: 23,
      headHash: H('a'),
    },
    registeredBenchmark: {
      state: 'registered',
      path: 'targets/clu/benchmark/master-benchmark.md',
      sha256: H('b'),
      benchmarkId: 'clu-master',
      benchmarkVersion: '0.1.0',
      runnerAdapter: 'cli-node',
      harnessId: 'HRN-001',
      integritySha256: H('c'),
      integrityVerified: true,
      reason: null,
    },
    summary: {
      benchmarkRuns: 1,
      proofAttempts: 1,
      accepts: 1,
      rejects: 0,
      revises: 0,
      invalids: 0,
      refusals: 0,
      openAttempts: 0,
      latestBenchmarkEventId: 'EVENT-000020',
      latestVerdictEventId: 'EVENT-000023',
    },
    benchmarkRuns: [{
      eventId: 'EVENT-000020',
      sequence: 20,
      recordedAt: AT,
      missionVersion: 'MISSION-000014',
      snapshotId: H('d'),
      registered: true,
      benchmarkId: 'clu-master',
      benchmarkVersion: '0.1.0',
      blockId: 'HRN-001',
      runnerAdapter: 'cli-node',
      contractSha256: H('b'),
      integritySha256: H('c'),
      resultArtifactHash: H('e'),
      unifiedScore: 91.25,
      measuresCount: 13,
      incompleteCount: 0,
      protective: [{ id: 'SIG-GUARD', value: 497 }],
      startedAt: AT,
      finishedAt: '2026-08-14T05:00:01.000Z',
      wallMs: 1000,
      budgetExhausted: false,
    }],
    proofAttempts: [{
      cycleId: 'CYCLE-000014',
      missionVersion: 'MISSION-000014',
      targetId: 'clu',
      contractHash: H('f'),
      hypothesisId: 'HYP-B6-000001',
      snapshotId: H('d'),
      contractArtifactHash: H('1'),
      frozenAt: AT,
      contract: {
        eventId: 'EVENT-000021',
        sequence: 21,
        recordedAt: AT,
      },
      baseline: {
        eventId: 'EVENT-000022',
        sequence: 22,
        recordedAt: AT,
        digest: H('2'),
        sourceBenchmarkEventId: 'EVENT-000020',
        runArtifactHash: H('e'),
        reused: true,
      },
      refusal: null,
      verdict: {
        eventId: 'EVENT-000023',
        sequence: 23,
        recordedAt: AT,
        disposition: 'ACCEPT',
        improvement: true,
        reasons: ['success threshold met; every mandatory gate held'],
        deltas: [{
          measure_id: 'SIG-COST',
          direction: 'lower_is_better',
          baseline: 100,
          candidate: 80,
          delta_pct: 20,
        }],
        baselineDigest: H('2'),
        candidateDigest: H('3'),
        candidateSnapshotId: H('4'),
        patchDigest: H('5'),
        verdictArtifactHash: H('6'),
        greatBookState: 'recorded',
        greatBookEntryId: 'GBE-000001',
      },
      state: 'verdict_recorded',
    }],
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test('Proof Board clears project history and ignores a late response after activation', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => ({}) };
  try {
    const button = Object.assign(new EventTarget(), { dataset: {} });
    const overlay = {
      body: { innerHTML: '', querySelector: () => null },
      setSub() {},
    };
    let activeProject = 'clu';
    let switching = false;
    const pending = [];
    const board = mountProofBoard({
      overlayUi: { panelButton: () => button, makeOverlay: () => overlay, esc: String },
      fetchJson: () => new Promise((resolve) => pending.push(resolve)),
      activeProjectId: () => activeProject,
      isProjectTransition: () => switching,
    });

    const first = board.refresh();
    pending.shift()(fixture());
    await first;
    assert.equal(button.dataset.proofState, 'accepted');

    const late = board.refresh();
    const resolveLate = pending.shift();
    switching = true;
    board.invalidate();
    assert.equal(board.current, null);
    assert.equal(button.dataset.proofState, undefined);
    assert.match(overlay.body.innerHTML, /Awaiting active project proof history/u);
    await board.refresh();
    assert.equal(pending.length, 0);

    activeProject = 'fixture-b';
    switching = false;
    const successor = board.refresh();
    const nextBoard = fixture();
    nextBoard.targetId = activeProject;
    nextBoard.proofAttempts[0].targetId = activeProject;
    pending.shift()(nextBoard);
    await successor;
    resolveLate(fixture());
    await late;
    assert.equal(board.current.targetId, activeProject);
    assert.match(overlay.body.innerHTML, /class="pb-board" data-target-id="fixture-b"/u);

    const wrongScope = board.refresh();
    pending.shift()(fixture());
    await wrongScope;
    assert.equal(board.current, null);
    assert.equal(button.dataset.proofState, 'unavailable');
    assert.match(overlay.body.innerHTML, /does not belong to the active project/u);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('P2-B6 UI: a valid durable board normalizes and renders exact identities', () => {
  const view = normalizeProofBoard(fixture());
  assert.equal(view.summary.accepts, 1);
  assert.equal(view.proofAttempts[0].verdict.disposition, 'ACCEPT');
  const html = renderProofBoard(view);
  assert.match(html, /ACCEPT/);
  assert.match(html, /EVENT-000023/);
  assert.match(html, /GBE-000001/);
  assert.match(html, /clu-master · 0\.1\.0/);
  assert.match(html, /verdicts are displayed, never calculated in this browser/);
});

test('P2-B6 UI: a positive-looking delta cannot cause the browser to upgrade a recorded REJECT', () => {
  const raw = clone(fixture());
  raw.proofAttempts[0].verdict.disposition = 'REJECT';
  raw.proofAttempts[0].verdict.improvement = false;
  raw.proofAttempts[0].verdict.reasons = ['recorded rejection despite a local positive delta'];
  raw.proofAttempts[0].verdict.greatBookState = 'not_recorded';
  raw.proofAttempts[0].verdict.greatBookEntryId = null;
  raw.summary.accepts = 0;
  raw.summary.rejects = 1;
  const view = normalizeProofBoard(raw);
  const html = renderProofBoard(view);
  assert.equal(view.proofAttempts[0].verdict.disposition, 'REJECT');
  assert.match(html, /data-disposition="REJECT"/);
  assert.match(html, />REJECT</);
  assert.doesNotMatch(html, /data-disposition="ACCEPT"/);
});

test('P2-B6 UI: server summary drift is refused rather than papered over', () => {
  const raw = clone(fixture());
  raw.summary.accepts = 0;
  assert.throws(() => normalizeProofBoard(raw), /summary\.accepts does not agree/);
});

test('P2-B6 UI: terminal proof state without a durable baseline is refused', () => {
  const raw = clone(fixture());
  raw.proofAttempts[0].baseline = null;
  assert.throws(() => normalizeProofBoard(raw), /terminal event without baseline/);
});

test('P2-B6 UI: branch state must agree with the events present', () => {
  const raw = clone(fixture());
  raw.proofAttempts[0].state = 'frozen';
  assert.throws(() => normalizeProofBoard(raw), /state does not agree with durable events/);
});

test('P2-B6 UI: duplicate durable event identities are refused', () => {
  const raw = clone(fixture());
  raw.proofAttempts[0].contract.eventId = raw.benchmarkRuns[0].eventId;
  assert.throws(() => normalizeProofBoard(raw), /duplicate event identities/);
});

test('P2-B6 UI: evidence text is escaped before it enters the overlay', () => {
  const raw = clone(fixture());
  raw.proofAttempts[0].verdict.reasons = ['<img src=x onerror=alert(1)>'];
  const html = renderProofBoard(normalizeProofBoard(raw));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
