import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { canonicalHarnessBody } from '../src/benchmark/harnessBlock.js';
import type { ProofContract } from '../src/proof/proofContract.js';
import { hashText, type Sha256 } from '../src/shared/ids.js';

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeStick(directory: string): string {
  const body = [
    "const c=Number((await context.exec([...context.nodeArgv,'-p','require(\"fs\").readFileSync(\"src/cost.txt\",\"utf8\")'])).stdout.trim());",
    "const g=Number((await context.exec([...context.nodeArgv,'-p','require(\"fs\").readFileSync(\"src/guard.txt\",\"utf8\")'])).stdout.trim());",
    "return { benchmarkVersion:'0.1.0', unifiedScore:null,",
    "  measures:[{id:'SIG-COST',name:'cost',scenario:'S1',native_unit:'ms',aggregation:'median',value:c,samples:[c],warmup_samples:[]},",
    "            {id:'SIG-GUARD',name:'guard',scenario:'S1',native_unit:'count',aggregation:'exact',value:g,samples:[g],warmup_samples:[]}],",
    '  protective:[], environment:context.environment, incomplete:[] };',
  ].join('\n');
  const text = [
    'benchmark_id = fixture-stick',
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
  const path = join(directory, 'stick.md');
  writeFileSync(path, text, 'utf8');
  return path;
}

export function writeCliFixture(
  root = join(mkdtempSync(join(tmpdir(), 'proof-cli-e2e-')), 'engine'),
  options = { pushBackups: true },
): string {
  mkdirSync(root);
  writeFileSync(join(root, 'CLUE.md'), '# Constitution\n', 'utf8');
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}', 'utf8');

  const target = join(root, 'target');
  mkdirSync(join(target, 'src'), { recursive: true });
  mkdirSync(join(target, 'benchmark'), { recursive: true });
  writeFileSync(join(target, 'src', 'hello.ts'), 'export const hello = 1;\n', 'utf8');
  writeFileSync(join(target, 'src', 'cost.txt'), '100', 'utf8');
  writeFileSync(join(target, 'src', 'guard.txt'), '497', 'utf8');
  writeFileSync(join(target, 'target description.md'), '# Target\n', 'utf8');
  writeFileSync(join(target, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["src"]}', 'utf8');
  writeFileSync(
    join(target, 'typecheck.js'),
    'if(require("fs").existsSync("src/broken.marker")){console.error("broken marker");process.exit(1)}',
    'utf8',
  );
  writeFileSync(join(target, 'build.js'), 'process.exit(0)', 'utf8');
  writeFileSync(join(target, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8');
  writeStick(join(target, 'benchmark'));

  mkdirSync(join(root, 'config', 'policies'), { recursive: true });
  writeFileSync(join(root, 'config', 'policies', 'patching.yaml'), 'mode: NOTIFY\n', 'utf8');
  const config = {
    version: 2,
    project: {
      id: 'fixture',
      root: target,
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
      inputs: { description: 'target description.md', benchmark: 'benchmark/stick.md' },
    },
    workspace: { root: join(dirname(root), 'workspace') },
    shadow: {
      root: join(dirname(root), 'shadow'),
      clone_mode: 'local',
      persistent: true,
      install_on_lockfile_change: true,
      install_command: 'node build.js',
    },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md'] },
    runtime: { package_manager: 'npm', scripts: { typecheck: 'node typecheck.js', build: 'node build.js' } },
    browser: {
      executable: join(root, 'chrome.exe'),
      remote_debugging_port: 9222,
      profile_dir: join(root, 'browser-profile'),
      allowed_origins: ['http://localhost:*'],
      require_webgpu: true,
    },
    powershell: { executable: 'pwsh.exe', autonomous_profile: 'restricted' },
    analysis: {
      max_context_tokens: 120000,
      reserve_output_tokens: 20000,
      dynamic_edge_confidence_threshold: 0.75,
      monodependency_percentile: 0.35,
    },
    proof: {
      require_frozen_contract: true,
      inconclusive_counts_as_improvement: false,
      require_baseline: true,
      require_guardrails: true,
    },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: {
      mode: 'NOTIFY',
      policy_file: 'config/policies/patching.yaml',
      landing_branch_prefix: 'clue/accepted/',
      merge_strategy: 'fast_forward_only',
      post_land_verify: ['typecheck'],
      auto_revert_on_post_land_failure: true,
    },
    notifications: { status_document: true, windows_toast: false, webhook_url_env: null },
    gateway: {
      enabled: false,
      provider: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_mode: 'batch',
      batch_poll_interval_seconds: 300,
      prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] },
      budget_policy_file: 'config/policies/budget.yaml',
      routing_file: 'config/policies/routing.yaml',
    },
    backup: {
      remote: 'origin',
      push_on_verdict: options.pushBackups,
      push_on_landing: options.pushBackups,
      max_remote_staleness_hours: 24,
    },
    security: { canonical_source_writes: 'denied', real_settlement: 'denied', redact_environment: true },
    logging: { level: 'info' },
  };
  mkdirSync(join(root, 'config', 'measurements'), { recursive: true });
  writeFileSync(join(root, 'config', 'clue.config.yaml'), stringifyYaml(config), 'utf8');
  writeFileSync(
    join(root, 'config', 'measurements', 'catalogue.yaml'),
    readFileSync(join(process.cwd(), 'config', 'measurements', 'catalogue.yaml'), 'utf8'),
    'utf8',
  );
  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(dirname(root), 'workspace', directory), { recursive: true });
  }
  return root;
}

export function proofContract(snapshot: Sha256, cycleId: string, mission: string): ProofContract {
  return {
    contract_version: 1,
    mission_version: mission,
    cycle_id: cycleId,
    snapshot_id: snapshot,
    hypothesis: {
      id: 'HYP-CLI-000001',
      causal_claim: 'Replacing the fixture cost value reduces the measured cost without reducing the guard.',
      target_units: ['src/cost.txt'],
    },
    great_book: {
      scope_id: 'src/cost.txt',
      contributions: [
        { measurement_id: 'MD04', source_measure_id: 'SIG-COST', confidence: 1, coverage: 1 },
      ],
    },
    baseline_state: `snapshot ${snapshot.slice(0, 12)}, fixture-stick@0.1.0 recorded run`,
    candidate_state: 'same snapshot with src/cost.txt replaced by the patch manifest',
    representative_inputs: ['fixture target at the cycle-locked snapshot'],
    target_measurements: [{ id: 'SIG-COST', native_unit: 'ms', direction: 'lower_is_better' }],
    regression_measurements: [{ id: 'SIG-GUARD', native_unit: 'count', direction: 'higher_is_better', aggregation: 'exact' }],
    mandatory_gates: [{ kind: 'must_not_decrease', measure_id: 'SIG-GUARD' }],
    execution: { warmup_runs: 0, repetitions: 1, max_duration_seconds: 120, statistic: 'median' },
    invalid_run_rules: ['a failed static preparation voids the run'],
    confounder_rules: [],
    required_instruments: ['benchmark:fixture-stick'],
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
