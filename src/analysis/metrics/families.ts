/**
 * CLUE metric families.
 *
 * Spec: CLUE_implementation.md §34 (metric families), §35 (Mitigation Ease Score),
 *       §36 (priority with visible components), §37 (proof readiness).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.3, Part V Stage E, Part IX §44.
 *
 * WHAT THESE NUMBERS ARE, AND WHAT THEY ARE NOT
 *
 * Six of the seven families below are **static inference**. They read structure and
 * produce a suspicion. None of them measures runtime cost, because runtime cost cannot
 * be read from a graph — it is measured in Stage H, against a real browser, under a
 * frozen contract. A static score is a reason to *look*, never a reason to *believe*.
 *
 * That distinction is not a caveat, it is the design. Every value carries an
 * `evidence` class, and every consumer is expected to treat `static-inference`
 * differently from `observed`. A system that ranked units by static score and called
 * the top one an improvement would be making exactly the mistake CLUE exists to
 * prevent, and it would be making it fluently.
 *
 * The seventh family, `observedDefect`, is different: it reads the console ledger, so
 * it reports things that actually happened. Where the two disagree, the observation
 * wins, and the disagreement is itself worth recording.
 *
 * Every value decomposes into named components. A number nobody can take apart is a
 * number nobody can argue with, and a ranking nobody can argue with is a ranking that
 * gets obeyed rather than examined.
 */

import type {
  SourceEdge,
  SourceUnit,
  UnitClassification,
  CoverageEntry,
} from '../source/graph.js';

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Where a value came from.
 *
 * `observed` means something happened and CLUE saw it. `static-inference` means CLUE
 * read the shape of the code and formed an opinion. Both are useful; only one is
 * evidence.
 */
export type EvidenceClass = 'observed' | 'static-inference';

export type MetricFamilyName =
  | 'economy'
  | 'intrinsicEfficiency'
  | 'amplification'
  | 'deadCodeSuspicion'
  | 'redundancy'
  | 'dependencySurface'
  | 'observedDefect';

/** Whether a candidate could be proven today, or needs an instrument built first. */
export type ProofReadiness = 'measurable' | 'needs-instrument' | 'not-measurable';

export interface MetricComponent {
  readonly name: string;
  readonly value: number;
  readonly note: string | null;
}

export interface MetricValue {
  readonly family: MetricFamilyName;
  readonly logicalId: string;
  /** The family's own units. Comparable only within the family. */
  readonly raw: number;
  /** 0-1 against this corpus. Comparable across families, and only ever a ranking aid. */
  readonly normalised: number;
  readonly percentile: number;
  readonly evidence: EvidenceClass;
  readonly confidence: number;
  readonly proofReadiness: ProofReadiness;
  readonly components: readonly MetricComponent[];
  readonly notes: readonly string[];
  /** False when the family could not be computed. The reason is always given. */
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

/* ------------------------------------------------------------------------- */
/* Console input (produced by Stage G1)                                       */
/* ------------------------------------------------------------------------- */

/**
 * A deduplicated console signature, as the ledger will supply it.
 *
 * Declared here ahead of Stage G1 so that the observation stage has a target shape to
 * satisfy rather than a shape invented later to fit whatever it happened to produce.
 */
export interface ConsoleSignatureSummary {
  readonly signature: string;
  readonly level: 'error' | 'warning' | 'info';
  /** Logical id of the unit the top project frame resolved to, if any. */
  readonly attributedTo: string | null;
  readonly occurrences: number;
  /** Occurrences per session. A per-frame warning and a once-per-session one differ. */
  readonly perSessionRate: number;
  /** How many approved scenarios reproduce it. One is a report; three is a fact. */
  readonly scenarioCount: number;
  readonly classification: 'actionable' | 'external' | 'intentional' | 'unclassified';
}

/* ------------------------------------------------------------------------- */
/* Input                                                                      */
/* ------------------------------------------------------------------------- */

export interface MetricInput {
  readonly snapshotId: string;
  readonly units: readonly SourceUnit[];
  readonly edges: readonly SourceEdge[];
  readonly classifications: readonly UnitClassification[];
  readonly coverage: readonly CoverageEntry[];
  /** Absent until Stage G1. Its absence is reported, never treated as "no defects". */
  readonly consoleSignatures?: readonly ConsoleSignatureSummary[];
  /**
   * Returns a reason when a unit sits on a protected surface, or null.
   *
   * Several families will rank protected surfaces highly and be wrong about them: the
   * dual ocean implementations look redundant, the ice placeholders look dead, and the
   * device-loss recovery path looks unreachable. Knowing which units are deliberate
   * turns a confident false positive into a low-confidence note.
   */
  readonly isProtected?: (unit: SourceUnit) => string | null;
}

/**
 * Below this many units, percentile normalisation describes noise rather than a
 * distribution, and every value says so.
 */
export const MINIMUM_CORPUS = 30;

/* ------------------------------------------------------------------------- */
/* Family interface                                                           */
/* ------------------------------------------------------------------------- */

export interface MetricFamily {
  readonly name: MetricFamilyName;
  readonly description: string;
  readonly evidence: EvidenceClass;
  compute(input: MetricInput): MetricValue[];
}

/* ------------------------------------------------------------------------- */
/* Shared computation                                                         */
/* ------------------------------------------------------------------------- */

interface GraphIndex {
  readonly inbound: ReadonlyMap<string, SourceEdge[]>;
  readonly outbound: ReadonlyMap<string, SourceEdge[]>;
  readonly classification: ReadonlyMap<string, UnitClassification>;
  readonly unitsById: ReadonlyMap<string, SourceUnit>;
}

function indexGraph(input: MetricInput): GraphIndex {
  const inbound = new Map<string, SourceEdge[]>();
  const outbound = new Map<string, SourceEdge[]>();

  for (const edge of input.edges) {
    if (edge.kind === 'declares') continue;
    push(outbound, edge.from, edge);
    if (!edge.external) push(inbound, edge.to, edge);
  }

  return {
    inbound,
    outbound,
    classification: new Map(input.classifications.map((entry) => [entry.logicalId, entry])),
    unitsById: new Map(input.units.map((unit) => [unit.logicalId, unit])),
  };
}

function push(map: Map<string, SourceEdge[]>, key: string, edge: SourceEdge): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [edge]);
  else existing.push(edge);
}

/** Units worth scoring. Modules are containers; scoring them double-counts their members. */
function scorableUnits(input: MetricInput): SourceUnit[] {
  return input.units.filter((unit) => unit.kind !== 'module');
}

/** Fraction of values at or below `value`. */
function percentileOf(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return 0;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? 0) <= value) low = middle + 1;
    else high = middle;
  }
  return Number((low / sorted.length).toFixed(4));
}

/**
 * Turns raw family values into normalised ones.
 *
 * Percentile rather than min-max, because a single outlier would otherwise compress
 * every other unit into the bottom of the range and make the ranking useless exactly
 * when one unit is genuinely extreme.
 *
 * Zero raw evidence normalises to zero, unconditionally. `percentileOf` is inclusive
 * (the fraction of values at or below), so in a sparse distribution — most units at
 * raw 0, a few above — a unit the family found *nothing* about would inherit a high
 * percentile from its zero-valued neighbours. That inflation classified units with no
 * console signal as `observed` evidence and let empty families cross the readiness
 * floor. Zero evidence must stay zero evidence: a family that found nothing for a
 * unit cannot dominate its evidence class, its readiness, or its magnitude. Nonzero
 * values keep the inclusive percentile; their ordering is unaffected.
 */
function normalise(
  family: MetricFamilyName,
  evidence: EvidenceClass,
  raws: ReadonlyMap<string, { raw: number; components: MetricComponent[]; notes: string[]; confidence: number; readiness: ProofReadiness }>,
  corpusSize: number,
): MetricValue[] {
  const sorted = [...raws.values()].map((entry) => entry.raw).sort((a, b) => a - b);
  const small = corpusSize < MINIMUM_CORPUS;

  return [...raws.entries()].map(([logicalId, entry]) => {
    const percentile = entry.raw === 0 ? 0 : percentileOf(sorted, entry.raw);
    const notes = [...entry.notes];
    let confidence = entry.confidence;

    if (small) {
      confidence = Math.min(confidence, 0.5);
      notes.push(
        `corpus of ${corpusSize} units is below ${MINIMUM_CORPUS}; the percentile describes noise as much as a distribution`,
      );
    }

    return {
      family,
      logicalId,
      raw: Number(entry.raw.toFixed(4)),
      normalised: percentile,
      percentile,
      evidence,
      confidence: Number(Math.min(1, Math.max(0, confidence)).toFixed(3)),
      proofReadiness: entry.readiness,
      components: entry.components,
      notes,
      available: true,
      unavailableReason: null,
    };
  });
}

function component(name: string, value: number, note: string | null = null): MetricComponent {
  return { name, value: Number(value.toFixed(4)), note };
}

/* ------------------------------------------------------------------------- */
/* Economy                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * What a unit plausibly costs the project.
 *
 * Not size. A two-hundred-line function called once at startup is cheap; a twelve-line
 * one reached from a frame loop is not. Size is weighted by how many distinct places
 * depend on the unit, so the family answers "how much does this matter" rather than
 * "how much of it is there".
 *
 * Still an inference. It cannot see how often anything actually runs.
 */
const economy: MetricFamily = {
  name: 'economy',
  description: 'Structural size weighted by how widely the unit is depended upon.',
  evidence: 'static-inference',

  compute(input) {
    const graph = indexGraph(input);
    const units = scorableUnits(input);
    const raws = new Map<string, ReturnType<typeof rawEntry>>();

    for (const unit of units) {
      const dependents = graph.inbound.get(unit.logicalId)?.length ?? 0;
      const classification = graph.classification.get(unit.logicalId);
      const impact = classification?.impactSize ?? dependents;

      // Logarithmic in reach: the difference between one dependent and ten matters far
      // more than between one hundred and one hundred and ten.
      const reach = Math.log2(1 + impact);
      const raw = unit.lineCount * (1 + reach);

      raws.set(
        unit.logicalId,
        rawEntry(raw, [
          component('lines', unit.lineCount),
          component('impactSize', impact, 'transitive dependents from the graph'),
          component('reachFactor', reach, 'log2(1 + impact)'),
        ], [
          'Structural proxy. Actual cost is measured at Stage H, not here.',
        ], classification?.confidence ?? 0.6, 'needs-instrument'),
      );
    }

    return normalise('economy', 'static-inference', raws, units.length);
  },
};

/* ------------------------------------------------------------------------- */
/* Intrinsic efficiency                                                       */
/* ------------------------------------------------------------------------- */

/**
 * How well a unit does its own work — and the family that is least able to say.
 *
 * Repeated allocation, redundant recomputation, and work that did not need doing are
 * not visible in a dependency graph. What is visible is a weak proxy: a large unit that
 * delegates little is doing its work inline, which is where such problems live when
 * they exist.
 *
 * It is kept deliberately low-confidence and always marked `needs-instrument`, which
 * is the honest answer and also the useful one: it routes candidates to a probe rather
 * than to a patch, which is precisely what the Stage E gate requires.
 */
const intrinsicEfficiency: MetricFamily = {
  name: 'intrinsicEfficiency',
  description: 'Weak structural proxy for inline work density. Always routes to instrumentation.',
  evidence: 'static-inference',

  compute(input) {
    const graph = indexGraph(input);
    const units = scorableUnits(input);
    const raws = new Map<string, ReturnType<typeof rawEntry>>();

    for (const unit of units) {
      const outgoing = graph.outbound.get(unit.logicalId) ?? [];
      const calls = outgoing.filter((edge) => edge.kind === 'calls' || edge.kind === 'instantiates');
      const delegation = calls.length / Math.max(1, unit.lineCount / 10);
      const inlineDensity = unit.lineCount / (1 + calls.length);

      raws.set(
        unit.logicalId,
        rawEntry(inlineDensity, [
          component('lines', unit.lineCount),
          component('outgoingCalls', calls.length),
          component('delegationRatio', delegation, 'calls per ten lines'),
        ], [
          'Cannot see allocation, recomputation, or wasted work. Treat as a hint about where to point a probe, never as a finding.',
        ], 0.35, 'needs-instrument'),
      );
    }

    return normalise('intrinsicEfficiency', 'static-inference', raws, units.length);
  },
};

/* ------------------------------------------------------------------------- */
/* Amplification                                                              */
/* ------------------------------------------------------------------------- */

/**
 * How much a unit's cost is multiplied by everything that reaches it.
 *
 * This is where the graph earns its keep. It is the difference between "this is slow"
 * and "this is slow *and everything goes through it*" — and the second is the only one
 * of the two that justifies the cost of a careful experiment.
 */
const amplification: MetricFamily = {
  name: 'amplification',
  description: 'Distinct call sites combined with transitive reach.',
  evidence: 'static-inference',

  compute(input) {
    const graph = indexGraph(input);
    const units = scorableUnits(input);
    const raws = new Map<string, ReturnType<typeof rawEntry>>();

    for (const unit of units) {
      const inbound = graph.inbound.get(unit.logicalId) ?? [];
      const callSites = inbound.filter(
        (edge) => edge.kind === 'calls' || edge.kind === 'instantiates',
      ).length;
      const distinctCallers = new Set(inbound.map((edge) => edge.from)).size;
      const classification = graph.classification.get(unit.logicalId);
      const impact = classification?.impactSize ?? distinctCallers;

      const raw = Math.log2(1 + callSites) * Math.log2(2 + impact);
      const notes: string[] = [
        'Call sites are static. A site inside a loop and one behind a rarely taken branch count the same here.',
      ];
      if (classification?.truncated === true) {
        notes.push('impact traversal was truncated, so this is a lower bound');
      }

      raws.set(
        unit.logicalId,
        rawEntry(raw, [
          component('callSites', callSites),
          component('distinctCallers', distinctCallers),
          component('impactSize', impact),
        ], notes, classification?.confidence ?? 0.6, 'needs-instrument'),
      );
    }

    return normalise('amplification', 'static-inference', raws, units.length);
  },
};

/* ------------------------------------------------------------------------- */
/* Dead-code suspicion                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Units nothing appears to reach.
 *
 * The name is a promise about its own reliability. A unit with no inbound edges may be
 * dead, or it may be an entry point, a deliberate placeholder, a recovery path that
 * runs only when something has already gone wrong, or a target the graph cannot see
 * because the call is dynamic.
 *
 * Three corrections are applied, and each one turns a confident wrong answer into a
 * quiet correct one:
 *
 *   - exported units are less suspicious than unexported ones;
 *   - a unit in a module with unresolved references may simply be reached invisibly;
 *   - a protected surface is deliberate, and CLUE has been told so.
 *
 * The strongest correction is not here at all: a unit with no inbound edges but live
 * console output is not dead, it is entered by a path the graph cannot see. That
 * cross-check lives in the ranking, where both families are visible at once.
 */
const deadCodeSuspicion: MetricFamily = {
  name: 'deadCodeSuspicion',
  description: 'Absence of inbound edges, corrected for export, graph gaps, and protected surfaces.',
  evidence: 'static-inference',

  compute(input) {
    const graph = indexGraph(input);
    const units = scorableUnits(input);
    const gapModules = new Set(
      input.coverage.filter((entry) => entry.unresolved > 0).map((entry) => entry.subsystem),
    );
    const raws = new Map<string, ReturnType<typeof rawEntry>>();

    for (const unit of units) {
      const inbound = graph.inbound.get(unit.logicalId)?.length ?? 0;
      const notes: string[] = [];
      let confidence = 0.7;
      let raw = inbound === 0 ? 1 : 0;

      if (raw === 1) {
        if (unit.exported) {
          raw *= 0.6;
          notes.push('exported: may be reached from outside the analysed program');
        }
        const subsystem = unit.modulePath.split('/').slice(0, 2).join('/');
        if (gapModules.has(subsystem)) {
          raw *= 0.7;
          confidence -= 0.2;
          notes.push('its subsystem has unresolved references; an invisible caller is plausible');
        }
        const protectedReason = input.isProtected?.(unit) ?? null;
        if (protectedReason !== null) {
          raw *= 0.1;
          confidence = 0.9;
          notes.push(`protected surface: ${protectedReason}`);
        }
      }

      raws.set(
        unit.logicalId,
        rawEntry(raw, [
          component('inboundEdges', inbound),
          component('exported', unit.exported ? 1 : 0),
        ], notes, confidence, 'measurable'),
      );
    }

    return normalise('deadCodeSuspicion', 'static-inference', raws, units.length);
  },
};

/* ------------------------------------------------------------------------- */
/* Redundancy                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Units that look like each other.
 *
 * Structural shape only — kind, arity, size band, and the multiset of outgoing edge
 * kinds. It finds *candidates*, and calling it a duplicate detector would overstate it
 * considerably: two functions with the same shape may do entirely different things.
 *
 * It will rank the dual ocean and dual Kodama implementations highly, and it will be
 * wrong about both. That is expected, it is why those surfaces are protected, and it
 * is why a match against a protected surface collapses the score rather than merely
 * annotating it. Confirming a genuine duplicate is a later, cheap AI task on a short
 * candidate list — not something this family should pretend to have done.
 */
const redundancy: MetricFamily = {
  name: 'redundancy',
  description: 'Structural shape collisions. A candidate detector, not a duplicate detector.',
  evidence: 'static-inference',

  compute(input) {
    const graph = indexGraph(input);
    const units = scorableUnits(input);

    const byShape = new Map<string, SourceUnit[]>();
    const byVersion = new Map<string, SourceUnit[]>();

    for (const unit of units) {
      const outgoing = graph.outbound.get(unit.logicalId) ?? [];
      const shape = [
        unit.kind,
        unit.parameterCount ?? '-',
        sizeBand(unit.lineCount),
        [...outgoing.map((edge) => edge.kind)].sort().join('+'),
      ].join('|');

      const shapeGroup = byShape.get(shape);
      if (shapeGroup === undefined) byShape.set(shape, [unit]);
      else shapeGroup.push(unit);

      const versionGroup = byVersion.get(unit.versionHash);
      if (versionGroup === undefined) byVersion.set(unit.versionHash, [unit]);
      else versionGroup.push(unit);
    }

    const raws = new Map<string, ReturnType<typeof rawEntry>>();

    for (const unit of units) {
      const outgoing = graph.outbound.get(unit.logicalId) ?? [];
      const shape = [
        unit.kind,
        unit.parameterCount ?? '-',
        sizeBand(unit.lineCount),
        [...outgoing.map((edge) => edge.kind)].sort().join('+'),
      ].join('|');

      const shapePeers = (byShape.get(shape)?.length ?? 1) - 1;
      const exactPeers = (byVersion.get(unit.versionHash)?.length ?? 1) - 1;

      const notes: string[] = [];
      let confidence = exactPeers > 0 ? 0.9 : 0.4;
      // Exact text duplicates are a fact; shape collisions are a hunch.
      let raw = exactPeers > 0 ? 1 + Math.log2(1 + exactPeers) : Math.min(0.8, shapePeers * 0.15);

      if (exactPeers > 0) notes.push(`${exactPeers} unit(s) share this exact source text`);
      else if (shapePeers > 0) notes.push(`${shapePeers} unit(s) share this structural shape; similarity is unverified`);

      const protectedReason = input.isProtected?.(unit) ?? null;
      if (protectedReason !== null && raw > 0) {
        raw *= 0.1;
        confidence = 0.9;
        notes.push(`protected surface: ${protectedReason}. Duplication here is deliberate.`);
      }

      raws.set(
        unit.logicalId,
        rawEntry(raw, [
          component('exactDuplicates', exactPeers),
          component('shapePeers', shapePeers),
        ], notes, confidence, 'measurable'),
      );
    }

    return normalise('redundancy', 'static-inference', raws, units.length);
  },
};

function sizeBand(lines: number): string {
  if (lines <= 5) return 'xs';
  if (lines <= 20) return 's';
  if (lines <= 60) return 'm';
  if (lines <= 200) return 'l';
  return 'xl';
}

/* ------------------------------------------------------------------------- */
/* Dependency surface                                                         */
/* ------------------------------------------------------------------------- */

/**
 * How much a unit couples to.
 *
 * Not a cost in itself. It is a multiplier on how risky a change is, and a unit that
 * reaches into four subsystems is harder to change safely than one that reaches into
 * none, whatever either of them costs to run.
 */
const dependencySurface: MetricFamily = {
  name: 'dependencySurface',
  description: 'Distinct modules, subsystems, and external packages the unit reaches into.',
  evidence: 'static-inference',

  compute(input) {
    const graph = indexGraph(input);
    const units = scorableUnits(input);
    const raws = new Map<string, ReturnType<typeof rawEntry>>();

    for (const unit of units) {
      const outgoing = graph.outbound.get(unit.logicalId) ?? [];
      const modules = new Set<string>();
      const subsystems = new Set<string>();
      let external = 0;

      for (const edge of outgoing) {
        if (edge.external) {
          external += 1;
          continue;
        }
        const target = graph.unitsById.get(edge.to);
        if (target === undefined) continue;
        modules.add(target.modulePath);
        subsystems.add(target.modulePath.split('/').slice(0, 2).join('/'));
      }

      modules.delete(unit.modulePath);
      const raw = modules.size + subsystems.size * 1.5 + external * 0.5;

      raws.set(
        unit.logicalId,
        rawEntry(raw, [
          component('distinctModules', modules.size),
          component('distinctSubsystems', subsystems.size),
          component('externalTargets', external),
        ], [
          'A risk multiplier, not a cost. High surface makes a change harder to prove safe.',
        ], 0.8, 'measurable'),
      );
    }

    return normalise('dependencySurface', 'static-inference', raws, units.length);
  },
};

/* ------------------------------------------------------------------------- */
/* Observed defect                                                            */
/* ------------------------------------------------------------------------- */

/**
 * What Murugan actually complained about, attributed to a unit.
 *
 * The only family that reports something that happened rather than something that
 * looks true. An error carries more weight than a warning; a signature reproduced in
 * three approved scenarios carries more than one seen once; and a per-frame rate
 * carries more than a per-session one, because it is both louder and cheaper to prove
 * gone.
 *
 * When the ledger is absent — before Stage G1, or for a snapshot never exercised — the
 * family reports itself **unavailable with a reason** rather than returning zero.
 * Zero would read as "nothing is wrong here", which is a different and much stronger
 * claim than "nobody has looked".
 */
const observedDefect: MetricFamily = {
  name: 'observedDefect',
  description: 'Console errors and warnings attributed to the unit, weighted by level, rate, and scenario coverage.',
  evidence: 'observed',

  compute(input) {
    const units = scorableUnits(input);

    if (input.consoleSignatures === undefined) {
      return units.map((unit) => unavailable(unit.logicalId, 'observedDefect', 'observed', 'no console ledger for this snapshot; the application has not been exercised'));
    }

    const bySubject = new Map<string, ConsoleSignatureSummary[]>();
    for (const signature of input.consoleSignatures) {
      if (signature.attributedTo === null) continue;
      // Intentional diagnostics are the application working as designed, and external
      // entries are somebody else's problem. Counting either would make a well
      // instrumented unit look defective.
      if (signature.classification === 'intentional' || signature.classification === 'external') continue;

      const existing = bySubject.get(signature.attributedTo);
      if (existing === undefined) bySubject.set(signature.attributedTo, [signature]);
      else existing.push(signature);
    }

    const raws = new Map<string, ReturnType<typeof rawEntry>>();

    for (const unit of units) {
      const signatures = bySubject.get(unit.logicalId) ?? [];
      let raw = 0;
      let errors = 0;
      let warnings = 0;
      let maxRate = 0;
      let maxScenarios = 0;

      for (const signature of signatures) {
        const levelWeight = signature.level === 'error' ? 1 : signature.level === 'warning' ? 0.5 : 0.1;
        const rateWeight = 1 + Math.log2(1 + signature.perSessionRate);
        const scenarioWeight = 1 + Math.log2(1 + signature.scenarioCount);

        raw += levelWeight * rateWeight * scenarioWeight;
        if (signature.level === 'error') errors += 1;
        if (signature.level === 'warning') warnings += 1;
        maxRate = Math.max(maxRate, signature.perSessionRate);
        maxScenarios = Math.max(maxScenarios, signature.scenarioCount);
      }

      const notes: string[] = [];
      // Reproduced in one scenario is a report; reproduced in several is a property.
      let confidence = signatures.length === 0 ? 0.9 : maxScenarios >= 2 ? 0.95 : 0.7;
      if (signatures.length > 0 && maxScenarios < 2) {
        notes.push('reproduced in a single scenario; confirm before treating as general');
        confidence = 0.7;
      }
      if (signatures.some((signature) => signature.classification === 'unclassified')) {
        notes.push('includes entries not yet triaged');
      }

      raws.set(
        unit.logicalId,
        rawEntry(raw, [
          component('signatures', signatures.length),
          component('errors', errors),
          component('warnings', warnings),
          component('maxPerSessionRate', maxRate),
          component('maxScenarioCoverage', maxScenarios),
        ], notes, confidence, signatures.length > 0 ? 'measurable' : 'measurable'),
      );
    }

    return normalise('observedDefect', 'observed', raws, units.length);
  },
};

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */

export const METRIC_FAMILIES: readonly MetricFamily[] = [
  economy,
  intrinsicEfficiency,
  amplification,
  deadCodeSuspicion,
  redundancy,
  dependencySurface,
  observedDefect,
];

export interface MetricSet {
  readonly snapshotId: string;
  readonly corpusSize: number;
  /** logicalId → family → value. */
  readonly byUnit: ReadonlyMap<string, ReadonlyMap<MetricFamilyName, MetricValue>>;
  readonly unavailableFamilies: readonly { family: MetricFamilyName; reason: string }[];
}

/**
 * Computes every family over one snapshot.
 *
 * Families that cannot run are listed rather than omitted. A ranking built from four
 * families instead of seven is a different ranking, and the consumer is entitled to
 * know which one it is looking at.
 */
export function computeAllMetrics(input: MetricInput): MetricSet {
  const byUnit = new Map<string, Map<MetricFamilyName, MetricValue>>();
  const unavailableFamilies: { family: MetricFamilyName; reason: string }[] = [];

  for (const family of METRIC_FAMILIES) {
    const values = family.compute(input);
    const firstUnavailable = values.find((value) => !value.available);

    if (firstUnavailable !== undefined && values.every((value) => !value.available)) {
      unavailableFamilies.push({
        family: family.name,
        reason: firstUnavailable.unavailableReason ?? 'unavailable',
      });
    }

    for (const value of values) {
      const existing = byUnit.get(value.logicalId);
      if (existing === undefined) byUnit.set(value.logicalId, new Map([[family.name, value]]));
      else existing.set(family.name, value);
    }
  }

  return {
    snapshotId: input.snapshotId,
    corpusSize: scorableUnits(input).length,
    byUnit,
    unavailableFamilies,
  };
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

function rawEntry(
  raw: number,
  components: MetricComponent[],
  notes: string[],
  confidence: number,
  readiness: ProofReadiness,
): { raw: number; components: MetricComponent[]; notes: string[]; confidence: number; readiness: ProofReadiness } {
  return { raw, components, notes, confidence, readiness };
}

function unavailable(
  logicalId: string,
  family: MetricFamilyName,
  evidence: EvidenceClass,
  reason: string,
): MetricValue {
  return {
    family,
    logicalId,
    raw: 0,
    normalised: 0,
    percentile: 0,
    evidence,
    confidence: 0,
    proofReadiness: 'not-measurable',
    components: [],
    notes: [],
    available: false,
    unavailableReason: reason,
  };
}
