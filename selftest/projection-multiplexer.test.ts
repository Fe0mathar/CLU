/** P2 B6 — more than one projection module may consume the same durable event atomically. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore, type ProjectionModule } from '../src/memory/db.js';

function stack(modules: readonly ProjectionModule[]) {
  const root = mkdtempSync(join(tmpdir(), 'clue-projector-multiplexer-'));
  mkdirSync(join(root, 'events'), { recursive: true });
  const projections = new ProjectionStore(join(root, 'clue.db'), { modules });
  const { log } = EventLog.open(join(root, 'events'));
  return {
    root,
    projections,
    log,
    close() {
      log.close();
      projections.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function module(name: string, table: string, fail = false): ProjectionModule {
  return {
    name,
    install(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (event_id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    },
    tables: [table],
    projectors: {
      'selftest.shared': (db, record) => {
        db.prepare(`INSERT INTO ${table} (event_id, value) VALUES (?, ?)`).run(
          record.id,
          String((record.payload as { value?: unknown }).value ?? ''),
        );
        if (fail) throw new Error(`${name} refused the event`);
      },
    },
  };
}

test('P2-B6: two registered modules consume one event without overwriting each other', () => {
  const fixture = stack([module('first', 'first_rows'), module('second', 'second_rows')]);
  try {
    fixture.log.append({
      type: 'selftest.shared',
      actor: 'cli',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: { value: 'durable' },
    });
    assert.deepEqual(fixture.projections.sync(fixture.log), {
      applied: 1,
      rebuilt: true,
      lastSequence: 0,
    });
    for (const table of ['first_rows', 'second_rows']) {
      const row = fixture.projections.db.prepare(`SELECT value FROM ${table}`).get() as { value: string };
      assert.equal(row.value, 'durable');
    }
  } finally {
    fixture.close();
  }
});

test('P2-B6: all projectors and the event index roll back when any consumer refuses', () => {
  const fixture = stack([module('first', 'first_rows'), module('refusing', 'refusing_rows', true)]);
  try {
    fixture.log.append({
      type: 'selftest.shared',
      actor: 'cli',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: { value: 'must-not-survive' },
    });
    assert.throws(() => fixture.projections.sync(fixture.log), /refusing refused the event/);
    for (const table of ['events_index', 'first_rows', 'refusing_rows']) {
      const row = fixture.projections.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(row.n, 0, `${table} participates in the same transaction`);
    }
    assert.equal(fixture.projections.status().lastSequence, null);
  } finally {
    fixture.close();
  }
});
