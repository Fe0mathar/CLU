/**
 * CLUE event log.
 *
 * Spec: CLUE_Architecture_v9.md — durable record model: one append-only, hash-chained
 *       state-transition authority, single-writer daemon, atomic evidence writes.
 *       CLUE_Project_Directory_v9.md §9 — `eventLog.ts` is that sole authority; SQLite
 *       contains no independent truth and must be reproducible from this file.
 *       CLUE_Execution_Model_v9.md — crash recovery and projection rebuild.
 * Constitution: CLUE_Constitution_v9.md — truth hierarchy and the append-only /
 *       hash-chained invariants.
 *
 * Revision 2 — the lock is now released on close, not merely closed. Revision 1 left
 * the lock file on disk, so any reopen inside the same process found a lock whose
 * recorded PID was still alive and refused to proceed. Found while writing the Stage A
 * acceptance test, which is where a defect of this shape is supposed to be found.
 *
 * This is the bottom of CLUE's memory. Every projection — SQLite tables, graph, queue
 * state — is derived from this file and must be reproducible from it byte for byte.
 * Nothing else in CLUE is allowed to be the sole home of a fact.
 *
 * Spec: CLUE_Architecture — durable record model (append-only event log, single-writer
 *       daemon); CLUE_Constitution — truth hierarchy and the append-only / hash-chained
 *       invariants; CLUE_Execution_Model — crash recovery and projection rebuild.
 * Backlog: DEV-P1-01 (revision 3) — atomic stale-lock takeover, PID-reuse protection,
 *          checked whole-buffer writes, durable recovery receipts, periodic full-chain
 *          checkpoints. Revision 2 released the lock on close; revision 1 leaked it.
 *
 * Revision 4 (DEV-P1-01) — two changes.
 *
 *   1. *`close()` could delete another writer's lock.* Release was unconditional: it
 *      removed whatever lock file was present, without checking that the lock was still
 *      ours. Ownership can legitimately move — a reclaimer that proves this process is
 *      gone (or a PID whose start time no longer matches) takes the lock by atomic
 *      replace, and `heartbeat()` already refuses to continue in that case. But `close()`
 *      did not make the same check, so a stalled writer that later closed would delete the
 *      new owner's lock and leave the log unlocked while that owner still believed it held
 *      it — admitting a third writer to an append-only chain. Release now performs the
 *      same token comparison `heartbeat()` performs, and simply lets go when the lock is
 *      no longer ours.
 *
 *   2. *Three private copies of the durability primitives.* This file carried its own
 *      `writeAllSync`, `fsyncDirSync` and `atomicWriteJsonSync`, byte-for-byte duplicates
 *      of what `src/shared/durableFs.ts` (DEV-P1-02) already owns and proves. Two more
 *      modules have since adopted the shared primitives, at which point three
 *      independently-maintained copies of a crash-safety guarantee is a defect waiting to
 *      happen: a fix applied to one is silently absent from the others. They are now
 *      imported. The one contract that had to be preserved is the error identity —
 *      `writeAllSync` here raised `EventLogError('WRITE_FAILED')`, and callers of the log
 *      are entitled to keep seeing an `EventLogError` — so the shared primitive's
 *      `DurableFsError` is translated at this module's boundary rather than leaking a
 *      foreign error type out of the memory spine.
 *
 * Guarantees:
 *   1. Append-only. Records are never edited or deleted; corrections append.
 *   2. Hash-chained. Each record carries the hash of its predecessor, so a silent
 *      edit anywhere in history is detectable at the next verification.
 *   3. Newline-committed. A record counts as committed only once its terminating
 *      newline is on disk. A torn tail from a crash is therefore removable without
 *      losing anything that was ever acknowledged.
 *   4. Single writer. One process holds the lock; concurrent appends are refused
 *      rather than interleaved. A lock left by a dead process is reclaimed only by an
 *      atomic rename-and-read-back, so two reclaimers can never both believe they won.
 *   5. Whole-buffer writes. Every write drains its buffer through a short-write loop;
 *      a partial write is completed, never silently truncated.
 *   6. Recovery is receipted. A torn-tail repair or a reclaimed stale lock writes a
 *      durable receipt (fsynced, parent-directory fsynced) recording exactly what was
 *      recovered, so a silent recovery cannot masquerade as a clean open.
 *   7. Checkpointed. A periodic full-chain verification is sealed to a durable
 *      checkpoint; a committed head found behind that checkpoint on open is refused as
 *      lost history rather than accepted.
 *
 * PID-reuse protection: a stale lock records the holder's process start time (Linux
 * /proc). A recycled PID whose start time differs is proven not to be our writer and is
 * reclaimed; where the start time is unavailable (e.g. Windows) an optional heartbeat
 * staleness window is used, defaulting to never-steal from a live PID.
 *
 * Deliberately synchronous: the daemon owns this file, better-sqlite3 is synchronous,
 * and replay drives projection rebuilds. Introducing async here would buy nothing and
 * would make crash semantics harder to reason about. The heartbeat is an explicit
 * method the owning daemon calls; nothing here schedules background timers.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  DurableFsError,
  fsyncDir,
  replaceFileSync,
  writeAllSync as durableWriteAllSync,
} from '../shared/durableFs.js';
import {
  canonicalJson,
  hashBytes,
  hashCanonicalJson,
  makeEntityId,
  nowIso,
  requireSha256,
  type Sha256,
} from '../shared/ids.js';
import {
  eventRecordSchema,
  parseOrThrow,
  type Actor,
  type EventRecord,
} from '../shared/schemas.js';
import {
  assertProjectOperationIdentity,
  canonicalProjectOperationIdentity,
  type ProjectOperationIdentity,
} from '../shared/projectOperationIdentity.js';

/* ------------------------------------------------------------------------- */
/* Errors                                                                     */
/* ------------------------------------------------------------------------- */

export type EventLogErrorCode =
  | 'LOCKED'
  | 'CHAIN_BROKEN'
  | 'HASH_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'MALFORMED_RECORD'
  | 'CHECKPOINT_CONFLICT'
  | 'WRITE_FAILED'
  | 'NOT_OPEN';

/** A failure that must never be swallowed: the log is the root of CLUE's memory. */
export class EventLogError extends Error {
  public readonly code: EventLogErrorCode;
  public readonly sequence: number | null;

  public constructor(code: EventLogErrorCode, message: string, sequence: number | null = null) {
    super(message);
    this.name = 'EventLogError';
    this.code = code;
    this.sequence = sequence;
  }
}

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

/** The caller-supplied part of an event; the log owns identity, order, time, and hash. */
export interface AppendEventInput {
  /** Optional stale-request guard; it is asserted but not duplicated into every event row. */
  readonly operationIdentity?: ProjectOperationIdentity;
  readonly type: string;
  readonly actor: Actor;
  readonly missionVersion: string;
  readonly subjectId?: string | null;
  readonly payload: unknown;
}

/** Position of the log after the last committed record. */
export interface LogHead {
  readonly sequence: number;
  readonly hash: Sha256;
}

export type VerificationDepth = 'none' | 'tail' | 'full';

export interface EventLogOptions {
  /** Project identity owning this physical log namespace. */
  readonly projectIdentity?: ProjectOperationIdentity;
  /**
   * How much of the chain to verify when opening.
   * 'tail' (default) is the daemon's startup cost; `clue doctor --deep` uses 'full'.
   */
  readonly verifyOnOpen?: VerificationDepth;
  /** Records inspected when verifyOnOpen is 'tail'. */
  readonly tailRecords?: number;
  /**
   * fsync after every append. Default true: CLUE's event rate is low and durability
   * is the entire point of this file. Bulk importers may disable it and fsync once.
   */
  readonly fsyncOnAppend?: boolean;
  /**
   * Milliseconds after which a stale lock whose holder cannot be proven live (no
   * readable process start time, e.g. Windows) may be reclaimed based on heartbeat age.
   * Default Infinity: never steal from a live same-host PID. A recycled PID with a
   * differing start time is always reclaimed regardless of this value.
   */
  readonly lockStaleAfterMs?: number;
  /**
   * Run a full-chain checkpoint after this many appends. Default 0 (disabled); the
   * daemon opts in. A checkpoint re-verifies the whole chain, so choose a value that
   * amortizes that cost against the event rate.
   */
  readonly checkpointEveryAppends?: number;
}

export interface OpenReport {
  readonly head: LogHead | null;
  readonly recordsVerified: number;
  /** Bytes discarded from an unterminated final line left by a crash. */
  readonly repairedBytes: number;
  /** Hash of the discarded tail bytes, for the recovery receipt; null when none. */
  readonly discardedTailSha256: Sha256 | null;
  /** True when a lock belonging to a dead process was reclaimed. */
  readonly staleLockReclaimed: boolean;
  /** The previous lock holder that was reclaimed, if any. */
  readonly reclaimedFrom: LockOwnerData | null;
  /** The durable checkpoint found on open, if any. */
  readonly checkpoint: CheckpointInfo | null;
  /** Path of the durable recovery receipt written this open, or null when clean. */
  readonly recoveryReceiptPath: string | null;
}

/** Parsed contents of the single-writer lock file. */
export interface LockOwnerData {
  readonly pid: number | null;
  readonly ownerToken: string | null;
  readonly host: string | null;
  readonly acquiredAt: string | null;
  readonly heartbeatAt: string | null;
  /** Opaque process-start marker used to detect PID reuse; null when unavailable. */
  readonly startTime: string | null;
}

/** A sealed full-chain verification anchor. */
export interface CheckpointInfo {
  readonly head: LogHead | null;
  readonly records: number;
  readonly fileSize: number;
  readonly createdAt: string;
  readonly ownerToken: string;
  readonly host: string;
  readonly pid: number;
}

/* ------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* ------------------------------------------------------------------------- */

/** The record shape that is hashed: every field except `hash` itself. */
export type UnhashedEventRecord = Omit<EventRecord, 'hash'>;

/**
 * Computes an event's hash over the canonical JSON of all fields except `hash`.
 *
 * Canonical JSON sorts keys and rejects non-finite numbers, so two structurally equal
 * records hash equal regardless of key order, and a record that cannot be verified
 * later cannot be written now.
 */
export function computeEventHash(record: UnhashedEventRecord): Sha256 {
  return hashCanonicalJson(record);
}

/* ------------------------------------------------------------------------- */
/* Event log                                                                  */
/* ------------------------------------------------------------------------- */

const CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

export class EventLog {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly checkpointPath: string;
  private readonly recoveryDir: string;
  private readonly fsyncOnAppend: boolean;
  private readonly lockStaleAfterMs: number;
  private readonly checkpointEveryAppends: number;
  private readonly boundProjectIdentity: ProjectOperationIdentity | null;
  private readonly host: string;
  private readonly startTime: string | null;

  private appendFd: number | null = null;
  private lockFd: number | null = null;
  private head: LogHead | null = null;
  private staleLockReclaimed = false;
  private reclaimedFrom: LockOwnerData | null = null;
  private ownerToken: string | null = null;
  private acquiredAt = '';
  private appendsSinceCheckpoint = 0;

  private constructor(
    filePath: string,
    fsyncOnAppend: boolean,
    lockStaleAfterMs: number,
    checkpointEveryAppends: number,
    projectIdentity: ProjectOperationIdentity | null,
  ) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.checkpointPath = join(dirname(filePath), 'checkpoint.json');
    this.recoveryDir = join(dirname(filePath), 'recovery');
    this.fsyncOnAppend = fsyncOnAppend;
    this.lockStaleAfterMs = lockStaleAfterMs;
    this.checkpointEveryAppends = checkpointEveryAppends;
    this.boundProjectIdentity = projectIdentity;
    this.host = hostname();
    this.startTime = readProcessStartTime(process.pid);
  }

  /**
   * Opens (or creates) the log at `workspace/events/events.ndjson`, acquiring the
   * single-writer lock, repairing a torn tail if present, and establishing the head.
   */
  public static open(
    eventsDir: string,
    options: EventLogOptions = {},
  ): { log: EventLog; report: OpenReport } {
    const filePath = join(eventsDir, 'events.ndjson');
    const log = new EventLog(
      filePath,
      options.fsyncOnAppend ?? true,
      options.lockStaleAfterMs ?? Number.POSITIVE_INFINITY,
      options.checkpointEveryAppends ?? 0,
      options.projectIdentity === undefined
        ? null
        : canonicalProjectOperationIdentity(options.projectIdentity),
    );

    mkdirSync(dirname(filePath), { recursive: true });
    log.acquireLock();

    try {
      const depth = options.verifyOnOpen ?? 'tail';
      const repair = log.repairTornTail();
      const core = log.establishHead(depth, options.tailRecords ?? 64);

      // A durable checkpoint is a trust anchor: a committed head behind it means
      // committed history was lost or replaced, which must be refused, not accepted.
      const checkpoint = log.readCheckpoint();
      assertCheckpointConsistent(core.head, checkpoint);

      log.appendFd = openSync(filePath, 'a');

      const recoveryReceiptPath =
        repair.discardedBytes > 0 || log.staleLockReclaimed
          ? log.writeRecoveryReceipt(depth, repair, core, checkpoint)
          : null;

      const report: OpenReport = {
        head: core.head,
        recordsVerified: core.recordsVerified,
        repairedBytes: repair.discardedBytes,
        discardedTailSha256: repair.discardedSha256,
        staleLockReclaimed: log.staleLockReclaimed,
        reclaimedFrom: log.reclaimedFrom,
        checkpoint,
        recoveryReceiptPath,
      };
      return { log, report };
    } catch (error) {
      log.releaseLock();
      throw error;
    }
  }

  /** Governed identity owning this log, or null for a legacy unbound workspace. */
  public get projectIdentity(): ProjectOperationIdentity | null {
    return this.boundProjectIdentity;
  }

  /** Explicit assertion used by runtime receipts and stale request contexts. */
  public assertProjectIdentity(actual: unknown, context = 'event-log operation'): void {
    if (this.boundProjectIdentity === null) return;
    assertProjectOperationIdentity(this.boundProjectIdentity, actual, context);
  }

  /** Head position, or null for an empty log. */
  public getHead(): LogHead | null {
    return this.head;
  }

  /** True while this instance owns the writer lock. */
  public get isOpen(): boolean {
    return this.appendFd !== null;
  }

  /**
   * Appends one event and returns the committed record.
   *
   * The write is a single `writeSync` of one newline-terminated line. Because a record
   * counts as committed only when its newline is durable, a crash mid-write leaves a
   * removable partial line rather than a corrupt history.
   */
  public append(input: AppendEventInput): EventRecord {
    if (input.operationIdentity !== undefined) {
      this.assertProjectIdentity(input.operationIdentity, 'event-log append');
    }
    const fd = this.appendFd;
    if (fd === null) {
      throw new EventLogError('NOT_OPEN', 'Event log is not open for appending');
    }

    const sequence = this.head === null ? 0 : this.head.sequence + 1;
    const unhashed: UnhashedEventRecord = {
      id: makeEntityId('event', sequence),
      sequence,
      timestamp: nowIso(),
      type: input.type,
      mission_version: input.missionVersion,
      actor: input.actor,
      subject_id: input.subjectId ?? null,
      payload: input.payload,
      previous_hash: this.head === null ? null : this.head.hash,
    };

    const record: EventRecord = { ...unhashed, hash: computeEventHash(unhashed) };

    // Validate before writing: an invalid record must never reach the file.
    const validated = parseOrThrow(eventRecordSchema, record, `event ${record.id}`);

    writeAllSync(fd, Buffer.from(`${JSON.stringify(validated)}\n`, 'utf8'));
    if (this.fsyncOnAppend) fsyncSync(fd);

    this.head = { sequence: validated.sequence, hash: requireSha256(validated.hash, 'event hash') };
    this.maybeCheckpoint();
    return validated;
  }

  /** Forces buffered appends to disk. Only needed when fsyncOnAppend is disabled. */
  public flush(): void {
    if (this.appendFd !== null) fsyncSync(this.appendFd);
  }

  /**
   * Replays the whole log in order, verifying each record's own hash, its link to its
   * predecessor, and sequence continuity.
   *
   * This is the projection-rebuild path: SQLite tables are dropped and reconstructed
   * by consuming this generator, which is what makes them safe to delete.
   */
  public *replay(): Generator<EventRecord> {
    yield* EventLog.readAndVerify(this.filePath);
  }

  /** Full-chain verification. Returns what was checked; throws on the first defect. */
  public verify(): { records: number; head: LogHead | null } {
    let records = 0;
    let head: LogHead | null = null;
    for (const record of EventLog.readAndVerify(this.filePath)) {
      records += 1;
      head = { sequence: record.sequence, hash: requireSha256(record.hash, 'event hash') };
    }
    return { records, head };
  }

  /**
   * Reads the log head WITHOUT acquiring the single-writer lock or creating the file (DEV-P0-10).
   *
   * A read-only attach uses this to compare the projection head against the real log head, so a stale
   * projection is proved rather than assumed. It writes nothing: a missing events file reads as an
   * empty log (`null` head), and the chain is verified as it is read so a torn or rewritten tail is a
   * thrown error rather than a silently wrong head.
   */
  public static readHead(eventsDir: string): LogHead | null {
    const filePath = join(eventsDir, 'events.ndjson');
    if (!existsSync(filePath)) return null;
    let head: LogHead | null = null;
    for (const record of EventLog.readAndVerify(filePath)) {
      head = { sequence: record.sequence, hash: requireSha256(record.hash, 'event hash') };
    }
    return head;
  }

  /** Verifies committed records and checks the same durable anchor as a writer open. */
  public static verifyReadOnly(eventsDir: string): LogHead | null {
    // Take the checkpoint before reading the chain so an advancing writer cannot
    // make a newer checkpoint appear to contradict a successfully read prefix.
    const checkpoint = readCheckpoint(join(eventsDir, 'checkpoint.json'));
    const head = EventLog.readHead(eventsDir);
    assertCheckpointConsistent(head, checkpoint);
    return head;
  }


  /**
   * Replays the committed log read-only, without acquiring or disturbing the writer lock.
   *
   * Used by long-lived observer surfaces that need rare event families not worth a SQLite
   * projection (for example Creator ratification and evidence-epoch seals). The same full
   * hash/sequence verification as `replay()` applies. A concurrently incomplete tail is
   * ignored because, by the log contract, bytes without a terminating newline are not yet
   * committed.
   */
  public static *replayReadOnly(eventsDir: string): Generator<EventRecord> {
    const filePath = join(eventsDir, 'events.ndjson');
    if (!existsSync(filePath)) return;
    yield* EventLog.readAndVerify(filePath);
  }

  /** Releases the writer lock and closes handles. Safe to call twice. */
  public close(): void {
    if (this.appendFd !== null) {
      try {
        fsyncSync(this.appendFd);
      } finally {
        closeSync(this.appendFd);
        this.appendFd = null;
      }
    }
    this.releaseLock();
  }

  /**
   * Refreshes the lock heartbeat, proving continued single ownership.
   *
   * The owning daemon calls this from its own loop. It first confirms the on-disk owner
   * token is still ours: if another writer reclaimed the lock (e.g. after this process
   * stalled past the staleness window), the heartbeat fails loudly rather than letting
   * two writers proceed.
   */
  public heartbeat(): void {
    const fd = this.lockFd;
    if (fd === null) {
      throw new EventLogError('NOT_OPEN', 'Cannot heartbeat a lock that is not held');
    }
    const current = readLockOwner(this.lockPath);
    if (current === null || current.ownerToken !== this.ownerToken) {
      throw new EventLogError(
        'LOCKED',
        'Lock ownership was superseded by another writer; this instance no longer owns the log.',
      );
    }
    this.writeOwner(fd);
  }

  /**
   * Verifies the whole chain and seals the result to a durable checkpoint.
   *
   * Public so the daemon and `clue doctor` can anchor trust explicitly; also driven
   * periodically from append when `checkpointEveryAppends` is set.
   */
  public checkpoint(): CheckpointInfo {
    const verified = this.verify();
    const info: CheckpointInfo = {
      head: verified.head,
      records: verified.records,
      fileSize: existsSync(this.filePath) ? statSync(this.filePath).size : 0,
      createdAt: nowIso(),
      ownerToken: this.ownerToken ?? '',
      host: this.host,
      pid: process.pid,
    };
    atomicWriteJsonSync(this.checkpointPath, {
      schema: CHECKPOINT_SCHEMA,
      head: info.head,
      records: info.records,
      fileSize: info.fileSize,
      createdAt: info.createdAt,
      ownerToken: info.ownerToken,
      host: info.host,
      pid: info.pid,
    });
    this.appendsSinceCheckpoint = 0;
    return info;
  }

  /** Reads the durable checkpoint if present; a corrupt checkpoint reads as absent. */
  public readCheckpoint(): CheckpointInfo | null {
    return readCheckpoint(this.checkpointPath);
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                              */
  /* --------------------------------------------------------------------- */

  /** Runs a full-chain checkpoint once the append threshold is reached. */
  private maybeCheckpoint(): void {
    if (this.checkpointEveryAppends <= 0) return;
    this.appendsSinceCheckpoint += 1;
    if (this.appendsSinceCheckpoint >= this.checkpointEveryAppends) {
      this.checkpoint();
    }
  }

  /**
   * Acquires the single-writer lock.
   *
   * A lock left behind by a killed process is reclaimed only after confirming that the
   * recorded PID is gone — an unconditional steal would allow two daemons to interleave
   * appends, which no amount of later verification could untangle.
   */
  private acquireLock(): void {
    // Fast path: exclusive create wins outright when no lock exists.
    try {
      const fd = openSync(this.lockPath, 'wx');
      this.lockFd = fd;
      this.ownerToken = newOwnerToken();
      this.acquiredAt = nowIso();
      this.writeOwner(fd);
      return;
    } catch (error) {
      if (!isErrnoException(error, 'EEXIST')) throw error;
    }

    // Contended: decide whether the recorded holder is genuinely live.
    const owner = readLockOwner(this.lockPath);
    if (owner !== null && this.isHolderLive(owner)) {
      const where = owner.host !== null && owner.host !== this.host ? ` on host ${owner.host}` : '';
      throw new EventLogError(
        'LOCKED',
        `Event log is locked by a live process (pid ${owner.pid ?? 'unknown'}${where}). ` +
          'Only one CLUE writer may run.',
      );
    }

    // Stale: the recorded process is gone (or its PID was recycled by a different
    // process). Reclaim by atomic rename-and-read-back so concurrent reclaimers cannot
    // both believe they won. The previous owner is retained for the recovery receipt.
    this.reclaimedFrom = owner;
    this.performAtomicTakeover();
    this.staleLockReclaimed = true;
  }

  /** Serializes this instance's ownership record (canonical JSON, newline-terminated). */
  private ownerBuffer(heartbeatAt: string = nowIso()): Buffer {
    const owner = {
      pid: process.pid,
      ownerToken: this.ownerToken,
      host: this.host,
      acquiredAt: this.acquiredAt,
      heartbeatAt,
      startTime: this.startTime,
    };
    return Buffer.from(`${canonicalJson(owner)}\n`, 'utf8');
  }

  /** Rewrites the lock file in place with a fresh heartbeat, fsynced. */
  private writeOwner(fd: number, heartbeatAt: string = nowIso()): void {
    ftruncateSync(fd, 0);
    writeAllSync(fd, this.ownerBuffer(heartbeatAt), 0);
    fsyncSync(fd);
  }

  /**
   * Atomically replaces a stale lock and confirms this writer won.
   *
   * The owner record is written to a uniquely-named temp on the same directory, fsynced,
   * then renamed over the lock (an atomic replace). A read-back verifies our token is the
   * one on disk; if a second reclaimer's rename landed last, this loses and refuses.
   */
  private performAtomicTakeover(): void {
    this.ownerToken = newOwnerToken();
    this.acquiredAt = nowIso();

    const dir = dirname(this.lockPath);
    const tempPath = join(dir, `.${basename(this.lockPath)}.take-${process.pid}-${randomBytes(6).toString('hex')}`);
    const tempFd = openSync(tempPath, 'wx');
    try {
      writeAllSync(tempFd, this.ownerBuffer(), 0);
      fsyncSync(tempFd);
    } finally {
      closeSync(tempFd);
    }
    replaceFileSync(tempPath, this.lockPath);

    const after = readLockOwner(this.lockPath);
    if (after === null || after.ownerToken !== this.ownerToken) {
      throw new EventLogError(
        'LOCKED',
        'Lost a concurrent stale-lock takeover; another CLUE writer reclaimed the log first.',
      );
    }
    this.lockFd = openSync(this.lockPath, 'r+');
  }

  /**
   * Decides whether a recorded lock holder is genuinely live.
   *
   * Same host + live PID + matching process start time proves it is our writer. A live
   * PID whose start time differs is a recycled PID and is treated as stale. When the
   * start time is unavailable (non-Linux), an optional heartbeat staleness window
   * applies, defaulting to never-steal from a live PID.
   */
  private isHolderLive(owner: LockOwnerData): boolean {
    const sameHost = owner.host === null || owner.host === this.host;
    if (!sameHost) {
      // Cannot probe a PID on another host; rely on heartbeat freshness only.
      return !heartbeatStale(owner, this.lockStaleAfterMs);
    }
    if (owner.pid === null || !isProcessAlive(owner.pid)) return false;

    const currentStart = readProcessStartTime(owner.pid);
    if (currentStart !== null && owner.startTime !== null) {
      if (currentStart !== owner.startTime) return false; // recycled PID
      return true; // proven same process
    }
    // Start time unavailable on this platform: fall back to heartbeat freshness.
    return !heartbeatStale(owner, this.lockStaleAfterMs);
  }

  /**
   * Writes a durable recovery receipt describing a torn-tail repair and/or a reclaimed
   * stale lock, so a silent recovery cannot masquerade as a clean open.
   */
  private writeRecoveryReceipt(
    depth: VerificationDepth,
    repair: TornTailRepair,
    core: { head: LogHead | null; recordsVerified: number },
    checkpoint: CheckpointInfo | null,
  ): string {
    const token = randomBytes(6).toString('hex');
    const stamp = nowIso().replace(/[:.]/g, '-');
    const path = join(this.recoveryDir, `recovery-${stamp}-${token}.json`);
    atomicWriteJsonSync(path, {
      schema: RECOVERY_SCHEMA,
      occurredAt: nowIso(),
      host: this.host,
      pid: process.pid,
      ownerToken: this.ownerToken,
      verifyDepth: depth,
      staleLockReclaimed: this.staleLockReclaimed,
      reclaimedFrom: this.reclaimedFrom,
      repairedBytes: repair.discardedBytes,
      discardedTailSha256: repair.discardedSha256,
      recordsVerified: core.recordsVerified,
      head: core.head,
      checkpoint: checkpoint === null ? null : { head: checkpoint.head, records: checkpoint.records },
    });
    return path;
  }

  /**
   * Closes and REMOVES the lock file — but only while the lock is still ours.
   *
   * Removal is the point: a lock that outlives its owner is indistinguishable from a live
   * one when the PID happens to still be running, which is exactly what happens when the
   * same process reopens the log.
   *
   * The ownership check is equally the point (revision 4). Ownership can legitimately move
   * while this instance still holds a descriptor: a reclaimer that proved this process
   * gone, or that saw a recycled PID, takes the lock by atomic replace, and `heartbeat()`
   * already refuses to continue in that case. An unconditional removal here deleted *that*
   * writer's lock, leaving the log unlocked while its owner believed otherwise — which is
   * how a third writer gets onto an append-only chain. When the on-disk token is no longer
   * ours we simply let go: the descriptor is closed, nothing is deleted, and the new owner
   * is left undisturbed.
   */
  private releaseLock(): void {
    if (this.lockFd === null) return;
    const current = readLockOwner(this.lockPath);
    const stillOurs = current === null || current.ownerToken === this.ownerToken;
    try {
      closeSync(this.lockFd);
    } finally {
      this.lockFd = null;
      if (stillOurs) rmSync(this.lockPath, { force: true });
    }
  }

  /**
   * Removes an unterminated final line.
   *
   * Such a line was never committed — nothing acknowledged it, no projection consumed
   * it, and no hash chain references it — so discarding it is lossless. Returns the
   * number of bytes discarded so the caller can audit the repair.
   */
  private repairTornTail(): TornTailRepair {
    if (!existsSync(this.filePath)) {
      closeSync(openSync(this.filePath, 'a'));
      fsyncDir(dirname(this.filePath));
      return { discardedBytes: 0, discardedSha256: null };
    }

    const size = statSync(this.filePath).size;
    if (size === 0) return { discardedBytes: 0, discardedSha256: null };

    const fd = openSync(this.filePath, 'r+');
    try {
      const lastNewline = findLastNewline(fd, size);
      const committedLength = lastNewline === -1 ? 0 : lastNewline + 1;
      if (committedLength === size) return { discardedBytes: 0, discardedSha256: null };

      // Hash the doomed bytes before truncating so the receipt records what was removed.
      const discardLength = size - committedLength;
      const discarded = Buffer.alloc(discardLength);
      readSync(fd, discarded, 0, discardLength, committedLength);
      const discardedSha256 = hashBytes(discarded);

      ftruncateSync(fd, committedLength);
      fsyncSync(fd);
      return { discardedBytes: discardLength, discardedSha256 };
    } finally {
      closeSync(fd);
    }
  }

  /** Determines the head and verifies the requested amount of history. */
  private establishHead(
    depth: VerificationDepth,
    tailRecords: number,
  ): { head: LogHead | null; recordsVerified: number } {
    if (statSync(this.filePath).size === 0) {
      this.head = null;
      return { head: null, recordsVerified: 0 };
    }

    if (depth === 'full') {
      const result = this.verify();
      this.head = result.head;
      return { head: result.head, recordsVerified: result.records };
    }

    const lines = readTailLines(this.filePath, Math.max(tailRecords, 1));
    let previous: EventRecord | null = null;
    let verified = 0;

    for (const line of lines) {
      const record = decodeRecord(line);
      // The first record of a tail window has no in-window predecessor, so only the
      // records after it can have their links checked here.
      if (previous !== null) verifyLink(previous, record);
      if (depth !== 'none') verifySelfHash(record);
      previous = record;
      verified += 1;
    }

    if (previous === null) {
      this.head = null;
      return { head: null, recordsVerified: 0 };
    }

    const head: LogHead = {
      sequence: previous.sequence,
      hash: requireSha256(previous.hash, 'event hash'),
    };
    this.head = head;
    return { head, recordsVerified: verified };
  }

  /** Streams the file, decoding and verifying every record in order. */
  private static *readAndVerify(filePath: string): Generator<EventRecord> {
    let previous: EventRecord | null = null;
    for (const line of readLines(filePath)) {
      const record = decodeRecord(line);
      verifySelfHash(record);

      if (previous === null) {
        if (record.sequence !== 0) {
          throw new EventLogError(
            'SEQUENCE_GAP',
            `Event log must start at sequence 0, found ${record.sequence}`,
            record.sequence,
          );
        }
        if (record.previous_hash !== null) {
          throw new EventLogError(
            'CHAIN_BROKEN',
            'First event must have a null previous_hash',
            record.sequence,
          );
        }
      } else {
        verifyLink(previous, record);
      }

      yield record;
      previous = record;
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Record decoding and verification                                           */
/* ------------------------------------------------------------------------- */

function decodeRecord(line: string): EventRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new EventLogError(
      'MALFORMED_RECORD',
      `Event log line is not valid JSON: ${(error as Error).message}`,
    );
  }
  return parseOrThrow(eventRecordSchema, parsed, 'event log record');
}

function verifySelfHash(record: EventRecord): void {
  const { hash, ...unhashed } = record;
  const expected = computeEventHash(unhashed);
  if (expected !== hash) {
    throw new EventLogError(
      'HASH_MISMATCH',
      `Event ${record.id} has hash ${hash} but its content hashes to ${expected}. ` +
        'The log has been edited outside CLUE.',
      record.sequence,
    );
  }
}

function verifyLink(previous: EventRecord, record: EventRecord): void {
  if (record.sequence !== previous.sequence + 1) {
    throw new EventLogError(
      'SEQUENCE_GAP',
      `Event sequence jumped from ${previous.sequence} to ${record.sequence}`,
      record.sequence,
    );
  }
  if (record.previous_hash !== previous.hash) {
    throw new EventLogError(
      'CHAIN_BROKEN',
      `Event ${record.id} references previous hash ${String(record.previous_hash)} ` +
        `but its predecessor hashes to ${previous.hash}`,
      record.sequence,
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Line IO                                                                    */
/* ------------------------------------------------------------------------- */

/** Streams complete lines from a file, skipping blanks. Chunked to bound memory. */
function* readLines(filePath: string): Generator<string> {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let position = 0;

    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      position += read;

      const text = carry + decoder.write(buffer.subarray(0, read));
      const parts = text.split('\n');
      carry = parts.pop() ?? '';

      for (const part of parts) {
        if (part.length > 0) yield part;
      }
    }

    // Any remainder had no terminating newline and is therefore uncommitted.
    // repairTornTail removes it on open; ignoring it here keeps reads non-destructive.
  } finally {
    closeSync(fd);
  }
}

/** Reads the last `count` complete lines by scanning backwards in chunks. */
function readTailLines(filePath: string, count: number): string[] {
  const fd = openSync(filePath, 'r');
  try {
    const size = statSync(filePath).size;
    if (size === 0) return [];

    const buffer = Buffer.alloc(CHUNK_BYTES);
    let position = size;
    let text = '';
    let lines: string[] = [];

    while (position > 0) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const read = readSync(fd, buffer, 0, length, position);
      text = buffer.subarray(0, read).toString('utf8') + text;

      lines = text.split('\n').filter((line) => line.length > 0);
      // Stop once enough complete lines are in hand, keeping one spare so the first
      // retained line is guaranteed not to be a partially read record.
      if (lines.length > count || position === 0) break;
    }

    return lines.slice(Math.max(0, lines.length - count));
  } finally {
    closeSync(fd);
  }
}

/** Byte offset of the final newline, or -1 if the file contains none. */
function findLastNewline(fd: number, size: number): number {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let position = size;

  while (position > 0) {
    const length = Math.min(CHUNK_BYTES, position);
    position -= length;
    const read = readSync(fd, buffer, 0, length, position);
    for (let index = read - 1; index >= 0; index -= 1) {
      if (buffer[index] === NEWLINE) return position + index;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------------- */
/* Host helpers                                                               */
/* ------------------------------------------------------------------------- */

/** Result of a torn-tail repair: how many bytes were discarded and their hash. */
interface TornTailRepair {
  readonly discardedBytes: number;
  readonly discardedSha256: Sha256 | null;
}

const RECOVERY_SCHEMA = 'clue.eventlog.recovery/1';
const CHECKPOINT_SCHEMA = 'clue.eventlog.checkpoint/1';
const LOCK_READ_BYTES = 4096;

/** A fresh, unique ownership token used to disambiguate concurrent lock reclaimers. */
function newOwnerToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Whole-buffer write, delegating to the shared primitive (`src/shared/durableFs.ts`).
 *
 * The delegation is deliberate and the translation is the point: the behaviour is the
 * shared one — a short write is completed, EAGAIN/EINTR are retried, a non-positive
 * return is refused rather than spun on — but a caller of the event log must keep seeing
 * an `EventLogError`, because `WRITE_FAILED` is part of this module's declared error
 * surface (`EventLogErrorCode`). Letting a `DurableFsError` escape from here would
 * silently change that contract in exchange for four lines.
 */
function writeAllSync(fd: number, data: Uint8Array, position: number | null = null): void {
  try {
    durableWriteAllSync(fd, data, position);
  } catch (error) {
    if (error instanceof DurableFsError) {
      throw new EventLogError('WRITE_FAILED', error.message);
    }
    throw error;
  }
}

/**
 * Atomically writes canonical JSON: exclusive temp on the same directory, whole-buffer
 * write, fsync, atomic replace, directory fsync.
 *
 * The temp is created with `wx` so a collision is an error rather than a silent overwrite
 * of another writer's in-flight temp; `replaceFileSync` owns the rename and the
 * directory fsync that makes the new name durable.
 */
function atomicWriteJsonSync(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = openSync(tempPath, 'wx');
  try {
    writeAllSync(fd, Buffer.from(`${canonicalJson(value)}\n`, 'utf8'), 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  replaceFileSync(tempPath, filePath);
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** Reads and parses the lock file, tolerating the legacy two-line pid/time format. */
function readLockOwner(lockPath: string): LockOwnerData | null {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8').slice(0, LOCK_READ_BYTES);
  } catch {
    return null;
  }
  if (text.trim() === '') return null;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      pid: intOrNull(parsed['pid']),
      ownerToken: strOrNull(parsed['ownerToken']),
      host: strOrNull(parsed['host']),
      acquiredAt: strOrNull(parsed['acquiredAt']),
      heartbeatAt: strOrNull(parsed['heartbeatAt']),
      startTime: strOrNull(parsed['startTime']),
    };
  } catch {
    // Legacy format written by an older writer: "pid\ntime\n".
    const lines = text.split('\n');
    const first = lines[0];
    const second = lines[1];
    const pid = first !== undefined ? Number.parseInt(first.trim(), 10) : Number.NaN;
    const time = second !== undefined && second.trim() !== '' ? second.trim() : null;
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      ownerToken: null,
      host: null,
      acquiredAt: time,
      heartbeatAt: time,
      startTime: null,
    };
  }
}

/** True when the holder's heartbeat is older than the staleness window. */
function heartbeatStale(owner: LockOwnerData, staleAfterMs: number): boolean {
  if (!Number.isFinite(staleAfterMs)) return false; // Infinity: never steal from a live PID
  const beat = owner.heartbeatAt ?? owner.acquiredAt;
  if (beat === null) return true;
  const millis = Date.parse(beat);
  if (Number.isNaN(millis)) return true;
  return Date.now() - millis > staleAfterMs;
}

/** Reads a durable checkpoint; a missing or corrupt file reads as absent. */
function readCheckpoint(checkpointPath: string): CheckpointInfo | null {
  if (!existsSync(checkpointPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, unknown>;
    let head: LogHead | null = null;
    const headRaw = parsed['head'];
    if (headRaw !== null && typeof headRaw === 'object') {
      const h = headRaw as Record<string, unknown>;
      const seq = h['sequence'];
      const hash = h['hash'];
      if (typeof seq === 'number' && Number.isSafeInteger(seq) && typeof hash === 'string') {
        head = { sequence: seq, hash: requireSha256(hash, 'checkpoint head hash') };
      }
    }
    const records = intOrNull(parsed['records']) ?? 0;
    const fileSize = intOrNull(parsed['fileSize']) ?? 0;
    return {
      head,
      records,
      fileSize,
      createdAt: strOrNull(parsed['createdAt']) ?? '',
      ownerToken: strOrNull(parsed['ownerToken']) ?? '',
      host: strOrNull(parsed['host']) ?? '',
      pid: intOrNull(parsed['pid']) ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Refuses a committed head that sits behind a durable checkpoint.
 *
 * The checkpoint only ever records committed (newline-terminated) history, and torn-tail
 * repair never removes committed records, so a head below the checkpoint means committed
 * history was lost or replaced — a corruption to surface, not to accept.
 */
function assertCheckpointConsistent(head: LogHead | null, checkpoint: CheckpointInfo | null): void {
  if (checkpoint === null || checkpoint.head === null) return;
  const checkpointSequence = checkpoint.head.sequence;
  if (head === null || head.sequence < checkpointSequence) {
    throw new EventLogError(
      'CHECKPOINT_CONFLICT',
      `Committed head (${head === null ? 'empty' : head.sequence}) is behind durable ` +
        `checkpoint (sequence ${checkpointSequence}); committed history was lost or replaced.`,
      checkpointSequence,
    );
  }
}

/**
 * An opaque process-start marker for PID-reuse detection (Linux /proc field 22).
 * Returns null on platforms without a readable start time.
 */
function readProcessStartTime(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    // After the comm field, index 19 is starttime (field 22 overall, 1-based).
    const starttime = fields[19];
    return starttime ?? null;
  } catch {
    return null;
  }
}

function isErrnoException(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Signal-0 liveness probe; works on Windows as well as POSIX hosts. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return isErrnoException(error, 'EPERM');
  }
}
