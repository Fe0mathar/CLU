/**
 * System Navigator recognition-stream acceptance tests.
 *
 * Spec: CLUE_Implementation_v3.md §24.3 (live recognition observer — non-authoritative,
 *       non-blocking) and §14.5 (append-only, versioned Navigator stream). These are the
 *       behavioral memory (CLUE_v3.md, "a test is the memory of a behavior") for the
 *       observer seam and the durable writer, including the writer's observer-error
 *       recording and error redaction, run identity (`runId`), and the durable-commit
 *       protocol (`graph.committing` / `graph.committed`) that makes completion
 *       provisional until the graph is persisted (§24.3; Zasada 17 / A4).
 *
 * Every replayed line is validated against `navigatorEnvelopeSchema`, the one definition
 * the writer owns, so a drift in the wire shape fails a test rather than a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  NavigatorEventWriter,
  NavigatorStreamError,
  graphPointerPath,
  navigatorEnvelopeSchema,
  pruneRunStreams,
  readGraphPointer,
  runStreamPath,
  sealRunStream,
  writeGraphPointer,
  type NavigatorEnvelope,
  type NavigatorStreamReceipt,
} from '../src/analysis/source/navigatorEvents.js';
import { parseGraphPointer } from '../src/daemon/runtimeRegistrySource.js';
import { recognize, type RecognitionObserver } from '../src/analysis/source/recognizer.js';

/** A tiny two-file project with one import and one call, so an edge is guaranteed. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-navigator-'));
  const files: Readonly<Record<string, string>> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
      },
      include: ['src'],
    }),
    'src/a.ts': 'export function a(): number { return 1; }\n',
    'src/b.ts': "import { a } from './a';\nexport function b(): number { return a(); }\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

/** Reads a stream and validates every line against the owned envelope schema. */
function readStream(path: string): readonly NavigatorEnvelope[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => navigatorEnvelopeSchema.parse(JSON.parse(line)));
}

test('recognizer publishes deterministic file, unit and edge observations', () => {
  const root = fixture();
  try {
    const observed: string[] = [];
    const observer: RecognitionObserver = {
      onScanStart: ({ total }) => observed.push(`start:${total}`),
      onFileStart: ({ path }) => observed.push(`file:${path}`),
      onUnit: (unit) => observed.push(`unit:${unit.logicalId}`),
      onEdge: (edge) => observed.push(`edge:${edge.kind}:${edge.from}:${edge.to}`),
      onFileComplete: ({ path }) => observed.push(`done:${path}`),
      onScanComplete: (result) =>
        observed.push(`complete:${result.units.length}:${result.edges.length}`),
    };

    const result = recognize({
      projectRoot: root,
      tsconfigPath: join(root, 'tsconfig.json'),
      observer,
    });

    // Scan start is first and reports both project files.
    assert.equal(observed[0], 'start:2');
    // The unit and the call edge both appeared in the stream.
    assert.ok(observed.some((entry) => entry.includes('unit:src/a.ts#a')));
    assert.ok(observed.some((entry) => entry.startsWith('edge:calls:')));
    // Scan complete is last and carries the same totals as the returned result.
    assert.equal(observed.at(-1), `complete:${result.units.length}:${result.edges.length}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NavigatorEventWriter creates a complete replayable NDJSON stream', () => {
  const root = fixture();
  const output = join(root, 'workspace', 'graph', 'system-navigator.ndjson');
  try {
    const writer = new NavigatorEventWriter({
      path: output,
      projectName: 'Murugan',
      snapshotId: 'snapshot-test',
      cinematic: true,
    });
    const result = recognize({
      projectRoot: root,
      tsconfigPath: join(root, 'tsconfig.json'),
      observer: writer,
    });

    const events = readStream(output);

    assert.equal(events[0]?.type, 'scan.started');
    assert.equal(events.at(-1)?.type, 'scan.completed');
    assert.equal(events.at(-1)?.snapshotId, 'snapshot-test');
    assert.equal(
      events.filter((event) => event.type === 'unit.discovered').length,
      result.units.length,
    );
    assert.equal(
      events.filter((event) => event.type === 'edge.discovered').length,
      result.edges.length,
    );
    // Sequence is monotonic from zero across the whole stream.
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index),
    );
    // Run identity is present, distinct from the snapshot, and constant across the stream.
    const runId = events[0]?.runId;
    assert.ok(typeof runId === 'string' && runId.length > 0, 'every run carries a runId');
    assert.equal(runId, writer.runId, 'the stream runId matches the writer');
    assert.notEqual(runId, 'snapshot-test', 'run identity is not the snapshot identity');
    assert.ok(
      events.every((event) => event.runId === runId),
      'runId is constant across every line of one run',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable-commit mode makes completion provisional until graph.committed seals the stream', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-navigator-commit-'));
  const output = join(root, 'run.ndjson');
  const unit = { logicalId: 'a#f' } as never;
  try {
    const writer = new NavigatorEventWriter({
      path: output,
      projectName: 'Murugan',
      snapshotId: 'snapshot-commit',
      awaitCommit: true,
    });

    writer.onScanStart({ total: 1 });
    writer.onUnit(unit);
    writer.onScanComplete({ units: [unit], edges: [], unresolved: [], stats: {} } as never);
    // The stream is still open here: in commit mode, scan.completed is provisional.
    writer.graphCommitting();
    writer.graphCommitted({
      recognitionRecordId: 'rec_000001',
      graphSha256: 'a'.repeat(64),
      unitCount: 1,
      edgeCount: 0,
      unresolvedCount: 0,
    });
    // The stream is sealed: a second commit must be a silent no-op, never a second line.
    writer.graphCommitted({
      recognitionRecordId: 'rec_should_not_appear',
      graphSha256: 'b'.repeat(64),
      unitCount: 9,
      edgeCount: 9,
      unresolvedCount: 9,
    });

    const events = readStream(output);

    // The commit pair follows a provisional completion, in order.
    assert.deepEqual(
      events.map((event) => event.type),
      ['scan.started', 'unit.discovered', 'scan.completed', 'graph.committing', 'graph.committed'],
    );
    // Completion is worded as provisional in commit mode, not as final recognition.
    const completed = events.find((event) => event.type === 'scan.completed');
    assert.equal(completed?.payload['status'], 'SCAN COMPLETE · COMMITTING GRAPH');
    // Only graph.committed asserts committed knowledge, and it carries the graph linkage.
    const committed = events.at(-1);
    assert.equal(committed?.payload['status'], 'RECOGNITION COMMITTED');
    assert.equal(committed?.payload['recognitionRecordId'], 'rec_000001');
    assert.equal(committed?.payload['graphSha256'], 'a'.repeat(64));
    // The seal is final: exactly one graph.committed regardless of repeated calls.
    assert.equal(
      events.filter((event) => event.type === 'graph.committed').length,
      1,
      'graph.committed seals the stream; a duplicate is dropped',
    );
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default mode preserves close-on-complete and does not emit commit events', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-navigator-legacy-'));
  const output = join(root, 'run.ndjson');
  try {
    const writer = new NavigatorEventWriter({
      path: output,
      projectName: 'Murugan',
      snapshotId: 'snapshot-legacy',
    });
    writer.onScanStart({ total: 0 });
    writer.onScanComplete({ units: [], edges: [], unresolved: [], stats: {} } as never);
    // With no commit step, the stream closed on completion; a late commit is a no-op.
    writer.graphCommitted({
      recognitionRecordId: 'x',
      graphSha256: 'c'.repeat(64),
      unitCount: 0,
      edgeCount: 0,
      unresolvedCount: 0,
    });

    const events = readStream(output);
    assert.deepEqual(
      events.map((event) => event.type),
      ['scan.started', 'scan.completed'],
    );
    assert.equal(events.at(-1)?.payload['status'], 'RECOGNITION COMPLETE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('observer errors and scan failures are recorded and redacted', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-navigator-err-'));
  const output = join(root, 'stream.ndjson');
  const secret = 'sk-PLANTED-SECRET-0123456789';
  try {
    const writer = new NavigatorEventWriter({
      path: output,
      projectName: 'Murugan',
      snapshotId: 'snapshot-err',
      env: { OPENAI_API_KEY: secret },
    });

    writer.onScanStart({ total: 0 });
    // What the recognizer's isolation seam calls when an observer method throws.
    writer.onObserverError({
      operation: 'unit',
      error: new Error(`boom leaking ${secret} across\nmultiple\nlines`),
    });
    // A scan-level failure, which closes the stream.
    writer.fail(new Error(`fatal error exposing ${secret}`));

    const raw = readFileSync(output, 'utf8');
    assert.ok(!raw.includes(secret), 'a secret must never reach the stream');
    assert.ok(raw.includes('«OPENAI_API_KEY»'), 'the redaction marker replaces the secret');

    const events = readStream(output);
    assert.ok(
      events.some((event) => event.type === 'observer.error'),
      'an observer error is recorded as its own event',
    );
    // fail() emits a terminal scan.completed and closes the stream.
    assert.equal(events.at(-1)?.type, 'scan.completed');
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
/* ------------------------------------------------------------------------- */
/* DEV-P1-06 — sealing, stream hash, observable failure, retention            */
/* ------------------------------------------------------------------------- */

/**
 * These prove the four obligations of DEV-P1-06 against real files: the stream hash is a
 * hash of the stream (not of the graph record), the seal refuses a stream it cannot
 * verify, a writer that cannot write says so instead of reporting success, and retention
 * is bounded without ever removing the run the pointer names.
 */

/** Drives one minimal commit-mode run and returns its receipt. */
function committedRun(
  output: string,
  overrides: Partial<Parameters<NavigatorEventWriter['graphCommitted']>[0]> = {},
): NavigatorStreamReceipt {
  const unit = { logicalId: 'a#f' } as never;
  const writer = new NavigatorEventWriter({
    path: output,
    projectName: 'Murugan',
    snapshotId: 'snapshot-seal',
    awaitCommit: true,
  });
  writer.onScanStart({ total: 1 });
  writer.onUnit(unit);
  writer.onScanComplete({ units: [unit], edges: [], unresolved: [], stats: {} } as never);
  writer.graphCommitting();
  return writer.graphCommitted({
    recognitionRecordId: null,
    graphSha256: 'a'.repeat(64),
    resultHash: 'b'.repeat(64),
    unitCount: 1,
    edgeCount: 0,
    unresolvedCount: 0,
    ...overrides,
  });
}

test('DEV-P1-06: the receipt hash is the hash of the stream, and the seal binds it', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-nav-hash-'));
  const output = join(root, 'graph', 'system-navigator.ndjson');
  try {
    const receipt = committedRun(output);

    const bytes = readFileSync(output);
    // The writer's accumulated hash is over the bytes that are actually on the file.
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(receipt.bytesWritten, bytes.byteLength);
    assert.equal(receipt.sealed, true);
    assert.equal(receipt.degraded, false);
    assert.equal(receipt.droppedEvents, 0);

    // The committed event carries the stream's own prefix hash — hashing everything
    // before that line — so a replayer can verify the stream from inside the stream.
    const events = readStream(output);
    const committed = events.at(-1);
    assert.equal(committed?.type, 'graph.committed');
    const text = readFileSync(output, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const prefix = `${lines.slice(0, -1).join('\n')}\n`;
    assert.equal(
      committed?.payload['streamPrefixSha256'],
      createHash('sha256').update(Buffer.from(prefix, 'utf8')).digest('hex'),
      'streamPrefixSha256 is recomputable by a replayer from the stream itself',
    );
    assert.equal(receipt.prefixSha256, committed?.payload['streamPrefixSha256']);
    // The graph record fingerprint and the stream hash are different values with
    // different meanings, and are no longer conflated.
    assert.notEqual(committed?.payload['graphSha256'], receipt.sha256);
    assert.equal(committed?.payload['runId'], receipt.runId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-06: sealing places an immutable record, never replaces it, and refuses an unverifiable stream', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-nav-seal-'));
  const output = join(root, 'graph', 'system-navigator.ndjson');
  try {
    const receipt = committedRun(output);

    const first = sealRunStream(output, receipt);
    assert.equal(first.outcome, 'placed');
    assert.equal(first.path, runStreamPath(output, receipt.runId));
    assert.equal(first.sha256, receipt.sha256);
    // The sealed record is byte-identical to the live stream it preserves.
    assert.deepEqual(readFileSync(first.path), readFileSync(output));

    // A per-run record is immutable: re-sealing reports the existing record and leaves it.
    const before = readFileSync(first.path);
    const second = sealRunStream(output, receipt);
    assert.equal(second.outcome, 'exists');
    assert.deepEqual(readFileSync(first.path), before);

    // The seal is a check, not a copy: a live stream that no longer matches the writer's
    // hash is refused rather than preserved as though it were the run's record.
    // Tampering that preserves the byte count, so only the hash can catch it — a length
    // check alone would let a same-size substitution through.
    const tampered = join(root, 'graph', 'tampered.ndjson');
    const mutated = Buffer.from(readFileSync(output));
    const target = mutated.indexOf(Buffer.from('Murugan', 'utf8'));
    assert.ok(target > 0, 'the fixture contains a byte to flip');
    mutated.write('MuruganX'.slice(0, 7), target, 'utf8');
    mutated[target] = mutated[target] === 0x4d ? 0x6d : 0x4d;
    writeFileSync(tampered, mutated);
    assert.equal(mutated.byteLength, receipt.bytesWritten, 'the tamper preserves the length');
    assert.throws(
      () => sealRunStream(tampered, { ...receipt, runId: 'tampered-run' }),
      (error: unknown) =>
        error instanceof NavigatorStreamError && /refusing to seal/.test((error as Error).message),
      'a stream that changed underneath the writer must not be sealed',
    );
    assert.equal(
      existsSync(runStreamPath(tampered, 'tampered-run')),
      false,
      'a refused seal leaves no record behind',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-06: the pointer is validated before it is written and round-trips to the console reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-nav-pointer-'));
  const output = join(root, 'graph', 'system-navigator.ndjson');
  try {
    const receipt = committedRun(output);
    sealRunStream(output, receipt);

    const pointer = {
      runId: receipt.runId,
      snapshotId: 'snapshot-seal',
      resultHash: 'b'.repeat(64),
      graphSha256: 'a'.repeat(64),
      committedAt: new Date().toISOString(),
      stream: `streams/${receipt.runId}.ndjson`,
      streamSha256: receipt.sha256,
      streamBytes: receipt.bytesWritten,
      streamEventCount: receipt.eventCount,
      degraded: false,
      unitCount: 1,
      edgeCount: 0,
      unresolvedCount: 0,
    } as const;
    writeGraphPointer(output, pointer);

    assert.deepEqual(readGraphPointer(output), pointer);
    // Cross-module parity: what this module writes is exactly what the console's own
    // reader trusts. Two definitions that could drift are proved to agree here.
    const trusted = parseGraphPointer(readFileSync(graphPointerPath(output), 'utf8'));
    assert.equal(trusted?.runId, receipt.runId);
    assert.equal(trusted?.resultHash, 'b'.repeat(64));

    // An invalid pointer is refused, and the previously valid one survives untouched.
    assert.throws(
      () => writeGraphPointer(output, { ...pointer, resultHash: 'not-a-hash' }),
      NavigatorStreamError,
    );
    assert.deepEqual(readGraphPointer(output), pointer, 'a refused write never damages the pointer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-06: a writer that cannot write degrades observably instead of throwing or claiming success', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-nav-degraded-'));
  // A directory cannot be opened for writing: the stream can never be created.
  const output = join(root, 'occupied');
  mkdirSync(output, { recursive: true });
  try {
    let writer: NavigatorEventWriter | null = null;
    assert.doesNotThrow(() => {
      writer = new NavigatorEventWriter({
        path: output,
        projectName: 'Murugan',
        snapshotId: 'snapshot-degraded',
        awaitCommit: true,
      });
    }, 'telemetry that cannot start must not abort the recognition it only observes');
    const created = writer as unknown as NavigatorEventWriter;

    created.onScanStart({ total: 2 });
    created.onUnit({ logicalId: 'a#f' } as never);
    created.onUnit({ logicalId: 'a#g' } as never);
    const receipt = created.graphCommitted({
      recognitionRecordId: null,
      graphSha256: 'a'.repeat(64),
      unitCount: 2,
      edgeCount: 0,
      unresolvedCount: 0,
    });

    assert.equal(receipt.degraded, true, 'the failure is stated, not swallowed');
    assert.equal(receipt.sealed, false, 'a degraded stream is never reported as sealed');
    assert.equal(receipt.eventCount, 0, 'no event reached the file');
    assert.equal(receipt.bytesWritten, 0);
    assert.ok(receipt.writeFailures >= 1);
    assert.ok(
      receipt.droppedEvents >= 4,
      `every refused event is counted (got ${receipt.droppedEvents})`,
    );
    assert.ok(
      typeof receipt.lastError === 'string' && receipt.lastError.length > 0,
      'the reason is carried, redacted, on the receipt',
    );
    // And the seal refuses a degraded run rather than inventing a record for it.
    assert.throws(() => sealRunStream(output, receipt), NavigatorStreamError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-06: retention is bounded, protects the pointed-at run, and reports what it removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-nav-retention-'));
  const output = join(root, 'graph', 'system-navigator.ndjson');
  const streams = join(root, 'graph', 'streams');
  try {
    mkdirSync(streams, { recursive: true });
    // Six sealed streams, oldest first, plus one unrelated file that must be left alone.
    const runIds = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6'];
    runIds.forEach((runId, index) => {
      const path = join(streams, `${runId}.ndjson`);
      writeFileSync(path, `${'x'.repeat(1000)}\n`, 'utf8');
      utimesSync(path, new Date(1_700_000_000_000 + index * 1000), new Date(1_700_000_000_000 + index * 1000));
    });
    writeFileSync(join(streams, 'README.txt'), 'not a stream\n', 'utf8');

    // The pointer names the OLDEST run — exactly the one a naive keep-newest-N would drop.
    writeGraphPointer(output, {
      runId: 'run-1',
      snapshotId: 'snapshot-retention',
      resultHash: 'c'.repeat(64),
      graphSha256: 'd'.repeat(64),
      committedAt: new Date().toISOString(),
      stream: 'streams/run-1.ndjson',
      streamSha256: 'e'.repeat(64),
      streamBytes: 1001,
      streamEventCount: 1,
      degraded: false,
      unitCount: 0,
      edgeCount: 0,
      unresolvedCount: 0,
    });

    const retention = pruneRunStreams(output, { keep: 2 });

    assert.equal(retention.scanned, 6, 'only .ndjson files are candidates');
    assert.ok(
      existsSync(join(streams, 'README.txt')),
      'an unrelated file in the directory is never removed',
    );
    assert.ok(
      existsSync(join(streams, 'run-1.ndjson')),
      'the run the pointer names survives regardless of age',
    );
    assert.deepEqual(retention.protectedRunIds, ['run-1']);
    // Newest two, plus the protected oldest.
    assert.ok(existsSync(join(streams, 'run-6.ndjson')));
    assert.ok(existsSync(join(streams, 'run-5.ndjson')));
    assert.equal(existsSync(join(streams, 'run-4.ndjson')), false);
    assert.equal(existsSync(join(streams, 'run-2.ndjson')), false);
    assert.equal(retention.removed.length, 3);
    assert.equal(retention.bytesReclaimed, 3 * 1001);
    assert.deepEqual(retention.failures, []);

    // A byte budget removes further, still never touching the protected run.
    const tightened = pruneRunStreams(output, { keep: 8, maxBytes: 1500 });
    assert.ok(existsSync(join(streams, 'run-1.ndjson')), 'the budget cannot evict the pointer');
    assert.equal(tightened.removed.length, 1, 'the oldest unprotected stream goes first');
    assert.equal(existsSync(join(streams, 'run-6.ndjson')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
