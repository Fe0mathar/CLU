import { join } from 'node:path';
import { AUTHORITY_EVENT_TYPES, verifyInstalledPackAgainstSeal } from '../control/mission.js';
import type { Runtime } from '../control/runtime.js';
import { EventLog } from '../memory/eventLog.js';
import { PROOF_EVENT_TYPES } from '../proof/proofContract.js';
import { requireSha256 } from '../shared/ids.js';
import { cycleInputsLockedSchema, epochSealSchema, type EventRecord } from '../shared/schemas.js';
import { readCurrentCycleAuthority } from './cycleAuthority.js';
import {
  CYCLE_EVENT_TYPES, readCurrentCycle, readRecordedCycleAuthorityRecovery,
  type CycleAuthorityRecoveryEvidence, type CycleRestartExpectation,
} from './cycleRegistry.js';

function reference(event: EventRecord) {
  return { id: event.id, sha256: event.hash, mission: event.mission_version };
}

function replayRecoveryJournal(runtime: Runtime): Iterable<EventRecord> {
  return runtime.log?.replay() ?? EventLog.replayReadOnly(
    runtime.projectState?.eventLogRoot ?? join(runtime.workspaceRoot, 'events'),
  );
}

export function findRecordedCycleAuthorityRecovery(runtime: Runtime, expected: CycleRestartExpectation) {
  runtime.requireMission();
  runtime.requireFreshProjections();
  return readRecordedCycleAuthorityRecovery(runtime.projections, expected, replayRecoveryJournal(runtime));
}

/** Inspect the old lock in its historical authority context and pin the newly established authority. */
export function inspectCycleAuthorityRecovery(
  runtime: Runtime,
  expected: CycleRestartExpectation,
): CycleAuthorityRecoveryEvidence {
  const missions = runtime.requireMission();
  const mission = missions.requireCurrentBasis();
  const previous = readCurrentCycle(runtime.projections);
  if (previous?.id !== expected.cycleId || previous.stage !== 'SCREENED' ||
      previous.lock_digest !== expected.lockDigest || previous.mission_version !== mission.id ||
      mission.id !== expected.missionVersion) {
    throw new Error('Authority recovery requires the exact active screened cycle, lock digest and current mission.');
  }

  const authority: EventRecord[] = [];
  let lockEvent: EventRecord | null = null;
  let head: EventRecord | null = null;
  for (const event of replayRecoveryJournal(runtime)) {
    head = event;
    if (event.type === AUTHORITY_EVENT_TYPES.packRatified || event.type === AUTHORITY_EVENT_TYPES.epochSealed) {
      authority.push(event);
    }
    if (event.subject_id !== previous.id) continue;
    if (event.type === PROOF_EVENT_TYPES.verdictRecorded) {
      throw new Error('A cycle with a recorded proof verdict cannot be recovered as an authority failure.');
    }
    if (event.type === CYCLE_EVENT_TYPES.inputsLocked) {
      if (lockEvent !== null || event.mission_version !== mission.id || event.actor !== 'daemon') {
        throw new Error('The predecessor must have exactly one verified daemon lock in the current mission.');
      }
      lockEvent = event;
    }
  }
  if (head === null || runtime.projections.isStaleAgainst({
    sequence: head.sequence, hash: requireSha256(head.hash, 'event journal head'),
  })) throw new Error('The cycle projection disagrees with the verified journal. Inspect and catch up the projections.');
  if (lockEvent === null) throw new Error('The predecessor lock is missing from the verified journal.');
  const { sequence: lockSequence } = lockEvent;
  const { cycle_id: cycleId, lock } = cycleInputsLockedSchema.parse(lockEvent.payload);
  if (cycleId !== previous.id || lock.digest !== previous.lock_digest || lock.grade !== previous.grade) {
    throw new Error('The predecessor lock disagrees with the cycle projection.');
  }

  const priorAuthority = authority.filter((event) => event.sequence < lockSequence);
  const historical = readCurrentCycleAuthority(priorAuthority, mission.id);
  if (historical.ratification !== null && historical.epoch !== null &&
      historical.ratification.event_id === lock.ratification_event_id &&
      historical.epoch.epoch_name === lock.epoch_name) {
    throw new Error('The predecessor locked valid authority for its mission. Later authority changes do not qualify it for recovery.');
  }
  const lockedRatification = lock.ratification_event_id === null ? null : priorAuthority.find(
    (event) => event.type === AUTHORITY_EVENT_TYPES.packRatified && event.id === lock.ratification_event_id,
  );
  const lockedEpoch = lock.epoch_name === null ? null : priorAuthority.find(
    (event) => event.type === AUTHORITY_EVENT_TYPES.epochSealed && epochSealSchema.parse(event.payload).epoch_name === lock.epoch_name,
  );
  for (const event of [lockedRatification, lockedEpoch]) {
    if (event === undefined || (event !== null && (event.actor !== 'creator' || event.subject_id !== event.mission_version))) {
      throw new Error('The predecessor references an authority record with missing or inconsistent identity.');
    }
  }

  const current = readCurrentCycleAuthority(authority, mission.id);
  if (current.ratification === null || current.epoch === null || current.epoch.sequence <= lockSequence) {
    throw new Error('Ratify and seal the installed authority for the current mission before recovering this cycle.');
  }
  const { pack, sealSha, declared } = verifyInstalledPackAgainstSeal(runtime.repoRoot, 'recover cycle authority');
  const ratification = current.ratification;
  const constitution = runtime.config.constitution.file;
  if (ratification.seal_sha256 !== sealSha || ratification.seal_path !== pack.sealFile ||
      ratification.pack_release !== pack.releaseName || ratification.release_version !== pack.releaseVersion ||
      ratification.manifest_path !== pack.manifestFile || ratification.manifest_sha256 !== declared.get(pack.manifestFile) ||
      ratification.constitution_path !== constitution || ratification.constitution_sha256 !== declared.get(constitution) ||
      ratification.declared_file_count !== declared.size) {
    throw new Error('The current mission ratification does not match the installed, sealed authority.');
  }
  const currentRatification = authority.find((event) => event.id === ratification.event_id);
  const currentEpoch = authority.find((event) => event.id === current.epoch?.event_id);
  if (currentRatification === undefined || currentEpoch === undefined) {
    throw new Error('The current authority records are missing from the verified journal.');
  }
  return {
    lock: reference(lockEvent),
    locked_ratification: lockedRatification ? reference(lockedRatification) : null,
    locked_epoch: lockedEpoch ? reference(lockedEpoch) : null,
    ratification: reference(currentRatification),
    epoch: reference(currentEpoch),
    mission_basis_sha256: missions.basis().basisHash,
    journal_head: { sequence: head.sequence, sha256: head.hash },
  };
}
