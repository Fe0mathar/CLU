/**
 * DEV-P0-06 — the opaque lease/attempt token is the sole authority for terminal transitions.
 *
 * A worker name is not a unique authority: if attempt 1 expires and the same worker name later
 * receives attempt 2, a delayed result from attempt 1 must not be mistaken for a valid result. Each
 * claim mints a fresh random token whose hash is stored; heartbeat, complete, fail, and abandon carry
 * it in one atomic conditional over (id, state, owner, unexpired lease, token). This suite proves
 * completion/reclaim exclusivity, expired- and stale-token rejection (including re-lease to the same
 * worker), that heartbeat cannot resurrect an expired attempt, and dependency self/unknown/cycle
 * rejection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectionStore } from '../src/memory/db.js';
import { EventLog } from '../src/memory/eventLog.js';
import { TaskQueue, TASK_PROJECTORS } from '../src/control/tasks.js';
import { hashText } from '../src/shared/ids.js';

interface Stack {
  readonly root: string;
  readonly projections: ProjectionStore;
  readonly queue: TaskQueue;
  readonly log: EventLog;
  dispose(): void;
}

function openQueue(): Stack {
  const root = mkdtempSync(join(tmpdir(), 'clue-lease-token-'));
  const ws = join(root, 'workspace');
  for (const d of ['db', 'events']) mkdirSync(join(ws, d), { recursive: true });
  const projections = new ProjectionStore(join(ws, 'db', 'clue.db'), { projectors: { ...TASK_PROJECTORS } });
  const { log } = EventLog.open(join(ws, 'events'));
  const queue = new TaskQueue({ log, projections, missionVersion: (): string => 'MISSION-000001' });
  return {
    root,
    projections,
    queue,
    log,
    dispose(): void {
      log.close();
      projections.close();
    },
  };
}

let counter = 0;
const make = (queue: TaskQueue) =>
  queue.create({ type: 'T', lane: 'analysis', priority: 0.5, inputHash: hashText(`in-${counter++}`) });
const nextId = (id: string): string => {
  const m = /^(.*-)(\d+)$/.exec(id);
  assert.ok(m !== null);
  const prefix = m[1];
  const num = m[2];
  assert.ok(prefix !== undefined && num !== undefined);
  return `${prefix}${String(Number(num) + 1).padStart(num.length, '0')}`;
};

test('completion and reclaim are mutually exclusive', () => {
  const s = openQueue();
  try {
    // Completion wins → a later reclaim finds nothing.
    const t1 = make(s.queue);
    const lease1 = s.queue.claimById(t1.id, 'worker-a');
    assert.ok(lease1 !== null);
    s.queue.complete(t1.id, 'worker-a', lease1.leaseToken, { outputHash: hashText('r1') });
    assert.equal(s.queue.reclaimExpired(), 0, 'reclaim takes nothing after completion');
    assert.equal(s.queue.get(t1.id)?.state, 'completed');

    // Reclaim wins → the held token can no longer complete.
    const t2 = make(s.queue);
    const lease2 = s.queue.claimById(t2.id, 'worker-a', { leaseMs: -1 });
    assert.ok(lease2 !== null);
    assert.equal(s.queue.reclaimExpired(), 1, 'the expired lease is reclaimed');
    assert.throws(
      () => s.queue.complete(t2.id, 'worker-a', lease2.leaseToken, { outputHash: hashText('r2') }),
      /not leased|expired|could not/,
    );
    assert.notEqual(s.queue.get(t2.id)?.state, 'completed');
  } finally {
    s.dispose();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a genuine token cannot complete once its lease has expired', () => {
  const s = openQueue();
  try {
    const t = make(s.queue);
    const lease = s.queue.claimById(t.id, 'worker-a', { leaseMs: -1 });
    assert.ok(lease !== null);
    assert.throws(
      () => s.queue.complete(t.id, 'worker-a', lease.leaseToken, { outputHash: hashText('x') }),
      /expired|not leased/,
    );
  } finally {
    s.dispose();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('an old token is rejected after re-lease to the same worker name', () => {
  const s = openQueue();
  try {
    const t = make(s.queue);
    const first = s.queue.claimById(t.id, 'worker-a', { leaseMs: -1 });
    assert.ok(first !== null);
    s.queue.reclaimExpired();
    // Reclaim applies a retry backoff (tested separately); clear it so the re-lease can proceed now.
    s.projections.db.prepare("UPDATE tasks SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(t.id);
    const second = s.queue.claimById(t.id, 'worker-a');
    assert.ok(second !== null);

    assert.notEqual(first.leaseToken, second.leaseToken, 'the two leases carry different tokens');
    assert.equal(second.attempt, first.attempt + 1, 'the re-lease is a new attempt');
    assert.throws(
      () => s.queue.complete(t.id, 'worker-a', first.leaseToken, { outputHash: hashText('stale') }),
      /does not match|not leased|expired|could not/,
      'the old token cannot complete the re-leased task',
    );
    assert.equal(
      s.queue.complete(t.id, 'worker-a', second.leaseToken, { outputHash: hashText('fresh') }).state,
      'completed',
      'the current token completes it',
    );
  } finally {
    s.dispose();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('heartbeat cannot resurrect an expired attempt and requires the right token', () => {
  const s = openQueue();
  try {
    const t = make(s.queue);
    const lease = s.queue.claimById(t.id, 'worker-a', { leaseMs: -1 });
    assert.ok(lease !== null);
    assert.equal(s.queue.heartbeat(t.id, 'worker-a', lease.leaseToken), false, 'expired lease cannot be extended');
    s.queue.reclaimExpired();
    assert.equal(s.queue.heartbeat(t.id, 'worker-a', lease.leaseToken), false, 'reclaimed task cannot be heartbeat');

    const live = make(s.queue);
    const good = s.queue.claimById(live.id, 'worker-a');
    assert.ok(good !== null);
    assert.equal(s.queue.heartbeat(live.id, 'worker-a', 'not-the-token'), false, 'a wrong token never extends a lease');
    assert.equal(s.queue.heartbeat(live.id, 'worker-a', good.leaseToken), true, 'the right token extends a live lease');
  } finally {
    s.dispose();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('dependency self-links, unknown links, and multi-step cycles are rejected', () => {
  const s = openQueue();
  try {
    const a = make(s.queue);

    assert.throws(
      () => s.queue.create({ type: 'T', lane: 'analysis', priority: 0.5, inputHash: hashText('self'), dependsOn: [nextId(a.id)] }),
      /depend on itself/,
    );
    assert.throws(
      () => s.queue.create({ type: 'T', lane: 'analysis', priority: 0.5, inputHash: hashText('unknown'), dependsOn: ['TASK-999999'] }),
      /unknown task/,
    );

    // Multi-step cycle: b -> a, and (seeded) a -> c; creating c depending on b closes b -> a -> c -> b.
    const b = s.queue.create({ type: 'T', lane: 'analysis', priority: 0.5, inputHash: hashText('b'), dependsOn: [a.id] });
    const cId = nextId(b.id);
    s.projections.db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run(a.id, cId);
    assert.throws(
      () => s.queue.create({ type: 'T', lane: 'analysis', priority: 0.5, inputHash: hashText('c'), dependsOn: [b.id] }),
      /dependency cycle/,
    );
  } finally {
    s.dispose();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('DEV-P0-06: renewal requires the current token, and a renewed lease survives a projection rebuild', () => {
  const s = openQueue();
  try {
    const t = make(s.queue);
    const first = s.queue.claimById(t.id, 'worker-a');
    assert.ok(first !== null);

    // A re-claim without the current token cannot rotate a live lease.
    assert.equal(s.queue.claimById(t.id, 'worker-a'), null, 'renewal without the token is refused');
    assert.equal(s.queue.claimById(t.id, 'worker-a', { leaseToken: 'wrong-token' }), null, 'renewal with a stale token is refused');

    // Presenting the current token renews the lease and rotates the token.
    const renewed = s.queue.claimById(t.id, 'worker-a', { leaseToken: first.leaseToken });
    assert.ok(renewed !== null);
    assert.equal(renewed.renewed, true);
    assert.notEqual(renewed.leaseToken, first.leaseToken, 'the renewal rotated the token');

    // Rebuild the projections purely from the event log.
    s.projections.rebuild(s.log);

    // After a rebuild the renewed token is still authoritative, and the old token is not resurrected —
    // the durable task.lease_renewed event, not just live projection state, carried the rotation.
    assert.equal(s.queue.heartbeat(t.id, 'worker-a', renewed.leaseToken), true, 'renewed token works after rebuild');
    assert.equal(s.queue.heartbeat(t.id, 'worker-a', first.leaseToken), false, 'old token is not resurrected');
  } finally {
    s.dispose();
  }
});

test('DEV-P0-06: administrative release does not consume the dead-letter budget; only failures do', () => {
  const s = openQueue();
  try {
    const t = s.queue.create({ type: 'T', lane: 'analysis', priority: 0.5, inputHash: hashText('budget-check'), maxAttempts: 2 });

    // Claim and administratively release several times. The attempt sequence grows; no failure recorded.
    for (let i = 0; i < 5; i++) {
      const lease = s.queue.claimById(t.id, 'worker-a');
      assert.ok(lease !== null, `claim ${i}`);
      s.queue.release(t.id, 'admin re-queue');
    }
    assert.equal(s.queue.get(t.id)?.failed_attempt_count, 0, 'releases record no failures');
    assert.notEqual(s.queue.get(t.id)?.state, 'dead', 'many releases never dead-letter the task');

    const claimNow = (): string => {
      s.projections.db.prepare("UPDATE tasks SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(t.id);
      const lease = s.queue.claimById(t.id, 'worker-a');
      assert.ok(lease !== null);
      return lease.leaseToken;
    };

    // A genuine failure counts toward the budget but does not yet exhaust it (max_attempts = 2).
    s.queue.fail(t.id, 'worker-a', claimNow(), { detail: 'boom' });
    assert.equal(s.queue.get(t.id)?.failed_attempt_count, 1);
    assert.notEqual(s.queue.get(t.id)?.state, 'dead');

    // The second failure exhausts the budget and dead-letters the task.
    s.queue.fail(t.id, 'worker-a', claimNow(), { detail: 'boom again' });
    assert.equal(s.queue.get(t.id)?.failed_attempt_count, 2);
    assert.equal(s.queue.get(t.id)?.state, 'dead');
  } finally {
    s.dispose();
  }
});
