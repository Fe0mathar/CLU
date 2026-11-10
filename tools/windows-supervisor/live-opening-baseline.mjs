/** Host-side entry for the reviewed, fixed P2 opening baseline. */
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCompleteCluBenchmarkV020 } from '../../dist/src/benchmark/benchmarkRunner.js';
import { requireProofExecutionBoundary } from '../../dist/src/benchmark/restrictedExecution.js';
import {
  BENCHMARK_EVENT_TYPES, performBenchmarkRun, prepareBenchmarkRunSubject, recordBenchmarkRun, resolveContract,
} from '../../dist/src/control/benchmarkRun.js';
import { AUTHORITY_EVENT_TYPES, verifyInstalledPackAgainstSeal } from '../../dist/src/control/mission.js';
import { readActiveProjectProfileForBenchmark } from '../../dist/src/control/projectProfiles/projectProfileStartup.js';
import { runWindowsPreflight } from '../../dist/src/control/projectProfiles/windowsPreflight.js';
import { withRuntime } from '../../dist/src/control/runtime.js';
import { computeInputLock } from '../../dist/src/cycle/cycleInputLock.js';
import { CYCLE_EVENT_TYPES, readCurrentCycle } from '../../dist/src/cycle/cycleRegistry.js';
import { EventLog } from '../../dist/src/memory/eventLog.js';
import { canonicalJson, hashBytes, hashCanonicalJson } from '../../dist/src/shared/ids.js';
import { artifactRefSchema, cycleInputLockSchema, epochSealSchema, packRatificationSchema } from '../../dist/src/shared/schemas.js';
import { redactSecretText } from '../../dist/src/shared/secretSafety.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const expected = Object.freeze({
  projectId: 'clue1',
  profileGeneration: 9,
  profileHash: 'profile:v1:62140f8b95362e58c57edc4dfb9f1e2be347fe6f832f8a02335f6c851a2b944d',
  missionId: 'MISSION-000006',
  epochName: 'P2-authoritative-MISSION-000006',
  epochEventId: 'EVENT-011723',
  ratificationEventId: 'EVENT-011722',
  epochBoundarySha256: 'c4982dedab2a248761d360f1b079ff1d155b954ccea360032c7c91ed2fdea3bb',
  epochBlobManifestSha256: '20a83247cc2088caf836df87b9797632e2a8715db0d00da5a7262b283b17229b',
  v9SealSha256: '7b62c8e3a84457f173b5bec4d63b9b417b277990d93e2949bafb5decc6e918ca',
  benchmarkSha256: 'f4ed32fa892f2a9716db44d4d0dd458d5bb029993054fefa0d06c4c68f04199f',
});

function requireCondition(condition, detail) {
  if (!condition) throw new Error(detail);
}

function reviewPreflight(sourceCommit, needsSupervisor) {
  const report = runWindowsPreflight(repoRoot);
  const blockers = report.blockers.filter((item) => needsSupervisor || item.id !== 'supervisor');
  requireCondition(blockers.length === 0, 'Preflight refused: ' + blockers.map(({ code }) => code).join(', '));
  requireCondition(report.git?.head === sourceCommit && report.git.dirty === false,
    'The working tree and commit must match the reviewed clean checkout.');
}

function readReviewedProfile() {
  const profile = readActiveProjectProfileForBenchmark(repoRoot);
  requireCondition(profile?.profile.projectId === expected.projectId && profile.generation === expected.profileGeneration &&
    profile.projectProfileHash === expected.profileHash, 'The active profile is outside the approved clue1 generation 9 scope.');
  return profile;
}

function collectReview(runtime, sourceCommit) {
  const binding = runtime.projectBinding;
  const profile = binding?.record;
  requireCondition(profile?.profile.projectId === expected.projectId &&
    profile.generation === expected.profileGeneration && profile.projectProfileHash === expected.profileHash,
  'The active profile is outside the approved clue1 generation 9 scope.');
  requireCondition(relative(realpathSync.native(runtime.repoRoot), realpathSync.native(runtime.config.project.root)) === '',
    'The benchmark target must be this CLU-E checkout.');
  const registry = runtime.requireMission();
  const mission = registry.requireCurrent();
  requireCondition(mission.id === expected.missionId, 'The active mission is outside the approved baseline scope.');
  const cycle = readCurrentCycle(runtime.projections);
  requireCondition(cycle?.mission_version === mission.id && cycle.stage === 'SCREENED' &&
    cycle.grade === 'proof-authoritative', 'Drive a fresh proof-authoritative cycle to SCREENED first.');
  let locked;
  let screened;
  const eligibleRuns = [];
  let exactEpoch;
  let exactRatification;
  const events = runtime.log === null
    ? EventLog.replayReadOnly(runtime.projectState.eventLogRoot)
    : runtime.log.replay();
  for (const event of events) {
    if (event.type === AUTHORITY_EVENT_TYPES.epochSealed) exactEpoch = event;
    if (event.type === AUTHORITY_EVENT_TYPES.packRatified) exactRatification = event;
    if (event.mission_version !== mission.id) continue;
    if (event.subject_id === cycle.id && event.payload?.cycle_id === cycle.id) {
      if (event.type === CYCLE_EVENT_TYPES.inputsLocked) locked = event;
      if (event.type === CYCLE_EVENT_TYPES.stageAdvanced && event.payload.to === 'SCREENED') screened = event;
    }
    if (event.type === BENCHMARK_EVENT_TYPES.runRecorded && event.payload?.proof_eligible === true) eligibleRuns.push(event);
  }
  requireCondition(exactEpoch?.id === expected.epochEventId && exactRatification?.id === expected.ratificationEventId &&
    exactEpoch.mission_version === mission.id && exactRatification.mission_version === mission.id &&
    exactEpoch.sequence > exactRatification.sequence,
  'The reviewed ratification and mission epoch must be the current durable records.');
  const ratification = { ...packRatificationSchema.parse(exactRatification.payload), event_id: exactRatification.id, sequence: exactRatification.sequence };
  const epoch = { ...epochSealSchema.parse(exactEpoch.payload), event_id: exactEpoch.id, sequence: exactEpoch.sequence };
  const pack = verifyInstalledPackAgainstSeal(runtime.repoRoot, 'prepare the live opening baseline');
  requireCondition(pack.pack.releaseVersion === '9.0' && pack.sealSha === expected.v9SealSha256 &&
    ratification.seal_sha256 === pack.sealSha && epoch.epoch_name === expected.epochName &&
    epoch.legacy_head_hash === expected.epochBoundarySha256 && epoch.blob_manifest_sha256 === expected.epochBlobManifestSha256 &&
    epoch.ratification_event_id === ratification.event_id && epoch.ratified_seal_sha256 === pack.sealSha,
  'The installed v9 seal or evidence boundary differs from the reviewed authority.');
  requireCondition(locked && screened && locked.sequence > exactEpoch.sequence && screened.sequence > locked.sequence,
  'The cycle must have a durable input lock and screening after the approved epoch.');

  const lock = cycleInputLockSchema.parse(locked.payload.lock);
  const recomputed = computeInputLock({ repoRoot: runtime.repoRoot, config: runtime.config, mission,
    projectBinding: binding, ratification, epoch });
  requireCondition(lock.grade === 'proof-authoritative' && lock.absent.length === 0 &&
    lock.digest === cycle.lock_digest && lock.digest === recomputed.digest &&
    lock.master_benchmark?.sha256 === expected.benchmarkSha256,
  'The cycle lock differs from the current proof-authoritative benchmark inputs.');

  const evidenceRef = artifactRefSchema.parse(screened.payload.evidence);
  const screening = runtime.artifacts.getJson(evidenceRef.hash);
  requireCondition(screening?.cycle_id === cycle.id && screening.stage === 'SCREENED',
    'The screening artifact belongs to a different cycle.');
  const contract = resolveContract(runtime.config, undefined, runtime.config.project.root);
  requireCondition(!('error' in contract) && contract.registered, 'A registered Master Benchmark is required.');
  const subject = prepareBenchmarkRunSubject(runtime, contract);
  requireCondition(subject.contract_sha256 === expected.benchmarkSha256 &&
    screening.snapshot_id === subject.snapshot_id && screening.inputs?.id === subject.inputs.id &&
    canonicalJson(screening.inputs) === canonicalJson(subject.inputs) &&
    subject.executable_inputs.engine_dist_id !== null && subject.executable_inputs.engine_dependencies_id !== null,
  'The current source, compiled output or benchmark no longer matches the screening basis.');
  requireCondition(!eligibleRuns.some((event) => event.sequence > screened.sequence &&
    event.payload.snapshot_id === subject.snapshot_id && event.payload.inputs_id === subject.inputs.id &&
    event.payload.contract?.sha256 === subject.contract_sha256),
  'This screened snapshot already has a proof-eligible benchmark receipt.');

  const review = {
    ...expected,
    sourceCommit,
    targetRootIdentity: profile.profile.targetRootIdentity,
    missionBasisSha256: registry.basis().basisHash,
    cycleId: cycle.id,
    lockDigest: lock.digest,
    screenedEventId: screened.id,
    screenedEvidenceSha256: evidenceRef.hash,
    snapshotId: subject.snapshot_id,
    inputsId: subject.inputs.id,
    configSha256: subject.config_sha256,
    executableInputs: subject.executable_inputs,
  };
  return { review, reviewDigest: hashCanonicalJson(review), contract, config: runtime.config };
}

/** Refuse incomplete runs before recording a proof-eligible baseline. */
export function requireCompleteOpeningOutcome(performed, boundary, reviewed) {
  const { outcome, subject } = performed;
  requireCondition(outcome.ok, outcome.ok ? '' : 'Benchmark refused at ' + outcome.stage + ': ' + outcome.reason);
  requireCondition(subject !== null && subject.mission_version === reviewed.missionId &&
    subject.snapshot_id === reviewed.snapshotId && subject.inputs.id === reviewed.inputsId &&
    subject.config_sha256 === reviewed.configSha256 &&
    canonicalJson(subject.executable_inputs) === canonicalJson(reviewed.executableInputs),
  'The benchmark ran against a different opening basis.');
  requireCondition(outcome.contract.benchmark_id === 'clu-master' && outcome.contract.benchmark_version === '0.2.0' &&
    outcome.contract.sha256 === reviewed.benchmarkSha256 && outcome.contract.runner_adapter === 'cli-node' &&
    canonicalJson(outcome.execution_boundary) === canonicalJson(boundary) && boundary.kind === 'windows-supervisor' &&
    outcome.result.environment.platform === 'win32',
  'The exact Windows execution boundary and benchmark are required.');
  const incomplete = outcome.result.incomplete.map(({ id }) => id);
  requireCondition(!outcome.budget.exhausted && isCompleteCluBenchmarkV020(outcome.result) &&
    outcome.policy.warmupRuns === 1 && outcome.policy.repetitions === 3 &&
    outcome.result.measures.some((measure) => measure.warmup_samples !== undefined),
  'The full opening run did not complete all 13 required measurements. Incomplete signals: ' + incomplete.join(', '));
}

export function requireReviewedQualification(bytes, boundary, sourceCommit, reviewDigest) {
  requireCondition(boundary.kind === 'windows-supervisor' && hashBytes(bytes) === boundary.qualificationSha256,
    'The exact Windows qualification receipt is required.');
  const review = JSON.parse(bytes.toString('utf8')).operatorReview;
  requireCondition(review?.operation === 'live-opening-baseline' && review.commit === sourceCommit &&
    review.reviewDigest === reviewDigest, 'The Windows qualification receipt does not authorize this reviewed baseline.');
}

async function main() {
  const [operation, sourceCommit, reviewedDigest, ...extra] = process.argv.slice(2);
  const needsSupervisor = operation === '--run';
  let stage = 'preflight';
  try {
    requireCondition(process.platform === 'win32', 'The live opening baseline requires the Windows installation.');
    requireCondition(/^[0-9a-f]{40}$/.test(sourceCommit ?? '') && extra.length === 0 &&
      ((operation === '--inspect' && reviewedDigest === undefined) ||
       (needsSupervisor && /^[0-9a-f]{64}$/.test(reviewedDigest ?? ''))),
    'Expected --inspect <source commit> or --run <source commit> <review digest>.');

    reviewPreflight(sourceCommit, needsSupervisor);
    const planned = withRuntime({ repoRoot, projectProfile: readReviewedProfile(), withLog: false, readOnly: true, requireMission: true },
      (runtime) => collectReview(runtime, sourceCommit));
    if (!needsSupervisor) {
      process.stdout.write(JSON.stringify({ state: 'READY', sourceCommit, review: planned.review, reviewDigest: planned.reviewDigest }) + '\n');
      return;
    }
    requireCondition(planned.reviewDigest === reviewedDigest, 'The opening basis changed after operator review.');
    const boundary = requireProofExecutionBoundary();
    requireReviewedQualification(readFileSync(process.env.CLU_WINDOWS_SUPERVISOR_QUALIFICATION), boundary, sourceCommit, reviewedDigest);

    stage = 'benchmark';
    const performed = await performBenchmarkRun({
      repoRoot, config: planned.config, contract: planned.contract,
      expectedContractSha256: expected.benchmarkSha256, expectedMissionVersion: expected.missionId,
      log: (line) => process.stderr.write(line + '\n'),
    });
    requireCompleteOpeningOutcome(performed, boundary, planned.review);
    stage = 'record';
    reviewPreflight(sourceCommit, true);
    const receipt = withRuntime({ repoRoot, projectProfile: readReviewedProfile(), withLog: true, verifyLog: 'full', requireMission: true }, (runtime) => {
      requireCondition(collectReview(runtime, sourceCommit).reviewDigest === reviewedDigest,
        'The opening basis changed during the benchmark.');
      const recorded = recordBenchmarkRun(runtime, performed);
      const artifact = runtime.artifacts.getJson(recorded.artifact.hash);
      requireCondition(artifact?.proof_eligible === true && isCompleteCluBenchmarkV020(artifact.result) &&
        canonicalJson(artifact.execution_boundary) === canonicalJson(boundary),
      'The stored baseline artifact did not verify against the Windows run.');
      return recorded;
    });
    requireCondition(receipt.event.payload.proof_eligible === true &&
      receipt.event.payload.measures_count === 13 && receipt.event.payload.incomplete_count === 0,
    'The durable run receipt did not qualify as a full opening baseline.');
    process.stdout.write(JSON.stringify({
      state: 'PASS', sourceCommit, reviewDigest: reviewedDigest, review: planned.review,
      eventId: receipt.event.id, sequence: receipt.event.sequence, eventSha256: receipt.event.hash,
      artifactSha256: receipt.artifact.hash, measures: 13, incomplete: 0,
      executionBoundary: boundary,
    }) + '\n');
  } catch (error) {
    const detail = redactSecretText(error instanceof Error ? error.message : String(error)).text.slice(0, 1024);
    process.stdout.write(JSON.stringify({ state: 'BLOCKED', stage, sourceCommit, detail }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && relative(resolve(process.argv[1]), fileURLToPath(import.meta.url)) === '') await main();
