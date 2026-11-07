/**
 * Q1 SURF/DIVE production-coordinator acceptance.
 *
 * This drives the same `runRecognition()` seam used by both the CLI and the cycle
 * orchestrator. It proves that a source-root semantic snapshot and a full-repository
 * physical inventory coexist in one sealed Navigator stream without collapsing their
 * identities or manufacturing physical files from semantic units.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as toYaml } from 'yaml';

import { ArtifactStore } from '../src/memory/artifactStore.js';
import { ProjectionStore } from '../src/memory/db.js';
import { EventLog } from '../src/memory/eventLog.js';
import { MissionRegistry } from '../src/control/mission.js';
import {
  loadConfig,
  resolveConfigPaths,
  withRuntime,
} from '../src/control/runtime.js';
import { runRecognition } from '../src/control/recognitionRun.js';
import { repositoryInventoryPointerPath } from '../src/analysis/source/repositoryInventory.js';

function write(root: string, relative: string, content: string | Buffer): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-q1-run-recognition-'));
  const target = join(root, 'target');
  const workspace = join(root, 'workspace');

  write(root, 'CLUE.md', '# CLU-E fixture constitution\n');
  write(root, 'CLUE_implementation.md', '# CLU-E fixture architecture\n');
  write(root, 'CLUE_Implementation_Strategy.md', '# CLU-E fixture strategy\n');
  write(root, 'package-lock.json', JSON.stringify({
    name: 'clue-fixture',
    lockfileVersion: 3,
    packages: {},
  }));

  write(target, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
    },
    include: ['src'],
  }));
  write(target, 'src/value.ts', 'export const physicalSecretMarker = 41;\n');
  write(target, 'src/use.ts', "import { physicalSecretMarker } from './value';\nexport const used = physicalSecretMarker;\n");
  write(target, 'README.md', '# Physical repository documentation\n');
  write(target, 'config/settings.yaml', 'feature: true\n');
  write(target, 'assets/icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(target, 'misc/opaque.foo', 'opaque\n');
  write(target, 'node_modules/ignored/index.js', 'throw new Error("excluded");\n');

  const config = {
    version: 2,
    project: {
      id: 'target',
      name: 'Q1 coordinator fixture',
      root: target,
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['.git', 'node_modules', 'dist', 'workspace'],
      remote: null,
      credential_env: null,
      inputs: { description: null, benchmark: null },
    },
    workspace: { root: workspace },
    shadow: {
      root: join(root, 'shadow'),
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

  write(root, 'config/clue.config.yaml', toYaml(config));
  for (const directory of ['db', 'events', 'blobs', 'logs', 'graph', 'snapshots']) {
    mkdirSync(join(workspace, directory), { recursive: true });
  }
  return root;
}

function bootstrap(root: string): void {
  const config = resolveConfigPaths(loadConfig(root), root);
  const projections = new ProjectionStore(join(config.workspace.root, 'db', 'clue.db'));
  const artifacts = new ArtifactStore(join(config.workspace.root, 'blobs'));
  const { log } = EventLog.open(join(config.workspace.root, 'events'));
  try {
    const mission = new MissionRegistry({ repoRoot: root, config, log, projections, artifacts });
    mission.bootstrap();
  } finally {
    log.close();
    projections.close();
  }
}

test('Q1 SURF/DIVE: production recognition emits full physical inventory before semantic DIVE evidence', () => {
  const root = makeRepo();
  try {
    bootstrap(root);
    const navigatorPath = join(root, 'workspace', 'graph', 'system-navigator.ndjson');
    const outcome = withRuntime({ withLog: true, requireMission: true, repoRoot: root }, (runtime) =>
      runRecognition(runtime, { force: true, navigatorPath }),
    );

    assert.equal(outcome.navigatorPath, navigatorPath);
    assert.equal(outcome.navigatorChecks.some((check) => check.level === 'warn'), false);

    const events = readFileSync(navigatorPath, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        type: string;
        sequence: number;
        snapshotId: string;
        payload: Record<string, unknown>;
      });
    const types = events.map((event) => event.type);

    assert.deepEqual(types.slice(0, 3), [
      'navigator.reset',
      'inventory.started',
      'inventory.taxonomy',
    ]);
    const inventoryCompleted = types.indexOf('inventory.completed');
    const recognitionStarted = types.indexOf('recognition.started');
    const scanStarted = types.indexOf('scan.started');
    assert.ok(types.indexOf('files.upserted') > 1);
    assert.equal(recognitionStarted, inventoryCompleted + 1);
    assert.equal(scanStarted, recognitionStarted + 1);
    assert.ok(types.includes('file.semantic-summary'));
    assert.ok(types.includes('dependency.discovered'));
    assert.equal(types.at(-1), 'graph.committed');
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index));
    assert.ok(events.every((event) => event.snapshotId === outcome.snapshotId));

    const physicalRecords = events
      .filter((event) => event.type === 'files.upserted')
      .flatMap((event) => {
        const files = event.payload['files'];
        return Array.isArray(files) ? files as Record<string, unknown>[] : [];
      });
    const physicalPaths = new Set(physicalRecords.map((file) => String(file['path'])));
    assert.ok(physicalPaths.has('src/value.ts'));
    assert.ok(physicalPaths.has('README.md'));
    assert.ok(physicalPaths.has('config/settings.yaml'));
    assert.ok(physicalPaths.has('assets/icon.png'));
    assert.ok(physicalPaths.has('misc/opaque.foo'));
    assert.equal([...physicalPaths].some((path) => path.startsWith('node_modules/')), false);

    const physicalReadme = physicalRecords.find((file) => file['path'] === 'README.md');
    assert.equal(physicalReadme?.['familyId'], 'documentation');
    assert.equal(physicalReadme?.['environmentId'], 'markdown');
    const opaque = physicalRecords.find((file) => file['path'] === 'misc/opaque.foo');
    assert.equal(opaque?.['familyId'], 'unknown');
    assert.equal(opaque?.['environmentId'], 'unknown');
    assert.match(String(physicalReadme?.['fileLocationId']), /^[0-9a-f]{64}$/u);
    assert.match(String(physicalReadme?.['fileVersionId']), /^[0-9a-f]{64}$/u);

    const semanticEvents = events.filter((event) => event.type === 'file.semantic-summary');
    const semanticByPath = new Map(semanticEvents.map((event) => [String(event.payload['path']), event.payload] as const));
    assert.ok(semanticByPath.has('src/value.ts'));
    assert.ok(semanticByPath.has('src/use.ts'));
    const readmeSemantic = semanticByPath.get('README.md');
    assert.equal(readmeSemantic?.['recognitionState'], 'unsupported');
    assert.deepEqual(readmeSemantic?.['semanticMembershipIds'], []);
    assert.equal(readmeSemantic?.['adapterId'], null, 'physical-only documentation gets an explicit unsupported summary, never invented units');

    const pointer = JSON.parse(readFileSync(repositoryInventoryPointerPath(navigatorPath), 'utf8')) as {
      inventoryHash: string;
      files: readonly { path: string; fileLocationId: string; fileVersionId: string }[];
    };
    assert.match(pointer.inventoryHash, /^[0-9a-f]{64}$/u);
    assert.ok(pointer.files.some((file) => file.path === 'README.md'));
    assert.ok(pointer.files.every((file) => file.fileLocationId.length > 0 && file.fileVersionId.length > 0));

    const stream = readFileSync(navigatorPath, 'utf8');
    assert.doesNotMatch(stream, /physicalSecretMarker\s*=\s*41/u, 'source body text is never telemetry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
