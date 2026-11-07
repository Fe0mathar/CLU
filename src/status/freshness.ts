/**
 * CLU-E Status — failure and freshness rules.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §18 is this file's entire subject. Also
 *   §2     every field is durably backed or an explicitly named non-value
 *   §13    a valid historical certificate cannot override a fresh runtime fault
 *   §20    gate 5 (assessment and runtime health cannot be conflated)
 * Directory: `CLUE_Project_Directory_v9.md` §19.2 — missing evidence becomes `UNKNOWN`,
 *          `OPEN`, `STALE` or `UNAVAILABLE`, never an invented zero or healthy state.
 *
 * Backlog: DEV-P1-13 — §18's rules existed only as prose. Rules of this shape are almost
 *          always violated by omission rather than by decision: nobody writes `value: 0`
 *          for absent data on purpose, they write it because a numeric field needed
 *          filling and zero was to hand. Prose cannot prevent that; a function that has no
 *          way to return zero for an absent reading can.
 *
 * ## Scope, stated honestly
 *
 * §18 lists twenty-five rules. Ten are implemented here because the state they govern
 * exists in this build. The remaining fifteen govern domains this tree does not have —
 * UPR projection loss, intent promotion, method-knowledge frontier claims, AI-authored
 * benchmark instruments, human-preference evidence, forecast-versus-realized value,
 * project equilibrium promotion, Base Pins, provider outage, remote divergence, worktree
 * retention, and publication blocking. They are enumerated in {@link DEFERRED_RULES} with
 * their owning domain rather than being silently absent, so a reader can tell an
 * unimplemented rule from a forgotten one. Implementing them now would mean writing
 * predicates over records nothing produces, and the predicate would then become the thing
 * the eventual domain is built to satisfy.
 *
 * ## Why these are functions over inputs and not methods on a projector
 *
 * Each rule is a decision about what a reading is *allowed to say*. Kept as pure
 * functions, each is provable in isolation and reusable by the projector, the CLI
 * validator and any future diagnostic surface — which is what §20 gate 4 requires, since
 * three surfaces reaching different freshness verdicts over the same data would be exactly
 * the drift Status exists to remove. This module performs no I/O and reads no clock: the
 * evaluation time is a parameter, for the same reason it is one in `statusSeal.ts`.
 */

import type { BranchState, BranchUnavailable, Freshness } from './statusContractV5.js';

/* ------------------------------------------------------------------------- */
/* Rule inventory                                                             */
/* ------------------------------------------------------------------------- */

/** A §18 rule this module enforces, named so a test can assert the set is complete. */
export const ENFORCED_RULES = [
  'failed-projection-carries-forward',
  'unavailable-is-not-zero',
  'stale-carries-age-and-source',
  'partial-scan-is-not-complete',
  'runtime-health-expires',
  'invalid-seal-blocks-automation',
  'unknown-native-is-not-normalized-zero',
  'missing-normalization-is-local',
  'coordinate-collision-is-total',
  'console-gap-stays-visible',
  'gauge-reports-its-own-state',
] as const;

export type EnforcedRule = (typeof ENFORCED_RULES)[number];

/**
 * §18 rules whose governed state has no owning module in this build.
 *
 * Listed rather than omitted: an absent rule and an unimplemented rule look identical
 * otherwise, and only one of them is a defect.
 */
export const DEFERRED_RULES: readonly { readonly rule: string; readonly owner: string }[] = [
  { rule: 'secrets redacted before export', owner: 'src/observability — redaction exists, export does not' },
  { rule: 'unsupported environment blocks project-complete recognition', owner: 'src/analysis/environments/' },
  { rule: 'UPR information loss is visible and blocks dependent claims', owner: 'src/analysis/upr/' },
  { rule: 'inferred intent cannot be promoted to confirmed', owner: 'src/intent/' },
  { rule: 'stale method knowledge cannot support a frontier claim', owner: 'src/analysis/method/' },
  { rule: 'an unfrozen AI-authored benchmark is INVALID_INSTRUMENT', owner: 'src/benchmark/' },
  { rule: 'uncontrolled visual preference is not controlled proof', owner: 'src/evaluation/' },
  { rule: 'forecast value is never reported as realized value', owner: 'src/analysis/value/' },
  { rule: 'local equilibrium cannot be promoted to project equilibrium', owner: 'src/equilibrium/' },
  { rule: 'stale Base Pins invalidate only dependent claims', owner: 'src/integration/git/' },
  { rule: 'provider outage becomes UNAVAILABLE or DEFERRED', owner: 'src/ai/' },
  { rule: 'remote divergence never triggers an implicit rebase', owner: 'src/integration/git/' },
  { rule: 'deleted worktrees cannot erase evidence without a receipt', owner: 'src/integration/git/' },
  { rule: 'unclassified evidence blocks sealing and publication', owner: 'src/integration/git/' },
  { rule: 'metric coordinate/normalization review records', owner: 'src/metrics/Normalization.ts' },
];

/* ------------------------------------------------------------------------- */
/* Freshness — "stale data carries age, last source event and refresh …"      */
/* ------------------------------------------------------------------------- */

/** What a reading is being judged against. `limitMs` absent means nothing expires it. */
export interface FreshnessPolicy {
  readonly limitMs: number | null;
}

/**
 * Evaluates a reading's freshness at a declared instant.
 *
 * §18 requires stale data to carry three things, and this returns all three or explains
 * why it cannot: the age, the last source event, and — through `stale` plus `limitMs` —
 * the refresh requirement that decided it. `limitMs` travels in the result so the
 * judgement is checkable later; a bare `stale: true` would be an assertion no reader could
 * audit.
 *
 * A reading with no observation time is not "fresh by default": `ageMs` is null and
 * `stale` is false only because unknown age cannot prove expiry. That asymmetry is
 * deliberate — §2 does not permit inventing an age, and a policy that treated unknown as
 * expired would flap every branch whose source carries no timestamp.
 */
export function evaluateFreshness(
  observedAt: string,
  evaluatedAt: string,
  sourceHead: string | null,
  policy: FreshnessPolicy = { limitMs: null },
): Freshness {
  const observed = Date.parse(observedAt);
  const evaluated = Date.parse(evaluatedAt);
  const known = Number.isFinite(observed) && Number.isFinite(evaluated);
  const ageMs = known ? Math.max(0, evaluated - observed) : null;
  return {
    observedAt,
    ageMs,
    sourceHead,
    stale: ageMs !== null && policy.limitMs !== null && ageMs > policy.limitMs,
    limitMs: policy.limitMs,
  };
}

/* ------------------------------------------------------------------------- */
/* "unavailable data becomes unknown, not zero"                               */
/* ------------------------------------------------------------------------- */

/**
 * A reading that exists, or an explicit statement that it does not.
 *
 * The point of the type is that there is no third case. A caller cannot reach for a
 * default, because `absent` carries no numeric member to default *to* — the zero has
 * nowhere to live.
 */
export type Reading<T> =
  | { readonly present: true; readonly value: T }
  | { readonly present: false; readonly state: BranchState; readonly reason: string };

export const present = <T>(value: T): Reading<T> => ({ present: true, value });

export const absent = <T>(state: BranchState, reason: string): Reading<T> => ({
  present: false,
  state,
  reason,
});

/**
 * The only sanctioned way to put a `Reading` into a nullable status field.
 *
 * Returns the value, or null — never zero, never an empty string, never a placeholder.
 * §18 and Directory §19.2 both say the same thing from different directions: absent data
 * becomes unknown, and null is the one representation of unknown that no arithmetic will
 * silently consume.
 */
export function readingValue<T>(reading: Reading<T>): T | null {
  return reading.present ? reading.value : null;
}

/** Converts an absent reading into the branch-level unavailability the contract carries. */
export function readingToBranch(
  reading: Reading<unknown>,
  expectedSource: string | null,
  lastKnownAt: string | null = null,
): BranchUnavailable | null {
  if (reading.present) return null;
  return { state: reading.state, reason: reading.reason, expectedSource, lastKnownAt };
}

/* ------------------------------------------------------------------------- */
/* "failed projection leaves the last valid status visible and records a fault"*/
/* ------------------------------------------------------------------------- */

export interface ProjectionFault {
  readonly branch: string;
  readonly detail: string;
  readonly occurredAt: string;
}

export interface CarryForward<T> {
  /** What the caller should show: the last valid reading, or nothing if there never was one. */
  readonly value: T | null;
  /** True when `value` is a previous reading rather than a current one. */
  readonly carriedForward: boolean;
  /** The fault, when this projection failed. Never swallowed. */
  readonly fault: ProjectionFault | null;
  /** When `value` was actually observed — not when it was displayed. */
  readonly asOf: string | null;
}

/**
 * Applies §18's first rule: a failed projection leaves the last valid status visible *and*
 * records a fault.
 *
 * Both halves are load-bearing and each is useless alone. Showing the last value without
 * the fault presents stale data as current — the exact lie §18's freshness rules exist to
 * prevent. Recording the fault while blanking the display throws away the operator's only
 * remaining information at the moment they most need it. So `carriedForward` and `fault`
 * are separate members and the caller cannot get one without seeing the other.
 */
export function carryForward<T>(
  branch: string,
  current: Reading<T>,
  previous: { readonly value: T; readonly asOf: string } | null,
  failure: string | null,
  now: string,
): CarryForward<T> {
  if (failure === null && current.present) {
    return { value: current.value, carriedForward: false, fault: null, asOf: now };
  }
  const fault: ProjectionFault = {
    branch,
    detail: failure ?? (current.present ? 'unknown failure' : current.reason),
    occurredAt: now,
  };
  if (previous === null) {
    return { value: null, carriedForward: false, fault, asOf: null };
  }
  return { value: previous.value, carriedForward: true, fault, asOf: previous.asOf };
}

/* ------------------------------------------------------------------------- */
/* "partial target scans cannot emit committed-complete status"               */
/* ------------------------------------------------------------------------- */

export type CompletenessClaim = 'committed_complete' | 'partial' | 'unknown';

/**
 * Decides what a scan may claim about itself.
 *
 * The rule is a one-way door: a run may only call itself complete when every file in the
 * program was recognised *and* the graph was durably committed. Anything short of that is
 * `partial`, and a run whose counts are unknown is `unknown` rather than optimistically
 * either.
 */
export function completenessOf(input: {
  readonly filesInProgram: number | null;
  readonly filesRecognised: number | null;
  readonly committed: boolean;
}): CompletenessClaim {
  if (input.filesInProgram === null || input.filesRecognised === null) return 'unknown';
  if (!input.committed) return 'partial';
  return input.filesRecognised >= input.filesInProgram ? 'committed_complete' : 'partial';
}

/* ------------------------------------------------------------------------- */
/* "runtime health expires according to target profile"                       */
/* ------------------------------------------------------------------------- */

export type RuntimeHealth = 'healthy' | 'degraded' | 'fault' | 'unknown' | 'stale';

/**
 * Expires a runtime-health reading.
 *
 * §13 is the reason this is not a simple max: a valid historical certificate cannot
 * override a fresh runtime fault, and the converse also holds — an expired *healthy*
 * reading must not keep asserting health. But an expired `fault` stays a fault. Health
 * decays into `stale`; a fault does not decay into anything, because the last thing known
 * about a faulted runtime is that it was faulted.
 */
export function expireRuntimeHealth(
  reported: RuntimeHealth,
  freshness: Freshness,
): RuntimeHealth {
  if (!freshness.stale) return reported;
  if (reported === 'fault' || reported === 'unknown') return reported;
  return 'stale';
}

/* ------------------------------------------------------------------------- */
/* "an invalid seal blocks automation and production-health claims"           */
/* ------------------------------------------------------------------------- */

export interface AutomationGate {
  readonly automationPermitted: boolean;
  readonly productionHealthClaimPermitted: boolean;
  readonly reason: string | null;
}

/**
 * §18: an invalid seal blocks automation and production-health claims.
 *
 * Both are blocked together and for the same reason: an unverifiable snapshot cannot
 * support a decision, and "the target is healthy" is a decision. Note that a *valid* seal
 * over an inconsistent body still blocks — validity proves the body was not altered, not
 * that its branches agree, and §15 calls a disagreement a projector defect.
 */
export function automationGate(seal: {
  readonly valid: boolean;
  readonly consistent: boolean;
}): AutomationGate {
  if (!seal.valid) {
    return {
      automationPermitted: false,
      productionHealthClaimPermitted: false,
      reason: 'the State Seal did not verify',
    };
  }
  if (!seal.consistent) {
    return {
      automationPermitted: false,
      productionHealthClaimPermitted: false,
      reason: 'the seal verified but the body is internally inconsistent',
    };
  }
  return { automationPermitted: true, productionHealthClaimPermitted: true, reason: null };
}

/* ------------------------------------------------------------------------- */
/* Metric projection invalidation — the asymmetric blast radius               */
/* ------------------------------------------------------------------------- */

export type FieldInvalidation =
  | { readonly scope: 'none' }
  /** A missing normalization profile invalidates *only* the affected metric. */
  | { readonly scope: 'metric'; readonly metricIds: readonly string[]; readonly reason: string }
  /** A coordinate collision invalidates the *entire* field projection. */
  | { readonly scope: 'field'; readonly reason: string };

/**
 * §18 gives these two failures deliberately different blast radii, and the asymmetry is
 * the substance of the rule.
 *
 * A missing normalization profile makes one metric uncomparable; every other cell remains
 * exactly as true as it was, so discarding the field would destroy good evidence over a
 * local gap. A coordinate collision is different in kind: if two metrics claim one cell,
 * *no* cell's identity can be trusted, because the collision proves the coordinate map
 * itself is wrong. Reporting the second as a per-metric problem would leave a field whose
 * every reading is unattributable looking mostly fine.
 *
 * Collision is checked first: when both are present the field is void regardless.
 */
export function invalidateField(input: {
  readonly collidingCoordinates: readonly string[];
  readonly metricsMissingNormalization: readonly string[];
}): FieldInvalidation {
  if (input.collidingCoordinates.length > 0) {
    return {
      scope: 'field',
      reason:
        `metric coordinate collision at ${input.collidingCoordinates.join(', ')}; ` +
        'no cell identity in the field can be trusted',
    };
  }
  if (input.metricsMissingNormalization.length > 0) {
    return {
      scope: 'metric',
      metricIds: [...input.metricsMissingNormalization],
      reason: 'no normalization profile; the native value stands but is not comparable',
    };
  }
  return { scope: 'none' };
}

/**
 * §18: unknown native values never become normalized zero.
 *
 * The normalized coordinate of an unknown or unnormalizable reading is null. This exists
 * as a named function rather than as a rule in someone's head because the pressure to
 * return 0 here is real — a renderer wants a number, and a bar of length zero looks like a
 * measurement rather than like an absence.
 */
export function normalizedValueOf(
  native: Reading<number>,
  profileAvailable: boolean,
): number | null {
  if (!native.present || !profileAvailable) return null;
  return native.value;
}

/* ------------------------------------------------------------------------- */
/* "a console sequence gap or dropped event count remains visible"            */
/* ------------------------------------------------------------------------- */

export interface ConsoleContinuity {
  readonly contiguous: boolean;
  /** Events the window did not carry. Never folded into zero. */
  readonly droppedEvents: number;
  /** Sequence ranges the window is missing, where they can be named. */
  readonly gaps: readonly { readonly from: number; readonly to: number }[];
  readonly detail: string | null;
}

/**
 * Reports what a console window is missing.
 *
 * A window is contiguous only when the sequences it carries run without a break *and*
 * nothing was dropped. Both halves matter: a bounded replay that returned the newest 250
 * of 5000 events has no internal gap at all, and reporting it as contiguous would be
 * technically true and completely misleading. Dropped events therefore break contiguity
 * on their own, which is what §18 and Status §8.3's `droppedEvents` field are for.
 */
export function consoleContinuity(input: {
  readonly sequences: readonly number[];
  readonly droppedEvents: number;
}): ConsoleContinuity {
  const gaps: { from: number; to: number }[] = [];
  const ordered = [...input.sequences].sort((left, right) => left - right);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) continue;
    if (current > previous + 1) gaps.push({ from: previous + 1, to: current - 1 });
  }
  const contiguous = gaps.length === 0 && input.droppedEvents === 0;
  return {
    contiguous,
    droppedEvents: input.droppedEvents,
    gaps,
    detail: contiguous
      ? null
      : `${gaps.length} sequence gap(s); ${input.droppedEvents} event(s) not carried`,
  };
}

/* ------------------------------------------------------------------------- */
/* "a gauge … reports that state rather than silently selecting another"      */
/* ------------------------------------------------------------------------- */

export type GaugeResolution =
  | { readonly resolved: true; readonly metricId: string }
  | { readonly resolved: false; readonly state: BranchState; readonly reason: string };

/**
 * Resolves a gauge's configured metric, or refuses.
 *
 * The prohibited behaviour is substitution: a gauge whose metric is retired, stale or not
 * applicable must say so rather than quietly rendering a different metric in the same
 * slot. A substituted gauge is worse than an empty one — the operator reads a number,
 * believes it is the number they configured, and has no way to discover otherwise. So
 * there is no fallback parameter here at all; the function cannot substitute because it is
 * never given anything to substitute with.
 */
export function resolveGaugeMetric(input: {
  readonly metricId: string | null;
  readonly retired: boolean;
  readonly applicable: boolean;
  readonly freshness: Freshness | null;
}): GaugeResolution {
  if (input.metricId === null) {
    return { resolved: false, state: 'unknown', reason: 'no metric is configured for this slot' };
  }
  if (input.retired) {
    return {
      resolved: false,
      state: 'not_applicable',
      reason: `metric ${input.metricId} is retired from the catalogue in force`,
    };
  }
  if (!input.applicable) {
    return {
      resolved: false,
      state: 'not_applicable',
      reason: `metric ${input.metricId} is not applicable to this target`,
    };
  }
  if (input.freshness?.stale === true) {
    return {
      resolved: false,
      state: 'stale',
      reason: `metric ${input.metricId} last observed ${String(input.freshness.ageMs)}ms ago, past its limit`,
    };
  }
  return { resolved: true, metricId: input.metricId };
}
