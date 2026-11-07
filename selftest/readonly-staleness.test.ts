/**
 * DEV-P0-10 — a read-only attach proves projection staleness.
 *
 * A read-only runtime holds no single-writer lock, so it previously could not compare the projection
 * head to the log head and reported staleness as `null` (unknown). `EventLog.readHead` reads the head
 * WITHOUT acquiring the writer lock or creating the file, and `ProjectionStore.isStaleAgainst` compares
 * against it — so a projection that lags or diverges from the log is identified as stale rather than
 * assumed healthy, and the read performs no write.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectionStore } from '../src/memory/db.js';
import { EventLog } from '../src/memory/eventLog.js';

function openWorkspace(): { root: string; eventsDir: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'clue-ro-stale-'));
  const ws = join(root, 'workspace');
  for (const d of ['db', 'events']) mkdirSync(join(ws, d), { recursive: true });
  return { root, eventsDir: join(ws, 'events'), dbPath: join(ws, 'db', 'clue.db') };
}

const appendEvent = (log: EventLog, n: number): void => {
  log.append({ type: 'test.probe', actor: 'daemon', missionVersion: 'MISSION-000001', subjectId: null, payload: { n } });
};

test('readHead reads an empty log as null and writes nothing', () => {
  const { root, eventsDir } = openWorkspace();
  try {
    assert.equal(EventLog.readHead(eventsDir), null, 'a fresh workspace has no head');
    assert.equal(existsSync(join(eventsDir, 'events.ndjson')), false, 'reading the head created no events file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a read-only head read proves a stale projection without the writer lock', () => {
  const { root, eventsDir, dbPath } = openWorkspace();
  try {
    const { log } = EventLog.open(eventsDir);
    appendEvent(log, 1);
    appendEvent(log, 2);

    // Synced to the current head → not stale.
    const synced = new ProjectionStore(dbPath, { projectors: {} });
    synced.sync(log);
    assert.equal(synced.isStaleAgainst(EventLog.readHead(eventsDir)), false, 'a synced projection is not stale');
    synced.close();

    // Advance the log while the writer still holds the lock; readHead must still work (no lock).
    appendEvent(log, 3);
    const headWhileLocked = EventLog.readHead(eventsDir);
    assert.ok(headWhileLocked !== null && headWhileLocked.sequence === 2, 'readHead works while the writer holds the lock');
    log.close();

    // The projection (synced to sequence 1) now lags the log head (sequence 2) → proved stale.
    const lagging = new ProjectionStore(dbPath, { projectors: {} });
    assert.equal(lagging.isStaleAgainst(EventLog.readHead(eventsDir)), true, 'a lagging projection is proved stale, not unknown');

    // A matching sequence with a different hash (rewritten history) is also stale.
    const realHead = EventLog.readHead(eventsDir);
    assert.ok(realHead !== null);
    assert.equal(lagging.isStaleAgainst({ sequence: realHead.sequence, hash: 'f'.repeat(64) as never }), true, 'divergent history is stale');
    lagging.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
