/**
 * Cycle closure acceptance (DEV-P2-08 closure tail + S6; cycle plan accepted 2026-08-10).
 *
 * Three layers, cheapest first:
 *
 * **The doctor line** (`cycleCheck`) is pure — four branches pinned exactly: live names
 * id/stage/grade/lock, SUSPENDED warns and names where from, no-live falls back to the
 * last closure's §24 verdict, nothing says how to start.
 *
 * **The closer's refusals** need only the registry and a minimal runtime shell: a cycle
 * before SCREENED is told to drive first, a suspended one that resuming is the operator's
 * act, no cycle at all is told so plainly.
 *
 * **The full arc** runs for real: a synthetic target (one TypeScript file, its own
 * tsconfig) inside a written-to-disk configuration, `withRuntime` opened in-process, and
 * the orchestrator driven OPENED → SCREENED → closeDiagnostic → CLOSED. Real snapshot,
 * real recognition, real screening, real artifacts — then §24 read back from the closure
 * event and the handoff artifact read back from the store, both checked against the lock
 * the cycle itself declared. Nothing mocked; the arc that happened on the twin is now the
 * arc the suite guards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import { withRuntime, type Runtime } from '../src/control/runtime.js';
import {
  CYCLE_EVENT_TYPES,
  CYCLE_PROJECTION,
  CycleRegistry,
} from '../src/cycle/cycleRegistry.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { canonicalHarnessBody } from '../src/benchmark/harnessBlock.js';
import { runMasterBenchmark, type ExecFn } from '../src/benchmark/benchmarkRunner.js';
import { prepareBenchmarkRunSubject, resolveContract, type PerformedRun } from '../src/control/benchmarkRun.js';
import { hashText } from '../src/shared/ids.js';
import { PROOF_EVENT_TYPES } from '../src/proof/proofContract.js';
import { cycleCheck } from '../src/cli/commands/doctorCommands.js';
import { commandCycleClose } from '../src/cli/commands/cycleCommands.js';
import {
  cycleClosedSchema,
  cycleInputsLockedSchema,
  nextCycleVitalInputSchema,
  type CycleClosed,
  type CycleRecord,
} from '../src/shared/schemas.js';

/* ========================================================================= */
/* The doctor line                                                            */
/* ========================================================================= */

const record = (overrides: Partial<CycleRecord>): CycleRecord => ({
  id: 'CYCLE-000001',
  mission_version: 'MISSION-000001',
  stage: 'SCREENED',
  suspended_from: null,
  grade: 'diagnostic',
  lock_digest: 'a'.repeat(64),
  opened_at: '2026-08-10T12:00:00.000Z',
  updated_at: '2026-08-10T12:30:00.000Z',
  closed_at: null,
  criteria_met: null,
  unmet_count: null,
  ...overrides,
});

const closure = (overrides: Partial<CycleClosed>): CycleClosed => ({
  cycle_id: 'CYCLE-000001',
  closed_at: '2026-08-10T20:17:03.195Z',
  stage_reached: 'HANDOFF',
  grade: 'diagnostic',
  criteria_met: false,
  unmet: ['a', 'b', 'c'],
  ...overrides,
});

test('S6: cycleCheck — live, suspended, last-closure fallback, and none', () => {
  const live = cycleCheck(record({}), null);
  assert.equal(live.level, 'ok');
  assert.ok(live.detail.includes('CYCLE-000001 at SCREENED'));
  assert.ok(live.detail.includes('diagnostic'));
  assert.ok(live.detail.includes('lock aaaaaaaaaaaa'));

  const suspended = cycleCheck(record({ stage: 'SUSPENDED', suspended_from: 'RECOGNIZED' }), null);
  assert.equal(suspended.level, 'warn', 'a suspended machine is waiting on an operator');
  assert.ok(suspended.detail.includes('(from RECOGNIZED)'));

  const fallback = cycleCheck(null, closure({}));
  assert.equal(fallback.level, 'info');
  assert.ok(fallback.detail.includes('last CYCLE-000001 closed diagnostic'));
  assert.ok(fallback.detail.includes('§24 unmet, 3 reason(s)'));

  const met = cycleCheck(null, closure({ criteria_met: true, unmet: [] }));
  assert.ok(met.detail.includes('§24 criteria met'));

  const none = cycleCheck(null, null);
  assert.equal(none.level, 'info');
  assert.ok(none.detail.includes('`clue cycle drive`'));
});

/* ========================================================================= */
/* The closer's refusals — registry + a minimal runtime shell                 */
/* ========================================================================= */

function refusalShell(): { orchestrator: CycleOrchestrator; registry: CycleRegistry; dispose(): void; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'clue-close-'));
  mkdirSync(join(root, 'events'), { recursive: true });
  const projections = new ProjectionStore(join(root, 'cycle.db'), { modules: [CYCLE_PROJECTION] });
  const { log } = EventLog.open(join(root, 'events'), { fsyncOnAppend: false });
  const registry = new CycleRegistry({ log, projections, missionVersion: () => 'MISSION-000001' });
  const runtime = {
    log,
    projections,
    requireMission: () => ({ current: () => ({ id: 'MISSION-000001' }) }),
  } as unknown as Runtime;
  return {
    orchestrator: new CycleOrchestrator(runtime),
    registry,
    root,
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

test('closure tail: refusals — none to close, drive-first before SCREENED, suspended is the operator\'s', () => {
  const shell = refusalShell();
  try {
    assert.throws(() => shell.orchestrator.close(), /No cycle in progress to close/);

    const cycle = shell.registry.open();
    assert.throws(
      () => shell.orchestrator.close(),
      /at OPENED — drive it to SCREENED before closing/,
    );

    shell.registry.suspend(cycle.id, 'parked');
    assert.throws(
      () => shell.orchestrator.close(),
      /suspended — resuming is the operator's act, not the closer's/,
    );
  } finally {
    shell.dispose();
    rmSync(shell.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* ========================================================================= */
/* The full arc — a real drive and a real closure on a synthetic target       */
/* ========================================================================= */

const TINY_HARNESS_BODY = [
  "const p = await context.exec([...context.nodeArgv, '-e', 'console.log(42)']);",
  "return { benchmarkVersion: '0.1.0', unifiedScore: null,",
  "  measures: [{ id: 'SIG-001', name: 'probe', scenario: 'SCN-001', native_unit: 'ms',",
  "    aggregation: 'exact', value: p.wallMs > 0 ? p.wallMs : 1, samples: [p.wallMs > 0 ? p.wallMs : 1] }],",
  "  protective: [{ id: 'SIG-005', value: null }, { id: 'SIG-008', value: null },",
  "    { id: 'SIG-012', value: null }, { id: 'SIG-013', value: null }],",
  "  environment: context.environment, incomplete: [] };",
].join('\n');

function tinyContract(body: string): string {
  return [
    'benchmark_id = clu-master',
    'benchmark_version = 0.1.0',
    'runner_adapter = cli-node',
    '',
    '[harness.HRN-001]',
    'runner_adapter = cli-node',
    'scenario_ids = SCN-001',
    'language = javascript',
    `integrity = ${hashText(canonicalHarnessBody(body))}`,
    '--- begin harness ---',
    body,
    '--- end harness ---',
    '',
  ].join('\n');
}

const stubExec: ExecFn = async () => ({ code: 0, stdout: '42\n', stderr: '', wallMs: 5, timedOut: false });

async function performedRunFor(root: string, contractPath: string): Promise<PerformedRun> {
  const prepared = withRuntime({ withLog: false, repoRoot: root }, (runtime) => {
    const registered = resolveContract(runtime.config, undefined, root);
    const contract = { path: contractPath, registered: 'path' in registered && registered.path === contractPath };
    return { contract, subject: prepareBenchmarkRunSubject(runtime, contract) };
  });
  const outcome = await runMasterBenchmark({
    repoRoot: '/nonexistent-repo',
    projectRoot: join(root, 'murugan'),
    workspaceRoot: join(root, 'workspace'),
    contractPath,
    execImpl: stubExec,
    environment: { node_version: 'v22', platform: 'linux', arch: 'x64' },
  });
  return { outcome, ...prepared, log_head_before: null };
}

function writeFullFixture(withBenchmark = false): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-arc-'));
  writeFileSync(join(root, 'CLUE.md'), '# CLUE\n\nThe constitution, for test purposes.\n', 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'clue-arc-fixture', private: true }), 'utf8');

  // The synthetic target: one file, its own tsconfig — recognition in milliseconds.
  mkdirSync(join(root, 'murugan', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'murugan', 'src', 'hello.ts'),
    'export function hello(name: string): string {\n  return `hello ${name}`;\n}\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'murugan', 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext' }, include: ['src'] }, null, 2),
    'utf8',
  );
  writeFileSync(join(root, 'murugan', 'target description.md'), '# intent\n', 'utf8');
  if (withBenchmark) {
    writeFileSync(join(root, 'murugan', 'benchmark.md'), tinyContract(TINY_HARNESS_BODY), 'utf8');
  }
  mkdirSync(join(root, 'config', 'policies'), { recursive: true });
  writeFileSync(join(root, 'config', 'policies', 'patching.yaml'), 'mode: NOTIFY\n', 'utf8');

  const config = {
    version: 2,
    project: {
      id: 'murugan',
      root: join(root, 'murugan'),
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
      inputs: { description: 'target description.md', benchmark: withBenchmark ? 'benchmark.md' : null },
    },
    workspace: { root: join(root, 'workspace') },
    shadow: {
      root: join(root, 'shadow'),
      clone_mode: 'local',
      persistent: true,
      install_on_lockfile_change: true,
      install_command: 'npm ci',
    },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md'] },
    runtime: { package_manager: 'npm', scripts: { typecheck: 'npm run typecheck', build: 'npm run build' } },
    browser: {
      executable: join(root, 'chrome.exe'),
      remote_debugging_port: 9222,
      profile_dir: join(root, 'chrome-profile'),
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
    backup: { remote: 'origin', push_on_verdict: true, push_on_landing: true, max_remote_staleness_hours: 24 },
    security: { canonical_source_writes: 'denied', real_settlement: 'denied', redact_environment: true },
    logging: { level: 'info' },
  };
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'clue.config.yaml'), stringifyYaml(config), 'utf8');
  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(root, 'workspace', directory), { recursive: true });
  }
  return root;
}

function appendClosureVerdict(
  runtime: Runtime,
  input: {
    readonly subjectCycleId: string;
    readonly payloadCycleId?: string;
    readonly disposition: 'ACCEPT' | 'REJECT' | 'REVISE' | 'INVALID';
    readonly improvement?: boolean;
  },
): string {
  const log = runtime.log;
  assert.ok(log !== null);
  const event = log.append({
    type: PROOF_EVENT_TYPES.verdictRecorded,
    actor: 'cli',
    missionVersion: runtime.currentMissionId(),
    subjectId: input.subjectCycleId,
    payload: {
      cycle_id: input.payloadCycleId ?? input.subjectCycleId,
      disposition: input.disposition,
      improvement: input.improvement ?? input.disposition === 'ACCEPT',
    },
  });
  runtime.projections.sync(log);
  return event.id;
}

test('cycle close resumes from HANDOFF without launching the already-recorded benchmark again', async () => {
  const root = writeFullFixture(true);
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.mission?.bootstrap();
      const orchestrator = new CycleOrchestrator(runtime);
      const { cycle, lock } = orchestrator.drive();
      assert.ok(lock?.master_benchmark, 'the CLI must see a locked benchmark');
      const registry = new CycleRegistry({
        log: runtime.requireLog(),
        projections: runtime.projections,
        missionVersion: runtime.currentMissionId,
      });
      const recorded = runtime.artifacts.putJson({
        master_benchmark_run: { benchmark_version: '0.1.0' },
      });
      registry.advance(cycle.id, 'CLOSING_EVIDENCE', recorded);
      registry.advance(cycle.id, 'HANDOFF', null);
    });

    assert.equal(await commandCycleClose(root), 0);
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.equal(new CycleOrchestrator(runtime).status(), null);
      const closed = [...runtime.requireLog().replay()].find(({ type }) => type === CYCLE_EVENT_TYPES.closed);
      assert.ok(closed);
      assert.equal(cycleClosedSchema.parse(closed.payload).criteria_met, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('closure tail: the full arc — drive to SCREENED, close honestly, §24 and the handoff match the lock', () => {
  const root = writeFullFixture();
  try {
    // A mission first: the init equivalent via the mission registry inside a runtime.
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const mission = runtime.mission;
      assert.ok(mission !== null);
      mission.bootstrap();
      return 0;
    });

    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);

      const driven = orchestrator.drive();
      assert.equal(driven.cycle.stage, 'SCREENED');
      assert.equal(driven.cycle.grade, 'diagnostic');
      assert.ok(driven.lock !== null);
      assert.ok(driven.lock.absent.includes('master_benchmark (unregistered)'));
      const stages = driven.performed.map((step) => step.to);
      assert.deepEqual(stages, ['OPENED', 'OPENING_EVIDENCE', 'RECOGNIZED', 'SCREENED']);
      for (const step of driven.performed.slice(1)) {
        assert.ok(step.evidence !== null, `${step.to} carries evidence`);
      }

      const closed = orchestrator.close();
      assert.equal(closed.cycle.stage, 'CLOSED');
      assert.deepEqual(
        closed.performed.map((step) => step.to),
        ['CLOSING_EVIDENCE', 'HANDOFF', 'CLOSED'],
      );

      // §24 read back from the truth, and checked against the lock the cycle declared.
      const log = runtime.log;
      assert.ok(log !== null);
      const closures = [...log.replay()].filter((event) => event.type === CYCLE_EVENT_TYPES.closed);
      assert.equal(closures.length, 1);
      const verdict = cycleClosedSchema.parse(closures[0]?.payload);
      assert.equal(verdict.criteria_met, false);
      assert.equal(verdict.grade, 'diagnostic');
      assert.deepEqual(verdict.unmet, [...verdict.unmet].sort(), '§24 reasons are sorted');
      const lockEvent = [...log.replay()].find(
        (event) => event.type === CYCLE_EVENT_TYPES.inputsLocked,
      );
      assert.ok(lockEvent !== undefined);
      const lock = cycleInputsLockedSchema.parse(lockEvent.payload).lock;
      for (const absence of lock.absent) {
        assert.ok(verdict.unmet.includes(absence), `§24 carries the lock's absence: ${absence}`);
      }
      for (const structural of ['candidate loop', 'closing Master Benchmark run', 'improvement demonstrated']) {
        assert.ok(
          verdict.unmet.some((reason) => reason.includes(structural)),
          `§24 names the structural gap: ${structural}`,
        );
      }

      // The handoff artifact, read back from the store, carries the same lock identity and
      // every stage's evidence ref.
      const handoffStep = closed.performed.find((step) => step.to === 'HANDOFF');
      assert.ok(handoffStep !== undefined && handoffStep.evidence !== null);
      const handoff = nextCycleVitalInputSchema.parse(
        runtime.artifacts.getJson(handoffStep.evidence.hash as never),
      );
      assert.equal(handoff.freshness.lock_digest, lock.digest, '§19.12 freshness is the lock');
      assert.equal(handoff.freshness.mission_version, driven.cycle.mission_version);
      for (const stage of ['OPENING_EVIDENCE', 'RECOGNIZED', 'SCREENED', 'CLOSING_EVIDENCE']) {
        assert.ok(handoff.stage_evidence[stage] != null, `handoff references ${stage}`);
      }
      assert.equal(handoff.accepted_identity.project_id, 'murugan');
      assert.equal(handoff.master_benchmark, null);
      assert.equal(handoff.intent_model_version, null);
      assert.ok(
        handoff.stated_absences.some((entry) => entry.field === 'master_benchmark'),
        'every null has its stated absence',
      );
      assert.ok(
        handoff.stated_absences.some((entry) => entry.field === 'intent_model_version'),
      );
      assert.deepEqual(handoff.unresolved_uncertainty, lock.absent, '§19.8 is the lock\'s absence set');
      assert.deepEqual(handoff.candidate_seeds.seeds, [], 'no seeds without observed evidence');
      assert.equal(handoff.benchmark_maturity, 'absent');

      // Serial release: the machine is free again.
      assert.equal(orchestrator.status(), null);
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* ========================================================================= */
/* P2 ZIP 03 — cycle closure consumes the durable proof derivation            */
/* ========================================================================= */

test('P2-ZIP-03 cycle close: current verdict removes the candidate gap; foreign verdict does not count', () => {
  const root = writeFullFixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      const orchestrator = new CycleOrchestrator(runtime);
      const driven = orchestrator.drive();
      appendClosureVerdict(runtime, { subjectCycleId: 'CYCLE-999999', disposition: 'ACCEPT' });
      appendClosureVerdict(runtime, { subjectCycleId: driven.cycle.id, disposition: 'REJECT' });

      const closed = orchestrator.close();
      const log = runtime.log;
      assert.ok(log !== null);
      const closureEvent = [...log.replay()].reverse().find((event) => event.type === CYCLE_EVENT_TYPES.closed);
      const verdict = cycleClosedSchema.parse(closureEvent?.payload);
      assert.ok(!verdict.unmet.some((reason) => reason.includes('candidate loop')));
      assert.ok(verdict.unmet.some((reason) => /evaluated — 1 verdict\(s\), no ACCEPT/.test(reason)));
      assert.match(closed.performed.at(-1)?.summary ?? '', /1 durable proof verdict\(s\), 0 ACCEPT/);
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('P2-ZIP-03 cycle close: ACCEPT removes both proof-owned §24 gaps', () => {
  const root = writeFullFixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      const orchestrator = new CycleOrchestrator(runtime);
      const driven = orchestrator.drive();
      appendClosureVerdict(runtime, { subjectCycleId: driven.cycle.id, disposition: 'ACCEPT' });

      const closed = orchestrator.close();
      const log = runtime.log;
      assert.ok(log !== null);
      const closureEvent = [...log.replay()].reverse().find((event) => event.type === CYCLE_EVENT_TYPES.closed);
      const verdict = cycleClosedSchema.parse(closureEvent?.payload);
      assert.ok(!verdict.unmet.some((reason) => reason.includes('candidate loop')));
      assert.ok(!verdict.unmet.some((reason) => reason.includes('improvement demonstrated')));
      assert.match(closed.performed.at(-1)?.summary ?? '', /1 durable proof verdict\(s\), 1 ACCEPT/);
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('P2-ZIP-03 cycle close: contradictory verdict blocks before any closing stage advance', () => {
  const root = writeFullFixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      const orchestrator = new CycleOrchestrator(runtime);
      const driven = orchestrator.drive();
      appendClosureVerdict(runtime, {
        subjectCycleId: driven.cycle.id,
        disposition: 'ACCEPT',
        improvement: false,
      });

      assert.throws(
        () => orchestrator.close(),
        /contradictory proof\.verdict_recorded.*ACCEPT requires improvement=true/,
      );
      assert.equal(orchestrator.status()?.stage, 'SCREENED');
      const log = runtime.log;
      assert.ok(log !== null);
      assert.equal(
        [...log.replay()].filter((event) => {
          if (event.type !== CYCLE_EVENT_TYPES.stageAdvanced) return false;
          const payload = event.payload as { to?: unknown };
          return payload.to === 'CLOSING_EVIDENCE';
        }).length,
        0,
        'prevalidation leaves no partial closing evidence',
      );
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* ========================================================================= */
/* B5 — the §18 switch: a real closing run when the lock names the benchmark  */
/* ========================================================================= */

test('B5 arc: the lock names the benchmark, the closing run is recorded, §24 drops the §18 line', async () => {
  const root = writeFullFixture(true);
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const mission = runtime.mission;
      assert.ok(mission !== null);
      mission.bootstrap();
      return 0;
    });

    const performed = await performedRunFor(root, join(root, 'murugan', 'benchmark.md'));
    assert.ok(performed.outcome.ok, performed.outcome.ok ? '' : performed.outcome.reason);

    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      const driven = orchestrator.drive();
      assert.equal(driven.cycle.stage, 'SCREENED');
      assert.ok(driven.lock !== null);
      assert.ok(
        !driven.lock.absent.some((line) => line.includes('master_benchmark')),
        'the lock no longer states the benchmark absent',
      );
      assert.ok(driven.lock.master_benchmark !== null);
      if (performed.outcome.ok) {
        assert.equal(
          performed.outcome.contract.sha256,
          driven.lock.master_benchmark.sha256,
          'the run measured exactly the locked bytes',
        );
      }

      const closed = orchestrator.close(performed);
      assert.equal(closed.cycle.stage, 'CLOSED');
      const closingStep = closed.performed.find((step) => step.to === 'CLOSING_EVIDENCE');
      assert.ok(closingStep !== undefined && closingStep.evidence !== null);
      assert.match(closingStep.summary, /§18 run recorded/);
      assert.match(closingStep.summary, /clu-master@0\.1\.0/);

      // The closing evidence carries the run: identity, its own artifact, and the stated
      // gate/score absence (no opening run this cycle).
      const closing = runtime.artifacts.getJson(closingStep.evidence.hash as never) as {
        master_benchmark_run: {
          benchmark_version: string;
          unified_score: number | null;
          run_artifact: { hash: string };
          gates: null;
          gates_reason: string;
        } | null;
        reason: string | null;
      };
      assert.ok(closing.master_benchmark_run !== null);
      assert.equal(closing.master_benchmark_run.benchmark_version, '0.1.0');
      assert.equal(closing.master_benchmark_run.unified_score, null);
      assert.match(closing.master_benchmark_run.run_artifact.hash, /^[0-9a-f]{64}$/);
      assert.equal(closing.master_benchmark_run.gates, null);
      assert.match(closing.master_benchmark_run.gates_reason, /no opening run/);
      assert.equal(closing.reason, null, 'the diagnostic absence sentence is gone');

      // §24: the §18 line has left the unmet list; the other structural gaps remain.
      const log = runtime.log;
      assert.ok(log !== null);
      const closures = [...log.replay()].filter((event) => event.type === CYCLE_EVENT_TYPES.closed);
      const verdict = cycleClosedSchema.parse(closures[closures.length - 1]?.payload);
      assert.equal(verdict.criteria_met, false, 'still diagnostic — other gaps remain');
      assert.ok(
        !verdict.unmet.some((reason) => reason.includes('closing Master Benchmark run')),
        '§18 is no longer an unmet reason',
      );
      for (const structural of ['candidate loop', 'improvement demonstrated']) {
        assert.ok(verdict.unmet.some((reason) => reason.includes(structural)));
      }

      // §19.2 stops being an absence: version + closing-run hash, maturity graduates.
      const handoffStep = closed.performed.find((step) => step.to === 'HANDOFF');
      assert.ok(handoffStep !== undefined && handoffStep.evidence !== null);
      const handoff = nextCycleVitalInputSchema.parse(
        runtime.artifacts.getJson(handoffStep.evidence.hash as never),
      );
      assert.deepEqual(handoff.master_benchmark, {
        version: '0.1.0',
        closing_run: closing.master_benchmark_run.run_artifact.hash,
      });
      assert.equal(handoff.benchmark_maturity, 'locked');
      assert.ok(
        !handoff.stated_absences.some((entry) => entry.field === 'master_benchmark'),
        'the §19.2 absence row is gone',
      );
      assert.ok(
        handoff.stated_absences.some((entry) => entry.field === 'master_benchmark.opening_run'),
        'the remaining gap — no opening run — is stated by name',
      );
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('B5 refusals: run required when locked; a lock-less run refused; a moved world refused', async () => {
  // (1) The lock names a benchmark and no run is supplied → the closer demands it, naming
  //     the unlocked-inversion path.
  const withBench = writeFullFixture(true);
  try {
    withRuntime({ withLog: true, repoRoot: withBench }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      new CycleOrchestrator(runtime).drive();
      return 0;
    });
    withRuntime({ withLog: true, repoRoot: withBench }, (runtime) => {
      assert.throws(
        () => new CycleOrchestrator(runtime).close(null),
        /§18's closing run is required[\s\S]*UNLOCKED/,
      );
      return 0;
    });

    // (3) A run over different bytes than the lock's → the moved-world refusal, before
    //     anything is recorded.
    const otherPath = join(withBench, 'murugan', 'benchmark-other.md');
    writeFileSync(otherPath, tinyContract(TINY_HARNESS_BODY + '\n// moved'), 'utf8');
    const drifted = await performedRunFor(withBench, otherPath);
    assert.ok(drifted.outcome.ok);
    withRuntime({ withLog: true, repoRoot: withBench }, (runtime) => {
      assert.throws(
        () => new CycleOrchestrator(runtime).close(drifted),
        /different contract than this cycle locked[\s\S]*moved world/,
      );
      return 0;
    });
  } finally {
    rmSync(withBench, { recursive: true, force: true, maxRetries: 3 });
  }

  // (2) The lock names none and a run is supplied anyway → refused by name.
  const withoutBench = writeFullFixture(false);
  try {
    withRuntime({ withLog: true, repoRoot: withoutBench }, (runtime) => {
      assert.ok(runtime.mission !== null);
      runtime.mission.bootstrap();
      new CycleOrchestrator(runtime).drive();
      return 0;
    });
    const stray = await performedRunFor(
      withoutBench,
      (() => {
        const path = join(withoutBench, 'murugan', 'stray.md');
        writeFileSync(path, tinyContract(TINY_HARNESS_BODY), 'utf8');
        return path;
      })(),
    );
    assert.ok(stray.outcome.ok);
    withRuntime({ withLog: true, repoRoot: withoutBench }, (runtime) => {
      assert.throws(
        () => new CycleOrchestrator(runtime).close(stray),
        /lock names no Master Benchmark/,
      );
      return 0;
    });
  } finally {
    rmSync(withoutBench, { recursive: true, force: true, maxRetries: 3 });
  }
});
