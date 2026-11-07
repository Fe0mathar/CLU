/**
 * DEV-P0-02 — canonical roots and symlink target identity (progress recommendation v2, §6.2).
 *
 * Complements snapshot-identity.test.ts, which already covers the content-id counterexample, excludes,
 * the executable bit, adding a skipped record, and distinct receipts. These two cover the gaps this
 * change closes: the roots are canonicalized once so order and equivalent spelling yield one identical
 * manifest (not just one id), and RE-POINTING a symlink at a different target changes identity because
 * the target text is now recorded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir as _tmpdir } from 'node:os';
import { join as _join } from 'node:path';

/* Symlink creation needs elevation/Developer Mode on Windows; where it is unavailable this
 * symlink-identity case skips rather than fails (it passes on POSIX and elevated Windows). */
function symlinksWork(): boolean {
  let dir: string | null = null;
  try { dir = mkdtempSync(_join(_tmpdir(), 'clue-symprobe-')); symlinkSync(_join(dir, 't'), _join(dir, 'l')); return true; }
  catch { return false; }
  finally { if (dir !== null) rmSync(dir, { recursive: true, force: true }); }
}
const SKIP_SYMLINK = symlinksWork() ? false : 'symlink creation needs an elevated shell or Developer Mode (Windows)';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { captureSnapshot } from '../src/analysis/source/snapshot.js';

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-snap-basis-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(root, 'lib', 'b.ts'), 'export const b = 2;\n', 'utf8');
  return root;
}

test('root order and equivalent spelling produce one identical manifest', () => {
  const root = makeTree();
  try {
    const forward = captureSnapshot({ root, sourceRoots: ['src', 'lib'] });
    const reversed = captureSnapshot({ root, sourceRoots: ['lib', 'src'] });
    const spelled = captureSnapshot({ root, sourceRoots: ['./src', 'lib', 'src'] }); // dot form + duplicate

    assert.equal(reversed.id, forward.id, 'reordered roots yield the same content id');
    assert.equal(spelled.id, forward.id, 'equivalent/duplicate spellings yield the same content id');
    // The stored manifest is canonical too — so the artifact bytes match and there is no manifest
    // conflict on re-capture. Both alternatives equal the canonical, de-duplicated, sorted list.
    assert.deepEqual(reversed.source_roots, forward.source_roots, 'the manifest stores canonical roots');
    assert.deepEqual(spelled.source_roots, forward.source_roots);
    assert.deepEqual(forward.source_roots, ['lib', 'src'], 'roots are de-duplicated and sorted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-pointing a symlink at a different target changes the content identity', { skip: SKIP_SYMLINK }, () => {
  const root = makeTree();
  try {
    symlinkSync('a.ts', join(root, 'src', 'link'));
    const before = captureSnapshot({ root, sourceRoots: ['src'] });

    // Same symlink path, different target — the file set is unchanged, only the link target moves.
    rmSync(join(root, 'src', 'link'));
    symlinkSync('../lib/b.ts', join(root, 'src', 'link'));
    const after = captureSnapshot({ root, sourceRoots: ['src'] });

    assert.deepEqual(before.files, after.files, 'the ingested file set is unchanged');
    assert.notEqual(after.id, before.id, 're-pointing the symlink changes the snapshot identity');
    const skipped = after.skipped.find((entry) => entry.path.endsWith('link'));
    assert.ok(skipped !== undefined, 'the symlink is recorded as skipped');
    assert.match(skipped.detail, /-> \.\.\/lib\/b\.ts/, 'the actual target text is recorded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});