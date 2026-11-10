import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';

import { snapshotManifestSchema, diffSnapshots } from '../src/analysis/source/snapshot.js';
import { benchmarkResultSchema } from '../src/benchmark/benchmarkRunner.js';
import { requireProofExecutionBoundary } from '../src/benchmark/restrictedExecution.js';
import { commandProof } from '../src/cli/commands/proofCommands.js';
import { BENCHMARK_EVENT_TYPES, performBenchmarkRun, recordBenchmarkRun } from '../src/control/benchmarkRun.js';
import { captureExactRunInputs } from '../src/control/exactRunInputs.js';
import { loadConfig, withRuntime } from '../src/control/runtime.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { CYCLE_EVENT_TYPES } from '../src/cycle/cycleRegistry.js';
import { greatBookEntrySchema } from '../src/greatBook/greatBookEntry.js';
import { readGreatBookEntries } from '../src/greatBook/greatBookProjection.js';
import { EventLog } from '../src/memory/eventLog.js';
import { PROOF_EVENT_TYPES, proofContractHash, proofContractSchema } from '../src/proof/proofContract.js';
import type { DeterministicVerdict } from '../src/proof/verdict.js';
import { hashBytes, hashCanonicalJson, hashText, requireSha256 } from '../src/shared/ids.js';
import { cycleInputsLockedSchema, cycleStageAdvancedSchema, type EventRecord } from '../src/shared/schemas.js';
import { proofContract, writeCliFixture, writeJson } from './proof-cli-fixture.js';

const output = process.env['CLUE_P03_NATIVE_PILOT_OUTPUT'];

function eventRef(event: EventRecord) {
  return { id: event.id, sequence: event.sequence, sha256: event.hash };
}

function readMeasurementEvidence(artifact: unknown, expectedCost: number) {
  const run = artifact as {
    readonly execution_boundary: unknown;
    readonly proof_eligible?: boolean;
    readonly contract: { readonly sha256: string };
    readonly inputs: unknown;
    readonly result: unknown;
  };
  const result = benchmarkResultSchema.parse(run.result);
  const cost = result.measures.find((measure) => measure.id === 'SIG-COST');
  const guard = result.measures.find((measure) => measure.id === 'SIG-GUARD');
  assert.equal(result.measures.length, 2);
  assert.equal(result.incomplete.length, 0);
  assert.ok(cost !== undefined && guard !== undefined);
  assert.deepEqual([cost.value, cost.samples, cost.native_unit], [expectedCost, [expectedCost], 'ms']);
  assert.deepEqual([guard.value, guard.samples, guard.native_unit], [497, [497], 'count']);
  return { run, cost: cost.value, guard: guard.value, inputs: snapshotManifestSchema.parse(run.inputs) };
}

test('P03 native Windows supervisor records one frozen proof on a disposable target', {
  skip: output === undefined ? 'Run the reviewed P03 Windows launcher to opt in.' : false,
  timeout: 240_000,
}, async () => {
  let stage = 'qualification';
  try {
    assert.ok(output !== undefined && isAbsolute(output), 'Pilot evidence requires an absolute output path.');
    assert.equal(process.platform, 'win32', 'This pilot requires native Windows.');
    const boundary = requireProofExecutionBoundary();
    assert.equal(boundary.kind, 'windows-supervisor', 'A qualified native supervisor is required.');

    stage = 'fixture';
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'clue-p03-proof-pilot-'));
    const root = join(fixtureDirectory, 'engine');
    const target = join(root, 'target');
    const eventsRoot = join(fixtureDirectory, 'workspace', 'events');
    const candidateCost = '80';
    const expectedChange = [{ op: 'write', path: 'src/cost.txt', sha256: hashText(candidateCost), bytes: 2 }];
    const expectedPatchDigest = hashCanonicalJson(expectedChange);
    let evidence;
    try {
      writeCliFixture(root, { pushBackups: false });
      const canonicalBefore = captureExactRunInputs(target);
      const registered = { path: join(target, 'benchmark', 'stick.md'), registered: true };
      const benchmarkSha256 = hashBytes(readFileSync(registered.path));

      stage = 'screening';
      const { cycleId, missionId, snapshotId } = withRuntime({ withLog: true, repoRoot: root }, (runtime) => {
        assert.equal(runtime.projectProfile, null);
        assert.equal(runtime.config.gateway.enabled, false);
        assert.equal(runtime.config.project.remote, null);
        assert.equal(runtime.config.backup.push_on_verdict, false);
        assert.equal(runtime.config.backup.push_on_landing, false);
        assert.equal(runtime.config.patching.mode, 'NOTIFY');
        assert.ok(runtime.mission !== null);
        runtime.mission.bootstrap();
        const driven = new CycleOrchestrator(runtime).drive();
        const screened = driven.performed.find((step) => step.to === 'SCREENED');
        assert.ok(screened?.evidence, 'The disposable cycle must reach SCREENED.');
        assert.equal(driven.cycle.stage, 'SCREENED');
        const evidence = runtime.artifacts.getJson(requireSha256(screened.evidence.hash, 'screened artifact')) as {
          readonly snapshot_id: string;
          readonly inputs: unknown;
        };
        assert.deepEqual(snapshotManifestSchema.parse(evidence.inputs), canonicalBefore);
        return {
          cycleId: driven.cycle.id,
          missionId: runtime.currentMissionId(),
          snapshotId: requireSha256(evidence.snapshot_id, 'screened snapshot'),
        };
      });

      stage = 'baseline';
      const contract = proofContract(snapshotId, cycleId, missionId);
      const contractPath = join(root, 'proof-input', 'contract.json');
      const patchPath = join(root, 'proof-input', 'patch.json');
      writeJson(contractPath, contract);
      writeJson(patchPath, {
        version: 1,
        operations: [{ op: 'write', path: 'src/cost.txt', content: candidateCost }],
      });
      const performed = await performBenchmarkRun({
        repoRoot: root,
        config: loadConfig(root),
        contract: registered,
        expectedContractSha256: benchmarkSha256,
        expectedMissionVersion: missionId,
      });
      assert.ok(performed.outcome.ok, performed.outcome.ok ? '' : performed.outcome.reason);
      assert.deepEqual(performed.outcome.execution_boundary, boundary);
      const baselineReceipt = withRuntime({ withLog: true, repoRoot: root }, (runtime) => recordBenchmarkRun(runtime, performed));

      stage = 'proof';
      const exitCode = await commandProof({ contract: contractPath, patch: patchPath }, root, root);
      assert.equal(exitCode, 0, 'The governed proof CLI reported a refusal.');
      stage = 'verification';
      const canonicalAfter = captureExactRunInputs(target);
      assert.deepEqual(canonicalAfter, canonicalBefore);
      assert.equal(readFileSync(join(target, 'src', 'cost.txt'), 'utf8'), '100');
      assert.equal(existsSync(join(target, '.git')), false);

      const records = [...EventLog.replayReadOnly(eventsRoot)];
      const head = EventLog.verifyReadOnly(eventsRoot);
      assert.ok(head !== null);
      const [frozen, bound, decided] = records.slice(-3);
      assert.ok(frozen !== undefined && bound !== undefined && decided !== undefined);
      assert.deepEqual([frozen.type, bound.type, decided.type], [
        PROOF_EVENT_TYPES.contractFrozen, PROOF_EVENT_TYPES.baselineBound, PROOF_EVENT_TYPES.verdictRecorded,
      ]);
      assert.equal(records.filter((record) => record.type === PROOF_EVENT_TYPES.verdictRecorded).length, 1);
      assert.ok([frozen, bound, decided].every((record) => record.subject_id === cycleId && record.mission_version === missionId));
      assert.equal(decided.hash, head.hash);
      assert.equal(decided.sequence, head.sequence);
      const baselineRun = records.find((record) => record.id === baselineReceipt.event.id);
      assert.ok(baselineRun && baselineRun.type === BENCHMARK_EVENT_TYPES.runRecorded);
      assert.equal(baselineRun.hash, baselineReceipt.event.hash);
      assert.equal(baselineRun.mission_version, missionId);
      const lockEvent = records.find((record) => record.type === CYCLE_EVENT_TYPES.inputsLocked);
      assert.ok(lockEvent);
      const locked = cycleInputsLockedSchema.parse(lockEvent.payload);
      assert.equal(locked.cycle_id, cycleId);
      assert.equal(locked.lock.master_benchmark?.sha256, benchmarkSha256);
      const lastStageEvent = records.findLast((record) => record.type === CYCLE_EVENT_TYPES.stageAdvanced);
      assert.ok(lastStageEvent);
      const finalStage = cycleStageAdvancedSchema.parse(lastStageEvent.payload);
      assert.equal(finalStage.cycle_id, cycleId);
      assert.equal(finalStage.to, 'SCREENED');
      assert.ok(lockEvent.sequence < lastStageEvent.sequence && lastStageEvent.sequence < baselineRun.sequence &&
        baselineRun.sequence < frozen.sequence && frozen.sequence < bound.sequence && bound.sequence < decided.sequence);

      evidence = withRuntime({ withLog: false, readOnly: true, repoRoot: root }, (runtime) => {
        assert.equal(runtime.projections.isStaleAgainst(head), false);
        const frozenPayload = frozen.payload as {
          readonly contract_hash: string;
          readonly cycle_id: string;
          readonly snapshot_id: string;
          readonly inputs_id: string;
          readonly contract_artifact: { readonly hash: string };
        };
        const binding = bound.payload as {
          readonly contract_hash: string;
          readonly baseline_digest: string;
          readonly inputs_id: string;
          readonly source_event_id: string;
          readonly run_artifact_hash: string;
          readonly reused: boolean;
        };
        const decision = decided.payload as {
          readonly contract_hash: string;
          readonly disposition: string;
          readonly improvement: boolean;
          readonly baseline_digest: string;
          readonly candidate_digest: string;
          readonly candidate_snapshot_id: string;
          readonly baseline_inputs_id: string;
          readonly patch_digest: string;
          readonly change_set: unknown;
          readonly static_preparation: readonly { readonly script: string }[];
          readonly artifacts: { readonly contract: { readonly hash: string }; readonly candidate_run: { readonly hash: string }; readonly verdict: { readonly hash: string } };
          readonly great_book: { readonly state: string; readonly entry: unknown };
        };
        const getArtifact = (hash: string) => runtime.artifacts.getJson(requireSha256(hash, 'proof artifact'));
        const frozenContract = proofContractSchema.parse(getArtifact(frozenPayload.contract_artifact.hash));
        const contractHash = proofContractHash(frozenContract);
        assert.deepEqual(frozenContract, proofContractSchema.parse(contract));
        assert.deepEqual([frozenPayload.contract_hash, binding.contract_hash, decision.contract_hash], [contractHash, contractHash, contractHash]);
        assert.equal(frozenPayload.cycle_id, cycleId);
        assert.equal(frozenPayload.snapshot_id, snapshotId);
        assert.deepEqual([frozenPayload.inputs_id, binding.inputs_id, decision.baseline_inputs_id], Array(3).fill(canonicalBefore.id));
        assert.equal(binding.source_event_id, baselineRun.id);
        assert.equal(binding.run_artifact_hash, baselineReceipt.artifact.hash);
        assert.equal(binding.reused, true);
        assert.equal(decision.artifacts.contract.hash, frozenPayload.contract_artifact.hash);
        assert.equal(decision.patch_digest, expectedPatchDigest);
        assert.deepEqual(decision.change_set, expectedChange);
        assert.deepEqual(decision.static_preparation.map(({ script }) => script), ['typecheck', 'build']);
        const baseline = readMeasurementEvidence(getArtifact(binding.run_artifact_hash), 100);
        const candidate = readMeasurementEvidence(getArtifact(decision.artifacts.candidate_run.hash), 80);
        assert.equal(baseline.run.proof_eligible, true);
        assert.deepEqual(baseline.inputs, canonicalBefore);
        assert.deepEqual([baseline.run.execution_boundary, candidate.run.execution_boundary], [boundary, boundary]);
        assert.deepEqual([baseline.run.contract.sha256, candidate.run.contract.sha256], [benchmarkSha256, benchmarkSha256]);
        assert.equal(candidate.inputs.id, decision.candidate_snapshot_id);
        const diff = diffSnapshots(baseline.inputs, candidate.inputs);
        assert.deepEqual(diff.changedPaths, ['src/cost.txt']);
        assert.equal(candidate.inputs.files.find((file) => file.path === 'src/cost.txt')?.hash, expectedChange[0]?.sha256);

        const verdict = getArtifact(decision.artifacts.verdict.hash) as DeterministicVerdict;
        assert.equal(decision.disposition, 'ACCEPT');
        assert.equal(decision.improvement, true);
        assert.equal(verdict.disposition, 'ACCEPT');
        assert.equal(verdict.improvement, true);
        assert.deepEqual(verdict.identity, {
          contract_hash: contractHash,
          baseline_digest: binding.baseline_digest,
          candidate_digest: decision.candidate_digest,
          baseline_snapshot: snapshotId,
          candidate_snapshot: candidate.inputs.id,
        });
        assert.equal(decision.baseline_digest, binding.baseline_digest);
        const delta = verdict.deltas.find((measure) => measure.measure_id === 'SIG-COST');
        assert.equal(delta?.delta_pct, 20);
        assert.equal(verdict.thresholds?.success.met, true);
        assert.deepEqual(verdict.gates.map(({ outcome }) => outcome), ['pass']);
        assert.equal(decision.great_book.state, 'recorded');
        const greatBook = greatBookEntrySchema.parse(decision.great_book.entry);
        const projected = readGreatBookEntries(runtime.projections, runtime.config.project.id);
        assert.equal(projected.length, 1);
        assert.deepEqual(projected[0], greatBook);
        assert.equal(greatBook.contract_hash, contractHash);

        return {
          schemaVersion: 'clue-p03-native-proof-pilot/1',
          status: 'passed',
          scope: 'disposable-synthetic-local-target',
          configurationMode: 'legacy-v2',
          fixturePolicy: { patchingMode: 'NOTIFY', remoteConfigured: false, backupPushEnabled: false, gatewayEnabled: false },
          platform: process.platform,
          nodeVersion: process.version,
          checkedAt: new Date().toISOString(),
          supervisor: { sha256: boundary.sha256, qualificationSha256: boundary.qualificationSha256 },
          missionId,
          cycleId,
          cycleStage: finalStage.to,
          inputLock: { event: eventRef(lockEvent), digest: locked.lock.digest, grade: locked.lock.grade, absent: locked.lock.absent },
          benchmark: { id: 'fixture-stick', version: '0.1.0', contractSha256: benchmarkSha256 },
          contract: { event: eventRef(frozen), sha256: contractHash, artifactSha256: frozenPayload.contract_artifact.hash },
          baseline: {
            event: eventRef(baselineRun), bindingEvent: eventRef(bound), digest: binding.baseline_digest,
            artifactSha256: binding.run_artifact_hash, snapshotId, inputsSha256: canonicalBefore.id, cost: baseline.cost, guard: baseline.guard,
          },
          candidate: {
            digest: decision.candidate_digest, artifactSha256: decision.artifacts.candidate_run.hash,
            inputsSha256: candidate.inputs.id, patchSha256: decision.patch_digest, cost: candidate.cost, guard: candidate.guard,
          },
          verdict: {
            event: eventRef(decided), artifactSha256: decision.artifacts.verdict.hash, disposition: verdict.disposition,
            improvement: verdict.improvement, improvementPct: delta?.delta_pct, greatBookEntryId: greatBook.entry_id,
          },
          journal: { head, records: records.length },
          canonical: { beforeSha256: canonicalBefore.id, afterSha256: canonicalAfter.id, unchanged: true },
        };
      });
    } finally {
      try {
        rmSync(fixtureDirectory, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        stage = 'cleanup';
        throw error;
      }
    }
    stage = 'evidence';
    writeFileSync(output, JSON.stringify({ ...evidence, evidenceDigestSha256: hashCanonicalJson(evidence) }, null, 2) + '\n', {
      flag: 'wx',
      flush: true,
    });
  } catch (error) {
    console.error(`P03_NATIVE_PILOT_REFUSED ${stage}`);
    throw error;
  }
});
