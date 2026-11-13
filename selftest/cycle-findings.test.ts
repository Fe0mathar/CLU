import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { RankedCandidate, RankingResult } from '../src/analysis/metrics/ranking.js';
import { recognize, type SourceUnit } from '../src/analysis/source/recognizer.js';
import { runMasterBenchmark } from '../src/benchmark/benchmarkRunner.js';
import { canonicalHarnessBody } from '../src/benchmark/harnessBlock.js';
import { prepareBenchmarkRunSubject, recordBenchmarkRun } from '../src/control/benchmarkRun.js';
import { assessCurrentFindings, readCurrentFindings } from '../src/control/cycleFindings.js';
import { selectFindingCandidate } from '../src/control/findingSelection.js';
import { PACK_MANIFEST_FILE, PACK_SEAL_FILE } from '../src/control/mission.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { enableProjectProfileStartup, projectProfileCutoverConfirmation } from '../src/control/projectProfiles/projectProfileStartup.js';
import { withRuntime } from '../src/control/runtime.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { hashBytes, hashText, requireSha256 } from '../src/shared/ids.js';
import { cloneProfile, makeProjectProfileFixture } from './project-profile-fixture.js';
import { writeProfileRuntimeInstallation, writeRecognitionTarget } from './project-recognition-fixture.js';

function makeRuntimeFixture(t: TestContext, ratify = true, declareBinding = false) {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const repoRoot = join(fixture.root, 'installation');
  writeProfileRuntimeInstallation(repoRoot);
  writeRecognitionTarget(fixture.target, 'finding_fixture');
  for (const path of [
    'config/measurements/catalogue.yaml', 'config/policies/equilibrium.yaml',
    'config/policies/patching.yaml', 'config/policies/budget.yaml',
    'config/policies/routing.yaml', 'config/policies/p2-closure.yaml',
  ]) {
    const destination = join(repoRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(process.cwd(), path), destination);
  }
  const manifest = '{"permanentFiles":[]}\n';
  writeFileSync(join(repoRoot, PACK_MANIFEST_FILE), manifest);
  writeFileSync(join(repoRoot, PACK_SEAL_FILE),
    `${hashBytes(readFileSync(join(repoRoot, 'CLUE.md')))}  CLUE.md\n${hashText(manifest)}  ${PACK_MANIFEST_FILE}\n`);

  const unit = recognize({ projectRoot: fixture.target, tsconfigPath: join(fixture.target, 'tsconfig.json') })
    .units.find((row) => row.name === 'finding_fixture');
  assert.ok(unit);
  const body = `return { benchmarkVersion: '1.0.0', unifiedScore: null, environment: context.environment,
  measures: [{ id: 'SIG-001', name: 'Fixture timing', scenario: 'SCN-001', native_unit: 'ms',
    aggregation: 'exact', value: 1, samples: [1], warmup_samples: [1] }], protective: [], incomplete: [] };`;
  const bindings = declareBinding ? ['```clue-finding-bindings', JSON.stringify([{
    unitId: unit.logicalId, unitVersion: unit.versionHash, scenarioId: 'SCN-001', signalId: 'SIG-001',
  }]), '```', ''] : [];
  const benchmark = [
    'benchmark_id = fixture-master',
    'benchmark_version = 1.0.0',
    'runner_adapter = cli-node',
    '',
    '[harness.HRN-001]',
    'runner_adapter = cli-node',
    'scenario_ids = SCN-001',
    'language = javascript',
    `integrity = ${hashText(canonicalHarnessBody(body))}`,
    '--- begin harness ---',
    body,
    '--- end harness ---',
    '',
    ...bindings,
  ].join('\n');
  writeFileSync(fixture.masterBenchmark, benchmark);
  const profile = cloneProfile(fixture.profile, (draft) => {
    const authority = draft['authority'] as Record<string, unknown>;
    const masterBenchmark = authority['masterBenchmark'] as Record<string, unknown>;
    masterBenchmark['sha256'] = hashText(benchmark);
    const benchmarkRuntime = draft['benchmarkRuntime'] as Record<string, unknown>;
    benchmarkRuntime['scenario'] = 'SCN-001';
  });
  const registry = new ProjectProfileRegistry(fixture.profiles);
  const projectProfile = registry.create(profile, { actor: 'creator' });
  const options = { repoRoot, projectProfile, withLog: true, workspaceIdentityOnMissing: 'initialize-new' } as const;
  withRuntime(options, (runtime) => {
    assert.ok(runtime.mission);
    runtime.mission.bootstrap();
    if (ratify) {
      runtime.mission.ratifyInstalledAuthority({ statement: 'RATIFY FINDINGS FIXTURE' });
      runtime.mission.sealEpoch({ epochName: 'findings-fixture', statement: 'SEAL FINDINGS FIXTURE' });
    }
  });
  enableProjectProfileStartup({ repoRoot, registry, projectId: projectProfile.profile.projectId,
    confirmation: projectProfileCutoverConfirmation(projectProfile) });
  return { options, target: fixture.target, benchmarkPath: fixture.masterBenchmark, unit };
}

test('findings are pinned to the screened evidence and repeat without another journal event', (t) => {
  const fixture = makeRuntimeFixture(t);
  withRuntime(fixture.options, (runtime) => {
    assert.equal(readCurrentFindings(runtime), null);
    assert.throws(() => assessCurrentFindings(runtime), { code: 'FINDINGS_SCREENED_REQUIRED' });
    const { cycle, lock } = new CycleOrchestrator(runtime).drive(null, { verifyRecovery: true });
    assert.equal(cycle.stage, 'SCREENED');
    assert.equal(cycle.grade, 'proof-authoritative', JSON.stringify(lock?.absent));
    assert.equal(readCurrentFindings(runtime), null);
    const prior = runtime.requireLog().getHead();
    assert.ok(prior);
    const receipt = assessCurrentFindings(runtime);
    assert.equal(receipt.outcome, 'NO_CANDIDATE');
    assert.equal(receipt.selected, null);
    assert.equal(receipt.projectId, fixture.options.projectProfile.profile.projectId);
    assert.equal(receipt.profileGeneration, fixture.options.projectProfile.generation);
    assert.equal(receipt.cycleId, cycle.id);
    assert.equal(receipt.lockDigest, cycle.lock_digest);
    const after = runtime.requireLog().getHead();
    assert.equal(after?.sequence, prior.sequence + 1);
    assert.equal(after?.hash, receipt.eventSha256);
    const event = [...runtime.requireLog().replay()].at(-1);
    assert.equal(event?.type, 'findings.assessed');
    assert.equal(event?.subject_id, cycle.id);
    assert.deepEqual(assessCurrentFindings(runtime), receipt);
    assert.deepEqual(runtime.requireLog().getHead(), after);
  });
  withRuntime({ ...fixture.options, withLog: false, readOnly: true }, (runtime) => {
    assert.equal(readCurrentFindings(runtime)?.outcome, 'NO_CANDIDATE');
  });
  withRuntime(fixture.options, (runtime) => {
    new CycleOrchestrator(runtime).suspend('fixture stops the screened cycle');
    assert.equal(readCurrentFindings(runtime), null);
  });
});

test('source drift after screening refuses a new findings assessment', (t) => {
  const fixture = makeRuntimeFixture(t);
  withRuntime(fixture.options, (runtime) => {
    const { cycle, lock } = new CycleOrchestrator(runtime).drive(null, { verifyRecovery: true });
    assert.equal(cycle.stage, 'SCREENED');
    assert.equal(cycle.grade, 'proof-authoritative', JSON.stringify(lock?.absent));
    const before = runtime.requireLog().getHead();
    writeFileSync(join(fixture.target, 'src', 'value.ts'), 'export const finding_fixture = 5;\n');
    assert.throws(() => assessCurrentFindings(runtime), { code: 'FINDINGS_INPUTS_CHANGED' });
    assert.deepEqual(runtime.requireLog().getHead(), before);
  });
});

test('diagnostic screening cannot mint a findings assessment', (t) => {
  const fixture = makeRuntimeFixture(t, false);
  withRuntime(fixture.options, (runtime) => {
    const { cycle } = new CycleOrchestrator(runtime).drive(null, { verifyRecovery: true });
    assert.equal(cycle.stage, 'SCREENED');
    assert.equal(cycle.grade, 'diagnostic');
    const before = runtime.requireLog().getHead();
    assert.throws(() => assessCurrentFindings(runtime), { code: 'FINDINGS_PROOF_AUTHORITY_REQUIRED' });
    assert.deepEqual(runtime.requireLog().getHead(), before);
    assert.equal(readCurrentFindings(runtime), null);
  });
});

test('a damaged findings artifact is refused before it can become a dashboard receipt', (t) => {
  const fixture = makeRuntimeFixture(t);
  withRuntime(fixture.options, (runtime) => {
    new CycleOrchestrator(runtime).drive(null, { verifyRecovery: true });
    const receipt = assessCurrentFindings(runtime);
    const evidencePath = runtime.artifacts.pathFor(requireSha256(receipt.evidenceSha256, 'findings evidence'));
    chmodSync(evidencePath, 0o600);
    writeFileSync(evidencePath, '{}\n');
    assert.throws(() => readCurrentFindings(runtime));
  });
});

test('declared benchmark coverage requires an opening receipt, then can select its exact source unit', async (t) => {
  const fixture = makeRuntimeFixture(t, true, true);
  const contract = { path: fixture.benchmarkPath, registered: true };
  const prepared = withRuntime(fixture.options, (runtime) => {
    const metrics = runtime.metrics;
    assert.ok(metrics);
    const recordRanking = metrics.recordRanking.bind(metrics);
    // Keep the journal, screening and graph real while making the fixture's ranking independent
    // of changes to production scoring weights.
    metrics.recordRanking = (result, weights) => {
      const row = ranked(fixture.unit);
      Object.assign(result, { patchCandidates: [row], instrumentationCandidates: [],
        clarificationCandidates: [], excluded: [], stats: { ...result.stats, unitsRanked: 1,
          byKind: { patch: 1, instrumentation: 0, clarification: 0, excluded: 0 } } });
      return recordRanking(result, weights);
    };
    const { cycle, lock } = new CycleOrchestrator(runtime).drive(null, { verifyRecovery: true });
    assert.equal(cycle.grade, 'proof-authoritative', JSON.stringify(lock?.absent));
    const log = runtime.requireLog();
    const before = log.getHead();
    assert.throws(() => assessCurrentFindings(runtime), { code: 'FINDINGS_OPENING_BENCHMARK_REQUIRED' });
    assert.deepEqual(log.getHead(), before);
    return { subject: prepareBenchmarkRunSubject(runtime, contract), log_head_before: before };
  });
  // Exercise the normal runner and receipt writer with an isolated fixture adapter. This does
  // not qualify the platform supervisor or record anything in the operator's workspace.
  const outcome = await runMasterBenchmark({ repoRoot: fixture.options.repoRoot, projectRoot: fixture.target,
    workspaceRoot: fixture.options.projectProfile.profile.state.eventLogRoot, contractPath: contract.path,
    execImpl: async () => assert.fail('The fixture harness must perform no external process work.'),
    executionBoundary: { kind: 'linux-bwrap', sha256: hashText('test boundary') } });
  assert.ok(outcome.ok, outcome.ok ? undefined : outcome.reason);
  withRuntime(fixture.options, (runtime) => {
    const opening = recordBenchmarkRun(runtime, { ...prepared, outcome, contract });
    assert.equal((opening.event.payload as { proof_eligible: boolean }).proof_eligible, true);
    const receipt = assessCurrentFindings(runtime);
    assert.equal(receipt.outcome, 'SELECTED');
    assert.equal(receipt.selected?.unitId, fixture.unit.logicalId);
    assert.equal(receipt.selected?.signalId, 'SIG-001');
    assert.match(receipt.selected?.reason ?? '', new RegExp(opening.event.id));
    assert.deepEqual(readCurrentFindings(runtime), receipt);
  });
});

function makeUnit(name: string): SourceUnit {
  const path = `src/${name}.ts`;
  return { logicalId: `${path}#${name}`, versionHash: hashText(name), kind: 'function', name,
    qualifiedName: name, modulePath: path, exported: true, anchor: { path, startLine: 1, endLine: 3,
      startByte: 0, endByte: 20 }, parentLogicalId: null, lineCount: 3, byteLength: 20, isAsync: false,
    parameterCount: 0 };
}

function ranked(unit: SourceUnit): RankedCandidate {
  return { logicalId: unit.logicalId, modulePath: unit.modulePath, subsystem: 'src', kind: 'patch',
    lane: 'safe-improvement', priority: 0.8, magnitude: 0.7, ease: 0.8, confidence: 0.9,
    evidence: 'observed', dominantFamily: 'intrinsicEfficiency', proofReadiness: 'measurable',
    magnitudeComponents: [], easeComponents: [], corrections: [], exclusionReason: null,
    proposedAction: 'Design a bounded proof.', quadrant: 'monofile-monodependency', blastRadius: 'local',
    unitClass: 'monodependency', impactSize: 0 };
}

test('selector uses stable priority ties and refuses unbound or protected proposals', () => {
  const units = [makeUnit('alpha'), makeUnit('beta')];
  const [alpha, beta] = units.map(ranked);
  assert.ok(alpha && beta);
  const ranking: RankingResult = { snapshotId: hashText('snapshot'), patchCandidates: [beta, alpha],
    instrumentationCandidates: [], clarificationCandidates: [], excluded: [], stats: { unitsRanked: 2,
      byKind: { patch: 2, instrumentation: 0, clarification: 0, excluded: 0 }, familiesUnavailable: [],
      observedEvidenceAvailable: true, correctionsApplied: 0 } };
  const signal = { signalId: 'SIG-001', signalName: 'Declared execution time', evidenceReason: 'The locked benchmark names this unit.', objectiveIds: ['OBJ-001'] };
  const params = { ranking, units, isProtected: () => null, firstFindingSequence: 1000 };
  const bindings = new Map([[alpha.logicalId, signal], [beta.logicalId, signal]]);
  const selected = selectFindingCandidate({ ...params, signalBindings: bindings });
  assert.equal(selected.outcome, 'SELECTED');
  assert.equal(selected.selected?.unitId, alpha.logicalId);
  assert.equal(selected.selected?.signalId, signal.signalId);
  assert.equal(selectFindingCandidate({ ...params, signalBindings: new Map() }).outcome, 'NO_CANDIDATE');
  assert.equal(selectFindingCandidate({ ...params, signalBindings: bindings, isProtected: () => 'protected' }).outcome, 'NO_CANDIDATE');
});
