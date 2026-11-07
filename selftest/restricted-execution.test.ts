import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRestrictedExecution } from '../src/benchmark/restrictedExecution.js';
import { performBenchmarkRun } from '../src/control/benchmarkRun.js';
import type { ClueConfig } from '../src/shared/schemas.js';

test('production benchmark refuses an unregistered harness before preparing runtime', async () => {
  const result = await performBenchmarkRun({
    repoRoot: 'unused',
    config: {} as ClueConfig,
    contract: { registered: false, path: 'unused' },
  });
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) throw new Error('Expected refusal');
  assert.equal(result.outcome.stage, 'subject');
  assert.match(result.outcome.reason, /registered Master Benchmark/u);
  assert.equal(result.subject, null);
});

test('production command broker rejects overlapping roots and never falls back when Linux isolation fails', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-restricted-execution-'));
  const projectRoot = join(root, 'project');
  const workspaceRoot = join(root, 'workspace');
  const nested = join(projectRoot, 'nested');
  const frozenFile = join(projectRoot, 'frozen.txt');
  const writtenFile = join(workspaceRoot, 'ran.txt');
  try {
    mkdirSync(nested, { recursive: true });
    mkdirSync(workspaceRoot);
    writeFileSync(frozenFile, 'frozen');
    const scope = { repoRoot: projectRoot, projectRoot, workspaceRoot, mode: 'baseline' } as const;
    assert.throws(() => createRestrictedExecution({ ...scope, workspaceRoot: nested }), /must be disjoint/u);
    const broker = createRestrictedExecution(scope);
    try {
      await assert.rejects(broker.exec(['sh', '-c', 'exit 0']), /accepts only Node/u);
      try {
        const result = await broker.exec(['node', '-e', [
          'const fs = require("node:fs");',
          'fs.writeFileSync(process.argv[1], "ran");',
          'try { fs.writeFileSync(process.argv[2], "tampered"); process.exitCode = 3; } catch {}',
        ].join(' '), writtenFile, frozenFile], { timeoutSeconds: 5 });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(readFileSync(writtenFile, 'utf8'), 'ran');
      } catch (error) {
        assert.match(String(error), /Linux proof isolation refused execution: bwrap:/u);
        assert.equal(existsSync(writtenFile), false);
      }
      assert.equal(readFileSync(frozenFile, 'utf8'), 'frozen');
    } finally {
      broker.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
