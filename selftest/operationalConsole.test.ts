import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '../src/memory/artifactStore.js';
import { mirrorOperation } from '../src/observability/operationalConsole/adapters.js';
import { parseOperationalConsoleProjection } from '../src/observability/operationalConsole/contract.js';
import { projectOperationalConsole } from '../src/observability/operationalConsole/projection.js';
import {
  OperationalConsoleRecorder,
  OperationalConsoleRecorderError,
} from '../src/observability/operationalConsole/recorder.js';
import { redactOperationalText } from '../src/observability/operationalConsole/redaction.js';
import {
  OperationalConsoleEventStore,
  OperationalConsoleStoreError,
  readOperationalConsoleEvents,
  readOperationalConsoleTail,
} from '../src/observability/operationalConsole/store.js';

interface Fixture {
  readonly root: string;
  readonly eventFile: string;
  readonly blobs: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'clue-operational-console-'));
  return {
    root,
    eventFile: join(root, 'console', 'events.ndjson'),
    blobs: join(root, 'blobs'),
  };
}

function clean(value: Fixture): void {
  rmSync(value.root, { recursive: true, force: true });
}

test('records exact send, exact receive, then a separate CLU-E interpretation', async () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    const artifacts = new ArtifactStore(f.blobs);
    const recorder = new OperationalConsoleRecorder(store, artifacts, {
      environment: { OPENAI_API_KEY: 'sk-secret-value-1234567890' },
    });

    const result = await mirrorOperation(recorder, {
      channel: 'GPT',
      title: 'Purpose review',
      what: 'Review the target purpose before a patch is designed.',
      why: 'A metric gain is invalid when it destroys the target purpose.',
      nextAction: 'Validate the returned purpose record.',
      exactRequest: JSON.stringify({
        role: 'Purpose Reviewer',
        authorization: 'Bearer sk-secret-value-1234567890',
      }),
      requestFormat: 'json',
      responseFormat: 'json',
      logicalSessionId: 'SES-0001',
      physicalCallId: 'CALL-0001',
      execute: async () => ({ preserved: true, confidence: 0.94 }),
      exactResponse: (value) => JSON.stringify(value),
      summarize: (value) => ({
        title: 'Purpose review accepted',
        what: 'The target purpose was reconstructed and preserved.',
        why: 'The proposed assessment may proceed only with this purpose context.',
        status: value.preserved ? 'PURPOSE CONTEXT AVAILABLE' : 'PURPOSE CONTEXT BLOCKED',
        nextAction: 'Freeze the proof contract.',
        validationState: 'schema_validated',
        payloadText: `Confidence: ${value.confidence}`,
      }),
    });

    assert.equal(result.preserved, true);
    const events = readOperationalConsoleEvents(f.eventFile);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.direction), ['OUTBOUND', 'INBOUND', 'INTERNAL']);
    assert.deepEqual(events.map((event) => event.kind), ['request', 'response', 'summary']);
    assert.equal(events[0]?.exchangeId, events[1]?.exchangeId);
    assert.equal(events[1]?.exchangeId, events[2]?.exchangeId);
    assert.equal(events[0]?.requestId, events[1]?.requestId);
    assert.equal(events[1]?.requestId, events[2]?.requestId);

    const outbound = events[0]?.payload;
    assert.notEqual(outbound, null);
    assert.equal(outbound?.redactionCount, 2);
    assert.match(outbound?.preview ?? '', /REDACTED/);
    assert.doesNotMatch(outbound?.preview ?? '', /sk-secret-value/);
    if (outbound !== null && outbound !== undefined) {
      const persisted = artifacts.getText(outbound.artifactHash);
      assert.match(persisted, /REDACTED/);
      assert.doesNotMatch(persisted, /sk-secret-value/);
    }
  } finally {
    store.close();
    clean(f);
  }
});

test('redaction removes secrets before persistence while preserving ordinary code', () => {
  const result = redactOperationalText(
    'npm run build\nAuthorization: Bearer abcdefghijklmnop\nconst token = "safe-label";',
    {},
  );
  assert.match(result.text, /npm run build/);
  assert.match(result.text, /REDACTED/);
  assert.doesNotMatch(result.text, /abcdefghijklmnop/);
  assert.equal(result.count, 1);
});

test('projection is validated, sealed, and preserves event order', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    const recorder = new OperationalConsoleRecorder(store, new ArtifactStore(f.blobs));
    recorder.recordState({
      channel: 'RECOGNITION',
      title: 'Recognition committed',
      what: 'The graph is durable.',
      why: 'Only committed recognition may become interface truth.',
      status: 'COMMITTED',
      nextAction: 'Build the applicability matrix.',
      context: { runId: 'RUN-0001' },
    });
    recorder.recordState({
      channel: 'STATUS',
      title: 'State sealed',
      what: 'The current console projection was sealed.',
      why: 'The visible state must be replayable.',
      status: 'SEALED',
      cinematicCue: 'status_seal',
    });

    const projected = projectOperationalConsole(f.eventFile, {
      capturedAt: '2026-07-27T00:00:00.000Z',
    });
    const parsed = parseOperationalConsoleProjection(projected);
    assert.equal(parsed.events.length, 2);
    assert.deepEqual(parsed.events.map((event) => event.sequence), [0, 1]);
    assert.equal(parsed.firstSequence, 0);
    assert.equal(parsed.lastSequence, 1);
    assert.equal(parsed.seal.eventHeadHash, parsed.events[1]?.eventHash ?? null);
  } finally {
    store.close();
    clean(f);
  }
});

test('tampering with a persisted line breaks the hash chain', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    const recorder = new OperationalConsoleRecorder(store, new ArtifactStore(f.blobs));
    recorder.recordState({
      channel: 'CLUE_CORE',
      title: 'Original state',
      what: 'Persist one truthful event.',
      why: 'Tampering must be detectable.',
      status: 'RECORDED',
    });
  } finally {
    store.close();
  }

  try {
    const original = readFileSync(f.eventFile, 'utf8');
    writeFileSync(f.eventFile, original.replace('Original state', 'Altered state'), 'utf8');
    assert.throws(
      () => readOperationalConsoleEvents(f.eventFile),
      (error: unknown) =>
        error instanceof OperationalConsoleStoreError && error.code === 'CHAIN_BROKEN',
    );
  } finally {
    clean(f);
  }
});

/* ------------------------------------------------------------------------- */
/* DEV-P1-22 — lock CAS, whole-buffer writes, listener isolation, bounded replay */
/* ------------------------------------------------------------------------- */

/** Appends `count` plain state events and returns the store's head sequence. */
function fill(store: OperationalConsoleEventStore, count: number): number {
  const recorder = new OperationalConsoleRecorder(store, new ArtifactStore(join(tmpdir(), 'clue-oc-blobs')));
  for (let index = 0; index < count; index += 1) {
    recorder.recordState({
      channel: 'CLUE_CORE',
      title: `event ${index}`,
      what: `state ${index}`,
      why: 'bounded replay needs a history to be bounded against',
      status: 'RECORDED',
    });
  }
  return store.getHead()?.sequence ?? -1;
}

test('DEV-P1-22: a live lock refuses a second writer and a stale lock is recovered by token', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    // A live lock is refused with LOCKED, not with a raw errno.
    assert.throws(
      () => OperationalConsoleEventStore.open(f.eventFile),
      (error: unknown) =>
        error instanceof OperationalConsoleStoreError && error.code === 'LOCKED',
      'a second writer on an append-only chain must be refused',
    );

    // The lock is a record, not a bare pid: pids are recycled, tokens are not.
    const lock = JSON.parse(readFileSync(`${f.eventFile}.lock`, 'utf8')) as Record<string, unknown>;
    assert.equal(lock['pid'], process.pid);
    assert.equal(typeof lock['token'], 'string');
  } finally {
    store.close();
  }

  try {
    // A lock owned by a dead pid is recoverable...
    writeFileSync(
      `${f.eventFile}.lock`,
      JSON.stringify({ pid: 2_147_483_646, token: 'dead-token', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    const recovered = OperationalConsoleEventStore.open(f.eventFile);
    const token = (JSON.parse(readFileSync(`${f.eventFile}.lock`, 'utf8')) as Record<string, unknown>)['token'];
    assert.notEqual(token, 'dead-token', 'recovery replaces the stale lock with our own');
    recovered.close();

    // ...but an unreadable lock is never stolen: its owner may be mid-write.
    writeFileSync(`${f.eventFile}.lock`, 'not json at all', 'utf8');
    assert.throws(
      () => OperationalConsoleEventStore.open(f.eventFile),
      (error: unknown) =>
        error instanceof OperationalConsoleStoreError && error.code === 'LOCKED',
    );
  } finally {
    rmSync(`${f.eventFile}.lock`, { force: true });
    clean(f);
  }
});

test('DEV-P1-22: releasing a lock that is no longer ours leaves the new owner alone', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    // Simulate a recoverer having decided we were dead and taken the lock.
    writeFileSync(
      `${f.eventFile}.lock`,
      JSON.stringify({ pid: process.pid, token: 'someone-else', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    store.close();
    const survivor = JSON.parse(readFileSync(`${f.eventFile}.lock`, 'utf8')) as Record<string, unknown>;
    assert.equal(
      survivor['token'],
      'someone-else',
      'close() must not delete a lock another owner holds',
    );
  } finally {
    rmSync(`${f.eventFile}.lock`, { force: true });
    clean(f);
  }
});

test('DEV-P1-22: one failing listener neither silences the others nor escapes into append', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    const seen: string[] = [];
    store.subscribe(() => {
      throw new Error('listener exploded');
    });
    store.subscribe((event) => seen.push(`second:${event.sequence}`));
    // A listener that unsubscribes during dispatch must not disturb the iteration.
    const unsubscribe = store.subscribe(() => {
      unsubscribe();
      seen.push('third');
    });

    const recorder = new OperationalConsoleRecorder(store, new ArtifactStore(f.blobs));
    assert.doesNotThrow(() =>
      recorder.recordState({
        channel: 'CLUE_CORE',
        title: 'Durable already',
        what: 'The event is on disk before any listener runs.',
        why: 'A throw here would invite a retry that appends it twice.',
        status: 'RECORDED',
      }),
    );

    assert.deepEqual(seen, ['second:0', 'third'], 'later listeners still received the event');
    assert.equal(store.listenerHealth().failures, 1);
    assert.equal(store.listenerHealth().lastError, 'listener exploded');
    // The event is durable exactly once.
    assert.equal(readOperationalConsoleEvents(f.eventFile).length, 1);
  } finally {
    store.close();
    clean(f);
  }
});

test('DEV-P1-22: replay is bounded, verified within its window, and declares what it dropped', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    const head = fill(store, 40);
    assert.equal(head, 39);

    // A tail window returns only the limit, and says how many it left behind.
    const tail = readOperationalConsoleTail(f.eventFile, { limit: 5 });
    assert.equal(tail.events.length, 5);
    assert.deepEqual(tail.events.map((event) => event.sequence), [35, 36, 37, 38, 39]);
    assert.equal(tail.headSequence, 39);
    assert.equal(tail.truncated, true);
    assert.equal(tail.droppedEvents, 35, 'the excluded history is announced, not hidden');
    assert.equal(tail.joinVerified, true, 'the window links to the line before it');

    // "Everything after N" is the SSE reconnect case and returns exactly that.
    const since = readOperationalConsoleTail(f.eventFile, { afterSequence: 36, limit: 250 });
    assert.deepEqual(since.events.map((event) => event.sequence), [37, 38, 39]);
    assert.equal(since.droppedEvents, 0);
    assert.equal(since.truncated, false);

    // A window that spans the whole history begins at zero and needs no join.
    const whole = readOperationalConsoleTail(f.eventFile, { limit: 250 });
    assert.equal(whole.events.length, 40);
    assert.equal(whole.firstSequence, 0);
    assert.equal(whole.joinVerified, true);

    // The window agrees, event for event, with the whole-chain authority.
    const authoritative = readOperationalConsoleEvents(f.eventFile);
    assert.deepEqual(whole.events, [...authoritative]);
  } finally {
    store.close();
    clean(f);
  }
});

test('DEV-P1-22: a tampered line inside the replay window is refused, not served', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    fill(store, 12);
  } finally {
    store.close();
  }
  try {
    const lines = readFileSync(f.eventFile, 'utf8').split('\n').filter(Boolean);
    const target = lines[10] ?? '';
    lines[10] = target.replace('"status":"RECORDED"', '"status":"ALTERED!"');
    writeFileSync(f.eventFile, `${lines.join('\n')}\n`, 'utf8');
    assert.throws(
      () => readOperationalConsoleTail(f.eventFile, { limit: 5 }),
      (error: unknown) =>
        error instanceof OperationalConsoleStoreError && error.code === 'CHAIN_BROKEN',
      'a bounded read still verifies every event it returns',
    );
  } finally {
    clean(f);
  }
});

test('DEV-P1-22: a partially written trailing line is never served as a committed event', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    fill(store, 4);
  } finally {
    store.close();
  }
  try {
    // What a crash mid-append leaves behind: bytes with no terminating newline.
    const text = readFileSync(f.eventFile, 'utf8');
    writeFileSync(f.eventFile, `${text}{"sequence":4,"partial":`, 'utf8');
    const tail = readOperationalConsoleTail(f.eventFile, { limit: 10 });
    assert.equal(tail.events.length, 4);
    assert.equal(tail.lastSequence, 3, 'truth ends at the last whole, fsynced line');
  } finally {
    clean(f);
  }
});

test('DEV-P1-23: an exchange with no correlation identity is refused, not appended', () => {
  const f = fixture();
  const store = OperationalConsoleEventStore.open(f.eventFile);
  try {
    const recorder = new OperationalConsoleRecorder(store, new ArtifactStore(f.blobs), {
      environment: {},
    });
    const opened = {
      channel: 'CHROME_CDP',
      kind: 'request',
      title: 'CDP request · Page.navigate',
      what: 'Transmit the exact Chrome DevTools Protocol request.',
      why: 'An exchange that cannot name its execution is an effect with no cause.',
      status: 'TRANSMITTING',
      exactPayload: JSON.stringify({ id: 1, method: 'Page.navigate' }),
      payloadFormat: 'json',
    } as const;

    assert.throws(
      () => recorder.beginExchange({ ...opened }),
      (error: unknown) =>
        error instanceof OperationalConsoleRecorderError &&
        error.code === 'UNCORRELATED_EXCHANGE',
      'no runId, physicalCallId, logicalSessionId or taskId',
    );

    // A whitespace identity is an absence wearing a presence. A truthiness check would
    // have accepted this one, which is why the predicate trims before it decides.
    assert.throws(
      () => recorder.beginExchange({ ...opened, physicalCallId: '   ' }),
      (error: unknown) =>
        error instanceof OperationalConsoleRecorderError &&
        error.code === 'UNCORRELATED_EXCHANGE',
      'a blank identity does not correlate anything',
    );

    assert.equal(
      readOperationalConsoleEvents(f.eventFile).length,
      0,
      'a refused exchange leaves no orphan in the append-only chain',
    );

    // The production shape, as hostClient.ts and browserAgent.ts open one. The identity
    // is supplied once at the open and inherited by every event of the exchange.
    const exchange = recorder.beginExchange({ ...opened, physicalCallId: 'CDP-1' });
    exchange.receive({
      title: 'CDP response',
      what: 'Receive the correlated response.',
      why: 'A request being sent is not evidence that it returned.',
      status: 'RECEIVED',
      exactPayload: JSON.stringify({ id: 1, result: {} }),
      payloadFormat: 'json',
    });
    exchange.summarize({
      title: 'Navigation complete',
      what: 'The page reached a load state.',
      why: 'The scenario may proceed.',
      status: 'OK',
      validationState: 'schema_validated',
    });

    // recordState is exempt by construction: it passes exchangeId null, and at daemon
    // startup there is genuinely no run, call or task to name.
    recorder.recordState({
      channel: 'CLUE_CORE',
      title: 'daemon started',
      what: 'The daemon reached a serving state.',
      why: 'Operators need the transition recorded.',
      status: 'RUNNING',
    });

    const events = readOperationalConsoleEvents(f.eventFile);
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((event) => event.physicalCallId),
      ['CDP-1', 'CDP-1', 'CDP-1', null],
      'the identity given at the open reaches receive and summarize',
    );
    assert.equal(events[3]?.exchangeId, null, 'the exempt event is the one with no exchange');
    for (const event of events) {
      if (event.exchangeId === null) continue;
      const correlated =
        event.runId !== null ||
        event.physicalCallId !== null ||
        event.logicalSessionId !== null ||
        event.taskId !== null;
      assert.equal(correlated, true, `event ${event.sequence} carries an exchange it cannot place`);
    }
  } finally {
    store.close();
    clean(f);
  }
});
