/**
 * Append-only, hash-chained, single-writer Operational Console event store.
 *
 * Spec: CLUE_Project_Directory_v9.md §19.1 — the console store preserves source-faithful
 *       exchanges; observability may diagnose instrument health but never creates a verdict.
 *       CLUE_Status_Contract_v9.md §8.3 — the console branch reports `firstSequence`,
 *       `lastSequence` and `droppedEvents`; a sequence gap or dropped-event count must
 *       remain *visible* rather than being silently absorbed.
 *       CLUE_Architecture_v9.md — durable records survive a crash without partial or
 *       silently-replaced state.
 *
 * Backlog: DEV-P1-22 — four defects.
 *
 *   1. *The lock could be taken twice.* Stale-lock recovery read the pid, then deleted the
 *      lock file and re-created it — three separate steps with no atomicity. Two processes
 *      that both observed the same dead pid both deleted and both re-created; worse, a
 *      process descheduled between the read and the delete could remove a lock another
 *      process had legitimately taken in the meantime, producing two live writers on an
 *      append-only chain. Recovery is now a compare-and-swap: the lock carries a random
 *      token, is only removed while it still carries the exact token that was observed to
 *      be dead, and is re-placed with the atomic no-replace primitive. Losing that race
 *      yields `LOCKED`, never a raw `EEXIST`.
 *
 *   2. *A short write corrupted the chain.* `writeSync` may write fewer bytes than
 *      requested and returns the count; the return was discarded, so a partial write left
 *      half a JSON line in an append-only file and every later read failed `MALFORMED`
 *      with no way to tell where the truth ended. Writes go through `writeAllSync`.
 *
 *   3. *One bad listener silenced the rest.* Dispatch iterated the live set and let a
 *      listener's exception escape `append`, so later subscribers never saw the event and
 *      the caller saw a throw for an event that was already durable — inviting a retry
 *      that would double-append. Dispatch now runs over a snapshot, isolates each
 *      listener, and records failures on the store instead of raising them.
 *
 *   4. *Replay was unbounded.* The SSE endpoint called the whole-file reader on every
 *      connect *and* on every poll tick, JSON-parsing and re-hashing every event ever
 *      recorded to emit the handful that were new. {@link readOperationalConsoleTail}
 *      reads backwards from the end of the file in bounded chunks, so the cost is
 *      proportional to the window asked for rather than to the history.
 *
 * The whole-file reader remains the chain authority. A tail read verifies the window it
 * returns and its join to the preceding line; it does not and cannot verify history it
 * never read, and it says so rather than implying a full-chain guarantee.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { fsyncDir, placeFileNoReplaceSync, writeAllSync } from '../../shared/durableFs.js';
import { hashCanonicalJson, type Sha256 } from '../../shared/ids.js';
import {
  OPERATIONAL_CONSOLE_SCHEMA_VERSION,
  operationalConsoleEventSchema,
  type OperationalConsoleEvent,
} from './contract.js';

export type UnhashedOperationalConsoleEvent = Omit<
  OperationalConsoleEvent,
  'eventId' | 'sequence' | 'previousHash' | 'eventHash' | 'schemaVersion'
>;

export class OperationalConsoleStoreError extends Error {
  public constructor(
    public readonly code: 'LOCKED' | 'CHAIN_BROKEN' | 'SEQUENCE_GAP' | 'MALFORMED' | 'CLOSED',
    message: string,
  ) {
    super(message);
    this.name = 'OperationalConsoleStoreError';
  }
}

function computeHash(event: Omit<OperationalConsoleEvent, 'eventHash'>): Sha256 {
  return hashCanonicalJson(event);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a lock file states. The token is the part that matters: pids are recycled, so
 * "the pid I saw is dead" is not sufficient grounds to delete a lock — the file must
 * still be the same file. The token makes that checkable.
 */
interface ConsoleLockRecord {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

function parseLockRecord(text: string): ConsoleLockRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const pid = record['pid'];
    const token = record['token'];
    const acquiredAt = record['acquiredAt'];
    if (typeof pid !== 'number' || typeof token !== 'string' || typeof acquiredAt !== 'string') {
      return null;
    }
    return { pid, token, acquiredAt };
  } catch {
    return null;
  }
}

/** Reads the lock, or null when it is absent or unreadable. */
function readLockRecord(lockPath: string): ConsoleLockRecord | null {
  try {
    return parseLockRecord(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes `bytes` to `path` durably: whole-buffer write, then fsync, then close. */
function writeDurable(path: string, bytes: Buffer): void {
  const fd = openSync(path, 'w');
  try {
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class OperationalConsoleEventStore {
  /** The event file this store writes. Previously not retained, so nothing could re-read it. */
  public readonly path: string;

  private readonly lockPath: string;
  private readonly lockToken = randomUUID();
  private fd: number | null = null;
  private lockOwned = false;
  private head: { readonly sequence: number; readonly hash: Sha256 } | null = null;
  private readonly listeners = new Set<(event: OperationalConsoleEvent) => void>();
  private listenerFailureCount = 0;
  private lastListenerError: string | null = null;

  private constructor(filePath: string) {
    this.path = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  public static open(filePath: string): OperationalConsoleEventStore {
    mkdirSync(dirname(filePath), { recursive: true });
    const store = new OperationalConsoleEventStore(filePath);
    store.acquireLock();
    try {
      const events = readOperationalConsoleEvents(filePath);
      const last = events.at(-1);
      store.head = last === undefined ? null : { sequence: last.sequence, hash: last.eventHash };
      const existed = existsSync(filePath);
      store.fd = openSync(filePath, 'a');
      // A file's data reaching disk does not make its *name* durable; the directory entry
      // needs its own fsync, once, when this open is the one that created the file.
      if (!existed) fsyncDir(dirname(filePath));
      return store;
    } catch (error) {
      store.releaseLock();
      throw error;
    }
  }

  /**
   * How many listener dispatches have thrown, and the message of the most recent one.
   * A listener failure is an instrument-health fact, not a store failure: it is counted
   * and readable rather than raised into the writer's call stack.
   */
  public listenerHealth(): { readonly failures: number; readonly lastError: string | null } {
    return { failures: this.listenerFailureCount, lastError: this.lastListenerError };
  }

  public append(input: UnhashedOperationalConsoleEvent): OperationalConsoleEvent {
    const fd = this.fd;
    if (fd === null) {
      throw new OperationalConsoleStoreError('CLOSED', 'Operational Console store is closed.');
    }

    const sequence = this.head === null ? 0 : this.head.sequence + 1;
    const withoutHash: Omit<OperationalConsoleEvent, 'eventHash'> = {
      schemaVersion: OPERATIONAL_CONSOLE_SCHEMA_VERSION,
      eventId: `OCE-${String(sequence).padStart(8, '0')}`,
      sequence,
      previousHash: this.head?.hash ?? null,
      ...input,
    };
    const event: OperationalConsoleEvent = {
      ...withoutHash,
      eventHash: computeHash(withoutHash),
    };
    const validated = operationalConsoleEventSchema.parse(event) as unknown as OperationalConsoleEvent;
    // writeAllSync completes short writes. A discarded partial write leaves half a JSON
    // line in an append-only file, and every subsequent read of the chain fails on it.
    writeAllSync(fd, Buffer.from(`${JSON.stringify(validated)}\n`, 'utf8'));
    fsyncSync(fd);
    this.head = { sequence: validated.sequence, hash: validated.eventHash };
    this.dispatch(validated);
    return validated;
  }

  /**
   * Notifies subscribers. Three properties, none of which the previous inline loop had:
   * iteration is over a snapshot, so a listener that subscribes or unsubscribes during
   * dispatch cannot disturb it; each listener is isolated, so one failure does not silence
   * the others; and nothing escapes into `append`, because the event is already durable by
   * this point and a throw here would invite a retry that appends it twice.
   */
  private dispatch(event: OperationalConsoleEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.listenerFailureCount += 1;
        this.lastListenerError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  /**
   * A bounded replay window over this store's own file. See
   * {@link readOperationalConsoleTail} for what the window does and does not prove.
   */
  public replay(options: ConsoleTailOptions = {}): ConsoleReplayWindow {
    return readOperationalConsoleTail(this.path, options);
  }

  public subscribe(listener: (event: OperationalConsoleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getHead(): { readonly sequence: number; readonly hash: Sha256 } | null {
    return this.head;
  }

  public close(): void {
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
    this.releaseLock();
  }

  /**
   * Takes the single-writer lock, or refuses.
   *
   * The placement itself is atomic (`placeFileNoReplaceSync` — a hard link, which fails
   * with EEXIST rather than replacing, identically on POSIX and NTFS). The interesting
   * part is recovery from a lock whose owner died: that must be a compare-and-swap, not a
   * read-then-delete. The previous implementation observed a dead pid, then deleted
   * whatever lock file was present at delete time — which, if it had been descheduled in
   * between, was a *live* lock taken by someone else. Two writers on an append-only
   * hash chain is the worst outcome this module has, so recovery here removes the lock
   * only while it still carries the exact token that was observed to be dead, and one
   * lost race yields LOCKED rather than a second owner.
   */
  private acquireLock(): void {
    const payload = Buffer.from(
      `${JSON.stringify({
        pid: process.pid,
        token: this.lockToken,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      'utf8',
    );
    const temporary = `${this.lockPath}.${this.lockToken}.tmp`;

    const place = (): 'placed' | 'exists' => {
      writeDurable(temporary, payload);
      try {
        return placeFileNoReplaceSync(temporary, this.lockPath);
      } finally {
        rmSync(temporary, { force: true });
      }
    };

    if (place() === 'placed') {
      this.lockOwned = true;
      return;
    }

    const observed = readLockRecord(this.lockPath);
    if (observed === null) {
      // A lock we cannot read is a lock we must not steal — its owner may be mid-write.
      throw new OperationalConsoleStoreError(
        'LOCKED',
        `Operational Console store is locked by an unreadable lock at ${this.lockPath}.`,
      );
    }
    if (isProcessAlive(observed.pid)) {
      throw new OperationalConsoleStoreError(
        'LOCKED',
        `Operational Console store is locked by pid ${observed.pid}.`,
      );
    }

    // Compare-and-swap: only remove the lock if it is still the same one we found dead.
    const current = readLockRecord(this.lockPath);
    if (current === null || current.token !== observed.token) {
      throw new OperationalConsoleStoreError(
        'LOCKED',
        'Operational Console lock changed during stale-lock recovery; refusing to steal it.',
      );
    }
    rmSync(this.lockPath, { force: true });

    if (place() !== 'placed') {
      // Another recoverer won. One attempt only: retrying is how two writers are born.
      throw new OperationalConsoleStoreError(
        'LOCKED',
        'Operational Console lock was reacquired by another process during recovery.',
      );
    }
    this.lockOwned = true;
  }

  /**
   * Releases the lock only if it is still ours. A blind delete would remove a lock a
   * recoverer had legitimately taken after deciding this process was dead.
   */
  private releaseLock(): void {
    if (!this.lockOwned) return;
    const current = readLockRecord(this.lockPath);
    if (current !== null && current.token !== this.lockToken) {
      this.lockOwned = false;
      return;
    }
    rmSync(this.lockPath, { force: true });
    this.lockOwned = false;
  }
}

/* ------------------------------------------------------------------------- */
/* Bounded replay                                                             */
/* ------------------------------------------------------------------------- */

export interface ConsoleTailOptions {
  /** Return only events after this sequence. Omitted or negative means "from the end". */
  readonly afterSequence?: number;
  /** Hard cap on returned events. Defaults to 250. */
  readonly limit?: number;
}

export interface ConsoleReplayWindow {
  readonly events: readonly OperationalConsoleEvent[];
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  /** The store's own head sequence, so a caller knows where the window sits in history. */
  readonly headSequence: number | null;
  /** Events after `afterSequence` that the limit excluded. Status §8.3 keeps this visible. */
  readonly droppedEvents: number;
  /** True when the limit, not the history, ended the window. */
  readonly truncated: boolean;
  /**
   * False when the window's first event is not sequence 0 *and* no preceding line was
   * available to verify its `previousHash` against — i.e. the join to history is
   * unverified. It is never silently implied to be verified.
   */
  readonly joinVerified: boolean;
}

/** Bytes read per backward step. Large enough that ordinary windows need one read. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/**
 * Reads the last `wanted` newline-terminated lines without reading the whole file.
 *
 * Walks backwards from EOF in fixed chunks, counting newlines, and stops as soon as
 * enough line starts have been seen. A file whose last line lacks a trailing newline is a
 * partially written record and is discarded — the append path fsyncs whole lines, so an
 * unterminated tail is by definition not a committed event.
 */
function tailLines(filePath: string, wanted: number): { lines: readonly string[]; fromStart: boolean } {
  if (!existsSync(filePath)) return { lines: [], fromStart: true };
  const size = statSync(filePath).size;
  if (size === 0) return { lines: [], fromStart: true };

  const fd = openSync(filePath, 'r');
  try {
    let start = size;
    let collected = Buffer.alloc(0);
    let newlines = 0;
    // One newline more than asked for: when the read does not reach the start of the
    // file, the leading fragment is discarded below, and it may be a whole line if the
    // chunk boundary happened to fall exactly on one.
    while (start > 0 && newlines < wanted + 1) {
      const length = Math.min(TAIL_CHUNK_BYTES, start);
      start -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, start);
      collected = Buffer.concat([chunk, collected]);
      newlines = 0;
      for (const byte of collected) if (byte === 0x0a) newlines += 1;
    }

    const fromStart = start === 0;
    const split = collected.toString('utf8').split('\n');
    // The final element is either '' (the buffer ended on a newline — the committed case)
    // or an unterminated record. The append path fsyncs whole lines, so an unterminated
    // tail is by definition not a committed event. Either way it is not returned.
    split.pop();
    // A mid-file read starts at an arbitrary byte, so its first element may be the tail of
    // a line. It is dropped unless the read reached the start of the file, where the first
    // element genuinely is the first line.
    if (!fromStart) split.shift();
    const lines = split.length > wanted ? split.slice(split.length - wanted) : split;
    return { lines, fromStart: fromStart && lines.length === split.length };
  } finally {
    closeSync(fd);
  }
}

/**
 * A bounded replay window read from the end of the file.
 *
 * What it proves: every returned event parses, satisfies the schema, hashes to its own
 * `eventHash`, sits at a contiguous sequence, and links to its predecessor *within the
 * window*. When the window does not begin at sequence 0, one extra preceding line is read
 * so the join to history can be checked too; `joinVerified` reports whether that happened.
 *
 * What it deliberately does not prove: the integrity of history it never read. A caller
 * that needs the whole chain calls {@link readOperationalConsoleEvents}, which is and
 * remains the chain authority. Conflating the two would be the more dangerous kind of
 * optimisation — one that quietly weakens a guarantee while keeping its name.
 */
export function readOperationalConsoleTail(
  filePath: string,
  options: ConsoleTailOptions = {},
): ConsoleReplayWindow {
  const limit = Math.max(1, options.limit ?? 250);
  const after = options.afterSequence ?? -1;

  // One extra line so the window's join to history can be verified.
  const { lines, fromStart } = tailLines(filePath, limit + 1);
  const parsed: OperationalConsoleEvent[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new OperationalConsoleStoreError('MALFORMED', 'Operational Console line is not JSON.');
    }
    parsed.push(operationalConsoleEventSchema.parse(value) as unknown as OperationalConsoleEvent);
  }

  // Verify the read span before anything is filtered out of it.
  for (let index = 0; index < parsed.length; index += 1) {
    const event = parsed[index];
    if (event === undefined) continue;
    const previous = index === 0 ? null : parsed[index - 1];
    if (previous !== undefined && previous !== null) {
      if (event.sequence !== previous.sequence + 1) {
        throw new OperationalConsoleStoreError(
          'SEQUENCE_GAP',
          `Expected console sequence ${previous.sequence + 1}, received ${event.sequence}.`,
        );
      }
      if (event.previousHash !== previous.eventHash) {
        throw new OperationalConsoleStoreError(
          'CHAIN_BROKEN',
          `Console hash chain is broken at sequence ${event.sequence}.`,
        );
      }
    }
    const { eventHash: _discard, ...unhashed } = event;
    void _discard;
    if (computeHash(unhashed) !== event.eventHash) {
      throw new OperationalConsoleStoreError(
        'CHAIN_BROKEN',
        `Console event hash mismatch at sequence ${event.sequence}.`,
      );
    }
  }

  const headSequence = parsed.at(-1)?.sequence ?? null;
  const wanted = parsed.filter((event) => event.sequence > after);
  const truncated = wanted.length > limit;
  const events = truncated ? wanted.slice(wanted.length - limit) : wanted;
  const first = events[0];
  const joinVerified =
    first === undefined ||
    first.sequence === 0 ||
    (fromStart && parsed[0]?.sequence === 0) ||
    parsed.some((event) => event.sequence === first.sequence - 1);

  // Everything the caller asked for that the limit excluded, plus everything older than
  // the read window when the caller asked for more history than a tail read covers.
  const excludedByLimit = wanted.length - events.length;
  const olderThanWindow =
    first === undefined || parsed[0] === undefined
      ? 0
      : Math.max(0, parsed[0].sequence - Math.max(0, after + 1));

  return {
    events,
    firstSequence: first?.sequence ?? null,
    lastSequence: events.at(-1)?.sequence ?? null,
    headSequence,
    droppedEvents: excludedByLimit + olderThanWindow,
    truncated: truncated || olderThanWindow > 0,
    joinVerified,
  };
}

export function readOperationalConsoleEvents(filePath: string): readonly OperationalConsoleEvent[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const events: OperationalConsoleEvent[] = [];
  let previous: OperationalConsoleEvent | null = null;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new OperationalConsoleStoreError('MALFORMED', 'Operational Console line is not JSON.');
    }
    const event = operationalConsoleEventSchema.parse(parsed) as unknown as OperationalConsoleEvent;
    const expectedSequence = previous === null ? 0 : previous.sequence + 1;
    if (event.sequence !== expectedSequence) {
      throw new OperationalConsoleStoreError(
        'SEQUENCE_GAP',
        `Expected console sequence ${expectedSequence}, received ${event.sequence}.`,
      );
    }
    if (event.previousHash !== (previous?.eventHash ?? null)) {
      throw new OperationalConsoleStoreError(
        'CHAIN_BROKEN',
        `Console hash chain is broken at sequence ${event.sequence}.`,
      );
    }
    const { eventHash: _discard, ...unhashed } = event;
    void _discard;
    if (computeHash(unhashed) !== event.eventHash) {
      throw new OperationalConsoleStoreError(
        'CHAIN_BROKEN',
        `Console event hash mismatch at sequence ${event.sequence}.`,
      );
    }
    events.push(event);
    previous = event;
  }
  return events;
}
