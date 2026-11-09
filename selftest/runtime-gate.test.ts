/**
 * DEV-P0-07 / DEV-P0-10 — the writable runtime gate rechecks mission-basis drift and projection
 * freshness at command entry.
 *
 * `withRuntime({ requireMission: true })` now calls `requireCurrentBasis()` (not merely
 * `requireCurrent()`) and `requireFreshProjections()` before the command body runs. This drives the
 * real runtime: a gated command passes under a matching mission, is refused once a governed document
 * drifts, and is refused once the log advances past the projections.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as toYaml } from 'yaml';

import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { MissionRegistry } from '../src/control/mission.js';
import { withRuntime, loadConfig, rehearseProjectionRebuild, resolveConfigPaths, type Runtime } from '../src/control/runtime.js';
import { hashBytes } from '../src/shared/ids.js';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-runtime-gate-'));
  writeFileSync(join(root, 'CLUE.md'), '# CLUE\n\nconstitution\n', 'utf8');
  writeFileSync(join(root, 'CLUE_implementation.md'), '# impl\n\narchitecture\n', 'utf8');
  writeFileSync(join(root, 'CLUE_Implementation_Strategy.md'), '# strategy\n\nplan\n', 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'clue', lockfileVersion: 3, packages: {} }), 'utf8');
  mkdirSync(join(root, 'murugan', 'src'), { recursive: true });

  const config = {
    version: 2,
    project: { id: 'murugan', root: join(root, 'murugan'), main_branch: 'main', source_roots: ['src'], document_roots: ['.'], exclude: ['node_modules'] },
    workspace: { root: join(root, 'workspace') },
    shadow: { root: join(root, 'shadow'), clone_mode: 'local', persistent: true, install_on_lockfile_change: true, install_command: 'npm ci' },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md', 'CLUE_implementation.md', 'CLUE_Implementation_Strategy.md'] },
    runtime: { package_manager: 'npm', scripts: { typecheck: 'npm run typecheck', build: 'npm run build' } },
    browser: { executable: join(root, 'chrome.exe'), remote_debugging_port: 9222, profile_dir: join(root, 'chrome-profile'), allowed_origins: ['http://localhost:*'], require_webgpu: true },
    powershell: { executable: 'pwsh.exe', autonomous_profile: 'restricted' },
    analysis: { max_context_tokens: 120000, reserve_output_tokens: 20000, dynamic_edge_confidence_threshold: 0.75, monodependency_percentile: 0.35 },
    proof: { require_frozen_contract: true, inconclusive_counts_as_improvement: false, require_baseline: true, require_guardrails: true },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: { mode: 'NOTIFY', policy_file: 'config/policies/patching.yaml', landing_branch_prefix: 'clue/accepted/', merge_strategy: 'fast_forward_only', post_land_verify: ['typecheck'], auto_revert_on_post_land_failure: true },
    notifications: { status_document: true, windows_toast: false, webhook_url_env: null },
    gateway: { enabled: false, provider: 'openai', api_key_env: 'OPENAI_API_KEY', default_mode: 'batch', batch_poll_interval_seconds: 300, prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] }, budget_policy_file: 'config/policies/budget.yaml', routing_file: 'config/policies/routing.yaml' },
    backup: { remote: 'origin', push_on_verdict: true, push_on_landing: true, max_remote_staleness_hours: 24 },
    security: { canonical_source_writes: 'denied', real_settlement: 'denied', redact_environment: true },
    logging: { level: 'info' },
  };
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'clue.config.yaml'), toYaml(config), 'utf8');
  for (const d of ['db', 'events', 'blobs', 'logs']) mkdirSync(join(root, 'workspace', d), { recursive: true });
  return root;
}

// Bootstrap a mission into the shared workspace, then release the handles so the runtime can reopen it.
function bootstrap(root: string): void {
  const config = resolveConfigPaths(loadConfig(root), root);
  const ws = config.workspace.root;
  const projections = new ProjectionStore(join(ws, 'db', 'clue.db'));
  const artifacts = new ArtifactStore(join(ws, 'blobs'));
  const { log } = EventLog.open(join(ws, 'events'));
  const mission = new MissionRegistry({ repoRoot: root, config, log, projections, artifacts });
  mission.bootstrap();
  log.close();
  projections.close();
}

test('a benchmark rebuild replays a fresh scratch database without changing live database or WAL bytes', () => {
  const root = makeRepo();
  try {
    bootstrap(root);
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      const db = join(runtime.workspaceRoot, 'db', 'clue.db');
      const events = join(runtime.workspaceRoot, 'events', 'events.ndjson');
      runtime.audit.record({
        actor: 'daemon', command: 'test.scratch-rebuild', capability: 'fs.read.workspace',
        decision: 'allowed', missionVersion: runtime.currentMissionId(),
      });
      assert.ok(existsSync(db + '-wal'), 'exercise a real live WAL copy');
      const paths = [db, db + '-wal', db + '-shm', events, events + '.lock', join(runtime.workspaceRoot, 'logs', 'audit.ndjson')];
      const captureHashes = () => paths.map((path) => existsSync(path) ? hashBytes(readFileSync(path)) : null);
      const projection = runtime.projections.status();
      const original = captureHashes();
      const result = rehearseProjectionRebuild({ repoRoot: root });
      assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
      assert.equal(result.eventHead, projection.headHash);
      assert.equal(result.eventCount, projection.indexedEvents);
      assert.match(result.factsDigest, /^[a-f0-9]{64}$/u);
      assert.deepEqual(captureHashes(), original);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a benchmark rebuild refuses stale live projections without changing their bytes', () => {
  const root = makeRepo();
  try {
    bootstrap(root);
    withRuntime({ withLog: true, repoRoot: root }, () => undefined);
    const { log } = EventLog.open(join(root, 'workspace', 'events'));
    try {
      log.append({ type: 'test.unprojected', actor: 'daemon', missionVersion: 'MISSION-000001', payload: {} });
    } finally {
      log.close();
    }
    const path = join(root, 'workspace', 'db', 'clue.db');
    const original = readFileSync(path);
    assert.throws(() => rehearseProjectionRebuild({ repoRoot: root }), /do not match the pinned event head/u);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(existsSync(path + '-wal'), false);
    assert.equal(existsSync(path + '-shm'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a gated command passes under a matching mission and is refused once a governed document drifts', () => {
  const root = makeRepo();
  try {
    bootstrap(root);

    // Under a matching mission the gate passes and the command body runs.
    const missionId = withRuntime({ withLog: true, requireMission: true, repoRoot: root }, (runtime: Runtime) =>
      runtime.requireMission().current()?.id ?? null,
    );
    assert.ok(missionId !== null, 'the gated command ran under the committed mission');

    // Drift a tracked document without registering a successor.
    writeFileSync(join(root, 'CLUE.md'), '# CLUE\n\nconstitution (drifted)\n', 'utf8');
    assert.throws(
      () => withRuntime({ withLog: true, requireMission: true, repoRoot: root }, () => 'body ran'),
      /drift|successor|MissionDrift/i,
      'the gated command is refused once the governed input drifts',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a gated command is refused once the log advances past the projections', () => {
  const root = makeRepo();
  try {
    bootstrap(root);

    // Advance the event log out of band, leaving the projections behind.
    const { log } = EventLog.open(join(root, 'workspace', 'events'));
    log.append({ type: 'task.created', actor: 'daemon', missionVersion: 'MISSION-000001', subjectId: 'TASK-000777', payload: { note: 'external' } });
    log.close();

    assert.throws(
      () => withRuntime({ withLog: true, requireMission: true, repoRoot: root }, () => 'body ran'),
      /stale|PROJECTIONS_STALE|lag|diverge/i,
      'the freshness gate refuses a runtime whose projections lag the log',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-07: a gated command is refused when no mission is registered', () => {
  const root = makeRepo();
  try {
    // No bootstrap: the workspace has no committed mission. A gated (evidence-producing) command —
    // as `clue metrics` now is — must be refused rather than produce evidence attributable to nothing.
    assert.throws(
      () => withRuntime({ withLog: true, requireMission: true, repoRoot: root }, () => 'body ran'),
      /mission|not registered|MISSION_REQUIRED/i,
      'the gate refuses evidence production without a mission',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-10: a second writable runtime is refused while the writer lock is held', () => {
  const root = makeRepo();
  try {
    bootstrap(root);
    // Hold the writer by keeping the outer writable runtime open across the inner attempt.
    withRuntime({ withLog: true, repoRoot: root }, () => {
      assert.throws(
        () => withRuntime({ withLog: true, repoRoot: root }, () => 'inner body ran'),
        /LOG_LOCKED|writer|held/i,
        'the second writable runtime is refused; its body never begins',
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-10: a withLog:false observer opens the store read-only — no mutable observer path', () => {
  const root = makeRepo();
  try {
    bootstrap(root); // registers a mission

    // A writable runtime installs every projection module's schema into the workspace DB. Open one first
    // so the observer has a fully-initialised store to attach to — a read-only store installs nothing and
    // requires the tables to already exist. Holding the writer, not the option name, is what gates writability.
    withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
      assert.equal(runtime.readOnly, false, 'a runtime holding the writer is writable');
    });

    // An observer opened without the writer reports read-only and cannot mutate durable state directly —
    // the registries already refuse log writes; this proves the store behind them refuses writes too.
    withRuntime({ withLog: false, repoRoot: root }, (runtime) => {
      assert.equal(runtime.readOnly, true, 'a withLog:false runtime is read-only, like an explicit attach');
      assert.throws(
        () =>
          runtime.projections.db
            .prepare('INSERT INTO snapshots (id, manifest_hash, file_count, total_bytes, skipped_count) VALUES (?, ?, ?, ?, ?)')
            .run('probe', 'h'.repeat(64), 0, 0, 0),
        /readonly|read-only/i,
        'a direct projection write through an observer is refused (the store is opened read-only)',
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
