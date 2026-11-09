/**
 * CLUE Stage A acceptance suite.
 *
 * Spec: CLUE_implementation.md §19.9 (instruments ship healthy and broken fixtures),
 *       §66 (a validator must be silent on known-good content before it may condemn).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.2, Part V Stage A gate, Part X §36.
 *
 * The Stage A gate has four clauses, and each has a test here that fails if the clause
 * stops holding:
 *
 *   1. restart loses no mission state          → "mission survives a full restart"
 *   2. artifact round-trip verified by hash    → "artifact store" group
 *   3. event replay rebuilds projections       → "projections rebuild identically"
 *   4. a canonical write is denied and audited → "policy" and "audit" groups
 *
 * Everything here runs against real files in a temporary directory. Nothing is mocked,
 * because the failures worth catching in this layer are filesystem failures — a lock
 * that is not released, a torn write, a read-only blob that cannot be replaced.
 *
 * Run: npm run selftest
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname, tmpdir } from 'node:os';

import {
  blobRelativePath,
  canonicalJson,
  hashText,
  makeEntityId,
  makeSnapshotId,
  parseEntityId,
  requireSha256,
} from '../src/shared/ids.js';
import { clueConfigSchema, type ClueConfig } from '../src/shared/schemas.js';
import { ArtifactStore, ArtifactStoreError } from '../src/memory/artifactStore.js';
import { EventLog, EventLogError } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import { AuditLog, AuditLogError, AuditedDispatcher, PolicyDenialError } from '../src/control/audit.js';
import {
  EvidenceChainError,
  verifyChain as verifyEvidenceChain,
  type MissionBasisHash,
} from '../src/shared/evidenceIdentity.js';
import { MissionRegistry } from '../src/control/mission.js';
import { SnapshotRegistry, SNAPSHOT_PROJECTORS } from '../src/analysis/source/snapshot.js';
import { GraphRegistry, GRAPH_PROJECTORS } from '../src/analysis/source/graph.js';
import { SCAN_CACHE_PROJECTORS } from '../src/analysis/source/scanCache.js';
import { recognize } from '../src/analysis/source/recognizer.js';
import { TaskQueue, TASK_PROJECTORS } from '../src/control/tasks.js';
import { ContextBuilder, type BuildOptions } from '../src/control/contextBuilder.js';
import { z } from 'zod';
import {
  OutputSchemaRegistry,
  SessionPacketService,
  PACKET_PROJECTORS,
  hostReceiptHashOf,
} from '../src/control/sessionPackets.js';
import { CAPABILITIES, DEFAULT_GRANTS, PolicyEngine, SecretRegistry } from '../src/control/policy.js';

/* ========================================================================= */
/* Fixtures                                                                   */
/* ========================================================================= */

const CONSTITUTION_TEXT = '# CLUE\n\nThe constitution, for test purposes.\n';
const SPEC_TEXT = '# CLUE implementation\n\nThe architecture, for test purposes.\n';
const STRATEGY_TEXT = '# CLUE strategy\n\nThe plan, for test purposes.\n';

interface Fixture {
  readonly root: string;
  readonly config: ClueConfig;
}

function makeFixture(overrides: { custodianWrites?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'clue-selftest-'));

  writeFileSync(join(root, 'CLUE.md'), CONSTITUTION_TEXT, 'utf8');
  writeFileSync(join(root, 'CLUE_implementation.md'), SPEC_TEXT, 'utf8');
  writeFileSync(join(root, 'CLUE_Implementation_Strategy.md'), STRATEGY_TEXT, 'utf8');

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
    constitution: {
      file: 'CLUE.md',
      tracked_documents: ['CLUE.md', 'CLUE_implementation.md', 'CLUE_Implementation_Strategy.md'],
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
      canonical_source_writes: overrides.custodianWrites === true ? 'custodian_only' : 'denied',
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

/**
 * Removes a fixture tree.
 *
 * Stored blobs are marked read-only on purpose, and on Windows a read-only file cannot
 * be deleted. Restoring write permission first is a test-harness concern only; it must
 * not become a reason to weaken the store.
 */
function removeFixture(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      chmodSync(join(entry.parentPath, entry.name), 0o666);
    } catch {
      // Best effort; rmSync reports anything that genuinely cannot be removed.
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

interface Kernel {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
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
    projections,
    artifacts,
    mission,
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

/** Canonical dump of every projection table, for equality comparison across rebuilds. */
function dumpProjections(store: ProjectionStore): string {
  return canonicalJson({
    events: store.db.prepare('SELECT * FROM events_index ORDER BY sequence').all(),
    missions: store.db.prepare('SELECT * FROM mission_versions ORDER BY version').all(),
    artifacts: store.db.prepare('SELECT * FROM artifacts ORDER BY hash').all(),
  });
}

/* ========================================================================= */
/* shared/ids                                                                 */
/* ========================================================================= */

test('canonical JSON is independent of key insertion order', () => {
  assert.equal(canonicalJson({ a: 1, b: [2, 3] }), canonicalJson({ b: [2, 3], a: 1 }));
});

test('canonical JSON drops undefined properties but preserves array order', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('canonical JSON refuses values that could never be verified later', () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), /Non-finite/);
  assert.throws(() => canonicalJson({ value: 1n }), /BigInt/);
});

test('snapshot identity ignores walk order', () => {
  const a = { path: 'src/a.ts', hash: hashText('a') };
  const b = { path: 'src/b.ts', hash: hashText('b') };
  assert.equal(makeSnapshotId([a, b]), makeSnapshotId([b, a]));
});

test('snapshot identity changes when any file changes', () => {
  const base = [{ path: 'src/a.ts', hash: hashText('a') }];
  const changed = [{ path: 'src/a.ts', hash: hashText('a2') }];
  assert.notEqual(makeSnapshotId(base), makeSnapshotId(changed));
});

test('snapshot identity reports case-only collisions instead of folding them', () => {
  assert.throws(
    () =>
      makeSnapshotId([
        { path: 'src/A.ts', hash: hashText('a') },
        { path: 'src/a.ts', hash: hashText('b') },
      ]),
    /Case-only path collision/,
  );
});

test('entity identifiers round-trip and stay sortable', () => {
  const id = makeEntityId('task', 123);
  assert.equal(id, 'TASK-000123');
  assert.deepEqual(parseEntityId(id), { kind: 'task', sequence: 123 });
  assert.equal(parseEntityId('NOPE-000001'), undefined);
  assert.ok(makeEntityId('task', 9) < makeEntityId('task', 10));
});

test('blob paths fan out from the hash and remain reversible', () => {
  const hash = hashText('content');
  assert.equal(blobRelativePath(hash), `sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`);
});

/* ========================================================================= */
/* Artifact store — Stage A gate 2                                            */
/* ========================================================================= */

test('artifact store round-trips content by hash', () => {
  const fixture = makeFixture();
  try {
    const store = new ArtifactStore(join(fixture.config.workspace.root, 'blobs'));
    const ref = store.putText('probe report', { label: 'report.txt' });

    assert.equal(ref.hash, hashText('probe report'));
    assert.equal(store.getText(requireSha256(ref.hash, 'ref')), 'probe report');
    assert.equal(store.sizeOf(requireSha256(ref.hash, 'ref')), ref.bytes);
    assert.ok(store.verifyOne(requireSha256(ref.hash, 'ref')));
  } finally {
    removeFixture(fixture.root);
  }
});

test('identical content is stored once, and canonical JSON dedupes by structure', () => {
  const fixture = makeFixture();
  try {
    const store = new ArtifactStore(join(fixture.config.workspace.root, 'blobs'));
    const first = store.putJson({ a: 1, b: 2 });
    const second = store.putJson({ b: 2, a: 1 });

    assert.equal(first.hash, second.hash);
    assert.equal(store.verifyAll().checked, 1);
  } finally {
    removeFixture(fixture.root);
  }
});

test('a modified blob is refused on read rather than trusted', () => {
  const fixture = makeFixture();
  try {
    const store = new ArtifactStore(join(fixture.config.workspace.root, 'blobs'));
    const ref = store.putText('original evidence');
    const hash = requireSha256(ref.hash, 'ref');
    const path = store.pathFor(hash);

    chmodSync(path, 0o666);
    writeFileSync(path, 'tampered evidence', 'utf8');

    assert.throws(
      () => store.getBytes(hash),
      (error: unknown) =>
        error instanceof ArtifactStoreError && error.code === 'HASH_MISMATCH',
    );
    assert.equal(store.verifyAll().mismatched.length, 1);
  } finally {
    removeFixture(fixture.root);
  }
});

/* ------------------------------------------------------------------------- */
/* DEV-P1-02: artifact-store durability                                       */
/* ------------------------------------------------------------------------- */

test('DEV-P1-02: a large file is captured whole and verifies (checked writeAll on copy)', () => {
  const fixture = makeFixture();
  try {
    const store = new ArtifactStore(join(fixture.config.workspace.root, 'blobs'));
    const source = join(fixture.config.workspace.root, 'big.bin');
    const payload = Buffer.alloc(2 * 1024 * 1024, 7); // 2 MiB spans many copy chunks
    writeFileSync(source, payload);

    const ref = store.putFile(source, { label: 'big' });
    assert.equal(ref.bytes, payload.length);
    const stored = store.getBytes(requireSha256(ref.hash, 'ref'));
    assert.ok(stored.equals(payload));
    assert.ok(store.verifyOne(requireSha256(ref.hash, 'ref')));
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-02: identical content from two sources dedupes without replacing the blob', () => {
  const fixture = makeFixture();
  try {
    const store = new ArtifactStore(join(fixture.config.workspace.root, 'blobs'));
    const a = join(fixture.config.workspace.root, 'a.bin');
    const b = join(fixture.config.workspace.root, 'b.bin');
    const payload = Buffer.from('identical evidence bytes');
    writeFileSync(a, payload);
    writeFileSync(b, payload);

    const first = store.putFile(a);
    const second = store.putFile(b); // takes the no-replace 'exists' path on the second call
    assert.equal(first.hash, second.hash);
    assert.equal(store.verifyAll().mismatched.length, 0);
    assert.ok(store.verifyOne(requireSha256(first.hash, 'ref')));
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-02: export atomically replaces an existing destination and stays writable', () => {
  const fixture = makeFixture();
  try {
    const store = new ArtifactStore(join(fixture.config.workspace.root, 'blobs'));
    const ref = store.putText('exported evidence', { label: 'e' });
    const hash = requireSha256(ref.hash, 'ref');
    const dest = join(fixture.config.workspace.root, 'out', 'evidence.txt');

    // A destination that already exists must be replaced, not rejected (uniform on all OSes).
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, 'stale contents that must be overwritten');
    store.exportTo(hash, dest);
    assert.equal(readFileSync(dest, 'utf8'), 'exported evidence');

    // Re-exporting over the now-existing file also succeeds.
    store.exportTo(hash, dest);
    assert.equal(readFileSync(dest, 'utf8'), 'exported evidence');

    // The exported copy is writable, unlike the stored (read-only) blob.
    writeFileSync(dest, 'locally editable', 'utf8');
    assert.equal(readFileSync(dest, 'utf8'), 'locally editable');
  } finally {
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* Event log                                                                  */
/* ========================================================================= */

function appendSample(log: EventLog, count: number): void {
  for (let index = 0; index < count; index += 1) {
    log.append({
      type: 'test.sample',
      actor: 'daemon',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: { index },
    });
  }
}

test('event log chains records and verifies the whole chain', () => {
  const fixture = makeFixture();
  try {
    const { log } = EventLog.open(join(fixture.config.workspace.root, 'events'));
    try {
      appendSample(log, 5);
      const head = log.getHead();
      assert.equal(head?.sequence, 4);

      const replayed = [...log.replay()];
      assert.equal(replayed.length, 5);
      assert.equal(replayed[0]?.previous_hash, null);
      assert.equal(replayed[1]?.previous_hash, replayed[0]?.hash);
      assert.equal(log.verify().records, 5);
    } finally {
      log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('event log reopens after close — the lock is released, not merely closed', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const first = EventLog.open(eventsDir);
    appendSample(first.log, 3);
    first.log.close();

    // Revision 1 failed here: the lock file survived close, and its recorded PID was
    // this very process, so reopening looked like a live second writer.
    const second = EventLog.open(eventsDir);
    try {
      assert.equal(second.log.getHead()?.sequence, 2);
      appendSample(second.log, 1);
      assert.equal(second.log.getHead()?.sequence, 3);
    } finally {
      second.log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('a second concurrent writer is refused', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const first = EventLog.open(eventsDir);
    try {
      assert.throws(
        () => EventLog.open(eventsDir),
        (error: unknown) => error instanceof EventLogError && error.code === 'LOCKED',
      );
    } finally {
      first.log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('an unterminated final line is discarded, and nothing committed is lost', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const first = EventLog.open(eventsDir);
    appendSample(first.log, 3);
    first.log.close();

    const torn = '{"id":"EVENT-000003","sequence":3,"partial":';
    appendFileSync(join(eventsDir, 'events.ndjson'), torn);

    const second = EventLog.open(eventsDir, { verifyOnOpen: 'full' });
    try {
      assert.equal(second.report.repairedBytes, Buffer.byteLength(torn, 'utf8'));
      assert.equal(second.log.getHead()?.sequence, 2);
      assert.equal(second.log.verify().records, 3);
    } finally {
      second.log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('an edited committed record is detected on full verification', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const first = EventLog.open(eventsDir);
    appendSample(first.log, 3);
    first.log.close();

    const filePath = join(eventsDir, 'events.ndjson');
    const tampered = readFileSync(filePath, 'utf8').replace('"test.sample"', '"test.altered"');
    writeFileSync(filePath, tampered, 'utf8');

    assert.throws(
      () => EventLog.open(eventsDir, { verifyOnOpen: 'full' }),
      (error: unknown) => error instanceof EventLogError && error.code === 'HASH_MISMATCH',
    );
  } finally {
    removeFixture(fixture.root);
  }
});

/* ------------------------------------------------------------------------- */
/* DEV-P1-01: durable-recovery hardening                                      */
/* ------------------------------------------------------------------------- */

function lockPathFor(eventsDir: string): string {
  return join(eventsDir, 'events.ndjson.lock');
}

function writeLockFile(eventsDir: string, owner: Record<string, unknown>): void {
  writeFileSync(lockPathFor(eventsDir), `${JSON.stringify(owner)}\n`, 'utf8');
}

test('DEV-P1-01: a large payload is written whole and verifies (checked writeAll)', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const { log, report } = EventLog.open(eventsDir);
    try {
      assert.equal(report.recoveryReceiptPath, null); // a clean open writes no receipt
      const big = 'x'.repeat(2 * 1024 * 1024); // 2 MiB spans many write chunks
      log.append({
        type: 'test.big',
        actor: 'daemon',
        missionVersion: 'MISSION-000001',
        subjectId: null,
        payload: { big },
      });
      appendSample(log, 1);
      assert.equal(log.getHead()?.sequence, 1);

      const replayed = [...log.replay()];
      assert.equal(replayed.length, 2);
      const first = replayed[0];
      assert.ok(first);
      assert.equal((first.payload as { big: string }).big.length, big.length);
      assert.equal(log.verify().records, 2);
    } finally {
      log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-01: a stale lock from a dead process is reclaimed with a durable receipt', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const seed = EventLog.open(eventsDir);
    appendSample(seed.log, 2);
    seed.log.close();

    // Above Linux pid_max: process.kill(pid, 0) throws ESRCH, so the holder is provably dead.
    const deadPid = 2147483647;
    writeLockFile(eventsDir, {
      pid: deadPid,
      ownerToken: 'dead-owner',
      host: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      startTime: '1',
    });

    const { log, report } = EventLog.open(eventsDir);
    try {
      assert.equal(report.staleLockReclaimed, true);
      assert.equal(report.reclaimedFrom?.pid, deadPid);
      assert.equal(report.reclaimedFrom?.ownerToken, 'dead-owner');
      assert.notEqual(report.recoveryReceiptPath, null);
      const receiptPath = report.recoveryReceiptPath as string;
      assert.ok(existsSync(receiptPath));
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
      assert.equal(receipt['schema'], 'clue.eventlog.recovery/1');
      assert.equal(receipt['staleLockReclaimed'], true);
      assert.equal((receipt['reclaimedFrom'] as { pid: number }).pid, deadPid);

      // The reclaimer genuinely holds the lock: a second opener in this process is refused.
      assert.throws(
        () => EventLog.open(eventsDir),
        (error: unknown) => error instanceof EventLogError && error.code === 'LOCKED',
      );
    } finally {
      log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test(
  'DEV-P1-01: a recycled PID (same pid, different start time) is reclaimed',
  { skip: process.platform !== 'linux' ? 'requires /proc process start time' : false },
  () => {
    const fixture = makeFixture();
    const eventsDir = join(fixture.config.workspace.root, 'events');
    try {
      const seed = EventLog.open(eventsDir);
      appendSample(seed.log, 1);
      seed.log.close();

      // The PID is this live process, but the recorded start time cannot match: the PID
      // was recycled, so the recorded holder is not our writer and the lock is stale.
      writeLockFile(eventsDir, {
        pid: process.pid,
        ownerToken: 'recycled',
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        startTime: 'not-the-real-start-time',
      });

      const { log, report } = EventLog.open(eventsDir);
      try {
        assert.equal(report.staleLockReclaimed, true);
        assert.equal(report.reclaimedFrom?.ownerToken, 'recycled');
      } finally {
        log.close();
      }
    } finally {
      removeFixture(fixture.root);
    }
  },
);

test('DEV-P1-01: a torn-tail repair writes a receipt recording the discarded bytes', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const first = EventLog.open(eventsDir);
    appendSample(first.log, 3);
    first.log.close();

    const torn = '{"id":"EVENT-000003","sequence":3,"partial":';
    appendFileSync(join(eventsDir, 'events.ndjson'), torn);

    const { log, report } = EventLog.open(eventsDir, { verifyOnOpen: 'full' });
    try {
      assert.equal(report.repairedBytes, Buffer.byteLength(torn, 'utf8'));
      assert.notEqual(report.discardedTailSha256, null);
      assert.notEqual(report.recoveryReceiptPath, null);
      const receipt = JSON.parse(readFileSync(report.recoveryReceiptPath as string, 'utf8')) as Record<
        string,
        unknown
      >;
      assert.equal(receipt['schema'], 'clue.eventlog.recovery/1');
      assert.equal(receipt['repairedBytes'], report.repairedBytes);
      assert.equal(receipt['discardedTailSha256'], report.discardedTailSha256);
    } finally {
      log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-01: a periodic checkpoint is sealed and reused as a trust anchor', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const { log } = EventLog.open(eventsDir, { checkpointEveryAppends: 4 });
    try {
      appendSample(log, 4); // crossing the threshold seals a checkpoint
      assert.ok(existsSync(join(eventsDir, 'checkpoint.json')));
      const checkpoint = log.readCheckpoint();
      assert.equal(checkpoint?.head?.sequence, 3);
      assert.equal(checkpoint?.records, 4);
    } finally {
      log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-01: a committed head behind a durable checkpoint is refused', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  const filePath = join(eventsDir, 'events.ndjson');
  try {
    const first = EventLog.open(eventsDir);
    appendSample(first.log, 5);
    first.log.checkpoint(); // seals head at sequence 4 (5 records)
    first.log.close();

    // Simulate loss of committed history: keep only the first three committed lines.
    const kept = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(0, 3);
    writeFileSync(filePath, `${kept.join('\n')}\n`, 'utf8');

    assert.throws(
      () => EventLog.open(eventsDir),
      (error: unknown) => error instanceof EventLogError && error.code === 'CHECKPOINT_CONFLICT',
    );
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-01: heartbeat refuses once lock ownership is superseded', () => {
  const fixture = makeFixture();
  const eventsDir = join(fixture.config.workspace.root, 'events');
  try {
    const { log } = EventLog.open(eventsDir);
    try {
      log.heartbeat(); // we own it

      // Another writer overwrites the lock with a different ownership token.
      writeLockFile(eventsDir, {
        pid: process.pid,
        ownerToken: 'someone-else',
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        startTime: '1',
      });

      assert.throws(
        () => log.heartbeat(),
        (error: unknown) => error instanceof EventLogError && error.code === 'LOCKED',
      );
    } finally {
      log.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* Projections — Stage A gate 3                                               */
/* ========================================================================= */

test('projections rebuild identically after the database is deleted', () => {
  const fixture = makeFixture();
  try {
    const kernel = openKernel(fixture);
    kernel.mission.bootstrap();
    const before = dumpProjections(kernel.projections);
    const databasePath = join(fixture.config.workspace.root, 'db', 'clue.db');
    kernel.dispose();

    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
    assert.equal(existsSync(databasePath), false);

    const rebuilt = openKernel(fixture);
    try {
      const result = rebuilt.projections.sync(rebuilt.log);
      assert.equal(result.rebuilt, true);
      assert.equal(dumpProjections(rebuilt.projections), before);
    } finally {
      rebuilt.dispose();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('projections report staleness when the log has moved ahead', () => {
  const fixture = makeFixture();
  try {
    const kernel = openKernel(fixture);
    try {
      kernel.mission.bootstrap();
      assert.equal(kernel.projections.isStale(kernel.log), false);

      appendSample(kernel.log, 1);
      assert.equal(kernel.projections.isStale(kernel.log), true);

      kernel.projections.sync(kernel.log);
      assert.equal(kernel.projections.isStale(kernel.log), false);
    } finally {
      kernel.dispose();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

/* ========================================================================= */
/* Mission — Stage A gate 1                                                   */
/* ========================================================================= */

test('mission survives a full restart', () => {
  const fixture = makeFixture();
  try {
    const first = openKernel(fixture);
    const registered = first.mission.bootstrap();
    assert.equal(registered.change, 'initial');
    assert.equal(registered.mission.version, 1);
    first.dispose();

    const second = openKernel(fixture);
    try {
      const current = second.mission.current();
      assert.equal(current?.id, registered.mission.id);
      assert.equal(current?.constitution_hash, hashText(CONSTITUTION_TEXT));
      assert.equal(second.mission.documentText(registered.mission.id, 'CLUE.md'), CONSTITUTION_TEXT);
    } finally {
      second.dispose();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('bootstrap is idempotent for an unchanged repository', () => {
  const fixture = makeFixture();
  try {
    const kernel = openKernel(fixture);
    try {
      kernel.mission.bootstrap();
      const again = kernel.mission.bootstrap();
      assert.equal(again.change, 'unchanged');
      assert.equal(kernel.mission.history().length, 1);
    } finally {
      kernel.dispose();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('editing the constitution creates a constitutional version; editing a guide does not', () => {
  const fixture = makeFixture();
  try {
    const kernel = openKernel(fixture);
    try {
      const first = kernel.mission.bootstrap();

      writeFileSync(join(fixture.root, 'CLUE_Implementation_Strategy.md'), '# revised\n', 'utf8');
      const architectural = kernel.mission.bootstrap();
      assert.equal(architectural.change, 'architectural');
      assert.deepEqual(architectural.changedDocuments, ['CLUE_Implementation_Strategy.md']);

      writeFileSync(join(fixture.root, 'CLUE.md'), '# CLUE\n\nAmended.\n', 'utf8');
      const constitutional = kernel.mission.bootstrap();
      assert.equal(constitutional.change, 'constitutional');
      assert.equal(constitutional.mission.version, 3);

      assert.equal(kernel.mission.isCurrent(first.mission.id), false);
      assert.equal(kernel.mission.constitutionChangedSince(first.mission.id), true);
    } finally {
      kernel.dispose();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('amendment A2 follows configuration, not prose', () => {
  const plain = makeFixture();
  const amended = makeFixture({ custodianWrites: true });
  try {
    const withoutAmendment = openKernel(plain);
    try {
      const result = withoutAmendment.mission.bootstrap();
      assert.equal(result.mission.amendments.length, 0);
    } finally {
      withoutAmendment.dispose();
    }

    const withAmendment = openKernel(amended);
    try {
      const result = withAmendment.mission.bootstrap();
      assert.deepEqual(
        result.mission.amendments.map((amendment) => amendment.code),
        ['A2'],
      );
      assert.deepEqual(result.amendmentDelta, ['+A2']);
    } finally {
      withAmendment.dispose();
    }
  } finally {
    removeFixture(plain.root);
    removeFixture(amended.root);
  }
});

/* ========================================================================= */
/* Policy — Stage A gate 4                                                    */
/* ========================================================================= */

test('no capability grants a filesystem write inside the canonical tree', () => {
  const fixture = makeFixture({ custodianWrites: true });
  try {
    const policy = new PolicyEngine(fixture.config);
    const token = policy.issueToken('custodian', DEFAULT_GRANTS.custodian);
    const canonicalFile = join(fixture.config.project.root, 'src', 'renderer.ts');

    const allowed = CAPABILITIES.filter(
      (capability) =>
        policy.evaluate({
          actor: 'custodian',
          capability,
          command: 'sweep',
          target: canonicalFile,
          tokenSecret: token.secret,
        }).decision === 'allowed',
    );

    // Reads and the landing operation may touch the canonical tree. A write never may,
    // whatever token is held — this assertion is what keeps amendment A2 narrow.
    assert.equal(
      allowed.some((capability) => capability.includes('.write.')),
      false,
      `write capability allowed on canonical path: ${allowed.join(', ')}`,
    );
    assert.ok(allowed.includes('git.land.canonical'));
  } finally {
    removeFixture(fixture.root);
  }
});

test('zone rules are enforced before tokens are even considered', () => {
  const fixture = makeFixture();
  try {
    const policy = new PolicyEngine(fixture.config);
    const decision = policy.evaluate({
      actor: 'daemon',
      capability: 'fs.write.workspace',
      command: 'fs.writeFile',
      target: join(fixture.config.project.root, 'src', 'renderer.ts'),
      tokenSecret: null,
    });

    assert.equal(decision.decision, 'denied');
    assert.equal(decision.code, 'ZONE_MISMATCH');
    assert.equal(decision.zone, 'canonical');
  } finally {
    removeFixture(fixture.root);
  }
});

test('landing requires both the amendment and the custodian', () => {
  const withoutAmendment = makeFixture();
  const withAmendment = makeFixture({ custodianWrites: true });
  try {
    const denied = new PolicyEngine(withoutAmendment.config);
    const deniedToken = denied.issueToken('custodian', ['git.land.canonical']);
    assert.equal(
      denied.evaluate({
        actor: 'custodian',
        capability: 'git.land.canonical',
        command: 'git.merge',
        target: withoutAmendment.config.project.root,
        tokenSecret: deniedToken.secret,
      }).code,
      'LANDING_NOT_AUTHORISED',
    );

    const enabled = new PolicyEngine(withAmendment.config);
    const custodianToken = enabled.issueToken('custodian', ['git.land.canonical']);
    assert.equal(
      enabled.evaluate({
        actor: 'custodian',
        capability: 'git.land.canonical',
        command: 'git.merge',
        target: withAmendment.config.project.root,
        tokenSecret: custodianToken.secret,
      }).decision,
      'allowed',
    );

    assert.equal(
      enabled.evaluate({
        actor: 'daemon',
        capability: 'git.land.canonical',
        command: 'git.merge',
        target: withAmendment.config.project.root,
        tokenSecret: custodianToken.secret,
      }).code,
      'LANDING_WRONG_ACTOR',
    );
  } finally {
    removeFixture(withoutAmendment.root);
    removeFixture(withAmendment.root);
  }
});

test('expired and foreign tokens are refused', () => {
  const fixture = makeFixture();
  try {
    const policy = new PolicyEngine(fixture.config);
    const expired = policy.issueToken('daemon', ['fs.read.workspace'], { ttlMs: -1 });
    const request = {
      actor: 'daemon' as const,
      capability: 'fs.read.workspace' as const,
      command: 'fs.readFile',
      target: join(fixture.config.workspace.root, 'db'),
    };

    assert.equal(policy.evaluate({ ...request, tokenSecret: expired.secret }).code, 'TOKEN_EXPIRED');
    assert.equal(policy.evaluate({ ...request, tokenSecret: 'invented' }).code, 'TOKEN_UNKNOWN');
    assert.equal(policy.evaluate({ ...request, tokenSecret: null }).code, 'NO_TOKEN');
  } finally {
    removeFixture(fixture.root);
  }
});

test('real settlement is refused permanently, before any other rule', () => {
  const fixture = makeFixture({ custodianWrites: true });
  try {
    const policy = new PolicyEngine(fixture.config);
    const decision = policy.evaluate({
      actor: 'creator',
      capability: 'settlement.real',
      command: 'neo.transfer',
    });
    assert.equal(decision.code, 'PERMANENTLY_DENIED');
  } finally {
    removeFixture(fixture.root);
  }
});

test('registered secrets are redacted and refused at write boundaries', () => {
  const secrets = new SecretRegistry();
  process.env['CLUE_SELFTEST_KEY'] = 'sk-selftest-abcdefghijklmnop';
  try {
    assert.equal(secrets.registerFromEnv('CLUE_SELFTEST_KEY'), true);

    const text = 'Authorization: sk-selftest-abcdefghijklmnop';
    assert.equal(secrets.containsSecret(text), true);
    assert.equal(secrets.redact(text).includes('sk-selftest-abcdefghijklmnop'), false);
    assert.throws(() => secrets.assertClean(text, 'context pack'), /registered secret/);

    // A credential CLUE was never told about still gets caught by shape.
    assert.equal(secrets.redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345').includes('ghp_'), false);
  } finally {
    delete process.env['CLUE_SELFTEST_KEY'];
  }
});

/* ========================================================================= */
/* Audit — Stage A gate 4                                                     */
/* ========================================================================= */

test('a denied command is recorded, and the work never runs', () => {
  const fixture = makeFixture();
  try {
    const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'clue.db'));
    try {
      const secrets = new SecretRegistry();
      const policy = new PolicyEngine(fixture.config, secrets);
      const audit = new AuditLog(join(fixture.config.workspace.root, 'logs'), projections, secrets);
      const dispatcher = new AuditedDispatcher(policy, audit, () => 'MISSION-000001');

      let executed = false;
      assert.throws(
        () =>
          dispatcher.run(
            {
              actor: 'daemon',
              capability: 'fs.write.workspace',
              command: 'fs.writeFile',
              target: join(fixture.config.project.root, 'src', 'renderer.ts'),
              args: { bytes: 42 },
            },
            () => {
              executed = true;
              return true;
            },
          ),
        (error: unknown) => error instanceof PolicyDenialError && error.code === 'ZONE_MISMATCH',
      );

      assert.equal(executed, false);
      const denials = audit.denials(10);
      assert.equal(denials.length, 1);
      assert.equal(denials[0]?.command, 'fs.writeFile');
      assert.equal(denials[0]?.decision, 'denied');
      // Arguments are proved by digest, never stored in the clear.
      assert.equal(denials[0]?.arguments_digest.length, 64);
    } finally {
      projections.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('an authorised command records its decision before the work, and its outcome after', () => {
  const fixture = makeFixture();
  try {
    const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'clue.db'));
    try {
      const secrets = new SecretRegistry();
      const policy = new PolicyEngine(fixture.config, secrets);
      const audit = new AuditLog(join(fixture.config.workspace.root, 'logs'), projections, secrets);
      const dispatcher = new AuditedDispatcher(policy, audit, () => 'MISSION-000001');
      const token = policy.issueToken('daemon', ['fs.read.workspace']);

      assert.throws(() =>
        dispatcher.run(
          {
            actor: 'daemon',
            capability: 'fs.read.workspace',
            command: 'fs.readFile',
            target: join(fixture.config.workspace.root, 'db'),
            tokenSecret: token.secret,
          },
          () => {
            throw new Error('probe exploded');
          },
        ),
      );

      const commands = audit.tail(10).map((entry) => entry.command);
      assert.ok(commands.includes('fs.readFile'), 'decision recorded before the work ran');
      assert.ok(commands.includes('fs.readFile:failed'), 'failure recorded after the work ran');
    } finally {
      projections.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('the audit index rebuilds from the file, which is the authority', () => {
  const fixture = makeFixture();
  try {
    const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'clue.db'));
    try {
      const secrets = new SecretRegistry();
      const audit = new AuditLog(join(fixture.config.workspace.root, 'logs'), projections, secrets);

      for (let index = 0; index < 4; index += 1) {
        audit.record({
          actor: 'cli',
          command: `probe.${index}`,
          capability: 'fs.read.workspace',
          decision: 'allowed',
          missionVersion: 'MISSION-000001',
        });
      }

      projections.db.prepare('DELETE FROM audit_entries').run();
      assert.equal(audit.tail(10).length, 0);
      assert.equal(audit.reindex(), 4);
      assert.equal(audit.tail(10).length, 4);

      const logFile = join(fixture.config.workspace.root, 'logs', 'audit.ndjson');
      assert.ok(statSync(logFile).size > 0);
    } finally {
      projections.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

/* ------------------------------------------------------------------------- */
/* DEV-P1-03: audit chain, execution ids, async dispatch, archive manifest    */
/* ------------------------------------------------------------------------- */

function readAuditEntries(workspaceRoot: string): Array<Record<string, unknown>> {
  const file = join(workspaceRoot, 'logs', 'audit.ndjson');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('DEV-P1-03: the audit file is hash-chained and a mid-history edit is detected', () => {
  const fixture = makeFixture();
  try {
    const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'clue.db'));
    try {
      const secrets = new SecretRegistry();
      const ws = fixture.config.workspace.root;
      const audit = new AuditLog(join(ws, 'logs'), projections, secrets);
      for (let i = 0; i < 4; i += 1) {
        audit.record({
          actor: 'cli',
          command: `probe.${i}`,
          capability: 'fs.read.workspace',
          decision: 'allowed',
          missionVersion: 'MISSION-000001',
        });
      }

      const entries = readAuditEntries(ws);
      assert.equal(entries.length, 4);
      assert.ok(entries.every((entry) => typeof entry['execution_id'] === 'string'));
      assert.equal(entries[0]?.['previous_hash'], null);
      assert.equal(entries[1]?.['previous_hash'], entries[0]?.['hash']);
      assert.equal(audit.verifyChain().records, 4);

      // Tamper with a committed record: both verifyChain and reindex refuse it.
      const file = join(ws, 'logs', 'audit.ndjson');
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
      const second = lines[1];
      assert.ok(second);
      lines[1] = second.replace('probe.1', 'probe.9');
      writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

      assert.throws(
        () => audit.verifyChain(),
        (error: unknown) => error instanceof AuditLogError && error.code === 'HASH_MISMATCH',
      );
      assert.throws(
        () => audit.reindex(),
        (error: unknown) => error instanceof AuditLogError && error.code === 'HASH_MISMATCH',
      );
    } finally {
      projections.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-03: one operation start and completion share an execution id', () => {
  const fixture = makeFixture();
  try {
    const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'clue.db'));
    try {
      const secrets = new SecretRegistry();
      const ws = fixture.config.workspace.root;
      const policy = new PolicyEngine(fixture.config, secrets);
      const audit = new AuditLog(join(ws, 'logs'), projections, secrets);
      const dispatcher = new AuditedDispatcher(policy, audit, () => 'MISSION-000001');
      const token = policy.issueToken('daemon', ['fs.read.workspace']);

      const result = dispatcher.run(
        {
          actor: 'daemon',
          capability: 'fs.read.workspace',
          command: 'fs.readFile',
          target: join(ws, 'db'),
          tokenSecret: token.secret,
        },
        () => 'value',
      );
      assert.equal(result, 'value');

      const entries = readAuditEntries(ws);
      const start = entries.find((entry) => entry['command'] === 'fs.readFile');
      const done = entries.find((entry) => entry['command'] === 'fs.readFile:completed');
      assert.ok(start && done);
      assert.equal(start['execution_id'], done['execution_id']);
      assert.ok(typeof start['execution_id'] === 'string' && (start['execution_id'] as string).length > 0);
    } finally {
      projections.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-03: runAsync records completion when the promise settles, and run refuses async work', async () => {
  const fixture = makeFixture();
  try {
    const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'clue.db'));
    try {
      const secrets = new SecretRegistry();
      const ws = fixture.config.workspace.root;
      const policy = new PolicyEngine(fixture.config, secrets);
      const audit = new AuditLog(join(ws, 'logs'), projections, secrets);
      const dispatcher = new AuditedDispatcher(policy, audit, () => 'MISSION-000001');
      const token = policy.issueToken('daemon', ['fs.read.workspace']);
      const target = join(ws, 'db');

      let settled = false;
      const value = await dispatcher.runAsync(
        { actor: 'daemon', capability: 'fs.read.workspace', command: 'fs.readFile', target, tokenSecret: token.secret },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          settled = true;
          return 'async-value';
        },
      );
      assert.equal(value, 'async-value');
      assert.equal(settled, true);
      assert.ok(audit.tail(20).some((entry) => entry.command === 'fs.readFile:completed'));

      await assert.rejects(
        dispatcher.runAsync(
          { actor: 'daemon', capability: 'fs.read.workspace', command: 'fs.readFile', target, tokenSecret: token.secret },
          async () => {
            throw new Error('async boom');
          },
        ),
        /async boom/,
      );
      assert.ok(audit.tail(20).some((entry) => entry.command === 'fs.readFile:failed'));

      // A promise-returning callback in the synchronous path is refused, not mis-recorded.
      assert.throws(
        () =>
          dispatcher.run(
            { actor: 'daemon', capability: 'fs.read.workspace', command: 'fs.readFile', target, tokenSecret: token.secret },
            () => Promise.resolve('nope'),
          ),
        /use runAsync/,
      );
    } finally {
      projections.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-03: same-millisecond rotations preserve every segment and expose tampering', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T12:00:00.000Z') });
  const fixture = makeFixture();
  try {
    const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'clue.db'));
    try {
      const secrets = new SecretRegistry();
      const ws = fixture.config.workspace.root;
      const logsDir = join(ws, 'logs');
      // A tiny threshold forces a rotation after each record.
      const audit = new AuditLog(logsDir, projections, secrets, { maxLogBytes: 200 });
      for (let i = 0; i < 8; i += 1) {
        audit.record({
          actor: 'cli',
          command: `probe.${i}`,
          capability: 'fs.read.workspace',
          decision: 'allowed',
          missionVersion: 'MISSION-000001',
        });
      }

      const manifest = audit.readManifest();
      assert.equal(manifest.segments.length, 7);
      assert.equal(new Set(manifest.segments.map((segment) => segment.segment)).size, 7);
      assert.equal(audit.verifyArchive().segments, manifest.segments.length);

      // The chain spans the rotation: the first active record links to the newest archived one.
      const newest = manifest.segments[manifest.segments.length - 1];
      assert.ok(newest);
      const archived = readFileSync(join(logsDir, newest.segment), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
      const lastArchivedLine = archived[archived.length - 1];
      assert.ok(lastArchivedLine);
      const lastArchived = JSON.parse(lastArchivedLine) as Record<string, unknown>;
      const active = readAuditEntries(ws);
      assert.equal(active[0]?.['previous_hash'], lastArchived['hash']);
      assert.equal(audit.verifyChain().records, active.length);

      // Corrupt the earliest archived segment (which holds probe.0): verifyArchive catches it.
      const earliest = manifest.segments[0];
      assert.ok(earliest);
      const segPath = join(logsDir, earliest.segment);
      writeFileSync(segPath, readFileSync(segPath, 'utf8').replace('probe.0', 'probe.X'), 'utf8');
      assert.throws(
        () => audit.verifyArchive(),
        (error: unknown) => error instanceof AuditLogError && error.code === 'SEGMENT_ALTERED',
      );
    } finally {
      projections.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

test('DEV-P1-03: a malformed audit archive manifest blocks verification and rotation', () => {
  const fixture = makeFixture();
  try {
    const workspace = fixture.config.workspace.root;
    const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'));
    try {
      const logsDir = join(workspace, 'logs');
      const audit = new AuditLog(logsDir, projections, new SecretRegistry(), { maxLogBytes: 200 });
      const input = {
        actor: 'cli',
        command: 'probe',
        capability: 'fs.read.workspace',
        decision: 'allowed',
        missionVersion: 'MISSION-000001',
      } as const;
      assert.deepEqual(audit.verifyArchive(), { segments: 0 });
      audit.record(input);
      const activePath = join(logsDir, 'audit.ndjson');
      const active = readFileSync(activePath);
      writeFileSync(join(logsDir, 'audit-archive.json'), '{');
      const invalidManifest = (error: unknown) => error instanceof AuditLogError && error.code === 'MANIFEST_INVALID';
      assert.throws(() => audit.verifyArchive(), invalidManifest);
      assert.throws(() => audit.record(input), invalidManifest);
      assert.deepEqual(readFileSync(activePath), active);
      writeFileSync(join(logsDir, 'audit-archive.json'), JSON.stringify({
        schema: 'clue.audit.archive/1',
        segments: [{
          segment: '../audit.ndjson',
          sha256: 'a'.repeat(64),
          bytes: active.byteLength,
          first_id: null,
          last_id: null,
          head_hash: null,
          rotated_at: '2026-08-15T12:00:00.000Z',
        }],
      }));
      assert.throws(() => audit.verifyArchive(), invalidManifest);
    } finally {
      projections.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});

/* ------------------------------------------------------------------------- */
/* DEV-P1-28 (phase 1): the mission root of the evidence spine                */
/* ------------------------------------------------------------------------- */

test('DEV-P1-28: the mission root spine link seals deterministically from the basis', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    kernel.mission.bootstrap();

    const link = kernel.mission.spineLink();
    assert.equal(link.stage, 'mission');
    assert.equal(link.boundTo, null);
    // The link's basis hash is exactly the mission basis hash.
    assert.equal(link.missionBasisHash, kernel.mission.basis().basisHash);
    // Sealing is deterministic across calls: nothing time-dependent leaks into the basis.
    assert.equal(kernel.mission.spineSeal(), kernel.mission.spineSeal());
    // The root is a valid degenerate chain whose seal equals spineSeal().
    assert.equal(verifyEvidenceChain([link]), kernel.mission.spineSeal());
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('DEV-P1-28: the mission registry verifies a presented root link against the mission in force', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  try {
    kernel.mission.bootstrap();

    // The genuine root link matches the mission in force.
    kernel.mission.verifyMissionLink(kernel.mission.spineLink());

    // A link carrying any other basis hash was produced under a different mission and is refused.
    const foreign = {
      ...kernel.mission.spineLink(),
      missionBasisHash: 'f'.repeat(64) as unknown as MissionBasisHash,
    };
    assert.throws(
      () => kernel.mission.verifyMissionLink(foreign),
      (error: unknown) => error instanceof EvidenceChainError,
    );
  } finally {
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('DEV-P1-28: a snapshot link binds to the mission root and is verified registry-aware', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  // The snapshot registry needs a projection store that owns the snapshot projectors, so a captured
  // snapshot is projected into the tables `get()` reads.
  const snapProjections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'snap.db'), {
    projectors: SNAPSHOT_PROJECTORS,
  });
  try {
    kernel.mission.bootstrap();
    const missionLink = kernel.mission.spineLink();
    const missionSeal = kernel.mission.spineSeal();

    const snapshots = new SnapshotRegistry({
      log: kernel.log,
      projections: snapProjections,
      artifacts: kernel.artifacts,
      missionVersion: () => kernel.mission.current()?.id ?? 'MISSION-000001',
    });

    // Capture a small real tree so the link carries genuine identity fields.
    const treeRoot = join(fixture.config.workspace.root, 'tree');
    mkdirSync(join(treeRoot, 'src'), { recursive: true });
    writeFileSync(join(treeRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    const capture = snapshots.capture({ root: treeRoot, sourceRoots: ['src'], origin: 'canonical' });

    const snapshotLink = snapshots.spineLink(capture, missionSeal);
    assert.equal(snapshotLink.stage, 'snapshot');
    assert.equal(snapshotLink.boundTo, missionSeal);
    assert.equal(snapshotLink.snapshotContentId, capture.record.id);
    assert.equal(snapshotLink.manifestHash, capture.record.manifest_hash);

    // The first real verifyLink against a live predecessor: mission → snapshot.
    snapshots.verifySnapshotLink(snapshotLink, missionLink);
    assert.equal(
      verifyEvidenceChain([missionLink, snapshotLink]),
      snapshots.spineSeal(capture, missionSeal),
    );

    // A snapshot link bound to a different mission root is refused.
    const foreignSeal = 'a'.repeat(64) as unknown as typeof missionSeal;
    const misbound = snapshots.spineLink(capture, foreignSeal);
    assert.throws(
      () => snapshots.verifySnapshotLink(misbound, missionLink),
      (error: unknown) => error instanceof EvidenceChainError,
    );

    // A link whose manifest hash does not match the recorded snapshot is refused (registry-aware).
    const tampered = {
      ...snapshotLink,
      manifestHash: 'b'.repeat(64) as unknown as typeof snapshotLink.manifestHash,
    };
    assert.throws(
      () => snapshots.verifySnapshotLink(tampered, missionLink),
      (error: unknown) => error instanceof EvidenceChainError,
    );
  } finally {
    snapProjections.close();
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('DEV-P1-28: a recognition link binds to the snapshot seal and is verified against durable run history', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'spine.db'), {
    projectors: { ...SNAPSHOT_PROJECTORS, ...GRAPH_PROJECTORS, ...SCAN_CACHE_PROJECTORS },
  });
  try {
    kernel.mission.bootstrap();
    const missionLink = kernel.mission.spineLink();
    const missionSeal = kernel.mission.spineSeal();
    const missionVersion = (): string => kernel.mission.current()?.id ?? 'MISSION-000001';

    const snapshots = new SnapshotRegistry({ log: kernel.log, projections, artifacts: kernel.artifacts, missionVersion });
    const graph = new GraphRegistry({ log: kernel.log, projections, artifacts: kernel.artifacts, missionVersion });

    // A tiny real project: snapshot it, then recognise it with the actual TypeScript compiler.
    const treeRoot = join(fixture.config.workspace.root, 'tree');
    mkdirSync(join(treeRoot, 'src'), { recursive: true });
    writeFileSync(
      join(treeRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'node', skipLibCheck: true },
        include: ['src/**/*.ts'],
      }),
      'utf8',
    );
    writeFileSync(join(treeRoot, 'src', 'a.ts'), 'export function a(): number { return 1; }\n', 'utf8');

    const capture = snapshots.capture({ root: treeRoot, sourceRoots: ['src'], origin: 'canonical' });
    const snapshotLink = snapshots.spineLink(capture, missionSeal);
    const snapshotSeal = snapshots.spineSeal(capture, missionSeal);

    const result = recognize({ projectRoot: treeRoot, tsconfigPath: join(treeRoot, 'tsconfig.json') });
    graph.record(capture.record.id, result);

    const run = graph.runsOf(capture.record.id)[0];
    assert.ok(run, 'the recorded run appears in durable history');
    const recognitionLink = graph.spineLink(run, snapshotSeal);

    // The three-stage chain verifies end to end, and its leaf seal is the recognition seal.
    graph.verifyRecognitionLink(recognitionLink, snapshotLink);
    assert.equal(
      verifyEvidenceChain([missionLink, snapshotLink, recognitionLink]),
      graph.spineSeal(run, snapshotSeal),
    );

    // A recognition link bound to a foreign snapshot seal is refused.
    const foreignSeal = 'c'.repeat(64) as unknown as typeof snapshotSeal;
    assert.throws(
      () => graph.verifyRecognitionLink(graph.spineLink(run, foreignSeal), snapshotLink),
      (error: unknown) => error instanceof EvidenceChainError,
    );

    // A link claiming a run this registry never recorded is refused (registry-aware).
    const phantomRun = { ...run, runKey: 'f'.repeat(64) };
    assert.throws(
      () => graph.verifyRecognitionLink(graph.spineLink(phantomRun, snapshotSeal), snapshotLink),
      (error: unknown) => error instanceof EvidenceChainError && /never recorded/.test(error.message),
    );

    // A link pairing the real run with a foreign result hash is refused.
    const swappedResult = { ...run, resultHash: 'd'.repeat(64) };
    assert.throws(
      () => graph.verifyRecognitionLink(graph.spineLink(swappedResult, snapshotSeal), snapshotLink),
      (error: unknown) => error instanceof EvidenceChainError && /result/.test(error.message),
    );
  } finally {
    projections.close();
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('DEV-P1-28: a task link binds to the recognition seal and is verified against durable attempt history', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'spine4.db'), {
    projectors: { ...SNAPSHOT_PROJECTORS, ...GRAPH_PROJECTORS, ...SCAN_CACHE_PROJECTORS, ...TASK_PROJECTORS },
  });
  try {
    kernel.mission.bootstrap();
    const missionLink = kernel.mission.spineLink();
    const missionSeal = kernel.mission.spineSeal();
    const missionVersion = (): string => kernel.mission.current()?.id ?? 'MISSION-000001';

    const snapshots = new SnapshotRegistry({ log: kernel.log, projections, artifacts: kernel.artifacts, missionVersion });
    const graph = new GraphRegistry({ log: kernel.log, projections, artifacts: kernel.artifacts, missionVersion });
    const queue = new TaskQueue({ log: kernel.log, projections, missionVersion });

    // Build the chain through recognition.
    const treeRoot = join(fixture.config.workspace.root, 'tree');
    mkdirSync(join(treeRoot, 'src'), { recursive: true });
    writeFileSync(
      join(treeRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'node', skipLibCheck: true },
        include: ['src/**/*.ts'],
      }),
      'utf8',
    );
    writeFileSync(join(treeRoot, 'src', 'a.ts'), 'export function a(): number { return 1; }\n', 'utf8');

    const capture = snapshots.capture({ root: treeRoot, sourceRoots: ['src'], origin: 'canonical' });
    const snapshotLink = snapshots.spineLink(capture, missionSeal);
    const snapshotSeal = snapshots.spineSeal(capture, missionSeal);
    graph.record(capture.record.id, recognize({ projectRoot: treeRoot, tsconfigPath: join(treeRoot, 'tsconfig.json') }));
    const run = graph.runsOf(capture.record.id)[0];
    assert.ok(run);
    const recognitionLink = graph.spineLink(run, snapshotSeal);
    const recognitionSeal = graph.spineSeal(run, snapshotSeal);

    // Task stage: create a task, claim it, and bind the granted lease to the recognition seal.
    const created = queue.create({
      type: 'analysis.probe',
      lane: 'analysis',
      priority: 0.5,
      inputHash: 'a'.repeat(64),
      snapshotId: capture.record.id,
    });
    const leased = queue.claimById(created.id, 'worker-1');
    assert.ok(leased);
    const taskLink = queue.spineLink(leased, recognitionSeal);
    assert.equal(taskLink.stage, 'task');
    assert.equal(taskLink.taskId, created.id);
    assert.equal(taskLink.attempt, leased.attempt);
    assert.equal(taskLink.boundTo, recognitionSeal);

    // The four-stage chain verifies end to end, and its leaf seal is the task seal.
    queue.verifyTaskLink(taskLink, recognitionLink);
    assert.equal(
      verifyEvidenceChain([missionLink, snapshotLink, recognitionLink, taskLink]),
      queue.spineSeal(leased, recognitionSeal),
    );

    // A task link bound to a foreign recognition seal is refused.
    const foreignSeal = 'e'.repeat(64) as unknown as typeof recognitionSeal;
    assert.throws(
      () => queue.verifyTaskLink(queue.spineLink(leased, foreignSeal), recognitionLink),
      (error: unknown) => error instanceof EvidenceChainError,
    );

    // A link claiming an attempt this registry never recorded is refused (registry-aware).
    const phantomAttempt = { ...taskLink, attempt: 999 };
    assert.throws(
      () => queue.verifyTaskLink(phantomAttempt, recognitionLink),
      (error: unknown) => error instanceof EvidenceChainError && /never recorded/.test(error.message),
    );

    // A link presenting a lease-token hash the registry never issued for this attempt is refused.
    const forgedLease = {
      ...taskLink,
      leaseTokenHash: 'f'.repeat(64) as unknown as typeof taskLink.leaseTokenHash,
    };
    assert.throws(
      () => queue.verifyTaskLink(forgedLease, recognitionLink),
      (error: unknown) => error instanceof EvidenceChainError && /lease hash/.test(error.message),
    );
  } finally {
    projections.close();
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('DEV-P1-28: a context link binds to the task seal and is verified by deterministic re-derivation', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'spine5.db'), {
    projectors: { ...SNAPSHOT_PROJECTORS, ...GRAPH_PROJECTORS, ...SCAN_CACHE_PROJECTORS, ...TASK_PROJECTORS },
  });
  try {
    kernel.mission.bootstrap();
    const missionLink = kernel.mission.spineLink();
    const missionSeal = kernel.mission.spineSeal();
    const missionVersion = (): string => kernel.mission.current()?.id ?? 'MISSION-000001';

    const snapshots = new SnapshotRegistry({ log: kernel.log, projections, artifacts: kernel.artifacts, missionVersion });
    const graph = new GraphRegistry({ log: kernel.log, projections, artifacts: kernel.artifacts, missionVersion });
    const queue = new TaskQueue({ log: kernel.log, projections, missionVersion });

    // Chain through the task stage (mission → snapshot → recognition → task).
    const treeRoot = join(fixture.config.workspace.root, 'tree');
    mkdirSync(join(treeRoot, 'src'), { recursive: true });
    writeFileSync(
      join(treeRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'node', skipLibCheck: true },
        include: ['src/**/*.ts'],
      }),
      'utf8',
    );
    writeFileSync(join(treeRoot, 'src', 'a.ts'), 'export function a(): number { return 1; }\n', 'utf8');

    const capture = snapshots.capture({ root: treeRoot, sourceRoots: ['src'], origin: 'canonical' });
    const snapshotLink = snapshots.spineLink(capture, missionSeal);
    const snapshotSeal = snapshots.spineSeal(capture, missionSeal);
    graph.record(capture.record.id, recognize({ projectRoot: treeRoot, tsconfigPath: join(treeRoot, 'tsconfig.json') }));
    const run = graph.runsOf(capture.record.id)[0];
    assert.ok(run);
    const recognitionLink = graph.spineLink(run, snapshotSeal);
    const recognitionSeal = graph.spineSeal(run, snapshotSeal);
    const created = queue.create({ type: 'analysis.probe', lane: 'analysis', priority: 0.5, inputHash: 'a'.repeat(64), snapshotId: capture.record.id });
    const leased = queue.claimById(created.id, 'worker-1');
    assert.ok(leased);
    const taskLink = queue.spineLink(leased, recognitionSeal);
    const taskSeal = queue.spineSeal(leased, recognitionSeal);

    // Context stage: assemble a deterministic context and bind it to the task seal.
    const builder = new ContextBuilder({ projectRoot: treeRoot, mission: kernel.mission, graph, snapshots });
    const options: BuildOptions = {
      directive: 'probe the unit',
      outputSchemaName: 'ProbeResult',
      recipe: ['missionRules', 'taskDirective', 'outputRequirements'],
    };
    const result = builder.build(created, options);
    const contextLink = builder.spineLink(result, created, options, taskSeal);
    assert.equal(contextLink.stage, 'context');
    assert.equal(contextLink.boundTo, taskSeal);

    // The five-stage chain verifies end to end, and its leaf seal is the context seal.
    builder.verifyContextLink(contextLink, taskLink, result, created, options);
    assert.equal(
      verifyEvidenceChain([missionLink, snapshotLink, recognitionLink, taskLink, contextLink]),
      builder.spineSeal(result, created, options, taskSeal),
    );

    // A context link bound to a foreign task seal is refused.
    const foreignSeal = 'e'.repeat(64) as unknown as typeof taskSeal;
    assert.throws(
      () => builder.verifyContextLink(builder.spineLink(result, created, options, foreignSeal), taskLink, result, created, options),
      (error: unknown) => error instanceof EvidenceChainError,
    );

    // The link verified against a different context (a changed directive) is refused: the re-derived
    // basis hash no longer matches. This is the determinism-as-authority check.
    const otherOptions: BuildOptions = { ...options, directive: 'a different directive entirely' };
    const otherResult = builder.build(created, otherOptions);
    assert.throws(
      () => builder.verifyContextLink(contextLink, taskLink, otherResult, created, otherOptions),
      (error: unknown) => error instanceof EvidenceChainError && /does not match/.test(error.message),
    );
  } finally {
    projections.close();
    kernel.dispose();
    removeFixture(fixture.root);
  }
});

test('DEV-P1-28: the packet link and the accepted-result leaf close the complete seven-stage chain', () => {
  const fixture = makeFixture();
  const kernel = openKernel(fixture);
  const projections = new ProjectionStore(join(fixture.config.workspace.root, 'db', 'spine6.db'), {
    projectors: {
      ...SNAPSHOT_PROJECTORS,
      ...GRAPH_PROJECTORS,
      ...SCAN_CACHE_PROJECTORS,
      ...TASK_PROJECTORS,
      ...PACKET_PROJECTORS,
    },
  });
  try {
    kernel.mission.bootstrap();
    const missionLink = kernel.mission.spineLink();
    const missionSeal = kernel.mission.spineSeal();
    const missionVersion = (): string => kernel.mission.current()?.id ?? 'MISSION-000001';

    const snapshots = new SnapshotRegistry({ log: kernel.log, projections, artifacts: kernel.artifacts, missionVersion });
    const graph = new GraphRegistry({ log: kernel.log, projections, artifacts: kernel.artifacts, missionVersion });
    const queue = new TaskQueue({ log: kernel.log, projections, missionVersion });

    // Chain through the context stage.
    const treeRoot = join(fixture.config.workspace.root, 'tree');
    mkdirSync(join(treeRoot, 'src'), { recursive: true });
    writeFileSync(
      join(treeRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'node', skipLibCheck: true },
        include: ['src/**/*.ts'],
      }),
      'utf8',
    );
    writeFileSync(join(treeRoot, 'src', 'a.ts'), 'export function a(): number { return 1; }\n', 'utf8');

    const capture = snapshots.capture({ root: treeRoot, sourceRoots: ['src'], origin: 'canonical' });
    const snapshotLink = snapshots.spineLink(capture, missionSeal);
    const snapshotSeal = snapshots.spineSeal(capture, missionSeal);
    graph.record(capture.record.id, recognize({ projectRoot: treeRoot, tsconfigPath: join(treeRoot, 'tsconfig.json') }));
    const run = graph.runsOf(capture.record.id)[0];
    assert.ok(run);
    const recognitionLink = graph.spineLink(run, snapshotSeal);
    const recognitionSeal = graph.spineSeal(run, snapshotSeal);
    const created = queue.create({ type: 'analysis.probe', lane: 'analysis', priority: 0.5, inputHash: 'a'.repeat(64), snapshotId: capture.record.id });
    const leased = queue.claimById(created.id, 'worker-1');
    assert.ok(leased);
    const taskLink = queue.spineLink(leased, recognitionSeal);
    const taskSeal = queue.spineSeal(leased, recognitionSeal);

    const builder = new ContextBuilder({ projectRoot: treeRoot, mission: kernel.mission, graph, snapshots });
    const options: BuildOptions = {
      directive: 'probe the unit',
      outputSchemaName: 'ProbeResult',
      recipe: ['missionRules', 'taskDirective', 'outputRequirements'],
    };
    const result = builder.build(leased.task, options);
    const contextLink = builder.spineLink(result, leased.task, options, taskSeal);
    const contextSeal = builder.spineSeal(result, leased.task, options, taskSeal);

    // Packet stage: export a real packet folder from the assembled context.
    const schemas = new OutputSchemaRegistry();
    schemas.register(
      {
        name: 'ProbeResult',
        schema: z.object({ summary: z.string() }),
        example: { summary: 'what was found' },
        notes: ['State the finding plainly.'],
      },
      ['analysis.probe'],
    );
    const packets = new SessionPacketService({
      log: kernel.log,
      projections,
      artifacts: kernel.artifacts,
      queue,
      schemas,
      secrets: new SecretRegistry(),
      missionVersion,
      tokenBudget: 200_000,
    });
    const exported = packets.export(
      leased.task,
      result.sections,
      join(fixture.config.workspace.root, 'packets'),
      leased.leaseToken,
    );

    const packetLink = packets.spineLink(exported.manifest, contextSeal);
    assert.equal(packetLink.stage, 'packet');
    assert.equal(packetLink.boundTo, contextSeal);
    assert.equal(packetLink.packetBasisHash, exported.manifest.packet_hash);
    assert.equal(packetLink.outputSchemaAuthorityHash, exported.manifest.output_schema_hash);

    // The six-stage chain verifies end to end, including the bytes on disk.
    packets.verifyPacketLink(packetLink, contextLink, { packetDirectory: exported.directory });
    assert.equal(
      verifyEvidenceChain([missionLink, snapshotLink, recognitionLink, taskLink, contextLink, packetLink]),
      packets.spineSeal(exported.manifest, contextSeal),
    );

    // A packet link bound to a foreign context seal is refused.
    const foreignSeal = 'e'.repeat(64) as unknown as typeof contextSeal;
    assert.throws(
      () => packets.verifyPacketLink(packets.spineLink(exported.manifest, foreignSeal), contextLink),
      (error: unknown) => error instanceof EvidenceChainError,
    );

    // A link claiming a packet this service never exported is refused (registry-aware).
    const phantom = { ...packetLink, packetBasisHash: 'b'.repeat(64) as unknown as typeof packetLink.packetBasisHash };
    assert.throws(
      () => packets.verifyPacketLink(phantom, contextLink),
      (error: unknown) => error instanceof EvidenceChainError && /never exported/.test(error.message),
    );

    // A link whose output-schema authority differs from the recorded export is refused.
    const swappedSchema = {
      ...packetLink,
      outputSchemaAuthorityHash: 'c'.repeat(64) as unknown as typeof packetLink.outputSchemaAuthorityHash,
    };
    assert.throws(
      () => packets.verifyPacketLink(swappedSchema, contextLink),
      (error: unknown) => error instanceof EvidenceChainError && /output-schema authority/.test(error.message),
    );

    // A link whose bundle hash disagrees with the packet on disk is refused (bytes-on-disk layer).
    const forgedBundle = {
      ...packetLink,
      bundleHash: 'd'.repeat(64) as unknown as typeof packetLink.bundleHash,
    };
    assert.throws(
      () => packets.verifyPacketLink(forgedBundle, contextLink, { packetDirectory: exported.directory }),
      (error: unknown) => error instanceof EvidenceChainError && /bundle/.test(error.message),
    );

    // A projection row carries no file list, so it cannot form a packet link: refused, not hashed empty.
    const fromProjection = packets.packetOf(exported.manifest.packet_hash);
    assert.ok(fromProjection);
    assert.throws(
      () => packets.spineLink(fromProjection, contextSeal),
      (error: unknown) => error instanceof EvidenceChainError && /closed-bundle/.test(error.message),
    );

    /* ----------------------------------------------------------------- */
    /* Phase 7: the accepted-result leaf closes the chain                 */
    /* ----------------------------------------------------------------- */

    const packetSeal = packets.spineSeal(exported.manifest, contextSeal);

    // Return a real result through the real import path so acceptance is durably recorded.
    writeFileSync(
      join(exported.directory, 'result.json'),
      JSON.stringify(
        {
          task_id: leased.task.id,
          packet_hash: exported.manifest.packet_hash,
          input_hash: leased.task.input_hash,
          mission_version: leased.task.mission_version,
          worker: 'worker-1',
          lease_token: leased.leaseToken,
          model: null,
          mode: 'manual',
          tokens_in: 100,
          tokens_out: 50,
          cost: 0.01,
          produced_at: new Date().toISOString(),
          limitations: [],
          output: { summary: 'a is a pure function' },
        },
        null,
        2,
      ),
      'utf8',
    );
    const report = packets.import(exported.directory);
    assert.equal(report.outcome, 'accepted');
    assert.ok(report.outputHash);

    // The audit execution id and the host receipt are the other two identities the leaf binds.
    const auditExecutionId = 'EXEC-0123456789abcdef0123';
    const hostReceiptHash = hostReceiptHashOf('{"id":"host-1","ok":true,"result":{"exitCode":0}}');
    const leafInput = { acceptedResultHash: report.outputHash, auditExecutionId, hostReceiptHash };

    const leaf = packets.acceptedResultSpineLink(leafInput, packetSeal);
    assert.equal(leaf.stage, 'accepted-result');
    assert.equal(leaf.boundTo, packetSeal);
    assert.equal(leaf.acceptedResultHash, report.outputHash);

    // The complete seven-stage chain verifies end to end, and its terminal hash is the leaf seal.
    packets.verifyAcceptedResultLink(leaf, packetLink);
    assert.equal(
      verifyEvidenceChain([
        missionLink,
        snapshotLink,
        recognitionLink,
        taskLink,
        contextLink,
        packetLink,
        leaf,
      ]),
      packets.acceptedResultSpineSeal(leafInput, packetSeal),
    );

    // A leaf bound to a foreign packet seal is refused.
    assert.throws(
      () => packets.verifyAcceptedResultLink(packets.acceptedResultSpineLink(leafInput, foreignSeal), packetLink),
      (error: unknown) => error instanceof EvidenceChainError,
    );

    // A leaf claiming a result the task never accepted is refused (registry-aware).
    const forgedResult = { ...leafInput, acceptedResultHash: 'a'.repeat(64) };
    assert.throws(
      () => packets.verifyAcceptedResultLink(packets.acceptedResultSpineLink(forgedResult, packetSeal), packetLink),
      (error: unknown) => error instanceof EvidenceChainError && /durably recorded/.test(error.message),
    );

    // Swapping the audit execution id or the host receipt changes the terminal hash of the chain:
    // both are sealed, so neither can be substituted after the fact without the chain failing.
    const otherExecution = packets.acceptedResultSpineSeal(
      { ...leafInput, auditExecutionId: 'EXEC-ffffffffffffffffffff' },
      packetSeal,
    );
    const otherReceipt = packets.acceptedResultSpineSeal(
      { ...leafInput, hostReceiptHash: hostReceiptHashOf('{"id":"host-1","ok":false}') },
      packetSeal,
    );
    const terminal = packets.acceptedResultSpineSeal(leafInput, packetSeal);
    assert.notEqual(otherExecution, terminal);
    assert.notEqual(otherReceipt, terminal);
  } finally {
    projections.close();
    kernel.dispose();
    removeFixture(fixture.root);
  }
});
