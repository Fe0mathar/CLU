/**
 * Installed documentation-pack selector.
 *
 * The selector separates "files present in the repository" from "the pack currently in force".
 * Batch 8 can therefore install and verify a v10 release candidate without silently replacing the
 * v9 authority used by the P2 closure ceremony. Promotion is one explicit, atomic selector edit.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

export const DOCUMENTATION_PACK_SELECTOR_SCHEMA =
  'clue-documentation-pack-selector/1' as const;
export const DOCUMENTATION_PACK_SELECTOR_PATH =
  'config/documentation-pack.json' as const;

export interface DocumentationPackIdentity {
  readonly schemaVersion: typeof DOCUMENTATION_PACK_SELECTOR_SCHEMA;
  readonly releaseName: string;
  readonly releaseVersion: string;
  readonly sealFile: string;
  readonly manifestFile: string;
  readonly installHint: string;
}

export interface ResolvedDocumentationPack extends DocumentationPackIdentity {
  readonly source: 'selector' | 'legacy-default';
  readonly selectorPath: typeof DOCUMENTATION_PACK_SELECTOR_PATH;
}

export const LEGACY_DOCUMENTATION_PACK: DocumentationPackIdentity = Object.freeze({
  schemaVersion: DOCUMENTATION_PACK_SELECTOR_SCHEMA,
  releaseName: 'CLU-E RPI Documentation Pack v9',
  releaseVersion: '9.0',
  sealFile: 'SHA256SUMS_v9.txt',
  manifestFile: 'DOCUMENTATION_MANIFEST_v9.json',
  installHint: 'apply the configured documentation pack',
});

export class DocumentationPackSelectorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DocumentationPackSelectorError';
  }
}

export function resolveDocumentationPack(repoRoot: string): ResolvedDocumentationPack {
  const selector = join(repoRoot, ...DOCUMENTATION_PACK_SELECTOR_PATH.split('/'));
  if (!existsSync(selector)) {
    return Object.freeze({
      ...LEGACY_DOCUMENTATION_PACK,
      source: 'legacy-default',
      selectorPath: DOCUMENTATION_PACK_SELECTOR_PATH,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(selector, 'utf8')) as unknown;
  } catch (error) {
    throw new DocumentationPackSelectorError(
      `${DOCUMENTATION_PACK_SELECTOR_PATH} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const identity = validateDocumentationPackSelector(parsed, repoRoot);
  return Object.freeze({
    ...identity,
    source: 'selector',
    selectorPath: DOCUMENTATION_PACK_SELECTOR_PATH,
  });
}

export function validateDocumentationPackSelector(
  input: unknown,
  repoRoot?: string,
): DocumentationPackIdentity {
  const record = object(input);
  const allowed = new Set([
    'schemaVersion',
    'releaseName',
    'releaseVersion',
    'sealFile',
    'manifestFile',
    'installHint',
  ]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new DocumentationPackSelectorError(
      `documentation-pack selector has unknown keys: ${unknown.join(', ')}`,
    );
  }
  const missing = [...allowed].filter((key) => !(key in record));
  if (missing.length > 0) {
    throw new DocumentationPackSelectorError(
      `documentation-pack selector is missing keys: ${missing.join(', ')}`,
    );
  }
  if (record['schemaVersion'] !== DOCUMENTATION_PACK_SELECTOR_SCHEMA) {
    throw new DocumentationPackSelectorError(
      `unsupported documentation-pack selector schema: ${String(record['schemaVersion'])}`,
    );
  }

  const releaseName = nonEmpty(record['releaseName'], 'releaseName');
  const releaseVersion = nonEmpty(record['releaseVersion'], 'releaseVersion');
  const sealFile = safeRelativeFile(record['sealFile'], 'sealFile', repoRoot);
  const manifestFile = safeRelativeFile(record['manifestFile'], 'manifestFile', repoRoot);
  const installHint = nonEmpty(record['installHint'], 'installHint');
  if (sealFile === manifestFile) {
    throw new DocumentationPackSelectorError('sealFile and manifestFile must be different files.');
  }
  if (!sealFile.endsWith('.txt')) {
    throw new DocumentationPackSelectorError('sealFile must be a .txt checksum seal.');
  }
  if (!manifestFile.endsWith('.json')) {
    throw new DocumentationPackSelectorError('manifestFile must be a .json manifest.');
  }

  return Object.freeze({
    schemaVersion: DOCUMENTATION_PACK_SELECTOR_SCHEMA,
    releaseName,
    releaseVersion,
    sealFile,
    manifestFile,
    installHint,
  });
}

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DocumentationPackSelectorError('documentation-pack selector must be an object.');
  }
  return input as Record<string, unknown>;
}

function nonEmpty(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new DocumentationPackSelectorError(`${label} must be a non-empty string.`);
  }
  if (/\r|\n|\u0000/u.test(input)) {
    throw new DocumentationPackSelectorError(`${label} contains a forbidden control character.`);
  }
  return input.trim();
}

function safeRelativeFile(input: unknown, label: string, repoRoot?: string): string {
  const value = nonEmpty(input, label).replace(/\\/gu, '/');
  if (isAbsolute(value) || /^[A-Za-z]:\//u.test(value) || value.startsWith('//')) {
    throw new DocumentationPackSelectorError(`${label} must be repository-relative.`);
  }
  const canonical = normalize(value).replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (
    canonical === '.' ||
    canonical === '..' ||
    canonical.startsWith('../') ||
    canonical.includes('/../') ||
    canonical.endsWith('/')
  ) {
    throw new DocumentationPackSelectorError(`${label} escapes or does not name a file.`);
  }
  if (repoRoot !== undefined) {
    const absolute = resolve(repoRoot, canonical);
    const back = relative(resolve(repoRoot), absolute).replace(/\\/gu, '/');
    if (back === '..' || back.startsWith('../')) {
      throw new DocumentationPackSelectorError(`${label} resolves outside the repository.`);
    }
  }
  return canonical;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
