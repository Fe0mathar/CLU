/**
 * Console state collector acceptance tests.
 *
 * Spec: the CLU deep review, Integrity Patch 0, P0.3 — recognition run identity is
 *       *read, never minted* — and the constitutional status-precision principle:
 *       visible identity must be attested identity, and a missing fact is declared,
 *       not papered over with a neighbouring value that happens to be non-null.
 *
 * The collector is pure over its reader seam, so these tests drive it with literal
 * {@link RegistrySource} fixtures — no database, no clock, no filesystem — and pin the
 * three identity regimes plus replay determinism. The regression assertion in the
 * second test is the exact fabrication that shipped once: a result hash dressed up as
 * a run identity, and a snapshot id copied into a field presenting itself as a second,
 * independent record identity the durable schema does not contain.
 *
 * Run: npm run selftest
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectStatus } from '../src/status/statusProjector.js';
import { emptyFourNeonGauges } from '../src/ui/fourNeonGauges.js';

import {
  collectProjectorInput,
  type CollectOptions,
  type RegistrySource,
} from '../src/daemon/consoleStateCollector.js';

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const RESULT_HASH = 'a'.repeat(64);
const SNAPSHOT_ID = 's'.repeat(64);

/** A registry source with a committed graph and no recorded run id. Overridden per test. */
function baseSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    currentMission: () => ({
      missionId: 'mission_000001',
      title: 'Improve Murugan',
      constitutionHash: 'c'.repeat(64),
      lastChange: 'unchanged',
    }),
    latestSnapshot: () => ({
      snapshotId: SNAPSHOT_ID,
      fileCount: 5,
      capturedAt: '2026-07-27T00:00:00.000Z',
      languageCensus: { typescript: 5 },
    }),
    recognitionFor: () => ({
      snapshotId: SNAPSHOT_ID,
      resultHash: RESULT_HASH,
      unitCount: 10,
      edgeCount: 20,
      unresolvedCount: 0,
      filesInProgram: 5,
      filesRecognised: 5,
      semanticDiagnostics: 0,
      moduleCount: 0,
      classDistribution: {
        'monofile-monodependency': 0,
        'monofile-polydependency': 0,
        'polyfile-monodependency': 0,
        'polyfile-polydependency': 0,
      },
    }),
    runIdForSnapshot: () => null,
    configReadiness: () => ({
      status: 'ready',
      sections: [{ section: 'project_repository', ready: true }],
    }),
    stateSources: () => ['eventlog@128', 'db@v3'],
    ...overrides,
  };
}

function options(source?: RegistrySource): CollectOptions {
  const capturedAt = '2026-07-27T00:00:01.000Z';
  // ADR-0002 step 4: the collector carries the sealed Status body through to the projector.
  // It is projected from the same reader, so these fixtures stay one durable reading rather
  // than becoming two.
  const status = projectStatus(source ?? baseSource(), {
    capturedAt,
    targetId: 'TGT',
    targetName: null,
    canonicalRoot: '/repo',
    missionBasisHash: null,
    recognizerVersion: null,
    catalogue: null,
    q1: null,
    provenance: {
      eventLogFrom: null,
      eventLogTo: null,
      projectionVersion: null,
      goldenDefinitionHash: null,
    },
  }).snapshot;
  return { capturedAt, operator: 'selftest', activeTab: 'dashboard', status };
}

test('the collector uses the gauge facts already sealed by Status', () => {
  let reads = 0;
  const source = baseSource({
    gaugesProjection(capturedAt) {
      reads += 1;
      return emptyFourNeonGauges(capturedAt);
    },
  });
  const captured = options(source);
  const input = collectProjectorInput(source, captured);
  assert.deepEqual(input.gauges, captured.status.gauges);
  assert.equal(reads, 1);
});

/* ------------------------------------------------------------------------- */
/* Identity regimes                                                           */
/* ------------------------------------------------------------------------- */

test('a recorded run identity travels as read, never re-minted', () => {
  const input = collectProjectorInput(
    baseSource({ runIdForSnapshot: () => 'run-7f3a' }),
    options(),
  );

  assert.ok(input.run !== null, 'a committed record yields a run block');
  assert.equal(input.run.runId, 'run-7f3a', 'the pointer run id is carried untouched');
  assert.equal(input.run.snapshotId, SNAPSHOT_ID);
  assert.ok(input.run.committed !== null);
  assert.equal(
    input.run.committed.graphSha256,
    RESULT_HASH,
    'graphSha256 is the durable result_hash — the sha256 of the stored recognition artifact',
  );
  assert.equal(
    input.run.committed.recognitionRecordId,
    null,
    'no distinct record identity exists in the durable schema; its absence is declared',
  );
});

test('a missing run identity is declared null, never substituted', () => {
  // The pointer has nothing for this snapshot — a pre-pointer stream, or a replaced
  // pointer. The run happened; its identity was not durably recorded. The only honest
  // value is null.
  const input = collectProjectorInput(baseSource(), options());

  assert.ok(input.run !== null, 'the committed graph is still shown');
  assert.equal(input.run.runId, null, 'absence travels as null');

  // The exact shipped fabrications, pinned so they cannot silently return:
  assert.notEqual(
    input.run.runId,
    RESULT_HASH,
    'a result hash must never be dressed up as a run identity',
  );
  assert.notEqual(
    input.run.committed?.recognitionRecordId,
    SNAPSHOT_ID,
    'a snapshot id must never be copied into a second identity field',
  );

  assert.equal(input.run.committed?.graphSha256, RESULT_HASH, 'real identity is still carried');
});

test('an uncommitted graph yields honest emptiness, not a decorated run', () => {
  const input = collectProjectorInput(baseSource({ recognitionFor: () => null }), options());

  assert.equal(input.run, null, 'no committed record, no run block');
  assert.equal(input.recognition, null, 'no committed record, no recognition block');
  assert.ok(input.snapshot !== null, 'the snapshot itself is still a fact and is shown');
});

test('facts are read only under their preconditions', () => {
  // With no snapshot there is nothing to look a recognition record up for. A fixture
  // that throws proves the collector never reaches for facts whose precondition failed —
  // the honest-emptiness path is structural, not accidental.
  const input = collectProjectorInput(
    baseSource({
      latestSnapshot: () => null,
      currentMission: () => null,
      recognitionFor: () => {
        throw new Error('recognitionFor must not be called without a snapshot');
      },
      runIdForSnapshot: () => {
        throw new Error('runIdForSnapshot must not be called without a committed record');
      },
    }),
    options(),
  );

  assert.equal(input.snapshot, null);
  assert.equal(input.run, null);
  assert.equal(input.recognition, null);
  assert.equal(
    input.mission.missionId,
    'unregistered',
    'the unregistered mission is a real, honest value — not a placeholder pretending',
  );
});

/* ------------------------------------------------------------------------- */
/* Replay determinism                                                         */
/* ------------------------------------------------------------------------- */

test('collection is replay-deterministic for identical facts', () => {
  // The capture timestamp is supplied by the caller precisely so that identical durable
  // facts produce byte-identical projector input on replay (cross-cutting rule: diff
  // sealed state before and after restart, not around it).
  const first = collectProjectorInput(baseSource({ runIdForSnapshot: () => 'run-7f3a' }), options());
  const second = collectProjectorInput(baseSource({ runIdForSnapshot: () => 'run-7f3a' }), options());

  assert.deepEqual(second, first);
});
