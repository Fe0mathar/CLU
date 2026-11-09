/** Canonical physical filesystem identity for CLU-E Project Profiles. */

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, posix, win32 } from 'node:path';

import { hashCanonicalJson } from './ids.js';
import { absolutePathForm } from './schemas.js';

export const PATH_IDENTITY_VERSION = 'path:v1' as const;

export type PathZone =
  | 'target'
  | 'workspace'
  | 'shadow'
  | 'clue-state'
  | 'clue-owned-state'
  | 'browser-profile';
export type PathPlatform = NodeJS.Platform;
export type PathIdentity = string & { readonly __brand: 'PathIdentity' };
export type TargetRootIdentity = string & { readonly __brand: 'TargetRootIdentity' };

export interface ResolvedPathIdentity {
  readonly zone: PathZone;
  readonly inputPath: string;
  readonly displayPath: string;
  readonly canonicalPath: string;
  readonly comparablePath: string;
  readonly identity: PathIdentity;
  readonly exists: boolean;
  readonly kind: 'directory' | 'file' | 'missing';
}

export type PathIdentityErrorCode =
  | 'PATH_EMPTY'
  | 'RELATIVE_BASE_REQUIRED'
  | 'PATH_PLATFORM_MISMATCH'
  | 'PATH_NOT_FOUND'
  | 'PATH_UNREADABLE'
  | 'PATH_KIND_INVALID'
  | 'ZONE_OVERLAP'
  | 'IDENTITY_MISMATCH';

export class PathIdentityError extends Error {
  public readonly code: PathIdentityErrorCode;
  public readonly path: string | null;

  public constructor(code: PathIdentityErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = 'PathIdentityError';
    this.code = code;
    this.path = path;
  }
}

export interface ResolvePathIdentityOptions {
  readonly zone: PathZone;
  readonly baseDir?: string;
  readonly mustExist?: boolean;
  readonly expectedKind?: 'directory' | 'file' | 'either';
}

function pathImplementation(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

export function normaliseIdentityPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const implementation = pathImplementation(platform);
  let normalised = implementation.normalize(value).replace(/\\/gu, '/');
  if (normalised.length > 1 && !/^[A-Za-z]:\/$/u.test(normalised)) {
    normalised = normalised.replace(/\/+$/u, '');
  }
  return platform === 'win32' ? normalised.toLowerCase() : normalised;
}

export function normalisePathForStorage(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const implementation = pathImplementation(platform);
  let normalised = implementation.normalize(value).replace(/\\/gu, '/');
  if (normalised.length > 1 && !/^[A-Za-z]:\/$/u.test(normalised)) {
    normalised = normalised.replace(/\/+$/u, '');
  }
  return normalised;
}

/** Compatibility name used by the later readiness modules. */
export const normalisePathDisplay = normalisePathForStorage;

function foreignAbsoluteDescription(value: string): string | null {
  const form = absolutePathForm(value);
  if (form === null || isAbsolute(value)) return null;
  return form;
}

function identityFor(comparablePath: string): PathIdentity {
  const digest = hashCanonicalJson({
    version: PATH_IDENTITY_VERSION,
    platform: process.platform,
    canonicalPath: comparablePath,
  });
  return `${PATH_IDENTITY_VERSION}:${process.platform}:${digest}` as PathIdentity;
}

export function resolvePathIdentity(
  inputPath: string,
  options: ResolvePathIdentityOptions,
): ResolvedPathIdentity {
  const trimmed = inputPath.trim();
  if (trimmed === '') throw new PathIdentityError('PATH_EMPTY', 'Path must not be empty.', inputPath);
  if (trimmed.includes('\0')) {
    throw new PathIdentityError('PATH_UNREADABLE', 'Path must not contain a NUL byte.', inputPath);
  }

  const foreign = foreignAbsoluteDescription(trimmed);
  if (foreign !== null) {
    throw new PathIdentityError(
      'PATH_PLATFORM_MISMATCH',
      `Path ${JSON.stringify(trimmed)} is absolute under ${foreign} rules but cannot be resolved on ${process.platform}.`,
      trimmed,
    );
  }
  if (!isAbsolute(trimmed) && options.baseDir === undefined) {
    throw new PathIdentityError(
      'RELATIVE_BASE_REQUIRED',
      `Relative path ${JSON.stringify(trimmed)} requires an explicit baseDir.`,
      trimmed,
    );
  }

  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(options.baseDir ?? '', trimmed);
  let canonical: string;
  let kind: ResolvedPathIdentity['kind'] = 'missing';
  try {
    if (pathEntryExists(absolute)) {
      canonical = realpathSync.native(absolute);
      const stats = statSync(canonical);
      if (!stats.isDirectory() && !stats.isFile()) {
        throw new PathIdentityError('PATH_KIND_INVALID', `Expected a regular file or directory at ${absolute}.`, absolute);
      }
      kind = stats.isDirectory() ? 'directory' : 'file';
    } else if (options.mustExist !== false) {
      throw new PathIdentityError('PATH_NOT_FOUND', `Path does not exist: ${normalisePathForStorage(absolute)}`, absolute);
    } else {
      // A nonexistent leaf still inherits aliases of its closest existing ancestor.
      let parent = dirname(absolute);
      while (!pathEntryExists(parent) && dirname(parent) !== parent) parent = dirname(parent);
      const canonicalParent = realpathSync.native(parent);
      if (!statSync(canonicalParent).isDirectory()) {
        throw new PathIdentityError('PATH_KIND_INVALID', `Expected a directory at ${parent}.`, parent);
      }
      canonical = resolve(canonicalParent, relative(parent, absolute));
    }
  } catch (error) {
    if (error instanceof PathIdentityError) throw error;
    throw new PathIdentityError(
      'PATH_UNREADABLE',
      `Path cannot be resolved: ${normalisePathForStorage(absolute)} (${(error as Error).message})`,
      absolute,
    );
  }
  const expectedKind = options.expectedKind ?? 'either';
  if (kind !== 'missing' && expectedKind !== 'either' && kind !== expectedKind) {
    throw new PathIdentityError(
      'PATH_KIND_INVALID',
      `Expected ${expectedKind} but resolved ${kind}: ${normalisePathForStorage(canonical)}`,
      canonical,
    );
  }

  const displayPath = normalisePathForStorage(canonical);
  const comparablePath = normaliseIdentityPath(canonical);
  return {
    zone: options.zone,
    inputPath,
    displayPath,
    canonicalPath: canonical,
    comparablePath,
    identity: identityFor(comparablePath),
    exists: kind !== 'missing',
    kind,
  };
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function asTargetRootIdentity(identity: PathIdentity | string): TargetRootIdentity {
  if (!/^path:v1:[a-z0-9._-]+:[0-9a-f]{64}$/u.test(identity)) {
    throw new PathIdentityError('IDENTITY_MISMATCH', `Expected path:v1 target identity, received ${identity}.`);
  }
  return identity as TargetRootIdentity;
}

export function resolveTargetRootIdentity(path: string): TargetRootIdentity {
  return asTargetRootIdentity(
    resolvePathIdentity(path, { zone: 'target', expectedKind: 'directory' }).identity,
  );
}

export function pathIdentitiesEqual(
  left: Pick<ResolvedPathIdentity, 'identity'> | string,
  right: Pick<ResolvedPathIdentity, 'identity'> | string,
): boolean {
  return (typeof left === 'string' ? left : left.identity) ===
    (typeof right === 'string' ? right : right.identity);
}

export function assertPathIdentity(
  expected: string,
  actual: Pick<ResolvedPathIdentity, 'identity'> | string,
  label = 'path identity',
): void {
  const actualValue = typeof actual === 'string' ? actual : actual.identity;
  if (expected !== actualValue) {
    throw new PathIdentityError(
      'IDENTITY_MISMATCH',
      `${label} mismatch: expected ${expected}, received ${actualValue}.`,
    );
  }
}

export function assertSamePathIdentity(
  left: Pick<ResolvedPathIdentity, 'identity'> | string,
  right: Pick<ResolvedPathIdentity, 'identity'> | string,
  label = 'path identity',
): void {
  const leftValue = typeof left === 'string' ? left : left.identity;
  const rightValue = typeof right === 'string' ? right : right.identity;
  if (leftValue !== rightValue) {
    throw new PathIdentityError('IDENTITY_MISMATCH', `${label} mismatch: ${leftValue} !== ${rightValue}.`);
  }
}

export function containsPath(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export function assertPathZonesDisjoint(paths: readonly ResolvedPathIdentity[]): void {
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const left = paths[leftIndex];
      const right = paths[rightIndex];
      if (left === undefined || right === undefined) continue;
      const equal = left.comparablePath === right.comparablePath;
      const leftContainsRight = containsPath(left.canonicalPath, right.canonicalPath);
      const rightContainsLeft = containsPath(right.canonicalPath, left.canonicalPath);
      if (equal || leftContainsRight || rightContainsLeft) {
        const relation = equal ? 'is the same path as' : leftContainsRight ? 'contains' : 'is contained by';
        throw new PathIdentityError(
          'ZONE_OVERLAP',
          `${left.zone} root ${left.displayPath} ${relation} ${right.zone} root ${right.displayPath}.`,
        );
      }
    }
  }
}
