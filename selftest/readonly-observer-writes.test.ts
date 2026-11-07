/**
 * DEV-P0-10 / DEV-P1-38 — a read-only attach must *refuse* writes, not merely avoid making them.
 *
 * Spec: `CLUE_Architecture_v9.md` — one write authority. The event log is the sole authority and
 *       every other surface is derived from it; a runtime that does not hold the writer must not
 *       be able to change durable state by any route.
 *       `CLUE_Project_Directory_v9.md` §9 — projections are rebuildable, which is what makes a
 *       direct projection write dangerous rather than merely irregular: it produces a row the
 *       log cannot justify, and the next rebuild silently deletes it.
 *
 * Backlog: DEV-P0-10 (no mutable observer paths) — the guarantee.
 *          DEV-P1-38 — the reason it now needs a test. Six commands moved to `withLog: false`
 *          across this session, and `runtime.ts` revisions 6 and 7 added three registries to the
 *          read-only branch to let them. Every one of those changes rests on the read-only attach
 *          being genuinely inert.
 *
 * ## Why this file exists
 *
 * `runtime-readonly.test.ts` asserts that a read-only attach **creates no directories**. That is
 * a real guarantee and a different one: it says the observer leaves no footprint, not that it
 * cannot write. Nothing anywhere asserted that a write attempted through a read-only runtime is
 * refused.
 *
 * That gap was noticed while proving revision 7, when an attempt to demonstrate the refusal was
 * rejected by argument validation before it ever reached the store — a good outcome that proves
 * nothing about the guard. The invariant three revisions depend on had no test, and the honest
 * response to "I could not prove it" is to make it provable rather than to assert it anyway.
 *
 * ## What is asserted, and at which layer
 *
 * At the store layer, not through a registry. A registry write has to construct a schema-valid
 * payload, so a refusal there is ambiguous: the schema may have rejected it first, which is what
 * happened during revision 7. Driving the stores directly makes the refusal attributable — the
 * assertion is about the read-only flag and nothing else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ArtifactStore, ArtifactStoreError } from '../src/memory/artifactStore.js';
import { ProjectionStore } from '../src/memory/db.js';

/** A workspace with a real projection database already created by a writable store. */
function workspace(): { root: string; dbPath: string; blobs: string } {
  const root = mkdtempSync(join(tmpdir(), 'clue-observer-'));
  mkdirSync(join(root, 'db'), { recursive: true });
  const dbPath = join(root, 'db', 'clue.db');
  // The file must exist before a read-only open: `fileMustExist: true` is itself part of the
  // guarantee, since an observer that could create a database could create a whole workspace.
  const writable = new ProjectionStore(dbPath, { projectors: {} });
  writable.db.prepare('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, note TEXT)').run();
  writable.db.prepare("INSERT INTO probe (note) VALUES ('written by the writer')").run();
  writable.close();
  return { root, dbPath, blobs: join(root, 'blobs') };
}

/* ------------------------------------------------------------------------- */
/* The projection database                                                    */
/* ------------------------------------------------------------------------- */

test('DEV-P0-10: a read-only projection store can read, and refuses to write', () => {
  const { root, dbPath } = workspace();
  try {
    const projections = new ProjectionStore(dbPath, { projectors: {}, readOnly: true });

    // Reading is the whole point of an observer; a refusal here would be a broken attach rather
    // than a safe one, so it is asserted before the refusals.
    const row = projections.db.prepare('SELECT note FROM probe').get() as { note: string };
    assert.equal(row.note, 'written by the writer');

    // DML and DDL both. A row inserted here would be a projection row no event justifies — and
    // because §9 makes projections rebuildable, the next rebuild would delete it without trace.
    // The failure mode is not a corrupt database; it is a fact that exists until someone rebuilds.
    assert.throws(
      () => projections.db.prepare("INSERT INTO probe (note) VALUES ('written by an observer')").run(),
      /readonly|read-only/iu,
      'an observer must not be able to insert a projection row',
    );
    assert.throws(
      () => projections.db.prepare('DELETE FROM probe').run(),
      /readonly|read-only/iu,
      'an observer must not be able to delete a projection row',
    );
    assert.throws(
      () => projections.db.prepare('CREATE TABLE sneaked (id INTEGER)').run(),
      /readonly|read-only/iu,
      'an observer must not be able to change the projection schema',
    );

    projections.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-10: a read-only projection store will not bring a database into existence', () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-observer-'));
  try {
    mkdirSync(join(root, 'db'), { recursive: true });
    const absent = join(root, 'db', 'clue.db');

    assert.throws(
      () => new ProjectionStore(absent, { projectors: {}, readOnly: true }),
      'a read-only attach to a workspace that has none must fail rather than create one',
    );
    assert.equal(
      existsSync(absent),
      false,
      'the failed read-only open left no database behind',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------- */
/* The artifact store                                                         */
/* ------------------------------------------------------------------------- */

test('DEV-P0-10: a read-only artifact store refuses to store an artifact', () => {
  const { root, blobs } = workspace();
  try {
    const store = new ArtifactStore(blobs, { readOnly: true });

    assert.throws(
      () => store.putJson({ written: 'by an observer' }, { label: 'probe.json' }),
      'a read-only artifact store must not accept an artifact',
    );

    // And it left nothing behind while refusing. A store that half-wrote before failing would
    // produce an orphan blob no artifact reference names — invisible, and indistinguishable from
    // a blob whose reference was lost.
    assert.equal(existsSync(blobs), false, 'the refused write created no blobs directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P0-10: the same store, writable, accepts the identical call', () => {
  // The pair is the argument. Without it, a refusal proves only that `putJson` throws — which
  // could be true for a reason that has nothing to do with the read-only flag, such as a
  // malformed payload. This is the control, and it uses the same value and the same options.
  const { root, blobs } = workspace();
  try {
    const store = new ArtifactStore(blobs);
    const ref = store.putJson({ written: 'by an observer' }, { label: 'probe.json' });

    assert.ok(ref.hash.length > 0, 'a writable store returned a content reference');
    assert.equal(existsSync(blobs), true, 'a writable store created its blob directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------- */
/* How the refusal is achieved                                                */
/* ------------------------------------------------------------------------- */

test('DEV-P1-39: the artifact refusal is a guard, not an absent staging directory', () => {
  // This test replaces one that documented the opposite, and the history is the point.
  //
  // `ArtifactStore` used to refuse only as a side effect: the constructor skipped creating
  // `blobs/.tmp` when read-only, and a write failed later because the staging path did not exist.
  // The outcome was correct and the mechanism was incidental — creating that directory by any
  // other route made a read-only store accept a write, with the flag untouched and every
  // assertion still green. That is what the previous version of this test demonstrated, and it
  // was written to fail the day the weakness was fixed.
  //
  // `ProjectionStore` never had that problem: SQLite is opened `readonly: true`, so the database
  // itself refuses whatever the calling code does. The two stores now refuse for reasons of the
  // same kind, which is why they can be asserted the same way.
  const { root, blobs } = workspace();
  try {
    const store = new ArtifactStore(blobs, { readOnly: true });

    // Create the staging directory behind the store's back, exactly as some other code path
    // might — a writable store opened over the same path earlier in the process, or a manual
    // mkdir. Under the old mechanism this was enough to make the write succeed.
    mkdirSync(join(blobs, '.tmp'), { recursive: true });

    assert.throws(
      () => store.putJson({ written: 'by an observer' }, { label: 'probe.json' }),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactStoreError, `expected ArtifactStoreError, got ${String(error)}`);
        // The code, not the message. Callers dispatch on it, and a refusal that arrives as an
        // ENOENT from the filesystem is indistinguishable from a genuine IO fault.
        assert.equal(error.code, 'READ_ONLY');
        return true;
      },
      'a read-only store must refuse even when it could stage the write',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DEV-P1-39: the refusal precedes the already-stored short-circuit', () => {
  // `commit` returns early when the blob is already present. If the guard sat below that, the
  // same call would throw or succeed according to what someone else had stored earlier — a
  // contract that depends on store contents rather than on how the store was attached.
  //
  // Either answer given consistently is defensible. An answer that varies with history is not.
  const { root, blobs } = workspace();
  try {
    const value = { written: 'by an observer' };
    const options = { label: 'probe.json' };

    // Store it with a writable store first, so the content address is occupied.
    const writable = new ArtifactStore(blobs);
    const ref = writable.putJson(value, options);
    assert.ok(ref.hash.length > 0);

    // The identical call through a read-only store must still be refused, not silently accepted
    // on the grounds that it would have been a no-op.
    const readOnlyStore = new ArtifactStore(blobs, { readOnly: true });
    assert.throws(
      () => readOnlyStore.putJson(value, options),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'READ_ONLY',
      'an already-stored blob must not turn a refusal into a quiet success',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
