import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evidenceAdjustedContribution,
  normalizeCategorical,
  normalizeNumericDelta,
} from '../src/analysis/metrics/improvementField/normalization.js';

test('numeric normalization preserves gray area and direction', () => {
  const higher = {
    kind: 'numeric' as const,
    direction: 'higher_is_better' as const,
    grayArea: 3,
    meaningful: 8,
    exceptional: 20,
  };
  assert.equal(normalizeNumericDelta(2.9, higher), 0);
  assert.ok(normalizeNumericDelta(10, higher) > 60);
  assert.ok(normalizeNumericDelta(-10, higher) < -60);

  const lower = { ...higher, direction: 'lower_is_better' as const };
  assert.ok(normalizeNumericDelta(-10, lower) > 60);
});

test('categorical normalization never invents an unmapped value', () => {
  const profile = { kind: 'categorical' as const, values: { PASS: 100, WARNING: -20, FAIL: -100 } };
  assert.equal(normalizeCategorical('PASS', profile), 100);
  assert.equal(normalizeCategorical('UNKNOWN', profile), null);
});

test('evidence adjustment reduces weak or stale contributions', () => {
  assert.equal(evidenceAdjustedContribution({ magnitude: 100, confidence: 1, freshness: 1, coverage: 1 }), 100);
  assert.equal(evidenceAdjustedContribution({ magnitude: 100, confidence: 0.5, freshness: 0.5, coverage: 0.5 }), 12.5);
});
