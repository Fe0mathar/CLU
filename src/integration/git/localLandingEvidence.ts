/** Reconcile one proof verdict with the current screened, profile-bound Git source. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';

import { snapshotManifestSchema } from '../../analysis/source/snapshot.js';
import { benchmarkResultSchema, isCompleteCluBenchmarkV020 } from '../../benchmark/benchmarkRunner.js';
import { BENCHMARK_EVENT_TYPES, captureBenchmarkExecutableInputs } from '../../control/benchmarkRun.js';
import { assertExactRunInputs } from '../../control/exactRunInputs.js';
import { readActiveProjectProfileForBenchmark } from '../../control/projectProfiles/projectProfileStartup.js';
import type { Runtime } from '../../control/runtime.js';
import { computeInputLock } from '../../cycle/cycleInputLock.js';
import { CYCLE_EVENT_TYPES, readCurrentCycle } from '../../cycle/cycleRegistry.js';
import {
  benchmarkRunRecordedPayloadSchema, proofBaselineBoundPayloadSchema, proofContractFrozenPayloadSchema,
  proofVerdictRecordedPayloadSchema,
} from '../../daemon/proofBoardProjection.js';
import type { PatchOperation } from '../../experiment/proof/executionCoordinator.js';
import { EventLog } from '../../memory/eventLog.js';
import { PROOF_EVENT_TYPES, proofContractSchema, verifyFrozenContract } from '../../proof/proofContract.js';
import { canonicalJson, hashBytes, hashCanonicalJson, requireSha256 } from '../../shared/ids.js';
import {
  artifactRefSchema, cycleInputsLockedSchema, cycleStageAdvancedSchema, projectGovernanceBasisSchema, sha256Schema,
  type ArtifactRef, type EventRecord,
} from '../../shared/schemas.js';
import { localLandingBaseSchema, observeLocalLandingBase } from './landableProofBasis.js';

const oneWrite = z.object({
  op: z.literal('write'), path: z.string().min(1), sha256: sha256Schema, bytes: z.number().int().positive(),
}).strict();
const nativeBoundary = z.object({
  kind: z.literal('windows-supervisor'), sha256: sha256Schema, qualificationSha256: sha256Schema,
}).strict();
const executableInputs = z.object({
  node_sha256: sha256Schema, engine_dist_id: sha256Schema, target_dist_id: sha256Schema,
  engine_dependencies_id: sha256Schema, target_dependencies_id: sha256Schema,
}).strict();
const runArtifact = z.object({
  inputs: snapshotManifestSchema, result: benchmarkResultSchema, execution_boundary: nativeBoundary,
  executable_inputs: executableInputs,
  contract: z.object({ sha256: sha256Schema, benchmark_id: z.literal('clu-master'), benchmark_version: z.literal('0.2.0') }),
  budget: z.object({ exhausted: z.literal(false) }),
});
const acceptedPayload = proofVerdictRecordedPayloadSchema.extend({
  disposition: z.literal('ACCEPT'), improvement: z.literal(true), baseline_inputs_id: sha256Schema,
  project_basis: projectGovernanceBasisSchema, local_landing_base: localLandingBaseSchema,
  change_set: z.tuple([oneWrite]), anomalies: z.tuple([]),
  static_preparation: z.tuple([z.object({ script: z.literal('typecheck'), wall_ms: z.number().nonnegative() }),
    z.object({ script: z.literal('build'), wall_ms: z.number().nonnegative() })]),
});
const verdictArtifact = z.object({
  disposition: z.literal('ACCEPT'), improvement: z.literal(true),
  reasons: z.array(z.string()), deltas: z.array(z.unknown()),
  gates: z.array(z.object({ outcome: z.literal('pass'), rule: z.unknown() })).min(1),
  thresholds: z.object({ success: z.object({ met: z.literal(true) }) }),
  identity: z.object({ contract_hash: sha256Schema, baseline_digest: sha256Schema, candidate_digest: sha256Schema,
    baseline_snapshot: sha256Schema, candidate_snapshot: sha256Schema, project_basis: projectGovernanceBasisSchema }),
});
const screenedArtifact = z.object({
  cycle_id: z.string(), stage: z.literal('SCREENED'), snapshot_id: sha256Schema, inputs: snapshotManifestSchema,
});
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export function insistLanding(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

export function landingJournal(runtime: Runtime): EventRecord[] {
  const state = runtime.projectState;
  insistLanding(state !== null, 'An active Project Profile workspace is required.');
  const events = runtime.log === null ? [...EventLog.replayReadOnly(state.eventLogRoot)] : [...runtime.log.replay()];
  const head = events.at(-1);
  const projection = runtime.projections.status();
  insistLanding(head !== undefined && projection.lastSequence === head.sequence && projection.headHash === head.hash &&
    projection.indexedEvents === head.sequence + 1, 'Landing requires projections at the verified journal head.');
  return events;
}

export function assertActiveLandingProfile(runtime: Runtime): void {
  const current = readActiveProjectProfileForBenchmark(runtime.repoRoot);
  insistLanding(current !== null && runtime.projectProfile !== null && equal(current, runtime.projectProfile),
    'The active Project Profile generation changed.');
}

function readArtifact(runtime: Runtime, ref: ArtifactRef): unknown {
  const bytes = runtime.artifacts.getBytes(requireSha256(ref.hash, 'landing proof artifact'));
  insistLanding(bytes.length === ref.bytes, 'A proof artifact disagrees with its recorded length.');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function readOne(events: readonly EventRecord[], type: string, detail: string): EventRecord {
  const matches = events.filter((event) => event.type === type);
  const event = matches[0];
  insistLanding(matches.length === 1 && event !== undefined, detail);
  return event;
}

export function inspectLandingEvidence(runtime: Runtime, proofEventId: string, patch: readonly PatchOperation[]) {
  const events = landingJournal(runtime);
  const proof = events.find((event) => event.id === proofEventId);
  insistLanding(proof?.type === PROOF_EVENT_TYPES.verdictRecorded && proof.actor === 'cli' &&
    (proof.payload as { disposition?: string } | null)?.disposition === 'ACCEPT',
  'Landing requires a recorded ACCEPT verdict. A refusal or a findings decision cannot authorize it.');
  assertActiveLandingProfile(runtime);
  const missionRegistry = runtime.requireMission();
  const mission = missionRegistry.requireCurrentBasis();
  const cycle = readCurrentCycle(runtime.projections);
  insistLanding(cycle?.id === proof.subject_id && cycle.mission_version === mission.id && proof.mission_version === mission.id &&
    cycle.stage === 'SCREENED' && cycle.grade === 'proof-authoritative',
  'The verdict must belong to the current proof-authoritative screened cycle and mission.');
  const accepted = acceptedPayload.parse(proof.payload);
  insistLanding(accepted.target_id === runtime.config.project.id && accepted.cycle_id === cycle.id,
    'The verdict targets a different project or cycle.');
  const scoped = events.filter((event) => event.subject_id === cycle.id && event.mission_version === mission.id);
  const latest = scoped.filter((event) => event.type === PROOF_EVENT_TYPES.verdictRecorded ||
    event.type === PROOF_EVENT_TYPES.executionRefused || event.type === PROOF_EVENT_TYPES.contractFrozen).at(-1);
  insistLanding(latest?.id === proof.id, 'A later terminal proof decision superseded this verdict.');
  const lockRecord = readOne(scoped, CYCLE_EVENT_TYPES.inputsLocked, 'The screened cycle has no unique input lock.');
  const { lock } = cycleInputsLockedSchema.parse(lockRecord.payload);
  const epoch = missionRegistry.latestEpoch();
  const ratification = missionRegistry.ratification();
  const current = computeInputLock({ repoRoot: runtime.repoRoot, config: runtime.config, mission,
    projectBinding: runtime.projectBinding, ratification, epoch });
  insistLanding(epoch !== null && ratification !== null && ratification.sequence < epoch.sequence &&
    epoch.sequence < lockRecord.sequence && lock.grade === 'proof-authoritative' && lock.project_basis !== undefined &&
    lock.digest === current.digest && lock.digest === cycle.lock_digest && equal(lock.project_basis, accepted.project_basis),
  'The current sealed mission, project basis or policy differs from the proof input lock.');
  const checkpoint = readOne(scoped.filter((event) => (event.payload as { to?: string } | null)?.to === 'SCREENED'),
    CYCLE_EVENT_TYPES.stageAdvanced, 'The cycle has no unique screening checkpoint.');
  const { evidence } = cycleStageAdvancedSchema.parse(checkpoint.payload);
  insistLanding(evidence !== null && lockRecord.sequence < checkpoint.sequence && checkpoint.sequence < proof.sequence,
    'The screening evidence does not precede the verdict under the current lock.');
  const screened = screenedArtifact.parse(readArtifact(runtime, evidence));
  const freezeEvent = scoped.findLast((event) => event.type === PROOF_EVENT_TYPES.contractFrozen && event.sequence < proof.sequence);
  insistLanding(freezeEvent !== undefined && checkpoint.sequence < freezeEvent.sequence && freezeEvent.actor === 'cli',
    'The verdict must follow its proof freeze on the screened source.');
  const freeze = proofContractFrozenPayloadSchema.extend({
    local_landing_base: localLandingBaseSchema, project_basis: projectGovernanceBasisSchema, inputs_id: sha256Schema,
  }).parse(freezeEvent.payload);
  const rules = proofContractSchema.parse(readArtifact(runtime, accepted.artifacts.contract));
  insistLanding(verifyFrozenContract(rules, requireSha256(accepted.contract_hash, 'landing proof contract')).ok,
    'The stored frozen Proof Contract hash is invalid.');
  insistLanding(rules.contract_version === 2 && rules.mission_version === mission.id && rules.cycle_id === cycle.id &&
    rules.snapshot_id === screened.snapshot_id && screened.cycle_id === cycle.id &&
    freeze.contract_hash === accepted.contract_hash && freeze.target_id === accepted.target_id &&
    freeze.cycle_id === cycle.id && freeze.snapshot_id === screened.snapshot_id && freeze.hypothesis_id === rules.hypothesis.id &&
    freeze.hypothesis_id === accepted.hypothesis_id && freeze.inputs_id === screened.inputs.id &&
    equal(freeze.contract_artifact, accepted.artifacts.contract) && equal(freeze.project_basis, lock.project_basis) &&
    equal(rules.project_basis, lock.project_basis) && equal(freeze.local_landing_base, accepted.local_landing_base) &&
    equal(rules.environment_fingerprint, lock.environment_fingerprint),
  'The frozen contract, proposed Git parent, lock, and proof verdict disagree.');
  const boundEvent = readOne(scoped.filter((event) => freezeEvent.sequence < event.sequence && event.sequence < proof.sequence),
    PROOF_EVENT_TYPES.baselineBound, 'The verdict has no unique registered baseline binding.');
  const bound = proofBaselineBoundPayloadSchema.extend({ inputs_id: sha256Schema }).parse(boundEvent.payload);
  const openingEvent = events.find((event) => event.id === bound.source_event_id);
  insistLanding(openingEvent?.type === BENCHMARK_EVENT_TYPES.runRecorded &&
    (openingEvent.actor === 'cli' || openingEvent.actor === 'daemon') &&
    openingEvent.mission_version === mission.id && checkpoint.sequence < openingEvent.sequence &&
    openingEvent.sequence < freezeEvent.sequence && boundEvent.actor === 'cli' && bound.reused &&
    bound.contract_hash === accepted.contract_hash && bound.baseline_digest === accepted.baseline_digest &&
    bound.inputs_id === screened.inputs.id && accepted.baseline_inputs_id === screened.inputs.id,
  'The accepted attempt does not bind a registered post-screening baseline.');
  const opening = benchmarkRunRecordedPayloadSchema.extend({ proof_eligible: z.literal(true), inputs_id: sha256Schema,
    project_basis: projectGovernanceBasisSchema, execution_boundary: nativeBoundary,
    config_sha256: sha256Schema, executable_inputs: executableInputs }).parse(openingEvent.payload);
  const openingRun = runArtifact.extend({ proof_eligible: z.literal(true), project_basis: projectGovernanceBasisSchema,
    config_sha256: sha256Schema })
    .parse(readArtifact(runtime, opening.result_artifact));
  const candidate = runArtifact.extend({ project_basis: projectGovernanceBasisSchema, matched_control: artifactRefSchema })
    .parse(readArtifact(runtime, accepted.artifacts.candidate_run));
  const control = runArtifact.extend({ role: z.literal('unchanged-matched-shadow-control') })
    .parse(readArtifact(runtime, candidate.matched_control));
  const { great_book } = accepted;
  const verdict = verdictArtifact.parse(readArtifact(runtime, accepted.artifacts.verdict));
  insistLanding(opening.registered && !opening.budget_exhausted && opening.incomplete_count === 0 && opening.measures_count === 13 &&
    opening.config_sha256 === hashCanonicalJson(runtime.config) && openingRun.config_sha256 === opening.config_sha256 &&
    opening.snapshot_id === screened.snapshot_id && opening.inputs_id === screened.inputs.id &&
    opening.result_artifact.hash === bound.run_artifact_hash && equal(opening.project_basis, lock.project_basis) &&
    equal(openingRun.project_basis, lock.project_basis) && equal(candidate.project_basis, lock.project_basis) &&
    equal(openingRun.inputs, screened.inputs) && equal(control.inputs, screened.inputs) &&
    equal(openingRun.executable_inputs, opening.executable_inputs) &&
    [control, openingRun].every((run) => run.executable_inputs.node_sha256 === candidate.executable_inputs.node_sha256) &&
    control.executable_inputs.target_dependencies_id === candidate.executable_inputs.target_dependencies_id &&
    equal(openingRun.execution_boundary, opening.execution_boundary) &&
    [candidate, control].every((run) => equal(run.execution_boundary, opening.execution_boundary)) &&
    [openingRun, candidate, control].every((run) => isCompleteCluBenchmarkV020(run.result) &&
      run.contract.sha256 === lock.master_benchmark?.sha256 && equal(run.result.environment, lock.environment_fingerprint)) &&
    opening.contract.sha256 === lock.master_benchmark?.sha256 &&
    verdict.identity.contract_hash === accepted.contract_hash && verdict.identity.baseline_digest === accepted.baseline_digest &&
    verdict.identity.candidate_digest === accepted.candidate_digest && verdict.identity.baseline_snapshot === screened.snapshot_id &&
    verdict.identity.candidate_snapshot === candidate.inputs.id && candidate.inputs.id === accepted.candidate_snapshot_id &&
    equal(verdict.identity.project_basis, lock.project_basis) &&
    equal(verdict.gates.map(({ rule }) => rule), rules.mandatory_gates) &&
    equal(verdict.reasons, accepted.reasons) && equal(verdict.deltas, accepted.deltas) &&
    great_book?.state === 'recorded' && great_book.entry.contract_hash === accepted.contract_hash &&
    great_book.entry.patch_digest === accepted.patch_digest && equal(great_book.entry.change_set, accepted.change_set) &&
    equal(great_book.entry.artifacts, accepted.artifacts),
  'The native run artifacts, passed gates, Great Book or proof identities disagree.');

  const [change] = accepted.change_set;
  const [write] = patch;
  insistLanding(patch.length === 1 && write?.op === 'write' && write.path === change.path &&
    hashCanonicalJson(accepted.change_set) === accepted.patch_digest,
  'The patch must match the one existing-file write named by the verdict.');
  const content = Buffer.from(write.content, 'utf8');
  const before = screened.inputs.files.find((file) => file.path === change.path);
  insistLanding(before !== undefined && hashBytes(content) === change.sha256 && content.length === change.bytes &&
    !/^(?:config|docs?|tools|scripts|selftest)\//iu.test(change.path) &&
    change.path.split('/').every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(part)) &&
    /^(?:src|ui)\/.+\.(?:[cm]?[jt]sx?|css)$/u.test(change.path),
  'Landing requires exact proved bytes in one existing source file. Configuration and execution surfaces are excluded.');
  const expectedFiles = screened.inputs.files.map((file) => file.path === change.path
    ? { ...file, hash: change.sha256, bytes: change.bytes } : file);
  insistLanding(candidate.inputs.skipped.length === 0 && equal(candidate.inputs.files, expectedFiles) &&
    equal(candidate.inputs.source_roots, screened.inputs.source_roots) && candidate.inputs.id !== screened.inputs.id,
  'The candidate manifest differs outside the exact proved write.');

  const base = observeLocalLandingBase(runtime.projectProfile, runtime.config.project.root);
  insistLanding(base !== null && equal(base, accepted.local_landing_base), 'Git HEAD or its tree differs from the approved clean parent.');
  assertExactRunInputs(runtime.config.project.root, screened.inputs, 'Screened project');
  insistLanding(equal(captureBenchmarkExecutableInputs(runtime.repoRoot, runtime.config.project.root), openingRun.executable_inputs),
    'The canonical Node, installed dependencies, or compiled benchmark basis changed after proof.');
  const path = join(runtime.config.project.root, ...change.path.split('/'));
  insistLanding(lstatSync(path).isFile() && relative(path, realpathSync.native(path)) === '', 'The screened file is linked or unavailable.');
  const original = readFileSync(path);
  insistLanding(hashBytes(original) === before.hash && original.length === before.bytes, 'The screened file differs from its recorded bytes.');
  return { events, proof, cycle, lock, screened, candidate, contract: rules, accepted, base, change, before, original, content };
}
