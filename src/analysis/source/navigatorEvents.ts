/**
 * Durable System Navigator event writer.
 *
 * Spec: CLUE_Q1_System_Navigator_v9.md §14.5 (versioning and seals: the stream binds
 *       stream schema version, snapshot/capture identity, recognition run identity,
 *       durable result hash, and committed unit/edge counts), §10.7 (replay must
 *       reconstruct identical truth), §14.6 (idempotency; stale events are rejected).
 *       CLUE_Project_Directory_v9.md §11.3 — this module is the sole owner of the
 *       versioned inventory/recognition stream consumed by Q1; §22 — `workspace/streams`
 *       holds sealed and live source files *with bounded retention*.
 *       CLUE_Architecture_v9.md — durable records survive a crash without partial or
 *       silently-replaced state.
 * Constitution: CLUE_Constitution_v9.md Zasada 17 / amendment A4 — the System Navigator
 *       renders durable knowledge; it never becomes durable knowledge by itself.
 *
 * Backlog: DEV-P1-46 — §14.5 lists eight facts the stream should bind. Four were bound,
 * one was half bound, three were not bound at all, and the stream said nothing about any
 * of it. §14.4 requires that unknown, unsupported and partial states remain explicit: the
 * gap is permitted, the silence is not. Every line of {@link navigatorSealBindings} is now
 * emitted on `scan.started`, so a reader learns what this stream can and cannot claim from
 * its first line rather than inferring it from absent fields.
 *
 *   | §14.5 fact | state | where |
 *   |---|---|---|
 *   | stream schema version | bound | `v` on every envelope |
 *   | taxonomy version/hash | bound in production; unavailable on a legacy writer | `inventory.taxonomy` |
 *   | repository inventory hash | bound in production; unavailable on a legacy writer | `inventory.completed` |
 *   | snapshot/capture identity | bound in production; capture unavailable only when omitted by a caller | envelope / `scan.started` |
 *   | recognition run identity | bound | `runId` on every envelope |
 *   | durable result hash | bound | `resultHash` in the pointer, `graphSha256` in the seal |
 *   | committed unit/edge counts | bound | `graph.committed` and the pointer |
 *   | inventory file/family/environment counts | bound in production; unavailable on a legacy writer | `inventory.completed.counts` |
 *
 * Q1 SURF now has a governed taxonomy and a full physical inventory authority. The
 * production recognition coordinator supplies both before semantic recognition begins.
 * A test or legacy caller may still construct a writer without that inventory; such a
 * writer reports the facts `unavailable`, never `unsupported`, because the capability is
 * implemented but absent from that particular run. Recognition remains an enrichment
 * source and never manufactures physical file membership.
 *
 * Capture identity is the one that differs, and it is why the table says partial rather
 * than bound. §14.5 asks for "snapshot/capture identity" and only the snapshot half was
 * ever on the stream, while `CaptureId` exists in `src/shared/evidenceIdentity.ts` and the
 * recognize command already holds one. This file now accepts a `captureId` and emits it in
 * `scan.started` and `graph.committed`; until the caller supplies one it emits `null` and
 * the binding entry reports `unavailable` with the call site named. A writer cannot bind
 * what it is not given, and it must not copy the snapshot id into the field to make it
 * look populated — the same identity-honesty rule {@link NavigatorEventWriter.graphCommitted}
 * already applies to `recognitionRecordId`.
 *
 * The declaration carries nine entries for §14.5's eight bullets: "snapshot/capture
 * identity" is one bullet naming two identities, and they are in different states, so
 * collapsing them would have to report the pair as bound or unbound and either answer
 * would be false.
 *
 * Backlog: DEV-P1-06 — four defects, all of which let the stream claim more than it held.
 *
 *   1. *Sealing was neither atomic nor owned here.* The per-run "immutable" copy and the
 *      `current.json` pointer were produced in `src/cli/index.ts` by `readFileSync` into
 *      `writeFileSync`, with no fsync, no no-replace guarantee, and a bare `catch {}`. A
 *      crash mid-copy left a truncated file that is indistinguishable from a complete one,
 *      and a re-run could overwrite a sealed record. Both operations now live here — the
 *      Directory names this file the stream's owner — and go through the durable
 *      primitives: temp file, whole-buffer write, fsync, then `placeFileNoReplaceSync`
 *      for the immutable per-run record and `replaceFileSync` for the mutable pointer.
 *
 *   2. *There was no stream hash.* `graphSha256` is a fingerprint of the durable graph
 *      record's fields, not of these bytes, yet this file's own documentation described it
 *      as "the stream's replay fingerprint". Nothing hashed the stream, so a truncated or
 *      partially-written stream could be sealed and pointed at as authoritative. The
 *      writer now hashes every byte it durably writes; the seal is refused unless the file
 *      on disk hashes to the value the writer accumulated, and `graph.committed` carries
 *      `streamPrefixSha256` — the hash of everything before that line — so a replayer can
 *      verify the stream's own integrity from inside the stream.
 *
 *   3. *Writer failure was unobservable.* `flush` used a single `writeSync`, which may
 *      write fewer bytes than requested and silently truncate; a failing descriptor
 *      produced no record anywhere; a stream that never opened threw from the constructor
 *      and killed a recognition that telemetry may never affect. Writes are now whole-
 *      buffer and checked, a failure *degrades* the writer instead of throwing or lying,
 *      and {@link NavigatorEventWriter.receipt} states bytes, events, hash, degradation,
 *      failure count and dropped-event count so the caller can report what actually
 *      happened rather than assuming success.
 *
 *   4. *Retention was unbounded.* Per-run streams accumulated without limit — the
 *      reference workspace held 26 sealed streams totalling 377 MB. {@link pruneRunStreams}
 *      applies a count and byte budget, never removes the run named by `current.json` or
 *      any explicitly protected run, and returns a receipt of exactly what it deleted.
 *
 * Deliberately *not* done under this item: intra-stream compaction (dropping `scan.progress`
 * lines from a sealed stream). It is safe in principle — progress events carry no graph
 * facts, so §10.7 replay truth is unaffected — but it would break the byte-parity between
 * the live stream and its sealed copy that defect 2 exists to establish. Doing it honestly
 * requires a second, separately-hashed compacted artifact and a declared relation between
 * the two; that is a design decision, not a patch, and it is left open.
 *
 * This observer projects recognition truth into a replayable stream consumed by the
 * WebGPU Navigator. It never changes recognition results, the graph database, or Murugan
 * source. Two boundaries hold it in place.
 *
 *   **It is one stream, and a separate contract from the Console Ledger.** This file
 *   carries *structural facts* discovered by Stage C — files, units, edges, unresolved
 *   references. Runtime observations (Chrome warnings, exceptions) live in the Console
 *   Ledger, which has different provenance, lifecycle, and invalidation rules
 *   (§14.6, §28B). The two may meet in the Navigator's graph projection, but they are
 *   never merged into one event protocol here.
 *
 *   **It cannot leak, and it cannot lie.** The stream carries the recognizer's own
 *   metadata records, which contain no source text. The one place source or a secret
 *   could enter is an error string, so every error that reaches the stream — a scan
 *   failure, or a failure inside the observer itself — passes through {@link redactError}
 *   first: environment-variable values are stripped by policy, the message is collapsed
 *   to one line, stacks are never included, and the result is length-capped.
 *
 *   **Completion is provisional until the graph is durable.** Every line carries the
 *   `runId` of its recognition run — an identity distinct from the snapshot, since one
 *   snapshot may be scanned many times. When the caller opts into the commit protocol
 *   (`awaitCommit`), `scan.completed` no longer ends the stream: the durable-commit
 *   pair (`graph.committing`, then `graph.committed` once §24.3 persistence has been
 *   written and verified) seals it, and only that final event lets the Navigator
 *   claim committed knowledge (Zasada 17 / A4).
 *
 * The writer owns the envelope schema ({@link navigatorEnvelopeSchema}) so that the SSE
 * transport, the browser projection, and the observer self-test all validate against one
 * definition rather than three that could drift. It does not validate on the write path —
 * the recognizer emits tens of thousands of events per large project, and paying zod on
 * each would tax a hot loop for a guarantee the type system already gives at construction.
 * Consumers validate; the producer builds correctly by construction.
 *
 * Batching is deliberate. One synchronous append per source file keeps genuine
 * file-by-file progress without turning every function and edge into an individual
 * syscall. A very large file therefore arrives as one burst; revealing each unit at the
 * exact moment of discovery is a future deep-stream seam that would distribute telemetry
 * through the recognizer's core traversal, and is intentionally not taken here.
 */

import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import {
  fsyncDir,
  placeFileNoReplaceSync,
  replaceFileSync,
  writeAllSync,
} from '../../shared/durableFs.js';
import {
  projectRecognitionIdentityEquals,
  projectRecognitionIdentitySchema,
  type ProjectRecognitionIdentity,
} from '../../shared/projectRecognitionIdentity.js';

import type {
  RecognitionObserver,
  RecognitionResult,
  SourceEdge,
  SourceUnit,
  UnresolvedReference,
} from './recognizer.js';
import type {
  RepositoryInventory,
  RepositoryInventoryEnrichment,
  RepositorySemanticSummary,
} from './repositoryInventory.js';

/* ------------------------------------------------------------------------- */
/* Event-envelope schema (owned here)                                         */
/* ------------------------------------------------------------------------- */

/**
 * Every event type that may appear on the Navigator stream. The recognizer writer emits
 * a subset (scan, file, unit, edge, unresolved, completion, and its own observer-error);
 * lifecycle and enrichment events (`unit.phase`, `unit.details`, `graph.replace`,
 * `navigator.reset`) are published by later services against the same envelope. The
 * durable-commit pair (`graph.committing`, `graph.committed`) is appended by the
 * recognize command after graph persistence.
 */
export const navigatorEventTypeSchema = z.enum([
  'inventory.started',
  'inventory.taxonomy',
  'files.upserted',
  'files.removed',
  'inventory.completed',
  'dependency.discovered',
  'recognition.started',
  'file.semantic-summary',
  'scan.started',
  'scan.progress',
  'unit.discovered',
  'edge.discovered',
  'reference.unresolved',
  'unit.phase',
  'unit.details',
  'scan.completed',
  'graph.replace',
  'graph.committing',
  'graph.committed',
  'navigator.reset',
  'observer.error',
]);

export type NavigatorEventType = z.infer<typeof navigatorEventTypeSchema>;

/**
 * The wire envelope shared by every NDJSON line and SSE message. `sequence` is monotonic
 * within one `streamId`; duplicate and older events are ignored by the browser
 * projection. `v` is the protocol version — this is a versioned stream (§14.5). `runId`
 * names the recognition run itself — distinct from `snapshotId` (one snapshot may be
 * scanned many times) and constant across every line of one stream.
 */
export const navigatorEnvelopeSchema = z
  .object({
    v: z.literal(1),
    type: navigatorEventTypeSchema,
    streamId: z.string().min(1),
    runId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    emittedAt: z.string().min(1),
    snapshotId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type NavigatorEnvelope = z.infer<typeof navigatorEnvelopeSchema>;

/* ------------------------------------------------------------------------- */
/* §14.5 seal bindings — declared, including the ones that cannot be bound     */
/* ------------------------------------------------------------------------- */

/**
 * Why a §14.5 fact carries no value.
 *
 * Deliberately the same vocabulary and the same distinction `statusContractV5.ts` uses for
 * an absent branch, because it is the same problem: `unsupported` says the capability is
 * specified by the contract and not implemented in this build, `unavailable` says it is
 * implemented but was not supplied for this run. Collapsing them would make a missing
 * subsystem indistinguishable from a caller that forgot an argument.
 */
export const SEAL_BINDING_STATES = ['bound', 'unsupported', 'unavailable'] as const;

export type SealBindingState = (typeof SEAL_BINDING_STATES)[number];

/**
 * One §14.5 fact and what this stream actually does with it.
 *
 * `reason` is mandatory for every non-`bound` state and must name the specific missing
 * thing — "no `src/analysis/environments/` in this build" is useful, a bare `unsupported`
 * is not. `location` names the field a reader should look at when the fact is bound, so
 * the declaration doubles as a map into the stream rather than only a disclaimer.
 */
export interface NavigatorSealBinding {
  /** The fact, worded as §14.5 words it. */
  readonly fact: string;
  readonly state: SealBindingState;
  /** Where the value is, when bound; null otherwise. */
  readonly location: string | null;
  /** Why not, in one specific line; null when bound. */
  readonly reason: string | null;
  /** The module that would own this fact, when one is named by the contract. */
  readonly expectedSource: string | null;
}

/**
 * The eight §14.5 facts, computed from what this writer was actually given rather than
 * written down as a fixed list.
 *
 * That distinction is the point. A hardcoded table would be a claim about the stream that
 * nothing keeps true: inventory and capture entries flip from `unavailable` to `bound`
 * when the coordinator supplies their exact authority. The table is therefore derived
 * from the run basis rather than copied from a capability wish list.
 */
export function navigatorSealBindings(basis: {
  readonly captureId: string | null;
  readonly inventory?: RepositoryInventory | null;
}): readonly NavigatorSealBinding[] {
  const inventory = basis.inventory ?? null;
  const taxonomyBound = inventory !== null;
  return [
    {
      fact: 'stream schema version',
      state: 'bound',
      location: 'envelope.v',
      reason: null,
      expectedSource: null,
    },
    taxonomyBound
      ? {
          fact: 'taxonomy version/hash',
          state: 'bound',
          location: 'inventory.taxonomy.taxonomyVersion, inventory.taxonomy.taxonomyHash',
          reason: null,
          expectedSource: 'src/analysis/environments/artifactTaxonomy.ts',
        }
      : {
          fact: 'taxonomy version/hash',
          state: 'unavailable',
          location: null,
          reason:
            'repository inventory is implemented but was not supplied to this writer for this run',
          expectedSource: 'src/analysis/environments/artifactTaxonomy.ts',
        },
    inventory !== null
      ? {
          fact: 'repository inventory hash',
          state: 'bound',
          location: 'inventory.completed.inventoryHash, graph.committed.inventoryHash',
          reason: null,
          expectedSource: 'src/analysis/source/repositoryInventory.ts',
        }
      : {
          fact: 'repository inventory hash',
          state: 'unavailable',
          location: null,
          reason:
            'repository inventory is implemented but was not supplied to this writer for this run',
          expectedSource: 'src/analysis/source/repositoryInventory.ts',
        },
    {
      fact: 'snapshot identity',
      state: 'bound',
      location: 'envelope.snapshotId',
      reason: null,
      expectedSource: null,
    },
    basis.captureId === null
      ? {
          fact: 'capture identity',
          state: 'unavailable',
          location: null,
          reason:
            'CaptureId is implemented but no captureId was supplied to this writer for this run',
          expectedSource: 'src/control/recognitionRun.ts',
        }
      : {
          fact: 'capture identity',
          state: 'bound',
          location: 'scan.started.captureId, graph.committed.captureId',
          reason: null,
          expectedSource: null,
        },
    {
      fact: 'recognition run identity',
      state: 'bound',
      location: 'envelope.runId',
      reason: null,
      expectedSource: null,
    },
    {
      fact: 'durable result hash',
      state: 'bound',
      location: 'graph.committed.graphSha256, current.json resultHash',
      reason: null,
      expectedSource: null,
    },
    {
      fact: 'committed unit/edge counts',
      state: 'bound',
      location: 'graph.committed.unitCount, graph.committed.edgeCount',
      reason: null,
      expectedSource: null,
    },
    inventory !== null
      ? {
          fact: 'inventory file/family/environment counts',
          state: 'bound',
          location: 'inventory.completed.counts, graph.committed.inventoryCounts',
          reason: null,
          expectedSource: 'src/analysis/source/repositoryInventory.ts',
        }
      : {
          fact: 'inventory file/family/environment counts',
          state: 'unavailable',
          location: null,
          reason:
            'repository inventory is implemented but was not supplied to this writer for this run',
          expectedSource: 'src/analysis/source/repositoryInventory.ts',
        },
  ];
}

/* ------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Environment-variable names whose values must never reach the stream. Mirrors the host
 * gateway's secret policy so the two agree on what is dangerous; kept local so this file
 * has no cross-module coupling for a three-element list.
 */
const SECRET_ENV_NAMES: readonly string[] = ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'];

/** The longest error string permitted onto the stream. Beyond this it is truncated. */
const MAX_ERROR_LENGTH = 500;

/**
 * Reduces any thrown value to a single, safe line. Takes the message only (never a stack,
 * which names source files), removes known secret values, collapses whitespace, and caps
 * the length. Reads the environment once per call; a value not present cannot be matched,
 * which is correct — there is nothing to hide.
 */
export function redactError(error: unknown, env: Readonly<Record<string, string | undefined>>): string {
  const raw = error instanceof Error ? error.message : String(error);
  let result = raw.replace(/\s+/g, ' ').trim();
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined && value.length >= 8) {
      result = result.split(value).join(`«${name}»`);
    }
  }
  if (result.length > MAX_ERROR_LENGTH) {
    result = `${result.slice(0, MAX_ERROR_LENGTH)}…`;
  }
  return result;
}

/* ------------------------------------------------------------------------- */
/* Writer                                                                     */
/* ------------------------------------------------------------------------- */

export interface NavigatorEventWriterOptions {
  readonly path: string;
  readonly projectName: string;
  readonly snapshotId: string;
  /**
   * The capture half of §14.5's "snapshot/capture identity". Distinct from the snapshot:
   * Architecture §4.2 makes `CaptureId` one capture receipt, environment, Git and time
   * context, while `SnapshotContentId` names the content basis. Null when the caller has
   * none — never the snapshot id under another name.
   */
  readonly captureId?: string | null;
  /** Physical inventory emitted before semantic recognition. Null preserves legacy writers. */
  readonly inventory?: RepositoryInventory | null;
  /** Exact Project Profile recognition generation carried by every event, when profile-bound. */
  readonly projectRecognition?: ProjectRecognitionIdentity | null;
  /**
   * Override for fixtures and tests. Defaults to `recognizer:<snapshotId>:<runId>` so
   * every recognition run is a distinct stream to the browser's per-stream dedup.
   */
  readonly streamId?: string;
  /**
   * Identity of this recognition run — distinct from the snapshot, and the key for
   * per-run immutable streams. Minted with randomUUID when not supplied.
   */
  readonly runId?: string;
  /**
   * When true, `scan.completed` leaves the stream open so the caller can append the
   * durable-commit pair after persistence (§24.3: results are persisted first;
   * telemetry follows). Default false preserves close-on-complete for callers with
   * no commit step.
   */
  readonly awaitCommit?: boolean;
  readonly cinematic?: boolean;
  readonly flushBytes?: number;
  /** Environment used for error redaction. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Writes complete recognition telemetry in file-sized batches to a fresh append-only
 * stream per scan. Implements {@link RecognitionObserver}; because the recognizer isolates
 * observer failures and calls {@link onObserverError}, a broken descriptor here can never
 * abort a scan — at worst the stream ends early and the failure is recorded.
 */
export class NavigatorEventWriter implements RecognitionObserver {
  public readonly path: string;
  /** Identity of this recognition run; constant across every line of the stream. */
  public readonly runId: string;

  private readonly options: Required<
    Omit<NavigatorEventWriterOptions, 'streamId' | 'env' | 'projectRecognition'>
  > & {
    readonly streamId: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly projectRecognition: ProjectRecognitionIdentity | null;
  };
  private descriptor: number | null = null;
  private sequence = 0;
  private buffered: string[] = [];
  private bufferedBytes = 0;
  private closed = false;

  /**
   * Rolling hash over every byte this writer has durably written. Advanced only after a
   * successful write, so it can never describe bytes that are not on the file — which is
   * the whole point: it is the value {@link sealRunStream} re-derives from disk.
   */
  private readonly digest: Hash = createHash('sha256');
  private bytesWritten = 0;
  private eventCount = 0;
  private degraded = false;
  private writeFailures = 0;
  private droppedEvents = 0;
  private lastError: string | null = null;
  private sealed = false;
  private prefixSha256: string | null = null;
  private physicalMembers: Map<string, InventoryMember> | null = null;
  private physicalIdentityConsistent = true;

  public constructor(options: NavigatorEventWriterOptions) {
    this.path = options.path;
    // The stream identity must carry the run identity. One snapshot may be scanned many
    // times, and the browser projection deduplicates by (streamId, sequence): a default
    // streamId naming only the snapshot made every re-run of the same snapshot look
    // stale — its fresh sequence numbers compared against the previous run's high-water
    // mark and were discarded. Qualifying the stream with the runId makes each run a
    // distinct, immutable stream, which is what §14.5 promises and what the envelope's
    // own runId documentation already claims.
    const runId = options.runId ?? randomUUID();
    this.options = {
      path: options.path,
      projectName: options.projectName,
      snapshotId: options.snapshotId,
      captureId: options.captureId ?? null,
      inventory: options.inventory ?? null,
      projectRecognition: options.projectRecognition ?? null,
      streamId: options.streamId ?? `recognizer:${options.snapshotId}:${runId}`,
      runId,
      awaitCommit: options.awaitCommit ?? false,
      cinematic: options.cinematic ?? true,
      flushBytes: options.flushBytes ?? 512 * 1024,
      env: options.env ?? process.env,
    };
    this.runId = this.options.runId;
    // One durable stream per scan (§14.5): truncate at open, then only ever append.
    // A stream that cannot be opened degrades the writer; it does not abort the caller.
    // Telemetry may never change recognition behavior (§24.3), and that has to include
    // the case where telemetry cannot start at all — previously this threw out of the
    // constructor and failed the recognition it was only supposed to observe.
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.descriptor = openSync(this.path, 'w');
    } catch (error) {
      this.degrade(error);
    }
  }

  /**
   * What this writer actually did. The caller reports from this rather than assuming the
   * stream exists: `degraded` means some or all events never reached disk, and `sha256`
   * covers exactly the bytes that did.
   */
  public receipt(): NavigatorStreamReceipt {
    const inventory = this.options.inventory;
    const members = this.physicalMembers;
    const physicalInventory = this.sealed && !this.degraded && inventory !== null && members !== null &&
      inventory.recognitionSnapshotId === this.options.snapshotId
      ? {
          repositoryId: inventory.repositoryId,
          snapshotId: inventory.snapshotId,
          inventoryHash: inventory.inventoryHash,
          expectedFileCount: inventory.counts.files,
          allFileCount: [...members.values()].filter((member) => !member.excluded).length,
          identityConsistent: this.physicalIdentityConsistent,
        }
      : undefined;
    return {
      path: this.path,
      streamId: this.options.streamId,
      runId: this.options.runId,
      snapshotId: this.options.snapshotId,
      captureId: this.options.captureId,
      eventCount: this.eventCount,
      bytesWritten: this.bytesWritten,
      sha256: this.digest.copy().digest('hex'),
      prefixSha256: this.prefixSha256,
      sealed: this.sealed,
      degraded: this.degraded,
      writeFailures: this.writeFailures,
      droppedEvents: this.droppedEvents,
      lastError: this.lastError,
      ...(physicalInventory === undefined ? {} : { physicalInventory }),
    };
  }

  /**
   * Records a write-path failure and stops writing. Never rethrows: the recognizer's
   * isolation seam already exists for observer methods, but a failure inside {@link flush}
   * can happen during `close()` too, where no seam is watching. Degradation is the honest
   * terminal state — the stream stops, the receipt says so, and nothing downstream is
   * allowed to read the truncated file as complete.
   */
  private degrade(error: unknown): void {
    this.writeFailures += 1;
    this.lastError = redactError(error, this.options.env);
    this.degraded = true;
    if (this.descriptor !== null) {
      try {
        closeSync(this.descriptor);
      } catch {
        /* the descriptor is already unusable; nothing further can be salvaged from it */
      }
      this.descriptor = null;
    }
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  /** Emits the complete physical inventory before semantic recognition begins. */
  public publishRepositoryInventory(): void {
    const inventory = this.options.inventory;
    if (inventory === null || this.closed) return;

    this.push('navigator.reset', {
      projectName: inventory.projectName,
      repositoryId: inventory.repositoryId,
      snapshotId: inventory.snapshotId,
      inventoryHash: inventory.inventoryHash,
      status: 'RESETTING NAVIGATOR FOR PHYSICAL INVENTORY',
    });
    this.push('inventory.started', {
      projectName: inventory.projectName,
      repositoryId: inventory.repositoryId,
      snapshotId: inventory.snapshotId,
      inventoryVersion: inventory.schemaVersion,
      inventoryHash: inventory.inventoryHash,
      sourceRoots: inventory.sourceRoots,
      excludedNames: inventory.excludedNames,
      expectedFileCount: inventory.counts.files,
      exclusions: inventory.exclusions,
      status: 'PHYSICAL INVENTORY STREAMING',
    });
    this.push('inventory.taxonomy', inventory.taxonomy);

    const batchSize = 96;
    const members = new Map<string, InventoryMember>();
    const paths = new Set<string>();
    this.physicalIdentityConsistent = true;
    for (let offset = 0; offset < inventory.files.length; offset += batchSize) {
      const files = inventory.files.slice(offset, offset + batchSize);
      for (const file of files) {
        if (members.has(file.fileLocationId) || paths.has(file.path)) this.physicalIdentityConsistent = false;
        members.set(file.fileLocationId, {
          path: file.path, fileVersionId: file.fileVersionId, excluded: file.excluded,
        });
        paths.add(file.path);
      }
      this.push('files.upserted', {
        repositoryId: inventory.repositoryId,
        snapshotId: inventory.snapshotId,
        inventoryHash: inventory.inventoryHash,
        offset,
        files,
      });
      this.flushIfLarge();
    }

    if (inventory.removedFiles.length > 0) {
      this.push('files.removed', {
        repositoryId: inventory.repositoryId,
        snapshotId: inventory.snapshotId,
        inventoryHash: inventory.inventoryHash,
        removedFiles: inventory.removedFiles,
        fileLocationIds: inventory.removedFiles.map((file) => file.fileLocationId),
      });
      for (const file of inventory.removedFiles) {
        if (members.delete(file.fileLocationId)) this.physicalIdentityConsistent = false;
      }
    }
    this.physicalMembers = members;

    this.push('inventory.completed', {
      projectName: inventory.projectName,
      repositoryId: inventory.repositoryId,
      snapshotId: inventory.snapshotId,
      inventoryVersion: inventory.schemaVersion,
      inventoryHash: inventory.inventoryHash,
      taxonomyVersion: inventory.taxonomy.taxonomyVersion,
      taxonomyHash: inventory.taxonomy.taxonomyHash,
      fileCount: inventory.counts.files,
      counts: inventory.counts,
      sourceRoots: inventory.sourceRoots,
      excludedNames: inventory.excludedNames,
      exclusions: inventory.exclusions,
      status: 'PHYSICAL INVENTORY COMMITTED',
    });
    this.push('recognition.started', {
      projectName: inventory.projectName,
      repositoryId: inventory.repositoryId,
      snapshotId: inventory.snapshotId,
      inventoryHash: inventory.inventoryHash,
      status: 'SEMANTIC RECOGNITION STARTING',
    });
    this.flush();
  }

  /** Adds semantic enrichment without changing physical file membership or classification. */
  public publishSemanticSummaries(summaries: readonly RepositorySemanticSummary[]): void {
    if (this.closed) return;
    for (const summary of summaries) {
      this.push('file.semantic-summary', summary);
      this.flushIfLarge();
    }
    this.flush();
  }

  /** Publishes recognized file states, semantic summaries and aggregate file dependencies. */
  public publishRepositoryEnrichment(enrichment: RepositoryInventoryEnrichment): void {
    if (this.closed) return;
    const batchSize = 96;
    for (let offset = 0; offset < enrichment.files.length; offset += batchSize) {
      const files = enrichment.files.slice(offset, offset + batchSize);
      const members = this.physicalMembers;
      if (members !== null) {
        for (const file of files) {
          const prior = members.get(file.fileLocationId);
          if (prior?.path !== file.path || prior.fileVersionId !== file.fileVersionId || prior.excluded !== file.excluded) {
            this.physicalIdentityConsistent = false;
            members.set(file.fileLocationId, {
              path: file.path, fileVersionId: file.fileVersionId, excluded: file.excluded,
            });
          }
        }
      }
      this.push('files.upserted', {
        phase: 'semantic-enrichment',
        offset,
        files,
      });
      this.flushIfLarge();
    }
    this.publishSemanticSummaries(enrichment.summaries);
    for (const edge of enrichment.edges) {
      this.push('dependency.discovered', edge);
      this.flushIfLarge();
    }
    this.flush();
  }

  public onScanStart(event: { readonly total: number }): void {
    this.push('scan.started', {
      projectName: this.options.projectName,
      totalFiles: event.total,
      status: 'SCANNING SOURCE TREE',
      // §14.5 read against §14.4: the first line declares every seal fact and its state,
      // so a consumer knows what this stream can claim before it reads 30,000 events.
      // Inventory and capture entries reflect the exact authority supplied for this run.
      captureId: this.options.captureId,
      sealBindings: navigatorSealBindings({
        captureId: this.options.captureId,
        inventory: this.options.inventory,
      }),
    });
    this.flush();
  }

  public onFileStart(event: {
    readonly path: string;
    readonly index: number;
    readonly total: number;
  }): void {
    this.push('scan.progress', {
      processedFiles: event.index,
      totalFiles: event.total,
      currentPath: event.path,
      currentUnit: '',
      status: `READING FILE · ${event.path}`,
    });
  }

  public onUnit(unit: SourceUnit): void {
    this.push('unit.discovered', {
      unit,
      cinematic: this.options.cinematic,
    });
    this.flushIfLarge();
  }

  public onEdge(edge: SourceEdge): void {
    this.push('edge.discovered', { edge });
    this.flushIfLarge();
  }

  public onUnresolved(reference: UnresolvedReference): void {
    this.push('reference.unresolved', { reference });
    this.flushIfLarge();
  }

  public onFileComplete(event: {
    readonly path: string;
    readonly index: number;
    readonly total: number;
    readonly unitCount: number;
    readonly edgeCount: number;
  }): void {
    this.push('scan.progress', {
      processedFiles: event.index,
      totalFiles: event.total,
      currentPath: event.path,
      currentUnit: '',
      status: 'RESOLVING DEPENDENCIES',
      fileUnits: event.unitCount,
      fileEdges: event.edgeCount,
    });
    this.flush();
  }

  public onScanComplete(result: RecognitionResult): void {
    this.push('scan.completed', {
      projectName: this.options.projectName,
      status: this.options.awaitCommit ? 'SCAN COMPLETE · COMMITTING GRAPH' : 'RECOGNITION COMPLETE',
      units: result.units.length,
      edges: result.edges.length,
      unresolved: result.unresolved.length,
      stats: result.stats,
    });
    this.flush();
    // §24.3: recognition results are persisted first and telemetry follows. With a
    // commit step ahead, completion here is provisional — the stream stays open for
    // the durable-commit pair, and only graph.committed (or fail/close) ends it.
    if (!this.options.awaitCommit) this.close();
  }

  /** Marks the start of durable graph persistence — first half of the commit pair. */
  public graphCommitting(): void {
    if (this.closed) return;
    this.push('graph.committing', {
      projectName: this.options.projectName,
      status: 'COMMITTING GRAPH',
    });
    this.flush();
  }

  /**
   * Records that the durable graph for this run's snapshot has been written and
   * verified, then seals the stream. Only after this event may the Navigator claim
   * the recognition is committed knowledge (Zasada 17 / A4: the Navigator renders
   * durable knowledge; it never becomes it). No-op if the stream is already closed.
   */
  /**
   * Seals the stream with the durable-commit fact. Identity honesty (P0.3): the graph
   * plane keys the recognition record by snapshot id and content hash — a record identity
   * distinct from those does not exist in the durable schema yet, so callers pass null
   * until it does. A snapshot id must never be copied into this field to make it look
   * populated. `graphSha256` is the stream's replay fingerprint over the recorded facts;
   * the pointer file, not this event, carries the parity anchor (`resultHash`).
   */
  public graphCommitted(info: {
    readonly recognitionRecordId: string | null;
    readonly graphSha256: string;
    readonly unitCount: number;
    readonly edgeCount: number;
    readonly unresolvedCount: number;
    /** The committed record's own durable identity, when the caller has it. */
    readonly resultHash?: string | null;
  }): NavigatorStreamReceipt {
    if (this.closed) return this.receipt();
    // Everything already written is flushed first, so the prefix hash covers exactly the
    // bytes preceding this line. A hash cannot include the event that carries it; the
    // prefix construction is what makes the stream verifiable from inside itself, and the
    // full-file hash in the receipt is what the seal checks against disk.
    this.flush();
    this.prefixSha256 = this.digest.copy().digest('hex');
    this.push('graph.committed', {
      projectName: this.options.projectName,
      status: 'RECOGNITION COMMITTED',
      ...info,
      // §14.5 binds run identity and the durable result hash into the seal. `graphSha256`
      // is the graph *record's* fingerprint (snapshot, result hash, counts) and is
      // deliberately not the stream's; `streamPrefixSha256` is the stream's own.
      runId: this.options.runId,
      // §14.5's "snapshot/capture identity" is one fact with two halves. The snapshot half
      // rides the envelope; the capture half is null until a caller supplies it, and the
      // scan.started bindings say so rather than leaving the field to be read as absent.
      captureId: this.options.captureId,
      ...(this.options.inventory === null
        ? {}
        : {
            repositoryId: this.options.inventory.repositoryId,
            inventorySnapshotId: this.options.inventory.snapshotId,
            inventoryHash: this.options.inventory.inventoryHash,
            taxonomyVersion: this.options.inventory.taxonomy.taxonomyVersion,
            taxonomyHash: this.options.inventory.taxonomy.taxonomyHash,
            inventoryCounts: this.options.inventory.counts,
          }),
      streamPrefixSha256: this.prefixSha256,
      streamEventCount: this.eventCount,
    });
    this.flush();
    this.sealed = !this.degraded;
    return this.close();
  }

  /**
   * Records a failure inside the observer itself, reported by the recognizer's isolation
   * seam. The error is redacted before it reaches the stream. Best-effort: if the write
   * also fails, the recognizer's own nested guard swallows it, because telemetry may never
   * change recognition behavior.
   */
  public onObserverError(event: { readonly operation: string; readonly error: unknown }): void {
    if (this.closed) return;
    this.push('observer.error', {
      operation: event.operation,
      message: redactError(event.error, this.options.env),
    });
    this.flush();
  }

  /** Records a scan-level failure and closes the stream. The error is redacted. */
  public fail(error: unknown): void {
    if (this.closed) return;
    this.push('scan.completed', {
      projectName: this.options.projectName,
      status: 'RECOGNITION FAILED',
      error: redactError(error, this.options.env),
    });
    this.flush();
    this.close();
  }

  public close(): NavigatorStreamReceipt {
    if (this.closed) return this.receipt();
    this.flush();
    if (this.descriptor !== null) {
      // The bytes must be on the device before anything reads them back to seal them;
      // a copy of a stream that is still only in the page cache is not durable evidence.
      try {
        fsyncSync(this.descriptor);
      } catch (error) {
        this.degrade(error);
      }
    }
    if (this.descriptor !== null) {
      try {
        closeSync(this.descriptor);
      } catch (error) {
        this.degrade(error);
      }
    }
    this.descriptor = null;
    this.closed = true;
    return this.receipt();
  }

  private push(type: NavigatorEventType, payload: Readonly<Record<string, unknown>>): void {
    if (this.closed) return;
    if (this.degraded) {
      // Count what the stream lost. A silent drop is the failure mode this item exists to
      // remove: the Q1 contract requires absence to stay visible rather than look complete.
      this.droppedEvents += 1;
      return;
    }
    const envelope: NavigatorEnvelope = {
      v: 1,
      type,
      streamId: this.options.streamId,
      runId: this.options.runId,
      sequence: this.sequence,
      emittedAt: new Date().toISOString(),
      snapshotId: this.options.snapshotId,
      payload:
        this.options.projectRecognition === null
          ? payload
          : {
              ...payload,
              projectRecognition: this.options.projectRecognition,
              projectId: this.options.projectRecognition.operationIdentity.projectId,
              targetRootIdentity:
                this.options.projectRecognition.operationIdentity.targetRootIdentity,
              projectProfileHash:
                this.options.projectRecognition.operationIdentity.projectProfileHash,
              profileGeneration: this.options.projectRecognition.profileGeneration,
              recognitionConfigHash: this.options.projectRecognition.recognitionConfigHash,
            },
    };
    this.sequence += 1;
    const serialized = `${JSON.stringify(envelope)}\n`;
    this.buffered.push(serialized);
    this.bufferedBytes += Buffer.byteLength(serialized, 'utf8');
  }

  private flushIfLarge(): void {
    if (this.bufferedBytes >= this.options.flushBytes) this.flush();
  }

  private flush(): void {
    if (this.buffered.length === 0) return;
    if (this.descriptor === null) {
      this.droppedEvents += this.buffered.length;
      this.buffered = [];
      this.bufferedBytes = 0;
      return;
    }
    const chunk = Buffer.from(this.buffered.join(''), 'utf8');
    try {
      // writeAllSync completes short writes. A single writeSync may write fewer bytes than
      // requested and returns the count; the previous code discarded it, so a short write
      // truncated the stream in the middle of a JSON line and nothing noticed.
      writeAllSync(this.descriptor, chunk);
    } catch (error) {
      this.degrade(error);
      return;
    }
    this.digest.update(chunk);
    this.bytesWritten += chunk.byteLength;
    this.eventCount += this.buffered.length;
    this.buffered = [];
    this.bufferedBytes = 0;
  }
}

/* ------------------------------------------------------------------------- */
/* Receipts, sealing, pointer, and retention (stream ownership lives here)     */
/* ------------------------------------------------------------------------- */

/** A durable stream operation refused rather than produced a record that could mislead. */
export class NavigatorStreamError extends Error {
  public override readonly name = 'NavigatorStreamError';
}

interface InventoryMember {
  readonly path: string;
  readonly fileVersionId: string;
  readonly excluded: boolean;
}

/**
 * What one recognition run's stream actually contains. `sha256` is over the bytes that
 * were durably written — not over what the writer was asked to write — so a degraded run
 * produces a truthful, shorter hash rather than an inflated claim.
 */
export interface NavigatorStreamReceipt {
  readonly path: string;
  readonly streamId: string;
  readonly runId: string;
  readonly snapshotId: string;
  /** The capture half of §14.5's identity pair; null when the caller supplied none. */
  readonly captureId: string | null;
  readonly eventCount: number;
  readonly bytesWritten: number;
  /** sha256 over every durably written byte. */
  readonly sha256: string;
  /** sha256 over everything preceding `graph.committed`, or null if never sealed. */
  readonly prefixSha256: string | null;
  /** True only when `graph.committed` was written and the writer never degraded. */
  readonly sealed: boolean;
  readonly degraded: boolean;
  readonly writeFailures: number;
  /** Events refused after degradation — the honest measure of what the stream lost. */
  readonly droppedEvents: number;
  /** Redacted single-line description of the last write failure. */
  readonly lastError: string | null;
  /** Observed physical membership, present only after the writer seals the committed run. */
  readonly physicalInventory?: PhysicalInventoryParity;
}

/** The result of preserving a live stream as its immutable per-run record. */
export interface SealedRunStream {
  readonly path: string;
  /** 'placed' when this call created the record; 'exists' when one was already there. */
  readonly outcome: 'placed' | 'exists';
  readonly sha256: string;
  readonly bytes: number;
}

/** Directory holding the immutable per-run streams, beside the live stream. */
export function runStreamDirectory(livePath: string): string {
  return join(dirname(livePath), 'streams');
}

/** The immutable per-run record path for one run. Never reused across runs. */
export function runStreamPath(livePath: string, runId: string): string {
  return join(runStreamDirectory(livePath), `${runId}.ndjson`);
}

/**
 * Preserves the live stream as `streams/<runId>.ndjson`, atomically and verifiably.
 *
 * Three properties the previous read-then-write copy did not have:
 *
 *   - **It proves what it sealed.** The bytes read back from the live stream must hash to
 *     the writer's own accumulated `sha256` and match its byte count. A truncated live
 *     stream, a concurrent writer, or a degraded run that under-reported is refused with
 *     {@link NavigatorStreamError} instead of being preserved as if it were complete.
 *   - **It is atomic.** The record is written to a temp file, fsynced, and hard-linked
 *     into place. A crash leaves either the temp file or the complete record, never a
 *     half-written one that reads as valid NDJSON up to its truncation point.
 *   - **It never replaces.** A per-run record is immutable; re-sealing the same run
 *     returns 'exists' and leaves the original untouched.
 */
export function sealRunStream(
  livePath: string,
  receipt: NavigatorStreamReceipt,
): SealedRunStream {
  const target = runStreamPath(livePath, receipt.runId);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });

  let bytes: Buffer;
  try {
    bytes = readFileSync(livePath);
  } catch (error) {
    throw new NavigatorStreamError(
      `live stream ${livePath} could not be read for sealing: ${String(error)}`,
    );
  }
  if (bytes.byteLength !== receipt.bytesWritten) {
    throw new NavigatorStreamError(
      `live stream ${livePath} holds ${bytes.byteLength} bytes but the writer wrote ` +
        `${receipt.bytesWritten}; refusing to seal a stream that changed underneath it`,
    );
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== receipt.sha256) {
    throw new NavigatorStreamError(
      `live stream ${livePath} hashes to ${actual} but the writer accumulated ` +
        `${receipt.sha256}; refusing to seal an unverifiable stream`,
    );
  }

  const temporary = join(directory, `.${receipt.runId}.ndjson.tmp`);
  const descriptor = openSync(temporary, 'w');
  try {
    writeAllSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const outcome = placeFileNoReplaceSync(temporary, target);
  if (outcome === 'exists' && !bytes.equals(readFileSync(target))) {
    throw new NavigatorStreamError('the immutable run stream already exists with different bytes');
  }
  return { path: target, outcome, sha256: actual, bytes: bytes.byteLength };
}

/* ------------------------------------------------------------------------- */
/* Current pointer                                                            */
/* ------------------------------------------------------------------------- */

const SHA256_HEX = /^[0-9a-f]{64}$/;

const physicalInventoryParitySchema = z.object({
  repositoryId: z.string().min(1),
  snapshotId: z.string().regex(SHA256_HEX),
  inventoryHash: z.string().regex(SHA256_HEX),
  expectedFileCount: z.number().int().nonnegative(),
  allFileCount: z.number().int().nonnegative(),
  identityConsistent: z.boolean(),
}).strict();

export type PhysicalInventoryParity = z.infer<typeof physicalInventoryParitySchema>;

/**
 * The pointer naming the run whose graph is durable, so a cold dashboard finds the
 * committed run without scanning the streams directory.
 *
 * The three claims the console's reader trusts — `runId`, `snapshotId`, `resultHash` — are
 * validated here before the file is written, because a pointer that fails validation on
 * read is treated as absent, and silently producing one is worse than failing loudly.
 * `streamSha256` and `streamBytes` let a reader verify the named stream before trusting it,
 * and `degraded` carries forward the fact that a run's telemetry was incomplete.
 */
export const graphPointerSchema = z
  .object({
    runId: z.string().min(1),
    snapshotId: z.string().min(1),
    resultHash: z.string().regex(SHA256_HEX),
    graphSha256: z.string().regex(SHA256_HEX),
    committedAt: z.string().min(1),
    stream: z.string().min(1).nullable(),
    streamSha256: z.string().regex(SHA256_HEX).nullable(),
    streamBytes: z.number().int().nonnegative().nullable(),
    streamEventCount: z.number().int().nonnegative().nullable(),
    degraded: z.boolean(),
    unitCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    unresolvedCount: z.number().int().nonnegative(),
    projectRecognition: projectRecognitionIdentitySchema.optional(),
    physicalInventory: physicalInventoryParitySchema.optional(),
  })
  .strict();

export type GraphPointer = z.infer<typeof graphPointerSchema>;

/** Read the commit-time comparison without replaying the archive on every Status request. */
export function readCommittedInventoryParity(livePath: string, pointer: GraphPointer, targetId: string): boolean | null {
  const proof = pointer.physicalInventory;
  if (proof === undefined || proof.repositoryId !== targetId || pointer.degraded ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(pointer.runId) || pointer.stream !== `streams/${pointer.runId}.ndjson` ||
      pointer.streamSha256 === null || pointer.streamBytes === null || pointer.streamBytes === 0 ||
      pointer.streamEventCount === null || pointer.streamEventCount === 0) return null;
  try {
    const archive = lstatSync(runStreamPath(livePath, pointer.runId));
    if (!archive.isFile() || archive.size !== pointer.streamBytes) return null;
  } catch {
    return null;
  }
  return proof.identityConsistent && proof.expectedFileCount === proof.allFileCount;
}

/** The pointer path beside a live stream. */
export function graphPointerPath(livePath: string): string {
  return join(dirname(livePath), 'current.json');
}

/**
 * Writes `current.json` atomically. Unlike the per-run record this file *is* mutable —
 * each commit supersedes the last — so it uses the replacing primitive. A reader therefore
 * sees the old pointer or the new one, never a partially rewritten one, which the previous
 * plain `writeFileSync` could produce and the reader would then discard as malformed.
 */
export function writeGraphPointer(livePath: string, pointer: GraphPointer): string {
  const parsed = graphPointerSchema.safeParse(pointer);
  if (!parsed.success) {
    throw new NavigatorStreamError(
      `refusing to write an invalid graph pointer: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );
  }
  const target = graphPointerPath(livePath);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, '.current.json.tmp');
  const bytes = Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
  const descriptor = openSync(temporary, 'w');
  try {
    writeAllSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  replaceFileSync(temporary, target);
  return target;
}

/**
 * Reads the pointer, or null when it is absent or does not satisfy the schema. Null is the
 * honest reading — an unparseable pointer must not be allowed to protect or attribute
 * anything.
 */
export function readGraphPointer(
  livePath: string,
  expectedProjectRecognition?: ProjectRecognitionIdentity,
): GraphPointer | null {
  try {
    const parsed = graphPointerSchema.safeParse(
      JSON.parse(readFileSync(graphPointerPath(livePath), 'utf8')),
    );
    if (!parsed.success) return null;
    if (expectedProjectRecognition === undefined) return parsed.data;
    if (
      parsed.data.projectRecognition === undefined ||
      !projectRecognitionIdentityEquals(parsed.data.projectRecognition, expectedProjectRecognition)
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Retention                                                                  */
/* ------------------------------------------------------------------------- */

export interface StreamRetentionPolicy {
  /** Newest sealed streams to keep. */
  readonly keep: number;
  /** Total byte budget for the streams directory; the oldest go first when exceeded. */
  readonly maxBytes?: number;
  /** Run ids that must survive regardless of age or budget. */
  readonly protect?: readonly string[];
}

export interface StreamRetentionReceipt {
  readonly directory: string;
  readonly scanned: number;
  readonly kept: readonly string[];
  readonly removed: readonly string[];
  readonly protectedRunIds: readonly string[];
  readonly bytesBefore: number;
  readonly bytesReclaimed: number;
  /** Files that could not be removed, with a redacted reason. */
  readonly failures: readonly string[];
}

/**
 * Applies bounded retention to the per-run streams directory (§22: sealed and live stream
 * files have bounded retention).
 *
 * Two protections make this safe to run unattended: the run named by `current.json` is
 * always retained, because deleting the stream the pointer names would leave the pointer
 * asserting a record that no longer exists; and only `*.ndjson` files are ever considered,
 * so an unrelated file dropped into the directory is left alone rather than deleted.
 *
 * Age is taken from mtime rather than from the run id, which carries no ordering.
 */
export function pruneRunStreams(
  livePath: string,
  policy: StreamRetentionPolicy,
): StreamRetentionReceipt {
  const directory = runStreamDirectory(livePath);
  const pointer = readGraphPointer(livePath);
  const protectedRunIds = [
    ...new Set([...(policy.protect ?? []), ...(pointer === null ? [] : [pointer.runId])]),
  ];

  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return {
      directory,
      scanned: 0,
      kept: [],
      removed: [],
      protectedRunIds,
      bytesBefore: 0,
      bytesReclaimed: 0,
      failures: [],
    };
  }

  const candidates: { path: string; runId: string; bytes: number; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ndjson')) continue;
    const path = join(directory, entry);
    let bytes = 0;
    let mtimeMs = 0;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      bytes = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ path, runId: basename(entry, '.ndjson'), bytes, mtimeMs });
  }
  // Newest first: retention keeps the head of this list.
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));

  const bytesBefore = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  const kept: string[] = [];
  const doomed: typeof candidates = [];
  let keptBytes = 0;
  let keptCount = 0;

  for (const candidate of candidates) {
    const isProtected = protectedRunIds.includes(candidate.runId);
    const withinCount = keptCount < policy.keep;
    const withinBytes =
      policy.maxBytes === undefined || keptBytes + candidate.bytes <= policy.maxBytes;
    if (isProtected || (withinCount && withinBytes)) {
      kept.push(candidate.path);
      keptBytes += candidate.bytes;
      if (!isProtected) keptCount += 1;
      continue;
    }
    doomed.push(candidate);
  }

  const removed: string[] = [];
  const failures: string[] = [];
  let bytesReclaimed = 0;
  for (const candidate of doomed) {
    try {
      rmSync(candidate.path, { force: true });
      removed.push(candidate.path);
      bytesReclaimed += candidate.bytes;
    } catch (error) {
      failures.push(`${candidate.path}: ${redactError(error, process.env)}`);
    }
  }
  if (removed.length > 0) {
    try {
      fsyncDir(directory);
    } catch {
      /* fsyncDir is already best-effort; a weaker ordering guarantee is not a failure */
    }
  }

  return {
    directory,
    scanned: candidates.length,
    kept,
    removed,
    protectedRunIds,
    bytesBefore,
    bytesReclaimed,
    failures,
  };
}
