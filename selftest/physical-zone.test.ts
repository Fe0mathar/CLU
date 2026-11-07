/**
 * DEV-P0-08 — physical zone resolution.
 *
 * Lexical normalization judges a path by its spelling; `resolvePhysicalPath` judges it by where it
 * actually lands, following symlinks (and Windows junctions on that platform). This proves the engine
 * classifies a target by its real location — so a symlink inside the workspace that points into the
 * canonical tree is refused as a canonical write, not allowed by its workspace spelling — and that a
 * not-yet-created path is resolved through its nearest existing (possibly linked) ancestor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PolicyEngine, SecretRegistry, resolvePhysicalPath, normaliseAbsolute, sourceRootOutsideProject } from '../src/control/policy.js';
import { type ClueConfig } from '../src/shared/schemas.js';

/* Creating a symlink needs an elevated shell or Developer Mode on Windows; without that privilege
 * symlinkSync throws EPERM. These cases are about symlink RESOLUTION (a POSIX and elevated-Windows
 * property), so where the privilege is absent they skip rather than fail. */
function symlinksWork(): boolean {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'clue-symprobe-'));
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  }
}
const SKIP_SYMLINK = symlinksWork() ? false : 'symlink creation needs an elevated shell or Developer Mode (Windows)';

function makeZones(): { root: string; canonical: string; workspace: string; shadow: string; profile: string } {
  const root = mkdtempSync(join(tmpdir(), 'clue-zones-'));
  const canonical = join(root, 'canonical');
  const workspace = join(root, 'workspace');
  const shadow = join(root, 'shadow');
  const profile = join(root, 'profile');
  for (const dir of [canonical, workspace, shadow, profile]) mkdirSync(dir, { recursive: true });
  // A symlink inside the workspace that points into the canonical tree.
  symlinkSync(canonical, join(workspace, 'sneaky'));
  return { root, canonical, workspace, shadow, profile };
}

test('resolvePhysicalPath follows symlinks and resolves not-yet-created paths through their ancestor', { skip: SKIP_SYMLINK }, () => {
  const z = makeZones();
  try {
    // A leaf under a symlinked directory resolves to the link target's real location.
    assert.equal(
      resolvePhysicalPath(join(z.workspace, 'sneaky', 'file.txt')),
      normaliseAbsolute(join(z.canonical, 'file.txt')),
      'a path under a symlink lands in the real target',
    );
    // A not-yet-created path under a real directory keeps its lexical suffix.
    assert.equal(
      resolvePhysicalPath(join(z.workspace, 'nope', 'deep.txt')),
      normaliseAbsolute(join(z.workspace, 'nope', 'deep.txt')),
      'a missing path resolves through its nearest existing ancestor',
    );
    // A path with no existing component falls back to lexical normalisation.
    assert.equal(resolvePhysicalPath('/no/such/root/x'), normaliseAbsolute('/no/such/root/x'));
  } finally {
    rmSync(z.root, { recursive: true, force: true });
  }
});

test('a workspace write through a symlink into the canonical tree is refused as a canonical write', { skip: SKIP_SYMLINK }, () => {
  const z = makeZones();
  try {
    const config = {
      project: { root: z.canonical },
      workspace: { root: z.workspace },
      shadow: { root: z.shadow },
      browser: { profile_dir: z.profile },
      security: { canonical_source_writes: 'denied' },
      patching: { landing_branch_prefix: 'clue/accepted/' },
    } as unknown as ClueConfig;
    const policy = new PolicyEngine(config, new SecretRegistry());
    const token = policy.issueToken('daemon', ['fs.write.workspace'], { subjectId: 'TASK-A', purpose: 'refute', attempt: 1 });
    const base = {
      actor: 'daemon' as const,
      capability: 'fs.write.workspace' as const,
      command: 'test',
      tokenSecret: token.secret,
      subjectId: 'TASK-A',
      purpose: 'refute' as const,
      attempt: 1,
    };

    // A genuine workspace write is allowed.
    const normal = policy.evaluate({ ...base, target: join(z.workspace, 'normal.txt') });
    assert.equal(normal.decision, 'allowed', 'a real workspace write is permitted');

    // A write to a symlink that physically lands in the canonical tree is refused — by where it lands,
    // not by its workspace spelling. Lexical classification would have allowed this escape.
    const escape = policy.evaluate({ ...base, target: join(z.workspace, 'sneaky', 'evil.txt') });
    assert.equal(escape.decision, 'denied', 'the symlink escape is refused');
    // The physical target is the canonical tree, so the workspace capability no longer matches its
    // zone; lexical classification would have judged it a workspace write and allowed it.
    assert.ok(
      escape.code === 'ZONE_MISMATCH' || escape.code === 'CANONICAL_WRITE_FORBIDDEN',
      `refused for landing outside the workspace zone (got ${escape.code})`,
    );
  } finally {
    rmSync(z.root, { recursive: true, force: true });
  }
});

test('DEV-P0-08: a source root that resolves outside the project tree is refused', { skip: SKIP_SYMLINK }, () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-srcroot-'));
  try {
    const project = join(root, 'project');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(root, 'outside'), { recursive: true });
    // A symlink inside the project that points to a sibling directory outside it.
    symlinkSync(join(root, 'outside'), join(project, 'escape'));

    // Legitimate roots inside the project are accepted, including a not-yet-created subdirectory.
    assert.equal(sourceRootOutsideProject(project, ['src']), null, 'a real in-project root passes');
    assert.equal(sourceRootOutsideProject(project, ['src/pending']), null, 'a not-yet-created in-project root passes');

    // A symlink that physically lands outside the project is refused.
    assert.ok(sourceRootOutsideProject(project, ['escape']) !== null, 'a symlink escaping the project is refused');
    // A parent-traversal root is refused.
    assert.ok(sourceRootOutsideProject(project, ['../outside']) !== null, 'a ".." root is refused');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});