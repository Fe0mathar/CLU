/**
 * Model Gateway policy loading and validation — DEV-P2-09.
 *
 * The installation config selects the provider and names the two governed policy files;
 * this module owns their strict schemas, exact-byte identities and the deterministic
 * readiness judgement. It performs no network I/O and never reads a secret value except
 * to answer the boolean question “is the named environment variable present?”.
 *
 * Production uses OpenAI Platform as the sole monetary authority. CLU-E records exact
 * provider token usage and pauses only after an explicit provider billing/credit refusal;
 * it never invents a local balance or silently substitutes a different model.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { hashBytes, hashCanonicalJson, type Sha256 } from '../../shared/ids.js';
import { absolutePathForm, type ClueConfig } from '../../shared/schemas.js';

export const GATEWAY_TASK_TYPES = [
  'DOC_EXTRACT',
  'UNIT_SUMMARIZE',
  'SOURCE_PARSE_FOLLOWUP',
  'EDGE_RESOLVE',
  'METRIC_ANALYZE',
  'CANDIDATE_REVIEW',
  'PROOF_CONTRACT_DESIGN',
  'PATCH_DESIGN',
  'PATCH_REVIEW',
  'REFUTATION',
  'EXPERIMENT_ANALYSIS',
  'GLOBAL_SYNTHESIS',
] as const;

export type GatewayTaskType = (typeof GATEWAY_TASK_TYPES)[number];

export const GATEWAY_LANES = [
  'extraction',
  'analysis',
  'patch_design',
  'refutation',
  'synthesis',
] as const;

export type GatewayLane = (typeof GATEWAY_LANES)[number];

export const GATEWAY_CALL_MODES = ['interactive', 'batch'] as const;
export type GatewayCallMode = (typeof GATEWAY_CALL_MODES)[number];

export const GATEWAY_DEGRADATION_ACTIONS = [
  'notify',
  'frontier_to_batch',
  'batch_only',
  'pause_submissions',
] as const;
export type GatewayDegradationAction = (typeof GATEWAY_DEGRADATION_ACTIONS)[number];

const money = z.number().finite().nonnegative();
const fraction = z.number().finite().min(0).max(1);
const gatewayTaskTypeSchema = z.enum(GATEWAY_TASK_TYPES);
const gatewayLaneSchema = z.enum(GATEWAY_LANES);
const gatewayCallModeSchema = z.enum(GATEWAY_CALL_MODES);

const budgetCapsSchema = z
  .object({
    monthly_hard: money,
    daily_soft: money,
    daily_hard: money,
    per_task_default: money,
    per_task_max: money,
    reserve_fraction: fraction,
  })
  .strict();

const degradationStepSchema = z
  .object({
    at_fraction: fraction,
    action: z.enum(GATEWAY_DEGRADATION_ACTIONS),
    detail: z.string().min(1),
  })
  .strict();

const laneAllocationSchema = z
  .object({
    extraction: fraction,
    analysis: fraction,
    patch_design: fraction,
    refutation: fraction,
    synthesis: fraction,
  })
  .strict();

const perTaskBudgetsSchema = z
  .object({
    DOC_EXTRACT: money,
    UNIT_SUMMARIZE: money,
    SOURCE_PARSE_FOLLOWUP: money,
    EDGE_RESOLVE: money,
    METRIC_ANALYZE: money,
    CANDIDATE_REVIEW: money,
    PROOF_CONTRACT_DESIGN: money,
    PATCH_DESIGN: money,
    PATCH_REVIEW: money,
    REFUTATION: money,
    EXPERIMENT_ANALYSIS: money,
    GLOBAL_SYNTHESIS: money,
  })
  .strict();

const callModesSchema = z
  .object({
    default: gatewayCallModeSchema,
    interactive_allowed_tasks: z.array(gatewayTaskTypeSchema),
    interactive_disabled_above_fraction: fraction,
    batch_poll_interval_seconds: z.number().int().min(30).max(3600),
    batch_timeout_hours: z.number().finite().positive().max(168),
  })
  .strict();

const accountingSchema = z
  .object({
    record_model_id: z.boolean(),
    record_price_schedule_version: z.boolean(),
    record_cached_input_separately: z.boolean(),
    record_batch_discount_separately: z.boolean(),
    attribute_to: z.array(z.enum(['task', 'lane', 'experiment', 'finding'])).min(1),
    attribute_on: z.literal('reconciliation'),
  })
  .strict();

const efficiencySchema = z
  .object({
    target_cost_per_confirmed_finding: money,
    target_cost_per_issued_verdict: money,
    target_cost_per_proven_improvement: money,
    review_after_experiments: z.number().int().positive(),
    report_rejected_experiment_share: z.boolean(),
  })
  .strict();

const alarmsSchema = z
  .object({
    on_degradation_step: z.boolean(),
    on_daily_hard_cap: z.boolean(),
    on_monthly_hard_cap: z.boolean(),
    on_task_budget_exceeded: z.boolean(),
    on_batch_timeout: z.boolean(),
    on_daily_spend_above_median_multiple: z.number().finite().positive(),
    channels: z.array(z.enum(['status_document', 'windows_toast', 'webhook'])).min(1),
  })
  .strict();

export const gatewayBudgetPolicySchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    currency: z.literal('USD'),
    /** Provider authority means the local numeric caps are compatibility metadata only. */
    spend_authority: z.enum(['clue', 'openai_platform']).default('clue'),
    provider_exhaustion_action: z.literal('controlled_pause').default('controlled_pause'),
    remaining_token_authority: z.literal('provider_only').default('provider_only'),
    caps: budgetCapsSchema,
    require_explicit_caps: z.boolean(),
    degradation: z.array(degradationStepSchema).min(1),
    monthly_exhausted_action: z.literal('pause_submissions'),
    monthly_rollover: z.literal(false),
    lane_allocation: laneAllocationSchema,
    soft_allocation: z.boolean(),
    per_task_budgets: perTaskBudgetsSchema,
    on_task_budget_exceeded: z.literal('fail_and_record'),
    call_modes: callModesSchema,
    accounting: accountingSchema,
    efficiency: efficiencySchema,
    alarms: alarmsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.spend_authority === 'clue' && value.caps.daily_soft > value.caps.daily_hard) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caps', 'daily_soft'],
        message: 'daily_soft must not exceed daily_hard',
      });
    }
    if (value.spend_authority === 'clue' && value.caps.per_task_default > value.caps.per_task_max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caps', 'per_task_default'],
        message: 'per_task_default must not exceed per_task_max',
      });
    }
    const allocation = Object.values(value.lane_allocation).reduce((sum, part) => sum + part, 0);
    if (Math.abs(allocation - 1) > 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lane_allocation'],
        message: `lane allocation must sum to 1.0; got ${allocation}`,
      });
    }
    let previous = -1;
    for (const [index, step] of value.degradation.entries()) {
      if (step.at_fraction <= previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['degradation', index, 'at_fraction'],
          message: 'degradation fractions must be strictly increasing',
        });
      }
      previous = step.at_fraction;
    }
    for (const task of GATEWAY_TASK_TYPES) {
      const cap = value.per_task_budgets[task];
      if (value.spend_authority === 'clue' && cap > value.caps.per_task_max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['per_task_budgets', task],
          message: `task budget ${cap} exceeds caps.per_task_max ${value.caps.per_task_max}`,
        });
      }
    }
  });

export type GatewayBudgetPolicy = z.infer<typeof gatewayBudgetPolicySchema>;

const pricingSchema = z
  .object({
    input_usd_per_million: money,
    cached_input_usd_per_million: money,
    output_usd_per_million: money,
  })
  .strict();

const routeSchema = z
  .object({
    enabled: z.boolean(),
    lane: gatewayLaneSchema,
    mode: gatewayCallModeSchema,
    model: z.string().min(1).nullable(),
    max_output_tokens: z.number().int().positive().max(1_000_000),
    pricing: pricingSchema.nullable(),
    note: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && value.model === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'an enabled route requires an explicit model identifier',
      });
    }
  });

const routesSchema = z
  .object({
    DOC_EXTRACT: routeSchema,
    UNIT_SUMMARIZE: routeSchema,
    SOURCE_PARSE_FOLLOWUP: routeSchema,
    EDGE_RESOLVE: routeSchema,
    METRIC_ANALYZE: routeSchema,
    CANDIDATE_REVIEW: routeSchema,
    PROOF_CONTRACT_DESIGN: routeSchema,
    PATCH_DESIGN: routeSchema,
    PATCH_REVIEW: routeSchema,
    REFUTATION: routeSchema,
    EXPERIMENT_ANALYSIS: routeSchema,
    GLOBAL_SYNTHESIS: routeSchema,
  })
  .strict();

const httpsBaseUrlSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'gateway API base_url must use HTTPS' });
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'gateway API base_url must not embed credentials',
      });
    }
    if (url.search !== '' || url.hash !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'gateway API base_url must not carry a query or fragment',
      });
    }
  });

export const gatewayRoutingPolicySchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('openai'),
    price_schedule_version: z.string().min(1),
    /** False when OpenAI Platform is the billing authority and local prices are not used. */
    local_pricing_authoritative: z.boolean().default(true),
    validate_model_before_use: z.boolean().default(false),
    batch_discount_fraction: fraction,
    api: z
      .object({
        base_url: httpsBaseUrlSchema,
        models_path: z.literal('/models').default('/models'),
        responses_path: z.literal('/responses'),
        files_path: z.literal('/files'),
        batches_path: z.literal('/batches'),
        request_timeout_seconds: z.number().int().min(1).max(3600),
        max_response_bytes: z.number().int().min(1024).max(256 * 1024 * 1024),
        store: z.literal(false),
      })
      .strict(),
    routes: routesSchema,
  })
  .strict();

export type GatewayRoutingPolicy = z.infer<typeof gatewayRoutingPolicySchema>;
export type GatewayRoute = GatewayRoutingPolicy['routes'][GatewayTaskType];
export type GatewayPricing = NonNullable<GatewayRoute['pricing']>;

export interface LoadedGatewayPolicies {
  readonly budget: GatewayBudgetPolicy;
  readonly routing: GatewayRoutingPolicy;
  readonly budgetPath: string;
  readonly routingPath: string;
  readonly budgetHash: Sha256;
  readonly routingHash: Sha256;
}

export interface GatewayPolicyAssessment {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly operationallyReady: boolean;
  readonly apiKeyPresent: boolean;
  readonly enabledRouteCount: number;
  readonly spendAuthority: 'clue' | 'openai_platform';
  readonly localBudgetEnforced: boolean;
  readonly preferredModel: string | null;
  readonly localPricingAuthoritative: boolean;
  readonly problems: readonly string[];
}

function resolvePolicyPath(repoRoot: string, configuredPath: string, label: string): string {
  const form = absolutePathForm(configuredPath);
  if (form !== null && !isAbsolute(configuredPath)) {
    throw new Error(`${label} uses a ${form} absolute path that this host cannot resolve: ${configuredPath}`);
  }
  return isAbsolute(configuredPath) ? resolve(configuredPath) : resolve(repoRoot, configuredPath);
}

function readStrictYaml<Schema extends z.ZodTypeAny>(
  path: string,
  schema: Schema,
  label: string,
): { readonly value: z.output<Schema>; readonly hash: Sha256 } {
  const bytes = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = parseYaml(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid YAML: ${(error as Error).message}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${label} is invalid: ${details}`);
  }
  return { value: result.data, hash: hashBytes(bytes) };
}

export function loadGatewayPolicies(repoRoot: string, config: ClueConfig): LoadedGatewayPolicies {
  const budgetPath = resolvePolicyPath(
    repoRoot,
    config.gateway.budget_policy_file,
    'gateway.budget_policy_file',
  );
  const routingPath = resolvePolicyPath(
    repoRoot,
    config.gateway.routing_file,
    'gateway.routing_file',
  );
  const budget = readStrictYaml(budgetPath, gatewayBudgetPolicySchema, 'gateway budget policy');
  const routing = readStrictYaml(routingPath, gatewayRoutingPolicySchema, 'gateway routing policy');
  return {
    budget: budget.value,
    routing: routing.value,
    budgetPath,
    routingPath,
    budgetHash: budget.hash,
    routingHash: routing.hash,
  };
}

export function isProjectGatewayModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

/** Preserve governed task routing and bind every enabled route to the saved exact model. */
export function bindProjectGatewayModel(
  policies: LoadedGatewayPolicies,
  model: string,
): LoadedGatewayPolicies {
  if (!isProjectGatewayModelId(model)) throw new Error('The Project Profile needs one valid exact model ID.');
  const routes = { ...policies.routing.routes };
  const changes = GATEWAY_TASK_TYPES.filter((task) => routes[task].enabled && routes[task].model !== model);
  if (changes.length === 0) return policies;
  if (policies.budget.spend_authority !== 'openai_platform' || policies.routing.local_pricing_authoritative) {
    throw new Error('Changing the Project Profile model requires OpenAI Platform budget and pricing authority.');
  }
  for (const task of changes) routes[task] = { ...routes[task], model, pricing: null };
  return {
    ...policies,
    routing: { ...policies.routing, routes },
    routingHash: hashCanonicalJson({ schema: 'clue.gateway.profile-routing/1', baseRoutingHash: policies.routingHash, model }),
  };
}

export function assessGatewayPolicy(
  config: ClueConfig,
  policies: LoadedGatewayPolicies,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly checkInstallationCredential?: boolean } = {},
): GatewayPolicyAssessment {
  const problems: string[] = [];
  const { budget, routing } = policies;

  if (routing.provider !== config.gateway.provider) {
    problems.push(
      `routing provider ${routing.provider} does not match config provider ${config.gateway.provider}`,
    );
  }
  if (budget.call_modes.default !== config.gateway.default_mode) {
    problems.push(
      `budget default mode ${budget.call_modes.default} does not match config default mode ${config.gateway.default_mode}`,
    );
  }
  if (
    budget.call_modes.batch_poll_interval_seconds !==
    config.gateway.batch_poll_interval_seconds
  ) {
    problems.push(
      'budget batch_poll_interval_seconds does not match gateway.batch_poll_interval_seconds',
    );
  }
  if (budget.spend_authority === 'clue' && budget.require_explicit_caps) {
    if (budget.caps.monthly_hard <= 0) problems.push('monthly_hard cap is zero');
    if (budget.caps.daily_hard <= 0) problems.push('daily_hard cap is zero');
  }

  const enabledRoutes = GATEWAY_TASK_TYPES.filter((task) => routing.routes[task].enabled);
  if (enabledRoutes.length === 0) problems.push('no model route is enabled');
  for (const task of enabledRoutes) {
    const route = routing.routes[task];
    if (route.model === null) problems.push(`${task} has no model`);
    if (policies.routing.local_pricing_authoritative && route.pricing === null) {
      problems.push(`${task} has no price schedule`);
    }
  }

  const apiKeyPresent =
    typeof environment[config.gateway.api_key_env] === 'string' &&
    (environment[config.gateway.api_key_env]?.trim().length ?? 0) >= 8;
  if (
    options.checkInstallationCredential !== false &&
    config.gateway.enabled &&
    !apiKeyPresent
  ) {
    problems.push(`${config.gateway.api_key_env} is not present`);
  }

  const enabledModels = [...new Set(
    enabledRoutes
      .map((task) => routing.routes[task].model)
      .filter((model): model is string => model !== null),
  )];
  if (enabledModels.length > 1) {
    problems.push('P2 activation requires one exact preferred model across all enabled routes');
  }

  return {
    configured: true,
    enabled: config.gateway.enabled,
    operationallyReady: config.gateway.enabled && problems.length === 0,
    apiKeyPresent,
    enabledRouteCount: enabledRoutes.length,
    spendAuthority: budget.spend_authority,
    localBudgetEnforced: budget.spend_authority === 'clue',
    preferredModel: enabledModels[0] ?? null,
    localPricingAuthoritative: routing.local_pricing_authoritative,
    problems,
  };
}

export function routeForTask(
  policies: LoadedGatewayPolicies,
  taskType: GatewayTaskType,
): GatewayRoute {
  const route = policies.routing.routes[taskType];
  if (!route.enabled) throw new Error(`Gateway route ${taskType} is disabled: ${route.note}`);
  if (route.model === null) {
    throw new Error(`Gateway route ${taskType} has no model and cannot submit work.`);
  }
  if (policies.routing.local_pricing_authoritative && route.pricing === null) {
    throw new Error(`Gateway route ${taskType} has no local price schedule.`);
  }
  return route;
}

export function estimateInputTokens(text: string): number {
  // Deliberately conservative without a model-specific tokenizer: UTF-8 bytes / 3 rounds up.
  // Exact provider usage replaces this estimate in the durable completion event.
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3));
}

export function priceForUsage(
  pricing: GatewayPricing,
  usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  },
  discountFraction = 0,
): number {
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens));
  const uncached = Math.max(0, usage.inputTokens - cached);
  const raw =
    (uncached * pricing.input_usd_per_million +
      cached * pricing.cached_input_usd_per_million +
      usage.outputTokens * pricing.output_usd_per_million) /
    1_000_000;
  return raw * (1 - discountFraction);
}
