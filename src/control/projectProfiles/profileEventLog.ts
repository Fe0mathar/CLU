/** Sanitized, hash-chained Project Profile authority event log. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, hashCanonicalJson, nowIso } from '../../shared/ids.js';
import {
  actorSchema,
  isoTimestampSchema,
  projectIdSchema,
  projectProfileHashSchema,
  sha256Schema,
  targetRootIdentitySchema,
} from '../../shared/schemas.js';
import { appendLineDurably, withExclusiveFileLock } from './profileFileSystem.js';

export const PROFILE_EVENT_VERSION = 'clue-project-profile-event/1' as const;

export const profileEventTypeSchema = z.enum([
  'project-profile.created',
  'project-profile.updated',
  'project-profile.activated',
  'project-profile.validation_failed',
  'project-profile.deleted',
  'project-authority.changed',
]);
export type ProfileEventType = z.infer<typeof profileEventTypeSchema>;

const nullableGenerationSchema = z.number().int().positive().nullable();
const transactionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'invalid transaction id');
const reasonCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z0-9][A-Z0-9._:-]*$/u, 'reasonCode must be a closed machine code')
  .nullable();

const profileEventInputShape = {
  transactionId: transactionIdSchema,
  type: profileEventTypeSchema,
  actor: actorSchema,
  projectId: projectIdSchema,
  targetRootIdentity: targetRootIdentitySchema,
  previousGeneration: nullableGenerationSchema,
  generation: nullableGenerationSchema,
  previousProfileHash: projectProfileHashSchema.nullable(),
  projectProfileHash: projectProfileHashSchema.nullable(),
  previousAuthorityHash: sha256Schema.nullable(),
  authorityHash: sha256Schema.nullable(),
  registryGeneration: z.number().int().nonnegative(),
  reasonCode: reasonCodeSchema,
} as const;

type ProfileEventInputShape = z.infer<z.ZodObject<typeof profileEventInputShape>>;

function validateEventSemantics(value: ProfileEventInputShape, ctx: z.RefinementCtx): void {
  const requireNew = (): void => {
    if (value.generation === null || value.projectProfileHash === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.type} requires generation and projectProfileHash`,
      });
    }
  };
  const requirePrevious = (): void => {
    if (value.previousGeneration === null || value.previousProfileHash === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.type} requires previousGeneration and previousProfileHash`,
      });
    }
  };

  switch (value.type) {
    case 'project-profile.created':
      requireNew();
      break;
    case 'project-profile.updated':
      requirePrevious();
      requireNew();
      break;
    case 'project-profile.deleted':
      requirePrevious();
      break;
    case 'project-profile.activated':
      requireNew();
      break;
    case 'project-profile.validation_failed':
      if (value.reasonCode === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reasonCode'],
          message: 'validation_failed requires reasonCode',
        });
      }
      break;
    case 'project-authority.changed':
      requirePrevious();
      requireNew();
      if (value.previousAuthorityHash === null || value.authorityHash === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'project-authority.changed requires previous and new authority hashes',
        });
      }
      break;
  }
}

export const profileEventInputSchema = z
  .object(profileEventInputShape)
  .strict()
  .superRefine(validateEventSemantics);
export type ProfileEventInput = z.infer<typeof profileEventInputSchema>;

const profileEventRecordShape = {
  ...profileEventInputShape,
  eventVersion: z.literal(PROFILE_EVENT_VERSION),
  eventId: z.string().regex(/^PROFILE-EVENT-[0-9]{6,}$/u),
  sequence: z.number().int().positive(),
  timestamp: isoTimestampSchema,
  previousEventHash: sha256Schema.nullable(),
  eventHash: sha256Schema,
} as const;

export const profileEventSchema = z
  .object(profileEventRecordShape)
  .strict()
  .superRefine(validateEventSemantics);
export type ProfileEvent = z.infer<typeof profileEventSchema>;

export type ProfileEventLogErrorCode =
  | 'MALFORMED_EVENT'
  | 'SEQUENCE_GAP'
  | 'CHAIN_BROKEN'
  | 'HASH_MISMATCH'
  | 'TRANSACTION_CONFLICT';

export class ProfileEventLogError extends Error {
  public readonly code: ProfileEventLogErrorCode;
  public readonly sequence: number | null;

  public constructor(
    code: ProfileEventLogErrorCode,
    message: string,
    sequence: number | null = null,
  ) {
    super(message);
    this.name = 'ProfileEventLogError';
    this.code = code;
    this.sequence = sequence;
  }
}

function eventHashBasis(event: Omit<ProfileEvent, 'eventHash'>): unknown {
  return event;
}

function comparableInput(event: ProfileEvent): ProfileEventInput {
  return {
    transactionId: event.transactionId,
    type: event.type,
    actor: event.actor,
    projectId: event.projectId,
    targetRootIdentity: event.targetRootIdentity,
    previousGeneration: event.previousGeneration,
    generation: event.generation,
    previousProfileHash: event.previousProfileHash,
    projectProfileHash: event.projectProfileHash,
    previousAuthorityHash: event.previousAuthorityHash,
    authorityHash: event.authorityHash,
    registryGeneration: event.registryGeneration,
    reasonCode: event.reasonCode,
  };
}

export class ProfileEventLog {
  public readonly eventsPath: string;
  private readonly lockPath: string;
  private readonly now: () => string;

  public constructor(
    profilesRoot: string,
    options: { readonly now?: () => string } = {},
  ) {
    this.eventsPath = join(profilesRoot, 'events', 'profile-events.ndjson');
    this.lockPath = join(profilesRoot, '.locks', 'profile-events.lock');
    this.now = options.now ?? nowIso;
  }

  public replay(): readonly ProfileEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const text = readFileSync(this.eventsPath, 'utf8');
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    const events: ProfileEvent[] = [];
    let previousHash: string | null = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;
      let event: ProfileEvent;
      try {
        event = profileEventSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new ProfileEventLogError(
          'MALFORMED_EVENT',
          `Malformed Project Profile event at line ${index + 1}: ${(error as Error).message}`,
          index + 1,
        );
      }

      const expectedSequence = index + 1;
      if (event.sequence !== expectedSequence) {
        throw new ProfileEventLogError(
          'SEQUENCE_GAP',
          `Expected profile event sequence ${expectedSequence}, received ${event.sequence}.`,
          event.sequence,
        );
      }
      if (event.previousEventHash !== previousHash) {
        throw new ProfileEventLogError(
          'CHAIN_BROKEN',
          `Profile event ${event.sequence} does not bind the preceding event hash.`,
          event.sequence,
        );
      }

      const { eventHash: _eventHash, ...withoutHash } = event;
      const computed = hashCanonicalJson(eventHashBasis(withoutHash));
      if (computed !== event.eventHash) {
        throw new ProfileEventLogError(
          'HASH_MISMATCH',
          `Profile event ${event.sequence} hash mismatch.`,
          event.sequence,
        );
      }
      previousHash = event.eventHash;
      events.push(event);
    }
    return events;
  }

  /** Appends once per transaction ID; replay verifies the entire chain before extending it. */
  public append(value: ProfileEventInput | unknown): ProfileEvent {
    const input = profileEventInputSchema.parse(value);
    return withExclusiveFileLock(this.lockPath, () => {
      const events = this.replay();
      const existing = events.find((event) => event.transactionId === input.transactionId);
      if (existing !== undefined) {
        if (canonicalJson(comparableInput(existing)) !== canonicalJson(input)) {
          throw new ProfileEventLogError(
            'TRANSACTION_CONFLICT',
            `Transaction ${input.transactionId} already names a different profile event.`,
            existing.sequence,
          );
        }
        return existing;
      }

      const sequence = events.length + 1;
      const previous = events.at(-1);
      const withoutHash: Omit<ProfileEvent, 'eventHash'> = {
        ...input,
        eventVersion: PROFILE_EVENT_VERSION,
        eventId: `PROFILE-EVENT-${String(sequence).padStart(6, '0')}`,
        sequence,
        timestamp: this.now(),
        previousEventHash: previous?.eventHash ?? null,
      };
      const event: ProfileEvent = {
        ...withoutHash,
        eventHash: hashCanonicalJson(eventHashBasis(withoutHash)),
      };
      appendLineDurably(this.eventsPath, canonicalJson(event));
      return event;
    });
  }
}
