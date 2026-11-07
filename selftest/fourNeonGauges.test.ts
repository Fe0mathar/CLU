import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFourNeonGauges } from '../src/analysis/metrics/gauges/projection.js';
import { DEFAULT_GAUGE_DEFINITIONS, SAMPLE_GAUGE_READINGS } from '../src/analysis/metrics/gauges/sampleData.js';
import { emptyFourNeonGauges, parseFourNeonGauges } from '../src/ui/fourNeonGauges.js';

test('gauge projection contains exactly four distinct slots', () => {
  const projection = buildFourNeonGauges({
    capturedAt: '2026-07-27T12:00:00.000Z',
    configurationHash: 'gauge-config-hash',
    definitions: DEFAULT_GAUGE_DEFINITIONS,
    readings: SAMPLE_GAUGE_READINGS,
  });
  assert.equal(projection.gauges.length, 4);
  assert.deepEqual(projection.gauges.map((gauge) => gauge.slot), [1, 2, 3, 4]);
  assert.equal(projection.gauges[2].gateState, 'PASS');
  assert.equal(projection.gauges[2].dialPosition, 1);
  assert.doesNotThrow(() => parseFourNeonGauges(projection));
});

test('empty gauges state unknown instead of fabricating zero', () => {
  const projection = emptyFourNeonGauges('2026-07-27T12:00:00.000Z');
  for (const gauge of projection.gauges) {
    assert.equal(gauge.normalizedValue, null);
    assert.equal(gauge.dialPosition, null);
    assert.equal(gauge.availability, 'unknown');
  }
});
