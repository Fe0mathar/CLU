/**
 * The evidence spine (progress recommendation v2, §7).
 *
 * Proves the two guarantees the spine exists to give: sealing is deterministic and a full chain
 * verifies link by link; and tampering anywhere in the chain — a mutated ancestor, a link bound to the
 * wrong predecessor, or a link bound to the wrong *kind* of predecessor — is refused. Also proves the
 * branded-identifier validators and the strict link parser fail closed on malformed input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashText } from '../src/shared/ids.js';
import {
  sealLink,
  verifyLink,
  verifyChain,
  parseEvidenceLink,
  requireSpineHash,
  requireSpineId,
  asSpineHash,
  EvidenceChainError,
  EvidenceIdentityError,
  type MissionLink,
  type SnapshotLink,
  type RecognitionLink,
  type TaskLink,
  type ContextLink,
  type PacketLink,
  type EvidenceLink,
} from '../src/shared/evidenceIdentity.js';

function buildChain(): {
  mission: MissionLink;
  snapshot: SnapshotLink;
  recognition: RecognitionLink;
  task: TaskLink;
  context: ContextLink;
  packet: PacketLink;
  chain: EvidenceLink[];
} {
  const mission: MissionLink = {
    stage: 'mission',
    boundTo: null,
    missionBasisHash: asSpineHash(hashText('mission-basis'), 'MissionBasisHash'),
  };
  const snapshot: SnapshotLink = {
    stage: 'snapshot',
    boundTo: sealLink(mission),
    snapshotContentId: asSpineHash(hashText('snapshot-content'), 'SnapshotContentId'),
    manifestHash: asSpineHash(hashText('manifest'), 'ManifestHash'),
    captureId: requireSpineId('CAPTURE-000001', 'CaptureId'),
  };
  const recognition: RecognitionLink = {
    stage: 'recognition',
    boundTo: sealLink(snapshot),
    recognitionRunId: requireSpineId('RUN-000001', 'RecognitionRunId'),
    recognitionStateKey: asSpineHash(hashText('state-key'), 'RecognitionStateKey'),
    resultHash: asSpineHash(hashText('result'), 'ResultHash'),
    artifactHash: asSpineHash(hashText('artifact'), 'ArtifactHash'),
  };
  const task: TaskLink = {
    stage: 'task',
    boundTo: sealLink(recognition),
    taskId: requireSpineId('TASK-000001', 'TaskId'),
    attempt: 1,
    leaseTokenHash: asSpineHash(hashText('lease-token'), 'LeaseTokenHash'),
    leaseExpiry: '2026-01-01T00:00:00.000Z',
  };
  const context: ContextLink = {
    stage: 'context',
    boundTo: sealLink(task),
    contextBasisHash: asSpineHash(hashText('context-basis'), 'ContextBasisHash'),
  };
  const packet: PacketLink = {
    stage: 'packet',
    boundTo: sealLink(context),
    packetBasisHash: asSpineHash(hashText('packet-basis'), 'PacketBasisHash'),
    bundleHash: asSpineHash(hashText('bundle'), 'BundleHash'),
    outputSchemaAuthorityHash: asSpineHash(hashText('schema-authority'), 'OutputSchemaAuthorityHash'),
  };
  return { mission, snapshot, recognition, task, context, packet, chain: [mission, snapshot, recognition, task, context, packet] };
}

test('sealing a link is deterministic', () => {
  const { mission } = buildChain();
  assert.equal(sealLink(mission), sealLink(mission));
  assert.match(sealLink(mission), /^[0-9a-f]{64}$/);
});

test('a well-formed chain verifies link by link', () => {
  const { snapshot, mission, recognition, packet, chain } = buildChain();
  assert.doesNotThrow(() => verifyLink(snapshot, mission));
  assert.doesNotThrow(() => verifyLink(recognition, snapshot));
  // The whole chain verifies and returns the leaf's binding hash.
  assert.equal(verifyChain(chain), sealLink(packet));
});

test('a link bound to the wrong predecessor hash is refused', () => {
  const { snapshot, recognition } = buildChain();
  // recognition binds to the snapshot; verifying it against the (different) mission-derived snapshot
  // with a rewritten boundTo must fail.
  const forged: SnapshotLink = { ...snapshot, boundTo: asSpineHash(hashText('some-other-seal'), 'BindingHash') };
  assert.throws(() => verifyLink(recognition, forged), EvidenceChainError);
});

test('a link bound to the wrong KIND of predecessor is refused', () => {
  const { recognition, mission } = buildChain();
  // A recognition link must bind to a snapshot, not directly to a mission.
  assert.throws(() => verifyLink(recognition, mission), EvidenceChainError);
});

test('mutating any ancestor invalidates the descendant chain', () => {
  const { mission, snapshot, chain } = buildChain();
  // Tamper with the mission after the snapshot already recorded its boundTo.
  const tamperedMission: MissionLink = { ...mission, missionBasisHash: asSpineHash(hashText('tampered'), 'MissionBasisHash') };
  // The snapshot's stored boundTo now points at a mission seal that no longer reproduces.
  assert.throws(() => verifyLink(snapshot, tamperedMission), EvidenceChainError);
  // And the whole chain, rebuilt with the tampered mission at the head, breaks at the first link.
  const tamperedChain: EvidenceLink[] = [tamperedMission, ...chain.slice(1)];
  assert.throws(() => verifyChain(tamperedChain), EvidenceChainError);
});

test('a chain that does not begin with a mission is refused', () => {
  const { chain } = buildChain();
  assert.throws(() => verifyChain(chain.slice(1)), EvidenceChainError);
});

test('the strict link parser accepts a valid link and rejects malformed input', () => {
  const { mission } = buildChain();
  const parsed = parseEvidenceLink(JSON.parse(JSON.stringify(mission)));
  assert.equal(parsed.stage, 'mission');

  // Unknown key.
  assert.throws(() => parseEvidenceLink({ ...mission, extra: 'x' }));
  // Malformed hash.
  assert.throws(() => parseEvidenceLink({ stage: 'mission', boundTo: null, missionBasisHash: 'not-a-hash' }));
  // Wrong shape for the stage (a mission link must bind to null).
  assert.throws(() => parseEvidenceLink({ stage: 'mission', boundTo: 'a'.repeat(64), missionBasisHash: 'b'.repeat(64) }));
});

test('the branded-identifier validators fail closed', () => {
  assert.throws(() => requireSpineHash('not-hex', 'MissionBasisHash'), EvidenceIdentityError);
  assert.throws(() => requireSpineHash('ABCDEF', 'MissionBasisHash'), EvidenceIdentityError); // uppercase
  assert.throws(() => requireSpineId('', 'TaskId'), EvidenceIdentityError);
  assert.equal(requireSpineHash('a'.repeat(64), 'MissionBasisHash'), 'a'.repeat(64));
  assert.equal(requireSpineId('TASK-1', 'TaskId'), 'TASK-1');
});
