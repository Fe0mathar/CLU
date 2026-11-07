/**
 * ADR-0004 — the console keeps its host facts, and Status does not carry them.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §19.3 — backend UI modules must not maintain a second
 *       lifecycle state machine.
 *       `CLUE_Status_Contract_v9.md` §9 and §10 — AI orchestration and the proof pipeline are
 *       Status's own branches, which is why the console's `sessions` and `pipeline` are NOT in
 *       the local declaration this file checks.
 *
 * Backlog: ADR-0004, decisions 1 and 2. `DEV-P1-15` and `DEV-P1-17` were blocked on the decision;
 *          this is the part of it that can be enforced today.
 *
 * ## Why a declaration needs a test
 *
 * ADR-0002 recorded the problem precisely: these surfaces were *"neither sourced from Status nor
 * declared as deliberately non-Status, which is the least defensible of the three possible
 * states"*. ADR-0004 chose the second, and `CONSOLE_LOCAL_SURFACES` writes it down.
 *
 * A written-down list decays in one specific way, and it is not the obvious one. The risk is not
 * that someone deletes an entry — that is visible. It is that Status later grows a branch covering
 * a fact the list still claims as local, and both statements sit in the tree being individually
 * true and jointly wrong. Nothing would fail. The dashboard would render, the status body would
 * validate, and the same fact would exist in two places with two lifetimes.
 *
 * That is the same defect shape as `DEV-P1-31` (a schema and its producer disagreeing about the
 * identity grammar) and `DEV-P1-16` (the dashboard holding a private copy of a governed list).
 * Both were invisible until something read across the boundary. This reads across it.
 *
 * ## What is asserted, and what deliberately is not
 *
 * Asserted: every declared-local surface is actually present in the console body, is absent from
 * the Status body, and does not collide with a declared branch name. Also that the three
 * deliberate *absences* from the list stay absent, because each records a different decision and
 * silently adding one would erase it.
 *
 * Not asserted: the reason strings. They are the argument, not the behaviour, and pinning prose
 * turns a conformance test into a change detector — the mistake avoided in
 * `config-path-portability.test.ts` for the same reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONSOLE_LOCAL_SURFACES, projectConsoleSnapshot, type ProjectorInput } from '../src/ui/consoleProjector.js';
import { BACKED_BRANCHES, UNSUPPORTED_BRANCHES, type StatusSnapshot } from '../src/status/statusContractV5.js';

/* ------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * A Status body with the branch keys this test needs.
 *
 * Built by hand rather than through `projectStatus`, because the property under test is about
 * *which names appear*, and a hand-built body makes the expectation legible. The projector's own
 * output is checked separately by `status-projector.test.ts`.
 */
function statusBody(): StatusSnapshot {
  const unavailable = (reason: string) => ({
    state: 'unsupported' as const,
    reason,
    expectedSource: null,
    lastKnownAt: null,
  });
  const body: Record<string, unknown> = {
    schemaVersion: '5.8.0',
    generatedAt: '2026-08-09T12:00:00.000Z',
    // The console projector reads exactly two fields from the Status seal —  and
    //  — which is ADR-0002's inversion in miniature: the console names the Status body
    // it reflects rather than computing an authority of its own.
    seal: { statusHash: 'a'.repeat(64), consistent: true },
  };
  for (const name of [...BACKED_BRANCHES, ...UNSUPPORTED_BRANCHES]) {
    body[name] = unavailable(`fixture: ${name}`);
  }
  return body as unknown as StatusSnapshot;
}

/** Durable inputs with a blocked readiness, so the host-fact surfaces carry real content. */
function input(): ProjectorInput {
  return {
    capturedAt: '2026-08-09T12:00:00.000Z',
    operator: 'operator',
    activeTab: 'dashboard',
    mission: {
      missionId: 'mission_000001',
      title: 'Improve Murugan',
      constitutionHash: 'c'.repeat(64),
      lastChange: 'initial',
    },
    snapshot: { snapshotId: 's'.repeat(64), fileCount: 42, capturedAt: '2026-08-09T11:59:00.000Z' },
    run: null,
    recognition: null,
    // Deliberately blocked, and blocked on a host fact. A `ready` fixture would let the test pass
    // over a console that reported nothing — the surfaces have to carry content for their absence
    // from Status to mean anything.
    readiness: {
      status: 'blocked',
      sections: [
        { section: 'project_repository', ready: true },
        { section: 'chrome_console', ready: false },
        { section: 'powershell', ready: false },
      ],
      firstBlocking: 'chrome_console',
    },
    sources: ['eventlog@128', 'db@v3'],
    status: statusBody(),
  };
}

/** Reads a dotted path, returning `undefined` rather than throwing. */
function at(root: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (node == null ? undefined : (node as Record<string, unknown>)[key]), root);
}

/* ------------------------------------------------------------------------- */
/* The split holds                                                            */
/* ------------------------------------------------------------------------- */

test('ADR-0004: every declared-local surface exists in the console body', () => {
  // A list naming something the console does not have is worse than no list: it asserts a
  // decision about a surface nobody can find, and the next reader cannot tell whether it was
  // removed or never existed.
  const snapshot = projectConsoleSnapshot(input()) as unknown as Record<string, unknown>;

  for (const [surface] of CONSOLE_LOCAL_SURFACES) {
    const value = at(snapshot, surface);
    assert.notEqual(
      value,
      undefined,
      `${surface} is declared console-local but is not in the console snapshot`,
    );
  }
});

test('ADR-0004: no declared-local surface names a Status branch', () => {
  // The decay mode this exists for. If Status later grows a branch covering a fact the list still
  // claims as local, both statements are individually true and jointly wrong — the same fact in
  // two places with two lifetimes, and nothing else in the suite would notice.
  const branches = new Set<string>([...BACKED_BRANCHES, ...UNSUPPORTED_BRANCHES]);

  const collisions = [...CONSOLE_LOCAL_SURFACES.keys()].filter((surface) =>
    branches.has(surface.split('.')[0] ?? surface),
  );

  assert.deepEqual(
    collisions,
    [],
    `declared console-local and also a Status branch: ${collisions.join(', ')}. ` +
      'One of the two declarations is wrong; ADR-0004 decides which.',
  );
});

test('ADR-0004: no declared-local surface appears in the Status body', () => {
  // Stronger than the name check above, and cheap: the branch census is a list of *declared*
  // branches, while this searches the emitted body. A surface leaking into Status through a
  // populated branch's payload would pass the census check and fail here.
  const body = JSON.stringify(statusBody());

  for (const [surface] of CONSOLE_LOCAL_SURFACES) {
    const leaf = (surface.split('.').pop() ?? surface);
    assert.equal(
      body.includes(`"${leaf}"`),
      false,
      `"${leaf}" appears in the Status body but is declared console-local`,
    );
  }
});

/* ------------------------------------------------------------------------- */
/* The absences are decisions, not omissions                                  */
/* ------------------------------------------------------------------------- */

test('ADR-0004: sessions and pipeline are NOT declared local — they belong to Status', () => {
  // §9 `aiOrchestration` and §10 `proofPipeline` already own these. Adding either to the local
  // list would quietly reverse decision 2 and duplicate a declared branch.
  for (const surface of ['sessions', 'dashboard.sessions', 'pipeline', 'dashboard.pipeline']) {
    assert.equal(
      CONSOLE_LOCAL_SURFACES.has(surface),
      false,
      `${surface} must not be declared console-local: the Status Contract owns it at §9/§10`,
    );
  }

  const branches = new Set<string>([...BACKED_BRANCHES, ...UNSUPPORTED_BRANCHES]);
  assert.ok(branches.has('aiOrchestration'), '§9 branch must exist for sessions to land in');
  assert.ok(branches.has('proofPipeline'), '§10 branch must exist for pipeline to land in');
});

test('ADR-0004: startStop is NOT declared local — it is deferred, which is a third state', () => {
  // It is `{phase, readiness}` and fails the test in both directions at once: `phase` is a
  // mission fact, `readiness` is a host fact. ADR-0004 defers it rather than splitting it against
  // a domain with no behaviour. Listing it as local would erase the deferral and assert an answer
  // nobody has reached.
  assert.equal(
    CONSOLE_LOCAL_SURFACES.has('startStop'),
    false,
    'startStop is deferred by ADR-0004, not decided local',
  );
  assert.equal(CONSOLE_LOCAL_SURFACES.has('dashboard.startStop'), false);

  // But its readiness half IS declared, which is what makes the deferral coherent rather than an
  // evasion: the part that certainly cannot leave has been decided.
  assert.ok(
    CONSOLE_LOCAL_SURFACES.has('configuration.readiness'),
    'readiness must be declared local, or deferring startStop defers nothing',
  );
});

test('ADR-0004: every declared surface states a reason', () => {
  // The list is a record of decisions. An entry without an argument is an assertion nobody has to
  // defend, which is how the undeclared state ADR-0002 objected to came about in the first place.
  for (const [surface, reason] of CONSOLE_LOCAL_SURFACES) {
    assert.ok(
      typeof reason === 'string' && reason.trim().length > 20,
      `${surface} is declared console-local without a stated reason`,
    );
  }
});
