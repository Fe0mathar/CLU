/** Projects the append-only event stream into the exact console state the UI consumes. */

import { hashCanonicalJson, nowIso } from '../../shared/ids.js';
import {
  OPERATIONAL_CONSOLE_SCHEMA_VERSION,
  operationalConsoleProjectionSchema,
  type CurrentWorkContract,
  type OperationalConsoleChannel,
  type OperationalConsoleEvent,
  type OperationalConsoleProjection,
} from './contract.js';
import { readOperationalConsoleEvents } from './store.js';

export interface ProjectionOptions {
  readonly limit?: number;
  readonly capturedAt?: string;
  readonly droppedEvents?: number;
  readonly collapsedEvents?: number;
}

function latestCurrentWork(events: readonly OperationalConsoleEvent[]): CurrentWorkContract | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.currentWork !== null && event?.currentWork !== undefined) return event.currentWork;
  }
  return null;
}

function activeChannels(events: readonly OperationalConsoleEvent[]): readonly OperationalConsoleChannel[] {
  const open = new Map<string, OperationalConsoleChannel>();
  for (const event of events) {
    if (event.exchangeId === null) continue;
    if (event.direction === 'OUTBOUND' && event.validationState === 'pending') {
      open.set(event.exchangeId, event.channel);
      continue;
    }
    if (event.direction === 'INBOUND') open.delete(event.exchangeId);
  }
  return [...new Set(open.values())];
}

export function projectOperationalConsole(
  eventFile: string,
  options: ProjectionOptions = {},
): OperationalConsoleProjection {
  const all = readOperationalConsoleEvents(eventFile);
  const limit = Math.max(1, options.limit ?? 250);
  const events = all.slice(Math.max(0, all.length - limit));
  const capturedAt = options.capturedAt ?? nowIso();
  const body = {
    schemaVersion: OPERATIONAL_CONSOLE_SCHEMA_VERSION,
    firstSequence: events[0]?.sequence ?? null,
    lastSequence: events.at(-1)?.sequence ?? null,
    droppedEvents: options.droppedEvents ?? 0,
    collapsedEvents: options.collapsedEvents ?? 0,
    activeChannels: activeChannels(events),
    currentWorkContract: latestCurrentWork(all),
    events,
  } as const;
  const projection: OperationalConsoleProjection = {
    ...body,
    seal: {
      eventHeadHash: all.at(-1)?.eventHash ?? null,
      projectionHash: hashCanonicalJson(body),
      capturedAt,
    },
  };
  return operationalConsoleProjectionSchema.parse(projection) as unknown as OperationalConsoleProjection;
}

export function emptyOperationalConsoleProjection(capturedAt: string): OperationalConsoleProjection {
  const body = {
    schemaVersion: OPERATIONAL_CONSOLE_SCHEMA_VERSION,
    firstSequence: null,
    lastSequence: null,
    droppedEvents: 0,
    collapsedEvents: 0,
    activeChannels: [],
    currentWorkContract: null,
    events: [],
  } as const;
  return {
    ...body,
    seal: {
      eventHeadHash: null,
      projectionHash: hashCanonicalJson(body),
      capturedAt,
    },
  };
}
