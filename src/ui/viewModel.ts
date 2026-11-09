/**
 * CLUE console view-model.
 *
 * Spec: CLUE_Interface_Design_v5.md — the two-tab WebGPU mission-control console.
 *   §4.3   persistent shell elements
 *   §6.1   Start/Stop state machine
 *   §7-8   command crown and mission-context lens
 *   §8.2   no false countdowns
 *   §9     AI sessions and calls
 *   §10-11 recognition field, progress lanes, velocity, forecasts
 *   §11.4  forecasts always carry P50 and P80
 *   §12    patch-to-proof pipeline and the operator-deployment boundary
 *   §13    Great Book and equilibrium
 *   §14-22 Configuration: project, Chrome chain, PowerShell, IDE, AI, tests, storage, safety
 *   §16.6  no false connectivity
 *   §17.5  no false execution state
 *   §21.3  canonical write protection
 *
 * Citation note: this module cites v5 by design. The two-tab console interface is
 * specified only in CLUE_Interface_Design_v5.md; unlike the System Navigator (which is
 * v3 §109), it has no v3 equivalent, so this view-model traces its contract to the
 * interface design directly rather than to the v3 corpus.
 *
 * This is the single shape the daemon projects and both tabs render from. It is
 * deliberately the *first* piece of the interface, for the same reason the host wire
 * contract came before its PowerShell implementation: a renderer, its WGSL, and the
 * endpoint that feeds it all consume this contract, so fixing it first is what prevents
 * the three of them from drifting.
 *
 * Two properties define it.
 *
 *   **It encodes the doctrine as types, not as guidelines.** v5's load-bearing rules are
 *   negative — the interface must never fake a countdown, collapse a connection chain
 *   into one CONNECTED, imply a command that started also succeeded, or suggest CLUE
 *   silently wrote the canonical tree. A comment asking a renderer not to do these things
 *   is worth little. So {@link NextTiming} makes a fabricated clock unrepresentable, the
 *   connection and execution chains are per-stage with no single boolean, the pipeline
 *   carries an explicit {@link PipelineStageState.awaiting_operator} boundary, and a
 *   {@link Verdict} of `accepted` cannot exist without the frozen-contract hash that
 *   proved it. The producer physically cannot emit the lie; the renderer physically
 *   cannot show it.
 *
 *   **It carries meaning, not appearance.** v5 assigns colours and motion — gold for
 *   proof, orange for fault, blue for neutral, a breathing glow for an active session.
 *   None of that lives here. This module carries the *state* a colour stands for; the
 *   mapping from state to Neon Blue / CLUE Gold / Orange lives in the renderer, so the
 *   palette can change without the contract changing and the contract can be reasoned
 *   about without a GPU. The same separation keeps this file free of DOM and WebGPU
 *   types: it is pure data, compiled under the Node lib like the rest of the kernel.
 *
 * Kernel types are imported rather than re-declared wherever a field already has a home
 * in the backend — a session's state is the scheduler's {@link TaskState}, a landing
 * mode is the config's {@link PatchingMode}. Re-declaring them would create a second
 * source of truth that could silently fall out of step, which is precisely the
 * redundancy CLUE exists to remove. Where a mirror is unavoidable it is tied back to its
 * origin with `satisfies`, so a divergence fails the typecheck instead of shipping.
 */

import type { Actor, PatchingMode } from '../shared/schemas.js';
import type { Capability, DenialCode, PathZone } from '../control/policy.js';
import type { TaskLane, TaskState } from '../control/tasks.js';
import type { MissionChangeKind } from '../control/mission.js';
import type { Sha256 } from '../shared/ids.js';
import {
  projectRecognitionIdentitySchema,
  type ProjectRecognitionIdentity,
} from '../shared/projectRecognitionIdentity.js';
import { z } from 'zod';
import { consoleAiOrchestrationSchema, consoleCycleSchema } from '../status/statusContractV5.js';
import {
  operationalConsoleProjectionSchema,
  type OperationalConsoleProjection,
} from '../observability/operationalConsole/contract.js';

import {
  fourNeonGaugesSchema,
  type FourNeonGaugesView,
} from './fourNeonGauges.js';
import {
  greatBookImprovementFieldSchema,
  type GreatBookImprovementFieldView,
} from './greatBookImprovementField.js';

/* ------------------------------------------------------------------------- */
/* Scalar aliases                                                             */
/* ------------------------------------------------------------------------- */

/** ISO-8601 UTC, as produced by `nowIso()`. Kept as an alias to read intent. */
export type IsoTimestamp = string;

/** A percentage in the inclusive range 0–100. The renderer clamps; producers should not exceed it. */
export type Percent = number;

/** A duration in whole or fractional seconds. The renderer formats; the contract stays unit-explicit. */
export type Seconds = number;

/** A confidence in the inclusive range 0–1. */
export type Confidence = number;

/* ------------------------------------------------------------------------- */
/* Honesty primitives                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Semantic health, not a colour. The renderer maps these to the palette: `ok` reads as
 * quiet blue, `degraded` and `fault` as orange, `unknown` as an unlit/quiet state. The
 * distinction between `degraded` (known-impaired but functioning) and `unknown`
 * (unverified) is deliberate and load-bearing — the no-false-connectivity rule forbids
 * treating an unverified link as working, so a summary must be able to say "not yet
 * proven" rather than defaulting to green.
 */
export type HealthLevel = 'ok' | 'degraded' | 'fault' | 'unknown';

/** Trend direction for a velocity series (§11.2). */
export type Trend = 'accelerating' | 'stable' | 'slowing' | 'blocked' | 'volatile';

export const TREND_STATES = ['accelerating', 'stable', 'slowing', 'blocked', 'volatile'] as const satisfies readonly Trend[];

/**
 * When the next thing happens (§8.2). This is the anti-fake-countdown type: a real clock
 * exists only in the `eta` variant, and even then it must state the basis it was computed
 * from. Every other case names *why* there is no clock instead of inventing one. There is
 * no representable value that is a bare number with no justification.
 */
export type NextTiming =
  /** A genuine estimate with a stated basis, e.g. "P50 of comparable checkpoints". */
  | { readonly by: 'eta'; readonly etaSeconds: Seconds; readonly basis: string }
  /** Gated on a checkpoint being written by a named session. No clock is honest here. */
  | { readonly by: 'after_checkpoint'; readonly sessionId: string }
  /** Gated on a human action, e.g. applying a patch and returning a receipt. */
  | { readonly by: 'after_operator'; readonly awaiting: string }
  /** Deliberately held for a manual decision. */
  | { readonly by: 'manual' }
  /** Nothing is queued. */
  | { readonly by: 'none' };

/**
 * A forecast (§11.4). Encodes the rule that a forecast is never a single point: it is a
 * P50/P80 pair with confidence and provenance, or it is explicitly still calibrating with
 * the number of comparable completions it is short by. A one-number ETA cannot be
 * expressed through this type.
 */
export type Forecast =
  | {
      readonly state: 'ready';
      readonly p50Seconds: Seconds;
      readonly p80Seconds: Seconds;
      readonly confidence: Confidence;
      /** What the estimate rests on, e.g. "42 prior patch cycles". */
      readonly basis: string;
      /** The dominant source of spread between P50 and P80. */
      readonly largestUncertainty: string;
      /** Recent estimator accuracy in 0–1, so the operator can distrust a poor estimator. */
      readonly estimatorAccuracy: Confidence;
    }
  | { readonly state: 'calibrating'; readonly comparableCompletionsRequired: number };

/**
 * The state of a single link in a connection or execution chain (§16.6, §17.5). Each
 * stage carries its own; the aggregate is *derived* by the producer and never asserted
 * as a lone boolean. `wrong` is distinct from `down`: the CDP endpoint can be up while
 * the selected tab is the wrong one — a failure the collapsed "connected" state hides.
 */
export type LinkState = 'unknown' | 'connecting' | 'up' | 'wrong' | 'down';

/* ------------------------------------------------------------------------- */
/* Persistent shell (§4.3)                                                    */
/* ------------------------------------------------------------------------- */

export type ConsoleTab = 'dashboard' | 'configuration';

export interface MissionIdentity {
  readonly missionId: string;
  readonly title: string;
  /** The constitution hash the mission version is bound to (§11.1 of the strategy). */
  readonly constitutionHash: Sha256;
  /** Whether the latest mission change was constitutional, architectural, or neither. */
  readonly lastChange: MissionChangeKind;
}

/**
 * The State Integrity Seal (§4.3). A hash over the projected snapshot plus a self-check,
 * so the console can show that what it is displaying is internally consistent and where
 * every part of it came from — the visual counterpart to the ledger's hash chain.
 */
export interface StateSeal {
  /**
   * A digest of this presentation body — the change-detection value, not an integrity seal.
   *
   * ADR-0002 step 5 made the distinction explicit. The publisher compares it to decide
   * whether a new revision is worth sending, so it must move whenever anything visible moves,
   * including changes (readiness, active tab) that leave the underlying Status untouched.
   */
  readonly snapshotHash: Sha256;
  /**
   * The sealed Status body this presentation reflects (ADR-0002 step 5).
   *
   * Directory §19.3 places this module downstream of sealed Status. This field is what
   * "downstream" means concretely: a rendered console can be resolved to the exact Status
   * body it was built from, and two presentations of one Status are provably presentations
   * of one Status.
   */
  readonly statusHash: Sha256;
  readonly capturedAt: IsoTimestamp;
  /**
   * Whether the underlying Status body is internally consistent.
   *
   * Read from the Status seal, never formed here. §20 gate 3 permits one State Seal, and the
   * failure it guards is two authorities reaching two verdicts about one workspace; this
   * projection reports Status's finding rather than forming its own.
   */
  readonly consistent: boolean;
  /** Source identities the snapshot was assembled from (event-log offset, db version, …). */
  readonly sources: readonly string[];
  /**
   * Provenance of the recognition state (deep review, Integrity Patch 0, P0.3): which
   * committed graph — and, when durably recorded, which run — the sealed body reflects.
   * Deliberately beside `snapshotHash`, not inside it, like `sources`: the sealed body is
   * run-agnostic on purpose, so the identical committed graph projects identically
   * whichever run produced it (daemon revision stability, replay parity). Null while no
   * run is named for the current snapshot.
   */
  readonly graph: RecognitionIdentity | null;
}

/** Elements that never disappear across either tab (§4.3). */
export interface ShellState {
  readonly identity: MissionIdentity;
  readonly activeTab: ConsoleTab;
  readonly operator: string;
  /** A single system-wide health roll-up shown in the mission rail. Derived, not asserted. */
  readonly systemHealth: HealthLevel;
  /** The emergency fault indicator: present only when a fault demands attention. */
  readonly emergencyFault: string | null;
  /** Configuration receives a restrained orange pulse when a fault needs setup (§4.1). */
  readonly configurationNeedsAttention: boolean;
  // The State Integrity Seal is intentionally NOT here. There is exactly one seal per
  // snapshot, on ConsoleSnapshot.seal — a second copy on the shell could be populated
  // independently and disagree, which defeats the seal's purpose (§4.3).
}

/* ------------------------------------------------------------------------- */
/* Start / Stop authority (§6)                                                */
/* ------------------------------------------------------------------------- */

/** Configuration section identifiers, used both to order the tab and to focus it (§14, §23). */
export type ConfigSection =
  | 'project_repository'
  | 'chrome_console'
  | 'powershell'
  | 'ide_cooperation'
  | 'ai_providers'
  | 'testing_benchmarks'
  | 'storage_ledger'
  | 'safety_authority'
  | 'validation';

export const CONFIG_SECTIONS = [
  'project_repository',
  'chrome_console',
  'powershell',
  'ide_cooperation',
  'ai_providers',
  'testing_benchmarks',
  'storage_ledger',
  'safety_authority',
  'validation',
] as const satisfies readonly ConfigSection[];

/** A declared degraded start (§6.3): CLUE ran, but a non-essential integration was absent. */
export interface DegradedMode {
  readonly reason: string;
  readonly unavailable: readonly string[];
}

/**
 * The primary control's state machine (§6.1). A discriminated union so that each phase
 * carries exactly the evidence its label promises: `blocked` must name the prerequisite
 * and the section that fixes it; `error` must state whether a clean stop was actually
 * confirmed, because §6.1 forbids implying a clean stop that was not verified.
 */
export type StartStopState =
  | { readonly phase: 'stopped'; readonly readiness: ReadinessSummary }
  | { readonly phase: 'starting'; readonly checksStreaming: readonly string[] }
  | { readonly phase: 'running'; readonly since: IsoTimestamp; readonly degraded: DegradedMode | null }
  | {
      readonly phase: 'graceful_stopping';
      readonly checkpointEta: NextTiming;
      readonly activeSessionId: string | null;
    }
  | { readonly phase: 'blocked'; readonly prerequisite: string; readonly focus: ConfigSection }
  | { readonly phase: 'error'; readonly faultReason: string; readonly cleanStopConfirmed: boolean };

/* ------------------------------------------------------------------------- */
/* Dashboard — command crown (§7)                                             */
/* ------------------------------------------------------------------------- */

export interface CallBudget {
  readonly today: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly successfulRatio: Percent;
  readonly remaining: number;
  readonly limit: number;
  readonly burnRatePerHour: number;
}

export interface SessionCounts {
  readonly active: number;
  readonly limit: number;
  readonly queued: number;
  readonly checkpointing: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  /** Orphaned or recovery-required sessions (§9.1). Non-zero is a standing concern. */
  readonly recoveryRequired: number;
}

/** A single integration's summary for the crown. Selecting it focuses its config section (§7). */
export interface IntegrationSummary {
  readonly section: ConfigSection;
  readonly label: string;
  readonly health: HealthLevel;
}

export interface CommandCrown {
  readonly campaign: string;
  readonly cycle: number;
  readonly snapshot: Sha256;
  readonly uptime: Seconds;
  readonly sessions: SessionCounts;
  readonly calls: CallBudget;
  readonly integrations: readonly IntegrationSummary[];
}

/* ------------------------------------------------------------------------- */
/* Dashboard — mission-context lens (§8)                                      */
/* ------------------------------------------------------------------------- */

export interface NowFrame {
  readonly sessionId: string;
  readonly role: string;
  readonly target: string;
  readonly task: string;
  readonly activeCallId: string | null;
  readonly elapsed: Seconds;
  /** Context-window utilisation as a percentage, so a handoff can be anticipated (§8.1). */
  readonly contextUsage: Percent;
  readonly checkpointState: string;
  readonly focus: string;
}

export interface NextFrame {
  readonly summary: string;
  readonly timing: NextTiming;
  readonly reason: string;
  /** Whether it may start without a human (§8.1). */
  readonly automatic: boolean;
}

export interface ThenFrame {
  readonly milestone: string;
  /** The next meaningful result — a patch proposal, a benchmark verdict, a synthesis (§8.1). */
  readonly kind: string;
  readonly dependsOnOperator: boolean;
  readonly earliest: NextTiming;
}

export interface MissionContextLens {
  readonly now: NowFrame | null;
  readonly next: NextFrame;
  readonly then: ThenFrame;
}

/* ------------------------------------------------------------------------- */
/* Dashboard — sessions and calls (§9)                                        */
/* ------------------------------------------------------------------------- */

/**
 * A session's lifecycle state. Mirrors the scheduler's {@link TaskState} exactly; the
 * `satisfies` on {@link SESSION_STATES} makes a divergence a compile error rather than a
 * display bug.
 */
export const SESSION_STATES = [
  'pending',
  'blocked',
  'leased',
  'completed',
  'failed',
  'dead',
  'cancelled',
] as const satisfies readonly TaskState[];

export interface SessionRow {
  readonly sessionId: string;
  /** The scheduler lane, reused so the console and the budget policy cannot disagree. */
  readonly lane: TaskLane;
  readonly role: string;
  readonly target: string;
  readonly state: TaskState;
  readonly callsConsumed: number;
  readonly estimatedRemainingCalls: number;
  readonly elapsed: Seconds;
  /** Completion estimate as a forecast, so it obeys the P50/P80 rule like every other. */
  readonly completion: Forecast;
  readonly successor: string | null;
}

export interface CallTelemetry {
  readonly today: number;
  readonly thisCycle: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly successful: number;
  readonly failed: number;
  readonly retries: number;
  readonly discarded: number;
  /** Calls avoided through cached knowledge (§9.2) — evidence the cache is earning its keep. */
  readonly avoidedByCache: number;
  readonly remaining: number;
  readonly burnRatePerHour: number;
}

export interface SessionsPanel {
  readonly counts: SessionCounts;
  readonly active: readonly SessionRow[];
  readonly calls: CallTelemetry;
}

/* ------------------------------------------------------------------------- */
/* Dashboard — recognition field and findings (§10)                          */
/* ------------------------------------------------------------------------- */

/** The four CLUE classes (CLUE.md §21.4), carried so the topology can colour by class. */
export type ClueClass =
  | 'monofile_monodependency'
  | 'monofile_polydependency'
  | 'polyfile_monodependency'
  | 'polyfile_polydependency';

export interface RecognitionTopology {
  readonly filesRecognized: number;
  readonly modules: number;
  readonly functions: number;
  /** Distribution across the four classes, for the class histogram (§10.1). */
  readonly classDistribution: Readonly<Record<ClueClass, number>>;
  readonly currentTarget: string | null;
  /** Count of dependency edges known to be hidden or runtime-only (§10.1). */
  readonly hiddenEdges: number;
}

/** Evidence state of a finding — the honest ladder from suspicion to proof. */
export type EvidenceState =
  | 'observed'
  | 'hypothesis'
  | 'candidate'
  | 'proof_designed'
  | 'baseline_captured'
  | 'proven'
  | 'refuted';

export interface Finding {
  readonly findingId: string;
  readonly target: string;
  readonly category: string;
  readonly evidence: EvidenceState;
  /** Mitigation ease as a percentage (higher = easier), per the ranking model. */
  readonly mitigationEase: Percent;
  readonly predictedValue: string;
  readonly risk: string;
  readonly nextAction: string;
}

/**
 * Provenance identity of the recognition state, carried on {@link StateSeal.graph} (deep
 * review, Integrity Patch 0, P0.3). Read from durable state, never minted: `runId` is
 * null when the run happened but its identity was not durably recorded (pre-pointer
 * streams, replaced pointers); `graphSha256` is the durable record's result hash — the
 * sha256 of the stored recognition artifact — and null only while a commit is
 * provisional; `recognitionRecordId` stays null until the graph plane grows a record
 * identity distinct from (snapshot id, content hash). One home only: putting a second
 * copy inside the sealed body would either break the run-agnostic body invariant or
 * drift from this one.
 */
export interface RecognitionIdentity {
  readonly runId: string | null;
  readonly snapshotId: string;
  readonly graphSha256: Sha256 | null;
  readonly recognitionRecordId: string | null;
}

export interface RecognitionField {
  readonly topology: RecognitionTopology;
  /** The rotating feed, top priority preserved (§10.2). Reads as testimony, not chat. */
  readonly findings: readonly Finding[];
}

/* ------------------------------------------------------------------------- */
/* Dashboard — progress, velocity, forecasts (§11)                           */
/* ------------------------------------------------------------------------- */

/** The five progress lanes (§11.1). Never collapse them into one figure. */
export type ProgressLane =
  | 'recognition'
  | 'deep_review'
  | 'proven_improvement'
  | 'certification'
  | 'test_maturity';

export const PROGRESS_LANES = [
  'recognition',
  'deep_review',
  'proven_improvement',
  'certification',
  'test_maturity',
] as const satisfies readonly ProgressLane[];

export type ProgressBoard = Readonly<Record<ProgressLane, Percent>>;

export interface VelocityRow {
  readonly label: string;
  /** The magnitude, in the unit the label declares (KB/day, patches/day, …). */
  readonly value: number;
  readonly unit: string;
  readonly trend: Trend;
}

export interface VelocityBoard {
  readonly rows: readonly VelocityRow[];
}

export interface NamedForecast {
  readonly label: string;
  readonly forecast: Forecast;
}

export interface ForecastBoard {
  readonly forecasts: readonly NamedForecast[];
}

/* ------------------------------------------------------------------------- */
/* Dashboard — patch-to-proof pipeline (§12)                                  */
/* ------------------------------------------------------------------------- */

/**
 * The fixed pipeline stages (§12). The operator-deployment boundary is made visible by the
 * `landing_eligibility` stage and its landing-route states: a patch can read as
 * `awaiting_operator`, `auto_landing`, or `outbox`, but nothing in this vocabulary can imply
 * CLUE silently wrote the canonical tree — the route that reached `canonical_landed` is always
 * named, and `post_land_verification` re-proves the result held.
 */
/**
 * The patch-to-proof pipeline stages (§12), as the current Custodian lifecycle. This is the
 * ordered spine every candidate travels; the landing branch (awaiting_operator | auto_landing
 * | outbox) and the post-land outcome (verified | auto_reverted) are expressed by each stage's
 * {@link PipelineStageState}, not by separate stages, so the board shows one path with a
 * branch rather than mutually exclusive rows. Replaces the older mandatory `operator_applies`
 * sequence, which assumed every landing was a manual operator apply — no longer true under the
 * Custodian (CLUE_v3.md amendment A2: autonomous landing via the Custodian, gated).
 *
 *   proof_contract_frozen   the falsifiable contract is sealed before any change is made
 *   baseline_captured       the pre-change measurement the verdict will be compared against
 *   patch_sealed            the candidate patch is sealed to its contract
 *   shadow_applied          applied in the shadow clone — never the canonical tree
 *   patched_experiment      the post-change measurement under the same contract
 *   verdict                 accepted | rejected | inconclusive | invalid
 *   landing_eligibility     the gate decision: is this eligible to land, and by which route
 *   canonical_landed        the change reached the canonical tree (by whichever route)
 *   post_land_verification  re-measured after landing to confirm the accepted result held
 *   ledger                  written to the Great Book, verdict and all
 */
export type PipelineStage =
  | 'proof_contract_frozen'
  | 'baseline_captured'
  | 'patch_sealed'
  | 'shadow_applied'
  | 'patched_experiment'
  | 'verdict'
  | 'landing_eligibility'
  | 'canonical_landed'
  | 'post_land_verification'
  | 'ledger';

export const PIPELINE_STAGES = [
  'proof_contract_frozen',
  'baseline_captured',
  'patch_sealed',
  'shadow_applied',
  'patched_experiment',
  'verdict',
  'landing_eligibility',
  'canonical_landed',
  'post_land_verification',
  'ledger',
] as const satisfies readonly PipelineStage[];

/**
 * A pipeline stage's state (§12 colour states, plus the explicit lifecycle branches).
 * `awaiting_operator`, `auto_landing`, and `outbox` are the three landing routes and are
 * first-class so the operator-deployment boundary is visible rather than implied; `verified`
 * and `auto_reverted` are the two post-land outcomes. A stage is only ever in one state, so a
 * patch that is awaiting the operator cannot simultaneously read as auto-landing.
 */
export type PipelineStageState =
  | 'not_reached'
  | 'active'
  | 'complete'
  | 'accepted'
  | 'rejected'
  | 'inconclusive'
  | 'invalid'
  | 'awaiting_operator'
  | 'auto_landing'
  | 'outbox'
  | 'verified'
  | 'auto_reverted'
  | 'blocked'
  | 'regressed';

export interface PipelineStageView {
  readonly stage: PipelineStage;
  readonly state: PipelineStageState;
  /** Optional one-line detail, e.g. the patch id currently at this stage. */
  readonly detail: string | null;
}

export interface PipelinePanel {
  readonly stages: readonly PipelineStageView[];
}

/* ------------------------------------------------------------------------- */
/* Dashboard — Great Book and equilibrium (§13)                              */
/* ------------------------------------------------------------------------- */

/** The canonical verdicts (CLUE.md). `accepted` cannot exist without the contract that proved it. */
export type Verdict =
  | { readonly kind: 'pending' }
  | { readonly kind: 'accepted'; readonly frozenContractHash: Sha256 }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'inconclusive'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

export type LedgerEntryKind =
  | 'accepted_patch'
  | 'rejected_experiment'
  | 'invalidated_certification'
  | 'recertification_request'
  | 'regression_test_added';

export interface LedgerEntry {
  readonly recordHash: Sha256;
  readonly kind: LedgerEntryKind;
  readonly at: IsoTimestamp;
  readonly summary: string;
  readonly verdict: Verdict;
}

export interface EquilibriumIndicators {
  readonly newFindingRate: number;
  readonly newTestRate: number;
  readonly repeatedFindingRate: number;
  readonly regressionEscapeRate: number;
  readonly cleanCycleCount: number;
  readonly domainsApproachingEquilibrium: readonly string[];
}

export interface LedgerBand {
  readonly recent: readonly LedgerEntry[];
  readonly equilibrium: EquilibriumIndicators;
}

/* ------------------------------------------------------------------------- */
/* Dashboard aggregate                                                        */
/* ------------------------------------------------------------------------- */

export interface DashboardView {
  readonly startStop: StartStopState;
  readonly crown: CommandCrown;
  readonly lens: MissionContextLens;
  readonly sessions: SessionsPanel;
  readonly aiOrchestration?: z.infer<typeof consoleAiOrchestrationSchema> | undefined;
  readonly cycle?: z.infer<typeof consoleCycleSchema> | undefined;
  readonly recognition: RecognitionField;
  readonly progress: ProgressBoard;
  readonly velocity: VelocityBoard;
  readonly forecasts: ForecastBoard;
  readonly pipeline: PipelinePanel;
  /** Quadrant 2 — canonical 10×10 Great Book metric field. */
  readonly improvementField: GreatBookImprovementFieldView;
  /** Quadrant 3 — exactly four governed neon gauge projections. */
  readonly gauges: FourNeonGaugesView;
  readonly ledger: LedgerBand;
  /** Real ordered CLU-E/GPT/benchmark/PowerShell/CDP traffic for Dashboard quadrant 4. */
  readonly operationalConsole: OperationalConsoleProjection;
}

/* ------------------------------------------------------------------------- */
/* Configuration — project and repository (§15)                              */
/* ------------------------------------------------------------------------- */

/** A path's verification ladder (§15.4). Text in a field is not a valid path. */
export type PathState =
  | 'empty'
  | 'entered'
  | 'exists'
  | 'repository_detected'
  | 'snapshot_confirmed'
  | 'index_current';

export interface RepoPath {
  readonly absolute: string | null;
  readonly state: PathState;
  /** The zone this path resolves to, so the safety model and the UI agree on it. */
  readonly zone: PathZone | null;
}

export interface ProjectRepoConfigView {
  /** Exact active project/recognition generation. Null is honest legacy single-project mode. */
  readonly activeProject: ProjectRecognitionIdentity | null;
  readonly scanRoot: RepoPath;
  readonly maintenanceRoot: RepoPath;
  readonly artifactRoot: RepoPath;
  readonly branch: string | null;
  readonly commit: Sha256 | null;
  readonly dirtyFileCount: number;
  readonly lastIndexed: IsoTimestamp | null;
  readonly watcherActive: boolean;
  readonly snapshotAligned: boolean;
  readonly excludedPaths: readonly string[];
  readonly health: HealthLevel;
}

/* ------------------------------------------------------------------------- */
/* Configuration — Chrome connection chain (§16)                             */
/* ------------------------------------------------------------------------- */

/** The Chrome chain stages (§16.1). Each is shown independently; none is collapsed. */
export type ChromeChainStage =
  | 'chrome_process'
  | 'cdp_endpoint'
  | 'target_tab'
  | 'frame'
  | 'execution_context'
  | 'runtime_bridge'
  | 'console_capture'
  | 'injection_authority';

export const CHROME_CHAIN_STAGES = [
  'chrome_process',
  'cdp_endpoint',
  'target_tab',
  'frame',
  'execution_context',
  'runtime_bridge',
  'console_capture',
  'injection_authority',
] as const satisfies readonly ChromeChainStage[];

export interface ChromeChainLink {
  readonly stage: ChromeChainStage;
  readonly state: LinkState;
  readonly detail: string | null;
}

/** Where a console line came from (§16.4), so the preview can attribute honestly. */
export type ConsoleOrigin = 'murugan' | 'chrome' | 'webgpu' | 'clue_injection' | 'probe';

export interface ConsolePreviewLine {
  readonly at: IsoTimestamp;
  readonly origin: ConsoleOrigin;
  readonly level: string;
  readonly message: string;
  readonly executionContext: string | null;
}

/** An injection audit record (§16.5). Who asked, what the policy decided, what it touched. */
export interface InjectionAudit {
  readonly requestedBy: Actor;
  readonly capability: Capability;
  /** null when the policy allowed it; a denial code otherwise. */
  readonly denied: DenialCode | null;
  readonly target: string;
  readonly commandOrProbe: string;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp | null;
  readonly mutationsRestored: boolean;
}

export interface ChromeConfigView {
  readonly chain: readonly ChromeChainLink[];
  readonly consolePreview: readonly ConsolePreviewLine[];
  readonly recentInjections: readonly InjectionAudit[];
  /** The single derived roll-up shown on the Dashboard crown. Never asserted alone. */
  readonly health: HealthLevel;
}

/* ------------------------------------------------------------------------- */
/* Configuration — PowerShell (§17)                                          */
/* ------------------------------------------------------------------------- */

/** No-false-execution ladder (§17.5). Started ≠ completed ≠ succeeded ≠ behaviour proven. */
export type ExecutionState =
  | 'idle'
  | 'wrong_directory'
  | 'started'
  | 'completed'
  | 'succeeded'
  | 'behaviour_proven';

/** Who a command acts as (§17.4). AI never gets an unrestricted shell. */
export type CommandOrigin =
  | { readonly by: 'operator' }
  | { readonly by: 'clue_gateway' }
  | { readonly by: 'ai'; readonly approved: true }
  | { readonly by: 'ai'; readonly approved: false; readonly denied: DenialCode };

export interface PowerShellCommandView {
  readonly label: string;
  /** The exact command, kept visible and auditable (§17.2). Secrets pre-redacted. */
  readonly command: string;
  readonly origin: CommandOrigin;
  readonly state: ExecutionState;
  readonly exitCode: number | null;
  readonly elapsed: Seconds | null;
}

export interface PowerShellConfigView {
  readonly processId: number | null;
  readonly version: string | null;
  readonly workingDirectory: string | null;
  readonly workingDirectoryZone: PathZone | null;
  readonly recentCommands: readonly PowerShellCommandView[];
  readonly health: HealthLevel;
}

/* ------------------------------------------------------------------------- */
/* Configuration — IDE, AI, testing (§18-20)                                 */
/* ------------------------------------------------------------------------- */

export interface IdeConfigView {
  readonly ideType: string | null;
  readonly workspace: string | null;
  readonly patchHandoffEnabled: boolean;
  /** Not "connected" unless the exact handoff works and a receipt returns (§18.3). */
  readonly handoffVerified: boolean;
  readonly health: HealthLevel;
}

/** Provider readiness ladder (§19.4). Configured ≠ reachable ≠ a test call passed. */
export type ProviderReadiness =
  | 'configured'
  | 'credential_available'
  | 'endpoint_reachable'
  | 'model_available'
  | 'test_call_passed'
  | 'role_policy_valid';

export interface AiProviderView {
  readonly name: string;
  readonly model: string;
  readonly readiness: ProviderReadiness;
  /** Roles this model is permitted to perform (§19.3). */
  readonly roles: readonly string[];
  readonly health: HealthLevel;
}

export interface SessionPolicyView {
  readonly maxParallelSessions: number;
  readonly maxCallsPerSession: number;
  readonly dailyCallCap: number;
  readonly cycleCallCap: number;
  readonly contextUtilisationThreshold: Percent;
  readonly automaticNextSession: boolean;
  readonly pauseAfterCheckpoint: boolean;
}

export interface AiConfigView {
  readonly providers: readonly AiProviderView[];
  readonly sessionPolicy: SessionPolicyView;
  readonly health: HealthLevel;
}

export interface TestingConfigView {
  readonly browserProfileControlled: boolean;
  readonly warmups: number;
  readonly iterations: number;
  /** The doctrine made visible: a preregistered benchmark is required (§20). */
  readonly preregisteredBenchmarkRequired: boolean;
  readonly health: HealthLevel;
}

/* ------------------------------------------------------------------------- */
/* Configuration — storage and safety (§21)                                  */
/* ------------------------------------------------------------------------- */

export interface StorageConfigView {
  readonly databaseLocation: string | null;
  readonly artifactRoot: string | null;
  readonly ledgerLocation: string | null;
  /**
   * Ledger hash-chain integrity. A positive claim here requires an actual verification
   * fact from the durable plane; until the ledger check is wired into the console's
   * reader seam this is null — “not verified” declared, never `true` asserted (deep
   * review §5.9: the chain was shown valid without ledger evidence).
   */
  readonly hashChainValid: boolean | null;
  readonly freeDiskBytes: number | null;
  readonly health: HealthLevel;
}

/**
 * The authority boundaries (§21.3). `canonicalWriteProtected` is a `true` literal for the
 * same reason the proof config pins its invariants to literals: a console that could
 * render "CLUE may write the canonical repository" as an ordinary boolean is a console
 * that could one day render it as `true` by accident. The landing mode is the config's
 * own {@link PatchingMode}, so the display and the policy in force cannot disagree.
 */
export interface SafetyConfigView {
  readonly canonicalWriteProtected: true;
  readonly maintenanceRootWritable: boolean;
  readonly landingMode: PatchingMode;
  readonly shellPolicy: string;
  readonly chromeInjectionPolicy: string;
  readonly health: HealthLevel;
}

/* ------------------------------------------------------------------------- */
/* Configuration — readiness (§22.3)                                          */
/* ------------------------------------------------------------------------- */

export interface SectionReadiness {
  readonly section: ConfigSection;
  readonly ready: boolean;
}

/**
 * The readiness roll-up (§22.3), a discriminated union so contradictory states cannot be
 * constructed: `ready` carries no blocker and every section it lists is ready; `blocked`
 * must name the first blocking section. There is deliberately no `overallReady: boolean`
 * beside a nullable blocker — that shape allowed "ready" with a false section to compile,
 * which §22.3 forbids. Consumers read `readiness.status === 'ready'`.
 */
export type ReadinessSummary =
  | { readonly status: 'ready'; readonly sections: readonly SectionReadiness[] }
  | {
      readonly status: 'blocked';
      readonly sections: readonly SectionReadiness[];
      readonly firstBlocking: ConfigSection;
    };

/* ------------------------------------------------------------------------- */
/* Configuration aggregate                                                    */
/* ------------------------------------------------------------------------- */

export interface ConfigurationView {
  readonly project: ProjectRepoConfigView;
  readonly chrome: ChromeConfigView;
  readonly powershell: PowerShellConfigView;
  readonly ide: IdeConfigView;
  readonly ai: AiConfigView;
  readonly testing: TestingConfigView;
  readonly storage: StorageConfigView;
  readonly safety: SafetyConfigView;
  readonly readiness: ReadinessSummary;
}

/* ------------------------------------------------------------------------- */
/* Top-level snapshot                                                         */
/* ------------------------------------------------------------------------- */

/**
 * The single object the daemon projects and the console renders. One value carries the
 * whole visible state at one instant; the seal binds it, the shell holds what persists
 * across tabs, and the two views hold what each tab shows. A runtime validator for this
 * shape belongs with the endpoint that produces it — this file defines the contract; the
 * projection layer is where it is checked on the wire, the way the kernel validates every
 * other record that crosses a boundary.
 */
export interface ConsoleSnapshot {
  readonly seal: StateSeal;
  readonly shell: ShellState;
  readonly dashboard: DashboardView;
  readonly configuration: ConfigurationView;
}

/* ------------------------------------------------------------------------- */
/* Runtime validator (§4.3 wire check)                                        */
/* ------------------------------------------------------------------------- */

/**
 * A zod schema for the complete {@link ConsoleSnapshot}, so the projection layer can reject
 * a malformed or partial snapshot on the wire the way the kernel validates every other
 * record that crosses a boundary. The critique's requirement — validate the *complete*
 * snapshot at runtime — is met here rather than deferred to the endpoint.
 *
 * The one hazard of a hand-written validator is that it becomes a second source of truth
 * that drifts from the interfaces. That is closed structurally: {@link assertConsoleSnapshotSchema}
 * below asserts, at compile time, that the schema's inferred type is *identical* to
 * {@link ConsoleSnapshot} in both directions. If a field is added, removed, or retyped on
 * either the interface or the schema, the typecheck fails. The types remain authoritative;
 * the schema is proven to mirror them.
 *
 * Brands (`Sha256` and the kernel string types) are validated structurally as strings and
 * re-cast, since a brand is a compile-time-only distinction with no runtime representation.
 */

const sha256 = z.string() as unknown as z.ZodType<Sha256>;
const branded = <T>() => z.string() as unknown as z.ZodType<T>;

const nextTimingSchema = z.union([
  z.object({ by: z.literal('eta'), etaSeconds: z.number(), basis: z.string() }).strict(),
  z.object({ by: z.literal('after_checkpoint'), sessionId: z.string() }).strict(),
  z.object({ by: z.literal('after_operator'), awaiting: z.string() }).strict(),
  z.object({ by: z.literal('manual') }).strict(),
  z.object({ by: z.literal('none') }).strict(),
]);

const forecastSchema = z.union([
  z
    .object({
      state: z.literal('ready'),
      p50Seconds: z.number(),
      p80Seconds: z.number(),
      confidence: z.number(),
      basis: z.string(),
      largestUncertainty: z.string(),
      estimatorAccuracy: z.number(),
    })
    .strict(),
  z.object({ state: z.literal('calibrating'), comparableCompletionsRequired: z.number() }).strict(),
]);

const healthLevelSchema = z.enum(['ok', 'degraded', 'fault', 'unknown']);
const linkStateSchema = z.enum(['unknown', 'connecting', 'up', 'wrong', 'down']);
const configSectionSchema = z.enum(CONFIG_SECTIONS);

const recognitionIdentitySchema = z
  .object({
    runId: z.string().nullable(),
    snapshotId: z.string(),
    graphSha256: sha256.nullable(),
    recognitionRecordId: z.string().nullable(),
  })
  .strict();

const stateSealSchema = z
  .object({
    snapshotHash: sha256,
    statusHash: sha256,
    capturedAt: z.string(),
    consistent: z.boolean(),
    sources: z.array(z.string()),
    graph: recognitionIdentitySchema.nullable(),
  })
  .strict();

const missionIdentitySchema = z
  .object({
    missionId: z.string(),
    title: z.string(),
    constitutionHash: sha256,
    lastChange: branded<MissionChangeKind>(),
  })
  .strict();

const shellStateSchema = z
  .object({
    identity: missionIdentitySchema,
    activeTab: z.enum(['dashboard', 'configuration']),
    operator: z.string(),
    systemHealth: healthLevelSchema,
    emergencyFault: z.string().nullable(),
    configurationNeedsAttention: z.boolean(),
  })
  .strict();

const degradedModeSchema = z
  .object({ reason: z.string(), unavailable: z.array(z.string()) })
  .strict();

const sectionReadinessSchema = z
  .object({ section: configSectionSchema, ready: z.boolean() })
  .strict();

const readinessSummarySchema = z.union([
  z.object({ status: z.literal('ready'), sections: z.array(sectionReadinessSchema) }).strict(),
  z
    .object({
      status: z.literal('blocked'),
      sections: z.array(sectionReadinessSchema),
      firstBlocking: configSectionSchema,
    })
    .strict(),
]);

const startStopStateSchema = z.union([
  z.object({ phase: z.literal('stopped'), readiness: readinessSummarySchema }).strict(),
  z.object({ phase: z.literal('starting'), checksStreaming: z.array(z.string()) }).strict(),
  z
    .object({ phase: z.literal('running'), since: z.string(), degraded: degradedModeSchema.nullable() })
    .strict(),
  z
    .object({
      phase: z.literal('graceful_stopping'),
      checkpointEta: nextTimingSchema,
      activeSessionId: z.string().nullable(),
    })
    .strict(),
  z.object({ phase: z.literal('blocked'), prerequisite: z.string(), focus: configSectionSchema }).strict(),
  z.object({ phase: z.literal('error'), faultReason: z.string(), cleanStopConfirmed: z.boolean() }).strict(),
]);

const callBudgetSchema = z
  .object({
    today: z.number(),
    inFlight: z.number(),
    queued: z.number(),
    successfulRatio: z.number(),
    remaining: z.number(),
    limit: z.number(),
    burnRatePerHour: z.number(),
  })
  .strict();

const sessionCountsSchema = z
  .object({
    active: z.number(),
    limit: z.number(),
    queued: z.number(),
    checkpointing: z.number(),
    completed: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    recoveryRequired: z.number(),
  })
  .strict();

const integrationSummarySchema = z
  .object({ section: configSectionSchema, label: z.string(), health: healthLevelSchema })
  .strict();

const commandCrownSchema = z
  .object({
    campaign: z.string(),
    cycle: z.number(),
    snapshot: sha256,
    uptime: z.number(),
    sessions: sessionCountsSchema,
    calls: callBudgetSchema,
    integrations: z.array(integrationSummarySchema),
  })
  .strict();

const nowFrameSchema = z
  .object({
    sessionId: z.string(),
    role: z.string(),
    target: z.string(),
    task: z.string(),
    activeCallId: z.string().nullable(),
    elapsed: z.number(),
    contextUsage: z.number(),
    checkpointState: z.string(),
    focus: z.string(),
  })
  .strict();

const nextFrameSchema = z
  .object({ summary: z.string(), timing: nextTimingSchema, reason: z.string(), automatic: z.boolean() })
  .strict();

const thenFrameSchema = z
  .object({
    milestone: z.string(),
    kind: z.string(),
    dependsOnOperator: z.boolean(),
    earliest: nextTimingSchema,
  })
  .strict();

const missionContextLensSchema = z
  .object({ now: nowFrameSchema.nullable(), next: nextFrameSchema, then: thenFrameSchema })
  .strict();

const sessionRowSchema = z
  .object({
    sessionId: z.string(),
    lane: branded<TaskLane>(),
    role: z.string(),
    target: z.string(),
    state: branded<TaskState>(),
    callsConsumed: z.number(),
    estimatedRemainingCalls: z.number(),
    elapsed: z.number(),
    completion: forecastSchema,
    successor: z.string().nullable(),
  })
  .strict();

const callTelemetrySchema = z
  .object({
    today: z.number(),
    thisCycle: z.number(),
    inFlight: z.number(),
    queued: z.number(),
    successful: z.number(),
    failed: z.number(),
    retries: z.number(),
    discarded: z.number(),
    avoidedByCache: z.number(),
    remaining: z.number(),
    burnRatePerHour: z.number(),
  })
  .strict();

const sessionsPanelSchema = z
  .object({
    counts: sessionCountsSchema,
    active: z.array(sessionRowSchema),
    calls: callTelemetrySchema,
  })
  .strict();

const recognitionTopologySchema = z
  .object({
    filesRecognized: z.number(),
    modules: z.number(),
    functions: z.number(),
    classDistribution: z.object({
      monofile_monodependency: z.number(),
      monofile_polydependency: z.number(),
      polyfile_monodependency: z.number(),
      polyfile_polydependency: z.number(),
    }).strict(),
    currentTarget: z.string().nullable(),
    hiddenEdges: z.number(),
  })
  .strict();

const findingSchema = z
  .object({
    findingId: z.string(),
    target: z.string(),
    category: z.string(),
    evidence: z.enum(['observed', 'hypothesis', 'candidate', 'proof_designed', 'baseline_captured', 'proven', 'refuted']),
    mitigationEase: z.number(),
    predictedValue: z.string(),
    risk: z.string(),
    nextAction: z.string(),
  })
  .strict();

const recognitionFieldSchema = z
  .object({ topology: recognitionTopologySchema, findings: z.array(findingSchema) })
  .strict();

const progressBoardSchema = z.object(
  Object.fromEntries(PROGRESS_LANES.map((lane) => [lane, z.number()])) as Record<ProgressLane, z.ZodNumber>,
).strict();

const velocityRowSchema = z
  .object({ label: z.string(), value: z.number(), unit: z.string(), trend: z.enum(TREND_STATES) })
  .strict();

const velocityBoardSchema = z.object({ rows: z.array(velocityRowSchema) }).strict();

const namedForecastSchema = z.object({ label: z.string(), forecast: forecastSchema }).strict();

const forecastBoardSchema = z.object({ forecasts: z.array(namedForecastSchema) }).strict();

const pipelineStageViewSchema = z
  .object({
    stage: z.enum(PIPELINE_STAGES),
    state: z.enum([
      'not_reached',
      'active',
      'complete',
      'accepted',
      'rejected',
      'inconclusive',
      'invalid',
      'awaiting_operator',
      'auto_landing',
      'outbox',
      'verified',
      'auto_reverted',
      'blocked',
      'regressed',
    ]),
    detail: z.string().nullable(),
  })
  .strict();

const pipelinePanelSchema = z.object({ stages: z.array(pipelineStageViewSchema) }).strict();

const verdictSchema = z.union([
  z.object({ kind: z.literal('pending') }).strict(),
  z.object({ kind: z.literal('accepted'), frozenContractHash: sha256 }).strict(),
  z.object({ kind: z.literal('rejected'), reason: z.string() }).strict(),
  z.object({ kind: z.literal('inconclusive'), reason: z.string() }).strict(),
  z.object({ kind: z.literal('invalid'), reason: z.string() }).strict(),
]);

const ledgerEntrySchema = z
  .object({
    recordHash: sha256,
    kind: z.enum([
      'accepted_patch',
      'rejected_experiment',
      'invalidated_certification',
      'recertification_request',
      'regression_test_added',
    ]),
    at: z.string(),
    summary: z.string(),
    verdict: verdictSchema,
  })
  .strict();

const equilibriumIndicatorsSchema = z
  .object({
    newFindingRate: z.number(),
    newTestRate: z.number(),
    repeatedFindingRate: z.number(),
    regressionEscapeRate: z.number(),
    cleanCycleCount: z.number(),
    domainsApproachingEquilibrium: z.array(z.string()),
  })
  .strict();

const ledgerBandSchema = z
  .object({ recent: z.array(ledgerEntrySchema), equilibrium: equilibriumIndicatorsSchema })
  .strict();

const dashboardViewSchema = z
  .object({
    startStop: startStopStateSchema,
    crown: commandCrownSchema,
    lens: missionContextLensSchema,
    sessions: sessionsPanelSchema,
    aiOrchestration: consoleAiOrchestrationSchema.optional(),
    cycle: consoleCycleSchema.optional(),
    recognition: recognitionFieldSchema,
    progress: progressBoardSchema,
    velocity: velocityBoardSchema,
    forecasts: forecastBoardSchema,
    pipeline: pipelinePanelSchema,
    improvementField: greatBookImprovementFieldSchema,
    gauges: fourNeonGaugesSchema,
    ledger: ledgerBandSchema,
    operationalConsole: operationalConsoleProjectionSchema,
  })
  .strict();

const repoPathSchema = z
  .object({
    absolute: z.string().nullable(),
    state: z.enum(['empty', 'entered', 'exists', 'repository_detected', 'snapshot_confirmed', 'index_current']),
    zone: branded<PathZone>().nullable(),
  })
  .strict();

const projectRepoConfigViewSchema = z
  .object({
    activeProject: projectRecognitionIdentitySchema.nullable(),
    scanRoot: repoPathSchema,
    maintenanceRoot: repoPathSchema,
    artifactRoot: repoPathSchema,
    branch: z.string().nullable(),
    commit: sha256.nullable(),
    dirtyFileCount: z.number(),
    lastIndexed: z.string().nullable(),
    watcherActive: z.boolean(),
    snapshotAligned: z.boolean(),
    excludedPaths: z.array(z.string()),
    health: healthLevelSchema,
  })
  .strict();

const chromeChainLinkSchema = z
  .object({ stage: z.enum(CHROME_CHAIN_STAGES), state: linkStateSchema, detail: z.string().nullable() })
  .strict();

const consolePreviewLineSchema = z
  .object({
    at: z.string(),
    origin: z.enum(['murugan', 'chrome', 'webgpu', 'clue_injection', 'probe']),
    level: z.string(),
    message: z.string(),
    executionContext: z.string().nullable(),
  })
  .strict();

const injectionAuditSchema = z
  .object({
    requestedBy: branded<Actor>(),
    capability: branded<Capability>(),
    denied: branded<DenialCode>().nullable(),
    target: z.string(),
    commandOrProbe: z.string(),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    mutationsRestored: z.boolean(),
  })
  .strict();

const chromeConfigViewSchema = z
  .object({
    chain: z.array(chromeChainLinkSchema),
    consolePreview: z.array(consolePreviewLineSchema),
    recentInjections: z.array(injectionAuditSchema),
    health: healthLevelSchema,
  })
  .strict();

const commandOriginSchema = z.union([
  z.object({ by: z.literal('operator') }).strict(),
  z.object({ by: z.literal('clue_gateway') }).strict(),
  z.object({ by: z.literal('ai'), approved: z.literal(true) }).strict(),
  z.object({ by: z.literal('ai'), approved: z.literal(false), denied: branded<DenialCode>() }).strict(),
]);

const powerShellCommandViewSchema = z
  .object({
    label: z.string(),
    command: z.string(),
    origin: commandOriginSchema,
    state: z.enum(['idle', 'wrong_directory', 'started', 'completed', 'succeeded', 'behaviour_proven']),
    exitCode: z.number().nullable(),
    elapsed: z.number().nullable(),
  })
  .strict();

const powerShellConfigViewSchema = z
  .object({
    processId: z.number().nullable(),
    version: z.string().nullable(),
    workingDirectory: z.string().nullable(),
    workingDirectoryZone: branded<PathZone>().nullable(),
    recentCommands: z.array(powerShellCommandViewSchema),
    health: healthLevelSchema,
  })
  .strict();

const ideConfigViewSchema = z
  .object({
    ideType: z.string().nullable(),
    workspace: z.string().nullable(),
    patchHandoffEnabled: z.boolean(),
    handoffVerified: z.boolean(),
    health: healthLevelSchema,
  })
  .strict();

const aiProviderViewSchema = z
  .object({
    name: z.string(),
    model: z.string(),
    readiness: z.enum([
      'configured',
      'credential_available',
      'endpoint_reachable',
      'model_available',
      'test_call_passed',
      'role_policy_valid',
    ]),
    roles: z.array(z.string()),
    health: healthLevelSchema,
  })
  .strict();

const sessionPolicyViewSchema = z
  .object({
    maxParallelSessions: z.number(),
    maxCallsPerSession: z.number(),
    dailyCallCap: z.number(),
    cycleCallCap: z.number(),
    contextUtilisationThreshold: z.number(),
    automaticNextSession: z.boolean(),
    pauseAfterCheckpoint: z.boolean(),
  })
  .strict();

const aiConfigViewSchema = z
  .object({
    providers: z.array(aiProviderViewSchema),
    sessionPolicy: sessionPolicyViewSchema,
    health: healthLevelSchema,
  })
  .strict();

const testingConfigViewSchema = z
  .object({
    browserProfileControlled: z.boolean(),
    warmups: z.number(),
    iterations: z.number(),
    preregisteredBenchmarkRequired: z.boolean(),
    health: healthLevelSchema,
  })
  .strict();

const storageConfigViewSchema = z
  .object({
    databaseLocation: z.string().nullable(),
    artifactRoot: z.string().nullable(),
    ledgerLocation: z.string().nullable(),
    hashChainValid: z.boolean().nullable(),
    freeDiskBytes: z.number().nullable(),
    health: healthLevelSchema,
  })
  .strict();

const safetyConfigViewSchema = z
  .object({
    canonicalWriteProtected: z.literal(true),
    maintenanceRootWritable: z.boolean(),
    landingMode: branded<PatchingMode>(),
    shellPolicy: z.string(),
    chromeInjectionPolicy: z.string(),
    health: healthLevelSchema,
  })
  .strict();

const configurationViewSchema = z
  .object({
    project: projectRepoConfigViewSchema,
    chrome: chromeConfigViewSchema,
    powershell: powerShellConfigViewSchema,
    ide: ideConfigViewSchema,
    ai: aiConfigViewSchema,
    testing: testingConfigViewSchema,
    storage: storageConfigViewSchema,
    safety: safetyConfigViewSchema,
    readiness: readinessSummarySchema,
  })
  .strict();

/**
 * The complete snapshot validator. `.strict()` throughout means an unexpected field is a
 * rejection, not silently dropped — the console must not render state the contract did not
 * describe.
 */
export const consoleSnapshotSchema = z
  .object({
    seal: stateSealSchema,
    shell: shellStateSchema,
    dashboard: dashboardViewSchema,
    configuration: configurationViewSchema,
  })
  .strict();

/**
 * Compile-time proof that the validator mirrors the contract. zod infers mutable properties
 * and mutable arrays, while the contract is deeply `readonly`; that modifier difference is
 * not a drift in the data shape. The lock strips `readonly` from both types and asserts they
 * are mutually assignable, so a field added, removed, or retyped on either the schema or
 * {@link ConsoleSnapshot} breaks the typecheck — the guard against the schema becoming a
 * second source of truth. `parseConsoleSnapshot` re-applies the `readonly` contract on exit.
 */
type DeepMutable<T> = T extends readonly (infer E)[]
  ? DeepMutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
type SchemaShape = DeepMutable<z.infer<typeof consoleSnapshotSchema>>;
type ContractShape = DeepMutable<ConsoleSnapshot>;
const schemaCoversContract: ContractShape extends SchemaShape ? true : false = true;
const contractCoversSchema: SchemaShape extends ContractShape ? true : false = true;
void schemaCoversContract;
void contractCoversSchema;

/** Parses and validates an unknown value as a {@link ConsoleSnapshot}, throwing on any mismatch. */
export function parseConsoleSnapshot(input: unknown): ConsoleSnapshot {
  return consoleSnapshotSchema.parse(input) as unknown as ConsoleSnapshot;
}
