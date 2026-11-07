/**
 * `DEV-P1-16` — the Q1, Q2 and Q4 decision kernels.
 *
 * One file for the three because each kernel is small; the questions are the same shape as
 * Q3's — what does the panel claim, and does absence stay distinct from failure and from
 * deliberate exclusion.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { q1PanelDecision, Q1_PHASES } from '../quadrants/q1Navigator.js';
import { q2PanelDecision } from '../quadrants/q2Field.js';
import {
  WORK_CONTRACT_ROWS,
  feedEntries,
  semanticEventState,
  workContractRows,
} from '../quadrants/q4Console.js';

/* ------------------------------- Q2 ---------------------------------- */

const CELLS = [
  { measurementId: 'MH03', state: 'available' },
  { measurementId: 'MG08', state: 'stale' },
  { measurementId: 'MI12', state: 'pending' },
];

test('DEV-P1-16: Q2 counts what is on the field — available and stale, after exclusions', () => {
  const decision = q2PanelDecision({ cells: CELLS });

  // Stale counts: a labelled old answer is on the field, and labelled staleness is information.
  assert.equal(decision.active, 2);
  assert.equal(decision.state, 'live');
  assert.equal(decision.label, '2 ACTIVE PROVEN MEASURES');
  assert.equal(decision.pulse, true);

  const singular = q2PanelDecision({ cells: [CELLS[0]] });
  assert.equal(singular.label, '1 ACTIVE PROVEN MEASURE', 'grammar follows the count');
});

test('DEV-P1-16: Q2 keeps "all excluded" apart from "awaiting proof"', () => {
  const excluded = q2PanelDecision({ cells: CELLS }, new Set(['MH03', 'MG08', 'MI12']));
  // The operator set these aside; the engine did not fail to prove them. AWAITING PROOF here
  // would tell the operator the opposite of what they themselves did.
  assert.equal(excluded.state, 'warning');
  assert.equal(excluded.label, '3 MEASURES EXCLUDED');
  assert.equal(excluded.active, 0);

  const empty = q2PanelDecision({ cells: [] });
  assert.equal(empty.state, 'idle');
  assert.equal(empty.label, 'AWAITING PROOF');

  const unavailable = q2PanelDecision(null);
  assert.equal(unavailable.label, 'AWAITING PROOF');
  assert.equal(unavailable.excluded, 0);
});

/* ------------------------------- Q4 ---------------------------------- */

test('DEV-P1-16: the classifier tests failure before warning before success', () => {
  assert.equal(semanticEventState('validation failed'), 'critical');
  // "retry succeeded" is the case the order exists for: a retry is a reliability fact even when
  // it worked, so warning wins over success.
  assert.equal(semanticEventState('retry succeeded'), 'warning');
  assert.equal(semanticEventState('sealed'), 'success');
  assert.equal(semanticEventState('dispatching review'), 'active');
  assert.equal(semanticEventState('lorem ipsum'), 'neutral');
  assert.equal(semanticEventState(null), 'neutral', 'nothing is never guessed upward');
});

test('DEV-P1-16: the work contract shows all six §9.1 rows, absent fields as absent', () => {
  assert.equal(workContractRows(null), null, 'no contract is the honest idle state');

  const rows = workContractRows({ what: 'Close DEV-P1-16', whoModel: 'CLU-E' });
  assert.equal(rows.length, WORK_CONTRACT_ROWS.length);
  assert.deepEqual(
    rows.map((row) => row.key),
    ['WHAT', 'WHY', 'HOW-PROVEN', 'WHO / MODEL', 'CURRENT', 'NEXT'],
  );
  assert.equal(rows[0].value, 'Close DEV-P1-16');
  // A contract missing its HOW-PROVEN is a different and worse thing than one with it, and
  // dropping the row would hide exactly that.
  assert.equal(rows[2].value, null);
});

test('DEV-P1-16: the feed keeps the latest, newest first, and classifies each entry', () => {
  const events = Array.from({ length: 130 }, (_, index) => ({
    occurredAt: `2026-08-09T16:00:${String(index % 60).padStart(2, '0')}.000Z`,
    channel: 'PIPELINE',
    title: `event ${index}`,
    summary: { status: index === 129 ? 'failed' : 'ok' },
  }));

  const entries = feedEntries(events);
  assert.equal(entries.length, 120, 'the cap holds');
  assert.equal(entries[0].title, 'event 129', 'newest first');
  assert.equal(entries[0].state, 'critical');
  assert.equal(entries[1].state, 'success');
  assert.equal(entries[0].at, '16:00:09', 'row shows the time; the full stamp still travels');
  assert.equal(entries[0].occurredAt, '2026-08-09T16:00:09.000Z');

  assert.deepEqual(feedEntries([]), []);
  assert.deepEqual(feedEntries(null), []);
});

/* ------------------------------- Q1 ---------------------------------- */

test('DEV-P1-16: Q1 keeps awaiting apart from reconnecting', () => {
  const awaiting = q1PanelDecision('awaiting');
  const reconnecting = q1PanelDecision('reconnecting');

  // The first says "run a recognition"; the second says "the daemon dropped". Both used to
  // render as generic CONNECTING, which answers neither question.
  assert.equal(awaiting.label, 'AWAITING RECOGNITION');
  assert.equal(reconnecting.label, 'RECONNECTING');
  assert.equal(awaiting.state, reconnecting.state, 'both are visually connecting states');
  assert.notEqual(awaiting.streamText, reconnecting.streamText);
});

test('DEV-P1-16: every named Q1 phase decides, and an unnamed one is not healthy', () => {
  for (const phase of Q1_PHASES) {
    const decision = q1PanelDecision(phase);
    assert.ok(decision.state.length > 0 && decision.label.length > 0, phase);
  }
  const unknown = q1PanelDecision('warp');
  assert.equal(unknown.state, 'unavailable');
  assert.match(unknown.label, /UNKNOWN PHASE: warp/);
});
