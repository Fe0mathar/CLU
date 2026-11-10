import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireCompleteOpeningOutcome, requireReviewedAuthority, requireReviewedQualification } from './live-opening-baseline.mjs';
import { AUTHORITY_EVENT_TYPES, verifyInstalledPackAgainstSeal } from '../../dist/src/control/mission.js';
import { hashBytes, hashCanonicalJson } from '../../dist/src/shared/ids.js';

const missionId = 'MISSION-000007';
const constitutionPath = 'CLUE_Constitution_v9.md';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function sampleAuthority(sequence) {
  const installedPack = verifyInstalledPackAgainstSeal(repoRoot, 'test the live opening baseline');
  const { pack, sealSha, declared } = installedPack;
  const id = (position) => 'EVENT-' + String(position).padStart(6, '0');
  const ratification = {
    type: AUTHORITY_EVENT_TYPES.packRatified, id: id(sequence), sequence,
    mission_version: missionId, subject_id: missionId, actor: 'creator', hash: 'a'.repeat(64),
    payload: {
      pack_release: pack.releaseName, release_version: pack.releaseVersion,
      seal_path: pack.sealFile, seal_sha256: sealSha,
      manifest_path: pack.manifestFile, manifest_sha256: declared.get(pack.manifestFile),
      constitution_path: constitutionPath, constitution_sha256: declared.get(constitutionPath),
      declared_file_count: declared.size, ratified_by: 'creator', statement: 'RATIFY ' + sealSha.slice(0, 12),
      ratified_at: '2026-11-10T20:30:00.000Z',
    },
  };
  const epoch = {
    type: AUTHORITY_EVENT_TYPES.epochSealed, id: id(sequence + 2), sequence: sequence + 2,
    mission_version: missionId, subject_id: missionId, actor: 'creator', hash: 'b'.repeat(64),
    previous_hash: 'c'.repeat(64),
    payload: {
      epoch_name: 'P2-authoritative-' + missionId, legacy_head_sequence: sequence + 1,
      legacy_head_hash: 'c'.repeat(64), blob_manifest_sha256: 'd'.repeat(64), blob_count: 89,
      ratification_event_id: ratification.id, ratified_seal_sha256: sealSha,
      sealed_by: 'creator', statement: 'SEAL ' + 'c'.repeat(12), sealed_at: '2026-11-10T20:31:00.000Z',
    },
  };
  return { ratification, epoch, installedPack };
}

test('review authority binds exact durable evidence without requiring predetermined event IDs', () => {
  const digests = [11800, 13927].map((sequence) => {
    const { ratification, epoch, installedPack } = sampleAuthority(sequence);
    const { reviewEvidence } = requireReviewedAuthority(ratification, epoch, installedPack, constitutionPath);
    assert.deepEqual(reviewEvidence, {
      ratificationEventId: ratification.id, ratificationEventSha256: ratification.hash,
      epochEventId: epoch.id, epochEventSha256: epoch.hash,
      epochBoundarySequence: epoch.sequence - 1, epochBoundarySha256: epoch.previous_hash,
      epochBlobManifestSha256: epoch.payload.blob_manifest_sha256,
    });
    return hashCanonicalJson(reviewEvidence);
  });
  assert.notEqual(...digests);
});

test('review authority refuses mission 6 records or a ratification newer than the epoch', () => {
  const { ratification, epoch, installedPack } = sampleAuthority(11800);
  const oldMission = { mission_version: 'MISSION-000006', subject_id: 'MISSION-000006' };
  const oldRatification = { ...ratification, ...oldMission };
  const oldEpoch = { ...epoch, ...oldMission };
  assert.throws(() => requireReviewedAuthority(oldRatification, oldEpoch, installedPack, constitutionPath), /MISSION-000007/);
  assert.throws(() => requireReviewedAuthority(ratification, oldEpoch, installedPack, constitutionPath), /MISSION-000007/);
  assert.throws(() => requireReviewedAuthority({ ...ratification, sequence: epoch.sequence + 1 }, epoch, installedPack, constitutionPath),
    /MISSION-000007/);
});

test('review authority requires the exact pack and an epoch linked to the ratification and event boundary', () => {
  const { ratification, epoch, installedPack } = sampleAuthority(11800);
  const otherSha = 'e'.repeat(64);
  for (const changes of [
    { epoch_name: 'P2-authoritative-MISSION-000006' },
    { ratification_event_id: 'EVENT-011722' },
    { ratified_seal_sha256: otherSha },
    { legacy_head_sequence: epoch.sequence - 2 },
    { legacy_head_hash: otherSha },
  ]) {
    const changed = { ...epoch, payload: { ...epoch.payload, ...changes } };
    assert.throws(() => requireReviewedAuthority(ratification, changed, installedPack, constitutionPath), /verified event boundary/);
  }
  const changed = { ...ratification, payload: { ...ratification.payload, manifest_sha256: otherSha } };
  assert.throws(() => requireReviewedAuthority(changed, epoch, installedPack, constitutionPath), /installed v9 pack/);
});

function sample() {
  const reviewed = {
    missionId, snapshotId: 'snapshot', inputsId: 'inputs',
    configSha256: 'config', executableInputs: { engine_dist_id: 'dist' }, benchmarkSha256: 'contract',
  };
  const boundary = { kind: 'windows-supervisor', sha256: 'supervisor', qualificationSha256: 'receipt' };
  const performed = {
    subject: {
      mission_version: reviewed.missionId, snapshot_id: reviewed.snapshotId, inputs: { id: reviewed.inputsId },
      config_sha256: reviewed.configSha256, executable_inputs: reviewed.executableInputs,
    },
    outcome: {
      ok: true,
      contract: { benchmark_id: 'clu-master', benchmark_version: '0.2.0', sha256: 'contract', runner_adapter: 'cli-node' },
      execution_boundary: { ...boundary },
      result: {
        environment: { platform: 'win32' },
        incomplete: [],
        measures: Array.from({ length: 13 }, (_, index) =>
          ({ id: 'SIG-' + String(index + 1).padStart(3, '0'), warmup_samples: [1] })),
      },
      budget: { exhausted: false },
      policy: { warmupRuns: 1, repetitions: 3 },
    },
  };
  return { reviewed, boundary, performed };
}

test('the live baseline requires all thirteen signals and the reviewed Windows basis', () => {
  const { reviewed, boundary, performed } = sample();
  assert.doesNotThrow(() => requireCompleteOpeningOutcome(performed, boundary, reviewed));
  performed.outcome.result.measures[12].id = 'SIG-012';
  assert.throws(() => requireCompleteOpeningOutcome(performed, boundary, reviewed), /13 required measurements/);
});

test('incomplete, one-pass or exhausted runs cannot become the opening baseline', () => {
  for (const alter of [
    (run) => { run.outcome.result.incomplete = [{ id: 'SIG-013', reason: 'fixture refusal' }]; },
    (run) => { run.outcome.policy.repetitions = 1; },
    (run) => { run.outcome.budget.exhausted = true; },
  ]) {
    const { reviewed, boundary, performed } = sample();
    alter(performed);
    assert.throws(() => requireCompleteOpeningOutcome(performed, boundary, reviewed), /13 required measurements/);
  }
});

test('changes to reviewed execution pins or the screened snapshot refuse the opening baseline', () => {
  const { reviewed, boundary, performed } = sample();
  performed.outcome.execution_boundary.qualificationSha256 = 'other';
  assert.throws(() => requireCompleteOpeningOutcome(performed, boundary, reviewed), /Windows execution boundary/);
  performed.outcome.execution_boundary = boundary;
  performed.subject.snapshot_id = 'other';
  assert.throws(() => requireCompleteOpeningOutcome(performed, boundary, reviewed), /different opening basis/);
});

test('a pinned qualification must authorize the exact baseline review', () => {
  const bytes = Buffer.from(JSON.stringify({
    operatorReview: { operation: 'live-opening-baseline', commit: 'commit', reviewDigest: 'digest' },
  }));
  const boundary = { kind: 'windows-supervisor', qualificationSha256: hashBytes(bytes) };
  assert.doesNotThrow(() => requireReviewedQualification(bytes, boundary, 'commit', 'digest'));
  assert.throws(() => requireReviewedQualification(bytes, boundary, 'other-commit', 'digest'), /does not authorize/);
  assert.throws(() => requireReviewedQualification(Buffer.concat([bytes, Buffer.from('\n')]), boundary, 'commit', 'digest'), /exact Windows/);
});
