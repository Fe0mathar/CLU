/**
 * `DEV-P1-21` — the Console Ledger against the real event log.
 *
 * This file exists because nothing constructed a `ConsoleLedger` before it. The module is
 * 906 lines and `beginSession` threw on its first call in every workspace: it minted
 * `CSESS-000001` as an event `subject_id` while `CSESS` was not a registered entity family,
 * so `entityIdSchema` rejected it. `ingest`, `classify`, the four projectors and the
 * cleanliness report were all unreachable behind that throw, and a clean `tsc` plus 453
 * passing tests said nothing about it — a compiler cannot see a string literal fail a
 * runtime regex, and no test had ever asked.
 *
 * What is held here is the seam that was broken: a real ledger, a real append-only log, a
 * real projection store, and one round trip through them. The remaining three clauses of
 * the obligation — the ordered raw-batch manifest, the checkpoint and run bindings, and
 * attribution revision history — are not yet built and are deliberately not asserted here.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConsoleLedger,
  CONSOLE_PROJECTORS,
  ensureConsoleSchema,
  type Attributor,
  type RawConsoleEntry,
} from '../src/experiment/console/consoleLedger.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { parseEntityId } from '../src/shared/ids.js';

interface Stack {
  readonly root: string;
  readonly ledger: ConsoleLedger;
  readonly projections: ProjectionStore;
  readonly log: EventLog;
  /** Flips the attributor mid-test, which is how an attribution comes to be revised. */
  readonly attributed: { value: boolean };
  dispose(): void;
}

function entry(
  text: string,
  scenarioId: string | null,
  checkpointId: string | null = null,
): RawConsoleEntry {
  return {
    level: 'error',
    text,
    frames: [
      { url: 'http://localhost:5173/src/world.ts', line: 42, column: 7, functionName: 'tick' },
    ],
    timestamp: '2026-08-09T12:00:00.000Z',
    scenarioId,
    stepIndex: null,
    checkpointId,
  };
}

function openStack(attributed = false): Stack {
  const root = mkdtempSync(join(tmpdir(), 'clue-console-ledger-'));
  const workspace = join(root, 'workspace');
  for (const directory of ['db', 'events', 'blobs']) {
    mkdirSync(join(workspace, directory), { recursive: true });
  }

  const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'), {
    projectors: CONSOLE_PROJECTORS,
  });
  ensureConsoleSchema(projections.db);
  const { log } = EventLog.open(join(workspace, 'events'));

  // A holder rather than a constant, because a revision only exists where an attribution
  // changed: the test flips this between ingests to make a source map "arrive".
  const attributedState = { value: attributed };
  const attributor: Attributor = () =>
    attributedState.value
      ? {
          outcome: 'attributed',
          logicalId: 'unit:src/world.ts#tick',
          path: 'src/world.ts',
          line: 42,
          detail: 'source map resolved the top frame',
        }
      : {
          outcome: 'unattributable',
          logicalId: null,
          path: null,
          line: null,
          detail: 'no attributor configured; source-map resolution has not run',
        };

  const ledger = new ConsoleLedger({
    log,
    projections,
    artifacts: new ArtifactStore(join(workspace, 'blobs')),
    missionVersion: () => 'MISSION-000001',
    attributor,
  });

  return {
    root,
    ledger,
    projections,
    log,
    attributed: attributedState,
    dispose(): void {
      log.close();
      projections.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('DEV-P1-21: a console session is a registered entity, so the ledger can open one', () => {
  const stack = openStack();
  try {
    // The mechanism. `entityIdSchema` builds its pattern from ENTITY_PREFIXES, so an
    // unregistered family is not merely unparseable — it is rejected at every append.
    assert.deepEqual(parseEntityId('CSESS-000001'), { kind: 'consoleSession', sequence: 1 });

    const session = stack.ledger.beginSession({
      snapshotId: 'a'.repeat(64),
      scenarioId: 'SCEN-boot',
      origin: 'shadow',
    });

    assert.match(session.id, /^CSESS-[0-9]{6,}$/);
    assert.equal(session.origin, 'shadow');
    assert.equal(session.ended_at, null);
    assert.equal(session.entry_count, 0);

    // It reached the projection, which means the event was appended and replayed, not
    // merely constructed in memory.
    assert.deepEqual(stack.ledger.session(session.id), session);
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: a batch ingests end to end and the raw entries survive the round trip', () => {
  const stack = openStack();
  try {
    const session = stack.ledger.beginSession({ scenarioId: 'SCEN-boot', origin: 'shadow' });
    const result = stack.ledger.ingest(session.id, [
      entry('failed to load tile 47', 'SCEN-boot'),
      entry('failed to load tile 92', 'SCEN-boot'),
      entry('shader compilation failed', 'SCEN-boot'),
    ]);

    // The two tile messages differ only by a number, which normalisation removes.
    assert.equal(result.entriesIngested, 3);
    assert.equal(result.signaturesTouched, 2, 'the varying number is not part of the signature');
    assert.equal(result.newSignatures.length, 2);
    assert.equal(result.byClassification.unclassified, 3, 'no attributor means nothing is filed');

    const after = stack.ledger.session(session.id);
    assert.equal(after?.entry_count, 3);
    assert.equal(after?.error_count, 3);
    assert.notEqual(after?.raw_log_hash, null, 'the batch is stored before it is summarised');

    // The lossy half is recoverable: the exact text, including the number normalisation
    // threw away, comes back from the artifact the session points at.
    const raw = stack.ledger.rawEntries(session.id);
    assert.deepEqual(
      raw.map((item) => item.text),
      ['failed to load tile 47', 'failed to load tile 92', 'shader compilation failed'],
    );
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: an attributed entry is filed, and cleanliness names what blocks it', () => {
  const stack = openStack(true);
  try {
    const session = stack.ledger.beginSession({ scenarioId: 'SCEN-boot', origin: 'shadow' });
    stack.ledger.ingest(session.id, [entry('failed to load tile 47', 'SCEN-boot')]);

    const signatures = stack.ledger.signatures({});
    assert.equal(signatures.length, 1);
    assert.equal(signatures[0]?.attribution_outcome, 'attributed');
    assert.equal(signatures[0]?.attributed_to, 'unit:src/world.ts#tick');
    assert.equal(signatures[0]?.classification, 'actionable');

    const report = stack.ledger.cleanliness();
    assert.equal(report.clean, false);
    assert.equal(report.actionable, 1);
    assert.equal(report.blocking.length, 1, 'a report that cannot name the blocker is an opinion');
    assert.match(report.qualifier, /not a claim that the application emits nothing/);
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: triage is sticky — a later ingest does not overturn a recorded judgement', () => {
  const stack = openStack(true);
  try {
    const session = stack.ledger.beginSession({ scenarioId: 'SCEN-boot', origin: 'shadow' });
    stack.ledger.ingest(session.id, [entry('probe: frame budget 16ms', 'SCEN-boot')]);

    const signature = stack.ledger.signatures({})[0]?.signature;
    assert.ok(signature !== undefined);
    stack.ledger.classify(signature, 'intentional', 'CLU-E probe output, declared');

    stack.ledger.ingest(session.id, [entry('probe: frame budget 16ms', 'SCEN-boot')]);

    const after = stack.ledger.signatures({})[0];
    assert.equal(after?.classification, 'intentional', 'the judgement is the point');
    assert.equal(after?.intentional_reason, 'CLU-E probe output, declared');
    assert.equal(after?.triaged, true);
    assert.equal(stack.ledger.cleanliness().clean, true, 'declared diagnostics do not block');
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: a signature seen in two scenarios keeps both, within one batch', () => {
  const stack = openStack(true);
  try {
    const session = stack.ledger.beginSession({ origin: 'shadow' });
    // One problem, two scenarios, one batch. The two tile messages differ only by a number,
    // so they share a signature — which is exactly the case that used to lose a scenario.
    const result = stack.ledger.ingest(session.id, [
      entry('failed to load tile 47', 'SCEN-boot'),
      entry('failed to load tile 92', 'SCEN-boot'),
      entry('failed to load tile 13', 'SCEN-combat'),
    ]);

    assert.equal(result.signaturesTouched, 1, 'two scenarios are still one problem');
    assert.equal(result.newSignatures.length, 1);

    const sightings = stack.projections.db
      .prepare('SELECT scenario_id, occurrences FROM console_sightings ORDER BY scenario_id')
      .all() as { scenario_id: string | null; occurrences: number }[];
    assert.deepEqual(sightings, [
      { scenario_id: 'SCEN-boot', occurrences: 2 },
      { scenario_id: 'SCEN-combat', occurrences: 1 },
    ]);

    const signature = stack.ledger.signatures({})[0];
    assert.equal(signature?.scenario_count, 2, 'reproducing in two scenarios is the finding');
    assert.equal(signature?.session_count, 1, 'two sightings are still one session');
    assert.equal(signature?.occurrences, 3);
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: scenario-less sightings collapse to one row rather than fragmenting', () => {
  const stack = openStack(true);
  try {
    const session = stack.ledger.beginSession({ origin: 'external' });
    stack.ledger.ingest(session.id, [
      entry('failed to load tile 47', null),
      entry('failed to load tile 92', null),
    ]);
    stack.ledger.ingest(session.id, [entry('failed to load tile 13', null)]);

    // SQLite treats NULLs as distinct in a unique constraint, so the key indexes
    // ifnull(scenario_id, ''). Without that, each of these would have inserted a fresh row
    // and the occurrence count would have fragmented across them.
    const sightings = stack.projections.db
      .prepare('SELECT scenario_id, occurrences FROM console_sightings')
      .all() as { scenario_id: string | null; occurrences: number }[];
    assert.deepEqual(sightings, [{ scenario_id: null, occurrences: 3 }]);

    const signature = stack.ledger.signatures({})[0];
    assert.equal(signature?.scenario_count, 0, 'absence is counted as absence, not as a scenario');
    assert.equal(signature?.session_count, 1);
    assert.equal(signature?.occurrences, 3);
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: one signature across two sessions counts sessions, not rows', () => {
  const stack = openStack(true);
  try {
    const first = stack.ledger.beginSession({ origin: 'shadow' });
    stack.ledger.ingest(first.id, [
      entry('failed to load tile 47', 'SCEN-boot'),
      entry('failed to load tile 92', 'SCEN-combat'),
    ]);
    const second = stack.ledger.beginSession({ origin: 'shadow' });
    stack.ledger.ingest(second.id, [entry('failed to load tile 13', 'SCEN-boot')]);

    const signature = stack.ledger.signatures({})[0];
    const rows = stack.projections.db
      .prepare('SELECT COUNT(*) AS n FROM console_sightings')
      .get() as { n: number };

    // Three sighting rows, two sessions, two scenarios. Counting rows would report three
    // sessions - the overcount that widening the key would otherwise have introduced.
    assert.equal(rows.n, 3);
    assert.equal(signature?.session_count, 2);
    assert.equal(signature?.scenario_count, 2);
    assert.equal(signature?.occurrences, 3);
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: two batches into one session are both reachable, in order', () => {
  const stack = openStack(true);
  try {
    const session = stack.ledger.beginSession({ origin: 'shadow' });
    stack.ledger.ingest(session.id, [entry('failed to load tile 47', 'SCEN-boot')]);
    stack.ledger.ingest(session.id, [
      entry('failed to load tile 92', 'SCEN-boot'),
      entry('shader compilation failed', 'SCEN-boot'),
    ]);

    const manifest = stack.ledger.batches(session.id);
    assert.equal(manifest.length, 2, 'a session that ingested twice collected two batches');
    assert.deepEqual(
      manifest.map((batch) => batch.sequence),
      [1, 2],
      'the manifest is ordered, and the order is recorded rather than inferred',
    );
    assert.deepEqual(
      manifest.map((batch) => batch.entry_count),
      [1, 2],
    );
    assert.notEqual(manifest[0]?.artifact_hash, manifest[1]?.artifact_hash);

    // The defect this clause exists for: the session reported two entries and could
    // produce one, because the newest batch had overwritten the only pointer.
    const after = stack.ledger.session(session.id);
    const raw = stack.ledger.rawEntries(session.id);
    assert.equal(after?.entry_count, 3);
    assert.equal(raw.length, 3, 'what the session counted is what it can produce');
    assert.deepEqual(
      raw.map((item) => item.text),
      ['failed to load tile 47', 'failed to load tile 92', 'shader compilation failed'],
    );
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: a recorded batch cannot be re-pointed at different bytes', () => {
  const stack = openStack(true);
  try {
    const session = stack.ledger.beginSession({ origin: 'shadow' });
    stack.ledger.ingest(session.id, [entry('failed to load tile 47', 'SCEN-boot')]);

    const original = stack.ledger.batches(session.id)[0];
    assert.ok(original !== undefined);

    // A replayed or forged event claiming sequence 1 for other bytes. The projector inserts
    // and never updates, so the manifest entry stands; immutability is a property of the
    // projector, not of the table.
    const projector = CONSOLE_PROJECTORS['console.batch_recorded'];
    assert.ok(projector !== undefined);
    projector(stack.projections.db, {
      payload: {
        session_id: session.id,
        sequence: 1,
        captured_at: '2026-08-09T13:00:00.000Z',
        artifact_hash: 'b'.repeat(64),
        entry_count: 99,
      },
    } as never);

    assert.deepEqual(stack.ledger.batches(session.id), [original]);
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: a re-attributed signature keeps both answers, and repeats add none', () => {
  const stack = openStack();
  try {
    const session = stack.ledger.beginSession({ origin: 'shadow' });
    // Twice with no attributor: one revision, because a revision is a change and this is a
    // repetition. `occurrences` is where repetition belongs.
    stack.ledger.ingest(session.id, [entry('failed to load tile 47', 'SCEN-boot')]);
    stack.ledger.ingest(session.id, [entry('failed to load tile 92', 'SCEN-boot')]);

    const signature = stack.ledger.signatures({})[0]?.signature;
    assert.ok(signature !== undefined);
    assert.equal(stack.ledger.attributionHistory(signature).length, 1);

    // A source map arrives and the same signature resolves.
    stack.attributed.value = true;
    stack.ledger.ingest(session.id, [entry('failed to load tile 13', 'SCEN-boot')]);

    const history = stack.ledger.attributionHistory(signature);
    assert.deepEqual(
      history.map((item) => [item.revision, item.attribution_outcome]),
      [
        [1, 'unattributable'],
        [2, 'attributed'],
      ],
      'the earlier answer survives the better one',
    );
    assert.equal(history[0]?.attributed_to, null);
    assert.equal(history[1]?.attributed_to, 'unit:src/world.ts#tick');
    assert.equal(history[1]?.session_id, session.id, 'a revision names when it happened');

    // The current answer is still the latest, unchanged by keeping the history.
    assert.equal(stack.ledger.signatures({})[0]?.attribution_outcome, 'attributed');
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: returning to a previous attribution is a new revision, not a merge', () => {
  const stack = openStack();
  try {
    const session = stack.ledger.beginSession({ origin: 'shadow' });
    stack.ledger.ingest(session.id, [entry('failed to load tile 47', 'SCEN-boot')]);
    stack.attributed.value = true;
    stack.ledger.ingest(session.id, [entry('failed to load tile 92', 'SCEN-boot')]);
    stack.attributed.value = false;
    stack.ledger.ingest(session.id, [entry('failed to load tile 13', 'SCEN-boot')]);

    const signature = stack.ledger.signatures({})[0]?.signature;
    assert.ok(signature !== undefined);
    // Flattening A-B-A to A-B would lose the fact that B was ever believed, which is the
    // thing a later reader needs in order to distrust it.
    assert.deepEqual(
      stack.ledger.attributionHistory(signature).map((item) => item.attribution_outcome),
      ['unattributable', 'attributed', 'unattributable'],
    );
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: the history survives losing the database, because the events carry it', () => {
  const stack = openStack();
  try {
    const session = stack.ledger.beginSession({ origin: 'shadow' });
    stack.ledger.ingest(session.id, [entry('failed to load tile 47', 'SCEN-boot')]);
    stack.attributed.value = true;
    stack.ledger.ingest(session.id, [entry('failed to load tile 92', 'SCEN-boot')]);

    const signature = stack.ledger.signatures({})[0]?.signature;
    assert.ok(signature !== undefined);
    const before = stack.ledger.attributionHistory(signature);
    assert.equal(before.length, 2);

    // A full rebuild replays the log from nothing. The history is derived, so it has to
    // come back identical — including the revision numbers, which are assigned during
    // replay rather than stored in the events.
    stack.projections.rebuild(stack.log);
    assert.deepEqual(stack.ledger.attributionHistory(signature), before);
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: a signature at two checkpoints of one scenario keeps both', () => {
  const stack = openStack(true);
  try {
    const session = stack.ledger.beginSession({ origin: 'shadow' });
    stack.ledger.ingest(session.id, [
      entry('failed to load tile 47', 'SCEN-boot', 'CHK-01'),
      entry('failed to load tile 92', 'SCEN-boot', 'CHK-01'),
      entry('failed to load tile 13', 'SCEN-boot', 'CHK-07'),
    ]);

    const sightings = stack.projections.db
      .prepare(
        'SELECT scenario_id, checkpoint_id, occurrences FROM console_sightings ORDER BY checkpoint_id',
      )
      .all() as { scenario_id: string | null; checkpoint_id: string | null; occurrences: number }[];
    assert.deepEqual(sightings, [
      { scenario_id: 'SCEN-boot', checkpoint_id: 'CHK-01', occurrences: 2 },
      { scenario_id: 'SCEN-boot', checkpoint_id: 'CHK-07', occurrences: 1 },
    ]);

    const signature = stack.ledger.signatures({})[0];
    // One scenario, two checkpoints, one session: the finer split must not inflate either
    // of the coarser counts.
    assert.equal(signature?.scenario_count, 1);
    assert.equal(signature?.session_count, 1);
    assert.equal(signature?.occurrences, 3);
  } finally {
    stack.dispose();
  }
});

test('DEV-P1-21: a checkpoint-less sighting stays one row beside a labelled one', () => {
  const stack = openStack(true);
  try {
    const session = stack.ledger.beginSession({ origin: 'shadow' });
    stack.ledger.ingest(session.id, [
      entry('failed to load tile 47', 'SCEN-boot', null),
      entry('failed to load tile 92', 'SCEN-boot', null),
      entry('failed to load tile 13', 'SCEN-boot', 'CHK-01'),
    ]);

    // Absence is one bucket, not one bucket per entry — the ifnull() in the key — and it is
    // a different bucket from any named checkpoint.
    const sightings = stack.projections.db
      .prepare('SELECT checkpoint_id, occurrences FROM console_sightings ORDER BY checkpoint_id')
      .all() as { checkpoint_id: string | null; occurrences: number }[];
    assert.deepEqual(sightings, [
      { checkpoint_id: null, occurrences: 2 },
      { checkpoint_id: 'CHK-01', occurrences: 1 },
    ]);
  } finally {
    stack.dispose();
  }
});
