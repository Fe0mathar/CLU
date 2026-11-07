/** Project Profiles PP-09 — durable workspace ownership and explicit legacy adoption. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ProjectionStore,
  WorkspaceProjectIdentityError,
  adoptLegacyWorkspaceProjectIdentity,
  type WorkspaceProjectIdentityInput,
} from '../src/memory/db.js';
import { EventLog } from '../src/memory/eventLog.js';

const AT = '2026-08-14T12:00:00.000Z';

function identity(projectId: string, digit: string): WorkspaceProjectIdentityInput {
  return {
    projectId,
    targetRootIdentity: `path:v1:${process.platform}:${digit.repeat(64)}`,
    profileVersion: 'clue-project-profile/1',
    initialProfileHash: `profile:v1:${digit.repeat(64)}`,
  };
}

test('a new workspace is claimed once, survives rebuild, and refuses another project', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-workspace-owner-'));
  const database = join(root, 'db', 'clue.db');
  const a = identity('alpha', 'a');
  try {
    const first = new ProjectionStore(database, {
      workspaceIdentity: { expected: a, onMissing: 'initialize-new' },
      workspaceIdentityNow: () => AT,
    });
    const durable = first.workspaceIdentity();
    assert.equal(durable?.projectId, 'alpha');
    assert.equal(durable?.origin, 'new-workspace');
    assert.equal(durable?.createdAt, AT);
    const { log: emptyLog } = EventLog.open(join(root, 'events-empty'));
    first.rebuild(emptyLog);
    emptyLog.close();
    assert.deepEqual(first.workspaceIdentity(), durable, 'projection rebuild preserves ownership');
    first.close();

    const updatedHash = { ...a, initialProfileHash: `profile:v1:${'b'.repeat(64)}` };
    const reopened = new ProjectionStore(database, {
      workspaceIdentity: { expected: updatedHash, onMissing: 'reject' },
    });
    assert.equal(
      reopened.workspaceIdentity()?.initialProfileHash,
      a.initialProfileHash,
      'later profile generations do not rewrite origin hash',
    );
    reopened.close();

    assert.throws(
      () =>
        new ProjectionStore(database, {
          workspaceIdentity: { expected: identity('beta', 'c'), onMissing: 'reject' },
        }),
      (error: unknown) =>
        error instanceof WorkspaceProjectIdentityError &&
        error.code === 'WORKSPACE_IDENTITY_MISMATCH' &&
        /ROOT\/WORKSPACE IDENTITY MISMATCH/u.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy adoption records the existing projection head without rewriting history', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-workspace-adopt-'));
  const database = join(root, 'db', 'clue.db');
  const events = join(root, 'events');
  const a = identity('alpha', 'd');
  try {
    const legacy = new ProjectionStore(database);
    const { log } = EventLog.open(events);
    log.append({
      type: 'fixture.event',
      actor: 'daemon',
      missionVersion: 'MISSION-000001',
      payload: { preserved: true },
    });
    legacy.sync(log);
    const before = legacy.status();
    log.close();
    legacy.close();

    const adopted = adoptLegacyWorkspaceProjectIdentity(database, a, { now: () => AT });
    assert.equal(adopted.origin, 'legacy-adoption');
    assert.equal(adopted.legacyProjectionHeadHash, before.headHash);
    assert.equal(adopted.legacyIndexedEvents, before.indexedEvents);

    const verified = new ProjectionStore(database, {
      workspaceIdentity: { expected: a, onMissing: 'reject' },
    });
    assert.deepEqual(verified.status(), before, 'adoption does not rewrite projections');
    assert.equal(verified.workspaceIdentity()?.createdAt, AT);
    verified.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only or ordinary activation cannot silently claim an unbound legacy workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-workspace-refuse-'));
  const database = join(root, 'db', 'clue.db');
  const a = identity('alpha', 'e');
  try {
    new ProjectionStore(database).close();
    assert.throws(
      () =>
        new ProjectionStore(database, {
          readOnly: true,
          workspaceIdentity: { expected: a, onMissing: 'reject' },
        }),
      (error: unknown) =>
        error instanceof WorkspaceProjectIdentityError &&
        error.code === 'WORKSPACE_IDENTITY_ADOPTION_REQUIRED',
    );
    assert.throws(
      () =>
        new ProjectionStore(database, {
          workspaceIdentity: { expected: a, onMissing: 'initialize-new' },
        }),
      (error: unknown) =>
        error instanceof WorkspaceProjectIdentityError &&
        error.code === 'WORKSPACE_IDENTITY_INITIALIZATION_REFUSED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
