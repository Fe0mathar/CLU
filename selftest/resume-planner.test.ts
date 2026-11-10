/**
 * Resume-planner acceptance (Execution Model §21.2; DEV-P2-08 deferred slice, delivered
 * 2026-08-10).
 *
 * Built on the closure suite's full fixture — real runtime, real services — because
 * §21.2 is a checklist over real verifiers and a mocked one would pin nothing. The pins:
 *
 * - a clean suspended cycle **resumes with a receipt**: the resumed event's verification
 *   ref resolves in the store to a passing report whose named non-checks state §21.2's
 *   remaining items and why they are elsewhere's business;
 * - **a changed world refuses with §21.3 named**: deleting a locked policy file after
 *   suspension flips the lock digest, and the refusal quotes both digests and prescribes
 *   restart-with-new-lock rather than a forced resume;
 * - **a moved mission refuses with §21.4 named**: a successor mission in force means the
 *   cycle's authority moved beneath it, and the refusal names both versions;
 * - a refused resume still **writes its receipt** — the failure is as documented as a
 *   success, and the suspended cycle is untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

import { withRuntime } from '../src/control/runtime.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { CYCLE_EVENT_TYPES, CycleRegistry } from '../src/cycle/cycleRegistry.js';
import { makeEntityId, nowIso } from '../src/shared/ids.js';
import { cycleResumedSchema } from '../src/shared/schemas.js';
import type { ResumeVerification } from '../src/cycle/resumePlanner.js';

function writeFixture(parent = tmpdir()): string {
  const root = mkdtempSync(join(parent, 'clue-resume-'));
  writeFileSync(join(root, 'CLUE.md'), '# CLUE\n\nThe constitution, for test purposes.\n', 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'clue-resume-fixture', private: true }), 'utf8');
  mkdirSync(join(root, 'murugan', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'murugan', 'src', 'hello.ts'),
    'export const answer = 42;\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'murugan', 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }, null, 2),
    'utf8',
  );
  writeFileSync(join(root, 'murugan', 'target description.md'), '# intent\n', 'utf8');
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
      inputs: { description: 'target description.md', benchmark: null },
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

test('§21.2: a clean resume verifies, and the resumed event carries a passing receipt', () => {
  const root = writeFixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.mission?.bootstrap();
      return 0;
    });
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      orchestrator.drive();
      orchestrator.suspend('operator break');
      const resumed = orchestrator.resume();
      assert.equal(resumed.stage, 'SCREENED');

      const log = runtime.log;
      assert.ok(log !== null);
      const event = [...log.replay()].filter((entry) => entry.type === CYCLE_EVENT_TYPES.resumed).pop();
      assert.ok(event !== undefined);
      const payload = cycleResumedSchema.parse(event.payload);
      assert.ok(payload.verification !== null, 'the stated absence is closed');
      const receipt = runtime.artifacts.getJson(payload.verification.hash as never) as ResumeVerification;
      assert.equal(receipt.ok, true);
      assert.deepEqual(
        receipt.checks.map((check) => [check.name, check.ok]),
        [['mission', true], ['lock', true], ['projections', true], ['log', true], ['artifacts', true]],
      );
      assert.deepEqual(
        receipt.notChecked.map((entry) => entry.name),
        ['task leases', 'repository state', 'tool health'],
        "§21.2's remaining items are stated, with their reasons, not silently narrowed",
      );
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('§21.2: a changed world refuses at the right layer — basis drift outranks, lock-only changes reach the planner', () => {
  const root = writeFixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.mission?.bootstrap();
      return 0;
    });
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      orchestrator.drive();
      orchestrator.suspend('before the world moves');

      // Layer 1 — a policy file is part of the MISSION BASIS, so deleting it trips the
      // outer gate before the planner can speak: measured behaviour, the stronger guard.
      rmSync(join(root, 'config', 'policies', 'patching.yaml'));
      assert.throws(() => orchestrator.resume(), /Register a successor before producing evidence/);
      writeFileSync(join(root, 'config', 'policies', 'patching.yaml'), 'mode: NOTIFY\n', 'utf8');

      // Layer 2 — a lock-only change: the adapters directory is lock-visible (a structural
      // absence disappears) but basis-invisible, so the planner's own check is the one
      // that fires, with §21.3 as the prescription.
      mkdirSync(join(root, 'src', 'analysis', 'environments'), { recursive: true });

      let receiptPrefix = '';
      assert.throws(
        () => orchestrator.resume(),
        (error: unknown) => {
          if (!(error instanceof Error)) return false;
          const match = error.message.match(/receipt ([0-9a-f]{12})/);
          receiptPrefix = match?.[1] ?? '';
          return (
            error.message.includes('§21.2 verification failed') &&
            error.message.includes('lock:') &&
            error.message.includes('§21.3: restart with a new identity and a new lock') &&
            receiptPrefix.length === 12
          );
        },
      );
      assert.equal(orchestrator.status()?.stage, 'SUSPENDED', 'the refusal changed nothing');

      // The failure is as documented as a success: the quoted receipt exists in the store.
      assert.ok(
        runtime.artifacts.manifest().some((entry) => entry.hash.startsWith(receiptPrefix)),
        'the refused verification wrote its receipt',
      );
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('§21.2: a successor mission refuses the resume and names §21.4', () => {
  const root = writeFixture();
  try {
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.mission?.bootstrap();
      return 0;
    });
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      new CycleOrchestrator(runtime).drive();
      new CycleOrchestrator(runtime).suspend('before the authority moves');
      return 0;
    });
    // The authority moves: the constitution changes, and re-running bootstrap registers
    // the successor — the same path `clue init` takes on a moved basis.
    writeFileSync(join(root, 'CLUE.md'), '# CLUE\n\nAmended for the fork test.\n', 'utf8');
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.mission?.bootstrap();
      return 0;
    });
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.throws(
        () => new CycleOrchestrator(runtime).resume(),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('mission:') &&
          error.message.includes('§21.4') &&
          error.message.includes('§21.3'),
      );
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('verified drive continues the same OPENED cycle and leaves suspension to the operator', () => {
  const root = writeFixture();
  try {
    const opened = withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.mission?.bootstrap();
      const mission = runtime.requireMission();
      const missionId = mission.requireCurrent().id;
      assert.ok(runtime.log);
      return new CycleRegistry({
        log: runtime.log,
        projections: runtime.projections,
        missionVersion: () => missionId,
      }).open();
    });
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      const suspended = orchestrator.suspend('operator paused before locking');
      assert.equal(suspended.suspended_from, 'OPENED');
      assert.throws(() => orchestrator.drive(null, { verifyRecovery: true }), /is suspended/);
      const resumed = orchestrator.resume();
      assert.equal(resumed.id, opened.id);
      assert.equal(resumed.stage, 'OPENED');
      const driven = orchestrator.drive(null, { verifyRecovery: true });
      assert.equal(driven.cycle.id, opened.id);
      assert.equal(driven.cycle.stage, 'SCREENED');
      assert.deepEqual(driven.performed.map((step) => step.to), [
        'INPUTS_LOCKED', 'OPENING_EVIDENCE', 'RECOGNIZED', 'SCREENED',
      ]);
      orchestrator.suspend('operator break');
      assert.throws(() => orchestrator.drive(null, { verifyRecovery: true }), /is suspended/);
      assert.equal(orchestrator.status()?.stage, 'SUSPENDED');
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('verified drive refuses source drift at the opening checkpoint and screens its own graph', (t) => {
  const root = writeFixture();
  try {
    const advance = CycleRegistry.prototype.advance;
    const opening = t.mock.method(CycleRegistry.prototype, 'advance', function (
      this: CycleRegistry,
      ...args: Parameters<CycleRegistry['advance']>
    ) {
      const cycle = advance.apply(this, args);
      if (cycle.stage === 'OPENING_EVIDENCE') throw new Error('simulated interruption after opening evidence');
      return cycle;
    });
    const cycleId = withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.mission?.bootstrap();
      const orchestrator = new CycleOrchestrator(runtime);
      assert.throws(() => orchestrator.drive(null, { verifyRecovery: true }), /simulated interruption/);
      const cycle = orchestrator.status();
      assert.equal(cycle?.stage, 'OPENING_EVIDENCE');
      return cycle.id;
    });
    opening.mock.restore();

    const source = join(root, 'murugan', 'src', 'hello.ts');
    writeFileSync(source, 'export const answer = 1;\n', 'utf8');
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      assert.throws(
        () => orchestrator.drive(null, { verifyRecovery: true }),
        /Recovery refused .* at OPENING_EVIDENCE: source changed since opening evidence/,
      );
      assert.equal(orchestrator.status()?.stage, 'OPENING_EVIDENCE');
      return 0;
    });
    writeFileSync(source, 'export const answer = 42;\n', 'utf8');

    const recognized = t.mock.method(CycleRegistry.prototype, 'advance', function (
      this: CycleRegistry,
      ...args: Parameters<CycleRegistry['advance']>
    ) {
      const cycle = advance.apply(this, args);
      if (cycle.stage === 'RECOGNIZED') throw new Error('simulated interruption after recognition');
      return cycle;
    });
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      assert.throws(() => orchestrator.drive(null, { verifyRecovery: true }), /simulated interruption/);
      assert.equal(orchestrator.status()?.stage, 'RECOGNIZED');
      return 0;
    });
    recognized.mock.restore();

    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const orchestrator = new CycleOrchestrator(runtime);
      assert.ok(runtime.snapshots);
      writeFileSync(source, 'export const answer = 1;\n', 'utf8');
      const unrelated = runtime.snapshots.capture({
        origin: 'canonical', root: join(root, 'murugan'), sourceRoots: ['src'],
      });
      assert.equal(runtime.snapshots.latest('canonical')?.id, unrelated.record.id);
      writeFileSync(source, 'export const answer = 42;\n', 'utf8');

      const driven = orchestrator.drive(null, { verifyRecovery: true });
      assert.equal(driven.cycle.id, cycleId);
      assert.equal(driven.cycle.stage, 'SCREENED');
      assert.deepEqual(driven.performed.map((step) => step.to), ['SCREENED']);
      return 0;
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('guarded CLI catches up a valid stale projection and refuses a divergent anchor', () => {
  // The CLI resolves its installation relative to its executable. Keep the fixture below the
  // test installation so the copied CLI resolves the same dependencies without a symlink.
  const root = writeFixture(fileURLToPath(new URL('..', import.meta.url)));
  try {
    cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(root, 'dist', 'src'), { recursive: true });
    const run = (...args: string[]) => spawnSync(process.execPath, [
      join(root, 'dist', 'src', 'cli', 'index.js'), 'cycle', 'drive', ...args,
    ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    const cycleId = makeEntityId('cycle', 1);
    const oldHead = withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.mission?.bootstrap();
      const missionVersion = runtime.requireMission().requireCurrent().id;
      assert.ok(runtime.log);
      const projected = runtime.projections.status();
      assert.ok(projected.headHash);
      // Simulate an interruption after the event commits and before projections sync.
      runtime.log.append({
        type: CYCLE_EVENT_TYPES.opened, actor: 'daemon', missionVersion, subjectId: cycleId,
        payload: { cycle_id: cycleId, mission_version: missionVersion, opened_by: 'daemon', opened_at: nowIso() },
      });
      return projected.headHash;
    });

    const ordinary = run();
    assert.equal(ordinary.status, 1, ordinary.stdout + ordinary.stderr);
    assert.match(ordinary.stdout, /Projections lag or diverge/);
    const wrongBinding = run('--verify-recovery', '--expect-runtime', 'f'.repeat(64));
    assert.equal(wrongBinding.status, 1, wrongBinding.stdout + wrongBinding.stderr);
    assert.match(wrongBinding.stdout, /Active project or workspace changed/);

    const divergentHead = '0'.repeat(64);
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.equal(runtime.projections.status().headHash, oldHead);
      assert.equal(new CycleOrchestrator(runtime).status(), null);
      runtime.projections.db.prepare("UPDATE projection_state SET value = ? WHERE key = 'head_hash'").run(divergentHead);
    });
    const divergent = run('--verify-recovery');
    assert.equal(divergent.status, 1, divergent.stdout + divergent.stderr);
    assert.match(divergent.stdout, /History was rewritten/);
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.equal(runtime.projections.status().headHash, divergentHead);
      assert.equal(new CycleOrchestrator(runtime).status(), null);
      runtime.projections.db.prepare("UPDATE projection_state SET value = ? WHERE key = 'head_hash'").run(oldHead);
    });

    const recovered = run('--verify-recovery');
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.match(recovered.stdout, new RegExp(`Cycle ${cycleId} at SCREENED`));
    assert.match(recovered.stdout, /"eventAppends":\{"count":[1-9]/);
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      runtime.requireFreshProjections();
      const cycle = new CycleOrchestrator(runtime).status();
      assert.equal(cycle?.id, cycleId);
      assert.equal(cycle.stage, 'SCREENED');
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
