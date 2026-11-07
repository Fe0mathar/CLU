/** Deterministic Project Profile identity. */

import { hashCanonicalJson, type Sha256 } from '../../shared/ids.js';
import {
  PROJECT_PROFILE_HASH_VERSION,
  projectProfileHashSchema,
  type ProjectProfile,
  type ProjectProfileRecord,
} from '../../shared/schemas.js';
import {
  canonicalizeProjectProfile,
  canonicalProjectProfileHashInput,
  type ProjectProfileCanonicalizationOptions,
} from './profileCanonicalization.js';

export type ProjectProfileHash = string & { readonly __brand: 'ProjectProfileHash' };
export type ProjectAuthorityHash = Sha256 & { readonly __brand: 'ProjectAuthorityHash' };

export function computeProjectProfileHash(
  input: unknown,
  _options: ProjectProfileCanonicalizationOptions = {},
): ProjectProfileHash {
  const digest = hashCanonicalJson({
    hashVersion: PROJECT_PROFILE_HASH_VERSION,
    profile: canonicalProjectProfileHashInput(input),
  });
  return projectProfileHashSchema.parse(
    `${PROJECT_PROFILE_HASH_VERSION}:${digest}`,
  ) as ProjectProfileHash;
}

export function profileHashMatches(record: ProjectProfileRecord): boolean {
  return computeProjectProfileHash(record.profile) === record.projectProfileHash;
}

export function assertProjectProfileHash(record: ProjectProfileRecord, context: string): void {
  const actual = computeProjectProfileHash(record.profile);
  if (actual !== record.projectProfileHash) {
    throw new ProjectProfileHashError(
      `${context}: stored projectProfileHash ${record.projectProfileHash} does not match ${actual}`,
    );
  }
}

export function canonicalProfileWithHash(input: unknown): {
  readonly profile: ProjectProfile;
  readonly projectProfileHash: ProjectProfileHash;
} {
  const profile = canonicalizeProjectProfile(input);
  return { profile, projectProfileHash: computeProjectProfileHash(profile) };
}

export const PROJECT_AUTHORITY_HASH_VERSION = 'clue-project-authority-hash/1' as const;
export const PROJECT_RECOGNITION_HASH_VERSION = 'clue-project-recognition-hash/1' as const;
export const PROJECT_BENCHMARK_RUNTIME_HASH_VERSION =
  'clue-project-benchmark-runtime-hash/1' as const;

/** Active Project Authority identity. Disabled documents remain profile state but not active law. */
export function computeProjectAuthorityHash(input: unknown): ProjectAuthorityHash {
  const profile = canonicalizeProjectProfile(input);
  const document = (value: Record<string, unknown> | null): unknown => {
    if (value === null || value['enabled'] !== true) return null;
    const { lastValidated: _lastValidated, validationState: _validationState, path: _path, ...basis } = value;
    return basis;
  };
  return hashCanonicalJson({
    hashVersion: PROJECT_AUTHORITY_HASH_VERSION,
    projectId: profile.projectId,
    targetRootIdentity: profile.targetRootIdentity,
    authority: {
      targetDescription: document(profile.authority.targetDescription),
      masterBenchmark: document(profile.authority.masterBenchmark),
      projectIntent: document(profile.authority.projectIntent),
      additionalDocuments: profile.authority.additionalDocuments
        .filter((entry) => entry.enabled)
        .map((entry) => document(entry)),
    },
  }) as ProjectAuthorityHash;
}

export function computeProjectRecognitionHash(input: unknown): Sha256 {
  const profile = canonicalizeProjectProfile(input);
  return hashCanonicalJson({
    hashVersion: PROJECT_RECOGNITION_HASH_VERSION,
    projectId: profile.projectId,
    targetRootIdentity: profile.targetRootIdentity,
    recognition: profile.recognition,
  });
}

export function computeProjectBenchmarkRuntimeHash(input: unknown): Sha256 {
  const profile = canonicalizeProjectProfile(input);
  return hashCanonicalJson({
    hashVersion: PROJECT_BENCHMARK_RUNTIME_HASH_VERSION,
    projectId: profile.projectId,
    targetRootIdentity: profile.targetRootIdentity,
    benchmarkRuntime: profile.benchmarkRuntime,
  });
}

export class ProjectProfileHashError extends Error {
  public readonly code = 'PROJECT_PROFILE_HASH_MISMATCH' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'ProjectProfileHashError';
  }
}
