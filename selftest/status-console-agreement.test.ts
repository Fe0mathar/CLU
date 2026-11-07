/**
 * Status ↔ ConsoleSnapshot agreement.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §20 gate 4 — the UI, CLI and API return the same
 *       body/hash; §1 — one validated snapshot, none of the surfaces assembling an
 *       independent interpretation.
 *       `CLUE_Project_Directory_v9.md` §19.3 — backend UI modules transform *sealed Status*;
 *       §4.2 — a mirror cannot silently become a second wire authority.
 *
 * Decision: `docs/architecture-decisions/ADR-0002-status-is-the-sealed-authority.md`, step 2
 *       of its migration plan:
 *
 *       > A test asserts the two bodies agree over the same durable head, for every branch
 *       > that exists on both sides. Any disagreement found here is a real defect in one of
 *       > them, and is the cheapest moment to find it.
 *
 * ## Why this test exists before the migration rather than after
 *
 * There are currently two projections of one durable state: `statusProjector.ts` produces a
 * `StatusSnapshot`, and `consoleProjector.ts` produces a `ConsoleSnapshot`, each with its own
 * seal. ADR-0002 records the decision to make the second a projection of the first. That is a
 * migration across a 1540-line contract with four quadrants downstream, and the temptation is
 * to start moving code.
 *
 * The cheaper move is to first establish that the two currently *agree*. If they do, the
 * migration is mechanical and this test protects it at every step. If they do not, the
 * disagreement is a live defect — two surfaces telling an operator different things about the
 * same workspace — and it is worth more than the migration, because it is the thing the
 * migration was supposed to prevent and is apparently already happening.
 *
 * Both projections are driven from **one** `RegistrySource` here. That is deliberate and it
 * bounds what the test can prove: it proves the two *projectors* agree given identical facts.
 * It does not prove they would read identical facts from a live workspace, because each
 * currently reads independently and at its own instant. Closing that second gap is what the
 * inversion is for; stating the limit is what keeps this test from being mistaken for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectStatus, type ProjectStatusOptions } from '../src/status/statusProjector.js';
import { isBranchUnavailable } from '../src/status/statusContractV5.js';
import { collectProjectorInput, type RegistrySource } from '../src/daemon/consoleStateCollector.js';
import { projectConsoleSnapshot } from '../src/ui/consoleProjector.js';
import type { ConsoleSnapshot } from '../src/ui/viewModel.js';
import { emptyGreatBookImprovementField } from '../src/ui/greatBookImprovementField.js';
import { emptyFourNeonGauges } from '../src/ui/fourNeonGauges.js';

const AT = '2026-08-06T00:00:00.000Z';
const SNAPSHOT_ID = 'b'.repeat(64);
const RESULT_HASH = 'c'.repeat(64);
const CONSTITUTION = 'd'.repeat(64);

/** One reader, both projections. Any divergence is therefore in a projector, not in a read. */
function source(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    currentMission: () => ({
      missionId: 'MISSION-000001',
      title: 'CLU-E',
      constitutionHash: CONSTITUTION,
      lastChange: 'initial',
    }),
    latestSnapshot: () => ({
      snapshotId: SNAPSHOT_ID,
      fileCount: 42,
      capturedAt: AT,
      languageCensus: { typescript: 40, markdown: 2 },
    }),
    recognitionFor: () => ({
      snapshotId: SNAPSHOT_ID,
      resultHash: RESULT_HASH,
      unitCount: 310,
      edgeCount: 890,
      unresolvedCount: 4,
      filesInProgram: 42,
      filesRecognised: 42,
      semanticDiagnostics: 0,
      moduleCount: 40,
      classDistribution: {
        'monofile-monodependency': 20,
        'monofile-polydependency': 10,
        'polyfile-monodependency': 7,
        'polyfile-polydependency': 3,
      },
    }),
    runIdForSnapshot: () => 'RUN-0001',
    configReadiness: () => ({ status: 'ready', sections: [] }) as never,
    stateSources: () => ['events:0-42', 'db:7'],
    improvementFieldProjection: (capturedAt: string) => emptyGreatBookImprovementField(capturedAt),
    gaugesProjection: (capturedAt: string) => emptyFourNeonGauges(capturedAt),
    ...overrides,
  } as RegistrySource;
}

function statusOf(src: RegistrySource) {
  const options: ProjectStatusOptions = {
    capturedAt: AT,
    targetId: 'TGT-CLUE',
    targetName: 'CLU-E',
    canonicalRoot: '/repo',
    missionBasisHash: 'e'.repeat(64),
    recognizerVersion: 'clue-recognizer/4',
    catalogue: null,
    q1: null,
    provenance: {
      eventLogFrom: 0,
      eventLogTo: 42,
      projectionVersion: 'clue.projections/7',
      goldenDefinitionHash: null,
    },
  };
  return projectStatus(src, options).snapshot;
}

function consoleOf(src: RegistrySource, status = statusOf(src)): ConsoleSnapshot {
  // ADR-0002 step 4: Status is projected first and the console downstream of it. The default
  // argument keeps every existing assertion reading the same, while making the ordering
  // explicit for the tests that deliberately supply a different Status body.
  return projectConsoleSnapshot(
    collectProjectorInput(src, {
      capturedAt: AT,
      operator: 'creator',
      activeTab: 'dashboard',
      status,
    }),
  );
}

test('ADR-0002 step 2: both projections name the same mission', () => {
  const src = source();
  const status = statusOf(src);
  const console = consoleOf(src);

  assert.equal(isBranchUnavailable(status.target), false, 'status backs the target branch');
  const target = status.target as { missionVersionId: string | null; constitutionHash: string | null };

  assert.equal(
    target.missionVersionId,
    console.shell.identity.missionId,
    'a disagreement here means two surfaces attribute the same workspace to different missions',
  );
  assert.equal(target.constitutionHash, console.shell.identity.constitutionHash);
});

test('ADR-0002 step 2: both projections report the same recognition topology', () => {
  const src = source();
  const status = statusOf(src);
  const console = consoleOf(src);

  assert.equal(isBranchUnavailable(status.recognition), false);
  const recognition = status.recognition as {
    filesRecognised: number;
    unitCount: number;
    unresolvedCount: number;
    moduleCount: number;
    snapshotId: string;
    resultHash: string;
  };
  const topology = console.dashboard.recognition.topology;

  // Exact equality throughout. The mapping was verified against both projectors' real
  // output rather than assumed: every field below is the same durable fact under two
  // spellings, and an inequality would be a live disagreement between two operator surfaces.
  assert.equal(
    recognition.filesRecognised,
    topology.filesRecognized,
    'the two spellings of the same fact must carry the same number',
  );
  assert.equal(recognition.unitCount, topology.functions, 'the console counts every unit here');
  assert.equal(recognition.unresolvedCount, topology.hiddenEdges);
  assert.equal(recognition.moduleCount, topology.modules);

  // The console's seal names the graph the body reflects; Status names it in its own branch.
  // These are the two independent identity claims, and they must be one identity.
  assert.equal(console.seal.graph?.snapshotId, recognition.snapshotId);
  assert.equal(console.seal.graph?.runId, 'RUN-0001');
});

test('ADR-0002 step 2: the inventory file count is one number in both bodies', () => {
  const src = source();
  const status = statusOf(src);
  const console = consoleOf(src);

  const inventory = status.repositoryInventory as { fileCount: number; snapshotId: string };
  assert.equal(inventory.fileCount, 42);
  assert.equal(console.seal.graph?.snapshotId, inventory.snapshotId);

  // NOT `filesRecognized === fileCount`. An earlier draft asserted that and passed, because
  // this fixture happens to recognise every file it inventories. Under a partial scan the two
  // are different facts — how many files exist versus how many the recognizer reached — and a
  // test that conflates them would go green while the surfaces disagreed. The partial case is
  // proved separately below.
});

test('ADR-0002 step 2: the quadrant projections are the same objects, not two derivations', () => {
  // Q2 and Q3 are the cleanest case in the whole comparison: both bodies carry the view the
  // registry produced, rather than each deriving its own. That is what the inversion should
  // look like everywhere once it lands.
  const src = source();
  const status = statusOf(src);
  const console = consoleOf(src);

  assert.deepEqual(status.improvementField, console.dashboard.improvementField);
  assert.deepEqual(status.gauges, console.dashboard.gauges);
});

test('ADR-0002 step 2: an uncommitted graph is uncommitted in both', () => {
  // Agreement has to hold in the honest-empty case too, and this is where two independent
  // projectors most easily diverge: one renders an idle field, the other an unavailable
  // branch, and only one of them says why.
  const src = source({ recognitionFor: () => null });
  const status = statusOf(src);
  const console = consoleOf(src);

  assert.equal(isBranchUnavailable(status.recognition), true, 'status states the absence');
  assert.equal(
    console.dashboard.recognition.topology.filesRecognized,
    0,
    'and the console renders no recognised files rather than a fabricated topology',
  );
  assert.equal(console.seal.graph, null, 'neither claims a graph identity that does not exist');
});

test('ADR-0002 step 5: one integrity verdict, and the console names the Status it reflects', () => {
  const src = source();
  const status = statusOf(src);
  const console = consoleOf(src, status);

  // This test previously asserted the *opposite* — that two seals existed — as the
  // migration's starting line. Step 5 moved that line, so it is rewritten to the new state
  // rather than deleted: the assertion that marked the defect now marks its closure.

  // The console reports Status's verdict and cannot form its own. Asserting equality against
  // a *consistent* Status proves nothing — a console hardcoding `true` would pass — so the
  // load-bearing case is an inconsistent one, where the two answers differ.
  assert.equal(console.seal.consistent, status.seal.consistent);

  const inconsistent = {
    ...status,
    seal: { ...status.seal, consistent: false, inconsistencies: ['snapshot-identity: mismatch'] },
  } as typeof status;
  assert.equal(
    consoleOf(src, inconsistent).seal.consistent,
    false,
    'an inconsistent Status makes the console inconsistent; it has no verdict of its own',
  );
  assert.equal(
    console.seal.statusHash as string,
    status.seal.statusHash as string,
    'the presentation names the exact sealed body it was built from',
  );

  // `snapshotHash` remains a digest of the presentation body — not an integrity claim, and
  // deliberately not the Status hash. Repointing it would have stopped the dashboard
  // republishing when readiness or the active tab changed without Status moving.
  assert.notEqual(
    console.seal.snapshotHash as string,
    status.seal.statusHash as string,
    'change detection and integrity are different values with different jobs',
  );
  const otherTab = projectConsoleSnapshot(
    collectProjectorInput(src, {
      capturedAt: AT,
      operator: 'creator',
      activeTab: 'configuration',
      status,
    }),
  );
  assert.notEqual(
    otherTab.seal.snapshotHash as string,
    console.seal.snapshotHash as string,
    'a visible change with no Status change still advances the revision',
  );
  assert.equal(
    otherTab.seal.statusHash as string,
    console.seal.statusHash as string,
    'and both are provably presentations of one Status',
  );

  // Status claims gate 3 (one integrity verdict) and gate 4 (one composition behind every
  // surface). Gate 7 is still out of reach and the snapshot says so about itself.
  assert.ok(status.capability.satisfiedGates.includes(3));
  assert.ok(status.capability.satisfiedGates.includes(4));
  assert.ok(status.capability.unreachableGates.some((entry) => entry.gate === 7));
});


test('ADR-0002 step 2: neither projection reads a clock, so the pair is reproducible', () => {
  // The precondition for every assertion above. If either projector read the wall clock, two
  // runs of this file could agree by luck and disagree in CI, and the agreement it reports
  // would mean nothing.
  const first = { status: statusOf(source()), console: consoleOf(source()) };
  const second = { status: statusOf(source()), console: consoleOf(source()) };

  assert.deepEqual(first.status, second.status);
  assert.deepEqual(first.console, second.console);
});

test('ADR-0002 step 2: a partial scan is partial in both, and neither conflates the two counts', () => {
  // The case where a disagreement would hide. When every inventoried file is recognised,
  // `fileCount` and `filesRecognized` are the same number and a test comparing them passes
  // for the wrong reason. Here they differ, so the two surfaces have to track them
  // separately or they will tell an operator different things about the same scan.
  const src = source({
    latestSnapshot: () => ({
      snapshotId: SNAPSHOT_ID,
      fileCount: 100,
      capturedAt: AT,
      languageCensus: { typescript: 100 },
    }),
    recognitionFor: () => ({
      snapshotId: SNAPSHOT_ID,
      resultHash: RESULT_HASH,
      unitCount: 310,
      edgeCount: 890,
      unresolvedCount: 4,
      filesInProgram: 100,
      filesRecognised: 60,
      semanticDiagnostics: 0,
      moduleCount: 40,
      classDistribution: {
        'monofile-monodependency': 20,
        'monofile-polydependency': 10,
        'polyfile-monodependency': 7,
        'polyfile-polydependency': 3,
      },
    }),
  });
  const status = statusOf(src);
  const console = consoleOf(src);

  const inventory = status.repositoryInventory as { fileCount: number };
  const recognition = status.recognition as { filesRecognised: number; complete: boolean };

  assert.equal(inventory.fileCount, 100, 'the inventory counts what exists');
  assert.equal(recognition.filesRecognised, 60, 'recognition counts what it reached');
  assert.notEqual(inventory.fileCount, recognition.filesRecognised, 'and they are different facts');

  // §18: a partial scan cannot claim committed-complete.
  assert.equal(recognition.complete, false);

  // The console reports the recognised count, not the inventory count — the same fact under
  // its own name, and not the other one.
  assert.equal(console.dashboard.recognition.topology.filesRecognized, 60);
});

/* ------------------------------------------------------------------------- */
/* ADR-0002 step 3 — the console sources its topology from sealed Status       */
/* ------------------------------------------------------------------------- */

test('ADR-0002 step 3: supplying Status changes nothing, which is what makes the move safe', () => {
  // The migration invariant. Step 3 replaces a derivation with a read; if that changed any
  // rendered value, the two paths were never equivalent and the agreement test of step 2 was
  // measuring the wrong thing. Byte equality here is the licence to keep going.
  const src = source();
  const status = statusOf(src);

  const without = consoleOf(src);
  const with_ = projectConsoleSnapshot({
    ...collectProjectorInput(src, { capturedAt: AT, operator: 'creator', activeTab: 'dashboard', status }),
  });

  assert.deepEqual(with_.dashboard.recognition, without.dashboard.recognition);
  assert.deepEqual(with_, without, 'the whole snapshot is unchanged, including its seal');
});

test('ADR-0002 step 3: the topology is genuinely read from Status, not recomputed beside it', () => {
  // The control for the test above: if the console ignored `status` entirely, the equality
  // would also hold and prove nothing. A Status body stating a different topology must move
  // the rendered value — that is what "sourced from" means.
  const src = source();
  const status = statusOf(src);
  const rewritten = {
    ...status,
    recognition: { ...(status.recognition as object), moduleCount: 999, unitCount: 777 },
  } as typeof status;

  const projected = projectConsoleSnapshot({
    ...collectProjectorInput(src, {
      capturedAt: AT,
      operator: 'creator',
      activeTab: 'dashboard',
      status: rewritten,
    }),
  });

  assert.equal(projected.dashboard.recognition.topology.modules, 999);
  assert.equal(projected.dashboard.recognition.topology.functions, 777);
});

test('ADR-0002 step 4: an unavailable Status branch renders the uncommitted field, and the console cannot say why', () => {
  // Step 3 kept a parallel derivation as a fallback, and this test asserted it. Step 4
  // removed it — a second code path deriving one fact is exactly the defect the inversion
  // exists to close — so the premise is gone and the test is rewritten rather than deleted.
  //
  // The new behaviour, and its cost, stated plainly: when Status cannot state the topology,
  // the console renders the same uncommitted field it renders before any graph is built.
  // `RecognitionTopology` has no unavailable state, so "the graph could not be read" and
  // "no graph yet" are indistinguishable in this quadrant. Status distinguishes them; the
  // console contract cannot, and giving it that state is a change to the console's own model
  // that belongs with the successor ADR §19.3 already needs.
  const src = source();
  const blinded = {
    ...statusOf(src),
    recognition: {
      state: 'unavailable' as const,
      reason: 'the graph registry could not be read',
      expectedSource: 'GraphRegistry',
      lastKnownAt: null,
    },
  } as unknown as ReturnType<typeof statusOf>;

  const projected = consoleOf(src, blinded);
  assert.equal(projected.dashboard.recognition.topology.functions, 0);
  assert.equal(projected.dashboard.recognition.topology.modules, 0);

  // The information is not lost from the system — only from this quadrant. Status still
  // says which of the two it is, and says why.
  assert.equal(isBranchUnavailable(blinded.recognition), true);
  assert.equal(
    (blinded.recognition as { reason: string }).reason,
    'the graph registry could not be read',
  );

  // And it is genuinely distinct from the never-built case at the Status layer, even though
  // the two render identically here.
  const never = statusOf(source({ recognitionFor: () => null }));
  assert.notEqual(
    (never.recognition as { reason: string }).reason,
    (blinded.recognition as { reason: string }).reason,
  );
});

