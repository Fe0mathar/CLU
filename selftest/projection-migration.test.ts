/**
 * Projection schema migration.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §9 — "SQLite contains no independent truth. Deleting
 *       it and rebuilding from events plus artifacts must reproduce the same canonical
 *       projections." That is what makes dropping a stale projection table safe, and it is
 *       the whole justification for the fix under test.
 *
 * Backlog: DEV-P1-32 — a workspace created before `DEV-P1-04`/`DEV-P1-05` could not be
 *          opened. `clue init` failed with `no such column: content_id` while printing
 *          "Migrating / initialising the workspace (idempotent)". Idempotent it was;
 *          migrating it was not.
 *
 * ## The two defects, because the second is the interesting one
 *
 * **`PROJECTION_SCHEMA_VERSION` was never bumped.** `DEV-P1-04` and `DEV-P1-05` changed the
 * shape of several projection tables — `claims` gained `content_id` and `text_key`,
 * `claim_domains` and `claim_subjects` arrived, the metrics registry gained
 * `metric_set_runs` and `ranking_runs` — and the constant stayed at 1. Nothing detected the
 * drift because nothing was told there was any.
 *
 * **The migration ran too late to help.** Even bumped, it would not have worked. Module DDL
 * is `CREATE TABLE IF NOT EXISTS`, which is a no-op against an existing table, so an old
 * table survived the create and the `CREATE INDEX` statements that followed failed on
 * columns nobody had added. That throw happened during `module.install()`, which runs
 * *before* `reconcileSchemaVersion()`. The mechanism was correct and simply unreachable —
 * the failure was one step upstream of the code written to prevent it.
 *
 * Both are covered below: a workspace at an older recorded version must be migrated by
 * dropping and rebuilding, and a workspace already at the current version must be left
 * entirely alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { PROJECTION_SCHEMA_VERSION, ProjectionStore } from '../src/memory/db.js';
import { buildProjectionModules } from '../src/control/projectionModules.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'clue-migration-'));
}

/** Opens a store with the real module set, the way a writable runtime does. */
function open(path: string): ProjectionStore {
  return new ProjectionStore(path, { modules: buildProjectionModules({}) });
}

test('DEV-P1-32: the schema version is ahead of 1, or nothing detects the DEV-P1-04/05 change', () => {
  // The first defect, stated as an invariant rather than a story: a build whose projection
  // tables changed shape must not still claim version 1.
  assert.ok(
    PROJECTION_SCHEMA_VERSION >= 2,
    'bump PROJECTION_SCHEMA_VERSION whenever a projection table changes shape',
  );
});

test('DEV-P1-32: a workspace at an older schema is migrated rather than refused', () => {
  const root = workspace();
  const path = join(root, 'clue.db');
  try {
    open(path).close();

    // Rewind to a pre-DEV-P1-05 `claims`: the columns that existed before content identity
    // was split from location, and the version that build would have recorded.
    const raw = new Database(path);
    raw.exec('DROP TABLE IF EXISTS claims');
    raw.exec(
      'CREATE TABLE claims (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ' +
        'text TEXT NOT NULL, document_path TEXT NOT NULL, registered_at TEXT NOT NULL)',
    );
    raw.prepare("UPDATE projection_state SET value='1' WHERE key='schema_version'").run();
    const before = raw.prepare('PRAGMA table_info(claims)').all() as { name: string }[];
    assert.equal(
      before.some((column) => column.name === 'content_id'),
      false,
      'the fixture really is a pre-DEV-P1-05 table',
    );
    raw.close();

    // The operation that used to throw `no such column: content_id`.
    assert.doesNotThrow(() => open(path).close(), 'a stale workspace must open, not refuse');

    const after = new Database(path);
    const columns = (after.prepare('PRAGMA table_info(claims)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    assert.ok(columns.includes('content_id'), 'the table was rebuilt at its current shape');
    assert.ok(columns.includes('text_key'), 'and carries every column the current build declares');
    assert.equal(
      (after.prepare("SELECT value FROM projection_state WHERE key='schema_version'").get() as {
        value: string;
      }).value,
      String(PROJECTION_SCHEMA_VERSION),
      'and the recorded version now matches the build',
    );
    after.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-32: a current workspace is left alone, and the event index survives', () => {
  // The control, and the one that matters most: the fix drops tables, so it must be certain
  // it never fires on a workspace that does not need it. Dropping projections is cheap only
  // because they are rebuildable — dropping the event index would not be.
  const root = workspace();
  const path = join(root, 'clue.db');
  try {
    open(path).close();

    const raw = new Database(path);
    raw
      .prepare(
        'INSERT INTO events_index (sequence, id, timestamp, type, actor, subject_id, ' +
          'mission_version, hash) VALUES (0, ?, ?, ?, ?, NULL, ?, ?)',
      )
      .run(
        'EVT-000001',
        '2026-08-06T00:00:00.000Z',
        'test.event',
        'daemon',
        'MISSION-000001',
        'a'.repeat(64),
      );
    const before = raw.prepare('SELECT COUNT(*) AS n FROM events_index').get() as { n: number };
    assert.equal(before.n, 1);
    raw.close();

    open(path).close();

    const after = new Database(path);
    const count = after.prepare('SELECT COUNT(*) AS n FROM events_index').get() as { n: number };
    assert.equal(count.n, 1, 'reopening a current workspace must not clear the event index');
    after.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-32: a workspace from a NEWER build is refused, not silently downgraded', () => {
  // The direction the drop must never run. A newer build may have recorded columns this one
  // does not know about; dropping them to "migrate" would destroy its work.
  const root = workspace();
  const path = join(root, 'clue.db');
  try {
    open(path).close();
    const raw = new Database(path);
    raw
      .prepare("UPDATE projection_state SET value=? WHERE key='schema_version'")
      .run(String(PROJECTION_SCHEMA_VERSION + 1));
    raw.close();

    assert.throws(
      () => open(path).close(),
      /schema version|Upgrade CLUE/i,
      'a newer workspace must stop this build rather than be downgraded',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P2-12: schema 6 installs the Great Book read model for a version-5 workspace', () => {
  assert.ok(PROJECTION_SCHEMA_VERSION >= 6, 'Great Book tables require projection schema 6');
  const root = workspace();
  const path = join(root, 'clue.db');
  try {
    open(path).close();
    const raw = new Database(path);
    raw.exec('DROP TABLE IF EXISTS great_book_entries');
    raw.exec('DROP TABLE IF EXISTS great_book_recording_gaps');
    raw.prepare("UPDATE projection_state SET value='5' WHERE key='schema_version'").run();
    raw.close();

    assert.doesNotThrow(() => open(path).close());
    const after = new Database(path);
    const names = new Set(
      (after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    assert.equal(names.has('great_book_entries'), true);
    assert.equal(names.has('great_book_recording_gaps'), true);
    assert.equal(
      (after.prepare("SELECT value FROM projection_state WHERE key='schema_version'").get() as { value: string }).value,
      String(PROJECTION_SCHEMA_VERSION),
    );
    after.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P2-09: schema 7 installs the event-derived gateway call read model for a version-6 workspace', () => {
  assert.ok(PROJECTION_SCHEMA_VERSION >= 7, 'Model Gateway tables require projection schema 7');
  const root = workspace();
  const path = join(root, 'clue.db');
  try {
    open(path).close();
    const raw = new Database(path);
    raw.exec('DROP TABLE IF EXISTS gateway_calls');
    raw.prepare("UPDATE projection_state SET value='6' WHERE key='schema_version'").run();
    raw.close();

    assert.doesNotThrow(() => open(path).close());
    const after = new Database(path);
    const table = after
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_calls'")
      .get() as { name: string } | undefined;
    assert.equal(table?.name, 'gateway_calls');
    const columns = new Set(
      (after.prepare('PRAGMA table_info(gateway_calls)').all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const required of [
      'call_id',
      'task_id',
      'experiment_id',
      'finding_id',
      'policy_hash',
      'routing_hash',
      'estimated_usd',
      'actual_usd',
    ]) {
      assert.equal(columns.has(required), true, `gateway_calls includes ${required}`);
    }
    assert.equal(
      (after.prepare("SELECT value FROM projection_state WHERE key='schema_version'").get() as {
        value: string;
      }).value,
      String(PROJECTION_SCHEMA_VERSION),
    );
    after.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test('PP-26: current schema installs Proof Board and Project Profile gateway columns for a version-7 workspace', () => {
  assert.ok(PROJECTION_SCHEMA_VERSION >= 10, 'Project-bound Gateway projections require schema 10');
  const root = workspace();
  const path = join(root, 'clue.db');
  try {
    open(path).close();
    const raw = new Database(path);
    for (const table of [
      'proof_board_benchmark_runs',
      'proof_board_contracts',
      'proof_board_baselines',
      'proof_board_refusals',
      'proof_board_verdicts',
    ]) raw.exec(`DROP TABLE IF EXISTS ${table}`);
    raw.prepare("UPDATE projection_state SET value='7' WHERE key='schema_version'").run();
    raw.close();

    assert.doesNotThrow(() => open(path).close());
    const after = new Database(path);
    const names = new Set(
      (after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    for (const table of [
      'proof_board_benchmark_runs',
      'proof_board_contracts',
      'proof_board_baselines',
      'proof_board_refusals',
      'proof_board_verdicts',
    ]) assert.equal(names.has(table), true, `${table} is installed`);
    const gatewayCallColumns = new Set(
      (after.prepare('PRAGMA table_info(gateway_calls)').all() as { name: string }[])
        .map((column) => column.name),
    );
    const gatewayStateColumns = new Set(
      (after.prepare('PRAGMA table_info(gateway_provider_state)').all() as { name: string }[])
        .map((column) => column.name),
    );
    for (const column of [
      'project_id',
      'target_root_identity',
      'project_profile_hash',
      'profile_generation',
    ]) {
      assert.equal(gatewayCallColumns.has(column), true, `gateway_calls.${column} is installed`);
      assert.equal(gatewayStateColumns.has(column), true, `gateway_provider_state.${column} is installed`);
    }
    assert.equal(
      (after.prepare("SELECT value FROM projection_state WHERE key='schema_version'").get() as { value: string }).value,
      String(PROJECTION_SCHEMA_VERSION),
    );
    after.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
