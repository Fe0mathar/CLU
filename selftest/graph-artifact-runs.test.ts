/**
 * DEV-P0-05 (complete artifact + run history).
 *
 * The recognition artifact is a complete, versioned record — basis, basis hash, run identity,
 * completeness, stats, merge provenance, and the graph content — parsed strictly and content-verified
 * on every read, so a corrupt or field-missing artifact is refused rather than returned as a partial
 * graph. `result_hash` stays the content hash alone (units/edges/unresolved), so the DEV-P0-04 full-
 * equals-incremental identity is preserved, while a distinct `artifact_hash` addresses the envelope.
 * `recognitions` is the current-run pointer for a snapshot; `recognition_runs` is durable history, so
 * two runs of one snapshot that differ in basis are both queryable and identical re-runs are idempotent.
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
import { hashCanonicalJson, requireSha256 } from '../src/shared/ids.js';

interface Stack {
  readonly root: string;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  readonly snapshots: SnapshotRegistry;
  readonly graph: GraphRegistry;
  dispose(): void;
}

function openStack(): Stack {
  const root = mkdtempSync(join(tmpdir(), 'clue-artifact-runs-'));
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
    artifacts,
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
const rec = (root: string, extra: Record<string, unknown> = {}) =>
  recognize({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), ...extra });
const capture = (stack: Stack) => stack.snapshots.capture({ root: stack.root, sourceRoots: ['src'], origin: 'canonical' });

test('the stored artifact is a complete versioned record and result_hash stays content-only', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, { 'a.ts': 'export function target(): void {}\nexport function caller(): void { target(); }\n' });
    const cap = capture(stack);
    const result = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    const recorded = stack.graph.record(cap.record.id, result, { complete: true });

    const artifact = stack.artifacts.getJson(requireSha256(recorded.record.artifact_hash ?? '', 'artifact hash')) as Record<string, unknown>;
    for (const field of ['schema_version', 'content_hash', 'basis', 'basis_hash', 'run_key', 'complete', 'stats', 'merge', 'units', 'edges', 'unresolved']) {
      assert.ok(field in artifact, `artifact carries ${field}`);
    }
    assert.equal(artifact['schema_version'], 1, 'the artifact is versioned');

    const content = stack.graph.resultOf(cap.record.id);
    assert.ok(content !== null);
    assert.equal(content.units.length, result.units.length, 'resultOf strict-parses and returns the content');
    assert.equal(
      recorded.record.result_hash,
      hashCanonicalJson({ units: content.units, edges: content.edges, unresolved: content.unresolved }),
      'result_hash is the content hash alone (DEV-P0-04 identity preserved)',
    );
    assert.notEqual(recorded.record.result_hash, recorded.record.artifact_hash, 'artifact_hash is distinct');
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('a corrupt or field-missing artifact is refused on read', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, { 'a.ts': 'export function t(): void {}\nexport function c(): void { t(); }\n' });
    const cap = capture(stack);
    const result = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    const recorded = stack.graph.record(cap.record.id, result, { complete: true });
    const artifact = stack.artifacts.getJson(requireSha256(recorded.record.artifact_hash ?? '', 'artifact hash')) as Record<string, unknown>;

    // Content tampered so it no longer matches content_hash.
    const units = artifact['units'] as Record<string, unknown>[];
    const tampered = { ...artifact, units: [...units, { ...units[0], logicalId: 'src/a.ts#ghost' }] };
    const tamperedHash = stack.artifacts.putJson(tampered).hash;
    stack.projections.db.prepare('UPDATE recognitions SET artifact_hash = ? WHERE snapshot_id = ?').run(tamperedHash, cap.record.id);
    assert.throws(
      () => stack.graph.resultOf(cap.record.id),
      (e: unknown) => e instanceof GraphIntegrityError && /content-hash/.test(String((e as Error).message)),
      'content that no longer matches its hash is refused',
    );

    // A required field removed.
    const withoutBasis: Record<string, unknown> = { ...artifact };
    delete withoutBasis['basis'];
    const missingHash = stack.artifacts.putJson(withoutBasis).hash;
    stack.projections.db.prepare('UPDATE recognitions SET artifact_hash = ? WHERE snapshot_id = ?').run(missingHash, cap.record.id);
    assert.throws(() => stack.graph.resultOf(cap.record.id), 'an artifact missing a required field is refused');
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('two runs of one snapshot are separately queryable and identical re-runs are idempotent', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, { 'a.ts': 'export const x = 1;\n' });
    const cap = capture(stack);
    const lockA = 'a'.repeat(64);
    const lockB = 'b'.repeat(64);
    // Same content, two different bases (a dependency lock changed) → two distinct run keys.
    const rec1 = stack.graph.record(cap.record.id, rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId, lockfileHash: lockA }), { complete: true });
    const rec2 = stack.graph.record(cap.record.id, rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId, lockfileHash: lockB }), { complete: true });

    const runs = stack.graph.runsOf(cap.record.id);
    assert.equal(runs.length, 2, 'both runs are recorded in the durable history');
    assert.notEqual(runs[0]?.runKey, runs[1]?.runKey, 'the two runs have distinct run keys');
    assert.equal(rec1.record.result_hash, rec2.record.result_hash, 'same content yields the same result hash');
    assert.equal(stack.graph.recognition(cap.record.id)?.run_key, rec2.record.run_key, 'recognition() is the current-run pointer');

    // Identical re-run of the second basis → same run_key → no new history row.
    stack.graph.record(cap.record.id, rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId, lockfileHash: lockB }), { complete: true });
    assert.equal(stack.graph.runsOf(cap.record.id).length, 2, 'an identical re-run adds no duplicate history row');
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('DEV-P0-05: a complete re-record replaces the snapshot graph exactly, leaving no stale rows', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, {
      'a.ts': 'export function A(): void {}\nexport function B(): void {}\nexport function caller(): void { A(); }\n',
    });
    const cap = capture(stack);
    const r1 = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    stack.graph.record(cap.record.id, r1, { complete: true });

    // The same snapshot id recognised again with caller -> B instead of caller -> A.
    writeFileSync(
      join(stack.root, 'src', 'a.ts'),
      'export function A(): void {}\nexport function B(): void {}\nexport function caller(): void { B(); }\n',
    );
    const r2 = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    stack.graph.record(cap.record.id, r2, { complete: true });

    assert.notEqual(
      JSON.stringify(r1.edges.map((e) => e.to).sort()),
      JSON.stringify(r2.edges.map((e) => e.to).sort()),
      'the two complete results genuinely differ (caller retargeted A -> B)',
    );
    const persisted = stack.projections.db
      .prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ?')
      .get(cap.record.id) as { n: number };
    assert.equal(
      persisted.n,
      r2.edges.length,
      'the persisted edge set equals the latest complete result — the stale caller->A edge did not survive a merge',
    );
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('DEV-P0-05: re-recognising a snapshot replaces every pointer column, not only the selected ones', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, { 'a.ts': 'export const x = 1;\n' });
    const cap = capture(stack);
    const r1 = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    stack.graph.record(cap.record.id, r1, { complete: true });

    // A second file changes files_in_program / files_recognised for the same snapshot id.
    writeFileSync(join(stack.root, 'src', 'b.ts'), 'export const y = 2;\n');
    const r2 = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    assert.notEqual(r1.stats.filesRecognised, r2.stats.filesRecognised, 'the two runs genuinely differ in a stat field');
    stack.graph.record(cap.record.id, r2, { complete: true });

    const row = stack.projections.db
      .prepare('SELECT files_in_program, files_recognised FROM recognitions WHERE snapshot_id = ?')
      .get(cap.record.id) as { files_in_program: number; files_recognised: number };
    assert.equal(row.files_recognised, r2.stats.filesRecognised, 'files_recognised reflects the latest run, not a stale value');
    assert.equal(row.files_in_program, r2.stats.filesInProgram, 'files_in_program is refreshed on re-recognition, not left behind');
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('DEV-P0-05: a structurally malformed nested value is refused even when the content hash matches', () => {
  const stack = openStack();
  try {
    writeTree(stack.root, { 'a.ts': 'export function t(): void {}\n' });
    const cap = capture(stack);
    const result = rec(stack.root, { snapshotId: cap.record.id, captureId: cap.captureId });
    const recorded = stack.graph.record(cap.record.id, result, { complete: true });
    const artifact = stack.artifacts.getJson(requireSha256(recorded.record.artifact_hash ?? '', 'artifact hash')) as Record<string, unknown>;

    // Corrupt a unit's kind to an invalid enum value, then RECOMPUTE content_hash and the row's
    // result_hash so both hash checks would pass — only strict nested validation can catch this.
    const units = (artifact['units'] as Record<string, unknown>[]).map((u, i) => (i === 0 ? { ...u, kind: 'bogus-kind' } : u));
    const contentHash = hashCanonicalJson({ units, edges: artifact['edges'], unresolved: artifact['unresolved'] });
    const malformed = { ...artifact, units, content_hash: contentHash };
    const h = stack.artifacts.putJson(malformed).hash;
    stack.projections.db
      .prepare('UPDATE recognitions SET artifact_hash = ?, result_hash = ? WHERE snapshot_id = ?')
      .run(h, contentHash, cap.record.id);

    assert.throws(
      () => stack.graph.resultOf(cap.record.id),
      'a unit with an invalid kind is refused by strict nested validation, not merely by a hash check',
    );
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});
