/** Project Profiles PP-11 — real runtime assembly from one durable profile record. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { stringify as toYaml } from 'yaml';

import {
  openRuntime,
  type Runtime,
} from '../src/control/runtime.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { ProjectRuntimeBindingError } from '../src/control/projectProfiles/projectRuntimeBinding.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { computeProjectProfileHash } from '../src/control/projectProfiles/profileHash.js';
import type { ProjectProfileRecord } from '../src/shared/schemas.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

function writeInstallationConfig(root: string, legacyProjectId = 'legacy'): void {
  const legacyTarget = join(root, 'legacy');
  const legacyWorkspace = join(root, 'legacy-workspace');
  const legacyShadow = join(root, 'legacy-shadow');
  for (const path of [
    legacyTarget,
    join(legacyTarget, 'src'),
    legacyWorkspace,
    legacyShadow,
    join(root, 'legacy-browser'),
    join(root, 'config'),
  ]) {
    mkdirSync(path, { recursive: true });
  }
  for (const name of ['CLUE.md', 'CLUE_implementation.md', 'CLUE_Implementation_Strategy.md']) {
    writeFileSync(join(root, name), `# ${name}\n`, 'utf8');
  }

  const config = {
    version: 2,
    project: {
      id: legacyProjectId,
      name: 'Legacy fixture target',
      root: legacyTarget,
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
    workspace: { root: legacyWorkspace },
    shadow: {
      root: legacyShadow,
      clone_mode: 'local',
      persistent: true,
      install_on_lockfile_change: true,
      install_command: 'npm ci',
    },
    constitution: {
      file: 'CLUE.md',
      tracked_documents: [
        'CLUE.md',
        'CLUE_implementation.md',
        'CLUE_Implementation_Strategy.md',
      ],
    },
    runtime: {
      package_manager: 'npm',
      scripts: { typecheck: 'npm run typecheck', build: 'npm run build' },
    },
    browser: {
      executable: process.execPath,
      remote_debugging_port: 9222,
      profile_dir: join(root, 'legacy-browser'),
      allowed_origins: ['http://127.0.0.1:*'],
      require_webgpu: false,
    },
    powershell: { executable: process.execPath, autonomous_profile: 'restricted' },
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
      mode: 'OUTBOX',
      policy_file: 'config/policies/patching.yaml',
      landing_branch_prefix: 'clue/accepted/',
      merge_strategy: 'fast_forward_only',
      post_land_verify: ['typecheck'],
      auto_revert_on_post_land_failure: true,
    },
    notifications: { status_document: false, windows_toast: false, webhook_url_env: null },
    gateway: {
      enabled: false,
      provider: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_mode: 'interactive',
      batch_poll_interval_seconds: 300,
      prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] },
      budget_policy_file: 'config/policies/budget.yaml',
      routing_file: 'config/policies/routing.yaml',
    },
    backup: {
      remote: 'origin',
      push_on_verdict: true,
      push_on_landing: true,
      max_remote_staleness_hours: 24,
    },
    security: {
      canonical_source_writes: 'denied',
      real_settlement: 'denied',
      redact_environment: true,
    },
    logging: { level: 'info' },
  };
  writeFileSync(join(root, 'config', 'clue.config.yaml'), toYaml(config), 'utf8');
}

function openProfileRuntime(
  repoRoot: string,
  record: ProjectProfileRecord,
  onMissing: 'reject' | 'initialize-new' = 'reject',
): Runtime {
  return openRuntime({
    repoRoot,
    withLog: true,
    projectProfile: record,
    workspaceIdentityOnMissing: onMissing,
  });
}

test('one profile record assembles one complete real runtime and read-only successor generation', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  mkdirSync(join(fixture.target, 'src'), { recursive: true });
  writeInstallationConfig(fixture.root);

  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });
  const expected = operationIdentityFromProfileRecord(record);

  const runtime = openProfileRuntime(fixture.root, record, 'initialize-new');
  try {
    assert.equal(runtime.profileMode, 'project-profile');
    assert.equal(runtime.workspaceRoot, normalize(record.profile.workspaceRoot));
    assert.equal(runtime.config.project.id, record.profile.projectId, 'the profile ID differs from the physical directory name');
    assert.equal(runtime.config.project.root, normalize(record.profile.targetRoot));
    assert.deepEqual(runtime.projectIdentity, expected);
    assert.equal(runtime.projectProfile?.projectProfileHash, record.projectProfileHash);
    assert.equal(runtime.projectState?.databasePath, normalize(record.profile.state.databasePath));
    assert.equal(runtime.projectState?.greatBookScope, record.profile.projectId);
    assert.equal(runtime.projections.workspaceIdentity()?.projectId, record.profile.projectId);
    runtime.artifacts.assertProjectIdentity(expected);
    runtime.log?.assertProjectIdentity(expected);
  } finally {
    runtime.dispose();
  }

  const observer = openRuntime({
    repoRoot: fixture.root,
    withLog: false,
    readOnly: true,
    projectProfile: record,
    workspaceIdentityOnMissing: 'reject',
  });
  fixture.deferCleanup(() => observer.dispose());
  assert.equal(observer.readOnly, true);
  assert.equal(observer.config.project.id, record.profile.projectId);
  assert.equal(observer.projectIdentity?.projectProfileHash, record.projectProfileHash);
  assert.equal(observer.projections.workspaceIdentity()?.initialProfileHash, record.projectProfileHash);
});

test('legacy v2 startup stays unchanged and profile target identity is re-verified before state opens', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  mkdirSync(join(fixture.target, 'src'), { recursive: true });
  writeInstallationConfig(fixture.root, 'legacy-config-id');

  const legacy = openRuntime({ repoRoot: fixture.root, withLog: true });
  assert.equal(legacy.profileMode, 'legacy-v2');
  assert.equal(legacy.projectProfile, null);
  assert.equal(legacy.projectIdentity, null);
  assert.equal(legacy.config.project.id, 'legacy', 'legacy-v2 still infers a mismatched ID from the physical directory');
  legacy.dispose();

  const registry = new ProjectProfileRegistry(fixture.profiles);
  const record = registry.create(fixture.profile, { actor: 'creator' });
  const forgedProfile = {
    ...record.profile,
    targetRootIdentity: `path:v1:${process.platform}:${'f'.repeat(64)}`,
  };
  const forged = {
    ...record,
    profile: forgedProfile,
    projectProfileHash: computeProjectProfileHash(forgedProfile),
  } as ProjectProfileRecord;

  assert.throws(
    () => openProfileRuntime(fixture.root, forged, 'initialize-new'),
    (error: unknown) =>
      error instanceof ProjectRuntimeBindingError &&
      error.code === 'PROFILE_TARGET_ROOT_IDENTITY_MISMATCH',
  );
});
