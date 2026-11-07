import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQ1ProjectGenerationGuard,
  q1ProjectGenerationOf,
} from '../quadrants/q1Navigator.js';

const hash = (digit) => digit.repeat(64);

function envelope({
  projectId,
  generation,
  profileHash,
  recognitionHash,
  streamId,
  emittedAt,
}) {
  return {
    type: 'navigator.reset',
    emittedAt,
    payload: {
      projectRecognition: {
        identityVersion: 'clue-project-recognition-identity/1',
        operationIdentity: {
          projectId,
          targetRootIdentity: `path:v1:win32:${hash(projectId === 'alpha' ? '1' : '2')}`,
          projectProfileHash: `profile:v1:${profileHash}`,
        },
        profileGeneration: generation,
        recognitionConfigHash: recognitionHash,
      },
      streamId,
      runId: `run-${projectId}-${generation}`,
    },
  };
}

const alpha = envelope({
  projectId: 'alpha',
  generation: 1,
  profileHash: hash('a'),
  recognitionHash: hash('b'),
  streamId: 'stream-alpha',
  emittedAt: '2026-08-14T12:00:00.000Z',
});
const beta = envelope({
  projectId: 'beta',
  generation: 1,
  profileHash: hash('c'),
  recognitionHash: hash('d'),
  streamId: 'stream-beta',
  emittedAt: '2026-08-14T12:01:00.000Z',
});

const alphaReplay = envelope({
  projectId: 'alpha',
  generation: 1,
  profileHash: hash('a'),
  recognitionHash: hash('b'),
  streamId: 'stream-alpha-replay',
  emittedAt: '2026-08-14T12:02:00.000Z',
});

test('PP-20: Navigator generation extraction binds project, profile, recognition and stream identity', () => {
  assert.deepEqual(q1ProjectGenerationOf(alpha), {
    projectId: 'alpha',
    targetRootIdentity: `path:v1:win32:${hash('1')}`,
    projectProfileHash: `profile:v1:${hash('a')}`,
    profileGeneration: 1,
    recognitionConfigHash: hash('b'),
    streamId: 'stream-alpha',
    runId: 'run-alpha-1',
    emittedAt: '2026-08-14T12:00:00.000Z',
    emittedAtMs: Date.parse('2026-08-14T12:00:00.000Z'),
  });
});

test('PP-20: a different project generation cannot switch Q1 without control-plane authorisation', () => {
  const guard = createQ1ProjectGenerationGuard();
  assert.equal(guard.decide(alpha, 'navigator.reset').accept, true);

  const unauthorized = guard.decide(beta, 'navigator.reset');
  assert.equal(unauthorized.accept, false);
  assert.equal(unauthorized.reason, 'PROJECT_SWITCH_NOT_AUTHORIZED');
  assert.equal(guard.current().projectId, 'alpha');
});

test('PP-20: authorisation suspends Project A until the exact Project B boundary arrives', () => {
  const guard = createQ1ProjectGenerationGuard();
  assert.equal(guard.decide(alpha, 'navigator.reset').accept, true);
  assert.equal(guard.authorizeNext(beta)?.projectId, 'beta');

  const lateAlpha = guard.decide({ ...alpha, type: 'graph.committed' }, 'graph.committed');
  assert.equal(lateAlpha.accept, false);
  assert.equal(lateAlpha.reason, 'PROJECT_SWITCH_PENDING');

  const betaDataBeforeBoundary = guard.decide({ ...beta, type: 'files.upserted' }, 'files.upserted');
  assert.equal(betaDataBeforeBoundary.accept, false);
  assert.equal(betaDataBeforeBoundary.reason, 'PROJECT_SWITCH_BOUNDARY_REQUIRED');

  const switched = guard.decide(beta, 'navigator.reset');
  assert.equal(switched.accept, true);
  assert.equal(switched.switched, true);
  assert.equal(switched.requiresReset, true);
  assert.equal(guard.current().projectId, 'beta');
  assert.equal(guard.pending(), null);

  const alphaAfterSwitch = guard.decide(alpha, 'navigator.reset');
  assert.equal(alphaAfterSwitch.accept, false);
  assert.equal(alphaAfterSwitch.reason, 'PROJECT_SWITCH_NOT_AUTHORIZED');
});

test('PP-20: switching back replays an unchanged project only after that exact generation is authorised', () => {
  const guard = createQ1ProjectGenerationGuard();
  assert.equal(guard.decide(alpha, 'navigator.reset').accept, true);
  guard.authorizeNext(beta);
  assert.equal(guard.decide(beta, 'navigator.reset').accept, true);

  guard.authorizeNext(alphaReplay);
  const replay = guard.decide(alphaReplay, 'inventory.started');
  assert.equal(replay.accept, true);
  assert.equal(replay.switched, true);
  assert.equal(replay.identity.projectId, 'alpha');
  assert.equal(replay.identity.streamId, 'stream-alpha-replay');
});

test('PP-20: same-generation stream replacement requires a newer boundary', () => {
  const guard = createQ1ProjectGenerationGuard();
  assert.equal(guard.decide(alpha, 'navigator.reset').accept, true);

  const data = guard.decide({ ...alphaReplay, type: 'files.upserted' }, 'files.upserted');
  assert.equal(data.accept, false);
  assert.equal(data.reason, 'STALE_NAVIGATOR_STREAM');

  const rebound = guard.decide(alphaReplay, 'navigator.reset');
  assert.equal(rebound.accept, true);
  assert.equal(rebound.reason, 'STREAM_REBOUND');
  assert.equal(rebound.requiresReset, true);
});

test('PP-20: profile-bound Q1 rejects legacy identity-free events', () => {
  const guard = createQ1ProjectGenerationGuard();
  assert.equal(guard.decide({ type: 'inventory.started' }, 'inventory.started').accept, true);
  assert.equal(guard.decide(alpha, 'navigator.reset').accept, true);
  const legacy = guard.decide({ type: 'files.upserted', payload: { files: [] } }, 'files.upserted');
  assert.equal(legacy.accept, false);
  assert.equal(legacy.reason, 'PROJECT_IDENTITY_MISSING');
});


test('PP-20: identity fields from unrelated nested objects are never combined', () => {
  const malformed = {
    projectId: 'alpha',
    nested: {
      targetRootIdentity: `path:v1:win32:${hash('1')}`,
      deeper: {
        projectProfileHash: `profile:v1:${hash('a')}`,
        profileGeneration: 1,
        recognitionConfigHash: hash('b'),
      },
    },
  };
  assert.equal(q1ProjectGenerationOf(malformed), null);
});

test('PP-20: cancelling activation requires a fresh boundary before Project A may return', () => {
  const guard = createQ1ProjectGenerationGuard();
  assert.equal(guard.decide(alpha, 'navigator.reset').accept, true);
  guard.authorizeNext(beta);
  assert.equal(guard.cancelPending()?.projectId, 'alpha');

  const lateData = guard.decide({ ...alpha, type: 'files.upserted' }, 'files.upserted');
  assert.equal(lateData.accept, false);
  assert.equal(lateData.reason, 'PROJECT_SWITCH_BOUNDARY_REQUIRED');

  const replay = guard.decide(alpha, 'navigator.reset');
  assert.equal(replay.accept, true);
  assert.equal(replay.reason, 'PROJECT_REBOUND');
  assert.equal(replay.requiresReset, true);
});
