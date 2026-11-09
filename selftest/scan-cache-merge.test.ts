/**
 * DEV-P0-04 — incremental scan produces one complete merged artifact.
 *
 * The contract: an incremental run does not persist the re-extracted fragment. It loads the previous
 * complete result, re-extracts only the changed surface, and merges them into one complete result.
 * For the same final tree this merged artifact hashes identically to a full scan, and after the
 * projection database is cleared and the graph rehydrated from the artifact alone, units, edges,
 * unresolved references and counts are byte-equivalent to the full scan. Carried content lives in the
 * artifact itself, so `carryForward` is no longer an authority-producing step.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { SnapshotRegistry, diffSnapshots, SNAPSHOT_PROJECTORS } from '../src/analysis/source/snapshot.js';
import { GraphRegistry, GRAPH_PROJECTORS } from '../src/analysis/source/graph.js';
import { ScanCache, SCAN_CACHE_PROJECTORS, mergeIncrementalResult, incrementalMatchesOracle } from '../src/analysis/source/scanCache.js';
import { recognize, RecognitionParityError } from '../src/analysis/source/recognizer.js';
import { hashCanonicalJson } from '../src/shared/ids.js';
import type { RecognitionResult } from '../src/analysis/source/recognizer.js';

interface Stack {
  readonly root: string;
  readonly projections: ProjectionStore;
  readonly snapshots: SnapshotRegistry;
  readonly graph: GraphRegistry;
  readonly cache: ScanCache;
  dispose(): void;
}

function openStack(): Stack {
  const root = mkdtempSync(join(tmpdir(), 'clue-scan-merge-'));
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
    projections,
    snapshots: new SnapshotRegistry({ log, projections, artifacts, missionVersion }),
    graph: new GraphRegistry({ log, projections, artifacts, missionVersion }),
    cache: new ScanCache({ log, projections, artifacts, missionVersion }),
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
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'old.ts']) {
    const path = join(src, name);
    if (name in files) writeFileSync(path, files[name] as string);
    else rmSync(path, { force: true });
  }
}

const C = 'export const shared = 1;\n';
const A = 'function helperA(): number { return 1; }\nexport function useA(): number { return helperA(); }\n';
const B_V0 = 'export function api(x: number): number { return x; }\n';
const B_V1 =
  'export function api(x: number): number;\nexport function api(x: string): string;\nexport function api(x: unknown): unknown { return x; }\n';
const OLD = 'export const gone = 1;\n';
const TREE_T0 = { 'a.ts': A, 'b.ts': B_V0, 'c.ts': C, 'old.ts': OLD };
const TREE_T = { 'a.ts': A, 'b.ts': B_V1, 'c.ts': C };

const capOpts = (root: string) => ({ root, sourceRoots: ['src'], origin: 'canonical' as const });
const recOpts = (root: string, extra: Record<string, unknown> = {}) => ({
  projectRoot: root,
  tsconfigPath: join(root, 'tsconfig.json'),
  ...extra,
});

interface Scenario {
  fullHash: string;
  incrementalHash: string;
  mergedResultHash: string;
  fullResult: Pick<RecognitionResult, 'units' | 'edges' | 'unresolved'>;
  fullCounts: { units: number; edges: number; unresolved: number };
  incrementalCounts: { units: number; edges: number; unresolved: number };
  toSnapshot: string;
  fullSnapshot: string;
  incStack: Stack;
  planFrom: string;
  merge: ReturnType<typeof mergeIncrementalResult>;
}

/** Runs a full scan of T and an incremental merge onto a T0 base that also reaches T. */
function runScenario(): Scenario {
  const full = openStack();
  writeTree(full.root, TREE_T);
  const capFull = full.snapshots.capture(capOpts(full.root));
  const resultFull = recognize(recOpts(full.root, { snapshotId: capFull.record.id, captureId: capFull.captureId }));
  const recFull = full.graph.record(capFull.record.id, resultFull, { complete: true });
  const fullResult = full.graph.resultOf(capFull.record.id);
  assert.ok(fullResult !== null);

  const inc = openStack();
  writeTree(inc.root, TREE_T0);
  const capBase = inc.snapshots.capture(capOpts(inc.root));
  const resultBase = recognize(recOpts(inc.root, { snapshotId: capBase.record.id, captureId: capBase.captureId }));
  inc.graph.record(capBase.record.id, resultBase, { complete: true });

  writeTree(inc.root, TREE_T);
  const capTo = inc.snapshots.capture(capOpts(inc.root));
  const diff = diffSnapshots(capBase.manifest, capTo.manifest);
  const probe = recognize(recOpts(inc.root));
  const plan = inc.cache.plan(diff, { compilerOptionsHash: probe.compilerOptionsHash });
  assert.equal(plan.fullRescan, false, 'the plan must be incremental for this scenario');
  assert.ok(plan.fromSnapshot !== null);

  const previous = inc.graph.resultOf(plan.fromSnapshot);
  const previousRecognition = inc.graph.recognition(plan.fromSnapshot);
  assert.ok(previous !== null && previousRecognition !== null);
  const fresh = recognize(recOpts(inc.root, { restrictTo: plan.extractionSurface, snapshotId: capTo.record.id, captureId: capTo.captureId }));
  const merge = mergeIncrementalResult({ plan, fresh, previous, previousResultHash: previousRecognition.result_hash });
  const recInc = inc.graph.record(capTo.record.id, merge.result, { complete: true });

  full.dispose();
  return {
    fullHash: recFull.record.result_hash,
    incrementalHash: recInc.record.result_hash,
    mergedResultHash: merge.mergedResultHash,
    fullResult,
    fullCounts: { units: recFull.record.unit_count, edges: recFull.record.edge_count, unresolved: recFull.record.unresolved_count },
    incrementalCounts: { units: recInc.record.unit_count, edges: recInc.record.edge_count, unresolved: recInc.record.unresolved_count },
    toSnapshot: capTo.record.id,
    fullSnapshot: capFull.record.id,
    incStack: inc,
    planFrom: plan.fromSnapshot,
    merge,
  };
}

test('an incremental merge produces the same artifact hash as a full scan of the same tree', () => {
  const s = runScenario();
  try {
    assert.equal(s.fullSnapshot, s.toSnapshot, 'both runs reached the identical final content id');
    assert.equal(s.mergedResultHash, s.fullHash, 'the merge hash equals the full-scan artifact hash');
    assert.equal(s.incrementalHash, s.fullHash, 'the recorded incremental artifact hash equals the full scan');
    assert.deepEqual(s.incrementalCounts, s.fullCounts, 'unit/edge/unresolved counts match');
  } finally {
    s.incStack.dispose();
  }
});

test('the incremental run records durable merge provenance', () => {
  const s = runScenario();
  try {
    s.incStack.cache.recordMerge(s.planFrom, s.toSnapshot, s.merge);
    const record = s.incStack.cache.mergeOf(s.toSnapshot);
    assert.ok(record !== null, 'a merge record exists');
    assert.equal(record.previous_result_hash, s.merge.previousResultHash);
    assert.equal(record.carried_count, s.merge.carriedModules.length);
    assert.equal(record.extracted_count, s.merge.extractedModules.length);
  } finally {
    s.incStack.dispose();
  }
});

test('cache reuse requires a readable prior artifact and the same toolchain basis', () => {
  const s = openStack();
  try {
    writeTree(s.root, TREE_T0);
    const base = s.snapshots.capture(capOpts(s.root));
    const initial = recognize(recOpts(s.root, { snapshotId: base.record.id }));
    s.graph.record(base.record.id, initial);
    writeTree(s.root, TREE_T);
    const next = s.snapshots.capture(capOpts(s.root));
    const diff = diffSnapshots(base.manifest, next.manifest);
    const options = { compilerOptionsHash: initial.compilerOptionsHash, currentBasis: initial.basis };
    assert.equal(s.cache.plan(diff, options).fullRescan, false);
    assert.equal(s.cache.plan(diff, {
      ...options,
      currentBasis: { ...initial.basis, lockfileHash: 'b'.repeat(64) },
    }).fullRescanReason, 'recognition-configuration-changed');
    s.projections.db.prepare('UPDATE recognitions SET artifact_hash = ? WHERE snapshot_id = ?')
      .run('c'.repeat(64), base.record.id);
    assert.equal(s.cache.plan(diff, options).fullRescanReason, 'previous-artifact-unavailable');
  } finally {
    s.dispose();
  }
});

test('DEV-P0-04: the merged result declares a full extraction scope with a consistent, recomputed basis hash', () => {
  const s = runScenario();
  try {
    // The merge covers carried + re-extracted files — a COMPLETE result — so its basis must declare full
    // scope, not carry the restricted surface the fresh run re-extracted. The graph registry relies on
    // this to recognise the merged artifact as complete and replace a snapshot's rows exactly (DEV-P0-05).
    assert.equal(
      s.merge.result.basis.extractionScope.mode,
      'full',
      'the merged basis declares full scope, not the fresh run’s restricted surface',
    );
    assert.equal(
      s.merge.result.basisHash,
      hashCanonicalJson(s.merge.result.basis),
      'the basis hash is recomputed to match the full-scope basis, not left as the fresh restricted hash',
    );
  } finally {
    s.incStack.dispose();
  }
});

test('DEV-P0-04: the full-oracle parity gate accepts an incremental run that equals the full scan', () => {
  const s = runScenario();
  try {
    // In the ordinary case the merged graph IS the full graph, so the gate lets the incremental through.
    const probe = recognize(recOpts(s.incStack.root, {
      snapshotId: s.toSnapshot,
      captureId: s.merge.result.basis.captureId,
    }));
    assert.equal(
      incrementalMatchesOracle(s.merge, probe),
      true,
      'a correct incremental merge matches the full-scan oracle and is accepted',
    );
    const changedBasis = { ...probe.basis, lockfileHash: 'a'.repeat(64) };
    assert.equal(
      incrementalMatchesOracle(s.merge, { ...probe, basis: changedBasis, basisHash: hashCanonicalJson(changedBasis) }),
      false,
      'identical graph content cannot substitute for matching compiler provenance',
    );
  } finally {
    s.incStack.dispose();
  }
});

test('DEV-P0-04: the full-oracle parity gate catches an incremental miss (an added file shadows a directory index)', () => {
  const inc = openStack();
  try {
    // Own tree — writeTree only manages a fixed file set, so write directly. T0: importer resolves
    // './foo' to foo/index.ts.
    writeFileSync(
      join(inc.root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'node', skipLibCheck: true },
        include: ['src/**/*.ts'],
      }),
    );
    mkdirSync(join(inc.root, 'src', 'foo'), { recursive: true });
    writeFileSync(join(inc.root, 'src', 'importer.ts'), "import { V } from './foo';\nexport const W = V;\n");
    writeFileSync(join(inc.root, 'src', 'foo', 'index.ts'), 'export const V = 1;\n');
    const capBase = inc.snapshots.capture(capOpts(inc.root));
    const base = recognize(recOpts(inc.root, { snapshotId: capBase.record.id, captureId: capBase.captureId }));
    inc.graph.record(capBase.record.id, base, { complete: true });

    // T1: ADD foo.ts, which shadows foo/index.ts — importer now resolves './foo' to foo.ts. importer.ts
    // is byte-identical, and expandDependents queries the OLD snapshot's edges (where nobody imports the
    // not-yet-existing foo.ts), so the rescan surface does not re-extract importer: it is carried, keeping
    // the stale importer -> foo/index.ts edge whose endpoints both still exist.
    writeFileSync(join(inc.root, 'src', 'foo.ts'), 'export const V = 2;\n');
    const capTo = inc.snapshots.capture(capOpts(inc.root));
    const probe = recognize(recOpts(inc.root, { snapshotId: capTo.record.id, captureId: capTo.captureId }));
    const diff = diffSnapshots(capBase.manifest, capTo.manifest);
    const plan = inc.cache.plan(diff, { compilerOptionsHash: probe.compilerOptionsHash });
    assert.equal(plan.fullRescan, false, 'this scenario is incremental, not a full rescan');
    assert.ok(plan.fromSnapshot !== null);
    assert.ok(plan.carriedFiles.includes('src/importer.ts'), 'importer is carried, not re-extracted (the miss)');

    const previous = inc.graph.resultOf(plan.fromSnapshot);
    const previousRecognition = inc.graph.recognition(plan.fromSnapshot);
    assert.ok(previous !== null && previousRecognition !== null);
    const fresh = recognize(recOpts(inc.root, { restrictTo: plan.extractionSurface, snapshotId: capTo.record.id, captureId: capTo.captureId }));
    const merge = mergeIncrementalResult({ plan, fresh, previous, previousResultHash: previousRecognition.result_hash });

    // Both endpoints exist, so only the oracle comparison detects the divergence — the gate must reject.
    assert.equal(
      incrementalMatchesOracle(merge, probe),
      false,
      'the parity gate detects that the incremental graph diverged from the full-scan oracle',
    );
  } finally {
    inc.dispose();
  }
});

test('DEV-P0-03: recognition binds the captured snapshot bytes via the manifest-derived parity map', () => {
  const stack = openStack();
  try {
    writeFileSync(
      join(stack.root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'node', skipLibCheck: true },
        include: ['src/**/*.ts'],
      }),
    );
    mkdirSync(join(stack.root, 'src'), { recursive: true });
    writeFileSync(join(stack.root, 'src', 'a.ts'), 'export const x = 1;\n');
    const cap = stack.snapshots.capture(capOpts(stack.root));

    // The CLI's exact wiring: build the parity map from the captured manifest and pass it to recognize().
    // This also proves the manifest's path format matches the compiled program's — a mismatch would make
    // every real recognition throw.
    const snapshotFiles = new Map(cap.manifest.files.map((file) => [file.path, file.hash] as const));
    const bound = recognize(recOpts(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId, snapshotFiles }));
    assert.equal(bound.basis.snapshotParityVerified, true, 'the manifest hashes verify against the compiled program');

    // A file changed after capture no longer matches the immutable snapshot: recognition is refused.
    writeFileSync(join(stack.root, 'src', 'a.ts'), 'export const x = 2;\n');
    assert.throws(
      () => recognize(recOpts(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId, snapshotFiles })),
      RecognitionParityError,
      'recognition of a drifted tree against the captured snapshot is refused',
    );
  } finally {
    stack.dispose();
  }
});

test('the merged graph rehydrates byte-equivalent to a full scan after the database is cleared', () => {
  const s = runScenario();
  try {
    s.incStack.graph.rehydrate(s.toSnapshot);
    const rebuilt = s.incStack.graph.resultOf(s.toSnapshot);
    assert.ok(rebuilt !== null);
    const canon = (r: Pick<RecognitionResult, 'units' | 'edges' | 'unresolved'>): string =>
      JSON.stringify({
        units: [...r.units].map((u) => u.logicalId).sort(),
        edges: [...r.edges].map((e) => `${e.from}->${e.to}`).sort(),
        unresolved: [...r.unresolved].map((u) => `${u.fromLogicalId}:${u.kind}`).sort(),
      });
    assert.equal(canon(rebuilt), canon(s.fullResult), 'rehydrated graph equals the full scan');
    assert.equal(rebuilt.units.length, s.fullResult.units.length, 'every carried and re-extracted unit is present');
  } finally {
    s.incStack.dispose();
  }
});
