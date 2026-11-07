/**
 * Status history acceptance tests.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §17 (atomic exports, content hashes, retention policy,
 *       `clue status diff`), §18, §20 gate 9 (exports survive restart and validate
 *       independently). Directory §22 — `workspace/status/` holds sealed snapshots and
 *       history indexes.
 *
 * Backlog: DEV-P1-14.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { projectStatus, type ProjectStatusOptions } from '../src/status/statusProjector.js';
import {
  StatusHistoryError,
  diffStatus,
  loadRetainedStatus,
  pruneStatusHistory,
  readStatusHistory,
  retainStatus,
  statusHistoryDirectory,
} from '../src/status/history.js';
import { parseStatusSnapshot, type StatusSnapshot } from '../src/status/statusContractV5.js';
import { verifySeal } from '../src/status/statusSeal.js';
import type { RegistrySource } from '../src/daemon/consoleStateCollector.js';

const SNAPSHOT = 'b'.repeat(64);
const RESULT = 'c'.repeat(64);

function source(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    currentMission: () => ({
      missionId: 'MISSION-000001',
      title: 'CLUE',
      constitutionHash: 'd'.repeat(64),
      lastChange: 'initial',
    }),
    latestSnapshot: () => ({
      snapshotId: SNAPSHOT,
      fileCount: 3,
      capturedAt: '2026-08-06T00:00:00.000Z',
      languageCensus: { typescript: 3 },
    }),
    recognitionFor: () => ({
      snapshotId: SNAPSHOT,
      resultHash: RESULT,
      unitCount: 9,
      edgeCount: 4,
      unresolvedCount: 0,
      filesInProgram: 3,
      filesRecognised: 3,
      semanticDiagnostics: 0,
      moduleCount: 3,
      classDistribution: {
        'monofile-monodependency': 3,
        'monofile-polydependency': 0,
        'polyfile-monodependency': 0,
        'polyfile-polydependency': 0,
      },
    }),
    runIdForSnapshot: () => 'RUN-1',
    configReadiness: () => ({ ready: true, sections: [] }) as never,
    stateSources: () => ['events:0-42'],
    ...overrides,
  } as RegistrySource;
}

function options(capturedAt: string): ProjectStatusOptions {
  return {
    capturedAt,
    targetId: 'TGT-CLUE',
    targetName: 'CLU-E',
    canonicalRoot: '/repo',
    missionBasisHash: 'e'.repeat(64),
    recognizerVersion: 'clue-recognizer/4',
    catalogue: {
      version: '6.0',
      hash: 'f'.repeat(64),
      activeCount: 100,
      reservedCount: 0,
      coordinatesUnique: true,
      productionReady: true,
    },
    q1: null,
    provenance: {
      eventLogFrom: 0,
      eventLogTo: 42,
      projectionVersion: 'clue.projections/7',
      goldenDefinitionHash: null,
    },
  };
}

const snapshotAt = (at: string, src: RegistrySource = source()): StatusSnapshot =>
  projectStatus(src, options(at)).snapshot;

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'clue-status-history-'));
}

test('DEV-P1-14: a retained snapshot survives a restart and validates independently', () => {
  const root = workspace();
  try {
    // §20 gate 9. "Independently" is the operative word: the file is re-read from disk with
    // nothing carried over from the process that wrote it.
    const original = snapshotAt('2026-08-06T00:00:00.000Z');
    const retained = retainStatus(root, original);

    const reloaded = loadRetainedStatus(retained.path);
    assert.deepEqual(reloaded, original, 'the body round-trips exactly');
    assert.equal(verifySeal(reloaded).valid, true, 'and its seal verifies on its own');
    assert.equal(reloaded.seal.statusHash, retained.statusHash);

    // The file lives where Directory §22 says sealed snapshots live.
    assert.ok(retained.path.startsWith(statusHistoryDirectory(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-14: a snapshot whose seal does not verify is refused, not stored and flagged', () => {
  const root = workspace();
  try {
    const good = snapshotAt('2026-08-06T00:00:00.000Z');
    // A body altered after sealing. Storing it would put a snapshot into the history that
    // `clue status validate` will later reject — history whose contents fail the check the
    // history exists to support.
    const tampered = { ...good, sources: ['events:tampered'] } as StatusSnapshot;

    assert.throws(() => retainStatus(root, tampered), StatusHistoryError);
    assert.deepEqual(
      readStatusHistory(root).entries,
      [],
      'a refused snapshot leaves nothing behind',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-14: the index is derived from the files, so it cannot drift from them', () => {
  const root = workspace();
  try {
    retainStatus(root, snapshotAt('2026-08-06T00:00:00.000Z'));
    const second = retainStatus(root, snapshotAt('2026-08-07T00:00:00.000Z'));
    assert.equal(readStatusHistory(root).entries.length, 2);

    // Delete a file behind the module's back — the failure mode a stored index would hide
    // forever, because the index is the thing you would ask.
    rmSync(second.path, { force: true });
    const after = readStatusHistory(root);
    assert.equal(after.entries.length, 1, 'the index reflects what is actually on disk');
    assert.equal(after.entries[0]?.generatedAt, '2026-08-06T00:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-14: newest first, and an unreadable file is reported rather than skipped', () => {
  const root = workspace();
  try {
    retainStatus(root, snapshotAt('2026-08-06T00:00:00.000Z'));
    retainStatus(root, snapshotAt('2026-08-08T00:00:00.000Z'));
    retainStatus(root, snapshotAt('2026-08-07T00:00:00.000Z'));

    mkdirSync(statusHistoryDirectory(root), { recursive: true });
    writeFileSync(join(statusHistoryDirectory(root), 'status-broken.json'), '{ not json', 'utf8');

    const history = readStatusHistory(root);
    assert.deepEqual(
      history.entries.map((entry) => entry.generatedAt),
      ['2026-08-08T00:00:00.000Z', '2026-08-07T00:00:00.000Z', '2026-08-06T00:00:00.000Z'],
    );
    assert.equal(history.unreadable.length, 1, 'a corrupt file is a fact about the workspace');
    assert.ok(history.unreadable[0]?.reason.length ?? 0 > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-14: retention is bounded, protects by hash, and never deletes what it cannot read', () => {
  const root = workspace();
  try {
    const oldest = retainStatus(root, snapshotAt('2026-08-01T00:00:00.000Z'));
    retainStatus(root, snapshotAt('2026-08-02T00:00:00.000Z'));
    retainStatus(root, snapshotAt('2026-08-03T00:00:00.000Z'));
    retainStatus(root, snapshotAt('2026-08-04T00:00:00.000Z'));

    const brokenPath = join(statusHistoryDirectory(root), 'status-broken.json');
    writeFileSync(brokenPath, '{ not json', 'utf8');

    // The oldest is protected by hash — exactly the one keep-newest-N would drop first.
    const receipt = pruneStatusHistory(root, { keep: 2, protect: [oldest.statusHash] });

    assert.equal(receipt.removed.length, 1);
    assert.ok(receipt.bytesReclaimed > 0);
    assert.deepEqual(receipt.failures, []);

    const remaining = readStatusHistory(root).entries.map((entry) => entry.generatedAt);
    assert.deepEqual(remaining, [
      '2026-08-04T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);

    // The unreadable file is the one most likely to be evidence of a real problem. A
    // retention pass that tidied it away would erase the symptom and leave the cause.
    assert.equal(readStatusHistory(root).unreadable.length, 1);
    assert.ok(readFileSync(brokenPath, 'utf8').length > 0, 'it is still there');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-14: diff separates a coverage regression from a changed value', () => {
  // The distinction the whole diff exists for. A branch that went from backed to
  // unavailable means something that was being observed no longer is; reporting that
  // identically to a changed number would bury the one result an operator needs.
  const before = snapshotAt('2026-08-06T00:00:00.000Z');
  const after = snapshotAt(
    '2026-08-06T00:00:00.000Z',
    source({ recognitionFor: () => null }),
  );

  const diff = diffStatus(before, after);
  assert.equal(diff.identical, false);
  assert.equal(diff.schemaChanged, false);

  const recognition = diff.branches.find((entry) => entry.branch === 'recognition');
  assert.equal(recognition?.change, 'lost');
  assert.match(String(recognition?.detail), /no longer backed/);

  // And the reverse direction is `gained`, not merely `changed`.
  const reverse = diffStatus(after, before);
  assert.equal(reverse.branches.find((entry) => entry.branch === 'recognition')?.change, 'gained');
});

test('DEV-P1-14: two projections of unchanged state diff to nothing', () => {
  // The control case. If this ever reports a change, either the projector is
  // non-deterministic or the diff is comparing something it should not.
  const at = '2026-08-06T00:00:00.000Z';
  const diff = diffStatus(snapshotAt(at), snapshotAt(at));
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.branches, []);
});

test('DEV-P1-14: a changed reason on an unavailable branch is not silently unchanged', () => {
  const at = '2026-08-06T00:00:00.000Z';
  const before = snapshotAt(at, source({ recognitionFor: () => null }));
  const after = snapshotAt(
    at,
    source({
      recognitionFor: () => {
        throw new Error('graph projection table is missing');
      },
    }),
  );

  const diff = diffStatus(before, after);
  const recognition = diff.branches.find((entry) => entry.branch === 'recognition');
  assert.equal(
    recognition?.change,
    'reason_changed',
    'both are unavailable, but "no record yet" and "the table is gone" are different facts',
  );
  assert.match(String(recognition?.detail), /→/);
});

test('DEV-P1-14: the retained file is a complete, parseable status snapshot on disk', () => {
  const root = workspace();
  try {
    const retained = retainStatus(root, snapshotAt('2026-08-06T00:00:00.000Z'));
    // Not via the module's own loader: straight from the bytes, the way an external tool or
    // a future CLU-E instance would read it.
    const raw = JSON.parse(readFileSync(retained.path, 'utf8')) as unknown;
    const parsed = parseStatusSnapshot(raw);
    assert.equal(parsed.schemaVersion, '5.8.0');
    assert.equal(verifySeal(parsed).valid, true);
    assert.equal(retained.bytes, readFileSync(retained.path).byteLength);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-14: a tampered body is never reported identical, and diff agrees with validate', () => {
  // Found empirically: `diff` originally compared the hashes the seals *claimed*, so a body
  // altered after sealing — which keeps its original seal — was reported identical while
  // `status validate` reported HASH_MISMATCH on the same file. Two commands disagreeing
  // about one pair of files, and the reassuring one was the wrong one.
  const original = snapshotAt('2026-08-06T00:00:00.000Z');
  const tampered = { ...original, sources: ['events:tampered'] } as StatusSnapshot;

  const diff = diffStatus(original, tampered);
  assert.equal(diff.identical, false, 'identity is decided by re-digesting, not by trusting the seal');
  assert.equal(verifySeal(tampered).valid, false, 'and validate agrees');

  // The changed member is reported as a branch, not silently excluded as noise.
  assert.ok(diff.branches.some((entry) => entry.branch === 'sources'));
});

test('DEV-P1-14: a change to the capability declaration is surfaced, not ignored', () => {
  // Gate 26 changes are exactly what a comparison between two runs should show: a branch
  // that stopped being backed changes both the branch and the declaration, and hiding the
  // latter would understate the former.
  const before = snapshotAt('2026-08-06T00:00:00.000Z');
  const after = snapshotAt('2026-08-06T00:00:00.000Z', source({ recognitionFor: () => null }));

  const diff = diffStatus(before, after);
  assert.ok(diff.branches.some((entry) => entry.branch === 'capability'));
  assert.ok(diff.branches.some((entry) => entry.branch === 'recognition' && entry.change === 'lost'));
});
