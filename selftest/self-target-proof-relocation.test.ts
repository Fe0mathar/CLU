/**
 * P2 final vertical-slice protection: CLU-E may prove a change against itself without
 * letting the benchmark's child `clue` commands contend for the canonical writer lock.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { canonicalHarnessBody } from '../src/benchmark/harnessBlock.js';
import { runMasterBenchmark } from '../src/benchmark/benchmarkRunner.js';
import { executeProofPlan } from '../src/experiment/proof/executionCoordinator.js';
import { captureExactRunInputs } from '../src/control/exactRunInputs.js';
import { captureBaseline } from '../src/proof/baselineRegistry.js';
import { freezeProofContract, type ProofContract } from '../src/proof/proofContract.js';
import { decide } from '../src/proof/verdict.js';
import { nativeProofSkipReason } from './proof-isolation-fixture.js';
import { hashText, type Sha256 } from '../src/shared/ids.js';

const SNAPSHOT = '7'.repeat(64) as Sha256;
const POLICY = {
  require_frozen_contract: true as const,
  inconclusive_counts_as_improvement: false as const,
  require_baseline: true,
  require_guardrails: true,
};

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writeSelfTargetStick(root: string): string {
  const body = [
    "const candidate = String(context.repoRoot).replace(/\\\\/g,'/').includes('/proof-');",
    'const cost = candidate ? 80 : 100;',
    "return { benchmarkVersion:'0.1.0', unifiedScore:null,",
    " measures:[{id:'SIG-COST',name:'cost',scenario:'S1',native_unit:'ms',aggregation:'median',value:cost,samples:[cost],warmup_samples:[]},",
    "           {id:'SIG-GUARD',name:'guard',scenario:'S1',native_unit:'count',aggregation:'exact',value:1,samples:[1],warmup_samples:[]}],",
    " protective:[], environment:context.environment, incomplete:[] };",
  ].join('\n');
  const text = [
    'benchmark_id = clu-master',
    'benchmark_version = 0.1.0',
    'runner_adapter = cli-node',
    'default_warmup_runs = 0',
    'default_repetitions = 1',
    '',
    '[harness.HRN-001]',
    'runner_adapter = cli-node',
    'scenario_ids = S1',
    'language = javascript',
    `integrity = ${hashText(canonicalHarnessBody(body))}`,
    '--- begin harness ---',
    body,
    '--- end harness ---',
    '',
  ].join('\n');
  const path = join(root, 'targets', 'clu', 'benchmark', 'master-benchmark.md');
  writeFile(path, text);
  return path;
}

function contract(): ProofContract {
  return {
    contract_version: 1,
    mission_version: 'MISSION-SELF-000001',
    cycle_id: 'CYCLE-000001',
    snapshot_id: SNAPSHOT,
    hypothesis: {
      id: 'HYP-SELF-000001',
      causal_claim: 'The candidate lowers the measured cost without reducing the guard.',
      target_units: ['src/value.ts'],
    },
    baseline_state: 'canonical CLU-E self-target under the frozen stick',
    candidate_state: 'same snapshot plus one typed candidate write',
    representative_inputs: ['self-target relocation fixture'],
    target_measurements: [{ id: 'SIG-COST', native_unit: 'ms', direction: 'lower_is_better' }],
    regression_measurements: [{ id: 'SIG-GUARD', native_unit: 'count', direction: 'higher_is_better', aggregation: 'exact' }],
    mandatory_gates: [{ kind: 'must_not_decrease', measure_id: 'SIG-GUARD' }],
    execution: { warmup_runs: 0, repetitions: 1, max_duration_seconds: 120, statistic: 'median' },
    invalid_run_rules: ['a failed instrument or static gate voids the run'],
    confounder_rules: [],
    required_instruments: ['benchmark:clu-master'],
    thresholds: {
      success: { measure_id: 'SIG-COST', kind: 'improve_pct_at_least', pct: 10 },
      non_inferiority: null,
      rejection: { measure_id: 'SIG-COST', kind: 'worsen_pct_at_least', pct: 5 },
    },
    environment_fingerprint: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    rollback_conditions: ['the guard decreases after landing'],
  };
}

test('P2-CLOSURE-02: self-target proof uses relocated shadow CLI/config/workspace and leaves canonical bytes untouched', { skip: nativeProofSkipReason() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-self-proof-'));
  const shadowRoot = mkdtempSync(join(tmpdir(), 'clue-self-proof-shadow-'));
  const openingWorkspace = mkdtempSync(join(tmpdir(), 'clue-self-proof-workspace-'));
  try {
    writeFile(join(root, 'package.json'), '{"name":"clue-self-fixture","private":true}\n');
    writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFile(join(root, 'src', 'value.ts'), 'export const value = 100;\n');
    writeFile(join(root, 'typecheck.js'), 'process.exit(0);\n');
    writeFile(
      join(root, 'build.js'),
      [
        "const fs=require('fs');",
        "fs.mkdirSync('dist/src/cli',{recursive:true});",
        "fs.writeFileSync('dist/src/cli/index.js','process.exit(0);\\n');",
      ].join(''),
    );
    const stick = writeSelfTargetStick(root);

    const config = stringifyYaml({
      version: 2,
      project: { active_target: 'clu' },
      workspace: { root: join(root, 'canonical-workspace') },
      shadow: {
        root: shadowRoot,
        clone_mode: 'local',
        persistent: true,
        install_on_lockfile_change: true,
        install_command: 'node build.js',
      },
    });
    const profile = stringifyYaml({
      id: 'clu',
      name: 'CLU-E fixture',
      root,
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules', 'dist'],
      remote: null,
      credential_env: null,
      inputs: {
        description: null,
        benchmark: 'targets/clu/benchmark/master-benchmark.md',
      },
    });
    writeFile(join(root, 'config', 'clue.config.yaml'), config);
    writeFile(join(root, 'targets', 'clu', 'profile.yaml'), profile);

    const opening = await runMasterBenchmark({
      repoRoot: root,
      projectRoot: root,
      workspaceRoot: openingWorkspace,
      contractPath: stick,
      environment: { node_version: process.version, platform: process.platform, arch: process.arch },
    });
    assert.ok(opening.ok, opening.ok ? '' : opening.reason);
    if (!opening.ok) return;
    const baseline = captureBaseline({
      outcome: opening,
      snapshot_id: SNAPSHOT,
      mission_version: 'MISSION-SELF-000001',
      run_artifact: {
        hash: '8'.repeat(64),
        bytes: 1,
        media_type: 'application/json; charset=utf-8',
        label: 'opening.json',
        created_at: opening.timing.finished_at,
      },
    });
    const frozen = freezeProofContract({
      contract: contract(),
      policy: POLICY,
      capabilities: ['benchmark:clu-master'],
    });
    assert.ok(!('refusals' in frozen));
    if ('refusals' in frozen) return;

    const pinnedInputs = captureExactRunInputs(root);
    const result = await executeProofPlan({
      frozen,
      baseline,
      patch: [{ op: 'write', path: 'src/value.ts', content: 'export const value = 80;\n' }],
      projectRoot: root,
      pinnedInputs,
      shadow: {
        root: shadowRoot,
        persistent: true,
        install_command: 'node build.js',
        install_on_lockfile_change: true,
      },
      scripts: { typecheck: 'node typecheck.js', build: 'node build.js' },
      benchmarkContractPath: stick,
      repoRoot: root,
    });
    assert.ok(result.ok, result.ok ? '' : [`${result.stage}: ${result.reason}`, ...result.evidence ?? []].join('\n'));
    if (!result.ok) return;
    assert.equal(result.instrumentation.length, 2);
    assert.equal(result.candidate_snapshot_id, result.candidate_inputs.id);
    assert.ok(result.executable_inputs.engine_dist_id);
    assert.equal(result.executable_inputs.engine_dist_id, result.executable_inputs.target_dist_id);
    assert.notEqual(captureExactRunInputs(result.shadow_dir).id, result.candidate_snapshot_id);
    for (const change of result.instrumentation) {
      assert.equal(result.candidate_inputs.files.find((entry) => entry.path === change.path)?.hash, change.before_sha256);
    }
    assert.deepEqual(result.instrumentation.map((item) => item.path).sort(), [
      'config/clue.config.yaml',
      'targets/clu/profile.yaml',
    ]);
    assert.equal(readFileSync(join(root, 'config', 'clue.config.yaml'), 'utf8'), config);
    assert.equal(readFileSync(join(root, 'targets', 'clu', 'profile.yaml'), 'utf8'), profile);
    assert.equal(readFileSync(join(root, 'src', 'value.ts'), 'utf8'), 'export const value = 100;\n');

    const relocatedConfig = parseYaml(
      readFileSync(join(result.shadow_dir, 'config', 'clue.config.yaml'), 'utf8'),
    ) as { workspace: { root: string }; shadow: { root: string } };
    const relocatedProfile = parseYaml(
      readFileSync(join(result.shadow_dir, 'targets', 'clu', 'profile.yaml'), 'utf8'),
    ) as { root: string };
    assert.equal(relocatedProfile.root.replace(/\\/g, '/'), result.shadow_dir.replace(/\\/g, '/'));
    assert.notEqual(relocatedConfig.workspace.root, join(root, 'canonical-workspace'));
    assert.ok(relative(result.shadow_dir, relocatedConfig.workspace.root).startsWith('..'));

    const candidate = captureBaseline({
      outcome: result.outcome,
      snapshot_id: result.candidate_snapshot_id,
      mission_version: 'MISSION-SELF-000001',
      run_artifact: {
        hash: '9'.repeat(64),
        bytes: 1,
        media_type: 'application/json; charset=utf-8',
        label: 'candidate.json',
        created_at: result.outcome.timing.finished_at,
      },
    });
    const verdict = decide({
      contract: frozen.contract,
      contract_hash: frozen.contract_hash,
      baseline,
      candidate,
      anomalies: result.anomalies,
    });
    assert.equal(verdict.disposition, 'ACCEPT');
    assert.equal(verdict.improvement, true);

    // An exact persistent rerun may reuse dependencies, but it must not reuse any source
    // mutation left by the previous instrument/toolchain execution. Rehydrate from the
    // canonical tree, then reapply the exact candidate patch.
    writeFile(join(result.shadow_dir, 'src', 'unrecorded-contamination.ts'), 'export const leak = true;\n');
    writeFileSync(join(result.shadow_dir, 'src', 'value.ts'), 'export const value = -999;\n', 'utf8');
    const rerun = await executeProofPlan({
      frozen,
      baseline,
      patch: [{ op: 'write', path: 'src/value.ts', content: 'export const value = 80;\n' }],
      projectRoot: root,
      pinnedInputs,
      shadow: {
        root: shadowRoot,
        persistent: true,
        install_command: 'node build.js',
        install_on_lockfile_change: true,
      },
      scripts: { typecheck: 'node typecheck.js', build: 'node build.js' },
      benchmarkContractPath: stick,
      repoRoot: root,
    });
    assert.ok(rerun.ok, rerun.ok ? '' : [`${rerun.stage}: ${rerun.reason}`, ...rerun.evidence ?? []].join('\n'));
    if (rerun.ok) {
      assert.equal(rerun.shadow_dir, result.shadow_dir);
      assert.equal(
        readFileSync(join(rerun.shadow_dir, 'src', 'value.ts'), 'utf8'),
        'export const value = 80;\n',
      );
      assert.equal(
        existsSync(join(rerun.shadow_dir, 'src', 'unrecorded-contamination.ts')),
        false,
      );
    }

    const authorityPatch = await executeProofPlan({
      frozen,
      baseline,
      patch: [{ op: 'write', path: 'targets/clu/profile.yaml', content: profile }],
      projectRoot: root,
      pinnedInputs,
      shadow: {
        root: shadowRoot,
        persistent: true,
        install_command: null,
        install_on_lockfile_change: true,
      },
      scripts: { typecheck: 'node typecheck.js', build: 'node build.js' },
      benchmarkContractPath: stick,
      repoRoot: root,
    });
    assert.ok(!authorityPatch.ok && authorityPatch.stage === 'shadow');
    if (!authorityPatch.ok) assert.match(authorityPatch.reason, /cannot modify relocation authority/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    rmSync(shadowRoot, { recursive: true, force: true, maxRetries: 3 });
    rmSync(openingWorkspace, { recursive: true, force: true, maxRetries: 3 });
  }
});
