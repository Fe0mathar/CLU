/**
 * CLU-E Operational Console contract.
 *
 * The console is a source-faithful projection of real CLU-E operations. It may animate,
 * group, filter, and summarize events, but it may never invent traffic or reorder truth.
 */

import { z } from 'zod';

import type { Sha256 } from '../../shared/ids.js';

export const OPERATIONAL_CONSOLE_SCHEMA_VERSION = '1.0.0' as const;

export const OPERATIONAL_CONSOLE_CHANNELS = [
  'CLUE_CORE',
  'RECOGNITION',
  'GPT',
  'BENCHMARK',
  'POWERSHELL',
  'CHROME_CDP',
  'PROOF',
  'CUSTODIAN',
  'GREAT_BOOK',
  'STATUS',
] as const;
export type OperationalConsoleChannel = (typeof OPERATIONAL_CONSOLE_CHANNELS)[number];

export const OPERATIONAL_CONSOLE_DIRECTIONS = ['OUTBOUND', 'INBOUND', 'INTERNAL'] as const;
export type OperationalConsoleDirection = (typeof OPERATIONAL_CONSOLE_DIRECTIONS)[number];

export const OPERATIONAL_CONSOLE_KINDS = [
  'command',
  'request',
  'response',
  'code',
  'result',
  'state',
  'warning',
  'error',
  'checkpoint',
  'artifact',
  'summary',
] as const;
export type OperationalConsoleKind = (typeof OPERATIONAL_CONSOLE_KINDS)[number];

export const OPERATIONAL_CONSOLE_PAYLOAD_FORMATS = [
  'text',
  'json',
  'typescript',
  'javascript',
  'powershell',
  'shell',
  'wgsl',
  'markdown',
  'http',
] as const;
export type OperationalConsolePayloadFormat =
  (typeof OPERATIONAL_CONSOLE_PAYLOAD_FORMATS)[number];

export const OPERATIONAL_CONSOLE_VALIDATION_STATES = [
  'pending',
  'received',
  'schema_validated',
  'policy_accepted',
  'evidence_admissible',
  'evidence_rejected',
  'not_applicable',
] as const;
export type OperationalConsoleValidationState =
  (typeof OPERATIONAL_CONSOLE_VALIDATION_STATES)[number];

export const OPERATIONAL_CONSOLE_CUES = [
  'transmit',
  'receive',
  'benchmark_start',
  'benchmark_lock',
  'checkpoint',
  'proof_accept',
  'warning_fracture',
  'error_fracture',
  'great_book_transfer',
  'status_seal',
  'idle',
] as const;
export type OperationalConsoleCinematicCue = (typeof OPERATIONAL_CONSOLE_CUES)[number];

export interface CurrentWorkContract {
  readonly targetId: string | null;
  readonly targetLabel: string;
  readonly metricId: string | null;
  readonly metricLabel: string | null;
  readonly what: string;
  readonly why: string;
  readonly howProven: string;
  readonly whoOrModel: string;
  readonly currentStatus: string;
  readonly next: string;
  readonly proofContractHash: Sha256 | null;
  readonly taskId: string | null;
  readonly logicalSessionId: string | null;
  readonly updatedAt: string;
}

export interface OperationalConsolePayload {
  /** Exact transmitted/received text after mandatory policy redaction. */
  readonly preview: string;
  readonly format: OperationalConsolePayloadFormat;
  /** False means the full redacted payload is available through artifactHash. */
  readonly complete: boolean;
  readonly byteLength: number;
  readonly artifactHash: Sha256;
  readonly redactionCount: number;
}

export interface OperationalConsoleEvent {
  readonly schemaVersion: typeof OPERATIONAL_CONSOLE_SCHEMA_VERSION;
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly channel: OperationalConsoleChannel;
  readonly direction: OperationalConsoleDirection;
  readonly kind: OperationalConsoleKind;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly status: string;
  readonly nextAction: string | null;
  readonly payload: OperationalConsolePayload | null;
  readonly sourceIds: readonly string[];
  readonly taskId: string | null;
  readonly logicalSessionId: string | null;
  readonly physicalCallId: string | null;
  readonly runId: string | null;
  readonly benchmarkId: string | null;
  readonly proofContractId: string | null;
  readonly patchId: string | null;
  readonly landingId: string | null;
  readonly requestId: string | null;
  readonly exchangeId: string | null;
  readonly durationMs: number | null;
  readonly validationState: OperationalConsoleValidationState;
  readonly redactionApplied: boolean;
  readonly cinematicCue: OperationalConsoleCinematicCue | null;
  readonly currentWork: CurrentWorkContract | null;
  readonly previousHash: Sha256 | null;
  readonly eventHash: Sha256;
}

export interface OperationalConsoleSeal {
  readonly eventHeadHash: Sha256 | null;
  readonly projectionHash: Sha256;
  readonly capturedAt: string;
}

export interface OperationalConsoleProjection {
  readonly schemaVersion: typeof OPERATIONAL_CONSOLE_SCHEMA_VERSION;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly droppedEvents: number;
  readonly collapsedEvents: number;
  readonly activeChannels: readonly OperationalConsoleChannel[];
  readonly currentWorkContract: CurrentWorkContract | null;
  readonly events: readonly OperationalConsoleEvent[];
  readonly seal: OperationalConsoleSeal;
}

const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .transform((value) => value as Sha256);
const nullableId = z.string().min(1).nullable();

export const currentWorkContractSchema = z
  .object({
    targetId: nullableId,
    targetLabel: z.string().min(1),
    metricId: nullableId,
    metricLabel: z.string().min(1).nullable(),
    what: z.string().min(1),
    why: z.string().min(1),
    howProven: z.string().min(1),
    whoOrModel: z.string().min(1),
    currentStatus: z.string().min(1),
    next: z.string().min(1),
    proofContractHash: sha256Schema.nullable(),
    taskId: nullableId,
    logicalSessionId: nullableId,
    updatedAt: z.string().datetime(),
  })
  .strict();

export const operationalConsolePayloadSchema = z
  .object({
    preview: z.string(),
    format: z.enum(OPERATIONAL_CONSOLE_PAYLOAD_FORMATS),
    complete: z.boolean(),
    byteLength: z.number().int().nonnegative(),
    artifactHash: sha256Schema,
    redactionCount: z.number().int().nonnegative(),
  })
  .strict();

export const operationalConsoleEventSchema = z
  .object({
    schemaVersion: z.literal(OPERATIONAL_CONSOLE_SCHEMA_VERSION),
    eventId: z.string().regex(/^OCE-[0-9]{8,}$/),
    sequence: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    channel: z.enum(OPERATIONAL_CONSOLE_CHANNELS),
    direction: z.enum(OPERATIONAL_CONSOLE_DIRECTIONS),
    kind: z.enum(OPERATIONAL_CONSOLE_KINDS),
    title: z.string().min(1),
    what: z.string().min(1),
    why: z.string().min(1),
    status: z.string().min(1),
    nextAction: z.string().min(1).nullable(),
    payload: operationalConsolePayloadSchema.nullable(),
    sourceIds: z.array(z.string().min(1)),
    taskId: nullableId,
    logicalSessionId: nullableId,
    physicalCallId: nullableId,
    runId: nullableId,
    benchmarkId: nullableId,
    proofContractId: nullableId,
    patchId: nullableId,
    landingId: nullableId,
    requestId: nullableId,
    exchangeId: nullableId,
    durationMs: z.number().nonnegative().nullable(),
    validationState: z.enum(OPERATIONAL_CONSOLE_VALIDATION_STATES),
    redactionApplied: z.boolean(),
    cinematicCue: z.enum(OPERATIONAL_CONSOLE_CUES).nullable(),
    currentWork: currentWorkContractSchema.nullable(),
    previousHash: sha256Schema.nullable(),
    eventHash: sha256Schema,
  })
  .strict();

export const operationalConsoleProjectionSchema = z
  .object({
    schemaVersion: z.literal(OPERATIONAL_CONSOLE_SCHEMA_VERSION),
    firstSequence: z.number().int().nonnegative().nullable(),
    lastSequence: z.number().int().nonnegative().nullable(),
    droppedEvents: z.number().int().nonnegative(),
    collapsedEvents: z.number().int().nonnegative(),
    activeChannels: z.array(z.enum(OPERATIONAL_CONSOLE_CHANNELS)),
    currentWorkContract: currentWorkContractSchema.nullable(),
    events: z.array(operationalConsoleEventSchema),
    seal: z
      .object({
        eventHeadHash: sha256Schema.nullable(),
        projectionHash: sha256Schema,
        capturedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export function parseOperationalConsoleEvent(input: unknown): OperationalConsoleEvent {
  return operationalConsoleEventSchema.parse(input) as unknown as OperationalConsoleEvent;
}

export function parseOperationalConsoleProjection(input: unknown): OperationalConsoleProjection {
  return operationalConsoleProjectionSchema.parse(input) as unknown as OperationalConsoleProjection;
}
