/**
 * Durability-cadence acceptance tests for the writable runtime.
 *
 * Spec: CLUE_Project_Directory_v9.md §8 — `runtime.ts` composes read-only, maintenance,
 *       analysis, experiment, and landing runtimes; §9 — the event log is the sole durable
 *       authority and SQLite must be reproducible from it.
 *       CLUE_Architecture_v9.md — crash recovery and the durable trust anchor.
 *
 * Backlog: DEV-P1-01 follow-up — the event log's checkpoint mechanism was implemented and
 *          proven, but every production open used the library default of 0, so no
 *          checkpoint was ever written and the "committed head behind the checkpoint is
 *          refused as lost history" guarantee had nothing to compare against. These prove
 *          the anchor is now written by an ordinary writable runtime, and that
 *          `maintainLog()` was a seam for a daemon loop, and it was deleted rather than kept:
 *          the dashboard holds no writer lock and the only writer, `clue recognize`, is
 *          synchronous, so no timer could ever have called it. It had tests, which made it
 *          look more finished than it was. The checkpoint cadence below is the half of that
 *          turn that fixed something real — a guarantee that was switched off in production —
 *          and it stays.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as toYaml } from 'yaml';

import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { MissionRegistry } from '../src/control/mission.js';
import {
  CHECKPOINT_EVERY_APPENDS,
  loadConfig,
  openRuntime,
  resolveConfigPaths,
  type Runtime,
} from '../src/control/runtime.js';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-runtime-cadence-'));
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

const checkpointPath = (root: string): string => join(root, 'workspace', 'events', 'checkpoint.json');

test('DEV-P1-01: a writable runtime writes the durable checkpoint anchor', () => {
  const root = makeRepo();
  try {
    bootstrap(root);
    // Bootstrap opened the log directly with library defaults, so no anchor exists yet —
    // which is exactly the production state this item found.
    assert.equal(existsSync(checkpointPath(root)), false, 'no anchor before a runtime opens');

    const runtime: Runtime = openRuntime({ withLog: true, repoRoot: root });
    try {
      // A modest cadence, chosen so the test drives the real threshold rather than a
      // special one: the constant is the production value.
      assert.equal(CHECKPOINT_EVERY_APPENDS, 250);
      const log = runtime.requireLog();
      for (let index = 0; index < CHECKPOINT_EVERY_APPENDS; index += 1) {
        log.append({
          type: 'task.created',
          actor: 'daemon',
          missionVersion: runtime.currentMissionId(),
          subjectId: `TASK-${String(index + 1).padStart(6, '0')}`,
          payload: { index },
        });
      }
    } finally {
      runtime.dispose();
    }

    assert.ok(existsSync(checkpointPath(root)), 'the anchor is written once the cadence is reached');
    const anchor = JSON.parse(readFileSync(checkpointPath(root), 'utf8')) as Record<string, unknown>;
    const head = anchor['head'] as Record<string, unknown> | null;
    assert.ok(head !== null && typeof head['sequence'] === 'number');
    assert.ok((anchor['records'] as number) >= CHECKPOINT_EVERY_APPENDS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-01: the anchor makes lost history refusable, which was its whole purpose', () => {
  const root = makeRepo();
  try {
    bootstrap(root);
    const runtime: Runtime = openRuntime({ withLog: true, repoRoot: root });
    try {
      const log = runtime.requireLog();
      for (let index = 0; index < CHECKPOINT_EVERY_APPENDS; index += 1) {
        log.append({
          type: 'task.created',
          actor: 'daemon',
          missionVersion: runtime.currentMissionId(),
          subjectId: `TASK-${String(index + 1).padStart(6, '0')}`,
          payload: { index },
        });
      }
    } finally {
      runtime.dispose();
    }

    // Truncate committed history behind the sealed anchor — the loss the guarantee exists
    // to catch. Without an anchor on disk this reopens silently and happily.
    const eventsFile = join(root, 'workspace', 'events', 'events.ndjson');
    const lines = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean);
    writeFileSync(eventsFile, `${lines.slice(0, 10).join('\n')}\n`, 'utf8');

    assert.throws(
      () => openRuntime({ withLog: true, repoRoot: root }).dispose(),
      /checkpoint|lost|behind/i,
      'a committed head behind the durable checkpoint is refused, not accepted',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

