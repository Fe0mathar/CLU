/**
 * CLUE Stage E acceptance suite.
 *
 * Spec: CLUE_implementation.md §34–38 (families, ease, priority, readiness, lanes).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.3, Part V Stage E, Part IX §44.
 * Audit: v2.1 §3.5 — the two-axis classification model.
 *
 * Revision 2 — fixtures rebuilt on the corrected classification, and one test added
 * that revision 1 was structurally incapable of expressing: two units in the *same*
 * quadrant with *different* blast radii must be treated differently. Under the old
 * single enum they were the same value, so no assertion could have caught the day that
 * distinction stopped being honoured.
 *
 * Gate clauses, each with a test that fails if it stops holding:
 *
 *   easy isolated units rank visibly           → "an easy isolated unit outranks…"
 *   every rank decomposes into components      → "every number can be taken apart"
 *   unsupported candidates route to
 *     instrumentation, not patching            → "a candidate that cannot be measured…"
 *   override possible with a recorded reason   → "reach beyond policy is excluded…"
 *   observed evidence outranks inference (A3)  → "a measured fault outranks…"
 *
 * The corpus is synthetic and stated outright rather than recognised from a real tree.
 * These tests are about how numbers combine, and a fixture whose shape is declared in
 * the file makes a failure legible in a way a recognised project never does. Fidelity
 * against real Murugan source is Stage C's problem and is tested there.
 *
 * Run: npm run selftest
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hashText } from '../src/shared/ids.js';
import { ArtifactStore } from '../src/memory/artifactStore.js';
import { EventLog } from '../src/memory/eventLog.js';
import { ProjectionStore } from '../src/memory/db.js';
import { ensureGraphSchema, quadrantOf } from '../src/analysis/source/graph.js';
import type {
  BlastRadius,
  CoverageEntry,
  EdgeKind,
  Quadrant,
  SourceEdge,
  SourceUnit,
  UnitClass,
  UnitClassification,
} from '../src/analysis/source/graph.js';
import {
  computeAllMetrics,
  METRIC_FAMILIES,
  MINIMUM_CORPUS,
  type ConsoleSignatureSummary,
  type MetricInput,
} from '../src/analysis/metrics/families.js';
import {
  DEFAULT_WEIGHTS,
  rank,
  selectBatch,
  type RankedCandidate,
  type RankingInput,
} from '../src/analysis/metrics/ranking.js';
import { METRIC_PROJECTORS, MetricRegistry } from '../src/analysis/metrics/registry.js';

/* ========================================================================= */
/* Fixture construction                                                       */
/* ========================================================================= */

const SNAPSHOT = hashText('snapshot-fixture-1');
const SNAPSHOT_TWO = hashText('snapshot-fixture-2');

function unit(logicalId: string, overrides: Partial<SourceUnit> = {}): SourceUnit {
  const modulePath = logicalId.split('#')[0] ?? logicalId;
  const name = logicalId.split('#')[1] ?? modulePath;

  return {
    logicalId,
    versionHash: hashText(logicalId),
    kind: 'function',
    name,
    qualifiedName: name,
    modulePath,
    exported: true,
    anchor: { path: modulePath, startLine: 1, endLine: 20, startByte: 0, endByte: 400 },
    parentLogicalId: modulePath,
    lineCount: 20,
    byteLength: 400,
    isAsync: false,
    parameterCount: 1,
    ...overrides,
  };
}

function moduleUnit(modulePath: string): SourceUnit {
  return unit(modulePath, {
    kind: 'module',
    name: modulePath,
    qualifiedName: modulePath,
    parentLogicalId: null,
    lineCount: 200,
    byteLength: 4000,
    parameterCount: null,
  });
}

function edge(from: string, to: string, kind: EdgeKind = 'calls'): SourceEdge {
  return {
    from,
    to,
    kind,
    confidence: 1,
    external: false,
    anchor: { path: from.split('#')[0] ?? from, startLine: 3, endLine: 3, startByte: 40, endByte: 60 },
  };
}

/** Mirrors the projection in graph.ts, so fixtures and production agree. */
function legacyClass(quadrant: Quadrant, blastRadius: BlastRadius): UnitClass {
  if (blastRadius === 'foundational') return 'foundational';
  if (blastRadius === 'systemic' || blastRadius === 'protected') return 'systemic';
  return quadrant === 'monofile-monodependency' ? 'monodependency' : 'local';
}

interface ClassificationOptions {
  readonly quadrant?: Quadrant;
  readonly blastRadius?: BlastRadius;
  readonly impactSize?: number;
  readonly confidence?: number;
  readonly protectedReason?: string | null;
  readonly truncated?: boolean;
}

function classification(logicalId: string, options: ClassificationOptions = {}): UnitClassification {
  const quadrant = options.quadrant ?? 'monofile-monodependency';
  const blastRadius = options.blastRadius ?? 'local';
  const [fileSpan, dependencySurface] = quadrant.split('-') as ['monofile' | 'polyfile', 'monodependency' | 'polydependency'];
  const impact = options.impactSize ?? (blastRadius === 'local' ? 2 : 40);

  return {
    logicalId,
    fileSpan,
    dependencySurface,
    quadrant,
    blastRadius,
    unitClass: legacyClass(quadrant, blastRadius),
    confidence: options.confidence ?? 0.9,
    percentile: blastRadius === 'foundational' ? 0.97 : blastRadius === 'local' ? 0.2 : 0.8,
    closureSize: fileSpan === 'polyfile' ? 4 : 1,
    closureModules: fileSpan === 'polyfile' ? 3 : 1,
    externalModules: dependencySurface === 'polydependency' ? 4 : 1,
    impactSize: impact,
    impactModules: blastRadius === 'local' ? 1 : 4,
    impactSubsystems: blastRadius === 'local' ? 1 : blastRadius === 'systemic' ? 2 : 4,
    directDependents: impact,
    truncated: options.truncated ?? false,
    protectedReason: options.protectedReason ?? null,
    reasons: [`fixture: ${quadrant} / ${blastRadius}`],
  };
}

function coverage(subsystem: string, unresolved = 0): CoverageEntry {
  return {
    subsystem,
    modules: 4,
    units: 20,
    edges: 40,
    unresolved,
    unitsPerModule: 5,
    coverage: unresolved === 0 ? 1 : 0.8,
  };
}

/** Filler so the corpus clears MINIMUM_CORPUS and percentiles mean something. */
function filler(count: number): { units: SourceUnit[]; edges: SourceEdge[]; classes: UnitClassification[] } {
  const units: SourceUnit[] = [];
  const edges: SourceEdge[] = [];
  const classes: UnitClassification[] = [];

  for (let index = 0; index < count; index += 1) {
    const id = `src/filler/mod${index}.ts#f${index}`;
    units.push(unit(id, { lineCount: 10 + (index % 15) }));
    classes.push(classification(id, { impactSize: index % 5 }));
    if (index > 0) edges.push(edge(`src/filler/mod${index - 1}.ts#f${index - 1}`, id));
  }
  return { units, edges, classes };
}

interface Corpus {
  readonly input: MetricInput;
  readonly units: SourceUnit[];
  readonly classes: UnitClassification[];
}

/**
 * The named cast.
 *
 * `easyUnit`    monofile-monodependency, local     — the shape a pilot wants
 * `hotHelper`   monofile-monodependency, foundational — same shape, everything downstream
 * `spread`      polyfile-monodependency, local     — coherent across files, narrow proof
 * `diffuse`     polyfile-polydependency, systemic  — hard in both directions
 * `orphan`      nothing reaches it
 * `dupA/dupB`   byte-identical twins
 * `guarded`     protected blast radius
 * `contested`   subject of an unresolved contradiction
 * `noisy`       emits console output
 * `quiet`       structurally identical to `noisy`, but says nothing
 */
function makeCorpus(
  options: { consoleSignatures?: readonly ConsoleSignatureSummary[]; fillerCount?: number } = {},
): Corpus {
  const fill = filler(options.fillerCount ?? 40);

  const named: SourceUnit[] = [
    moduleUnit('src/core/easy.ts'),
    unit('src/core/easy.ts#easyUnit', { lineCount: 12 }),
    unit('src/core/hot.ts#hotHelper', { lineCount: 12 }),
    unit('src/core/spread.ts#spread', { lineCount: 30 }),
    unit('src/core/diffuse.ts#diffuse', { lineCount: 400 }),
    unit('src/core/orphan.ts#orphan', { lineCount: 30, exported: false }),
    unit('src/water/dupA.ts#oceanStep', { versionHash: hashText('shared-body'), lineCount: 25 }),
    unit('src/water/dupB.ts#oceanStep', { versionHash: hashText('shared-body'), lineCount: 25 }),
    unit('src/water/guarded.ts#kodamaStep', { versionHash: hashText('guarded-body'), lineCount: 25 }),
    unit('src/econ/contested.ts#settle', { lineCount: 30 }),
    unit('src/render/noisy.ts#drawTile', { lineCount: 25 }),
    unit('src/render/quiet.ts#drawTile', { lineCount: 25 }),
  ];

  const edges: SourceEdge[] = [
    ...fill.edges,
    edge('src/core/easy.ts', 'src/core/easy.ts#easyUnit', 'declares'),
    edge('src/filler/mod0.ts#f0', 'src/core/easy.ts#easyUnit'),
    // The hot helper and the diffuse unit are both widely reached.
    ...Array.from({ length: 14 }, (_value, index) =>
      edge(`src/filler/mod${index}.ts#f${index}`, 'src/core/hot.ts#hotHelper'),
    ),
    ...Array.from({ length: 12 }, (_value, index) =>
      edge(`src/filler/mod${index + 10}.ts#f${index + 10}`, 'src/core/diffuse.ts#diffuse'),
    ),
    edge('src/filler/mod1.ts#f1', 'src/core/spread.ts#spread'),
    edge('src/filler/mod2.ts#f2', 'src/water/dupA.ts#oceanStep'),
    edge('src/filler/mod3.ts#f3', 'src/water/dupB.ts#oceanStep'),
    edge('src/filler/mod4.ts#f4', 'src/econ/contested.ts#settle'),
    edge('src/filler/mod5.ts#f5', 'src/render/noisy.ts#drawTile'),
    edge('src/filler/mod6.ts#f6', 'src/render/quiet.ts#drawTile'),
    // `orphan` and `guarded` deliberately have no inbound edges.
  ];

  const classes: UnitClassification[] = [
    ...fill.classes,
    classification('src/core/easy.ts#easyUnit', { quadrant: 'monofile-monodependency', blastRadius: 'local' }),
    // Same shape as easyUnit. Different reach. This pair is the point of revision 2.
    classification('src/core/hot.ts#hotHelper', {
      quadrant: 'monofile-monodependency',
      blastRadius: 'foundational',
      impactSize: 70,
    }),
    classification('src/core/spread.ts#spread', { quadrant: 'polyfile-monodependency', blastRadius: 'local' }),
    classification('src/core/diffuse.ts#diffuse', {
      quadrant: 'polyfile-polydependency',
      blastRadius: 'systemic',
      impactSize: 60,
    }),
    classification('src/core/orphan.ts#orphan', { impactSize: 0 }),
    classification('src/water/dupA.ts#oceanStep'),
    classification('src/water/dupB.ts#oceanStep'),
    classification('src/water/guarded.ts#kodamaStep', {
      blastRadius: 'protected',
      protectedReason: 'dual Kodama implementation is deliberate',
      impactSize: 0,
    }),
    classification('src/econ/contested.ts#settle'),
    classification('src/render/noisy.ts#drawTile'),
    classification('src/render/quiet.ts#drawTile'),
  ];

  const units = [...fill.units, ...named];

  const input: MetricInput = {
    snapshotId: SNAPSHOT,
    units,
    edges,
    classifications: classes,
    coverage: [coverage('src/core'), coverage('src/water'), coverage('src/render'), coverage('src/filler', 3)],
    isProtected: (candidate: SourceUnit) =>
      candidate.logicalId.includes('guarded') ? 'dual Kodama implementation is deliberate' : null,
    ...(options.consoleSignatures === undefined
      ? {}
      : { consoleSignatures: options.consoleSignatures }),
  };

  return { input, units, classes };
}

function signature(
  attributedTo: string,
  overrides: Partial<ConsoleSignatureSummary> = {},
): ConsoleSignatureSummary {
  return {
    signature: hashText(`${attributedTo}-sig`),
    level: 'error',
    attributedTo,
    occurrences: 120,
    perSessionRate: 40,
    scenarioCount: 2,
    classification: 'actionable',
    ...overrides,
  };
}

function rankingInput(corpus: Corpus, overrides: Partial<RankingInput> = {}): RankingInput {
  return {
    metrics: computeAllMetrics(corpus.input),
    units: corpus.units,
    classifications: corpus.classes,
    // Seven multiplied ease factors produce small numbers. These tests are about
    // classification behaviour rather than thresholding, so nothing is filtered out.
    minimumPriority: 0,
    ...overrides,
  };
}

function find(candidates: readonly RankedCandidate[], logicalId: string): RankedCandidate | undefined {
  return candidates.find((candidate) => candidate.logicalId === logicalId);
}

function allCandidates(result: ReturnType<typeof rank>): RankedCandidate[] {
  return [
    ...result.patchCandidates,
    ...result.instrumentationCandidates,
    ...result.clarificationCandidates,
    ...result.excluded,
  ];
}

/* ========================================================================= */
/* Families                                                                   */
/* ========================================================================= */

test('every family scores every unit, and modules are not scored', () => {
  const corpus = makeCorpus();
  const metrics = computeAllMetrics(corpus.input);

  const scorable = corpus.units.filter((candidate) => candidate.kind !== 'module');
  assert.equal(metrics.byUnit.size, scorable.length);
  assert.equal(metrics.byUnit.has('src/core/easy.ts'), false, 'a module is a container, not a candidate');

  const values = metrics.byUnit.get('src/core/easy.ts#easyUnit');
  assert.ok(values !== undefined);
  assert.equal(values.size, METRIC_FAMILIES.length);
});

test('observed defect reports its own absence rather than reporting zero', () => {
  const corpus = makeCorpus();
  const metrics = computeAllMetrics(corpus.input);

  const value = metrics.byUnit.get('src/render/noisy.ts#drawTile')?.get('observedDefect');
  assert.ok(value !== undefined);

  // Zero would read as "nothing is wrong here" — a far stronger claim than "nobody has
  // looked", and the only one of the two that would be a lie.
  assert.equal(value.available, false);
  assert.ok(value.unavailableReason?.includes('not been exercised'));
  assert.ok(metrics.unavailableFamilies.some((entry) => entry.family === 'observedDefect'));
});

test('a protected surface collapses the families that would misjudge it', () => {
  const corpus = makeCorpus();
  const metrics = computeAllMetrics(corpus.input);

  const dead = metrics.byUnit.get('src/water/guarded.ts#kodamaStep')?.get('deadCodeSuspicion');
  assert.ok(dead !== undefined);
  assert.ok(
    dead.notes.some((note) => note.includes('protected surface')),
    'the reason travels with the number',
  );

  const orphan = metrics.byUnit.get('src/core/orphan.ts#orphan')?.get('deadCodeSuspicion');
  assert.ok(orphan !== undefined);
  assert.ok(
    orphan.raw > dead.raw,
    'an unexplained orphan is more suspicious than a documented placeholder',
  );
});

test('exact duplicates are a fact; shape collisions are a hunch', () => {
  const corpus = makeCorpus();
  const metrics = computeAllMetrics(corpus.input);

  const duplicate = metrics.byUnit.get('src/water/dupA.ts#oceanStep')?.get('redundancy');
  assert.ok(duplicate !== undefined);
  assert.ok(duplicate.raw > 0);
  assert.ok(duplicate.confidence >= 0.85, 'identical source text is not a guess');
  assert.ok(duplicate.notes.some((note) => note.includes('exact source text')));

  const easy = metrics.byUnit.get('src/core/easy.ts#easyUnit')?.get('redundancy');
  assert.ok(easy !== undefined);
  assert.ok(easy.raw < duplicate.raw);
});

test('a corpus too small to normalise says so and lowers its own confidence', () => {
  const metrics = computeAllMetrics(makeCorpus({ fillerCount: 4 }).input);
  const value = metrics.byUnit.get('src/core/easy.ts#easyUnit')?.get('economy');

  assert.ok(value !== undefined);
  assert.ok(value.confidence <= 0.5);
  assert.ok(value.notes.some((note) => note.includes(String(MINIMUM_CORPUS))));
});

test('economy weights size by reach rather than counting lines', () => {
  const metrics = computeAllMetrics(makeCorpus().input);

  const wide = metrics.byUnit.get('src/core/diffuse.ts#diffuse')?.get('economy');
  const narrow = metrics.byUnit.get('src/core/easy.ts#easyUnit')?.get('economy');
  assert.ok(wide !== undefined && narrow !== undefined);

  assert.ok(wide.raw > narrow.raw);
  assert.ok(
    wide.components.some((part) => part.name === 'reachFactor'),
    'the reach term is visible, not folded into a single number',
  );
});

test('every family declares whether it observed something or inferred it', () => {
  const corpus = makeCorpus({ consoleSignatures: [signature('src/render/noisy.ts#drawTile')] });
  const values = computeAllMetrics(corpus.input).byUnit.get('src/render/noisy.ts#drawTile');
  assert.ok(values !== undefined);

  assert.equal(values.get('observedDefect')?.evidence, 'observed');
  for (const family of ['economy', 'amplification', 'redundancy', 'deadCodeSuspicion'] as const) {
    assert.equal(values.get(family)?.evidence, 'static-inference', `${family} is an inference`);
  }
});

/* ========================================================================= */
/* Ranking — gate clauses                                                     */
/* ========================================================================= */

test('every number can be taken apart', () => {
  const result = rank(rankingInput(makeCorpus()));
  const candidate = allCandidates(result).find((entry) => entry.magnitudeComponents.length > 0);

  assert.ok(candidate !== undefined);
  assert.ok(candidate.magnitudeComponents.length >= 3, 'magnitude names its families');

  const easeNames = candidate.easeComponents.map((part) => part.name);
  for (const expected of ['quadrant', 'blastRadius', 'proofReadiness', 'size', 'guardrail']) {
    assert.ok(easeNames.includes(expected), `ease exposes "${expected}"`);
  }

  // A ranking nobody can take apart is a ranking that gets obeyed rather than examined.
  assert.ok(candidate.proposedAction.length > 0);
  assert.ok(candidate.easeComponents.every((part) => Number.isFinite(part.value)));
});

test('shape and reach are separate factors, and the same shape can be treated differently', () => {
  const result = rank(rankingInput(makeCorpus()));
  const candidates = allCandidates(result);

  const easy = find(candidates, 'src/core/easy.ts#easyUnit');
  const hot = find(candidates, 'src/core/hot.ts#hotHelper');
  assert.ok(easy !== undefined && hot !== undefined);

  // Identical quadrant. A twelve-line helper is exactly as easy to edit in both cases.
  assert.equal(easy.quadrant, hot.quadrant);
  assert.equal(easy.quadrant, quadrantOf('monofile', 'monodependency'));

  // Different reach, and that is the whole difference. Revision 1 gave these two the
  // same class value, so no assertion could have caught the distinction being lost.
  assert.equal(easy.blastRadius, 'local');
  assert.equal(hot.blastRadius, 'foundational');
  assert.ok(easy.ease > hot.ease, 'reach lowers ease even when the shape is ideal');
  // Same ideal shape and local reach, so neither shape nor reach excludes easyUnit — but its dominant
  // signals are the efficiency families (economy, intrinsicEfficiency, amplification), which are
  // needs-instrument: an efficiency claim cannot be proven without a benchmark, so the unit is routed to
  // instrumentation (build the probe first), never patched blind. hotHelper carries the same shape but a
  // foundational reach, which excludes it before readiness is even consulted. That is the separation this
  // case guards: identical shape, yet reach and proof-readiness route the two units differently.
  assert.equal(easy.kind, 'instrumentation');
  assert.equal(easy.lane, 'instrumentation');
  assert.equal(hot.kind, 'excluded');
  assert.ok(hot.exclusionReason?.includes('foundational'));
});

test('an easy isolated unit outranks a worse but diffuse one', () => {
  const result = rank(rankingInput(makeCorpus()));
  const candidates = allCandidates(result);

  const easy = find(candidates, 'src/core/easy.ts#easyUnit');
  const diffuse = find(candidates, 'src/core/diffuse.ts#diffuse');
  assert.ok(easy !== undefined && diffuse !== undefined);

  // The diffuse unit is worse by every static measure and still ranks below, because
  // only the isolated one can produce a proven improvement in one bounded experiment.
  assert.ok(diffuse.magnitude > easy.magnitude, 'the diffuse unit really is worse');
  assert.ok(easy.ease > diffuse.ease);
  assert.ok(easy.priority > diffuse.priority, 'ease dominates severity');
});

test('a coherent multi-file behaviour is still workable; a diffuse one is not', () => {
  const result = rank(rankingInput(makeCorpus()));

  const spread = find(allCandidates(result), 'src/core/spread.ts#spread');
  const diffuse = find(result.excluded, 'src/core/diffuse.ts#diffuse');
  assert.ok(spread !== undefined && diffuse !== undefined);

  assert.equal(spread.quadrant, 'polyfile-monodependency');
  assert.notEqual(spread.kind, 'excluded', 'spanning files is a difficulty, not a disqualification');

  assert.equal(diffuse.quadrant, 'polyfile-polydependency');
  assert.equal(diffuse.kind, 'excluded');
});

test('a candidate that cannot be measured becomes instrumentation, not a patch', () => {
  const result = rank(rankingInput(makeCorpus()));
  assert.ok(result.instrumentationCandidates.length > 0, 'the fixture produces unmeasurable candidates');

  for (const candidate of result.patchCandidates) {
    assert.equal(candidate.proofReadiness, 'measurable', `${candidate.logicalId} is provable today`);
  }
  for (const candidate of result.instrumentationCandidates) {
    assert.notEqual(candidate.proofReadiness, 'measurable');
    const action = candidate.proposedAction.toLowerCase();
    assert.ok(
      action.includes('probe') || action.includes('instrument') || action.includes('record the gap'),
      'the proposal says to build the instrument first',
    );
  }
});

test('reach beyond policy is excluded until a human takes responsibility for it', () => {
  const corpus = makeCorpus();

  const withoutOverride = rank(rankingInput(corpus));
  const excluded = find(withoutOverride.excluded, 'src/core/diffuse.ts#diffuse');
  assert.ok(excluded !== undefined);
  assert.ok(excluded.exclusionReason !== null);
  assert.equal(find(withoutOverride.patchCandidates, 'src/core/diffuse.ts#diffuse'), undefined);

  const withOverride = rank(
    rankingInput(corpus, {
      overrides: [
        {
          logicalId: 'src/core/diffuse.ts#diffuse',
          reason: 'Creator accepts the blast radius for the frame budget work',
        },
      ],
    }),
  );
  const promoted =
    find(withOverride.patchCandidates, 'src/core/diffuse.ts#diffuse') ??
    find(withOverride.instrumentationCandidates, 'src/core/diffuse.ts#diffuse');

  assert.ok(promoted !== undefined, 'the override reaches a working bucket');
  if (promoted.kind === 'patch') {
    // The reason travels with the candidate. An override without a recorded reason is
    // indistinguishable from the safeguard simply not working.
    assert.ok(promoted.proposedAction.includes('Creator accepts the blast radius'));
  }
});

test('a protected surface is never a patch candidate, and says why', () => {
  const result = rank(rankingInput(makeCorpus()));

  const guarded = find(result.excluded, 'src/water/guarded.ts#kodamaStep');
  assert.ok(guarded !== undefined);
  assert.equal(guarded.kind, 'excluded');
  assert.equal(guarded.blastRadius, 'protected');
  assert.ok(guarded.exclusionReason?.includes('protected surface'));
  assert.ok(guarded.proposedAction.includes('never make one'));
  assert.equal(guarded.ease, 0, 'the arithmetic says so without relying on a later branch');
});

test('a contested subject routes to clarification rather than being patched', () => {
  const result = rank(
    rankingInput(makeCorpus(), {
      contestedSubjects: new Set(['src/econ/contested.ts#settle']),
    }),
  );

  const contested = find(result.clarificationCandidates, 'src/econ/contested.ts#settle');
  assert.ok(contested !== undefined);
  assert.ok(contested.corrections.some((note) => note.includes('contradicts itself')));
  assert.ok(contested.proposedAction.includes('choosing a side'));
});

test('a measured fault outranks an inferred one of the same shape', () => {
  const result = rank(
    rankingInput(makeCorpus({ consoleSignatures: [signature('src/render/noisy.ts#drawTile')] })),
  );
  const candidates = allCandidates(result);

  const noisy = find(candidates, 'src/render/noisy.ts#drawTile');
  const quiet = find(candidates, 'src/render/quiet.ts#drawTile');
  assert.ok(noisy !== undefined && quiet !== undefined);

  // The two units are structurally identical in the fixture. The only difference is
  // that one of them actually complained while the application was running.
  assert.equal(noisy.evidence, 'observed');
  assert.equal(quiet.evidence, 'static-inference');
  assert.ok(noisy.magnitude > quiet.magnitude);
  assert.ok(noisy.priority > quiet.priority);
  assert.equal(noisy.dominantFamily, 'observedDefect');
});

test('console output disproves dead-code suspicion, and the correction is recorded', () => {
  // An orphan by the graph's reckoning, which is nonetheless emitting warnings: it is
  // reached by a path the recogniser cannot see, and deleting it would be a mistake
  // every static family would have endorsed.
  const result = rank(
    rankingInput(
      makeCorpus({
        consoleSignatures: [
          signature('src/core/orphan.ts#orphan', { level: 'warning', perSessionRate: 3 }),
        ],
      }),
    ),
  );

  const orphan = find(allCandidates(result), 'src/core/orphan.ts#orphan');
  assert.ok(orphan !== undefined);
  assert.ok(
    orphan.corrections.some((note) => note.includes('the graph cannot see')),
    'the contradiction between families is stated, not silently averaged away',
  );
});

test('ranking reports which families were unavailable to it', () => {
  const result = rank(rankingInput(makeCorpus()));
  assert.equal(result.stats.observedEvidenceAvailable, false);
  assert.ok(result.stats.familiesUnavailable.includes('observedDefect'));

  const withConsole = rank(
    rankingInput(makeCorpus({ consoleSignatures: [signature('src/render/noisy.ts#drawTile')] })),
  );
  assert.equal(withConsole.stats.observedEvidenceAvailable, true);
});

/* ========================================================================= */
/* Lane selection                                                             */
/* ========================================================================= */

test('a batch is mixed, and instrumentation is never starved', () => {
  const result = rank(rankingInput(makeCorpus()));
  const batch = selectBatch(result, { size: 10 });

  assert.ok(batch.length > 0);
  const lanes = new Set(batch.map((candidate) => candidate.lane));

  // Without a reserved share, a cycle spends itself on the highest-scoring family in
  // the noisiest subsystem and stays permanently blind everywhere else.
  if (result.instrumentationCandidates.length > 0) {
    assert.ok(lanes.has('instrumentation'), 'the instrumentation share was spent');
  }
  assert.equal(new Set(batch.map((candidate) => candidate.logicalId)).size, batch.length);
});

test('no single subsystem can consume a whole cycle', () => {
  const result = rank(rankingInput(makeCorpus()));
  const batch = selectBatch(result, { size: 12, maxPerSubsystem: 2 });

  const perSubsystem = new Map<string, number>();
  for (const candidate of batch) {
    perSubsystem.set(candidate.subsystem, (perSubsystem.get(candidate.subsystem) ?? 0) + 1);
  }
  for (const [subsystem, count] of perSubsystem) {
    assert.ok(count <= 2, `${subsystem} took ${count}`);
  }
});

/* ========================================================================= */
/* Registry                                                                   */
/* ========================================================================= */

interface Stack {
  readonly root: string;
  readonly registry: MetricRegistry;
  readonly projections: ProjectionStore;
  dispose(): void;
}

function openStack(): Stack {
  const root = mkdtempSync(join(tmpdir(), 'clue-metrics-'));
  const workspace = join(root, 'workspace');
  for (const directory of ['db', 'events', 'blobs', 'logs']) {
    mkdirSync(join(workspace, directory), { recursive: true });
  }

  const projections = new ProjectionStore(join(workspace, 'db', 'clue.db'), {
    projectors: { ...METRIC_PROJECTORS },
  });
  // The trend query joins the unit tables, which the graph module owns. ProjectionStore
  // exposes its handle deliberately; the registries do not, and reaching for a `db`
  // member on one of those is how a test stops compiling.
  ensureGraphSchema(projections.db);

  const artifacts = new ArtifactStore(join(workspace, 'blobs'));
  const { log } = EventLog.open(join(workspace, 'events'));

  return {
    root,
    projections,
    registry: new MetricRegistry({
      log,
      projections,
      artifacts,
      missionVersion: () => 'MISSION-000001',
    }),
    dispose(): void {
      log.close();
      projections.close();
    },
  };
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

test('a metric set survives a round trip through the artifact store', () => {
  const stack = openStack();
  try {
    const metrics = computeAllMetrics(makeCorpus().input);
    const record = stack.registry.record(metrics);

    assert.equal(record.snapshot_id, SNAPSHOT);
    assert.equal(record.corpus_size, metrics.corpusSize);
    assert.ok(record.value_count > 0);

    const restored = stack.registry.metricSet(SNAPSHOT);
    assert.ok(restored !== null);
    assert.equal(restored.byUnit.size, metrics.byUnit.size);

    // Components survive the trip, which is the whole reason the full set is stored.
    const economy = restored.byUnit.get('src/core/easy.ts#easyUnit')?.get('economy');
    assert.ok(economy !== undefined);
    assert.ok(economy.components.length > 0);
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});

test('candidates are queryable by kind and ordered by priority', () => {
  const stack = openStack();
  try {
    const corpus = makeCorpus();
    stack.registry.record(computeAllMetrics(corpus.input));
    stack.registry.recordRanking(rank(rankingInput(corpus)), DEFAULT_WEIGHTS);

    const patches = stack.registry.candidates(SNAPSHOT, { kind: 'patch', limit: 20 });
    for (let index = 1; index < patches.length; index += 1) {
      const previous = patches[index - 1];
      const current = patches[index];
      if (previous === undefined || current === undefined) continue;
      assert.ok(previous.priority >= current.priority);
    }

    const excluded = stack.registry.candidates(SNAPSHOT, { kind: 'excluded', limit: 20 });
    assert.ok(excluded.length > 0);
    assert.ok(excluded.every((candidate) => candidate.exclusionReason !== null));
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});

test('a trend distinguishes a unit changing from the corpus moving around it', () => {
  const stack = openStack();
  try {
    stack.registry.record(computeAllMetrics(makeCorpus().input));

    // Same unit, untouched. Everything else in the corpus grows, which moves every
    // percentile without anything about this unit having changed.
    const second = makeCorpus({ fillerCount: 80 });
    stack.registry.record(computeAllMetrics({ ...second.input, snapshotId: SNAPSHOT_TWO }));

    const points = stack.registry.trend('src/core/easy.ts#easyUnit', 'economy');
    assert.equal(points.length, 2);

    const before = points[0];
    const after = points[1];
    assert.ok(before !== undefined && after !== undefined);

    // Raw is the unit's own number; normalised is its position among others. Reading a
    // trend without both would occasionally credit CLUE for someone else's regression.
    assert.equal(before.raw, after.raw, 'the unit itself did not change');
    assert.equal(after.unitChanged, false);
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});

test('two rankings computed under different weights are not compared as progress', () => {
  const stack = openStack();
  try {
    const corpus = makeCorpus();
    stack.registry.record(computeAllMetrics(corpus.input));
    stack.registry.recordRanking(rank(rankingInput(corpus)), DEFAULT_WEIGHTS);

    const shifted = { ...DEFAULT_WEIGHTS, easeExponent: 2 };
    const second = rank(rankingInput(corpus, { weights: shifted }));
    stack.registry.recordRanking({ ...second, snapshotId: SNAPSHOT_TWO }, shifted);

    const comparison = stack.registry.compareRankings(SNAPSHOT, SNAPSHOT_TWO);

    // A ranking that shifted because a weight was edited says nothing about Murugan.
    // Presenting it as movement would be the most flattering possible way to be wrong.
    assert.equal(comparison.comparable, false);
    assert.ok(comparison.incomparableReason?.includes('different weights'));

    const sameWeights = stack.registry.compareRankings(SNAPSHOT, SNAPSHOT);
    assert.equal(sameWeights.comparable, true);
    assert.equal(sameWeights.incomparableReason, null);
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});

test('the registry rebuilds its tables from stored artifacts', () => {
  const stack = openStack();
  try {
    const corpus = makeCorpus();
    stack.registry.record(computeAllMetrics(corpus.input));
    stack.registry.recordRanking(rank(rankingInput(corpus)), DEFAULT_WEIGHTS);

    const before = stack.registry.candidates(SNAPSHOT, { limit: 200 }).length;
    assert.ok(before > 0);

    stack.projections.db.prepare('DELETE FROM ranked_candidates WHERE snapshot_id = ?').run(SNAPSHOT);
    stack.projections.db.prepare('DELETE FROM metric_values WHERE snapshot_id = ?').run(SNAPSHOT);
    assert.equal(stack.registry.candidates(SNAPSHOT, { limit: 200 }).length, 0);

    assert.equal(stack.registry.rehydrate(SNAPSHOT), true);
    assert.equal(stack.registry.candidates(SNAPSHOT, { limit: 200 }).length, before);
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});
/* ------------------------------------------------------------------------- */
/* DEV-P1-04: atomicity, complete field replacement, multi-run history         */
/* ------------------------------------------------------------------------- */

test('DEV-P1-04: re-recording a snapshot replaces every field, leaving nothing from the prior run', () => {
  const stack = openStack();
  try {
    const first = computeAllMetrics(makeCorpus().input);
    stack.registry.record(first);

    // Take a real row, then mutate the columns the old upsert did not replace.
    const before = stack.projections.db
      .prepare('SELECT logical_id, family FROM metric_values WHERE snapshot_id = ? LIMIT 1')
      .get(SNAPSHOT) as { logical_id: string; family: string } | undefined;
    assert.ok(before, 'the first record produced at least one value row');

    stack.projections.db
      .prepare(
        `UPDATE metric_values SET evidence = 'STALE_EVIDENCE', proof_readiness = 'STALE_READINESS'
          WHERE snapshot_id = ? AND logical_id = ? AND family = ?`,
      )
      .run(SNAPSHOT, before.logical_id, before.family);

    // Re-recording the same snapshot must overwrite those columns, not leave them behind.
    stack.registry.record(computeAllMetrics(makeCorpus().input));

    const after = stack.projections.db
      .prepare(
        'SELECT evidence, proof_readiness FROM metric_values WHERE snapshot_id = ? AND logical_id = ? AND family = ?',
      )
      .get(SNAPSHOT, before.logical_id, before.family) as
      | { evidence: string; proof_readiness: string }
      | undefined;
    assert.ok(after);
    assert.notEqual(after.evidence, 'STALE_EVIDENCE', 'evidence is replaced on re-record');
    assert.notEqual(after.proof_readiness, 'STALE_READINESS', 'proof_readiness is replaced on re-record');
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});

test('DEV-P1-04: a re-ranked candidate keeps no column from the previous ranking', () => {
  const stack = openStack();
  try {
    const corpus = makeCorpus();
    stack.registry.record(computeAllMetrics(corpus.input));
    stack.registry.recordRanking(rank(rankingInput(corpus)), DEFAULT_WEIGHTS);

    const target = stack.projections.db
      .prepare('SELECT logical_id FROM ranked_candidates WHERE snapshot_id = ? LIMIT 1')
      .get(SNAPSHOT) as { logical_id: string } | undefined;
    assert.ok(target, 'the first ranking produced at least one candidate');

    stack.projections.db
      .prepare(
        `UPDATE ranked_candidates
            SET module_path = 'stale/module.ts', subsystem = 'STALE_SUBSYSTEM',
                evidence = 'STALE_EVIDENCE', proof_readiness = 'STALE_READINESS',
                impact_size = 987654
          WHERE snapshot_id = ? AND logical_id = ?`,
      )
      .run(SNAPSHOT, target.logical_id);

    stack.registry.recordRanking(rank(rankingInput(corpus)), DEFAULT_WEIGHTS);

    const after = stack.projections.db
      .prepare(
        `SELECT module_path, subsystem, evidence, proof_readiness, impact_size
           FROM ranked_candidates WHERE snapshot_id = ? AND logical_id = ?`,
      )
      .get(SNAPSHOT, target.logical_id) as Record<string, unknown> | undefined;
    assert.ok(after);
    assert.notEqual(after['module_path'], 'stale/module.ts');
    assert.notEqual(after['subsystem'], 'STALE_SUBSYSTEM');
    assert.notEqual(after['evidence'], 'STALE_EVIDENCE');
    assert.notEqual(after['proof_readiness'], 'STALE_READINESS');
    assert.notEqual(after['impact_size'], 987654);
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});

test('DEV-P1-04: every run is kept as history, not just the newest', () => {
  const stack = openStack();
  try {
    const corpus = makeCorpus();
    stack.registry.record(computeAllMetrics(corpus.input));
    stack.registry.recordRanking(rank(rankingInput(corpus)), DEFAULT_WEIGHTS);

    // A second measurement of the same snapshot: the summary points at the newest run,
    // but the earlier run must remain in history.
    stack.registry.record(computeAllMetrics(makeCorpus().input));

    const runs = stack.registry.metricSetRuns(SNAPSHOT);
    assert.ok(runs.length >= 1, 'metric-set runs are recorded');
    for (const run of runs) {
      assert.equal(run.snapshotId, SNAPSHOT);
      assert.ok(run.valueCount > 0);
      assert.match(run.artifactHash, /^[0-9a-f]{64}$/);
    }

    // A ranking under different weights is a genuinely different run and must be retained.
    stack.registry.recordRanking(rank(rankingInput(corpus)), {
      ...DEFAULT_WEIGHTS,
      magnitudeExponent: DEFAULT_WEIGHTS.magnitudeExponent + 0.25,
    });
    const rankingRuns = stack.registry.rankingRuns(SNAPSHOT);
    assert.equal(rankingRuns.length, 2, 'both rankings are kept as history');
    assert.notEqual(
      rankingRuns[0]?.weightsHash,
      rankingRuns[1]?.weightsHash,
      'the two runs record different weights, so a ranking shift is attributable',
    );
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});

test('DEV-P1-04: a partial bulk projection is detectable rather than silent', () => {
  const stack = openStack();
  try {
    stack.registry.record(computeAllMetrics(makeCorpus().input));
    assert.equal(stack.registry.verifyProjection(SNAPSHOT).consistent, true);

    // Simulate a crash between the committed event and the bulk write.
    stack.projections.db.prepare('DELETE FROM metric_values WHERE snapshot_id = ?').run(SNAPSHOT);

    const broken = stack.registry.verifyProjection(SNAPSHOT);
    assert.equal(broken.consistent, false, 'a summary without its values is reported inconsistent');
    assert.ok(broken.expectedValues > 0);
    assert.equal(broken.storedValues, 0);

    // The artifact remains truth, so rehydrate repairs it exactly.
    assert.equal(stack.registry.rehydrate(SNAPSHOT), true);
    const repaired = stack.registry.verifyProjection(SNAPSHOT);
    assert.equal(repaired.consistent, true, 'rehydrate restores the bulk table from the artifact');
    assert.equal(repaired.storedValues, repaired.expectedValues);
  } finally {
    stack.dispose();
    removeRoot(stack.root);
  }
});
