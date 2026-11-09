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

test('read-only full-chain verification preserves UTF-8 across read chunks', () => {
  const { root, events } = tempEvents();
  try {
    const marker = '🧪';
    const { log } = EventLog.open(events);
    const event = log.append({
      type: 'test.event',
      missionVersion: 'MISSION-000001',
      actor: 'daemon',
      payload: { marker },
    });
    log.close();

    const path = join(events, 'events.ndjson');
    const record = readFileSync(path);
    const markerOffset = record.indexOf(marker);
    assert.ok(markerOffset >= 0);
    // JSON permits leading whitespace. Place the code point's first byte at the end
    // of the first chunk without changing the hashed fields in the record.
    const padding = Buffer.alloc(256 * 1024 - 1 - markerOffset, ' ');
    const logBytes = Buffer.concat([padding, record]);
    writeFileSync(path, logBytes);

    assert.deepEqual(EventLog.verifyReadOnly(events), { sequence: event.sequence, hash: event.hash });
    assert.deepEqual([...EventLog.replayReadOnly(events)], [event]);
    assert.deepEqual(readFileSync(path), logBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only full-chain verification refuses committed history behind the checkpoint', () => {
  const { root, events } = tempEvents();
  try {
    const path = join(events, 'events.ndjson');
    assert.equal(EventLog.verifyReadOnly(events), null);
    const { log } = EventLog.open(events);
    try {
      const input = { type: 'test.event', missionVersion: 'MISSION-000001', actor: 'daemon', payload: {} } as const;
      const first = log.append(input);
      const prefix = readFileSync(path);
      const second = log.append(input);
      log.checkpoint();

      assert.deepEqual(EventLog.verifyReadOnly(events), { sequence: second.sequence, hash: second.hash });
      log.close();
      writeFileSync(path, prefix);

      assert.deepEqual(EventLog.readHead(events), { sequence: first.sequence, hash: first.hash });
      assert.throws(
        () => EventLog.verifyReadOnly(events),
        (error: unknown) => error instanceof EventLogError && error.code === 'CHECKPOINT_CONFLICT',
      );
      assert.deepEqual(readFileSync(path), prefix);
    } finally {
      log.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
