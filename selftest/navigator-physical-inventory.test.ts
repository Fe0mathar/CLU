/** Q1 SURF wire ordering, seal binding and semantic-enrichment tests. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  NavigatorEventWriter,
  navigatorEnvelopeSchema,
  type NavigatorEnvelope,
} from '../src/analysis/source/navigatorEvents.js';
import {
  captureRepositoryInventory,
  enrichRepositoryInventory,
} from '../src/analysis/source/repositoryInventory.js';
import { recognize } from '../src/analysis/source/recognizer.js';

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-q1-wire-'));
  write(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
    },
    include: ['src'],
  }));
  write(root, 'src/a.ts', 'export function secretBodyMarker(): number { return 41; }\n');
  write(root, 'src/b.ts', "import { secretBodyMarker } from './a';\nexport const b = secretBodyMarker() + 1;\n");
  write(root, 'README.md', '# Inventory fixture\n');
  return root;
}

function readEvents(path: string): readonly NavigatorEnvelope[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => navigatorEnvelopeSchema.parse(JSON.parse(line)));
}

test('Q1 SURF: physical inventory precedes recognition and the sealed stream binds its identity', () => {
  const root = fixture();
  const output = join(root, 'workspace', 'graph', 'system-navigator.ndjson');
  const recognitionSnapshotId = 'a'.repeat(64);
  const captureId = 'b'.repeat(64);
  try {
    const inventory = captureRepositoryInventory({
      root,
      repositoryId: 'fixture',
      projectName: 'Fixture',
      recognitionSourceRoots: ['src'],
      recognitionSnapshotId,
      exclude: ['node_modules', 'dist', '.git', 'workspace'],
      previous: null,
    });
    const writer = new NavigatorEventWriter({
      path: output,
      projectName: 'Fixture',
      snapshotId: recognitionSnapshotId,
      captureId,
      runId: 'run-q1-physical',
      awaitCommit: true,
      inventory,
    });

    writer.publishRepositoryInventory();
    const result = recognize({
      projectRoot: root,
      tsconfigPath: join(root, 'tsconfig.json'),
      observer: writer,
    });
    writer.publishRepositoryEnrichment(enrichRepositoryInventory(inventory, result));
    writer.graphCommitting();
    writer.graphCommitted({
      recognitionRecordId: null,
      graphSha256: 'c'.repeat(64),
      resultHash: 'd'.repeat(64),
      unitCount: result.units.length,
      edgeCount: result.edges.length,
      unresolvedCount: result.unresolved.length,
    });

    const events = readEvents(output);
    const types = events.map((event) => event.type);
    assert.deepEqual(types.slice(0, 3), [
      'navigator.reset',
      'inventory.started',
      'inventory.taxonomy',
    ]);
    const inventoryCompletedIndex = types.indexOf('inventory.completed');
    const recognitionStartedIndex = types.indexOf('recognition.started');
    const scanStartedIndex = types.indexOf('scan.started');
    assert.ok(types.indexOf('files.upserted') > 1);
    assert.ok(inventoryCompletedIndex > types.indexOf('files.upserted'));
    assert.equal(recognitionStartedIndex, inventoryCompletedIndex + 1);
    assert.equal(scanStartedIndex, recognitionStartedIndex + 1);
    assert.equal(types.at(-1), 'graph.committed');
    const committed = events.at(-1);
    assert.equal(committed?.payload['inventoryHash'], inventory.inventoryHash);
    assert.equal(committed?.payload['inventorySnapshotId'], inventory.snapshotId);
    assert.equal(committed?.payload['taxonomyHash'], inventory.taxonomy.taxonomyHash);
    assert.deepEqual(committed?.payload['inventoryCounts'], inventory.counts);

    const taxonomy = events.find((event) => event.type === 'inventory.taxonomy');
    assert.equal(taxonomy?.payload['taxonomyVersion'], inventory.taxonomy.taxonomyVersion);
    assert.equal(taxonomy?.payload['taxonomyHash'], inventory.taxonomy.taxonomyHash);

    const completed = events.find((event) => event.type === 'inventory.completed');
    assert.equal(completed?.payload['inventoryHash'], inventory.inventoryHash);
    assert.deepEqual(completed?.payload['counts'], inventory.counts);

    const scan = events.find((event) => event.type === 'scan.started');
    const bindings = scan?.payload['sealBindings'];
    assert.ok(Array.isArray(bindings));
    const byFact = new Map(bindings.map((item) => [item.fact, item]));
    assert.equal(byFact.get('taxonomy version/hash')?.state, 'bound');
    assert.equal(byFact.get('repository inventory hash')?.state, 'bound');
    assert.equal(byFact.get('inventory file/family/environment counts')?.state, 'bound');
    assert.equal(byFact.get('capture identity')?.state, 'bound');

    assert.ok(types.includes('file.semantic-summary'));
    assert.ok(types.includes('dependency.discovered'));
    assert.ok(events.every((event) => event.snapshotId === recognitionSnapshotId));
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index),
    );

    const serialized = readFileSync(output, 'utf8');
    assert.doesNotMatch(serialized, /return 41/u, 'source body text never enters Navigator telemetry');
    assert.match(serialized, /secretBodyMarker/u, 'semantic identity is allowed without source text');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
