/**
 * P2 phase-boundary policy.
 *
 * This file is mission-bound by `MissionRegistry`. It records the Creator's D4 gateway
 * and D5 remote registration decisions and the two explicitly post-P2 capabilities. The policy does
 * not activate a provider, ratify documents, seal an epoch, or issue a verdict; it only makes phase scope
 * machine-readable so the cycle lock and closure assessment cannot disagree.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { hashBytes } from '../shared/ids.js';

export const P2_CLOSURE_POLICY_PATH = 'config/policies/p2-closure.yaml' as const;
export const P2_OPENAI_MODEL = 'gpt-5.6-sol' as const;
export const P2_EXACT_OPENAI_MODELS = [P2_OPENAI_MODEL, 'gpt-6-astra'] as const;

export const p2GatewayDecisionSchema = z.enum([
  'PENDING_CREATOR_DECISION',
  'SAFE_DISABLED_DEFERRED',
  'OPERATIONAL',
]);

export const p2ClosurePolicySchema = z
  .object({
    version: z.literal(1),
    phase: z.literal('P2'),
    gateway: z
      .object({
        decision: p2GatewayDecisionSchema,
        decision_id: z.string().min(1).nullable(),
        recorded_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
        recorded_by: z.literal('creator').nullable(),
        reason: z.string().min(1),
        /** Exact Creator-approved provider model; no implicit fallback is allowed. */
        model: z.enum(['gpt-5.6', ...P2_EXACT_OPENAI_MODELS]).nullable().default(null),
        /** Billing/credit authority is external; CLU-E never invents a provider balance. */
        budget_authority: z.enum(['OPENAI_PLATFORM', 'CLU_E']).nullable().default(null),
        local_budget_enforced: z.boolean().nullable().default(null),
        provider_exhaustion_action: z.enum(['CONTROLLED_PAUSE']).nullable().default(null),
        remaining_token_authority: z.enum(['PROVIDER_ONLY']).nullable().default(null),
      })
      .strict(),
    // Legacy policies without D5 retain the original local-only closure rule.
    publication: z
      .object({
        decision: z.enum(['NO_REMOTE_YET', 'REMOTE_REGISTERED']),
        decision_id: z.string().min(1),
        recorded_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        recorded_by: z.literal('creator'),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
    p3_deferrals: z
      .object({
        project_intent_model: z.literal(true),
        environment_adapters: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.gateway.decision === 'PENDING_CREATOR_DECISION') {
      if (
        value.gateway.decision_id !== null ||
        value.gateway.recorded_at !== null ||
        value.gateway.recorded_by !== null ||
        value.gateway.model !== null ||
        value.gateway.budget_authority !== null ||
        value.gateway.local_budget_enforced !== null ||
        value.gateway.provider_exhaustion_action !== null ||
        value.gateway.remaining_token_authority !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gateway'],
          message: 'a pending gateway decision cannot carry Creator decision identity',
        });
      }
      return;
    }
    if (
      value.gateway.decision_id === null ||
      value.gateway.recorded_at === null ||
      value.gateway.recorded_by !== 'creator'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gateway'],
        message: 'a closed gateway decision needs decision_id, recorded_at and recorded_by: creator',
      });
    }
    if (value.gateway.decision === 'OPERATIONAL') {
      if (
        value.gateway.model === null ||
        value.gateway.budget_authority !== 'OPENAI_PLATFORM' ||
        value.gateway.local_budget_enforced !== false ||
        value.gateway.provider_exhaustion_action !== 'CONTROLLED_PAUSE' ||
        value.gateway.remaining_token_authority !== 'PROVIDER_ONLY'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gateway'],
          message:
            'OPERATIONAL requires exact model, OPENAI_PLATFORM budget authority, no local budget, ' +
            'CONTROLLED_PAUSE and PROVIDER_ONLY remaining-token authority',
        });
      }
    }
  });

export type P2ClosurePolicy = z.infer<typeof p2ClosurePolicySchema>;

export function matchesP2Publication(
  expected: NonNullable<P2ClosurePolicy['publication']>['decision'],
  observed: { readonly decision: string | null; readonly localOnly: boolean; readonly publicationPermitted: boolean },
): boolean {
  return observed.decision === expected && observed.localOnly === (expected === 'NO_REMOTE_YET') &&
    observed.publicationPermitted === false;
}

function parsePolicy(bytes: Buffer): P2ClosurePolicy {
  const parsed = p2ClosurePolicySchema.safeParse(parseYaml(bytes.toString('utf8')));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${P2_CLOSURE_POLICY_PATH} is invalid: ${detail}`);
  }
  return parsed.data;
}

/** Required read used by the closure assessment. */
export function readP2ClosurePolicy(repoRoot: string): {
  readonly policy: P2ClosurePolicy;
  readonly sha256: string;
} {
  const path = join(repoRoot, ...P2_CLOSURE_POLICY_PATH.split('/'));
  if (!existsSync(path)) throw new Error(`${P2_CLOSURE_POLICY_PATH} is missing.`);
  const bytes = readFileSync(path);
  return { policy: parsePolicy(bytes), sha256: hashBytes(bytes) };
}

/**
 * Optional compatibility read used by the cycle lock. Old installations without the
 * phase policy retain the pre-ZIP-08 absence semantics; a present but malformed file is
 * refused rather than silently ignored.
 */
export function tryReadP2ClosurePolicy(repoRoot: string): {
  readonly policy: P2ClosurePolicy;
  readonly sha256: string;
} | null {
  const path = join(repoRoot, ...P2_CLOSURE_POLICY_PATH.split('/'));
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return { policy: parsePolicy(bytes), sha256: hashBytes(bytes) };
}
