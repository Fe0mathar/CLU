/** Q1 SURF physical inventory and semantic-enrichment acceptance tests. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  captureRepositoryInventory,
  enrichRepositoryInventory,
  readRepositoryInventoryPointer,
  toRepositoryInventoryPointer,
  writeRepositoryInventoryPointer,
  type RepositoryInventoryPointer,
} from '../src/analysis/source/repositoryInventory.js';
import { recognize } from '../src/analysis/source/recognizer.js';

function write(root: string, relative: string, content: string | Buffer): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-q1-inventory-'));
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
  write(root, 'src/a.ts', 'export function a(): number { return 1; }\n');
  write(root, 'src/b.ts', "import { a } from './a';\nexport function b(): number { return a(); }\n");
  write(root, 'README.md', '# Fixture\n');
  write(root, 'config/settings.yaml', 'enabled: true\n');
  write(root, 'scripts/build.ps1', 'Write-Output "ok"\n');
  write(root, 'assets/icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(root, 'misc/opaque.foo', 'opaque\n');
  write(root, 'node_modules/ignored/index.js', 'throw new Error("must not be inventoried");\n');
  return root;
}

const recognitionSnapshotId = 'a'.repeat(64);

function capture(root: string, previous: RepositoryInventoryPointer | null = null) {
  return captureRepositoryInventory({
    root,
    repositoryId: 'fixture',
    projectName: 'Fixture',
    recognitionSourceRoots: ['src'],
    recognitionSnapshotId,
    exclude: ['node_modules', 'dist', '.git'],
    previous,
  });
}

test('Q1 SURF: full repository inventory is physical, classified and explicit about unsupported/excluded surfaces', () => {
  const root = fixture();
  try {
    const inventory = capture(root);
    const paths = inventory.files.map((file) => file.path);

    assert.ok(paths.includes('src/a.ts'));
    assert.ok(paths.includes('README.md'));
    assert.ok(paths.includes('config/settings.yaml'));
    assert.ok(paths.includes('scripts/build.ps1'));
    assert.ok(paths.includes('assets/icon.png'));
    assert.ok(paths.includes('misc/opaque.foo'));
    assert.equal(paths.some((path) => path.startsWith('node_modules/')), false);

    const byPath = new Map(inventory.files.map((file) => [file.path, file] as const));
    assert.deepEqual(
      [byPath.get('src/a.ts')?.familyId, byPath.get('src/a.ts')?.environmentId],
      ['ecmascript', 'typescript'],
    );
    assert.deepEqual(
      [byPath.get('README.md')?.familyId, byPath.get('README.md')?.environmentId],
      ['documentation', 'markdown'],
    );
    assert.deepEqual(
      [byPath.get('scripts/build.ps1')?.familyId, byPath.get('scripts/build.ps1')?.environmentId],
      ['shell-automation', 'powershell'],
    );
    assert.deepEqual(
      [byPath.get('misc/opaque.foo')?.familyId, byPath.get('misc/opaque.foo')?.environmentId],
      ['unknown', 'unknown'],
    );
    assert.equal(byPath.get('misc/opaque.foo')?.recognitionState, 'unsupported');
    assert.equal(byPath.get('src/a.ts')?.recognitionState, 'pending');

    assert.ok(inventory.exclusions.some((entry) => entry.path === 'node_modules'));
    assert.deepEqual(inventory.sourceRoots, ['.']);
    assert.deepEqual(inventory.recognitionSourceRoots, ['src']);
    assert.deepEqual(inventory.excludedNames, ['.git', 'dist', 'node_modules']);
    assert.match(inventory.inventoryHash, /^[0-9a-f]{64}$/u);
    assert.match(inventory.taxonomy.taxonomyHash, /^[0-9a-f]{64}$/u);
    assert.equal(inventory.counts.files, inventory.files.filter((file) => !file.excluded).length);
    assert.equal(inventory.counts.families > 1, true);
    assert.equal(inventory.counts.environments > 1, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Q1 SURF: location identity survives edits while version identity and lifecycle change', () => {
  const root = fixture();
  try {
    const first = capture(root);
    const pointer = toRepositoryInventoryPointer(first);
    const before = first.files.find((file) => file.path === 'src/a.ts');
    assert.ok(before);

    write(root, 'src/a.ts', 'export function a(): number { return 2; }\n');
    const second = capture(root, pointer);
    const after = second.files.find((file) => file.path === 'src/a.ts');
    assert.ok(after);

    assert.equal(after.fileLocationId, before.fileLocationId);
    assert.notEqual(after.fileVersionId, before.fileVersionId);
    assert.equal(after.inventoryState, 'modified');

    unlinkSync(join(root, 'README.md'));
    const third = capture(root, toRepositoryInventoryPointer(second));
    const removed = third.removedFiles.find((file) => file.path === 'README.md');
    assert.ok(removed);
    assert.equal(removed.inventoryState, 'removed');
    assert.equal(removed.fileLocationId, first.files.find((file) => file.path === 'README.md')?.fileLocationId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Q1 SURF: mode changes are modified and foreign inventory pointers are ignored', {
  skip: process.platform === 'win32' ? 'POSIX executable mode' : false,
}, () => {
  const root = fixture();
  try {
    const pointer = toRepositoryInventoryPointer(capture(root));
    chmodSync(join(root, 'src/a.ts'), 0o755);
    const changed = capture(root, pointer).files.find((file) => file.path === 'src/a.ts');
    assert.equal(changed?.inventoryState, 'modified');
    assert.equal(changed?.contentHash, pointer.files.find((file) => file.path === 'src/a.ts')?.contentHash);
    unlinkSync(join(root, 'README.md'));
    const unrelated = capture(root, { ...pointer, repositoryId: 'another-project' });
    assert.equal(unrelated.files.find((file) => file.path === 'src/a.ts')?.inventoryState, 'committed');
    assert.deepEqual(unrelated.removedFiles, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Q1 SURF: semantic recognition enriches existing physical records and creates file-level relations', () => {
  const root = fixture();
  try {
    const inventory = capture(root);
    const result = recognize({
      projectRoot: root,
      tsconfigPath: join(root, 'tsconfig.json'),
    });
    const enrichment = enrichRepositoryInventory(inventory, result);
    const byPath = new Map(enrichment.files.map((file) => [file.path, file] as const));

    assert.equal(byPath.get('src/a.ts')?.recognitionState, 'recognized');
    assert.equal(byPath.get('src/b.ts')?.recognitionState, 'recognized');
    assert.equal(byPath.get('README.md')?.recognitionState, 'unsupported');
    assert.ok((byPath.get('src/a.ts')?.semanticMembershipIds.length ?? 0) > 0);

    const bSummary = enrichment.summaries.find((summary) => summary.path === 'src/b.ts');
    assert.ok(bSummary);
    assert.ok(bSummary.semanticSummary.unitCount > 0);
    assert.ok(bSummary.semanticSummary.outboundCount > 0);

    assert.ok(enrichment.edges.length > 0, 'cross-file import/call becomes a file relation');
    const physicalIds = new Set(inventory.files.map((file) => file.fileLocationId));
    for (const edge of enrichment.edges) {
      assert.ok(physicalIds.has(edge.fromFileLocationId));
      assert.ok(physicalIds.has(edge.toFileLocationId));
      assert.notEqual(edge.fromFileLocationId, edge.toFileLocationId);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Q1 SURF: the current-inventory pointer is durable and parseable', () => {
  const root = fixture();
  const navigatorPath = join(root, 'workspace', 'graph', 'system-navigator.ndjson');
  try {
    const inventory = capture(root);
    const path = writeRepositoryInventoryPointer(navigatorPath, inventory);
    const parsed = readRepositoryInventoryPointer(navigatorPath);
    assert.ok(parsed);
    assert.equal(parsed.inventoryHash, inventory.inventoryHash);
    assert.equal(parsed.snapshotId, inventory.snapshotId);
    assert.equal(parsed.files.length, inventory.files.filter((file) => !file.excluded).length);
    assert.match(readFileSync(path, 'utf8'), /"inventoryHash"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Q1 SURF: semantic enrichment requires the exact inventoried file version', () => {
  const root = fixture();
  try {
    const inventory = capture(root);
    write(root, 'src/a.ts', 'export function a(): number { return 77; }\n');
    const result = recognize({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json') });
    const enrichment = enrichRepositoryInventory(inventory, result);
    const a = enrichment.files.find((file) => file.path === 'src/a.ts');
    const b = enrichment.files.find((file) => file.path === 'src/b.ts');
    assert.equal(a?.recognitionState, 'failed');
    assert.deepEqual(a?.semanticMembershipIds, []);
    assert.equal(b?.recognitionState, 'recognized');
    assert.deepEqual(enrichment.edges, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
