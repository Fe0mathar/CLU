/**
 * DEV-P0-10 — a read-only attach creates nothing, and a malformed protected-policy entry blocks.
 *
 * Two guarantees the runtime owes: attaching read-only must not create directories (it observes, it
 * does not perturb the workspace), and a defective protected-surface rule must mark the whole policy
 * malformed — which stops a patch-capable startup — rather than silently vanishing and leaving the
 * surface it named unguarded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as toYaml } from 'yaml';

import { ArtifactStore } from '../src/memory/artifactStore.js';
import { ProjectionStore } from '../src/memory/db.js';
import { AuditLog } from '../src/control/audit.js';
import { SecretRegistry } from '../src/control/policy.js';
import { readProtectedPolicy } from '../src/control/runtime.js';
import { type ClueConfig } from '../src/shared/schemas.js';

test('DEV-P0-10: a read-only artifact store and audit log create no directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-ro-'));
  try {
    const blobs = join(root, 'blobs');
    const logs = join(root, 'logs');
    mkdirSync(join(root, 'db'), { recursive: true });
    const projections = new ProjectionStore(join(root, 'db', 'clue.db'), { projectors: {} });

    // Read-only construction creates nothing.
    new ArtifactStore(blobs, { readOnly: true });
    new AuditLog(logs, projections, new SecretRegistry(), { readOnly: true });
    assert.equal(existsSync(blobs), false, 'read-only artifact store created no blobs/temp directory');
    assert.equal(existsSync(logs), false, 'read-only audit log created no logs directory');

    // A writable store DOES create its working directories — proving the flag is what gates it.
    new ArtifactStore(blobs);
    new AuditLog(logs, projections, new SecretRegistry());
    assert.ok(existsSync(blobs) && readdirSync(blobs).length > 0, 'writable artifact store created its temp dir');
    assert.equal(existsSync(logs), true, 'writable audit log created its logs dir');

    projections.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-10: a malformed protected-policy entry marks the policy malformed instead of vanishing', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-pp-'));
  try {
    const rel = 'config/policies/patching.yaml';
    mkdirSync(join(root, 'config', 'policies'), { recursive: true });
    const config = { patching: { policy_file: rel } } as unknown as ClueConfig;
    const writePolicy = (surfaces: unknown): void => writeFileSync(join(root, rel), toYaml({ protected_surfaces: surfaces }), 'utf8');

    // A well-formed rule is accepted.
    writePolicy([{ id: 'r1', reason: 'core', match: { path_globs: ['src/**'] } }]);
    const good = readProtectedPolicy(root, config);
    assert.equal(good.malformed, false);
    assert.equal(good.rules.length, 1);

    // A malformed entry alongside a good one must block the WHOLE policy, not silently drop the bad one.
    writePolicy([{ id: 'r1', match: { path_globs: ['src/**'] } }, { id: 'broken-no-match' }]);
    const mixed = readProtectedPolicy(root, config);
    assert.equal(mixed.malformed, true, 'a malformed entry marks the policy malformed');
    assert.deepEqual(mixed.rules, [], 'no rules leak from a malformed policy');

    // A rule that matches nothing is itself a defect (it would protect nothing).
    writePolicy([{ id: 'empty', match: {} }]);
    assert.equal(readProtectedPolicy(root, config).malformed, true, 'a match-nothing rule is malformed');

    // A non-object entry is a defect too.
    writePolicy(['not-an-object']);
    assert.equal(readProtectedPolicy(root, config).malformed, true, 'a non-object entry is malformed');

    // A file_contains-only rule is a legitimate matcher whose enforcement is deferred to the
    // snapshot-time pass (it needs the file's text). It is well-formed here and contributes no startup
    // rule — it must NOT be rejected as match-nothing, or a valid policy would refuse startup.
    writePolicy([{ id: 'vendored', reason: 'third-party', match: { file_contains: ['@ts-nocheck'] } }]);
    const deferred = readProtectedPolicy(root, config);
    assert.equal(deferred.malformed, false, 'a file_contains-only rule is well-formed');
    assert.deepEqual(deferred.rules, [], 'a file_contains-only rule contributes no startup rule');

    // Alongside an identifier/glob rule, the policy stays well-formed and the enforceable rule remains.
    writePolicy([
      { id: 'g', match: { path_globs: ['src/**'] } },
      { id: 'vendored', match: { file_contains: ['@ts-nocheck'] } },
    ]);
    const combined = readProtectedPolicy(root, config);
    assert.equal(combined.malformed, false);
    assert.equal(combined.rules.length, 1, 'only the identifier/glob rule is enforced at startup');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});