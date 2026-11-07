/**
 * DEV-P0-05 (edge integrity) — the graph edge key is the exact source byte anchor.
 *
 * Two calls to the same target on one source line are distinct observations. Keyed by `start_line`
 * they silently collapsed (and `ON CONFLICT DO UPDATE` merged them); keyed by `(start_byte, end_byte)`
 * they both survive. A byte-identical duplicate — the same observation recorded twice — is rejected
 * before persistence rather than merged, and a snapshot's edges rehydrate from the artifact exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { SnapshotRegistry, SNAPSHOT_PROJECTORS } from '../src/analysis/source/snapshot.js';
import { GraphRegistry, GRAPH_PROJECTORS, GraphIntegrityError } from '../src/analysis/source/graph.js';
import { SCAN_CACHE_PROJECTORS } from '../src/analysis/source/scanCache.js';
import { recognize } from '../src/analysis/source/recognizer.js';

interface Stack {
  readonly root: string;
  readonly snapshots: SnapshotRegistry;
  readonly graph: GraphRegistry;
  dispose(): void;
}

function openStack(): Stack {
  const root = mkdtempSync(join(tmpdir(), 'clue-edge-id-'));
  const ws = join(root, 'workspace');
  for (const d of ['db', 'events', 'blobs', 'logs']) mkdirSync(join(ws, d), { recursive: true });
  const projections = new ProjectionStore(join(ws, 'db', 'clue.db'), {
    projectors: { ...SNAPSHOT_PROJECTORS, ...GRAPH_PROJECTORS, ...SCAN_CACHE_PROJECTORS },
  });
  const artifacts = new ArtifactStore(join(ws, 'blobs'));
  const { log } = EventLog.open(join(ws, 'events'));
  const missionVersion = (): string => 'MISSION-000001';
  return {
    root,
    snapshots: new SnapshotRegistry({ log, projections, artifacts, missionVersion }),
    graph: new GraphRegistry({ log, projections, artifacts, missionVersion }),
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'node', skipLibCheck: true },
      include: ['src/**/*.ts'],
    }),
  );
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(src, name), content);
}

const capOpts = (root: string) => ({ root, sourceRoots: ['src'], origin: 'canonical' as const });
const rec = (root: string, extra: Record<string, unknown> = {}) =>
  recognize({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), ...extra });

test('two calls to one target on a single line persist as distinct edges', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, {
      'a.ts': 'export function target(): void {}\nexport function caller(): void { target(); target(); }\n',
    });
    const cap = stack.snapshots.capture(capOpts(stack.root));
    const result = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });

    const observed = result.edges.filter((e) => e.from.includes('#caller') && e.to.includes('#target'));
    assert.equal(observed.length, 2, 'two call sites are two edges');
    assert.equal(observed[0]?.anchor.startLine, observed[1]?.anchor.startLine, 'they share a source line');
    assert.notEqual(observed[0]?.anchor.startByte, observed[1]?.anchor.startByte, 'but differ in byte anchor');

    const recorded = stack.graph.record(cap.record.id, result, { complete: true });
    const persisted = stack.graph.resultOf(cap.record.id);
    assert.ok(persisted !== null);
    const persistedPair = persisted.edges.filter((e) => e.from.includes('#caller') && e.to.includes('#target'));
    assert.equal(persistedPair.length, 2, 'both edges survive persistence, none collapsed');
    assert.equal(recorded.record.edge_count, result.edges.length, 'persisted edge count equals observed');
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('a snapshot with same-line duplicate call sites rehydrates to the exact edge set', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, {
      'a.ts': 'export function t(): void {}\nexport function c(): void { t(); t(); t(); }\n',
    });
    const cap = stack.snapshots.capture(capOpts(stack.root));
    const result = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    const before = stack.graph.record(cap.record.id, result, { complete: true }).record.edge_count;

    stack.graph.rehydrate(cap.record.id);
    const after = stack.graph.resultOf(cap.record.id);
    assert.ok(after !== null);
    assert.equal(after.edges.length, before, 'rehydration restores the exact edge count');
    const cToT = after.edges.filter((e) => e.from.includes('#c') && e.to.includes('#t'));
    assert.equal(cToT.length, 3, 'all three same-line call edges are present after rehydration');
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('a byte-identical duplicate edge is rejected before persistence, not silently merged', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, {
      'a.ts': 'export function target(): void {}\nexport function caller(): void { target(); }\n',
    });
    const cap = stack.snapshots.capture(capOpts(stack.root));
    const result = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    const firstInternal = result.edges.find((e) => !e.external);
    assert.ok(firstInternal !== undefined);
    const poisoned = { ...result, edges: [...result.edges, firstInternal] };
    assert.throws(
      () => stack.graph.record(cap.record.id, poisoned, { complete: true }),
      (error: unknown) => error instanceof GraphIntegrityError && /duplicate-edge-key/.test(String((error as Error).message)),
      'an exact byte-identical duplicate must be rejected',
    );
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});
