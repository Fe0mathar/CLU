/**
 * Live, fail-closed Project Authority inspection for one durable Project Profile generation.
 *
 * A profile stores the intended canonical path and content hash. This module re-reads the exact
 * physical files and refuses silent drift. Disabled documents remain configured but never enter
 * the active authority manifest.
 */

import {
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { hashBytes, hashCanonicalJson, requireSha256, type Sha256 } from '../../shared/ids.js';
import { normalisePathDisplay } from '../../shared/pathIdentity.js';
import type { ProjectProfile, ProjectProfileRecord } from '../../shared/schemas.js';
import type { ProjectOperationIdentity } from '../../shared/projectOperationIdentity.js';
import { operationIdentityFromProfileRecord } from '../../shared/projectOperationIdentity.js';
import { computeProjectAuthorityHash, computeProjectRecognitionHash } from './profileHash.js';
import { benchmarkWorkerAuthority } from './benchmarkProfileInputs.js';

export const PROJECT_AUTHORITY_MANIFEST_VERSION = 'clue-project-authority-manifest/1' as const;
export const PROJECT_AUTHORITY_SNAPSHOT_VERSION = 'clue-project-authority-snapshot/1' as const;

export type ProjectAuthorityState = 'CURRENT' | 'INCOMPLETE' | 'DRIFTED' | 'INVALID';
export type ProjectAuthorityDocumentState =
  | 'CURRENT'
  | 'DISABLED'
  | 'MISSING'
  | 'INVALID_PATH'
  | 'PATH_MISMATCH'
  | 'HASH_MISMATCH'
  | 'PROFILE_VALIDATION_INVALID';

export type AuthorityBinding = NonNullable<ProjectProfile['authority']['targetDescription']>;

export interface ProjectAuthorityIssue {
  readonly code:
    | 'TARGET_DESCRIPTION_REQUIRED'
    | 'MASTER_BENCHMARK_REQUIRED'
    | 'DOCUMENT_MISSING'
    | 'DOCUMENT_PATH_INVALID'
    | 'DOCUMENT_PATH_MISMATCH'
    | 'DOCUMENT_HASH_MISMATCH'
    | 'PROFILE_VALIDATION_INVALID';
  readonly severity: 'incomplete' | 'drift' | 'invalid';
  readonly bindingId: string | null;
  readonly detail: string;
}

export interface EvaluatedAuthorityDocument {
  readonly bindingId: string;
  readonly kind: AuthorityBinding['kind'];
  readonly role: AuthorityBinding['role'];
  readonly order: number;
  readonly enabled: boolean;
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly configuredSha256: Sha256;
  readonly observedSha256: Sha256 | null;
  readonly bytes: number | null;
  readonly state: ProjectAuthorityDocumentState;
}

export interface ActiveAuthorityDocument {
  readonly bindingId: string;
  readonly kind: AuthorityBinding['kind'];
  readonly role: AuthorityBinding['role'];
  readonly order: number;
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly sha256: Sha256;
  readonly bytes: number;
}

export interface ProjectAuthorityManifest {
  readonly manifestVersion: typeof PROJECT_AUTHORITY_MANIFEST_VERSION;
  readonly operationIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly configuredAuthorityHash: Sha256;
  readonly recognitionConfigHash: Sha256;
  readonly documents: readonly ActiveAuthorityDocument[];
  readonly targetDescriptionHash: Sha256;
  readonly masterBenchmarkHash: Sha256;
  readonly projectIntentHash: Sha256 | null;
  readonly manifestHash: Sha256;
}

export interface ProjectAuthoritySnapshot {
  readonly snapshotVersion: typeof PROJECT_AUTHORITY_SNAPSHOT_VERSION;
  readonly operationIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly configuredAuthorityHash: Sha256;
  readonly recognitionConfigHash: Sha256;
  readonly state: ProjectAuthorityState;
  readonly proofReady: boolean;
  readonly documents: readonly EvaluatedAuthorityDocument[];
  readonly issues: readonly ProjectAuthorityIssue[];
  readonly manifest: ProjectAuthorityManifest | null;
}

export class ProjectAuthorityError extends Error {
  public readonly code = 'PROJECT_AUTHORITY_NOT_CURRENT' as const;
  public readonly snapshot: ProjectAuthoritySnapshot;

  public constructor(message: string, snapshot: ProjectAuthoritySnapshot) {
    super(message);
    this.name = 'ProjectAuthorityError';
    this.snapshot = snapshot;
  }
}

export function inspectProjectAuthority(record: ProjectProfileRecord): ProjectAuthoritySnapshot {
  const profile = record.profile;
  const operationIdentity = operationIdentityFromProfileRecord(record);
  const configuredAuthorityHash = computeProjectAuthorityHash(profile);
  const recognitionConfigHash = computeProjectRecognitionHash(profile);
  const issues: ProjectAuthorityIssue[] = [];
  const evaluated: EvaluatedAuthorityDocument[] = [];

  if (profile.authority.targetDescription === null) {
    issues.push({
      code: 'TARGET_DESCRIPTION_REQUIRED',
      severity: 'incomplete',
      bindingId: null,
      detail: 'A proof-ready Project Profile requires one enabled Target Description.',
    });
  }
  if (profile.authority.masterBenchmark === null) {
    issues.push({
      code: 'MASTER_BENCHMARK_REQUIRED',
      severity: 'incomplete',
      bindingId: null,
      detail: 'A proof-ready Project Profile requires one enabled Master Benchmark.',
    });
  }

  for (const binding of orderedBindings(profile)) {
    const result = evaluateBinding(record, binding);
    evaluated.push(result.document);
    if (result.issue !== null) issues.push(result.issue);
  }

  const state = authorityState(issues);
  const active = evaluated
    .filter((document): document is EvaluatedAuthorityDocument & {
      readonly observedSha256: Sha256;
      readonly bytes: number;
      readonly state: 'CURRENT';
    } => document.enabled && document.state === 'CURRENT' && document.observedSha256 !== null && document.bytes !== null)
    .map((document): ActiveAuthorityDocument => ({
      bindingId: document.bindingId,
      kind: document.kind,
      role: document.role,
      order: document.order,
      configuredPath: document.configuredPath,
      canonicalPath: document.canonicalPath,
      sha256: document.observedSha256,
      bytes: document.bytes,
    }))
    .sort(compareDocuments);

  const target = active.find((document) => document.kind === 'target-description');
  const benchmark = active.find((document) => document.kind === 'master-benchmark');
  const intent = active.find((document) => document.kind === 'project-intent');

  const manifest =
    state === 'CURRENT' && target !== undefined && benchmark !== undefined
      ? buildManifest({
          operationIdentity,
          profileGeneration: record.generation,
          configuredAuthorityHash,
          recognitionConfigHash,
          documents: active,
          targetDescriptionHash: target.sha256,
          masterBenchmarkHash: benchmark.sha256,
          projectIntentHash: intent?.sha256 ?? null,
        })
      : null;

  return {
    snapshotVersion: PROJECT_AUTHORITY_SNAPSHOT_VERSION,
    operationIdentity,
    profileGeneration: record.generation,
    configuredAuthorityHash,
    recognitionConfigHash,
    state,
    proofReady: manifest !== null,
    documents: evaluated.sort(compareDocuments),
    issues,
    manifest,
  };
}

export function requireCurrentProjectAuthority(record: ProjectProfileRecord): ProjectAuthorityManifest {
  const snapshot = inspectProjectAuthority(record);
  if (snapshot.manifest !== null) return snapshot.manifest;
  throw new ProjectAuthorityError(
    `Project ${record.profile.projectId} authority is ${snapshot.state}: ${snapshot.issues
      .map((issue) => `${issue.code}: ${issue.detail}`)
      .join('; ')}`,
    snapshot,
  );
}

/** Reads exact text only after the whole authority generation has passed currentness checks. */
export function readActiveAuthorityDocuments(record: ProjectProfileRecord): readonly {
  readonly document: ActiveAuthorityDocument;
  readonly text: string;
}[] {
  const manifest = requireCurrentProjectAuthority(record);
  return manifest.documents.map((document) => ({
    document,
    text: readProjectAuthorityBytes(record, document).toString('utf8'),
  }));
}

/** Worker reads only its exact staged bytes; ordinary runtime reads the live canonical file. */
export function readProjectAuthorityBytes(record: ProjectProfileRecord, document: ActiveAuthorityDocument): Buffer {
  return benchmarkWorkerAuthority(record, document.bindingId) ?? readFileSync(nativePath(document.canonicalPath));
}

function buildManifest(
  input: Omit<ProjectAuthorityManifest, 'manifestVersion' | 'manifestHash'>,
): ProjectAuthorityManifest {
  const body = {
    manifestVersion: PROJECT_AUTHORITY_MANIFEST_VERSION,
    ...input,
  } as const;
  return { ...body, manifestHash: hashCanonicalJson(body) };
}

function evaluateBinding(
  record: ProjectProfileRecord,
  binding: AuthorityBinding,
): { readonly document: EvaluatedAuthorityDocument; readonly issue: ProjectAuthorityIssue | null } {
  const base: Omit<EvaluatedAuthorityDocument, 'canonicalPath' | 'observedSha256' | 'bytes' | 'state'> = {
    bindingId: binding.bindingId,
    kind: binding.kind,
    role: binding.role,
    order: binding.order,
    enabled: binding.enabled,
    configuredPath: binding.path,
    configuredSha256: requireSha256(binding.sha256, `authority binding ${binding.bindingId}`),
  };
  if (!binding.enabled) {
    return {
      document: {
        ...base,
        canonicalPath: normalisePathDisplay(binding.canonicalPath),
        observedSha256: null,
        bytes: null,
        state: 'DISABLED',
      },
      issue: null,
    };
  }
  if (binding.validationState !== 'VALID') {
    return {
      document: {
        ...base,
        canonicalPath: normalisePathDisplay(binding.canonicalPath),
        observedSha256: null,
        bytes: null,
        state: 'PROFILE_VALIDATION_INVALID',
      },
      issue: {
        code: 'PROFILE_VALIDATION_INVALID',
        severity: 'invalid',
        bindingId: binding.bindingId,
        detail: `Profile validationState is ${binding.validationState}; active authority requires VALID.`,
      },
    };
  }

  const staged = benchmarkWorkerAuthority(record, binding.bindingId);
  if (staged !== null) {
    return {
      document: {
        ...base,
        canonicalPath: normalisePathDisplay(binding.canonicalPath),
        observedSha256: hashBytes(staged),
        bytes: staged.byteLength,
        state: 'CURRENT',
      },
      issue: null,
    };
  }

  const configuredAbsolute = isAbsolute(nativePath(binding.path))
    ? nativePath(binding.path)
    : resolve(nativePath(record.profile.targetRoot), nativePath(binding.path));
  const declaredAbsolute = nativePath(binding.canonicalPath);

  let configuredCanonical: string;
  let declaredCanonical: string;
  try {
    configuredCanonical = canonicalFile(configuredAbsolute);
    declaredCanonical = canonicalFile(declaredAbsolute);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      document: {
        ...base,
        canonicalPath: normalisePathDisplay(binding.canonicalPath),
        observedSha256: null,
        bytes: null,
        state: missing ? 'MISSING' : 'INVALID_PATH',
      },
      issue: {
        code: missing ? 'DOCUMENT_MISSING' : 'DOCUMENT_PATH_INVALID',
        severity: 'invalid',
        bindingId: binding.bindingId,
        detail: `${binding.kind} ${binding.path} cannot be resolved: ${errorMessage(error)}`,
      },
    };
  }

  if (comparable(configuredCanonical) !== comparable(declaredCanonical)) {
    return {
      document: {
        ...base,
        canonicalPath: normalisePathDisplay(configuredCanonical),
        observedSha256: null,
        bytes: null,
        state: 'PATH_MISMATCH',
      },
      issue: {
        code: 'DOCUMENT_PATH_MISMATCH',
        severity: 'invalid',
        bindingId: binding.bindingId,
        detail: `Configured path resolves to ${configuredCanonical}, but canonicalPath resolves to ${declaredCanonical}.`,
      },
    };
  }

  const bytes = readFileSync(configuredCanonical);
  const observed = hashBytes(bytes);
  if (observed !== binding.sha256) {
    return {
      document: {
        ...base,
        canonicalPath: normalisePathDisplay(configuredCanonical),
        observedSha256: observed,
        bytes: bytes.byteLength,
        state: 'HASH_MISMATCH',
      },
      issue: {
        code: 'DOCUMENT_HASH_MISMATCH',
        severity: 'drift',
        bindingId: binding.bindingId,
        detail: `Configured hash ${binding.sha256} no longer matches ${observed}. Save a successor profile generation; do not absorb drift silently.`,
      },
    };
  }

  return {
    document: {
      ...base,
      canonicalPath: normalisePathDisplay(configuredCanonical),
      observedSha256: observed,
      bytes: bytes.byteLength,
      state: 'CURRENT',
    },
    issue: null,
  };
}

function orderedBindings(profile: ProjectProfile): AuthorityBinding[] {
  return [
    profile.authority.targetDescription,
    profile.authority.masterBenchmark,
    profile.authority.projectIntent,
    ...profile.authority.additionalDocuments,
  ]
    .filter((binding): binding is AuthorityBinding => binding !== null)
    .sort((left, right) => left.order - right.order || left.bindingId.localeCompare(right.bindingId));
}

function compareDocuments<T extends { readonly order: number; readonly bindingId: string }>(left: T, right: T): number {
  return left.order - right.order || left.bindingId.localeCompare(right.bindingId);
}

function canonicalFile(value: string): string {
  const canonical = realpathSync.native(value);
  if (!statSync(canonical).isFile()) throw new Error(`${canonical} is not a file`);
  return canonical;
}

function comparable(value: string): string {
  const normalized = normalisePathDisplay(value).normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function nativePath(value: string): string {
  return process.platform === 'win32' ? value.replace(/\//gu, '\\') : value;
}

function authorityState(issues: readonly ProjectAuthorityIssue[]): ProjectAuthorityState {
  if (issues.some((issue) => issue.severity === 'invalid')) return 'INVALID';
  if (issues.some((issue) => issue.severity === 'drift')) return 'DRIFTED';
  if (issues.some((issue) => issue.severity === 'incomplete')) return 'INCOMPLETE';
  return 'CURRENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
