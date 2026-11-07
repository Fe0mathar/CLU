/**
 * Durable filesystem primitives for CLUE's memory spine.
 *
 * Spec: CLUE_Architecture — atomic evidence writes and durable record model;
 *       CLUE_Constitution — durable records survive a crash without partial or
 *       silently-replaced state.
 * Backlog: DEV-P1-02 — checked whole-buffer writes, parent-directory fsync, and
 *          race-safe no-replace placement that behaves identically on Windows and POSIX.
 *
 * These are the shared building blocks used by the artifact store (and, over time, the
 * event log). They exist because durability on a real disk needs three things the naive
 * `writeSync`/`renameSync` pair does not give:
 *
 *   1. A short write must be completed, not silently truncated.
 *   2. A rename is only durable once the containing directory entry is fsynced; the file
 *      data reaching disk is not enough to guarantee the name reaching disk.
 *   3. "Create if absent, otherwise leave the existing file untouched" must be atomic and
 *      identical on every platform — POSIX `rename` replaces the destination, and Windows
 *      cannot replace a read-only destination at all, so neither can express no-replace
 *      by itself. A hard link fails cleanly with EEXIST when the destination exists and is
 *      the one primitive that means the same thing on both.
 *
 * Deliberately synchronous, matching the rest of the memory spine.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** A durability primitive failed in a way that must not be swallowed. */
export class DurableFsError extends Error {
  public readonly code: 'WRITE_FAILED';

  public constructor(code: 'WRITE_FAILED', message: string) {
    super(message);
    this.name = 'DurableFsError';
    this.code = code;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Writes `data` fully, completing any short write.
 *
 * A single `writeSync` may write fewer bytes than requested; this advances through the
 * buffer until every byte is on the file, retrying transient EAGAIN/EINTR. A pathological
 * non-positive return is refused rather than spun on. `position` is the file offset for
 * the first byte (null appends / uses the file's current offset).
 */
export function writeAllSync(fd: number, data: Uint8Array, position: number | null = null): void {
  let offset = 0;
  let filePos = position;
  while (offset < data.length) {
    let written: number;
    try {
      written = writeSync(fd, data, offset, data.length - offset, filePos);
    } catch (error) {
      if (isErrno(error, 'EAGAIN') || isErrno(error, 'EINTR')) continue;
      throw error;
    }
    if (written <= 0) {
      throw new DurableFsError('WRITE_FAILED', `writeSync reported ${written} bytes; refusing to spin`);
    }
    offset += written;
    if (filePos !== null) filePos += written;
  }
}

/**
 * fsyncs a directory so a create/rename/truncate of one of its entries is durable.
 *
 * Best-effort: platforms that reject fsync on a directory handle (Windows, and some
 * filesystems) are treated as degraded, not broken — the data fsync on the file itself
 * still holds; only the ordering guarantee of the directory entry is weaker there.
 */
export function fsyncDir(dirPath: string): void {
  let fd: number;
  try {
    fd = openSync(dirPath, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    if (
      !isErrno(error, 'EISDIR') &&
      !isErrno(error, 'EPERM') &&
      !isErrno(error, 'EINVAL') &&
      !isErrno(error, 'EACCES') &&
      !isErrno(error, 'ENOTSUP')
    ) {
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Places `tempPath` at `finalPath` without ever replacing an existing file, then makes
 * the resulting directory entry durable. Returns 'placed' when this call created the
 * final file, or 'exists' when another writer had already created it (temp is discarded).
 *
 * Uses a hard link as the atomic create-or-EEXIST primitive — identical on POSIX and
 * NTFS, and it never has to replace a read-only destination. Where hard links are
 * unsupported, it falls back to an existence check plus a rename that only runs when the
 * destination is absent.
 */
export function placeFileNoReplaceSync(tempPath: string, finalPath: string): 'placed' | 'exists' {
  mkdirSync(dirname(finalPath), { recursive: true });
  try {
    linkSync(tempPath, finalPath);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      rmSync(tempPath, { force: true });
      return 'exists';
    }
    if (
      isErrno(error, 'ENOSYS') ||
      isErrno(error, 'EPERM') ||
      isErrno(error, 'EXDEV') ||
      isErrno(error, 'EACCES') ||
      isErrno(error, 'ENOTSUP') ||
      isErrno(error, 'EOPNOTSUPP')
    ) {
      if (existsSync(finalPath)) {
        rmSync(tempPath, { force: true });
        return 'exists';
      }
      renameSync(tempPath, finalPath);
      fsyncDir(dirname(finalPath));
      return 'placed';
    }
    throw error;
  }
  // The link created a second name for the same content; drop the temp name.
  rmSync(tempPath, { force: true });
  fsyncDir(dirname(finalPath));
  return 'placed';
}

/**
 * Atomically replaces `finalPath` with `tempPath`, then makes the directory entry
 * durable. This is the intended overwrite path (e.g. materializing a blob at a working
 * path): `renameSync` is an atomic replace on POSIX and, via libuv's MoveFileEx, on
 * Windows too, so callers get the same behavior on both.
 */
export function replaceFileSync(tempPath: string, finalPath: string): void {
  mkdirSync(dirname(finalPath), { recursive: true });
  renameSync(tempPath, finalPath);
  fsyncDir(dirname(finalPath));
}
