/**
 * DEV-P0-07 — mission registration and the mission gate.
 *
 * A mission version is bound to its governed inputs by content hash — not only the tracked documents,
 * but the actual toolchain and compiler identity (package-lock pins every dependency including the
 * TypeScript compiler; tsconfig pins the compiler options). A change to any bound input registers a
 * successor mission automatically, rather than depending on a version string being bumped by hand. And
 * `requireCurrent()` — the gate that `withRuntime({ requireMission: true })` enforces before any
 * non-bootstrap command body runs — refuses while no committed mission exists.
 *
 * kernel.test.ts already covers registration survival, idempotency, and tracked-document successors;
 * this suite covers the toolchain-input binding and the gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { MissionRegistry, MissionDriftError } from '../src/control/mission.js';
import { RECOGNIZER_VERSION } from '../src/analysis/source/recognizer.js';
import { clueConfigSchema } from '../src/shared/schemas.js';

interface Fixture {
  readonly root: string;
  readonly config: ReturnType<typeof clueConfigSchema.parse>;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'clue-mission-gate-'));
  writeFileSync(join(root, 'CLUE.md'), '# CLUE\n\nconstitution\n', 'utf8');
  writeFileSync(join(root, 'CLUE_implementation.md'), '# impl\n\narchitecture\n', 'utf8');
  writeFileSync(join(root, 'CLUE_Implementation_Strategy.md'), '# strategy\n\nplan\n', 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'clue', lockfileVersion: 3, packages: {} }), 'utf8');
  mkdirSync(join(root, 'murugan', 'src'), { recursive: true });

  const config = clueConfigSchema.parse({
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
  });
  for (const d of ['db', 'events', 'blobs', 'logs']) mkdirSync(join(config.workspace.root, d), { recursive: true });
  return { root, config };
}

function openMission(fx: Fixture) {
  const projections = new ProjectionStore(join(fx.config.workspace.root, 'db', 'clue.db'), { projectors: {} });
  const artifacts = new ArtifactStore(join(fx.config.workspace.root, 'blobs'));
  const { log } = EventLog.open(join(fx.config.workspace.root, 'events'));
  const mission = new MissionRegistry({ repoRoot: fx.root, config: fx.config, log, projections, artifacts });
  return {
    mission,
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

test('the mission gate refuses while no committed mission exists', () => {
  const fx = makeFixture();
  const m = openMission(fx);
  try {
    assert.equal(m.mission.current(), null, 'no mission before bootstrap');
    assert.throws(() => m.mission.requireCurrent(), /mission|not registered|no current/i);

    const v1 = m.mission.bootstrap();
    assert.equal(v1.change, 'initial');
    assert.equal(v1.mission.version, 1);
    assert.equal(m.mission.current()?.id, v1.mission.id, 'the registered mission is now current');
    assert.equal(m.mission.requireCurrent().id, v1.mission.id, 'the gate now passes');
  } finally {
    m.dispose();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the governed basis binds the actual toolchain and compiler inputs, and a change registers a successor', () => {
  const fx = makeFixture();
  const m = openMission(fx);
  try {
    const v1 = m.mission.bootstrap();
    const bound = v1.mission.documents.map((d) => d.path);
    assert.ok(bound.includes('tsconfig.json'), 'tsconfig is bound by content hash');
    assert.ok(bound.includes('package-lock.json'), 'package-lock is bound by content hash');

    // Editing the compiler options registers a successor mission.
    writeFileSync(join(fx.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true } }), 'utf8');
    const v2 = m.mission.bootstrap();
    assert.equal(v2.mission.version, 2);
    assert.notEqual(v2.change, 'unchanged');
    assert.equal(m.mission.current()?.version, 2);

    // Editing the dependency lock registers a further successor.
    writeFileSync(join(fx.root, 'package-lock.json'), JSON.stringify({ name: 'clue', lockfileVersion: 3, packages: { '': { version: '0.0.1' } } }), 'utf8');
    const v3 = m.mission.bootstrap();
    assert.equal(v3.mission.version, 3);

    // An unchanged repository does not create a runaway version.
    const again = m.mission.bootstrap();
    assert.equal(again.change, 'unchanged');
    assert.equal(again.mission.version, 3);
  } finally {
    m.dispose();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('DEV-P0-07: requireCurrentBasis refuses a drifted governed document, and passes again after a successor', () => {
  const fx = makeFixture();
  const m = openMission(fx);
  try {
    const v1 = m.mission.bootstrap();
    // Immediately after bootstrap the disk matches the committed basis.
    assert.equal(m.mission.requireCurrentBasis().id, v1.mission.id, 'no drift after bootstrap');

    // Change a tracked document on disk without registering a successor.
    writeFileSync(join(fx.root, 'CLUE.md'), '# CLUE\n\nconstitution (amended out of band)\n', 'utf8');
    assert.throws(() => m.mission.requireCurrentBasis(), MissionDriftError, 'drift is refused');

    // Existence-only gate still passes — the drift gate is strictly stronger than requireCurrent.
    assert.equal(m.mission.requireCurrent().id, v1.mission.id, 'requireCurrent still passes on existence');

    // Registering a successor re-establishes the basis, and the gate passes under it.
    const v2 = m.mission.bootstrap();
    assert.equal(v2.mission.version, 2, 'a successor is registered');
    assert.equal(m.mission.requireCurrentBasis().id, v2.mission.id, 'the gate passes under the successor');
  } finally {
    m.dispose();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('DEV-P0-07: the mission basis binds the real recognizer version, not a hardcoded string', () => {
  const fx = makeFixture();
  const m = openMission(fx);
  try {
    assert.equal(RECOGNIZER_VERSION, 'clue-recognizer/4', 'the executed recognizer version is /4');
    assert.equal(
      m.mission.basis().toolchain.recognizerVersion,
      RECOGNIZER_VERSION,
      'the basis binds the version actually executed, not a stale /2',
    );
  } finally {
    m.dispose();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('DEV-P0-07: changing the package manifest registers a successor mission', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.root, 'package.json'), JSON.stringify({ name: 'clue', version: '1.0.0' }), 'utf8');
  const m = openMission(fx);
  try {
    const v1 = m.mission.bootstrap();
    assert.equal(v1.mission.version, 1);
    assert.equal(m.mission.bootstrap().change, 'unchanged', 'a no-op re-bootstrap is unchanged');

    // The manifest is a bound governed input; changing it must require a successor.
    writeFileSync(join(fx.root, 'package.json'), JSON.stringify({ name: 'clue', version: '1.0.1' }), 'utf8');
    const v2 = m.mission.bootstrap();
    assert.equal(v2.mission.version, 2, 'a manifest change registered a successor mission');
  } finally {
    m.dispose();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('DEV-P0-07: the catalogue, coordinate map, and record-schema authority are each bound by content hash', () => {
  const fx = makeFixture();
  // The three measurement/schema authorities the basis must bind by BYTES, not by a version label
  // (a string like 'clue-catalogue/6' cannot detect that the bytes in force have moved).
  mkdirSync(join(fx.root, 'config', 'measurements'), { recursive: true });
  mkdirSync(join(fx.root, 'src', 'shared'), { recursive: true });
  const catalogue = join(fx.root, 'config', 'measurements', 'catalogue.yaml');
  const coordinates = join(fx.root, 'src', 'shared', 'measurementCoordinates.ts');
  const schemas = join(fx.root, 'src', 'shared', 'schemas.ts');
  writeFileSync(catalogue, 'version: 3.0\nmeasures: []\n', 'utf8');
  writeFileSync(coordinates, 'export const METRIC_COORDINATES = [];\n', 'utf8');
  writeFileSync(schemas, 'export const X = 1;\n', 'utf8');

  const m = openMission(fx);
  try {
    const v1 = m.mission.bootstrap();
    const bound = v1.mission.documents.map((d) => d.path);
    assert.ok(bound.includes('config/measurements/catalogue.yaml'), 'catalogue bound by content hash');
    assert.ok(bound.includes('src/shared/measurementCoordinates.ts'), 'coordinate map bound by content hash');
    assert.ok(bound.includes('src/shared/schemas.ts'), 'record-schema authority bound by content hash');

    // Each authority's bytes changing registers a successor — the exact property the version string lacked.
    writeFileSync(catalogue, 'version: 3.0\nmeasures: [MH03]\n', 'utf8');
    assert.equal(m.mission.bootstrap().mission.version, 2, 'a catalogue change registered a successor');

    writeFileSync(coordinates, 'export const METRIC_COORDINATES = [{ id: "MH03" }];\n', 'utf8');
    assert.equal(m.mission.bootstrap().mission.version, 3, 'a coordinate-map change registered a successor');

    writeFileSync(schemas, 'export const X = 2;\n', 'utf8');
    const v4 = m.mission.bootstrap();
    assert.equal(v4.mission.version, 4, 'a schema-authority change registered a successor');

    // get(id) resolves that exact committed version, and an unchanged tree does not run away.
    assert.equal(m.mission.get(v4.mission.id)?.version, 4, 'get(id) returns the committed successor');
    assert.equal(m.mission.bootstrap().change, 'unchanged', 'an unchanged tree stays at the same version');
  } finally {
    m.dispose();
    rmSync(fx.root, { recursive: true, force: true });
  }
});