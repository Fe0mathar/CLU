/**
 * Evidence-epoch seal acceptance (ADR-0006, accepted 2026-08-10; DEV-P2-05 second half).
 *
 * Spec: ADR-0006 — the record, the five guards, and its own acceptance criteria, quoted
 *       where a test pins one verbatim.
 *
 * Same discipline as `authority-ratification.test.ts`: real files in a temporary kernel,
 * a synthetic pack sealed by real hashes, nothing mocked. The two manifest criteria come
 * straight from the ADR: "a blob manifest recomputed at the boundary state reproduces
 * `blob_manifest_sha256`", and "a blob added after sealing changes nothing about the
 * record". The boundary criterion likewise: the seal event lands at
 * `legacy_head_sequence + 1`, which is what lets a future cycle assert
 * `sequence > legacy_head_sequence` as a machine check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { clueConfigSchema, type ClueConfig } from '../src/shared/schemas.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import {
  AUTHORITY_EVENT_TYPES,
  MissionRegistry,
  PACK_MANIFEST_FILE,
  PACK_SEAL_FILE,
} from '../src/control/mission.js';

const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/* ========================================================================= */
/* Fixture — the ratification suite's kernel, unchanged                       */
/* ========================================================================= */

interface Fixture {
  readonly root: string;
  readonly config: ClueConfig;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'clue-epoch-'));
  writeFileSync(join(root, 'CLUE.md'), '# CLUE\n\nThe constitution, for test purposes.\n', 'utf8');
  mkdirSync(join(root, 'murugan', 'src'), { recursive: true });

  const config = clueConfigSchema.parse({
    version: 2,
    project: {
      id: 'murugan',
      root: join(root, 'murugan'),
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
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
  });

  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(config.workspace.root, directory), { recursive: true });
  }
  return { root, config };
}

interface Kernel {
  readonly log: EventLog;
  readonly artifacts: ArtifactStore;
  readonly mission: MissionRegistry;
  dispose(): void;
}

function openKernel(fixture: Fixture): Kernel {
  const workspace = fixture.config.workspace.root;
  const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'));
  const artifacts = new ArtifactStore(join(workspace, 'blobs'));
  const { log } = EventLog.open(join(workspace, 'events'));
  const mission = new MissionRegistry({
    repoRoot: fixture.root,
    config: fixture.config,
    log,
    projections,
    artifacts,
  });
  return {
    log,
    artifacts,
    mission,
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

/** Writes the synthetic pack and its seal; identical arguments regenerate identical bytes. */
function writePack(root: string, nestedContent = 'nested content\n'): string {
  const manifest = '{"permanentFiles":[]}\n';
  writeFileSync(join(root, PACK_MANIFEST_FILE), manifest, 'utf8');
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'nested', 'extra.txt'), nestedContent, 'utf8');
  const constitution = readFileSync(join(root, 'CLUE.md'));
  const seal =
    `${sha256(constitution)}  CLUE.md\n` +
    `${sha256(manifest)}  ${PACK_MANIFEST_FILE}\n` +
    `${sha256(nestedContent)}  nested/extra.txt\n`;
  writeFileSync(join(root, PACK_SEAL_FILE), seal, 'utf8');
  return sha256(seal);
}

/* ========================================================================= */
/* The act: boundary exactness and the ADR's manifest criteria                */
/* ========================================================================= */

test('ADR-0006: the seal binds the verified head, lands at head+1, and pins a reproducible blob manifest', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    kernel.mission.bootstrap();
    writePack(fixture.root);
    kernel.mission.ratifyInstalledAuthority({ statement: 'RATIFY under test' });
    kernel.artifacts.putText('first blob');
    kernel.artifacts.putText('second blob');

    const boundaryManifest = kernel.artifacts.manifest();
    const boundaryVerification = kernel.artifacts.verifyAll();
    const browserExecution = join(fixture.config.workspace.root, 'blobs', 'browser-executions', `BEXEC-${'a'.repeat(32)}`);
    mkdirSync(browserExecution, { recursive: true });
    for (const name of ['page.jpg', 'request.json', 'response.json', 'receipt.json']) {
      writeFileSync(join(browserExecution, name), name);
    }
    assert.deepEqual(kernel.artifacts.manifest(), boundaryManifest);
    assert.deepEqual(kernel.artifacts.verifyAll(), boundaryVerification);

    const boundarySha = sha256(Buffer.from(JSON.stringify(boundaryManifest), 'utf8'));
    const preHead = kernel.log.getHead();
    assert.ok(preHead !== null);

    assert.equal(kernel.mission.latestEpoch(), null, 'no boundary before the act');
    const record = kernel.mission.sealEpoch({
      epochName: 'P0-final',
      statement: 'SEAL under test',
    });

    assert.equal(record.legacy_head_sequence, preHead.sequence, 'the boundary is the verified head');
    assert.equal(record.legacy_head_hash, preHead.hash);
    assert.equal(record.sequence, record.legacy_head_sequence + 1, 'the seal lands at head+1');
    assert.equal(record.sealed_by, 'creator');

    // ADR: "a blob manifest recomputed at the boundary state reproduces blob_manifest_sha256".
    assert.equal(record.blob_manifest_sha256, boundarySha);
    assert.equal(record.blob_count, boundaryManifest.length);
    assert.equal(readFileSync(join(browserExecution, 'receipt.json'), 'utf8'), 'receipt.json');

    // ADR: "a blob added after sealing changes nothing about the record".
    kernel.artifacts.putText('post-seal blob');
    const reread = kernel.mission.epoch('P0-final');
    assert.ok(reread !== null);
    assert.equal(reread.blob_manifest_sha256, record.blob_manifest_sha256);
    assert.equal(reread.blob_count, record.blob_count);
    assert.notEqual(
      sha256(Buffer.from(JSON.stringify(kernel.artifacts.manifest()), 'utf8')),
      record.blob_manifest_sha256,
      'the live store moved on; the record did not',
    );

    // A second named epoch seals cleanly; queries stay per-name and latest-overall.
    const second = kernel.mission.sealEpoch({ epochName: 'P1-open', statement: 'SEAL again' });
    assert.notEqual(second.event_id, record.event_id);
    assert.equal(kernel.mission.epoch('P0-final')?.event_id, record.event_id);
    assert.equal(kernel.mission.epoch('P1-open')?.event_id, second.event_id);
    assert.equal(kernel.mission.latestEpoch()?.event_id, second.event_id);
    assert.equal(
      [...kernel.log.replay()].filter((event) => event.type === AUTHORITY_EVENT_TYPES.epochSealed)
        .length,
      2,
      'both boundaries remain in the log',
    );
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* Refusals                                                                   */
/* ========================================================================= */

test('ADR-0006: refusals — missionless, unratified, moved-on pack, empty name/statement, duplicate', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    writePack(fixture.root);
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: 'P0-final', statement: 'x' }),
      /No mission registered/,
    );

    kernel.mission.bootstrap();
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: '  ', statement: 'x' }),
      /needs a name/,
    );
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: 'P0-final', statement: '  ' }),
      /confirmation statement/,
    );
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: 'P0-final', statement: 'x' }),
      /No ratification is in force/,
    );

    kernel.mission.ratifyInstalledAuthority({ statement: 'RATIFY under test' });

    // A governed amendment: the pack verifies internally, but the ratification covered the
    // prior seal. The epoch must refuse and prescribe re-ratification.
    writePack(fixture.root, 'amended nested content\n');
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: 'P0-final', statement: 'x' }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('the pack has moved on') &&
        error.message.includes('re-ratify'),
    );

    writePack(fixture.root); // identical arguments regenerate the ratified bytes
    kernel.mission.sealEpoch({ epochName: 'P0-final', statement: 'SEAL under test' });
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: 'P0-final', statement: 'again' }),
      /already sealed/,
    );
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('a benchmark successor needs its own ratification and a distinct evidence epoch', () => {
  const fixture = makeFixture();
  const benchmark = 'master-benchmark.md';
  const benchmarkPath = join(fixture.config.project.root, benchmark);
  writeFileSync(benchmarkPath, 'initial benchmark\n');
  const kernel = openKernel({
    ...fixture,
    config: {
      ...fixture.config,
      project: {
        ...fixture.config.project,
        inputs: { ...fixture.config.project.inputs, benchmark },
      },
    },
  });
  try {
    const initial = kernel.mission.bootstrap().mission;
    const packSha = writePack(fixture.root);
    const originalRatification = kernel.mission.ratifyInstalledAuthority({ statement: 'RATIFY initial pack' });
    const originalEpoch = kernel.mission.sealEpoch({ epochName: 'P2-authoritative', statement: 'SEAL original epoch' });

    writeFileSync(benchmarkPath, 'successor benchmark\n');
    const successor = kernel.mission.bootstrap().mission;
    assert.equal(successor.version, initial.version + 1);
    const successorEpochName = `P2-authoritative-${successor.id}`;
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: successorEpochName, statement: 'SEAL before ratification' }),
      /does not cover current mission/,
    );
    assert.equal(kernel.mission.latestEpoch()?.event_id, originalEpoch.event_id);

    const successorRatification = kernel.mission.ratifyInstalledAuthority({ statement: 'RATIFY successor pack' });
    assert.equal(successorRatification.seal_sha256, packSha);
    assert.notEqual(successorRatification.event_id, originalRatification.event_id);
    assert.equal(kernel.mission.ratification()?.event_id, successorRatification.event_id);
    assert.throws(
      () => kernel.mission.ratifyInstalledAuthority({ statement: 'RATIFY duplicate successor pack' }),
      /already ratified/,
    );
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: originalEpoch.epoch_name, statement: 'SEAL duplicate name' }),
      /already sealed/,
    );

    const successorEpoch = kernel.mission.sealEpoch({ epochName: successorEpochName, statement: 'SEAL successor epoch' });
    assert.equal(successorEpoch.ratification_event_id, successorRatification.event_id);
    assert.equal(kernel.mission.latestEpoch()?.event_id, successorEpoch.event_id);
    assert.equal(kernel.mission.epoch(originalEpoch.epoch_name)?.event_id, originalEpoch.event_id);
    assert.throws(
      () => kernel.mission.sealEpoch({ epochName: successorEpochName, statement: 'SEAL duplicate successor epoch' }),
      /already sealed/,
    );
    const evidence = [...kernel.log.replay()];
    assert.equal(evidence.find((event) => event.id === originalRatification.event_id)?.mission_version, initial.id);
    assert.equal(evidence.find((event) => event.id === successorRatification.event_id)?.mission_version, successor.id);
    assert.equal(evidence.find((event) => event.id === originalEpoch.event_id)?.mission_version, initial.id);
    assert.equal(evidence.find((event) => event.id === successorEpoch.event_id)?.mission_version, successor.id);
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* Corruption is loud — the record, and the store                             */
/* ========================================================================= */

test('ADR-0006: an epoch-typed event with a malformed payload refuses to stand as a boundary', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    kernel.mission.bootstrap();
    const missionId = kernel.mission.current()?.id;
    assert.ok(missionId !== undefined);
    kernel.log.append({
      type: AUTHORITY_EVENT_TYPES.epochSealed,
      actor: 'creator',
      missionVersion: missionId,
      subjectId: missionId,
      payload: { garbage: true },
    });
    assert.throws(() => kernel.mission.latestEpoch(), /does not satisfy epochSealSchema/);
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('ADR-0006: a tampered blob refuses the manifest, naming the offender', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    const ref = kernel.artifacts.putText('evidence bytes');
    const blobsDir = join(fixture.config.workspace.root, 'blobs');
    const hit = readdirSync(blobsDir, { recursive: true, withFileTypes: true }).find(
      (entry) => entry.isFile() && entry.name === ref.hash,
    );
    assert.ok(hit !== undefined, 'the stored blob is findable by its hash');
    const blobPath = join(hit.parentPath, hit.name);

    // ArtifactStore deliberately marks evidence read-only. The test simulates a hostile
    // out-of-band modification, so it must first remove that OS-level guard. On Windows,
    // writeFileSync otherwise fails with EPERM before manifest verification is exercised.
    chmodSync(blobPath, 0o666);
    writeFileSync(blobPath, 'tampered', 'utf8');
    assert.ok(existsSync(blobPath));

    assert.throws(
      () => kernel.artifacts.manifest(),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('do not verify') &&
        error.message.includes(ref.hash.slice(0, 16)),
      'a manifest of evidence that does not verify is not a manifest',
    );
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});
