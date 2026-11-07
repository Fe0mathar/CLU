import assert from 'node:assert/strict';
import test from 'node:test';
import { mountQuadrantStatus } from '../quadrants/statusPresentation.js';
import { createSelectionBus } from '../state/selectionBus.js';
import { createStatusStore } from '../state/statusStore.js';

test('dashboard quadrants label the actual Status branches and update on refresh', async (t) => {
  const version = { schemaVersion: '5.8.0' };
  let body = {
    ...version,
    repositoryInventory: { fileCount: 445 },
    recognition: { filesRecognised: 219 },
    improvementField: { cells: Array(100).fill(null) },
    goldenMetrics: { projectionState: 'UNAVAILABLE' },
    gauges: { state: 'unavailable', reason: 'No sealed gauge projection' },
    operationalConsole: { events: [] },
  };
  const store = createStatusStore({ fetchJson: async (path) => path.endsWith('/schema') ? version : body });
  const panels = Object.fromEntries(['q1', 'q2', 'q3', 'q4'].map((id) => [id, {
    dataset: {},
    labels: {},
    setAttribute(name, value) { this.labels[name] = value; },
  }]));
  const controllers = mountQuadrantStatus({ findPanel: (id) => panels[id], store, bus: createSelectionBus() });
  t.after(() => controllers.forEach((controller) => controller.unmount()));
  assert.equal(panels.q1.dataset.statusState, 'unavailable');
  await store.refresh();
  assert.deepEqual(Object.values(panels).map((panel) => panel.dataset.statusBranch), [
    'repositoryInventory', 'improvementField', 'gauges', 'operationalConsole',
  ]);
  assert.deepEqual(Object.values(panels).map((panel) => panel.dataset.statusState), [
    'value', 'value', 'unavailable', 'value',
  ]);
  assert.deepEqual(Object.values(panels).map((panel) => panel.labels['aria-label']), [
    'Q1: 445 files in Status inventory',
    'Q2: 100 metric cells',
    'Q3: UNAVAILABLE — No sealed gauge projection',
    'Q4: 0 console events in this snapshot',
  ]);

  body = {
    ...body,
    repositoryInventory: { fileCount: 0 },
    improvementField: { cells: null },
    gauges: { gauges: [{}, {}, {}, {}] },
    operationalConsole: { state: 'unknown', reason: 'Event readiness undetermined' },
  };
  await store.refresh();
  assert.deepEqual(Object.values(panels).map((panel) => panel.dataset.statusState), [
    'value', 'malformed', 'value', 'unknown',
  ]);
  assert.match(panels.q1.labels['aria-label'], /^Q1: 0 files/);
  assert.equal(panels.q3.labels['aria-label'], 'Q3: 4 gauge projections');
  assert.equal(panels.q4.labels['aria-label'], 'Q4: UNKNOWN — Event readiness undetermined');
});
