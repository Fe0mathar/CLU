import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertBenchmarkRunSubject,
  prepareBenchmarkRunSubject,
  recordBenchmarkRun,
  type PerformedRun,
} from '../src/control/benchmarkRun.js';
import type { Runtime } from '../src/control/runtime.js';

import {
  assertExactRunInputs,
  captureExactRunInputs,
  isExactRunInputPath,
  materializeExactRunInputs,
} from '../src/control/exactRunInputs.js';

test('exact inputs include root executable inputs and additional files outside recognition roots', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clue-exact-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'workspace'));
  writeFileSync(join(root, 'src', 'engine.ts'), 'export const engine = 1;');
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'scripts', 'probe.js'), 'process.exitCode = 0;');
  const pinned = captureExactRunInputs(root);
  assert.deepEqual(pinned.files.map((file) => file.path), ['package-lock.json', 'scripts/probe.js', 'src/engine.ts']);

  writeFileSync(join(root, 'workspace', 'receipt.json'), '{}');
  assert.doesNotThrow(() => assertExactRunInputs(root, pinned, 'Project'));
  assert.equal(isExactRunInputPath('workspace/receipt.json'), false);
  writeFileSync(join(root, 'scripts', 'extra.js'), 'process.exitCode = 1;');
  assert.throws(() => assertExactRunInputs(root, pinned, 'Project'), /inputs changed/);
});

test('a candidate lease copies exactly the pinned bytes and refuses a stale pin', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'clue-exact-copy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'target');
  const shadow = join(base, 'shadow');
  const rejected = join(base, 'rejected');
  for (const path of [root, shadow, rejected]) mkdirSync(path);
  writeFileSync(join(root, 'benchmark.md'), 'first benchmark');
  const pin = captureExactRunInputs(root);
  materializeExactRunInputs(root, shadow, pin);
  assert.equal(readFileSync(join(shadow, 'benchmark.md'), 'utf8'), 'first benchmark');
  assert.equal(captureExactRunInputs(shadow).id, pin.id);

  writeFileSync(join(root, 'benchmark.md'), 'different benchmark');
  assert.throws(() => materializeExactRunInputs(root, rejected, pin), /inputs changed/);
  assert.equal(existsSync(join(rejected, 'benchmark.md')), false);
});

test('an input directory link is refused instead of silently excluded from exact evidence', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'clue-exact-link-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'target');
  mkdirSync(root);
  const outside = join(base, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => captureExactRunInputs(root), /linked.*symlink/);
});

test('recording checks the measured benchmark subject rather than a later snapshot', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'clue-benchmark-subject-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'target');
  const workspace = join(base, 'workspace');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(root, 'src', 'engine.ts'), 'export const engine = 1;');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  const contract = { path: join(root, 'benchmark.md'), registered: true };
  writeFileSync(contract.path, 'exact benchmark bytes');
  const lock = join(root, 'package-lock.json');
  writeFileSync(lock, '{}');
  const runtime = {
    repoRoot: root, workspaceRoot: workspace, projectProfile: null, projectBinding: null,
    requireMission() {}, currentMissionId: () => 'MISSION-000001',
    log: { append: (event: unknown) => event },
    artifacts: { putJson: (value: unknown) => value },
    projections: { sync() {} },
    config: { project: { id: 'fixture', root, source_roots: ['src'], exclude: [], inputs: { benchmark: 'benchmark.md' } } },
  } as unknown as Runtime;
  const subject = prepareBenchmarkRunSubject(runtime, contract);
  const outcome = {
    ok: true,
    contract: { path: contract.path, sha256: subject.contract_sha256 },
    result: { unifiedScore: null, measures: [], incomplete: [], protective: [], environment: {} },
    timing: { started_at: '2026-08-15T00:00:00Z', finished_at: '2026-08-15T00:00:01Z', wall_ms: 1 },
    budget: { exhausted: false },
  } as unknown as PerformedRun['outcome'];
  const performed = { subject, outcome, contract, log_head_before: null };

  assert.equal(assertBenchmarkRunSubject(runtime, performed).snapshot_id, subject.snapshot_id);
  const diagnostic = { ...contract, registered: false };
  const receipt = recordBenchmarkRun(runtime, {
    ...performed, contract: diagnostic, subject: prepareBenchmarkRunSubject(runtime, diagnostic),
  });
  assert.equal((receipt.event.payload as { proof_eligible: boolean }).proof_eligible, false);
  writeFileSync(lock, '{"changed":true}');
  assert.throws(() => assertBenchmarkRunSubject(runtime, performed), /Benchmark subject inputs changed/);
  writeFileSync(lock, '{}');
  writeFileSync(join(root, 'src', 'engine.ts'), 'export const engine = 2;');
  assert.throws(() => assertBenchmarkRunSubject(runtime, performed), /recognition snapshot changed/);
});
