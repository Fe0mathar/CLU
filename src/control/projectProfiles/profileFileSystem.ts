/** Internal crash-safe filesystem primitives for the Project Profile control plane. */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  fsyncDir,
  placeFileNoReplaceSync,
  replaceFileSync,
  writeAllSync,
} from '../../shared/durableFs.js';
import { canonicalJson, nowIso } from '../../shared/ids.js';

export type ProfilePersistenceErrorCode =
  | 'LOCKED'
  | 'CREATE_CONFLICT'
  | 'READ_FAILED'
  | 'WRITE_FAILED';

export class ProfilePersistenceError extends Error {
  public readonly code: ProfilePersistenceErrorCode;
  public readonly path: string;

  public constructor(code: ProfilePersistenceErrorCode, message: string, path: string) {
    super(message);
    this.name = 'ProfilePersistenceError';
    this.code = code;
    this.path = path;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function tempPathFor(finalPath: string): string {
  return join(dirname(finalPath), `.${randomUUID()}.${process.pid}.tmp`);
}

export function writeBytesAtomically(
  finalPath: string,
  bytes: Uint8Array,
  options: { readonly createOnly?: boolean } = {},
): void {
  mkdirSync(dirname(finalPath), { recursive: true });
  const tempPath = tempPathFor(finalPath);
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeAllSync(fd, bytes, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    if (options.createOnly === true) {
      const placement = placeFileNoReplaceSync(tempPath, finalPath);
      if (placement === 'exists') {
        throw new ProfilePersistenceError(
          'CREATE_CONFLICT',
          `Refusing to replace existing file ${finalPath}.`,
          finalPath,
        );
      }
    } else {
      replaceFileSync(tempPath, finalPath);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    rmSync(tempPath, { force: true });
    if (error instanceof ProfilePersistenceError) throw error;
    throw new ProfilePersistenceError(
      'WRITE_FAILED',
      `Failed to write ${finalPath}: ${(error as Error).message}`,
      finalPath,
    );
  }
}

export function writeTextAtomically(
  finalPath: string,
  text: string,
  options: { readonly createOnly?: boolean } = {},
): void {
  writeBytesAtomically(finalPath, Buffer.from(text, 'utf8'), options);
}

export function writeJsonAtomically(
  finalPath: string,
  value: unknown,
  options: { readonly createOnly?: boolean } = {},
): void {
  writeTextAtomically(finalPath, `${canonicalJson(value)}\n`, options);
}

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ProfilePersistenceError(
      'READ_FAILED',
      `Failed to read ${path}: ${(error as Error).message}`,
      path,
    );
  }
}

export function removeFileDurably(path: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
  fsyncDir(dirname(path));
}

/**
 * Synchronous cross-process lock. A live lock is never guessed stale or removed automatically;
 * the operator must investigate rather than risk two profile writers.
 */
export function withExclusiveFileLock<T>(lockPath: string, action: () => T): T {
  const release = acquireExclusiveFileLock(lockPath);
  try {
    return action();
  } finally {
    release();
  }
}

/** The caller owns the lock until release, including across awaited operations. */
export function acquireExclusiveFileLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  const release = (): void => {
    try {
      closeSync(fd);
    } finally {
      rmSync(lockPath, { force: true });
      fsyncDir(dirname(lockPath));
    }
  };
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new ProfilePersistenceError(
        'LOCKED',
        `Project Profile store is locked by another writer: ${lockPath}`,
        lockPath,
      );
    }
    throw new ProfilePersistenceError(
      'WRITE_FAILED',
      `Failed to acquire Project Profile lock ${lockPath}: ${(error as Error).message}`,
      lockPath,
    );
  }

  try {
    const lockRecord = Buffer.from(
      `${canonicalJson({ pid: process.pid, acquiredAt: nowIso() })}\n`,
      'utf8',
    );
    writeAllSync(fd, lockRecord, 0);
    fsyncSync(fd);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export function appendLineDurably(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  let fd: number | null = null;
  try {
    fd = openSync(path, 'a', 0o600);
    const bytes = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    writeAllSync(fd, bytes, null);
    fsyncSync(fd);
    if (!existed) fsyncDir(dirname(path));
  } catch (error) {
    throw new ProfilePersistenceError(
      'WRITE_FAILED',
      `Failed to append ${path}: ${(error as Error).message}`,
      path,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
