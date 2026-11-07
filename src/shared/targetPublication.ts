/**
 * Target publication decision — the one pure owner of what `project.remote` means.
 *
 * DEV-P2-04 may close in either of two explicit Creator states:
 *
 * - `NO_REMOTE_YET`: publication is intentionally deferred; Git identity stays local-only.
 * - `REMOTE_REGISTERED`: a credential-free remote identity is recorded, but recording it
 *   still grants no push or landing authority.
 *
 * Legacy profiles resolve to `UNRECORDED`, which is deliberately different from
 * `NO_REMOTE_YET`. A nullable remote alone cannot preserve that distinction because old
 * configurations default the field to null. The decision record is therefore first-class,
 * mission-governed profile data.
 *
 * This module is pure. It performs no I/O and never reads a credential value.
 */

import { z } from 'zod';

export const TARGET_REMOTE_DECISIONS = [
  'UNRECORDED',
  'NO_REMOTE_YET',
  'REMOTE_REGISTERED',
] as const;

export type TargetRemoteDecision = (typeof TARGET_REMOTE_DECISIONS)[number];

const stableDecisionIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/u, 'decision_id must be a stable uppercase identifier');

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'recorded_at must be YYYY-MM-DD');

/** Mission-governed profile record. YAML uses this snake_case shape verbatim. */
export const targetRemoteDecisionRecordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('UNRECORDED') }).strict(),
  z
    .object({
      state: z.literal('NO_REMOTE_YET'),
      decision_id: stableDecisionIdSchema,
      recorded_at: dateSchema,
      recorded_by: z.literal('creator'),
      reason: z.string().min(10).max(500),
    })
    .strict(),
  z
    .object({
      state: z.literal('REMOTE_REGISTERED'),
      decision_id: stableDecisionIdSchema,
      recorded_at: dateSchema,
      recorded_by: z.literal('creator'),
      reason: z.string().min(10).max(500),
    })
    .strict(),
]);

export type TargetRemoteDecisionRecord = z.infer<typeof targetRemoteDecisionRecordSchema>;

export const UNRECORDED_TARGET_REMOTE_DECISION: TargetRemoteDecisionRecord = {
  state: 'UNRECORDED',
};

/** Status/diagnostic view. It contains names and identities only, never a credential value. */
const publicationCommon = {
  gitLifecycleImplemented: z.literal(false),
  publicationPermitted: z.literal(false),
  reason: z.string().min(1),
} as const;

export const targetPublicationStateSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('UNRECORDED'),
      decisionId: z.null(),
      recordedAt: z.null(),
      recordedBy: z.null(),
      remote: z.null(),
      credentialEnv: z.null(),
      localOnly: z.literal(true),
      ...publicationCommon,
    })
    .strict(),
  z
    .object({
      decision: z.literal('NO_REMOTE_YET'),
      decisionId: stableDecisionIdSchema,
      recordedAt: dateSchema,
      recordedBy: z.literal('creator'),
      remote: z.null(),
      credentialEnv: z.null(),
      localOnly: z.literal(true),
      ...publicationCommon,
    })
    .strict(),
  z
    .object({
      decision: z.literal('REMOTE_REGISTERED'),
      decisionId: stableDecisionIdSchema,
      recordedAt: dateSchema,
      recordedBy: z.literal('creator'),
      remote: z.string().min(1),
      credentialEnv: z.string().min(1).nullable(),
      localOnly: z.literal(false),
      ...publicationCommon,
    })
    .strict(),
]);

export type TargetPublicationState = z.infer<typeof targetPublicationStateSchema>;

/**
 * Cross-field configuration problem, when one exists.
 *
 * A credential reference without a remote has no subject and is refused. `NO_REMOTE_YET`
 * requires the explicit null/null pair. A registered remote requires a matching explicit
 * decision; a legacy `UNRECORDED` profile may not silently carry publication identity.
 *
 * A remote without `credential_env` remains valid because Git may use a host credential
 * helper or SSH agent. That does not grant publication authority and no secret is persisted.
 */
export function targetPublicationProblem(
  remote: string | null,
  credentialEnv: string | null,
  decision: TargetRemoteDecisionRecord,
): string | null {
  if (remote === null && credentialEnv !== null) {
    return 'credential_env requires a registered project.remote';
  }

  switch (decision.state) {
    case 'UNRECORDED':
      if (remote !== null || credentialEnv !== null) {
        return 'a remote or credential reference requires an explicit Creator remote_decision';
      }
      return null;

    case 'NO_REMOTE_YET':
      if (remote !== null || credentialEnv !== null) {
        return 'NO_REMOTE_YET requires remote: null and credential_env: null';
      }
      return null;

    case 'REMOTE_REGISTERED':
      if (remote === null) {
        return 'REMOTE_REGISTERED requires a credential-free project.remote';
      }
      return null;
  }
}

/** Derives the sealed Status/diagnostic view from validated profile fields. */
export function describeTargetPublication(
  remote: string | null,
  credentialEnv: string | null,
  decision: TargetRemoteDecisionRecord,
): TargetPublicationState {
  const problem = targetPublicationProblem(remote, credentialEnv, decision);
  if (problem !== null) throw new Error(problem);

  if (decision.state === 'UNRECORDED') {
    return {
      decision: 'UNRECORDED',
      decisionId: null,
      recordedAt: null,
      recordedBy: null,
      remote: null,
      credentialEnv: null,
      gitLifecycleImplemented: false,
      publicationPermitted: false,
      localOnly: true,
      reason:
        'no Creator publication decision is recorded; DEV-P2-04 remains open until the profile records NO_REMOTE_YET or REMOTE_REGISTERED',
    };
  }

  if (decision.state === 'NO_REMOTE_YET') {
    return {
      decision: decision.state,
      decisionId: decision.decision_id,
      recordedAt: decision.recorded_at,
      recordedBy: decision.recorded_by,
      remote: null,
      credentialEnv: null,
      gitLifecycleImplemented: false,
      publicationPermitted: false,
      localOnly: true,
      reason: decision.reason,
    };
  }

  if (remote === null) {
    throw new Error('REMOTE_REGISTERED requires a credential-free project.remote');
  }

  return {
    decision: decision.state,
    decisionId: decision.decision_id,
    recordedAt: decision.recorded_at,
    recordedBy: decision.recorded_by,
    remote,
    credentialEnv,
    gitLifecycleImplemented: false,
    publicationPermitted: false,
    localOnly: false,
    reason: decision.reason,
  };
}
