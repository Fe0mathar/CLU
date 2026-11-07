/**
 * Console daemon boundary tests.
 *
 * Spec: the CLU deep review, Integrity Patch 0, P0.4 — the daemon is the single authority
 *       boundary the renderers trust, and its header's second rule ("publishes only
 *       schema-valid, sealed snapshots") must be *enforced at the boundary, not assumed*.
 *       Before the fix, `publish` accepted anything with a truthy `.seal`; these are the
 *       first tests the daemon has ever had, and they pin the boundary shut.
 *
 * Import note: the daemon deliberately lives outside the TypeScript build (a .mjs sibling
 * to the Navigator SSE server; node built-ins only), so tsc neither compiles nor copies it
 * into dist. The test therefore loads it dynamically, relative to the *executed* file —
 * from dist/selftest this resolves to the real src/daemon/consoleDaemon.mjs — and types it
 * through a small structural seam that documents exactly the surface under test. The
 * validator injected is the real compiled `parseConsoleSnapshot`; the snapshots are real
 * projector output. Nothing here is mocked, because the property being tested is precisely
 * that the real schema stands between callers and the endpoints.
 *
 * Run: npm run selftest
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectStatus } from '../src/status/statusProjector.js';
import type { StatusSnapshot } from '../src/status/statusContractV5.js';
import type { RegistrySource } from '../src/daemon/consoleStateCollector.js';

import { projectConsoleSnapshot, type ProjectorInput } from '../src/ui/consoleProjector.js';
import { parseConsoleSnapshot, type ConsoleSnapshot } from '../src/ui/viewModel.js';

/* ------------------------------------------------------------------------- */
/* Structural seam over the .mjs module                                       */
/* ------------------------------------------------------------------------- */

interface DaemonEntry {
  readonly revision: number;
  readonly seal: { readonly snapshotHash: string };
  readonly snapshot: ConsoleSnapshot;
}

interface ConsoleDaemonInstance {
  publish(snapshot: unknown): number;
  readonly revision: number;
  readonly current: DaemonEntry | null;
}

interface ConsoleDaemonModule {
  ConsoleDaemon: new (options?: {
    validateSnapshot?: unknown;
    port?: number;
  }) => ConsoleDaemonInstance;
}

const daemonModule = (await import(
  new URL('../../src/daemon/consoleDaemon.mjs', import.meta.url).href
)) as ConsoleDaemonModule;
const { ConsoleDaemon } = daemonModule;

/* ------------------------------------------------------------------------- */
/* Fixtures — real projector output, never hand-shaped snapshots              */
/* ------------------------------------------------------------------------- */

/** A Status body with no committed graph, matching this fixture's durable state. */
function UNCOMMITTED_STATUS(): StatusSnapshot {
  const source = {
    currentMission: () => ({
      missionId: 'mission_000001',
      title: 'Improve Murugan',
      constitutionHash: 'c'.repeat(64),
      lastChange: 'initial' as const,
    }),
    latestSnapshot: () => null,
    recognitionFor: () => null,
    runIdForSnapshot: () => null,
    configReadiness: () => ({ status: 'ready', sections: [] }) as never,
    stateSources: () => ['eventlog@128'],
  } as unknown as RegistrySource;
  return projectStatus(source, {
    capturedAt: '2026-07-27T12:00:00.000Z',
    targetId: 'TGT',
    targetName: null,
    canonicalRoot: '/repo',
    missionBasisHash: null,
    recognizerVersion: null,
    catalogue: null,
    q1: null,
    provenance: {
      eventLogFrom: null,
      eventLogTo: null,
      projectionVersion: null,
      goldenDefinitionHash: null,
    },
  }).snapshot;
}

function baseInput(overrides: Partial<ProjectorInput> = {}): ProjectorInput {
  return {
    capturedAt: '2026-07-27T12:00:00.000Z',
    operator: 'operator',
    activeTab: 'dashboard',
    // ADR-0002 step 4: the projector is downstream of sealed Status. This daemon fixture has
    // no committed graph, so the honest Status body states the absence and the console
    // renders its uncommitted field — the same pairing production produces.
    status: UNCOMMITTED_STATUS(),
    mission: {
      missionId: 'mission_000001',
      title: 'Improve Murugan',
      constitutionHash: 'c'.repeat(64),
      lastChange: 'unchanged',
    },
    snapshot: {
      snapshotId: 's'.repeat(64),
      fileCount: 5,
      capturedAt: '2026-07-27T11:59:00.000Z',
    },
    run: null,
    recognition: null,
    readiness: { status: 'ready', sections: [{ section: 'project_repository', ready: true }] },
    sources: ['eventlog@1'],
    ...overrides,
  };
}

function validatingDaemon(): ConsoleDaemonInstance {
  return new ConsoleDaemon({ validateSnapshot: parseConsoleSnapshot, port: 0 });
}

/** Deep-copies a valid snapshot so a test can tamper with one field of a real object. */
function tampered(mutate: (copy: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(projectConsoleSnapshot(baseInput()))) as Record<
    string,
    unknown
  >;
  mutate(copy);
  return copy;
}

/* ------------------------------------------------------------------------- */
/* The boundary                                                               */
/* ------------------------------------------------------------------------- */

test('a daemon without a validator cannot be constructed', () => {
  // The validator is a constructor requirement, not a courtesy: an unvalidating daemon
  // must be unconstructable, so the boundary cannot be accidentally weak.
  assert.throws(() => new ConsoleDaemon(), /requires options\.validateSnapshot/);
  assert.throws(() => new ConsoleDaemon({}), /requires options\.validateSnapshot/);
  assert.throws(
    () => new ConsoleDaemon({ validateSnapshot: 'yes' }),
    /requires options\.validateSnapshot/,
    'a non-function is as unvalidating as nothing',
  );
});

test('valid snapshots publish, and identical state never advances the revision', () => {
  const daemon = validatingDaemon();

  assert.equal(daemon.publish(projectConsoleSnapshot(baseInput())), 1, 'first state is revision 1');
  assert.equal(
    daemon.publish(projectConsoleSnapshot(baseInput())),
    1,
    'the identical seal is a no-op — reconnecting and live clients agree on "current"',
  );

  const changed = daemon.publish(projectConsoleSnapshot(baseInput({ operator: 'other' })));
  assert.equal(changed, 2, 'changed projected state advances the revision');
  assert.equal(
    daemon.current?.snapshot.shell.operator,
    'other',
    'what is stored and served is the VALIDATED object, not the raw argument',
  );
});

test('the boundary rejects what the schema rejects, and rejections change nothing', () => {
  const daemon = validatingDaemon();
  daemon.publish(projectConsoleSnapshot(baseInput()));
  const revisionBefore = daemon.revision;
  const sealBefore = daemon.current?.seal.snapshotHash;

  const rejected = /rejected an invalid ConsoleSnapshot/;
  assert.throws(() => daemon.publish({}), rejected, 'garbage');
  assert.throws(() => daemon.publish(null), rejected, 'null');
  assert.throws(
    () => daemon.publish(tampered((copy) => delete copy['seal'])),
    rejected,
    'a real snapshot with its seal removed',
  );
  assert.throws(
    () => daemon.publish(tampered((copy) => (copy['surprise'] = true))),
    rejected,
    'an unknown top-level field — the schema is strict',
  );
  assert.throws(
    () =>
      daemon.publish(
        tampered((copy) => {
          const configuration = copy['configuration'] as Record<string, unknown>;
          const storage = configuration['storage'] as Record<string, unknown>;
          storage['hashChainValid'] = 'yes';
        }),
      ),
    rejected,
    'a wrong-typed nested field deep inside the body',
  );

  assert.equal(daemon.revision, revisionBefore, 'five rejections advanced nothing');
  assert.equal(daemon.current?.seal.snapshotHash, sealBefore, 'the published state is untouched');
});

test('the seal-lookalike that once passed the truthiness check is rejected', () => {
  // Historical regression pin: before P0.4, `publish` checked only that `.seal` was
  // truthy, so this object would have been stored and served to every console client.
  const daemon = validatingDaemon();
  assert.throws(
    () => daemon.publish({ seal: { snapshotHash: 'x'.repeat(64) } }),
    /rejected an invalid ConsoleSnapshot/,
  );
  assert.equal(daemon.current, null, 'nothing unvalidated ever sits behind the endpoints');
});
