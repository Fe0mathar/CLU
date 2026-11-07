/**
 * Exact identity of one project's recognition configuration generation.
 *
 * Physical project-state isolation prevents cross-project database reuse; this envelope closes the
 * remaining semantic gap by binding every recognition, cache decision and Navigator stream to the
 * exact Project Profile generation and recognition configuration that produced it.
 */

import { z } from 'zod';

import { hashCanonicalJson, type Sha256 } from './ids.js';
import {
  assertProjectOperationIdentity,
  canonicalProjectOperationIdentity,
  projectOperationIdentityEquals,
  projectOperationIdentitySchema,
  type ProjectOperationIdentity,
} from './projectOperationIdentity.js';
import { sha256Schema } from './schemas.js';
import { assertNoSecretMaterial } from './secretSafety.js';

export const PROJECT_RECOGNITION_IDENTITY_VERSION =
  'clue-project-recognition-identity/1' as const;

export const projectRecognitionIdentitySchema = z
  .object({
    identityVersion: z.literal(PROJECT_RECOGNITION_IDENTITY_VERSION),
    operationIdentity: projectOperationIdentitySchema,
    profileGeneration: z.number().int().positive(),
    recognitionConfigHash: sha256Schema,
  })
  .strict();

export type ProjectRecognitionIdentity = z.infer<typeof projectRecognitionIdentitySchema>;

export type ProjectRecognitionIdentityErrorCode =
  | 'PROJECT_RECOGNITION_IDENTITY_INVALID'
  | 'PROJECT_RECOGNITION_IDENTITY_MISMATCH';

export class ProjectRecognitionIdentityError extends Error {
  public readonly code: ProjectRecognitionIdentityErrorCode;
  public readonly expected: ProjectRecognitionIdentity | null;
  public readonly actual: ProjectRecognitionIdentity | null;

  public constructor(
    code: ProjectRecognitionIdentityErrorCode,
    message: string,
    expected: ProjectRecognitionIdentity | null = null,
    actual: ProjectRecognitionIdentity | null = null,
  ) {
    super(message);
    this.name = 'ProjectRecognitionIdentityError';
    this.code = code;
    this.expected = expected;
    this.actual = actual;
  }
}

export function canonicalProjectRecognitionIdentity(input: unknown): ProjectRecognitionIdentity {
  try {
    assertNoSecretMaterial(input, 'project recognition identity');
    const parsed = projectRecognitionIdentitySchema.parse(input);
    return Object.freeze({
      identityVersion: PROJECT_RECOGNITION_IDENTITY_VERSION,
      operationIdentity: canonicalProjectOperationIdentity(parsed.operationIdentity),
      profileGeneration: parsed.profileGeneration,
      recognitionConfigHash: parsed.recognitionConfigHash,
    });
  } catch (error) {
    if (error instanceof ProjectRecognitionIdentityError) throw error;
    throw new ProjectRecognitionIdentityError(
      'PROJECT_RECOGNITION_IDENTITY_INVALID',
      `invalid project recognition identity: ${errorMessage(error)}`,
    );
  }
}

export function projectRecognitionIdentityEquals(
  left: ProjectRecognitionIdentity,
  right: ProjectRecognitionIdentity,
): boolean {
  return (
    projectOperationIdentityEquals(left.operationIdentity, right.operationIdentity) &&
    left.profileGeneration === right.profileGeneration &&
    left.recognitionConfigHash === right.recognitionConfigHash
  );
}

/** Deterministic cache/stream key; secrets are structurally forbidden by the schema. */
export function projectRecognitionIdentityHash(input: ProjectRecognitionIdentity): Sha256 {
  return hashCanonicalJson(canonicalProjectRecognitionIdentity(input));
}

export function assertProjectRecognitionIdentity(
  expectedInput: ProjectRecognitionIdentity,
  actualInput: unknown,
  context: string,
): ProjectRecognitionIdentity {
  const expected = canonicalProjectRecognitionIdentity(expectedInput);
  const actual = canonicalProjectRecognitionIdentity(actualInput);
  if (projectRecognitionIdentityEquals(expected, actual)) return actual;

  const fields: string[] = [];
  try {
    assertProjectOperationIdentity(
      expected.operationIdentity,
      actual.operationIdentity,
      `${context} operation identity`,
    );
  } catch {
    fields.push('operationIdentity');
  }
  if (expected.profileGeneration !== actual.profileGeneration) fields.push('profileGeneration');
  if (expected.recognitionConfigHash !== actual.recognitionConfigHash) {
    fields.push('recognitionConfigHash');
  }

  throw new ProjectRecognitionIdentityError(
    'PROJECT_RECOGNITION_IDENTITY_MISMATCH',
    `${context}: project recognition identity mismatch in ${fields.join(', ')}`,
    expected,
    actual,
  );
}

export function operationIdentityOfRecognition(
  identity: ProjectRecognitionIdentity,
): ProjectOperationIdentity {
  return canonicalProjectOperationIdentity(identity.operationIdentity);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
