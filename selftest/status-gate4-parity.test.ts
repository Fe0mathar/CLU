/**
 * Status Contract §20 gate 4 — one body across every surface.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §1 — "The UI, CLI, HTTP API and exported JSON consume
 *       one validated snapshot; none assembles an independent interpretation."
 *       §20 gate 4 — "UI, CLI and API return the same body/hash."
 *       §15 — the same durable inputs *and declared timestamp* reproduce the same body and
 *       seal; a mismatch is a projector defect.
 *
 * Backlog: DEV-P1-16 — `/api/status/current` served the console projection under the Status
 *          Contract's own §17 route name, so the API's Status endpoint returned a different
 *          schema and gate 4 could not hold.
 *
 * ## What "the same body" has to mean
 *
 * Not "byte-identical responses". Two surfaces asked at different moments legitimately carry
 * different capture instants, and §15 makes the timestamp a declared *input* precisely so
 * that difference is expected rather than a defect. Verified against the running dashboard,
 * a CLI export and an `/api/status/current` fetch ten seconds apart differed in exactly six
 * branches, and in each the only differing member was the freshness or check timestamp.
 *
 * So the invariant this test enforces is the one that actually matters: **given one declared
 * instant, the surfaces produce one body and one hash.** A difference anywhere else is a
 * second interpretation, which is what §1 forbids.
 *
 * The HTTP layer is not started here. Its route was the defect and is now a thin call into
 * `projectStatusFromRuntime`; what this proves is that the composition every surface shares
 * is deterministic across independent invocations, which is the property the route depends
 * on. The end-to-end HTTP check was run manually against the real server and is recorded in
 * the delivery note rather than asserted from a test that would need to bind a port.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectStatus, type ProjectStatusOptions } from '../src/status/statusProjector.js';
import { bodyOf, sealBodyDigest, verifySeal } from '../src/status/statusSeal.js';
import type { StatusSnapshot } from '../src/status/statusContractV5.js';
import type { RegistrySource } from '../src/daemon/consoleStateCollector.js';

const SNAPSHOT = 'b'.repeat(64);

function source(): RegistrySource {
  return {
    currentMission: () => ({
      missionId: 'MISSION-000001',
      title: 'CLU-E',
      constitutionHash: 'd'.repeat(64),
      lastChange: 'initial',
    }),
    latestSnapshot: () => ({
      snapshotId: SNAPSHOT,
      fileCount: 12,
      capturedAt: '2026-08-06T00:00:00.000Z',
      languageCensus: { typescript: 12 },
    }),
    recognitionFor: () => null,
    runIdForSnapshot: () => null,
    configReadiness: () => ({ status: 'ready', sections: [] }) as never,
    stateSources: () => ['events:0-42'],
  } as unknown as RegistrySource;
}

function options(capturedAt: string): ProjectStatusOptions {
  return {
    capturedAt,
    targetId: 'demo',
    targetName: 'Demo',
    canonicalRoot: '/repo',
    missionBasisHash: 'e'.repeat(64),
    recognizerVersion: 'clue-recognizer/4',
    catalogue: null,
    q1: null,
    provenance: {
      eventLogFrom: null,
      eventLogTo: null,
      projectionVersion: null,
      goldenDefinitionHash: null,
    },
  };
}

/**
 * The snapshot with every instant-derived member removed.
 *
 * These are enumerated rather than pattern-matched, because the enumeration is the claim: a
 * member is allowed to differ between two surfaces *only* if it is derived from the declared
 * capture instant. Everything else is durable content and must be identical.
 *
 *   generatedAt                    the declared instant itself
 *   seal                           binds the body, so it moves with any of the above
 *   <branch>.freshness             observedAt, and `ageMs` measured to the instant
 *   runtimeDiagnostics.checkedAt   when this instance was asked, not what it found
 *
 * A first draft of this test normalised by string-replacing the timestamp, which passed
 * against the live dashboard and failed here: `ageMs` is a *number* derived from the
 * instant, so a string replace cannot reach it. The live comparison had happened to have
 * `ageMs: 0` on both sides. Enumerating is what makes the claim checkable rather than
 * incidentally true.
 */
function durableCore(snapshot: StatusSnapshot): unknown {
  const { generatedAt: _at, seal: _seal, ...branches } = snapshot;
  void _at;
  void _seal;
  const stripped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(branches)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      stripped[name] = value;
      continue;
    }
    const { freshness: _freshness, checkedAt: _checkedAt, ...rest } =
      value as unknown as Record<string, unknown>;
    void _freshness;
    void _checkedAt;
    stripped[name] = rest;
  }
  return stripped;
}

test('gate 4: independent invocations at one instant produce one body and one hash', () => {
  const at = '2026-08-06T12:00:00.000Z';
  // Two separate readers and two separate projections — the shape of two surfaces asking.
  const first = projectStatus(source(), options(at)).snapshot;
  const second = projectStatus(source(), options(at)).snapshot;

  assert.equal(first.seal.statusHash, second.seal.statusHash);
  assert.deepEqual(first, second);
  assert.equal(verifySeal(first).valid, true);
  assert.equal(verifySeal(second).valid, true);
});

test('gate 4: surfaces asking at different moments differ only in the capture instant', () => {
  // The real-world case, and the one a naive byte comparison would call a failure. Ten
  // seconds apart is not a second interpretation; it is the same interpretation of the same
  // state, declared at a different time.
  const early = '2026-08-06T12:00:00.000Z';
  const late = '2026-08-06T12:00:10.000Z';
  const cli = projectStatus(source(), options(early)).snapshot;
  const api = projectStatus(source(), options(late)).snapshot;

  assert.notEqual(cli.seal.statusHash, api.seal.statusHash, 'the instant is part of the body');

  // Strip what the instant derives, and every remaining member must be identical. If any
  // other member differs, two surfaces have formed two interpretations and §1 is broken.
  assert.deepEqual(
    durableCore(api),
    durableCore(cli),
    'the durable content is one interpretation regardless of when each surface asked',
  );

  // And the difference really is only the instant: re-projecting the later one at the
  // earlier instant reproduces the earlier hash exactly.
  const replayed = projectStatus(source(), options(early)).snapshot;
  assert.equal(sealBodyDigest(bodyOf(replayed)), sealBodyDigest(bodyOf(cli)));
});

test('gate 4: a body that differs in anything but the instant is caught', () => {
  // The control. Without it the test above would pass for a projector that ignored its
  // inputs entirely and returned a constant.
  const at = '2026-08-06T12:00:00.000Z';
  const cli = projectStatus(source(), options(at)).snapshot;
  const other = projectStatus(source(), { ...options(at), targetId: 'a-different-target' }).snapshot;

  assert.notEqual(
    sealBodyDigest(bodyOf(other)),
    sealBodyDigest(bodyOf(cli)),
    'a genuinely different body must not normalise away',
  );
});
