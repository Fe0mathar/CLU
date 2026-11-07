import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  NavigatorEventWriter,
  readCommittedInventoryParity,
  readGraphPointer,
  sealRunStream,
  writeGraphPointer,
  type GraphPointer,
} from '../src/analysis/source/navigatorEvents.js';
import {
  captureRepositoryInventory,
  type RepositoryInventory,
} from '../src/analysis/source/repositoryInventory.js';
import { captureSnapshot } from '../src/analysis/source/snapshot.js';

const repositoryId = 'fixture-project';
const runId = 'c437b0d3-e48d-482e-9d1a-0d6d20421fc9';
const graphSha256 = 'a'.repeat(64);
const resultHash = 'b'.repeat(64);

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'clue-navigator-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const target = join(root, 'target');
  const src = join(target, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'index.ts'), 'export const one = 1;\n');
  writeFileSync(join(target, 'README.md'), '# Fixture\n');
  writeFileSync(join(target, 'config.json'), '{}\n');
  const sourceRoots = ['src'];
  const recognitionSnapshot = captureSnapshot({ root: target, sourceRoots, exclude: [] });
  const inventory = captureRepositoryInventory({
    root: target, repositoryId, projectName: 'Fixture',
    recognitionSourceRoots: sourceRoots, recognitionSnapshotId: recognitionSnapshot.id,
    exclude: [],
  });
  return { live: join(root, 'workspace', 'graph', 'system-navigator.ndjson'), recognitionSnapshot, inventory };
}

function commitInventory(
  live: string,
  inventory: RepositoryInventory,
  enrich?: (writer: NavigatorEventWriter) => void,
) {
  const writer = new NavigatorEventWriter({
    path: live,
    projectName: 'Fixture',
    snapshotId: inventory.recognitionSnapshotId,
    runId,
    inventory,
    awaitCommit: true,
  });
  writer.publishRepositoryInventory();
  enrich?.(writer);
  writer.graphCommitting();
  const receipt = writer.graphCommitted({
    recognitionRecordId: null, graphSha256, resultHash, unitCount: 1, edgeCount: 0, unresolvedCount: 0,
  });
  const sealed = sealRunStream(live, receipt);
  assert.equal(sealed.outcome, 'placed');
  assert.ok(receipt.physicalInventory, 'a complete sealed inventory supplies physical evidence');
  const pointer: GraphPointer = {
    runId, snapshotId: inventory.recognitionSnapshotId, resultHash, graphSha256,
    committedAt: new Date().toISOString(), stream: 'streams/' + runId + '.ndjson',
    streamSha256: receipt.sha256, streamBytes: receipt.bytesWritten, streamEventCount: receipt.eventCount,
    degraded: false, unitCount: 1, edgeCount: 0, unresolvedCount: 0,
    physicalInventory: receipt.physicalInventory,
  };
  writeGraphPointer(live, pointer);
  const restored = readGraphPointer(live);
  assert.deepEqual(restored, pointer, 'committed pointer round-trips its same-run inventory evidence');
  return { pointer, archive: sealed.path };
}

test('Gate 38 compares visible physical inventory and ALL from one sealed run', (t) => {
  const { live, inventory, recognitionSnapshot } = fixture(t);
  assert.equal(recognitionSnapshot.files.length, 1);
  assert.equal(inventory.counts.files, 3);
  assert.notEqual(inventory.snapshotId, recognitionSnapshot.id, 'physical and semantic scopes have distinct identities');

  const { pointer } = commitInventory(live, inventory);
  assert.deepEqual(pointer.physicalInventory, {
    repositoryId,
    snapshotId: inventory.snapshotId,
    inventoryHash: inventory.inventoryHash,
    expectedFileCount: 3,
    allFileCount: 3,
    identityConsistent: true,
  });
  assert.equal(readCommittedInventoryParity(live, pointer, repositoryId), true);
});

test('Gate 38 is unevaluated for legacy, degraded, misattributed or truncated evidence', (t) => {
  const { live, inventory } = fixture(t);
  const { pointer, archive } = commitInventory(live, inventory);
  const { physicalInventory: _ignored, ...legacy } = pointer;
  writeGraphPointer(live, legacy);
  assert.deepEqual(readGraphPointer(live), legacy, 'old pointers remain readable');

  assert.equal(readCommittedInventoryParity(live, legacy, repositoryId), null);
  assert.equal(readCommittedInventoryParity(live, { ...pointer, degraded: true }, repositoryId), null);
  assert.equal(readCommittedInventoryParity(live, { ...pointer, stream: null }, repositoryId), null);
  assert.equal(readCommittedInventoryParity(live, { ...pointer, stream: '../system-navigator.ndjson' }, repositoryId), null);
  assert.equal(readCommittedInventoryParity(live, pointer, 'another-project'), null);
  writeFileSync(archive, 'truncated\n');
  assert.equal(readCommittedInventoryParity(live, pointer, repositoryId), null);
});

test('Gate 38 fails when a sealed physical stream repeats a file identity', (t) => {
  const { live, inventory } = fixture(t);
  const duplicate = inventory.files[0];
  assert.ok(duplicate);
  const { pointer } = commitInventory(live, { ...inventory, files: [...inventory.files, duplicate] });
  assert.equal(pointer.physicalInventory?.expectedFileCount, 3);
  assert.equal(pointer.physicalInventory?.allFileCount, 3, 'deduplication alone must not hide the duplicate');
  assert.equal(pointer.physicalInventory?.identityConsistent, false);
  assert.equal(readCommittedInventoryParity(live, pointer, repositoryId), false);
});

test('Gate 38 fails when semantic enrichment adds an unregistered physical identity', (t) => {
  const { live, inventory } = fixture(t);
  const file = inventory.files[0];
  assert.ok(file);
  const { pointer } = commitInventory(live, inventory, (writer) => {
    writer.publishRepositoryEnrichment({
      files: [{ ...file, path: 'unexpected.ts', fileLocationId: 'c'.repeat(64) }],
      summaries: [], edges: [],
    });
  });
  assert.equal(pointer.physicalInventory?.expectedFileCount, 3);
  assert.equal(pointer.physicalInventory?.identityConsistent, false);
  assert.equal(readCommittedInventoryParity(live, pointer, repositoryId), false);
});
