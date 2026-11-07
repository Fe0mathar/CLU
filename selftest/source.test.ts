/**
 * CLUE Stage C acceptance suite.
 *
 * Spec: CLUE_implementation.md §18 (snapshot identity), §19 (unit identity and
 *       behaviour closure), §23.1 (compiler-grade resolution), §23.4 (ambiguity
 *       reported), §33 (rescan).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.3, Part V Stage C gate.
 * Audit: v2.1 §2.2 and §3.5.
 *
 * Revision 2 — three changes:
 *
 *   - classification assertions moved to the two-axis model: quadrant and blast radius
 *     are checked independently, because they answer different questions and the audit
 *     found revision 1 conflating them;
 *   - behaviour closures are tested directly, since file span is a claim about the
 *     closure rather than about where a declaration happens to sit;
 *   - `stack.graph.db` is gone. `GraphRegistry` never exposed a `db` member and the
 *     audit caught the test reaching for one. `ProjectionStore` exposes its handle
 *     deliberately, and that is the one to use.
 *
 * Gate clauses:
 *
 *   1. identical tree → identical snapshot ID     → "snapshot identity" group
 *   2. one changed file invalidates only the
 *      correct cached surface                     → "incremental equals full"
 *   3. every unit resolves to exact source        → "units resolve to exact source"
 *   4. ambiguous continuity reported, not guessed → "recognition" group
 *   5. four quadrants with confidence and
 *      percentile, blast radius separate          → "classification" group
 *
 * The tests run against a real, tiny TypeScript project compiled by a real `ts.Program`.
 * Mocking the compiler would defeat the point: the argument for the Compiler API is
 * that path aliases, barrels, and symbol identity resolve correctly, and only the
 * compiler can demonstrate that.
 *
 * Run: npm run selftest
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { hashText } from '../src/shared/ids.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import {
  recognize,
  verifyProgramSnapshotParity,
  type RecognitionResult,
  type RecognitionStats,
  type UnresolvedReference,
  type ProgramFile,
} from '../src/analysis/source/recognizer.js';
import { computeCoverage } from '../src/analysis/source/coverage.js';
import {
  SNAPSHOT_PROJECTORS,
  SnapshotRegistry,
  captureSnapshot,
  classifyLanguage,
  diffSnapshots,
} from '../src/analysis/source/snapshot.js';
import {
  GRAPH_PROJECTORS,
  GraphRegistry,
  quadrantOf,
  subsystemOf,
  type BlastRadius,
  type ProtectedMatcher,
  type Quadrant,
} from '../src/analysis/source/graph.js';
import { SCAN_CACHE_PROJECTORS, ScanCache } from '../src/analysis/source/scanCache.js';

const ALL_QUADRANTS: readonly Quadrant[] = [
  'monofile-monodependency',
  'monofile-polydependency',
  'polyfile-monodependency',
  'polyfile-polydependency',
];

const ALL_BLAST_RADII: readonly BlastRadius[] = ['local', 'systemic', 'foundational', 'protected'];

/* ========================================================================= */
/* Fixture project                                                            */
/* ========================================================================= */

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      baseUrl: '.',
      paths: { '@core/*': ['src/core/*'] },
      skipLibCheck: true,
    },
    include: ['src'],
  },
  null,
  2,
);

/** Deliberately opens with non-ASCII text, so byte offsets cannot pass by accident. */
const MATH_TS = [
  '// Núcleo — arithmetic helpers §1',
  'export const SCALE = 2;',
  '',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
].join('\n');

/** A barrel: forwards symbols without naming them. */
const CORE_INDEX_TS = "export * from './math';\n";

const FRAME_TS = [
  "import { add, SCALE } from '@core/index';",
  '',
  'export interface Renderable {',
  '  render(): void;',
  '}',
  '',
  'export class Frame implements Renderable {',
  '  private readonly depth: number = SCALE;',
  '',
  '  public render(): void {',
  '    add(this.depth, 1);',
  '  }',
  '}',
  '',
].join('\n');

const APP_TS = [
  "import { Frame } from './render/frame';",
  '',
  'export function main(): void {',
  '  const frame = new Frame();',
  '  frame.render();',
  '}',
  '',
].join('\n');

/** A computed specifier: unresolvable without running the program. */
const DYNAMIC_TS = [
  'export async function load(name: string): Promise<unknown> {',
  '  return import(name);',
  '}',
  '',
].join('\n');

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': TSCONFIG,
  'src/core/math.ts': MATH_TS,
  'src/core/index.ts': CORE_INDEX_TS,
  'src/render/frame.ts': FRAME_TS,
  'src/app.ts': APP_TS,
  'src/dynamic.ts': DYNAMIC_TS,
};

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'clue-source-'));
  for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

function writeFixture(root: string, relative: string, content: string): void {
  writeFileSync(join(root, relative), content, 'utf8');
}

function removeRoot(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      chmodSync(join(entry.parentPath, entry.name), 0o666);
    } catch {
      // Best effort; rmSync reports whatever genuinely cannot be removed.
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

function recogniseProject(root: string, restrictTo?: readonly string[]): RecognitionResult {
  return recognize({
    projectRoot: root,
    tsconfigPath: join(root, 'tsconfig.json'),
    ...(restrictTo === undefined ? {} : { restrictTo }),
  });
}

function captureProject(root: string) {
  return captureSnapshot({ root, sourceRoots: ['src'] });
}

/* ------------------------------------------------------------------------- */
/* Workspace                                                                  */
/* ------------------------------------------------------------------------- */

interface Stack {
  readonly snapshots: SnapshotRegistry;
  readonly graph: GraphRegistry;
  readonly cache: ScanCache;
  /** Exposed because the registries deliberately do not expose a database handle. */
  readonly projections: ProjectionStore;
  dispose(): void;
}

function openStack(options: { isProtected?: ProtectedMatcher } = {}): { root: string; stack: Stack } {
  const root = mkdtempSync(join(tmpdir(), 'clue-source-ws-'));
  const workspace = join(root, 'workspace');
  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(workspace, directory), { recursive: true });
  }

  const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'), {
    projectors: { ...SNAPSHOT_PROJECTORS, ...GRAPH_PROJECTORS, ...SCAN_CACHE_PROJECTORS },
  });
  const artifacts = new ArtifactStore(join(workspace, 'blobs'));
  const { log } = EventLog.open(join(workspace, 'events'));
  const missionVersion = (): string => 'MISSION-000001';

  return {
    root,
    stack: {
      projections,
      snapshots: new SnapshotRegistry({ log, projections, artifacts, missionVersion }),
      graph: new GraphRegistry({
        log,
        projections,
        artifacts,
        missionVersion,
        ...(options.isProtected === undefined ? {} : { isProtected: options.isProtected }),
      }),
      cache: new ScanCache({ log, projections, artifacts, missionVersion }),
      dispose(): void {
        log.close();
        projections.close();
      },
    },
  };
}

/* ========================================================================= */
/* Snapshot identity — gate clause 1                                          */
/* ========================================================================= */

test('an unchanged tree produces an identical snapshot id', () => {
  const root = makeProject();
  try {
    const first = captureProject(root);
    const second = captureProject(root);

    assert.equal(first.id, second.id);
    assert.equal(first.stats.file_count, 5);
  } finally {
    removeRoot(root);
  }
});

test('a copied tree at a different path produces the same snapshot id', () => {
  const original = makeProject();
  const copy = makeProject();
  try {
    // Identity is content-only. This is what lets a shadow clone be proven identical to
    // the canonical tree, which every comparative measurement depends on.
    assert.equal(captureProject(original).id, captureProject(copy).id);
  } finally {
    removeRoot(original);
    removeRoot(copy);
  }
});

test('changing one byte changes the snapshot id and nothing else', () => {
  const root = makeProject();
  try {
    const before = captureProject(root);
    writeFixture(root, 'src/core/math.ts', MATH_TS.replace('a + b', 'b + a'));
    const after = captureProject(root);

    assert.notEqual(before.id, after.id);

    const diff = diffSnapshots(before, after);
    assert.deepEqual([...diff.changedPaths], ['src/core/math.ts']);
    assert.equal(diff.modified.length, 1);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.unchangedCount, 4);
  } finally {
    removeRoot(root);
  }
});

test('language classification and subsystem derivation are stable', () => {
  assert.equal(classifyLanguage('src/render/frame.ts'), 'typescript');
  assert.equal(classifyLanguage('src/shaders/ocean.wgsl'), 'wgsl');
  assert.equal(classifyLanguage('assets/tile.ply'), 'binary');
  assert.equal(subsystemOf('src/render/frame.ts'), 'src/render');
  assert.equal(subsystemOf('app.ts'), '.');
});

/* ========================================================================= */
/* Recognition — gate clauses 3 and 4                                         */
/* ========================================================================= */

test('a path alias resolves to a real module', () => {
  const root = makeProject();
  try {
    const result = recogniseProject(root);
    const aliasEdge = result.edges.find(
      (candidate) =>
        candidate.from === 'src/render/frame.ts' &&
        candidate.to === 'src/core/index.ts' &&
        candidate.kind === 'imports',
    );

    // "@core/index" is a string to a syntax parser and a resolved file to the compiler.
    assert.ok(aliasEdge !== undefined, 'the @core alias resolved to src/core/index.ts');
    assert.equal(aliasEdge.external, false);
    assert.equal(aliasEdge.confidence, 1);
  } finally {
    removeRoot(root);
  }
});

test('a call through a barrel attaches to the declaring module, not the barrel', () => {
  const root = makeProject();
  try {
    const result = recogniseProject(root);
    const callEdge = result.edges.find(
      (candidate) => candidate.kind === 'calls' && candidate.to === 'src/core/math.ts#add',
    );

    // `add` is imported from a barrel that re-exports it. Following the alias is the
    // difference between an impact set that is right and one that merely looks plausible.
    assert.ok(callEdge !== undefined, 'the call resolved through the re-export');
    // identity-v4 decorates a declaration id with its kind, so a method is
    // `Class$class.method$method`. The entity is the same one; only the grammar moved.
    assert.equal(callEdge.from, 'src/render/frame.ts#Frame$class.render$method');
  } finally {
    removeRoot(root);
  }
});

test('classes, methods, interfaces and module-level values become units', () => {
  const root = makeProject();
  try {
    const result = recogniseProject(root);
    const ids = new Set(result.units.map((candidate) => candidate.logicalId));

    for (const expected of [
      'src/core/math.ts',
      'src/core/math.ts#add',
      // identity-v4 ids. Verified against the recognizer's real output, not guessed:
      // a module-level value is `$variable`, an interface `$interface`, a class `$class`,
      // a method `Class$class.name$method`. Bare function ids are unchanged.
      'src/core/math.ts#SCALE$variable',
      'src/render/frame.ts#Renderable$interface',
      'src/render/frame.ts#Frame$class',
      'src/render/frame.ts#Frame$class.render$method',
      'src/app.ts#main',
    ]) {
      assert.ok(ids.has(expected), `expected unit ${expected}`);
    }

    const add = result.units.find((candidate) => candidate.logicalId === 'src/core/math.ts#add');
    assert.equal(add?.kind, 'function');
    assert.equal(add?.exported, true);
    assert.equal(add?.parameterCount, 2);
  } finally {
    removeRoot(root);
  }
});

test('units resolve to exact source, including after non-ASCII text', () => {
  const root = makeProject();
  try {
    const result = recogniseProject(root);
    const bytes = readFileSync(join(root, 'src/core/math.ts'));

    const add = result.units.find((candidate) => candidate.logicalId === 'src/core/math.ts#add');
    assert.ok(add !== undefined);

    const slice = bytes.subarray(add.anchor.startByte, add.anchor.endByte).toString('utf8');
    assert.ok(slice.startsWith('export function add'), `anchor pointed at: ${slice.slice(0, 40)}`);
    assert.ok(slice.trimEnd().endsWith('}'));

    // The file opens with two multi-byte characters. A character-based offset would land
    // three bytes early, which still looks like source and is the wrong source.
    const prefix = MATH_TS.slice(0, MATH_TS.indexOf('export function add'));
    assert.equal(add.anchor.startByte, Buffer.byteLength(prefix, 'utf8'));

    for (const candidate of result.units) {
      assert.ok(candidate.anchor.endByte > candidate.anchor.startByte, `${candidate.logicalId} has extent`);
      assert.ok(candidate.anchor.startLine >= 1);
    }
  } finally {
    removeRoot(root);
  }
});

test('a computed dynamic import is reported, not guessed', () => {
  const root = makeProject();
  try {
    const result = recogniseProject(root);
    const reported = result.unresolved.find((entry) => entry.kind === 'dynamic-import');

    assert.ok(reported !== undefined, 'the computed specifier is recorded');
    assert.equal(reported.anchor.path, 'src/dynamic.ts');
    assert.ok(reported.anchor.startLine >= 1);

    // No edge was invented for it. An invented edge would place a dependency in the
    // graph that may not exist, and impact analysis would blame the wrong module.
    const invented = result.edges.filter(
      (candidate) =>
        candidate.from.startsWith('src/dynamic.ts') && !candidate.external && candidate.kind === 'imports',
    );
    assert.equal(invented.length, 0);
  } finally {
    removeRoot(root);
  }
});

test('a project that does not typecheck is still recognisable', () => {
  const root = makeProject();
  try {
    writeFixture(root, 'src/app.ts', `${APP_TS}\nconst broken: number = 'not a number';\n`);
    const result = recogniseProject(root);

    assert.ok(result.stats.semanticDiagnostics > 0, 'the error is counted');
    assert.ok(
      result.units.some((candidate) => candidate.logicalId === 'src/app.ts#main'),
      'recognition continued regardless',
    );
  } finally {
    removeRoot(root);
  }
});

test('restricting extraction does not restrict resolution', () => {
  const root = makeProject();
  try {
    const restricted = recogniseProject(root, ['src/render/frame.ts']);

    assert.equal(restricted.stats.filesRecognised, 1);
    assert.ok(restricted.units.every((candidate) => candidate.modulePath === 'src/render/frame.ts'));

    // The edge still names a unit in a file that was never extracted. Incremental rescan
    // depends on exactly this: partial extraction, whole-program resolution.
    assert.ok(
      restricted.edges.some((candidate) => candidate.to === 'src/core/math.ts#add'),
      'a call into an unextracted module still resolves',
    );
  } finally {
    removeRoot(root);
  }
});

/* ========================================================================= */
/* Classification — gate clause 5                                             */
/* ========================================================================= */

test('every unit gets both axes, a blast radius, a confidence and a percentile', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    const recorded = stack.graph.record(manifest.id, recogniseProject(project));

    assert.ok(recorded.classifications.length > 0);

    for (const entry of recorded.classifications) {
      assert.ok(ALL_QUADRANTS.includes(entry.quadrant), `${entry.logicalId} has a known quadrant`);
      assert.ok(ALL_BLAST_RADII.includes(entry.blastRadius), `${entry.logicalId} has a known radius`);

      // The quadrant is exactly the composition of its two axes, never an independent
      // label that could drift away from them.
      assert.equal(entry.quadrant, quadrantOf(entry.fileSpan, entry.dependencySurface));

      assert.ok(entry.confidence >= 0.3 && entry.confidence <= 1);
      assert.ok(entry.percentile >= 0 && entry.percentile <= 1);
      assert.ok(entry.reasons.length > 0, `${entry.logicalId} explains itself`);
      assert.ok(entry.closureSize >= 1, 'a closure always contains its own subject');
    }
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('a leaf function is monofile-monodependency', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    stack.graph.record(manifest.id, recogniseProject(project));

    // `add` calls nothing. Its behaviour is entirely in one file and reaches out to
    // nothing, which is the shape a first experiment wants.
    const add = stack.graph.classificationOf(manifest.id, 'src/core/math.ts#add');
    assert.ok(add !== null);
    assert.equal(add.fileSpan, 'monofile');
    assert.equal(add.dependencySurface, 'monodependency');
    assert.equal(add.quadrant, 'monofile-monodependency');
    assert.equal(add.closureModules, 1);
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('a behaviour closure absorbs helpers that serve only it', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    stack.graph.record(manifest.id, recogniseProject(project));

    const own = stack.graph.closureOf(manifest.id, 'src/core/math.ts#add');
    assert.ok(own !== null);
    assert.deepEqual([...own.members], ['src/core/math.ts#add']);

    // `main` is the only caller of everything beneath it, so the whole application is
    // its implementation. The closure spans modules, which is what makes it polyfile —
    // a claim about behaviour, not about where a declaration happens to sit.
    const entry = stack.graph.closureOf(manifest.id, 'src/app.ts#main');
    assert.ok(entry !== null);
    assert.ok(entry.members.includes('src/app.ts#main'));
    assert.ok(entry.modules.length > 1, `closure spans ${entry.modules.join(', ')}`);

    const classification = stack.graph.classificationOf(manifest.id, 'src/app.ts#main');
    assert.equal(classification?.fileSpan, 'polyfile');
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('a declared protected surface takes a protected blast radius, whatever its shape', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack({
    isProtected: (candidate) =>
      candidate.logicalId === 'src/core/math.ts#add' ? 'fixture: declared deliberate' : null,
  });
  try {
    const manifest = captureProject(project);
    stack.graph.record(manifest.id, recogniseProject(project));

    const add = stack.graph.classificationOf(manifest.id, 'src/core/math.ts#add');
    assert.ok(add !== null);

    // Shape and protection are independent. The unit is still the easiest possible
    // quadrant; it is simply not available to be changed automatically.
    assert.equal(add.quadrant, 'monofile-monodependency');
    assert.equal(add.blastRadius, 'protected');
    assert.equal(add.protectedReason, 'fixture: declared deliberate');
    assert.ok(add.reasons.some((reason) => reason.includes('protected surface')));

    const safe = stack.graph.candidates(manifest.id, {
      quadrants: ['monofile-monodependency'],
      blastRadii: ['local'],
      minimumConfidence: 0.3,
    });
    assert.equal(
      safe.some((candidate) => candidate.logicalId === 'src/core/math.ts#add'),
      false,
      'a protected unit never appears among safe candidates',
    );
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('candidates are filtered on both axes independently', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    stack.graph.record(manifest.id, recogniseProject(project));

    const narrow = stack.graph.candidates(manifest.id, {
      quadrants: ['monofile-monodependency'],
      blastRadii: ['local'],
      minimumConfidence: 0.3,
    });
    for (const candidate of narrow) {
      assert.equal(candidate.quadrant, 'monofile-monodependency');
      assert.equal(candidate.blastRadius, 'local');
    }
    for (let index = 1; index < narrow.length; index += 1) {
      const previous = narrow[index - 1];
      const current = narrow[index];
      if (previous === undefined || current === undefined) continue;
      assert.ok(previous.confidence >= current.confidence, 'ordered by confidence');
    }

    // Widening one axis can only ever add candidates, never remove them.
    const wider = stack.graph.candidates(manifest.id, {
      quadrants: [...ALL_QUADRANTS],
      blastRadii: ['local'],
      minimumConfidence: 0.3,
      limit: 200,
    });
    assert.ok(wider.length >= narrow.length);
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('impact runs backwards along dependencies and coverage reports the gaps', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    stack.graph.record(manifest.id, recogniseProject(project));

    const impact = stack.graph.impactOf(manifest.id, 'src/core/math.ts#add');
    assert.ok(
      impact.dependents.includes('src/render/frame.ts#Frame$class.render$method'),
      'the caller is in the impact set',
    );
    assert.ok(impact.modules.includes('src/render/frame.ts'));
    assert.equal(impact.truncated, false);

    const dependencies = stack.graph.dependenciesOf(manifest.id, 'src/app.ts#main');
    assert.ok(dependencies.includes('src/render/frame.ts#Frame$class'));

    const coverage = stack.graph.coverage(manifest.id);
    const gap = coverage.find((entry) => entry.units > 0 && entry.unresolved > 0);
    assert.ok(gap !== undefined, 'the module with a computed import shows a gap');
    assert.ok(gap.coverage < 1);
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('the compact export carries both axes for a context pack', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    stack.graph.record(manifest.id, recogniseProject(project));

    const exported = stack.graph.exportCompact(manifest.id, { limit: 50 });
    assert.ok(exported.includes('src/core/math.ts#add'));
    assert.ok(exported.includes('monodependency'), 'the quadrant is visible to a worker');
    assert.ok(exported.includes('blast='), 'so is the reach');
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

/* ========================================================================= */
/* Incremental rescan — gate clause 2                                         */
/* ========================================================================= */

test('a first scan has nothing to reuse and says so', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    const result = recogniseProject(project);
    const plan = stack.cache.plan(diffSnapshots(null, manifest), {
      compilerOptionsHash: result.compilerOptionsHash,
    });

    assert.equal(plan.fullRescan, true);
    assert.equal(plan.fullRescanReason, 'no-previous-recognition');
    assert.equal(plan.estimatedSaving, 0);
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('the extraction surface follows re-exports transitively and imports one hop', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const before = captureProject(project);
    const first = recogniseProject(project);
    stack.graph.record(before.id, first);

    writeFixture(project, 'src/core/math.ts', MATH_TS.replace('a + b', 'b + a'));
    const after = captureProject(project);

    const plan = stack.cache.plan(diffSnapshots(before, after), {
      compilerOptionsHash: first.compilerOptionsHash,
    });

    assert.equal(plan.fullRescan, false);
    assert.deepEqual([...plan.extractionSurface].sort(), [
      'src/core/index.ts',
      'src/core/math.ts',
      'src/render/frame.ts',
    ]);

    // The barrel is in because it re-exports the changed module; the frame is in because
    // it imports the barrel. Files beyond that hop are reusable.
    assert.equal(plan.surfaceReasons['src/core/math.ts'], 'changed');
    assert.equal(plan.surfaceReasons['src/core/index.ts'], 'reexports-changed-module');
    assert.equal(plan.surfaceReasons['src/render/frame.ts'], 'imports-changed-module');
    assert.deepEqual([...plan.carriedFiles].sort(), ['src/app.ts', 'src/dynamic.ts']);
    assert.ok(plan.estimatedSaving > 0);
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('a changed tsconfig forces a full rescan', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const before = captureProject(project);
    const first = recogniseProject(project);
    stack.graph.record(before.id, first);

    writeFixture(project, 'src/core/math.ts', MATH_TS.replace('a + b', 'b + a'));
    const after = captureProject(project);

    // Compiler options change module resolution for files whose bytes never moved, so
    // nothing from the previous program can be trusted.
    const plan = stack.cache.plan(diffSnapshots(before, after), {
      compilerOptionsHash: hashText('a different configuration'),
    });

    assert.equal(plan.fullRescan, true);
    assert.equal(plan.fullRescanReason, 'compiler-options-changed');
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('incremental equals full', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const before = captureProject(project);
    const first = recogniseProject(project);
    stack.graph.record(before.id, first);

    writeFixture(project, 'src/core/math.ts', MATH_TS.replace('a + b', 'b + a'));
    const after = captureProject(project);
    const plan = stack.cache.plan(diffSnapshots(before, after), {
      compilerOptionsHash: first.compilerOptionsHash,
    });
    assert.equal(plan.fullRescan, false);

    // Path A — the incremental route: reuse what the plan says is safe, re-extract the
    // surface, and reclassify only what the cache says could have moved.
    const carried = stack.cache.carryForward(plan);
    assert.ok(carried.unitsCarried > 0, 'something was actually reused');

    const surface = stack.cache.classificationSurface(plan);
    stack.graph.record(after.id, recogniseProject(project, plan.extractionSurface), {
      complete: true,
      classify: { only: surface },
    });

    // Path B — the honest route: recognise the whole tree again, recorded under a
    // synthetic identity so both projections can live side by side and be compared.
    const fullAlias = hashText(`full:${after.id}`);
    stack.graph.record(fullAlias, recogniseProject(project));

    const comparison = stack.cache.compareProjections(fullAlias, after.id);

    assert.deepEqual([...comparison.unitsOnlyInA], [], 'no unit was lost by the cache');
    assert.deepEqual([...comparison.unitsOnlyInB], [], 'no unit was invented by the cache');
    assert.deepEqual([...comparison.unitsDiffering], [], 'no unit carried a stale version hash');
    assert.equal(comparison.identical, true, 'the incremental graph is the full graph');
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('a deleted file leaves no orphan units behind', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const before = captureProject(project);
    stack.graph.record(before.id, recogniseProject(project));

    rmSync(join(project, 'src/dynamic.ts'));
    const after = captureProject(project);
    const diff = diffSnapshots(before, after);

    assert.equal(diff.removed.length, 1);
    assert.equal(diff.removed[0]?.path, 'src/dynamic.ts');

    const plan = stack.cache.plan(diff, {
      compilerOptionsHash: recogniseProject(project).compilerOptionsHash,
    });
    assert.deepEqual([...plan.droppedFiles], ['src/dynamic.ts']);
    assert.equal(
      plan.carriedFiles.includes('src/dynamic.ts'),
      false,
      'a removed file is never carried forward',
    );
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

/* ========================================================================= */
/* Durability                                                                 */
/* ========================================================================= */

test('the graph survives losing the database', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    const recorded = stack.graph.record(manifest.id, recogniseProject(project));
    const unitsBefore = recorded.classifications.length;

    // Simulate the projection being discarded while the evidence survives. The handle
    // comes from ProjectionStore, which exposes one; the registries do not, and reaching
    // for a `db` member on GraphRegistry is what stopped revision 1 compiling.
    stack.projections.db.prepare('DELETE FROM units WHERE snapshot_id = ?').run(manifest.id);
    stack.projections.db.prepare('DELETE FROM graph_edges WHERE snapshot_id = ?').run(manifest.id);
    assert.equal(stack.graph.impactOf(manifest.id, 'src/core/math.ts#add').dependents.length, 0);

    assert.equal(stack.graph.rehydrate(manifest.id), true);
    assert.ok(
      stack.graph.impactOf(manifest.id, 'src/core/math.ts#add').dependents.length > 0,
      'the graph came back from the artifact',
    );
    assert.equal(stack.graph.classify(manifest.id).length, unitsBefore);
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('a recognition result round-trips through the artifact store', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const manifest = captureProject(project);
    const result = recogniseProject(project);
    stack.graph.record(manifest.id, result);

    const stored = stack.graph.resultOf(manifest.id);
    assert.ok(stored !== null);
    assert.equal(stored.units.length, result.units.length);
    assert.equal(stored.edges.length, result.edges.length);
    assert.equal(stored.unresolved.length, result.unresolved.length);

    const record = stack.graph.recognition(manifest.id);
    assert.equal(record?.unit_count, result.units.length);
    assert.equal(record?.complete, true);
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

test('snapshots are stored, diffed and re-read from their manifests', () => {
  const project = makeProject();
  const { root: workspaceRoot, stack } = openStack();
  try {
    const first = stack.snapshots.capture({
      root: project,
      sourceRoots: ['src'],
      origin: 'canonical',
    });
    assert.equal(first.alreadyKnown, false);
    assert.equal(first.record.file_count, 5);

    writeFixture(
      project,
      'src/app.ts',
      APP_TS.replace('const frame', 'const renderFrame').replace('frame.render', 'renderFrame.render'),
    );
    const second = stack.snapshots.capture({
      root: project,
      sourceRoots: ['src'],
      origin: 'canonical',
    });

    assert.notEqual(second.record.id, first.record.id);
    assert.ok(second.diff !== null);
    assert.deepEqual([...(second.diff?.changedPaths ?? [])], ['src/app.ts']);

    const manifest = stack.snapshots.manifestOf(second.record.id);
    assert.equal(manifest?.stats.file_count, 5);
    assert.equal(stack.snapshots.files(second.record.id).length, 5);
  } finally {
    stack.dispose();
    removeRoot(workspaceRoot);
    removeRoot(project);
  }
});

/* ========================================================================= */
/* Coverage semantics                                                         */
/* ========================================================================= */

// Pure math over the recognizer's own counts — no compiler fixture needed. These four
// tests pin the honesty contract of the coverage report: a finished scan is not
// finished recognition, and absent evidence never reads as complete. Each was a live
// defect once (P0.2): staticRecognition duplicated the fileScan formula, and
// runtimeEnrichment reported a fabricated 0/0 = 100% on both the CLI and the durable
// console-record path.

function coverageStats(overrides: Partial<RecognitionStats> = {}): RecognitionStats {
  return {
    filesInProgram: 40,
    filesRecognised: 40,
    unitsByKind: { function: 120, class: 20 },
    edgesByKind: { calls: 300 },
    unresolvedByKind: {},
    syntacticDiagnostics: 0,
    semanticDiagnostics: 0,
    elapsedMs: 5,
    ...overrides,
  };
}

function unresolvedReference(): UnresolvedReference {
  return {
    kind: 'module-unresolved',
    detail: 'dynamic import the static pass cannot follow',
    anchor: { path: 'src/app.ts', startLine: 1, endLine: 1, startByte: 0, endByte: 1 },
    fromLogicalId: null,
  };
}

test('a finished scan is not finished recognition: the measures separate', () => {
  // The census carries files the static pipeline cannot analyse. They must widen the
  // staticRecognition denominator — present-but-unrecognised is named residual, not a
  // silent gap — while fileScan legitimately reports a complete scan of the program.
  // Before the fix both measures were the same formula and could never disagree.
  const coverage = computeCoverage({
    stats: coverageStats(),
    unresolved: [],
    languageCensus: { typescript: 40, javascript: 3, yaml: 6, powershell: 1, markdown: 2 },
  });

  assert.equal(coverage.fileScan.ratio, 1);
  assert.equal(coverage.scanComplete, true);
  assert.equal(coverage.staticRecognition.covered, 40);
  assert.equal(coverage.staticRecognition.total, 49, 'program files plus unsupported census files');
  assert.ok(coverage.staticRecognition.ratio < 1, 'unsupported surface lowers recognition, not scan');
  assert.equal(coverage.residual.unsupportedLanguageFiles, 9);
});

test('zero runtime evidence reads as zero, never as complete', () => {
  // measure(0, 0) once turned “no runtime evidence” into ratio 1. The denominator is
  // now the real unit-bearing surface, so nothing-observed over something-real is 0%.
  const live = computeCoverage({
    stats: coverageStats(),
    unresolved: [],
    languageCensus: { typescript: 40 },
  });
  assert.equal(live.runtimeEnrichment.covered, 0);
  assert.equal(live.runtimeEnrichment.total, 140, 'recognised units are the surface');
  assert.equal(live.runtimeEnrichment.ratio, 0);
  assert.equal(live.recognitionComplete, false);

  // The durable console record carries no unit census (unitsByKind is empty on that
  // path). The surface falls back to recognised files; the fabricated 100% must not
  // survive on the projector path either.
  const durable = computeCoverage({
    stats: coverageStats({ unitsByKind: {} }),
    unresolved: [],
    languageCensus: { typescript: 40 },
  });
  assert.equal(durable.runtimeEnrichment.total, 40, 'falls back to recognised files');
  assert.equal(durable.runtimeEnrichment.ratio, 0);
  assert.notEqual(durable.runtimeEnrichment.ratio, 1, 'no fabricated completeness');
});

test('recognition is complete only when nothing is outstanding', () => {
  // Perfect static recognition and full dependency resolution are not enough: the
  // flag's documented meaning includes “no runtime enrichment outstanding”, so a
  // static-only pass over a real surface reports false — the honest answer.
  const staticOnly = computeCoverage({
    stats: coverageStats(),
    unresolved: [],
    languageCensus: { typescript: 40 },
  });
  assert.equal(staticOnly.staticRecognition.ratio, 1);
  assert.equal(staticOnly.dependencyResolution.ratio, 1);
  assert.equal(staticOnly.recognitionComplete, false, 'runtime enrichment is outstanding');

  const withUnresolved = computeCoverage({
    stats: coverageStats(),
    unresolved: [unresolvedReference()],
    languageCensus: { typescript: 40 },
  });
  assert.ok(withUnresolved.dependencyResolution.ratio < 1);
  assert.equal(withUnresolved.residual.unresolvedTotal, 1);
  assert.equal(withUnresolved.recognitionComplete, false);
});

test('absent census invents nothing, and an empty program stays vacuous', () => {
  // Without a census, no unsupported files are guessed and the recognition surface
  // degrades to the program itself.
  const noCensus = computeCoverage({ stats: coverageStats(), unresolved: [] });
  assert.equal(noCensus.residual.unsupportedLanguageFiles, 0);
  assert.equal(noCensus.staticRecognition.total, 40);

  // An empty program has nothing to scan and nothing to enrich. The documented
  // zero-denominator rule (“nothing to miss”) applies deliberately — the fixed defect
  // was a fabricated zero denominator on a real surface, not this vacuous edge.
  const empty = computeCoverage({
    stats: coverageStats({ filesInProgram: 0, filesRecognised: 0, unitsByKind: {}, edgesByKind: {} }),
    unresolved: [],
  });
  assert.equal(empty.fileScan.ratio, 1);
  assert.equal(empty.runtimeEnrichment.ratio, 1);
  assert.equal(empty.recognitionComplete, true);
});

/* ========================================================================= */
/* DEV-P0-03 — recognition validates against an exact immutable snapshot      */
/* ========================================================================= */

const isTsFile = (path: string): boolean => /\.tsx?$/.test(path);

test('program/snapshot parity: exact match, unaccounted files, and classified omissions', () => {
  const pf = (path: string, seed: string): ProgramFile => ({ path, hash: hashText(seed) });
  const sf = (path: string, seed: string): { path: string; hash: string } => ({ path, hash: hashText(seed) });

  // Exact: every program file matches a snapshot file hash, and every snapshot file is in the program.
  const exact = verifyProgramSnapshotParity(
    [pf('src/a.ts', 'A'), pf('src/b.ts', 'B')],
    [sf('src/a.ts', 'A'), sf('src/b.ts', 'B')],
    isTsFile,
  );
  assert.equal(exact.exact, true);
  assert.deepEqual(exact.matched, ['src/a.ts', 'src/b.ts']);

  // A program file whose bytes differ from the snapshot is unaccounted — a live file not in evidence.
  const tampered = verifyProgramSnapshotParity([pf('src/a.ts', 'CHANGED')], [sf('src/a.ts', 'A')], isTsFile);
  assert.equal(tampered.exact, false);
  assert.deepEqual(tampered.unaccounted, ['src/a.ts']);

  // A program file absent from the snapshot entirely is unaccounted.
  const extra = verifyProgramSnapshotParity([pf('src/a.ts', 'A'), pf('src/ghost.ts', 'G')], [sf('src/a.ts', 'A')], isTsFile);
  assert.deepEqual(extra.unaccounted, ['src/ghost.ts']);

  // A supported snapshot file the program did not analyse is a real gap (not exact).
  const gap = verifyProgramSnapshotParity([pf('src/a.ts', 'A')], [sf('src/a.ts', 'A'), sf('src/b.ts', 'B')], isTsFile);
  assert.equal(gap.exact, false);
  assert.deepEqual(gap.supportedOmitted, ['src/b.ts']);

  // An unsupported snapshot file (a README, an asset) the program did not analyse is correctly omitted.
  const ok = verifyProgramSnapshotParity([pf('src/a.ts', 'A')], [sf('src/a.ts', 'A'), sf('README.md', 'R')], isTsFile);
  assert.equal(ok.exact, true);
  assert.deepEqual(ok.unsupportedOmitted, ['README.md']);
});

test('a real recognition proves exact parity with a snapshot of the same tree, and detects drift', () => {
  const root = makeProject();
  try {
    const result = recogniseProject(root);
    const manifest = captureProject(root);

    const parity = verifyProgramSnapshotParity(result.programFiles, manifest.files, isTsFile);
    assert.equal(parity.unaccounted.length, 0, 'every analysed file matches a snapshot file hash');
    assert.equal(parity.exact, true, 'the analysed program equals the snapshot evidence');

    // Change a file after the snapshot was taken; re-recognition no longer matches that snapshot.
    const target = result.programFiles[0];
    assert.ok(target !== undefined);
    writeFixture(root, target.path, '// drift\nexport const drift = 1;\n');
    const drifted = recogniseProject(root);
    const afterDrift = verifyProgramSnapshotParity(drifted.programFiles, manifest.files, isTsFile);
    assert.equal(afterDrift.exact, false, 'a changed live file no longer matches the immutable snapshot');
    assert.ok(afterDrift.unaccounted.includes(target.path), 'the drifted file is reported unaccounted');
  } finally {
    removeRoot(root);
  }
});
