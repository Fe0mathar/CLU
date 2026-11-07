/**
 * Runtime-backed registry source.
 *
 * Spec: CLUE_Recommended_Next_Milestone_v4.md §3 (Workstream B). This is the live
 *       implementation of {@link RegistrySource} — the daemon-side adapter that binds the
 *       collector's read seam to the real {@link Runtime} registries. It is the *only* place
 *       that touches registries on behalf of the console; the collector, projector, daemon,
 *       and renderer never read registries directly.
 *
 * It reads through the same handles the CLI uses — `runtime.mission`, `runtime.snapshots`,
 * `runtime.graph` — and recovers run identity from the `graph/current.json` pointer the
 * recognize command writes on commit. It performs only reads and constructs plain facts.
 *
 * Verification boundary (honest): this adapter's construction and mapping are DELIVERY-VERIFIED
 * against the real registry *types* — it compiles against the true method signatures and field
 * names, and its pure fallbacks (missing registry, missing pointer) are unit-testable without a
 * database. Exercising it against live registry *data* requires the kernel DB, which is a
 * TARGET-HOST step: on the Windows host, `recognize` populates the registries and writes
 * current.json, and this adapter then feeds the collector real state. The collector's own
 * acceptance suite already proves the mapping logic against a deterministic fake source; this
 * file is the seam that makes that logic live.
 *
 * Two durable constraints are encoded rather than papered over:
 *
 *   - **A MissionVersion carries no display title and no change kind.** `current()` returns the
 *     versioned constitution binding (id, constitution_hash, documents, amendments); the human
 *     title and the "what changed" kind are not stored on it. The title is taken from config
 *     when present and otherwise stated plainly; `lastChange` is reported as `unchanged` for a
 *     read, because the change kind is a bootstrap-time fact, not a queryable property of the
 *     current version. Neither is invented.
 *
 *   - **Run identity lives with the recognition run, not the graph record — and a pointer
 *     earns trust per claim (pointer schema/hash parity, Integrity Patch 0).** The committed
 *     RecognitionRecord is keyed by snapshot and carries the durable content identity
 *     (`result_hash`); the run id is recovered from current.json. The pointer is a
 *     writer-owned convenience file, so the reader validates exactly the claims it relies
 *     on: to attribute a run to the committed graph, the pointer must name this snapshot
 *     AND the record's exact `result_hash`. Absent, malformed, mismatched, or pre-parity
 *     pointers (written before the recognize command stamped `resultHash`) are all reported
 *     as null — a stale pointer must never attribute an old run to a new graph, and refusal
 *     always beats misattribution. Nothing falls back to a substitute identity.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import type {
  MissionFacts,
  RecognitionFacts,
  RegistrySource,
  SnapshotFacts,
  ProofPipelineFacts,
  ProofPipelineEventFacts,
  GreatBookFacts,
  AiOrchestrationFacts,
  ProjectProfileFacts,
  ProjectCapabilityFacts,
} from './consoleStateCollector.js';
import type { ReadinessSummary } from '../ui/viewModel.js';
import type { Runtime } from '../control/runtime.js';
import type { ProjectReadinessAssessment } from '../control/projectProfiles/projectReadiness.js';
import { assertProjectOperationIdentity } from '../shared/projectOperationIdentity.js';
import {
  projectOperationalConsole,
  emptyOperationalConsoleProjection,
} from '../observability/operationalConsole/projection.js';
import type { OperationalConsoleProjection } from '../observability/operationalConsole/contract.js';
import { buildGreatBookImprovementField } from '../analysis/metrics/improvementField/index.js';
import type { GreatBookImprovementFieldView } from '../ui/greatBookImprovementField.js';
import { loadMeasurementCatalogue } from '../analysis/measure/catalogue.js';
import { readCurrentCycle, readLastClosure } from '../cycle/cycleRegistry.js';
import type { CycleFacts } from './consoleStateCollector.js';
import { PROOF_EVENT_TYPES } from '../proof/proofContract.js';
import {
  GREAT_BOOK_NORMALIZATION_HASH,
  GREAT_BOOK_NORMALIZATION_VERSION,
} from '../greatBook/greatBookEntry.js';
import { readGatewayStatus } from '../ai/gateway/modelGateway.js';
import {
  projectRecognitionIdentityEquals,
  projectRecognitionIdentitySchema,
  type ProjectRecognitionIdentity,
} from '../shared/projectRecognitionIdentity.js';
import {
  readGreatBookContributions,
  readGreatBookFacts as readProjectedGreatBookFacts,
} from '../greatBook/greatBookProjection.js';

export interface RuntimeRegistrySourceOptions {
  /**
   * Absolute path to the navigator live stream (…/graph/system-navigator.ndjson), used to
   * locate current.json beside it. When omitted, it is derived from the workspace root.
   */
  readonly navigatorPath?: string;
  /** Display title for the mission; falls back to the config project name or a plain default. */
  readonly missionTitle?: string;
  /** Configuration readiness, evaluated by the caller (the daemon) from the config registry. */
  readonly readiness: ReadinessSummary;
  /** Durable source identities to stamp on the snapshot seal (log offset, db version, …). */
  readonly sources: readonly string[];
  /** Optional complete operation-specific readiness assessment for this exact runtime generation. */
  readonly projectReadiness?: ProjectReadinessAssessment | null;
}

/* ------------------------------------------------------------------------- */
/* Graph pointer — trusted schema and parity (pure, unit-testable)            */
/* ------------------------------------------------------------------------- */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The claims the console actually relies on. The pointer file is owned by the recognize
 * command and may carry additional convenience fields (stream path, counts, timestamps);
 * those are ignored, not rejected — but the trusted claims are validated strictly, and a
 * pointer that cannot state them is treated as absent.
 */
const trustedGraphPointerSchema = z
  .object({
    runId: z.string().min(1),
    snapshotId: z.string().min(1),
    /** The committed record's own durable identity — the parity anchor. */
    resultHash: z.string().regex(SHA256_HEX),
    projectRecognition: projectRecognitionIdentitySchema.optional(),
  })
  .passthrough();

export interface TrustedGraphPointer {
  readonly runId: string;
  readonly snapshotId: string;
  readonly resultHash: string;
  readonly projectRecognition?: ProjectRecognitionIdentity;
}

/**
 * Parses current.json text into its trusted claims, or null when the file is malformed or
 * predates the parity contract (no `resultHash`). Null is the honest reading: a pointer
 * that cannot be validated must not be allowed to attribute anything.
 */
export function parseGraphPointer(text: string): TrustedGraphPointer | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = trustedGraphPointerSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    runId: parsed.data.runId,
    snapshotId: parsed.data.snapshotId,
    resultHash: parsed.data.resultHash,
    ...(parsed.data.projectRecognition === undefined
      ? {}
      : { projectRecognition: parsed.data.projectRecognition }),
  };
}

/**
 * The refusal ladder for run attribution. A run id is only meaningful as “the run that
 * produced THIS committed graph”, so every rung refuses rather than guesses:
 * no pointer → null; pointer names another snapshot → null; no committed record → null
 * (nothing exists to attribute to); pointer's `resultHash` differs from the record's →
 * null (a stale pointer from an earlier commit must never claim the current graph).
 */
export function pointerRunIdFor(
  pointer: TrustedGraphPointer | null,
  snapshotId: string,
  committedResultHash: string | null,
  expectedProjectRecognition?: ProjectRecognitionIdentity,
): string | null {
  if (pointer === null) return null;
  if (pointer.snapshotId !== snapshotId) return null;
  if (committedResultHash === null) return null;
  if (pointer.resultHash !== committedResultHash) return null;
  if (expectedProjectRecognition !== undefined) {
    if (
      pointer.projectRecognition === undefined ||
      !projectRecognitionIdentityEquals(pointer.projectRecognition, expectedProjectRecognition)
    ) {
      return null;
    }
  }
  return pointer.runId;
}

function capabilityFacts(input: ProjectCapabilityFacts): ProjectCapabilityFacts {
  return {
    state: input.state,
    ready: input.ready,
    required: input.required,
    code: input.code,
  };
}

export class RuntimeRegistrySource implements RegistrySource {
  readonly #runtime: Runtime;
  readonly #options: RuntimeRegistrySourceOptions;

  public constructor(runtime: Runtime, options: RuntimeRegistrySourceOptions) {
    this.#runtime = runtime;
    this.#options = options;
  }

  public currentMission(): MissionFacts | null {
    const mission = this.#runtime.mission?.current() ?? null;
    if (mission === null) return null;
    return {
      missionId: mission.id,
      // Title and change kind are not stored on the version; report them honestly.
      title: this.#options.missionTitle ?? this.#runtime.config.project.id ?? 'CLUE mission',
      constitutionHash: mission.constitution_hash,
      lastChange: 'unchanged',
    };
  }

  public latestSnapshot(): SnapshotFacts | null {
    const record = this.#runtime.snapshots?.latest('canonical') ?? null;
    if (record === null) return null;
    const manifest = this.#runtime.snapshots?.manifestOf(record.id) ?? null;
    const languageCensus = manifest?.stats.by_language ?? {};
    return {
      snapshotId: record.id,
      fileCount: record.file_count,
      capturedAt: record.captured_at,
      languageCensus,
    };
  }

  public recognitionFor(snapshotId: string): RecognitionFacts | null {
    const record = this.#runtime.graph?.recognition(snapshotId) ?? null;
    if (record === null) return null;
    return {
      snapshotId: record.snapshot_id,
      resultHash: record.result_hash,
      unitCount: record.unit_count,
      edgeCount: record.edge_count,
      unresolvedCount: record.unresolved_count,
      filesInProgram: record.files_in_program,
      filesRecognised: record.files_recognised,
      semanticDiagnostics: record.semantic_diagnostics,
      ...(() => {
        const topology = this.#runtime.graph?.topologyOf(record.snapshot_id)
          ?? { moduleCount: 0, classDistribution: {
            'monofile-monodependency': 0, 'monofile-polydependency': 0,
            'polyfile-monodependency': 0, 'polyfile-polydependency': 0,
          } };
        return { moduleCount: topology.moduleCount, classDistribution: topology.classDistribution };
      })(),
    };
  }

  public runIdForSnapshot(snapshotId: string): string | null {
    const committedResultHash = this.#runtime.graph?.recognition(snapshotId)?.result_hash ?? null;
    return pointerRunIdFor(
      this.#readPointer(),
      snapshotId,
      committedResultHash,
      this.#runtime.projectBinding?.recognition.identity,
    );
  }

  public projectRecognitionIdentity(): ProjectRecognitionIdentity | null {
    return this.#runtime.projectBinding?.recognition.identity ?? null;
  }

  public configReadiness(): ReadinessSummary {
    return this.#options.readiness;
  }

  /**
   * ADR-0007: the cycle facts, read through the same two readers doctor uses —
   * `readCurrentCycle` off the projection and `latestClosedCycle` off the log — so the
   * Status branch and the doctor line can never disagree.
   */
  public cycleFacts(): CycleFacts {
    const current = readCurrentCycle(this.#runtime.projections);
    // Projection-sourced, not log-sourced: Status opens with `withLog: false`, and a
    // log-only read would report "no closure" on a workspace that has one.
    const closure = readLastClosure(this.#runtime.projections);
    return {
      current:
        current === null
          ? null
          : {
              id: current.id,
              stage: current.stage,
              grade: current.grade,
              lockDigest: current.lock_digest,
              suspendedFrom: current.suspended_from,
              openedAt: current.opened_at,
              updatedAt: current.updated_at,
            },
      lastClosure:
        closure === null
          ? null
          : {
              cycleId: closure.cycleId,
              closedAt: closure.closedAt,
              grade: closure.grade,
              criteriaMet: closure.criteriaMet,
              unmetCount: closure.unmetCount,
              // The projection carries the verdict, not the stage the cycle reached; §24's
              // closure always happens from HANDOFF, which is the registry's only legal path.
              stageReached: 'HANDOFF',
            },
    };
  }

  public stateSources(): readonly string[] {
    return this.#options.sources;
  }

  /**
   * ADR-0011: project one coherent proof attempt from the durable event index, never from
   * UI state. Proof events use the cycle id as `subject_id`; this lets a read-only Status
   * attach select one cycle without opening the writer log or reparsing payloads.
   *
   * The latest `proof.contract_frozen` event is the attempt boundary. Later event kinds are
   * read only after that sequence, so a newly frozen attempt can never inherit the baseline
   * or verdict of an older attempt in the same cycle. Older pre-ADR events whose subject was
   * null remain honestly unattributed and therefore do not populate this branch.
   */
  public proofPipelineFacts(): ProofPipelineFacts {
    const db = this.#runtime.projections.db;

    const parseEventRow = (
      row: { eventId?: unknown; sequence?: unknown; occurredAt?: unknown } | undefined,
      label: string,
    ): ProofPipelineEventFacts | null => {
      if (row === undefined) return null;
      if (
        typeof row.eventId !== 'string' ||
        typeof row.sequence !== 'number' ||
        !Number.isSafeInteger(row.sequence) ||
        row.sequence < 0 ||
        typeof row.occurredAt !== 'string'
      ) {
        throw new Error(`Malformed ${label} row in events_index.`);
      }
      return { eventId: row.eventId, sequence: row.sequence, occurredAt: row.occurredAt };
    };

    const latestProofCycle = db
      .prepare(
        `SELECT subject_id AS subjectId
           FROM events_index
          WHERE type = ? AND subject_id IS NOT NULL
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(PROOF_EVENT_TYPES.contractFrozen) as { subjectId?: unknown } | undefined;

    const currentCycleId = readCurrentCycle(this.#runtime.projections)?.id ?? null;
    const latestProofCycleId =
      typeof latestProofCycle?.subjectId === 'string' ? latestProofCycle.subjectId : null;
    const cycleId = currentCycleId ?? latestProofCycleId;
    if (cycleId === null) {
      return {
        cycleId: null,
        contractFrozen: null,
        baselineBound: null,
        executionRefused: null,
        verdictRecorded: null,
      };
    }

    const readLatest = (
      type: string,
      afterSequence: number | null = null,
    ): ProofPipelineEventFacts | null => {
      const row =
        afterSequence === null
          ? (db
              .prepare(
                `SELECT id AS eventId, sequence, timestamp AS occurredAt
                   FROM events_index
                  WHERE type = ? AND subject_id = ?
                  ORDER BY sequence DESC LIMIT 1`,
              )
              .get(type, cycleId) as
              | { eventId?: unknown; sequence?: unknown; occurredAt?: unknown }
              | undefined)
          : (db
              .prepare(
                `SELECT id AS eventId, sequence, timestamp AS occurredAt
                   FROM events_index
                  WHERE type = ? AND subject_id = ? AND sequence > ?
                  ORDER BY sequence DESC LIMIT 1`,
              )
              .get(type, cycleId, afterSequence) as
              | { eventId?: unknown; sequence?: unknown; occurredAt?: unknown }
              | undefined);
      return parseEventRow(row, `${type}/${cycleId}`);
    };

    const contractFrozen = readLatest(PROOF_EVENT_TYPES.contractFrozen);
    if (contractFrozen === null) {
      // A current cycle may legitimately have no proof attempt yet.
      return {
        cycleId,
        contractFrozen: null,
        baselineBound: null,
        executionRefused: null,
        verdictRecorded: null,
      };
    }

    const baselineBound = readLatest(
      PROOF_EVENT_TYPES.baselineBound,
      contractFrozen.sequence,
    );
    const executionRefused = readLatest(
      PROOF_EVENT_TYPES.executionRefused,
      contractFrozen.sequence,
    );
    const verdictRecorded = readLatest(
      PROOF_EVENT_TYPES.verdictRecorded,
      contractFrozen.sequence,
    );

    if (executionRefused !== null && verdictRecorded !== null) {
      throw new Error(
        `Proof attempt ${contractFrozen.eventId} for ${cycleId} has both execution refusal and verdict.`,
      );
    }
    const terminal = executionRefused ?? verdictRecorded;
    if (terminal !== null && baselineBound === null) {
      throw new Error(
        `Proof attempt ${contractFrozen.eventId} for ${cycleId} reached a terminal event without a baseline binding.`,
      );
    }
    if (
      baselineBound !== null &&
      terminal !== null &&
      terminal.sequence <= baselineBound.sequence
    ) {
      throw new Error(
        `Proof attempt ${contractFrozen.eventId} for ${cycleId} has a terminal event before its baseline binding.`,
      );
    }

    return {
      cycleId,
      contractFrozen,
      baselineBound,
      executionRefused,
      verdictRecorded,
    };
  }

  /**
   * Reads the recorded Quadrant 4 operational-console traffic into a projection. The stream
   * is the append-only NDJSON the single OperationalConsoleRuntime writer produces at
   * `<workspace>/console/operational-console.ndjson`; an absent stream reads as an empty
   * console (no traffic yet), which is honest, not fabricated.
   *
   * Fail-safe here, fail-loud there (per the RegistrySource contract): the store's reader
   * rejects a broken hash chain, a sequence gap, or a malformed line by throwing — correct
   * for the standalone Operational Console instrument, which must surface stream corruption.
   * But this is the unified dashboard read, and one quadrant's corrupt stream must not take
   * down the whole snapshot. So a read or integrity failure degrades to an empty console;
   * the dedicated instrument remains the place that shows the integrity error itself.
   */
  public projectProfileFacts(capturedAt: string): ProjectProfileFacts | null {
    const binding = this.#runtime.projectBinding;
    if (binding === null) return null;

    const assessment = this.#options.projectReadiness ?? null;
    if (assessment !== null) {
      assertProjectOperationIdentity(
        binding.identity,
        assessment.projectIdentity,
        'Status Project Profile readiness',
      );
      if (assessment.profileGeneration !== binding.record.generation) {
        throw new Error(
          `Status Project Profile readiness generation ${assessment.profileGeneration} does not match active generation ${binding.record.generation}.`,
        );
      }
    }

    const pending = (code: string): ProjectCapabilityFacts => ({
      state: 'INCOMPLETE',
      ready: false,
      required: false,
      code,
    });
    const recognition: ProjectCapabilityFacts = assessment?.capabilities.recognition ?? {
      state: 'READY',
      ready: true,
      required: true,
      code: 'PROJECT_RECOGNITION_BOUND',
    };
    const gitPublication: ProjectCapabilityFacts = assessment?.capabilities.gitPublication ??
      (binding.config.project.remote === null
        ? {
            state: 'READY_LOCAL_ONLY',
            ready: true,
            required: false,
            code: 'NO_REMOTE_YET',
          }
        : pending('GIT_PUBLICATION_NOT_ASSESSED'));

    return {
      profileMode: 'project-profile',
      projectIdentity: binding.identity,
      profileGeneration: binding.record.generation,
      assessmentAvailable: assessment !== null,
      overallReadiness: assessment?.level ?? 'INCOMPLETE',
      readyForLocalWork: assessment?.readyForLocalWork ?? false,
      readyForRequestedOperations: assessment?.readyForRequestedOperations ?? false,
      capabilities: {
        recognition: capabilityFacts(recognition),
        proof: capabilityFacts(assessment?.capabilities.proof ?? pending('PROOF_READINESS_NOT_ASSESSED')),
        browserBenchmark: capabilityFacts(
          assessment?.capabilities.browserBenchmark ?? pending('BROWSER_READINESS_NOT_ASSESSED'),
        ),
        aiCandidateGeneration: capabilityFacts(
          assessment?.capabilities.aiCandidateGeneration ?? pending('GATEWAY_READINESS_NOT_ASSESSED'),
        ),
        gitPublication: capabilityFacts(gitPublication),
        custodianLanding: capabilityFacts(
          assessment?.capabilities.custodianLanding ?? {
            state: 'NOT_REQUIRED',
            ready: true,
            required: false,
            code: 'CUSTODIAN_LANDING_NOT_ASSESSED',
          },
        ),
      },
      authorityState: binding.authority.state,
      authorityConflictState: binding.authorityConflicts.state,
      authorityManifestHash: binding.authority.manifest?.manifestHash ?? null,
      configuredAuthorityHash: binding.authority.configuredAuthorityHash,
      recognitionConfigurationHash: binding.authority.recognitionConfigHash,
      assessedAt: assessment?.checkedAt ?? capturedAt,
    };
  }

  public aiOrchestrationFacts(capturedAt: string): AiOrchestrationFacts {
    const status = readGatewayStatus(this.#runtime, capturedAt);
    return {
      configured: true,
      enabled: status.enabled,
      provider: status.provider,
      projectIdentity: status.projectIdentity,
      profileGeneration: status.profileGeneration,
      credentialReference: status.credentialReference,
      requestedModel: status.requestedModel,
      effectiveModel: status.effectiveModel,
      fallbackUsed: status.fallbackUsed,
      apiKeyEnv: status.apiKeyEnv,
      apiKeyPresent: status.apiKeyPresent,
      operationallyReady: status.operationallyReady,
      policyProblems: status.policyProblems,
      budgetHash: status.budgetHash,
      routingHash: status.routingHash,
      priceScheduleVersion: status.priceScheduleVersion,
      enabledRouteCount: status.enabledRouteCount,
      defaultMode: status.defaultMode,
      model: status.model,
      budgetAuthority: status.budgetAuthority,
      localBudgetEnforced: status.localBudgetEnforced,
      localPricingAuthoritative: status.localPricingAuthoritative,
      providerState: status.providerState,
      providerPaused: status.providerPaused,
      providerBudgetExhausted: status.providerBudgetExhausted,
      providerPauseReason: status.providerPauseReason,
      usage: status.usage,
      submitted: status.submitted,
      completed: status.completed,
      failed: status.failed,
      refused: status.refused,
      pending: status.pending,
      todayActualUsd: status.todayActualUsd,
      monthActualUsd: status.monthActualUsd,
      reservedUsd: status.reservedUsd,
      dailyHardUsd: status.dailyHardUsd,
      monthlyHardUsd: status.monthlyHardUsd,
      degradationAction: status.degradationAction,
      latest:
        status.latest === null
          ? null
          : {
              callId: status.latest.callId,
              taskType: status.latest.taskType,
              lane: status.latest.lane,
              mode: status.latest.mode,
              model: status.latest.model,
              state: status.latest.state,
              submittedAt: status.latest.submittedAt,
              updatedAt: status.latest.updatedAt,
              actualUsd: status.latest.actualUsd,
              errorCode: status.latest.errorCode,
            },
    };
  }

  public greatBookFacts(): GreatBookFacts {
    const facts = readProjectedGreatBookFacts(
      this.#runtime.projections,
      this.#runtime.config.project.id,
    );
    return {
      entryCount: facts.entryCount,
      contributionCount: facts.contributionCount,
      recordingGapCount: facts.recordingGapCount,
      latestEntryId: facts.latestEntry?.entryId ?? null,
      latestCycleId: facts.latestEntry?.cycleId ?? null,
      latestRecordedAt: facts.latestEntry?.recordedAt ?? null,
      normalizationVersion: facts.normalizationVersion,
      normalizationHash: facts.normalizationHash,
    };
  }

  public operationalConsoleProjection(capturedAt: string): OperationalConsoleProjection {
    const eventFile = join(this.#runtime.workspaceRoot, 'console', 'operational-console.ndjson');
    try {
      return projectOperationalConsole(eventFile, { capturedAt });
    } catch {
      return emptyOperationalConsoleProjection(capturedAt);
    }
  }

  /**
   * Sealed Q2 projection (SC2 §14): even with zero proven contributions, the field and the
   * catalogue must agree on catalogue identity. The empty field therefore carries the REAL
   * loaded catalogue version and content hash; contributions stay honestly empty until the
   * Great Book records them. The normalization identity is the deterministic proof-delta
   * profile used by the durable entry builder; a read model with another identity is refused
   * by Status. Any load failure degrades to the projector's empty fallback rather than
   * inventing identity.
   */
  public improvementFieldProjection(capturedAt: string): GreatBookImprovementFieldView | undefined {
    try {
      const yaml = readFileSync(
        join(this.#runtime.repoRoot, 'config', 'measurements', 'catalogue.yaml'),
        'utf8',
      );
      const loaded = loadMeasurementCatalogue(yaml);
      const facts = readProjectedGreatBookFacts(
        this.#runtime.projections,
        this.#runtime.config.project.id,
      );
      return buildGreatBookImprovementField({
        capturedAt,
        targetId: this.#runtime.config.project.id,
        cycleId: facts.latestEntry?.cycleId ?? null,
        catalogueVersion: loaded.identity.version,
        catalogueHash: loaded.identity.contentHash,
        normalizationVersion: GREAT_BOOK_NORMALIZATION_VERSION,
        normalizationHash: GREAT_BOOK_NORMALIZATION_HASH,
        aggregationMode: 'CURRENT_CERTIFIED',
        selectedMeasurementId: null,
        contributions: readGreatBookContributions(
          this.#runtime.projections,
          this.#runtime.config.project.id,
        ),
      });
    } catch {
      return undefined; // projector renders the identity-less empty field
    }
  }

  /** Resolves current.json beside the navigator stream. */
  #pointerPath(): string {
    const explicit = this.#options.navigatorPath;
    const livePath =
      explicit !== undefined
        ? isAbsolute(explicit)
          ? explicit
          : resolve(this.#runtime.repoRoot, explicit)
        : join(this.#runtime.workspaceRoot, 'graph', 'system-navigator.ndjson');
    return join(dirname(livePath), 'current.json');
  }

  /** Reads current.json and returns its trusted claims, or null when absent/invalid. */
  #readPointer(): TrustedGraphPointer | null {
    try {
      const raw = readFileSync(this.#pointerPath(), 'utf8');
      return parseGraphPointer(raw);
    } catch {
      // Absent pointer is a normal state (no run has committed yet), not an error.
      return null;
    }
  }
}
