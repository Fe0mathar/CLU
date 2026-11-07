/** Deterministic structural/declared authority conflict policy. */

import { z } from 'zod';

import { hashCanonicalJson, type Sha256 } from '../../shared/ids.js';
import { projectIdSchema, sha256Schema } from '../../shared/schemas.js';
import type { ProjectAuthoritySnapshot } from './projectAuthority.js';

export const authorityConflictRecordSchema = z
  .object({
    conflictVersion: z.literal('clue-authority-conflict/1'),
    conflictId: z.string().min(1).max(128),
    projectId: projectIdSchema,
    authorityHash: sha256Schema,
    kind: z.enum(['structural', 'semantic-declared']),
    description: z.string().min(1),
    bindingIds: z.array(z.string().min(1)).min(1),
    detectedAt: z.string().datetime({ offset: true }),
    resolution: z
      .object({
        resolutionId: z.string().min(1),
        resolvedAt: z.string().datetime({ offset: true }),
        resolvedBy: z.string().min(1),
        statement: z.string().min(1),
        successorAuthorityHash: sha256Schema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type AuthorityConflictRecord = z.infer<typeof authorityConflictRecordSchema>;

export interface AuthorityConflictAssessment {
  readonly state: 'CLEAR' | 'AUTHORITY CONFLICT';
  readonly assessmentHash: Sha256;
  readonly structuralReasons: readonly string[];
  readonly unresolved: readonly AuthorityConflictRecord[];
  readonly staleResolutions: readonly AuthorityConflictRecord[];
}

export class AuthorityConflictError extends Error {
  public readonly code = 'AUTHORITY_CONFLICT' as const;
  public readonly assessment: AuthorityConflictAssessment;

  public constructor(assessment: AuthorityConflictAssessment) {
    super(
      `AUTHORITY CONFLICT: ${[
        ...assessment.structuralReasons,
        ...assessment.unresolved.map((record) => record.description),
        ...assessment.staleResolutions.map((record) => `stale resolution ${record.conflictId}`),
      ].join('; ')}`,
    );
    this.name = 'AuthorityConflictError';
    this.assessment = assessment;
  }
}

export function assessAuthorityConflicts(
  snapshot: ProjectAuthoritySnapshot,
  records: readonly AuthorityConflictRecord[] = [],
): AuthorityConflictAssessment {
  const structuralReasons = structuralConflictReasons(snapshot);
  const authorityHash = snapshot.manifest?.manifestHash ?? snapshot.configuredAuthorityHash;
  const parsed = records.map((record) => authorityConflictRecordSchema.parse(record));
  const relevant = parsed.filter((record) => record.projectId === snapshot.operationIdentity.projectId);
  const unresolved = relevant.filter(
    (record) => record.authorityHash === authorityHash && record.resolution === null,
  );
  // A conflict belongs to the authority generation recorded in record.authorityHash.
  // Even a signed resolution cannot make that same generation current again: the resolution
  // names a successor authority hash, and the system becomes clear only after that successor
  // generation is actually active. This also rejects a forged self-blessing where the
  // successor hash is set equal to the conflicted generation.
  const staleResolutions = relevant.filter(
    (record) => record.authorityHash === authorityHash && record.resolution !== null,
  );
  const body = { structuralReasons, unresolved, staleResolutions };
  return {
    state:
      structuralReasons.length === 0 && unresolved.length === 0 && staleResolutions.length === 0
        ? 'CLEAR'
        : 'AUTHORITY CONFLICT',
    assessmentHash: hashCanonicalJson(body),
    ...body,
  };
}


function structuralConflictReasons(snapshot: ProjectAuthoritySnapshot): string[] {
  const reasons: string[] = [];
  const active = snapshot.documents.filter(
    (document) => document.enabled && document.state === 'CURRENT',
  );

  const byPath = new Map<string, string>();
  const byOrder = new Map<number, string>();
  const distinguished = new Map<string, string>();
  for (const document of active) {
    const pathKey = comparablePath(document.canonicalPath);
    const previousPath = byPath.get(pathKey);
    if (previousPath !== undefined && previousPath !== document.bindingId) {
      reasons.push(
        `canonical authority file ${document.canonicalPath} is bound by both ${previousPath} and ${document.bindingId}`,
      );
    } else {
      byPath.set(pathKey, document.bindingId);
    }

    const previousOrder = byOrder.get(document.order);
    if (previousOrder !== undefined && previousOrder !== document.bindingId) {
      reasons.push(
        `authority order ${document.order} is shared by ${previousOrder} and ${document.bindingId}`,
      );
    } else {
      byOrder.set(document.order, document.bindingId);
    }

    if (document.kind !== 'additional') {
      const previousKind = distinguished.get(document.kind);
      if (previousKind !== undefined && previousKind !== document.bindingId) {
        reasons.push(
          `distinguished authority kind ${document.kind} is bound by both ${previousKind} and ${document.bindingId}`,
        );
      } else {
        distinguished.set(document.kind, document.bindingId);
      }
    }
  }
  return reasons.sort((left, right) => left.localeCompare(right));
}

function comparablePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/').normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function requireAuthorityConflictClear(assessment: AuthorityConflictAssessment): void {
  if (assessment.state !== 'CLEAR') throw new AuthorityConflictError(assessment);
}
