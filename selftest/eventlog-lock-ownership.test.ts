/**
 * Event-log lock-ownership and durability-primitive acceptance tests.
 *
 * Spec: CLUE_Architecture_v9.md — one append-only, hash-chained, single-writer authority.
 *       CLUE_Project_Directory_v9.md §9 — `eventLog.ts` owns that authority; §21 rule 1 —
 *       `src/shared/` depends on no domain service, so the durability primitives it owns
 *       are the ones every layer above is expected to use.
 *
 * Backlog: DEV-P1-01 revision 4 — `close()` deleted whatever lock file was present rather
 *          than the lock it owned, and this file kept private copies of the shared
 *          durability primitives.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { EventLog, EventLogError } from '../src/memory/eventLog.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'clue-eventlog-lock-'));
}

/** The lock record as it sits on disk. */
function readLock(eventsDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(eventsDir, 'events.ndjson.lock'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * Rewrites the lock as a successful reclaimer would: same file, different owner token.
 * This is exactly the state a writer finds itself in after stalling past the staleness
 * window while another process proved it gone and took over.
 */
function simulateTakeover(eventsDir: string, token: string): void {
  const lockPath = join(eventsDir, 'events.ndjson.lock');
  const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(lockPath, `${JSON.stringify({ ...owner, ownerToken: token })}\n`, 'utf8');
}

test('DEV-P1-01: close() does not delete a lock that ownership has moved away from', () => {
  const root = workspace();
  const eventsDir = join(root, 'events');
  try {
    const { log } = EventLog.open(eventsDir);
    const ours = readLock(eventsDir)['ownerToken'];
    assert.equal(typeof ours, 'string');

    // Ownership moves while this instance still holds its descriptor.
    simulateTakeover(eventsDir, 'reclaimer-token');

    // The heartbeat already refused in this situation; close() must agree with it.
    assert.throws(
      () => log.heartbeat(),
      (error: unknown) => error instanceof EventLogError && error.code === 'LOCKED',
      'a superseded writer must not be able to refresh a lock it no longer owns',
    );

    log.close();

    assert.ok(
      existsSync(join(eventsDir, 'events.ndjson.lock')),
      'the new owner’s lock must survive a superseded writer closing',
    );
    assert.equal(
      readLock(eventsDir)['ownerToken'],
      'reclaimer-token',
      'close() must not replace or remove another writer’s ownership record',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-01: a writer that still owns its lock releases it on close, as before', () => {
  const root = workspace();
  const eventsDir = join(root, 'events');
  try {
    const first = EventLog.open(eventsDir);
    first.log.append({
      type: 'test.event',
      missionVersion: 'MISSION-000001',
      actor: 'daemon',
      payload: { note: 'one' },
    });
    first.log.close();

    assert.equal(
      existsSync(join(eventsDir, 'events.ndjson.lock')),
      false,
      'an owned lock is still removed on close — a leaked lock blocks every reopen',
    );

    // And the log reopens cleanly, which is the behaviour the removal exists to protect.
    const second = EventLog.open(eventsDir);
    try {
      assert.equal(second.report.head?.sequence, 0);
    } finally {
      second.log.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-01: the log runs on the shared durability primitives and keeps no private copy', () => {
  // Tests execute compiled from `dist/`, so the authored source is located by walking up
  // from this module until the repository root is found. Reading the source is the point:
  // the invariant being proved is structural, not behavioural.
  let directory = dirname(fileURLToPath(import.meta.url));
  let sourcePath = '';
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'src', 'memory', 'eventLog.ts');
    if (existsSync(candidate)) {
      sourcePath = candidate;
      break;
    }
    directory = dirname(directory);
  }
  assert.notEqual(sourcePath, '', 'the authored eventLog.ts must be locatable from the test');
  const source = readFileSync(sourcePath, 'utf8');

  // The structural invariant: a fourth private copy cannot drift back in unnoticed.
  assert.match(source, /from '\.\.\/shared\/durableFs\.js'/, 'the shared module is imported');
  assert.doesNotMatch(
    source,
    /^function fsyncDirSync\(/m,
    'no private directory-fsync copy remains',
  );
  assert.doesNotMatch(
    source,
    /^\s*written = writeSync\(fd, data, offset/m,
    'no private short-write loop remains',
  );

  // And the behavioural invariant those primitives exist for: append, checkpoint and
  // reopen all still hold, now driven by the shared implementations.
  const root = workspace();
  const eventsDir = join(root, 'events');
  try {
    const { log } = EventLog.open(eventsDir);
    let head;
    try {
      for (let index = 0; index < 5; index += 1) {
        log.append({
          type: 'test.event',
          missionVersion: 'MISSION-000001',
          actor: 'daemon',
          payload: { index },
        });
      }
      // atomicWriteJsonSync → whole-buffer write, fsync, atomic replace, directory fsync.
      const checkpoint = log.checkpoint();
      assert.equal(checkpoint.records, 5);
      assert.equal(checkpoint.head?.sequence, 4);
      head = log.getHead();
    } finally {
      log.close();
    }

    const reopened = EventLog.open(eventsDir, { verifyOnOpen: 'full' });
    try {
      assert.deepEqual(reopened.report.head, head, 'the chain verifies end to end after reopen');
      assert.equal(reopened.report.checkpoint?.records, 5, 'the checkpoint survived the replace');
      assert.equal(reopened.report.repairedBytes, 0, 'nothing was torn');
      assert.equal(reopened.log.verify().records, 5);
    } finally {
      reopened.log.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
