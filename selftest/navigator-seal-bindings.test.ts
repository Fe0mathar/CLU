/**
 * Navigator §14.5 seal bindings (DEV-P1-46, carried as DEV-P2-13).
 *
 * Spec: `CLUE_Q1_System_Navigator_v9.md` §14.5 (the eight facts the stream binds) read
 *       against §14.4 (unknown, unsupported, and partial states remain explicit).
 *
 * The backlog of 2026-08-09 records this item as open — five of eight facts bound, three
 * silent. The tree audit of 2026-08-10 found the implementation already present in
 * `navigatorEvents.ts`: `navigatorSealBindings` declares all nine entries (the
 * snapshot/capture bullet names two identities in different states) and `onScanStart`
 * emits the declaration on the stream's first line. What was missing was the pin — a
 * claim of honesty that no test guards is a claim, not a fact. These tests are that pin:
 * the exact facts, the exact states, the named implemented sources behind each `unavailable`,
 * the capture entry's `unavailable`→`bound` flip when a caller supplies the id, and the
 * first-line emission through a real writer to a real file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  NavigatorEventWriter,
  navigatorSealBindings,
} from '../src/analysis/source/navigatorEvents.js';

/* ========================================================================= */
/* The declaration                                                            */
/* ========================================================================= */

test('DEV-P1-46: the declaration states all nine §14.5 entries with their exact states', () => {
  const bindings = navigatorSealBindings({ captureId: null });

  assert.deepEqual(
    bindings.map((binding) => binding.fact),
    [
      'stream schema version',
      'taxonomy version/hash',
      'repository inventory hash',
      'snapshot identity',
      'capture identity',
      'recognition run identity',
      'durable result hash',
      'committed unit/edge counts',
      'inventory file/family/environment counts',
    ],
    'eight bullets, with snapshot/capture split because the two identities differ in state',
  );

  const byFact = new Map(bindings.map((binding) => [binding.fact, binding]));

  for (const fact of [
    'stream schema version',
    'snapshot identity',
    'recognition run identity',
    'durable result hash',
    'committed unit/edge counts',
  ]) {
    const binding = byFact.get(fact);
    assert.ok(binding !== undefined);
    assert.equal(binding.state, 'bound', `${fact} is bound`);
    assert.ok(binding.location !== null, `${fact} names where it is bound`);
    assert.equal(binding.reason, null);
    assert.equal(binding.expectedSource, null);
  }

  // The physical inventory capability exists. A legacy/test writer that is not
  // supplied the inventory reports those facts unavailable — never unsupported and
  // never silently bound. Production recognition supplies the inventory and flips them.
  const unavailable: Record<string, string> = {
    'taxonomy version/hash': 'src/analysis/environments/artifactTaxonomy.ts',
    'repository inventory hash': 'src/analysis/source/repositoryInventory.ts',
    'inventory file/family/environment counts': 'src/analysis/source/repositoryInventory.ts',
  };
  for (const [fact, expectedSource] of Object.entries(unavailable)) {
    const binding = byFact.get(fact);
    assert.ok(binding !== undefined);
    assert.equal(binding.state, 'unavailable', `${fact} is implemented but absent from this writer`);
    assert.equal(binding.location, null);
    assert.ok(binding.reason !== null && binding.reason.length > 0, `${fact} states why`);
    assert.equal(binding.expectedSource, expectedSource, `${fact} names its implemented owner`);
  }

  // Capture identity without a caller-supplied id: implemented elsewhere, unreadable here.
  const capture = byFact.get('capture identity');
  assert.ok(capture !== undefined);
  assert.equal(capture.state, 'unavailable');
  assert.equal(capture.expectedSource, 'src/control/recognitionRun.ts');
});

test('DEV-P1-46: supplying a captureId flips exactly the capture entry to bound', () => {
  const without = navigatorSealBindings({ captureId: null });
  const withId = navigatorSealBindings({ captureId: 'CAP-TEST' });

  assert.equal(withId.length, without.length);
  for (let index = 0; index < withId.length; index += 1) {
    const a = without[index];
    const b = withId[index];
    assert.ok(a !== undefined && b !== undefined);
    if (a.fact === 'capture identity') {
      assert.equal(b.state, 'bound');
      assert.ok(b.location !== null && b.location.includes('captureId'));
      assert.equal(b.reason, null);
      assert.equal(b.expectedSource, null);
    } else {
      assert.deepEqual(b, a, `${a.fact} is unaffected by the capture id`);
    }
  }
});

/* ========================================================================= */
/* First-line emission                                                        */
/* ========================================================================= */

test('DEV-P1-46: scan.started carries the full declaration as the stream\'s first line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clue-nav-seal-'));
  try {
    const writer = new NavigatorEventWriter({
      path: join(dir, 'run.ndjson'),
      projectName: 'seal-binding-test',
      snapshotId: 'SNAP-000001',
      captureId: null,
      runId: 'RUN-SEAL-TEST',
      flushBytes: 1,
    });
    writer.onScanStart({ total: 7 });
    const receipt = writer.close();
    assert.equal(receipt.degraded, false, 'the stream reached disk');
    assert.equal(receipt.eventCount, 1);

    const lines = readFileSync(join(dir, 'run.ndjson'), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    assert.equal(lines.length, 1);
    const first = lines[0];
    assert.ok(first !== undefined);
    const record = JSON.parse(first) as {
      type?: unknown;
      runId?: unknown;
      payload?: { captureId?: unknown; sealBindings?: unknown };
    };
    assert.equal(record.type, 'scan.started');
    assert.equal(record.runId, 'RUN-SEAL-TEST');
    assert.equal(record.payload?.captureId, null);
    assert.deepEqual(
      record.payload?.sealBindings,
      navigatorSealBindings({ captureId: null }),
      'a reader learns what the stream can and cannot claim from its first line',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
