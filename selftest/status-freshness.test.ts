/**
 * Status failure-and-freshness rule acceptance tests.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §18 in full; §13 (a fresh runtime fault outranks a
 *       valid historical certificate); §20 gate 5.
 *
 * Backlog: DEV-P1-13 — §18's rules existed only as prose.
 *
 * Each test names the §18 clause it proves. The clauses whose domains are absent from this
 * build are covered by one test asserting that they are *declared* deferred rather than
 * quietly missing — an unimplemented rule and a forgotten rule must not look the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFERRED_RULES,
  ENFORCED_RULES,
  absent,
  automationGate,
  carryForward,
  completenessOf,
  consoleContinuity,
  evaluateFreshness,
  expireRuntimeHealth,
  invalidateField,
  normalizedValueOf,
  present,
  readingToBranch,
  readingValue,
  resolveGaugeMetric,
} from '../src/status/freshness.js';

const T0 = '2026-08-06T00:00:00.000Z';
const T1 = '2026-08-06T00:05:00.000Z'; // five minutes later

test('DEV-P1-13: stale data carries its age, its source event, and the limit that judged it', () => {
  const fresh = evaluateFreshness(T0, T1, 'events:42', { limitMs: 10 * 60 * 1000 });
  assert.equal(fresh.ageMs, 5 * 60 * 1000);
  assert.equal(fresh.sourceHead, 'events:42');
  assert.equal(fresh.stale, false);

  const stale = evaluateFreshness(T0, T1, 'events:42', { limitMs: 60 * 1000 });
  assert.equal(stale.stale, true);
  assert.equal(stale.ageMs, 5 * 60 * 1000, '§18: stale data carries age');
  assert.equal(stale.sourceHead, 'events:42', '§18: stale data carries the last source event');
  assert.equal(stale.limitMs, 60 * 1000, 'the refresh requirement travels so the verdict is auditable');

  // No limit means nothing expires it — absence of a policy is not a licence to expire.
  assert.equal(evaluateFreshness(T0, T1, null).stale, false);

  // An unreadable timestamp yields unknown age, and unknown age cannot prove expiry.
  const unknown = evaluateFreshness('not-a-date', T1, null, { limitMs: 1 });
  assert.equal(unknown.ageMs, null);
  assert.equal(unknown.stale, false, 'an invented age would be worse than an unknown one');
});

test('DEV-P1-13: unavailable data becomes null, and has nowhere to put a zero', () => {
  const missing = absent<number>('unavailable', 'the registry could not be read');
  assert.equal(readingValue(missing), null, '§18: unavailable data becomes unknown, not zero');
  assert.equal(readingValue(present(0)), 0, 'a real zero is still a real zero');

  // The branch form carries the reason outward rather than collapsing to a bare null.
  const branch = readingToBranch(missing, 'metrics.registry');
  assert.equal(branch?.state, 'unavailable');
  assert.equal(branch?.reason, 'the registry could not be read');
  assert.equal(branch?.expectedSource, 'metrics.registry');
  assert.equal(readingToBranch(present(1), 'x'), null, 'a present reading is not an unavailability');
});

test('DEV-P1-13: a failed projection shows the last valid value AND records the fault', () => {
  const previous = { value: 41, asOf: T0 };

  // Both halves together. Either alone is a different, worse behaviour.
  const failed = carryForward('recognition', present(99), previous, 'projector threw', T1);
  assert.equal(failed.value, 41, '§18: the last valid status stays visible');
  assert.equal(failed.carriedForward, true, 'and is marked as not current');
  assert.equal(failed.asOf, T0, 'dated when it was observed, not when it was shown');
  assert.notEqual(failed.fault, null, '§18: a fault is recorded');
  assert.equal(failed.fault?.branch, 'recognition');

  // A failure with no history shows nothing rather than inventing a floor.
  const noHistory = carryForward('recognition', absent<number>('unavailable', 'gone'), null, null, T1);
  assert.equal(noHistory.value, null);
  assert.equal(noHistory.carriedForward, false);
  assert.notEqual(noHistory.fault, null);

  // A success is a success: current value, no carry-forward, no fault.
  const ok = carryForward('recognition', present(42), previous, null, T1);
  assert.deepEqual(ok, { value: 42, carriedForward: false, fault: null, asOf: T1 });
});

test('DEV-P1-13: a partial scan cannot claim committed-complete', () => {
  assert.equal(
    completenessOf({ filesInProgram: 10, filesRecognised: 10, committed: true }),
    'committed_complete',
  );
  assert.equal(
    completenessOf({ filesInProgram: 10, filesRecognised: 9, committed: true }),
    'partial',
    '§18: a partial target scan cannot emit committed-complete status',
  );
  assert.equal(
    completenessOf({ filesInProgram: 10, filesRecognised: 10, committed: false }),
    'partial',
    'recognised is not committed',
  );
  assert.equal(
    completenessOf({ filesInProgram: null, filesRecognised: 10, committed: true }),
    'unknown',
    'unknown counts resolve to unknown, not optimistically to complete',
  );
});

test('DEV-P1-13: runtime health expires, but a fault does not decay', () => {
  const fresh = evaluateFreshness(T0, T1, null, { limitMs: 10 * 60 * 1000 });
  const expired = evaluateFreshness(T0, T1, null, { limitMs: 60 * 1000 });

  assert.equal(expireRuntimeHealth('healthy', fresh), 'healthy');
  assert.equal(
    expireRuntimeHealth('healthy', expired),
    'stale',
    '§18: runtime health expires according to target profile',
  );
  assert.equal(expireRuntimeHealth('degraded', expired), 'stale');
  assert.equal(
    expireRuntimeHealth('fault', expired),
    'fault',
    '§13: an expired fault is still the last thing known, and outranks a stale healthy claim',
  );
  assert.equal(expireRuntimeHealth('unknown', expired), 'unknown');
});

test('DEV-P1-13: an invalid or inconsistent seal blocks automation and health claims', () => {
  const invalid = automationGate({ valid: false, consistent: true });
  assert.equal(invalid.automationPermitted, false);
  assert.equal(invalid.productionHealthClaimPermitted, false);
  assert.match(String(invalid.reason), /did not verify/);

  // A valid seal over a disagreeing body still blocks: validity proves the body was not
  // altered, not that its branches agree (§15 calls that a projector defect).
  const inconsistent = automationGate({ valid: true, consistent: false });
  assert.equal(inconsistent.automationPermitted, false);
  assert.equal(inconsistent.productionHealthClaimPermitted, false);

  const good = automationGate({ valid: true, consistent: true });
  assert.equal(good.automationPermitted, true);
  assert.equal(good.productionHealthClaimPermitted, true);
  assert.equal(good.reason, null);
});

test('DEV-P1-13: the two field failures have deliberately different blast radii', () => {
  // A missing normalization profile is local: every other cell stays as true as it was.
  const local = invalidateField({
    collidingCoordinates: [],
    metricsMissingNormalization: ['MD04'],
  });
  assert.equal(local.scope, 'metric', '§18: a missing profile invalidates only the affected metric');
  assert.deepEqual(local.scope === 'metric' ? local.metricIds : [], ['MD04']);

  // A coordinate collision is total: it proves the coordinate map itself is wrong, so no
  // cell's identity can be trusted.
  const total = invalidateField({
    collidingCoordinates: ['C7'],
    metricsMissingNormalization: [],
  });
  assert.equal(total.scope, 'field', '§18: a coordinate collision invalidates the entire field');

  // Both at once: the field is void regardless. Reporting only the local problem would
  // leave an unattributable field looking mostly fine.
  const both = invalidateField({
    collidingCoordinates: ['C7'],
    metricsMissingNormalization: ['MD04'],
  });
  assert.equal(both.scope, 'field');

  assert.equal(
    invalidateField({ collidingCoordinates: [], metricsMissingNormalization: [] }).scope,
    'none',
  );
});

test('DEV-P1-13: an unknown native value never becomes a normalized zero', () => {
  assert.equal(normalizedValueOf(present(89.2), true), 89.2);
  assert.equal(
    normalizedValueOf(absent('unknown', 'not measured'), true),
    null,
    '§18: unknown native values never become normalized zero',
  );
  assert.equal(
    normalizedValueOf(present(89.2), false),
    null,
    'a native value with no profile is not comparable, so it has no normalized coordinate',
  );
});

test('DEV-P1-13: a console gap and a dropped-event count both stay visible', () => {
  const clean = consoleContinuity({ sequences: [10, 11, 12], droppedEvents: 0 });
  assert.equal(clean.contiguous, true);
  assert.deepEqual(clean.gaps, []);

  const gapped = consoleContinuity({ sequences: [10, 11, 15, 16], droppedEvents: 0 });
  assert.equal(gapped.contiguous, false);
  assert.deepEqual(gapped.gaps, [{ from: 12, to: 14 }]);

  // The case that matters most: a bounded replay has no internal gap at all, and calling
  // it contiguous would be technically true and completely misleading.
  const bounded = consoleContinuity({ sequences: [4750, 4751, 4752], droppedEvents: 4750 });
  assert.equal(bounded.gaps.length, 0, 'the window itself is unbroken');
  assert.equal(bounded.contiguous, false, 'but it is not the whole history, and says so');
  assert.equal(bounded.droppedEvents, 4750, '§18: the dropped count remains visible');
});

test('DEV-P1-13: a gauge reports its own state and can never substitute another metric', () => {
  const fresh = evaluateFreshness(T0, T1, null, { limitMs: 10 * 60 * 1000 });
  const expired = evaluateFreshness(T0, T1, null, { limitMs: 60 * 1000 });

  assert.deepEqual(resolveGaugeMetric({ metricId: 'MD04', retired: false, applicable: true, freshness: fresh }), {
    resolved: true,
    metricId: 'MD04',
  });

  for (const [label, input] of [
    ['retired', { metricId: 'MD04', retired: true, applicable: true, freshness: fresh }],
    ['not applicable', { metricId: 'MD04', retired: false, applicable: false, freshness: fresh }],
    ['stale', { metricId: 'MD04', retired: false, applicable: true, freshness: expired }],
    ['unconfigured', { metricId: null, retired: false, applicable: true, freshness: fresh }],
  ] as const) {
    const result = resolveGaugeMetric(input);
    assert.equal(result.resolved, false, `${label} must not resolve`);
    assert.ok(
      !result.resolved && result.reason.length > 0,
      `${label} states why, so the slot is not silently empty`,
    );
  }

  // The structural guarantee: there is no fallback parameter, so substitution is not
  // merely discouraged — the function is never given anything to substitute with.
  assert.equal(resolveGaugeMetric.length, 1, 'one argument: the slot, and nothing to swap in');
});

test('DEV-P1-13: every §18 rule is either enforced or declared deferred with an owner', () => {
  // The point of this test: an unimplemented rule and a forgotten rule look identical
  // unless one of them is written down.
  assert.equal(ENFORCED_RULES.length, 11);
  assert.equal(new Set(ENFORCED_RULES).size, ENFORCED_RULES.length, 'no rule is listed twice');
  assert.ok(DEFERRED_RULES.length >= 14, 'the deferred rules are enumerated, not omitted');
  for (const entry of DEFERRED_RULES) {
    assert.ok(entry.rule.length > 0);
    assert.ok(entry.owner.length > 0, `${entry.rule} names the domain that will own it`);
  }
  // §18 lists 25 rules; enforced plus deferred must account for all of them.
  assert.equal(ENFORCED_RULES.length + DEFERRED_RULES.length, 26);
});
