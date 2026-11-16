import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { RankedCandidate, RankingResult } from '../src/analysis/metrics/ranking.js';
import { recognize, type SourceUnit } from '../src/analysis/source/recognizer.js';
import { runMasterBenchmark } from '../src/benchmark/benchmarkRunner.js';
import { canonicalHarnessBody } from '../src/benchmark/harnessBlock.js';
import { commandCycleDrive } from '../src/cli/commands/cycleCommands.js';
import { prepareBenchmarkRunSubject, recordBenchmarkRun } from '../src/control/benchmarkRun.js';
import { assessCurrentFindings, readCurrentFindings } from '../src/control/cycleFindings.js';
import { selectFindingCandidate } from '../src/control/findingSelection.js';
import { PACK_MANIFEST_FILE, PACK_SEAL_FILE } from '../src/control/mission.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { enableProjectProfileStartup, projectProfileCutoverConfirmation } from '../src/control/projectProfiles/projectProfileStartup.js';
import { runRecognition } from '../src/control/recognitionRun.js';
import { withRuntime, withRuntimeAsync, type Runtime } from '../src/control/runtime.js';
import { CycleOrchestrator } from '../src/cycle/cycleOrchestrator.js';
import { compareClosingBenchmark, recordedOpeningComparisonSchema } from '../src/cycle/closingBenchmarkComparison.js';
import { startClueDashboard } from '../src/daemon/clueDashboardServer.js';
import { hashBytes, hashText, requireSha256 } from '../src/shared/ids.js';
import { nextCycleVitalInputSchema } from '../src/shared/schemas.js';
import { cloneProfile, makeProjectProfileFixture } from './project-profile-fixture.js';
import { writeProfileRuntimeInstallation, writeRecognitionTarget } from './project-recognition-fixture.js';

function makeRuntimeFixture(
  t: TestContext,
  ratify = true,
  declareBinding = false,
  completeBenchmark: false | 'sampled' | 'derived' = false,
) {
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
  const body = completeBenchmark ? `
    const measures = Array.from({length: 13}, (_, index) => {
      const n = index + 1;
      const id = 'SIG-' + String(n).padStart(3, '0');
      if (n === 2) {
        return { id, name: 'recognition throughput', scenario: 'SCN-001', native_unit: 'units/s',
          aggregation: 'median', value: 1000,
          ${completeBenchmark === 'derived' ? 'samples: [1000]' : 'samples: [1000, 1000, 1000], warmup_samples: [1000]'} };
      }
      return { id, name: id, scenario: 'SCN-001', native_unit: 'ms', aggregation: 'median', value: 100,
        samples: [100, 100, 100], warmup_samples: [100] };
    });
    const protective = ['SIG-005', 'SIG-008', 'SIG-012', 'SIG-013'].map((id) => ({ id, value: 100 }));
    return { benchmarkVersion: '0.2.0', unifiedScore: null, environment: context.environment,
      measures, protective, incomplete: [] };
  ` : `return { benchmarkVersion: '1.0.0', unifiedScore: null, environment: context.environment,
  measures: [{ id: 'SIG-001', name: 'Fixture timing', scenario: 'SCN-001', native_unit: 'ms',
    aggregation: 'exact', value: 1, samples: [1], warmup_samples: [1] }], protective: [], incomplete: [] };`;
  const bindings = declareBinding ? ['```clue-finding-bindings', JSON.stringify([{
    unitId: unit.logicalId, unitVersion: unit.versionHash, scenarioId: 'SCN-001', signalId: 'SIG-001',
  }]), '```', ''] : [];
  const benchmark = [
    completeBenchmark ? 'benchmark_id = clu-master' : 'benchmark_id = fixture-master',
    completeBenchmark ? 'benchmark_version = 0.2.0' : 'benchmark_version = 1.0.0',
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
    if (completeBenchmark) {
      masterBenchmark['benchmarkId'] = 'clu-master';
      masterBenchmark['benchmarkVersion'] = '0.2.0';
    }
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
  return { options, profilesRoot: fixture.profiles, target: fixture.target, benchmarkPath: fixture.masterBenchmark, unit };
}

function driveFromCommand(t: TestContext, repoRoot: string, assessFindings = false) {
  const output: string[] = [];
  const writer = t.mock.method(process.stdout, 'write', (line: string) => {
    output.push(line.trimEnd());
    return true;
  });
  let exitCode: number;
  try {
    exitCode = commandCycleDrive({ verifyRecovery: true, assessFindings }, repoRoot);
  } finally {
    writer.mock.restore();
  }
  const read = (key: 'cycleFindings' | 'eventAppends') => {
    const line = output.find((value) => value.startsWith(`{"${key}":`));
    return line === undefined ? null : (JSON.parse(line) as Record<string, unknown>)[key];
  };
  return { exitCode, output, findings: read('cycleFindings'), timing: read('eventAppends') };
}

function recaptureRecognizedSnapshot(runtime: Runtime, snapshotId: string) {
  const graph = runtime.requireGraph();
  const screened = graph.recognition(snapshotId);
  assert.ok(screened?.run_key && screened.artifact_hash);
  const refreshed = runRecognition(runtime, { force: true, navigatorPath: null, expectedSnapshotId: snapshotId });
  assert.equal(refreshed.snapshotId, snapshotId);
  assert.equal(refreshed.recorded.record.result_hash, screened.result_hash);
  assert.notEqual(refreshed.recorded.record.run_key, screened.run_key);
  assert.notEqual(refreshed.recorded.record.artifact_hash, screened.artifact_hash);
  assert.equal(graph.recognition(snapshotId)?.run_key, refreshed.recorded.record.run_key);
  return screened;
}

test('cycle drive assesses findings only on opt-in and reuses the screened cycle receipt', (t) => {
  const fixture = makeRuntimeFixture(t);
  const { repoRoot } = fixture.options;
  const screened = driveFromCommand(t, repoRoot);
  assert.equal(screened.exitCode, 0);
  assert.equal(screened.findings, null);
  assert.match(screened.output.join('\n'), /at SCREENED \(proof-authoritative\)/u);

  const first = driveFromCommand(t, repoRoot, true);
  assert.equal(first.exitCode, 0);
  assert.match(first.output.join('\n'), /Findings NO_CANDIDATE/u);
  const durable = withRuntime(fixture.options, (runtime) => readCurrentFindings(runtime));
  assert.ok(durable);
  assert.deepEqual(first.findings, { outcome: 'NO_CANDIDATE', code: null, eventId: durable.eventId,
    cycleId: durable.cycleId, reason: durable.reason });
  assert.equal((first.timing as { count: number }).count, 1);

  const repeated = driveFromCommand(t, repoRoot, true);
  assert.equal(repeated.exitCode, 0);
  assert.deepEqual(repeated.findings, first.findings);
  assert.equal((repeated.timing as { count: number }).count, 0);

  writeFileSync(join(fixture.target, 'src', 'value.ts'), 'export const finding_fixture = 5;\n');
  const stale = driveFromCommand(t, repoRoot, true);
  assert.equal(stale.exitCode, 1);
  assert.deepEqual(stale.findings, { outcome: 'BLOCKED', code: 'FINDINGS_INPUTS_CHANGED', eventId: null,
    cycleId: durable.cycleId, reason: 'The current source differs from the exact screened inputs.' });
  assert.equal((stale.timing as { count: number }).count, 0);
});

test('opt-in findings preserves the diagnostic checkpoint and reports missing proof authority', (t) => {
  const fixture = makeRuntimeFixture(t, false);
  const result = driveFromCommand(t, fixture.options.repoRoot, true);
  assert.equal(result.exitCode, 1);
  assert.match(result.output.join('\n'), /at SCREENED \(diagnostic\)/u);
  assert.deepEqual(result.findings, { outcome: 'BLOCKED', code: 'FINDINGS_PROOF_AUTHORITY_REQUIRED', eventId: null,
    cycleId: 'CYCLE-000001', reason: 'Findings planning requires a proof-authoritative SCREENED cycle.' });
  withRuntime(fixture.options, (runtime) => assert.equal(readCurrentFindings(runtime), null));
});

test('dashboard binds a real findings worker receipt to the current screened event', { timeout: 60_000 }, async (t) => {
  const { options, profilesRoot } = makeRuntimeFixture(t);
  const { repoRoot } = options;
  const entry = join(repoRoot, 'dist', 'src', 'cli', 'index.js');
  const workerUrl = new URL('../src/cli/commands/cycleCommands.js', import.meta.url).href;
  mkdirSync(dirname(entry), { recursive: true });
  // Use the actual command with its installation root supplied by this isolated fixture.
  writeFileSync(entry, `
const { parseArgs } = require('node:util');
const { values, positionals } = parseArgs({ options: {
  navigator: { type: 'boolean' }, 'expect-runtime': { type: 'string' },
  'verify-recovery': { type: 'boolean' }, 'assess-findings': { type: 'boolean' },
}, allowPositionals: true });
if (positionals.join(' ') !== 'cycle drive') throw new Error('Expected cycle drive');
import(${JSON.stringify(workerUrl)}).then(({ commandCycleDrive }) => {
  process.exitCode = commandCycleDrive({ navigator: values.navigator,
    expectRuntime: values['expect-runtime'], verifyRecovery: values['verify-recovery'],
    assessFindings: values['assess-findings'],
  }, process.cwd());
});
`);
  await withRuntimeAsync({ repoRoot, withLog: false, readOnly: true }, async (runtime) => {
    const dashboard = await startClueDashboard(runtime, { operator: 'selftest', port: 0, profilesRoot });
    try {
      const call = (path: string, method = 'GET') => fetch(new URL(path, dashboard.url), { method });
      type RunView = {
        state: string;
        cycleId: string;
        dispatchId: string;
        cycleStage: string;
        cycleGrade: string;
        findingsOutcome: string | null;
        findingsCode: string | null;
        findingsEventId: string;
        lastLine: string;
        eventAppends: { count: number };
      };
      const poll = async () => {
        const stopAt = Date.now() + 20_000;
        while (Date.now() < stopAt) {
          const view = await call('/api/run').then((response) => response.json()) as RunView;
          if (view.state !== 'running') return view;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        assert.fail('The dashboard worker did not finish.');
      };

      const screening = await call('/api/control/start', 'POST');
      assert.equal(screening.status, 202, await screening.text());
      const screened = await poll();
      assert.equal(screened.state, 'completed', screened.lastLine);
      assert.equal(screened.cycleStage, 'SCREENED');
      assert.equal(screened.cycleGrade, 'proof-authoritative');
      assert.equal(screened.findingsOutcome, null);
      assert.equal(await call('/api/findings/current').then((response) => response.json()), null);

      const start = await call('/api/control/start-with-findings', 'POST');
      assert.equal(start.status, 202);
      const dispatch = await start.json() as { disposition: string; cycleId: string; dispatchId: string };
      assert.equal(dispatch.disposition, 'started');
      assert.equal(dispatch.cycleId, screened.cycleId);
      const assessed = await poll();
      assert.equal(assessed.state, 'completed', assessed.lastLine);
      assert.equal(assessed.dispatchId, dispatch.dispatchId);
      assert.equal(assessed.cycleId, screened.cycleId);
      assert.equal(assessed.findingsOutcome, 'NO_CANDIDATE');
      assert.match(assessed.findingsEventId, /^EVENT-\d+$/u);
      assert.equal(assessed.findingsCode, null);
      assert.equal(assessed.eventAppends.count, 1);
      const receipt = await call('/api/findings/current').then((response) => response.json()) as
        ReturnType<typeof readCurrentFindings>;
      assert.ok(receipt);
      assert.equal(receipt.eventId, assessed.findingsEventId);
      assert.equal(receipt.cycleId, screened.cycleId);
      assert.equal(receipt.reason, assessed.lastLine);
    } finally {
      await dashboard.stop();
    }
  });
});

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

test('a damaged historical recognition artifact blocks findings even when the latest graph is intact', (t) => {
  const fixture = makeRuntimeFixture(t);
  withRuntime(fixture.options, (runtime) => {
    const { cycle } = new CycleOrchestrator(runtime).drive(null, { verifyRecovery: true });
    assert.equal(cycle.stage, 'SCREENED');
    const snapshotId = runtime.snapshots?.latest('canonical')?.id;
    assert.ok(snapshotId);
    const screened = recaptureRecognizedSnapshot(runtime, snapshotId);
    assert.ok(screened.artifact_hash);
    const artifactPath = runtime.artifacts.pathFor(requireSha256(screened.artifact_hash, 'screened recognition artifact'));
    chmodSync(artifactPath, 0o600);
    writeFileSync(artifactPath, '{}\n');
    assert.ok(runtime.requireGraph().resultOf(snapshotId)?.units.length);
    const head = runtime.requireLog().getHead();
    assert.throws(() => assessCurrentFindings(runtime), { code: 'FINDINGS_EVIDENCE_INVALID' });
    assert.deepEqual(runtime.requireLog().getHead(), head);
  });
});

test('declared benchmark coverage selects the screened unit after the benchmark re-recognizes the same snapshot', async (t) => {
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
    // Recognition scenarios record a fresh capture of the same source inside the benchmark.
    const screened = recaptureRecognizedSnapshot(runtime, prepared.subject.snapshot_id);
    const opening = recordBenchmarkRun(runtime, { ...prepared, outcome, contract });
    assert.equal((opening.event.payload as { proof_eligible: boolean }).proof_eligible, true);
    const receipt = assessCurrentFindings(runtime);
    assert.equal(receipt.outcome, 'SELECTED');
    assert.equal(receipt.selected?.unitId, fixture.unit.logicalId);
    assert.equal(receipt.selected?.signalId, 'SIG-001');
    assert.match(receipt.selected?.reason ?? '', new RegExp(opening.event.id));
    const evidence = runtime.artifacts.getJson(requireSha256(receipt.evidenceSha256, 'findings evidence')) as {
      recognitionSha256: string;
      recognitionEventId: string;
    };
    assert.equal(evidence.recognitionSha256, screened.result_hash);
    const recognitionEvent = [...runtime.requireLog().replay()].find(({ id }) => id === evidence.recognitionEventId);
    assert.equal(recognitionEvent?.type, 'cycle.stage_advanced');
    assert.equal(recognitionEvent.subject_id, receipt.cycleId);
    assert.deepEqual(readCurrentFindings(runtime), receipt);
  });
});

async function verifyTimingRegressionSurvivesClosure(t: TestContext, throughput: 'sampled' | 'derived') {
  const fixture = makeRuntimeFixture(t, true, false, throughput);
  const contract = { path: fixture.benchmarkPath, registered: true };
  const { cycle, lock, subject, openingHead } = withRuntime(fixture.options, (runtime) => {
    const { cycle, lock } = new CycleOrchestrator(runtime).drive();
    assert.equal(cycle.grade, 'proof-authoritative', JSON.stringify(lock?.absent));
    assert.ok(lock);
    return { cycle, lock, subject: prepareBenchmarkRunSubject(runtime, contract), openingHead: runtime.requireLog().getHead() };
  });
  const outcome = await runMasterBenchmark({ repoRoot: fixture.options.repoRoot, projectRoot: fixture.target,
    workspaceRoot: fixture.options.projectProfile.profile.state.eventLogRoot, contractPath: contract.path,
    execImpl: async () => assert.fail('The fixture harness must perform no external process work.'),
    executionBoundary: { kind: 'linux-bwrap', sha256: hashText('test boundary') } });
  assert.ok(outcome.ok, outcome.ok ? undefined : outcome.reason);
  const closingOutcome = { ...outcome, result: { ...outcome.result, measures: outcome.result.measures.map((measure) =>
    measure.id === 'SIG-009' ? { ...measure, value: 120, samples: [120, 120, 120] } : measure) } };
  const openingId = withRuntime(fixture.options, (runtime) => {
    const { event } = recordBenchmarkRun(runtime, { outcome, subject, contract, log_head_before: openingHead });
    const head = runtime.requireLog().getHead();
    const events = [...runtime.requireLog().replay()];
    const closing = { contract, subject, outcome: closingOutcome, log_head_before: head };
    const compare = (journal = events, run = closing) => compareClosingBenchmark(runtime.artifacts, journal, cycle, lock, run);
    const comparison = compare();
    assert.equal(comparison?.opening.opening_event_sha256, event.hash);
    assert.equal(comparison?.opening.unified_score, Math.exp(Math.log(100 / 120) / 6));
    assert.deepEqual(comparison?.opening.advisory_regressions, [{ id: 'SIG-009', opening_ms: 100, closing_ms: 120 }]);
    const throughputMeasure = outcome.result.measures.find(({ id }) => id === 'SIG-002');
    assert.equal(throughputMeasure?.samples.length, throughput === 'sampled' ? 3 : 1);
    assert.equal(throughputMeasure?.warmup_samples?.length, throughput === 'sampled' ? 1 : undefined);
    const withoutRequiredWarmup = { ...closingOutcome, result: { ...closingOutcome.result,
      measures: closingOutcome.result.measures.map((measure) => measure.id === 'SIG-002' ?
        { ...measure, samples: [1000, 1000, 1000], warmup_samples: [] } : measure),
    } };
    assert.equal(compare(events, { ...closing, outcome: withoutRequiredWarmup }), null,
      'Sampled throughput still requires the governed warm-up.');
    assert.equal(compare(events, { ...closing, log_head_before: openingHead }), null,
      'An opening recorded after the closing start is outside the comparison scope.');
    assert.equal(compare(events, { ...closing, outcome: { ...closingOutcome,
      execution_boundary: { kind: 'linux-bwrap', sha256: hashText('different test boundary') } } }), null);
    const duplicate = { ...event, sequence: event.sequence + 1, hash: hashText('duplicate opening') };
    assert.equal(compare([...events, duplicate], { ...closing,
      log_head_before: { sequence: duplicate.sequence, hash: duplicate.hash } }), null);
    const failed = compare(events, { ...closing, outcome: { ...closingOutcome, result: { ...closingOutcome.result,
      measures: closingOutcome.result.measures.map((measure) => measure.id === 'SIG-012' ? { ...measure, value: 99 } : measure),
      protective: closingOutcome.result.protective.map((measure) => measure.id === 'SIG-012' ? { ...measure, value: 99 } : measure),
    } } });
    assert.equal(failed?.gates.run_verdict, 'void');
    assert.deepEqual(failed?.opening.advisory_regressions, []);

    const put = runtime.artifacts.putJson.bind(runtime.artifacts);
    const interruption = t.mock.method(runtime.artifacts, 'putJson', (...args: Parameters<typeof put>) => {
      const [, options] = args;
      if (options?.label === `cycle-${cycle.id}-handoff.json`) throw new Error('interrupted before handoff');
      return put(...args);
    });
    try {
      assert.throws(() => new CycleOrchestrator(runtime).close(closing), /interrupted before handoff/);
      assert.equal(new CycleOrchestrator(runtime).status()?.stage, 'CLOSING_EVIDENCE');
    } finally {
      interruption.mock.restore();
    }
    return event.id;
  });

  withRuntime(fixture.options, (runtime) => {
    const closed = new CycleOrchestrator(runtime).close();
    assert.equal(closed.cycle.stage, 'CLOSED');
    assert.equal(closed.cycle.criteria_met, false);
    const ref = closed.performed.find(({ to }) => to === 'HANDOFF')?.evidence;
    assert.ok(ref);
    const handoff = nextCycleVitalInputSchema.parse(runtime.artifacts.getJson(requireSha256(ref.hash, 'handoff')));
    const closingRef = handoff.stage_evidence['CLOSING_EVIDENCE'];
    assert.ok(closingRef);
    const evidence = runtime.artifacts.getJson(requireSha256(closingRef, 'closing evidence')) as {
      master_benchmark_run: { opening_comparison: unknown };
    };
    const opening = recordedOpeningComparisonSchema.parse(evidence.master_benchmark_run.opening_comparison);
    assert.equal(opening.opening_event_id, openingId);
    assert.equal(handoff.candidate_seeds.seeds.length, 1);
    assert.match(handoff.candidate_seeds.seeds[0] ?? '', /Investigate SIG-009: 100.00 to 120.00 ms/);
    assert.match(handoff.candidate_seeds.source, new RegExp(openingId));
    assert.ok(!handoff.stated_absences.some(({ field }) => field === 'master_benchmark.opening_run'));
  });
}

test('a verified regression with sampled throughput survives closure recovery as a §19 seed',
  (t) => verifyTimingRegressionSurvivesClosure(t, 'sampled'));

test('a verified regression with legacy derived throughput survives closure recovery as a §19 seed',
  (t) => verifyTimingRegressionSurvivesClosure(t, 'derived'));

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
