import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGreatBookImprovementField } from '../src/analysis/metrics/improvementField/projection.js';
import { SAMPLE_GREAT_BOOK_CONTRIBUTIONS } from '../src/analysis/metrics/improvementField/sampleData.js';
import {
  ACTIVE_COORDINATES,
  CANONICAL_GRID_SIZE,
  METRIC_COORDINATES,
  coordinateForMetric,
} from '../src/shared/measurementCoordinates.js';

test('field projection preserves the canonical 10x10 coordinate system', () => {
  const field = buildGreatBookImprovementField({
    capturedAt: '2026-07-27T12:00:00.000Z',
    targetId: 'TGT-CLUE',
    cycleId: 'CYCLE-017',
    catalogueVersion: '3.0',
    catalogueHash: 'catalogue-hash',
    normalizationVersion: '1.0',
    normalizationHash: 'normalization-hash',
    aggregationMode: 'CURRENT_CERTIFIED',
    selectedMeasurementId: 'MC04',
    contributions: SAMPLE_GREAT_BOOK_CONTRIBUTIONS,
  });

  assert.equal(field.cells.length, 100);

  // DEV-P1-20: catalogue v6 activated the final four expansion cells, so the grid no longer holds
  // any reserved cell. The four new coordinates carry no v2 legacy alias.
  assert.equal(field.grid.reservedCells, 0);
  assert.equal(field.cells.filter((cell) => cell.state === 'reserved').length, 0);
  for (const [measurementId, gridIndex] of [
    ['MH03', 97],
    ['MG08', 98],
    ['MI12', 99],
    ['MK19', 100],
  ] as const) {
    const cell = field.cells.find((candidate) => candidate.measurementId === measurementId);
    assert.ok(cell, `${measurementId} occupies a canonical cell`);
    assert.equal(cell.x, ((gridIndex - 1) % 10) + 1);
    assert.equal(cell.y, Math.floor((gridIndex - 1) / 10) + 1);
    assert.notEqual(cell.state, 'reserved');
  }

  const coupling = field.cells.find((cell) => cell.measurementId === 'MC04');
  assert.ok(coupling);
  assert.equal(coupling.x, 7);
  assert.equal(coupling.y, 2);
  assert.equal(coupling.state, 'available');
  assert.equal(coupling.contributionCount, 1);
});

/* ------------------------------------------------------------------------- */
/* DEV-P1-20: exact v6 coordinate map and compile-time/runtime parity          */
/* ------------------------------------------------------------------------- */

test('DEV-P1-20: the grid holds 100 unique active v6 coordinates on unique cells', () => {
  assert.equal(METRIC_COORDINATES.length, CANONICAL_GRID_SIZE);
  assert.equal(ACTIVE_COORDINATES.length, CANONICAL_GRID_SIZE, 'every cell is active under v6');

  const ids = new Set(METRIC_COORDINATES.map((coordinate) => coordinate.measurementId));
  assert.equal(ids.size, CANONICAL_GRID_SIZE, 'canonical ids are unique');

  const cells = new Set(METRIC_COORDINATES.map((coordinate) => `${coordinate.x},${coordinate.y}`));
  assert.equal(cells.size, CANONICAL_GRID_SIZE, 'grid cells are unique');

  // Every id matches the M<Area><Ordinal> grammar, and x/y follow the documented derivation.
  for (const coordinate of METRIC_COORDINATES) {
    assert.match(coordinate.measurementId, /^M[A-K][0-9]{2}$/);
    assert.equal(coordinate.x, ((coordinate.gridIndex - 1) % 10) + 1);
    assert.equal(coordinate.y, Math.floor((coordinate.gridIndex - 1) / 10) + 1);
  }

  // The documented family allocation: 62 / 12 / 7 / 19 (CLUE_Interface_Design_v9 §10.2.2).
  const counts = new Map<string, number>();
  for (const coordinate of METRIC_COORDINATES) {
    counts.set(coordinate.family, (counts.get(coordinate.family) ?? 0) + 1);
  }
  assert.equal(counts.get('TARGET_QUALITY'), 62);
  assert.equal(counts.get('EVIDENCE_ASSURANCE'), 12);
  assert.equal(counts.get('ACCEPTANCE_GATES'), 7);
  assert.equal(counts.get('CLUE_SELF'), 19);
  assert.equal(counts.get('RESERVED'), undefined, 'no cell remains reserved under v6');
});

test('DEV-P1-20: v6 activation shifted no historic coordinate and added no legacy alias', () => {
  // Cells 1-96 keep their canonical id, cell and legacy alias: no completed record is renumbered.
  const spotChecks = [
    { gridIndex: 1, measurementId: 'MA01', legacyId: 'Q01', x: 1, y: 1 },
    { gridIndex: 60, measurementId: 'MH02', legacyId: 'Q60', x: 10, y: 6 },
    { gridIndex: 96, measurementId: 'MK18', legacyId: 'S18', x: 6, y: 10 },
  ] as const;
  for (const expected of spotChecks) {
    const coordinate = METRIC_COORDINATES[expected.gridIndex - 1];
    assert.ok(coordinate);
    assert.equal(coordinate.measurementId, expected.measurementId);
    assert.equal(coordinate.legacyId, expected.legacyId);
    assert.equal(coordinate.x, expected.x);
    assert.equal(coordinate.y, expected.y);
  }

  // Every legacy alias is unique, and the four v6 activations deliberately carry none.
  const aliases = METRIC_COORDINATES.map((coordinate) => coordinate.legacyId).filter(
    (alias): alias is string => alias !== null,
  );
  assert.equal(aliases.length, 96, 'exactly the 96 historic cells carry a legacy alias');
  assert.equal(new Set(aliases).size, 96, 'legacy aliases are unique');

  for (const measurementId of ['MH03', 'MG08', 'MI12', 'MK19'] as const) {
    const coordinate = coordinateForMetric(measurementId);
    assert.ok(coordinate, `${measurementId} resolves`);
    assert.equal(coordinate.legacyId, null, `${measurementId} has no v2 legacy alias`);
    assert.notEqual(coordinate.area, null);
  }

  // The activated cells land exactly where the catalogue puts them.
  assert.equal(coordinateForMetric('MH03')?.gridIndex, 97);
  assert.equal(coordinateForMetric('MG08')?.gridIndex, 98);
  assert.equal(coordinateForMetric('MI12')?.gridIndex, 99);
  assert.equal(coordinateForMetric('MK19')?.gridIndex, 100);
});
