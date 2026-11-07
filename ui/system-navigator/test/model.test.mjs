import test from 'node:test';
import assert from 'node:assert/strict';

import { GraphModel } from '../src/core/GraphModel.js';
import { LayoutEngine } from '../src/core/LayoutEngine.js';
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

test('projects a function through all seven semantic levels', () => {
  const model = new GraphModel({ projectName: 'Murugan' });
  const path = 'src/core/render/gaussian/GaussianRenderer.ts';
  const moduleId = `${path}#${path}`;
  const classId = `${path}#GaussianRenderer`;
  const methodId = `${path}#GaussianRenderer.draw`;
  model.addUnit(unit(moduleId, 'module', 'GaussianRenderer.ts', path));
  model.addUnit(unit(classId, 'class', 'GaussianRenderer', path, moduleId));
  model.addUnit(unit(methodId, 'method', 'draw', path, classId));

  const node = model.getNode(methodId);
  const chain = model.getAncestors(node).reverse().map((entry) => entry.granularity);
  assert.deepEqual(chain, ['project', 'domain', 'subsystem', 'module', 'file', 'class', 'function']);
});

test('aggregates leaf dependencies at a semantic zoom level', () => {
  const model = new GraphModel({ projectName: 'Murugan' });
  const aPath = 'src/render/core/A.ts';
  const bPath = 'src/world/core/B.ts';
  const a = `${aPath}#run`;
  const b = `${bPath}#read`;
  model.addUnit(unit(a, 'function', 'run', aPath));
  model.addUnit(unit(b, 'function', 'read', bPath));
  model.addEdge({ from: a, to: b, kind: 'calls', confidence: 1, external: false, anchor: unit(a, 'function', 'run', aPath).anchor });
  model.completeScan();
  const domains = model.displaySetForDepth(1);
  const edges = model.aggregatedEdgesFor(domains);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].weight, 1);
});

test('a mutual dependency keeps both directions as distinct aggregates', () => {
  // Direction is semantic truth: reverse impact, blast radius, and coupling reasoning
  // all depend on which way an edge points. A sorted-endpoint key once merged A→B and
  // B→A into one aggregate whose recorded direction was whichever raw edge arrived
  // first. This test contains both directions so that defect cannot silently return.
  const model = new GraphModel({ projectName: 'Murugan' });
  const aPath = 'src/render/core/A.ts';
  const bPath = 'src/world/core/B.ts';
  const a = `${aPath}#run`;
  const b = `${bPath}#read`;
  model.addUnit(unit(a, 'function', 'run', aPath));
  model.addUnit(unit(b, 'function', 'read', bPath));
  const anchor = unit(a, 'function', 'run', aPath).anchor;
  model.addEdge({ from: a, to: b, kind: 'calls', confidence: 1, external: false, anchor });
  model.addEdge({ from: a, to: b, kind: 'calls', confidence: 1, external: false, anchor });
  model.addEdge({ from: b, to: a, kind: 'references', confidence: 0.6, external: false, anchor });
  model.completeScan();

  const domains = model.displaySetForDepth(1);
  const edges = model.aggregatedEdgesFor(domains);
  assert.equal(edges.length, 2, 'A→B and B→A are distinct aggregates, never merged');

  const renderDomainId = model.ancestorAtLevel(model.getNode(a), 1).id;
  const worldDomainId = model.ancestorAtLevel(model.getNode(b), 1).id;
  const forward = edges.find((edge) => edge.from === renderDomainId);
  const backward = edges.find((edge) => edge.from === worldDomainId);
  assert.ok(forward !== undefined && backward !== undefined, 'one aggregate per direction');

  assert.equal(forward.to, worldDomainId, 'forward aggregate points render → world');
  assert.equal(backward.to, renderDomainId, 'backward aggregate points world → render');
  assert.notEqual(forward.id, backward.id, 'directional keys differ');

  assert.equal(forward.weight, 2, 'both raw calls aggregate into the forward direction');
  assert.equal(backward.weight, 1);
  assert.equal(forward.confidence, 1, 'confidence is averaged per direction, not pooled');
  assert.equal(backward.confidence, 0.6);
  assert.deepEqual(forward.kinds, ['calls'], 'kinds stay with their direction');
  assert.deepEqual(backward.kinds, ['references']);

  for (const edge of edges) {
    assert.equal(edge.directedFrom, edge.from, 'directedFrom always equals from');
    assert.equal(edge.directedTo, edge.to, 'directedTo always equals to');
  }
});

test('layout is deterministic for the same graph', () => {
  const make = () => {
    const model = new GraphModel({ projectName: 'Murugan' });
    model.addUnit(unit('src/a/x.ts#f', 'function', 'f', 'src/a/x.ts'));
    model.addUnit(unit('src/b/y.ts#g', 'function', 'g', 'src/b/y.ts'));
    const layout = new LayoutEngine(model);
    layout.rebuild();
    return [...model.nodes.values()].map((node) => [node.id, [...node.basePosition]]);
  };
  assert.deepEqual(make(), make());
});

test('event protocol rejects malformed sequence state', () => {
  assert.throws(() => assertNavigatorEvent({ v: 1, type: 'scan.started', streamId: '', sequence: -1, payload: {} }));
  const event = assertNavigatorEvent({
    v: 1,
    type: 'scan.started',
    streamId: 'recognizer:test',
    sequence: 0,
    snapshotId: 'snapshot',
    payload: { projectName: 'Murugan' },
  });
  assert.equal(event.type, 'scan.started');
});
