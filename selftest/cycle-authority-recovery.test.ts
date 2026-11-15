import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { PACK_MANIFEST_FILE, PACK_SEAL_FILE } from '../src/control/mission.js';
import { withRuntime, type Runtime } from '../src/control/runtime.js';
import { findRecordedCycleAuthorityRecovery, inspectCycleAuthorityRecovery } from '../src/cycle/cycleAuthorityRecovery.js';
import { CYCLE_EVENT_TYPES, CYCLE_PROJECTION, CycleRegistry, cycleAuthorityRecoveryConfirmation } from '../src/cycle/cycleRegistry.js';
import { createDashboardCycleProgress } from '../src/daemon/dashboardCycleProgress.js';
import { ProjectionStore } from '../src/memory/db.js';
import { PROOF_EVENT_TYPES } from '../src/proof/proofContract.js';
import { hashBytes, hashText } from '../src/shared/ids.js';
import { writeProfileRuntimeInstallation } from './project-recognition-fixture.js';

function installation(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-cycle-authority-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  writeProfileRuntimeInstallation(root);
  const manifest = '{"permanentFiles":[]}\n';
  writeFileSync(join(root, PACK_MANIFEST_FILE), manifest);
  writeFileSync(join(root, PACK_SEAL_FILE),
    `${hashBytes(readFileSync(join(root, 'CLUE.md')))}  CLUE.md\n${hashText(manifest)}  ${PACK_MANIFEST_FILE}\n`);
  writeFileSync(join(root, 'package.json'), '{"files":["src"]}\n');
  return root;
}

function registry(runtime: Runtime): CycleRegistry {
  return new CycleRegistry({
    log: runtime.requireLog(), projections: runtime.projections, missionVersion: runtime.currentMissionId,
  });
}

function screened(runtime: Runtime, lockedRatification: string | null, lockedEpoch: string | null) {
  const cycles = registry(runtime);
  const cycle = cycles.open();
  const lockDigest = hashText('legacy lock');
  const absent = lockedRatification === null || lockedEpoch === null ? ['authority'] : [];
  cycles.lockInputs(cycle.id, {
    digest: lockDigest,
    grade: absent.length === 0 ? 'proof-authoritative' : 'diagnostic',
    computed_at: '2026-11-15T00:00:00.000Z',
    target_description: null,
    master_benchmark: null,
    tracked_documents: [{ path: 'CLUE.md', sha256: hashText('constitution') }],
    catalogue_version: 'v6',
    policy_files: [],
    environment_fingerprint: { node_version: process.version, platform: process.platform, arch: process.arch },
    ratification_event_id: lockedRatification,
    epoch_name: lockedEpoch,
    absent,
  });
  for (const stage of ['OPENING_EVIDENCE', 'RECOGNIZED', 'SCREENED'] as const) cycles.advance(cycle.id, stage, null);
  return { cycleId: cycle.id, missionVersion: cycle.mission_version, lockDigest };
}

test('Creator recovery replaces a stale cross-mission lock once and reproduces the original and successor on replay', (t) => {
  const repoRoot = installation(t);
  const expected = withRuntime({ repoRoot, withLog: true }, (runtime) => {
    const missions = runtime.mission;
    assert.ok(missions);
    missions.bootstrap();
    const priorRatification = missions.ratifyInstalledAuthority({ statement: 'RATIFY OLD' });
    const priorEpoch = missions.sealEpoch({ epochName: 'old', statement: 'SEAL OLD' });
    writeFileSync(join(repoRoot, 'package.json'), '{"files":["LICENSE","src"]}\n');
    const current = missions.bootstrap().mission;
    assert.equal(current.id, 'MISSION-000002');
    const expected = screened(runtime, priorRatification.event_id, priorEpoch.epoch_name);
    assert.throws(() => inspectCycleAuthorityRecovery(runtime, expected), /Ratify and seal/);
    missions.ratifyInstalledAuthority({ statement: 'RATIFY CURRENT' });
    missions.sealEpoch({ epochName: 'current', statement: 'SEAL CURRENT' });
    return expected;
  });
  const evidence = withRuntime({ repoRoot, withLog: false, readOnly: true }, (runtime) => {
    assert.equal(runtime.log, null);
    const evidence = inspectCycleAuthorityRecovery(runtime, expected);
    assert.equal(evidence.locked_ratification?.mission, 'MISSION-000001');
    assert.equal(evidence.locked_epoch?.mission, 'MISSION-000001');
    assert.equal(evidence.ratification.mission, 'MISSION-000002');
    assert.equal(evidence.epoch.mission, 'MISSION-000002');
    return evidence;
  });
  const confirmation = cycleAuthorityRecoveryConfirmation(expected, evidence);
  const event = withRuntime({ repoRoot, withLog: true, verifyLog: 'full' }, (runtime) => {
    const cycles = registry(runtime);
    const log = runtime.requireLog();
    const previous = cycles.get(expected.cycleId);
    const before = log.getHead();
    assert.equal(before?.hash, evidence.journal_head.sha256, 'preview preserves the verified head');
    assert.throws(() => cycles.recoverAuthority(expected, 'yes', () => inspectCycleAuthorityRecovery(runtime, expected)),
      /confirmation differs/);
    assert.deepEqual(log.getHead(), before);
    const recovered = cycles.recoverAuthority(expected, confirmation, () => inspectCycleAuthorityRecovery(runtime, expected));
    assert.equal(recovered.state, 'RECOVERED');
    assert.equal(recovered.event.sequence, evidence.journal_head.sequence + 1);
    assert.equal(recovered.successor.cycle_id, 'CYCLE-000002');
    assert.deepEqual(cycles.get(expected.cycleId), previous);
    assert.equal(cycles.current()?.stage, 'OPENED');
    assert.equal(cycles.current()?.lock_digest, null);
    assert.equal(cycles.recoverAuthority(expected, confirmation, () => assert.fail('retry needs no preview')).state, 'ALREADY_RECOVERED');
    assert.equal(log.getHead()?.hash, recovered.event.hash);

    const rebuilt = new ProjectionStore(join(repoRoot, 'replayed.db'), { modules: [CYCLE_PROJECTION] });
    try {
      rebuilt.sync(log);
      const replayed = new CycleRegistry({ log, projections: rebuilt, missionVersion: runtime.currentMissionId });
      assert.deepEqual(replayed.get(expected.cycleId), previous);
      assert.deepEqual(replayed.current(), cycles.current());
      const dashboard = createDashboardCycleProgress({ projections: rebuilt, currentMissionId: runtime.currentMissionId }).read();
      assert.equal(dashboard?.checkpoint?.kind, CYCLE_EVENT_TYPES.authorityRecovered);
      assert.equal(dashboard?.recoverable, true);
    } finally {
      rebuilt.close();
    }
    return recovered.event;
  });
  withRuntime({ repoRoot, withLog: false, readOnly: true }, (runtime) => {
    const replayed = findRecordedCycleAuthorityRecovery(runtime, expected);
    assert.equal(replayed?.event.hash, event.hash);
  });
});

test('later authority changes leave healthy historical locks outside the recovery path', (t) => {
  const repoRoot = installation(t);
  withRuntime({ repoRoot, withLog: true }, (runtime) => {
    const missions = runtime.mission;
    assert.ok(missions);
    missions.bootstrap();
    const ratification = missions.ratifyInstalledAuthority({ statement: 'RATIFY CURRENT' });
    const initialEpoch = missions.sealEpoch({ epochName: 'initial', statement: 'SEAL INITIAL' });
    const expected = screened(runtime, ratification.event_id, initialEpoch.epoch_name);
    missions.sealEpoch({ epochName: 'later', statement: 'SEAL LATER' });
    assert.throws(() => inspectCycleAuthorityRecovery(runtime, expected), /Later authority changes do not qualify/);
  });
});

test('a changed review or a recorded proof verdict prevents authority recovery', (t) => {
  const repoRoot = installation(t);
  withRuntime({ repoRoot, withLog: true }, (runtime) => {
    const missions = runtime.mission;
    assert.ok(missions);
    const current = missions.bootstrap().mission;
    const expected = screened(runtime, null, null);
    missions.ratifyInstalledAuthority({ statement: 'RATIFY CURRENT' });
    missions.sealEpoch({ epochName: 'current', statement: 'SEAL CURRENT' });
    const evidence = inspectCycleAuthorityRecovery(runtime, expected);
    assert.equal(evidence.locked_epoch, null);
    const confirmation = cycleAuthorityRecoveryConfirmation(expected, evidence);
    const log = runtime.requireLog();
    log.append({ type: 'test.review_changed', actor: 'cli', missionVersion: current.id, payload: {} });
    runtime.projections.sync(log);
    assert.throws(
      () => registry(runtime).recoverAuthority(expected, confirmation, () => inspectCycleAuthorityRecovery(runtime, expected)),
      /review changed/,
    );
    log.append({
      type: PROOF_EVENT_TYPES.verdictRecorded, actor: 'cli', missionVersion: current.id, subjectId: expected.cycleId,
      payload: { cycle_id: expected.cycleId, disposition: 'REJECT', improvement: false },
    });
    runtime.projections.sync(log);
    assert.throws(() => inspectCycleAuthorityRecovery(runtime, expected), /recorded proof verdict/);
  });
});
