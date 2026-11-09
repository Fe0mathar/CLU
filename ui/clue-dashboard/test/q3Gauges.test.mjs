/**
 * `DEV-P1-16` — Q3's four gauge areas.
 *
 * Every one of these questions was unaskable while `deriveTelemetry` lived inside a 6000-line
 * IIFE: it could be called by nothing but the canvas that drew its output, so the only way to see
 * what a gauge showed for a given snapshot was to produce that snapshot in a running daemon and
 * look at the screen.
 *
 * The rule under test throughout is the one the original carried as a comment on area D — *honest
 * 'unknown' (flatline) where a signal is genuinely absent, never a fabricated pulse.* A comment
 * above a calculation holds only for as long as everyone editing the calculation keeps reading it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveTelemetry } from '../quadrants/q3Gauges.js';

/** A snapshot carrying only what the test names. */
function snapshot(dashboard, seal) {
  return { dashboard, ...(seal === undefined ? {} : { seal }) };
}

test('DEV-P1-16: an empty snapshot flatlines every area rather than reading zero', () => {
  const out = deriveTelemetry(snapshot({}));

  // Null is the flatline: the gauge has no reading. A reading of zero is a different claim, and
  // one an operator would act on.
  assert.deepEqual(out, { ai: null, cycle: null, gain: null, health: { ...out.health } });
  assert.equal(out.ai, null);
  assert.equal(out.cycle, null);
  assert.equal(out.gain, null);
});

test('DEV-P1-16: health reports NO SIGNAL when nothing is known, not full marks', () => {
  const out = deriveTelemetry(snapshot({}));

  // The score starts at 100 and is decremented by faults. With no subsystem reporting, a naive
  // reading is a perfect 100 — a fabricated pulse, and the most dangerous possible default.
  assert.equal(out.health.value, null);
  assert.equal(out.health.status, 'NO SIGNAL');
  assert.equal(out.health.big, '\u2014');
  for (const vital of out.health.raw.vitals) {
    assert.equal(vital.status, 'unknown', `${vital.key} has no signal`);
  }
});

test('DEV-P1-16: a broken seal is critical, and its reason is stated', () => {
  const out = deriveTelemetry(
    snapshot({ pipeline: { stages: [{ state: 'ok' }] } }, { consistent: false }),
  );

  assert.equal(out.health.raw.vitals.find((v) => v.key === 'seal').status, 'crit');
  assert.match(out.health.warn, /seal inconsistent/);
  assert.ok(out.health.value < 100);
});

test('DEV-P1-16: a present-but-quiet AI gateway is STANDBY, and says why', () => {
  const out = deriveTelemetry(
    snapshot({ sessions: { calls: { limit: 100, remaining: 100, thisCycle: 0, inFlight: 0 } } }),
  );

  // Standby and offline are different from absent, and all three are different from busy.
  assert.equal(out.ai.status, 'STANDBY');
  assert.match(out.ai.warn, /No observed gateway call traffic/);
});

test('sealed gateway counts show a reading without inventing provider capacity', () => {
  const aiOrchestration = {
    configured: true, provider: 'openai', enabled: true, operationallyReady: true,
    effectiveModel: 'gpt-5.6-sol', calls: { submitted: 2, completed: 1, pending: 1 },
    usage: { totalTokens: 129, providerRemainingTokens: 500, providerRemainingTokensAuthoritative: false },
  };
  const live = deriveTelemetry(snapshot({ aiOrchestration })).ai;
  assert.equal(live.status, 'LIVE');
  assert.equal(live.big, '129');
  assert.equal(live.bigUnit, 'tok');
  assert.equal(live.value, null);
  assert.equal(live.raw.provider.remainingTokens, null);
  assert.ok(live.lines.some(([label, value]) => label === 'tokens left' && value === 'provider n/a'));

  const budgetPause = deriveTelemetry(snapshot({ aiOrchestration: {
    ...aiOrchestration, providerPaused: true, providerBudgetExhausted: true,
  } })).ai;
  assert.equal(budgetPause.big, 'LACK OF $');
  assert.equal(budgetPause.critical, true);
  assert.equal(budgetPause.value, null);
});

test('sealed missing gateway is distinct from disabled or idle', () => {
  const result = deriveTelemetry(snapshot({
    sessions: { calls: { thisCycle: 0 } },
    aiOrchestration: { state: 'unavailable', reason: 'Gateway policy could not be read' },
  }));
  assert.equal(result.ai.status, 'UNAVAILABLE');
  assert.equal(result.ai.big, '—');
  assert.equal(result.ai.warn, 'Gateway policy could not be read');
});

test('sealed cycle stage replaces the legacy synthetic completion percentage', () => {
  const result = deriveTelemetry(snapshot({
    progress: { recognition: 100, proven_improvement: 100 },
    cycle: { current: { id: 'CYCLE-000001', stage: 'SCREENED', grade: 'diagnostic' }, lastClosure: null },
  }));
  assert.equal(result.cycle.big, 'SCREENED');
  assert.equal(result.cycle.value, null);
  assert.equal(result.cycle.raw.cycleNum, 'CYCLE-000001');
  assert.deepEqual(result.cycle.raw.phases.map(({ value }) => value), [100, null, null, null, null]);
});

test('DEV-P1-16: cycle progress is the mean of five phases, and IDLE at zero', () => {
  const idle = deriveTelemetry(snapshot({ progress: { recognition: 0 } }));
  assert.equal(idle.cycle.status, 'IDLE');
  assert.equal(idle.cycle.value, 0);

  const partway = deriveTelemetry(
    snapshot({ progress: { recognition: 100, deep_review: 100, proven_improvement: 0 } }),
  );
  assert.equal(partway.cycle.value, 40, 'two of five phases complete');
  assert.equal(partway.cycle.status, 'IN CYCLE');
});

test('DEV-P1-16: with no proven improvement the gain dial does not move, and says so', () => {
  const out = deriveTelemetry(snapshot({ improvementField: { cells: [] } }));

  assert.equal(out.gain.value, null);
  assert.equal(out.gain.status, 'AWAITING PROOF');
  // This is `OBJ-002` rendered on a dial: no claim of improvement without admissible proof.
  assert.match(out.gain.warn, /the dial moves only on evidence/);
});

test('DEV-P1-16: excluding every measured improvement is its own state, not emptiness', () => {
  const cells = [
    { measurementId: 'MH03', state: 'available', netContribution: 12, familyColor: '#39ff88' },
    { measurementId: 'MG08', state: 'available', netContribution: -4, familyColor: '#39ff88' },
  ];

  const counted = deriveTelemetry(snapshot({ improvementField: { cells } }), new Set());
  assert.equal(counted.status, undefined);
  assert.equal(counted.gain.status, 'GAINING');
  assert.equal(counted.gain.raw.net, 8);

  const allExcluded = deriveTelemetry(
    snapshot({ improvementField: { cells } }),
    new Set(['MH03', 'MG08']),
  );
  // "The operator excluded everything" and "nothing has been proven" are different facts, and an
  // operator seeing the second when the first is true would draw the wrong conclusion.
  assert.equal(allExcluded.gain.status, 'ALL EXCLUDED');
  assert.match(allExcluded.gain.warn, /excluded from this cycle/);
  assert.equal(allExcluded.gain.value, null);
});

test('DEV-P1-16: a net regression is reported as regressing, not hidden', () => {
  const out = deriveTelemetry(
    snapshot({
      improvementField: {
        cells: [{ measurementId: 'MI12', state: 'available', netContribution: -30 }],
      },
    }),
  );

  assert.equal(out.gain.status, 'REGRESSING');
  assert.equal(out.gain.raw.net, -30);
});

test('DEV-P1-16: the function is total — same inputs, same output, no globals', () => {
  const frame = snapshot({
    progress: { recognition: 50 },
    improvementField: { cells: [{ measurementId: 'MH03', state: 'available', netContribution: 5 }] },
  });

  const first = JSON.stringify(deriveTelemetry(frame, new Set()));
  const second = JSON.stringify(deriveTelemetry(frame, new Set()));
  assert.equal(first, second);

  // Taking the exclusions as a parameter is what makes the state above reachable at all: the
  // original read `window.__q2Field` and `localStorage`, neither of which exists here.
  assert.doesNotThrow(() => deriveTelemetry(frame));
});
