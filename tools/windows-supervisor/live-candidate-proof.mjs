/** Host entry point for the reviewed Windows recognizer proof. */
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCompleteCluBenchmarkV020 } from '../../dist/src/benchmark/benchmarkRunner.js';
import { requireProofExecutionBoundary } from '../../dist/src/benchmark/restrictedExecution.js';
import { proofPatchManifestSchema } from '../../dist/src/cli/commands/proofCommands.js';
import { withRuntime, withRuntimeAsync } from '../../dist/src/control/runtime.js';
import { CycleOrchestrator } from '../../dist/src/cycle/cycleOrchestrator.js';
import { freezeProofContract, PROOF_EVENT_TYPES } from '../../dist/src/proof/proofContract.js';
import { canonicalJson, hashBytes, hashCanonicalJson } from '../../dist/src/shared/ids.js';
import { redactSecretText } from '../../dist/src/shared/secretSafety.js';
import {
  collectReview, readReviewedProfile, repoRoot, requireCondition, requireOperationAuthorization,
  requireReviewedQualification, reviewPreflight,
} from './live-opening-baseline.mjs';
import { stageGovernedOfflineCache } from './governedOfflineCache.mjs';

const candidateTarget = 'src/analysis/source/recognizer.ts';
const capabilities = Object.freeze(['benchmark:clu-master', 'harness:HRN-001', 'runner:cli-node']);
const operationName = 'live-candidate-proof';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const evidenceRoot = join(dirname(repoRoot.replace(/[\\/]$/u, '')), 'release-evidence');

function inside(parent, child) {
  const delta = relative(parent, child);
  return delta !== '' && delta !== '..' && !/^\.\.[\\/]/u.test(delta) && !isAbsolute(delta);
}

function readExactEvidence(path, maximumBytes) {
  requireCondition(isAbsolute(path) && inside(evidenceRoot, path) &&
    relative(path, realpathSync.native(path)) === '', 'Use regular, unlinked files in release-evidence.');
  const before = lstatSync(path, { bigint: true });
  requireCondition(before.isFile() && before.nlink === 1n && before.size > 0n &&
    before.size <= BigInt(maximumBytes), 'A proof input is missing, linked or oversized.');
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    const same = (stat) => stat.isFile() && stat.nlink === 1n && stat.ino === before.ino &&
      stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
    requireCondition(same(opened), 'A proof input changed while opening it.');
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireCondition(count > 0, 'A proof input was truncated.');
      offset += count;
    }
    requireCondition(same(fstatSync(fd, { bigint: true })) && same(lstatSync(path, { bigint: true })) &&
      relative(path, realpathSync.native(path)) === '', 'A proof input changed while reading it.');
    return { bytes, sha256: hashBytes(bytes) };
  } finally {
    closeSync(fd);
  }
}

function readInputs(openingReport, contractPath, patchPath) {
  const opening = readExactEvidence(openingReport, 1024 * 1024);
  const contract = readExactEvidence(contractPath, 2 * 1024 * 1024);
  const patch = readExactEvidence(patchPath, 2 * 1024 * 1024);
  const manifest = proofPatchManifestSchema.parse(JSON.parse(decoder.decode(patch.bytes)));
  const [write] = manifest.operations;
  requireCondition(manifest.operations.length === 1 && write.op === 'write' &&
    write.path === candidateTarget && typeof write.source === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.ts$/u.test(write.source) && basename(write.source) === write.source,
  'The reviewed candidate must replace only recognizer.ts with the named source beside the manifest.');
  const source = readExactEvidence(join(dirname(patchPath), write.source), 16 * 1024 * 1024);
  return {
    opening: JSON.parse(decoder.decode(opening.bytes)),
    contract: JSON.parse(decoder.decode(contract.bytes)),
    patch: [{ op: 'write', path: write.path, content: decoder.decode(source.bytes) }],
    inputPins: {
      openingReportSha256: opening.sha256,
      proofContractSha256: contract.sha256,
      patchManifestSha256: patch.sha256,
      candidateSourceSha256: source.sha256,
      candidateSourceName: write.source,
      candidateTarget: write.path,
    },
  };
}

export function requirePassingOpening(report, planned, runtime) {
  const { baseline, inspection } = report;
  const boundary = baseline?.executionBoundary;
  requireCondition(report.schemaVersion === 'clue-windows-live-opening-baseline/2' && report.state === 'PASS' &&
    report.phase === 'BASELINE_COMPLETE' && report.sourceCommit === planned.review.sourceCommit &&
    report.reviewDigest === planned.reviewDigest && inspection?.reviewDigest === planned.reviewDigest &&
    inspection.state === 'READY' && canonicalJson(inspection.review) === canonicalJson(planned.review) &&
    baseline?.state === 'PASS' && baseline.sourceCommit === planned.review.sourceCommit &&
    baseline.reviewDigest === planned.reviewDigest && canonicalJson(baseline.review) === canonicalJson(planned.review) &&
    baseline.measures === 13 && baseline.incomplete === 0 && boundary?.kind === 'windows-supervisor' &&
    boundary.sha256 === report.supervisorSha256 && boundary.qualificationSha256 === report.qualificationReceiptSha256,
  'A passing P05 opening report for this exact screened cycle is required.');
  const event = planned.matchingRuns.find((run) => run.id === baseline.eventId);
  const payload = event?.payload;
  requireCondition(event !== undefined && event.hash === baseline.eventSha256 && event.sequence === baseline.sequence &&
    payload.registered === true && payload.proof_eligible === true && payload.measures_count === 13 &&
    payload.incomplete_count === 0 && payload.budget_exhausted === false &&
    payload.result_artifact?.hash === baseline.artifactSha256 && payload.config_sha256 === planned.review.configSha256 &&
    canonicalJson(payload.executable_inputs) === canonicalJson(planned.review.executableInputs) &&
    canonicalJson(payload.project_basis) === canonicalJson(planned.lock.project_basis) &&
    canonicalJson(payload.execution_boundary) === canonicalJson(boundary),
  'The passing opening receipt does not match the verified event log.');
  const artifact = runtime.artifacts.getJson(baseline.artifactSha256);
  requireCondition(artifact?.proof_eligible === true && artifact.budget?.exhausted === false &&
    isCompleteCluBenchmarkV020(artifact.result) && artifact.inputs?.id === planned.review.inputsId &&
    artifact.contract?.sha256 === planned.review.benchmarkSha256 && artifact.config_sha256 === planned.review.configSha256 &&
    canonicalJson(artifact.executable_inputs) === canonicalJson(planned.review.executableInputs) &&
    canonicalJson(artifact.project_basis) === canonicalJson(planned.lock.project_basis) &&
    canonicalJson(artifact.execution_boundary) === canonicalJson(boundary),
  'The verified opening artifact is incomplete or differs from its receipt.');
  return { baseline, boundary };
}

function planCandidate(runtime, sourceCommit, inputs, cache) {
  const planned = collectReview(runtime, sourceCommit, false);
  const { baseline, boundary } = requirePassingOpening(inputs.opening, planned, runtime);
  const qualification = readExactEvidence(inputs.opening.qualificationReceipt, 1024 * 1024);
  requireReviewedQualification(qualification.bytes, boundary, sourceCommit, planned.reviewDigest);
  requireOperationAuthorization(readExactEvidence(inputs.opening.authorizationReceipt, 1024 * 1024).bytes,
    inputs.opening.authorizationReceiptSha256, 'live-opening-baseline', sourceCommit, planned.reviewDigest,
    boundary.qualificationSha256);
  const frozen = freezeProofContract({
    contract: inputs.contract, policy: runtime.config.proof, capabilities,
    expectedProjectBasis: planned.lock.project_basis,
  });
  requireCondition(!('refusals' in frozen),
    'The reviewed Proof Contract failed freeze: ' + (frozen.refusals ?? []).join(' / '));
  const contract = frozen.contract;
  requireCondition(contract.contract_version === 2 && contract.cycle_id === planned.review.cycleId &&
    contract.mission_version === planned.review.missionId && contract.snapshot_id === planned.review.snapshotId &&
    contract.execution.warmup_runs === 1 && contract.execution.repetitions === 3 &&
    contract.execution.statistic === 'median' && contract.thresholds.success.measure_id === 'SIG-001' &&
    contract.thresholds.success.kind === 'improve_pct_at_least' && contract.thresholds.success.pct >= 5,
  'The Proof Contract must bind the fresh cycle and its reviewed measurement policy.');
  requireCondition(planned.lock.project_basis !== undefined &&
    planned.matchingRuns.every((run) => run.sequence <= baseline.sequence ||
      canonicalJson(run.payload.execution_boundary) !== canonicalJson(boundary)),
  'A later baseline on the same native boundary requires its own review.');
  const review = {
    ...planned.review,
    ...inputs.inputPins,
    operation: operationName,
    openingReviewDigest: planned.reviewDigest,
    openingEventId: baseline.eventId,
    openingEventSha256: baseline.eventSha256,
    openingArtifactSha256: baseline.artifactSha256,
    executionBoundary: boundary,
    authoritySha256: planned.lock.project_basis.authorityHash,
    proofContractHash: frozen.contract_hash,
    offlineCacheManifestSha256: cache.manifestSha256,
    journalHeadSha256: planned.journalHead.hash,
  };
  return { review, reviewDigest: hashCanonicalJson(review), boundary };
}

function matchesRelocation(relocation, review) {
  return relocation?.canonicalProfileHash === review.profileHash &&
    relocation.canonicalAuthoritySha256 === review.authoritySha256 &&
    /^profile:v1:[0-9a-f]{64}$/u.test(relocation.shadowProfileHash) &&
    relocation.shadowProfileHash !== review.profileHash &&
    /^MISSION-[0-9]+$/u.test(relocation.shadowMission) &&
    /^[0-9a-f]{64}$/u.test(relocation.shadowAuthoritySha256) &&
    /^[0-9a-f]{64}$/u.test(relocation.capsuleSha256);
}

function stageCandidateCache(cacheDirectory, cacheSource) {
  requireCondition(isAbsolute(cacheDirectory) && inside(evidenceRoot, cacheDirectory) &&
    relative(dirname(cacheDirectory), realpathSync.native(dirname(cacheDirectory))) === '',
  'The reviewed cache must be staged outside the project in release-evidence.');
  mkdirSync(cacheDirectory);
  const cache = stageGovernedOfflineCache({
    lockfile: join(repoRoot, 'package-lock.json'), destinationCache: cacheDirectory,
    ...(cacheSource === undefined ? {} : { sourceCache: cacheSource }),
  });
  requireCondition(cache.state === 'READY',
    'Verified offline npm cache unavailable: ' + cache.blocker);
  return cache;
}

export function buildBlockedReport(error, stage, sourceCommit) {
  const detail = redactSecretText(error instanceof Error ? error.message : String(error)).text.slice(0, 1024);
  const recordedEventId = /^EVENT-[0-9]+$/u.test(error?.recordedEventId ?? '') ? error.recordedEventId : undefined;
  const evidence = Array.isArray(error?.evidence)
    ? error.evidence.slice(0, 32).filter((item) => typeof item === 'string')
      .map((item) => redactSecretText(item).text.slice(0, 1024))
    : undefined;
  return { state: 'BLOCKED', stage, sourceCommit, detail, recordedEventId, evidence };
}

async function main() {
  const [operation, sourceCommit, ...args] = process.argv.slice(2);
  const execute = operation === '--run';
  const reviewedDigest = execute ? args.shift() : undefined;
  const [openingReport, contract, patch, cacheDirectory, cacheSource] = args;
  let stage = 'preflight';
  try {
    requireCondition(process.platform === 'win32' && (execute || operation === '--inspect') &&
      /^[0-9a-f]{40}$/u.test(sourceCommit ?? '') && (!execute || /^[0-9a-f]{64}$/u.test(reviewedDigest ?? '')) &&
      (args.length === 4 || args.length === 5), 'Invalid reviewed Windows candidate invocation.');
    reviewPreflight(sourceCommit, execute);
    const inputs = readInputs(openingReport, contract, patch);
    stage = 'offline-cache';
    const cache = stageCandidateCache(cacheDirectory, cacheSource);
    stage = 'review';
    const options = { repoRoot, projectProfile: readReviewedProfile(), requireMission: true };
    const plan = withRuntime({ ...options, withLog: false, readOnly: true },
      (runtime) => planCandidate(runtime, sourceCommit, inputs, cache));
    if (!execute) {
      process.stdout.write(JSON.stringify({ state: 'READY', sourceCommit, review: plan.review, reviewDigest: plan.reviewDigest }) + '\n');
      return;
    }
    requireCondition(plan.reviewDigest === reviewedDigest, 'The candidate changed after operator review.');
    const boundary = requireProofExecutionBoundary();
    requireCondition(canonicalJson(boundary) === canonicalJson(plan.boundary),
      'The live qualification must match the opening benchmark exactly.');
    requireOperationAuthorization(readExactEvidence(process.env.CLU_PROOF_OPERATOR_AUTHORIZATION, 1024 * 1024).bytes,
      process.env.CLU_PROOF_OPERATOR_AUTHORIZATION_SHA256, operationName, sourceCommit, reviewedDigest, boundary.qualificationSha256);

    stage = 'proof';
    process.stderr.write('Running the unchanged shadow control and the reviewed candidate in the verified Windows boundary.\n');
    process.env.CLU_OFFLINE_NPM_CACHE = cacheDirectory;
    const receipt = await withRuntimeAsync({ ...options, withLog: true, verifyLog: 'full' }, async (runtime) => {
      requireCondition(planCandidate(runtime, sourceCommit, inputs, cache).reviewDigest === reviewedDigest,
        'The durable proof basis changed before execution.');
      const result = await new CycleOrchestrator(runtime).candidate({
        contract: inputs.contract, patch: inputs.patch, capabilities, expectedBaselineEventId: plan.review.openingEventId,
        log: (line) => process.stderr.write(line + '\n'),
      });
      if (!result.ok) {
        throw Object.assign(new Error('Proof refused at ' + result.stage + ': ' + result.reasons.join(' / ')),
          { recordedEventId: result.recorded_event, evidence: result.evidence });
      }
      const events = [...runtime.requireLog().replay()];
      const bound = events.findLast((event) => event.type === PROOF_EVENT_TYPES.baselineBound &&
        event.subject_id === plan.review.cycleId && event.payload?.contract_hash === result.contract_hash);
      const verdict = events.find((event) => event.id === result.events.verdict);
      const candidate = runtime.artifacts.getJson(result.artifacts.candidate_run.hash);
      const durableVerdict = runtime.artifacts.getJson(result.artifacts.verdict.hash);
      const controlSha256 = candidate?.matched_control?.hash;
      requireCondition(/^[0-9a-f]{64}$/u.test(controlSha256 ?? ''), 'The durable candidate does not reference its matched control.');
      const control = runtime.artifacts.getJson(controlSha256);
      requireCondition(bound?.payload.source_event_id === plan.review.openingEventId &&
        bound.payload.run_artifact_hash === plan.review.openingArtifactSha256 && verdict?.type === PROOF_EVENT_TYPES.verdictRecorded &&
        bound.sequence < verdict.sequence && verdict.subject_id === plan.review.cycleId &&
        verdict.mission_version === plan.review.missionId && verdict.payload.contract_hash === plan.review.proofContractHash &&
        verdict.payload.disposition === result.verdict.disposition &&
        verdict.payload.change_set?.length === 1 && verdict.payload.change_set[0].path === plan.review.candidateTarget &&
        verdict.payload.change_set[0].sha256 === plan.review.candidateSourceSha256 &&
        verdict.payload.artifacts?.candidate_run?.hash === result.artifacts.candidate_run.hash &&
        verdict.payload.artifacts?.verdict?.hash === result.artifacts.verdict.hash &&
        canonicalJson(durableVerdict) === canonicalJson(result.verdict) &&
        canonicalJson(candidate?.execution_boundary) === canonicalJson(boundary) && isCompleteCluBenchmarkV020(candidate.result),
      'The durable candidate or verdict did not match the reviewed proof.');
      requireCondition(control?.role === 'unchanged-matched-shadow-control' && control.inputs?.id === plan.review.inputsId &&
        control.contract?.sha256 === plan.review.benchmarkSha256 && control.budget?.exhausted === false &&
        canonicalJson(control.execution_boundary) === canonicalJson(boundary) && isCompleteCluBenchmarkV020(control.result),
      'The durable matched shadow control did not match the screened inputs and native boundary.');
      requireCondition(matchesRelocation(control.profile_relocation, plan.review) &&
        matchesRelocation(candidate.profile_relocation, plan.review) &&
        control.profile_relocation.shadowProfileHash !== candidate.profile_relocation.shadowProfileHash &&
        control.profile_relocation.capsuleSha256 !== candidate.profile_relocation.capsuleSha256,
      'The durable runs did not prove separate, authority-bound shadow profiles.');
      requireCondition(result.verdict.disposition !== 'ACCEPT' || result.great_book.state === 'recorded',
        'The accepted verdict lacks its durable Great Book entry.');
      return {
        disposition: result.verdict.disposition, eventId: verdict.id, eventSha256: verdict.hash,
        controlArtifactSha256: controlSha256,
        profileRelocation: { control: control.profile_relocation, candidate: candidate.profile_relocation },
        candidateArtifactSha256: result.artifacts.candidate_run.hash, verdictArtifactSha256: result.artifacts.verdict.hash,
        greatBookEntryId: result.great_book.state === 'recorded' ? result.great_book.entry.entry_id : null,
      };
    });
    reviewPreflight(sourceCommit, true);
    process.stdout.write(JSON.stringify({
      state: 'PASS', sourceCommit, review: plan.review, reviewDigest: reviewedDigest, executionBoundary: boundary, ...receipt,
    }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify(buildBlockedReport(error, stage, sourceCommit)) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') await main();
