import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { stringify as stringifyYaml } from 'yaml';

import { hashBytes } from '../src/shared/ids.js';
import { ProfileEventLog } from '../src/control/projectProfiles/profileEventLog.js';
import {
  ProjectProfileMigrationError,
  migrateLegacyActiveTarget,
} from '../src/control/projectProfiles/profileMigration.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { ProjectProfileStore } from '../src/control/projectProfiles/profileStore.js';
import { FIXED_TIME, FIXED_TIME_2 } from './project-profile-fixture.js';

interface LegacyFixture {
  readonly root: string;
  readonly targetRoot: string;
  readonly workspaceRoot: string;
  readonly shadowRoot: string;
  readonly configPath: string;
  readonly profilePath: string;
  readonly routingPath: string;
  readonly markerPath: string;
  readonly profilesRoot: string;
}

function makeLegacyFixture(
  root: string,
  options: {
    readonly activeTarget?: string;
    readonly profileId?: string;
    readonly explicitNoRemote?: boolean;
    readonly modelIds?: readonly string[];
    readonly includeBenchmark?: boolean;
    readonly bindDescription?: boolean;
    readonly bindBenchmark?: boolean;
  } = {},
): LegacyFixture {
  const activeTarget = options.activeTarget ?? 'clu';
  const profileId = options.profileId ?? activeTarget;
  const targetRoot = join(root, 'target');
  const workspaceRoot = join(root, 'workspace', 'clue');
  const shadowRoot = join(root, 'shadow', 'clue');
  const configPath = join(root, 'config', 'clue.config.yaml');
  const profilePath = join(root, 'targets', activeTarget, 'profile.yaml');
  const routingPath = join(root, 'config', 'policies', 'routing.yaml');
  const markerPath = join(workspaceRoot, 'events', 'historic.ndjson');
  const profilesRoot = join(root, 'profiles');

  for (const directory of [
    targetRoot,
    workspaceRoot,
    shadowRoot,
    join(root, 'config', 'policies'),
    join(root, 'targets', activeTarget),
    join(workspaceRoot, 'db'),
    join(workspaceRoot, 'events'),
    join(workspaceRoot, 'snapshots'),
    join(workspaceRoot, 'proof-contracts'),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  mkdirSync(join(targetRoot, 'src'), { recursive: true });
  mkdirSync(join(targetRoot, 'selftest'), { recursive: true });
  writeFileSync(join(targetRoot, 'target-description.md'), '# Target\n', 'utf8');
  if (options.includeBenchmark !== false) {
    writeFileSync(join(targetRoot, 'master-benchmark.md'), '# Benchmark\n', 'utf8');
  }
  writeFileSync(markerPath, '{"historic":true}\n', 'utf8');

  const config = {
    version: 2,
    project: { active_target: activeTarget },
    workspace: { root: workspaceRoot },
    shadow: {
      root: shadowRoot,
      clone_mode: 'local',
      persistent: true,
      install_on_lockfile_change: true,
      install_command: 'npm ci',
    },
    constitution: {
      file: 'CLUE.md',
      tracked_documents: ['CLUE.md', 'CLUE_implementation.md', 'CLUE_Implementation_Strategy.md'],
    },
    runtime: {
      package_manager: 'npm',
      scripts: { typecheck: 'npm run typecheck', build: 'npm run build', selftest: 'npm run selftest' },
    },
    browser: {
      executable: join(root, 'chrome.exe'),
      remote_debugging_port: 9222,
      profile_dir: join(root, 'browser-profile'),
      allowed_origins: ['http://127.0.0.1:*'],
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
      enabled: true,
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
      canonical_source_writes: 'custodian_only',
      real_settlement: 'denied',
      redact_environment: true,
    },
    logging: { level: 'info' },
  };
  writeFileSync(configPath, stringifyYaml(config), 'utf8');

  const remoteDecision = options.explicitNoRemote === false
    ? undefined
    : {
        state: 'NO_REMOTE_YET',
        decision_id: 'P2-D5-NO-REMOTE-YET',
        recorded_at: '2026-08-14',
        recorded_by: 'creator',
        reason: 'Local-only migration fixture.',
      };
  const profile: Record<string, unknown> = {
    credential_env: null,
    id: profileId,
    name: 'CLU-E',
    root: targetRoot,
    main_branch: 'main',
    source_roots: ['src', 'selftest'],
    document_roots: ['.'],
    exclude: ['node_modules', 'dist', '.git', 'workspace'],
    remote: null,
    inputs: {
      description: options.bindDescription === false ? null : 'target-description.md',
      benchmark: options.bindBenchmark === false ? null : 'master-benchmark.md',
    },
  };
  if (remoteDecision !== undefined) profile['remote_decision'] = remoteDecision;
  writeFileSync(profilePath, stringifyYaml(profile), 'utf8');

  const models = options.modelIds ?? ['gpt-5.6'];
  const routes = Object.fromEntries(
    models.map((model, index) => [
      `ROUTE_${index + 1}`,
      { enabled: true, lane: 'analysis', mode: 'interactive', model },
    ]),
  );
  writeFileSync(routingPath, stringifyYaml({ version: 1, provider: 'openai', routes }), 'utf8');

  return {
    root,
    targetRoot,
    workspaceRoot,
    shadowRoot,
    configPath,
    profilePath,
    routingPath,
    markerPath,
    profilesRoot,
  };
}

function registryFor(fixture: LegacyFixture): ProjectProfileRegistry {
  const store = new ProjectProfileStore(fixture.profilesRoot, { now: () => FIXED_TIME });
  const events = new ProfileEventLog(fixture.profilesRoot, { now: () => FIXED_TIME });
  return new ProjectProfileRegistry(store, { now: () => FIXED_TIME, eventLog: events });
}

function withRoot(action: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'clue-profile-migration-'));
  try {
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof ProjectProfileMigrationError ? error.code : null;
  }
}

test('PP-08: explicit migration preserves workspace history and records exact legacy bytes', () => {
  withRoot((root) => {
    const fixture = makeLegacyFixture(root);
    const registry = registryFor(fixture);
    const markerBefore = readFileSync(fixture.markerPath);
    const configBefore = readFileSync(fixture.configPath);
    const profileBefore = readFileSync(fixture.profilePath);

    const result = migrateLegacyActiveTarget({
      repoRoot: fixture.root,
      registry,
      now: () => FIXED_TIME,
    });

    assert.equal(result.state, 'created');
    assert.equal(registry.activeProjectId(), 'clu');
    assert.deepEqual(readFileSync(fixture.markerPath), markerBefore);
    assert.ok(existsSync(fixture.workspaceRoot));
    assert.ok(existsSync(fixture.shadowRoot));
    assert.equal(result.sourceConfigHash, hashBytes(configBefore));
    assert.equal(result.sourceProfileHash, hashBytes(profileBefore));

    const profile = result.registered.profile;
    assert.equal(profile.profileVersion, 'clue-project-profile/1');
    assert.equal(profile.workspaceRoot.replace(/\\/gu, '/'), fixture.workspaceRoot.replace(/\\/gu, '/'));
    assert.equal(profile.integrations.git.publicationMode, 'NO_REMOTE_YET');
    assert.equal(profile.integrations.gpt.modelId, 'gpt-5.6');
    assert.equal(profile.integrations.gpt.credential.value, 'env:OPENAI_API_KEY');
    assert.equal(profile.provenance.source, 'legacy-target-profile');
    if (profile.provenance.source !== 'legacy-target-profile') throw new Error('expected legacy provenance');
    assert.equal(profile.provenance.legacyConfigSha256, hashBytes(configBefore));
    assert.equal(profile.provenance.legacyProfileSha256, hashBytes(profileBefore));
    assert.equal(profile.authority.targetDescription?.sha256, hashBytes(readFileSync(join(fixture.targetRoot, 'target-description.md'))));
    assert.equal(profile.authority.masterBenchmark?.sha256, hashBytes(readFileSync(join(fixture.targetRoot, 'master-benchmark.md'))));

    const serialized = JSON.stringify(result.registered);
    assert.doesNotMatch(serialized, /sk-|raw-secret|"apiKey"/iu);
  });
});

test('PP-08: rerunning against identical source bytes is idempotent despite a later validation time', () => {
  withRoot((root) => {
    const fixture = makeLegacyFixture(root);
    const registry = registryFor(fixture);
    const first = migrateLegacyActiveTarget({ repoRoot: root, registry, now: () => FIXED_TIME });
    const second = migrateLegacyActiveTarget({ repoRoot: root, registry, now: () => FIXED_TIME_2 });
    assert.equal(first.state, 'created');
    assert.equal(second.state, 'unchanged');
    assert.equal(second.registered.projectProfileHash, first.registered.projectProfileHash);
    assert.equal(second.registered.generation, 1);
    assert.equal(registry.list().length, 1);
  });
});

test('PP-08: changed legacy source bytes are not silently absorbed into an existing migration', () => {
  withRoot((root) => {
    const fixture = makeLegacyFixture(root);
    const registry = registryFor(fixture);
    migrateLegacyActiveTarget({ repoRoot: root, registry, now: () => FIXED_TIME });
    writeFileSync(fixture.profilePath, `${readFileSync(fixture.profilePath, 'utf8')}\n# changed\n`, 'utf8');
    assert.equal(
      codeOf(() => migrateLegacyActiveTarget({ repoRoot: root, registry, now: () => FIXED_TIME_2 })),
      'MIGRATION_CONFLICT',
    );
    assert.equal(registry.get('clu')?.record.generation, 1);
  });
});

test('PP-08: noncanonical/mismatched legacy identities and ambiguous publication fail closed', () => {
  withRoot((root) => {
    const upper = makeLegacyFixture(root, { activeTarget: 'CLU', profileId: 'CLU' });
    assert.equal(
      codeOf(() => migrateLegacyActiveTarget({ repoRoot: root, registry: registryFor(upper) })),
      'ACTIVE_TARGET_INVALID',
    );
  });

  withRoot((root) => {
    const mismatch = makeLegacyFixture(root, { activeTarget: 'clu', profileId: 'other' });
    assert.equal(
      codeOf(() => migrateLegacyActiveTarget({ repoRoot: root, registry: registryFor(mismatch) })),
      'ACTIVE_TARGET_MISMATCH',
    );
  });

  withRoot((root) => {
    const ambiguous = makeLegacyFixture(root, { explicitNoRemote: false });
    assert.equal(
      codeOf(() => migrateLegacyActiveTarget({ repoRoot: root, registry: registryFor(ambiguous) })),
      'PUBLICATION_STATE_AMBIGUOUS',
    );
  });
});

test('PP-08: missing governed authority and multiple enabled model identities fail closed', () => {
  withRoot((root) => {
    const missing = makeLegacyFixture(root, { includeBenchmark: false });
    assert.equal(
      codeOf(() => migrateLegacyActiveTarget({ repoRoot: root, registry: registryFor(missing) })),
      'AUTHORITY_DOCUMENT_MISSING',
    );
  });

  withRoot((root) => {
    const unbound = makeLegacyFixture(root, { bindBenchmark: false });
    assert.equal(
      codeOf(() => migrateLegacyActiveTarget({ repoRoot: root, registry: registryFor(unbound) })),
      'AUTHORITY_DOCUMENT_MISSING',
    );
  });

  withRoot((root) => {
    const multiModel = makeLegacyFixture(root, { modelIds: ['gpt-5.6', 'gpt-other'] });
    assert.equal(
      codeOf(() => migrateLegacyActiveTarget({ repoRoot: root, registry: registryFor(multiModel) })),
      'MODEL_ID_AMBIGUOUS',
    );
  });
});
