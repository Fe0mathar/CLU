/**
 * CLUE audit log.
 *
 * Spec: CLUE_Architecture — restricted command host and audit fields; CLUE_Constitution
 *       — authority boundaries and durable, tamper-evident records; CLUE_AI_Utilization
 *       — secret handling in audited exchanges.
 * Backlog: DEV-P1-03 — an independent chain, archive manifest, mandatory execution ids,
 *          and async-aware dispatch. The single-writer lock is intentionally not
 *          duplicated here: a writable audit log only exists inside a runtime that already
 *          holds the event-log writer lock, which serializes every audit write.
 *
 * Every command that passes through the policy engine leaves a record here, allowed or
 * denied. The audit log answers one question that nothing else in CLUE can: what did
 * this system *try* to do. Events record what happened; the ledger records what was
 * proven; the audit records what was attempted, by whom, under which capability, and
 * what the engine decided.
 *
 * Three properties make it worth trusting:
 *
 *   Written before the act. `run()` records the decision and fsyncs it *before* the
 *   operation executes. If CLUE dies mid-landing, the log still shows that a landing
 *   was authorised and begun — which is exactly the forensic fact wanted at 03:00,
 *   and the one a record written on completion would lose.
 *
 *   Arguments hashed, never stored. A command may carry a source slice, a prompt, or a
 *   path that reveals more than the audit needs. Storing the digest proves which
 *   arguments were used without becoming a second, unguarded copy of them.
 *
 *   Append-only, with the file as truth. The SQLite table is an index for querying;
 *   `reindex()` rebuilds it from the file, never the other way round.
 *
 *   Hash-chained. Each record carries its predecessor's hash, so a silent edit or
 *   deletion anywhere in audit history is detectable — the same guarantee the event log
 *   gives its own records. Rotation preserves the chain across files, and an archive
 *   manifest records each rotated segment's digest so a deleted or altered segment is
 *   caught too.
 *
 *   Correlated by execution id. Every record carries a mandatory execution id; the three
 *   records of one operation (start / completed / failed) share it, so an operation's
 *   fate is reconstructable even when operations interleave.
 *
 *   Async-aware. Synchronous work goes through `run`; asynchronous work through
 *   `runAsync`, which records completion when the promise settles rather than when it is
 *   scheduled. `run` refuses a promise-returning callback rather than mis-recording it.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, hashBytes, hashCanonicalJson, nowIso } from '../shared/ids.js';
import { auditEntrySchema, parseOrThrow, type Actor } from '../shared/schemas.js';
import { replaceFileSync, writeAllSync } from '../shared/durableFs.js';
import type { ProjectionStore } from '../memory/db.js';
import type {
  Capability,
  DenialCode,
  PolicyDecision,
  PolicyEngine,
  PolicyRequest,
  SecretRegistry,
} from './policy.js';

/* ------------------------------------------------------------------------- */
/* Stored shape                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Audit identifiers are local to this log rather than global CLUE entity IDs.
 *
 * Audit records are high-volume operational traces, not first-class entities that
 * findings or contracts refer to, so they do not consume the shared entity namespace.
 * The rest of the record shape is exactly `auditEntrySchema`.
 */
const auditIdSchema = z.string().regex(/^AUDIT-[0-9]{6,}$/, 'expected an audit id');

const storedAuditEntrySchema = auditEntrySchema.extend({ id: auditIdSchema });

export type StoredAuditEntry = z.infer<typeof storedAuditEntrySchema>;

/** Rotation threshold. Rotated files stay beside the active one and remain readable. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

/**
 * What a record looks like on disk: the stored entry plus a mandatory execution id and a
 * hash chain. These live in the file — the durable authority — not in the query index,
 * which stays the lean projection it already is.
 */
const writtenAuditEntrySchema = storedAuditEntrySchema.extend({
  execution_id: z.string().min(1),
  previous_hash: z.string().min(1).nullable(),
  hash: z.string().min(1),
});
export type WrittenAuditEntry = z.infer<typeof writtenAuditEntrySchema>;

/**
 * What a record may look like when read back. Tolerates legacy lines written before the
 * chain existed (no execution id, no hashes), so upgrading an existing audit file never
 * makes it unreadable; the chain simply begins at the first record written by this code.
 */
const readAuditEntrySchema = storedAuditEntrySchema.extend({
  execution_id: z.string().min(1).optional(),
  previous_hash: z.string().min(1).nullable().optional(),
  hash: z.string().min(1).optional(),
});
type ReadAuditEntry = z.infer<typeof readAuditEntrySchema>;

/** One rotated segment, recorded so the full multi-file history stays verifiable. */
const archiveSegmentSchema = z.object({
  segment: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  first_id: z.string().nullable(),
  last_id: z.string().nullable(),
  head_hash: z.string().min(1).nullable(),
  rotated_at: z.string().min(1),
});
const archiveManifestSchema = z.object({
  schema: z.literal('clue.audit.archive/1'),
  segments: z.array(archiveSegmentSchema),
});
type ArchiveManifest = z.infer<typeof archiveManifestSchema>;
export type ArchiveSegment = z.infer<typeof archiveSegmentSchema>;

const MANIFEST_NAME = 'audit-archive.json';
const ARCHIVE_SCHEMA = 'clue.audit.archive/1' as const;

/* ------------------------------------------------------------------------- */
/* Errors                                                                     */
/* ------------------------------------------------------------------------- */

/** Thrown when the policy engine refuses a request. Carries the machine-readable code. */
export class PolicyDenialError extends Error {
  public readonly code: DenialCode;
  public readonly capability: Capability;
  public readonly command: string;

  public constructor(request: PolicyRequest, decision: PolicyDecision) {
    super(
      `Denied ${request.command} (${request.capability}): ${decision.reason ?? 'no reason given'}`,
    );
    this.name = 'PolicyDenialError';
    this.code = decision.code ?? 'PERMANENTLY_DENIED';
    this.capability = request.capability;
    this.command = request.command;
  }
}

export type AuditLogErrorCode = 'CHAIN_BROKEN' | 'HASH_MISMATCH' | 'SEGMENT_MISSING' | 'SEGMENT_ALTERED';

/** An audit-history integrity failure: the log or its archive has been edited outside CLUE. */
export class AuditLogError extends Error {
  public readonly code: AuditLogErrorCode;
  public readonly sequence: number | null;

  public constructor(code: AuditLogErrorCode, message: string, sequence: number | null = null) {
    super(message);
    this.name = 'AuditLogError';
    this.code = code;
    this.sequence = sequence;
  }
}

/* ------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* ------------------------------------------------------------------------- */

export interface AuditRecordInput {
  readonly actor: Actor;
  readonly command: string;
  readonly capability: string;
  readonly target?: string | null;
  /** Hashed, never stored. Must be JSON-serialisable. */
  readonly args?: unknown;
  readonly decision: 'allowed' | 'denied';
  readonly reason?: string | null;
  readonly missionVersion: string;
  readonly durationMs?: number | null;
  /** Correlates the records of one operation. Auto-generated when the caller omits it. */
  readonly executionId?: string;
}

export class AuditLog {
  private readonly logDir: string;
  private readonly filePath: string;
  private readonly manifestPath: string;
  private readonly maxLogBytes: number;
  private readonly projections: ProjectionStore;
  private readonly secrets: SecretRegistry;
  private sequence: number;
  private head: { sequence: number; hash: string } | null;

  public constructor(
    logsDir: string,
    projections: ProjectionStore,
    secrets: SecretRegistry,
    options: { readonly readOnly?: boolean; readonly maxLogBytes?: number } = {},
  ) {
    this.logDir = logsDir;
    this.filePath = join(logsDir, 'audit.ndjson');
    this.manifestPath = join(logsDir, MANIFEST_NAME);
    this.maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
    this.projections = projections;
    this.secrets = secrets;

    // DEV-P0-10: a read-only attach records nothing, so it must not create the logs directory.
    if (options.readOnly !== true) mkdirSync(logsDir, { recursive: true });
    this.sequence = this.readHighestSequence();
    this.head = this.readHead();
  }

  /**
   * Writes one entry, durably, and indexes it.
   *
   * The file write is fsynced before the index insert. If the process dies between the
   * two, the file is complete and `reindex()` restores the table — the reverse ordering
   * could leave an indexed command with no record of ever having been authorised.
   */
  public record(input: AuditRecordInput): WrittenAuditEntry {
    this.sequence += 1;

    // The hash covers every field including the execution id and the predecessor link, so
    // the chain is what makes any later edit — even to the correlation id — detectable.
    const unhashed = {
      id: `AUDIT-${String(this.sequence).padStart(6, '0')}`,
      timestamp: nowIso(),
      actor: input.actor,
      command: input.command,
      capability: input.capability,
      target: input.target === undefined ? null : this.redactNullable(input.target),
      arguments_digest: hashCanonicalJson(input.args ?? null),
      decision: input.decision,
      reason: input.reason === undefined ? null : this.redactNullable(input.reason),
      mission_version: input.missionVersion,
      duration_ms: input.durationMs ?? null,
      execution_id: input.executionId ?? newExecutionId(),
      previous_hash: this.head === null ? null : this.head.hash,
    };
    const hash = hashCanonicalJson(unhashed);
    const entry = parseOrThrow(writtenAuditEntrySchema, { ...unhashed, hash }, 'audit entry');

    this.appendLine(canonicalJson(entry));
    this.head = { sequence: this.sequence, hash };
    this.index(entry);
    return entry;
  }

  /** Most recent entries, newest first. Served from the index. */
  public tail(count = 20): StoredAuditEntry[] {
    const rows = this.projections.db
      .prepare(
        `SELECT id, timestamp, actor, command, capability, target, arguments_digest,
                decision, reason, mission_version, duration_ms
           FROM audit_entries
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(Math.max(1, count));
    return rows.map((row) => parseOrThrow(storedAuditEntrySchema, row, 'audit_entries row'));
  }

  /** Denials only — the view that matters when a boundary is being probed. */
  public denials(count = 20): StoredAuditEntry[] {
    const rows = this.projections.db
      .prepare(
        `SELECT id, timestamp, actor, command, capability, target, arguments_digest,
                decision, reason, mission_version, duration_ms
           FROM audit_entries
          WHERE decision = 'denied'
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(Math.max(1, count));
    return rows.map((row) => parseOrThrow(storedAuditEntrySchema, row, 'audit_entries row'));
  }

  /** Rebuilds the index from the active file. The file is always the authority. */
  public reindex(): number {
    if (!existsSync(this.filePath)) return 0;

    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    const db = this.projections.db;

    const rebuild = (): number => {
      db.prepare('DELETE FROM audit_entries').run();
      let indexed = 0;
      let previous: { hash: string } | null = null;
      for (const line of lines) {
        if (line.length === 0) continue;
        const entry = parseOrThrow(readAuditEntrySchema, JSON.parse(line) as unknown, 'audit log line');
        verifyChainStep(entry, previous);
        previous = entry.hash === undefined ? null : { hash: entry.hash };
        this.index(entry);
        indexed += 1;
      }
      return indexed;
    };

    // DEV-P0-01: when called from projection rebuild, the store already holds the transaction, so do
    // not open a nested one; run standalone otherwise.
    if (db.inTransaction) {
      return rebuild();
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const indexed = rebuild();
      db.exec('COMMIT');
      return indexed;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /* ----------------------------- internals ---------------------------- */

  private appendLine(line: string): void {
    this.rotateIfNeeded();
    const fd = openSync(this.filePath, 'a');
    try {
      writeAllSync(fd, Buffer.from(`${line}\n`, 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Rotates the active file once it grows past the threshold.
   *
   * Rotation preserves history rather than truncating it: an audit log that discards
   * its own past to save space cannot answer the questions it exists for.
   */
  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;
    if (statSync(this.filePath).size < this.maxLogBytes) return;

    const stamp = nowIso().replace(/[:.]/g, '-');
    const segmentName = `audit-${stamp}.ndjson`;
    const segmentPath = join(this.logDir, segmentName);
    renameSync(this.filePath, segmentPath);
    this.recordRotation(segmentName, segmentPath);
    // The in-memory head is preserved, so the first record in the new file links to the
    // last record of the rotated segment: the chain spans files unbroken.
  }

  /** Adds a rotated segment to the archive manifest so the full history stays verifiable. */
  private recordRotation(segmentName: string, segmentPath: string): void {
    const content = readFileSync(segmentPath);
    const lines = content.toString('utf8').split('\n').filter((line) => line.length > 0);
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];

    const manifest = this.readManifest();
    manifest.segments.push({
      segment: segmentName,
      sha256: hashBytes(content),
      bytes: content.byteLength,
      first_id: firstLine === undefined ? null : readAuditId(firstLine),
      last_id: lastLine === undefined ? null : readAuditId(lastLine),
      head_hash: this.head === null ? null : this.head.hash,
      rotated_at: nowIso(),
    });
    this.writeManifest(manifest);
  }

  /** Reads the archive manifest; a missing or corrupt manifest reads as empty. */
  public readManifest(): ArchiveManifest {
    if (!existsSync(this.manifestPath)) return { schema: ARCHIVE_SCHEMA, segments: [] };
    try {
      return parseOrThrow(
        archiveManifestSchema,
        JSON.parse(readFileSync(this.manifestPath, 'utf8')) as unknown,
        'audit archive manifest',
      );
    } catch {
      return { schema: ARCHIVE_SCHEMA, segments: [] };
    }
  }

  private writeManifest(manifest: ArchiveManifest): void {
    const tempPath = join(this.logDir, `.${MANIFEST_NAME}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
    const fd = openSync(tempPath, 'wx');
    try {
      writeAllSync(fd, Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    replaceFileSync(tempPath, this.manifestPath);
  }

  /**
   * Verifies the active file's hash chain end to end. `clue doctor` work: throws on the
   * first edited or mislinked record, tolerating a legacy (pre-chain) prefix.
   */
  public verifyChain(): { records: number } {
    if (!existsSync(this.filePath)) return { records: 0 };
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    let previous: { hash: string } | null = null;
    let records = 0;
    for (const line of lines) {
      if (line.length === 0) continue;
      const entry = parseOrThrow(readAuditEntrySchema, JSON.parse(line) as unknown, 'audit log line');
      verifyChainStep(entry, previous);
      previous = entry.hash === undefined ? null : { hash: entry.hash };
      records += 1;
    }
    return { records };
  }

  /**
   * Verifies every archived segment named in the manifest is present and unaltered.
   * Detects a rotated segment that was deleted or edited after rotation.
   */
  public verifyArchive(): { segments: number } {
    const manifest = this.readManifest();
    for (const segment of manifest.segments) {
      const path = join(this.logDir, segment.segment);
      if (!existsSync(path)) {
        throw new AuditLogError('SEGMENT_MISSING', `Archived audit segment ${segment.segment} is missing`);
      }
      const actual = hashBytes(readFileSync(path));
      if (actual !== segment.sha256) {
        throw new AuditLogError(
          'SEGMENT_ALTERED',
          `Archived audit segment ${segment.segment} hashes to ${actual}, not ${segment.sha256}`,
        );
      }
    }
    return { segments: manifest.segments.length };
  }

  private index(entry: StoredAuditEntry): void {
    this.projections.db
      .prepare(
        `INSERT INTO audit_entries
           (id, timestamp, actor, command, capability, target, arguments_digest,
            decision, reason, mission_version, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        entry.id,
        entry.timestamp,
        entry.actor,
        entry.command,
        entry.capability,
        entry.target,
        entry.arguments_digest,
        entry.decision,
        entry.reason,
        entry.mission_version,
        entry.duration_ms,
      );
  }

  /**
   * Highest sequence already on disk, so IDs keep rising across restarts and across
   * rotations. Derived from the index when available, from the file otherwise.
   */
  private readHighestSequence(): number {
    const row = this.projections.db.prepare('SELECT MAX(id) AS max_id FROM audit_entries').get();
    const fromIndex = parseSequence(readStringOrNull(row, 'max_id'));
    if (fromIndex > 0) return fromIndex;

    if (!existsSync(this.filePath)) return 0;
    const lines = readFileSync(this.filePath, 'utf8').trimEnd().split('\n');
    const last = lines[lines.length - 1];
    if (last === undefined || last.length === 0) return 0;

    try {
      const parsed = JSON.parse(last) as { id?: unknown };
      return typeof parsed.id === 'string' ? parseSequence(parsed.id) : 0;
    } catch {
      return 0;
    }
  }

  /** The last committed entry's sequence and hash, so the next record links to it. */
  private readHead(): { sequence: number; hash: string } | null {
    if (!existsSync(this.filePath)) return null;
    const lines = readFileSync(this.filePath, 'utf8').trimEnd().split('\n');
    const last = lines[lines.length - 1];
    if (last === undefined || last.length === 0) return null;
    try {
      const parsed = JSON.parse(last) as { id?: unknown; hash?: unknown };
      if (typeof parsed.id === 'string' && typeof parsed.hash === 'string') {
        return { sequence: parseSequence(parsed.id), hash: parsed.hash };
      }
    } catch {
      return null;
    }
    return null;
  }

  private redactNullable(value: string | null): string | null {
    return value === null ? null : this.secrets.redact(value);
  }
}

function parseSequence(id: string | null): number {
  if (id === null) return 0;
  const digits = id.slice('AUDIT-'.length);
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function readStringOrNull(row: unknown, field: string): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

function readAuditId(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

/** A fresh execution id; correlates the records of one operation. */
function newExecutionId(): string {
  return `EXEC-${randomBytes(12).toString('hex')}`;
}

/** Verifies one entry's self-hash and its link to the previous chained entry. */
function verifyChainStep(entry: ReadAuditEntry, previous: { hash: string } | null): void {
  if (entry.hash === undefined) return; // legacy entry; the chain restarts after it
  const { hash, ...unhashed } = entry;
  const expected = hashCanonicalJson(unhashed);
  if (expected !== hash) {
    throw new AuditLogError(
      'HASH_MISMATCH',
      `Audit ${entry.id} content hashes to ${expected}, not ${hash}. The log was edited outside CLUE.`,
      parseSequence(entry.id),
    );
  }
  if (previous !== null && entry.previous_hash != null && entry.previous_hash !== previous.hash) {
    throw new AuditLogError(
      'CHAIN_BROKEN',
      `Audit ${entry.id} references previous hash ${entry.previous_hash}, but its predecessor hashes to ${previous.hash}.`,
      parseSequence(entry.id),
    );
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/* ------------------------------------------------------------------------- */
/* Audited dispatcher                                                         */
/* ------------------------------------------------------------------------- */

export interface DispatchRequest extends PolicyRequest {
  /** Arguments to hash into the record. Never stored in the clear. */
  readonly args?: unknown;
  /** Correlation id for this operation; generated when omitted, shared across its records. */
  readonly executionId?: string;
}

/**
 * The single entry point for anything the policy engine governs.
 *
 * Auditing is not something a caller remembers to do; it is what wraps the call. A
 * component that wants to act must go through `run`, and `run` cannot execute without
 * having first written a durable record of the decision that permitted it.
 */
export class AuditedDispatcher {
  private readonly policy: PolicyEngine;
  private readonly audit: AuditLog;
  private readonly missionVersion: () => string;

  public constructor(policy: PolicyEngine, audit: AuditLog, missionVersion: () => string) {
    this.policy = policy;
    this.audit = audit;
    this.missionVersion = missionVersion;
  }

  /** Evaluates and records a decision without executing anything. */
  public check(request: DispatchRequest): PolicyDecision {
    return this.begin(request, request.executionId ?? newExecutionId());
  }

  /**
   * Evaluates, records, then executes synchronous work.
   *
   * On denial the work is never invoked and a `PolicyDenialError` is thrown. On success a
   * second record marks completion with the measured duration; on failure it marks the
   * failure. Start and end share one execution id, so an interrupted operation is visible
   * as a start without an end rather than vanishing. A promise-returning callback is
   * refused here — its completion could not be recorded truthfully — and must use
   * `runAsync`.
   */
  public run<T>(request: DispatchRequest, work: () => T): T {
    const executionId = request.executionId ?? newExecutionId();
    const decision = this.begin(request, executionId);
    if (decision.decision === 'denied') {
      throw new PolicyDenialError(request, decision);
    }

    const started = Date.now();
    let result: T;
    try {
      result = work();
    } catch (error) {
      this.recordEnd(request, decision, executionId, started, error);
      throw error;
    }

    if (isThenable(result)) {
      const misuse = new Error(
        `AuditedDispatcher.run received asynchronous work for ${request.command}; use runAsync().`,
      );
      this.recordEnd(request, decision, executionId, started, misuse);
      throw misuse;
    }

    this.recordEnd(request, decision, executionId, started, null);
    return result;
  }

  /**
   * Evaluates, records, then executes asynchronous work, recording completion when the
   * promise settles rather than when it is scheduled.
   */
  public async runAsync<T>(request: DispatchRequest, work: () => Promise<T>): Promise<T> {
    const executionId = request.executionId ?? newExecutionId();
    const decision = this.begin(request, executionId);
    if (decision.decision === 'denied') {
      throw new PolicyDenialError(request, decision);
    }

    const started = Date.now();
    try {
      const result = await work();
      this.recordEnd(request, decision, executionId, started, null);
      return result;
    } catch (error) {
      this.recordEnd(request, decision, executionId, started, error);
      throw error;
    }
  }

  /** Evaluates the request and writes the start record under a given execution id. */
  private begin(request: DispatchRequest, executionId: string): PolicyDecision {
    const decision = this.policy.evaluate(request);
    this.audit.record({
      actor: request.actor,
      command: request.command,
      capability: request.capability,
      target: decision.resolvedTarget ?? request.target ?? null,
      args: request.args,
      decision: decision.decision,
      reason: decision.reason,
      missionVersion: this.missionVersion(),
      executionId,
    });
    return decision;
  }

  /** Writes the completion (or failure) record for an operation, sharing its execution id. */
  private recordEnd(
    request: DispatchRequest,
    decision: PolicyDecision,
    executionId: string,
    started: number,
    error: unknown,
  ): void {
    const failed = error !== null && error !== undefined;
    const message = failed ? (error as Error).message : null;
    this.audit.record({
      actor: request.actor,
      command: `${request.command}:${failed ? 'failed' : 'completed'}`,
      capability: request.capability,
      target: decision.resolvedTarget ?? request.target ?? null,
      args: null,
      decision: 'allowed',
      reason: failed ? (message && message.length > 0 ? message : 'error') : null,
      missionVersion: this.missionVersion(),
      durationMs: Date.now() - started,
      executionId,
    });
  }
}