/**
 * Graph identity parity — the producer and the record schema must agree.
 *
 * Spec: `CLUE_Architecture_v9.md` — the durable record model; a stored result declares the
 *       grammar that produced it, and reading across grammars must fail closed.
 *       `CLUE_Project_Directory_v9.md` §4.2 — "The TypeScript type system may mirror a
 *       schema but cannot silently become a second wire authority."
 *
 * Backlog: DEV-P1-31 (new item; the defect was found by probe, not from the backlog).
 *          Originally labelled DEV-P1-29 in error — that id is an open cluster-H item
 *          (target + stale docs) and was already taken. Renumbered before the mislabel
 *          could become durable.
 *
 *          `src/shared/schemas.ts` declared `GRAPH_IDENTITY_VERSION =
 *          'identity-v3'` while `src/analysis/source/recognizer.ts` emitted `identity-v4`.
 *          The governed schema rejected the producer's own output, so every recognition
 *          artifact this build wrote was unreadable by this build: `resultOf` threw on the
 *          enum, which broke `rehydrate`, `rehydrateAll`, the incremental merge's
 *          full-oracle parity gate, and the property `graph.ts` asserts in its own header —
 *          that the graph survives losing the database.
 *
 * Why this file exists rather than a comment asking future editors to be careful.
 *
 * The two constants live in different files on purpose: the recognizer names the algorithm
 * it implements, the record schema names the grammar it will accept. That separation is
 * correct — a producer and a wire contract should not be one declaration — but it has a
 * failure mode with no natural detector. A bump to one without the other typechecks, builds,
 * and passes every test that only *writes*. It surfaces only when something reads an
 * artifact back, which in this codebase is rehydration after database loss: the one path
 * that, by construction, nobody exercises until they need it most.
 *
 * Fifteen self-tests did report it, correctly and continuously. They were mistaken for stale
 * expectations left behind by the identity-v4 re-baseline, and the near-miss is the reason
 * this guard is written as a direct statement of the invariant rather than as another
 * downstream test that happens to fail: a test named for the thing it protects is much
 * harder to dismiss than a rehydration test that "must be out of date".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRAPH_IDENTITY_VERSION,
  graphIdentityVersionSchema,
  recognitionBasisSchema,
} from '../src/shared/schemas.js';
import { RECOGNITION_IDENTITY_ALGORITHM } from '../src/analysis/source/recognizer.js';

test('DEV-P1-31: the record schema accepts exactly what the recognizer emits', () => {
  // The invariant, stated once and directly. If a future identity bump changes one constant
  // and not the other, this fails immediately and names both sides.
  assert.equal(
    GRAPH_IDENTITY_VERSION,
    RECOGNITION_IDENTITY_ALGORITHM,
    'src/shared/schemas.ts (GRAPH_IDENTITY_VERSION) and src/analysis/source/recognizer.ts ' +
      '(RECOGNITION_IDENTITY_ALGORITHM) declare the same identity grammar, or nothing this ' +
      'build writes can be read back',
  );

  const accepted = graphIdentityVersionSchema.safeParse(RECOGNITION_IDENTITY_ALGORITHM);
  assert.equal(
    accepted.success,
    true,
    'the governed schema must accept the producer\'s own output',
  );
});

test('DEV-P1-31: a basis carrying the emitted grammar validates', () => {
  // The parity above is necessary but not sufficient: the constant could agree while the
  // schema that consumes it rejects the value for another reason. This drives the actual
  // validation path that `GraphRegistry.resultOf` uses.
  const basis = {
    schemaVersion: 1,
    identityAlgorithm: RECOGNITION_IDENTITY_ALGORITHM,
  } as unknown as Record<string, unknown>;

  const result = recognitionBasisSchema.safeParse(basis);
  const identityIssues = result.success
    ? []
    : result.error.issues.filter((issue) => issue.path[0] === 'identityAlgorithm');

  assert.deepEqual(
    identityIssues,
    [],
    'the identity grammar the recognizer emits must not be the field that fails validation',
  );
});

test('DEV-P1-31: an unrecognised grammar is refused, so reading across grammars fails closed', () => {
  // The other half of the contract, and the reason the enum is a single value rather than a
  // widened list. Unit ids mean different things between grammars, so a graph produced under
  // a grammar this build does not implement must be refused rather than silently compared.
  for (const foreign of ['identity-v3', 'identity-v5', 'identity', '']) {
    assert.equal(
      graphIdentityVersionSchema.safeParse(foreign).success,
      false,
      `${foreign || '<empty>'} is not the grammar in force and must be refused`,
    );
  }
});
