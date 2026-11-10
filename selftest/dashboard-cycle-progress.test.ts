import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CYCLE_EVENT_TYPES, CYCLE_PROJECTION, CycleRegistry } from '../src/cycle/cycleRegistry.js';
import { createDashboardCycleProgress } from '../src/daemon/dashboardCycleProgress.js';
import { ProjectionStore } from '../src/memory/db.js';
import { EventLog } from '../src/memory/eventLog.js';

test('dashboard cycle progress survives observer restart and distinguishes suspension, screening and closure', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-dashboard-cycle-'));
  const databasePath = join(root, 'cycle.db');
  const writer = new ProjectionStore(databasePath, { modules: [CYCLE_PROJECTION] });
  const { log } = EventLog.open(join(root, 'events'), { fsyncOnAppend: false });
  const missionId = 'MISSION-000001';
  const registry = new CycleRegistry({ log, projections: writer, missionVersion: () => missionId });
  let observer = new ProjectionStore(databasePath, { readOnly: true });
  try {
    const bind = (currentMissionId = missionId) => createDashboardCycleProgress({
      projections: observer,
      currentMissionId: () => currentMissionId,
    });
    let progress = bind();
    assert.equal(progress.read(), null);

    const { id } = registry.open();
    const opened = progress.read();
    assert.equal(opened?.cycleId, id);
    assert.equal(opened?.stage, 'OPENED');
    assert.equal(opened?.checkpoint?.kind, CYCLE_EVENT_TYPES.opened);
    assert.equal(opened?.recoverable, true);
    assert.equal(bind('MISSION-000002').read()?.recoverable, false);

    // Simulate an interruption after a journal append and before its projection commits.
    log.append({
      type: CYCLE_EVENT_TYPES.suspended,
      actor: 'daemon',
      missionVersion: missionId,
      subjectId: id,
      payload: {
        cycle_id: id,
        from: 'OPENED',
        suspended_at: new Date().toISOString(),
        reason: 'operator pause',
      },
    });
    observer.close();
    observer = new ProjectionStore(databasePath, { readOnly: true });
    progress = bind();
    assert.deepEqual(progress.read(), opened);

    writer.sync(log);
    const suspended = progress.read();
    assert.equal(suspended?.stage, 'SUSPENDED');
    assert.equal(suspended?.suspendedFrom, 'OPENED');
    assert.equal(suspended?.recoverable, false);
    assert.equal(suspended?.checkpoint?.kind, CYCLE_EVENT_TYPES.suspended);

    registry.resume(id, null);
    assert.equal(progress.read()?.checkpoint?.kind, CYCLE_EVENT_TYPES.resumed);
    registry.lockInputs(id, {
      digest: 'd'.repeat(64),
      grade: 'diagnostic',
      computed_at: '2026-08-10T12:00:00.000Z',
      target_description: { path: 'target description.md', sha256: '1'.repeat(64) },
      master_benchmark: null,
      tracked_documents: [{ path: 'CLUE.md', sha256: '2'.repeat(64) }],
      catalogue_version: 'v6',
      policy_files: [],
      environment_fingerprint: { node_version: 'v22', platform: 'linux', arch: 'x64' },
      ratification_event_id: 'EVENT-000001',
      epoch_name: 'P0-final',
      absent: ['master_benchmark'],
    });
    for (const stage of ['OPENING_EVIDENCE', 'RECOGNIZED', 'SCREENED'] as const) {
      registry.advance(id, stage, null);
    }
    const screened = progress.read();
    assert.equal(screened?.stage, 'SCREENED');
    assert.equal(screened?.current, true);
    assert.equal(screened?.recoverable, false);
    assert.equal(screened?.closedAt, null);
    assert.equal(screened?.criteriaMet, null);
    assert.deepEqual(screened?.checkpoints.map(({ kind }) => kind), [
      CYCLE_EVENT_TYPES.opened,
      CYCLE_EVENT_TYPES.suspended,
      CYCLE_EVENT_TYPES.resumed,
      CYCLE_EVENT_TYPES.inputsLocked,
      CYCLE_EVENT_TYPES.stageAdvanced,
      CYCLE_EVENT_TYPES.stageAdvanced,
      CYCLE_EVENT_TYPES.stageAdvanced,
    ]);

    registry.advance(id, 'CLOSING_EVIDENCE', null);
    registry.advance(id, 'HANDOFF', null);
    registry.close(id, ['no master benchmark']);
    const closed = progress.read();
    assert.equal(closed?.stage, 'CLOSED');
    assert.equal(closed?.current, false);
    assert.equal(closed?.criteriaMet, false);
    assert.equal(closed?.unmetCount, 1);
    const event = [...log.replay()].at(-1);
    assert.ok(event);
    assert.deepEqual(closed?.checkpoint, {
      kind: CYCLE_EVENT_TYPES.closed,
      eventId: event.id,
      eventSha256: event.hash,
      sequence: event.sequence,
      occurredAt: event.timestamp,
    });
    assert.equal(closed?.cycleId, id);
    assert.equal(closed?.closedAt, closed?.updatedAt);

    const next = registry.open();
    assert.equal(progress.read()?.cycleId, next.id);
    assert.equal(progress.read()?.current, true);
  } finally {
    observer.close();
    log.close();
    writer.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
