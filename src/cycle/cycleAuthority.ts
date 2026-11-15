import { AUTHORITY_EVENT_TYPES, type EpochRecord, type RatificationRecord } from '../control/mission.js';
import { epochSealSchema, packRatificationSchema, parseOrThrow, type EventRecord } from '../shared/schemas.js';

/** Resolve the latest Creator authority from events in verified journal order. */
export function readCurrentCycleAuthority(events: Iterable<EventRecord>, missionId: string): {
  readonly ratification: RatificationRecord | null;
  readonly epoch: EpochRecord | null;
} {
  let ratification: RatificationRecord | null = null;
  let epoch: EpochRecord | null = null;

  for (const event of events) {
    if (event.type !== AUTHORITY_EVENT_TYPES.packRatified && event.type !== AUTHORITY_EVENT_TYPES.epochSealed) continue;
    const currentCreator = event.actor === 'creator' && event.mission_version === missionId && event.subject_id === missionId;
    if (event.type === AUTHORITY_EVENT_TYPES.packRatified) {
      const payload = parseOrThrow(packRatificationSchema, event.payload, `${event.id} ratification`);
      ratification = currentCreator ? { ...payload, event_id: event.id, sequence: event.sequence } : null;
      // An epoch stands on the ratification it names. A newer ratification needs its own epoch.
      epoch = null;
    } else {
      const payload = parseOrThrow(epochSealSchema, event.payload, `${event.id} epoch`);
      const linked = ratification !== null && ratification.sequence < event.sequence &&
        payload.ratification_event_id === ratification.event_id && payload.ratified_seal_sha256 === ratification.seal_sha256;
      const exactBoundary = payload.legacy_head_sequence === event.sequence - 1 && payload.legacy_head_hash === event.previous_hash;
      epoch = currentCreator && linked && exactBoundary ? { ...payload, event_id: event.id, sequence: event.sequence } : null;
    }
  }

  return { ratification, epoch };
}
