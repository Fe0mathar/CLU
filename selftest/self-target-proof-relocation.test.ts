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
import { executeMatchedProofControl, executeProofPlan } from '../src/experiment/proof/executionCoordinator.js';
import { captureExactRunInputs } from '../src/control/exactRunInputs.js';
import { captureBaseline } from '../src/proof/baselineRegistry.js';
import { freezeProofContract, type ProofContract } from '../src/proof/proofContract.js';
import { decide, decideWithMatchedControl } from '../src/proof/verdict.js';
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

function writeSelfTargetStick(root: string, version = '0.1.0', extraBody: readonly string[] = []): string {
  const body = [
    "const candidate = String(context.repoRoot).replace(/\\\\/g,'/').includes('/proof-');",
    'const cost = candidate ? 80 : 100;',
    ...extraBody,
    `return { benchmarkVersion:'${version}', unifiedScore:null,`,
    " measures:[{id:'SIG-COST',name:'cost',scenario:'S1',native_unit:'ms',aggregation:'median',value:cost,samples:[cost],warmup_samples:[]},",
    "           {id:'SIG-GUARD',name:'guard',scenario:'S1',native_unit:'count',aggregation:'exact',value:1,samples:[1],warmup_samples:[]}],",
    " protective:[], environment:context.environment, incomplete:[] };",
  ].join('\n');
  const text = [
    'benchmark_id = clu-master',
    `benchmark_version = ${version}`,
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

test('a candidate cannot replace an offline suite test in the version 0.2.0 benchmark', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clue-proof-offline-suite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stick = writeSelfTargetStick(root, '0.2.0');
  const exec = async (): Promise<never> => assert.fail('the refusal must happen before any candidate workload');
  const opening = await runMasterBenchmark({
    repoRoot: root, projectRoot: root, workspaceRoot: root, contractPath: stick, execImpl: exec,
  });
  assert.ok(opening.ok, opening.ok ? '' : opening.reason);
  const baseline = captureBaseline({
    outcome: opening,
    snapshot_id: SNAPSHOT,
    mission_version: 'MISSION-SELF-000001',
    run_artifact: {
      hash: '8'.repeat(64), bytes: 1, media_type: 'application/json; charset=utf-8',
      label: 'opening.json', created_at: opening.timing.finished_at,
    },
  });
  const frozen = freezeProofContract({
    contract: contract(), policy: POLICY, capabilities: ['benchmark:clu-master'],
  });
  assert.ok(!('refusals' in frozen));
  const testPath = 'selftest/recognizer-identity.test.ts';
  const result = await executeProofPlan({
    frozen, baseline, patch: [{ op: 'delete', path: testPath }],
    projectRoot: root, pinnedInputs: captureExactRunInputs(root),
    shadow: { root: join(root, 'shadow'), persistent: true, install_command: 'npm ci', install_on_lockfile_change: true },
    scripts: { typecheck: 'npm run typecheck', build: 'npm run build' },
    benchmarkContractPath: stick, repoRoot: root, execImpl: exec,
  });
  assert.deepEqual(result, {
    ok: false, stage: 'patch', reason: `a proof candidate cannot modify the benchmark instrument: ${testPath}`,
  });
});

test('version 0.2.0 proof refusals retain the recognition command timings', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clue-proof-recognition-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'target');
  writeFile(join(project, 'src', 'value.ts'), 'export const value = 100;\n');
  const stick = writeSelfTargetStick(project, '0.2.0', [
    "await context.exec([...context.cliArgv, 'recognize', '--full', '--navigator']);",
    "await context.exec([...context.cliArgv, 'recognize', '--navigator']);",
  ]);
  const exec = async (argv: readonly string[]) => ({ code: 0,
    stdout: argv.includes('--full') ? 'INFO  elapsed                          31 ms\r\n' : '',
    stderr: '', wallMs: 58.125, timedOut: false });
  const opening = await runMasterBenchmark({
    repoRoot: root, projectRoot: project, workspaceRoot: root, contractPath: stick, execImpl: exec,
  });
  assert.ok(opening.ok, opening.ok ? '' : opening.reason);
  const baseline = captureBaseline({
    outcome: opening, snapshot_id: SNAPSHOT, mission_version: 'MISSION-SELF-000001',
    run_artifact: { hash: '8'.repeat(64), bytes: 1, media_type: 'application/json; charset=utf-8',
      label: 'opening.json', created_at: opening.timing.finished_at },
  });
  const frozen = freezeProofContract({ contract: contract(), policy: POLICY, capabilities: ['benchmark:clu-master'] });
  assert.ok(!('refusals' in frozen));
  const deps = {
    frozen, baseline, projectRoot: project, pinnedInputs: captureExactRunInputs(project),
    shadow: { root: join(root, 'shadow'), persistent: false, install_command: null, install_on_lockfile_change: true },
    scripts: { typecheck: 'node typecheck.js', build: 'node build.js' },
    benchmarkContractPath: stick, repoRoot: root, execImpl: exec,
  };
  const prefix = 'BENCHMARK_TIMING ';
  const checkRefusal = (result: Awaited<ReturnType<typeof executeProofPlan>>, role: 'control' | 'candidate') => {
    assert.ok(!result.ok && result.stage === 'instrument');
    assert.match(result.reason, /13 required signals/);
    const timings = result.evidence?.filter((line) => line.startsWith(prefix)).map((line) => {
      const { startedAt, finishedAt, ...timing } = JSON.parse(line.slice(prefix.length));
      assert.ok(Date.parse(startedAt) <= Date.parse(finishedAt));
      return timing;
    });
    assert.deepEqual(timings, [
      { role, command: 'cold-recognize', sample: 1, wallMs: 58.125, internalElapsedMs: 31, code: 0, timedOut: false },
      { role, command: 'incremental-recognize', sample: 1, wallMs: 58.125, internalElapsedMs: null, code: 0, timedOut: false },
    ]);
  };
  checkRefusal(await executeMatchedProofControl(deps), 'control');
  checkRefusal(await executeProofPlan({
    ...deps, patch: [{ op: 'write', path: 'src/value.ts', content: 'export const value = 80;\n' }],
  }), 'candidate');
});

test('a matched proof control measures the pinned unchanged tree in a fresh separate lease', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clue-proof-matched-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'target');
  const stick = writeSelfTargetStick(project);
  writeFile(join(project, 'src', 'value.ts'), 'export const value = 100;\n');
  const exec = async () => ({ code: 0, stdout: '', stderr: '', wallMs: 1, timedOut: false });
  const opening = await runMasterBenchmark({
    repoRoot: root, projectRoot: project, workspaceRoot: root, contractPath: stick, execImpl: exec,
  });
  assert.ok(opening.ok, opening.ok ? '' : opening.reason);
  const baseline = captureBaseline({
    outcome: opening,
    snapshot_id: SNAPSHOT,
    mission_version: 'MISSION-SELF-000001',
    run_artifact: {
      hash: '8'.repeat(64), bytes: 1, media_type: 'application/json; charset=utf-8',
      label: 'opening.json', created_at: opening.timing.finished_at,
    },
  });
  const frozen = freezeProofContract({ contract: contract(), policy: POLICY, capabilities: ['benchmark:clu-master'] });
  assert.ok(!('refusals' in frozen));
  const pinnedInputs = captureExactRunInputs(project);
  const deps = {
    frozen, baseline, projectRoot: project, pinnedInputs,
    shadow: { root: join(root, 'shadow'), persistent: true, install_command: null, install_on_lockfile_change: true },
    scripts: { typecheck: 'node typecheck.js', build: 'node build.js' },
    benchmarkContractPath: stick, repoRoot: root, execImpl: exec,
  };
  const first = await executeMatchedProofControl(deps);
  assert.ok(first.ok, first.ok ? '' : first.reason);
  assert.deepEqual(first.candidate_inputs, pinnedInputs);
  assert.deepEqual(first.change_set, []);
  assert.match(first.shadow_dir, /proof-control-/u);
  writeFile(join(first.shadow_dir, 'dist', 'unrecorded.js'), 'throw new Error("old control state")');
  const second = await executeMatchedProofControl(deps);
  assert.ok(second.ok, second.ok ? '' : second.reason);
  assert.deepEqual(second.candidate_inputs, pinnedInputs);
  assert.equal(existsSync(join(second.shadow_dir, 'dist', 'unrecorded.js')), false);
  const noOp = await executeProofPlan({ ...deps, patch: [] });
  assert.ok(!noOp.ok && noOp.stage === 'patch');

  const observations = (cost: number, guard = 1) => baseline.measures.map((measure) => {
    const value = measure.id === 'SIG-COST' ? cost : guard;
    return { ...measure, value, samples: [value] };
  });
  const verdictInput = {
    contract: frozen.contract,
    contract_hash: frozen.contract_hash,
    baseline,
    candidate: { ...baseline, snapshot_id: hashText('changed candidate'), measures: observations(80) },
  };
  assert.equal(decideWithMatchedControl(verdictInput, null).disposition, 'ACCEPT');
  assert.equal(decideWithMatchedControl(verdictInput, { ...baseline, measures: observations(90) }).disposition, 'ACCEPT');
  for (const control of [
    { ...baseline, measures: observations(81) },
    { ...baseline, measures: observations(90, 2) },
    { ...baseline, run_wall_ms: Number.POSITIVE_INFINITY },
  ]) {
    const verdict = decideWithMatchedControl(verdictInput, control);
    assert.equal(verdict.disposition, 'INVALID');
    assert.equal(verdict.improvement, false);
    assert.match(verdict.reasons.join(' '), /matched shadow control comparison/u);
    assert.equal(verdict.identity.baseline_snapshot, baseline.snapshot_id);
  }
});

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

    const changedProfile = stringifyYaml({ ...parseYaml(profile), name: 'CLU-E candidate fixture' });
    const authorityPatch = await executeProofPlan({
      frozen,
      baseline,
      patch: [{ op: 'write', path: 'targets/clu/profile.yaml', content: changedProfile }],
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
    assert.ok(!authorityPatch.ok, 'a change to relocation authority must be refused');
    assert.equal(authorityPatch.stage, 'shadow', authorityPatch.reason);
    assert.match(authorityPatch.reason, /cannot modify relocation authority/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    rmSync(shadowRoot, { recursive: true, force: true, maxRetries: 3 });
    rmSync(openingWorkspace, { recursive: true, force: true, maxRetries: 3 });
  }
});
