/**
 * DEV-P0-01 — projection rebuild equivalence.
 *
 * The contract this file guards: "SQLite holds no truth." Every projection row must be rebuildable
 * from the append-only event log and the content-addressed blobs, so deleting the database and
 * rebuilding must reproduce the exact same state — and any row not backed by that authority must not
 * survive the rebuild.
 *
 * The interesting case is the artifact-backed bulk tables. A projector receives only `(db, record)`;
 * it can replay an event into a summary receipt but cannot open a blob, so the graph's unit/edge
 * tables (filled by the registry from the recognition artifact) are left empty by replay alone. The
 * production runtime therefore builds its projection store from registered modules whose rehydrate
 * hooks repopulate those tables after replay. These tests prove the mechanism end to end: replay
 * alone leaves the bulk empty, a rebuild through the registered modules is byte-identical, and a
 * planted row absent from the authority is gone after a rebuild.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectionStore } from '../src/memory/db.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { GraphRegistry, GRAPH_PROJECTORS, ensureGraphSchema } from '../src/analysis/source/graph.js';
import { MetricRegistry } from '../src/analysis/metrics/registry.js';
import { recognize } from '../src/analysis/source/recognizer.js';
import { captureSnapshot } from '../src/analysis/source/snapshot.js';
import { TASK_PROJECTORS } from '../src/control/tasks.js';
import { PACKET_PROJECTORS } from '../src/control/sessionPackets.js';
import { buildProjectionModules } from '../src/control/projectionModules.js';

const GRAPH_TABLES = ['recognitions', 'units', 'graph_edges', 'unit_ids', 'unresolved_refs', 'unit_classes'] as const;

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-rebuild-proj-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
      include: ['src'],
    }),
  );
  writeFileSync(join(root, 'src', 'index.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
  writeFileSync(join(root, 'src', 'util.ts'), "import { add } from './index';\nexport function inc(x: number): number { return add(x, 1); }\n");
  writeFileSync(join(root, 'src', 'main.ts'), "import { inc } from './util';\nexport const two = inc(1);\n");
  return root;
}

interface Populated {
  readonly root: string;
  readonly ws: string;
  readonly projections: ProjectionStore;
  readonly log: EventLog;
  readonly before: Record<string, number>;
  readonly digest: string;
  dispose(): void;
}

function countRows(projections: ProjectionStore, table: string): number {
  const row = projections.db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
  return row.c;
}

/** Build a workspace exactly as the runtime does (modules + kernel projectors), record a graph. */
function populate(): Populated {
  const root = makeProject();
  const manifest = captureSnapshot({ root, sourceRoots: ['src'] });
  const result = recognize({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json') });

  const ws = mkdtempSync(join(tmpdir(), 'clue-rebuild-ws-'));
  for (const d of ['db', 'events', 'blobs', 'logs']) mkdirSync(join(ws, d), { recursive: true });

  const rehydrators: { graph?: () => void; metrics?: () => void } = {};
  const projections = new ProjectionStore(join(ws, 'db', 'clue.db'), {
    modules: buildProjectionModules(rehydrators),
    projectors: { ...TASK_PROJECTORS, ...PACKET_PROJECTORS },
  });
  const artifacts = new ArtifactStore(join(ws, 'blobs'));
  const { log } = EventLog.open(join(ws, 'events'));
  const missionVersion = (): string => 'MISSION-000001';
  const graph = new GraphRegistry({ log, projections, artifacts, missionVersion });
  const metrics = new MetricRegistry({ log, projections, artifacts, missionVersion });
  rehydrators.graph = (): void => {
    graph.rehydrateAll();
  };
  rehydrators.metrics = (): void => {
    metrics.rehydrateAll();
  };

  graph.record(manifest.id, result);

  const before: Record<string, number> = {};
  for (const t of GRAPH_TABLES) before[t] = countRows(projections, t);

  return {
    root,
    ws,
    projections,
    log,
    before,
    digest: projections.canonicalExportDigest(),
    dispose(): void {
      log.close();
      projections.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('event replay alone restores the recognition receipt but leaves the artifact-backed bulk empty', () => {
  const p = populate();
  try {
    assert.ok((p.before['units'] ?? 0) > 0, 'fixture should produce units');

    // A store with the graph projector registered but no module — so no rehydrate hook.
    const bare = new ProjectionStore(join(p.ws, 'db', 'bare.db'), {
      projectors: { ...GRAPH_PROJECTORS, ...TASK_PROJECTORS, ...PACKET_PROJECTORS },
    });
    ensureGraphSchema(bare.db);
    bare.rebuild(p.log);

    const recognitions = (bare.db.prepare('SELECT COUNT(*) AS c FROM recognitions').get() as { c: number }).c;
    const units = (bare.db.prepare('SELECT COUNT(*) AS c FROM units').get() as { c: number }).c;
    bare.close();

    assert.equal(recognitions, p.before['recognitions'], 'replay restores the recognitions receipt');
    assert.equal(units, 0, 'replay alone cannot fill the artifact-backed bulk — this is the gap the hook closes');
  } finally {
    p.dispose();
  }
});

test('a full rebuild through the registered modules is byte-identical', () => {
  const p = populate();
  try {
    p.projections.rebuild(p.log);

    for (const t of GRAPH_TABLES) {
      assert.equal(countRows(p.projections, t), p.before[t], `table "${t}" restored to its exact row count`);
    }
    assert.equal(p.projections.canonicalExportDigest(), p.digest, 'canonical export is byte-identical after rebuild');
  } finally {
    p.dispose();
  }
});

test('a row absent from the event and blob authority does not survive a rebuild', () => {
  const p = populate();
  try {
    p.projections.db
      .prepare(
        `INSERT INTO units (snapshot_id, unit_id, kind, name, qualified_name, module_path, subsystem,
           exported, version_hash, start_line, end_line, start_byte, end_byte, line_count, byte_length, is_async)
         VALUES ('POISON', 999999, 'function', 'poison', 'poison', 'src/poison.ts', 'x',
           1, 'deadbeef', 1, 1, 0, 10, 1, 10, 0)`,
      )
      .run();
    assert.equal(countRows(p.projections, 'units'), (p.before['units'] ?? 0) + 1, 'poison row present before rebuild');

    p.projections.rebuild(p.log);

    assert.equal(countRows(p.projections, 'units'), p.before['units'], 'poison row gone after rebuild');
    assert.equal(p.projections.canonicalExportDigest(), p.digest, 'canonical export identical again after rebuild');
  } finally {
    p.dispose();
  }
});
