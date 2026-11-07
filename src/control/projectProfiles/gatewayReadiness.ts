/** Project-scoped GPT/OpenAI readiness with credential-reference and exact-model safety. */

import {
  OpenAiGatewayError,
  OpenAiResponsesAdapter,
  type GatewayFetch,
} from '../../ai/gateway/openaiAdapter.js';
import { assessGatewayPolicy, bindProjectGatewayModel, type LoadedGatewayPolicies } from '../../ai/gateway/policy.js';
import {
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import {
  projectProfileRecordSchema,
  type ClueConfig,
  type ProjectProfileRecord,
} from '../../shared/schemas.js';
import {
  assertNoSecretMaterial,
  isCredentialReference,
  redactSecretText,
} from '../../shared/secretSafety.js';
import { assertProjectProfileHash } from './profileHash.js';

export const PROJECT_GATEWAY_READINESS_STATES = [
  'READY',
  'DISABLED',
  'INCOMPLETE',
  'CREDENTIAL MISSING',
  'CREDENTIAL STORE UNAVAILABLE',
  'POLICY MISMATCH',
  'MODEL UNAVAILABLE',
  'PROVIDER UNREACHABLE',
  'CONTROLLED PAUSE',
] as const;
export type ProjectGatewayReadinessState =
  (typeof PROJECT_GATEWAY_READINESS_STATES)[number];

export interface ProjectGatewayReadiness {
  readonly state: ProjectGatewayReadinessState;
  readonly ready: boolean;
  readonly code: string;
  readonly detail: string;
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly provider: 'openai';
  readonly requestedModel: string | null;
  readonly effectiveModel: string | null;
  readonly fallbackPolicy: 'FORBID';
  readonly fallbackUsed: false;
  readonly credentialReference: string | null;
  readonly credentialPresent: boolean;
  readonly providerReachable: boolean;
  readonly providerState: 'ready' | 'unknown' | 'paused_budget';
  readonly providerPauseReason: string | null;
  readonly spendAuthority: 'clue' | 'openai_platform';
  readonly localBudgetEnforced: boolean;
  readonly checkedAt: string;
}

export interface ProjectGatewayReadinessOptions {
  /** Installation default used when the Project Profile inherits its credential setting. */
  readonly globalCredentialReference: string | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly checkedAt?: string;
  readonly providerState?: 'ready' | 'unknown' | 'paused_budget';
  readonly providerPauseReason?: string | null;
  readonly fetchImpl?: GatewayFetch;
  /** Optional OS credential-store resolver. It must return bytes in memory only. */
  readonly resolveCredentialReference?: (reference: string) => Promise<string | null>;
  /** Test/adapter seam. The returned id must equal the requested model exactly. */
  readonly probeModel?: (input: {
    readonly model: string;
    readonly credential: string;
  }) => Promise<{ readonly id: string }>;
}

export async function testProjectGatewayReadiness(
  recordInput: ProjectProfileRecord,
  config: ClueConfig,
  policies: LoadedGatewayPolicies,
  options: ProjectGatewayReadinessOptions,
): Promise<ProjectGatewayReadiness> {
  const record = projectProfileRecordSchema.parse(recordInput);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  const identity = operationIdentityFromProfileRecord(record);
  const profileGpt = record.profile.integrations.gpt;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const providerState = options.providerState ?? 'unknown';
  const pauseReason = options.providerPauseReason ?? null;
  const reference =
    profileGpt.credential.source === 'project-override'
      ? profileGpt.credential.value
      : options.globalCredentialReference;

  const base = {
    projectIdentity: identity,
    profileGeneration: record.generation,
    provider: profileGpt.provider,
    requestedModel: profileGpt.modelId,
    fallbackPolicy: profileGpt.fallbackPolicy,
    credentialReference: reference,
    providerState,
    providerPauseReason: pauseReason,
    spendAuthority: policies.budget.spend_authority,
    localBudgetEnforced: policies.budget.spend_authority === 'clue',
    checkedAt,
  } as const;

  if (!profileGpt.enabled || !config.gateway.enabled) {
    return output(
      'DISABLED',
      false,
      'GATEWAY_DISABLED',
      'GPT/Model Gateway is disabled by the Project Profile or installation policy.',
      base,
      null,
      false,
      false,
    );
  }
  if (profileGpt.modelId === null) {
    return output(
      'INCOMPLETE',
      false,
      'GATEWAY_MODEL_MISSING',
      'The Project Profile does not name one exact model.',
      base,
      null,
      false,
      false,
    );
  }
  if (profileGpt.fallbackPolicy !== 'FORBID') {
    return output(
      'POLICY MISMATCH',
      false,
      'GATEWAY_FALLBACK_POLICY_INVALID',
      'Project Profiles must forbid silent model fallback.',
      base,
      null,
      false,
      false,
    );
  }
  if (reference === null || !isCredentialReference(reference)) {
    return output(
      'CREDENTIAL MISSING',
      false,
      'GATEWAY_CREDENTIAL_REFERENCE_MISSING',
      'No approved credential reference is configured.',
      base,
      null,
      false,
      false,
    );
  }
  if (policies.budget.spend_authority !== 'openai_platform') {
    return output(
      'POLICY MISMATCH',
      false,
      'GATEWAY_BUDGET_AUTHORITY_MISMATCH',
      'OpenAI Platform must remain the sole monetary budget authority for this governed gateway policy.',
      base,
      null,
      false,
      false,
    );
  }

  let effectivePolicies: LoadedGatewayPolicies;
  try {
    effectivePolicies = bindProjectGatewayModel(policies, profileGpt.modelId);
    const assessment = assessGatewayPolicy(config, effectivePolicies, options.environment ?? process.env, {
      checkInstallationCredential: false,
    });
    if (assessment.problems.length > 0) throw new Error(assessment.problems.join('; '));
  } catch (error) {
    return output(
      'POLICY MISMATCH',
      false,
      'GATEWAY_POLICY_MISMATCH',
      sanitizedError(error),
      base,
      null,
      false,
      false,
    );
  }
  const credential = await resolveProjectGatewayCredential(reference, options);
  if (credential === null || credential.trim().length < 8) {
    const state = reference.startsWith('credential-store:')
      ? 'CREDENTIAL STORE UNAVAILABLE'
      : 'CREDENTIAL MISSING';
    return output(
      state,
      false,
      state === 'CREDENTIAL STORE UNAVAILABLE'
        ? 'GATEWAY_CREDENTIAL_STORE_UNAVAILABLE'
        : 'GATEWAY_CREDENTIAL_MISSING',
      `${reference} is configured but no credential bytes are available to the runtime.`,
      base,
      null,
      false,
      false,
    );
  }

  if (providerState === 'paused_budget') {
    return output(
      'CONTROLLED PAUSE',
      false,
      'PROVIDER_BUDGET_PAUSED',
      pauseReason ?? 'OpenAI Platform funding/billing authority paused new submissions.',
      base,
      null,
      true,
      false,
    );
  }

  const reachableBase = Object.freeze({
    ...base,
    providerState: 'ready' as const,
    providerPauseReason: null,
  });
  const unreachableBase = Object.freeze({
    ...base,
    providerState: 'unknown' as const,
    providerPauseReason: null,
  });

  let effectiveModel: string;
  try {
    const probe = options.probeModel ?? (async (input) => {
      const adapter = new OpenAiResponsesAdapter({
        apiKey: input.credential,
        routing: effectivePolicies.routing,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      return adapter.probeModel(input.model);
    });
    const result = await probe({ model: profileGpt.modelId, credential });
    effectiveModel = result.id;
  } catch (error) {
    const modelFailure = error instanceof OpenAiGatewayError &&
      (error.code === 'PROVIDER_MODEL_ID_MISMATCH' || error.code === 'PROVIDER_RESPONSE_INVALID');
    return output(
      modelFailure ? 'MODEL UNAVAILABLE' : 'PROVIDER UNREACHABLE',
      false,
      modelFailure ? 'GATEWAY_MODEL_UNAVAILABLE' : 'GATEWAY_PROVIDER_UNREACHABLE',
      sanitizedError(error, [credential]),
      modelFailure ? reachableBase : unreachableBase,
      null,
      true,
      modelFailure,
    );
  } finally {
    // Credential bytes are intentionally kept in one local binding only. JavaScript cannot
    // guarantee zeroisation, but the value is never copied into the returned/public record.
  }

  if (effectiveModel !== profileGpt.modelId) {
    return output(
      'MODEL UNAVAILABLE',
      false,
      'GATEWAY_MODEL_ID_MISMATCH',
      `Provider returned model ${effectiveModel}; exact requested model is ${profileGpt.modelId}.`,
      reachableBase,
      effectiveModel,
      true,
      true,
    );
  }

  return output(
    'READY',
    true,
    'GATEWAY_READY',
    `OpenAI provider and exact model ${profileGpt.modelId} are ready with no fallback.`,
    reachableBase,
    effectiveModel,
    true,
    true,
  );
}

export async function resolveProjectGatewayCredential(
  reference: string,
  options: Pick<ProjectGatewayReadinessOptions, 'environment' | 'resolveCredentialReference'>,
): Promise<string | null> {
  if (reference.startsWith('env:')) {
    const name = reference.slice('env:'.length);
    const value = (options.environment ?? process.env)[name];
    return typeof value === 'string' ? value.trim() : null;
  }
  if (reference.startsWith('credential-store:')) {
    return options.resolveCredentialReference === undefined
      ? null
      : options.resolveCredentialReference(reference);
  }
  return null;
}

function output(
  state: ProjectGatewayReadinessState,
  ready: boolean,
  code: string,
  detail: string,
  base: {
    readonly projectIdentity: ProjectOperationIdentity;
    readonly profileGeneration: number;
    readonly provider: 'openai';
    readonly requestedModel: string | null;
    readonly fallbackPolicy: 'FORBID';
    readonly credentialReference: string | null;
    readonly providerState: 'ready' | 'unknown' | 'paused_budget';
    readonly providerPauseReason: string | null;
    readonly spendAuthority: 'clue' | 'openai_platform';
    readonly localBudgetEnforced: boolean;
    readonly checkedAt: string;
  },
  effectiveModel: string | null,
  credentialPresent: boolean,
  providerReachable: boolean,
): ProjectGatewayReadiness {
  const value: ProjectGatewayReadiness = Object.freeze({
    state,
    ready,
    code,
    detail,
    ...base,
    effectiveModel,
    fallbackUsed: false,
    credentialPresent,
    providerReachable,
  });
  assertNoSecretMaterial(value, 'Project Gateway readiness');
  return value;
}

function sanitizedError(error: unknown, secrets: readonly string[] = []): string {
  const raw = error instanceof OpenAiGatewayError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  let exactRedacted = raw;
  for (const secret of secrets) {
    if (secret.length > 0) exactRedacted = exactRedacted.split(secret).join('[REDACTED]');
  }
  return redactSecretText(exactRedacted).text;
}
