/**
 * DEV-P0-01 — a projection rebuild restores every table, including the artifact-backed index.
 *
 * `snapshot_files` is only an index over each snapshot's manifest artifact; it is filled at capture,
 * not by event replay, so before this fix a rebuild left it empty. The snapshots module now carries a
 * rehydrate hook (`SnapshotRegistry.rehydrateAll`) that rebuilds the index from the stored manifests.
 * This proves the canonical acceptance for the snapshot family: poison a row in each snapshot
 * projection, clear and replay the projections, rehydrate, and show the rebuilt tables equal the clean
 * build — no poison row survives and no real row disappears.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { SnapshotRegistry } from '../src/analysis/source/snapshot.js';
import { AuditLog } from '../src/control/audit.js';
import { SecretRegistry } from '../src/control/policy.js';
import { TaskQueue, TASK_PROJECTORS } from '../src/control/tasks.js';
import { hashText } from '../src/shared/ids.js';
import { buildProjectionModules, type ProjectionRehydrators } from '../src/control/projectionModules.js';

interface Stack {
  readonly root: string;
  readonly projections: ProjectionStore;
  readonly log: EventLog;
  readonly snapshots: SnapshotRegistry;
  readonly audit: AuditLog;
  readonly queue: TaskQueue;
  dispose(): void;
}

function openStack(): Stack {
  const root = mkdtempSync(join(tmpdir(), 'clue-rebuild-'));
  const ws = join(root, 'workspace');
  for (const d of ['db', 'events', 'blobs', 'logs']) mkdirSync(join(ws, d), { recursive: true });
  // A small source tree to capture.
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(root, 'src', 'b.ts'), 'export function b(): number { return 2; }\n', 'utf8');

  const rehydrators: ProjectionRehydrators = {};
  const projections = new ProjectionStore(join(ws, 'db', 'clue.db'), {
    modules: buildProjectionModules(rehydrators),
    projectors: { ...TASK_PROJECTORS },
    rehydrateKernel: () => {
      rehydrators.audit?.();
    },
  });
  const artifacts = new ArtifactStore(join(ws, 'blobs'));
  const { log } = EventLog.open(join(ws, 'events'));
  const missionVersion = (): string => 'MISSION-000001';
  const snapshots = new SnapshotRegistry({ log, projections, artifacts, missionVersion });
  const audit = new AuditLog(join(ws, 'logs'), projections, new SecretRegistry());
  const queue = new TaskQueue({ log, projections, missionVersion });
  rehydrators.snapshots = () => snapshots.rehydrateAll();
  rehydrators.audit = () => audit.reindex();

  return {
    root,
    projections,
    log,
    snapshots,
    audit,
    queue,
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

// A deterministic, canonical dump of a table for before/after comparison.
const dump = (projections: ProjectionStore, sql: string): string =>
  JSON.stringify(projections.db.prepare(sql).all());

test('a rebuild restores snapshot_files from the manifest and removes poison rows', () => {
  const stack = openStack();
  try {
    stack.snapshots.capture({ root: stack.root, sourceRoots: ['src'], origin: 'canonical' });

    // The clean build: capture the exact contents of each snapshot projection.
    const cleanFiles = dump(stack.projections, 'SELECT * FROM snapshot_files ORDER BY snapshot_id, path');
    const cleanSnapshots = dump(stack.projections, 'SELECT * FROM snapshots ORDER BY id');
    const cleanCaptures = dump(stack.projections, 'SELECT * FROM snapshot_captures ORDER BY capture_id');
    assert.notEqual(cleanFiles, '[]', 'the clean build indexed some files');

    // Poison a row in each snapshot projection family.
    stack.projections.db
      .prepare(
        `INSERT INTO snapshot_files (snapshot_id, path, hash, bytes, language, executable)
         VALUES ('SNAP-poison', 'src/poison.ts', ?, 999, 'typescript', 0)`,
      )
      .run('f'.repeat(64));
    stack.projections.db
      .prepare(
        `INSERT INTO snapshots (id, manifest_hash, file_count, total_bytes, skipped_count)
         VALUES ('SNAP-poison', ?, 42, 4242, 0)`,
      )
      .run('e'.repeat(64));

    // Confirm the poison is really there before the rebuild.
    assert.notEqual(dump(stack.projections, 'SELECT * FROM snapshot_files ORDER BY snapshot_id, path'), cleanFiles);

    // Delete-and-rebuild: clear every projection, replay the log, rehydrate the artifact-backed index.
    stack.projections.rebuild(stack.log);

    // The rebuilt projections must equal the clean build exactly — poison gone, real rows restored.
    assert.equal(
      dump(stack.projections, 'SELECT * FROM snapshot_files ORDER BY snapshot_id, path'),
      cleanFiles,
      'snapshot_files is restored from the manifest, with no poison row and no missing row',
    );
    assert.equal(dump(stack.projections, 'SELECT * FROM snapshots ORDER BY id'), cleanSnapshots, 'snapshots receipt restored');
    assert.equal(
      dump(stack.projections, 'SELECT * FROM snapshot_captures ORDER BY capture_id'),
      cleanCaptures,
      'snapshot_captures restored',
    );
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('a rebuild reindexes audit_entries from the durable audit file and removes poison rows', () => {
  const stack = openStack();
  try {
    // Record real audit entries; each is appended to the durable file and indexed into audit_entries.
    stack.audit.record({ actor: 'daemon', command: 'test.one', capability: 'fs.read.workspace', decision: 'allowed', missionVersion: 'MISSION-000001' });
    stack.audit.record({ actor: 'daemon', command: 'test.two', capability: 'fs.write.workspace', decision: 'denied', reason: 'no token', missionVersion: 'MISSION-000001' });

    const cleanAudit = dump(stack.projections, 'SELECT * FROM audit_entries ORDER BY id');
    assert.notEqual(cleanAudit, '[]', 'the clean build indexed the audit entries');

    // Poison the audit index with a row that has no backing in the durable file.
    stack.projections.db
      .prepare(
        `INSERT INTO audit_entries
           (id, timestamp, actor, command, capability, target, arguments_digest, decision, reason, mission_version, duration_ms)
         VALUES ('AUDIT-poison', '2000-01-01T00:00:00.000Z', 'attacker', 'forged', 'settlement.real', NULL, ?, 'allowed', NULL, 'MISSION-000001', NULL)`,
      )
      .run('a'.repeat(64));
    assert.notEqual(dump(stack.projections, 'SELECT * FROM audit_entries ORDER BY id'), cleanAudit);

    // Rebuild: audit_entries is a kernel table, cleared by the rebuild and reindexed from the file.
    stack.projections.rebuild(stack.log);

    assert.equal(
      dump(stack.projections, 'SELECT * FROM audit_entries ORDER BY id'),
      cleanAudit,
      'audit_entries is reindexed from the durable file, with no poison row and no missing entry',
    );
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('the whole-surface canonical digest is identical after poisoning every family and rebuilding', () => {
  const stack = openStack();
  try {
    // Populate several projection families across the artifact-backed, event-projected, and kernel kinds.
    stack.snapshots.capture({ root: stack.root, sourceRoots: ['src'], origin: 'canonical' });
    stack.queue.create({ type: 'ANALYSE', lane: 'analysis', priority: 0.5, inputHash: hashText('unit-a') });
    stack.queue.create({ type: 'ANALYSE', lane: 'analysis', priority: 0.7, inputHash: hashText('unit-b') });
    stack.audit.record({ actor: 'daemon', command: 'test.audit', capability: 'fs.read.workspace', decision: 'allowed', missionVersion: 'MISSION-000001' });

    // The canonical, order-independent digest of the entire projection surface — the P0-01 instrument.
    const cleanDigest = stack.projections.canonicalExportDigest();

    // Poison one row in each family: an artifact-backed index, an event-projected table, and the
    // kernel audit index.
    stack.projections.db
      .prepare(
        `INSERT INTO snapshot_files (snapshot_id, path, hash, bytes, language, executable)
         VALUES ('SNAP-poison', 'src/poison.ts', ?, 1, 'typescript', 0)`,
      )
      .run('f'.repeat(64));
    stack.projections.db
      .prepare(
        `INSERT INTO tasks (id, signature, type, lane, lane_weight, priority, state, mission_version,
                            input_hash, budget, spent, attempts, max_attempts, available_at, created_at, updated_at)
         VALUES ('TASK-poison', ?, 'ANALYSE', 'analysis', 1.0, 0.9, 'pending', 'MISSION-000001',
                 ?, 0, 0, 0, 3, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
      )
      .run(hashText('poison-signature'), hashText('poison'));
    stack.projections.db
      .prepare(
        `INSERT INTO audit_entries
           (id, timestamp, actor, command, capability, target, arguments_digest, decision, reason, mission_version, duration_ms)
         VALUES ('AUDIT-poison', '2000-01-01T00:00:00.000Z', 'attacker', 'forged', 'settlement.real', NULL, ?, 'allowed', NULL, 'MISSION-000001', NULL)`,
      )
      .run('a'.repeat(64));

    // The poison really changed the surface.
    assert.notEqual(stack.projections.canonicalExportDigest(), cleanDigest);

    // Delete-and-rebuild the entire surface.
    stack.projections.rebuild(stack.log);

    // Every table, plus the recorded head, digests back to exactly the clean build.
    assert.equal(
      stack.projections.canonicalExportDigest(),
      cleanDigest,
      'the whole projection surface rebuilds to the clean digest — no poison survives, no row disappears',
    );
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});

test('DEV-P0-10: projection staleness is re-detected live after the log advances past the projections', () => {
  const stack = openStack();
  try {
    // Bring the projections in step with the log via a synced write.
    stack.queue.create({ type: 'ANALYSE', lane: 'analysis', priority: 0.5, inputHash: hashText('fresh-check') });
    assert.equal(stack.projections.isStale(stack.log), false, 'projections are fresh right after a synced write');

    // Advance the log WITHOUT syncing the projections — exactly what a second writer does while a
    // read-only runtime stays attached. The freshness gate re-reads the head on every call (it no
    // longer trusts a value cached at startup), so the divergence is now visible.
    stack.log.append({
      type: 'task.created',
      actor: 'daemon',
      missionVersion: 'MISSION-000001',
      subjectId: 'TASK-000999',
      payload: { note: 'appended out of band' },
    });

    assert.equal(stack.projections.isStale(stack.log), true, 'the advanced log is detected as stale on the next check');
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true });
  }
});
