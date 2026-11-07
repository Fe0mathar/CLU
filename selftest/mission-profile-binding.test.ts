/** PP-15 — mission and AI context bind the exact Project Profile authority generation. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { MissionRegistry } from '../src/control/mission.js';
import { ContextBuilder } from '../src/control/contextBuilder.js';
import { computeInputLock } from '../src/cycle/cycleInputLock.js';
import { resolveProjectRuntimeBinding } from '../src/control/projectProfiles/projectRuntimeBinding.js';
import { ProjectAuthorityError } from '../src/control/projectProfiles/projectAuthority.js';
import { clueConfigSchema, type ClueConfig } from '../src/shared/schemas.js';
import type { TaskRecord } from '../src/control/tasks.js';
import type { Sha256 } from '../src/shared/ids.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';
import { proofReadyProfile, recordForProfile } from './project-governance-fixture.js';

const H = (char: string): Sha256 => char.repeat(64).slice(0, 64) as Sha256;
const AT = '2026-08-14T16:00:00.000Z';

function installationConfig(root: string, target: string, workspace: string, shadow: string): ClueConfig {
  for (const name of ['CLUE.md', 'CLUE_implementation.md', 'CLUE_Implementation_Strategy.md']) {
    writeFileSync(join(root, name), `# ${name}\nGoverned fixture.\n`, 'utf8');
  }
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'clue', lockfileVersion: 3, packages: {} }), 'utf8');
  mkdirSync(join(root, 'browser-installation'), { recursive: true });
  return clueConfigSchema.parse({
    version: 2,
    project: {
      id: 'legacy',
      root: target,
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules', 'dist'],
      remote: null,
      credential_env: null,
      remote_decision: { state: 'UNRECORDED' },
      inputs: { description: null, benchmark: null },
      active_target: null,
    },
    workspace: { root: workspace },
    shadow: { root: shadow, clone_mode: 'local', persistent: true, install_on_lockfile_change: true, install_command: 'npm ci' },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md', 'CLUE_implementation.md', 'CLUE_Implementation_Strategy.md'] },
    runtime: { package_manager: 'npm', scripts: { typecheck: 'npm run typecheck', build: 'npm run build' } },
    browser: { executable: process.execPath, remote_debugging_port: 9222, profile_dir: join(root, 'browser-installation'), allowed_origins: ['http://127.0.0.1:*'], require_webgpu: false },
    powershell: { executable: process.execPath, autonomous_profile: 'restricted' },
    analysis: { max_context_tokens: 120000, reserve_output_tokens: 20000, dynamic_edge_confidence_threshold: 0.75, monodependency_percentile: 0.35 },
    proof: { require_frozen_contract: true, inconclusive_counts_as_improvement: false, require_baseline: true, require_guardrails: true },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: { mode: 'OUTBOX', policy_file: 'config/policies/patching.yaml', landing_branch_prefix: 'clue/accepted/', merge_strategy: 'fast_forward_only', post_land_verify: ['typecheck'], auto_revert_on_post_land_failure: true },
    notifications: { status_document: false, windows_toast: false, webhook_url_env: null },
    gateway: { enabled: false, provider: 'openai', api_key_env: 'OPENAI_API_KEY', default_mode: 'interactive', batch_poll_interval_seconds: 300, prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] }, budget_policy_file: 'config/policies/budget.yaml', routing_file: 'config/policies/routing.yaml' },
    backup: { remote: 'origin', push_on_verdict: true, push_on_landing: true, max_remote_staleness_hours: 24 },
    security: { canonical_source_writes: 'denied', real_settlement: 'denied', redact_environment: true },
    logging: { level: 'info' },
  });
}

function task(missionVersion: string): TaskRecord {
  return {
    id: 'TASK-000001',
    signature: H('1'),
    type: 'DOC_EXTRACT',
    lane: 'extraction',
    lane_weight: 1,
    priority: 0.5,
    state: 'pending',
    parent_id: null,
    subject_id: 'project-authority',
    snapshot_id: null,
    mission_version: missionVersion,
    input_hash: H('2'),
    output_hash: null,
    budget: 1,
    spent: 0,
    attempts: 0,
    max_attempts: 3,
    failed_attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    available_at: AT,
    created_at: AT,
    updated_at: AT,
    terminal_reason: null,
  };
}

test('PP-15: mission stores exact authority bytes and ContextBuilder exposes them as essential policy', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  mkdirSync(join(fixture.target, 'src'), { recursive: true });
  const profile = proofReadyProfile(fixture);
  const record = recordForProfile(fixture, profile);
  const base = installationConfig(fixture.root, fixture.target, fixture.workspace, fixture.shadow);
  const binding = resolveProjectRuntimeBinding(base, record);

  const projections = new ProjectionStore(join(fixture.workspace, 'db', 'mission-profile.db'));
  const artifacts = new ArtifactStore(join(fixture.workspace, 'blobs'));
  const { log } = EventLog.open(join(fixture.workspace, 'events'));
  t.after(() => {
    log.close();
    projections.close();
  });
  const mission = new MissionRegistry({
    repoRoot: fixture.root,
    config: binding.config,
    log,
    projections,
    artifacts,
    projectBinding: binding,
  });
  const registered = mission.bootstrap().mission;
  const basis = mission.basis();
  assert.match(basis.projectGovernanceBasisHash ?? '', /^[0-9a-f]{64}$/);
  assert.ok(registered.documents.some((document) => document.path === fixture.targetDescription));
  assert.ok(registered.documents.some((document) => document.path === fixture.masterBenchmark));
  assert.ok(registered.documents.some((document) => document.path === 'clue-basis://project-governance'));

  const authority = mission.projectAuthorityContext(registered.id);
  assert.ok(authority !== null);
  assert.equal(authority?.basis.operationIdentity.projectId, 'alpha');
  assert.deepEqual(authority?.documents.map((document) => document.binding.kind), [
    'target-description',
    'master-benchmark',
  ]);

  const context = new ContextBuilder({ projectRoot: fixture.target, mission }).build(task(registered.id), {
    directive: 'Extract the exact active project authority.',
    outputSchemaName: 'fixture-output',
  });
  assert.equal(context.fits, true);
  const section = context.sections.find((candidate) => candidate.id === 'project-authority');
  assert.ok(section !== undefined);
  assert.match(section?.body ?? '', /Project: alpha/);
  assert.match(section?.body ?? '', /Target description\./u);
  assert.match(section?.body ?? '', /benchmark_id = fixture-master/);

  const lock = computeInputLock({
    repoRoot: fixture.root,
    config: binding.config,
    mission: registered,
    ratification: null,
    epoch: null,
    projectBinding: binding,
  });
  assert.equal(lock.project_basis?.operationIdentity.projectId, 'alpha');
  assert.equal(lock.target_description?.path, fixture.targetDescription);
  assert.equal(lock.master_benchmark?.path, fixture.masterBenchmark);
  assert.equal(lock.absent.some((value) => value.startsWith('project_authority')), false);
  assert.equal(lock.absent.some((value) => value.startsWith('benchmark_runtime')), false);
});

test('PP-15: authority drift makes the current mission unusable rather than silently changing AI context', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  mkdirSync(join(fixture.target, 'src'), { recursive: true });
  const record = recordForProfile(fixture, proofReadyProfile(fixture));
  const base = installationConfig(fixture.root, fixture.target, fixture.workspace, fixture.shadow);
  const binding = resolveProjectRuntimeBinding(base, record);
  const projections = new ProjectionStore(join(fixture.workspace, 'db', 'mission-drift.db'));
  const artifacts = new ArtifactStore(join(fixture.workspace, 'blobs'));
  const { log } = EventLog.open(join(fixture.workspace, 'events'));
  t.after(() => {
    log.close();
    projections.close();
  });
  const mission = new MissionRegistry({ repoRoot: fixture.root, config: binding.config, log, projections, artifacts, projectBinding: binding });
  mission.bootstrap();

  writeFileSync(fixture.targetDescription, '# Target\nUnratified successor bytes.\n', 'utf8');
  assert.throws(
    () => mission.requireCurrentBasis(),
    (error: unknown) => error instanceof ProjectAuthorityError && error.snapshot.state === 'DRIFTED',
  );
});
