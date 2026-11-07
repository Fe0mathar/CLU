/**
 * DEV-P0-02 — snapshot content identity.
 *
 * The contract: one snapshot content id identifies exactly one immutable manifest. The id is a hash
 * of the full governed capture basis — normalised source roots, effective excludes, the executable
 * mode of each file, and the skipped/symlink/special records — not of file paths+hashes alone. So two
 * different governed bases can never collide on an id while carrying different manifests, and the
 * projector enforces that invariant on replay rather than silently keeping whichever landed first.
 * Volatile facts (capture time, Git state) live in the capture receipt, which varies per capture
 * while the content id stays fixed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir as _tmpdir } from 'node:os';
import { join as _join } from 'node:path';

/* Windows filesystem limits, not code defects: creating a symlink needs elevation/Developer Mode, and
 * chmod cannot set the Unix executable bit at all. Where the capability is absent, the dependent case
 * skips rather than fails (both pass on POSIX and, for symlinks, on an elevated Windows shell). */
function symlinksWork(): boolean {
  let dir: string | null = null;
  try { dir = mkdtempSync(_join(_tmpdir(), 'clue-symprobe-')); symlinkSync(_join(dir, 't'), _join(dir, 'l')); return true; }
  catch { return false; }
  finally { if (dir !== null) rmSync(dir, { recursive: true, force: true }); }
}
function execBitWorks(): boolean {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(_join(_tmpdir(), 'clue-execprobe-'));
    const f = _join(dir, 'f');
    writeFileSync(f, 'x');
    chmodSync(f, 0o755);
    return (statSync(f).mode & 0o111) !== 0;
  } catch { return false; }
  finally { if (dir !== null) rmSync(dir, { recursive: true, force: true }); }
}
const SKIP_SYMLINK = symlinksWork() ? false : 'symlink creation needs an elevated shell or Developer Mode (Windows)';
const SKIP_EXEC_BIT = execBitWorks() ? false : 'the filesystem does not honour the Unix executable bit (Windows)';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  captureSnapshot,
  diffSnapshots,
  SnapshotRegistry,
  SNAPSHOT_PROJECTORS,
  ensureSnapshotSchema,
  SnapshotIdentityError,
} from '../src/analysis/source/snapshot.js';
import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { hashText } from '../src/shared/ids.js';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-snap-id-'));
  mkdirSync(join(root, 'src', 'sub'), { recursive: true });
  writeFileSync(join(root, 'src', 'sub', 'a.ts'), 'export const a = 1;\n');
  return root;
}

const json = (v: unknown): string => JSON.stringify(v);

test('different governed bases cannot share a content id (the DEV-P0-02 counterexample)', () => {
  const root = makeProject();
  try {
    // Same file (src/sub/a.ts) is the only included file under both roots, so the file records match.
    const a = captureSnapshot({ root, sourceRoots: ['src'] });
    const b = captureSnapshot({ root, sourceRoots: ['src/sub'] });
    assert.equal(json(a.files), json(b.files), 'both capture the identical file record');
    assert.notEqual(a.id, b.id, 'different source roots must produce different content ids');
    assert.notEqual(json(a), json(b), 'the manifests genuinely differ');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged content and basis yield one content id and one manifest', () => {
  const root = makeProject();
  try {
    const a = captureSnapshot({ root, sourceRoots: ['src'] });
    const b = captureSnapshot({ root, sourceRoots: ['src'] });
    assert.equal(a.id, b.id);
    assert.equal(json(a), json(b), 'the manifest is byte-identical');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the exclude policy is part of identity even when the included files are identical', () => {
  const root = makeProject();
  try {
    const x = captureSnapshot({ root, sourceRoots: ['src'], excludeExtensions: [] });
    const y = captureSnapshot({ root, sourceRoots: ['src'], excludeExtensions: ['zzz'] });
    assert.equal(json(x.files), json(y.files), 'the excluded extension is absent, so files match');
    assert.notEqual(x.id, y.id, 'a different effective exclude policy changes the content id');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the executable bit is part of identity but does not change the file content hash', { skip: SKIP_EXEC_BIT }, () => {
  const root = makeProject();
  try {
    const before = captureSnapshot({ root, sourceRoots: ['src'] });
    chmodSync(join(root, 'src', 'sub', 'a.ts'), 0o755);
    const after = captureSnapshot({ root, sourceRoots: ['src'] });
    assert.equal(before.files[0]?.hash, after.files[0]?.hash, 'content hash is unaffected by chmod');
    assert.equal(before.files[0]?.executable, false);
    assert.equal(after.files[0]?.executable, true);
    assert.notEqual(before.id, after.id, 'the executable-bit change changes the content id');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a change in skipped/symlink records changes the content id', { skip: SKIP_SYMLINK }, () => {
  const root = makeProject();
  try {
    const before = captureSnapshot({ root, sourceRoots: ['src'] });
    symlinkSync(join(root, 'src', 'sub', 'a.ts'), join(root, 'src', 'link.ts'));
    const after = captureSnapshot({ root, sourceRoots: ['src'] });
    assert.equal(json(before.files), json(after.files), 'the symlink is skipped, not ingested');
    assert.ok(after.skipped.length > before.skipped.length, 'a skipped record was added');
    assert.notEqual(before.id, after.id, 'the skipped-record change changes the content id');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one content id cannot carry two manifests, and replay order cannot select one', () => {
  const wsRoot = mkdtempSync(join(tmpdir(), 'clue-snap-inv-'));
  const store = new ProjectionStore(join(wsRoot, 'clue.db'), { projectors: SNAPSHOT_PROJECTORS });
  try {
    ensureSnapshotSchema(store.db);
    const project = SNAPSHOT_PROJECTORS['snapshot.captured'];
    assert.ok(project !== undefined);
    const id = hashText('collision-id');
    const rec = (manifestHash: string, when: string): { payload: unknown } => ({
      payload: {
        id,
        manifest_hash: manifestHash,
        file_count: 1,
        total_bytes: 1,
        skipped_count: 0,
        captured_at: when,
        git_commit: null,
        git_branch: null,
        git_dirty: false,
        origin: 'canonical',
      },
    });
    const countFor = (): number =>
      (store.db.prepare('SELECT COUNT(*) AS c FROM snapshots WHERE id = ?').get(id) as { c: number }).c;

    project(store.db, rec(hashText('manifest-1'), '2026-01-01T00:00:00.000Z') as never);
    assert.equal(countFor(), 1, 'first manifest recorded');

    assert.throws(
      () => project(store.db, rec(hashText('manifest-2'), '2026-01-02T00:00:00.000Z') as never),
      SnapshotIdentityError,
      'a different manifest under the same id throws instead of being silently ignored',
    );

    // Same manifest under the same id is idempotent (replay / re-capture).
    project(store.db, rec(hashText('manifest-1'), '2026-01-03T00:00:00.000Z') as never);
    const stored = (store.db.prepare('SELECT manifest_hash FROM snapshots WHERE id = ?').get(id) as {
      manifest_hash: string;
    }).manifest_hash;
    assert.equal(stored, hashText('manifest-1'), 'the persisted manifest is the first, never crossed');
  } finally {
    store.close();
    rmSync(wsRoot, { recursive: true, force: true });
  }
});

test('repeated captures create distinct receipts without changing content identity', () => {
  const proj = makeProject();
  const ws = mkdtempSync(join(tmpdir(), 'clue-snap-reg-'));
  for (const d of ['db', 'events', 'blobs', 'logs']) mkdirSync(join(ws, d), { recursive: true });
  const projections = new ProjectionStore(join(ws, 'db', 'clue.db'), { projectors: SNAPSHOT_PROJECTORS });
  const { log } = EventLog.open(join(ws, 'events'));
  try {
    ensureSnapshotSchema(projections.db);
    const artifacts = new ArtifactStore(join(ws, 'blobs'));
    const registry = new SnapshotRegistry({ log, projections, artifacts, missionVersion: () => 'MISSION-000001' });

    const one = registry.capture({ root: proj, sourceRoots: ['src'], origin: 'canonical' });
    const two = registry.capture({ root: proj, sourceRoots: ['src'], origin: 'canonical' });

    assert.equal(one.record.id, two.record.id, 'same content id');
    assert.notEqual(one.captureId, two.captureId, 'distinct capture receipts');
    const receipts = (projections.db
      .prepare('SELECT COUNT(*) AS c FROM snapshot_captures WHERE snapshot_id = ?')
      .get(one.record.id) as { c: number }).c;
    assert.equal(receipts, 2, 'two receipts for the one content id');
    const snaps = (projections.db
      .prepare('SELECT COUNT(*) AS c FROM snapshots WHERE id = ?')
      .get(one.record.id) as { c: number }).c;
    assert.equal(snaps, 1, 'exactly one immutable snapshot row');
  } finally {
    log.close();
    projections.close();
    rmSync(proj, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
test('root order, equivalent spelling, and duplicates produce one identical content manifest (DEV-P0-02)', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-snap-roots-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'lib', 'c.ts'), 'export const c = 3;\n');
  try {
    const canonical = captureSnapshot({ root, sourceRoots: ['src', 'lib'] });
    for (const variant of [
      captureSnapshot({ root, sourceRoots: ['lib', 'src'] }), // reordered
      captureSnapshot({ root, sourceRoots: ['./src', 'lib'] }), // equivalent spelling
      captureSnapshot({ root, sourceRoots: ['src', 'src', 'lib', './lib'] }), // duplicates
    ]) {
      assert.equal(variant.id, canonical.id, 'the content identity is the same');
      assert.equal(json(variant), json(canonical), 'the stored manifest is byte-identical');
    }
    // A genuinely narrower root set is a different snapshot.
    assert.notEqual(captureSnapshot({ root, sourceRoots: ['src'] }).id, canonical.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an injected mode provider binds executable identity independent of local filesystem mode (DEV-P0-02)', () => {
  const root = makeProject();
  try {
    // On this POSIX host a plain source file is not executable by local mode.
    const local = captureSnapshot({ root, sourceRoots: ['src'] });
    const localFile = local.files.find((file) => file.path.endsWith('a.ts'));
    assert.ok(localFile !== undefined);
    assert.equal(localFile.executable, false);

    // A provider standing in for Git's recorded mode (100755) is authoritative; identity changes.
    const provider = (path: string): boolean | null => (path.endsWith('a.ts') ? true : false);
    const recorded = captureSnapshot({ root, sourceRoots: ['src'], executableOf: provider });
    const recordedFile = recorded.files.find((file) => file.path.endsWith('a.ts'));
    assert.ok(recordedFile !== undefined);
    assert.equal(recordedFile.executable, true, 'the provider overrides local mode');
    assert.notEqual(recorded.id, local.id, 'the executable bit participates in identity');

    // Because the provider, not the platform, decides, two hosts with the same recorded modes agree.
    const recordedAgain = captureSnapshot({ root, sourceRoots: ['src'], executableOf: provider });
    assert.equal(json(recordedAgain), json(recorded), 'the same recorded modes yield one manifest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-02: an executable-mode change shows as modified in the diff, even with identical bytes', () => {
  const root = makeProject();
  try {
    const before = captureSnapshot({ root, sourceRoots: ['src'], executableOf: () => false });
    const after = captureSnapshot({ root, sourceRoots: ['src'], executableOf: () => true });

    const [b] = before.files;
    const [a] = after.files;
    assert.ok(b !== undefined && a !== undefined, 'one file captured');
    assert.equal(b.hash, a.hash, 'content is byte-identical');
    assert.notEqual(b.executable, a.executable, 'only the executable bit changed');

    const diff = diffSnapshots(before, after);
    assert.equal(diff.modified.length, 1, 'the mode-only change is a modification, not unchanged');
    assert.equal(diff.unchangedCount, 0, 'it is not counted as unchanged');
    assert.ok(diff.changedPaths.includes(b.path), 'and it lands in the invalidation set');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});