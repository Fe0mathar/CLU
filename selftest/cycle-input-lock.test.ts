/**
 * Cycle input lock acceptance (DEV-P2-08 S3; Execution Model §2/§3.3).
 *
 * The pins, in the order they matter:
 *
 * **Digest laws** — the digest ignores time (identical worlds locked at different moments
 * compare equal) and notices worlds (one changed input, one changed digest, one named
 * absence).
 *
 * **A lying registration refuses** — a registered input whose file is gone is not an
 * absence; it throws, naming the label, so a broken installation cannot launder itself
 * into a diagnostic grade.
 *
 * **Structural absences are computed, not believed** — give the tree an adapters
 * directory and that absence disappears; enable the gateway in configuration and that one
 * disappears; the rules never change, the world does.
 *
 * **Phase scope is evidence.** Legacy worlds still name the Project Intent Model,
 * environment adapters and disabled gateway as absences. A mission-bound P2 closure policy
 * may explicitly defer the two P3 domains and close D4 as SAFE_DISABLED_DEFERRED; only then
 * can an otherwise complete P2 world become proof-authoritative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { clueConfigSchema, cycleInputLockSchema, type ClueConfig } from '../src/shared/schemas.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import { MissionRegistry, type EpochRecord, type RatificationRecord } from '../src/control/mission.js';
import { computeInputLock } from '../src/cycle/cycleInputLock.js';

/* ========================================================================= */
/* Fixture                                                                    */
/* ========================================================================= */

interface FixtureOptions {
  readonly registerDescription?: boolean;
  readonly registerBenchmark?: boolean;
  readonly writeDescription?: boolean;
  readonly gatewayEnabled?: boolean;
  readonly adaptersDir?: boolean;
  readonly allPolicies?: boolean;
  readonly p2Decision?: 'PENDING_CREATOR_DECISION' | 'SAFE_DISABLED_DEFERRED' | 'OPERATIONAL';
}

interface Fixture {
  readonly root: string;
  readonly config: ClueConfig;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'clue-lock-'));
  writeFileSync(join(root, 'CLUE.md'), '# CLUE\n\nThe constitution, for test purposes.\n', 'utf8');
  mkdirSync(join(root, 'murugan', 'src'), { recursive: true });
  if (options.writeDescription ?? true) {
    writeFileSync(join(root, 'murugan', 'target description.md'), '# intent\n', 'utf8');
  }
  if (options.registerBenchmark === true) {
    // ADR-0010: one artifact — the contract carries its harness in a `[harness.<id>]` block.
    writeFileSync(join(root, 'murugan', 'benchmark.md'), '# contract\n', 'utf8');
  }
  // One declared policy present, the rest deliberately missing — both branches pinned.
  mkdirSync(join(root, 'config', 'policies'), { recursive: true });
  writeFileSync(join(root, 'config', 'policies', 'patching.yaml'), 'mode: NOTIFY\n', 'utf8');
  if (options.allPolicies === true) {
    writeFileSync(join(root, 'config', 'policies', 'equilibrium.yaml'), 'evaluation_cycles: 3\n', 'utf8');
    writeFileSync(join(root, 'config', 'policies', 'budget.yaml'), 'version: 1\n', 'utf8');
    writeFileSync(join(root, 'config', 'policies', 'routing.yaml'), 'version: 1\n', 'utf8');
  }
  if (options.p2Decision !== undefined) {
    const closed = options.p2Decision !== 'PENDING_CREATOR_DECISION';
    writeFileSync(
      join(root, 'config', 'policies', 'p2-closure.yaml'),
      [
        'version: 1',
        'phase: P2',
        'gateway:',
        `  decision: ${options.p2Decision}`,
        `  decision_id: ${closed ? 'P2-D4-TEST' : 'null'}`,
        `  recorded_at: ${closed ? '"2026-08-14"' : 'null'}`,
        `  recorded_by: ${closed ? 'creator' : 'null'}`,
        '  reason: "test phase boundary"',
        'p3_deferrals:',
        '  project_intent_model: true',
        '  environment_adapters: true',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  if (options.adaptersDir === true) {
    mkdirSync(join(root, 'src', 'analysis', 'environments'), { recursive: true });
  }

  const config = clueConfigSchema.parse({
    version: 2,
    project: {
      id: 'murugan',
      root: join(root, 'murugan'),
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
      inputs: {
        description: (options.registerDescription ?? true) ? 'target description.md' : null,
        benchmark: options.registerBenchmark === true ? 'benchmark.md' : null,
      },
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
    runtime: {
      package_manager: 'npm',
      scripts: { typecheck: 'npm run typecheck', build: 'npm run build' },
    },
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
      enabled: options.gatewayEnabled === true,
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
  });

  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(config.workspace.root, directory), { recursive: true });
  }
  return { root, config };
}

/** A real mission from a real bootstrap; the lock takes the record, not the registry. */
function bootstrapMission(fixture: Fixture) {
  const workspace = fixture.config.workspace.root;
  const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'));
  const { log } = EventLog.open(join(workspace, 'events'), { fsyncOnAppend: false });

  try {
    const registry = new MissionRegistry({
      repoRoot: fixture.root,
      config: fixture.config,
      log,
      projections,
      artifacts: new ArtifactStore(join(workspace, 'blobs')),
    });
    registry.bootstrap();
    const mission = registry.current();
    assert.ok(mission !== null);
    return mission;
  } finally {
    // The refusal test intentionally makes bootstrap() throw. Windows keeps clue.db
    // locked until the ProjectionStore is closed, so cleanup must run on both success
    // and failure rather than only after a healthy bootstrap.
    try {
      log.close();
    } finally {
      projections.close();
    }
  }
}

function removeFixture(root: string): void {
  // Windows Defender/indexing can briefly retain a just-closed temp file. Retry only
  // transient removal failures; a persistent leaked handle still fails the test.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const ratification: RatificationRecord = {
  pack_release: 'CLU-E RPI Documentation Pack v9',
  release_version: '9.0',
  seal_path: 'SHA256SUMS_v9.txt',
  seal_sha256: 'a'.repeat(64),
  manifest_path: 'DOCUMENTATION_MANIFEST_v9.json',
  manifest_sha256: 'b'.repeat(64),
  constitution_path: 'CLUE.md',
  constitution_sha256: 'c'.repeat(64),
  declared_file_count: 3,
  ratified_by: 'creator',
  statement: 'RATIFY test',
  ratified_at: '2026-08-10T12:00:00.000Z',
  event_id: 'EVENT-000010',
  sequence: 10,
};

const epoch: EpochRecord = {
  epoch_name: 'P0-final',
  legacy_head_sequence: 11,
  legacy_head_hash: 'd'.repeat(64),
  blob_manifest_sha256: 'e'.repeat(64),
  blob_count: 2,
  ratification_event_id: 'EVENT-000010',
  ratified_seal_sha256: 'a'.repeat(64),
  sealed_by: 'creator',
  statement: 'SEAL test',
  sealed_at: '2026-08-10T12:01:00.000Z',
  event_id: 'EVENT-000012',
  sequence: 12,
};

/* ========================================================================= */
/* Digest laws and honest absences                                            */
/* ========================================================================= */

test('S3: the digest ignores time, notices worlds, and every absence is named and sorted', () => {
  const fixture = makeFixture();
  try {
    const mission = bootstrapMission(fixture);
    const deps = {
      repoRoot: fixture.root,
      config: fixture.config,
      mission,
      ratification,
      epoch,
    };

    const a = computeInputLock(deps);
    assert.equal(a.grade, 'diagnostic');
    assert.equal(a.target_description?.path, 'target description.md');
    assert.equal(a.master_benchmark, null);
    assert.equal(a.tracked_documents.length, mission.documents.length);
    assert.deepEqual(
      a.policy_files.map((policy) => policy.path),
      ['config/policies/patching.yaml'],
      'the one present policy is hashed; the missing ones are absences',
    );
    assert.deepEqual(a.absent, [...a.absent].sort(), 'absences are sorted');
    for (const needle of [
      'master_benchmark (unregistered)',
      'catalogue_version (config/measurements/catalogue.yaml absent)',
      'project_intent_model (AMB-003: no compiler exists)',
      'environment_adapters (src/analysis/environments/ absent)',
      'model_provider (gateway disabled)',
      'policy:config/policies/routing.yaml (declared but missing)',
    ]) {
      assert.ok(a.absent.includes(needle), `absence named: ${needle}`);
    }
    assert.ok(!a.absent.some((entry) => entry.startsWith('ratification')), 'supplied, so not absent');
    assert.ok(!a.absent.some((entry) => entry.startsWith('epoch')), 'supplied, so not absent');

    const b = computeInputLock(deps);
    assert.equal(b.digest, a.digest, 'identical worlds compare equal across time');

    const changed = computeInputLock({ ...deps, ratification: null });
    assert.notEqual(changed.digest, a.digest, 'a changed world is a changed digest');
    assert.equal(changed.absent.length, a.absent.length + 1, 'and exactly one new absence');
    assert.equal(changed.ratification_event_id, null);
  } finally {
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* A lying registration refuses                                               */
/* ========================================================================= */

test('S3: a lying registration is refused at both layers — bootstrap first, and the lock when the file vanishes later', () => {
  // Layer 1: the mission basis reader refuses to bootstrap over a registered-but-missing
  // input at all — measured behavior, and the stronger guard.
  const unbootable = makeFixture({ writeDescription: false });
  try {
    assert.throws(() => bootstrapMission(unbootable), /project\.inputs\.description could not be read/);
  } finally {
    removeFixture(unbootable.root);
  }

  // Layer 2: the file vanishes AFTER a healthy bootstrap — now the lock's own guard is the
  // one that fires, and the absence does not launder into a diagnostic grade.
  const fixture = makeFixture();
  try {
    const mission = bootstrapMission(fixture);
    rmSync(join(fixture.root, 'murugan', 'target description.md'));
    assert.throws(
      () =>
        computeInputLock({
          repoRoot: fixture.root,
          config: fixture.config,
          mission,
          ratification: null,
          epoch: null,
        }),
      /target_description.*lying registration/s,
    );
  } finally {
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* Structural absences are computed from the world                            */
/* ========================================================================= */

test('S3: giving the world the machinery removes its absence — adapters directory, gateway, benchmark', () => {
  const fixture = makeFixture({ adaptersDir: true, gatewayEnabled: true, registerBenchmark: true });
  try {
    const mission = bootstrapMission(fixture);
    // The real repository catalogue, copied in: the fixture's world now carries a loadable
    // v6 registry, so the absence disappears through the same sourcing path production
    // uses — not through an injected label.
    mkdirSync(join(fixture.root, 'config', 'measurements'), { recursive: true });
    writeFileSync(
      join(fixture.root, 'config', 'measurements', 'catalogue.yaml'),
      readFileSync(join(process.cwd(), 'config', 'measurements', 'catalogue.yaml')),
    );
    const lock = computeInputLock({
      repoRoot: fixture.root,
      config: fixture.config,
      mission,
      ratification,
      epoch,
    });

    assert.ok(!lock.absent.some((entry) => entry.startsWith('environment_adapters')));
    assert.ok(!lock.absent.some((entry) => entry.startsWith('model_provider')));
    assert.ok(!lock.absent.some((entry) => entry.startsWith('master_benchmark')));
    assert.ok(!lock.absent.some((entry) => entry.startsWith('catalogue_version')));
    assert.equal(lock.master_benchmark?.path, 'benchmark.md');

    // Everything else supplied, one absence remains — and therefore the grade holds.
    assert.deepEqual(
      lock.absent.filter((entry) => !entry.startsWith('policy:')),
      ['project_intent_model (AMB-003: no compiler exists)'],
      'proof-authoritative is unwritable until the intent compiler exists',
    );
    assert.equal(lock.grade, 'diagnostic');
  } finally {
    removeFixture(fixture.root);
  }
});


test('P2-CLOSURE-03: a pending D4 decision keeps the phase lock diagnostic while P3 deferrals are bound', () => {
  const fixture = makeFixture({
    registerBenchmark: true,
    allPolicies: true,
    p2Decision: 'PENDING_CREATOR_DECISION',
  });
  try {
    const mission = bootstrapMission(fixture);
    mkdirSync(join(fixture.root, 'config', 'measurements'), { recursive: true });
    writeFileSync(
      join(fixture.root, 'config', 'measurements', 'catalogue.yaml'),
      readFileSync(join(process.cwd(), 'config', 'measurements', 'catalogue.yaml')),
    );
    const lock = computeInputLock({
      repoRoot: fixture.root,
      config: fixture.config,
      mission,
      ratification,
      epoch,
    });
    assert.equal(lock.grade, 'diagnostic');
    assert.deepEqual(lock.absent, ['model_provider (D4 gateway closure decision pending)']);
    assert.ok(lock.policy_files.some((item) => item.path === 'config/policies/p2-closure.yaml'));
  } finally {
    removeFixture(fixture.root);
  }
});

test('P2-CLOSURE-03: explicit SAFE_DISABLED_DEFERRED plus P3 scope produces a real zero-absence P2 lock', () => {
  const fixture = makeFixture({
    registerBenchmark: true,
    allPolicies: true,
    p2Decision: 'SAFE_DISABLED_DEFERRED',
  });
  try {
    const mission = bootstrapMission(fixture);
    mkdirSync(join(fixture.root, 'config', 'measurements'), { recursive: true });
    writeFileSync(
      join(fixture.root, 'config', 'measurements', 'catalogue.yaml'),
      readFileSync(join(process.cwd(), 'config', 'measurements', 'catalogue.yaml')),
    );
    const lock = computeInputLock({
      repoRoot: fixture.root,
      config: fixture.config,
      mission,
      ratification,
      epoch,
    });
    assert.deepEqual(lock.absent, []);
    assert.equal(lock.grade, 'proof-authoritative');
    assert.ok(lock.policy_files.some((item) => item.path === 'config/policies/p2-closure.yaml'));
    assert.ok(!lock.policy_files.some((item) => item.path.includes('missing')));
  } finally {
    removeFixture(fixture.root);
  }
});

test('S3: the grade is achievable by shape — a zero-absence lock parses as proof-authoritative', () => {
  const parsed = cycleInputLockSchema.safeParse({
    digest: 'f'.repeat(64),
    grade: 'proof-authoritative',
    computed_at: '2026-08-10T12:00:00.000Z',
    target_description: { path: 'target description.md', sha256: '1'.repeat(64) },
    master_benchmark: { path: 'benchmark.txt', sha256: '2'.repeat(64) },
    tracked_documents: [{ path: 'CLUE.md', sha256: '3'.repeat(64) }],
    catalogue_version: 'v6',
    policy_files: [],
    environment_fingerprint: { node_version: 'v22', platform: 'linux', arch: 'x64' },
    ratification_event_id: 'EVENT-000010',
    epoch_name: 'P0-final',
    absent: [],
  });
  assert.equal(parsed.success, true, 'the day AMB-003 resolves, only the constant line moves');
});
