/**
 * Governed identity envelope carried by project-scoped commands and durable operations.
 *
 * The envelope is deliberately small and closed. Project-specific payloads may extend a command
 * around it, but they may not redefine which project, physical target, or profile generation the
 * operation belongs to. Strict parsing also means a stale UI cannot smuggle credential material
 * or another ad-hoc identity field into the authority basis.
 */

import { z } from 'zod';

import { hashCanonicalJson, type Sha256 } from './ids.js';
import {
  projectIdSchema,
  projectProfileHashSchema,
  targetRootIdentitySchema,
  type ProjectProfileRecord,
} from './schemas.js';

export const PROJECT_OPERATION_IDENTITY_VERSION = 'clue-project-operation-identity/1' as const;

export const projectOperationIdentitySchema = z
  .object({
    projectId: projectIdSchema,
    targetRootIdentity: targetRootIdentitySchema,
    projectProfileHash: projectProfileHashSchema,
  })
  .strict();

export type ProjectOperationIdentity = z.infer<typeof projectOperationIdentitySchema>;

export type ProjectOperationIdentityErrorCode = 'INVALID_IDENTITY' | 'IDENTITY_MISMATCH';

export class ProjectOperationIdentityError extends Error {
  public readonly code: ProjectOperationIdentityErrorCode;

  public constructor(code: ProjectOperationIdentityErrorCode, message: string) {
    super(message);
    this.name = 'ProjectOperationIdentityError';
    this.code = code;
  }
}

/** Parses and returns a fresh canonical object in the one governed field order. */
export function canonicalProjectOperationIdentity(value: unknown): ProjectOperationIdentity {
  const parsed = projectOperationIdentitySchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectOperationIdentityError(
      'INVALID_IDENTITY',
      `Invalid project operation identity: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return {
    projectId: parsed.data.projectId,
    targetRootIdentity: parsed.data.targetRootIdentity,
    projectProfileHash: parsed.data.projectProfileHash,
  };
}

/** Stable digest suitable for binding the envelope into a mission/proof/event identity. */
export function projectOperationIdentityHash(value: unknown): Sha256 {
  return hashCanonicalJson({
    version: PROJECT_OPERATION_IDENTITY_VERSION,
    identity: canonicalProjectOperationIdentity(value),
  });
}

export function projectOperationIdentitiesEqual(left: unknown, right: unknown): boolean {
  const a = canonicalProjectOperationIdentity(left);
  const b = canonicalProjectOperationIdentity(right);
  return (
    a.projectId === b.projectId &&
    a.targetRootIdentity === b.targetRootIdentity &&
    a.projectProfileHash === b.projectProfileHash
  );
}

/**
 * Fail-closed assertion used at stale-command and cross-project boundaries.
 * The message names each mismatched field without echoing any surrounding request payload.
 */
export function assertProjectOperationIdentity(
  expected: unknown,
  actual: unknown,
  label = 'project operation',
): ProjectOperationIdentity {
  const left = canonicalProjectOperationIdentity(expected);
  const right = canonicalProjectOperationIdentity(actual);
  const mismatches: string[] = [];
  if (left.projectId !== right.projectId) mismatches.push('projectId');
  if (left.targetRootIdentity !== right.targetRootIdentity) mismatches.push('targetRootIdentity');
  if (left.projectProfileHash !== right.projectProfileHash) mismatches.push('projectProfileHash');
  if (mismatches.length > 0) {
    throw new ProjectOperationIdentityError(
      'IDENTITY_MISMATCH',
      `${label} identity mismatch in ${mismatches.join(', ')}.`,
    );
  }
  return left;
}


/** Derives the governed identity from one exact durable Project Profile generation. */
export function operationIdentityFromProfileRecord(
  record: ProjectProfileRecord,
): ProjectOperationIdentity {
  return canonicalProjectOperationIdentity({
    projectId: record.profile.projectId,
    targetRootIdentity: record.profile.targetRootIdentity,
    projectProfileHash: record.projectProfileHash,
  });
}

/** Compatibility spelling retained for downstream Batch 4/5 modules. */
export const projectOperationIdentityEquals = projectOperationIdentitiesEqual;
