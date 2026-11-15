/** Evidence-bound candidate selection for the current screened Project Profile cycle. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { METRIC_EVENT_TYPES, metricSetRecordSchema, rankingRecordSchema } from '../analysis/metrics/registry.js';
import type { RankingResult } from '../analysis/metrics/ranking.js';
import { snapshotManifestSchema } from '../analysis/source/snapshot.js';
import { GRAPH_EVENT_TYPES, recognitionRecordSchema } from '../analysis/source/graph.js';
import type { SourceUnit } from '../analysis/source/recognizer.js';
import { benchmarkResultSchema } from '../benchmark/benchmarkRunner.js';
import { readBenchmarkContract, selectHarnessBlock, verifyHarnessIntegrity } from '../benchmark/harnessBlock.js';
import { readCurrentCycleAuthority } from '../cycle/cycleAuthority.js';
import { computeInputLock } from '../cycle/cycleInputLock.js';
import { CYCLE_EVENT_TYPES, readCurrentCycle } from '../cycle/cycleRegistry.js';
import { EventLog } from '../memory/eventLog.js';
import { canonicalJson, hashBytes, requireSha256 } from '../shared/ids.js';
import { artifactRefSchema, cycleInputsLockedSchema, cycleStageAdvancedSchema, entityIdSchema,
  projectGovernanceBasisSchema, projectIdSchema, projectProfileHashSchema, sha256Schema,
  type ArtifactRef, type CycleRecord, type EventRecord } from '../shared/schemas.js';
import { BENCHMARK_EVENT_TYPES, verifyLockedContract } from './benchmarkRun.js';
import { assertExactRunInputs } from './exactRunInputs.js';
import { selectFindingCandidate, type FindingSignalBinding } from './findingSelection.js';
import { readActiveProjectProfileForBenchmark } from './projectProfiles/projectProfileStartup.js';
import { resolveProjectRecognition } from './projectProfiles/projectRecognition.js';
import type { Runtime } from './runtime.js';

export const CYCLE_FINDINGS_EVENT = 'findings.assessed';

const scopeSchema = z.object({
  projectId: projectIdSchema,
  profileGeneration: z.number().int().positive(),
  projectProfileHash: projectProfileHashSchema,
  missionId: entityIdSchema,
  cycleId: entityIdSchema,
  lockDigest: sha256Schema,
  snapshotId: sha256Schema,
  screenedEvidenceSha256: sha256Schema,
  rankingSha256: sha256Schema,
});
const boundedText = z.string().min(1).max(2_048);
const selectedSchema = z.object({
  findingId: entityIdSchema, unitId: boundedText, path: boundedText, line: z.number().int().positive(),
  signalId: boundedText, signalName: boundedText, objectiveIds: z.array(boundedText).max(25), reason: boundedText,
}).strict();
const receiptDataSchema = scopeSchema.extend({
  schemaVersion: z.literal('clue-cycle-findings/1'),
  outcome: z.enum(['SELECTED', 'NO_CANDIDATE']),
  reason: boundedText,
  findingCount: z.number().int().nonnegative(),
  selected: selectedSchema.nullable(),
}).strict().refine(({ outcome, selected, findingCount }) => outcome === 'SELECTED'
  ? selected !== null && findingCount > 0 : selected === null);
export type CycleFindingsReceipt = z.infer<typeof receiptDataSchema> & {
  readonly evidenceSha256: string;
  readonly eventId: string;
  readonly eventSha256: string;
};

const stageEvidenceSchema = z.object({ stage: z.literal('SCREENED'), cycle_id: entityIdSchema,
  snapshot_id: sha256Schema, inputs: snapshotManifestSchema, values_stored: z.number().int().nonnegative(),
  corpus_size: z.number().int().nonnegative(), patch_candidates: z.number().int().nonnegative(),
  instrumentation_candidates: z.number().int().nonnegative(), clarification_candidates: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(), observed_evidence: z.boolean() });
const recognizedSchema = z.object({ stage: z.literal('RECOGNIZED'), cycle_id: entityIdSchema,
  snapshot_id: sha256Schema, capture_id: sha256Schema, result_hash: sha256Schema, run_key: sha256Schema,
  unit_count: z.number().int().nonnegative(), edge_count: z.number().int().nonnegative(),
  unresolved_count: z.number().int().nonnegative() });
const assessedSchema = z.object({ receipt: receiptDataSchema, evidence: artifactRefSchema }).strict();
const executionBoundarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linux-bwrap'), sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal('windows-supervisor'), sha256: sha256Schema, qualificationSha256: sha256Schema }).strict(),
]);
const openingSchema = z.object({ registered: z.literal(true), proof_eligible: z.literal(true),
  budget_exhausted: z.literal(false), incomplete_count: z.literal(0), snapshot_id: sha256Schema,
  inputs_id: sha256Schema, project_basis: projectGovernanceBasisSchema,
  execution_boundary: executionBoundarySchema, contract: z.object({ sha256: sha256Schema }), result_artifact: artifactRefSchema });
const openingArtifactSchema = z.object({ result: benchmarkResultSchema, proof_eligible: z.literal(true),
  inputs: snapshotManifestSchema, project_basis: projectGovernanceBasisSchema, execution_boundary: executionBoundarySchema,
  contract: z.object({ sha256: sha256Schema }) });

export class CycleFindingsError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CycleFindingsError';
  }
}

function insist(condition: unknown, code: string, reason: string): asserts condition {
  if (!condition) throw new CycleFindingsError(code, reason);
}

function artifact(runtime: Runtime, ref: ArtifactRef): unknown {
  const bytes = runtime.artifacts.getBytes(requireSha256(ref.hash, 'findings artifact'));
  insist(bytes.length === ref.bytes, 'FINDINGS_EVIDENCE_INVALID', 'An evidence artifact has the wrong byte length.');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function journal(runtime: Runtime): EventRecord[] {
  const state = runtime.projectState;
  insist(state !== null, 'FINDINGS_PROFILE_REQUIRED', 'An exact Project Profile workspace is required.');
  const events = runtime.log === null
    ? [...EventLog.replayReadOnly(state.eventLogRoot)] : [...runtime.log.replay()];
  const last = events.at(-1);
  const projection = runtime.projections.status();
  insist(last !== undefined && projection.lastSequence === last.sequence && projection.headHash === last.hash &&
    projection.indexedEvents === last.sequence + 1,
    'FINDINGS_PROJECTIONS_STALE', 'The workspace projections and verified event journal disagree.');
  return events;
}

function checkpoint(events: readonly EventRecord[], cycle: CycleRecord, stage: 'SCREENED' | 'RECOGNIZED') {
  const matches = events.filter((event) => event.type === CYCLE_EVENT_TYPES.stageAdvanced &&
    event.subject_id === cycle.id && event.mission_version === cycle.mission_version &&
    (event.payload as { to?: unknown } | undefined)?.to === stage);
  const event = matches[0];
  insist(event !== undefined && matches.length === 1, 'FINDINGS_EVIDENCE_INVALID', `Expected exactly one ${stage} checkpoint.`);
  const value = cycleStageAdvancedSchema.parse(event.payload);
  insist(value.cycle_id === cycle.id && value.evidence !== null && event.actor === 'daemon',
    'FINDINGS_EVIDENCE_INVALID', `The ${stage} checkpoint has no exact cycle evidence.`);
  return { event, ref: value.evidence };
}

function receiptScope(runtime: Runtime, cycle: CycleRecord, events: readonly EventRecord[]) {
  const profile = runtime.projectProfile;
  insist(profile !== null && cycle.lock_digest !== null, 'FINDINGS_PROFILE_REQUIRED', 'An exact profile and cycle lock are required.');
  const screened = checkpoint(events, cycle, 'SCREENED');
  const data = stageEvidenceSchema.parse(artifact(runtime, screened.ref));
  const rankingEvent = events[screened.event.sequence - 1];
  const metricEvent = events[screened.event.sequence - 2];
  insist(data.cycle_id === cycle.id && rankingEvent?.type === METRIC_EVENT_TYPES.rankingComputed &&
    metricEvent?.type === METRIC_EVENT_TYPES.metricsComputed && screened.event.previous_hash === rankingEvent.hash &&
    rankingEvent.previous_hash === metricEvent.hash && [rankingEvent, metricEvent].every((event) =>
      event.actor === 'daemon' && event.mission_version === cycle.mission_version),
  'FINDINGS_EVIDENCE_INVALID', 'The screened checkpoint does not bind its ranking and metric events.');
  const rankingRecord = rankingRecordSchema.parse(rankingEvent.payload);
  const metrics = metricSetRecordSchema.parse(metricEvent.payload);
  insist(rankingRecord.snapshot_id === data.snapshot_id && metrics.snapshot_id === data.snapshot_id &&
    metrics.value_count === data.values_stored && metrics.corpus_size === data.corpus_size &&
    rankingRecord.patch_count === data.patch_candidates && rankingRecord.instrumentation_count === data.instrumentation_candidates &&
    rankingRecord.clarification_count === data.clarification_candidates && rankingRecord.excluded_count === data.excluded &&
    rankingRecord.observed_evidence_available === data.observed_evidence,
  'FINDINGS_EVIDENCE_INVALID', 'Screening, ranking and metric census disagree.');
  const scope = scopeSchema.parse({ projectId: profile.profile.projectId, profileGeneration: profile.generation,
    projectProfileHash: profile.projectProfileHash, missionId: cycle.mission_version, cycleId: cycle.id,
    lockDigest: cycle.lock_digest, snapshotId: data.snapshot_id, screenedEvidenceSha256: screened.ref.hash,
    rankingSha256: rankingRecord.artifact_hash });
  return { scope, data, rankingEvent, metricEvent, screened };
}

function readAssessment(runtime: Runtime, cycle: CycleRecord, events: readonly EventRecord[], scope: z.infer<typeof scopeSchema>): CycleFindingsReceipt | null {
  const matches = events.filter((event) => event.type === CYCLE_FINDINGS_EVENT &&
    event.subject_id === cycle.id && event.mission_version === cycle.mission_version);
  const event = matches[0];
  if (event === undefined) return null;
  insist(matches.length === 1 && event.actor === 'daemon', 'FINDINGS_EVIDENCE_INVALID', 'Expected one durable findings assessment.');
  const payload = assessedSchema.parse(event.payload);
  const record = z.object({ receipt: receiptDataSchema }).parse(artifact(runtime, payload.evidence));
  insist(canonicalJson(record.receipt) === canonicalJson(payload.receipt) &&
    canonicalJson(scopeSchema.parse(payload.receipt)) === canonicalJson(scope),
  'FINDINGS_EVIDENCE_INVALID', 'The findings receipt differs from this exact screened scope.');
  return { ...payload.receipt, evidenceSha256: payload.evidence.hash, eventId: event.id, eventSha256: event.hash };
}

function requireActiveProfile(runtime: Runtime, scope: z.infer<typeof scopeSchema>): void {
  const active = readActiveProjectProfileForBenchmark(runtime.repoRoot);
  insist(active?.profile.projectId === scope.projectId && active.generation === scope.profileGeneration &&
    active.projectProfileHash === scope.projectProfileHash, 'FINDINGS_PROFILE_CHANGED', 'The active saved profile changed.');
}

/** One read-only projection for the Dashboard. It never launches an assessment. */
export function readCurrentFindings(runtime: Runtime): CycleFindingsReceipt | null {
  if (runtime.projectState === null || runtime.projectProfile === null) return null;
  const cycle = readCurrentCycle(runtime.projections);
  if (cycle?.stage !== 'SCREENED' || cycle.grade !== 'proof-authoritative' || cycle.mission_version !== runtime.currentMissionId()) return null;
  const existing = runtime.projections.db.prepare('SELECT 1 FROM events_index WHERE type = ? AND subject_id = ? LIMIT 1')
    .get(CYCLE_FINDINGS_EVENT, cycle.id);
  if (existing === undefined) return null;
  const events = journal(runtime);
  return readAssessment(runtime, cycle, events, receiptScope(runtime, cycle, events).scope);
}

// Optional declarations are owned by the already registered, hash-locked benchmark. They bind
// one signal/scenario to exact source bytes and do not infer attribution from aggregate timings.
const bindingSchema = z.object({ unitId: boundedText, unitVersion: sha256Schema,
  scenarioId: z.string().regex(/^SCN-[A-Za-z0-9_-]+$/u), signalId: z.string().regex(/^SIG-[A-Za-z0-9_-]+$/u),
  objectiveIds: z.array(z.string().regex(/^OBJ-[A-Za-z0-9_-]+$/u)).max(25).default([]) }).strict();

function declaredBindings(text: string) {
  const markers = [...text.matchAll(/^```clue-finding-bindings[ \t]*\r?$/gmu)];
  if (markers.length === 0) return [];
  const blocks = [...text.matchAll(/^```clue-finding-bindings[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gmu)];
  const body = blocks[0]?.[1];
  insist(markers.length === 1 && blocks.length === 1 && body !== undefined,
    'FINDINGS_BENCHMARK_BINDINGS_INVALID', 'Expected one closed benchmark finding-bindings block.');
  try {
    return z.array(bindingSchema).max(100).parse(JSON.parse(body) as unknown);
  } catch {
    throw new CycleFindingsError('FINDINGS_BENCHMARK_BINDINGS_INVALID', 'The finding-bindings block does not match the declared format.');
  }
}

function observedBindings(runtime: Runtime, events: readonly EventRecord[], lock: z.infer<typeof cycleInputsLockedSchema>['lock'],
  scope: z.infer<typeof scopeSchema>, inputsId: string, units: readonly SourceUnit[]) {
  const bound = lock.master_benchmark;
  const basis = lock.project_basis;
  const signals = new Map<string, FindingSignalBinding>();
  insist(bound !== null && basis !== undefined, 'FINDINGS_PROOF_AUTHORITY_REQUIRED', 'The cycle has no governed benchmark basis.');
  const locked = verifyLockedContract(runtime.config.project.root, bound);
  insist(!('error' in locked), 'FINDINGS_BENCHMARK_CHANGED', 'The registered Master Benchmark moved since the cycle lock.');
  const bytes = readFileSync(locked.path);
  insist(hashBytes(bytes) === bound.sha256, 'FINDINGS_BENCHMARK_CHANGED', 'The registered Master Benchmark changed while being read.');
  const text = bytes.toString('utf8');
  const declarations = declaredBindings(text);
  if (declarations.length === 0) return { signals, openingEventId: null, benchmarkSha256: bound.sha256 };
  const read = readBenchmarkContract(text);
  insist(!('error' in read) && read.identity.runner_adapter !== null, 'FINDINGS_BENCHMARK_BINDINGS_INVALID',
    'Finding coverage requires a registered harness and adapter.');
  const harness = selectHarnessBlock(read, read.identity.runner_adapter);
  insist(!('error' in harness) && verifyHarnessIntegrity(harness).ok, 'FINDINGS_BENCHMARK_BINDINGS_INVALID',
    'The exact harness integrity could not be verified.');
  const duplicate = new Set<string>();
  for (const declaration of declarations) {
    insist(!duplicate.has(declaration.unitId) && harness.scenario_ids.includes(declaration.scenarioId),
      'FINDINGS_BENCHMARK_BINDINGS_INVALID', 'A binding repeats a unit or refers to an undeclared scenario.');
    duplicate.add(declaration.unitId);
  }
  const event = events.findLast((row) => {
    if (row.type !== BENCHMARK_EVENT_TYPES.runRecorded || row.mission_version !== scope.missionId || row.actor !== 'cli') return false;
    const match = openingSchema.safeParse(row.payload);
    return match.success && match.data.snapshot_id === scope.snapshotId && match.data.inputs_id === inputsId &&
      match.data.contract.sha256 === bound.sha256 && canonicalJson(match.data.project_basis) === canonicalJson(basis);
  });
  insist(event !== undefined, 'FINDINGS_OPENING_BENCHMARK_REQUIRED',
    'Run the registered opening benchmark on the exact screened inputs before using its declared finding coverage.');
  const opening = openingSchema.parse(event.payload);
  const run = openingArtifactSchema.parse(artifact(runtime, opening.result_artifact));
  insist(run.inputs.id === inputsId && run.contract.sha256 === bound.sha256 &&
    canonicalJson(run.project_basis) === canonicalJson(basis) && run.result.incomplete.length === 0 &&
    run.result.benchmarkVersion === read.identity.benchmark_version &&
    canonicalJson(run.result.environment) === canonicalJson(lock.environment_fingerprint) &&
    canonicalJson(run.execution_boundary) === canonicalJson(opening.execution_boundary),
  'FINDINGS_EVIDENCE_INVALID', 'The proof-eligible benchmark receipt does not reproduce.');
  const versions = new Map(units.map((unit) => [unit.logicalId, unit.versionHash]));
  for (const declaration of declarations) {
    if (versions.get(declaration.unitId) !== declaration.unitVersion) continue;
    const matches = run.result.measures.filter((row) => row.id === declaration.signalId && row.scenario === declaration.scenarioId);
    const measure = matches[0];
    if (matches.length !== 1 || measure === undefined || !measure.warmup_samples?.length) continue;
    signals.set(declaration.unitId, { signalId: measure.id, signalName: measure.name, objectiveIds: declaration.objectiveIds,
      evidenceReason: `The locked benchmark binds this unit version to ${measure.scenario} and ${measure.id}. Matching native evidence is recorded at ${event.id}.` });
  }
  return { signals, openingEventId: event.id, benchmarkSha256: bound.sha256 };
}

/** Persists one assessed decision after validating the exact screened world. No provider or proof execution. */
export function assessCurrentFindings(runtime: Runtime): CycleFindingsReceipt {
  const profile = runtime.projectProfile;
  insist(profile !== null && runtime.projectState !== null && runtime.projectIdentity !== null,
    'FINDINGS_PROFILE_REQUIRED', 'Activate a saved Project Profile before assessing findings.');
  const log = runtime.requireLog();
  const missionRegistry = runtime.requireMission();
  runtime.requireFreshProjections();
  const mission = missionRegistry.requireCurrentBasis();
  const cycle = readCurrentCycle(runtime.projections);
  insist(cycle?.stage === 'SCREENED' && cycle.mission_version === mission.id, 'FINDINGS_SCREENED_REQUIRED',
    'Use Dashboard Start to reach SCREENED under the current mission before planning findings.');
  insist(cycle.grade === 'proof-authoritative', 'FINDINGS_PROOF_AUTHORITY_REQUIRED',
    'Findings planning requires a proof-authoritative SCREENED cycle.');
  const events = journal(runtime);
  const { scope, data, rankingEvent, metricEvent, screened } = receiptScope(runtime, cycle, events);
  const locks = events.filter((row) => row.type === CYCLE_EVENT_TYPES.inputsLocked && row.subject_id === cycle.id &&
    row.mission_version === mission.id);
  const lockEvent = locks[0];
  insist(locks.length === 1 && lockEvent !== undefined && lockEvent.sequence < screened.event.sequence,
    'FINDINGS_EVIDENCE_INVALID', 'The screened cycle has no unique earlier input lock.');
  const locked = cycleInputsLockedSchema.parse(lockEvent.payload);
  const authority = readCurrentCycleAuthority(events, mission.id);
  const current = computeInputLock({ repoRoot: runtime.repoRoot, config: runtime.config, mission,
    projectBinding: runtime.projectBinding, ...authority });
  insist(locked.cycle_id === cycle.id && locked.lock.digest === scope.lockDigest && current.digest === scope.lockDigest &&
    current.grade === 'proof-authoritative', 'FINDINGS_LOCK_CHANGED', 'The current governed inputs differ from the cycle lock.');
  const recognition = resolveProjectRecognition(runtime);
  try { assertExactRunInputs(recognition.targetRoot, data.inputs, 'Screened project'); }
  catch { throw new CycleFindingsError('FINDINGS_INPUTS_CHANGED', 'The current source differs from the exact screened inputs.'); }
  requireActiveProfile(runtime, scope);
  const existing = readAssessment(runtime, cycle, events, scope);
  if (existing !== null) return existing;

  const recognized = checkpoint(events, cycle, 'RECOGNIZED');
  const recognizedData = recognizedSchema.parse(artifact(runtime, recognized.ref));
  insist(recognized.event.sequence > lockEvent.sequence && recognized.event.sequence < metricEvent.sequence &&
    recognizedData.cycle_id === cycle.id && recognizedData.snapshot_id === scope.snapshotId &&
    recognition.projectRecognitionIdentity !== null,
  'FINDINGS_EVIDENCE_INVALID', 'The recognition checkpoint does not match the screened cycle and profile.');
  const runEvents = events.filter((event) => event.type === GRAPH_EVENT_TYPES.recognitionCompleted &&
    event.actor === 'daemon' && event.subject_id === null && event.mission_version === cycle.mission_version &&
    event.sequence > lockEvent.sequence && event.sequence < recognized.event.sequence &&
    (event.payload as { run_key?: unknown } | undefined)?.run_key === recognizedData.run_key);
  const runEvent = runEvents[0];
  insist(runEvents.length === 1 && runEvent !== undefined,
    'FINDINGS_EVIDENCE_INVALID', 'Expected one recorded recognition run for the screened checkpoint.');
  const run = recognitionRecordSchema.safeParse(runEvent.payload);
  insist(run.success && run.data.snapshot_id === recognizedData.snapshot_id &&
    run.data.result_hash === recognizedData.result_hash && run.data.unit_count === recognizedData.unit_count &&
    run.data.edge_count === recognizedData.edge_count && run.data.unresolved_count === recognizedData.unresolved_count,
  'FINDINGS_EVIDENCE_INVALID', 'The recorded recognition run does not match the screened checkpoint.');
  let units: readonly SourceUnit[];
  try {
    units = runtime.requireGraph().resultOfRecordedRun(run.data, recognizedData.capture_id, recognition.projectRecognitionIdentity).units;
  } catch {
    throw new CycleFindingsError('FINDINGS_EVIDENCE_INVALID', 'The screened recognition artifact could not be verified.');
  }
  const metricEvidenceSha256 = metricSetRecordSchema.parse(metricEvent.payload).artifact_hash;
  runtime.artifacts.getBytes(requireSha256(metricEvidenceSha256, 'screened metrics'));
  const ranking = runtime.artifacts.getJson(requireSha256(scope.rankingSha256, 'screened ranking')) as RankingResult;
  insist(ranking.snapshotId === scope.snapshotId && ranking.patchCandidates?.length === data.patch_candidates &&
    ranking.instrumentationCandidates?.length === data.instrumentation_candidates &&
    ranking.clarificationCandidates?.length === data.clarification_candidates && ranking.excluded?.length === data.excluded,
  'FINDINGS_EVIDENCE_INVALID', 'The ranking artifact does not reproduce the screened census.');
  const benchmark = observedBindings(runtime, events, locked.lock, scope, data.inputs.id, units);
  const head = log.getHead();
  insist(head !== null, 'FINDINGS_EVIDENCE_INVALID', 'The event journal has no committed head.');
  const selection = selectFindingCandidate({ ranking, units, isProtected: runtime.isProtected,
    signalBindings: benchmark.signals, firstFindingSequence: (head.sequence + 1) * 100 });
  const { findings, ...decision } = selection;
  const receipt = receiptDataSchema.parse({ ...scope, schemaVersion: 'clue-cycle-findings/1', ...decision });
  const body = { receipt, findings, recognitionEventId: recognized.event.id, recognitionSha256: recognizedData.result_hash,
    recognitionRunEventId: runEvent.id, recognitionRunKey: recognizedData.run_key, recognitionArtifactSha256: run.data.artifact_hash,
    metricEventId: metricEvent.id, metricEvidenceSha256,
    rankingEventId: rankingEvent.id, benchmarkSha256: benchmark.benchmarkSha256, benchmarkEventId: benchmark.openingEventId,
    screenedEventId: screened.event.id, screenedInputsId: data.inputs.id };
  runtime.secrets.assertClean(canonicalJson(body), 'findings assessment');
  requireActiveProfile(runtime, scope);
  const evidence = runtime.artifacts.putJson(body, { label: `${cycle.id}-findings-assessment.json`, operationIdentity: runtime.projectIdentity });
  const event = log.append({ type: CYCLE_FINDINGS_EVENT, actor: 'daemon', missionVersion: mission.id, subjectId: cycle.id,
    payload: assessedSchema.parse({ receipt, evidence }), operationIdentity: runtime.projectIdentity });
  runtime.projections.sync(log);
  return { ...receipt, evidenceSha256: evidence.hash, eventId: event.id, eventSha256: event.hash };
}
