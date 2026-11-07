/**
 * Event-first Model Gateway projection — DEV-P2-09.
 *
 * The append-only event log is authority. SQLite stores one rebuildable row per call so
 * Status, `gateway status`, budget checks and batch reconciliation never scan provider
 * responses or infer state from files. Transition projectors fail closed: a terminal call
 * cannot be completed twice, a batch cannot appear without a started call, and a rejected
 * request cannot later become successful.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';

import type { ProjectionModule, ProjectionStore } from '../../memory/db.js';
import { projectOperationIdentitySchema, type ProjectOperationIdentity } from '../../shared/projectOperationIdentity.js';
import type { EventRecord } from '../../shared/schemas.js';
import {
  GATEWAY_CALL_MODES,
  GATEWAY_LANES,
  GATEWAY_TASK_TYPES,
  type GatewayCallMode,
  type GatewayLane,
  type GatewayTaskType,
} from './policy.js';

export const GATEWAY_EVENT_TYPES = {
  callRefused: 'gateway.call_refused',
  callStarted: 'gateway.call_started',
  batchSubmitted: 'gateway.batch_submitted',
  batchPolled: 'gateway.batch_polled',
  callCompleted: 'gateway.call_completed',
  callFailed: 'gateway.call_failed',
  /** Explicit operator recovery after a successful provider/model probe. */
  providerResumed: 'gateway.provider_resumed',
} as const;

export const GATEWAY_CALL_STATES = [
  'refused',
  'in_flight',
  'batch_pending',
  'completed',
  'failed',
] as const;
export type GatewayCallState = (typeof GATEWAY_CALL_STATES)[number];

export const gatewayCallIdSchema = z.string().regex(/^GWCALL-[0-9a-f]{32}$/u);
const sha = z.string().regex(/^[0-9a-f]{64}$/u);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const money = z.number().finite().nonnegative();

const attributionSchema = z
  .object({
    task_id: z.string().regex(/^TASK-[0-9]{6,}$/u).nullable(),
    experiment_id: z.string().regex(/^EXP-[0-9]{6,}$/u).nullable(),
    finding_id: z.string().regex(/^FIND-[0-9]{6,}$/u).nullable(),
  })
  .strict();

const optionalProjectBindingShape = {
  /** Optional only for replay compatibility with pre-Project-Profile gateway events. */
  project_identity: projectOperationIdentitySchema.optional(),
  profile_generation: z.number().int().positive().optional(),
} as const;

function requireCompleteOptionalProjectBinding(
  value: {
    readonly project_identity?: ProjectOperationIdentity | undefined;
    readonly profile_generation?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if ((value.project_identity === undefined) !== (value.profile_generation === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.project_identity === undefined ? ['project_identity'] : ['profile_generation'],
      message: 'project_identity and profile_generation must be present together',
    });
  }
}

const commonSchema = z
  .object({
    call_id: gatewayCallIdSchema,
    target_id: z.string().min(1),
    task_type: z.enum(GATEWAY_TASK_TYPES),
    lane: z.enum(GATEWAY_LANES),
    mode: z.enum(GATEWAY_CALL_MODES),
    model: z.string().min(1).nullable(),
    attribution: attributionSchema,
    policy_hash: sha,
    routing_hash: sha,
    price_schedule_version: z.string().min(1),
    ...optionalProjectBindingShape,
  })
  .strict();

export const gatewayCallRefusedPayloadSchema = commonSchema
  .extend({
    code: z.string().min(1),
    reason: z.string().min(1),
    requested_at: iso,
  })
  .strict()
  .superRefine(requireCompleteOptionalProjectBinding);

export const gatewayCallStartedPayloadSchema = commonSchema
  .extend({
    request_artifact_hash: sha,
    request_hash: sha,
    estimated_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    estimated_usd: money,
    pricing: z
      .object({
        input_usd_per_million: money,
        cached_input_usd_per_million: money,
        output_usd_per_million: money,
        batch_discount_fraction: z.number().finite().min(0).max(1),
      })
      .strict(),
    started_at: iso,
  })
  .strict()
  .superRefine(requireCompleteOptionalProjectBinding);

export const gatewayBatchSubmittedPayloadSchema = z
  .object({
    call_id: gatewayCallIdSchema,
    /** Added in P2 final activation; optional for replay compatibility with earlier events. */
    target_id: z.string().min(1).optional(),
    ...optionalProjectBindingShape,
    provider_batch_id: z.string().min(1),
    input_file_id: z.string().min(1),
    provider_status: z.string().min(1),
    provider_receipt_artifact_hash: sha,
    submitted_at: iso,
  })
  .strict()
  .superRefine(requireCompleteOptionalProjectBinding);

export const gatewayBatchPolledPayloadSchema = z
  .object({
    call_id: gatewayCallIdSchema,
    ...optionalProjectBindingShape,
    provider_batch_id: z.string().min(1),
    provider_status: z.string().min(1),
    provider_receipt_artifact_hash: sha,
    polled_at: iso,
  })
  .strict()
  .superRefine(requireCompleteOptionalProjectBinding);

const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  })
  .strict();

export const gatewayCallCompletedPayloadSchema = z
  .object({
    call_id: gatewayCallIdSchema,
    ...optionalProjectBindingShape,
    provider_request_id: z.string().min(1),
    provider_batch_id: z.string().min(1).nullable(),
    provider_model: z.string().min(1),
    response_artifact_hash: sha,
    usage: usageSchema,
    actual_usd: money,
    completed_at: iso,
  })
  .strict()
  .superRefine(requireCompleteOptionalProjectBinding);

export const gatewayCallFailedPayloadSchema = z
  .object({
    call_id: gatewayCallIdSchema,
    /** Added in P2 final activation; optional for replay compatibility with earlier events. */
    target_id: z.string().min(1).optional(),
    ...optionalProjectBindingShape,
    provider_batch_id: z.string().min(1).nullable(),
    provider_status: z.string().min(1).nullable(),
    code: z.string().min(1),
    reason: z.string().min(1),
    retryable: z.boolean(),
    failed_at: iso,
  })
  .strict()
  .superRefine(requireCompleteOptionalProjectBinding);

type Db = Database.Database;

export const GATEWAY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gateway_calls (
  call_id                  TEXT PRIMARY KEY,
  source_event_id          TEXT NOT NULL,
  mission_version          TEXT NOT NULL,
  subject_id               TEXT,
  target_id                TEXT NOT NULL,
  project_id              TEXT,
  target_root_identity    TEXT,
  project_profile_hash    TEXT,
  profile_generation      INTEGER,
  task_type                TEXT NOT NULL,
  lane                     TEXT NOT NULL,
  mode                     TEXT NOT NULL,
  model                    TEXT,
  task_id                  TEXT,
  experiment_id            TEXT,
  finding_id               TEXT,
  state                    TEXT NOT NULL,
  provider_request_id      TEXT,
  provider_batch_id        TEXT,
  provider_status          TEXT,
  input_file_id            TEXT,
  provider_receipt_artifact_hash TEXT,
  request_artifact_hash    TEXT,
  response_artifact_hash   TEXT,
  request_hash             TEXT,
  policy_hash              TEXT NOT NULL,
  routing_hash             TEXT NOT NULL,
  price_schedule_version   TEXT NOT NULL,
  estimated_input_tokens   INTEGER NOT NULL DEFAULT 0,
  max_output_tokens        INTEGER NOT NULL DEFAULT 0,
  estimated_usd            REAL NOT NULL DEFAULT 0,
  input_usd_per_million    REAL NOT NULL DEFAULT 0,
  cached_input_usd_per_million REAL NOT NULL DEFAULT 0,
  output_usd_per_million   REAL NOT NULL DEFAULT 0,
  batch_discount_fraction REAL NOT NULL DEFAULT 0,
  actual_usd               REAL,
  input_tokens             INTEGER,
  cached_input_tokens      INTEGER,
  output_tokens            INTEGER,
  total_tokens             INTEGER,
  submitted_at             TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  completed_at             TEXT,
  error_code               TEXT,
  error_message            TEXT,
  retryable                INTEGER
);
CREATE INDEX IF NOT EXISTS gateway_calls_target_time
  ON gateway_calls(target_id, submitted_at);
CREATE INDEX IF NOT EXISTS gateway_calls_state
  ON gateway_calls(state, updated_at);
CREATE INDEX IF NOT EXISTS gateway_calls_batch
  ON gateway_calls(provider_batch_id);
CREATE INDEX IF NOT EXISTS gateway_calls_task
  ON gateway_calls(task_type, submitted_at);
CREATE TABLE IF NOT EXISTS gateway_provider_state (
  target_id     TEXT PRIMARY KEY,
  project_id              TEXT,
  target_root_identity    TEXT,
  project_profile_hash    TEXT,
  profile_generation      INTEGER,
  state         TEXT NOT NULL CHECK (state IN ('ready', 'paused_budget')),
  reason        TEXT,
  source_event_id TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`;

function rowState(db: Db, callId: string): GatewayCallState | null {
  const row = db.prepare('SELECT state FROM gateway_calls WHERE call_id = ?').get(callId) as
    | { state?: unknown }
    | undefined;
  if (row === undefined) return null;
  const value = row.state;
  if (typeof value !== 'string' || !(GATEWAY_CALL_STATES as readonly string[]).includes(value)) {
    throw new Error(`Gateway call ${callId} has malformed projected state.`);
  }
  return value as GatewayCallState;
}

function requireState(db: Db, callId: string, allowed: readonly GatewayCallState[], eventId: string): void {
  const current = rowState(db, callId);
  if (current === null) throw new Error(`${eventId} refers to unknown gateway call ${callId}.`);
  if (!allowed.includes(current)) {
    throw new Error(
      `${eventId} cannot transition gateway call ${callId} from ${current}; expected ${allowed.join(' or ')}.`,
    );
  }
}

interface OptionalProjectedProjectBinding {
  readonly project_identity?: ProjectOperationIdentity | undefined;
  readonly profile_generation?: number | undefined;
}

function projectBindingValues(payload: OptionalProjectedProjectBinding): readonly [
  string | null,
  string | null,
  string | null,
  number | null,
] {
  const identity = payload.project_identity;
  return identity === undefined
    ? [null, null, null, null]
    : [
        identity.projectId,
        identity.targetRootIdentity,
        identity.projectProfileHash,
        payload.profile_generation ?? null,
      ];
}

function assertTransitionProjectBinding(
  db: Db,
  callId: string,
  payload: OptionalProjectedProjectBinding,
  eventId: string,
): void {
  const row = db.prepare(
    `SELECT project_id AS projectId, target_root_identity AS targetRootIdentity,
            project_profile_hash AS projectProfileHash, profile_generation AS profileGeneration
       FROM gateway_calls WHERE call_id = ?`,
  ).get(callId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error(`${eventId} refers to unknown gateway call ${callId}.`);

  const projectedIsLegacy =
    row['projectId'] === null &&
    row['targetRootIdentity'] === null &&
    row['projectProfileHash'] === null &&
    row['profileGeneration'] === null;
  const eventIsLegacy =
    payload.project_identity === undefined && payload.profile_generation === undefined;
  if (projectedIsLegacy && eventIsLegacy) return;
  if (projectedIsLegacy !== eventIsLegacy || payload.project_identity === undefined) {
    throw new Error(
      `${eventId} cannot cross the legacy/Project-Profile identity boundary for gateway call ${callId}.`,
    );
  }

  const expected = payload.project_identity;
  if (
    row['projectId'] !== expected.projectId ||
    row['targetRootIdentity'] !== expected.targetRootIdentity ||
    row['projectProfileHash'] !== expected.projectProfileHash ||
    row['profileGeneration'] !== payload.profile_generation
  ) {
    throw new Error(`${eventId} carries a project identity that does not match gateway call ${callId}.`);
  }
}

function ensureColumn(db: Db, table: string, name: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as readonly Record<string, unknown>[];
  if (columns.some((column) => column['name'] === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
}

function ensureGatewaySchemaMigrations(db: Db): void {
  for (const [name, declaration] of [
    ['project_id', 'TEXT'],
    ['target_root_identity', 'TEXT'],
    ['project_profile_hash', 'TEXT'],
    ['profile_generation', 'INTEGER'],
  ] as const) {
    ensureColumn(db, 'gateway_calls', name, declaration);
    ensureColumn(db, 'gateway_provider_state', name, declaration);
  }
}

function projectRefused(db: Db, record: EventRecord): void {
  const payload = gatewayCallRefusedPayloadSchema.parse(record.payload);
  const [projectId, targetRootIdentity, projectProfileHash, profileGeneration] = projectBindingValues(payload);
  db.prepare(
    `INSERT INTO gateway_calls (
       call_id, source_event_id, mission_version, subject_id, target_id,
       project_id, target_root_identity, project_profile_hash, profile_generation,
       task_type, lane, mode, model, task_id, experiment_id, finding_id, state,
       policy_hash, routing_hash, price_schedule_version, submitted_at, updated_at,
       error_code, error_message, retryable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'refused', ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    payload.call_id,
    record.id,
    record.mission_version,
    record.subject_id,
    payload.target_id,
    projectId,
    targetRootIdentity,
    projectProfileHash,
    profileGeneration,
    payload.task_type,
    payload.lane,
    payload.mode,
    payload.model,
    payload.attribution.task_id,
    payload.attribution.experiment_id,
    payload.attribution.finding_id,
    payload.policy_hash,
    payload.routing_hash,
    payload.price_schedule_version,
    payload.requested_at,
    payload.requested_at,
    payload.code,
    payload.reason,
  );
}

function projectStarted(db: Db, record: EventRecord): void {
  const payload = gatewayCallStartedPayloadSchema.parse(record.payload);
  const [projectId, targetRootIdentity, projectProfileHash, profileGeneration] = projectBindingValues(payload);
  db.prepare(
    `INSERT INTO gateway_calls (
       call_id, source_event_id, mission_version, subject_id, target_id,
       project_id, target_root_identity, project_profile_hash, profile_generation,
       task_type, lane, mode, model, task_id, experiment_id, finding_id, state,
       request_artifact_hash, request_hash, policy_hash, routing_hash,
       price_schedule_version, estimated_input_tokens, max_output_tokens, estimated_usd,
       input_usd_per_million, cached_input_usd_per_million, output_usd_per_million,
       batch_discount_fraction, submitted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    payload.call_id,
    record.id,
    record.mission_version,
    record.subject_id,
    payload.target_id,
    projectId,
    targetRootIdentity,
    projectProfileHash,
    profileGeneration,
    payload.task_type,
    payload.lane,
    payload.mode,
    payload.model,
    payload.attribution.task_id,
    payload.attribution.experiment_id,
    payload.attribution.finding_id,
    payload.request_artifact_hash,
    payload.request_hash,
    payload.policy_hash,
    payload.routing_hash,
    payload.price_schedule_version,
    payload.estimated_input_tokens,
    payload.max_output_tokens,
    payload.estimated_usd,
    payload.pricing.input_usd_per_million,
    payload.pricing.cached_input_usd_per_million,
    payload.pricing.output_usd_per_million,
    payload.pricing.batch_discount_fraction,
    payload.started_at,
    payload.started_at,
  );
}

function projectBatchSubmitted(db: Db, record: EventRecord): void {
  const payload = gatewayBatchSubmittedPayloadSchema.parse(record.payload);
  assertTransitionProjectBinding(db, payload.call_id, payload, record.id);
  requireState(db, payload.call_id, ['in_flight'], record.id);
  db.prepare(
    `UPDATE gateway_calls
        SET source_event_id = ?, state = 'batch_pending', provider_batch_id = ?, input_file_id = ?,
            provider_status = ?, provider_receipt_artifact_hash = ?, updated_at = ?
      WHERE call_id = ?`,
  ).run(
    record.id,
    payload.provider_batch_id,
    payload.input_file_id,
    payload.provider_status,
    payload.provider_receipt_artifact_hash,
    payload.submitted_at,
    payload.call_id,
  );
}

function projectBatchPolled(db: Db, record: EventRecord): void {
  const payload = gatewayBatchPolledPayloadSchema.parse(record.payload);
  assertTransitionProjectBinding(db, payload.call_id, payload, record.id);
  requireState(db, payload.call_id, ['batch_pending'], record.id);
  const row = db
    .prepare('SELECT provider_batch_id AS providerBatchId FROM gateway_calls WHERE call_id = ?')
    .get(payload.call_id) as { providerBatchId?: unknown };
  if (row.providerBatchId !== payload.provider_batch_id) {
    throw new Error(`${record.id} provider batch id does not match gateway call ${payload.call_id}.`);
  }
  db.prepare(
    `UPDATE gateway_calls
        SET source_event_id = ?, provider_status = ?, provider_receipt_artifact_hash = ?, updated_at = ?
      WHERE call_id = ?`,
  ).run(record.id, payload.provider_status, payload.provider_receipt_artifact_hash, payload.polled_at, payload.call_id);
}

function projectCompleted(db: Db, record: EventRecord): void {
  const payload = gatewayCallCompletedPayloadSchema.parse(record.payload);
  assertTransitionProjectBinding(db, payload.call_id, payload, record.id);
  requireState(db, payload.call_id, ['in_flight', 'batch_pending'], record.id);
  const row = db
    .prepare('SELECT provider_batch_id AS providerBatchId FROM gateway_calls WHERE call_id = ?')
    .get(payload.call_id) as { providerBatchId?: unknown };
  const existingBatch = typeof row.providerBatchId === 'string' ? row.providerBatchId : null;
  if (existingBatch !== payload.provider_batch_id) {
    throw new Error(`${record.id} provider batch id does not match gateway call ${payload.call_id}.`);
  }
  db.prepare(
    `UPDATE gateway_calls
        SET source_event_id = ?, state = 'completed', provider_request_id = ?,
            response_artifact_hash = ?, model = ?, actual_usd = ?, input_tokens = ?,
            cached_input_tokens = ?, output_tokens = ?, total_tokens = ?, updated_at = ?,
            completed_at = ?, provider_status = COALESCE(provider_status, 'completed')
      WHERE call_id = ?`,
  ).run(
    record.id,
    payload.provider_request_id,
    payload.response_artifact_hash,
    payload.provider_model,
    payload.actual_usd,
    payload.usage.input_tokens,
    payload.usage.cached_input_tokens,
    payload.usage.output_tokens,
    payload.usage.total_tokens,
    payload.completed_at,
    payload.completed_at,
    payload.call_id,
  );
}

function projectFailed(db: Db, record: EventRecord): void {
  const payload = gatewayCallFailedPayloadSchema.parse(record.payload);
  assertTransitionProjectBinding(db, payload.call_id, payload, record.id);
  requireState(db, payload.call_id, ['in_flight', 'batch_pending'], record.id);
  const row = db
    .prepare('SELECT provider_batch_id AS providerBatchId FROM gateway_calls WHERE call_id = ?')
    .get(payload.call_id) as { providerBatchId?: unknown };
  const existingBatch = typeof row.providerBatchId === 'string' ? row.providerBatchId : null;
  if (payload.provider_batch_id !== null && existingBatch !== payload.provider_batch_id) {
    throw new Error(`${record.id} provider batch id does not match gateway call ${payload.call_id}.`);
  }
  db.prepare(
    `UPDATE gateway_calls
        SET source_event_id = ?, state = 'failed', provider_status = COALESCE(?, provider_status),
            error_code = ?, error_message = ?, retryable = ?, updated_at = ?, completed_at = ?
      WHERE call_id = ?`,
  ).run(
    record.id,
    payload.provider_status,
    payload.code,
    payload.reason,
    payload.retryable ? 1 : 0,
    payload.failed_at,
    payload.failed_at,
    payload.call_id,
  );

  // Provider funding state is a durable read model, not an O(n) observer replay. Older
  // gateway.call_failed events may lack target_id; those cannot authoritatively change
  // target-scoped provider state and are intentionally ignored for this projection.
  if (payload.target_id !== undefined && ['PROVIDER_BUDGET_EXHAUSTED', 'PROVIDER_BUDGET_PAUSED'].includes(payload.code)) {
    const [projectId, targetRootIdentity, projectProfileHash, profileGeneration] =
      projectBindingValues(payload);
    db.prepare(
      `INSERT INTO gateway_provider_state (
         target_id, project_id, target_root_identity, project_profile_hash, profile_generation,
         state, reason, source_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, 'paused_budget', ?, ?, ?)
       ON CONFLICT(target_id) DO UPDATE SET
         project_id = excluded.project_id,
         target_root_identity = excluded.target_root_identity,
         project_profile_hash = excluded.project_profile_hash,
         profile_generation = excluded.profile_generation,
         state = excluded.state, reason = excluded.reason,
         source_event_id = excluded.source_event_id, updated_at = excluded.updated_at`,
    ).run(
      payload.target_id,
      projectId,
      targetRootIdentity,
      projectProfileHash,
      profileGeneration,
      payload.reason,
      record.id,
      payload.failed_at,
    );
  }
}

export const gatewayProviderResumedPayloadSchema = z
  .object({
    target_id: z.string().min(1),
    ...optionalProjectBindingShape,
    provider: z.literal('openai'),
    model: z.string().min(1),
    resumed_at: iso,
  })
  .strict()
  .superRefine(requireCompleteOptionalProjectBinding);

function projectProviderResumed(db: Db, record: EventRecord): void {
  const payload = gatewayProviderResumedPayloadSchema.parse(record.payload);
  const [projectId, targetRootIdentity, projectProfileHash, profileGeneration] = projectBindingValues(payload);
  db.prepare(
    `INSERT INTO gateway_provider_state (
       target_id, project_id, target_root_identity, project_profile_hash, profile_generation,
       state, reason, source_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ready', NULL, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET
       project_id = excluded.project_id,
       target_root_identity = excluded.target_root_identity,
       project_profile_hash = excluded.project_profile_hash,
       profile_generation = excluded.profile_generation,
       state = excluded.state, reason = NULL,
       source_event_id = excluded.source_event_id, updated_at = excluded.updated_at`,
  ).run(
    payload.target_id,
    projectId,
    targetRootIdentity,
    projectProfileHash,
    profileGeneration,
    record.id,
    payload.resumed_at,
  );
}

export const GATEWAY_PROJECTION: ProjectionModule = {
  name: 'gateway',
  install(db: Db): void {
    db.exec(GATEWAY_SCHEMA_SQL);
    ensureGatewaySchemaMigrations(db);
  },
  tables: ['gateway_calls', 'gateway_provider_state'],
  projectors: {
    [GATEWAY_EVENT_TYPES.callRefused]: projectRefused,
    [GATEWAY_EVENT_TYPES.callStarted]: projectStarted,
    [GATEWAY_EVENT_TYPES.batchSubmitted]: projectBatchSubmitted,
    [GATEWAY_EVENT_TYPES.batchPolled]: projectBatchPolled,
    [GATEWAY_EVENT_TYPES.callCompleted]: projectCompleted,
    [GATEWAY_EVENT_TYPES.callFailed]: projectFailed,
    [GATEWAY_EVENT_TYPES.providerResumed]: projectProviderResumed,
  },
};

export interface GatewayCallRecord {
  readonly callId: string;
  readonly missionVersion: string;
  readonly subjectId: string | null;
  readonly targetId: string;
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
  readonly taskType: GatewayTaskType;
  readonly lane: GatewayLane;
  readonly mode: GatewayCallMode;
  readonly model: string | null;
  readonly attribution: {
    readonly taskId: string | null;
    readonly experimentId: string | null;
    readonly findingId: string | null;
  };
  readonly state: GatewayCallState;
  readonly providerRequestId: string | null;
  readonly providerBatchId: string | null;
  readonly providerStatus: string | null;
  readonly providerReceiptArtifactHash: string | null;
  readonly requestArtifactHash: string | null;
  readonly responseArtifactHash: string | null;
  readonly estimatedUsd: number;
  readonly pricing: {
    readonly inputUsdPerMillion: number;
    readonly cachedInputUsdPerMillion: number;
    readonly outputUsdPerMillion: number;
    readonly batchDiscountFraction: number;
  };
  readonly actualUsd: number | null;
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${label} is not a string.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  const read = nullableString(value, label);
  if (read === null || read.length === 0) throw new Error(`${label} is missing.`);
  return read;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} is not a number.`);
  return value;
}

function parseCallRow(row: Record<string, unknown>): GatewayCallRecord {
  const taskType = requiredString(row['taskType'], 'gateway task type');
  const lane = requiredString(row['lane'], 'gateway lane');
  const mode = requiredString(row['mode'], 'gateway mode');
  const state = requiredString(row['state'], 'gateway state');
  if (!(GATEWAY_TASK_TYPES as readonly string[]).includes(taskType)) throw new Error(`Unknown task type ${taskType}.`);
  if (!(GATEWAY_LANES as readonly string[]).includes(lane)) throw new Error(`Unknown gateway lane ${lane}.`);
  if (!(GATEWAY_CALL_MODES as readonly string[]).includes(mode)) throw new Error(`Unknown gateway mode ${mode}.`);
  if (!(GATEWAY_CALL_STATES as readonly string[]).includes(state)) throw new Error(`Unknown gateway state ${state}.`);
  return {
    callId: requiredString(row['callId'], 'gateway call id'),
    missionVersion: requiredString(row['missionVersion'], 'gateway mission'),
    subjectId: nullableString(row['subjectId'], 'gateway subject'),
    targetId: requiredString(row['targetId'], 'gateway target'),
    projectIdentity:
      row['projectProfileHash'] === null || row['projectProfileHash'] === undefined
        ? null
        : projectOperationIdentitySchema.parse({
            projectId: requiredString(row['projectId'], 'gateway project id'),
            targetRootIdentity: requiredString(row['targetRootIdentity'], 'gateway target-root identity'),
            projectProfileHash: requiredString(row['projectProfileHash'], 'gateway Project Profile hash'),
          }),
    profileGeneration:
      row['profileGeneration'] === null || row['profileGeneration'] === undefined
        ? null
        : requiredNumber(row['profileGeneration'], 'gateway Project Profile generation'),
    taskType: taskType as GatewayTaskType,
    lane: lane as GatewayLane,
    mode: mode as GatewayCallMode,
    model: nullableString(row['model'], 'gateway model'),
    attribution: {
      taskId: nullableString(row['taskId'], 'gateway task attribution'),
      experimentId: nullableString(row['experimentId'], 'gateway experiment attribution'),
      findingId: nullableString(row['findingId'], 'gateway finding attribution'),
    },
    state: state as GatewayCallState,
    providerRequestId: nullableString(row['providerRequestId'], 'provider request id'),
    providerBatchId: nullableString(row['providerBatchId'], 'provider batch id'),
    providerStatus: nullableString(row['providerStatus'], 'provider status'),
    providerReceiptArtifactHash: nullableString(row['providerReceiptArtifactHash'], 'provider receipt artifact hash'),
    requestArtifactHash: nullableString(row['requestArtifactHash'], 'request artifact hash'),
    responseArtifactHash: nullableString(row['responseArtifactHash'], 'response artifact hash'),
    estimatedUsd: requiredNumber(row['estimatedUsd'], 'estimated gateway cost'),
    pricing: {
      inputUsdPerMillion: requiredNumber(row['inputUsdPerMillion'], 'gateway input price'),
      cachedInputUsdPerMillion: requiredNumber(row['cachedInputUsdPerMillion'], 'gateway cached input price'),
      outputUsdPerMillion: requiredNumber(row['outputUsdPerMillion'], 'gateway output price'),
      batchDiscountFraction: requiredNumber(row['batchDiscountFraction'], 'gateway batch discount'),
    },
    actualUsd: row['actualUsd'] === null || row['actualUsd'] === undefined ? null : requiredNumber(row['actualUsd'], 'actual gateway cost'),
    submittedAt: requiredString(row['submittedAt'], 'gateway submitted time'),
    updatedAt: requiredString(row['updatedAt'], 'gateway updated time'),
    completedAt: nullableString(row['completedAt'], 'gateway completed time'),
    errorCode: nullableString(row['errorCode'], 'gateway error code'),
    errorMessage: nullableString(row['errorMessage'], 'gateway error message'),
  };
}

const CALL_SELECT = `
SELECT call_id AS callId, mission_version AS missionVersion, subject_id AS subjectId,
       target_id AS targetId, project_id AS projectId,
       target_root_identity AS targetRootIdentity, project_profile_hash AS projectProfileHash,
       profile_generation AS profileGeneration, task_type AS taskType, lane, mode, model,
       task_id AS taskId, experiment_id AS experimentId, finding_id AS findingId, state,
       provider_request_id AS providerRequestId, provider_batch_id AS providerBatchId,
       provider_status AS providerStatus, provider_receipt_artifact_hash AS providerReceiptArtifactHash,
       request_artifact_hash AS requestArtifactHash,
       response_artifact_hash AS responseArtifactHash, estimated_usd AS estimatedUsd,
       input_usd_per_million AS inputUsdPerMillion,
       cached_input_usd_per_million AS cachedInputUsdPerMillion,
       output_usd_per_million AS outputUsdPerMillion,
       batch_discount_fraction AS batchDiscountFraction, actual_usd AS actualUsd, submitted_at AS submittedAt, updated_at AS updatedAt,
       completed_at AS completedAt, error_code AS errorCode, error_message AS errorMessage
  FROM gateway_calls`;

export function readGatewayCall(
  projections: ProjectionStore,
  callId: string,
): GatewayCallRecord | null {
  const row = projections.db.prepare(`${CALL_SELECT} WHERE call_id = ?`).get(callId) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : parseCallRow(row);
}

export interface GatewayProviderProjectionState {
  readonly state: 'ready' | 'unknown' | 'paused_budget';
  readonly reason: string | null;
  readonly eventId: string | null;
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
}

export function readGatewayProviderProjectionState(
  projections: ProjectionStore,
  targetId: string,
): GatewayProviderProjectionState {
  const row = projections.db
    .prepare(
      `SELECT state, reason, source_event_id AS eventId,
              project_id AS projectId, target_root_identity AS targetRootIdentity,
              project_profile_hash AS projectProfileHash,
              profile_generation AS profileGeneration
         FROM gateway_provider_state
        WHERE target_id = ?`,
    )
    .get(targetId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    return {
      state: 'unknown',
      reason: null,
      eventId: null,
      projectIdentity: null,
      profileGeneration: null,
    };
  }
  const state = requiredString(row['state'], 'gateway provider state');
  if (state !== 'ready' && state !== 'paused_budget') {
    throw new Error(`Unknown gateway provider state ${state}.`);
  }
  const hasProjectIdentity =
    row['projectId'] !== null ||
    row['targetRootIdentity'] !== null ||
    row['projectProfileHash'] !== null ||
    row['profileGeneration'] !== null;
  if (
    hasProjectIdentity &&
    (row['projectId'] === null ||
      row['targetRootIdentity'] === null ||
      row['projectProfileHash'] === null ||
      row['profileGeneration'] === null)
  ) {
    throw new Error(`Gateway provider state for ${targetId} has a partial project binding.`);
  }
  return {
    state,
    reason: nullableString(row['reason'], 'gateway provider reason'),
    eventId: requiredString(row['eventId'], 'gateway provider source event'),
    projectIdentity: hasProjectIdentity
      ? projectOperationIdentitySchema.parse({
          projectId: requiredString(row['projectId'], 'gateway provider project id'),
          targetRootIdentity: requiredString(
            row['targetRootIdentity'],
            'gateway provider target-root identity',
          ),
          projectProfileHash: requiredString(
            row['projectProfileHash'],
            'gateway provider Project Profile hash',
          ),
        })
      : null,
    profileGeneration: hasProjectIdentity
      ? requiredNumber(row['profileGeneration'], 'gateway provider profile generation')
      : null,
  };
}

export interface GatewayAggregateFacts {
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly refused: number;
  readonly pending: number;
  readonly todayActualUsd: number;
  readonly monthActualUsd: number;
  readonly reservedUsd: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latest: GatewayCallRecord | null;
}

function countValue(row: unknown): number {
  if (typeof row !== 'object' || row === null) return 0;
  const value = (row as Record<string, unknown>)['n'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sumValue(row: unknown): number {
  if (typeof row !== 'object' || row === null) return 0;
  const value = (row as Record<string, unknown>)['total'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function readGatewayAggregateFacts(
  projections: ProjectionStore,
  targetId: string,
  at: string,
): GatewayAggregateFacts {
  const db = projections.db;
  const count = (where: string, ...params: unknown[]): number =>
    countValue(db.prepare(`SELECT COUNT(*) AS n FROM gateway_calls WHERE target_id = ? AND ${where}`).get(targetId, ...params));
  const date = at.slice(0, 10);
  const month = at.slice(0, 7);
  const latestRow = db
    .prepare(`${CALL_SELECT} WHERE target_id = ? ORDER BY submitted_at DESC, call_id DESC LIMIT 1`)
    .get(targetId) as Record<string, unknown> | undefined;
  return {
    submitted: count("state <> 'refused'"),
    completed: count("state = 'completed'"),
    failed: count("state = 'failed'"),
    refused: count("state = 'refused'"),
    pending: count("state IN ('in_flight', 'batch_pending')"),
    todayActualUsd: sumValue(
      db
        .prepare(
          `SELECT COALESCE(SUM(actual_usd), 0) AS total FROM gateway_calls
            WHERE target_id = ? AND state = 'completed' AND substr(completed_at, 1, 10) = ?`,
        )
        .get(targetId, date),
    ),
    monthActualUsd: sumValue(
      db
        .prepare(
          `SELECT COALESCE(SUM(actual_usd), 0) AS total FROM gateway_calls
            WHERE target_id = ? AND state = 'completed' AND substr(completed_at, 1, 7) = ?`,
        )
        .get(targetId, month),
    ),
    reservedUsd: sumValue(
      db
        .prepare(
          `SELECT COALESCE(SUM(estimated_usd), 0) AS total FROM gateway_calls
            WHERE target_id = ? AND state IN ('in_flight', 'batch_pending')`,
        )
        .get(targetId),
    ),
    inputTokens: sumValue(
      db.prepare(`SELECT COALESCE(SUM(input_tokens), 0) AS total FROM gateway_calls WHERE target_id = ? AND state = 'completed'`).get(targetId),
    ),
    cachedInputTokens: sumValue(
      db.prepare(`SELECT COALESCE(SUM(cached_input_tokens), 0) AS total FROM gateway_calls WHERE target_id = ? AND state = 'completed'`).get(targetId),
    ),
    outputTokens: sumValue(
      db.prepare(`SELECT COALESCE(SUM(output_tokens), 0) AS total FROM gateway_calls WHERE target_id = ? AND state = 'completed'`).get(targetId),
    ),
    totalTokens: sumValue(
      db.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS total FROM gateway_calls WHERE target_id = ? AND state = 'completed'`).get(targetId),
    ),
    latest: latestRow === undefined ? null : parseCallRow(latestRow),
  };
}
