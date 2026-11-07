import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PathIdentityError,
  asTargetRootIdentity,
  assertPathIdentity,
  assertPathZonesDisjoint,
  normaliseIdentityPath,
  pathIdentitiesEqual,
  resolvePathIdentity,
} from '../src/shared/pathIdentity.js';

function withFixture(action: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'clue-path-identity-'));
  try {
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof PathIdentityError ? error.code : null;
  }
}

test('PP-01: textual aliases resolve to one physical target identity', () => {
  withFixture((root) => {
    const target = join(root, 'target');
    mkdirSync(join(target, 'nested'), { recursive: true });

    const direct = resolvePathIdentity(target, { zone: 'target', expectedKind: 'directory' });
    const dot = resolvePathIdentity(join(target, '.'), { zone: 'target', expectedKind: 'directory' });
    const dotDot = resolvePathIdentity(join(target, 'nested', '..'), {
      zone: 'target',
      expectedKind: 'directory',
    });
    const relative = resolvePathIdentity('target', {
      zone: 'target',
      baseDir: root,
      expectedKind: 'directory',
    });

    assert.equal(direct.identity, dot.identity);
    assert.equal(direct.identity, dotDot.identity);
    assert.equal(direct.identity, relative.identity);
    assert.ok(pathIdentitiesEqual(direct, relative));
    assert.match(asTargetRootIdentity(direct.identity), /^path:v1:[a-z0-9._-]+:[0-9a-f]{64}$/u);
    assert.doesNotThrow(() => assertPathIdentity(direct.identity, relative));
  });
});

test('PP-01: a symlink/junction alias resolves to the same physical root when supported', () => {
  withFixture((root) => {
    const target = join(root, 'target');
    const alias = join(root, 'target-alias');
    mkdirSync(target, { recursive: true });
    try {
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      // Windows may deny symlink creation in constrained CI. Junction normally succeeds, but a
      // skipped host capability must not make the portable identity assertions disappear.
      assert.ok(error instanceof Error);
      return;
    }

    const physical = resolvePathIdentity(target, { zone: 'target', expectedKind: 'directory' });
    const linked = resolvePathIdentity(alias, { zone: 'target', expectedKind: 'directory' });
    assert.equal(linked.identity, physical.identity);
    assert.equal(linked.canonicalPath, physical.canonicalPath);
  });
});

test('PP-01: different physical targets do not collide', () => {
  withFixture((root) => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);
    const left = resolvePathIdentity(a, { zone: 'target', expectedKind: 'directory' });
    const right = resolvePathIdentity(b, { zone: 'target', expectedKind: 'directory' });
    assert.notEqual(left.identity, right.identity);
  });
});

test('PP-01: Windows spelling canonicalization is deterministic on every CI host', () => {
  assert.equal(normaliseIdentityPath('F:\\CLU\\CLU\\', 'win32'), 'f:/clu/clu');
  assert.equal(normaliseIdentityPath('f:/clu/./CLU', 'win32'), 'f:/clu/clu');
  assert.equal(normaliseIdentityPath('F:/CLU/src/../CLU', 'win32'), 'f:/clu/clu');
});

test('PP-01: invalid, missing, relative-without-base, and wrong-kind roots fail closed', () => {
  withFixture((root) => {
    const file = join(root, 'file.txt');
    writeFileSync(file, 'x', 'utf8');
    assert.equal(codeOf(() => resolvePathIdentity('', { zone: 'target' })), 'PATH_EMPTY');
    assert.equal(
      codeOf(() => resolvePathIdentity('relative', { zone: 'target' })),
      'RELATIVE_BASE_REQUIRED',
    );
    assert.equal(
      codeOf(() => resolvePathIdentity(join(root, 'missing'), { zone: 'target' })),
      'PATH_NOT_FOUND',
    );
    assert.equal(
      codeOf(() => resolvePathIdentity(file, { zone: 'target', expectedKind: 'directory' })),
      'PATH_KIND_INVALID',
    );
  });
});

test('PP-01: equal and nested operating zones are refused symmetrically', () => {
  withFixture((root) => {
    const targetRoot = join(root, 'target');
    const nestedWorkspace = join(targetRoot, 'workspace');
    const separateShadow = join(root, 'shadow');
    mkdirSync(nestedWorkspace, { recursive: true });
    mkdirSync(separateShadow, { recursive: true });

    const target = resolvePathIdentity(targetRoot, { zone: 'target', expectedKind: 'directory' });
    const workspace = resolvePathIdentity(nestedWorkspace, {
      zone: 'workspace',
      expectedKind: 'directory',
    });
    const shadow = resolvePathIdentity(separateShadow, {
      zone: 'shadow',
      expectedKind: 'directory',
    });

    assert.equal(codeOf(() => assertPathZonesDisjoint([target, workspace, shadow])), 'ZONE_OVERLAP');
    assert.equal(codeOf(() => assertPathZonesDisjoint([workspace, target])), 'ZONE_OVERLAP');
    assert.doesNotThrow(() => assertPathZonesDisjoint([target, shadow]));
  });
});
