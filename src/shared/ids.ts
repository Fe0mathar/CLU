/**
 * CLUE shared identity primitives.
 *
 * Spec: CLUE_implementation.md §13 (identity), §18 (snapshot identity), §101.2 (atomic
 *       evidence).
 * Strategy: CLUE_Implementation_Strategy.md Part III §9.
 *
 * Revision 2 — hashing now goes through one unbranded `digest` helper, and each public
 * function brands the result for its own domain. Revision 1 computed a snapshot
 * identity by asserting a `Sha256` to a `SnapshotId`, which TypeScript correctly
 * refused: the two brands are deliberately incompatible, and an assertion between them
 * is exactly the mistake the brands exist to catch. Constructing each identity from a
 * plain digest removes the collision at its root instead of laundering it through
 * `unknown`.
 *
 * Everything CLUE remembers is addressed by content or by a stable, ordered ID. This
 * module owns both, and depends on no other CLUE plane by design — `memory/` imports
 * it; it imports nothing above `shared/`.
 *
 * Invariants enforced here:
 *   1. Identical bytes always produce an identical hash string (lowercase hex, sha256).
 *   2. Identical trees always produce an identical snapshot ID, regardless of walk
 *      order, host path separators, or filesystem case reporting.
 *   3. Sequential IDs are zero-padded and lexicographically sortable, so ordering in
 *      the event log, in filenames, and in SQLite projections agrees without extra
 *      collation rules.
 */

import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* ------------------------------------------------------------------------- */

/** Canonical hash algorithm for every CLUE artifact, event, and snapshot. */
export const HASH_ALGORITHM = 'sha256';

/** Length of a lowercase hex sha256 digest. */
export const HASH_HEX_LENGTH = 64;

/** A lowercase hex sha256 digest. Branded to prevent accidental string mixing. */
export type Sha256 = string & { readonly __brand: 'Sha256' };

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * The one place a digest is actually computed.
 *
 * Returns a plain string so that every branded identity is *constructed* from it rather
 * than asserted across from another brand. Two identities that mean different things
 * should never be interchangeable, and a helper that hands back an already-branded
 * value forces exactly that interchange at the next call site.
 */
function digestText(text: string): string {
  return createHash(HASH_ALGORITHM).update(text, 'utf8').digest('hex');
}

function digestBytes(bytes: Uint8Array): string {
  return createHash(HASH_ALGORITHM).update(bytes).digest('hex');
}

/** Narrows an arbitrary string to a Sha256, or returns undefined if it is not one. */
export function asSha256(value: string): Sha256 | undefined {
  return HEX_64.test(value) ? (value as Sha256) : undefined;
}

/** Throwing variant of asSha256, for boundaries where a malformed hash is a defect. */
export function requireSha256(value: string, context: string): Sha256 {
  const hash = asSha256(value);
  if (hash === undefined) {
    throw new Error(`Invalid sha256 digest in ${context}: ${JSON.stringify(value)}`);
  }
  return hash;
}

/** Hashes raw bytes. */
export function hashBytes(bytes: Uint8Array): Sha256 {
  return digestBytes(bytes) as Sha256;
}

/**
 * Hashes text as UTF-8.
 *
 * Note on line endings: callers hashing file CONTENT must pass the bytes exactly as
 * stored on disk (use hashBytes), because CRLF/LF normalisation would make CLUE's
 * hashes disagree with Git's object hashes and with the actual file a patch applies to.
 * hashText is for CLUE-generated canonical strings, not for reading foreign files.
 */
export function hashText(text: string): Sha256 {
  return digestText(text) as Sha256;
}

/**
 * Hashes a JSON-serialisable value through a canonical form: object keys sorted, no
 * insignificant whitespace, undefined-valued properties omitted.
 *
 * Used for proof-contract freezing, event hashing, and anywhere two structurally equal
 * records must hash equal regardless of key insertion order.
 */
export function hashCanonicalJson(value: unknown): Sha256 {
  return hashText(canonicalJson(value));
}

/**
 * Deterministic JSON serialisation.
 *
 * Rules: object keys sorted by code unit; arrays keep order (order is meaningful);
 * `undefined` properties dropped; `undefined` array entries become null (JSON has no
 * undefined); non-finite numbers rejected, because a contract that hashes NaN is a
 * contract that cannot be verified later.
 */
export function canonicalJson(value: unknown): string {
  return serialiseCanonical(value, []);
}

function serialiseCanonical(value: unknown, path: readonly string[]): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`Non-finite number cannot be canonicalised at ${formatPath(path)}`);
      }
      return JSON.stringify(value);
    case 'bigint':
      throw new Error(`BigInt cannot be canonicalised at ${formatPath(path)}`);
    case 'undefined':
      // Only reachable for array entries; object properties are filtered before recursion.
      return 'null';
    case 'object':
      break;
    default:
      throw new Error(
        `Value of type ${typeof value} cannot be canonicalised at ${formatPath(path)}`,
      );
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => serialiseCanonical(item, [...path, String(index)]));
    return `[${items.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = record[key];
    if (child === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serialiseCanonical(child, [...path, key])}`);
  }
  return `{${parts.join(',')}}`;
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join('.');
}

/* ------------------------------------------------------------------------- */
/* Path normalisation                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Canonical CLUE path form: forward slashes, no leading "./", no trailing slash,
 * relative to a stated root. Windows hosts must never leak backslashes into stored
 * evidence, or the same tree read from two shells would hash differently.
 *
 * Case is preserved exactly. Windows filesystems are case-insensitive but
 * case-preserving; preserving case keeps CLUE's records aligned with Git, which is
 * case-sensitive. Case-only collisions are detected in makeSnapshotId, not silently
 * folded.
 */
export function normalisePath(relativePath: string): string {
  const forward = relativePath.replace(/\\/g, '/');
  const withoutLeadingDot = forward.startsWith('./') ? forward.slice(2) : forward;
  const collapsed = withoutLeadingDot.replace(/\/{2,}/g, '/');
  return collapsed.endsWith('/') && collapsed.length > 1 ? collapsed.slice(0, -1) : collapsed;
}

/* ------------------------------------------------------------------------- */
/* Snapshot identity (spec §18)                                               */
/* ------------------------------------------------------------------------- */

/** One file's contribution to a snapshot: its canonical relative path and content hash. */
export interface SnapshotFileEntry {
  readonly path: string;
  readonly hash: Sha256;
}

/**
 * A content-addressed identity for an entire source tree state.
 *
 * Branded separately from Sha256 on purpose. Both are hex digests, but one identifies
 * arbitrary bytes and the other identifies a tree, and mistaking either for the other
 * would silently attach evidence to the wrong subject.
 */
export type SnapshotId = string & { readonly __brand: 'SnapshotId' };

/**
 * Computes the snapshot identity of a set of files.
 *
 * The identity is the hash of a canonical manifest: entries sorted by normalised path,
 * one "<path>\0<hash>\n" line each. Sorting makes the result independent of directory
 * walk order; the NUL separator makes path/hash boundaries unambiguous even for exotic
 * filenames.
 *
 * Throws on duplicate paths after normalisation, including case-only duplicates,
 * because an ambiguous tree must be reported and never silently resolved (§23.4).
 */
export function makeSnapshotId(files: readonly SnapshotFileEntry[]): SnapshotId {
  const normalised = files.map((entry) => ({
    path: normalisePath(entry.path),
    hash: entry.hash,
  }));

  normalised.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const seenLower = new Map<string, string>();
  let manifest = '';
  for (const entry of normalised) {
    const lower = entry.path.toLowerCase();
    const previous = seenLower.get(lower);
    if (previous !== undefined) {
      throw new Error(
        previous === entry.path
          ? `Duplicate path in snapshot manifest: ${entry.path}`
          : `Case-only path collision in snapshot manifest: ${previous} vs ${entry.path}`,
      );
    }
    seenLower.set(lower, entry.path);
    manifest += `${entry.path}\0${entry.hash}\n`;
  }

  return digestText(manifest) as SnapshotId;
}

/** Narrows a string to a SnapshotId, or returns undefined if it is not a digest. */
export function asSnapshotId(value: string): SnapshotId | undefined {
  return HEX_64.test(value) ? (value as SnapshotId) : undefined;
}

/* ------------------------------------------------------------------------- */
/* Entity IDs                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Entity families that receive sequential CLUE identifiers.
 *
 * `DEV-P1-21`: `consoleSession` was missing, and its absence stopped the Console Ledger
 * dead. `ConsoleLedger.beginSession` mints `CSESS-000001` and passes it as the event's
 * `subject_id`, which `entityIdSchema` builds its pattern from this map — so the very first
 * append threw `expected a CLUE entity id such as TASK-000123`, and every path below it
 * (`ingest`, `classify`, the projectors, the cleanliness report) was unreachable. 906 lines
 * that had never run once. Nothing caught it because no test constructs a `ConsoleLedger`
 * and a compiler cannot see that a string literal fails a runtime regex.
 *
 * Registered as its own family rather than reusing `session`. `SESSION` is reserved and
 * minted nowhere; folding console sessions into it would put two unrelated kinds of session
 * in one sequence namespace, so a later logical-session id could collide with a console one.
 * Disjoint id spaces are cheaper to keep than to separate afterwards.
 */
export const ENTITY_PREFIXES = {
  task: 'TASK',
  finding: 'FIND',
  experiment: 'EXP',
  patch: 'PATCH',
  proofContract: 'PROOF',
  run: 'RUN',
  session: 'SESSION',
  consoleSession: 'CSESS',
  conflict: 'CONFLICT',
  claim: 'CLAIM',
  unit: 'UNIT',
  certificate: 'CERT',
  mission: 'MISSION',
  event: 'EVENT',
  // DEV-P2-08 S1 (cycle plan accepted 2026-08-10): cycles are durable first-class entities;
  // the registry mints CYCLE-###### ids and every cycle.* payload validates against them.
  cycle: 'CYCLE',
} as const;

export type EntityKind = keyof typeof ENTITY_PREFIXES;

/** Width of the sequential component; 6 digits keeps IDs sortable and readable. */
export const SEQUENCE_WIDTH = 6;

/** A sequential entity identifier, e.g. "TASK-000123". */
export type EntityId = string & { readonly __brand: 'EntityId' };

/** Builds a sequential entity ID. Sequence must be a non-negative safe integer. */
export function makeEntityId(kind: EntityKind, sequence: number): EntityId {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Entity sequence must be a non-negative safe integer, received ${sequence}`);
  }
  const digits = String(sequence).padStart(SEQUENCE_WIDTH, '0');
  return `${ENTITY_PREFIXES[kind]}-${digits}` as EntityId;
}

/** Parsed form of an entity ID. */
export interface ParsedEntityId {
  readonly kind: EntityKind;
  readonly sequence: number;
}

const PREFIX_TO_KIND: ReadonlyMap<string, EntityKind> = new Map(
  (Object.keys(ENTITY_PREFIXES) as EntityKind[]).map((kind) => [ENTITY_PREFIXES[kind], kind]),
);

/** Parses an entity ID, or returns undefined when the string is not a valid CLUE ID. */
export function parseEntityId(id: string): ParsedEntityId | undefined {
  const separator = id.indexOf('-');
  if (separator <= 0) return undefined;

  const prefix = id.slice(0, separator);
  const digits = id.slice(separator + 1);

  const kind = PREFIX_TO_KIND.get(prefix);
  if (kind === undefined) return undefined;
  if (digits.length < SEQUENCE_WIDTH || !/^[0-9]+$/.test(digits)) return undefined;

  const sequence = Number(digits);
  if (!Number.isSafeInteger(sequence)) return undefined;

  return { kind, sequence };
}

/* ------------------------------------------------------------------------- */
/* Content-addressed storage layout (spec §14.1)                              */
/* ------------------------------------------------------------------------- */

/** Number of leading hash characters used per directory level in the blob store. */
export const BLOB_FANOUT_LEVELS = 2;
export const BLOB_FANOUT_WIDTH = 2;

/**
 * Relative blob path for a content hash: "sha256/ab/cd/abcd...".
 * Two levels of 2-character fan-out keep directory sizes workable on NTFS while
 * remaining trivially reversible from the hash alone.
 */
export function blobRelativePath(hash: Sha256): string {
  const segments: string[] = [HASH_ALGORITHM];
  for (let level = 0; level < BLOB_FANOUT_LEVELS; level += 1) {
    const start = level * BLOB_FANOUT_WIDTH;
    segments.push(hash.slice(start, start + BLOB_FANOUT_WIDTH));
  }
  segments.push(hash);
  return segments.join('/');
}

/* ------------------------------------------------------------------------- */
/* Time                                                                       */
/* ------------------------------------------------------------------------- */

/** UTC ISO-8601 timestamp with millisecond precision; the only time format CLUE stores. */
export function nowIso(): string {
  return new Date().toISOString();
}
