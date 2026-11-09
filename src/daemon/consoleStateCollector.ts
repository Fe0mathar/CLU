/**
 * Console state collector.
 *
 * Spec: CLUE_Recommended_Next_Milestone_v4.md §3 (Workstream B — replace placeholder
 *       projector inputs with one authoritative daemon-side state collector). Doctrine:
 *       CLUE_v4 — the interface is authoritative only when one collector maps durable CLUE
 *       state into the snapshot; no renderer reads registries directly.
 *
 * This is the single place durable CLUE state is gathered and shaped into the pure
 * projector's input. It sits on the daemon side, between the registries and
 * {@link projectConsoleSnapshot}. Three properties define it, mirroring the discipline the
 * projector already holds.
 *
 *   **It depends on a narrow reader seam, not on the database.** The collector reads through
 *   {@link RegistrySource} — a small interface exposing exactly the durable facts it needs.
 *   The daemon supplies a live implementation backed by the real MissionRegistry,
 *   SnapshotRegistry, and GraphRegistry; a test supplies a deterministic fake. So the mapping
 *   logic is verifiable without a database, a clock, or a filesystem, and the DB-ABI
 *   constraint of the delivery environment does not block proving it.
 *
 *   **It gathers, it does not assemble.** It produces a {@link ProjectorInput}; the projector
 *   remains the pure assembler that seals and validates the snapshot. The collector never
 *   builds a ConsoleSnapshot itself and never mutates anything it reads.
 *
 *   **It is deterministic given the same durable state and the same captured-at.** Every
 *   value is a pure function of what the reader returns plus the caller-supplied timestamp,
 *   so a restart that reads the same durable state and passes the same timestamp yields the
 *   same ProjectorInput — and therefore, through the projector, the same sealed snapshot.
 *   Run identity is carried by the recognition run, not minted here.
 *
 * Workstream B scope note: this v1 collector maps the durable facts that exist today —
 * mission, snapshot, committed recognition record, coverage inputs, and configuration
 * readiness. The registries the milestone will add later (Purpose Catalogue, Measure Session
 * Registry, Experiment Registry, Great Book, integration/host/Chrome health) are read through
 * the same seam as they come online; their absence here is represented by the projector's
 * honest empty/idle shapes, never fabricated.
 */

import type { ProjectorInput } from '../ui/consoleProjector.js';
import type { GreatBookImprovementFieldView } from '../ui/greatBookImprovementField.js';
import type { FourNeonGaugesView } from '../ui/fourNeonGauges.js';
import type { ConsoleTab, ReadinessSummary } from '../ui/viewModel.js';
import type { OperationalConsoleProjection } from '../observability/operationalConsole/contract.js';
import { isBranchUnavailable, type StatusSnapshot } from '../status/statusContractV5.js';
import type { ProjectRecognitionIdentity } from '../shared/projectRecognitionIdentity.js';
import type { ProjectOperationIdentity } from '../shared/projectOperationIdentity.js';

/** The mission version in force, as MissionRegistry.current() records it. */
export interface MissionFacts {
  readonly missionId: string;
  readonly title: string;
  readonly constitutionHash: string;
  readonly lastChange: 'initial' | 'constitutional' | 'architectural' | 'unchanged';
}

/** A source snapshot summary, as SnapshotRegistry records it. */
export interface SnapshotFacts {
  readonly snapshotId: string;
  readonly fileCount: number;
  readonly capturedAt: string;
  /** Per-language file census from the snapshot manifest (`stats.by_language`). */
  readonly languageCensus: Readonly<Record<string, number>>;
}

/** A committed recognition record for a snapshot, as GraphRegistry.recognition() records it. */
export interface RecognitionFacts {
  readonly snapshotId: string;
  readonly resultHash: string;
  readonly unitCount: number;
  readonly edgeCount: number;
  readonly unresolvedCount: number;
  readonly filesInProgram: number;
  readonly filesRecognised: number;
  readonly semanticDiagnostics: number;
  /** Distinct module paths in the committed graph (Quadrant 1 topology). */
  readonly moduleCount: number;
  /** Four-quadrant classification distribution (mono/poly file × dependency). */
  readonly classDistribution: Readonly<Record<
    'monofile-monodependency' | 'monofile-polydependency' | 'polyfile-monodependency' | 'polyfile-polydependency',
    number
  >>;
}

/**
 * The narrow reader seam the collector depends on. Each method returns a plain durable fact
 * or null; none mutates. The daemon implements this over the live registries, a test over
 * fixtures. `runIdForSnapshot` reflects that the run identity lives with the recognition run
 * (the stream / current.json pointer), not in the graph record — the collector reads it,
 * never mints it.
 */
export interface ProofPipelineEventFacts {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface ProofPipelineFacts {
  readonly cycleId: string | null;
  readonly contractFrozen: ProofPipelineEventFacts | null;
  readonly baselineBound: ProofPipelineEventFacts | null;
  readonly executionRefused: ProofPipelineEventFacts | null;
  readonly verdictRecorded: ProofPipelineEventFacts | null;
}

export interface GreatBookFacts {
  readonly entryCount: number;
  readonly contributionCount: number;
  readonly recordingGapCount: number;
  readonly latestEntryId: string | null;
  readonly latestCycleId: string | null;
  readonly latestRecordedAt: string | null;
  readonly normalizationVersion: string;
  readonly normalizationHash: string;
}

/** Active Project Profile and operation-specific readiness facts (Status 5.8.0). */
export interface ProjectProfileFacts {
  readonly profileMode: 'project-profile';
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly assessmentAvailable: boolean;
  readonly overallReadiness: 'READY' | 'READY_LOCAL_ONLY' | 'INCOMPLETE' | 'BLOCKED' | 'INVALID';
  readonly readyForLocalWork: boolean;
  readonly readyForRequestedOperations: boolean;
  readonly capabilities: {
    readonly recognition: ProjectCapabilityFacts;
    readonly proof: ProjectCapabilityFacts;
    readonly browserBenchmark: ProjectCapabilityFacts;
    readonly aiCandidateGeneration: ProjectCapabilityFacts;
    readonly gitPublication: ProjectCapabilityFacts;
    readonly custodianLanding: ProjectCapabilityFacts;
  };
  readonly authorityState: 'CURRENT' | 'INCOMPLETE' | 'DRIFTED' | 'INVALID';
  readonly authorityConflictState: 'CLEAR' | 'AUTHORITY CONFLICT';
  readonly authorityManifestHash: string | null;
  readonly configuredAuthorityHash: string;
  readonly recognitionConfigurationHash: string;
  readonly assessedAt: string;
}

export interface ProjectCapabilityFacts {
  readonly state: 'READY' | 'READY_LOCAL_ONLY' | 'NOT_REQUIRED' | 'INCOMPLETE' | 'BLOCKED' | 'INVALID';
  readonly ready: boolean;
  readonly required: boolean;
  readonly code: string;
}

/** Event-backed Model Gateway summary (DEV-P2-09 / ADR-0013). */
export interface AiOrchestrationFacts {
  readonly configured: true;
  readonly enabled: boolean;
  readonly provider: 'openai';
  readonly projectIdentity: ProjectOperationIdentity | null;
  readonly profileGeneration: number | null;
  readonly credentialReference: string;
  readonly requestedModel: string | null;
  readonly effectiveModel: string | null;
  readonly fallbackUsed: false;
  readonly apiKeyEnv: string;
  readonly apiKeyPresent: boolean;
  readonly operationallyReady: boolean;
  readonly policyProblems: readonly string[];
  readonly budgetHash: string;
  readonly routingHash: string;
  readonly priceScheduleVersion: string;
  readonly enabledRouteCount: number;
  readonly defaultMode: 'interactive' | 'batch';
  readonly model: string | null;
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
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly refused: number;
  readonly pending: number;
  readonly todayActualUsd: number | null;
  readonly monthActualUsd: number | null;
  readonly reservedUsd: number | null;
  readonly dailyHardUsd: number;
  readonly monthlyHardUsd: number;
  readonly degradationAction: 'notify' | 'frontier_to_batch' | 'batch_only' | 'pause_submissions' | null;
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
}

export interface RegistrySource {
  /** The mission version in force, or null before bootstrap. */
  currentMission(): MissionFacts | null;
  /** The latest canonical snapshot, or null if none has been captured. */
  latestSnapshot(): SnapshotFacts | null;
  /** The committed recognition record for a snapshot, or null if the graph is not committed. */
  recognitionFor(snapshotId: string): RecognitionFacts | null;
  /** The run id that produced the committed graph for a snapshot, or null if unknown. */
  runIdForSnapshot(snapshotId: string): string | null;
  /** Exact active Project Profile/recognition generation, or null in legacy mode. */
  projectRecognitionIdentity?(): ProjectRecognitionIdentity | null;
  /** Configuration readiness, as the config registry evaluates it. */
  configReadiness(): ReadinessSummary;
  /** Durable source identities the snapshot is assembled from (log offset, db version, …). */
  stateSources(): readonly string[];
  /**
   * The real Quadrant 4 operational-console projection built from the recorded traffic
   * stream, or absent when this source carries no operational console. Optional because a
   * source without a traffic stream is a valid, honest state the projector renders as an
   * empty console — never invented activity. Implementations must degrade a corrupt or
   * partially-written stream to an empty projection rather than throwing: one quadrant's
   * stream must not be able to take down the whole dashboard snapshot.
   */
  operationalConsoleProjection?(capturedAt: string): OperationalConsoleProjection;
  /** Optional authoritative Great Book Improvement Field projection (Q2), sealed with the snapshot. */
  improvementFieldProjection?(capturedAt: string): GreatBookImprovementFieldView | undefined;
  /** Optional authoritative Four Neon Gauges projection (Q3), sealed with the snapshot. */
  gaugesProjection?(capturedAt: string): FourNeonGaugesView;
  /**
   * The cycle stage machine's facts (ADR-0007, the 5.2.0 revision): the live cycle and the
   * last closure, either of which may be null. Optional because a source without the cycle
   * projection is a valid state — the projector renders `unavailable` naming what would
   * back it, never an invented empty cycle.
   */
  cycleFacts?(): CycleFacts;
  /** Durable proof events for the active/latest proof cycle (ADR-0011). */
  proofPipelineFacts?(): ProofPipelineFacts;
  /** Durable accepted-proof recursive memory (DEV-P2-12). */
  greatBookFacts?(): GreatBookFacts;
  /** Active Project Profile generation and readiness, null in legacy config-v2 mode. */
  projectProfileFacts?(capturedAt: string): ProjectProfileFacts | null;
  /** Governed Model Gateway policy and event-backed call summary (DEV-P2-09). */
  aiOrchestrationFacts?(capturedAt: string): AiOrchestrationFacts;
}

/** What a source reports about the cycle domain; both members independently nullable. */
export interface CycleFacts {
  readonly current: {
    readonly id: string;
    readonly stage: string;
    readonly grade: string | null;
    readonly lockDigest: string | null;
    readonly suspendedFrom: string | null;
    readonly openedAt: string;
    readonly updatedAt: string;
  } | null;
  readonly lastClosure: {
    readonly cycleId: string;
    readonly closedAt: string;
    readonly grade: string;
    readonly criteriaMet: boolean;
    readonly unmetCount: number;
    readonly stageReached: string;
  } | null;
}

/** Options the caller controls per collection (not durable state). */
export interface CollectOptions {
  /** The capture timestamp, supplied by the caller so the result is replay-deterministic. */
  readonly capturedAt: string;
  /** The operator identity for display. */
  readonly operator: string;
  /** Which tab the console is showing. */
  readonly activeTab: ConsoleTab;
  /**
   * The sealed Status body the console projects from (ADR-0002, step 4).
   *
   * The collector does not project it. Status is produced by `statusProjector.ts` from this
   * same `RegistrySource`, and threading it through as an argument keeps that ordering
   * explicit at the call site: Status first, then the console downstream of it. Building it
   * inside the collector would hide the dependency direction the inversion exists to
   * establish, and would give the collector a second job it has no reason to hold.
   */
  readonly status: StatusSnapshot;
}

/**
 * Reads durable state through {@link RegistrySource} and shapes it into a {@link ProjectorInput}.
 * Pure with respect to `source` and `options`: it calls only read methods and constructs a
 * plain object. When no mission is registered it still returns a well-formed input describing
 * an unregistered system, so the projector can render honest emptiness rather than the
 * collector throwing.
 */
export function collectProjectorInput(source: RegistrySource, options: CollectOptions): ProjectorInput {
  const mission = source.currentMission();
  const snapshotFacts = source.latestSnapshot();
  const { operationalConsole, improvementField, gauges } = options.status;

  // A recognition record and run identity are read only when a snapshot exists and its graph
  // has committed. A snapshot with no committed record yields a null recognition input, which
  // the projector renders as an idle, uncommitted recognition field — never a fabricated one.
  let recognition: ProjectorInput['recognition'] = null;
  let run: ProjectorInput['run'] = null;
  if (snapshotFacts !== null) {
    const record = source.recognitionFor(snapshotFacts.snapshotId);
    if (record !== null) {
      recognition = {
        edgeCount: record.edgeCount,
        unresolvedCount: record.unresolvedCount,
        filesInProgram: record.filesInProgram,
        filesRecognised: record.filesRecognised,
        semanticDiagnostics: record.semanticDiagnostics,
        languageCensus: snapshotFacts.languageCensus,
      };
      const runId = source.runIdForSnapshot(snapshotFacts.snapshotId);
      run = {
        // Identity is read, never minted (P0.3). A committed record proves the graph is
        // durable; it does not name the run that produced it. When the current.json
        // pointer carries no matching run id — pre-pointer streams, replaced pointers —
        // the absence travels as null and the console can say “not recorded”, instead of
        // the old fallback that dressed the result hash up as a run identity.
        runId,
        snapshotId: snapshotFacts.snapshotId,
        committed: {
          // result_hash IS the graph's content identity: the sha256 of the stored
          // recognition artifact (units, edges, unresolved), recorded at commit.
          graphSha256: record.resultHash,
          // The graph plane keys the recognition record by snapshot id and content hash;
          // no distinct record identity exists in the durable schema yet. Null until one
          // does — the previous copy of the snapshot id fabricated a second identity.
          recognitionRecordId: null,
        },
      };
    }
  }

  return {
    capturedAt: options.capturedAt,
    operator: options.operator,
    activeTab: options.activeTab,
    status: options.status,
    mission: mission ?? UNREGISTERED_MISSION,
    snapshot:
      snapshotFacts === null
        ? null
        : {
            snapshotId: snapshotFacts.snapshotId,
            fileCount: snapshotFacts.fileCount,
            capturedAt: snapshotFacts.capturedAt,
          },
    run,
    recognition,
    projectRecognition: source.projectRecognitionIdentity?.() ?? null,
    readiness: source.configReadiness(),
    sources: source.stateSources(),
    // Use the same facts already sealed in Status. A second registry read could race a writer
    // and show evidence under a Status seal that did not cover it.
    ...(isBranchUnavailable(operationalConsole) ? {} : { operationalConsole }),
    ...(isBranchUnavailable(improvementField) ? {} : { improvementField }),
    ...(isBranchUnavailable(gauges) ? {} : { gauges }),
  };
}

/**
 * The mission identity shown before any mission is registered. It is a real, honest value —
 * a system that has not been bootstrapped — not a placeholder pretending a mission exists.
 */
const UNREGISTERED_MISSION: MissionFacts = {
  missionId: 'unregistered',
  title: 'No mission registered',
  constitutionHash: '0'.repeat(64),
  lastChange: 'unchanged',
};
