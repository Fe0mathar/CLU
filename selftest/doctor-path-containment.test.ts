/**
 * P1-CLOSURE-DIAG-01 — doctor target-input repository containment.
 *
 * Regression guard for the Windows false-positive fixed in doctorCommands.ts:
 * `project.root` may be written with `/` while resolved target inputs use `\\`.
 * Containment must be physical, separator/case tolerant where the platform is,
 * and component-boundary exact — a sibling prefix is never inside the repository.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { isInsideTargetRepository } from '../src/cli/commands/doctorCommands.js';

const here = dirname(fileURLToPath(import.meta.url));
void here; // keep the test independent of checkout spelling; fixtures are temporary.

function fixture(): { root: string; inside: string; sibling: string; outside: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'clue-doctor-containment-'));
  const root = join(base, 'CLU');
  const sibling = join(base, 'CLU-copy');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'targets', 'clu', 'benchmark'), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const inside = join(root, 'targets', 'clu', 'benchmark', 'master-benchmark.md');
  writeFileSync(inside, 'benchmark\n', 'utf8');
  return { root, inside, sibling, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('P1-CLOSURE-DIAG-01: repository root and a descendant are inside, an outside path is not', () => {
  const f = fixture();
  try {
    assert.equal(isInsideTargetRepository(f.root, f.root), true);
    assert.equal(isInsideTargetRepository(f.root, f.inside), true);
    assert.equal(isInsideTargetRepository(f.root, join(f.outside, 'master-benchmark.md')), false);
  } finally {
    f.cleanup();
  }
});

test('P1-CLOSURE-DIAG-01: a sibling sharing the repository text prefix is not inside', () => {
  const f = fixture();
  try {
    assert.equal(isInsideTargetRepository(f.root, join(f.sibling, 'target description.md')), false);
    assert.equal(isInsideTargetRepository(f.root, `${f.root}-evil`), false);
  } finally {
    f.cleanup();
  }
});

test('P1-CLOSURE-DIAG-01: mixed slash spelling resolves to the same physical descendant', () => {
  const f = fixture();
  try {
    const mixedRoot = f.root.replace(/\\/g, '/');
    const mixedInside = f.inside.replace(/\\/g, '/');
    assert.equal(isInsideTargetRepository(mixedRoot, mixedInside), true);

    if (process.platform === 'win32') {
      const backslashInside = mixedInside.replace(/\//g, '\\');
      assert.equal(isInsideTargetRepository(mixedRoot, backslashInside), true);
    }
  } finally {
    f.cleanup();
  }
});

test('P1-CLOSURE-DIAG-01: Windows drive-letter/case variation does not create a false outside warning', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    const flipCase = (value: string): string =>
      value.replace(/^([A-Za-z]):/, (_whole, drive: string) => `${drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()}:`);
    assert.equal(isInsideTargetRepository(flipCase(f.root), f.inside), true);
  } finally {
    f.cleanup();
  }
});

test('P1-CLOSURE-DIAG-01: a lexical in-repository symlink that physically escapes is not inside', (t) => {
  const f = fixture();
  try {
    const link = join(f.root, 'escaped');
    try {
      symlinkSync(f.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.skip('symlink/junction creation unavailable on this host');
        return;
      }
      throw error;
    }
    assert.equal(isInsideTargetRepository(f.root, join(link, 'escaped.md')), false);
  } finally {
    f.cleanup();
  }
});
