/**
 * Proof-derived cycle closure facts — the §24 candidate-loop switch (DEV-P2-11, ZIP 03).
 *
 * The cycle stage machine does not own proof arithmetic. It owns one narrower question:
 * did this cycle produce a durable deterministic verdict, and did any such verdict prove
 * an improvement? The event log is the authority; UI state and caller parameters never
 * participate.
 *
 * A verdict can stand here only when:
 *   - the event is `proof.verdict_recorded`;
 *   - its `subject_id` is the cycle being closed;
 *   - payload `cycle_id` agrees with that subject;
 *   - disposition is one the deterministic verdict layer can emit; and
 *   - `improvement` agrees with the law that ACCEPT, and only ACCEPT, is improvement.
 *
 * Anything else is malformed authority and blocks closure. Foreign-cycle events are
 * ignored rather than borrowed. Multiple attempts remain history: one ACCEPT is enough
 * to demonstrate improvement, while the latest disposition is retained only to explain
 * an evaluated non-improvement result.
 */

import { PROOF_EVENT_TYPES } from '../proof/proofContract.js';
import { canonicalJson } from '../shared/ids.js';
import {
  projectGovernanceBasisSchema,
  type ProjectGovernanceBasis,
} from '../shared/projectGovernanceBasis.js';
import type { EventRecord } from '../shared/schemas.js';

export const CLOSURE_PROOF_DISPOSITIONS = [
  'ACCEPT',
  'REJECT',
  'REVISE',
  'INVALID',
] as const;

export type ClosureProofDisposition = (typeof CLOSURE_PROOF_DISPOSITIONS)[number];

export interface ProofClosureState {
  readonly cycleId: string;
  readonly verdictCount: number;
  readonly acceptedCount: number;
  readonly latestDisposition: ClosureProofDisposition | null;
  readonly latestEventId: string | null;
  readonly candidateLoopExecuted: boolean;
  readonly improvementDemonstrated: boolean;
}

function payloadOf(
  record: EventRecord,
  cycleId: string,
  expectedProjectBasis: ProjectGovernanceBasis | null | undefined,
): {
  readonly disposition: ClosureProofDisposition;
  readonly improvement: boolean;
} {
  const payload = record.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `Cycle ${cycleId} has malformed ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
        'payload is not an object.',
    );
  }

  const row = payload as Record<string, unknown>;
  if (expectedProjectBasis !== undefined) {
    if (expectedProjectBasis === null) {
      if (row['project_basis'] !== undefined) {
        throw new Error(
          `Cycle ${cycleId} has incompatible ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
            'a legacy cycle cannot borrow a Project Profile-bound verdict.',
        );
      }
    } else {
      if (row['project_basis'] === undefined) {
        throw new Error(
          `Cycle ${cycleId} has incompatible ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
            'the Project Profile-bound cycle requires an exact project_basis.',
        );
      }
      let observed: ProjectGovernanceBasis;
      try {
        observed = projectGovernanceBasisSchema.parse(row['project_basis']);
      } catch (error) {
        throw new Error(
          `Cycle ${cycleId} has malformed ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
            `project_basis is invalid (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
      if (canonicalJson(observed) !== canonicalJson(expectedProjectBasis)) {
        throw new Error(
          `Cycle ${cycleId} has incompatible ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
            'project_basis does not match the cycle input lock.',
        );
      }
    }
  }
  if (row['cycle_id'] !== cycleId) {
    throw new Error(
      `Cycle ${cycleId} has malformed ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
        `payload cycle_id ${JSON.stringify(row['cycle_id'])} does not match the event subject.`,
    );
  }

  if (
    typeof row['disposition'] !== 'string' ||
    !CLOSURE_PROOF_DISPOSITIONS.includes(row['disposition'] as ClosureProofDisposition)
  ) {
    throw new Error(
      `Cycle ${cycleId} has malformed ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
        `unknown disposition ${JSON.stringify(row['disposition'])}.`,
    );
  }

  if (typeof row['improvement'] !== 'boolean') {
    throw new Error(
      `Cycle ${cycleId} has malformed ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
        'improvement is not boolean.',
    );
  }

  const disposition = row['disposition'] as ClosureProofDisposition;
  const expectedImprovement = disposition === 'ACCEPT';
  if (row['improvement'] !== expectedImprovement) {
    throw new Error(
      `Cycle ${cycleId} has contradictory ${PROOF_EVENT_TYPES.verdictRecorded} event ${record.id}: ` +
        `${disposition} requires improvement=${String(expectedImprovement)}, received ${String(row['improvement'])}.`,
    );
  }

  return { disposition, improvement: row['improvement'] };
}

/** Derives the complete proof fact used by §24 from one replayable event history. */
export function deriveProofClosure(
  records: Iterable<EventRecord>,
  cycleId: string,
  /** undefined preserves historical callers; null explicitly enforces a legacy/no-profile cycle. */
  expectedProjectBasis: ProjectGovernanceBasis | null | undefined = undefined,
): ProofClosureState {
  let verdictCount = 0;
  let acceptedCount = 0;
  let latestDisposition: ClosureProofDisposition | null = null;
  let latestEventId: string | null = null;

  for (const record of records) {
    if (record.type !== PROOF_EVENT_TYPES.verdictRecorded || record.subject_id !== cycleId) {
      continue;
    }
    const payload = payloadOf(record, cycleId, expectedProjectBasis);
    verdictCount += 1;
    if (payload.improvement) acceptedCount += 1;
    latestDisposition = payload.disposition;
    latestEventId = record.id;
  }

  return {
    cycleId,
    verdictCount,
    acceptedCount,
    latestDisposition,
    latestEventId,
    candidateLoopExecuted: verdictCount > 0,
    improvementDemonstrated: acceptedCount > 0,
  };
}

/** The §24 unmet lines owned by the proof/candidate portion of closure. */
export function proofClosureUnmet(state: ProofClosureState): readonly string[] {
  if (!state.candidateLoopExecuted) {
    return [
      'candidate loop (§8–§15): not executed — no proof.verdict_recorded exists for this cycle',
      'improvement demonstrated (§16/§24): not evaluated — no proof verdict exists for this cycle',
    ];
  }

  if (!state.improvementDemonstrated) {
    return [
      `improvement demonstrated (§16/§24): evaluated — ${state.verdictCount} verdict(s), no ACCEPT ` +
        `(latest ${state.latestDisposition ?? 'unknown'} at ${state.latestEventId ?? 'unknown event'})`,
    ];
  }

  return [];
}
