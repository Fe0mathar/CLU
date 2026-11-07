export const CHANNELS = [
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
export type Channel = (typeof CHANNELS)[number];

export type Direction = 'OUTBOUND' | 'INBOUND' | 'INTERNAL';
export type EventKind =
  | 'command'
  | 'request'
  | 'response'
  | 'code'
  | 'result'
  | 'state'
  | 'warning'
  | 'error'
  | 'checkpoint'
  | 'artifact'
  | 'summary';

export type PayloadFormat =
  | 'text'
  | 'json'
  | 'typescript'
  | 'javascript'
  | 'powershell'
  | 'shell'
  | 'wgsl'
  | 'markdown'
  | 'http';

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
  readonly proofContractHash: string | null;
  readonly taskId: string | null;
  readonly logicalSessionId: string | null;
  readonly updatedAt: string;
}

export interface ConsolePayload {
  readonly preview: string;
  readonly format: PayloadFormat;
  readonly complete: boolean;
  readonly byteLength: number;
  readonly artifactHash: string;
  readonly redactionCount: number;
}

export interface ConsoleEvent {
  readonly schemaVersion: '1.0.0';
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly channel: Channel;
  readonly direction: Direction;
  readonly kind: EventKind;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly status: string;
  readonly nextAction: string | null;
  readonly payload: ConsolePayload | null;
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
  readonly validationState: string;
  readonly redactionApplied: boolean;
  readonly cinematicCue: string | null;
  readonly currentWork: CurrentWorkContract | null;
  readonly previousHash: string | null;
  readonly eventHash: string;
}

export interface ConsoleProjection {
  readonly schemaVersion: '1.0.0';
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly droppedEvents: number;
  readonly collapsedEvents: number;
  readonly activeChannels: readonly Channel[];
  readonly currentWorkContract: CurrentWorkContract | null;
  readonly events: readonly ConsoleEvent[];
  readonly seal: {
    readonly eventHeadHash: string | null;
    readonly projectionHash: string;
    readonly capturedAt: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseConsoleEvent(value: unknown): ConsoleEvent {
  if (!isRecord(value)) throw new Error('Operational Console event is not an object.');
  if (value['schemaVersion'] !== '1.0.0') throw new Error('Unsupported console event schema.');
  if (typeof value['sequence'] !== 'number') throw new Error('Console event lacks sequence.');
  if (typeof value['eventId'] !== 'string') throw new Error('Console event lacks eventId.');
  if (!CHANNELS.includes(value['channel'] as Channel)) throw new Error('Unknown console channel.');
  if (typeof value['title'] !== 'string') throw new Error('Console event lacks title.');
  return value as unknown as ConsoleEvent;
}

export function parseConsoleProjection(value: unknown): ConsoleProjection {
  if (!isRecord(value) || value['schemaVersion'] !== '1.0.0') {
    throw new Error('Unsupported Operational Console projection.');
  }
  if (!Array.isArray(value['events'])) throw new Error('Console projection lacks events.');
  const projection = value as unknown as ConsoleProjection;
  for (const event of projection.events) parseConsoleEvent(event);
  return projection;
}
