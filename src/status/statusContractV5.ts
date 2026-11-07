/**
 * CLU-E Status Contract — machine schema owner.
 *
 * Spec: `CLUE_Status_Contract_v9.md` is the sole normative owner of this shape.
 *   §2     truth boundaries: every field is durably backed or explicitly unknown /
 *          not_applicable / conflicted / stale / unavailable
 *   §3     top-level structure; the runtime schema is strict and rejects unknown fields
 *   §15    the State Seal binds the canonicalized body — there is exactly one
 *   §19    additive optional fields are a minor version; changed meaning is a major one
 *   §20    acceptance gates, of which gates 2 and 3 are this file's direct obligations
 * Directory: `CLUE_Project_Directory_v9.md` §19.2 — `statusContractV5.ts` is the machine
 *          schema owner corresponding to the Status Contract; §19.3 — backend UI modules
 *          transform *sealed Status*, they do not maintain a second lifecycle state machine.
 * Supplement: `supplementation_v9.md` §9 — wire schema 5.1.0 and the `goldenMetrics` branch.
 *
 * Backlog: DEV-P1-10 — Status Contract v5 had no machine owner at all. The console's
 *          `src/ui/viewModel.ts` had become the de-facto sealed contract, which inverts
 *          the Directory's layering and cannot satisfy §20 gate 3 ("one and only one State
 *          Seal exists") while a second seal lives downstream of it.
 *
 * ## Why the wire version is 5.8.0
 *
 * The Status Contract's own header states `5.0.0` and says its v9 re-baseline "is not a
 * schema migration". `supplementation_v9.md` §9.1 first advanced the canonical wire to
 * `5.1.0` for `goldenMetrics`; ADR-0007 then added the backed cycle branch as `5.2.0`;
 * ADR-0011 adds the durable `proofPipeline` branch as `5.3.0`; ADR-0012 adds the
 * event-backed `greatBook` branch as `5.4.0`; ADR-0013 adds the governed,
 * event-backed `aiOrchestration` branch as `5.5.0`; ADR-0014 adds the explicit,
 * mission-bound target publication decision as `5.6.0`. Each is an additive minor
 * revision under §19. The supplement's §2.3 still supplies the governing refusal:
 *
 *   > A partial state in which, for example, the Catalogue defines Golden Metrics while
 *   > Status still rejects the branch is not a releasable documentation baseline.
 *
 * DEV-P1-18/19/20 already migrated the Catalogue to v6 / 100 active coordinates, so the
 * Catalogue half of that atomic transaction is done. Emitting `5.0.0` here would
 * deliberately construct the state the supplement forbids.
 *
 * The Golden branch is therefore present and explicitly `UNAVAILABLE`, which is what its
 * own contract prescribes rather than a way around it: §9.1 requires a migrated snapshot
 * to carry "an explicit `UNAVAILABLE` migration state and no invented metric values", and
 * §9.4 requires one item per Golden ID, "a non-applicable or unavailable metric is
 * represented by an explicit item, not omission". No Golden backend exists in this tree
 * (`src/metrics/golden/` is absent), so unavailable is the true reading.
 *
 * ## Why most branches are refusal-only
 *
 * The current machine contract partitions 35 ordinary branches: fifteen are backed by
 * durable state and twenty have no owning domain in this build. That is not because
 * Status is allowed to omit them; it is because substantial domains assigned elsewhere by
 * the Directory do not exist here yet: no `src/intent/`, `src/ai/`, `src/evaluation/`,
 * `src/improvement/`, `src/equilibrium/`, or `src/integration/git/`.
 *
 * §2 and §18 make that representable rather than embarrassing: unavailable data becomes
 * unknown, never zero, and §20 gate 26 requires the snapshot to "clearly distinguish
 * normative RPI capabilities from capabilities evidenced as implemented by the observed
 * CLU-E runtime". So an unbacked branch is typed as {@link BranchUnavailable} *only*. Its
 * populated variant is deliberately not invented here; it is added when its owning domain
 * exists, which is an additive widening and therefore a minor version under §19.
 *
 * Inventing those shapes now would be the more damaging choice. A speculative schema for
 * `benchmarks` or `equilibrium` would become the thing the eventual domain is built to
 * satisfy, which is exactly backwards — and it would let a projector emit a structurally
 * valid branch describing evidence that was never gathered.
 *
 * ## Why the backed branches are imported, not re-declared
 *
 * §19 is explicit that "no separate manual status format is allowed to drift". The
 * improvement field, the four gauges and the operational console already have validated,
 * separately-versioned contracts under `src/ui/` and `src/observability/`. This file
 * composes those schemas rather than restating them, so there is one definition of each.
 * Their independent `schemaVersion` fields travel with them, which §19's "the status
 * schema is versioned independently" permits and the seal binds.
 *
 * This module is pure: types, schemas, and constants. It performs no I/O, reads no
 * durable state, and computes no hash. The projector (`statusProjector.ts`) produces
 * bodies of this shape; the seal (`statusSeal.ts`) binds them.
 */

import { z } from 'zod';

import {
  fourNeonGaugesSchema,
  type FourNeonGaugesView,
} from '../ui/fourNeonGauges.js';
import {
  greatBookImprovementFieldSchema,
  type GreatBookImprovementFieldView,
} from '../ui/greatBookImprovementField.js';
import {
  operationalConsoleProjectionSchema,
  type OperationalConsoleProjection,
} from '../observability/operationalConsole/contract.js';
import type { Sha256 } from '../shared/ids.js';
import {
  projectOperationIdentitySchema,
  type ProjectOperationIdentity,
} from '../shared/projectOperationIdentity.js';
import {
  targetPublicationStateSchema,
  type TargetPublicationState,
} from '../shared/targetPublication.js';

/* ------------------------------------------------------------------------- */
/* Version                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The canonical wire schema version. See the module header, ADR-0011 and ADR-0012 for
 * the additive path from the documentation baseline through 5.1.0–5.8.0. Status 5.7.0 added provider-budget authority, controlled
 * provider pause, exact model identity and token-usage telemetry without claiming a provider-side
 * remaining-token balance. Status 5.8.0 adds one explicit Project Profile/readiness branch and
 * binds the Model Gateway branch to the active project generation. Historical 5.7.0 bodies remain
 * 5.7.0 evidence and are rejected by this strict validator rather than silently reinterpreted.
 */
export const STATUS_SCHEMA_VERSION = '5.8.0' as const;

/** The Golden branch's own definition-schema version (`supplementation_v9.md` §9.3). */
export const GOLDEN_DEFINITION_SCHEMA_VERSION = '1.0.0' as const;

/** The four stable Golden IDs (`supplementation_v9.md` §5.1). Exactly these, always. */
export const GOLDEN_METRIC_IDS = ['GOLD-01', 'GOLD-02', 'GOLD-03', 'GOLD-04'] as const;
export type GoldenMetricId = (typeof GOLDEN_METRIC_IDS)[number];

/* ------------------------------------------------------------------------- */
/* Availability — the shape §2 and §18 require                                */
/* ------------------------------------------------------------------------- */

/**
 * Why a branch carries no data.
 *
 * These are §2's permitted non-values. The distinction that matters most in this engine's
 * current state is `unsupported` versus `unavailable`: the first says the capability is
 * specified but not implemented here, the second says it is implemented but could not be
 * read right now. Collapsing them would let a missing subsystem look like a transient
 * fault, which is precisely the confusion §20 gate 26 exists to prevent.
 */
export const BRANCH_STATES = [
  /** Specified by the contract, not implemented by this runtime. Gate 26's distinction. */
  'unsupported',
  /** Implemented, but the durable source could not be read for this snapshot. */
  'unavailable',
  /** Readable, but no determination can be made from what was read. */
  'unknown',
  /** Correctly empty — the branch does not apply to this target or cycle. */
  'not_applicable',
  /** Read, but the sources disagree. §18: a conflict stays visible. */
  'conflicted',
  /** Last known value, past its freshness limit. */
  'stale',
] as const;

export type BranchState = (typeof BRANCH_STATES)[number];

/**
 * A branch with no data, and the reason.
 *
 * `reason` is mandatory and free text because the honest answer is specific — "no
 * `src/benchmark/` domain in this build" is useful; a bare `unsupported` is not. `since`
 * and `sourceHead` are present where known so a reader can tell a permanent gap from a
 * momentary one without consulting another branch.
 */
export interface BranchUnavailable {
  readonly state: BranchState;
  /** Why, in one specific line. Never a generic placeholder. */
  readonly reason: string;
  /** The durable source that would have backed this branch, when one is named. */
  readonly expectedSource: string | null;
  /** Last successful reading of this branch, when there has ever been one. */
  readonly lastKnownAt: string | null;
}

const branchUnavailableSchema = z
  .object({
    state: z.enum(BRANCH_STATES),
    reason: z.string().min(1),
    expectedSource: z.string().min(1).nullable(),
    lastKnownAt: z.string().min(1).nullable(),
  })
  .strict();

/**
 * A branch that is either populated or explicitly not. The discriminant is the presence of
 * `state`, so a populated branch physically cannot also claim unavailability.
 */
export type Branch<T> = BranchUnavailable | T;

/* ------------------------------------------------------------------------- */
/* Freshness — §18                                                            */
/* ------------------------------------------------------------------------- */

/**
 * How current a populated branch is. Carried alongside data rather than inside it, so the
 * data shape is owned by its domain and the freshness rule is owned by Status (§18).
 */
export interface Freshness {
  /** When the underlying durable state was last observed. */
  readonly observedAt: string;
  /** Age in milliseconds at capture; null when the source carries no timestamp. */
  readonly ageMs: number | null;
  /** The event-log sequence or record id this reading was taken at. */
  readonly sourceHead: string | null;
  /** True once `ageMs` exceeds the branch's policy limit. §18: stale carries its age. */
  readonly stale: boolean;
  /** The limit that decided `stale`, so the judgement is checkable. */
  readonly limitMs: number | null;
}

const freshnessSchema = z
  .object({
    observedAt: z.string().min(1),
    ageMs: z.number().nonnegative().nullable(),
    sourceHead: z.string().min(1).nullable(),
    stale: z.boolean(),
    limitMs: z.number().positive().nullable(),
  })
  .strict();

/* ------------------------------------------------------------------------- */
/* Backed branches                                                            */
/* ------------------------------------------------------------------------- */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/) as unknown as z.ZodType<Sha256>;

/** §4 — what is being assessed, to the extent this engine can name it. */
export interface TargetBranch {
  readonly targetId: string;
  readonly name: string | null;
  /** The canonical root. §4: identified without leaking secrets. */
  readonly canonicalRoot: string;
  readonly snapshotId: string | null;
  readonly missionVersionId: string | null;
  readonly missionBasisHash: Sha256 | null;
  readonly constitutionHash: Sha256 | null;
  readonly catalogueVersion: string | null;
  readonly catalogueHash: Sha256 | null;
  readonly recognizerVersion: string | null;
  /**
   * Mission-bound target publication decision (ADR-0014 / DEV-P2-04).
   *
   * This belongs to target identity, not `versionControl`: P2 records a stated absence or
   * credential-free remote identity while continuing to report the governed Git lifecycle
   * as unsupported. Neither profile state grants publication authority.
   */
  readonly publication: TargetPublicationState;
  /**
   * §4 additionally requires the adapter set, UPR hashes, Master Benchmark versions, Git
   * envelope, and value/proof policy. None has an owning module in this build; the
   * `assessmentEnvelope` branch reports that rather than this one carrying empty strings.
   */
  readonly freshness: Freshness;
}

const targetBranchSchema = z
  .object({
    targetId: z.string().min(1),
    name: z.string().min(1).nullable(),
    canonicalRoot: z.string().min(1),
    snapshotId: z.string().min(1).nullable(),
    missionVersionId: z.string().min(1).nullable(),
    missionBasisHash: sha256.nullable(),
    constitutionHash: sha256.nullable(),
    catalogueVersion: z.string().min(1).nullable(),
    catalogueHash: sha256.nullable(),
    recognizerVersion: z.string().min(1).nullable(),
    publication: targetPublicationStateSchema,
    freshness: freshnessSchema,
  })
  .strict();

/** Active Project Profile generation and operation-specific readiness — Status 5.8.0. */
export const PROJECT_READINESS_WIRE_LEVELS = [
  'READY',
  'READY_LOCAL_ONLY',
  'INCOMPLETE',
  'BLOCKED',
  'INVALID',
] as const;
export type ProjectReadinessWireLevel = (typeof PROJECT_READINESS_WIRE_LEVELS)[number];

export const PROJECT_CAPABILITY_WIRE_STATES = [
  'READY',
  'READY_LOCAL_ONLY',
  'NOT_REQUIRED',
  'INCOMPLETE',
  'BLOCKED',
  'INVALID',
] as const;
export type ProjectCapabilityWireState = (typeof PROJECT_CAPABILITY_WIRE_STATES)[number];

export interface ProjectCapabilityWireReadiness {
  readonly state: ProjectCapabilityWireState;
  readonly ready: boolean;
  readonly required: boolean;
  readonly code: string;
}

export interface ProjectProfileBranch {
  readonly profileMode: 'project-profile';
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly assessmentAvailable: boolean;
  readonly overallReadiness: ProjectReadinessWireLevel;
  readonly readyForLocalWork: boolean;
  readonly readyForRequestedOperations: boolean;
  readonly capabilities: {
    readonly recognition: ProjectCapabilityWireReadiness;
    readonly proof: ProjectCapabilityWireReadiness;
    readonly browserBenchmark: ProjectCapabilityWireReadiness;
    readonly aiCandidateGeneration: ProjectCapabilityWireReadiness;
    readonly gitPublication: ProjectCapabilityWireReadiness;
    readonly custodianLanding: ProjectCapabilityWireReadiness;
  };
  readonly authorityState: 'CURRENT' | 'INCOMPLETE' | 'DRIFTED' | 'INVALID';
  readonly authorityConflictState: 'CLEAR' | 'AUTHORITY CONFLICT';
  readonly authorityManifestHash: Sha256 | null;
  readonly configuredAuthorityHash: Sha256;
  readonly recognitionConfigurationHash: Sha256;
  readonly assessedAt: string;
  readonly freshness: Freshness;
}

const projectCapabilityWireReadinessSchema = z
  .object({
    state: z.enum(PROJECT_CAPABILITY_WIRE_STATES),
    ready: z.boolean(),
    required: z.boolean(),
    code: z.string().min(1),
  })
  .strict();

const projectProfileBranchSchema = z
  .object({
    profileMode: z.literal('project-profile'),
    projectIdentity: projectOperationIdentitySchema,
    profileGeneration: z.number().int().positive(),
    assessmentAvailable: z.boolean(),
    overallReadiness: z.enum(PROJECT_READINESS_WIRE_LEVELS),
    readyForLocalWork: z.boolean(),
    readyForRequestedOperations: z.boolean(),
    capabilities: z
      .object({
        recognition: projectCapabilityWireReadinessSchema,
        proof: projectCapabilityWireReadinessSchema,
        browserBenchmark: projectCapabilityWireReadinessSchema,
        aiCandidateGeneration: projectCapabilityWireReadinessSchema,
        gitPublication: projectCapabilityWireReadinessSchema,
        custodianLanding: projectCapabilityWireReadinessSchema,
      })
      .strict(),
    authorityState: z.enum(['CURRENT', 'INCOMPLETE', 'DRIFTED', 'INVALID']),
    authorityConflictState: z.enum(['CLEAR', 'AUTHORITY CONFLICT']),
    authorityManifestHash: sha256.nullable(),
    configuredAuthorityHash: sha256,
    recognitionConfigurationHash: sha256,
    assessedAt: z.string().min(1),
    freshness: freshnessSchema,
  })
  .strict();

/** §5.1 — physical inventory, kept separate from semantic recognition. */
export interface RepositoryInventoryBranch {
  readonly snapshotId: string;
  readonly fileCount: number;
  readonly capturedAt: string;
  /** Files by language, as the snapshot manifest recorded them. */
  readonly languageCensus: Readonly<Record<string, number>>;
  readonly freshness: Freshness;
}

const repositoryInventoryBranchSchema = z
  .object({
    snapshotId: z.string().min(1),
    fileCount: z.number().int().nonnegative(),
    capturedAt: z.string().min(1),
    languageCensus: z.record(z.string(), z.number().int().nonnegative()),
    freshness: freshnessSchema,
  })
  .strict();

/** §5 — semantic recognition of the inventoried snapshot. */
export interface RecognitionBranch {
  readonly snapshotId: string;
  readonly resultHash: Sha256;
  readonly unitCount: number;
  readonly edgeCount: number;
  readonly unresolvedCount: number;
  readonly filesInProgram: number;
  readonly filesRecognised: number;
  readonly semanticDiagnostics: number;
  /**
   * Distinct module paths in the committed graph — the Q1 topology count (§5.1).
   *
   * Added after the ADR-0002 agreement test found the console reporting a module count that
   * Status could not. Both read it from the same `RecognitionFacts.moduleCount`; Status
   * simply dropped it. That is exactly the information loss ADR-0002 warns a naive inversion
   * would cause, found before the inversion rather than after.
   */
  readonly moduleCount: number;
  /** Four-quadrant classification distribution (mono/poly file × dependency), §5.1. */
  readonly classDistribution: Readonly<Record<string, number>>;
  /**
   * §2: `scanned ≠ recognized`. False whenever the inventory holds files the recognizer
   * did not reach, so a partial scan cannot present itself as complete (§18).
   */
  readonly complete: boolean;
  readonly freshness: Freshness;
}

/**
 * The cycle branch — Execution Model §1's operating unit on the wire (ADR-0007, accepted
 * 2026-08-11; the 5.2.0 revision).
 *
 * Both members are independently nullable, and the pair is the point: a workspace whose
 * domain exists but has never run a cycle is `{backed, null, null}` — backed and truthfully
 * empty — which is the contract's founding distinction between "the domain answers:
 * nothing yet" and "no domain answers" (§2).
 *
 * The closure carries `unmetCount`, not the reasons (D2). §24's reasons live in the closure
 * event and the §19 handoff artifact, sealed and complete; the wire carries the verdict and
 * its weight, and a consumer wanting the reasons follows `cycleId` into evidence.
 */
/** The stage vocabulary, restated here because the wire contract is deliberately
 *  independent of internal module types — a consumer reads this file alone. */
export type CycleStageOnWire =
  | 'OPENED'
  | 'INPUTS_LOCKED'
  | 'OPENING_EVIDENCE'
  | 'RECOGNIZED'
  | 'SCREENED'
  | 'CANDIDATES'
  | 'CLOSING_EVIDENCE'
  | 'HANDOFF'
  | 'CLOSED'
  | 'SUSPENDED';

export type CycleGradeOnWire = 'diagnostic' | 'proof-authoritative';

export interface CycleCurrent {
  readonly id: string;
  readonly stage: CycleStageOnWire;
  readonly grade: CycleGradeOnWire | null;
  readonly lockDigest: Sha256 | null;
  readonly suspendedFrom: string | null;
  readonly openedAt: string;
  readonly updatedAt: string;
}

export interface CycleClosure {
  readonly cycleId: string;
  readonly closedAt: string;
  readonly grade: CycleGradeOnWire;
  readonly criteriaMet: boolean;
  readonly unmetCount: number;
  readonly stageReached: string;
}

export interface CycleBranch {
  readonly current: CycleCurrent | null;
  readonly lastClosure: CycleClosure | null;
  readonly freshness: Freshness;
}

/**
 * Proof-pipeline branch — ADR-0011 / Status wire 5.3.0.
 *
 * This branch reports only proof events that exist durably in the event index. It never
 * reconstructs proof from UI state. A null member means that event has not been recorded
 * for the selected cycle; a wholly empty branch is therefore a backed domain with no proof
 * attempt yet, not an unsupported capability.
 */
export interface ProofPipelineEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface ProofPipelineBranch {
  readonly cycleId: string | null;
  readonly contractFrozen: ProofPipelineEvent | null;
  readonly baselineBound: ProofPipelineEvent | null;
  readonly executionRefused: ProofPipelineEvent | null;
  readonly verdictRecorded: ProofPipelineEvent | null;
  readonly freshness: Freshness;
}

const proofPipelineEventSchema = z
  .object({
    eventId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    occurredAt: z.string().min(1),
  })
  .strict();

const proofPipelineBranchSchema = z
  .object({
    cycleId: z.string().min(1).nullable(),
    contractFrozen: proofPipelineEventSchema.nullable(),
    baselineBound: proofPipelineEventSchema.nullable(),
    executionRefused: proofPipelineEventSchema.nullable(),
    verdictRecorded: proofPipelineEventSchema.nullable(),
    freshness: freshnessSchema,
  })
  .strict();

/** Durable recursive-memory summary — DEV-P2-12 / Status wire 5.4.0. */
export interface GreatBookBranch {
  readonly entryCount: number;
  readonly contributionCount: number;
  readonly recordingGapCount: number;
  readonly latestEntryId: string | null;
  readonly latestCycleId: string | null;
  readonly normalizationVersion: string;
  readonly normalizationHash: Sha256;
  readonly freshness: Freshness;
}

const greatBookBranchSchema = z
  .object({
    entryCount: z.number().int().nonnegative(),
    contributionCount: z.number().int().nonnegative(),
    recordingGapCount: z.number().int().nonnegative(),
    latestEntryId: z.string().regex(/^GBI-[0-9a-f]{32}$/).nullable(),
    latestCycleId: z.string().min(1).nullable(),
    normalizationVersion: z.string().min(1),
    normalizationHash: sha256,
    freshness: freshnessSchema,
  })
  .strict();

/** Governed Model Gateway summary — DEV-P2-09 / Status wire 5.8.0. */
export interface AiOrchestrationBranch {
  readonly configured: true;
  readonly enabled: boolean;
  readonly provider: 'openai';
  /** Exact active project generation; null only for the legacy config-v2 runtime. */
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
  /** Sanitized credential reference only; never credential bytes. */
  readonly credentialReference: string;
  readonly requestedModel: string | null;
  readonly effectiveModel: string | null;
  readonly fallbackUsed: false;
  /** Environment-variable name only. The secret value is never a Status field. */
  readonly apiKeyEnv: string;
  readonly apiKeyPresent: boolean;
  readonly operationallyReady: boolean;
  readonly policyProblems: readonly string[];
  readonly budgetHash: Sha256;
  readonly routingHash: Sha256;
  readonly priceScheduleVersion: string;
  readonly enabledRouteCount: number;
  readonly defaultMode: 'interactive' | 'batch';
  readonly model: string | null;
  /** Monetary budget authority. P2 final activation requires OpenAI Platform. */
  readonly budgetAuthority: 'clue' | 'openai_platform';
  readonly localBudgetEnforced: boolean;
  readonly localPricingAuthoritative: boolean;
  readonly providerState: 'ready' | 'unknown' | 'paused_budget';
  readonly providerPaused: boolean;
  readonly providerBudgetExhausted: boolean;
  readonly providerPauseReason: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly providerRemainingTokens: number | null;
    readonly providerRemainingTokensAuthoritative: false;
  };
  readonly calls: {
    readonly submitted: number;
    readonly completed: number;
    readonly failed: number;
    readonly refused: number;
    readonly pending: number;
  };
  readonly spendUsd: {
    readonly todayActual: number | null;
    readonly monthActual: number | null;
    readonly reserved: number | null;
    readonly dailyHard: number;
    readonly monthlyHard: number;
  };
  readonly degradationAction:
    | 'notify'
    | 'frontier_to_batch'
    | 'batch_only'
    | 'pause_submissions'
    | null;
  readonly latest: {
    readonly callId: string;
    readonly taskType: string;
    readonly lane: string;
    readonly mode: string;
    readonly model: string | null;
    readonly state: string;
    readonly submittedAt: string;
    readonly updatedAt: string;
    readonly actualUsd: number | null;
    readonly errorCode: string | null;
  } | null;
  readonly freshness: Freshness;
}

const aiOrchestrationBranchSchema = z
  .object({
    configured: z.literal(true),
    enabled: z.boolean(),
    provider: z.literal('openai'),
    projectIdentity: projectOperationIdentitySchema.nullable(),
    profileGeneration: z.number().int().positive().nullable(),
    credentialReference: z
      .string()
      .regex(/^(?:env:[A-Z][A-Z0-9_]{0,63}|credential-store:[A-Za-z0-9][A-Za-z0-9._:/-]{0,191})$/u),
    requestedModel: z.string().min(1).nullable(),
    effectiveModel: z.string().min(1).nullable(),
    fallbackUsed: z.literal(false),
    apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    apiKeyPresent: z.boolean(),
    operationallyReady: z.boolean(),
    policyProblems: z.array(z.string().min(1)),
    budgetHash: sha256,
    routingHash: sha256,
    priceScheduleVersion: z.string().min(1),
    enabledRouteCount: z.number().int().nonnegative(),
    defaultMode: z.enum(['interactive', 'batch']),
    model: z.string().min(1).nullable(),
    budgetAuthority: z.enum(['clue', 'openai_platform']),
    localBudgetEnforced: z.boolean(),
    localPricingAuthoritative: z.boolean(),
    providerState: z.enum(['ready', 'unknown', 'paused_budget']),
    providerPaused: z.boolean(),
    providerBudgetExhausted: z.boolean(),
    providerPauseReason: z.string().min(1).nullable(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        providerRemainingTokens: z.number().int().nonnegative().nullable(),
        providerRemainingTokensAuthoritative: z.literal(false),
      })
      .strict(),
    calls: z
      .object({
        submitted: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        refused: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict(),
    spendUsd: z
      .object({
        todayActual: z.number().finite().nonnegative().nullable(),
        monthActual: z.number().finite().nonnegative().nullable(),
        reserved: z.number().finite().nonnegative().nullable(),
        dailyHard: z.number().finite().nonnegative(),
        monthlyHard: z.number().finite().nonnegative(),
      })
      .strict(),
    degradationAction: z
      .enum(['notify', 'frontier_to_batch', 'batch_only', 'pause_submissions'])
      .nullable(),
    latest: z
      .object({
        callId: z.string().regex(/^GWCALL-[0-9a-f]{32}$/),
        taskType: z.string().min(1),
        lane: z.string().min(1),
        mode: z.string().min(1),
        model: z.string().min(1).nullable(),
        state: z.string().min(1),
        submittedAt: z.string().min(1),
        updatedAt: z.string().min(1),
        actualUsd: z.number().finite().nonnegative().nullable(),
        errorCode: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    freshness: freshnessSchema,
  })
  .strict();

const cycleCurrentSchema = z
  .object({
    id: z.string().min(1),
    stage: z.enum([
      'OPENED',
      'INPUTS_LOCKED',
      'OPENING_EVIDENCE',
      'RECOGNIZED',
      'SCREENED',
      'CANDIDATES',
      'CLOSING_EVIDENCE',
      'HANDOFF',
      'CLOSED',
      'SUSPENDED',
    ]),
    grade: z.enum(['diagnostic', 'proof-authoritative']).nullable(),
    lockDigest: sha256.nullable(),
    suspendedFrom: z.string().min(1).nullable(),
    openedAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

const cycleClosureSchema = z
  .object({
    cycleId: z.string().min(1),
    closedAt: z.string().min(1),
    grade: z.enum(['diagnostic', 'proof-authoritative']),
    criteriaMet: z.boolean(),
    unmetCount: z.number().int().nonnegative(),
    stageReached: z.string().min(1),
  })
  .strict();

const cycleBranchSchema = z
  .object({
    current: cycleCurrentSchema.nullable(),
    lastClosure: cycleClosureSchema.nullable(),
    freshness: freshnessSchema,
  })
  .strict();

const recognitionBranchSchema = z
  .object({
    snapshotId: z.string().min(1),
    resultHash: sha256,
    unitCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    unresolvedCount: z.number().int().nonnegative(),
    filesInProgram: z.number().int().nonnegative(),
    filesRecognised: z.number().int().nonnegative(),
    semanticDiagnostics: z.number().int().nonnegative(),
    moduleCount: z.number().int().nonnegative(),
    classDistribution: z.record(z.string(), z.number().int().nonnegative()),
    complete: z.boolean(),
    freshness: freshnessSchema,
  })
  .strict();

/** §5.1 — the Q1 stream identity. Gate 38: inventory reconciles with ALL exactly once. */
export interface Q1Branch {
  readonly runId: string | null;
  readonly snapshotId: string | null;
  /** The committed record's own identity — the pointer's parity anchor (DEV-P1-06). */
  readonly resultHash: Sha256 | null;
  readonly streamSha256: Sha256 | null;
  readonly streamEventCount: number | null;
  /** True when the run's telemetry was incomplete, carried forward from the stream seal. */
  readonly streamDegraded: boolean;
  /** Gate 38, evaluated: inventory file count equals the ALL projection's file count. */
  readonly inventoryReconciles: boolean | null;
  readonly freshness: Freshness;
}

const q1BranchSchema = z
  .object({
    runId: z.string().min(1).nullable(),
    snapshotId: z.string().min(1).nullable(),
    resultHash: sha256.nullable(),
    streamSha256: sha256.nullable(),
    streamEventCount: z.number().int().nonnegative().nullable(),
    streamDegraded: z.boolean(),
    inventoryReconciles: z.boolean().nullable(),
    freshness: freshnessSchema,
  })
  .strict();

/** §7.1 — one record per semantic unit, resolving to evidence (gate 7). */
export interface UnitRecord {
  readonly unitId: string;
  readonly path: string;
  readonly kind: string;
  /** §2: `recognized ≠ purpose-understood`. Null until a purpose record exists. */
  readonly purposeRecordId: string | null;
  readonly measured: boolean;
}

const unitRecordSchema = z
  .object({
    unitId: z.string().min(1),
    path: z.string().min(1),
    kind: z.string().min(1),
    purposeRecordId: z.string().min(1).nullable(),
    measured: z.boolean(),
  })
  .strict();

/** §8 — the catalogue in force. Gate 11: 100 active v6 metrics, unique IDs and cells. */
export interface MeasurementCatalogueBranch {
  readonly version: string;
  readonly hash: Sha256;
  readonly activeCount: number;
  readonly reservedCount: number;
  /** Gate 11, evaluated by the loader rather than asserted here. */
  readonly coordinatesUnique: boolean;
  /** Whether this catalogue may govern a run (the v6 production-readiness gate). */
  readonly productionReady: boolean;
  readonly freshness: Freshness;
}

const measurementCatalogueBranchSchema = z
  .object({
    version: z.string().min(1),
    hash: sha256,
    activeCount: z.number().int().nonnegative(),
    reservedCount: z.number().int().nonnegative(),
    coordinatesUnique: z.boolean(),
    productionReady: z.boolean(),
    freshness: freshnessSchema,
  })
  .strict();

/**
 * §6 — WHAT / WHY / HOW PROVEN / WHO / NEXT for the active work (gate 6).
 *
 * Reuses the operational console's `CurrentWorkContract` rather than restating it: the
 * console recorder already produces exactly this record, and two declarations of it would
 * be the drift §19 prohibits.
 */
export interface CurrentWorkBranch {
  readonly contract: OperationalConsoleProjection['currentWorkContract'];
  readonly freshness: Freshness;
}

/* ------------------------------------------------------------------------- */
/* Golden Outcome Rail — supplement §9.3                                      */
/* ------------------------------------------------------------------------- */

/**
 * The Golden branch. Four explicit items, always — §9.4 forbids representing an
 * unavailable metric by omission, so an absent backend produces four stated
 * unavailabilities rather than an empty list.
 */
export interface GoldenMetricsBranch {
  readonly schemaVersion: typeof GOLDEN_DEFINITION_SCHEMA_VERSION;
  readonly projectionState: 'READY' | 'PARTIAL' | 'UNKNOWN' | 'STALE' | 'UNAVAILABLE' | 'INVALID';
  readonly definitionSet: {
    readonly id: string;
    readonly version: string;
    readonly hash: Sha256;
    readonly canonicalGridRevision: string;
  } | null;
  readonly items: readonly [GoldenItem, GoldenItem, GoldenItem, GoldenItem];
}

/** One Golden result, or an explicit statement that there is none. */
export interface GoldenItem {
  readonly id: GoldenMetricId;
  readonly applicability:
    | 'REQUIRED'
    | 'APPLICABLE'
    | 'CONDITIONAL'
    | 'NOT_APPLICABLE'
    | 'UNKNOWN'
    | 'CONFLICTED';
  readonly state:
    | 'UNKNOWN'
    | 'BASELINE_ONLY'
    | 'MEASURED'
    | 'PRODUCT_GAIN'
    | 'ENGINEERING_ONLY'
    | 'REGRESSION'
    | 'NON_CONVERGENCE'
    | 'NOT_COMPARABLE'
    | 'INVALID_EXPERIMENT'
    | 'BLOCKED_BY_GATE'
    | 'STALE'
    | 'UNAVAILABLE';
  /** §9: never zero when unknown. Null is the only honest empty. */
  readonly normalizedValue: number | null;
  readonly normalizedDelta: number | null;
  readonly nativeEvidenceArtifactId: Sha256 | null;
  readonly limitations: readonly string[];
}

const goldenItemSchema = z
  .object({
    id: z.enum(GOLDEN_METRIC_IDS),
    applicability: z.enum([
      'REQUIRED',
      'APPLICABLE',
      'CONDITIONAL',
      'NOT_APPLICABLE',
      'UNKNOWN',
      'CONFLICTED',
    ]),
    state: z.enum([
      'UNKNOWN',
      'BASELINE_ONLY',
      'MEASURED',
      'PRODUCT_GAIN',
      'ENGINEERING_ONLY',
      'REGRESSION',
      'NON_CONVERGENCE',
      'NOT_COMPARABLE',
      'INVALID_EXPERIMENT',
      'BLOCKED_BY_GATE',
      'STALE',
      'UNAVAILABLE',
    ]),
    normalizedValue: z.number().nullable(),
    normalizedDelta: z.number().nullable(),
    nativeEvidenceArtifactId: sha256.nullable(),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

const goldenMetricsBranchSchema = z
  .object({
    schemaVersion: z.literal(GOLDEN_DEFINITION_SCHEMA_VERSION),
    projectionState: z.enum(['READY', 'PARTIAL', 'UNKNOWN', 'STALE', 'UNAVAILABLE', 'INVALID']),
    definitionSet: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1),
        hash: sha256,
        canonicalGridRevision: z.string().min(1),
      })
      .strict()
      .nullable(),
    // Exactly four, in stable ID order. §9.4 and §14.4: exactly four unique Golden IDs.
    items: z.tuple([goldenItemSchema, goldenItemSchema, goldenItemSchema, goldenItemSchema]),
  })
  .strict();

/* ------------------------------------------------------------------------- */
/* Diagnostics — §13                                                          */
/* ------------------------------------------------------------------------- */

/**
 * §13.2. Kept structurally separate from assessment, because §13 requires that a valid
 * historical certificate cannot override a fresh runtime fault — a rule that only holds
 * if the two can never be read as one field.
 */
export interface RuntimeDiagnosticsBranch {
  readonly health: 'healthy' | 'degraded' | 'fault' | 'unknown' | 'stale';
  readonly reason: string | null;
  readonly checkedAt: string;
  readonly faults: readonly string[];
}

const runtimeDiagnosticsBranchSchema = z
  .object({
    health: z.enum(['healthy', 'degraded', 'fault', 'unknown', 'stale']),
    reason: z.string().min(1).nullable(),
    checkedAt: z.string().min(1),
    faults: z.array(z.string().min(1)),
  })
  .strict();

/* ------------------------------------------------------------------------- */
/* Seal — §15                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * §15 and §20 gate 3: exactly one seal per snapshot. It is declared here so the schema can
 * validate it, and computed by `statusSeal.ts`, which is the only module permitted to.
 *
 * §15's determinism rule — the same durable inputs and declared timestamp reproduce the
 * same body and seal, and a mismatch is a projector defect — is the acceptance probe for
 * that module, not a property this file can enforce.
 */
export interface StatusSeal {
  readonly statusHash: Sha256;
  readonly generatedAt: string;
  /** §15: the source event-log range this body was assembled over. */
  readonly eventLogFrom: number | null;
  readonly eventLogTo: number | null;
  readonly projectionVersion: string | null;
  readonly targetSnapshotId: string | null;
  readonly missionHash: Sha256 | null;
  readonly catalogueHash: Sha256 | null;
  /** Supplement §9.6. Null while no Golden definition set exists. */
  readonly goldenDefinitionHash: Sha256 | null;
  /** False if the projector detected an inconsistency while assembling the body. */
  readonly consistent: boolean;
  /** What was inconsistent, when it was not. */
  readonly inconsistencies: readonly string[];
}

const statusSealSchema = z
  .object({
    statusHash: sha256,
    generatedAt: z.string().min(1),
    eventLogFrom: z.number().int().nonnegative().nullable(),
    eventLogTo: z.number().int().nonnegative().nullable(),
    projectionVersion: z.string().min(1).nullable(),
    targetSnapshotId: z.string().min(1).nullable(),
    missionHash: sha256.nullable(),
    catalogueHash: sha256.nullable(),
    goldenDefinitionHash: sha256.nullable(),
    consistent: z.boolean(),
    inconsistencies: z.array(z.string().min(1)),
  })
  .strict();

/* ------------------------------------------------------------------------- */
/* Capability declaration — §1 and gate 26                                    */
/* ------------------------------------------------------------------------- */

/**
 * §1: status "must never present a specified-but-unimplemented RPI capability as
 * operational". Gate 26 turns that into a structural requirement.
 *
 * This branch is the snapshot's own honest account of itself: which contract branches this
 * build can back, and which acceptance gates it claims. It exists so a reader never has to
 * infer implementation state from the absence of data — absence and unimplementedness look
 * identical otherwise, and only one of them is a fault.
 *
 * **Recorded gap (`DEV-P1-51`).** The declaration is two-state per branch: backed or
 * unsupported. A third state — specified, implemented, but *degraded here and now* — has no
 * field, so a build whose reader is failing must report the branch as backed and let the
 * branch's own `state: 'unavailable'` carry the fact. That is expressible today, one level
 * down, which is why the gap is recorded rather than closed: adding the field is a wire-schema
 * change, a `STATUS_SCHEMA_VERSION` bump, and ADR-0001 territory, taken while the v9
 * documentation pack itself is unratified. If per-branch degradation ever needs to appear in
 * the capability summary rather than in the branches, this interface is where the field goes
 * and this note is what it replaces. Decision recorded 2026-08-09 (Creator-delegated).
 */
export interface CapabilityDeclaration {
  readonly contractVersion: typeof STATUS_SCHEMA_VERSION;
  /** Branch names this build populates from durable state. */
  readonly backedBranches: readonly string[];
  /** Branch names specified by the contract but unimplemented in this build. */
  readonly unsupportedBranches: readonly string[];
  /** §20 gate numbers this build claims to satisfy. Claiming none is permitted. */
  readonly satisfiedGates: readonly number[];
  /** Gate numbers explicitly not reachable, with the reason. */
  readonly unreachableGates: readonly { readonly gate: number; readonly reason: string }[];
}

const capabilityDeclarationSchema = z
  .object({
    contractVersion: z.literal(STATUS_SCHEMA_VERSION),
    backedBranches: z.array(z.string().min(1)),
    unsupportedBranches: z.array(z.string().min(1)),
    satisfiedGates: z.array(z.number().int().positive()),
    unreachableGates: z.array(
      z.object({ gate: z.number().int().positive(), reason: z.string().min(1) }).strict(),
    ),
  })
  .strict();

/* ------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* ------------------------------------------------------------------------- */

/**
 * One status snapshot: §3's structure, in §3's order.
 *
 * Every branch is `Branch<T>` — populated, or an explicit {@link BranchUnavailable}. The
 * twenty-one branches typed as `BranchUnavailable` alone are the ones whose owning domain
 * does not exist in this build; they gain a populated variant when it does, which §19
 * classes as a minor version.
 */
export interface StatusSnapshot {
  readonly schemaVersion: typeof STATUS_SCHEMA_VERSION;
  readonly generatedAt: string;

  readonly target: Branch<TargetBranch>;
  readonly projectProfile: Branch<ProjectProfileBranch>;
  readonly projectInputs: BranchUnavailable;
  readonly assessmentEnvelope: BranchUnavailable;
  readonly rpi: BranchUnavailable;
  readonly cycle: Branch<CycleBranch>;
  readonly repositoryInventory: Branch<RepositoryInventoryBranch>;
  readonly recognition: Branch<RecognitionBranch>;
  readonly q1: Branch<Q1Branch>;
  readonly environments: BranchUnavailable;
  readonly universalProjectRepresentation: BranchUnavailable;
  readonly crossEnvironment: BranchUnavailable;
  readonly purposeAndCapabilities: BranchUnavailable;
  readonly intentAndMethods: BranchUnavailable;
  readonly solutionFrontier: BranchUnavailable;
  readonly currentWork: Branch<CurrentWorkBranch>;
  readonly units: Branch<readonly UnitRecord[]>;
  readonly functionalities: BranchUnavailable;
  readonly measurementCatalogue: Branch<MeasurementCatalogueBranch>;
  /** Supplement §9.2: placed after `measurementCatalogue`, before `measureSessions`. */
  readonly goldenMetrics: GoldenMetricsBranch;
  readonly measureSessions: BranchUnavailable;
  readonly proofInstruments: BranchUnavailable;
  readonly humanEvaluations: BranchUnavailable;
  readonly improvementField: Branch<GreatBookImprovementFieldView>;
  readonly gauges: Branch<FourNeonGaugesView>;
  readonly operationalConsole: Branch<OperationalConsoleProjection>;
  readonly aiOrchestration: Branch<AiOrchestrationBranch>;
  readonly findings: BranchUnavailable;
  readonly proofPipeline: Branch<ProofPipelineBranch>;
  readonly benchmarks: BranchUnavailable;
  readonly improvementEconomics: BranchUnavailable;
  readonly versionControl: BranchUnavailable;
  readonly integrations: BranchUnavailable;
  readonly assessment: BranchUnavailable;
  readonly runtimeDiagnostics: Branch<RuntimeDiagnosticsBranch>;
  readonly greatBook: Branch<GreatBookBranch>;
  readonly equilibrium: BranchUnavailable;

  /** §15: durable source identities the body was assembled from. */
  readonly sources: readonly string[];
  /** §1 and gate 26: what this build can and cannot do. */
  readonly capability: CapabilityDeclaration;
  /** §20 gate 3: exactly one. */
  readonly seal: StatusSeal;
}

const currentWorkBranchSchema = z
  .object({
    contract: operationalConsoleProjectionSchema.shape.currentWorkContract,
    freshness: freshnessSchema,
  })
  .strict();

/** A branch that is either its populated shape or an explicit unavailability. */
const branch = <T extends z.ZodTypeAny>(populated: T) =>
  z.union([branchUnavailableSchema, populated]);

/**
 * The complete validator. `.strict()` throughout, because §3 requires unknown additional
 * fields to be *rejected* until a schema revision defines them — a status body that
 * silently absorbed an unrecognised branch would be exactly the second source of truth
 * §19 forbids.
 */
export const statusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    generatedAt: z.string().min(1),

    target: branch(targetBranchSchema),
    projectProfile: branch(projectProfileBranchSchema),
    projectInputs: branchUnavailableSchema,
    assessmentEnvelope: branchUnavailableSchema,
    rpi: branchUnavailableSchema,
    cycle: branch(cycleBranchSchema),
    repositoryInventory: branch(repositoryInventoryBranchSchema),
    recognition: branch(recognitionBranchSchema),
    q1: branch(q1BranchSchema),
    environments: branchUnavailableSchema,
    universalProjectRepresentation: branchUnavailableSchema,
    crossEnvironment: branchUnavailableSchema,
    purposeAndCapabilities: branchUnavailableSchema,
    intentAndMethods: branchUnavailableSchema,
    solutionFrontier: branchUnavailableSchema,
    currentWork: branch(currentWorkBranchSchema),
    units: branch(z.array(unitRecordSchema)),
    functionalities: branchUnavailableSchema,
    measurementCatalogue: branch(measurementCatalogueBranchSchema),
    goldenMetrics: goldenMetricsBranchSchema,
    measureSessions: branchUnavailableSchema,
    proofInstruments: branchUnavailableSchema,
    humanEvaluations: branchUnavailableSchema,
    improvementField: branch(greatBookImprovementFieldSchema),
    gauges: branch(fourNeonGaugesSchema),
    operationalConsole: branch(operationalConsoleProjectionSchema),
    aiOrchestration: branch(aiOrchestrationBranchSchema),
    findings: branchUnavailableSchema,
    proofPipeline: branch(proofPipelineBranchSchema),
    benchmarks: branchUnavailableSchema,
    improvementEconomics: branchUnavailableSchema,
    versionControl: branchUnavailableSchema,
    integrations: branchUnavailableSchema,
    assessment: branchUnavailableSchema,
    runtimeDiagnostics: branch(runtimeDiagnosticsBranchSchema),
    greatBook: branch(greatBookBranchSchema),
    equilibrium: branchUnavailableSchema,

    sources: z.array(z.string().min(1)),
    capability: capabilityDeclarationSchema,
    seal: statusSealSchema,
  })
  .strict();

/**
 * Compile-time proof that the validator mirrors the contract, in both directions.
 *
 * The same technique `src/ui/viewModel.ts` uses and for the same reason: a hand-written
 * validator beside a hand-written interface is a second source of truth unless something
 * forces them to agree. zod infers mutable properties and arrays while the contract is
 * deeply `readonly`; that modifier difference is not a data-shape drift, so both sides are
 * stripped before the mutual-assignability assertion. A field added, removed or retyped on
 * either side breaks the typecheck.
 */
type DeepMutable<T> = T extends readonly (infer E)[]
  ? DeepMutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
type SchemaShape = DeepMutable<z.infer<typeof statusSnapshotSchema>>;
type ContractShape = DeepMutable<StatusSnapshot>;
const schemaCoversContract: ContractShape extends SchemaShape ? true : false = true;
const contractCoversSchema: SchemaShape extends ContractShape ? true : false = true;
void schemaCoversContract;
void contractCoversSchema;

/** Parses and validates an unknown value as a {@link StatusSnapshot}, throwing on mismatch. */
export function parseStatusSnapshot(input: unknown): StatusSnapshot {
  return statusSnapshotSchema.parse(input) as unknown as StatusSnapshot;
}

/** True when a branch carries no data. Narrows to {@link BranchUnavailable}. */
export function isBranchUnavailable<T>(value: Branch<T>): value is BranchUnavailable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    (BRANCH_STATES as readonly string[]).includes((value as BranchUnavailable).state)
  );
}

/**
 * The branch names whose owning domain does not exist in this build.
 *
 * Exported so the projector fills them from one list rather than twenty-one literals, and
 * so a test can assert that the list and the schema agree — the failure mode otherwise is
 * a branch quietly dropping out of the declaration while staying in the type.
 */
export const UNSUPPORTED_BRANCHES = [
  'projectInputs',
  'assessmentEnvelope',
  'rpi',
  'environments',
  'universalProjectRepresentation',
  'crossEnvironment',
  'purposeAndCapabilities',
  'intentAndMethods',
  'solutionFrontier',
  'functionalities',
  'measureSessions',
  'proofInstruments',
  'humanEvaluations',
  'findings',
  'benchmarks',
  'improvementEconomics',
  'versionControl',
  'integrations',
  'assessment',
  'equilibrium',
] as const;

/** The branch names this build populates from durable state. */
export const BACKED_BRANCHES = [
  'target',
  'projectProfile',
  'cycle',
  'repositoryInventory',
  'recognition',
  'q1',
  'currentWork',
  'units',
  'measurementCatalogue',
  'improvementField',
  'gauges',
  'operationalConsole',
  'aiOrchestration',
  'proofPipeline',
  'greatBook',
  'runtimeDiagnostics',
] as const;

/**
 * A Golden branch stating, in the form its own contract requires, that no Golden backend
 * exists. Four explicit items — §9.4 forbids representing an unavailable metric by
 * omission — with null values throughout, because §9 is equally explicit that a missing
 * value never becomes zero.
 */
export function unavailableGoldenMetrics(reason: string): GoldenMetricsBranch {
  const item = (id: GoldenMetricId): GoldenItem => ({
    id,
    applicability: 'UNKNOWN',
    state: 'UNAVAILABLE',
    normalizedValue: null,
    normalizedDelta: null,
    nativeEvidenceArtifactId: null,
    limitations: [reason],
  });
  return {
    schemaVersion: GOLDEN_DEFINITION_SCHEMA_VERSION,
    projectionState: 'UNAVAILABLE',
    definitionSet: null,
    items: [item('GOLD-01'), item('GOLD-02'), item('GOLD-03'), item('GOLD-04')],
  };
}
