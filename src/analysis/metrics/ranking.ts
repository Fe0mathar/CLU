/**
 * CLUE candidate ranking.
 *
 * Spec: CLUE_implementation.md §35 (Mitigation Ease Score), §36 (priority with visible
 *       components), §37 (proof readiness), §38 (weighted fair lanes).
 * Strategy: CLUE_Implementation_Strategy.md rev 1.3, Part V Stage E, Part IX §44;
 *           landing gate G7. Audit v2.1 §3.5.
 *
 * Revision 2 — three changes:
 *
 *   - the two classification axes are consumed separately. `quadrant` says how hard a
 *     unit is to change *correctly*; `blastRadius` says how much breaks if the change
 *     is wrong. Revision 1 had one factor doing both jobs and doing neither well;
 *     a widely-used one-line helper and a diffuse cross-module behaviour scored alike.
 *   - `protected` is a blast radius now, so a deliberate surface is excluded by the
 *     classification itself rather than only by a matcher passed in beside it.
 *   - an `exactOptionalPropertyTypes` violation is fixed: an optional property cannot
 *     receive a possibly-undefined value, so the internal decision input declares
 *     `| undefined` explicitly instead of using `?`.
 *
 * WHAT RANKING DECIDES
 *
 * Where to spend attention. Not what is true, not what is wrong, and not what should be
 * changed. A high rank means "this is the next thing worth the cost of trying to prove
 * something about", and nothing more.
 *
 * Priority is magnitude multiplied by ease, so a badly behaved foundational unit ranks
 * *below* a mildly suspicious isolated one — only the second can produce a proven
 * improvement inside a bounded experiment. The form is multiplicative, so any factor
 * near zero eliminates the candidate: something CLUE cannot measure is worth nothing to
 * CLUE regardless of how bad it looks, because the only currency here is proof. Such
 * candidates are not discarded; they become instrumentation candidates, which is the
 * honest next step and the one the Stage E gate requires.
 */

import type {
  EvidenceClass,
  MetricComponent,
  MetricFamilyName,
  MetricSet,
  MetricValue,
  ProofReadiness,
} from './families.js';
import type {
  BlastRadius,
  Quadrant,
  SourceUnit,
  UnitClass,
  UnitClassification,
} from '../source/graph.js';

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

export type CandidateKind = 'patch' | 'instrumentation' | 'clarification' | 'excluded';

export type WorkLane = 'safe-improvement' | 'instrumentation' | 'clarification' | 'investigation';

export interface RankedCandidate {
  readonly logicalId: string;
  readonly modulePath: string;
  readonly subsystem: string;
  readonly kind: CandidateKind;
  readonly lane: WorkLane;

  readonly priority: number;
  readonly magnitude: number;
  readonly ease: number;
  readonly confidence: number;

  readonly evidence: EvidenceClass;
  readonly dominantFamily: MetricFamilyName | null;
  readonly proofReadiness: ProofReadiness;

  readonly magnitudeComponents: readonly MetricComponent[];
  readonly easeComponents: readonly MetricComponent[];
  readonly corrections: readonly string[];
  readonly exclusionReason: string | null;
  readonly proposedAction: string;

  /** How hard the unit is to change correctly. */
  readonly quadrant: Quadrant | null;
  /** How much breaks if the change is wrong. */
  readonly blastRadius: BlastRadius | null;
  /** @deprecated Compatibility projection from graph revision 2. Use the two above. */
  readonly unitClass: UnitClass | null;
  readonly impactSize: number;
}

export interface RankingResult {
  readonly snapshotId: string;
  readonly patchCandidates: readonly RankedCandidate[];
  readonly instrumentationCandidates: readonly RankedCandidate[];
  readonly clarificationCandidates: readonly RankedCandidate[];
  readonly excluded: readonly RankedCandidate[];
  readonly stats: RankingStats;
}

export interface RankingStats {
  readonly unitsRanked: number;
  readonly byKind: Readonly<Record<CandidateKind, number>>;
  readonly familiesUnavailable: readonly MetricFamilyName[];
  readonly observedEvidenceAvailable: boolean;
  readonly correctionsApplied: number;
}

/* ------------------------------------------------------------------------- */
/* Weights                                                                    */
/* ------------------------------------------------------------------------- */

export interface RankingWeights {
  readonly families: Readonly<Record<MetricFamilyName, number>>;
  readonly magnitudeExponent: number;
  readonly easeExponent: number;
  readonly confidenceExponent: number;
  /** How hard the shape is to change correctly. */
  readonly quadrantFactor: Readonly<Record<Quadrant, number>>;
  /** How costly a mistake would be. */
  readonly blastRadiusFactor: Readonly<Record<BlastRadius, number>>;
  readonly readinessFactor: Readonly<Record<ProofReadiness, number>>;
  readonly comfortableUnitLines: number;
  readonly noScenarioFactor: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  families: {
    // Observed evidence outweighs every inference, by a margin wide enough that the
    // ranking notices. A measured fault beats a suspected one of the same size.
    observedDefect: 2.0,
    amplification: 1.2,
    economy: 1.0,
    deadCodeSuspicion: 0.6,
    redundancy: 0.5,
    intrinsicEfficiency: 0.4,
    // Not a cost. Dependency surface shapes ease, and the coarse signal now lives in
    // the quadrant, so counting it in magnitude too would penalise coupling twice.
    dependencySurface: 0,
  },
  magnitudeExponent: 1,
  easeExponent: 1,
  confidenceExponent: 0.5,

  quadrantFactor: {
    // One file, one outside dependency: a patch and its proof both fit in one place.
    'monofile-monodependency': 1.0,
    // One file, several dependencies: the diff is contained, the experiment is not.
    'monofile-polydependency': 0.7,
    // Several files, one dependency: the diff must stay coherent across modules, but
    // the experiment stays narrow.
    'polyfile-monodependency': 0.55,
    // Diffuse in both directions. Rarely provable in a single bounded experiment.
    'polyfile-polydependency': 0.3,
  },

  blastRadiusFactor: {
    local: 1.0,
    systemic: 0.3,
    foundational: 0.08,
    // Zero rather than small. A deliberate surface is not a hard candidate; it is not
    // a candidate, and the arithmetic should say so without relying on a later branch.
    protected: 0,
  },

  readinessFactor: {
    measurable: 1.0,
    'needs-instrument': 0.4,
    'not-measurable': 0.1,
  },

  comfortableUnitLines: 80,
  noScenarioFactor: 0.6,
};

/** Shapes eligible for automatic patch work. Aligns with landing gate G7. */
export const DEFAULT_ALLOWED_QUADRANTS: readonly Quadrant[] = [
  'monofile-monodependency',
  'monofile-polydependency',
  'polyfile-monodependency',
];

export const DEFAULT_ALLOWED_BLAST_RADII: readonly BlastRadius[] = ['local'];

/* ------------------------------------------------------------------------- */
/* Input                                                                      */
/* ------------------------------------------------------------------------- */

export interface RankingInput {
  readonly metrics: MetricSet;
  readonly units: readonly SourceUnit[];
  readonly classifications: readonly UnitClassification[];
  /**
   * Additional protected-surface matcher.
   *
   * The classification already carries `protected` as a blast radius when the graph was
   * given a matcher. This is the second line: a ranking run configured with a wider
   * protected list than the graph was still refuses to propose a patch.
   */
  readonly isProtected?: (unit: SourceUnit) => string | null;
  readonly contestedSubjects?: ReadonlySet<string>;
  readonly scenarioCovered?: ReadonlySet<string>;
  readonly overrides?: readonly { logicalId: string; reason: string }[];
  readonly weights?: RankingWeights;
  readonly allowedQuadrants?: readonly Quadrant[];
  readonly allowedBlastRadii?: readonly BlastRadius[];
  readonly minimumPriority?: number;
}

/* ------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* ------------------------------------------------------------------------- */

export function rank(input: RankingInput): RankingResult {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const allowedQuadrants = new Set(input.allowedQuadrants ?? DEFAULT_ALLOWED_QUADRANTS);
  const allowedBlastRadii = new Set(input.allowedBlastRadii ?? DEFAULT_ALLOWED_BLAST_RADII);
  // Seven ease factors multiply to small numbers by construction; the threshold exists
  // to drop noise, not to filter out most of the corpus.
  const minimum = input.minimumPriority ?? 0.005;

  const classifications = new Map(input.classifications.map((entry) => [entry.logicalId, entry]));
  const overrides = new Map((input.overrides ?? []).map((entry) => [entry.logicalId, entry.reason]));
  const unavailable = input.metrics.unavailableFamilies.map((entry) => entry.family);
  const observedAvailable = !unavailable.includes('observedDefect');

  const candidates: RankedCandidate[] = [];
  let correctionsApplied = 0;

  for (const unit of input.units) {
    if (unit.kind === 'module') continue;

    const values = input.metrics.byUnit.get(unit.logicalId);
    if (values === undefined) continue;

    const classification = classifications.get(unit.logicalId) ?? null;
    const corrections: string[] = [];

    const magnitude = computeMagnitude(values, weights, corrections);
    const readiness = worstReadiness(values, weights);
    const ease = computeEase({
      unit,
      classification,
      values,
      weights,
      readiness,
      scenarioCovered: input.scenarioCovered?.has(unit.logicalId) ?? false,
    });

    const confidence = computeConfidence(values, classification);
    const evidence = dominantEvidence(values, weights);
    const dominant = dominantFamily(values, weights);

    applyCorrections({
      values,
      corrections,
      contested: input.contestedSubjects?.has(unit.logicalId) ?? false,
    });
    correctionsApplied += corrections.length;

    const adjustedMagnitude = adjustMagnitude(magnitude.value, values, corrections);

    const priority =
      Math.pow(adjustedMagnitude, weights.magnitudeExponent) *
      Math.pow(ease.value, weights.easeExponent) *
      Math.pow(confidence, weights.confidenceExponent);

    const decision = decide({
      unit,
      classification,
      readiness,
      allowedQuadrants,
      allowedBlastRadii,
      // Declared as `| undefined` rather than optional, because an optional property
      // cannot receive a possibly-undefined value under exactOptionalPropertyTypes.
      isProtected: input.isProtected,
      contested: input.contestedSubjects?.has(unit.logicalId) ?? false,
      override: overrides.get(unit.logicalId) ?? null,
    });

    if (decision.kind !== 'excluded' && priority < minimum) continue;

    candidates.push({
      logicalId: unit.logicalId,
      modulePath: unit.modulePath,
      subsystem: subsystemOf(unit.modulePath),
      kind: decision.kind,
      lane: decision.lane,
      priority: Number(priority.toFixed(6)),
      magnitude: Number(adjustedMagnitude.toFixed(4)),
      ease: Number(ease.value.toFixed(4)),
      confidence: Number(confidence.toFixed(3)),
      evidence,
      dominantFamily: dominant,
      proofReadiness: readiness,
      magnitudeComponents: magnitude.components,
      easeComponents: ease.components,
      corrections,
      exclusionReason: decision.exclusionReason,
      proposedAction: decision.proposedAction,
      quadrant: classification?.quadrant ?? null,
      blastRadius: classification?.blastRadius ?? null,
      unitClass: classification?.unitClass ?? null,
      impactSize: classification?.impactSize ?? 0,
    });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.logicalId.localeCompare(b.logicalId));

  const byKind: Record<CandidateKind, number> = {
    patch: 0,
    instrumentation: 0,
    clarification: 0,
    excluded: 0,
  };
  for (const candidate of candidates) byKind[candidate.kind] += 1;

  return {
    snapshotId: input.metrics.snapshotId,
    patchCandidates: candidates.filter((candidate) => candidate.kind === 'patch'),
    instrumentationCandidates: candidates.filter((candidate) => candidate.kind === 'instrumentation'),
    clarificationCandidates: candidates.filter((candidate) => candidate.kind === 'clarification'),
    excluded: candidates.filter((candidate) => candidate.kind === 'excluded'),
    stats: {
      unitsRanked: candidates.length,
      byKind,
      familiesUnavailable: unavailable,
      observedEvidenceAvailable: observedAvailable,
      correctionsApplied,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Magnitude                                                                  */
/* ------------------------------------------------------------------------- */

function computeMagnitude(
  values: ReadonlyMap<MetricFamilyName, MetricValue>,
  weights: RankingWeights,
  notes: string[],
): { value: number; components: MetricComponent[] } {
  const components: MetricComponent[] = [];
  let weighted = 0;
  let totalWeight = 0;

  for (const [family, value] of values) {
    const weight = weights.families[family] ?? 0;
    if (weight === 0) continue;

    if (!value.available) {
      components.push({ name: family, value: 0, note: value.unavailableReason });
      continue;
    }

    weighted += value.normalised * weight;
    totalWeight += weight;
    components.push({
      name: family,
      value: Number(value.normalised.toFixed(4)),
      note: `weight ${weight}${value.evidence === 'observed' ? ', observed' : ''}`,
    });
  }

  if (totalWeight === 0) {
    notes.push('no magnitude family was available for this unit');
    return { value: 0, components };
  }
  return { value: weighted / totalWeight, components };
}

/* ------------------------------------------------------------------------- */
/* Mitigation Ease Score                                                      */
/* ------------------------------------------------------------------------- */

/**
 * How easy and provable a fix would be.
 *
 * Multiplicative, with every factor reported. The two classification axes appear as
 * separate factors on purpose: shape and reach are different obstacles, and collapsing
 * them makes a widely-used one-line helper indistinguishable from a behaviour smeared
 * across four modules. They are not the same problem and should not share a number.
 */
function computeEase(input: {
  unit: SourceUnit;
  classification: UnitClassification | null;
  values: ReadonlyMap<MetricFamilyName, MetricValue>;
  weights: RankingWeights;
  readiness: ProofReadiness;
  scenarioCovered: boolean;
}): { value: number; components: MetricComponent[] } {
  const { unit, classification, values, weights, readiness, scenarioCovered } = input;
  const components: MetricComponent[] = [];

  const quadrantFactor =
    classification === null ? 0.5 : weights.quadrantFactor[classification.quadrant];
  components.push({
    name: 'quadrant',
    value: quadrantFactor,
    note: classification?.quadrant ?? 'unclassified; assumed middling',
  });

  const blastFactor =
    classification === null ? 0.5 : weights.blastRadiusFactor[classification.blastRadius];
  components.push({
    name: 'blastRadius',
    value: blastFactor,
    note: classification?.blastRadius ?? 'unclassified',
  });

  const readinessFactor = weights.readinessFactor[readiness];
  components.push({ name: 'proofReadiness', value: readinessFactor, note: readiness });

  // Mild, because the coarse mono/poly distinction is already carried by the quadrant.
  // This term only separates units that fall on the same side of that line.
  const surface = values.get('dependencySurface');
  const surfaceFactor = surface?.available === true ? 1 - surface.normalised * 0.25 : 0.9;
  components.push({
    name: 'dependencySurfaceDetail',
    value: Number(surfaceFactor.toFixed(4)),
    note: 'fine-grained coupling; the coarse signal is in the quadrant',
  });

  const sizeFactor = Math.min(1, weights.comfortableUnitLines / Math.max(1, unit.lineCount));
  components.push({
    name: 'size',
    value: Number(sizeFactor.toFixed(4)),
    note: `${unit.lineCount} lines; a large unit resists a surgical diff`,
  });

  const guardrailFactor = scenarioCovered ? 1 : weights.noScenarioFactor;
  components.push({
    name: 'guardrail',
    value: guardrailFactor,
    note: scenarioCovered
      ? 'exercised by an approved scenario'
      : 'no approved scenario reaches this unit; one can be built',
  });

  const confidenceFactor = classification?.confidence ?? 0.6;
  components.push({
    name: 'classificationConfidence',
    value: Number(confidenceFactor.toFixed(3)),
    note: classification?.truncated === true ? 'impact is a lower bound' : null,
  });

  const value =
    quadrantFactor *
    blastFactor *
    readinessFactor *
    surfaceFactor *
    sizeFactor *
    guardrailFactor *
    confidenceFactor;

  return { value: Number(Math.min(1, Math.max(0, value)).toFixed(6)), components };
}

/* ------------------------------------------------------------------------- */
/* Cross-family corrections                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Cases where one family is confidently wrong and another family knows it.
 *
 * The most valuable lines in the ranking. A single-family score is exactly where a
 * confident false positive comes from, and a correction turns one into a recorded note
 * instead of a wasted experiment.
 */
function applyCorrections(input: {
  values: ReadonlyMap<MetricFamilyName, MetricValue>;
  corrections: string[];
  contested: boolean;
}): void {
  const { values, corrections, contested } = input;

  const dead = values.get('deadCodeSuspicion');
  const observed = values.get('observedDefect');

  // The strongest cross-check available. A unit nothing appears to reach, which is
  // nonetheless emitting console output, is not dead — it is entered by a path the graph
  // cannot see, and the correct response is to fix the graph, not delete code.
  if (
    dead?.available === true &&
    dead.normalised > 0.7 &&
    observed?.available === true &&
    observed.raw > 0
  ) {
    corrections.push(
      'dead-code suspicion suppressed: the unit emits console output, so it is reached by a path the graph cannot see',
    );
  }

  const redundancy = values.get('redundancy');
  if (redundancy?.available === true && redundancy.raw > 0 && redundancy.confidence < 0.6) {
    corrections.push(
      'redundancy is a shape collision only; similarity must be confirmed before it counts as a finding',
    );
  }

  const amplification = values.get('amplification');
  if (
    amplification?.available === true &&
    amplification.normalised > 0.8 &&
    amplification.proofReadiness !== 'measurable'
  ) {
    corrections.push(
      'high amplification with no way to measure it: instrument the hot path before proposing a change to it',
    );
  }

  if (contested) {
    corrections.push(
      'the corpus contradicts itself about this subject; patching would silently pick a side',
    );
  }

  const economy = values.get('economy');
  if (economy?.available === true && economy.notes.some((note) => note.includes('lower bound'))) {
    corrections.push('economy rests on a truncated impact traversal and understates reach');
  }
}

function adjustMagnitude(
  magnitude: number,
  values: ReadonlyMap<MetricFamilyName, MetricValue>,
  corrections: readonly string[],
): number {
  let adjusted = magnitude;

  if (corrections.some((correction) => correction.startsWith('dead-code suspicion suppressed'))) {
    const dead = values.get('deadCodeSuspicion');
    const weightRemoved = dead?.available === true ? dead.normalised * 0.6 : 0;
    adjusted = Math.max(0, adjusted - weightRemoved * 0.25);
  }

  return Math.min(1, Math.max(0, adjusted));
}

/* ------------------------------------------------------------------------- */
/* Decision                                                                   */
/* ------------------------------------------------------------------------- */

interface Decision {
  readonly kind: CandidateKind;
  readonly lane: WorkLane;
  readonly exclusionReason: string | null;
  readonly proposedAction: string;
}

/**
 * Input to the decision.
 *
 * `isProtected` is declared `| undefined` rather than optional. Under
 * `exactOptionalPropertyTypes` an optional property's type does not include `undefined`,
 * so passing a possibly-undefined value into one is an error — the rule exists to stop
 * "absent" and "present but undefined" being quietly confused, and the fix is to say
 * which is meant.
 */
interface DecisionInput {
  readonly unit: SourceUnit;
  readonly classification: UnitClassification | null;
  readonly readiness: ProofReadiness;
  readonly allowedQuadrants: ReadonlySet<Quadrant>;
  readonly allowedBlastRadii: ReadonlySet<BlastRadius>;
  readonly isProtected: ((unit: SourceUnit) => string | null) | undefined;
  readonly contested: boolean;
  readonly override: string | null;
}

/**
 * The proof-readiness gate, and the two-axis eligibility check behind landing gate G7.
 *
 * Order matters. Protection is absolute and is checked first; a contested subject is
 * next, because patching one means choosing a side the project has not chosen; then
 * reach, then shape, then measurability. A candidate that cannot be measured never
 * becomes a patch — it becomes an instrumentation candidate, which is the structural
 * defence against proposing a change that cannot be proven and then arguing it is
 * obviously an improvement.
 */
function decide(input: DecisionInput): Decision {
  const {
    unit,
    classification,
    readiness,
    allowedQuadrants,
    allowedBlastRadii,
    isProtected,
    contested,
    override,
  } = input;

  const protectedReason = classification?.protectedReason ?? isProtected?.(unit) ?? null;
  if (protectedReason !== null || classification?.blastRadius === 'protected') {
    return {
      kind: 'excluded',
      lane: 'clarification',
      exclusionReason: `protected surface: ${protectedReason ?? 'declared by policy'}`,
      proposedAction:
        'Report as a finding for the Creator. A protected surface is deliberate; CLUE may argue for a change here but never make one.',
    };
  }

  if (contested) {
    return {
      kind: 'clarification',
      lane: 'clarification',
      exclusionReason: null,
      proposedAction:
        'Resolve the contradiction in the corpus first. Patching a contested subject means choosing a side the project has not chosen.',
    };
  }

  const blastRadius = classification?.blastRadius ?? null;
  if (blastRadius !== null && !allowedBlastRadii.has(blastRadius) && override === null) {
    return {
      kind: 'excluded',
      lane: 'investigation',
      exclusionReason: `${blastRadius} blast radius; automatic work is limited to ${[...allowedBlastRadii].join(', ')}`,
      proposedAction:
        'Produce a finding with the evidence and let the Creator decide. A change with this reach is a design decision, not an optimisation.',
    };
  }

  const quadrant = classification?.quadrant ?? null;
  if (quadrant !== null && !allowedQuadrants.has(quadrant) && override === null) {
    return {
      kind: 'excluded',
      lane: 'investigation',
      exclusionReason: `${quadrant} shape; a change here is diffuse in both files and dependencies`,
      proposedAction:
        'Record the finding. A behaviour spread across files and dependencies is rarely provable in one bounded experiment; propose a decomposition instead.',
    };
  }

  if (readiness !== 'measurable') {
    return {
      kind: 'instrumentation',
      lane: 'instrumentation',
      exclusionReason: null,
      proposedAction:
        readiness === 'needs-instrument'
          ? 'Design a probe or scenario that measures the suspected cost directly, then re-rank.'
          : 'No instrument can currently observe this. Record the gap; do not propose a change.',
    };
  }

  return {
    kind: 'patch',
    lane: 'safe-improvement',
    exclusionReason: null,
    proposedAction:
      override === null
        ? 'Design a patch with a falsifiable proof contract and guardrails, and prove it in the shadow clone.'
        : `Design a patch. Override recorded: ${override}`,
  };
}

/* ------------------------------------------------------------------------- */
/* Lane selection                                                             */
/* ------------------------------------------------------------------------- */

export interface LaneShares {
  readonly 'safe-improvement': number;
  readonly instrumentation: number;
  readonly clarification: number;
  readonly investigation: number;
}

export const DEFAULT_LANE_SHARES: LaneShares = {
  'safe-improvement': 0.5,
  instrumentation: 0.3,
  clarification: 0.15,
  investigation: 0.05,
};

export interface BatchOptions {
  readonly size: number;
  readonly shares?: LaneShares;
  readonly maxPerSubsystem?: number;
  readonly agingBoost?: number;
  readonly ageOf?: (logicalId: string) => number;
}

/**
 * Selects a mixed batch of work.
 *
 * Fair lanes are not politeness. Without them a cycle spends itself entirely on the
 * highest-scoring family in the noisiest subsystem, and CLUE becomes excellent at one
 * question while learning nothing about the rest of the project. The instrumentation
 * share matters most: it converts unmeasurable suspicion into measurable fact, and a
 * system that never spends on it stays permanently blind in the same places.
 */
export function selectBatch(result: RankingResult, options: BatchOptions): RankedCandidate[] {
  const shares = options.shares ?? DEFAULT_LANE_SHARES;
  const maxPerSubsystem = options.maxPerSubsystem ?? Math.max(2, Math.ceil(options.size / 3));
  const agingBoost = options.agingBoost ?? 0.02;

  const pools: Record<WorkLane, RankedCandidate[]> = {
    'safe-improvement': [...result.patchCandidates],
    instrumentation: [...result.instrumentationCandidates],
    clarification: [...result.clarificationCandidates],
    investigation: result.excluded.filter((candidate) => candidate.lane === 'investigation'),
  };

  if (options.ageOf !== undefined) {
    const age = options.ageOf;
    for (const lane of Object.keys(pools) as WorkLane[]) {
      pools[lane].sort(
        (a, b) =>
          b.priority + age(b.logicalId) * agingBoost - (a.priority + age(a.logicalId) * agingBoost),
      );
    }
  }

  const perSubsystem = new Map<string, number>();
  const selected: RankedCandidate[] = [];

  for (const lane of Object.keys(shares) as WorkLane[]) {
    const quota = Math.max(0, Math.round(options.size * shares[lane]));
    let taken = 0;

    for (const candidate of pools[lane]) {
      if (taken >= quota || selected.length >= options.size) break;
      const used = perSubsystem.get(candidate.subsystem) ?? 0;
      if (used >= maxPerSubsystem) continue;

      selected.push(candidate);
      perSubsystem.set(candidate.subsystem, used + 1);
      taken += 1;
    }
  }

  // A quota a lane could not fill returns to the pool rather than being wasted, so a
  // quiet lane does not shrink the cycle.
  if (selected.length < options.size) {
    const chosen = new Set(selected.map((candidate) => candidate.logicalId));
    const remainder = [...pools['safe-improvement'], ...pools.instrumentation, ...pools.clarification]
      .filter((candidate) => !chosen.has(candidate.logicalId))
      .sort((a, b) => b.priority - a.priority);

    for (const candidate of remainder) {
      if (selected.length >= options.size) break;
      const used = perSubsystem.get(candidate.subsystem) ?? 0;
      if (used >= maxPerSubsystem) continue;
      selected.push(candidate);
      perSubsystem.set(candidate.subsystem, used + 1);
    }
  }

  return selected;
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The least ready of the families that actually contribute.
 *
 * Pessimistic on purpose. A candidate is only as provable as the weakest evidence the
 * proposal would rest on, and averaging readiness would let a well-measured family
 * launder an unmeasurable one into a patch task.
 */
function worstReadiness(
  values: ReadonlyMap<MetricFamilyName, MetricValue>,
  weights: RankingWeights,
): ProofReadiness {
  const order: ProofReadiness[] = ['measurable', 'needs-instrument', 'not-measurable'];
  let worst = 0;

  for (const [family, value] of values) {
    if ((weights.families[family] ?? 0) === 0) continue;
    if (!value.available) continue;
    if (value.normalised < 0.2) continue;
    worst = Math.max(worst, order.indexOf(value.proofReadiness));
  }

  return order[worst] ?? 'needs-instrument';
}

function computeConfidence(
  values: ReadonlyMap<MetricFamilyName, MetricValue>,
  classification: UnitClassification | null,
): number {
  const contributing = [...values.values()].filter(
    (value) => value.available && value.normalised >= 0.2,
  );
  if (contributing.length === 0) return classification?.confidence ?? 0.5;

  // Geometric mean, so one badly uncertain family drags the candidate down rather than
  // being averaged away by confident neighbours.
  const product = contributing.reduce((total, value) => total * Math.max(0.05, value.confidence), 1);
  const geometric = Math.pow(product, 1 / contributing.length);

  return Math.min(1, Math.max(0, geometric * (classification?.confidence ?? 0.8)));
}

function dominantEvidence(
  values: ReadonlyMap<MetricFamilyName, MetricValue>,
  weights: RankingWeights,
): EvidenceClass {
  for (const [family, value] of values) {
    if ((weights.families[family] ?? 0) === 0) continue;
    if (value.available && value.evidence === 'observed' && value.normalised > 0) return 'observed';
  }
  return 'static-inference';
}

function dominantFamily(
  values: ReadonlyMap<MetricFamilyName, MetricValue>,
  weights: RankingWeights,
): MetricFamilyName | null {
  let best: MetricFamilyName | null = null;
  let bestScore = 0;

  for (const [family, value] of values) {
    const weight = weights.families[family] ?? 0;
    if (weight === 0 || !value.available) continue;
    const score = value.normalised * weight;
    if (score > bestScore) {
      bestScore = score;
      best = family;
    }
  }
  return best;
}

function subsystemOf(modulePath: string): string {
  const first = modulePath.indexOf('/');
  if (first === -1) return '.';
  const second = modulePath.indexOf('/', first + 1);
  return second === -1 ? modulePath.slice(0, first) : modulePath.slice(0, second);
}