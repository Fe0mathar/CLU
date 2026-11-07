/**
 * INT-P0-01 — permanent task-transition authority fault injection.
 *
 * The task queue is event-first: a transition may become visible in SQLite only after its
 * authoritative event is durable. These tests exercise the four failure boundaries that exposed
 * the former contradiction:
 *
 *   1. claim append fails                  -> no event, no lease projection;
 *   2. completion append fails             -> no event, task remains leased;
 *   3. claim event commits, projection fails -> replay creates exactly one lease/attempt;
 *   4. completion event commits, projection fails -> replay creates exactly one completion.
 *
 * Projection faults are injected *after* the real task projector has run. ProjectionStore wraps
 * each catch-up/rebuild in one SQLite transaction, so the injected throw proves that even a fault
 * during projection rolls back the whole derived transition while leaving the event authoritative.
 * A subsequent rebuild must recover that committed event exactly once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectionStore, type Projector } from '../src/memory/db.js';
import { EventLog } from '../src/memory/eventLog.js';
import {
  TASK_EVENT_TYPES,
  TASK_PROJECTORS,
  TaskQueue,
  type TaskAttempt,
  type TaskRecord,
} from '../src/control/tasks.js';
import { hashText } from '../src/shared/ids.js';

type FaultBoundary = 'append-before' | 'projection-after';

class InjectedTaskAuthorityFault extends Error {
  public readonly eventType: string;
  public readonly boundary: FaultBoundary;

  public constructor(eventType: string, boundary: FaultBoundary) {
    super(`Injected ${boundary} fault for ${eventType}`);
    this.name = 'InjectedTaskAuthorityFault';
    this.eventType = eventType;
    this.boundary = boundary;
  }
}

class FaultController {
  private armed: { readonly eventType: string; readonly boundary: FaultBoundary } | null = null;

  public arm(eventType: string, boundary: FaultBoundary): void {
    assert.equal(this.armed, null, 'only one deterministic fault may be armed at a time');
    this.armed = { eventType, boundary };
  }

  public trip(eventType: string, boundary: FaultBoundary): boolean {
    if (this.armed?.eventType !== eventType || this.armed.boundary !== boundary) return false;
    this.armed = null;
    return true;
  }
}

interface Stack {
  readonly root: string;
  readonly log: EventLog;
  readonly projections: ProjectionStore;
  readonly queue: TaskQueue;
  readonly faults: FaultController;
  dispose(): void;
}

function faultInjectingProjectors(faults: FaultController): Readonly<Record<string, Projector>> {
  const projectors: Record<string, Projector> = {};

  for (const eventType of Object.keys(TASK_PROJECTORS)) {
    const projector = TASK_PROJECTORS[eventType];
    if (projector === undefined) continue;

    projectors[eventType] = (db, record): void => {
      projector(db, record);
      if (faults.trip(eventType, 'projection-after')) {
        throw new InjectedTaskAuthorityFault(eventType, 'projection-after');
      }
    };
  }

  return projectors;
}

function openStack(): Stack {
  const root = mkdtempSync(join(tmpdir(), 'clue-task-authority-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'db'), { recursive: true });
  mkdirSync(join(workspace, 'events'), { recursive: true });

  const faults = new FaultController();
  const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'), {
    projectors: faultInjectingProjectors(faults),
  });
  const { log } = EventLog.open(join(workspace, 'events'), { fsyncOnAppend: false });

  const append = log.append.bind(log);
  const injectedAppend: EventLog['append'] = (input) => {
    if (faults.trip(input.type, 'append-before')) {
      throw new InjectedTaskAuthorityFault(input.type, 'append-before');
    }
    return append(input);
  };
  Object.defineProperty(log, 'append', {
    configurable: true,
    enumerable: false,
    value: injectedAppend,
    writable: true,
  });

  const queue = new TaskQueue({
    log,
    projections,
    missionVersion: (): string => 'MISSION-000001',
  });

  return {
    root,
    log,
    projections,
    queue,
    faults,
    dispose(): void {
      try {
        log.close();
      } finally {
        projections.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  };
}

function createTask(queue: TaskQueue, label: string): TaskRecord {
  return queue.create({
    type: 'authority-probe',
    lane: 'analysis',
    priority: 0.5,
    inputHash: hashText(`input:${label}`),
  });
}

function eventCount(log: EventLog, eventType: string): number {
  let count = 0;
  for (const record of log.replay()) {
    if (record.type === eventType) count += 1;
  }
  return count;
}

function oneAttempt(queue: TaskQueue, taskId: string): TaskAttempt {
  const attempts = queue.attempts(taskId);
  assert.equal(attempts.length, 1, 'exactly one attempt is projected');
  const attempt = attempts[0];
  assert.ok(attempt !== undefined);
  return attempt;
}

function assertInjectedFault(
  action: () => unknown,
  eventType: string,
  boundary: FaultBoundary,
): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof InjectedTaskAuthorityFault &&
      error.eventType === eventType &&
      error.boundary === boundary,
  );
}

test('INT-P0-01: claim append failure leaves neither an event nor a lease projection', () => {
  const stack = openStack();
  try {
    const task = createTask(stack.queue, 'claim-append');
    const headBefore = stack.log.getHead();
    const statusBefore = stack.projections.status();
    const digestBefore = stack.projections.canonicalExportDigest();

    stack.faults.arm(TASK_EVENT_TYPES.attemptStarted, 'append-before');
    assertInjectedFault(
      () => stack.queue.claimById(task.id, 'worker-a'),
      TASK_EVENT_TYPES.attemptStarted,
      'append-before',
    );

    assert.deepEqual(stack.log.getHead(), headBefore, 'no authoritative claim event was added');
    assert.deepEqual(stack.projections.status(), statusBefore, 'projection head did not move');
    assert.equal(
      stack.projections.canonicalExportDigest(),
      digestBefore,
      'no task or attempt projection changed',
    );
    assert.equal(eventCount(stack.log, TASK_EVENT_TYPES.attemptStarted), 0);
    assert.deepEqual(stack.queue.get(task.id), task, 'the task remains exactly pending');
    assert.deepEqual(stack.queue.attempts(task.id), [], 'no attempt row exists');

    const retry = stack.queue.claimById(task.id, 'worker-a');
    assert.ok(retry !== null, 'the same command can be retried after the append failure');
    assert.equal(retry.task.state, 'leased');
    assert.equal(eventCount(stack.log, TASK_EVENT_TYPES.attemptStarted), 1);
  } finally {
    stack.dispose();
  }
});

test('INT-P0-01: completion append failure leaves the live lease and open attempt unchanged', () => {
  const stack = openStack();
  try {
    const task = createTask(stack.queue, 'complete-append');
    const lease = stack.queue.claimById(task.id, 'worker-a');
    assert.ok(lease !== null);

    const headBefore = stack.log.getHead();
    const statusBefore = stack.projections.status();
    const digestBefore = stack.projections.canonicalExportDigest();
    const outputHash = hashText('result:complete-append');

    stack.faults.arm(TASK_EVENT_TYPES.attemptEnded, 'append-before');
    assertInjectedFault(
      () =>
        stack.queue.complete(task.id, 'worker-a', lease.leaseToken, {
          outputHash,
          tokensIn: 11,
          tokensOut: 7,
          cost: 0.25,
        }),
      TASK_EVENT_TYPES.attemptEnded,
      'append-before',
    );

    assert.deepEqual(stack.log.getHead(), headBefore, 'no authoritative completion event was added');
    assert.deepEqual(stack.projections.status(), statusBefore, 'projection head did not move');
    assert.equal(stack.projections.canonicalExportDigest(), digestBefore);
    assert.equal(eventCount(stack.log, TASK_EVENT_TYPES.attemptEnded), 0);

    const stillLeased = stack.queue.get(task.id);
    assert.equal(stillLeased?.state, 'leased');
    assert.equal(stillLeased?.output_hash, null);
    const openAttempt = oneAttempt(stack.queue, task.id);
    assert.equal(openAttempt.ended_at, null);
    assert.equal(openAttempt.outcome, null);
    assert.equal(
      stack.queue.leaseHeldBy(task.id, 'worker-a', lease.leaseToken),
      true,
      'the same lease remains authoritative after a pre-append failure',
    );

    const completed = stack.queue.complete(task.id, 'worker-a', lease.leaseToken, { outputHash });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.output_hash, outputHash);
    assert.equal(eventCount(stack.log, TASK_EVENT_TYPES.attemptEnded), 1);
  } finally {
    stack.dispose();
  }
});

test('INT-P0-01: committed claim plus projection failure rebuilds to exactly one lease attempt', () => {
  const stack = openStack();
  try {
    const task = createTask(stack.queue, 'claim-projection');
    const headBefore = stack.log.getHead();
    const statusBefore = stack.projections.status();
    const digestBefore = stack.projections.canonicalExportDigest();

    stack.faults.arm(TASK_EVENT_TYPES.attemptStarted, 'projection-after');
    assertInjectedFault(
      () => stack.queue.claimById(task.id, 'worker-a'),
      TASK_EVENT_TYPES.attemptStarted,
      'projection-after',
    );

    assert.equal(
      stack.log.getHead()?.sequence,
      (headBefore?.sequence ?? -1) + 1,
      'the claim event is durable despite the projection fault',
    );
    assert.equal(eventCount(stack.log, TASK_EVENT_TYPES.attemptStarted), 1);
    assert.deepEqual(stack.projections.status(), statusBefore, 'the failed projection transaction rolled back');
    assert.equal(stack.projections.canonicalExportDigest(), digestBefore);
    assert.deepEqual(stack.queue.get(task.id), task, 'the old projection remains visible until recovery');
    assert.deepEqual(stack.queue.attempts(task.id), []);

    stack.projections.rebuild(stack.log);
    const recovered = stack.queue.get(task.id);
    assert.equal(recovered?.state, 'leased');
    assert.equal(recovered?.lease_owner, 'worker-a');
    assert.equal(recovered?.attempts, 1);
    const recoveredAttempt = oneAttempt(stack.queue, task.id);
    assert.equal(recoveredAttempt.attempt, 1);
    assert.equal(recoveredAttempt.worker, 'worker-a');
    assert.equal(recoveredAttempt.ended_at, null);

    const recoveredDigest = stack.projections.canonicalExportDigest();
    stack.projections.rebuild(stack.log);
    assert.equal(
      stack.projections.canonicalExportDigest(),
      recoveredDigest,
      'a second replay is byte-equivalent and does not duplicate the attempt',
    );
    assert.equal(oneAttempt(stack.queue, task.id).attempt, 1);
  } finally {
    stack.dispose();
  }
});

test('INT-P0-01: committed completion plus projection failure rebuilds to exactly one terminal result', () => {
  const stack = openStack();
  try {
    const task = createTask(stack.queue, 'complete-projection');
    const lease = stack.queue.claimById(task.id, 'worker-a');
    assert.ok(lease !== null);

    const headBefore = stack.log.getHead();
    const statusBefore = stack.projections.status();
    const digestBefore = stack.projections.canonicalExportDigest();
    const outputHash = hashText('result:complete-projection');

    stack.faults.arm(TASK_EVENT_TYPES.attemptEnded, 'projection-after');
    assertInjectedFault(
      () =>
        stack.queue.complete(task.id, 'worker-a', lease.leaseToken, {
          outputHash,
          detail: 'validated result',
          tokensIn: 13,
          tokensOut: 5,
          cost: 0.5,
        }),
      TASK_EVENT_TYPES.attemptEnded,
      'projection-after',
    );

    assert.equal(
      stack.log.getHead()?.sequence,
      (headBefore?.sequence ?? -1) + 1,
      'the completion event is durable despite the projection fault',
    );
    assert.equal(eventCount(stack.log, TASK_EVENT_TYPES.attemptEnded), 1);
    assert.deepEqual(stack.projections.status(), statusBefore, 'the failed projection transaction rolled back');
    assert.equal(stack.projections.canonicalExportDigest(), digestBefore);

    const preRecovery = stack.queue.get(task.id);
    assert.equal(preRecovery?.state, 'leased');
    assert.equal(preRecovery?.output_hash, null);
    const preRecoveryAttempt = oneAttempt(stack.queue, task.id);
    assert.equal(preRecoveryAttempt.ended_at, null);
    assert.equal(preRecoveryAttempt.outcome, null);

    stack.projections.rebuild(stack.log);
    const recovered = stack.queue.get(task.id);
    assert.equal(recovered?.state, 'completed');
    assert.equal(recovered?.output_hash, outputHash);
    assert.equal(recovered?.lease_owner, null);
    assert.equal(recovered?.lease_expires_at, null);

    const recoveredAttempt = oneAttempt(stack.queue, task.id);
    assert.equal(recoveredAttempt.outcome, 'completed');
    assert.equal(recoveredAttempt.detail, 'validated result');
    assert.equal(recoveredAttempt.tokens_in, 13);
    assert.equal(recoveredAttempt.tokens_out, 5);
    assert.equal(recoveredAttempt.cost, 0.5);

    const recoveredDigest = stack.projections.canonicalExportDigest();
    stack.projections.rebuild(stack.log);
    assert.equal(
      stack.projections.canonicalExportDigest(),
      recoveredDigest,
      'a second replay is byte-equivalent and does not duplicate terminal evidence',
    );
    assert.equal(oneAttempt(stack.queue, task.id).outcome, 'completed');
  } finally {
    stack.dispose();
  }
});
