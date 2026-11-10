import { z } from 'zod';
import { snapshotManifestSchema } from '../analysis/source/snapshot.js';
import { BENCHMARK_EVENT_TYPES } from '../control/benchmarkRun.js';
import { assertExactRunInputs, captureExactRunInputs } from '../control/exactRunInputs.js';
import { AUTHORITY_EVENT_TYPES } from '../control/mission.js';
import type { Runtime } from '../control/runtime.js';
import { PROOF_EVENT_TYPES } from '../proof/proofContract.js';
import { canonicalJson, hashCanonicalJson, requireSha256 } from '../shared/ids.js';
import {
  artifactRefSchema, cycleInputsLockedSchema, cycleStageAdvancedSchema, sha256Schema,
  type CycleRecord, type EventRecord,
} from '../shared/schemas.js';
import { computeInputLock } from './cycleInputLock.js';
import { CYCLE_EVENT_TYPES, type CycleSupersessionEvidence } from './cycleRegistry.js';
import { deriveProofClosure } from './proofClosure.js';

const screeningSchema = z.object({
  cycle_id: z.string(),
  stage: z.literal('SCREENED'),
  snapshot_id: sha256Schema,
  inputs: snapshotManifestSchema,
});

const executionBoundarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linux-bwrap'), sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal('windows-supervisor'), sha256: sha256Schema, qualificationSha256: sha256Schema }).strict(),
]);

const baselineEventSchema = z.object({
  registered: z.literal(true),
  proof_eligible: z.literal(true),
  snapshot_id: sha256Schema,
  inputs_id: sha256Schema,
  config_sha256: sha256Schema,
  project_basis: z.unknown().optional(),
  contract: z.object({ sha256: sha256Schema }),
  result_artifact: artifactRefSchema,
  execution_boundary: executionBoundarySchema,
  executable_inputs: z.object({}).passthrough(),
  budget_exhausted: z.literal(false),
  measures_count: z.number().int().positive(),
  incomplete_count: z.literal(0),
});

const baselineArtifactSchema = z.object({
  proof_eligible: z.literal(true),
  config_sha256: sha256Schema,
  project_basis: z.unknown().optional(),
  contract: z.object({ sha256: sha256Schema }),
  inputs: snapshotManifestSchema,
  execution_boundary: executionBoundarySchema,
  executable_inputs: z.object({}).passthrough(),
});

/** Read and verify the predecessor's durable inputs before replacing its active slot. */
export function inspectCycleSupersession(runtime: Runtime, previous: CycleRecord): CycleSupersessionEvidence {
  const log = runtime.requireLog();
  const missions = runtime.requireMission();
  const mission = missions.requireCurrent();
  const ratification = missions.ratification();
  const epoch = missions.latestEpoch();
  if (ratification === null || epoch === null || epoch.ratification_event_id !== ratification.event_id) {
    throw new Error('Supersession requires the current ratification and its evidence epoch.');
  }

  let lockEvent: EventRecord | null = null;
  let screeningEvent: EventRecord | null = null;
  let currentRatification = false;
  let currentEpoch = false;
  const benchmarkEvents: EventRecord[] = [];
  const verdicts: EventRecord[] = [];
  for (const record of log.replay()) {
    if (record.type === PROOF_EVENT_TYPES.verdictRecorded && record.subject_id === previous.id) {
      verdicts.push(record);
    }
    if (record.mission_version !== mission.id) continue;
    if (record.actor === 'creator') {
      if (record.id === ratification.event_id && record.type === AUTHORITY_EVENT_TYPES.packRatified) currentRatification = true;
      if (record.id === epoch.event_id && record.type === AUTHORITY_EVENT_TYPES.epochSealed) currentEpoch = true;
    }
    if (record.sequence <= epoch.sequence) continue;
    if (record.subject_id === previous.id && record.type === CYCLE_EVENT_TYPES.inputsLocked) {
      lockEvent = record;
    }
    if (record.subject_id === previous.id && record.type === CYCLE_EVENT_TYPES.stageAdvanced) {
      const stage = cycleStageAdvancedSchema.parse(record.payload);
      if (stage.cycle_id === previous.id && stage.to === 'SCREENED') screeningEvent = record;
    }
    if (record.type === BENCHMARK_EVENT_TYPES.runRecorded && record.subject_id === null && screeningEvent !== null) {
      benchmarkEvents.push(record);
    }
  }
  if (!currentRatification || !currentEpoch || lockEvent === null || screeningEvent === null ||
      lockEvent.sequence >= screeningEvent.sequence) {
    throw new Error('Supersession requires the predecessor lock and screening under the current evidence epoch.');
  }

  const locked = cycleInputsLockedSchema.parse(lockEvent.payload);
  const lock = locked.lock;
  const benchmark = lock.master_benchmark;
  const current = computeInputLock({ repoRoot: runtime.repoRoot, config: runtime.config, mission,
    ratification, epoch, projectBinding: runtime.projectBinding });
  if (locked.cycle_id !== previous.id || lock.grade !== 'proof-authoritative' || benchmark === null ||
      lock.digest !== previous.lock_digest || lock.digest !== current.digest ||
      lock.ratification_event_id !== ratification.event_id || lock.epoch_name !== epoch.epoch_name) {
    throw new Error('The predecessor lock must reproduce under the current proof-authoritative mission.');
  }
  if (deriveProofClosure(verdicts, previous.id, lock.project_basis ?? null).improvementDemonstrated ||
      verdicts.some((record) => (record.payload as { great_book?: { state?: string } } | null)?.great_book?.state === 'recorded')) {
    throw new Error('A cycle with an ACCEPT verdict or Great Book entry cannot be superseded.');
  }

  const screeningRef = cycleStageAdvancedSchema.parse(screeningEvent.payload).evidence;
  if (screeningRef === null) throw new Error('Supersession requires the exact predecessor screening artifact.');
  const screening = screeningSchema.parse(runtime.artifacts.getJson(requireSha256(screeningRef.hash, 'screening artifact')));
  if (screening.cycle_id !== previous.id) throw new Error('The screening artifact belongs to a different cycle.');

  const configHash = hashCanonicalJson(runtime.config);
  const projectBasis = canonicalJson(lock.project_basis ?? null);
  const baseline = benchmarkEvents.toReversed().flatMap((event) => {
    const parsed = baselineEventSchema.safeParse(event.payload);
    if (!parsed.success) return [];
    const value = parsed.data;
    return value.snapshot_id === screening.snapshot_id && value.inputs_id === screening.inputs.id &&
      value.config_sha256 === configHash && value.contract.sha256 === benchmark.sha256 &&
      canonicalJson(value.project_basis ?? null) === projectBasis ? [{ event, value }] : [];
  })[0];
  if (baseline === undefined) throw new Error('Supersession requires a proof-eligible opening baseline for the screened inputs.');
  const artifactHash = requireSha256(baseline.value.result_artifact.hash, 'opening baseline artifact');
  const body = baselineArtifactSchema.parse(runtime.artifacts.getJson(artifactHash));
  if (body.config_sha256 !== configHash || body.contract.sha256 !== benchmark.sha256 ||
      canonicalJson(body.project_basis ?? null) !== projectBasis ||
      canonicalJson(body.inputs) !== canonicalJson(screening.inputs) ||
      canonicalJson(body.execution_boundary) !== canonicalJson(baseline.value.execution_boundary) ||
      canonicalJson(body.executable_inputs) !== canonicalJson(baseline.value.executable_inputs)) {
    throw new Error('The opening baseline artifact does not reproduce its predecessor receipt.');
  }

  const inputs = captureExactRunInputs(runtime.config.project.root);
  if (inputs.id === screening.inputs.id) throw new Error('The screened exact target inputs have not changed.');
  assertExactRunInputs(runtime.config.project.root, inputs, 'Replacement target');
  return {
    screened: { event_id: screeningEvent.id, event_sha256: screeningEvent.hash, artifact_sha256: screeningRef.hash },
    baseline: { event_id: baseline.event.id, event_sha256: baseline.event.hash, artifact_sha256: artifactHash },
    previous_inputs_id: screening.inputs.id,
    replacement_inputs_id: inputs.id,
  };
}
