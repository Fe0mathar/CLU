/**
 * CLUE artifact store.
 *
 * Spec: CLUE_Architecture — content-addressed artifact store and atomic evidence
 *       writes; CLUE_Constitution — evidence integrity (a reference cannot rot).
 * Backlog: DEV-P1-02 — checked whole-buffer writes, parent-directory fsync, race-safe
 *          no-replace placement (identical on Windows and POSIX), and stable-source
 *          capture. Crash-safety primitives are shared via ../shared/durableFs.ts.
 *          DEV-P1-39 — a read-only store now refuses writes because it was told to, not
 *          because its staging directory happens to be absent.
 *
 * Every non-trivial thing CLUE produces or captures — source slices, context packs,
 * probe reports, run evidence, patch bundles, diffs — is stored here and referenced
 * elsewhere only by its hash. Two consequences follow, and both are load-bearing:
 *
 *   1. A reference cannot rot. If a finding cites a blob hash, the bytes behind that
 *      hash are the bytes that were examined, or the read fails loudly.
 *   2. Identical content is stored once. Re-running an experiment that produces the
 *      same report costs no additional disk and produces the same reference, which is
 *      itself evidence of determinism.
 *
 * Writes are atomic: content goes to a temp file on the same volume, is fsynced, and
 * is then placed at its content address with a no-replace link and a directory fsync. A
 * crash therefore leaves either no blob or a complete one — never a half-written
 * artifact that a later run would trust, and never a blob replaced out from under a
 * concurrent writer. A file captured from disk is re-read if the source changes mid-copy,
 * so a stored blob is always a coherent snapshot rather than a torn mixture.
 *
 * Stored blobs are marked read-only. Evidence that can be edited in place is not
 * evidence, and on Windows the read-only attribute turns an accidental overwrite into
 * an immediate error rather than a silent corruption discovered months later.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { createHash, randomBytes } from 'node:crypto';

import { placeFileNoReplaceSync, replaceFileSync, writeAllSync } from '../shared/durableFs.js';

import {
  HASH_ALGORITHM,
  blobRelativePath,
  canonicalJson,
  hashBytes,
  hashText,
  nowIso,
  requireSha256,
  type Sha256,
} from '../shared/ids.js';
import { artifactRefSchema, parseOrThrow, type ArtifactRef } from '../shared/schemas.js';
import {
  assertProjectOperationIdentity,
  canonicalProjectOperationIdentity,
  type ProjectOperationIdentity,
} from '../shared/projectOperationIdentity.js';

/* ------------------------------------------------------------------------- */
/* Errors                                                                     */
/* ------------------------------------------------------------------------- */

export type ArtifactStoreErrorCode =
  | 'NOT_FOUND'
  | 'HASH_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'SOURCE_UNSTABLE'
  /** DEV-P1-39: a write was attempted through a store attached read-only. */
  | 'READ_ONLY'
  | 'IO';

export class ArtifactStoreError extends Error {
  public readonly code: ArtifactStoreErrorCode;
  public readonly hash: string | null;

  public constructor(code: ArtifactStoreErrorCode, message: string, hash: string | null = null) {
    super(message);
    this.name = 'ArtifactStoreError';
    this.code = code;
    this.hash = hash;
  }
}

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

export interface PutOptions {
  /** Optional stale-request guard for a store already bound to one active project. */
  readonly operationIdentity?: ProjectOperationIdentity;
  /** IANA media type; drives how downstream tools and the CLI render the artifact. */
  readonly mediaType?: string;
  /** Human-facing label. Informational only — lookup is always by hash. */
  readonly label?: string | null;
}

export interface ReadOptions {
  /** Optional stale-request guard for a store already bound to one active project. */
  readonly operationIdentity?: ProjectOperationIdentity;
  /**
   * Recompute the hash on read. Default true: a stored artifact that no longer matches
   * its name means the store has been tampered with or the disk is failing, and CLUE
   * must not build evidence on it. Disable only for bulk paths that verify separately.
   */
  readonly verify?: boolean;
}

export interface VerificationReport {
  readonly checked: number;
  readonly ok: number;
  readonly mismatched: readonly string[];
  readonly unreadable: readonly string[];
}

const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
const TEMP_DIR = '.tmp';
const CHUNK_BYTES = 256 * 1024;
const READ_ONLY_MODE = 0o444;

/* ------------------------------------------------------------------------- */
/* Artifact store                                                             */
/* ------------------------------------------------------------------------- */

export interface ArtifactStoreOptions {
  readonly readOnly?: boolean;
  /** Project identity owning this physical blob namespace. */
  readonly projectIdentity?: ProjectOperationIdentity;
}

export class ArtifactStore {
  private readonly rootDir: string;
  private readonly tempDir: string;
  private readonly readOnly: boolean;
  private readonly boundProjectIdentity: ProjectOperationIdentity | null;

  /** `blobsDir` is `workspace/blobs`; the layout beneath it is owned by shared/ids.ts. */
  public constructor(blobsDir: string, options: ArtifactStoreOptions = {}) {
    this.rootDir = blobsDir;
    this.tempDir = join(blobsDir, TEMP_DIR);
    this.readOnly = options.readOnly === true;
    this.boundProjectIdentity =
      options.projectIdentity === undefined
        ? null
        : canonicalProjectOperationIdentity(options.projectIdentity);
    // DEV-P0-10: a read-only attach must create nothing. The temp dir is a write-staging area, so it is
    // only created when writes are possible; a read-only store never stages, so it never needs it.
    if (!this.readOnly) mkdirSync(this.tempDir, { recursive: true });
  }

  /** Governed identity owning this store, or null for a legacy unbound workspace. */
  public get projectIdentity(): ProjectOperationIdentity | null {
    return this.boundProjectIdentity;
  }

  /** Explicit assertion used by runtime publication receipts and stale request guards. */
  public assertProjectIdentity(actual: unknown, context = 'artifact store operation'): void {
    if (this.boundProjectIdentity === null) return;
    assertProjectOperationIdentity(this.boundProjectIdentity, actual, context);
  }

  /* ------------------------------ writing ------------------------------ */

  /** Stores raw bytes and returns the reference to use everywhere else. */
  public putBytes(bytes: Uint8Array, options: PutOptions = {}): ArtifactRef {
    this.assertOptionalIdentity(options.operationIdentity, 'artifact putBytes');
    const hash = hashBytes(bytes);
    this.commit(hash, (tempPath) => {
      writeFileSync(tempPath, bytes);
    });
    return this.makeRef(hash, bytes.byteLength, options);
  }

  /** Stores UTF-8 text. */
  public putText(text: string, options: PutOptions = {}): ArtifactRef {
    this.assertOptionalIdentity(options.operationIdentity, 'artifact putText');
    const hash = hashText(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    this.commit(hash, (tempPath) => {
      writeFileSync(tempPath, text, 'utf8');
    });
    return this.makeRef(hash, bytes, { mediaType: 'text/plain; charset=utf-8', ...options });
  }

  /**
   * Stores a value as canonical JSON.
   *
   * Canonical form means two structurally equal objects produce one blob and one hash,
   * regardless of key order. This is what lets CLUE detect that a re-run produced an
   * identical report rather than merely a similar-looking one.
   */
  public putJson(value: unknown, options: PutOptions = {}): ArtifactRef {
    return this.putText(canonicalJson(value), {
      mediaType: 'application/json; charset=utf-8',
      ...options,
    });
  }

  /**
   * Stores the contents of an existing file without loading it into memory.
   *
   * Used for run evidence, traces, and captured output, which can be large. The file
   * is hashed and copied in one streaming pass, so the hash always describes exactly
   * the bytes that were stored.
   */
  public putFile(sourcePath: string, options: PutOptions = {}): ArtifactRef {
    this.assertOptionalIdentity(options.operationIdentity, 'artifact putFile');
    this.assertWritable();
    const captured = this.captureStable(sourcePath);
    try {
      this.placeOrDiscard(captured.hash, captured.tempPath);
    } catch (error) {
      rmSync(captured.tempPath, { force: true });
      throw error;
    }
    return this.makeRef(captured.hash, captured.bytes, options);
  }

  /* ------------------------------ reading ------------------------------ */

  /** True when the blob is present. Does not verify content; use `verifyOne` for that. */
  public has(hash: Sha256, operationIdentity?: ProjectOperationIdentity): boolean {
    this.assertOptionalIdentity(operationIdentity, 'artifact has');
    return existsSync(this.pathFor(hash));
  }

  /** Absolute path of a stored blob. Callers must treat the file as read-only. */
  public pathFor(hash: Sha256): string {
    return join(this.rootDir, ...blobRelativePath(hash).split('/'));
  }

  /** Size in bytes of a stored blob. */
  public sizeOf(hash: Sha256, operationIdentity?: ProjectOperationIdentity): number {
    this.assertOptionalIdentity(operationIdentity, 'artifact sizeOf');
    const path = this.pathFor(hash);
    if (!existsSync(path)) {
      throw new ArtifactStoreError('NOT_FOUND', `Artifact ${hash} is not in the store`, hash);
    }
    return statSync(path).size;
  }

  /** Reads a blob, verifying its hash unless explicitly told not to. */
  public getBytes(hash: Sha256, options: ReadOptions = {}): Buffer {
    this.assertOptionalIdentity(options.operationIdentity, 'artifact getBytes');
    const path = this.pathFor(hash);
    if (!existsSync(path)) {
      throw new ArtifactStoreError('NOT_FOUND', `Artifact ${hash} is not in the store`, hash);
    }

    const bytes = readFileSync(path);
    if (options.verify !== false) {
      const actual = hashBytes(bytes);
      if (actual !== hash) {
        throw new ArtifactStoreError(
          'HASH_MISMATCH',
          `Artifact ${hash} hashes to ${actual}. The store has been modified outside CLUE.`,
          hash,
        );
      }
    }
    return bytes;
  }

  /** Reads a blob as UTF-8 text. */
  public getText(hash: Sha256, options: ReadOptions = {}): string {
    return this.getBytes(hash, options).toString('utf8');
  }

  /**
   * Reads a blob as JSON.
   *
   * Returns `unknown` on purpose: the caller must run the value through a zod schema
   * before using it, exactly as every other ingestion boundary does.
   */
  public getJson(hash: Sha256, options: ReadOptions = {}): unknown {
    return JSON.parse(this.getText(hash, options)) as unknown;
  }

  /**
   * Copies a blob out to a working path, e.g. into the shadow clone for a patch apply.
   * The exported copy is writable; the stored original is not.
   */
  public exportTo(hash: Sha256, destinationPath: string, options: ReadOptions = {}): void {
    const bytes = this.getBytes(hash, options);
    mkdirSync(dirname(destinationPath), { recursive: true });
    const tempPath = `${destinationPath}.clue-tmp-${randomBytes(6).toString('hex')}`;
    const fd = openSync(tempPath, 'wx');
    try {
      writeAllSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Atomic replace, identical on Windows and POSIX; the exported copy is writable.
    replaceFileSync(tempPath, destinationPath);
  }

  /* ---------------------------- verification --------------------------- */

  /** Recomputes one blob's hash. Returns false when the content no longer matches. */
  public verifyOne(hash: Sha256, operationIdentity?: ProjectOperationIdentity): boolean {
    this.assertOptionalIdentity(operationIdentity, 'artifact verifyOne');
    const path = this.pathFor(hash);
    if (!existsSync(path)) return false;
    return hashBytes(readFileSync(path)) === hash;
  }

  /**
   * Walks the entire store and re-hashes everything. This is `clue doctor` work, not
   * daemon work: it is linear in total evidence size and exists so integrity failures
   * surface on demand rather than at the moment a proof depends on them.
   */
  public verifyAll(): VerificationReport {
    const mismatched: string[] = [];
    const unreadable: string[] = [];
    let checked = 0;
    let ok = 0;

    for (const relative of this.listBlobRelativePaths()) {
      checked += 1;
      const expected = relative.split('/').pop() ?? '';
      try {
        const bytes = readFileSync(join(this.rootDir, ...relative.split('/')));
        if (hashBytes(bytes) === expected) ok += 1;
        else mismatched.push(expected);
      } catch {
        unreadable.push(expected);
      }
    }

    return { checked, ok, mismatched, unreadable };
  }

  /* ------------------------------ internals ---------------------------- */

  private assertOptionalIdentity(
    identity: ProjectOperationIdentity | undefined,
    context: string,
  ): void {
    if (identity !== undefined) this.assertProjectIdentity(identity, context);
  }

  /**
   * Writes via `writer` to a temp file, then places it at its content address.
   * Skips the write entirely when the blob already exists — the defining property of
   * a content-addressed store, and the reason repeated evidence is free.
   */
  private commit(hash: Sha256, writer: (tempPath: string) => void): void {
    this.assertWritable(hash);
    if (existsSync(this.pathFor(hash))) return;

    const tempPath = this.makeTempPath();
    try {
      writer(tempPath);
      this.fsyncFile(tempPath);
      this.placeOrDiscard(hash, tempPath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }

  private assertWritable(hash: Sha256 | null = null): void {
    if (this.readOnly) {
      throw new ArtifactStoreError(
        'READ_ONLY',
        'This artifact store is attached read-only; storing evidence requires the event-log writer.',
        hash,
      );
    }
  }

  /**
   * Moves a temp file to its final content address.
   *
   * If another writer won the race, the existing blob is byte-identical by definition,
   * so the temp file is simply discarded. The store never overwrites a blob, which is
   * what keeps `rename` semantics identical on every platform.
   */
  /**
   * Places a staged temp file at its content address without ever replacing an existing
   * blob, then marks it read-only. Race-safe by construction: a concurrent writer that
   * placed the identical blob first simply wins, and this call discards its temp.
   */
  private placeOrDiscard(hash: Sha256, tempPath: string): void {
    if (placeFileNoReplaceSync(tempPath, this.pathFor(hash)) === 'placed') {
      this.markReadOnly(this.pathFor(hash));
    }
  }

  /** Marks a blob read-only; a store that cannot is degraded, not broken (hash still guards reads). */
  private markReadOnly(path: string): void {
    try {
      chmodSync(path, READ_ONLY_MODE);
    } catch {
      // Left writable: the content hash still detects any later modification on read.
    }
  }

  /**
   * Captures a source file into a fsynced temp, refusing a torn snapshot.
   *
   * Hash and copy happen in one streaming pass, so the hash always describes exactly the
   * bytes written. The source is stat'd before and after: if its size or mtime changed
   * during the copy, the bytes may be a mixture of two versions, so the temp is discarded
   * and the capture retried; a source that will not hold still is refused rather than
   * stored as coherent evidence.
   */
  private captureStable(sourcePath: string): { tempPath: string; hash: Sha256; bytes: number } {
    const maxAttempts = 3;
    let lastChange = '';

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const before = statSync(sourcePath);
      const tempPath = this.makeTempPath();
      const hasher = createHash(HASH_ALGORITHM);
      let bytes = 0;

      const sourceFd = openSync(sourcePath, 'r');
      try {
        const destFd = openSync(tempPath, 'wx');
        try {
          const buffer = Buffer.alloc(CHUNK_BYTES);
          let position = 0;
          for (;;) {
            const read = readSync(sourceFd, buffer, 0, buffer.length, position);
            if (read === 0) break;
            position += read;
            bytes += read;
            const chunk = buffer.subarray(0, read);
            hasher.update(chunk);
            writeAllSync(destFd, chunk);
          }
          fsyncSync(destFd);
        } finally {
          closeSync(destFd);
        }
      } finally {
        closeSync(sourceFd);
      }

      const after = statSync(sourcePath);
      if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
        return {
          tempPath,
          hash: requireSha256(hasher.digest('hex'), `file ${sourcePath}`),
          bytes,
        };
      }

      // The source moved under us; discard the possibly-torn capture and try again.
      rmSync(tempPath, { force: true });
      lastChange = `size ${before.size}->${after.size}, mtimeMs ${before.mtimeMs}->${after.mtimeMs}`;
    }

    throw new ArtifactStoreError(
      'SOURCE_UNSTABLE',
      `Source file changed during capture across ${maxAttempts} attempts (${lastChange}): ${sourcePath}`,
    );
  }

  private makeTempPath(): string {
    return join(this.tempDir, `put-${process.pid}-${randomBytes(8).toString('hex')}`);
  }

  private fsyncFile(path: string): void {
    const fd = openSync(path, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private makeRef(hash: Sha256, bytes: number, options: PutOptions): ArtifactRef {
    return parseOrThrow(
      artifactRefSchema,
      {
        hash,
        bytes,
        media_type: options.mediaType ?? DEFAULT_MEDIA_TYPE,
        label: options.label ?? null,
        created_at: nowIso(),
      },
      `artifact ${hash}`,
    );
  }

  /**
   * The store's verified census: every blob as `{hash, bytes}`, sorted by hash (ADR-0006).
   *
   * This is what the evidence-epoch seal binds, so it refuses rather than reports: a blob
   * whose bytes do not hash to its name, or that cannot be read, throws with the offenders
   * named — a manifest of evidence that does not verify is not a manifest. `verifyAll`
   * remains the reporting surface for diagnostics; this is the sealing surface.
   */
  public manifest(): { readonly hash: string; readonly bytes: number }[] {
    const entries: { hash: string; bytes: number }[] = [];
    const bad: string[] = [];
    for (const relative of this.listBlobRelativePaths()) {
      const expected = relative.split('/').pop() ?? '';
      try {
        const bytes = readFileSync(join(this.rootDir, ...relative.split('/')));
        if (hashBytes(bytes) === expected) entries.push({ hash: expected, bytes: bytes.length });
        else bad.push(`${expected} (mismatched)`);
      } catch {
        bad.push(`${expected} (unreadable)`);
      }
    }
    if (bad.length > 0) {
      throw new Error(
        `Refusing to build the blob manifest: ${bad.length} blob(s) do not verify ` +
          `(${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ', …' : ''}).`,
      );
    }
    entries.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    return entries;
  }

  /** Every stored blob as a forward-slashed path relative to the store root. */
  private listBlobRelativePaths(): string[] {
    const entries = readdirSync(this.rootDir, { recursive: true, withFileTypes: true });
    const paths: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parentRelative = entry.parentPath.slice(this.rootDir.length).replace(/^[\\/]/, '');
      const relative = (parentRelative.length > 0 ? `${parentRelative}${sep}${entry.name}` : entry.name)
        .split(sep)
        .join('/');
      if (relative.startsWith(`${TEMP_DIR}/`)) continue;
      paths.push(relative);
    }

    return paths;
  }
}
