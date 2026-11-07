/**
 * Cycle registry acceptance (DEV-P2-08 S2; cycle-implementation-plan v1 §4–§5, accepted
 * 2026-08-10).
 *
 * Turns the S2 live walk into suite-guarded facts. The machine under test is deliberately
 * small — one legality map, one suspendable set — so the pins are exact: which arrows
 * exist, which refusals name what, what a suspended cycle remembers, what the serial rule
 * releases on, and that a fresh projection replays the same log into identical rows. The
 * lock's honesty refinement (a lock naming absences cannot call itself
 * proof-authoritative) is pinned here through the registry's own write path, and the
 * closure refinement at the schema surface, because the registry's API makes the
 * disagreement unconstructible — which is itself the design worth keeping.
 *
 * The corruption test appends a `cycle.opened` event with garbage directly to the log:
 * the write gate was bypassed, so the projector is the last line, and it must throw
 * rather than project a cycle that never legally opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import {
  CYCLE_EVENT_TYPES,
  CYCLE_PROJECTION,
  CycleRegistry,
  CycleTransitionError,
} from '../src/cycle/cycleRegistry.js';
import {
  cycleClosedSchema,
  type CycleInputLock,
  type CycleStage,
} from '../src/shared/schemas.js';

/* ========================================================================= */
/* Fixture — the cycle domain needs only a log, a store, and a mission name   */
/* ========================================================================= */

interface Stack {
  readonly root: string;
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly registry: CycleRegistry;
  dispose(): void;
}

function openStack(root = mkdtempSync(join(tmpdir(), 'clue-cycle-'))): Stack {
  mkdirSync(join(root, 'events'), { recursive: true });
  const projections = new ProjectionStore(join(root, 'cycle.db'), {
    modules: [CYCLE_PROJECTION],
  });
  const { log } = EventLog.open(join(root, 'events'), { fsyncOnAppend: false });
  const registry = new CycleRegistry({
    log,
    projections,
    missionVersion: () => 'MISSION-000001',
  });
  return {
    root,
    log,
    projections,
    registry,
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

function diagnosticLock(overrides: Partial<CycleInputLock> = {}): CycleInputLock {
  return {
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
    absent: ['master_benchmark', 'intent_model'],
    ...overrides,
  };
}

const transition = (from: CycleStage | null, to: CycleStage | null, needle: string) =>
  (error: unknown): boolean =>
    error instanceof CycleTransitionError &&
    error.from === from &&
    error.to === to &&
    error.message.includes(needle);

/* ========================================================================= */
/* The walk, the serial rule, and honest closure                              */
/* ========================================================================= */

test('S2: the diagnostic walk — open, lock, advance, close honestly unmet, and the serial rule releases', () => {
  const stack = openStack();
  try {
    const cycle = stack.registry.open();
    assert.match(cycle.id, /^CYCLE-\d{6,}$/);
    assert.equal(cycle.stage, 'OPENED');
    assert.equal(cycle.grade, null, 'no grade before the lock');

    assert.throws(
      () => stack.registry.open(),
      transition('OPENED', 'OPENED', 'cycles are serial'),
    );

    const locked = stack.registry.lockInputs(cycle.id, diagnosticLock());
    assert.equal(locked.stage, 'INPUTS_LOCKED');
    assert.equal(locked.grade, 'diagnostic');
    assert.equal(locked.lock_digest, 'd'.repeat(64));

    for (const to of ['OPENING_EVIDENCE', 'RECOGNIZED', 'SCREENED'] as const) {
      assert.equal(stack.registry.advance(cycle.id, to, null).stage, to);
    }

    // The diagnostic path: SCREENED → CLOSING_EVIDENCE, no CANDIDATES loop (plan D3).
    stack.registry.advance(cycle.id, 'CLOSING_EVIDENCE', null);
    stack.registry.advance(cycle.id, 'HANDOFF', null);

    const unmet = ['no master benchmark', 'no candidate loop in a diagnostic cycle'];
    const closed = stack.registry.close(cycle.id, unmet);
    assert.equal(closed.stage, 'CLOSED');
    assert.ok(closed.closed_at !== null);

    // §24 lives in the closure event, met-or-honestly-unmet; read it back from the truth.
    const closures = [...stack.log.replay()].filter(
      (record) => record.type === CYCLE_EVENT_TYPES.closed,
    );
    assert.equal(closures.length, 1);
    const payload = cycleClosedSchema.parse(closures[0]?.payload);
    assert.equal(payload.criteria_met, false);
    assert.deepEqual(payload.unmet, unmet);
    assert.equal(payload.stage_reached, 'HANDOFF');
    assert.equal(payload.grade, 'diagnostic');

    // Closure releases the serial rule.
    const next = stack.registry.open();
    assert.notEqual(next.id, cycle.id);
    assert.equal(stack.registry.current()?.id, next.id);
    assert.equal(stack.registry.list().length, 2);
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* ========================================================================= */
/* Refusals — each names its whole story                                      */
/* ========================================================================= */

test('S2: refusals — pre-lock advance, double lock, skips name legal targets, wrong-stage close, bad resume, unknown id', () => {
  const stack = openStack();
  try {
    const cycle = stack.registry.open();

    assert.throws(
      () => stack.registry.advance(cycle.id, 'OPENING_EVIDENCE', null),
      transition('OPENED', 'OPENING_EVIDENCE', 'no stage_advanced arrow'),
    );
    assert.throws(
      () => stack.registry.close(cycle.id, []),
      transition('OPENED', 'CLOSED', 'closure happens from HANDOFF'),
    );
    assert.throws(
      () => stack.registry.resume(cycle.id, null),
      (error: unknown) =>
        error instanceof CycleTransitionError && error.message.includes('only a suspended cycle'),
    );

    // The lock's honesty refinement, through the registry's own write path.
    assert.throws(
      () =>
        stack.registry.lockInputs(cycle.id, diagnosticLock({ grade: 'proof-authoritative' })),
      /cannot be proof-authoritative/,
    );

    stack.registry.lockInputs(cycle.id, diagnosticLock());
    assert.throws(
      () => stack.registry.lockInputs(cycle.id, diagnosticLock()),
      transition('INPUTS_LOCKED', 'INPUTS_LOCKED', 'exactly once, from OPENED'),
    );

    stack.registry.advance(cycle.id, 'OPENING_EVIDENCE', null);
    stack.registry.advance(cycle.id, 'RECOGNIZED', null);
    stack.registry.advance(cycle.id, 'SCREENED', null);
    assert.throws(
      () => stack.registry.advance(cycle.id, 'HANDOFF', null),
      (error: unknown) =>
        error instanceof CycleTransitionError &&
        error.message.includes('CANDIDATES') &&
        error.message.includes('CLOSING_EVIDENCE'),
      'a refused skip names every legal target',
    );

    assert.throws(
      () => stack.registry.get('CYCLE-999999') === null && stack.registry.close('CYCLE-999999', []),
      transition(null, null, 'unknown cycle'),
    );

    // The closure refinement is unconstructible through the API — pin it at the schema.
    const disagreement = cycleClosedSchema.safeParse({
      cycle_id: 'CYCLE-000001',
      closed_at: '2026-08-10T12:00:00.000Z',
      stage_reached: 'HANDOFF',
      grade: 'diagnostic',
      criteria_met: true,
      unmet: ['something'],
    });
    assert.equal(disagreement.success, false, 'criteria_met must agree with the unmet list');
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* ========================================================================= */
/* Suspension remembers; closure is history                                   */
/* ========================================================================= */

test('S2: suspend remembers the stage, resume returns exactly there, and a closed cycle is history', () => {
  const stack = openStack();
  try {
    const cycle = stack.registry.open();
    stack.registry.lockInputs(cycle.id, diagnosticLock());
    stack.registry.advance(cycle.id, 'OPENING_EVIDENCE', null);
    stack.registry.advance(cycle.id, 'RECOGNIZED', null);

    const suspended = stack.registry.suspend(cycle.id, 'operator break');
    assert.equal(suspended.stage, 'SUSPENDED');
    assert.equal(suspended.suspended_from, 'RECOGNIZED');
    assert.throws(
      () => stack.registry.suspend(cycle.id, 'again'),
      transition('SUSPENDED', 'SUSPENDED', 'already suspended'),
    );
    assert.throws(
      () => stack.registry.advance(cycle.id, 'SCREENED', null),
      transition('SUSPENDED', 'SCREENED', 'no stage_advanced arrow'),
    );

    const resumed = stack.registry.resume(cycle.id, null);
    assert.equal(resumed.stage, 'RECOGNIZED');
    assert.equal(resumed.suspended_from, null, 'the memory clears on resume');

    stack.registry.advance(cycle.id, 'SCREENED', null);
    stack.registry.advance(cycle.id, 'CLOSING_EVIDENCE', null);
    stack.registry.advance(cycle.id, 'HANDOFF', null);
    stack.registry.close(cycle.id, ['diagnostic cycle']);
    assert.throws(
      () => stack.registry.suspend(cycle.id, 'too late'),
      transition('CLOSED', 'SUSPENDED', 'a closed cycle is history'),
    );
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* ========================================================================= */
/* The rows are a convenience; the events are the truth                       */
/* ========================================================================= */

test('S2: a fresh projection replays the same log into identical rows', () => {
  const stack = openStack();
  try {
    const cycle = stack.registry.open();
    stack.registry.lockInputs(cycle.id, diagnosticLock());
    stack.registry.advance(cycle.id, 'OPENING_EVIDENCE', null);
    stack.registry.suspend(cycle.id, 'parity check');
    const original = stack.registry.list();

    const rebuilt = new ProjectionStore(join(stack.root, 'rebuilt.db'), {
      modules: [CYCLE_PROJECTION],
    });
    try {
      rebuilt.sync(stack.log);
      const replayed = new CycleRegistry({
        log: stack.log,
        projections: rebuilt,
        missionVersion: () => 'MISSION-000001',
      }).list();
      assert.deepEqual(replayed, original, 'events in, identical rows out');
    } finally {
      rebuilt.close();
    }
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('S2: a cycle event with a malformed payload refuses to project', () => {
  const stack = openStack();
  try {
    stack.log.append({
      type: CYCLE_EVENT_TYPES.opened,
      actor: 'daemon',
      missionVersion: 'MISSION-000001',
      subjectId: null,
      payload: { garbage: true },
    });
    assert.throws(
      () => stack.projections.sync(stack.log),
      /cycle\.opened/,
      'the projector is the last line when the write gate was bypassed',
    );
  } finally {
    stack.dispose();
    rmSync(stack.root, { recursive: true, force: true, maxRetries: 3 });
  }
});
