/**
 * Graph-pointer parity tests.
 *
 * Spec: the CLU deep review, Integrity Patch 0 — pointer schema/hash parity. The
 *       `graph/current.json` pointer is a writer-owned convenience file, and before this
 *       arc it was read permissively: any object was accepted, and the only guard was
 *       snapshot-name equality, so a stale pointer left by an earlier commit could
 *       attribute that old run to a newly committed graph the run never produced. These
 *       tests pin the corrected contract from both ends: the reader validates exactly
 *       the claims it relies on, and attribution happens only under matching identity.
 *
 * The parity core is exported as pure functions precisely so it can be pinned here
 * without a database or a Runtime — the class around it is a thin I/O shell, and the
 * live end-to-end (recognize → pointer on disk → console attribution) is a declared
 * TARGET-HOST step.
 *
 * Run: npm run selftest
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGraphPointer,
  pointerRunIdFor,
  type TrustedGraphPointer,
} from '../src/daemon/runtimeRegistrySource.js';
import type { ProjectRecognitionIdentity } from '../src/shared/projectRecognitionIdentity.js';

const RESULT_HASH = 'a'.repeat(64);
const SNAPSHOT_ID = 's'.repeat(64);
const PROJECT_RECOGNITION: ProjectRecognitionIdentity = {
  identityVersion: 'clue-project-recognition-identity/1',
  operationIdentity: {
    projectId: 'alpha',
    targetRootIdentity: 'path:v1:linux:' + 'c'.repeat(64),
    projectProfileHash: 'profile:v1:' + 'd'.repeat(64),
  },
  profileGeneration: 1,
  recognitionConfigHash: 'e'.repeat(64),
};

function validPointer(): TrustedGraphPointer {
  return { runId: 'run-7f3a', snapshotId: SNAPSHOT_ID, resultHash: RESULT_HASH };
}

test('the pointer schema trusts exactly the claims the console relies on', () => {
  // A valid pointer parses to its three trusted claims and nothing else.
  const parsed = parseGraphPointer(JSON.stringify(validPointer()));
  assert.deepEqual(parsed, validPointer());

  // Writer decoration (stream path, counts, timestamps) is ignored, not rejected —
  // the file is the writer's; the reader owns only what it trusts.
  const decorated = parseGraphPointer(
    JSON.stringify({
      ...validPointer(),
      stream: 'streams/run-7f3a.ndjson',
      committedAt: '2026-07-27T12:00:00.000Z',
      unitCount: 10,
    }),
  );
  assert.equal(decorated?.runId, 'run-7f3a');

  // A pointer that cannot state the trusted claims is treated as ABSENT, never guessed
  // at. The first case is the exact pre-parity writer shape: a derived fingerprint
  // (`graphSha256`) but no `resultHash` — the intermediate this arc deliberately
  // declared while the writer caught up.
  assert.equal(
    parseGraphPointer(
      JSON.stringify({ runId: 'run-7f3a', snapshotId: SNAPSHOT_ID, graphSha256: RESULT_HASH }),
    ),
    null,
    'pre-parity pointers read as absent',
  );
  assert.equal(parseGraphPointer('{not json'), null, 'malformed JSON reads as absent');
  assert.equal(
    parseGraphPointer(JSON.stringify({ ...validPointer(), runId: 7 })),
    null,
    'a wrong-typed claim reads as absent',
  );
  assert.equal(
    parseGraphPointer(JSON.stringify({ ...validPointer(), runId: '' })),
    null,
    'an empty claim reads as absent',
  );
  assert.equal(
    parseGraphPointer(JSON.stringify({ ...validPointer(), resultHash: 'Z'.repeat(64) })),
    null,
    'a non-hex parity anchor reads as absent',
  );
});

test('the refusal ladder never attributes on a guess', () => {
  // Every rung refuses rather than substitutes: a run id is only meaningful as “the run
  // that produced THIS committed graph”.
  assert.equal(
    pointerRunIdFor(validPointer(), SNAPSHOT_ID, RESULT_HASH),
    'run-7f3a',
    'matching snapshot and matching record hash attribute the run',
  );
  assert.equal(pointerRunIdFor(null, SNAPSHOT_ID, RESULT_HASH), null, 'no pointer');
  assert.equal(
    pointerRunIdFor(validPointer(), 'x'.repeat(64), RESULT_HASH),
    null,
    'a pointer naming another snapshot',
  );
  assert.equal(
    pointerRunIdFor(validPointer(), SNAPSHOT_ID, null),
    null,
    'no committed record — nothing exists to attribute to',
  );
  // The misattribution scenario this arc exists to close: a new commit changed the
  // record's hash, and the old pointer must not claim the new graph.
  assert.equal(
    pointerRunIdFor(validPointer(), SNAPSHOT_ID, 'b'.repeat(64)),
    null,
    'a stale pointer never attributes an old run to a new graph',
  );
});

test("the writer's payload round-trips into attribution, and only the anchor grants it", () => {
  // The exact shape cli/index.ts writes on commit: parity anchor, replay fingerprint,
  // and human/dashboard convenience together.
  const written = JSON.stringify(
    {
      runId: 'run-7f3a',
      snapshotId: SNAPSHOT_ID,
      resultHash: RESULT_HASH,
      graphSha256: 'f'.repeat(64),
      committedAt: '2026-07-27T12:00:00.000Z',
      stream: 'streams/run-7f3a.ndjson',
      unitCount: 10,
      edgeCount: 20,
      unresolvedCount: 0,
    },
    null,
    2,
  );

  const pointer = parseGraphPointer(written);
  assert.ok(pointer !== null, 'the written pointer validates');
  assert.equal(
    pointerRunIdFor(pointer, SNAPSHOT_ID, RESULT_HASH),
    'run-7f3a',
    'a fresh pointer attributes its run',
  );
  // The fingerprint is derived over the record for stream-replay purposes; it is
  // deliberately NOT the parity anchor, and treating it as one must fail.
  assert.equal(
    pointerRunIdFor(pointer, SNAPSHOT_ID, 'f'.repeat(64)),
    null,
    'the replay fingerprint does not grant attribution',
  );
});

test('PP-20: run attribution requires exact project recognition identity when profile-bound', () => {
  const pointer: TrustedGraphPointer = { ...validPointer(), projectRecognition: PROJECT_RECOGNITION };
  assert.equal(
    pointerRunIdFor(pointer, SNAPSHOT_ID, RESULT_HASH, PROJECT_RECOGNITION),
    'run-7f3a',
  );
  assert.equal(
    pointerRunIdFor(
      pointer,
      SNAPSHOT_ID,
      RESULT_HASH,
      { ...PROJECT_RECOGNITION, profileGeneration: 2 },
    ),
    null,
  );
  assert.equal(
    pointerRunIdFor(validPointer(), SNAPSHOT_ID, RESULT_HASH, PROJECT_RECOGNITION),
    null,
    'profile-bound readers reject identity-free legacy pointers',
  );
});

