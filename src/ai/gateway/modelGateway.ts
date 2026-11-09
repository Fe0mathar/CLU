/**
 * CLU-E Model Gateway application service — DEV-P2-09.
 *
 * Authority choreography:
 *   1. a short writer phase validates mission/config/policies/budget and records STARTED/REFUSED;
 *   2. provider I/O runs after the writer lock is released;
 *   3. a second short writer phase records the provider receipt or terminal result.
 *
 * No secret value enters an event, artifact, Status branch, error detail, or request metadata.
 * The configured environment-variable NAME is durable policy; its value exists only in memory.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import { withRuntime, type Runtime } from '../../control/runtime.js';
import {
  hasWindowsOpenAiCredentialReference,
  legacyWindowsOpenAiCredentialReference,
  readWindowsOpenAiCredential,
  windowsOpenAiCredentialReference,
} from '../../control/projectProfiles/windowsOpenAiCredential.js';
import { CycleOrchestrator } from '../../cycle/cycleOrchestrator.js';
import { canonicalJson, hashCanonicalJson, nowIso, requireSha256 } from '../../shared/ids.js';
import {
  assertProjectOperationIdentity,
  canonicalProjectOperationIdentity,
  projectOperationIdentityEquals,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import { parseOrThrow, type ProjectProfileRecord } from '../../shared/schemas.js';
import {
  GATEWAY_EVENT_TYPES,
  gatewayCallIdSchema,
  readGatewayAggregateFacts,
  readGatewayCall,
  readGatewayProviderProjectionState,
  type GatewayCallRecord,
} from './gatewayProjection.js';
import {
  GATEWAY_TASK_TYPES,
  assessGatewayPolicy,
  bindProjectGatewayModel,
  estimateInputTokens,
  loadGatewayPolicies,
  priceForUsage,
  routeForTask,
  type GatewayCallMode,
  type GatewayDegradationAction,
  type GatewayPricing,
  type GatewayTaskType,
  type LoadedGatewayPolicies,
} from './policy.js';
import {
  OpenAiGatewayError,
  OpenAiResponsesAdapter,
  type GatewayFetch,
  type OpenAiBatchReconciliation,
  type OpenAiCompletedResponse,
} from './openaiAdapter.js';

const MAX_REQUEST_FILE_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_CHARS = 2 * 1024 * 1024;
const MAX_INSTRUCTIONS_CHARS = 256 * 1024;

const ZERO_GATEWAY_PRICING: GatewayPricing = Object.freeze({
  input_usd_per_million: 0,
  cached_input_usd_per_million: 0,
  output_usd_per_million: 0,
});

const metadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(512))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 16) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'metadata has more than 16 entries' });
    }
  });

const attributionSchema = z
  .object({
    task_id: z.string().regex(/^TASK-[0-9]{6,}$/u).nullable().default(null),
    experiment_id: z.string().regex(/^EXP-[0-9]{6,}$/u).nullable().default(null),
    finding_id: z.string().regex(/^FIND-[0-9]{6,}$/u).nullable().default(null),
  })
  .strict()
  .default({ task_id: null, experiment_id: null, finding_id: null });

export const gatewayRequestSchema = z
  .object({
    version: z.literal(1),
    task_type: z.enum(GATEWAY_TASK_TYPES),
    input: z.string().min(1).max(MAX_INPUT_CHARS),
    instructions: z.string().min(1).max(MAX_INSTRUCTIONS_CHARS).nullable().default(null),
    metadata: metadataSchema.default({}),
    attribution: attributionSchema,
    /** Optional narrower ceiling; it can only reduce the policy route ceiling. */
    max_output_tokens: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export type GatewayRequest = z.infer<typeof gatewayRequestSchema>;

export interface GatewayPreparedCall {
  readonly callId: string;
  readonly missionVersion: string;
  readonly targetId: string;
  /** Exact Project Profile operation identity; null only for the legacy config-v2 runtime. */
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
  readonly request: GatewayRequest;
  readonly mode: GatewayCallMode;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly pricing: GatewayPricing;
  readonly batchDiscountFraction: number;
  readonly estimatedInputTokens: number;
  readonly estimatedUsd: number;
  readonly policies: LoadedGatewayPolicies;
  /** Sanitized credential reference. Secret bytes remain only in apiKey memory. */
  readonly credentialReference: string;
  readonly apiKey: string;
}

export type GatewayInvocationResult =
  | {
      readonly state: 'refused';
      readonly callId: string;
      readonly code: string;
      readonly reason: string;
    }
  | {
      readonly state: 'completed';
      readonly callId: string;
      readonly outputText: string;
      readonly record: GatewayCallRecord;
    }
  | {
      readonly state: 'batch_pending';
      readonly callId: string;
      readonly providerBatchId: string;
      readonly providerStatus: string;
      readonly record: GatewayCallRecord;
    }
  | {
      readonly state: 'failed';
      readonly callId: string;
      readonly code: string;
      readonly reason: string;
      readonly retryable: boolean;
      readonly record: GatewayCallRecord | null;
    };

export interface GatewayStatus {
  readonly configured: true;
  readonly enabled: boolean;
  readonly provider: 'openai';
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
  readonly credentialReference: string;
  readonly requestedModel: string | null;
  readonly effectiveModel: string | null;
  readonly fallbackUsed: false;
  readonly apiKeyEnv: string;
  readonly apiKeyPresent: boolean;
  readonly operationallyReady: boolean;
  readonly policyProblems: readonly string[];
  readonly budgetHash: string;
  readonly routingHash: string;
  readonly priceScheduleVersion: string;
  readonly enabledRouteCount: number;
  readonly defaultMode: GatewayCallMode;
  readonly model: string | null;
  readonly budgetAuthority: 'clue' | 'openai_platform';
  readonly localBudgetEnforced: boolean;
  readonly localPricingAuthoritative: boolean;
  readonly providerState: 'ready' | 'unknown' | 'paused_budget';
  readonly providerPaused: boolean;
  readonly providerBudgetExhausted: boolean;
  readonly providerPauseReason: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    /** OpenAI does not expose one universal monetary-budget-as-token balance. */
    readonly providerRemainingTokens: number | null;
    readonly providerRemainingTokensAuthoritative: false;
  };
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly refused: number;
  readonly pending: number;
  /** Null when local price estimation is disabled; token usage remains authoritative. */
  readonly todayActualUsd: number | null;
  readonly monthActualUsd: number | null;
  readonly reservedUsd: number | null;
  readonly dailyHardUsd: number;
  readonly monthlyHardUsd: number;
  readonly degradationAction: GatewayDegradationAction | null;
  readonly latest: GatewayCallRecord | null;
}

function newCallId(): string {
  return gatewayCallIdSchema.parse(`GWCALL-${randomBytes(16).toString('hex')}`);
}

function readBoundedJson(pathFromCwd: string, cwd: string): GatewayRequest {
  const path = isAbsolute(pathFromCwd) ? pathFromCwd : resolve(cwd, pathFromCwd);
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_REQUEST_FILE_BYTES) {
    throw new Error(`Gateway request is ${bytes.byteLength} bytes; limit is ${MAX_REQUEST_FILE_BYTES}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(`Gateway request is not strict UTF-8 JSON: ${(error as Error).message}`);
  }
  return parseOrThrow(gatewayRequestSchema, value, 'gateway request');
}

export function loadGatewayRequest(pathFromCwd: string, cwd = process.cwd()): GatewayRequest {
  return readBoundedJson(pathFromCwd, cwd);
}

export interface GatewayProviderState {
  readonly state: 'ready' | 'unknown' | 'paused_budget';
  readonly reason: string | null;
  readonly eventId: string | null;
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
}

/**
 * O(1) provider funding state from the rebuildable SQLite projection. The event log remains
 * authority; gatewayProjection.ts consumes gateway.call_failed/provider_resumed events into
 * this row. Dashboard refresh must never synchronously replay the full event log.
 */
export function readGatewayProviderState(
  projections: Runtime['projections'],
  targetId: string,
): GatewayProviderState {
  return readGatewayProviderProjectionState(projections, targetId);
}

function degradationAction(policies: LoadedGatewayPolicies, spentOrReserved: number): GatewayDegradationAction | null {
  if (policies.budget.spend_authority === 'openai_platform') return null;
  const hard = policies.budget.caps.daily_hard;
  if (hard <= 0) return 'pause_submissions';
  const fraction = spentOrReserved / hard;
  let action: GatewayDegradationAction | null = null;
  for (const step of policies.budget.degradation) {
    if (fraction >= step.at_fraction) action = step.action;
  }
  return action;
}

function resolvedMode(
  policies: LoadedGatewayPolicies,
  taskType: GatewayTaskType,
  configured: GatewayCallMode,
  spentOrReserved: number,
): GatewayCallMode {
  const route = policies.routing.routes[taskType];
  let mode = route.mode ?? configured;
  if (policies.budget.spend_authority === 'openai_platform') return mode;
  const hard = policies.budget.caps.daily_hard;
  const fraction = hard <= 0 ? 1 : spentOrReserved / hard;
  const degrade = degradationAction(policies, spentOrReserved);
  if (
    mode === 'interactive' &&
    (!policies.budget.call_modes.interactive_allowed_tasks.includes(taskType) ||
      fraction >= policies.budget.call_modes.interactive_disabled_above_fraction ||
      degrade === 'frontier_to_batch' ||
      degrade === 'batch_only')
  ) {
    mode = 'batch';
  }
  return mode;
}

export interface GatewayCredentialResolver {
  /** Returns secret bytes in memory only; callers must never log or persist the result. */
  readonly resolve: (reference: string) => string | null;
}

export interface GatewayRuntimeOptions {
  readonly repoRoot?: string;
  readonly projectProfile?: ProjectProfileRecord;
  readonly environment?: NodeJS.ProcessEnv;
  readonly credentialResolver?: GatewayCredentialResolver;
  readonly fetchImpl?: GatewayFetch;
  /** A caller requiring a live reply must never submit a batch as a substitute. */
  readonly requireInteractive?: boolean;
  /** Bind operator context to the exact project/workspace captured by the caller. */
  readonly expectedRuntimeDigest?: string;
}

interface RuntimeGatewayBinding {
  readonly projectId: string | null;
  readonly enabled: boolean;
  readonly requestedModel: string | null;
  readonly credentialReference: string;
  readonly fallbackPolicy: 'FORBID';
}

function runtimeGatewayBinding(runtime: Runtime, environment: NodeJS.ProcessEnv): RuntimeGatewayBinding {
  if (runtime.projectProfile === null) {
    const name = runtime.config.gateway.api_key_env;
    const envValue = environment[name];
    const hasOverride = typeof envValue === 'string' && envValue.trim().length >= 8;
    const savedReference = legacyWindowsOpenAiCredentialReference(runtime.config.project.root, name);
    return {
      projectId: null,
      enabled: runtime.config.gateway.enabled,
      requestedModel: null,
      credentialReference: runtime.config.gateway.enabled && !hasOverride && hasWindowsOpenAiCredentialReference(savedReference)
        ? savedReference : `env:${name}`,
      fallbackPolicy: 'FORBID',
    };
  }
  const setting = runtime.projectProfile.profile.integrations.gpt;
  const inheritedReference = `env:${runtime.config.gateway.api_key_env}`;
  return {
    projectId: runtime.projectProfile.profile.projectId,
    enabled: setting.enabled && runtime.config.gateway.enabled,
    requestedModel: setting.modelId,
    credentialReference:
      setting.credential.source === 'project-override'
        ? setting.credential.value
        : inheritedReference,
    fallbackPolicy: setting.fallbackPolicy,
  };
}

function runtimeGatewayPolicy(runtime: Runtime, environment = process.env): {
  readonly binding: RuntimeGatewayBinding;
  readonly policies: LoadedGatewayPolicies;
  readonly modelProblem: string | null;
} {
  const binding = runtimeGatewayBinding(runtime, environment);
  const policies = loadGatewayPolicies(runtime.repoRoot, runtime.config);
  if (binding.projectId === null || !binding.enabled) return { binding, policies, modelProblem: null };
  if (binding.requestedModel === null) {
    return { binding, policies, modelProblem: 'The Project Profile must select one exact model.' };
  }
  try {
    return { binding, policies: bindProjectGatewayModel(policies, binding.requestedModel), modelProblem: null };
  } catch (error) {
    return { binding, policies, modelProblem: (error as Error).message };
  }
}

function resolveGatewayCredential(
  binding: RuntimeGatewayBinding,
  environment: NodeJS.ProcessEnv,
  resolver?: GatewayCredentialResolver,
): string | null {
  const reference = binding.credentialReference;
  if (reference.startsWith('env:')) {
    const name = reference.slice('env:'.length);
    const value = environment[name];
    return typeof value === 'string' && value.trim().length >= 8 ? value.trim() : null;
  }
  if (reference.startsWith('credential-store:')) {
    // The legacy binding is constructed only from the server's exact target and credential slot.
    const ownWindowsReference = binding.projectId === null || reference === windowsOpenAiCredentialReference(binding.projectId);
    const value = resolver !== undefined ? resolver.resolve(reference)
      : ownWindowsReference ? readWindowsOpenAiCredential(reference) : null;
    return typeof value === 'string' && value.trim().length >= 8 ? value.trim() : null;
  }
  return null;
}

function projectProfileRuntimeOption(options: GatewayRuntimeOptions): {
  readonly projectProfile?: ProjectProfileRecord;
} {
  return options.projectProfile === undefined ? {} : { projectProfile: options.projectProfile };
}

function runtimeProjectContext(runtime: Runtime): {
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
} {
  if (runtime.projectIdentity === null || runtime.projectProfile === null) {
    return { projectIdentity: null, profileGeneration: null };
  }
  return {
    projectIdentity: canonicalProjectOperationIdentity(runtime.projectIdentity),
    profileGeneration: runtime.projectProfile.generation,
  };
}

function providerStateMatchesRuntime(
  runtime: Runtime,
  providerState: GatewayProviderState,
): boolean {
  const context = runtimeProjectContext(runtime);
  if (context.projectIdentity === null || context.profileGeneration === null) {
    return providerState.projectIdentity === null && providerState.profileGeneration === null;
  }
  return (
    providerState.projectIdentity !== null &&
    providerState.profileGeneration === context.profileGeneration &&
    projectOperationIdentityEquals(context.projectIdentity, providerState.projectIdentity)
  );
}

function assertPreparedProjectContext(runtime: Runtime, prepared: GatewayPreparedCall): void {
  if (prepared.projectIdentity === null) return;
  if (runtime.projectIdentity === null || runtime.projectProfile === null) {
    throw new OpenAiGatewayError(
      'PROJECT_IDENTITY_DRIFT',
      'Project Profile identity disappeared while the provider call was in flight.',
    );
  }
  try {
    assertProjectOperationIdentity(
      prepared.projectIdentity,
      runtime.projectIdentity,
      'gateway provider completion',
    );
  } catch (error) {
    throw new OpenAiGatewayError(
      'PROJECT_IDENTITY_DRIFT',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (runtime.projectProfile.generation !== prepared.profileGeneration) {
    throw new OpenAiGatewayError(
      'PROJECT_IDENTITY_DRIFT',
      `Project Profile generation changed from ${String(prepared.profileGeneration)} to ${String(runtime.projectProfile.generation)} while the provider call was in flight.`,
    );
  }
  const { policies, modelProblem } = runtimeGatewayPolicy(runtime);
  if (modelProblem !== null || policies.routingHash !== prepared.policies.routingHash ||
      policies.budgetHash !== prepared.policies.budgetHash) {
    throw new OpenAiGatewayError('GATEWAY_POLICY_DRIFT', 'Gateway routing or budget policy changed while the provider call was in flight.');
  }
}

function refusal(
  runtime: Runtime,
  callId: string,
  request: GatewayRequest,
  policies: LoadedGatewayPolicies,
  code: string,
  reason: string,
): GatewayInvocationResult {
  const log = runtime.requireLog();
  const projectContext = runtimeProjectContext(runtime);
  const route = policies.routing.routes[request.task_type];
  log.append({
    type: GATEWAY_EVENT_TYPES.callRefused,
    missionVersion: runtime.currentMissionId(),
    actor: 'gateway',
    subjectId: null,
    payload: {
      call_id: callId,
      target_id: runtime.config.project.id,
      ...(projectContext.projectIdentity === null
        ? {}
        : {
            project_identity: projectContext.projectIdentity,
            profile_generation: projectContext.profileGeneration,
          }),
      task_type: request.task_type,
      lane: route.lane,
      mode: route.mode,
      model: route.model,
      attribution: request.attribution,
      policy_hash: policies.budgetHash,
      routing_hash: policies.routingHash,
      price_schedule_version: policies.routing.price_schedule_version,
      code,
      reason: runtime.secrets.redact(reason),
      requested_at: nowIso(),
    },
  });
  runtime.projections.sync(log);
  return { state: 'refused', callId, code, reason: runtime.secrets.redact(reason) };
}

function prepareGatewayCall(
  request: GatewayRequest,
  options: GatewayRuntimeOptions = {},
): GatewayPreparedCall | GatewayInvocationResult {
  return withRuntime(
    {
      withLog: true,
      requireMission: true,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
    },
    (runtime) => {
      const callId = newCallId();
      if (options.expectedRuntimeDigest !== undefined && options.expectedRuntimeDigest !== hashCanonicalJson([
        runtime.config.project.root,
        runtime.workspaceRoot,
        runtime.projectBinding?.recognition.identity ?? null,
      ])) {
        return {
          state: 'refused', callId, code: 'DASHBOARD_RUNTIME_CHANGED',
          reason: 'The configured project or workspace changed. Reopen the dashboard and retry.',
        };
      }
      const environment = options.environment ?? process.env;
      const { binding, policies, modelProblem } = runtimeGatewayPolicy(runtime, environment);
      const assessment = assessGatewayPolicy(runtime.config, policies, environment, {
        checkInstallationCredential: runtime.projectProfile === null && binding.credentialReference.startsWith('env:'),
      });
      const projectContext = runtimeProjectContext(runtime);
      const policyProblems = assessment.problems;

      if (!binding.enabled) {
        return refusal(runtime, callId, request, policies, 'GATEWAY_DISABLED', 'The Model Gateway is disabled by installation or Project Profile policy.');
      }
      if (binding.fallbackPolicy !== 'FORBID') {
        return refusal(runtime, callId, request, policies, 'GATEWAY_FALLBACK_FORBIDDEN', 'The Project Profile must forbid silent model fallback.');
      }
      if (modelProblem !== null) {
        return refusal(runtime, callId, request, policies, 'GATEWAY_MODEL_POLICY_MISMATCH', modelProblem);
      }
      if (policyProblems.length > 0) {
        return refusal(runtime, callId, request, policies, 'GATEWAY_POLICY_NOT_READY', policyProblems.join('; '));
      }
      const providerState = readGatewayProviderState(runtime.projections, runtime.config.project.id);
      if (providerState.eventId !== null && !providerStateMatchesRuntime(runtime, providerState)) {
        return refusal(
          runtime,
          callId,
          request,
          policies,
          'PROJECT_IDENTITY_DRIFT',
          'The durable provider state belongs to another Project Profile generation.',
        );
      }
      if (providerState.state === 'paused_budget') {
        return refusal(
          runtime,
          callId,
          request,
          policies,
          'PROVIDER_BUDGET_PAUSED',
          providerState.reason ?? 'OpenAI Platform funding/billing authority paused new submissions.',
        );
      }

      let route: ReturnType<typeof routeForTask>;
      try {
        route = routeForTask(policies, request.task_type);
      } catch (error) {
        return refusal(runtime, callId, request, policies, 'ROUTE_DISABLED', (error as Error).message);
      }
      if (route.model === null) {
        return refusal(runtime, callId, request, policies, 'ROUTE_INCOMPLETE', `Route ${request.task_type} has no model.`);
      }
      const pricing = route.pricing ?? ZERO_GATEWAY_PRICING;

      runtime.secrets.assertClean(request.input, 'gateway request input');
      if (request.instructions !== null) runtime.secrets.assertClean(request.instructions, 'gateway instructions');
      runtime.secrets.assertClean(canonicalJson(request.metadata), 'gateway metadata');

      const aggregate = readGatewayAggregateFacts(
        runtime.projections,
        runtime.config.project.id,
        nowIso(),
      );
      const spentOrReserved = aggregate.todayActualUsd + aggregate.reservedUsd;
      const action = degradationAction(policies, spentOrReserved);
      if (action === 'pause_submissions') {
        return refusal(runtime, callId, request, policies, 'BUDGET_PAUSED', 'The degradation ladder pauses new gateway submissions.');
      }

      const maxOutputTokens = Math.min(
        route.max_output_tokens,
        request.max_output_tokens ?? route.max_output_tokens,
      );
      const estimatedInputTokens = estimateInputTokens(
        `${request.instructions ?? ''}\n${request.input}`,
      );
      const mode = resolvedMode(
        policies,
        request.task_type,
        runtime.config.gateway.default_mode as GatewayCallMode,
        spentOrReserved,
      );
      if (options.requireInteractive === true && mode !== 'interactive') {
        return refusal(runtime, callId, request, policies, 'INTERACTIVE_REQUIRED', 'Gateway policy does not allow an interactive call for this request.');
      }
      const discount = mode === 'batch' ? policies.routing.batch_discount_fraction : 0;
      const estimatedUsd = priceForUsage(
        pricing,
        { inputTokens: estimatedInputTokens, cachedInputTokens: 0, outputTokens: maxOutputTokens },
        discount,
      );

      if (policies.budget.spend_authority === 'clue') {
        const taskBudget = Math.min(
          policies.budget.per_task_budgets[request.task_type],
          policies.budget.caps.per_task_max,
        );
        if (estimatedUsd > taskBudget) {
          return refusal(
            runtime,
            callId,
            request,
            policies,
            'TASK_BUDGET_EXCEEDED',
            `Estimated cost $${estimatedUsd.toFixed(6)} exceeds ${request.task_type} budget $${taskBudget.toFixed(6)}.`,
          );
        }
        if (spentOrReserved + estimatedUsd > policies.budget.caps.daily_hard) {
          return refusal(runtime, callId, request, policies, 'DAILY_HARD_CAP', 'Estimated call would exceed the daily hard cap.');
        }
        if (mode === 'batch') {
          const batchCeiling = policies.budget.caps.daily_hard * (1 - policies.budget.caps.reserve_fraction);
          if (spentOrReserved + estimatedUsd > batchCeiling) {
            return refusal(
              runtime,
              callId,
              request,
              policies,
              'DAILY_RESERVE_HELD',
              'Estimated batch cost would consume the daily reserve held for blocking interactive work.',
            );
          }
        }
        if (aggregate.monthActualUsd + aggregate.reservedUsd + estimatedUsd > policies.budget.caps.monthly_hard) {
          return refusal(runtime, callId, request, policies, 'MONTHLY_HARD_CAP', 'Estimated call would exceed the monthly hard cap.');
        }

      }

      const apiKey = resolveGatewayCredential(
        binding,
        environment,
        options.credentialResolver,
      );
      if (apiKey === null) {
        return refusal(
          runtime,
          callId,
          request,
          policies,
          'API_KEY_MISSING',
          `${binding.credentialReference} is configured but unavailable to the runtime.`,
        );
      }
      if (request.input.includes(apiKey) || request.instructions?.includes(apiKey) ||
          Object.values(request.metadata).some((value) => value.includes(apiKey))) {
        return refusal(runtime, callId, request, policies, 'CREDENTIAL_IN_REQUEST', 'The request contains the configured gateway credential.');
      }

      const requestBody = {
        schema:
          projectContext.projectIdentity === null
            ? 'clue.gateway.request/1'
            : 'clue.gateway.request/2',
        call_id: callId,
        target_id: runtime.config.project.id,
        ...(projectContext.projectIdentity === null
          ? {}
          : {
              project_identity: projectContext.projectIdentity,
              profile_generation: projectContext.profileGeneration,
              policy_hash: policies.budgetHash,
              routing_hash: policies.routingHash,
            }),
        task_type: request.task_type,
        lane: route.lane,
        mode,
        model: route.model,
        credential_reference: binding.credentialReference,
        max_output_tokens: maxOutputTokens,
        input: request.input,
        instructions: request.instructions,
        metadata: request.metadata,
        attribution: request.attribution,
      };
      const artifact = runtime.artifacts.putJson(requestBody, {
        label: `${callId}-request.json`,
        ...(projectContext.projectIdentity === null
          ? {}
          : { operationIdentity: projectContext.projectIdentity }),
      });
      const requestHash = hashCanonicalJson(requestBody);
      const startedAt = nowIso();
      const log = runtime.requireLog();
      log.append({
        type: GATEWAY_EVENT_TYPES.callStarted,
        missionVersion: runtime.currentMissionId(),
        actor: 'gateway',
        subjectId: null,
        payload: {
          call_id: callId,
          target_id: runtime.config.project.id,
          ...(projectContext.projectIdentity === null
            ? {}
            : {
                project_identity: projectContext.projectIdentity,
                profile_generation: projectContext.profileGeneration,
              }),
          task_type: request.task_type,
          lane: route.lane,
          mode,
          model: route.model,
          attribution: request.attribution,
          policy_hash: policies.budgetHash,
          routing_hash: policies.routingHash,
          price_schedule_version: policies.routing.price_schedule_version,
          request_artifact_hash: artifact.hash,
          request_hash: requestHash,
          estimated_input_tokens: estimatedInputTokens,
          max_output_tokens: maxOutputTokens,
          estimated_usd: estimatedUsd,
          pricing: {
            input_usd_per_million: pricing.input_usd_per_million,
            cached_input_usd_per_million: pricing.cached_input_usd_per_million,
            output_usd_per_million: pricing.output_usd_per_million,
            batch_discount_fraction: discount,
          },
          started_at: startedAt,
        },
      });
      runtime.projections.sync(log);

      return {
        callId,
        missionVersion: runtime.currentMissionId(),
        targetId: runtime.config.project.id,
        projectIdentity: projectContext.projectIdentity,
        profileGeneration: projectContext.profileGeneration,
        request,
        mode,
        model: route.model,
        maxOutputTokens,
        pricing,
        batchDiscountFraction: discount,
        estimatedInputTokens,
        estimatedUsd,
        policies,
        credentialReference: binding.credentialReference,
        apiKey,
      };
    },
  );
}

function requireOpenGatewayCall(runtime: Runtime, callId: string): GatewayCallRecord {
  const current = readGatewayCall(runtime.projections, callId);
  if (current === null || (current.state !== 'in_flight' && current.state !== 'batch_pending')) {
    throw new OpenAiGatewayError(
      'GATEWAY_CALL_NOT_OPEN',
      `Gateway call ${callId} is already ${current?.state ?? 'unavailable'}. No duplicate event was recorded.`,
    );
  }
  return current;
}

function recordFailureInRuntime(
  runtime: Runtime,
  prepared: GatewayPreparedCall,
  error: unknown,
  options: {
    readonly providerBatchId?: string | null;
    readonly providerStatus?: string | null;
  } = {},
): GatewayInvocationResult {
  requireOpenGatewayCall(runtime, prepared.callId);
  try {
    assertPreparedProjectContext(runtime, prepared);
  } catch (identityError) {
    error = identityError;
  }
  const provider = error instanceof OpenAiGatewayError ? error : null;
  const code = provider?.code ?? 'GATEWAY_EXECUTION_FAILED';
  const retryable = provider?.retryable ?? false;
  const rawReason = error instanceof Error ? error.message : String(error);
  const exactRedacted = prepared.apiKey.length === 0
    ? rawReason
    : rawReason.split(prepared.apiKey).join('«REDACTED:GATEWAY_CREDENTIAL»');
  const reason = runtime.secrets.redact(exactRedacted);
  const log = runtime.requireLog();
  log.append({
    type: GATEWAY_EVENT_TYPES.callFailed,
    missionVersion: runtime.currentMissionId(),
    actor: 'gateway',
    subjectId: null,
    payload: {
      call_id: prepared.callId,
      target_id: prepared.targetId,
      ...(prepared.projectIdentity === null
        ? {}
        : {
            project_identity: prepared.projectIdentity,
            profile_generation: prepared.profileGeneration,
          }),
      provider_batch_id: options.providerBatchId ?? null,
      provider_status: options.providerStatus ?? null,
      code,
      reason,
      retryable,
      failed_at: nowIso(),
    },
  });

  // An explicit provider billing/funding refusal pauses the live CLU-E cycle as well as
  // future gateway submissions. This is a controlled, durable suspension — never a crash.
  // No cycle is invented merely to represent the provider state.
  if (code === 'PROVIDER_BUDGET_EXHAUSTED') {
    const cycles = new CycleOrchestrator(runtime);
    const current = cycles.status();
    if (current !== null && current.stage !== 'SUSPENDED' && current.stage !== 'CLOSED') {
      cycles.suspend(`OpenAI Platform budget/funding pause: ${reason}`);
    }
  }
  runtime.projections.sync(log);
  return {
    state: 'failed',
    callId: prepared.callId,
    code,
    reason,
    retryable,
    record: readGatewayCall(runtime.projections, prepared.callId),
  };
}

function appendTerminalFailure(
  prepared: GatewayPreparedCall,
  error: unknown,
  options: {
    readonly repoRoot?: string;
    readonly projectProfile?: ProjectProfileRecord;
    readonly providerBatchId?: string | null;
    readonly providerStatus?: string | null;
  } = {},
): GatewayInvocationResult {
  return withRuntime(
    {
      withLog: true,
      requireMission: false,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...(options.projectProfile === undefined ? {} : { projectProfile: options.projectProfile }),
    },
    (runtime) => recordFailureInRuntime(runtime, prepared, error, options),
  );
}

function recordCompleted(
  prepared: GatewayPreparedCall,
  response: OpenAiCompletedResponse,
  raw: unknown,
  options: {
    readonly repoRoot?: string;
    readonly projectProfile?: ProjectProfileRecord;
    readonly providerBatchId?: string | null;
  } = {},
): GatewayInvocationResult {
  return withRuntime(
    {
      withLog: true,
      requireMission: false,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...(options.projectProfile === undefined ? {} : { projectProfile: options.projectProfile }),
    },
    (runtime) => {
      requireOpenGatewayCall(runtime, prepared.callId);
      try {
        assertPreparedProjectContext(runtime, prepared);
      } catch (error) {
        return recordFailureInRuntime(runtime, prepared, error, {
          providerBatchId: options.providerBatchId ?? null,
        });
      }
      if (response.model !== prepared.model) {
        return recordFailureInRuntime(
          runtime,
          prepared,
          new OpenAiGatewayError(
            'PROVIDER_MODEL_ID_MISMATCH',
            `Provider returned model ${response.model}; exact requested model is ${prepared.model}.`,
          ),
          { providerBatchId: options.providerBatchId ?? null },
        );
      }
      if (runtime.currentMissionId() !== prepared.missionVersion) {
        return recordFailureInRuntime(
          runtime,
          prepared,
          new OpenAiGatewayError('MISSION_DRIFT', 'Mission changed while the provider call was in flight.'),
          { providerBatchId: options.providerBatchId ?? null },
        );
      }
      const serialized = canonicalJson(raw);
      if (response.outputText.includes(prepared.apiKey) || serialized.includes(prepared.apiKey)) {
        return recordFailureInRuntime(runtime, prepared, new OpenAiGatewayError(
          'CREDENTIAL_IN_RESPONSE',
          'The provider reply contained a credential and was refused.',
        ));
      }
      runtime.secrets.assertClean(serialized, 'gateway provider response');
      const artifact = runtime.artifacts.putJson(raw, {
        label: `${prepared.callId}-response.json`,
        ...(prepared.projectIdentity === null
          ? {}
          : { operationIdentity: prepared.projectIdentity }),
      });
      const actualUsd = priceForUsage(
        prepared.pricing,
        {
          inputTokens: response.usage.inputTokens,
          cachedInputTokens: response.usage.cachedInputTokens,
          outputTokens: response.usage.outputTokens,
        },
        prepared.batchDiscountFraction,
      );
      const log = runtime.requireLog();
      log.append({
        type: GATEWAY_EVENT_TYPES.callCompleted,
        missionVersion: runtime.currentMissionId(),
        actor: 'gateway',
        subjectId: null,
        payload: {
          call_id: prepared.callId,
          ...(prepared.projectIdentity === null
            ? {}
            : {
                project_identity: prepared.projectIdentity,
                profile_generation: prepared.profileGeneration,
              }),
          provider_request_id: response.providerRequestId,
          provider_batch_id: options.providerBatchId ?? null,
          provider_model: response.model,
          response_artifact_hash: artifact.hash,
          usage: {
            input_tokens: response.usage.inputTokens,
            cached_input_tokens: response.usage.cachedInputTokens,
            output_tokens: response.usage.outputTokens,
            total_tokens: response.usage.totalTokens,
          },
          actual_usd: actualUsd,
          completed_at: nowIso(),
        },
      });
      runtime.projections.sync(log);
      const record = readGatewayCall(runtime.projections, prepared.callId);
      if (record === null) throw new Error(`Gateway completion ${prepared.callId} did not project.`);
      return { state: 'completed', callId: prepared.callId, outputText: response.outputText, record };
    },
  );
}

export async function invokeGateway(
  request: GatewayRequest,
  options: GatewayRuntimeOptions = {},
): Promise<GatewayInvocationResult> {
  const prepared = prepareGatewayCall(request, options);
  if ('state' in prepared) return prepared;
  const adapter = new OpenAiResponsesAdapter({
    apiKey: prepared.apiKey,
    routing: prepared.policies.routing,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  try {
    if (prepared.policies.routing.validate_model_before_use) {
      await adapter.probeModel(prepared.model);
    }
    if (prepared.mode === 'interactive') {
      const response = await adapter.invokeInteractive({
        callId: prepared.callId,
        model: prepared.model,
        input: prepared.request.input,
        instructions: prepared.request.instructions,
        maxOutputTokens: prepared.maxOutputTokens,
        metadata: {
          clue_call_id: prepared.callId,
          target_id: prepared.targetId,
          task_type: prepared.request.task_type,
          ...(prepared.projectIdentity === null
            ? {}
            : {
                clue_project_id: prepared.projectIdentity.projectId,
                clue_profile_hash: prepared.projectIdentity.projectProfileHash,
              }),
          ...prepared.request.metadata,
        },
      });
      return recordCompleted(prepared, response, response.raw, options);
    }
    const submission = await adapter.submitBatch({
      callId: prepared.callId,
      model: prepared.model,
      input: prepared.request.input,
      instructions: prepared.request.instructions,
      maxOutputTokens: prepared.maxOutputTokens,
      metadata: {
        clue_call_id: prepared.callId,
        target_id: prepared.targetId,
        task_type: prepared.request.task_type,
        ...(prepared.projectIdentity === null
          ? {}
          : {
              clue_project_id: prepared.projectIdentity.projectId,
              clue_profile_hash: prepared.projectIdentity.projectProfileHash,
            }),
        ...prepared.request.metadata,
      },
    });
    return withRuntime(
      {
        withLog: true,
        requireMission: false,
        ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
        ...projectProfileRuntimeOption(options),
      },
      (runtime) => {
        try {
          assertPreparedProjectContext(runtime, prepared);
        } catch (error) {
          return recordFailureInRuntime(runtime, prepared, error);
        }
        if (runtime.currentMissionId() !== prepared.missionVersion) {
          return recordFailureInRuntime(
            runtime,
            prepared,
            new OpenAiGatewayError('MISSION_DRIFT', 'Mission changed while the batch was submitted.'),
          );
        }
        const raw = canonicalJson(submission.raw);
        runtime.secrets.assertClean(raw, 'gateway batch receipt');
        const artifact = runtime.artifacts.putJson(submission.raw, {
          label: `${prepared.callId}-batch-submission.json`,
          ...(prepared.projectIdentity === null
            ? {}
            : { operationIdentity: prepared.projectIdentity }),
        });
        const log = runtime.requireLog();
        log.append({
          type: GATEWAY_EVENT_TYPES.batchSubmitted,
          missionVersion: runtime.currentMissionId(),
          actor: 'gateway',
          subjectId: null,
          payload: {
            call_id: prepared.callId,
            target_id: prepared.targetId,
            ...(prepared.projectIdentity === null
              ? {}
              : {
                  project_identity: prepared.projectIdentity,
                  profile_generation: prepared.profileGeneration,
                }),
            provider_batch_id: submission.providerBatchId,
            input_file_id: submission.inputFileId,
            provider_status: submission.providerStatus,
            provider_receipt_artifact_hash: artifact.hash,
            submitted_at: nowIso(),
          },
        });
        runtime.projections.sync(log);
        const record = readGatewayCall(runtime.projections, prepared.callId);
        if (record === null) throw new Error(`Gateway batch ${prepared.callId} did not project.`);
        return {
          state: 'batch_pending',
          callId: prepared.callId,
          providerBatchId: submission.providerBatchId,
          providerStatus: submission.providerStatus,
          record,
        };
      },
    );
  } catch (error) {
    return appendTerminalFailure(prepared, error, {
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
    });
  }
}

function preparedFromRecord(
  runtime: Runtime,
  record: GatewayCallRecord,
  policies: LoadedGatewayPolicies,
  environment: NodeJS.ProcessEnv,
): GatewayPreparedCall {
  if (record.projectIdentity !== null) {
    if (runtime.projectIdentity === null || runtime.projectProfile === null) {
      throw new OpenAiGatewayError(
        'PROJECT_IDENTITY_DRIFT',
        `Gateway call ${record.callId} is project-bound but the runtime is not.`,
      );
    }
    assertProjectOperationIdentity(record.projectIdentity, runtime.projectIdentity, `gateway call ${record.callId}`);
    if (record.profileGeneration !== runtime.projectProfile.generation) {
      throw new OpenAiGatewayError(
        'PROJECT_IDENTITY_DRIFT',
        `Gateway call ${record.callId} belongs to profile generation ${String(record.profileGeneration)}, not ${String(runtime.projectProfile.generation)}.`,
      );
    }
  }
  if (record.model === null) throw new Error(`Gateway call ${record.callId} has no model.`);
  const requestArtifactHash = record.requestArtifactHash;
  if (requestArtifactHash === null) throw new Error(`Gateway call ${record.callId} has no request artifact.`);
  const body = runtime.artifacts.getJson(
    requireSha256(requestArtifactHash, 'gateway request artifact hash'),
  ) as Record<string, unknown>;
  const request = gatewayRequestSchema.parse({
    version: 1,
    task_type: record.taskType,
    input: body['input'],
    instructions: body['instructions'] ?? null,
    metadata: body['metadata'] ?? {},
    attribution: body['attribution'] ?? { task_id: null, experiment_id: null, finding_id: null },
    max_output_tokens: body['max_output_tokens'],
  });

  const artifactIdentity = body['project_identity'] === undefined
    ? null
    : canonicalProjectOperationIdentity(body['project_identity']);
  const artifactGenerationRaw = body['profile_generation'];
  const artifactGeneration = artifactGenerationRaw === undefined
    ? null
    : Number(artifactGenerationRaw);
  if (
    (artifactIdentity === null) !== (artifactGeneration === null) ||
    (artifactGeneration !== null && (!Number.isSafeInteger(artifactGeneration) || artifactGeneration <= 0))
  ) {
    throw new OpenAiGatewayError(
      'PROJECT_IDENTITY_DRIFT',
      `Gateway request artifact ${requestArtifactHash} has an incomplete Project Profile binding.`,
    );
  }
  if (record.projectIdentity !== null) {
    if (artifactIdentity === null) {
      throw new OpenAiGatewayError(
        'PROJECT_IDENTITY_DRIFT',
        `Gateway call ${record.callId} projection is project-bound but its request artifact is not.`,
      );
    }
    assertProjectOperationIdentity(
      record.projectIdentity,
      artifactIdentity,
      `gateway request artifact ${record.callId}`,
    );
    if (record.profileGeneration !== artifactGeneration) {
      throw new OpenAiGatewayError(
        'PROJECT_IDENTITY_DRIFT',
        `Gateway call ${record.callId} profile generation does not match its request artifact.`,
      );
    }
  } else if (artifactIdentity !== null) {
    throw new OpenAiGatewayError(
      'PROJECT_IDENTITY_DRIFT',
      `Gateway call ${record.callId} projection lost the Project Profile binding present in its request artifact.`,
    );
  }

  const currentBinding = runtimeGatewayBinding(runtime, environment);
  const prepared: GatewayPreparedCall = {
    callId: record.callId,
    missionVersion: record.missionVersion,
    targetId: record.targetId,
    projectIdentity: artifactIdentity,
    profileGeneration: artifactGeneration,
    request,
    mode: record.mode,
    model: record.model,
    maxOutputTokens: Number(body['max_output_tokens']),
    pricing: {
      input_usd_per_million: record.pricing.inputUsdPerMillion,
      cached_input_usd_per_million: record.pricing.cachedInputUsdPerMillion,
      output_usd_per_million: record.pricing.outputUsdPerMillion,
    },
    batchDiscountFraction: record.pricing.batchDiscountFraction,
    estimatedInputTokens: 0,
    estimatedUsd: record.estimatedUsd,
    policies,
    credentialReference:
      typeof body['credential_reference'] === 'string'
        ? body['credential_reference']
        : currentBinding.credentialReference,
    apiKey: '',
  };
  assertPreparedProjectContext(runtime, prepared);
  if (prepared.credentialReference !== currentBinding.credentialReference) {
    throw new OpenAiGatewayError(
      'PROJECT_IDENTITY_DRIFT',
      `Gateway credential reference changed from ${prepared.credentialReference} to ${currentBinding.credentialReference}.`,
    );
  }
  if (prepared.projectIdentity !== null && (
    prepared.model !== currentBinding.requestedModel ||
    (body['routing_hash'] !== undefined && body['routing_hash'] !== policies.routingHash) ||
    (body['policy_hash'] !== undefined && body['policy_hash'] !== policies.budgetHash)
  )) {
    throw new OpenAiGatewayError('GATEWAY_POLICY_DRIFT', 'The pending batch does not match the current Project Profile model or policy.');
  }
  return prepared;
}

export async function reconcileGatewayBatch(
  callId: string,
  options: GatewayRuntimeOptions & {
    /** Deterministic clock seam for batch timeout/poll-cadence tests. */
    readonly now?: () => string;
  } = {},
): Promise<GatewayInvocationResult> {
  const at = options.now?.() ?? nowIso();
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error(`Gateway reconciliation clock is not ISO-8601: ${at}`);

  const lookup = withRuntime(
    {
      withLog: false,
      readOnly: true,
      requireMission: false,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
    },
    (runtime) => {
      const record = readGatewayCall(runtime.projections, callId);
      if (record === null) throw new Error(`Gateway call ${callId} does not exist.`);
      if (record.state !== 'batch_pending' || record.providerBatchId === null) {
        throw new Error(`Gateway call ${callId} is not a pending batch.`);
      }
      const environment = options.environment ?? process.env;
      const { binding, policies, modelProblem } = runtimeGatewayPolicy(runtime, environment);
      if (modelProblem !== null) throw new OpenAiGatewayError('GATEWAY_MODEL_POLICY_MISMATCH', modelProblem);
      const submittedMs = Date.parse(record.submittedAt);
      const updatedMs = Date.parse(record.updatedAt);
      if (!Number.isFinite(submittedMs) || !Number.isFinite(updatedMs)) {
        throw new Error(`Gateway call ${callId} carries an invalid projected timestamp.`);
      }
      const timeoutMs = policies.budget.call_modes.batch_timeout_hours * 60 * 60 * 1000;
      const pollIntervalMs = runtime.config.gateway.batch_poll_interval_seconds * 1000;
      const timedOut = atMs - submittedMs >= timeoutMs;
      const pollDue = atMs - updatedMs >= pollIntervalMs;
      const credential = resolveGatewayCredential(
        binding,
        environment,
        options.credentialResolver,
      );
      return {
        record,
        policies,
        providerBatchId: record.providerBatchId,
        timedOut,
        pollDue,
        apiKey: credential,
        credentialReference: binding.credentialReference,
      };
    },
  );

  const preparedWithoutSecret = withRuntime(
    {
      withLog: false,
      readOnly: true,
      requireMission: false,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
    },
    (runtime) => preparedFromRecord(runtime, lookup.record, lookup.policies, options.environment ?? process.env),
  );

  if (lookup.timedOut) {
    return appendTerminalFailure(
      preparedWithoutSecret,
      new OpenAiGatewayError(
        'BATCH_TIMEOUT',
        `OpenAI batch ${lookup.providerBatchId} exceeded the governed ` +
          `${lookup.policies.budget.call_modes.batch_timeout_hours}-hour window.`,
      ),
      {
        ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
        ...projectProfileRuntimeOption(options),
        providerBatchId: lookup.providerBatchId,
        providerStatus: lookup.record.providerStatus,
      },
    );
  }

  if (!lookup.pollDue) {
    return {
      state: 'batch_pending',
      callId,
      providerBatchId: lookup.providerBatchId,
      providerStatus: lookup.record.providerStatus ?? 'submitted',
      record: lookup.record,
    };
  }

  if (lookup.apiKey === null) {
    return appendTerminalFailure(
      preparedWithoutSecret,
      new OpenAiGatewayError('API_KEY_MISSING', `${lookup.credentialReference} is unavailable.`),
      {
        ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
        ...projectProfileRuntimeOption(options),
        providerBatchId: lookup.providerBatchId,
        providerStatus: lookup.record.providerStatus,
      },
    );
  }

  const prepared = { ...preparedWithoutSecret, apiKey: lookup.apiKey };
  const adapter = new OpenAiResponsesAdapter({
    apiKey: prepared.apiKey,
    routing: prepared.policies.routing,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  let result: OpenAiBatchReconciliation;
  try {
    result = await adapter.reconcileBatch(lookup.providerBatchId, callId, prepared.model);
  } catch (error) {
    return appendTerminalFailure(prepared, error, {
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
      providerBatchId: lookup.providerBatchId,
    });
  }

  if (result.state === 'completed') {
    return recordCompleted(prepared, result.response, result.raw, {
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
      providerBatchId: lookup.providerBatchId,
    });
  }
  if (result.state === 'failed') {
    return appendTerminalFailure(
      prepared,
      new OpenAiGatewayError(result.code, result.message),
      {
        ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
        ...projectProfileRuntimeOption(options),
        providerBatchId: lookup.providerBatchId,
        providerStatus: result.providerStatus,
      },
    );
  }

  return withRuntime(
    {
      withLog: true,
      requireMission: false,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
    },
    (runtime) => {
      const current = requireOpenGatewayCall(runtime, callId);
      if (current.updatedAt !== lookup.record.updatedAt || current.providerReceiptArtifactHash !== lookup.record.providerReceiptArtifactHash) {
        return {
          state: 'batch_pending',
          callId,
          providerBatchId: lookup.providerBatchId,
          providerStatus: current.providerStatus ?? 'submitted',
          record: current,
        };
      }
      const raw = canonicalJson(result.raw);
      runtime.secrets.assertClean(raw, 'gateway batch poll receipt');
      try {
        assertPreparedProjectContext(runtime, prepared);
      } catch (error) {
        return recordFailureInRuntime(runtime, prepared, error, {
          providerBatchId: result.providerBatchId,
          providerStatus: result.providerStatus,
        });
      }
      const artifact = runtime.artifacts.putJson(result.raw, {
        label: `${callId}-batch-poll.json`,
        ...(prepared.projectIdentity === null
          ? {}
          : { operationIdentity: prepared.projectIdentity }),
      });
      const log = runtime.requireLog();
      log.append({
        type: GATEWAY_EVENT_TYPES.batchPolled,
        missionVersion: runtime.currentMissionId(),
        actor: 'gateway',
        subjectId: null,
        payload: {
          call_id: callId,
          ...(prepared.projectIdentity === null
            ? {}
            : {
                project_identity: prepared.projectIdentity,
                profile_generation: prepared.profileGeneration,
              }),
          provider_batch_id: result.providerBatchId,
          provider_status: result.providerStatus,
          provider_receipt_artifact_hash: artifact.hash,
          polled_at: at,
        },
      });
      runtime.projections.sync(log);
      const record = readGatewayCall(runtime.projections, callId);
      if (record === null) throw new Error(`Gateway batch poll ${callId} did not project.`);
      return {
        state: 'batch_pending',
        callId,
        providerBatchId: result.providerBatchId,
        providerStatus: result.providerStatus,
        record,
      };
    },
  );
}

export async function resumeGatewayProvider(
  options: GatewayRuntimeOptions = {},
): Promise<{ readonly model: string; readonly eventId: string }> {
  const lookup = withRuntime(
    {
      withLog: false,
      readOnly: true,
      requireMission: true,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
    },
    (runtime) => {
      const environment = options.environment ?? process.env;
      const { binding, policies, modelProblem } = runtimeGatewayPolicy(runtime, environment);
      const assessment = assessGatewayPolicy(runtime.config, policies, environment, {
        checkInstallationCredential: runtime.projectProfile === null && binding.credentialReference.startsWith('env:'),
      });
      const policyProblems = assessment.problems;
      if (modelProblem !== null) throw new OpenAiGatewayError('GATEWAY_MODEL_POLICY_MISMATCH', modelProblem);
      if (!binding.enabled || policyProblems.length > 0) {
        throw new Error(
          `Gateway resume requires an enabled, coherent gateway policy: ${policyProblems.join('; ')}`,
        );
      }
      const models = [...new Set(GATEWAY_TASK_TYPES
        .map((task) => policies.routing.routes[task])
        .filter((route) => route.enabled && route.model !== null)
        .map((route) => route.model as string))];
      if (models.length !== 1) {
        throw new Error(`Gateway resume requires one exact approved model; found ${models.length}.`);
      }
      const model = models[0] as string;
      if (binding.requestedModel !== null && binding.requestedModel !== model) {
        throw new Error(
          `Project Profile requests ${binding.requestedModel}, but routing policy requests ${model}.`,
        );
      }
      const apiKey = resolveGatewayCredential(
        binding,
        environment,
        options.credentialResolver,
      );
      if (apiKey === null) {
        throw new Error(`${binding.credentialReference} is configured but unavailable.`);
      }
      return {
        model,
        apiKey,
        credentialReference: binding.credentialReference,
        targetId: runtime.config.project.id,
        missionVersion: runtime.currentMissionId(),
        policies,
        ...runtimeProjectContext(runtime),
      };
    },
  );
  const adapter = new OpenAiResponsesAdapter({
    apiKey: lookup.apiKey,
    routing: lookup.policies.routing,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const probe = await adapter.probeModel(lookup.model);
  if (probe.id !== lookup.model) {
    throw new OpenAiGatewayError(
      'PROVIDER_MODEL_ID_MISMATCH',
      `Provider returned model ${probe.id}; exact requested model is ${lookup.model}.`,
    );
  }
  return withRuntime(
    {
      withLog: true,
      requireMission: true,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...projectProfileRuntimeOption(options),
    },
    (runtime) => {
      if (runtime.currentMissionId() !== lookup.missionVersion) {
        throw new Error('Mission changed while the OpenAI model probe was in flight.');
      }
      const current = runtimeProjectContext(runtime);
      if (lookup.projectIdentity !== null) {
        if (current.projectIdentity === null || current.profileGeneration === null) {
          throw new OpenAiGatewayError(
            'PROJECT_IDENTITY_DRIFT',
            'Project Profile identity disappeared while the OpenAI model probe was in flight.',
          );
        }
        assertProjectOperationIdentity(
          lookup.projectIdentity,
          current.projectIdentity,
          'gateway provider resume',
        );
        if (lookup.profileGeneration !== current.profileGeneration) {
          throw new OpenAiGatewayError(
            'PROJECT_IDENTITY_DRIFT',
            'Project Profile generation changed while the OpenAI model probe was in flight.',
          );
        }
        const { policies, modelProblem } = runtimeGatewayPolicy(runtime);
        if (modelProblem !== null || policies.routingHash !== lookup.policies.routingHash ||
            policies.budgetHash !== lookup.policies.budgetHash) {
          throw new OpenAiGatewayError('GATEWAY_POLICY_DRIFT', 'Gateway routing or budget policy changed while the OpenAI model probe was in flight.');
        }
      }
      const event = runtime.requireLog().append({
        type: GATEWAY_EVENT_TYPES.providerResumed,
        missionVersion: runtime.currentMissionId(),
        actor: 'gateway',
        subjectId: null,
        payload: {
          target_id: lookup.targetId,
          ...(lookup.projectIdentity === null
            ? {}
            : {
                project_identity: lookup.projectIdentity,
                profile_generation: lookup.profileGeneration,
              }),
          provider: 'openai',
          model: lookup.model,
          resumed_at: nowIso(),
        },
      });
      runtime.projections.sync(runtime.requireLog());
      return { model: lookup.model, eventId: event.id };
    },
  );
}

export function readGatewayStatus(
  runtime: Runtime,
  at = nowIso(),
  environment: NodeJS.ProcessEnv = process.env,
  credentialResolver?: GatewayCredentialResolver,
): GatewayStatus {
  const { binding, policies, modelProblem } = runtimeGatewayPolicy(runtime, environment);
  const assessment = assessGatewayPolicy(runtime.config, policies, environment, {
    checkInstallationCredential: runtime.projectProfile === null && binding.credentialReference.startsWith('env:'),
  });
  const aggregate = readGatewayAggregateFacts(runtime.projections, runtime.config.project.id, at);
  const providerState = readGatewayProviderState(runtime.projections, runtime.config.project.id);
  const providerStateCurrent =
    providerState.eventId === null || providerStateMatchesRuntime(runtime, providerState);
  const effectiveProviderState = providerStateCurrent ? providerState.state : 'unknown';
  const effectiveProviderReason = providerStateCurrent ? providerState.reason : null;
  const providerPaused = effectiveProviderState === 'paused_budget';
  const projectContext = runtimeProjectContext(runtime);
  const enabledModels = [...new Set(GATEWAY_TASK_TYPES
    .map((task) => policies.routing.routes[task])
    .filter((route) => route.enabled && route.model !== null)
    .map((route) => route.model as string))];
  const routedModel = enabledModels.length === 1 ? enabledModels[0] ?? null : null;
  const requestedModel = binding.projectId === null ? routedModel : binding.requestedModel;
  const modelPolicyExact =
    requestedModel !== null &&
    routedModel !== null &&
    requestedModel === routedModel &&
    binding.fallbackPolicy === 'FORBID';
  const credential = resolveGatewayCredential(
    binding,
    environment,
    credentialResolver,
  );
  const apiKeyPresent = credential !== null;
  const policyProblems = [
    ...assessment.problems,
    ...(modelProblem === null ? [] : [modelProblem]),
    ...(enabledModels.length !== 1
      ? [`enabled routes resolve to ${enabledModels.length} models instead of one exact model`]
      : []),
    ...(binding.requestedModel !== null && routedModel !== binding.requestedModel
      ? [`Project Profile requests ${binding.requestedModel}, routing policy requests ${routedModel ?? 'none'}`]
      : []),
    ...(!apiKeyPresent
      ? [`${binding.credentialReference} is configured but unavailable to the runtime`]
      : []),
    ...(!providerStateCurrent
      ? ['durable provider state belongs to another Project Profile generation']
      : []),
    ...(providerPaused ? [effectiveProviderReason ?? 'OpenAI Platform provider budget is paused.'] : []),
  ];
  const operationallyReady =
    binding.enabled &&
    modelPolicyExact &&
    apiKeyPresent &&
    policyProblems.length === 0 &&
    !providerPaused;
  return {
    configured: true,
    enabled: binding.enabled,
    provider: runtime.config.gateway.provider,
    projectIdentity: projectContext.projectIdentity,
    profileGeneration: projectContext.profileGeneration,
    credentialReference: binding.credentialReference,
    requestedModel,
    effectiveModel: operationallyReady ? requestedModel : null,
    fallbackUsed: false,
    apiKeyEnv: binding.credentialReference.startsWith('env:')
      ? binding.credentialReference.slice('env:'.length)
      : runtime.config.gateway.api_key_env,
    apiKeyPresent,
    operationallyReady,
    policyProblems,
    budgetHash: policies.budgetHash,
    routingHash: policies.routingHash,
    priceScheduleVersion: policies.routing.price_schedule_version,
    enabledRouteCount: assessment.enabledRouteCount,
    defaultMode: runtime.config.gateway.default_mode as GatewayCallMode,
    model: requestedModel,
    budgetAuthority: policies.budget.spend_authority,
    localBudgetEnforced: assessment.localBudgetEnforced,
    localPricingAuthoritative: assessment.localPricingAuthoritative,
    providerState: effectiveProviderState,
    providerPaused,
    providerBudgetExhausted: providerPaused,
    providerPauseReason: effectiveProviderReason,
    usage: {
      inputTokens: aggregate.inputTokens,
      cachedInputTokens: aggregate.cachedInputTokens,
      outputTokens: aggregate.outputTokens,
      totalTokens: aggregate.totalTokens,
      providerRemainingTokens: null,
      providerRemainingTokensAuthoritative: false,
    },
    submitted: aggregate.submitted,
    completed: aggregate.completed,
    failed: aggregate.failed,
    refused: aggregate.refused,
    pending: aggregate.pending,
    todayActualUsd: assessment.localPricingAuthoritative ? aggregate.todayActualUsd : null,
    monthActualUsd: assessment.localPricingAuthoritative ? aggregate.monthActualUsd : null,
    reservedUsd: assessment.localPricingAuthoritative ? aggregate.reservedUsd : null,
    dailyHardUsd: policies.budget.caps.daily_hard,
    monthlyHardUsd: policies.budget.caps.monthly_hard,
    degradationAction: degradationAction(
      policies,
      aggregate.todayActualUsd + aggregate.reservedUsd,
    ),
    latest: aggregate.latest,
  };
}
