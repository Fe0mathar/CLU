import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readBenchmarkContract, readExecutionPolicy } from '../src/benchmark/harnessBlock.js';
import { loadProofContract, loadProofPatchManifest } from '../src/cli/commands/proofCommands.js';
import { freezeProofContract } from '../src/proof/proofContract.js';

const templates = 'templates/p2-closure';
const benchmarkPath = 'targets/clu/benchmark/master-benchmark.md';

test('P2 proof contract template freezes against the stock benchmark capabilities and policy', () => {
  const benchmark = readFileSync(benchmarkPath, 'utf8');
  const identity = readBenchmarkContract(benchmark);
  const policy = readExecutionPolicy(benchmark);
  if ('error' in identity) assert.fail(identity.error);
  if ('error' in policy) assert.fail(policy.error);
  const contract = freezeProofContract({
    contract: loadProofContract(join(templates, 'proof-contract.template.json')),
    policy: {
      require_frozen_contract: true,
      inconclusive_counts_as_improvement: false,
      require_baseline: true,
      require_guardrails: true,
    },
    capabilities: [
      `benchmark:${identity.identity.benchmark_id}`,
      ...identity.blocks.flatMap((block) => [
        `runner:${block.runner_adapter}`,
        `harness:${block.id}`,
      ]),
    ],
  });
  if ('refusals' in contract) assert.fail(contract.refusals.join('\n'));
  const input = contract.contract;
  assert.equal(input.contract_version, 1);
  assert.deepEqual(input.execution, {
    warmup_runs: policy.default_warmup_runs,
    repetitions: policy.default_repetitions,
    max_duration_seconds: policy.maximum_total_runtime_seconds,
    statistic: 'median',
  });

  const lines = benchmark.split(/\r?\n/u);
  for (const measure of [...input.target_measurements, ...input.regression_measurements]) {
    const row = lines.find((line) => line.startsWith(`| \`${measure.id}\` |`));
    assert.ok(row, `expected registered signal ${measure.id}`);
    const fields = row.split('|').map((field) => field.trim());
    assert.equal(measure.native_unit, fields[4]);
    assert.equal(measure.aggregation ?? input.execution.statistic, fields[5]?.split(' ')[0]);
  }
});

test('P2 candidate patch template expands the full replacement file with the CLI loader', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'clue-p2-proof-template-'));
  try {
    const patch = join(scratch, 'candidate-patch.json');
    const content = '// Candidate fixture.\n';
    copyFileSync(join(templates, 'candidate-patch.template.json'), patch);
    writeFileSync(join(scratch, 'recognizer.candidate.ts'), content, 'utf8');
    const expected = 'src/analysis/source/recognizer.ts';
    assert.ok(existsSync(expected));
    assert.deepEqual(loadProofPatchManifest(patch), [{ op: 'write', path: expected, content }]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
