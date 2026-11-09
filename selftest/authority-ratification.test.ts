/**
 * Installed-authority ratification acceptance (DEV-P2-05, Gate 7).
 *
 * Spec: `DOCUMENTATION_GOVERNANCE_v9.md` §14 (the reconstructed Constitution requires Creator
 *       ratification); `CLUE_Project_Directory_v9.md` §8 (mission registers authority before
 *       authoritative work).
 *
 * Turns the session's shell proofs into suite-guarded facts. Everything runs against real files
 * in a temporary directory, kernel-suite style: a synthetic pack (a constitution, a manifest, one
 * nested file) sealed by a real `SHA256SUMS_v9.txt` whose lines carry the files' actual hashes.
 * Nothing is mocked, because the failures worth catching are a seal that does not verify, a file
 * that drifted, and a payload that was written wrong.
 *
 * The corrupt-payload test appends a genuine event with garbage under the ratification type —
 * the log accepts it (payloads are opaque at the envelope), and `ratification()` must refuse to
 * let it stand as authority rather than skip past it.
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
  parsePackSeal,
} from '../src/control/mission.js';

/* ========================================================================= */
/* Fixtures                                                                   */
/* ========================================================================= */

const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

interface Fixture {
  readonly root: string;
  readonly config: ClueConfig;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'clue-ratify-'));
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

function removeFixture(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      chmodSync(join(entry.parentPath, entry.name), 0o666);
    } catch {
      /* best effort */
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

interface Kernel {
  readonly log: EventLog;
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
    mission,
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

/**
 * Writes a synthetic pack and its seal. The constitution and the manifest are always declared
 * (the service requires both); `nested/extra.txt` exercises the declared-path `/` grammar on
 * every platform. Returns the seal's own hash — the value a ratification must bind.
 */
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
/* parsePackSeal grammar                                                      */
/* ========================================================================= */

test('DEV-P2-05: parsePackSeal accepts the grammar and names each malformation', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);

  const parsed = parsePackSeal(`${a}  one.md\r\n\n${b}  dir/two.txt\n`);
  assert.ok('declared' in parsed, 'CRLF and blank lines are tolerated');
  assert.equal(parsed.declared.size, 2);
  assert.equal(parsed.declared.get('one.md'), a);
  assert.equal(parsed.declared.get('dir/two.txt'), b);

  const malformed = parsePackSeal(`${a.slice(0, 10)}  short-hash.md\n`);
  assert.ok('error' in malformed && malformed.error.includes('unparseable'));

  const duplicate = parsePackSeal(`${a}  same.md\n${b}  same.md\n`);
  assert.ok('error' in duplicate && duplicate.error.includes('duplicate'));
  const caseAlias = parsePackSeal(`${a}  same.md\n${b}  SAME.md\n`);
  assert.ok('error' in caseAlias && caseAlias.error.includes('duplicate'));
  for (const path of ['../outside.md', '/absolute.md', 'C:/outside.md', 'dir\\outside.md']) {
    const traversal = parsePackSeal(`${a}  ${path}\n`);
    assert.ok('error' in traversal && traversal.error.includes('non-portable'));
  }

  const empty = parsePackSeal('\n\n');
  assert.ok('error' in empty && empty.error.includes('declares no files'));
});

/* ========================================================================= */
/* Refusals                                                                   */
/* ========================================================================= */

test('DEV-P2-05: ratification is refused before a mission exists', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    writePack(fixture.root);
    assert.throws(
      () => kernel.mission.ratifyInstalledAuthority({ statement: 'x' }),
      /No mission registered/,
    );
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('DEV-P2-05: refusals — empty statement, absent seal, drifted file, undeclared manifest and constitution', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    kernel.mission.bootstrap();

    // Absent seal, before the pack exists at all.
    assert.throws(
      () => kernel.mission.ratifyInstalledAuthority({ statement: 'x' }),
      new RegExp(`${PACK_SEAL_FILE} absent`),
    );

    writePack(fixture.root);
    assert.throws(
      () => kernel.mission.ratifyInstalledAuthority({ statement: '   ' }),
      /confirmation statement/,
    );

    // One drifted byte refuses the act and names the file.
    writeFileSync(join(fixture.root, 'nested', 'extra.txt'), 'tampered\n', 'utf8');
    assert.throws(
      () => kernel.mission.ratifyInstalledAuthority({ statement: 'x' }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('Refusing to ratify') &&
        error.message.includes('nested/extra.txt'),
    );
    writeFileSync(join(fixture.root, 'nested', 'extra.txt'), 'nested content\n', 'utf8');

    // A seal that does not declare the manifest is not a pack seal.
    const constitution = readFileSync(join(fixture.root, 'CLUE.md'));
    writeFileSync(
      join(fixture.root, PACK_SEAL_FILE),
      `${sha256(constitution)}  CLUE.md\n`,
      'utf8',
    );
    assert.throws(
      () => kernel.mission.ratifyInstalledAuthority({ statement: 'x' }),
      new RegExp(`does not declare ${PACK_MANIFEST_FILE}`),
    );

    // A registered constitution outside the declared set is authority the pack does not govern.
    const manifest = readFileSync(join(fixture.root, PACK_MANIFEST_FILE));
    writeFileSync(
      join(fixture.root, PACK_SEAL_FILE),
      `${sha256(manifest)}  ${PACK_MANIFEST_FILE}\n`,
      'utf8',
    );
    assert.throws(
      () => kernel.mission.ratifyInstalledAuthority({ statement: 'x' }),
      /is not declared by/,
    );
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* The act, read-back, and re-ratification                                    */
/* ========================================================================= */

test('DEV-P2-05: the act binds the live seal, reads back, refuses repetition, and a new seal ratifies anew', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    kernel.mission.bootstrap();
    const sealSha = writePack(fixture.root);
    const missionId = kernel.mission.current()?.id;
    assert.ok(missionId !== undefined);

    assert.equal(kernel.mission.ratification(), null, 'no act before the act');

    const record = kernel.mission.ratifyInstalledAuthority({ statement: 'RATIFY under test' });
    assert.equal(record.seal_sha256, sealSha, 'the record binds the live seal bytes');
    assert.equal(record.declared_file_count, 3);
    assert.equal(record.ratified_by, 'creator');
    assert.equal(record.statement, 'RATIFY under test');
    assert.match(record.event_id, /^EVENT-\d+$/);

    const back = kernel.mission.ratification();
    assert.ok(back !== null);
    assert.equal(back.event_id, record.event_id);
    assert.equal(back.seal_sha256, sealSha);
    assert.equal(back.statement, record.statement);

    // The envelope: creator-attributed, bound to the mission in force.
    const events = [...kernel.log.replay()].filter(
      (event) => event.type === AUTHORITY_EVENT_TYPES.packRatified,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actor, 'creator');
    assert.equal(events[0]?.mission_version, missionId);

    assert.throws(
      () => kernel.mission.ratifyInstalledAuthority({ statement: 'again' }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('already ratified') &&
        error.message.includes(record.event_id),
    );

    // A governed amendment: file and seal move together; the new state ratifies as a new event.
    const newSealSha = writePack(fixture.root, 'amended nested content\n');
    assert.notEqual(newSealSha, sealSha);
    const second = kernel.mission.ratifyInstalledAuthority({ statement: 'RATIFY amended' });
    assert.equal(second.seal_sha256, newSealSha);
    assert.notEqual(second.event_id, record.event_id);

    const latest = kernel.mission.ratification();
    assert.equal(latest?.event_id, second.event_id, 'latest act wins on read-back');
    assert.equal(
      [...kernel.log.replay()].filter((event) => event.type === AUTHORITY_EVENT_TYPES.packRatified)
        .length,
      2,
      'both acts remain in the log',
    );
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* Corruption is loud                                                         */
/* ========================================================================= */

test('DEV-P2-05: a ratification-typed event with a malformed payload refuses to stand as authority', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    kernel.mission.bootstrap();
    const missionId = kernel.mission.current()?.id;
    assert.ok(missionId !== undefined);

    kernel.log.append({
      type: AUTHORITY_EVENT_TYPES.packRatified,
      actor: 'creator',
      missionVersion: missionId,
      subjectId: missionId,
      payload: { garbage: true },
    });

    assert.throws(
      () => kernel.mission.ratification(),
      /does not satisfy packRatificationSchema/,
    );
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});
