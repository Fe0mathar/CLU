/**
 * Proof pipeline acceptance (DEV-P2-11, Stage H; Execution Model §10–§15).
 *
 * The pins, in the order the pipeline runs:
 *
 * **The freeze is the single gate.** §10's field list parses strictly; the hash is
 * canonical (a genuine key reorder cannot move it — and the suite knows the difference
 * between a reorder and a replacer-array mutilation); policy and capability refusals
 * all arrive at once, each by name; a tampered contract is caught with both hashes
 * cited, and a non-sha256 claim refuses instead of crashing — hashes arrive from disk
 * untyped.
 *
 * **§11 is reuse-or-rerun, nothing between.** The package is a recorded run rebound;
 * presence is the noise gate (a needed measure in `incomplete[]` refuses quoting the
 * harness's own reason); stale, incompatible, and never-collected each refuse ending in
 * the only §11 remedy, and every failing condition reports together.
 *
 * **The verdict is arithmetic, and the literal is law.** ACCEPT only through
 * superiority with every gate held; REJECT for a valid run showing a bad candidate
 * (gate or threshold); REVISE quotes `inconclusive_counts_as_improvement: false` and
 * carries the deltas as §12.4's evidence; INVALID always means the question was not
 * answerable; DEFER is never emitted by this layer.
 *
 * **The coordinator collects; it never decides.** On a real fixture tree with a real
 * stick: shadow lease, typed patch with its change-set record, static preparation with
 * failure evidence, the same stick over the candidate — and the canonical tree
 * provably untouched throughout.
 *
 * **The arm records the whole causal chain.** Off SCREENED, against the cycle's own
 * locked stick: the no-baseline refusal names the existing operator act; a recorded run
 * binds the snapshot it measured; the accepting arc leaves
 * `contract_frozen → baseline_bound → verdict_recorded` on the log with readable
 * artifacts; a static-failing candidate leaves `execution_refused` with its evidence;
 * and the cycle stands at SCREENED after all of it, because candidates are a loop, not
 * a stage.
 */

import { test } from 'node:test';
import { nativeProofSkipReason } from './proof-isolation-fixture.js';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import { canonicalHarnessBody } from '../src/benchmark/harnessBlock.js';
import { DEFAULT_EXECUTION_POLICY, makeExec, runMasterBenchmark, type ExecFn, type RunOutcome } from '../src/benchmark/benchmarkRunner.js';
import { hashText, type Sha256 } from '../src/shared/ids.js';
import {
  PROOF_EVENT_TYPES,
  freezeProofContract,
  proofContractHash,
  verifyFrozenContract,
  type ProofContract,
} from '../src/proof/proofContract.js';
import {
  assessBaselineValidity,
  baselineDigest,
  captureBaseline,
  measuresNeededBy,
  type BaselinePackage,
} from '../src/proof/baselineRegistry.js';
import { decide } from '../src/proof/verdict.js';
import { executeProofPlan } from '../src/experiment/proof/executionCoordinator.js';
import { captureExactRunInputs } from '../src/control/exactRunInputs.js';
import { withRuntime, withRuntimeAsync, type Runtime } from '../src/control/runtime.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { prepareBenchmarkRunSubject, recordBenchmarkRun } from '../src/control/benchmarkRun.js';
import { readGreatBookEntries, readGreatBookFacts } from '../src/greatBook/greatBookProjection.js';
import type { CycleInputLock, CycleRecord } from '../src/shared/schemas.js';

const POLICY = {
  require_frozen_contract: true,
  inconclusive_counts_as_improvement: false,
  require_baseline: true,
  require_guardrails: true,
} as const;

const FINGERPRINT = { node_version: 'v22.11.0', platform: 'linux', arch: 'x64' } as const;
const SNAP = 'b'.repeat(64) as Sha256;

/* ------------------------------------------------------------------------- */
/* Builders                                                                   */
/* ------------------------------------------------------------------------- */

function contractBody(over: Partial<ProofContract> = {}): ProofContract {
  return {
    contract_version: 1,
    mission_version: 'M1',
    cycle_id: 'CYCLE-000002',
    snapshot_id: SNAP,
    hypothesis: {
      id: 'HYP-000001',
      causal_claim: 'Memoization cuts incremental recognition wall time.',
      target_units: ['x#y'],
    },
    baseline_state: `snapshot ${SNAP.slice(0, 12)}, clu-master@0.1.0 recorded run`,
    candidate_state: 'same snapshot plus the smallest patch',
    representative_inputs: ['the tree at the locked snapshot'],
    target_measurements: [{ id: 'SIG-006', native_unit: 'ms', direction: 'lower_is_better' }],
    regression_measurements: [
      { id: 'SIG-012', native_unit: 'count', direction: 'higher_is_better', aggregation: 'exact' },
      { id: 'SIG-003', native_unit: 'count', direction: 'higher_is_better', aggregation: 'exact' },
    ],
    mandatory_gates: [
      { kind: 'must_not_decrease', measure_id: 'SIG-012' },
      { kind: 'must_not_regress_pct', measure_id: 'SIG-003', pct: 0.5 },
    ],
    execution: { warmup_runs: 1, repetitions: 3, max_duration_seconds: 1800, statistic: 'median' },
    invalid_run_rules: ['a red suite voids the run'],
    confounder_rules: [],
    required_instruments: ['benchmark:clu-master'],
    thresholds: {
      success: { measure_id: 'SIG-006', kind: 'improve_pct_at_least', pct: 10 },
      non_inferiority: { measure_id: 'SIG-006', kind: 'not_worse_pct', pct: 2 },
      rejection: { measure_id: 'SIG-006', kind: 'worsen_pct_at_least', pct: 5 },
    },
    environment_fingerprint: { ...FINGERPRINT },
    rollback_conditions: ['gate failure post-land'],
    ...over,
  } as ProofContract;
}

/** Zero-spread stub over the shipped contract: every timing signal lands. */
function zeroSpreadStub(): ExecFn {
  return async (argv) => {
    const command = argv.join(' ');
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', wallMs: 100, timedOut: false });
    if (command.includes('resultHash')) return ok(`${'f'.repeat(64)}\n`);
    if (command.includes('recognize')) {
      return ok(
        `  OK   units${' '.repeat(30)}6294\n  OK   edges${' '.repeat(30)}30687\n  WARN  unresolved${' '.repeat(25)}473 x\n`,
      );
    }
    if (command.includes('metrics')) return ok(`  OK   values stored${' '.repeat(21)}42917\n`);
    if (command.includes('status diff')) return ok('PARITY-OK\n');
    if (command.includes('selftest')) return ok('# pass 497\n# fail 0\n# skipped 5\n');
    return ok('  OK   x  y\n');
  };
}

async function shippedBaseline(): Promise<{
  readonly baseline: BaselinePackage;
  readonly outcome: Extract<RunOutcome, { ok: true }>;
}> {
  const outcome = await runMasterBenchmark({
    repoRoot: '/r',
    projectRoot: '/p',
    workspaceRoot: '/w',
    contractPath: 'targets/clu/benchmark/master-benchmark.md',
    execImpl: zeroSpreadStub(),
    environment: { ...FINGERPRINT },
  });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
  const baseline = captureBaseline({
    outcome,
    snapshot_id: SNAP,
    mission_version: 'M1',
    run_artifact: {
      hash: 'c'.repeat(64),
      bytes: 1,
      media_type: 'application/json; charset=utf-8',
      label: 'run.json',
      created_at: outcome.timing.finished_at,
    },
  });
  return { baseline, outcome };
}

function candidateFrom(baseline: BaselinePackage, mutate: (values: Map<string, number>) => void): BaselinePackage {
  const copy = JSON.parse(JSON.stringify(baseline)) as BaselinePackage;
  (copy as { snapshot_id: string }).snapshot_id = 'e'.repeat(64);
  const values = new Map(copy.measures.map((measure) => [measure.id, measure.value]));
  mutate(values);
  (copy as { measures: unknown }).measures = copy.measures.map((measure) => ({
    ...measure,
    value: values.get(measure.id) ?? measure.value,
    samples: measure.samples.map(() => values.get(measure.id) ?? measure.value),
  }));
  return copy;
}

/* ========================================================================= */
/* §10 — the freeze                                                           */
/* ========================================================================= */

test('proof §10: a full contract freezes; the hash is canonical under genuine reorder', () => {
  const body = contractBody();
  const frozen = freezeProofContract({ contract: body, policy: POLICY, capabilities: ['benchmark:clu-master'] });
  assert.ok(!('refusals' in frozen), 'refusals' in frozen ? frozen.refusals.join('; ') : '');
  if ('refusals' in frozen) return;
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(body).reverse()) reversed[key] = (body as Record<string, unknown>)[key];
  assert.equal(proofContractHash(reversed as ProofContract), frozen.contract_hash);
});

test('proof §10/§15.2: tamper caught with both hashes; a non-sha256 claim refuses, never crashes', () => {
  const frozen = freezeProofContract({ contract: contractBody(), policy: POLICY, capabilities: ['benchmark:clu-master'] });
  assert.ok(!('refusals' in frozen));
  if ('refusals' in frozen) return;
  assert.deepEqual(verifyFrozenContract(frozen.contract, frozen.contract_hash), { ok: true });
  const moved = verifyFrozenContract({ ...frozen.contract, candidate_state: 'edited after the fact' }, frozen.contract_hash);
  assert.equal(moved.ok, false);
  if (!moved.ok) {
    assert.ok(moved.reason.includes(frozen.contract_hash.slice(0, 12)));
    assert.match(moved.reason, /only cite the exact contract that predates it/);
  }
  const bogus = verifyFrozenContract(frozen.contract, undefined as unknown as Sha256);
  assert.equal(bogus.ok, false);
  if (!bogus.ok) assert.match(bogus.reason, /citing no real freeze cites nothing/);
});

test('proof §10: every freeze refusal by name, all at once', () => {
  const expectRefusal = (contract: unknown, capabilities: readonly string[], pattern: RegExp) => {
    const result = freezeProofContract({ contract, policy: POLICY, capabilities });
    assert.ok('refusals' in result, `expected refusal matching ${pattern}`);
    if (!('refusals' in result)) return;
    assert.match(result.refusals.join('; '), pattern);
  };
  expectRefusal({ ...contractBody(), extra_field: true }, ['benchmark:clu-master'], /[Uu]nrecognized/);
  expectRefusal({ ...contractBody(), mandatory_gates: [] }, ['benchmark:clu-master'], /protects nothing proves nothing/);
  expectRefusal(contractBody(), ['typecheck'], /no authority before capability validation/);
  const missingTwo = freezeProofContract({ contract: contractBody(), policy: POLICY, capabilities: [] });
  assert.ok('refusals' in missingTwo && missingTwo.refusals.length === 1, 'one instrument, one refusal');
  expectRefusal(
    { ...contractBody(), thresholds: { ...contractBody().thresholds, success: { measure_id: 'SIG-999', kind: 'improve_pct_at_least', pct: 10 } } },
    ['benchmark:clu-master'],
    /declared target measurements/,
  );
  expectRefusal(
    { ...contractBody(), mandatory_gates: [{ kind: 'must_not_decrease', measure_id: 'SIG-777' }] },
    ['benchmark:clu-master'],
    /declared target or regression/,
  );
  expectRefusal({ ...contractBody(), baseline_state: 'ok' }, ['benchmark:clu-master'], /not narrative/);
  expectRefusal(
    { ...contractBody(), regression_measurements: contractBody().target_measurements },
    ['benchmark:clu-master'],
    /measurement SIG-006 is declared more than once/,
  );
  expectRefusal(
    { ...contractBody(), thresholds: { ...contractBody().thresholds, non_inferiority: {
      measure_id: 'undeclared', kind: 'not_worse_pct', pct: 2,
    } } },
    ['benchmark:clu-master'],
    /non-inferiority must use not_worse_pct on a declared/,
  );
});

/* ========================================================================= */
/* §11 — the baseline                                                         */
/* ========================================================================= */

test('proof §11: a recorded run rebinds as the package; variance carried; digest deterministic', async () => {
  const { baseline } = await shippedBaseline();
  assert.equal(baseline.benchmark.benchmark_id, 'clu-master');
  assert.ok(baseline.measures.length >= 12);
  const sig1 = baseline.measures.find((measure) => measure.id === 'SIG-001');
  assert.ok(sig1 !== undefined && sig1.samples.length === 3 && sig1.spread_pct === 0);
  assert.equal(baselineDigest(baseline), baselineDigest(JSON.parse(JSON.stringify(baseline)) as BaselinePackage));
});

test('proof §11: reuse-or-rerun — valid reuse surfaces needed/variance/digest; every mismatch refuses by name', async () => {
  const { baseline } = await shippedBaseline();
  const frozen = freezeProofContract({ contract: contractBody(), policy: POLICY, capabilities: ['benchmark:clu-master'] });
  assert.ok(!('refusals' in frozen));
  if ('refusals' in frozen) return;
  const contract = frozen.contract;

  assert.deepEqual(measuresNeededBy(contract), ['SIG-003', 'SIG-006', 'SIG-012']);
  const valid = assessBaselineValidity(contract, baseline);
  assert.ok(valid.valid);
  if (!valid.valid) return;
  assert.deepEqual(valid.needed, ['SIG-003', 'SIG-006', 'SIG-012']);
  assert.match(valid.digest, /^[0-9a-f]{64}$/);

  const cases: readonly { readonly contract: ProofContract; readonly baseline: BaselinePackage; readonly pattern: RegExp }[] = [
    { contract: { ...contract, snapshot_id: 'd'.repeat(64) as Sha256 }, baseline, pattern: /stale.*narrative cannot repair/ },
    { contract: { ...contract, mission_version: 'M2' }, baseline, pattern: /captured under mission/ },
    {
      contract: { ...contract, environment_fingerprint: { ...FINGERPRINT, node_version: 'v20.0.0' } },
      baseline,
      pattern: /fingerprint differs/,
    },
    {
      contract: {
        ...contract,
        regression_measurements: [...contract.regression_measurements, { id: 'SIG-999', native_unit: 'x', direction: 'higher_is_better' }],
      },
      baseline,
      pattern: /SIG-999 was never collected/,
    },
    {
      contract,
      baseline: {
        ...baseline,
        measures: baseline.measures.filter((measure) => measure.id !== 'SIG-006'),
        incomplete: [...baseline.incomplete, { id: 'SIG-006', reason: 'spread 19.3% exceeds 15%' }],
      },
      pattern: /noisy or invalid at capture: SIG-006.*19\.3%/,
    },
  ];
  for (const { contract: c, baseline: b, pattern } of cases) {
    const verdict = assessBaselineValidity(c, b);
    assert.ok(!verdict.valid, `expected refusal matching ${pattern}`);
    if (verdict.valid) continue;
    assert.match(verdict.reasons.join('; '), pattern);
  }
  const multi = assessBaselineValidity({ ...contract, snapshot_id: 'd'.repeat(64) as Sha256, mission_version: 'M2' }, baseline);
  assert.ok(!multi.valid && multi.reasons.length === 2, 'all failing conditions report together');
});

/* ========================================================================= */
/* §14 — the deterministic verdict                                            */
/* ========================================================================= */

test('proof §14: the disposition table, and the literal enforced', async () => {
  const { baseline } = await shippedBaseline();
  const frozen = freezeProofContract({ contract: contractBody(), policy: POLICY, capabilities: ['benchmark:clu-master'] });
  assert.ok(!('refusals' in frozen));
  if ('refusals' in frozen) return;
  const base6 = baseline.measures.find((measure) => measure.id === 'SIG-006')?.value as number;
  const run = (candidate: BaselinePackage, anomalies?: readonly string[]) =>
    decide({
      contract: frozen.contract,
      contract_hash: frozen.contract_hash,
      baseline,
      candidate,
      ...(anomalies === undefined ? {} : { anomalies }),
    });

  const accept = run(candidateFrom(baseline, (values) => values.set('SIG-006', base6 * 0.85)));
  assert.equal(accept.disposition, 'ACCEPT');
  assert.equal(accept.improvement, true);
  assert.ok((accept.deltas.find((delta) => delta.measure_id === 'SIG-006')?.delta_pct ?? 0) > 14.9, 'improvement-positive');

  const gateFail = run(candidateFrom(baseline, (values) => values.set('SIG-012', 496)));
  assert.equal(gateFail.disposition, 'REJECT');
  assert.match(gateFail.reasons[0] ?? '', /must_not_decrease/);

  const thresholdFail = run(candidateFrom(baseline, (values) => values.set('SIG-006', base6 * 1.08)));
  assert.equal(thresholdFail.disposition, 'REJECT');
  assert.match(thresholdFail.reasons[0] ?? '', /rejection threshold met/);

  const revise = run(candidateFrom(baseline, (values) => values.set('SIG-006', base6 * 1.03)));
  assert.equal(revise.disposition, 'REVISE');
  assert.equal(revise.improvement, false);
  assert.match(revise.reasons[0] ?? '', /never an improvement/);
  assert.match(revise.reasons[0] ?? '', /inconclusive_counts_as_improvement: false/);

  const nonInferior = run(candidateFrom(baseline, (values) => values.set('SIG-006', base6 * 0.99)));
  assert.equal(nonInferior.disposition, 'REVISE');
  assert.match(nonInferior.reasons[0] ?? '', /non-inferiority held.*not an acceptance/);

  for (const verdict of [accept, gateFail, thresholdFail, revise, nonInferior]) {
    assert.notEqual(verdict.disposition, 'DEFER', 'the deterministic layer never defers');
  }
});

test('proof §14: INVALID always means the question was not answerable', async () => {
  const { baseline } = await shippedBaseline();
  const frozen = freezeProofContract({ contract: contractBody(), policy: POLICY, capabilities: ['benchmark:clu-master'] });
  assert.ok(!('refusals' in frozen));
  if ('refusals' in frozen) return;
  const clean = candidateFrom(baseline, () => {});

  const moved = decide({
    contract: { ...frozen.contract, candidate_state: 'edited' },
    contract_hash: frozen.contract_hash,
    baseline,
    candidate: clean,
  });
  assert.equal(moved.disposition, 'INVALID');
  assert.match(moved.reasons[0] ?? '', /no longer matches its freeze/);

  const otherStick = candidateFrom(baseline, () => {});
  (otherStick as { benchmark: BaselinePackage['benchmark'] }).benchmark = {
    ...otherStick.benchmark,
    contract_sha256: 'a'.repeat(64) as Sha256,
  };
  const stick = decide({ contract: frozen.contract, contract_hash: frozen.contract_hash, baseline, candidate: otherStick });
  assert.equal(stick.disposition, 'INVALID');
  assert.match(stick.reasons[0] ?? '', /different sticks/);

  const anomaly = decide({
    contract: frozen.contract,
    contract_hash: frozen.contract_hash,
    baseline,
    candidate: clean,
    anomalies: ['shadow install failed once'],
  });
  assert.equal(anomaly.disposition, 'INVALID');
  assert.match(anomaly.reasons[0] ?? '', /instrument anomaly/);

  const incomplete = candidateFrom(baseline, () => {});
  (incomplete as { measures: unknown }).measures = incomplete.measures.filter((measure) => measure.id !== 'SIG-006');
  (incomplete as { incomplete: unknown }).incomplete = [...incomplete.incomplete, { id: 'SIG-006', reason: 'spread 22% exceeds 15%' }];
  const noisy = decide({ contract: frozen.contract, contract_hash: frozen.contract_hash, baseline, candidate: incomplete });
  assert.equal(noisy.disposition, 'INVALID');
  assert.match(noisy.reasons[0] ?? '', /SIG-006 landed incomplete.*22%/);

  assert.deepEqual(Object.keys(moved.identity).sort(), [
    'baseline_digest',
    'baseline_snapshot',
    'candidate_digest',
    'candidate_snapshot',
    'contract_hash',
  ]);
});

/* ========================================================================= */
/* §12–§13 — the coordinator, on a real fixture tree                          */
/* ========================================================================= */

function writeStick(dir: string): string {
  const body = [
    "const c=Number((await context.exec([...context.nodeArgv,'-p','require(\"fs\").readFileSync(\"src/cost.txt\",\"utf8\")'])).stdout.trim());",
    "const g=Number((await context.exec([...context.nodeArgv,'-p','require(\"fs\").readFileSync(\"src/guard.txt\",\"utf8\")'])).stdout.trim());",
    "return { benchmarkVersion:'0.1.0', unifiedScore:null,",
    "  measures:[{id:'SIG-COST',name:'cost',scenario:'S1',native_unit:'ms',aggregation:'median',value:c,samples:[c],warmup_samples:[]},",
    "            {id:'SIG-GUARD',name:'guard',scenario:'S1',native_unit:'count',aggregation:'exact',value:g,samples:[g],warmup_samples:[]}],",
    "  protective:[], environment:context.environment, incomplete:[] };",
  ].join('\n');
  const stick = [
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
  const path = join(dir, 'stick.md');
  writeFileSync(path, stick);
  return path;
}

function fixtureContract(snapshot: Sha256, cycleId: string, mission: string): ProofContract {
  return contractBody({
    mission_version: mission,
    cycle_id: cycleId,
    snapshot_id: snapshot,
    baseline_state: `snapshot ${snapshot.slice(0, 12)}, fixture-stick@0.1.0 recorded run`,
    target_measurements: [{ id: 'SIG-COST', native_unit: 'ms', direction: 'lower_is_better' }],
    regression_measurements: [{ id: 'SIG-GUARD', native_unit: 'count', direction: 'higher_is_better', aggregation: 'exact' }],
    execution: { warmup_runs: 0, repetitions: 1, max_duration_seconds: 120, statistic: 'median' },
    great_book: {
      scope_id: 'src/cost.txt',
      contributions: [
        { measurement_id: 'MD04', source_measure_id: 'SIG-COST', confidence: 1, coverage: 1 },
      ],
    },
    mandatory_gates: [{ kind: 'must_not_decrease', measure_id: 'SIG-GUARD' }],
    required_instruments: ['stick'],
    thresholds: {
      success: { measure_id: 'SIG-COST', kind: 'improve_pct_at_least', pct: 10 },
      non_inferiority: null,
      rejection: { measure_id: 'SIG-COST', kind: 'worsen_pct_at_least', pct: 5 },
    },
    environment_fingerprint: { node_version: process.version, platform: process.platform, arch: process.arch },
  });
}

test('proof §12–§13: the coordinator collects on a real tree and never decides', { skip: nativeProofSkipReason() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-coord-'));
  try {
    const project = join(root, 'target');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(root, 'ws'));
    writeFileSync(join(project, 'src', 'cost.txt'), '100');
    writeFileSync(join(project, 'src', 'guard.txt'), '497');
    writeFileSync(join(project, 'tscheck.js'), 'if(require("fs").existsSync("src/broken.marker")){console.error("broken marker");process.exit(1)}');
    writeFileSync(join(project, 'build.js'), 'process.exit(0)');
    writeFileSync(join(project, 'package-lock.json'), '{"lock":1}');
    const stickPath = writeStick(root);

    const base = await runMasterBenchmark({
      repoRoot: process.cwd(),
      projectRoot: project,
      workspaceRoot: join(root, 'ws'),
      contractPath: stickPath,
      environment: { node_version: process.version, platform: process.platform, arch: process.arch },
    });
    assert.ok(base.ok, base.ok ? '' : base.reason);
    const baseline = captureBaseline({
      outcome: base,
      snapshot_id: SNAP,
      mission_version: 'M1',
      run_artifact: { hash: 'c'.repeat(64), bytes: 1, media_type: 'application/json; charset=utf-8', label: 'x', created_at: base.timing.finished_at },
    });
    const frozen = freezeProofContract({
      contract: fixtureContract(SNAP, 'CYCLE-000009', 'M1'),
      policy: POLICY,
      capabilities: ['stick'],
    });
    assert.ok(!('refusals' in frozen));
    if ('refusals' in frozen) return;

    const pinnedInputs = captureExactRunInputs(project);
    const deps = (patch: Parameters<typeof executeProofPlan>[0]['patch']) => ({
      frozen,
      baseline,
      patch,
      projectRoot: project,
      pinnedInputs,
      shadow: { root: join(root, 'shadow'), persistent: true, install_command: 'node build.js', install_on_lockfile_change: true },
      scripts: { typecheck: 'node tscheck.js', build: 'node build.js' },
      benchmarkContractPath: stickPath,
      repoRoot: process.cwd(),
    });

    const run = await executeProofPlan(deps([{ op: 'write', path: 'src/cost.txt', content: '80' }]));
    assert.ok(run.ok, run.ok ? '' : `${run.stage}: ${run.reason}`);
    if (!run.ok) return;
    assert.equal(run.installed, true);
    assert.deepEqual(run.static_preparation.map((entry) => entry.script), ['typecheck', 'build']);
    assert.equal(run.change_set.length, 1);
    assert.match(run.candidate_snapshot_basis, /verified measured candidate input manifest/);
    assert.equal(run.candidate_snapshot_id, run.candidate_inputs.id);
    assert.equal(run.candidate_snapshot_id, captureExactRunInputs(run.shadow_dir).id);
    assert.notEqual(run.candidate_snapshot_id, pinnedInputs.id);

    const candidate = captureBaseline({
      outcome: run.outcome,
      snapshot_id: run.candidate_snapshot_id,
      mission_version: 'M1',
      run_artifact: { hash: 'd'.repeat(64), bytes: 1, media_type: 'application/json; charset=utf-8', label: 'x', created_at: run.outcome.timing.finished_at },
    });
    const verdict = decide({ contract: frozen.contract, contract_hash: frozen.contract_hash, baseline, candidate, anomalies: run.anomalies });
    assert.equal(verdict.disposition, 'ACCEPT');

    const reuse = await executeProofPlan(deps([{ op: 'write', path: 'src/cost.txt', content: '80' }]));
    assert.ok(reuse.ok && reuse.installed === false, 'persistent lease reused, install skipped');
    assert.equal(readFileSync(join(project, 'src', 'cost.txt'), 'utf8'), '100', 'the canonical tree is untouched');

    const exec = makeExec({ cwd: run.shadow_dir, policy: DEFAULT_EXECUTION_POLICY }).exec;
    const executableDrift = await executeProofPlan({
      ...deps([{ op: 'write', path: 'src/cost.txt', content: '80' }]),
      execImpl: async (argv, options) => {
        const result = await exec(argv, options);
        if (argv.some((argument) => argument.includes('src/cost.txt'))) {
          mkdirSync(join(run.shadow_dir, 'dist'), { recursive: true });
          writeFileSync(join(run.shadow_dir, 'dist', 'unrecorded.js'), 'process.exit(0)');
        }
        return result;
      },
    });
    assert.ok(!executableDrift.ok && executableDrift.stage === 'instrument' &&
      /executable inputs changed/.test(executableDrift.reason));

    const traversal = await executeProofPlan(deps([{ op: 'write', path: '../escape.txt', content: 'x' }]));
    assert.ok(!traversal.ok && traversal.stage === 'patch');

    const unchanged = await executeProofPlan(deps([{ op: 'write', path: 'src/cost.txt', content: '100' }]));
    assert.ok(!unchanged.ok && unchanged.stage === 'patch');
    if (!unchanged.ok) assert.match(unchanged.reason, /did not change the pinned project inputs/u);

    // A lexically in-tree path whose existing component is a symlink/junction must not
    // become an unbounded filesystem write authority.
    const outside = join(root, 'outside');
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(project, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
      const linkedEscape = await executeProofPlan(
        deps([{ op: 'write', path: 'linked-outside/escaped.txt', content: 'x' }]),
      );
      assert.ok(!linkedEscape.ok && linkedEscape.stage === 'shadow');
      if (!linkedEscape.ok) assert.match(linkedEscape.reason, /symlink|junction/);
      assert.equal(existsSync(join(outside, 'escaped.txt')), false);
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // A locked-down Windows host may deny link creation.
    } finally {
      rmSync(join(project, 'linked-outside'), { recursive: true, force: true });
    }

    const blockedPatchPaths = ['node_modules/poison.js', 'src/cost.txt:stream', 'src/CON.txt'];
    for (const path of blockedPatchPaths) {
      const blocked = await executeProofPlan(deps([{ op: 'write', path, content: 'x' }]));
      assert.ok(!blocked.ok && blocked.stage === 'patch', path);
    }

    writeFileSync(join(project, 'src', 'cost.txt'), '101');
    const drifted = await executeProofPlan(deps([{ op: 'write', path: 'src/cost.txt', content: '80' }]));
    assert.ok(!drifted.ok && drifted.stage === 'shadow' && /inputs changed/.test(drifted.reason));
    writeFileSync(join(project, 'src', 'cost.txt'), '100');

    writeFileSync(join(project, 'build.js'), 'require("fs").writeFileSync("src/ambient.txt", "ambient");');
    const buildDeps = deps([{ op: 'write', path: 'src/cost.txt', content: '80' }]);
    const mutatingBuild = await executeProofPlan({
      ...buildDeps,
      pinnedInputs: captureExactRunInputs(project),
      shadow: { ...buildDeps.shadow, install_command: null },
    });
    assert.ok(!mutatingBuild.ok && mutatingBuild.stage === 'static' && /inputs changed/.test(mutatingBuild.reason));
    writeFileSync(join(project, 'build.js'), 'process.exit(0)');

    const broken = await executeProofPlan(deps([{ op: 'write', path: 'src/broken.marker', content: '' }]));
    assert.ok(!broken.ok && broken.stage === 'static' && /broken marker/.test((broken.evidence ?? [])[0] ?? ''));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* ========================================================================= */
/* The CANDIDATES arm — the durable chain                                     */
/* ========================================================================= */

function writeArmFixture(withBenchmark: boolean): string {
  const root = join(mkdtempSync(join(tmpdir(), 'proof-arm-')), 'engine');
  mkdirSync(root);
  writeFileSync(join(root, 'CLUE.md'), '# C\n');
  writeFileSync(join(root, 'package.json'), '{"name":"a","private":true}');
  mkdirSync(join(root, 'murugan', 'src'), { recursive: true });
  writeFileSync(join(root, 'murugan', 'src', 'hello.ts'), 'export function hello(n: string): string {\n  return n;\n}\n');
  writeFileSync(join(root, 'murugan', 'src', 'cost.txt'), '100');
  writeFileSync(join(root, 'murugan', 'src', 'guard.txt'), '497');
  writeFileSync(join(root, 'murugan', 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["src"]}');
  writeFileSync(join(root, 'murugan', 'target description.md'), '# i\n');
  writeFileSync(join(root, 'murugan', 'tscheck.js'), 'if(require("fs").existsSync("src/broken.marker")){console.error("broken marker");process.exit(1)}');
  writeFileSync(join(root, 'murugan', 'buildok.js'), 'process.exit(0)');
  writeFileSync(join(root, 'murugan', 'package-lock.json'), '{"l":1}');
  if (withBenchmark) {
    mkdirSync(join(root, 'murugan', 'benchmark'), { recursive: true });
    const stickPath = writeStick(join(root, 'murugan', 'benchmark'));
    assert.ok(stickPath.endsWith('stick.md'));
  }
  mkdirSync(join(root, 'config', 'policies'), { recursive: true });
  writeFileSync(join(root, 'config', 'policies', 'patching.yaml'), 'mode: NOTIFY\n');
  const config = {
    version: 2,
    project: {
      id: 'murugan',
      root: join(root, 'murugan'),
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
      inputs: { description: 'target description.md', benchmark: withBenchmark ? 'benchmark/stick.md' : null },
    },
    workspace: { root: join(dirname(root), 'workspace') },
    shadow: { root: join(dirname(root), 'shadow'), clone_mode: 'local', persistent: true, install_on_lockfile_change: true, install_command: 'node buildok.js' },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md'] },
    runtime: { package_manager: 'npm', scripts: { typecheck: 'node tscheck.js', build: 'node buildok.js' } },
    browser: { executable: join(root, 'c.exe'), remote_debugging_port: 9222, profile_dir: join(root, 'cp'), allowed_origins: ['http://localhost:*'], require_webgpu: true },
    powershell: { executable: 'pwsh.exe', autonomous_profile: 'restricted' },
    analysis: { max_context_tokens: 120000, reserve_output_tokens: 20000, dynamic_edge_confidence_threshold: 0.75, monodependency_percentile: 0.35 },
    proof: { require_frozen_contract: true, inconclusive_counts_as_improvement: false, require_baseline: true, require_guardrails: true },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: { mode: 'NOTIFY', policy_file: 'config/policies/patching.yaml', landing_branch_prefix: 'clue/accepted/', merge_strategy: 'fast_forward_only', post_land_verify: ['typecheck'], auto_revert_on_post_land_failure: true },
    notifications: { status_document: true, windows_toast: false, webhook_url_env: null },
    gateway: { enabled: false, provider: 'openai', api_key_env: 'K', default_mode: 'batch', batch_poll_interval_seconds: 300, prompt_cache: { enabled: true, stable_prefix_sections: ['x'] }, budget_policy_file: 'config/policies/budget.yaml', routing_file: 'config/policies/routing.yaml' },
    backup: { remote: 'origin', push_on_verdict: true, push_on_landing: true, max_remote_staleness_hours: 24 },
    security: { canonical_source_writes: 'denied', real_settlement: 'denied', redact_environment: true },
    logging: { level: 'info' },
  };
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'clue.config.yaml'), stringifyYaml(config));
  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(dirname(root), 'workspace', directory), { recursive: true });
  }
  return root;
}

test('proof arm: checks the pinned absolute benchmark outside the project before execution', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clue-proof-benchmark-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const projectRoot = join(root, 'project');
  const benchmarkPath = join(root, 'master-benchmark.md');
  mkdirSync(projectRoot);
  writeFileSync(benchmarkPath, 'changed benchmark');
  const now = '2026-11-07T12:00:00.000Z';
  const lock: CycleInputLock = {
    digest: hashText('lock'),
    grade: 'diagnostic',
    computed_at: now,
    target_description: null,
    master_benchmark: { path: benchmarkPath, sha256: hashText('locked benchmark') },
    tracked_documents: [{ path: 'CLUE.md', sha256: hashText('constitution') }],
    catalogue_version: null,
    policy_files: [],
    environment_fingerprint: FINGERPRINT,
    ratification_event_id: null,
    epoch_name: null,
    absent: ['target_description'],
  };
  const cycle: CycleRecord = {
    id: 'CYCLE-000001',
    mission_version: 'MISSION-000001',
    stage: 'SCREENED',
    suspended_from: null,
    grade: lock.grade,
    lock_digest: lock.digest,
    opened_at: now,
    updated_at: now,
    closed_at: null,
    criteria_met: null,
    unmet_count: null,
  };
  const runtime = {
    config: { project: { root: projectRoot } },
    projections: { db: { prepare: () => ({ get: () => cycle }) } },
    log: { replay: () => [{ type: 'cycle.inputs_locked', payload: { cycle_id: cycle.id, lock } }] },
  } as unknown as Runtime;
  const result = await new CycleOrchestrator(runtime).candidate({ contract: {}, capabilities: [], patch: [] });
  assert.ok(!result.ok && result.stage === 'instrument');
  assert.match(result.reasons[0] ?? '', /Master Benchmark on disk .* differs from the one this cycle locked/);
});

test('proof arm: misuse throws — no cycle, and no locked stick', async () => {
  const root = writeArmFixture(false);
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      return 0;
    });
    await withRuntimeAsync({ withLog: true, repoRoot: root }, async (runtime) => {
      await assert.rejects(
        new CycleOrchestrator(runtime).candidate({ contract: {}, capabilities: [], patch: [] }),
        /No cycle in progress/,
      );
      return 0;
    });
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      new CycleOrchestrator(runtime).drive();
      return 0;
    });
    await withRuntimeAsync({ withLog: true, repoRoot: root }, async (runtime) => {
      await assert.rejects(
        new CycleOrchestrator(runtime).candidate({ contract: {}, capabilities: [], patch: [] }),
        /locked Master Benchmark/,
      );
      return 0;
    });
  } finally {
    rmSync(dirname(root), { recursive: true, force: true, maxRetries: 3 });
  }
});

test('proof arm: the durable chain — refusal by name, snapshot-bound reuse, ACCEPT recorded, evidence outliving failure', { skip: nativeProofSkipReason() }, async () => {
  const root = writeArmFixture(true);
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      return 0;
    });
    let snapshotId = '' as Sha256;
    let cycleId = '';
    let mission = '';
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const driven = new CycleOrchestrator(runtime).drive();
      cycleId = driven.cycle.id;
      mission = runtime.currentMissionId();
      const recognized = driven.performed.find((step) => step.to === 'RECOGNIZED');
      assert.ok(recognized !== undefined && recognized.evidence !== null);
      snapshotId = (runtime.artifacts.getJson(recognized.evidence.hash as never) as { snapshot_id: Sha256 }).snapshot_id;
      return 0;
    });
    const contract = () => fixtureContract(snapshotId, cycleId, mission);

    // (1) No reusable baseline — the refusal names the operator act that already exists.
    await withRuntimeAsync({ withLog: true, repoRoot: root }, async (runtime) => {
      const result = await new CycleOrchestrator(runtime).candidate({
        contract: contract(),
        capabilities: ['stick'],
        patch: [{ op: 'write', path: 'src/cost.txt', content: '80' }],
      });
      assert.ok(!result.ok && result.stage === 'baseline');
      if (result.ok) return 0;
      assert.match(result.reasons[0] ?? '', /run `clue benchmark run`, then retry/);
      return 0;
    });

    // (2) Record a run: the payload binds the snapshot it measured.
    await withRuntimeAsync({ withLog: true, repoRoot: root }, async (runtime) => {
      const stickPath = join(root, 'murugan', 'benchmark', 'stick.md');
      const registered = { path: stickPath, registered: true };
      const subject = prepareBenchmarkRunSubject(runtime, registered);
      const outcome = await runMasterBenchmark({
        repoRoot: root,
        projectRoot: join(root, 'murugan'),
        workspaceRoot: join(dirname(root), 'workspace'),
        contractPath: stickPath,
        environment: { node_version: process.version, platform: process.platform, arch: process.arch },
      });
      assert.ok(outcome.ok);
      if (!outcome.ok) return 0;
      const performed = { outcome, contract: registered, subject, log_head_before: null };
      const lockfile = join(root, 'murugan', 'package-lock.json');
      writeFileSync(lockfile, '{"l":2}');
      assert.throws(() => recordBenchmarkRun(runtime, performed), /Benchmark subject inputs changed/);
      writeFileSync(lockfile, '{"l":1}');
      const receipt = recordBenchmarkRun(runtime, performed);
      assert.equal((receipt.event.payload as { snapshot_id?: string }).snapshot_id, snapshotId);
      const diagnostic = { path: stickPath, registered: false };
      const diagnosticReceipt = recordBenchmarkRun(runtime, {
        ...performed, contract: diagnostic, subject: prepareBenchmarkRunSubject(runtime, diagnostic),
      });
      assert.equal((diagnosticReceipt.event.payload as { proof_eligible?: boolean }).proof_eligible, false);
      return 0;
    });

    // (3) The arm: ACCEPT, and the whole chain durable.
    await withRuntimeAsync({ withLog: true, repoRoot: root }, async (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      const input = {
        contract: contract(),
        capabilities: ['stick'],
        patch: [{ op: 'write' as const, path: 'src/cost.txt', content: '80' }],
      };
      const lockfile = join(root, 'murugan', 'package-lock.json');
      writeFileSync(lockfile, '{"l":2}');
      const stale = await orchestrator.candidate(input);
      assert.ok(!stale.ok && stale.stage === 'freeze');
      if (!stale.ok) assert.match(stale.reasons[0] ?? '', /Screened project inputs changed/);
      writeFileSync(lockfile, '{"l":1}');
      const result = await orchestrator.candidate(input);
      assert.ok(result.ok, result.ok ? '' : `${result.stage}: ${result.reasons.join('; ')}`);
      if (!result.ok) return 0;
      assert.equal(result.verdict.disposition, 'ACCEPT');
      assert.equal(result.verdict.improvement, true);
      assert.equal(result.great_book.state, 'recorded');
      if (result.great_book.state !== 'recorded') return 0;

      const log = runtime.log;
      assert.ok(log !== null);
      const proofTail = [...log.replay()].slice(-3);
      assert.ok(
        proofTail.every((event) => event.subject_id === cycleId),
        'every durable proof event is cycle-addressable',
      );
      const tail = proofTail.map((event) => event.type);
      assert.deepEqual(tail, [
        PROOF_EVENT_TYPES.contractFrozen,
        PROOF_EVENT_TYPES.baselineBound,
        PROOF_EVENT_TYPES.verdictRecorded,
      ]);
      const verdictEvent = [...log.replay()].reverse().find((event) => event.type === PROOF_EVENT_TYPES.verdictRecorded);
      assert.ok(verdictEvent !== undefined);
      assert.equal([...log.replay()].filter((event) =>
        event.type === PROOF_EVENT_TYPES.verdictRecorded && event.subject_id === cycleId &&
        (event.payload as { disposition?: string }).disposition === 'ACCEPT'
      ).length, 1);
      const payload = verdictEvent.payload as {
        disposition: string;
        change_set: readonly unknown[];
        artifacts: { verdict: { hash: string } };
        great_book: {
          state: string;
          entry?: { entry_id: string; causal_claim: string; contract_hash: string };
        };
      };
      assert.equal(payload.disposition, 'ACCEPT');
      assert.equal(payload.change_set.length, 1);
      assert.equal(payload.great_book.state, 'recorded');
      assert.equal(payload.great_book.entry?.entry_id, result.great_book.entry.entry_id);
      assert.equal(payload.great_book.entry?.causal_claim, contract().hypothesis.causal_claim);
      assert.equal(payload.great_book.entry?.contract_hash, result.contract_hash);
      const stored = runtime.artifacts.getJson(payload.artifacts.verdict.hash as never) as { disposition: string };
      assert.equal(stored.disposition, 'ACCEPT');

      const greatBook = readGreatBookEntries(runtime.projections, runtime.config.project.id);
      assert.equal(greatBook.length, 1);
      assert.equal(greatBook[0]?.entry_id, result.great_book.entry.entry_id);
      assert.deepEqual(
        greatBook[0]?.contributions.map((item) => item.measurement_id),
        ['MD04', 'MI05', 'MJ06'],
      );
      const greatBookFacts = readGreatBookFacts(runtime.projections, runtime.config.project.id);
      assert.equal(greatBookFacts.entryCount, 1);
      assert.equal(greatBookFacts.contributionCount, 3);
      assert.equal(greatBookFacts.recordingGapCount, 0);

      assert.equal(orchestrator.status()?.stage, 'SCREENED', 'candidates are a loop, not a stage');
      assert.equal(readFileSync(join(root, 'murugan', 'src', 'cost.txt'), 'utf8'), '100');

      // (4) A static-failing candidate: the refusal is recorded with its evidence.
      const broken = await orchestrator.candidate({
        contract: contract(),
        capabilities: ['stick'],
        patch: [{ op: 'write', path: 'src/broken.marker', content: '' }],
      });
      assert.ok(!broken.ok && broken.stage === 'static');
      if (broken.ok) return 0;
      assert.ok(typeof broken.recorded_event === 'string');
      assert.match((broken.evidence ?? [])[0] ?? '', /broken marker/);
      const refused = [...log.replay()]
        .reverse()
        .find((event) => event.type === PROOF_EVENT_TYPES.executionRefused);
      assert.ok(refused !== undefined);
      assert.equal(refused.subject_id, cycleId, 'execution refusal stays attributable to its cycle');

      // (5) A contract frozen for another cycle refuses at freeze, before anything records.
      const foreign = await orchestrator.candidate({
        contract: { ...contract(), cycle_id: 'CYCLE-999999' },
        capabilities: ['stick'],
        patch: [],
      });
      assert.ok(!foreign.ok && foreign.stage === 'freeze' && /binds cycle CYCLE-999999/.test(foreign.reasons[0] ?? ''));
      return 0;
    });
  } finally {
    rmSync(dirname(root), { recursive: true, force: true, maxRetries: 3 });
  }
});
