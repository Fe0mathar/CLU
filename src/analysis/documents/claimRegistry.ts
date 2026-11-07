/**
 * CLUE claim registry.
 *
 * Spec: CLUE_Architecture_v9 (document bootstrap, claims and anchors); CLUE_Constitution_v9
 *       (conflicts are preserved, never merged); CLUE_Execution_Model_v9 (machine validation).
 * Backlog: DEV-P1-05 — content-derived identity instead of MAX(id)+1, legal status transitions,
 *          and conflict preconditions. Identity was minted by reading MAX(id) from the projection,
 *          so the id of a claim depended on how many rows happened to be in a table rather than on
 *          the claim itself: the same statement re-ingested, or ingested in another workspace, got a
 *          different id, and any finding that cited one was not portable. `promoteStatus` accepted
 *          every transition including demotion, and `resolveConflict` verified nothing at all.
 *          Content and location identity are now distinct — `content_id` is what is asserted,
 *          `id` is that assertion anchored in one document version — and domains and subjects are
 *          normalized into their own tables instead of living as JSON inside a column.
 *
 * Owns the three registries the Stage B gate names:
 *
 *   claims           every extracted statement, with its exact anchor and its status
 *   conflicts        contradictions, preserved as objects with both sides intact
 *   missing sources  documents that are cited but were never ingested
 *
 * The rule that shapes everything here is that **CLUE never resolves a contradiction by
 * choosing**. When two documents disagree, both claims survive, a conflict object
 * records that they disagree, and the disagreement becomes visible work rather than a
 * silent decision made by whichever document happened to be read second. The moment a
 * registry starts merging, its output stops being evidence and becomes an opinion with
 * a hash attached.
 *
 * Nothing is deleted, either. A document revision supersedes its old claims rather than
 * removing them, so a finding raised against last week's wording still resolves to the
 * text that actually justified it.
 *
 * Integration: this module owns its own projection tables. Call `ensureClaimSchema(db)`
 * immediately after constructing the ProjectionStore, and pass `CLAIM_PROJECTORS` into
 * its options, so a rebuild from the event log reconstructs these tables too. Every
 * projector is an upsert keyed by identifier, which is what makes replay idempotent.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';

import {
  SEQUENCE_WIDTH,
  canonicalJson,
  hashBytes,
  hashText,
  nowIso,
  requireSha256,
  type Sha256,
} from '../../shared/ids.js';
import { parseOrThrow } from '../../shared/schemas.js';
import type { Projector } from '../../memory/db.js';
import type { ArtifactStore } from '../../memory/artifactStore.js';
import type { EventLog } from '../../memory/eventLog.js';
import type { ProjectionStore } from '../../memory/db.js';
import { extractDocumentStructure, type DocumentStructure } from './markdownStructure.js';
import {
  extractClaims,
  normaliseSubject,
  type ClaimCandidate,
  type ClaimModality,
  type ClaimStatus,
  type ClaimExtractionOptions,
} from './claimExtractor.js';

type Db = Database.Database;

/* ------------------------------------------------------------------------- */
/* Event types                                                                */
/* ------------------------------------------------------------------------- */

export const CLAIM_EVENT_TYPES = {
  documentIngested: 'document.ingested',
  claimRegistered: 'claim.registered',
  claimSuperseded: 'claim.superseded',
  claimStatusChanged: 'claim.status_changed',
  conflictRegistered: 'conflict.registered',
  conflictResolved: 'conflict.resolved',
  sourceMissing: 'source.missing',
  sourceResolved: 'source.resolved',
} as const;

/* ------------------------------------------------------------------------- */
/* Record schemas                                                             */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const claimRecordSchema = z
  .object({
    id: z.string().regex(/^CLAIM-[0-9]{6,}$/),
    content_id: z.string().regex(/^CLAIMC-[0-9]{6,}$/),
    fingerprint: sha256,
    text_key: sha256,
    text: z.string().min(1),
    raw_text: z.string().min(1),
    document_path: z.string().min(1),
    document_hash: sha256,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    start_byte: z.number().int().nonnegative(),
    end_byte: z.number().int().nonnegative(),
    section_id: z.string().nullable(),
    section_path: z.array(z.string()),
    modality: z.enum([
      'prohibition',
      'requirement',
      'invariant',
      'recommendation',
      'definition',
      'plan',
      'description',
    ]),
    polarity: z.enum(['affirmative', 'negative']),
    status: z.enum(['declared', 'source-confirmed', 'runtime-observed', 'contradicted']),
    subjects: z.array(z.string()),
    subject_key: z.string().nullable(),
    domains: z.array(z.string()).min(1),
    measurable: z.boolean(),
    numbers: z.array(
      z.object({ value: z.number(), unit: z.string().nullable(), raw: z.string() }).strict(),
    ),
    strength: z.number().min(0).max(1),
    registered_at: isoTime,
    superseded_at: isoTime.nullable(),
  })
  .strict();

export type ClaimRecord = z.infer<typeof claimRecordSchema>;

export type ConflictKind = 'polarity' | 'numeric' | 'definition';
export type ConflictScope = 'intra-document' | 'cross-document';
export type ConflictSeverity = 'low' | 'medium' | 'high';

export const conflictRecordSchema = z
  .object({
    id: z.string().regex(/^CONFLICT-[0-9]{6,}$/),
    /** Derived from the participating claims, so re-detection never duplicates. */
    signature: sha256,
    kind: z.enum(['polarity', 'numeric', 'definition']),
    scope: z.enum(['intra-document', 'cross-document']),
    severity: z.enum(['low', 'medium', 'high']),
    subject_key: z.string(),
    claim_ids: z.array(z.string()).min(2),
    summary: z.string().min(1),
    detected_at: isoTime,
    resolution: z.enum(['unresolved', 'both-valid', 'superseded', 'misdetected']),
    rationale: z.string().nullable(),
  })
  .strict();

export type ConflictRecord = z.infer<typeof conflictRecordSchema>;

export const missingSourceSchema = z
  .object({
    target: z.string().min(1),
    first_seen_at: isoTime,
    citation_count: z.number().int().positive(),
    citations: z
      .array(z.object({ document_path: z.string(), line: z.number().int().positive() }).strict())
      .min(1),
    resolved: z.boolean(),
  })
  .strict();

export type MissingSource = z.infer<typeof missingSourceSchema>;

export const documentRecordSchema = z
  .object({
    hash: sha256,
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    line_count: z.number().int().nonnegative(),
    block_count: z.number().int().nonnegative(),
    claim_count: z.number().int().nonnegative(),
    has_crlf: z.boolean(),
    ingested_at: isoTime,
  })
  .strict();

export type DocumentRecord = z.infer<typeof documentRecordSchema>;

/* ------------------------------------------------------------------------- */
/* Schema                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * A claim's identity is a function of the claim (DEV-P1-05).
 *
 * Derived from the same pair the table's UNIQUE index already treats as the claim's identity:
 * its content fingerprint and the document version it was read from. So re-ingesting the same
 * bytes yields the same id, and a finding that cites a claim still resolves after a rebuild or in
 * another workspace. The previous `MAX(id) + 1` read the projection to number a record destined for
 * the log, which made identity depend on table contents rather than on the claim.
 */
export function claimIdFor(fingerprint: string, documentHash: string): string {
  return `CLAIM-${contentSequence(`${fingerprint}\u0000${documentHash}`)}`;
}

/**
 * The identity of what a claim asserts, independent of where it was found (DEV-P1-05).
 *
 * Derived from the normalized text key, **not** the fingerprint. The fingerprint is
 * `hash(documentPath + normalizedText)` — already a hybrid of content and location — and the
 * registry's natural key `(fingerprint, document_hash)` compounded that, so nothing in the schema
 * expressed "the same assertion" independently of where it was written. The text key is the pure
 * content half, which is what lets the registry answer "is this the same claim, restated elsewhere?"
 * without comparing prose.
 */
export function claimContentIdFor(textKey: string): string {
  return `CLAIMC-${contentSequence(textKey)}`;
}

/** A conflict's identity, derived from the signature the table already treats as unique. */
export function conflictIdFor(signature: string): string {
  return `CONFLICT-${contentSequence(signature)}`;
}

/**
 * A stable decimal sequence derived from content.
 *
 * The id stays a canonical CLUE entity id (`PREFIX-<digits>`), because the event log validates every
 * `subject_id` against that grammar — so identity becomes content-derived without widening a governed
 * schema. 52 bits of the content hash are used, which keeps the value inside the safe-integer range
 * and makes an accidental collision between two distinct claims vanishingly unlikely at corpus sizes
 * this registry will ever hold.
 */
function contentSequence(material: string): string {
  const digest = hashText(material);
  const value = Number.parseInt(digest.slice(0, 13), 16);
  return String(value).padStart(SEQUENCE_WIDTH, '0');
}

/**
 * Which status changes `promoteStatus` may make (DEV-P1-05).
 *
 * The ladder is evidence strength: a document asserting something makes it `declared` and nothing
 * more; only source inspection or a runtime observation moves it further. Demotion is absent on
 * purpose — moving a runtime-observed claim back to `declared` would discard the observation that
 * justified it. `contradicted` is terminal here because a contradicted claim's standing is governed
 * by the conflict object, and changing it is a resolution decision rather than a promotion.
 */
export const LEGAL_CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  declared: ['source-confirmed', 'runtime-observed', 'contradicted'],
  'source-confirmed': ['runtime-observed', 'contradicted'],
  'runtime-observed': ['contradicted'],
  contradicted: [],
};

export function isLegalClaimTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return LEGAL_CLAIM_TRANSITIONS[from].includes(to);
}

/** An illegal claim status transition was attempted. */
export class ClaimTransitionError extends Error {
  public readonly claimId: string;
  public readonly from: ClaimStatus;
  public readonly to: ClaimStatus;

  public constructor(claimId: string, from: ClaimStatus, to: ClaimStatus, reason: string) {
    super(`Claim ${claimId} cannot move from ${from} to ${to}: ${reason}`);
    this.name = 'ClaimTransitionError';
    this.claimId = claimId;
    this.from = from;
    this.to = to;
  }
}

/** A conflict resolution was attempted without its preconditions holding. */
export class ConflictPreconditionError extends Error {
  public readonly conflictId: string;

  public constructor(conflictId: string, reason: string) {
    super(`Conflict ${conflictId} cannot be resolved: ${reason}`);
    this.name = 'ConflictPreconditionError';
    this.conflictId = conflictId;
  }
}

export const CLAIM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  hash        TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  line_count  INTEGER NOT NULL,
  block_count INTEGER NOT NULL,
  claim_count INTEGER NOT NULL,
  has_crlf    INTEGER NOT NULL,
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_path ON documents(path);

CREATE TABLE IF NOT EXISTS claims (
  id             TEXT PRIMARY KEY,
  -- DEV-P1-05: what is asserted, independent of where. Two documents making the same statement
  -- share a content_id while keeping distinct ids, because they are two occurrences of one claim.
  -- Location lives in the document_/start_/end_/section_ columns below and never enters content_id.
  content_id     TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  text_key       TEXT NOT NULL,
  text           TEXT NOT NULL,
  raw_text       TEXT NOT NULL,
  document_path  TEXT NOT NULL,
  document_hash  TEXT NOT NULL,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  start_byte     INTEGER NOT NULL,
  end_byte       INTEGER NOT NULL,
  section_id     TEXT,
  section_path   TEXT NOT NULL,
  modality       TEXT NOT NULL,
  polarity       TEXT NOT NULL,
  status         TEXT NOT NULL,
  subjects       TEXT NOT NULL,
  subject_key    TEXT,
  domains        TEXT NOT NULL,
  measurable     INTEGER NOT NULL,
  numbers        TEXT NOT NULL,
  strength       REAL NOT NULL,
  registered_at  TEXT NOT NULL,
  superseded_at  TEXT
);
CREATE INDEX IF NOT EXISTS claims_subject     ON claims(subject_key);
CREATE INDEX IF NOT EXISTS claims_document    ON claims(document_hash);
CREATE INDEX IF NOT EXISTS claims_modality    ON claims(modality);
CREATE INDEX IF NOT EXISTS claims_status      ON claims(status);
CREATE INDEX IF NOT EXISTS claims_text_key    ON claims(text_key);
CREATE UNIQUE INDEX IF NOT EXISTS claims_fingerprint ON claims(fingerprint, document_hash);
CREATE INDEX IF NOT EXISTS claims_content ON claims(content_id);

-- DEV-P1-05: domains and subjects were JSON blobs inside a claims column, so "which claims touch
-- performance" meant reading every row and parsing it. Normalized, that is an indexed join, and a
-- malformed entry fails at write time rather than at every read.
CREATE TABLE IF NOT EXISTS claim_domains (
  claim_id TEXT NOT NULL,
  domain   TEXT NOT NULL,
  PRIMARY KEY (claim_id, domain)
);
CREATE INDEX IF NOT EXISTS claim_domains_domain ON claim_domains(domain);

CREATE TABLE IF NOT EXISTS claim_subjects (
  claim_id TEXT NOT NULL,
  subject  TEXT NOT NULL,
  PRIMARY KEY (claim_id, subject)
);
CREATE INDEX IF NOT EXISTS claim_subjects_subject ON claim_subjects(subject);

CREATE TABLE IF NOT EXISTS conflicts (
  id          TEXT PRIMARY KEY,
  signature   TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  scope       TEXT NOT NULL,
  severity    TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  claim_ids   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolution  TEXT NOT NULL,
  rationale   TEXT
);
CREATE INDEX IF NOT EXISTS conflicts_resolution ON conflicts(resolution);
CREATE INDEX IF NOT EXISTS conflicts_severity   ON conflicts(severity);

CREATE TABLE IF NOT EXISTS missing_sources (
  target         TEXT PRIMARY KEY,
  first_seen_at  TEXT NOT NULL,
  citation_count INTEGER NOT NULL,
  citations      TEXT NOT NULL,
  resolved       INTEGER NOT NULL
);
`;

/** Run once, immediately after constructing the ProjectionStore. */
export function ensureClaimSchema(db: Db): void {
  db.exec(CLAIM_SCHEMA_SQL);
}

/* ------------------------------------------------------------------------- */
/* Projectors                                                                 */
/* ------------------------------------------------------------------------- */
/* Every one is an upsert keyed by identifier. Replaying the log therefore reproduces
 * exactly the same rows rather than accumulating duplicates, which is what allows the
 * database to be deleted and rebuilt at any time. */

export const CLAIM_PROJECTORS: Readonly<Record<string, Projector>> = {
  [CLAIM_EVENT_TYPES.documentIngested]: (db, record) => {
    const document = parseOrThrow(documentRecordSchema, record.payload, 'document.ingested');
    db.prepare(
      `INSERT INTO documents (hash, path, bytes, line_count, block_count, claim_count, has_crlf, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET
         path = excluded.path, bytes = excluded.bytes, line_count = excluded.line_count,
         block_count = excluded.block_count, claim_count = excluded.claim_count,
         has_crlf = excluded.has_crlf, ingested_at = excluded.ingested_at`,
    ).run(
      document.hash,
      document.path,
      document.bytes,
      document.line_count,
      document.block_count,
      document.claim_count,
      document.has_crlf ? 1 : 0,
      document.ingested_at,
    );
  },

  [CLAIM_EVENT_TYPES.claimRegistered]: (db, record) => {
    const claim = parseOrThrow(claimRecordSchema, record.payload, 'claim.registered');
    db.prepare(
      `INSERT INTO claims (
         id, content_id, fingerprint, text_key, text, raw_text, document_path, document_hash,
         start_line, end_line, start_byte, end_byte, section_id, section_path,
         modality, polarity, status, subjects, subject_key, domains, measurable,
         numbers, strength, registered_at, superseded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status, superseded_at = excluded.superseded_at`,
    ).run(
      claim.id,
      claim.content_id,
      claim.fingerprint,
      claim.text_key,
      claim.text,
      claim.raw_text,
      claim.document_path,
      claim.document_hash,
      claim.start_line,
      claim.end_line,
      claim.start_byte,
      claim.end_byte,
      claim.section_id,
      canonicalJson(claim.section_path),
      claim.modality,
      claim.polarity,
      claim.status,
      canonicalJson(claim.subjects),
      claim.subject_key,
      canonicalJson(claim.domains),
      claim.measurable ? 1 : 0,
      canonicalJson(claim.numbers),
      claim.strength,
      claim.registered_at,
      claim.superseded_at,
    );

    // DEV-P1-05: normalized projections of the same facts. Replaced wholesale rather than merged,
    // so a claim that loses a domain on re-registration does not keep it here — the JSON column and
    // these tables must never be able to disagree about the same claim.
    db.prepare('DELETE FROM claim_domains WHERE claim_id = ?').run(claim.id);
    const insertDomain = db.prepare(
      'INSERT INTO claim_domains (claim_id, domain) VALUES (?, ?) ON CONFLICT DO NOTHING',
    );
    for (const domain of claim.domains) insertDomain.run(claim.id, domain);

    db.prepare('DELETE FROM claim_subjects WHERE claim_id = ?').run(claim.id);
    const insertSubject = db.prepare(
      'INSERT INTO claim_subjects (claim_id, subject) VALUES (?, ?) ON CONFLICT DO NOTHING',
    );
    for (const subject of claim.subjects) insertSubject.run(claim.id, subject);
  },

  [CLAIM_EVENT_TYPES.claimSuperseded]: (db, record) => {
    const payload = readObject(record.payload, 'claim.superseded');
    db.prepare('UPDATE claims SET superseded_at = ? WHERE id = ?').run(
      readString(payload, 'superseded_at'),
      readString(payload, 'claim_id'),
    );
  },

  [CLAIM_EVENT_TYPES.claimStatusChanged]: (db, record) => {
    const payload = readObject(record.payload, 'claim.status_changed');
    db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(
      readString(payload, 'to'),
      readString(payload, 'claim_id'),
    );
  },

  [CLAIM_EVENT_TYPES.conflictRegistered]: (db, record) => {
    const conflict = parseOrThrow(conflictRecordSchema, record.payload, 'conflict.registered');
    db.prepare(
      `INSERT INTO conflicts
         (id, signature, kind, scope, severity, subject_key, claim_ids, summary,
          detected_at, resolution, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signature) DO UPDATE SET
         resolution = excluded.resolution, rationale = excluded.rationale`,
    ).run(
      conflict.id,
      conflict.signature,
      conflict.kind,
      conflict.scope,
      conflict.severity,
      conflict.subject_key,
      canonicalJson(conflict.claim_ids),
      conflict.summary,
      conflict.detected_at,
      conflict.resolution,
      conflict.rationale,
    );
  },

  [CLAIM_EVENT_TYPES.conflictResolved]: (db, record) => {
    const payload = readObject(record.payload, 'conflict.resolved');
    db.prepare('UPDATE conflicts SET resolution = ?, rationale = ? WHERE id = ?').run(
      readString(payload, 'resolution'),
      readString(payload, 'rationale'),
      readString(payload, 'conflict_id'),
    );
  },

  [CLAIM_EVENT_TYPES.sourceMissing]: (db, record) => {
    const source = parseOrThrow(missingSourceSchema, record.payload, 'source.missing');
    db.prepare(
      `INSERT INTO missing_sources (target, first_seen_at, citation_count, citations, resolved)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(target) DO UPDATE SET
         citation_count = excluded.citation_count,
         citations = excluded.citations,
         resolved = excluded.resolved`,
    ).run(
      source.target,
      source.first_seen_at,
      source.citation_count,
      canonicalJson(source.citations),
      source.resolved ? 1 : 0,
    );
  },

  [CLAIM_EVENT_TYPES.sourceResolved]: (db, record) => {
    const payload = readObject(record.payload, 'source.resolved');
    db.prepare('UPDATE missing_sources SET resolved = 1 WHERE target = ?').run(
      readString(payload, 'target'),
    );
  },
};

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */

export interface ClaimRegistryDeps {
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly artifacts: ArtifactStore;
  /** Supplies the mission version stamped on every event. */
  readonly missionVersion: () => string;
  readonly extraction?: ClaimExtractionOptions;
}

export interface IngestResult {
  readonly document: DocumentRecord;
  readonly structure: DocumentStructure;
  readonly registered: readonly ClaimRecord[];
  readonly superseded: readonly string[];
  /** True when this exact document content was already ingested. */
  readonly unchanged: boolean;
}

export interface ClaimFilter {
  readonly documentHash?: string;
  readonly documentPath?: string;
  readonly modality?: ClaimModality;
  readonly status?: ClaimStatus;
  readonly domain?: string;
  readonly subjectKey?: string;
  readonly minimumStrength?: number;
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

export class ClaimRegistry {
  private readonly log: EventLog;
  private readonly projections: ProjectionStore;
  private readonly artifacts: ArtifactStore;
  private readonly missionVersion: () => string;
  private readonly extraction: ClaimExtractionOptions;

  public constructor(deps: ClaimRegistryDeps) {
    this.log = deps.log;
    this.projections = deps.projections;
    this.artifacts = deps.artifacts;
    this.missionVersion = deps.missionVersion;
    this.extraction = deps.extraction ?? {};
    ensureClaimSchema(this.projections.db);
  }

  /* ------------------------------ ingestion --------------------------- */

  /**
   * Ingests one document: stores its bytes, parses it, extracts claims, and supersedes
   * the claims of any previous version of the same path.
   *
   * Re-ingesting identical content is a no-op that reports `unchanged`. That makes it
   * safe to run over the whole document set on every daemon start, which is the only
   * way a document edited outside CLUE gets noticed promptly.
   */
  public ingestDocument(path: string, bytes: Uint8Array): IngestResult {
    const hash = hashBytes(bytes);
    const timestamp = nowIso();
    const existing = this.getDocument(hash);

    const structure = extractDocumentStructure({ path, hash, bytes });
    if (existing !== null && existing.path === path) {
      return {
        document: existing,
        structure,
        registered: this.claims({ documentHash: hash }),
        superseded: [],
        unchanged: true,
      };
    }

    // Store the exact bytes before announcing anything, so every claim's anchor can be
    // re-resolved against the text it was extracted from, forever.
    this.artifacts.putBytes(bytes, { mediaType: 'text/markdown; charset=utf-8', label: path });

    const candidates = extractClaims(structure, this.extraction);
    const superseded = this.supersedePreviousVersions(path, hash, timestamp);

    const document: DocumentRecord = parseOrThrow(
      documentRecordSchema,
      {
        hash,
        path,
        bytes: bytes.byteLength,
        line_count: structure.lineCount,
        block_count: structure.blocks.length,
        claim_count: candidates.length,
        has_crlf: structure.hasCrlf,
        ingested_at: timestamp,
      },
      `document ${path}`,
    );

    this.append(CLAIM_EVENT_TYPES.documentIngested, document, null);

    const registered: ClaimRecord[] = [];

    for (const candidate of candidates) {
      const claim = toClaimRecord(candidate, claimIdFor(candidate.fingerprint, document.hash), timestamp);
      this.append(CLAIM_EVENT_TYPES.claimRegistered, claim, claim.id);
      registered.push(claim);
    }

    this.projections.sync(this.log);
    return { document, structure, registered, superseded, unchanged: false };
  }

  /**
   * Marks the claims of earlier versions of a path as superseded.
   *
   * Superseded, never deleted: a finding raised last week against wording that has
   * since changed must still resolve to the text that justified it, or the finding
   * becomes unauditable.
   */
  private supersedePreviousVersions(path: string, keepHash: Sha256, timestamp: string): string[] {
    const rows = this.projections.db
      .prepare(
        `SELECT id FROM claims
          WHERE document_path = ? AND document_hash != ? AND superseded_at IS NULL`,
      )
      .all(path, keepHash);

    const ids = rows.map((row) => readString(readObject(row, 'claims row'), 'id'));
    for (const id of ids) {
      this.append(
        CLAIM_EVENT_TYPES.claimSuperseded,
        { claim_id: id, superseded_at: timestamp, reason: 'document revised' },
        id,
      );
    }
    return ids;
  }

  /* ------------------------------ conflicts --------------------------- */

  /**
   * Detects contradictions among the currently active claims.
   *
   * Deliberately biased toward reporting. A false positive costs one review; a false
   * negative means CLUE proceeds as though the corpus agreed with itself when it did
   * not — and every finding built on top of that inherits the mistake silently.
   *
   * Detection is structural, not semantic. Two claims must share a subject and a
   * substantially overlapping predicate before they can conflict, which keeps unrelated
   * statements about the same subsystem from being paired.
   */
  public detectConflicts(): ConflictRecord[] {
    const active = this.claims({ includeSuperseded: false });
    const grouped = new Map<string, ClaimRecord[]>();

    for (const claim of active) {
      if (claim.subject_key === null) continue;
      const bucket = grouped.get(claim.subject_key);
      if (bucket === undefined) grouped.set(claim.subject_key, [claim]);
      else bucket.push(claim);
    }

    const timestamp = nowIso();
    const found: ConflictRecord[] = [];
    for (const [subjectKey, claims] of grouped) {
      for (let i = 0; i < claims.length; i += 1) {
        for (let j = i + 1; j < claims.length; j += 1) {
          const left = claims[i];
          const right = claims[j];
          if (left === undefined || right === undefined) continue;

          // Identical statements are corroboration, not contradiction.
          if (left.text_key === right.text_key) continue;

          const overlap = predicateOverlap(left, right);
          if (overlap < PREDICATE_OVERLAP_THRESHOLD) continue;

          const kind = classifyConflict(left, right);
          if (kind === null) continue;

          const signature = conflictSignature(kind, left.fingerprint, right.fingerprint);
          if (this.conflictExists(signature)) continue;

          const conflict = parseOrThrow(
            conflictRecordSchema,
            {
              id: conflictIdFor(signature),
              signature,
              kind,
              scope:
                left.document_path === right.document_path ? 'intra-document' : 'cross-document',
              severity: severityOf(left, right),
              subject_key: subjectKey,
              claim_ids: [left.id, right.id],
              summary: summarise(kind, left, right),
              detected_at: timestamp,
              resolution: 'unresolved',
              rationale: null,
            },
            'conflict record',
          );

          this.append(CLAIM_EVENT_TYPES.conflictRegistered, conflict, conflict.id);
          found.push(conflict);
        }
      }
    }

    if (found.length > 0) this.projections.sync(this.log);
    return found;
  }

  /**
   * Records an adjudication.
   *
   * The conflict object itself is never removed, and neither claim is edited. Even
   * `misdetected` leaves the pair on the record, because a detector that quietly forgets
   * its false positives cannot be tuned against them later.
   */
  public resolveConflict(
    conflictId: string,
    resolution: 'both-valid' | 'superseded' | 'misdetected',
    rationale: string,
  ): void {
    // DEV-P1-05: preconditions. This wrote the event unconditionally, so a typo in the id recorded a
    // resolution for a conflict that does not exist, and a second call silently overwrote a decision
    // someone had already reasoned about. A conflict is preserved evidence; closing one is a
    // deliberate act that must name a real, still-open conflict and say why.
    const existing = this.getConflict(conflictId);
    if (existing === null) {
      throw new ConflictPreconditionError(conflictId, `unknown conflict ${conflictId}`);
    }
    if (existing.resolution !== 'unresolved') {
      throw new ConflictPreconditionError(
        conflictId,
        `already resolved as ${existing.resolution}; reopening is a new decision, not a resolution`,
      );
    }
    if (rationale.trim() === '') {
      throw new ConflictPreconditionError(conflictId, 'a resolution must record why');
    }

    this.append(
      CLAIM_EVENT_TYPES.conflictResolved,
      { conflict_id: conflictId, resolution, rationale },
      conflictId,
    );
    this.projections.sync(this.log);
  }

  /* --------------------------- missing sources ------------------------ */

  /**
   * Registers every cited document that has not been ingested.
   *
   * The gate this serves is "missing referenced documents are visible". A cited
   * document that nobody can read is a hole in the corpus, and the correct response is
   * to show the hole — never to infer what it probably contained.
   */
  public refreshMissingSources(structures: readonly DocumentStructure[]): MissingSource[] {
    const known = new Set<string>();
    for (const structure of structures) {
      known.add(normaliseTarget(structure.path));
      known.add(normaliseTarget(basename(structure.path)));
    }
    for (const row of this.projections.db.prepare('SELECT path FROM documents').all()) {
      const path = readString(readObject(row, 'documents row'), 'path');
      known.add(normaliseTarget(path));
      known.add(normaliseTarget(basename(path)));
    }

    const citations = new Map<string, { document_path: string; line: number }[]>();
    for (const structure of structures) {
      for (const reference of structure.references) {
        const target = normaliseTarget(reference.target);
        if (target.length === 0 || known.has(target) || known.has(normaliseTarget(basename(reference.target)))) {
          continue;
        }
        const list = citations.get(reference.target);
        const entry = { document_path: structure.path, line: reference.anchor.startLine };
        if (list === undefined) citations.set(reference.target, [entry]);
        else list.push(entry);
      }
    }

    const timestamp = nowIso();
    const registered: MissingSource[] = [];

    for (const [target, list] of citations) {
      const record = parseOrThrow(
        missingSourceSchema,
        {
          target,
          first_seen_at: this.missingSourceFirstSeen(target) ?? timestamp,
          citation_count: list.length,
          citations: list,
          resolved: false,
        },
        `missing source ${target}`,
      );
      this.append(CLAIM_EVENT_TYPES.sourceMissing, record, null);
      registered.push(record);
    }

    // A target that has since been ingested stops being missing, but its record stays.
    for (const row of this.projections.db
      .prepare('SELECT target FROM missing_sources WHERE resolved = 0')
      .all()) {
      const target = readString(readObject(row, 'missing_sources row'), 'target');
      if (known.has(normaliseTarget(target)) || known.has(normaliseTarget(basename(target)))) {
        this.append(CLAIM_EVENT_TYPES.sourceResolved, { target }, null);
      }
    }

    this.projections.sync(this.log);
    return registered;
  }

  /* -------------------------------- status ---------------------------- */

  /**
   * Promotes a claim's status.
   *
   * Promotion is an explicit, evidenced act. A document says a thing; that makes it
   * `declared` and nothing more. Only source inspection or a runtime observation may
   * move it further, and the evidence reference is required so the promotion can be
   * re-examined rather than trusted.
   */
  public promoteStatus(claimId: string, to: ClaimStatus, evidenceRef: string): void {
    const claim = this.getClaim(claimId);
    if (claim === null) throw new Error(`Unknown claim ${claimId}`);
    if (claim.status === to) return;

    // DEV-P1-05: the transition must be legal. Without this the method named `promoteStatus`
    // silently accepted demotion — a runtime-observed claim could be pushed back to `declared`,
    // discarding the observation that justified it, and leaving no record that anything was lost.
    if (evidenceRef.trim() === '') {
      throw new ClaimTransitionError(
        claimId,
        claim.status,
        to,
        'a promotion must cite the evidence that justifies it',
      );
    }
    if (claim.superseded_at !== null) {
      throw new ClaimTransitionError(
        claimId,
        claim.status,
        to,
        'the claim is superseded; its wording no longer exists to be confirmed',
      );
    }
    if (!isLegalClaimTransition(claim.status, to)) {
      throw new ClaimTransitionError(
        claimId,
        claim.status,
        to,
        LEGAL_CLAIM_TRANSITIONS[claim.status].length === 0
          ? 'the status is terminal for promotion; resolve the conflict instead'
          : `legal transitions are ${LEGAL_CLAIM_TRANSITIONS[claim.status].join(', ')}`,
      );
    }

    this.append(
      CLAIM_EVENT_TYPES.claimStatusChanged,
      { claim_id: claimId, from: claim.status, to, evidence: evidenceRef },
      claimId,
    );
    this.projections.sync(this.log);
  }

  /* ------------------------------- queries ---------------------------- */

  public claims(filter: ClaimFilter = {}): ClaimRecord[] {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (filter.includeSuperseded !== true) conditions.push('superseded_at IS NULL');
    if (filter.documentHash !== undefined) {
      conditions.push('document_hash = ?');
      parameters.push(filter.documentHash);
    }
    if (filter.documentPath !== undefined) {
      conditions.push('document_path = ?');
      parameters.push(filter.documentPath);
    }
    if (filter.modality !== undefined) {
      conditions.push('modality = ?');
      parameters.push(filter.modality);
    }
    if (filter.status !== undefined) {
      conditions.push('status = ?');
      parameters.push(filter.status);
    }
    if (filter.subjectKey !== undefined) {
      conditions.push('subject_key = ?');
      parameters.push(normaliseSubject(filter.subjectKey));
    }
    if (filter.minimumStrength !== undefined) {
      conditions.push('strength >= ?');
      parameters.push(filter.minimumStrength);
    }
    if (filter.domain !== undefined) {
      conditions.push("domains LIKE ?");
      parameters.push(`%"${filter.domain}"%`);
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const limit = filter.limit === undefined ? '' : `LIMIT ${Math.max(1, filter.limit)}`;

    return this.projections.db
      .prepare(`SELECT * FROM claims ${where} ORDER BY id ${limit}`)
      .all(...parameters)
      .map(readClaimRow);
  }

  public getClaim(claimId: string): ClaimRecord | null {
    const row = this.projections.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    return row === undefined ? null : readClaimRow(row);
  }

  public conflicts(onlyUnresolved = true): ConflictRecord[] {
    const where = onlyUnresolved ? "WHERE resolution = 'unresolved'" : '';
    return this.projections.db
      .prepare(`SELECT * FROM conflicts ${where} ORDER BY severity DESC, id`)
      .all()
      .map(readConflictRow);
  }

  public missingSources(onlyUnresolved = true): MissingSource[] {
    const where = onlyUnresolved ? 'WHERE resolved = 0' : '';
    return this.projections.db
      .prepare(`SELECT * FROM missing_sources ${where} ORDER BY citation_count DESC, target`)
      .all()
      .map(readMissingSourceRow);
  }

  public getDocument(hash: string): DocumentRecord | null {
    const row = this.projections.db.prepare('SELECT * FROM documents WHERE hash = ?').get(hash);
    return row === undefined ? null : readDocumentRow(row);
  }

  /* ------------------------------ internals --------------------------- */

  private append(type: string, payload: unknown, subjectId: string | null): void {
    this.log.append({
      type,
      actor: 'daemon',
      missionVersion: this.missionVersion(),
      subjectId,
      payload,
    });
  }

  /**
   * Every occurrence of one assertion, wherever it appears (DEV-P1-05).
   *
   * Content identity is what makes "these two documents say the same thing" answerable without
   * comparing prose, and it is deliberately independent of location: a restatement in another file,
   * or the same sentence surviving a revision, resolves to the same content id.
   */
  public claimsByContent(contentId: string): ClaimRecord[] {
    return this.projections.db
      .prepare('SELECT * FROM claims WHERE content_id = ? ORDER BY document_path, start_line')
      .all(contentId)
      .map(readClaimRow);
  }

  /** Claim ids in a domain, answered by an indexed join rather than by parsing every JSON column. */
  public claimIdsInDomain(domain: string): string[] {
    return this.projections.db
      .prepare('SELECT claim_id FROM claim_domains WHERE domain = ? ORDER BY claim_id')
      .all(domain)
      .map((row) => readString(readObject(row, 'claim_domains row'), 'claim_id'));
  }

  /** Claim ids mentioning a subject, from the normalized table. */
  public claimIdsAboutSubject(subject: string): string[] {
    return this.projections.db
      .prepare('SELECT claim_id FROM claim_subjects WHERE subject = ? ORDER BY claim_id')
      .all(subject)
      .map((row) => readString(readObject(row, 'claim_subjects row'), 'claim_id'));
  }

  /** One conflict by id, or null. Needed by `resolveConflict` to check its preconditions. */
  public getConflict(conflictId: string): ConflictRecord | null {
    const row = this.projections.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(conflictId);
    return row === undefined ? null : readConflictRow(row);
  }

  private conflictExists(signature: string): boolean {
    return (
      this.projections.db.prepare('SELECT 1 FROM conflicts WHERE signature = ?').get(signature) !==
      undefined
    );
  }

  private missingSourceFirstSeen(target: string): string | null {
    const row = this.projections.db
      .prepare('SELECT first_seen_at FROM missing_sources WHERE target = ?')
      .get(target);
    if (typeof row !== 'object' || row === null) return null;
    const value = (row as Record<string, unknown>)['first_seen_at'];
    return typeof value === 'string' ? value : null;
  }
}

/* ------------------------------------------------------------------------- */
/* Conflict analysis                                                          */
/* ------------------------------------------------------------------------- */

const PREDICATE_OVERLAP_THRESHOLD = 0.34;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'for', 'from',
  'has', 'have', 'in', 'into', 'is', 'it', 'its', 'may', 'must', 'never', 'no', 'not',
  'of', 'on', 'or', 'should', 'that', 'the', 'their', 'then', 'this', 'to', 'was', 'were',
  'which', 'while', 'will', 'with', 'would',
]);

/** Jaccard similarity of content words. Cheap, deterministic, and explainable. */
function predicateOverlap(left: ClaimRecord, right: ClaimRecord): number {
  const a = contentWords(left.text);
  const b = contentWords(right.text);
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of text.split(/[^a-z0-9_.]+/i)) {
    const word = token.toLowerCase();
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    words.add(word);
  }
  return words;
}

const NORMATIVE: ReadonlySet<ClaimModality> = new Set<ClaimModality>([
  'prohibition',
  'requirement',
  'invariant',
]);

function classifyConflict(left: ClaimRecord, right: ClaimRecord): ConflictKind | null {
  if (left.polarity !== right.polarity && (NORMATIVE.has(left.modality) || NORMATIVE.has(right.modality))) {
    return 'polarity';
  }

  if (left.modality === 'definition' && right.modality === 'definition') return 'definition';

  for (const a of left.numbers) {
    for (const b of right.numbers) {
      if (a.unit === b.unit && a.value !== b.value) return 'numeric';
    }
  }

  return null;
}

function severityOf(left: ClaimRecord, right: ClaimRecord): ConflictSeverity {
  const normativeSides = Number(NORMATIVE.has(left.modality)) + Number(NORMATIVE.has(right.modality));
  if (normativeSides === 2) return 'high';
  if (normativeSides === 1) return 'medium';
  return 'low';
}

function summarise(kind: ConflictKind, left: ClaimRecord, right: ClaimRecord): string {
  const where = `${left.document_path}:${left.start_line} vs ${right.document_path}:${right.start_line}`;
  switch (kind) {
    case 'polarity':
      return `Opposing ${left.modality}/${right.modality} statements about "${left.subject_key ?? ''}" (${where})`;
    case 'numeric':
      return `Different values stated for "${left.subject_key ?? ''}" (${where})`;
    default:
      return `Competing definitions of "${left.subject_key ?? ''}" (${where})`;
  }
}

/** Order-independent, so the same pair always yields the same signature. */
function conflictSignature(kind: ConflictKind, a: string, b: string): Sha256 {
  const [first, second] = a < b ? [a, b] : [b, a];
  return hashText(`${kind}\0${first}\0${second}`);
}

/* ------------------------------------------------------------------------- */
/* Conversion and row reading                                                 */
/* ------------------------------------------------------------------------- */

function toClaimRecord(candidate: ClaimCandidate, id: string, timestamp: string): ClaimRecord {
  return parseOrThrow(
    claimRecordSchema,
    {
      id,
      content_id: claimContentIdFor(candidate.textKey),
      fingerprint: candidate.fingerprint,
      text_key: candidate.textKey,
      text: candidate.text,
      raw_text: candidate.rawText,
      document_path: candidate.anchor.documentPath,
      document_hash: candidate.anchor.documentHash,
      start_line: candidate.anchor.startLine,
      end_line: candidate.anchor.endLine,
      start_byte: candidate.anchor.startByte,
      end_byte: candidate.anchor.endByte,
      section_id: candidate.sectionId,
      section_path: [...candidate.sectionTitlePath],
      modality: candidate.modality,
      polarity: candidate.polarity,
      status: candidate.status,
      subjects: [...candidate.subjects],
      subject_key: candidate.subjectKey,
      domains: [...candidate.domains],
      measurable: candidate.measurable,
      numbers: candidate.numbers.map((number) => ({ ...number })),
      strength: candidate.strength,
      registered_at: timestamp,
      superseded_at: null,
    },
    `claim ${id}`,
  );
}

function readClaimRow(row: unknown): ClaimRecord {
  const record = readObject(row, 'claims row');
  return parseOrThrow(
    claimRecordSchema,
    {
      ...record,
      section_path: JSON.parse(readString(record, 'section_path')) as unknown,
      subjects: JSON.parse(readString(record, 'subjects')) as unknown,
      domains: JSON.parse(readString(record, 'domains')) as unknown,
      numbers: JSON.parse(readString(record, 'numbers')) as unknown,
      measurable: readNumber(record, 'measurable') === 1,
    },
    'claims row',
  );
}

function readConflictRow(row: unknown): ConflictRecord {
  const record = readObject(row, 'conflicts row');
  return parseOrThrow(
    conflictRecordSchema,
    { ...record, claim_ids: JSON.parse(readString(record, 'claim_ids')) as unknown },
    'conflicts row',
  );
}

function readMissingSourceRow(row: unknown): MissingSource {
  const record = readObject(row, 'missing_sources row');
  return parseOrThrow(
    missingSourceSchema,
    {
      ...record,
      citations: JSON.parse(readString(record, 'citations')) as unknown,
      resolved: readNumber(record, 'resolved') === 1,
    },
    'missing_sources row',
  );
}

function readDocumentRow(row: unknown): DocumentRecord {
  const record = readObject(row, 'documents row');
  return parseOrThrow(
    documentRecordSchema,
    { ...record, has_crlf: readNumber(record, 'has_crlf') === 1 },
    'documents row',
  );
}

function readObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected an object for ${context}`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Expected string field "${field}"`);
  return value;
}

function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number') throw new Error(`Expected numeric field "${field}"`);
  return value;
}

/* ------------------------------------------------------------------------- */
/* Path helpers                                                               */
/* ------------------------------------------------------------------------- */

function normaliseTarget(target: string): string {
  return target
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/[#?].*$/, '')
    .trim()
    .toLowerCase();
}

function basename(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const index = normalised.lastIndexOf('/');
  return index === -1 ? normalised : normalised.slice(index + 1);
}

/** Re-exported so callers need only one import to work with claim identity. */
export { requireSha256 };
