/**
 * Master Benchmark runner acceptance (DEV-P2-07, slice B3; ADR-0010).
 *
 * The pins, in the order they matter:
 *
 * **The real contract is the fixture.** The suite reads
 * `targets/clu/benchmark/master-benchmark.md` itself: identity parses, exactly one
 * `cli-node` block with the six scenarios, and — the drift alarm — the recorded
 * `integrity` verifies against the body on disk, on LF and on CRLF alike. Any future edit
 * to the fenced body without re-recording its hash turns the suite red, which is the whole
 * point of embedding the harness in the version that governs comparability.
 *
 * **Every refusal is a distinct, named outcome.** Nine runner stages (`read` → `version`)
 * plus the grammar owner's own refusals (duplicate block, unterminated fence, unknown and
 * duplicate keys, malformed integrity and scenario ids, conflicting identity values) are
 * each produced deliberately and asserted by stage, not by message prefix.
 *
 * **§4 governs from the contract.** A contract declaring `default_repetitions = 2` runs
 * with 2; the shipped defaults fill only true absences; the caller's explicit override
 * wins over both (it exists for tests and diagnostics); and the real contract yields
 * exactly the reviewed numbers (1800 · 1 · 3 · 5400).
 *
 * **The version-agreement check is a VOID, not an error message.** A body reporting a
 * `benchmarkVersion` the document does not govern refuses at stage `version` — the one
 * agreement check ADR-0010 kept, now a self-check inside one artifact.
 *
 * **Gates render §7 exactly, and conservatively.** All five gates over synthetic
 * opening/closing pairs: the clean pass, the test-count drop that voids, the *missing*
 * protective signal that voids (protection unproven is protection failed), the
 * unresolved-imports rise that blocks equilibrium without voiding, the >10% timing
 * regression that seeds a candidate, GATE-002's 0.5% rule with and without a declared
 * removal, and the refusal of any contract identity this rendering does not cover.
 *
 * **Execution mechanics are real.** `makeExec` spawns actual processes: wall time is
 * measured, a timeout SIGTERMs and reports `timedOut`, and an exhausted total budget
 * refuses the next spawn with a synthesized incomplete rather than starting work it
 * cannot finish. The Windows `npm` → `cmd.exe` translation is pinned as pure argv
 * rewriting, no shell needed on the asserting host.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  canonicalHarnessBody,
  readBenchmarkContract,
  readExecutionPolicy,
  selectHarnessBlock,
  verifyHarnessIntegrity,
} from '../src/benchmark/harnessBlock.js';
import {
  DEFAULT_EXECUTION_POLICY,
  benchmarkResultSchema,
  evaluateGates,
  isCompleteCluBenchmarkV020,
  makeExec,
  platformArgv,
  runMasterBenchmark,
  type BenchmarkMeasure,
  type ExecFn,
} from '../src/benchmark/benchmarkRunner.js';
import { captureBenchmarkExecutableInputs } from '../src/control/benchmarkRun.js';
import { hashBytes, hashText } from '../src/shared/ids.js';

const CONTRACT_PATH = fileURLToPath(
  new URL('../../targets/clu/benchmark/master-benchmark.md', import.meta.url),
);
const realContract = readFileSync(CONTRACT_PATH, 'utf8');

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

/** A minimal contract whose harness body is recorded (integrity computed, not placeholder). */
function contractWith(body: string, options?: { version?: string; language?: string }): string {
  const canonical = canonicalHarnessBody(body);
  return [
    'benchmark_id = clu-master',
    `benchmark_version = ${options?.version ?? '0.1.0'}`,
    'runner_adapter = cli-node',
    '',
    '[harness.HRN-001]',
    'runner_adapter = cli-node',
    'scenario_ids = SCN-001',
    `language = ${options?.language ?? 'javascript'}`,
    `integrity = ${hashText(canonical)}`,
    '--- begin harness ---',
    body,
    '--- end harness ---',
    '',
  ].join('\n');
}

/** Stub exec with a fresh clock, mimicking the CLI formats measured in the B3 session. */
function stubExec(): ExecFn {
  let t = 100;
  const line = (label: string, detail: string) => `  OK   ${label.padEnd(34)} ${detail}\n`;
  return async (argv) => {
    const cmd = argv.join(' ');
    t += 7;
    const ok = (stdout: string, wallMs = t) => ({ code: 0, stdout, stderr: '', wallMs, timedOut: false });
    if (cmd.includes('resultHash')) return ok(`${'f'.repeat(64)}\n`);
    if (cmd.includes('recognize')) {
      return ok(
        line('units', '6294') +
          line('edges', '30687') +
          '  WARN  unresolved                         473 reference(s) the graph could not follow\n',
        argv.includes('--full') ? t : 180,
      );
    }
    if (cmd.includes('metrics')) return ok(line('values stored', '42917'));
    if (argv.includes('rebuild-projections')) return ok(JSON.stringify({
      state: 'PROJECTION_REBUILD_VERIFIED', eventCount: 3, eventHead: 'a'.repeat(64),
      factsDigest: 'b'.repeat(64), elapsedMs: 40,
    }));
    if (argv.includes('verify-chain')) {
      return ok(line('event chain', `3 committed records verified, head ${'a'.repeat(64)}`));
    }
    if (argv.includes('dist/selftest/benchmark-offline-suite-v1.js')) {
      return ok('CLU-E_OFFLINE_SUITE_V1\n# tests 502\n# pass 497\n# fail 0\n# cancelled 0\n# skipped 5\n# todo 0\n');
    }
    return ok(line('x', 'y'));
  };
}

function runOptions(overrides: Partial<Parameters<typeof runMasterBenchmark>[0]> = {}) {
  return {
    repoRoot: '/repo',
    projectRoot: '/project',
    workspaceRoot: '/workspace',
    contractPath: CONTRACT_PATH,
    execImpl: stubExec(),
    environment: { node_version: 'v22.11.0', platform: 'linux', arch: 'x64' },
    ...overrides,
  };
}

function measure(id: string, value: number): BenchmarkMeasure {
  return { id, name: id, scenario: 'S', native_unit: 'x', aggregation: 'a', value, samples: [value] };
}

const GATE_IDENTITY = {
  benchmark_id: 'clu-master',
  benchmark_version: '0.1.0',
  runner_adapter: 'cli-node',
} as const;

const OPENING: readonly BenchmarkMeasure[] = [
  measure('SIG-001', 1000),
  measure('SIG-003', 6294),
  measure('SIG-004', 30687),
  measure('SIG-005', 473),
  measure('SIG-008', 42917),
  measure('SIG-011', 90000),
  measure('SIG-012', 497),
  measure('SIG-013', 5),
];

function replaced(id: string, value: number): readonly BenchmarkMeasure[] {
  return OPENING.map((entry) => (entry.id === id ? measure(id, value) : entry));
}

/* ------------------------------------------------------------------------- */
/* The real contract is the fixture                                           */
/* ------------------------------------------------------------------------- */

test('the shipped contract parses: identity, one cli-node block, six scenarios', () => {
  const read = readBenchmarkContract(realContract);
  assert.ok(!('error' in read), 'error' in read ? read.error : '');
  if ('error' in read) return;
  assert.equal(read.identity.benchmark_id, 'clu-master');
  assert.equal(read.identity.benchmark_version, '0.2.0');
  assert.equal(read.identity.runner_adapter, 'cli-node');
  const block = selectHarnessBlock(read, 'cli-node');
  assert.ok(!('error' in block));
  if ('error' in block) return;
  assert.equal(block.id, 'HRN-001');
  assert.deepEqual(block.scenario_ids, ['SCN-001', 'SCN-002', 'SCN-003', 'SCN-004', 'SCN-005', 'SCN-006']);
  assert.equal(block.language, 'javascript');
});

test('the recorded integrity verifies against the body on disk — the drift alarm', () => {
  const read = readBenchmarkContract(realContract);
  assert.ok(!('error' in read));
  if ('error' in read) return;
  const block = selectHarnessBlock(read, 'cli-node');
  assert.ok(!('error' in block));
  if ('error' in block) return;
  assert.equal(block.integrity.state, 'declared');
  assert.deepEqual(verifyHarnessIntegrity(block), { ok: true });
});

test('the canonical form is CRLF-stable: the same recorded hash verifies both checkouts', () => {
  const crlf = readBenchmarkContract(realContract.replace(/\n/g, '\r\n'));
  assert.ok(!('error' in crlf));
  if ('error' in crlf) return;
  const block = selectHarnessBlock(crlf, 'cli-node');
  assert.ok(!('error' in block));
  if ('error' in block) return;
  assert.deepEqual(verifyHarnessIntegrity(block), { ok: true });
});

test('a placeholder integrity is a stated absence, and verification refuses it by name', () => {
  const draft = contractWith('return 1').replace(/^integrity = .*$/m, 'integrity = <recorded at approval>');
  const read = readBenchmarkContract(draft);
  assert.ok(!('error' in read));
  if ('error' in read) return;
  const block = selectHarnessBlock(read, 'cli-node');
  assert.ok(!('error' in block));
  if ('error' in block) return;
  assert.equal(block.integrity.state, 'unrecorded');
  const verdict = verifyHarnessIntegrity(block);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.match(verdict.reason, /unrecorded/);
  assert.ok(verdict.reason.includes(block.body_sha256), 'the refusal names the actual hash');
});

/* ------------------------------------------------------------------------- */
/* Grammar refusals                                                           */
/* ------------------------------------------------------------------------- */

test('grammar refusals: each malformation is named, none half-reads', () => {
  const base = contractWith('return 1');
  const cases: readonly { readonly mutate: (text: string) => string; readonly expect: RegExp }[] = [
    { mutate: (t) => t + '\n' + contractWith('return 2').split('\n').slice(4).join('\n'), expect: /duplicate harness block id/ },
    { mutate: (t) => t.replace('--- end harness ---', ''), expect: /unterminated/ },
    { mutate: (t) => t.replace('language = javascript', 'language = javascript\nflavour = strong'), expect: /unknown key/ },
    { mutate: (t) => t.replace('language = javascript', 'language = javascript\nlanguage = javascript'), expect: /duplicate key/ },
    { mutate: (t) => t.replace(/^language = javascript\n/m, ''), expect: /missing required key language/ },
    { mutate: (t) => t.replace(/^integrity = .*$/m, 'integrity = not-a-hash'), expect: /integrity must be 64 lowercase hex/ },
    { mutate: (t) => t.replace('scenario_ids = SCN-001', 'scenario_ids = SCN-001,'), expect: /malformed id/ },
    { mutate: (t) => t.replace('scenario_ids = SCN-001', 'scenario_ids = SCN-001,SCN-001'), expect: /repeats SCN-001/ },
    { mutate: (t) => t.replace('language = javascript', 'this line has no equals sign'), expect: /unparseable line/ },
    { mutate: (t) => t.replace(/^benchmark_id = .*\n/m, ''), expect: /declares no benchmark_id/ },
    { mutate: (t) => t + '\nbenchmark_version = 9.9.9\n', expect: /benchmark_version more than once/ },
  ];
  for (const { mutate, expect } of cases) {
    const read = readBenchmarkContract(mutate(base));
    assert.ok('error' in read, `expected refusal matching ${expect}`);
    if (!('error' in read)) continue;
    assert.match(read.error, expect);
  }
});

test('identity reads the Markdown rendering, and first-occurrence governs when consistent', () => {
  const markdown = [
    '# A contract',
    '',
    '**Benchmark id:** `md-form`',
    '**Benchmark version:** 1.2.3',
    '**Runner adapter:** `cli-node` (prose continues)',
  ].join('\n');
  const read = readBenchmarkContract(markdown);
  assert.ok(!('error' in read));
  if ('error' in read) return;
  assert.deepEqual(read.identity, { benchmark_id: 'md-form', benchmark_version: '1.2.3', runner_adapter: 'cli-node' });
});

test('selection refuses zero blocks and refuses two blocks for one adapter', () => {
  const read = readBenchmarkContract(contractWith('return 1'));
  assert.ok(!('error' in read));
  if ('error' in read) return;
  const none = selectHarnessBlock(read, 'browser-injection');
  assert.ok('error' in none && /no \[harness\.\*\] block/.test(none.error));
  const twin = contractWith('return 1') + contractWith('return 1').split('\n').slice(4).join('\n').replace('HRN-001', 'HRN-002');
  const both = readBenchmarkContract(twin);
  assert.ok(!('error' in both));
  if ('error' in both) return;
  const two = selectHarnessBlock(both, 'cli-node');
  assert.ok('error' in two && /2 harness blocks/.test(two.error));
});

/* ------------------------------------------------------------------------- */
/* §4 governs from the contract                                               */
/* ------------------------------------------------------------------------- */

test('§4 reads the shipped contract to exactly the reviewed numbers', () => {
  assert.deepEqual(readExecutionPolicy(realContract), {
    default_timeout_seconds: 1800,
    default_warmup_runs: 1,
    default_repetitions: 3,
    maximum_total_runtime_seconds: 5400,
  });
});

test('§4 refusals: conflicting values and below-minimum values', () => {
  const conflict = readExecutionPolicy('default_repetitions = 2\n`default_repetitions` 3');
  assert.ok('error' in conflict && /more than once/.test(conflict.error));
  const zero = readExecutionPolicy('default_repetitions = 0');
  assert.ok('error' in zero && /at least 1/.test(zero.error));
  const warmups = readExecutionPolicy('default_warmup_runs = 0');
  assert.ok(!('error' in warmups) && warmups.default_warmup_runs === 0, 'zero warmups is a legitimate policy');
});

test('policy precedence: defaults fill absences, the contract overrides them, the caller overrides both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-policy-'));
  try {
    const body =
      'return { benchmarkVersion: "0.1.0", unifiedScore: null, measures: [], protective: [], ' +
      'environment: context.environment, incomplete: [{ id: "reps", reason: "reps=" + context.repetitions }] }';
    const declared = 'default_repetitions = 2\ndefault_warmup_runs = 0\n' + contractWith(body);
    const path = join(dir, 'contract.md');
    writeFileSync(path, declared);

    const fromContract = await runMasterBenchmark(runOptions({ contractPath: path }));
    assert.ok(fromContract.ok);
    if (!fromContract.ok) return;
    assert.equal(fromContract.policy.repetitions, 2, 'the contract governs');
    assert.equal(fromContract.policy.warmupRuns, 0);
    assert.equal(fromContract.policy.scenarioTimeoutSeconds, DEFAULT_EXECUTION_POLICY.scenarioTimeoutSeconds, 'defaults fill the absence');
    assert.deepEqual(fromContract.result.incomplete, [{ id: 'reps', reason: 'reps=2' }], 'the harness saw the contract value');

    const overridden = await runMasterBenchmark(runOptions({ contractPath: path, policy: { repetitions: 5 } }));
    assert.ok(overridden.ok);
    if (!overridden.ok) return;
    assert.equal(overridden.policy.repetitions, 5, 'the caller overrides');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------- */
/* The runner's refusal ladder                                                */
/* ------------------------------------------------------------------------- */

test('every runner refusal fires at its own stage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-refusals-'));
  const path = join(dir, 'contract.md');
  const at = async (expected: string, text?: string, overrides: Parameters<typeof runOptions>[0] = {}) => {
    if (text !== undefined) writeFileSync(path, text);
    const outcome = await runMasterBenchmark(runOptions({ contractPath: path, ...overrides }));
    assert.equal(outcome.ok, false, `expected refusal at ${expected}`);
    if (outcome.ok) return;
    assert.equal(outcome.stage, expected, outcome.reason);
  };
  try {
    await at('read', undefined, { contractPath: join(dir, 'absent.md') });
    await at('contract', 'no identity here at all');
    await at('select', contractWith('return 1'), { runnerAdapter: 'browser-injection' });
    await at('language', contractWith('return 1', { language: 'python' }));
    await at('integrity', contractWith('return 1').replace(/^integrity = .*$/m, `integrity = ${'0'.repeat(64)}`));
    await at('syntax', contractWith('return {{{'));
    await at('execute', contractWith('throw new Error("boom")'));
    await at('shape', contractWith('return { wrong: true }'));
    await at(
      'version',
      contractWith(
        'return { benchmarkVersion: "9.9.9", unifiedScore: null, measures: [], protective: [], environment: context.environment, incomplete: [] }',
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner executes and hashes the exact pinned bytes, and refuses invalid UTF-8', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-pinned-'));
  try {
    const path = join(dir, 'contract.md');
    const bytes = Buffer.from(contractWith(
      'return { benchmarkVersion: "0.1.0", unifiedScore: null, measures: [], protective: [], environment: context.environment, incomplete: [] }',
    ).replace(/\n/gu, '\r\n'));
    writeFileSync(path, 'The contract path changed after capture.');
    const pinned = await runMasterBenchmark(runOptions({ contractPath: path, contractBytes: bytes }));
    assert.ok(pinned.ok);
    assert.equal(pinned.contract.sha256, hashBytes(bytes));

    const invalid = await runMasterBenchmark(runOptions({
      contractPath: path,
      contractBytes: Buffer.concat([bytes, Buffer.from([0xff])]),
    }));
    assert.ok(!invalid.ok);
    assert.equal(invalid.stage, 'read');
    assert.match(invalid.reason, /not valid UTF-8/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark harness has only guest-realm data and a typed broker', async () => {
  const body = [
    'if (typeof process !== "undefined" || typeof require !== "undefined" || typeof fetch !== "undefined") throw new Error("host access");',
    'let escaped = false;',
    'try { context.exec.constructor.constructor("return process")(); escaped = true; } catch {}',
    'if (escaped) throw new Error("host function");',
    'const reply = await context.exec(["broker-test"]);',
    'if (reply.stdout !== "hello") throw new Error("broker mismatch");',
    'return { benchmarkVersion: "0.1.0", unifiedScore: null, measures: [], protective: [], environment: context.environment, incomplete: [] };',
  ].join('\n');
  let calls = 0;
  const outcome = await runMasterBenchmark(runOptions({
    contractBytes: Buffer.from(contractWith(body)),
    execImpl: async (argv, opts) => {
      calls += 1;
      assert.deepEqual(argv, ['broker-test']);
      assert.ok(opts?.signal instanceof AbortSignal);
      return { code: 0, stdout: 'hello', stderr: '', wallMs: 1, timedOut: false };
    },
  }));
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
  assert.equal(calls, 1);
  assert.equal(outcome.execution_boundary, undefined, 'test injection is not native restriction evidence');
});

test('benchmark worker refuses dynamic import, malformed brokerage and nonterminating guest code', async () => {
  const cases = [
    ['await import("node:fs");', /dynamic module loading/iu],
    ['await context.exec(["broker-test"], { shell: true });', /broker protocol/iu],
    ['while (true) {}', /timed out|deadline/iu],
  ] as const;
  for (const [body, reason] of cases) {
    const outcome = await runMasterBenchmark(runOptions({
      contractBytes: Buffer.from(contractWith(body)),
      execImpl: async () => assert.fail('refused guest reached the trusted command broker'),
    }));
    assert.ok(!outcome.ok);
    assert.equal(outcome.stage, 'execute');
    assert.match(outcome.reason, reason);
  }
});

test('benchmark wall deadline cancels an in-flight broker command before returning', async () => {
  let cancelled = false;
  const outcome = await runMasterBenchmark(runOptions({
    contractBytes: Buffer.from(contractWith('await context.exec(["broker-test"]);')),
    maxProofDurationSeconds: 1,
    execImpl: async (_argv, opts) => await new Promise((resolve) => {
      assert.ok(opts?.signal instanceof AbortSignal);
      assert.ok(opts.timeoutSeconds !== undefined && opts.timeoutSeconds <= 1);
      opts.signal.addEventListener('abort', () => {
        cancelled = true;
        resolve({ code: -1, stdout: '', stderr: '', wallMs: 0, timedOut: true });
      }, { once: true });
    }),
  }));
  assert.ok(!outcome.ok);
  assert.equal(outcome.stage, 'execute');
  assert.match(outcome.reason, /wall-clock deadline/u);
  assert.equal(cancelled, true);
});

test('benchmark executable inputs detect built code and nested installed dependency drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-executable-inputs-'));
  try {
    const dist = join(root, 'dist');
    const nested = join(root, 'node_modules', 'parent', 'node_modules', 'child');
    mkdirSync(dist);
    mkdirSync(nested, { recursive: true });
    const executable = join(dist, 'run.js');
    const dependency = join(nested, 'index.js');
    writeFileSync(executable, 'export default 1;');
    writeFileSync(dependency, 'export default 2;');
    const before = captureBenchmarkExecutableInputs(root, root);
    writeFileSync(join(dist, '.tsbuildinfo'), 'compiler cache');
    assert.deepEqual(captureBenchmarkExecutableInputs(root, root), before);
    writeFileSync(executable, 'export default 3;');
    writeFileSync(dependency, 'export default 4;');
    const after = captureBenchmarkExecutableInputs(root, root);
    assert.notEqual(after.engine_dist_id, before.engine_dist_id);
    assert.notEqual(after.engine_dependencies_id, before.engine_dependencies_id);
    assert.equal(after.node_sha256, before.node_sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the version refusal is a VOID by wording, not merely a mismatch note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-void-'));
  try {
    const path = join(dir, 'contract.md');
    writeFileSync(
      path,
      contractWith(
        'return { benchmarkVersion: "0.9.9", unifiedScore: null, measures: [], protective: [], environment: context.environment, incomplete: [] }',
      ),
    );
    const outcome = await runMasterBenchmark(runOptions({ contractPath: path }));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.stage, 'version');
    assert.match(outcome.reason, /^VOID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------- */
/* The happy path, against the shipped contract                               */
/* ------------------------------------------------------------------------- */

test('a run against the shipped contract returns the full result shape, bound to its stick', async () => {
  const outcome = await runMasterBenchmark(runOptions());
  assert.ok(outcome.ok, outcome.ok ? '' : `${outcome.stage}: ${outcome.reason}`);
  if (!outcome.ok) return;

  assert.ok(benchmarkResultSchema.safeParse(outcome.result).success);
  assert.equal(outcome.result.benchmarkVersion, '0.2.0');
  assert.ok(isCompleteCluBenchmarkV020(outcome.result), JSON.stringify(outcome.result.incomplete));
  assert.equal(outcome.result.unifiedScore, null, 'no baseline: the absence is stated, not a fabricated 1.0');

  const ids = outcome.result.measures.map((entry) => entry.id).sort();
  for (const id of ['SIG-001', 'SIG-003', 'SIG-004', 'SIG-005', 'SIG-007', 'SIG-008', 'SIG-009', 'SIG-010', 'SIG-011', 'SIG-012', 'SIG-013']) {
    assert.ok(ids.includes(id), `expected ${id} in measures`);
  }
  assert.deepEqual(
    outcome.result.protective.map((entry) => entry.id),
    ['SIG-005', 'SIG-008', 'SIG-012', 'SIG-013'],
  );

  assert.equal(outcome.contract.benchmark_id, 'clu-master');
  assert.equal(outcome.contract.block_id, 'HRN-001');
  assert.equal(outcome.contract.sha256, hashText(realContract), 'bound to the whole document by content');
  assert.equal(outcome.policy.repetitions, 3, '§4 governed the run');
  const byId = new Map(outcome.result.measures.map((measure) => [measure.id, measure]));
  assert.deepEqual(byId.get('SIG-001')?.warmup_samples, [114]);
  assert.deepEqual(byId.get('SIG-001')?.samples, [121, 128, 135]);
  assert.equal(byId.get('SIG-001')?.value, 128);
  assert.deepEqual(byId.get('SIG-003')?.warmup_samples, [6294]);
  assert.deepEqual(byId.get('SIG-003')?.samples, [6294, 6294, 6294]);
  assert.deepEqual(byId.get('SIG-009')?.samples, [40, 40, 40]);
  assert.deepEqual(byId.get('SIG-012')?.samples, [497, 497, 497]);
  assert.equal(byId.get('SIG-002')?.samples.length, 3);
});

test('the stock benchmark leaves unstable exact counts and red suite evidence incomplete', async () => {
  const exec = stubExec();
  let metrics = 0;
  const outcome = await runMasterBenchmark(runOptions({
    execImpl: async (argv, options) => {
      const result = await exec(argv, options);
      if (argv.includes('metrics') && ++metrics === 4) {
        return { ...result, stdout: result.stdout.replace('42917', '42918') };
      }
      if (argv.includes('dist/selftest/benchmark-offline-suite-v1.js')) {
        return { ...result, code: 1, stdout: result.stdout.replace('# fail 0', '# fail 1') };
      }
      return result;
    },
  }));
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
  assert.equal(isCompleteCluBenchmarkV020(outcome.result), false);
  for (const id of ['SIG-008', 'SIG-011', 'SIG-012', 'SIG-013']) {
    assert.ok(outcome.result.incomplete.some((measure) => measure.id === id), id);
    assert.ok(!outcome.result.measures.some((measure) => measure.id === id), id);
  }
});

test('missing scenario receipts or incomplete TAP cannot supply required signals', async () => {
  const exec = stubExec();
  const outcome = await runMasterBenchmark(runOptions({
    policy: { repetitions: 1, warmupRuns: 0 },
    execImpl: async (argv, options) => {
      const result = await exec(argv, options);
      if (argv.includes('rebuild-projections') || argv.includes('verify-chain')) {
        return { ...result, stdout: 'unverified' };
      }
      if (argv.includes('dist/selftest/benchmark-offline-suite-v1.js')) {
        return { ...result, stdout: result.stdout.replace('# cancelled 0', '# cancelled 1') };
      }
      return result;
    },
  }));
  assert.ok(outcome.ok);
  assert.equal(isCompleteCluBenchmarkV020(outcome.result), false);
  for (const id of ['SIG-009', 'SIG-010', 'SIG-011', 'SIG-012', 'SIG-013']) {
    assert.ok(outcome.result.incomplete.some((entry) => entry.id === id), id);
  }
});

test('a closing run against its own opening scores exactly 1.0', async () => {
  const opening = await runMasterBenchmark(runOptions());
  assert.ok(opening.ok);
  if (!opening.ok) return;
  const closing = await runMasterBenchmark(runOptions({ baseline: opening.result.measures }));
  assert.ok(closing.ok);
  if (!closing.ok) return;
  assert.equal(closing.result.unifiedScore, 1, 'indistinguishable from the opening run');
});

/* ------------------------------------------------------------------------- */
/* Execution mechanics — real processes                                       */
/* ------------------------------------------------------------------------- */

test('makeExec measures wall time and enforces the per-call timeout with a kill', async () => {
  const { exec } = makeExec({
    cwd: process.cwd(),
    policy: { ...DEFAULT_EXECUTION_POLICY, scenarioTimeoutSeconds: 1 },
  });
  const quick = await exec(['node', '-e', 'console.log("out"); console.error("err")']);
  assert.equal(quick.code, 0);
  assert.match(quick.stdout, /out/);
  assert.match(quick.stderr, /err/);
  assert.ok(quick.wallMs > 0);
  assert.equal(quick.timedOut, false);

  const slow = await exec(['node', '-e', 'setTimeout(() => {}, 60000)'], { timeoutSeconds: 0.2 });
  assert.equal(slow.timedOut, true);
  assert.notEqual(slow.code, 0);
});

test('an exhausted total budget refuses the next spawn as incomplete, not slow', async () => {
  const made = makeExec({
    cwd: process.cwd(),
    policy: { ...DEFAULT_EXECUTION_POLICY, maxTotalRuntimeSeconds: 0.001 },
  });
  const first = await made.exec(['node', '-e', '0']);
  assert.equal(first.timedOut, false, 'the budget is checked before a spawn, so the first call runs');
  const second = await made.exec(['node', '-e', '0']);
  assert.equal(second.timedOut, true);
  assert.match(second.stderr, /maximum_total_runtime_seconds .* exhausted/);
  assert.equal(made.exhausted(), true);
});

test('the Windows npm translation is pure argv rewriting, and only for npm on win32', () => {
  assert.deepEqual(platformArgv(['npm', 'run', 'selftest'], 'win32'), ['cmd.exe', '/d', '/s', '/c', 'npm', 'run', 'selftest']);
  assert.deepEqual(platformArgv(['npm', 'run', 'selftest'], 'linux'), ['npm', 'run', 'selftest']);
  assert.deepEqual(platformArgv(['node', '-e', '0'], 'win32'), ['node', '-e', '0']);
});

/* ------------------------------------------------------------------------- */
/* §7 gates                                                                   */
/* ------------------------------------------------------------------------- */

test('gates: the clean pass', () => {
  const report = evaluateGates({ identity: GATE_IDENTITY, opening: OPENING, closing: OPENING });
  assert.ok(!('error' in report));
  if ('error' in report) return;
  assert.equal(report.run_verdict, 'valid');
  assert.equal(report.equilibrium_blocked, false);
  assert.equal(report.candidate_seed, false);
  assert.ok(report.gates.every((gate) => gate.outcome === 'pass'));
});

test('GATE-001 voids on a passing-test drop, and on a skip growth', () => {
  for (const closing of [replaced('SIG-012', 496), replaced('SIG-013', 6)]) {
    const report = evaluateGates({ identity: GATE_IDENTITY, opening: OPENING, closing });
    assert.ok(!('error' in report));
    if ('error' in report) return;
    assert.equal(report.run_verdict, 'void');
  }
});

test('a missing protective signal voids: protection unproven is protection failed', () => {
  const closing = OPENING.filter((entry) => entry.id !== 'SIG-012');
  const report = evaluateGates({ identity: GATE_IDENTITY, opening: OPENING, closing });
  assert.ok(!('error' in report));
  if ('error' in report) return;
  assert.equal(report.run_verdict, 'void');
  const gate = report.gates.find((entry) => entry.id === 'GATE-001');
  assert.equal(gate?.outcome, 'unevaluable');
});

test('GATE-002: a >0.5% unit drop voids, unless a removal is declared — then the deltas are named', () => {
  const closing = replaced('SIG-003', 6231);
  const undeclared = evaluateGates({ identity: GATE_IDENTITY, opening: OPENING, closing });
  assert.ok(!('error' in undeclared));
  if ('error' in undeclared) return;
  assert.equal(undeclared.run_verdict, 'void');

  const declared = evaluateGates({ identity: GATE_IDENTITY, opening: OPENING, closing, declared_removal: true });
  assert.ok(!('error' in declared));
  if ('error' in declared) return;
  assert.equal(declared.run_verdict, 'valid');
  const gate = declared.gates.find((entry) => entry.id === 'GATE-002');
  assert.match(gate?.detail ?? '', /declared removal/);
});

test('GATE-003/004 block equilibrium without voiding the run', () => {
  for (const closing of [replaced('SIG-005', 474), replaced('SIG-008', 42916)]) {
    const report = evaluateGates({ identity: GATE_IDENTITY, opening: OPENING, closing });
    assert.ok(!('error' in report));
    if ('error' in report) return;
    assert.equal(report.run_verdict, 'valid');
    assert.equal(report.equilibrium_blocked, true);
  }
});

test('GATE-005: a >10% timing regression seeds a candidate and stays advisory', () => {
  const report = evaluateGates({ identity: GATE_IDENTITY, opening: OPENING, closing: replaced('SIG-011', 108001) });
  assert.ok(!('error' in report));
  if ('error' in report) return;
  assert.equal(report.run_verdict, 'valid');
  assert.equal(report.candidate_seed, true);
  const gate = report.gates.find((entry) => entry.id === 'GATE-005');
  assert.equal(gate?.severity, 'advisory');
  assert.match(gate?.detail ?? '', /SIG-011/);
});

test('the gate rendering refuses any contract identity it does not cover', () => {
  const foreign = evaluateGates({
    identity: { ...GATE_IDENTITY, benchmark_id: 'other' },
    opening: OPENING,
    closing: OPENING,
  });
  assert.ok('error' in foreign);
  const major = evaluateGates({
    identity: { ...GATE_IDENTITY, benchmark_version: '0.3.0' },
    opening: OPENING,
    closing: OPENING,
  });
  assert.ok('error' in major);
  const repaired = evaluateGates({
    identity: { ...GATE_IDENTITY, benchmark_version: '0.2.0' },
    opening: OPENING,
    closing: OPENING,
  });
  assert.ok(!('error' in repaired));
  assert.equal(repaired.run_verdict, 'valid');
});
