import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GraphModel } from '../src/core/GraphModel.js';
import {
  resolveSemanticFileNode,
  validateFileDiveContext,
} from '../src/core/FileDiveResolver.js';
import { SseNavigatorAdapter } from '../src/adapters/SseNavigatorAdapter.js';
import { assertNavigatorEvent } from '../src/protocol.js';

function unit(logicalId, kind, name, modulePath, parentLogicalId = null) {
  return {
    logicalId,
    versionHash: '0'.repeat(64),
    kind,
    name,
    qualifiedName: logicalId.split('#')[1] ?? name,
    modulePath,
    exported: true,
    anchor: { path: modulePath, startLine: 1, endLine: 2, startByte: 0, endByte: 20 },
    parentLogicalId,
    lineCount: 2,
    byteLength: 20,
    isAsync: false,
    parameterCount: kind === 'method' || kind === 'function' ? 1 : null,
  };
}

function envelope(type, sequence, payload = {}) {
  return {
    v: 1,
    type,
    streamId: 'q1-test',
    runId: 'run-test',
    sequence,
    emittedAt: new Date().toISOString(),
    snapshotId: 'a'.repeat(64),
    payload,
  };
}

test('Q1 SURF/DIVE: protocol accepts the physical inventory lifecycle', () => {
  for (const [index, type] of [
    'inventory.started',
    'inventory.taxonomy',
    'files.upserted',
    'files.removed',
    'inventory.completed',
    'recognition.started',
    'file.semantic-summary',
    'dependency.discovered',
  ].entries()) {
    assert.equal(assertNavigatorEvent(envelope(type, index)).type, type);
  }
});

test('Q1 SURF/DIVE: file handoff resolves explicit membership or exact path to the file scope', () => {
  const model = new GraphModel({ projectName: 'Fixture' });
  const path = 'src/core/Thing.ts';
  const moduleId = `${path}#${path}`;
  const classId = `${path}#Thing`;
  const methodId = `${path}#Thing.run`;
  model.addUnit(unit(moduleId, 'module', 'Thing.ts', path));
  model.addUnit(unit(classId, 'class', 'Thing', path, moduleId));
  model.addUnit(unit(methodId, 'method', 'run', path, classId));

  const common = {
    repositoryId: 'fixture',
    snapshotId: 'a'.repeat(64),
    fileLocationId: 'b'.repeat(64),
    fileVersionId: 'c'.repeat(64),
    path,
    familyId: 'ecmascript',
    environmentId: 'typescript',
    semanticMembershipIds: [methodId],
    preferredSemanticRootId: methodId,
  };

  const byMembership = resolveSemanticFileNode(model, common);
  assert.equal(byMembership.ok, true);
  assert.equal(byMembership.node?.granularity, 'file');

  const byPath = resolveSemanticFileNode(model, {
    ...common,
    semanticMembershipIds: [],
    preferredSemanticRootId: null,
  });
  assert.equal(byPath.ok, true);
  assert.equal(byPath.node?.granularity, 'file');

  const wrongPath = resolveSemanticFileNode(model, {
    ...common,
    path: 'src/other/Thing.ts',
    semanticMembershipIds: [],
    preferredSemanticRootId: null,
  });
  assert.equal(wrongPath.ok, false, 'same basename in another path is never guessed');

  const foreignMembership = resolveSemanticFileNode(model, {
    ...common,
    path: 'src/other/Thing.ts',
    semanticMembershipIds: [methodId],
    preferredSemanticRootId: methodId,
  });
  assert.equal(foreignMembership.ok, false, 'an explicit semantic id cannot override physical path identity');
  assert.equal(validateFileDiveContext({ path }).ok, false, 'physical identities are mandatory');
});

test('Q1 SURF/DIVE: adapter forwards physical envelopes exactly once and retains a replay model', async () => {
  const originalEventSource = globalThis.EventSource;
  class FakeEventSource {
    static latest = null;
    constructor() {
      this.listeners = new Map();
      FakeEventSource.latest = this;
    }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type, data = null) {
      for (const listener of this.listeners.get(type) ?? []) listener({ type, data });
    }
    close() {}
  }
  globalThis.EventSource = FakeEventSource;

  try {
    const target = new EventTarget();
    target.navigator = { applyEvent: async () => true };
    const adapter = new SseNavigatorAdapter(target, '/events');
    let exact = 0;
    let generic = 0;
    target.addEventListener('files.upserted', () => { exact += 1; });
    adapter.addEventListener('event', () => { generic += 1; });
    adapter.connect();

    const source = FakeEventSource.latest;
    source.emit('message', JSON.stringify(envelope('inventory.started', 0, {
      repositoryId: 'fixture',
      snapshotId: 'd'.repeat(64),
      inventoryVersion: 'q1-repository-inventory/1',
      inventoryHash: 'e'.repeat(64),
      expectedFileCount: 1,
    })));
    source.emit('message', JSON.stringify(envelope('files.upserted', 1, {
      files: [{
        fileLocationId: 'f'.repeat(64),
        fileVersionId: '1'.repeat(64),
        path: 'src/a.ts',
        familyId: 'ecmascript',
        environmentId: 'typescript',
      }],
    })));
    source.emit('message', JSON.stringify(envelope('dependency.discovered', 2, {
      fromFileLocationId: 'f'.repeat(64),
      toFileLocationId: '2'.repeat(64),
      kind: 'semantic-dependency',
      directed: true,
      weight: 2,
    })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(exact, 1);
    assert.equal(generic, 0, 'physical events are not duplicated through the legacy generic event');
    assert.equal(adapter.repositoryInventoryModel.filesById.size, 1);
    assert.equal(adapter.repositoryInventoryModel.fileEdges.size, 1);
    assert.equal(adapter.repositoryInventoryModel.phase, 'INVENTORY STREAMING');

    source.emit('message', JSON.stringify(envelope('files.upserted', 1, {
      files: [{ fileLocationId: 'f'.repeat(64), fileVersionId: '9'.repeat(64), path: 'stale.ts' }],
    })));
    source.emit('message', JSON.stringify(envelope('file.semantic-summary', 3, {
      fileLocationId: 'f'.repeat(64), fileVersionId: '9'.repeat(64), recognitionState: 'recognized',
    })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(adapter.repositoryInventoryModel.filesById.get('f'.repeat(64)).path, 'src/a.ts',
      'duplicate sequence cannot overwrite the replay model');
    assert.notEqual(adapter.repositoryInventoryModel.filesById.get('f'.repeat(64)).recognitionState, 'recognized',
      'semantic enrichment for another file version is refused');

    source.emit('message', JSON.stringify(envelope('files.removed', 4, {
      fileLocationIds: ['f'.repeat(64)],
    })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(adapter.repositoryInventoryModel.filesById.size, 0,
      'late bootstrap model retains only the current physical inventory');

    source.emit('message', JSON.stringify(envelope('scan.started', 5, {})));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(generic, 1, 'semantic events preserve the existing generic adapter contract');
  } finally {
    globalThis.EventSource = originalEventSource;
  }
});


test('Q1 SURF/DIVE: adapter preserves wire order across the asynchronous custom-element seam', async () => {
  const originalEventSource = globalThis.EventSource;
  class FakeEventSource {
    static latest = null;
    constructor() { this.listeners = new Map(); FakeEventSource.latest = this; }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type, data = null) {
      for (const listener of this.listeners.get(type) ?? []) listener({ type, data });
    }
    close() {}
  }
  globalThis.EventSource = FakeEventSource;
  try {
    const applied = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const target = new EventTarget();
    target.navigator = {
      async applyEvent(event) {
        if (event.sequence === 0) await firstGate;
        applied.push(event.sequence);
        return true;
      },
    };
    const forwarded = [];
    target.addEventListener('inventory.started', (event) => forwarded.push(event.detail.sequence));
    target.addEventListener('files.upserted', (event) => forwarded.push(event.detail.sequence));
    const adapter = new SseNavigatorAdapter(target, '/events');
    adapter.connect();
    const source = FakeEventSource.latest;
    source.emit('message', JSON.stringify(envelope('inventory.started', 0, {})));
    source.emit('message', JSON.stringify(envelope('files.upserted', 1, { files: [] })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(applied, [], 'the second event waits behind the first event');
    releaseFirst();
    await adapter.consumeTail;
    assert.deepEqual(applied, [0, 1]);
    assert.deepEqual(forwarded, [0, 1]);
  } finally {
    globalThis.EventSource = originalEventSource;
  }
});

test('Q1 SURF/DIVE: the authoritative dashboard baseline declares the expected contract', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(join(here, '../../clue-dashboard/app.js'), 'utf8');
  assert.match(app, /ULTIMATE-2026\.08-Q1-V9-REPOSITORY-OBSERVATORY-R1/);
  assert.match(app, /Q1-SURF-DIVE-REPOSITORY-NAVIGATOR-R2/);
  assert.match(app, /SURF PHYSICAL INVENTORY AWAITING DATA/);
  assert.match(app, /inventory\.taxonomy/);
  assert.match(app, /files\.upserted/);
  assert.match(app, /enterDiveForFile/);
  assert.match(app, /Physical inventory truth is[\s\S]{0,120}never manufactured from semantic units/);
  assert.match(app, /q1v9-mode-header/,
    'the authoritative SURF\/DIVE control is mounted in the Q1 panel header');
  assert.match(app, /state\.modeObserver\.observe\(shadow,[\s\S]{0,120}childList:\s*true/,
    'legacy semantic mode rebinding watches child replacement rather than attribute churn');
  assert.match(app, /panelTools\.insertBefore\(fallbackMode, panelTools\.firstChild\)/,
    'Navigator shadow rerenders cannot replace the operator-facing mode control');
});

test('Q1 SURF/DIVE: a legacy semantic stream cannot claim a sealed physical inventory', async () => {
  const originalEventSource = globalThis.EventSource;
  class FakeEventSource {
    static latest = null;
    constructor() { this.listeners = new Map(); FakeEventSource.latest = this; }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type, data = null) {
      for (const listener of this.listeners.get(type) ?? []) listener({ type, data });
    }
    close() {}
  }
  globalThis.EventSource = FakeEventSource;
  try {
    const applied = [];
    const target = new EventTarget();
    target.navigator = { applyEvent: async (event) => { applied.push(event.type); return true; } };
    const bridged = [];
    for (const type of ['scan.started', 'scan.completed', 'graph.committed']) {
      target.addEventListener(type, () => bridged.push(type));
    }
    let generic = 0;
    const adapter = new SseNavigatorAdapter(target, '/events');
    adapter.addEventListener('event', () => { generic += 1; });
    adapter.connect();
    const source = FakeEventSource.latest;
    source.emit('message', JSON.stringify(envelope('navigator.reset', 0, {})));
    source.emit('message', JSON.stringify(envelope('scan.started', 1, {})));
    source.emit('message', JSON.stringify(envelope('scan.completed', 2, {})));
    source.emit('message', JSON.stringify(envelope('graph.committed', 3, {})));
    await adapter.consumeTail;

    assert.deepEqual(applied, ['navigator.reset', 'scan.started', 'scan.completed', 'graph.committed'],
      'semantic Navigator still receives the complete legacy stream');
    assert.deepEqual(bridged, [], 'SURF phase bridge refuses lifecycle claims without physical inventory');
    assert.equal(generic, 1, 'scan.started remains generic, while terminal physical claims stay suppressed');
    assert.equal(adapter.repositoryInventoryModel.physicalEnvelopeComplete, false);
    assert.equal(adapter.repositoryInventoryModel.requiresFreshRecognition, true);
    assert.match(adapter.repositoryInventoryModel.phase, /PHYSICAL INVENTORY UNAVAILABLE/);
  } finally {
    globalThis.EventSource = originalEventSource;
  }
});

test('Q1 SURF/DIVE: a complete inventory envelope authorizes the sealed SURF phase bridge', async () => {
  const originalEventSource = globalThis.EventSource;
  class FakeEventSource {
    static latest = null;
    constructor() { this.listeners = new Map(); FakeEventSource.latest = this; }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type, data = null) {
      for (const listener of this.listeners.get(type) ?? []) listener({ type, data });
    }
    close() {}
  }
  globalThis.EventSource = FakeEventSource;
  try {
    const target = new EventTarget();
    target.navigator = { applyEvent: async () => true };
    const bridged = [];
    for (const type of ['scan.started', 'scan.completed', 'graph.committed']) {
      target.addEventListener(type, () => bridged.push(type));
    }
    const adapter = new SseNavigatorAdapter(target, '/events');
    adapter.connect();
    const source = FakeEventSource.latest;
    const hash = (character) => character.repeat(64);
    const full = (type, sequence, payload = {}) => ({
      ...envelope(type, sequence, payload),
      streamId: 'q1-complete',
      runId: 'run-complete',
      snapshotId: hash('a'),
    });
    source.emit('message', JSON.stringify(full('navigator.reset', 0, {
      repositoryId: 'fixture', snapshotId: hash('a'), inventoryHash: hash('b'),
    })));
    source.emit('message', JSON.stringify(full('inventory.started', 1, {
      repositoryId: 'fixture', snapshotId: hash('a'), inventoryVersion: 'q1-repository-inventory/1',
      inventoryHash: hash('b'), expectedFileCount: 1,
    })));
    source.emit('message', JSON.stringify(full('inventory.taxonomy', 2, {
      taxonomyVersion: 'q1-artifact-taxonomy/1', taxonomyHash: hash('c'),
      families: [{ id: 'ecmascript', label: 'ECMASCRIPT' }],
      environments: [{ id: 'typescript', familyId: 'ecmascript', label: 'TypeScript' }],
    })));
    source.emit('message', JSON.stringify(full('files.upserted', 3, {
      files: [{
        fileLocationId: hash('d'), fileVersionId: hash('e'), repositoryId: 'fixture',
        snapshotId: hash('a'), path: 'src/a.ts', familyId: 'ecmascript',
        environmentId: 'typescript', excluded: false,
      }],
    })));
    source.emit('message', JSON.stringify(full('inventory.completed', 4, {
      repositoryId: 'fixture', snapshotId: hash('a'), inventoryVersion: 'q1-repository-inventory/1',
      inventoryHash: hash('b'), taxonomyVersion: 'q1-artifact-taxonomy/1',
      taxonomyHash: hash('c'), fileCount: 1,
    })));
    source.emit('message', JSON.stringify(full('scan.started', 5, {})));
    source.emit('message', JSON.stringify(full('scan.completed', 6, {})));
    source.emit('message', JSON.stringify(full('graph.committed', 7, {})));
    await adapter.consumeTail;

    assert.deepEqual(bridged, ['scan.completed', 'graph.committed']);
    assert.equal(adapter.repositoryInventoryModel.physicalEnvelopeComplete, true);
    assert.equal(adapter.repositoryInventoryModel.requiresFreshRecognition, false);
    assert.equal(adapter.repositoryInventoryModel.phase, 'SEALED PROJECTION LIVE');
    assert.equal(adapter.repositoryInventoryModel.filesById.size, 1);
  } finally {
    globalThis.EventSource = originalEventSource;
  }
});
