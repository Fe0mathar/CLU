import { z } from 'zod';
import type { Runtime } from '../control/runtime.js';
import { CYCLE_EVENT_TYPES, readCurrentCycle } from '../cycle/cycleRegistry.js';
import {
  cycleRecordSchema,
  entityIdSchema,
  isoTimestampSchema,
  parseOrThrow,
  sha256Schema,
  type CycleRecord,
  type CycleStage,
} from '../shared/schemas.js';

const checkpointKinds = [
  CYCLE_EVENT_TYPES.opened,
  CYCLE_EVENT_TYPES.restarted,
  CYCLE_EVENT_TYPES.superseded,
  CYCLE_EVENT_TYPES.inputsLocked,
  CYCLE_EVENT_TYPES.stageAdvanced,
  CYCLE_EVENT_TYPES.suspended,
  CYCLE_EVENT_TYPES.resumed,
  CYCLE_EVENT_TYPES.closed,
] as const;
const checkpointSchema = z.object({
  kind: z.enum(checkpointKinds),
  eventId: entityIdSchema,
  eventSha256: sha256Schema,
  sequence: z.number().int().nonnegative(),
  occurredAt: isoTimestampSchema,
});

type DashboardCycleCheckpoint = z.infer<typeof checkpointSchema>;

export interface DashboardCycleProgress {
  readonly cycleId: string;
  readonly missionId: string;
  readonly missionMatches: boolean;
  readonly stage: CycleStage;
  readonly grade: CycleRecord['grade'];
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly suspendedFrom: CycleStage | null;
  readonly lockDigest: string | null;
  readonly criteriaMet: boolean | null;
  readonly unmetCount: number | null;
  readonly checkpoint: DashboardCycleCheckpoint | null;
  readonly checkpoints: readonly DashboardCycleCheckpoint[];
  readonly recoverable: boolean;
  readonly current: boolean;
}

const openingStages = new Set<CycleStage>(['OPENED', 'INPUTS_LOCKED', 'OPENING_EVIDENCE', 'RECOGNIZED']);

/** A projection-only observer. The writer verifies and catches up the journal before resuming. */
export function createDashboardCycleProgress(runtime: Pick<Runtime, 'projections' | 'currentMissionId'>): {
  read(): DashboardCycleProgress | null;
} {
  const db = runtime.projections.db;
  const latestClosed = db.prepare(
    "SELECT * FROM cycles WHERE stage = 'CLOSED' ORDER BY closed_at DESC, id DESC LIMIT 1",
  );
  const recentCheckpoints = db.prepare(`
    SELECT type AS kind, id AS eventId, hash AS eventSha256, sequence, timestamp AS occurredAt
    FROM events_index
    WHERE subject_id = ? AND type IN (${checkpointKinds.map(() => '?').join(', ')})
    ORDER BY sequence DESC LIMIT 24
  `);

  // Keep the cycle row, mission and journal index in a single SQLite read snapshot.
  const read = db.transaction((): DashboardCycleProgress | null => {
    let cycle = readCurrentCycle(runtime.projections);
    if (cycle === null) {
      const row = latestClosed.get();
      if (row === undefined) return null;
      cycle = parseOrThrow(cycleRecordSchema, row, 'last closed cycle row');
    }
    const checkpoints = recentCheckpoints.all(cycle.id, ...checkpointKinds)
      .map((row) => parseOrThrow(checkpointSchema, row, 'cycle event checkpoint'));
    const checkpoint = checkpoints[0] ?? null;
    const missionMatches = cycle.mission_version === runtime.currentMissionId();
    return {
      cycleId: cycle.id,
      missionId: cycle.mission_version,
      missionMatches,
      stage: cycle.stage,
      grade: cycle.grade,
      openedAt: cycle.opened_at,
      updatedAt: cycle.updated_at,
      closedAt: cycle.closed_at,
      suspendedFrom: cycle.suspended_from,
      lockDigest: cycle.lock_digest,
      criteriaMet: cycle.criteria_met,
      unmetCount: cycle.unmet_count,
      checkpoint,
      checkpoints: checkpoints.reverse(),
      recoverable: missionMatches && checkpoint !== null && openingStages.has(cycle.stage),
      current: cycle.stage !== 'CLOSED',
    };
  });
  return { read };
}
