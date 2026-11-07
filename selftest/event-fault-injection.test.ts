/**
 * Event-log fault injection (INT-P0-01, carried as DEV-P2-13; additions to the DEV-T01/T03
 * ground the kernel suite already holds).
 *
 * Spec: `src/memory/eventLog.ts` header invariants — a record is committed only when its
 *       newline is durable; a torn tail is removable and receipted; recovery is never
 *       silent; the checkpoint is a trust anchor a shortened committed history must fail
 *       against, not slide past.
 *
 * Every test here injects a fault the same way a crash or a corruption would leave it —
 * raw bytes in `events.ndjson` — and asserts the *contracted* response, by error code and
 * sequence where the contract names them. Nothing is mocked; the file on disk is the
 * subject.
 *
 * The distinction under test, case by case:
 *
 *   torn tail (no newline)      → repaired on open, receipted, history intact
 *   terminated garbage line     → refused; a committed-looking line is never discarded
 *   tampered committed record   → HASH_MISMATCH naming the sequence, at open('full') and
 *                                 at verify() alike
 *   reordered committed records → the event-order fault INT-P0-01 is named for: each
 *                                 record's own hash still verifies, so only the chain and
 *                                 sequence rules can catch it — and they must
 *   committed history shortened → CHECKPOINT_CONFLICT; the same checkpoint must tolerate
 *                                 a merely-torn tail, or recovery would be impossible
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog, EventLogError } from '../src/memory/eventLog.js';

const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

function makeEventsDir(): string {
  return mkdtempSync(join(tmpdir(), 'clue-fault-'));
}

function removeEventsDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Opens, appends `count` plain test events, closes; returns nothing the file can't show. */
function seedLog(dir: string, count: number, checkpointEveryAppends = 0): void {
  const { log } = EventLog.open(dir, { fsyncOnAppend: false, checkpointEveryAppends });
  try {
    for (let index = 0; index < count; index += 1) {
      log.append({
        type: 'test.event',
        actor: 'daemon',
        missionVersion: 'MISSION-000001',
        subjectId: null,
        payload: { index },
      });
    }
  } finally {
    log.close();
  }
}

const eventsFile = (dir: string): string => join(dir, 'events.ndjson');

/** The file's complete, newline-terminated lines, in order. */
function committedLines(dir: string): string[] {
  return readFileSync(eventsFile(dir), 'utf8').split('\n').filter((line) => line !== '');
}

/* ========================================================================= */
/* Torn tail: repaired, receipted, never silent                               */
/* ========================================================================= */

test('INT-P0-01: a torn tail is repaired on open, receipted, and history stays appendable', () => {
  const dir = makeEventsDir();
  try {
    seedLog(dir, 3);
    const torn = '{"id":"EVENT-0000';
    appendFileSync(eventsFile(dir), torn);

    const { log, report } = EventLog.open(dir, { fsyncOnAppend: false });
    try {
      assert.equal(report.repairedBytes, Buffer.byteLength(torn), 'exactly the torn bytes go');
      assert.equal(report.discardedTailSha256, sha256(torn), 'the receipt can name what went');
      assert.ok(report.recoveryReceiptPath !== null, 'recovery is receipted, not silent');
      assert.ok(existsSync(report.recoveryReceiptPath), 'the receipt is durable');
      const receipt: unknown = JSON.parse(readFileSync(report.recoveryReceiptPath, 'utf8'));
      assert.ok(typeof receipt === 'object' && receipt !== null, 'the receipt parses');

      assert.equal(report.head?.sequence, 2, 'the last committed record is the head');
      const appended = log.append({
        type: 'test.event',
        actor: 'daemon',
        missionVersion: 'MISSION-000001',
        subjectId: null,
        payload: { after: 'recovery' },
      });
      assert.equal(appended.sequence, 3, 'appends continue from the repaired head');
    } finally {
      log.close();
    }

    // A clean reopen after the repair: nothing to fix, nothing receipted.
    const second = EventLog.open(dir, { fsyncOnAppend: false });
    try {
      assert.equal(second.report.repairedBytes, 0);
      assert.equal(second.report.recoveryReceiptPath, null);
      const verified = second.log.verify();
      assert.equal(verified.records, 4, 'full-chain verification passes after recovery');
      const sequences = [...second.log.replay()].map((record) => record.sequence);
      assert.deepEqual(sequences, [0, 1, 2, 3], 'the history is contiguous');
    } finally {
      second.log.close();
    }
  } finally {
    removeEventsDir(dir);
  }
});

/* ========================================================================= */
/* A terminated garbage line is not a torn tail                               */
/* ========================================================================= */

test('INT-P0-01: a newline-terminated garbage line is refused, and the file is left untouched', () => {
  const dir = makeEventsDir();
  try {
    seedLog(dir, 2);
    appendFileSync(eventsFile(dir), 'this is not an event record\n');
    const bytesBefore = readFileSync(eventsFile(dir));

    assert.throws(
      () => EventLog.open(dir, { fsyncOnAppend: false }),
      (error: unknown) => error instanceof EventLogError && error.code === 'MALFORMED_RECORD',
      'a committed-looking line is never discarded as if it were a torn tail',
    );

    const bytesAfter = readFileSync(eventsFile(dir));
    assert.ok(bytesBefore.equals(bytesAfter), 'a refused open changes nothing on disk');
  } finally {
    removeEventsDir(dir);
  }
});

/* ========================================================================= */
/* Tampered committed record: caught by code and by sequence                  */
/* ========================================================================= */

test('INT-P0-01: a tampered committed record fails open("full") and verify() with HASH_MISMATCH at its sequence', () => {
  const dir = makeEventsDir();
  try {
    seedLog(dir, 5);
    const lines = committedLines(dir);
    const tampered = lines[2]?.replace('"index":2', '"index":99');
    assert.ok(tampered !== undefined && tampered !== lines[2], 'the injection changed the record');
    lines[2] = tampered;
    writeFileSync(eventsFile(dir), `${lines.join('\n')}\n`, 'utf8');

    assert.throws(
      () => EventLog.open(dir, { fsyncOnAppend: false, verifyOnOpen: 'full' }),
      (error: unknown) =>
        error instanceof EventLogError && error.code === 'HASH_MISMATCH' && error.sequence === 2,
    );

    // The same fault, caught at the standalone verification surface.
    const { log } = EventLog.open(dir, { fsyncOnAppend: false, verifyOnOpen: 'none' });
    try {
      assert.throws(
        () => log.verify(),
        (error: unknown) =>
          error instanceof EventLogError && error.code === 'HASH_MISMATCH' && error.sequence === 2,
      );
    } finally {
      log.close();
    }
  } finally {
    removeEventsDir(dir);
  }
});

/* ========================================================================= */
/* Reordered records: the event-order fault                                   */
/* ========================================================================= */

test('INT-P0-01: swapping two committed records is caught by the chain, not by per-record hashes', () => {
  const dir = makeEventsDir();
  try {
    seedLog(dir, 4);
    const lines = committedLines(dir);
    const [a, b] = [lines[1], lines[2]];
    assert.ok(a !== undefined && b !== undefined);
    lines[1] = b;
    lines[2] = a;
    writeFileSync(eventsFile(dir), `${lines.join('\n')}\n`, 'utf8');

    assert.throws(
      () => EventLog.open(dir, { fsyncOnAppend: false, verifyOnOpen: 'full' }),
      (error: unknown) =>
        error instanceof EventLogError &&
        (error.code === 'CHAIN_BROKEN' || error.code === 'SEQUENCE_GAP') &&
        error.sequence !== null,
      'each swapped record still hashes clean alone; only the chain and order rules can see this',
    );
  } finally {
    removeEventsDir(dir);
  }
});

/* ========================================================================= */
/* The checkpoint is a trust anchor                                           */
/* ========================================================================= */

test('INT-P0-01: shortened committed history fails the checkpoint; a merely-torn tail passes it', () => {
  // Lost committed history: the last *committed* record is removed entirely.
  const shortened = makeEventsDir();
  try {
    seedLog(shortened, 3, 1); // checkpoint after every append: anchor head is sequence 2
    const lines = committedLines(shortened);
    writeFileSync(eventsFile(shortened), `${lines.slice(0, 2).join('\n')}\n`, 'utf8');

    assert.throws(
      () => EventLog.open(shortened, { fsyncOnAppend: false }),
      (error: unknown) => error instanceof EventLogError && error.code === 'CHECKPOINT_CONFLICT',
      'a head behind the checkpoint means committed history was lost, and that is refused',
    );
  } finally {
    removeEventsDir(shortened);
  }

  // The same anchor must tolerate a torn tail, or crash recovery would be impossible.
  const torn = makeEventsDir();
  try {
    seedLog(torn, 3, 1);
    appendFileSync(eventsFile(torn), '{"partial":');

    const { log, report } = EventLog.open(torn, { fsyncOnAppend: false });
    try {
      assert.ok(report.repairedBytes > 0, 'the tail was repaired');
      assert.equal(report.head?.sequence, 2, 'the checkpointed head survives the repair');
      assert.equal(report.checkpoint?.head?.sequence, 2, 'and matches the anchor');
    } finally {
      log.close();
    }
  } finally {
    removeEventsDir(torn);
  }
});
