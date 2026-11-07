/** Read-only event replay for observer/governance surfaces (P2 closure control). */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventLog, EventLogError } from '../src/memory/eventLog.js';

function tempEvents(): { readonly root: string; readonly events: string } {
  const root = mkdtempSync(join(tmpdir(), 'clue-readonly-replay-'));
  return { root, events: join(root, 'events') };
}

test('P2-CLOSURE-05: verified read-only replay can observe committed events while the writer retains its lock', () => {
  const { root, events } = tempEvents();
  try {
    const { log } = EventLog.open(events);
    try {
      log.append({
        type: 'authority.pack_ratified',
        missionVersion: 'MISSION-000001',
        actor: 'creator',
        payload: { marker: 1 },
      });
      log.append({
        type: 'authority.epoch_sealed',
        missionVersion: 'MISSION-000001',
        actor: 'creator',
        payload: { marker: 2 },
      });
      const lockBefore = readFileSync(join(events, 'events.ndjson.lock'), 'utf8');
      const records = [...EventLog.replayReadOnly(events)];
      const lockAfter = readFileSync(join(events, 'events.ndjson.lock'), 'utf8');
      assert.deepEqual(records.map((record) => record.sequence), [0, 1]);
      assert.deepEqual(records.map((record) => record.type), [
        'authority.pack_ratified',
        'authority.epoch_sealed',
      ]);
      assert.equal(lockAfter, lockBefore, 'an observer must not acquire, replace or release the writer lock');
    } finally {
      log.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P2-CLOSURE-05: read-only replay verifies the chain and refuses edited governance history', () => {
  const { root, events } = tempEvents();
  try {
    const { log } = EventLog.open(events);
    log.append({
      type: 'test.event',
      missionVersion: 'MISSION-000001',
      actor: 'daemon',
      payload: { value: 'original' },
    });
    log.close();

    const path = join(events, 'events.ndjson');
    writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'edited'), 'utf8');
    assert.throws(
      () => [...EventLog.replayReadOnly(events)],
      (error: unknown) => error instanceof EventLogError && error.code === 'HASH_MISMATCH',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
