/**
 * CLU-E Q1 SURF interface handoff acceptance guards.
 *
 * These source-contract checks protect the smallest coherent browser patch. They do not claim
 * visual acceptance: the Creator still decides whether the constellation reads correctly in the
 * running dashboard. They do prevent later edits from silently removing the truth gates,
 * project-identity parity, responsive section-window seams, or semantic-unavailable warning.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createQ1ProjectGenerationGuard } from '../quadrants/q1Navigator.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'app.js'), 'utf8');

function sourceSection(startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = app.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return app.slice(start, end);
}

function rendererIngestHarness({ model, physicalInventory, nav, errors } = {}) {
  const noop = () => {};
  const state = {
    snapshotId: null,
    inventoryPhase: 'AWAITING INVENTORY',
    projectGenerationGuard: createQ1ProjectGenerationGuard(),
    files: new Map(),
    eventDisposers: [],
  };
  // Run the production ingest and hydration against the real generation guard.
  // The omitted collaborators only draw or mutate individual files, edges, and taxonomy.
  return runInNewContext([
    sourceSection('function normalizeToken(', 'function esc('),
    sourceSection('function finite(', 'function basename('),
    sourceSection('function eventPayload(', 'function resetProjectProjection('),
    sourceSection('function ingestNavigatorEvent(', 'function recordProjectionError('),
    sourceSection('function installEventBridge(', 'function installSceneObserver('),
    '({ state, ingestNavigatorEvent, ingestAvailableRuntimeState, installEventBridge })',
  ].join('\n'), {
    state,
    navigatorInstance: { model },
    adapter: { repositoryInventoryModel: physicalInventory },
    nav,
    window: { setTimeout: noop },
    extractTaxonomy: noop,
    updateAllDerivedState: noop,
    updateHud: noop,
    renderInspector: noop,
    updateDiveContextUi: noop,
    markDirty: noop,
    ingestEdge: noop,
    upsertFile: noop,
    normalizeEntityKind: noop,
    recordProjectionError: errors ? (reason) => errors.push(reason) : (reason) => assert.fail(reason),
  });
}

function navigatorEnvelope(type, payload) {
  return { v: 1, type, runId: 'run', snapshotId: 'semantic-snapshot', payload };
}

const navigatorEventRoutes = {
  'raw EventSource message': (envelope) => new MessageEvent('message', { data: JSON.stringify(envelope) }),
  'named adapter event': (envelope) => new CustomEvent(envelope.type, { detail: envelope }),
  'generic adapter event': (envelope) => new CustomEvent('event', { detail: { payload: envelope } }),
};

test('Q1 bridge leaves local Navigator notifications with UI listeners and guards recognition input', () => {
  const nav = new EventTarget();
  const errors = [];
  const { state, installEventBridge } = rendererIngestHarness({ nav, errors });
  const projectRecognition = {
    identityVersion: 'clue-project-recognition-identity/1',
    operationIdentity: {
      projectId: 'clue1',
      targetRootIdentity: 'path:v1:win32:' + 'a'.repeat(64),
      projectProfileHash: 'profile:v1:' + 'b'.repeat(64),
    },
    profileGeneration: 6,
    recognitionConfigHash: 'c'.repeat(64),
  };
  assert.equal(state.projectGenerationGuard.decide({ projectRecognition }, 'navigator-reset').accept, true);
  installEventBridge();

  const observed = [];
  const notifications = [
    new CustomEvent('node-added', { detail: { node: {}, unit: {}, cinematic: true } }),
    new CustomEvent('semantic-depth', { detail: { current: 2, granularity: 'file', scope: 'scope-1' } }),
    new CustomEvent('discovery-complete', { detail: { node: {} } }),
  ];
  for (const event of notifications) {
    nav.addEventListener(event.type, (event) => observed.push(event.type));
    nav.dispatchEvent(event);
  }
  assert.deepEqual(observed, notifications.map((event) => event.type));
  assert.deepEqual(errors, []);
  assert.equal(state.snapshotId, null);

  const send = (type, payload) => nav.dispatchEvent(
    navigatorEventRoutes['named adapter event'](navigatorEnvelope(type, payload)),
  );
  send('inventory.completed', { projectRecognition, snapshotId: 'physical-snapshot', fileCount: 663 });
  assert.equal(state.snapshotId, 'physical-snapshot');
  assert.equal(state.inventoryExpectedCount, 663);

  send('inventory.completed', { snapshotId: 'missing-identity', fileCount: 1 });
  send('inventory.completed', {
    projectRecognition: { ...projectRecognition, profileGeneration: 5 },
    snapshotId: 'stale-generation',
    fileCount: 2,
  });
  assert.deepEqual(errors, ['PROJECT_IDENTITY_MISSING', 'STALE_PROJECT_GENERATION']);
  assert.equal(state.snapshotId, 'physical-snapshot');
  assert.equal(state.inventoryExpectedCount, 663);
});

for (const [route, deliver] of Object.entries(navigatorEventRoutes)) {
  test(`Q1 SURF: ${route} keeps the physical snapshot through a dotted stream replay`, () => {
    const { state, ingestNavigatorEvent } = rendererIngestHarness();
    const send = (type, payload) => ingestNavigatorEvent(deliver(navigatorEnvelope(type, payload)));

    send('navigator.reset', {});
    send('inventory.started', { snapshotId: 'physical-snapshot' });
    assert.equal(state.snapshotId, 'physical-snapshot');
    send('inventory.completed', { snapshotId: 'physical-snapshot', fileCount: 636 });
    send('scan.completed', { snapshotId: 'semantic-snapshot' });
    assert.equal(state.snapshotId, 'physical-snapshot');

    send('graph.committed', { runId: 'run', captureId: 'capture-id' });
    assert.equal(state.snapshotId, 'physical-snapshot');
    send('graph.committed', { runId: 'run', inventorySnapshotId: 'physical-snapshot' });
    assert.equal(state.snapshotId, 'physical-snapshot');
    assert.equal(state.recognitionRunId, 'run');
    assert.equal(state.inventoryExpectedCount, 636);
  });
}

test('Q1 SURF: a named graph commit repairs the physical binding after an unbound raw message', () => {
  const { state, ingestNavigatorEvent } = rendererIngestHarness();
  const commit = navigatorEnvelope('graph.committed', { inventorySnapshotId: 'physical-snapshot' });
  const unbound = navigatorEnvelope('scan.completed', { snapshotId: 'semantic-snapshot' });
  ingestNavigatorEvent(navigatorEventRoutes['raw EventSource message'](unbound));
  assert.equal(state.snapshotId, null);
  ingestNavigatorEvent(navigatorEventRoutes['named adapter event'](commit));
  assert.equal(state.snapshotId, 'physical-snapshot');
});

test('Q1 SURF: late hydration uses an explicit physical model and ignores the semantic graph snapshot', () => {
  const physicalInventory = { snapshotId: 'semantic-snapshot', inventoryStarted: false };
  const { state, ingestAvailableRuntimeState } = rendererIngestHarness({
    model: { snapshotId: 'semantic-snapshot' }, physicalInventory,
  });
  ingestAvailableRuntimeState();
  assert.equal(state.snapshotId, null);

  physicalInventory.snapshotId = 'physical-snapshot';
  physicalInventory.inventoryStarted = true;
  ingestAvailableRuntimeState();
  assert.equal(state.snapshotId, 'physical-snapshot');
});

test('Q1 SURF: exposes the rendered snapshot and run', () => {
  assert.match(app, /snapshotId: state\.snapshotId,\s*runId: state\.recognitionRunId,\s*files: activeFiles\(\)\.length/);
});

test('Q1 SURF: micro-pattern strokes clear inherited shadows and restore the caller state', () => {
  const shadow = { shadowBlur: 14, shadowColor: 'white' };
  const strokes = [];
  const noop = () => {};
  const stack = [];
  const ctx = {
    ...shadow,
    save() { stack.push({ shadowBlur: this.shadowBlur, shadowColor: this.shadowColor }); },
    restore() {
      const saved = stack.pop();
      assert.ok(saved, 'restore without save');
      Object.assign(this, saved);
    },
    translate: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke() { strokes.push([this.shadowBlur, this.shadowColor]); },
  };
  const drawMicroPattern = runInNewContext(
    `${sourceSection('function drawMicroPattern(', 'function drawFileLabel(')}\ndrawMicroPattern`,
    { ctx, rgbaHex: () => 'white', hash01: () => 0.5, TAU: Math.PI * 2 },
  );

  drawMicroPattern(10, 10, 5, { pattern: 'double', accent: '#fff' }, 'file');
  assert.deepEqual(strokes, Array.from({ length: 8 }, () => [0, 'transparent']));
  assert.equal(ctx.shadowBlur, shadow.shadowBlur);
  assert.equal(ctx.shadowColor, shadow.shadowColor);
});

test('Q1 SURF: idle draws wait one second and dirty or animated frames draw immediately', () => {
  const idleDelay = app.match(/const DRAW_IDLE_MS = \d+;/)?.[0];
  assert.ok(idleDelay, 'missing idle delay');
  const state = {
    mode: 'surf', visible: true, cssWidth: 640, cssHeight: 480,
    lastDrawAt: 0, dirty: false, files: new Map([['file', {}]]),
  };
  const draws = [];
  let animating = false;
  const surfTick = sourceSection('function tick(now) {\n      if (state.destroyed) return;', 'function draw(now) {');
  const tick = runInNewContext(
    `${idleDelay}\n${surfTick}\ntick`,
    {
      state, document: { hidden: false }, requestAnimationFrame: () => 1,
      updateCameraAnimation: () => animating, hasTransientAnimation: () => false,
      draw(now) { draws.push(now); state.lastDrawAt = now; state.dirty = false; },
    },
  );

  tick(999);
  assert.deepEqual(draws, []);
  tick(1000);
  state.dirty = true;
  tick(1001);
  animating = true;
  tick(1002);
  assert.deepEqual(draws, [1000, 1001, 1002]);
});

test('Q1 SURF: the root reuses the canonical DIVE project dragon instead of inventing a SURF identity', () => {
  const parity = sourceSection(
    'function syncProjectIdentityIcon()',
    'function drawProjectRoot',
  );

  assert.match(parity, /CLU_E_PROJECT_DRAGON_ICON/);
  assert.match(parity, /shadow\.querySelector/);
  assert.match(parity, /new XMLSerializer\(\)\.serializeToString\(canonicalSvg\)/);
  assert.match(parity, /projectIcon\.src = `data:image\/svg\+xml/);
  assert.match(parity, /canonical-dive-project-dragon/);
});

test('Q1 SURF: project-to-section connectors contain a bright white core and illuminated halo', () => {
  const guides = sourceSection(
    'function drawContainmentGuides()',
    'function familySemanticAvailability',
  );

  assert.match(guides, /rgba\(255,255,255,\.96\)/);
  assert.match(guides, /rgba\(238,252,255,\.58\)/);
  assert.match(guides, /ctx\.shadowBlur = 24/);
  assert.match(guides, /traceProjectPath\(target\)/);
});

test('Q1 SURF: every environment center is circular and uses a deliberate technology icon vocabulary', () => {
  const iconSpec = sourceSection(
    'function technologyIconSpec',
    'function environmentGlyph',
  );
  const anchor = sourceSection(
    'function drawEnvironmentAnchors',
    'function hexagon',
  );

  for (const kind of [
    'typescript', 'javascript', 'python', 'java', 'powershell',
    'html', 'json', 'shader', 'markdown', 'yaml',
  ]) {
    assert.match(iconSpec, new RegExp(`kind: '${kind}'`), kind);
  }
  assert.match(app, /function drawTechnologyIcon/);
  assert.match(app, /Deliberate generic environment symbol/);
  assert.match(anchor, /ctx\.arc\(point\.x, point\.y, radius, 0, TAU\)/);
  assert.match(anchor, /drawTechnologyIcon\(point\.x, point\.y, radius, spec, family\.accent\)/);
});

test('Q1 SURF: section windows have independent drag and eight-direction resize controls', () => {
  const input = sourceSection('function familyHitSelection', 'function canvasPoint');
  const districts = sourceSection('function drawFamilyDistricts', 'function drawFamilyPattern');

  assert.match(app, /familyWindows: new Map\(\)/);
  assert.match(districts, /kind: 'family-drag'/);
  assert.match(districts, /kind: 'family-resize'/);
  for (const direction of ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']) {
    assert.match(districts, new RegExp(`\\['${direction}',`), direction);
  }
  assert.match(input, /pointer\.mode === 'family-drag'/);
  assert.match(input, /pointer\.mode === 'family-resize'/);
  assert.match(input, /FAMILY_WINDOW_MIN_W/);
  assert.match(input, /FAMILY_WINDOW_MIN_H/);
  assert.match(input, /computeGroupBounds\(\)/);
});

test('Q1 SURF: resizing triggers deterministic responsive mini-constellation reflow', () => {
  const environmentLayout = sourceSection('function environmentSlot', 'function releaseFileSlot');
  const fileLayout = sourceSection('function ensureFilePosition', 'function computeGroupBounds');

  assert.match(environmentLayout, /const count = Math\.max\(1, ids\.length\)/);
  assert.match(environmentLayout, /if \(count <= 2\) columns = count/);
  assert.match(environmentLayout, /cellWidth = innerWidth \/ columns/);
  assert.match(environmentLayout, /cellHeight = innerHeight \/ rows/);
  assert.match(environmentLayout, /layoutSignature: `\$\{windowState\.revision\}/);
  assert.match(fileLayout, /existing\.layoutSignature === environment\.layoutSignature/);
  assert.match(fileLayout, /maxX = Math\.max\(34, environment\.cellWidth/);
  assert.match(fileLayout, /maxY = Math\.max\(29, environment\.cellHeight/);
});

test('Q1 SURF: TypeScript and JavaScript occupy distinct local centers inside Web Runtime', () => {
  const environmentLayout = sourceSection('function environmentSlot', 'function releaseFileSlot');
  const anchors = sourceSection('function drawEnvironmentAnchors', 'function hexagon');

  assert.match(environmentLayout, /if \(count <= 2\) columns = count/);
  assert.match(environmentLayout, /const column = index % columns/);
  assert.match(environmentLayout, /const row = Math\.floor\(index \/ columns\)/);
  assert.match(anchors, /aggregate\.cellBounds\.minX/);
  assert.match(anchors, /ctx\.ellipse\(point\.x, point\.y, orbitWidth/);
});

test('Q1 SURF: semantic availability is proven by explicit mapping or an exact source anchor, never file type', () => {
  const availability = sourceSection(
    'function semanticAvailabilityForFile',
    'function dismissSemanticUnavailable',
  );

  assert.match(availability, /file\.preferredSemanticRootId/);
  assert.match(availability, /file\.semanticDestinationId/);
  assert.match(availability, /file\.semanticMembershipIds/);
  assert.match(app, /unitPath && unitPath === expectedPath/);
  assert.match(availability, /semantic-source-anchor/);
  assert.doesNotMatch(availability, /environmentId.*available/);
  assert.doesNotMatch(availability, /familyId.*available/);
});

test('Q1 SURF: an unavailable file remains in SURF and raises the closable ten-second red warning', () => {
  const handoff = sourceSection('function enterDiveFromFile', 'function shortId');

  assert.match(app, /const SEMANTIC_WARNING_MS = 10_000/);
  assert.match(app, /SEMANTIC CONTENT UNAVAILABLE/);
  assert.match(app, /q1v9-semantic-warning-close/);
  assert.match(app, /semanticWarningClose\?\.addEventListener\('click'/);
  assert.match(app, /border:1px solid rgba\(255,74,74,\.72\)/);
  assert.match(handoff, /if \(!availability\.available\) \{\s*showSemanticUnavailable/);

  const unavailableIndex = handoff.indexOf('if (!availability.available)');
  const enterIndex = handoff.indexOf('navigatorInstance.enterDiveForFile');
  const modeIndex = handoff.indexOf("setMode('dive'");
  assert.ok(unavailableIndex < enterIndex, 'preflight occurs before the semantic Navigator call');
  assert.ok(enterIndex < modeIndex, 'top-level DIVE mode changes only after a successful handoff');
  assert.match(handoff, /if \(!entered\) \{\s*showSemanticUnavailable/);
});

test('Q1 SURF: a valid handoff preserves physical file context when DIVE accepts it', () => {
  const handoff = sourceSection('function enterDiveFromFile', 'function shortId');

  for (const field of [
    'repositoryId', 'snapshotId', 'fileLocationId', 'fileVersionId',
    'path', 'familyId', 'environmentId',
    'preferredSemanticRootId', 'semanticDestinationId',
  ]) {
    assert.match(handoff, new RegExp(`${field}:`), field);
  }
  assert.match(handoff, /\bsemanticMembershipIds,/);
  assert.match(handoff, /entered = navigatorInstance\.enterDiveForFile\(handoff\) === true/);
  assert.match(handoff, /state\.diveContext = \{\s*\.\.\.handoff/);
  assert.match(handoff, /semanticMappingSource: availability\.source/);
});

test('Q1 SURF: Web Runtime is elevated while other sections retain honest physical-only signalling', () => {
  const districts = sourceSection('function drawFamilyDistricts', 'function drawFamilyPattern');
  const anchors = sourceSection('function drawEnvironmentAnchors', 'function hexagon');
  const files = sourceSection('function drawFileNodes', 'function drawMicroPattern');

  assert.match(app, /function isWebRuntimeFamily/);
  assert.match(districts, /CHROME \/ TEST \/ BENCHMARK/);
  assert.match(districts, /DIVE LINK/);
  assert.match(districts, /PHYSICAL ONLY/);
  assert.match(anchors, /DIVE \$\{semanticCount\}\/\$\{aggregate\.files\.length\}/);
  assert.match(anchors, /PHYSICAL ONLY/);
  assert.match(files, /if \(semantic\.available\)/);
  assert.match(files, /rgba\(244,175,45,\.72\)/);
});
