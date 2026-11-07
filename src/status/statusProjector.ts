/**
 * CLU-E Status — the projector.
 *
 * Spec: `CLUE_Status_Contract_v9.md`
 *   §1     the same durable state produces the same status body; the UI, CLI, HTTP API and
 *          exported JSON consume one validated snapshot and none assembles its own
 *   §2     every field is durably backed or an explicitly named non-value
 *   §18    the failure and freshness rules, implemented in `./freshness.js`
 *   §20    gate 1 (one pure projector produces the same snapshot from the same durable
 *          inputs), gate 26 (normative capability is distinguished from evidenced capability)
 * Directory: `CLUE_Project_Directory_v9.md` §19.2 — the projector joins compatible source
 *          heads only; Status is a projection over durable records, never a source used to
 *          reconstruct them (§21 rule 7).
 *
 * Backlog: DEV-P1-12 — Status had a schema, a seal and its freshness rules, and nothing that
 *          produced a body. This is that.
 *
 * ## Why it depends on `RegistrySource` rather than on `Runtime`
 *
 * `RegistrySource` is the narrow reader seam the console collector already uses: eight read
 * methods returning plain durable facts, no mutation, no registries in the signature.
 * Depending on it rather than on the whole `Runtime` buys three things. The projector can be
 * driven from a fixture, so gate 1's determinism is provable without a workspace. It cannot
 * reach past the seam to a registry the contract did not intend it to read. And it composes
 * the *same* reader the console composes, which is the mechanical precondition for ADR-0002:
 * two projections of one durable state cannot disagree about what that state was if they
 * read it through one interface.
 *
 * ## Determinism, and why the timestamp is an argument
 *
 * Gate 1 requires the same durable inputs to produce the same body. Every capture time in
 * the result — `generatedAt`, each branch's `freshness.observedAt`, the console and field
 * projections' `capturedAt` — descends from the single `capturedAt` the caller supplies.
 * Nothing here reads a clock or a random source. Two projections over unchanged state are
 * byte-identical, which is what makes `statusSeal.ts`'s "a mismatch is a projector defect"
 * a usable diagnosis rather than a hope.
 *
 * ## Honest emptiness is the normal case, not the error case
 *
 * Twenty of the thirty-five contract branches have no owning domain in this build.
 * They are filled from `UNSUPPORTED_BRANCHES` with `state: 'unsupported'` and a reason
 * naming the absent domain — not omitted, not zeroed. The fifteen backed branches degrade
 * individually: a reader that returns null yields `unavailable` for that branch alone, and
 * a reader that *throws* is caught per branch, so one broken projection cannot take down the
 * snapshot. §18's first rule requires exactly that, and a fault that removed the other
 * thirty-four branches would be a worse outcome than the fault itself.
 */

import {
  BACKED_BRANCHES,
  STATUS_SCHEMA_VERSION,
  UNSUPPORTED_BRANCHES,
  unavailableGoldenMetrics,
  type BranchUnavailable,
  type CapabilityDeclaration,
  type CurrentWorkBranch,
  type MeasurementCatalogueBranch,
  type Q1Branch,
  type RecognitionBranch,
  type RepositoryInventoryBranch,
  type RuntimeDiagnosticsBranch,
  type StatusSnapshot,
  type TargetBranch,
  type ProjectProfileBranch,
  type UnitRecord,
  type CycleBranch,
  type CycleCurrent,
  type CycleClosure,
  type ProofPipelineBranch,
  type GreatBookBranch,
  type AiOrchestrationBranch,
} from './statusContractV5.js';
import { completenessOf, evaluateFreshness, type FreshnessPolicy } from './freshness.js';
import { sealSnapshot, type SealedBody, type SealProvenance } from './statusSeal.js';
import type { RegistrySource } from '../daemon/consoleStateCollector.js';
import type { Sha256 } from '../shared/ids.js';
import {
  describeTargetPublication,
  UNRECORDED_TARGET_REMOTE_DECISION,
  type TargetRemoteDecisionRecord,
} from '../shared/targetPublication.js';

/* ------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* ------------------------------------------------------------------------- */

/** Facts about the catalogue in force, supplied by the caller that loaded it. */
export interface CatalogueFacts {
  readonly version: string;
  readonly hash: string;
  readonly activeCount: number;
  readonly reservedCount: number;
  readonly coordinatesUnique: boolean;
  readonly productionReady: boolean;
}

/** Facts about the Q1 stream pointer, read from `current.json` by the caller. */
export interface Q1Facts {
  readonly runId: string | null;
  readonly snapshotId: string | null;
  readonly resultHash: string | null;
  readonly streamSha256: string | null;
  readonly streamEventCount: number | null;
  readonly degraded: boolean;
  /** Physical ALL comparison from the committed stream receipt. Null when unavailable. */
  readonly inventoryReconciles: boolean | null;
}

export interface ProjectStatusOptions {
  /** The single capture instant every timestamp in the body descends from. */
  readonly capturedAt: string;
  readonly targetId: string;
  readonly targetName: string | null;
  readonly canonicalRoot: string;
  /** Mission-bound target publication fields; optional only for old unit fixtures. */
  readonly targetRemote?: string | null;
  readonly targetCredentialEnv?: string | null;
  readonly targetRemoteDecision?: TargetRemoteDecisionRecord;
  readonly missionBasisHash: string | null;
  readonly recognizerVersion: string | null;
  /** The catalogue in force, or null when it could not be loaded. */
  readonly catalogue: CatalogueFacts | null;
  /** The Q1 pointer, or null when no committed run is named. */
  readonly q1: Q1Facts | null;
  /** Per-branch freshness limits. A branch with no entry never expires. */
  readonly freshness?: Readonly<Record<string, FreshnessPolicy>>;
  /** Seal provenance the projector cannot derive from the reader seam. */
  readonly provenance: Omit<SealProvenance, 'generatedAt'>;
  /** Units to include. §7.1 requires the records; a large graph is capped, and says so. */
  readonly unitLimit?: number;
}

/** What the projector did, beside the body it produced. */
export interface ProjectionReport {
  readonly snapshot: StatusSnapshot;
  /** Branches whose reader threw. §18: a failed projection records a fault. */
  readonly faults: readonly { readonly branch: string; readonly detail: string }[];
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

const sha = (value: string): Sha256 => value as unknown as Sha256;

function unsupported(reason: string, expectedSource: string | null = null): BranchUnavailable {
  return { state: 'unsupported', reason, expectedSource, lastKnownAt: null };
}

/**
 * Reasons that must track reality (DEV-P2-08 S7-interim, 2026-08-10).
 *
 * The blanket "no owning domain in this build" was true for all twenty-four branches until
 * `src/cycle/` landed; a reason that has stopped being true is a lie the contract's own §2
 * forbids. These overrides keep the three affected branches honest while their **data**
 * waits where DEV-P1-51 recorded it must: a typed branch shape is a `5.2.0` wire revision
 * under ADR-0001's procedure — a schema change, a version bump, an ADR — now unblocked
 * (the pack is ratified and the epoch sealed) but not yet taken. The override says exactly
 * that, and names the source that will back the branch when the revision lands.
 */
const UNSUPPORTED_REASON_OVERRIDES: Readonly<
  Partial<Record<string, { readonly reason: string; readonly expectedSource: string }>>
> = {};

function unavailable(reason: string, expectedSource: string | null): BranchUnavailable {
  return { state: 'unavailable', reason, expectedSource, lastKnownAt: null };
}

/**
 * Runs one branch reader in isolation.
 *
 * §18's first rule and the Q1 contract's failure isolation agree here: one branch's source
 * failing must not remove the other thirty-four. The reason reaches the branch, the detail
 * reaches the fault list, and the caller sees both.
 */
function branchOf<T>(
  name: string,
  expectedSource: string,
  faults: { branch: string; detail: string }[],
  read: () => T | null,
): T | BranchUnavailable {
  let value: T | null;
  try {
    value = read();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    faults.push({ branch: name, detail });
    return { state: 'unavailable', reason: detail, expectedSource, lastKnownAt: null };
  }
  if (value === null) {
    return unavailable(`${expectedSource} holds no record for this snapshot`, expectedSource);
  }
  return value;
}

/* ------------------------------------------------------------------------- */
/* Projection                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Projects one status snapshot from durable state.
 *
 * The order below is §3's declaration order, which is also the dependency order: the
 * snapshot is read first because recognition and Q1 are scoped to it, and a body whose
 * branches named different captures would fail the seal's own consistency check.
 */
export function projectStatus(
  source: RegistrySource,
  options: ProjectStatusOptions,
): ProjectionReport {
  const at = options.capturedAt;
  const faults: { branch: string; detail: string }[] = [];
  const policy = (branch: string): FreshnessPolicy =>
    options.freshness?.[branch] ?? { limitMs: null };

  const sources = (() => {
    try {
      return [...source.stateSources()];
    } catch (error) {
      faults.push({ branch: 'sources', detail: error instanceof Error ? error.message : String(error) });
      return [];
    }
  })();
  const head = sources.at(-1) ?? null;

  // --- snapshot and mission -------------------------------------------------
  const snapshotFacts = branchOf('repositoryInventory', 'SnapshotRegistry', faults, () =>
    source.latestSnapshot(),
  );
  const hasSnapshot = !('state' in snapshotFacts);
  const snapshotId = hasSnapshot ? snapshotFacts.snapshotId : null;

  const missionFacts = (() => {
    try {
      return source.currentMission();
    } catch (error) {
      faults.push({ branch: 'target', detail: error instanceof Error ? error.message : String(error) });
      return null;
    }
  })();

  const target: TargetBranch | BranchUnavailable =
    missionFacts === null
      ? unavailable('no mission is registered', 'MissionRegistry')
      : {
          targetId: options.targetId,
          name: options.targetName,
          canonicalRoot: options.canonicalRoot,
          snapshotId,
          missionVersionId: missionFacts.missionId,
          missionBasisHash: options.missionBasisHash === null ? null : sha(options.missionBasisHash),
          constitutionHash: sha(missionFacts.constitutionHash),
          catalogueVersion: options.catalogue?.version ?? null,
          catalogueHash: options.catalogue === null ? null : sha(options.catalogue.hash),
          recognizerVersion: options.recognizerVersion,
          publication: describeTargetPublication(
            options.targetRemote ?? null,
            options.targetCredentialEnv ?? null,
            options.targetRemoteDecision ?? UNRECORDED_TARGET_REMOTE_DECISION,
          ),
          freshness: evaluateFreshness(at, at, head, policy('target')),
        };

  // --- active Project Profile and operation-specific readiness (Status 5.8.0) ---
  const projectProfile: ProjectProfileBranch | BranchUnavailable =
    source.projectProfileFacts === undefined
      ? unavailable('this source carries no Project Profile reader', 'ProjectRuntimeBinding')
      : (() => {
          const facts = branchOf('projectProfile', 'ProjectRuntimeBinding + ProjectReadiness', faults, () =>
            source.projectProfileFacts?.(at) ?? null,
          );
          if (facts === null || 'state' in facts) {
            return facts === null
              ? unavailable('runtime is operating in legacy config-v2 mode', 'ProjectRuntimeBinding')
              : facts;
          }
          return {
            profileMode: 'project-profile',
            projectIdentity: facts.projectIdentity,
            profileGeneration: facts.profileGeneration,
            assessmentAvailable: facts.assessmentAvailable,
            overallReadiness: facts.overallReadiness,
            readyForLocalWork: facts.readyForLocalWork,
            readyForRequestedOperations: facts.readyForRequestedOperations,
            capabilities: facts.capabilities,
            authorityState: facts.authorityState,
            authorityConflictState: facts.authorityConflictState,
            authorityManifestHash:
              facts.authorityManifestHash === null ? null : sha(facts.authorityManifestHash),
            configuredAuthorityHash: sha(facts.configuredAuthorityHash),
            recognitionConfigurationHash: sha(facts.recognitionConfigurationHash),
            assessedAt: facts.assessedAt,
            freshness: evaluateFreshness(facts.assessedAt, at, head, policy('projectProfile')),
          };
        })();

  const repositoryInventory: RepositoryInventoryBranch | BranchUnavailable = hasSnapshot
    ? {
        snapshotId: snapshotFacts.snapshotId,
        fileCount: snapshotFacts.fileCount,
        capturedAt: snapshotFacts.capturedAt,
        languageCensus: snapshotFacts.languageCensus,
        freshness: evaluateFreshness(
          snapshotFacts.capturedAt,
          at,
          head,
          policy('repositoryInventory'),
        ),
      }
    : snapshotFacts;

  // --- cycle (ADR-0007, the 5.2.0 revision) ---------------------------------
  // A source without the reader is `unavailable` naming what would back it; a source with
  // one is backed even when both members are null — "the domain answers: nothing yet".
  const cycle: CycleBranch | BranchUnavailable =
    source.cycleFacts === undefined
      ? unavailable('this source carries no cycle projection', 'src/cycle/cycleRegistry.ts')
      : (() => {
          const facts = branchOf('cycle', 'CycleRegistry', faults, () => source.cycleFacts?.() ?? null);
          if (facts === null || 'state' in facts) {
            return facts === null
              ? unavailable('the cycle reader returned nothing', 'src/cycle/cycleRegistry.ts')
              : facts;
          }
          return {
            current:
              facts.current === null
                ? null
                : {
                    id: facts.current.id,
                    stage: facts.current.stage as CycleCurrent['stage'],
                    grade: facts.current.grade as CycleCurrent['grade'],
                    lockDigest: facts.current.lockDigest === null ? null : sha(facts.current.lockDigest),
                    suspendedFrom: facts.current.suspendedFrom,
                    openedAt: facts.current.openedAt,
                    updatedAt: facts.current.updatedAt,
                  },
            lastClosure:
              facts.lastClosure === null
                ? null
                : {
                    cycleId: facts.lastClosure.cycleId,
                    closedAt: facts.lastClosure.closedAt,
                    grade: facts.lastClosure.grade as CycleClosure['grade'],
                    criteriaMet: facts.lastClosure.criteriaMet,
                    unmetCount: facts.lastClosure.unmetCount,
                    stageReached: facts.lastClosure.stageReached,
                  },
            freshness: evaluateFreshness(at, at, head, policy('cycle')),
          };
        })();

  // --- proof pipeline (ADR-0011, Status 5.3.0) -------------------------------
  const proofPipeline: ProofPipelineBranch | BranchUnavailable =
    source.proofPipelineFacts === undefined
      ? unavailable('this source carries no proof-event reader', 'events_index (proof.*)')
      : (() => {
          const facts = branchOf('proofPipeline', 'events_index (proof.*)', faults, () =>
            source.proofPipelineFacts?.() ?? null,
          );
          if (facts === null || 'state' in facts) {
            return facts === null
              ? unavailable('the proof-event reader returned nothing', 'events_index (proof.*)')
              : facts;
          }
          const latest = [
            facts.contractFrozen,
            facts.baselineBound,
            facts.executionRefused,
            facts.verdictRecorded,
          ]
            .filter((value): value is NonNullable<typeof value> => value !== null)
            .sort((left, right) => left.sequence - right.sequence)
            .at(-1);
          return {
            cycleId: facts.cycleId,
            contractFrozen: facts.contractFrozen,
            baselineBound: facts.baselineBound,
            executionRefused: facts.executionRefused,
            verdictRecorded: facts.verdictRecorded,
            freshness: evaluateFreshness(latest?.occurredAt ?? at, at, head, policy('proofPipeline')),
          };
        })();

  // --- Great Book recursive memory (DEV-P2-12, Status 5.4.0) ----------------
  const greatBook: GreatBookBranch | BranchUnavailable =
    source.greatBookFacts === undefined
      ? unavailable('this source carries no Great Book reader', 'great_book_entries')
      : (() => {
          const facts = branchOf('greatBook', 'great_book_entries', faults, () =>
            source.greatBookFacts?.() ?? null,
          );
          if (facts === null || 'state' in facts) {
            return facts === null
              ? unavailable('the Great Book reader returned nothing', 'great_book_entries')
              : facts;
          }
          return {
            entryCount: facts.entryCount,
            contributionCount: facts.contributionCount,
            recordingGapCount: facts.recordingGapCount,
            latestEntryId: facts.latestEntryId,
            latestCycleId: facts.latestCycleId,
            normalizationVersion: facts.normalizationVersion,
            normalizationHash: sha(facts.normalizationHash),
            freshness: evaluateFreshness(facts.latestRecordedAt ?? at, at, head, policy('greatBook')),
          };
        })();

  // --- Model Gateway / AI orchestration (DEV-P2-09, Status 5.8.0) ----------
  const aiOrchestration: AiOrchestrationBranch | BranchUnavailable =
    source.aiOrchestrationFacts === undefined
      ? unavailable('this source carries no Model Gateway reader', 'gateway_calls + governed policies')
      : (() => {
          const facts = branchOf('aiOrchestration', 'gateway_calls + governed policies', faults, () =>
            source.aiOrchestrationFacts?.(at) ?? null,
          );
          if (facts === null || 'state' in facts) {
            return facts === null
              ? unavailable('the Model Gateway reader returned nothing', 'gateway_calls + governed policies')
              : facts;
          }
          return {
            configured: true,
            enabled: facts.enabled,
            provider: facts.provider,
            projectIdentity: facts.projectIdentity,
            profileGeneration: facts.profileGeneration,
            credentialReference: facts.credentialReference,
            requestedModel: facts.requestedModel,
            effectiveModel: facts.effectiveModel,
            fallbackUsed: facts.fallbackUsed,
            apiKeyEnv: facts.apiKeyEnv,
            apiKeyPresent: facts.apiKeyPresent,
            operationallyReady: facts.operationallyReady,
            policyProblems: facts.policyProblems,
            budgetHash: sha(facts.budgetHash),
            routingHash: sha(facts.routingHash),
            priceScheduleVersion: facts.priceScheduleVersion,
            enabledRouteCount: facts.enabledRouteCount,
            defaultMode: facts.defaultMode,
            model: facts.model,
            budgetAuthority: facts.budgetAuthority,
            localBudgetEnforced: facts.localBudgetEnforced,
            localPricingAuthoritative: facts.localPricingAuthoritative,
            providerState: facts.providerState,
            providerPaused: facts.providerPaused,
            providerBudgetExhausted: facts.providerBudgetExhausted,
            providerPauseReason: facts.providerPauseReason,
            usage: facts.usage,
            calls: {
              submitted: facts.submitted,
              completed: facts.completed,
              failed: facts.failed,
              refused: facts.refused,
              pending: facts.pending,
            },
            spendUsd: {
              todayActual: facts.todayActualUsd,
              monthActual: facts.monthActualUsd,
              reserved: facts.reservedUsd,
              dailyHard: facts.dailyHardUsd,
              monthlyHard: facts.monthlyHardUsd,
            },
            degradationAction: facts.degradationAction,
            latest: facts.latest,
            freshness: evaluateFreshness(facts.latest?.updatedAt ?? at, at, head, policy('aiOrchestration')),
          };
        })();

  // --- recognition ----------------------------------------------------------
  const recognitionFacts =
    snapshotId === null
      ? unavailable('no snapshot has been captured', 'SnapshotRegistry')
      : branchOf('recognition', 'GraphRegistry', faults, () => source.recognitionFor(snapshotId));

  const recognition: RecognitionBranch | BranchUnavailable =
    'state' in recognitionFacts
      ? recognitionFacts
      : {
          snapshotId: recognitionFacts.snapshotId,
          resultHash: sha(recognitionFacts.resultHash),
          unitCount: recognitionFacts.unitCount,
          edgeCount: recognitionFacts.edgeCount,
          unresolvedCount: recognitionFacts.unresolvedCount,
          filesInProgram: recognitionFacts.filesInProgram,
          filesRecognised: recognitionFacts.filesRecognised,
          semanticDiagnostics: recognitionFacts.semanticDiagnostics,
          moduleCount: recognitionFacts.moduleCount,
          classDistribution: recognitionFacts.classDistribution,
          // §18: a partial scan cannot claim committed-complete. The rule lives in
          // freshness.ts so the projector cannot express a different answer than the
          // validator would; `committed` is true because a recognition record exists.
          complete:
            completenessOf({
              filesInProgram: recognitionFacts.filesInProgram,
              filesRecognised: recognitionFacts.filesRecognised,
              committed: true,
            }) === 'committed_complete',
          freshness: evaluateFreshness(at, at, head, policy('recognition')),
        };

  // --- Q1 -------------------------------------------------------------------
  const q1: Q1Branch | BranchUnavailable =
    options.q1 === null
      ? unavailable('no committed run is named by the graph pointer', 'workspace/graph/current.json')
      : {
          runId: options.q1.runId,
          snapshotId: options.q1.snapshotId,
          resultHash: options.q1.resultHash === null ? null : sha(options.q1.resultHash),
          streamSha256: options.q1.streamSha256 === null ? null : sha(options.q1.streamSha256),
          streamEventCount: options.q1.streamEventCount,
          streamDegraded: options.q1.degraded,
          // Gate 38 concerns physical membership. Only use a receipt for this durable graph.
          inventoryReconciles:
            !options.q1.degraded && options.q1.runId !== null && options.q1.streamSha256 !== null &&
            !('state' in recognition) && options.q1.snapshotId === recognition.snapshotId &&
            options.q1.resultHash === recognition.resultHash
              ? options.q1.inventoryReconciles
              : null,
          freshness: evaluateFreshness(at, at, head, policy('q1')),
        };

  // --- catalogue ------------------------------------------------------------
  const measurementCatalogue: MeasurementCatalogueBranch | BranchUnavailable =
    options.catalogue === null
      ? unavailable('the measurement catalogue could not be loaded', 'config/measurements/catalogue.yaml')
      : {
          version: options.catalogue.version,
          hash: sha(options.catalogue.hash),
          activeCount: options.catalogue.activeCount,
          reservedCount: options.catalogue.reservedCount,
          coordinatesUnique: options.catalogue.coordinatesUnique,
          productionReady: options.catalogue.productionReady,
          freshness: evaluateFreshness(at, at, head, policy('measurementCatalogue')),
        };

  // --- quadrant projections -------------------------------------------------
  const operationalConsole = branchOf('operationalConsole', 'OperationalConsoleStore', faults, () =>
    source.operationalConsoleProjection?.(at) ?? null,
  );
  const improvementField = branchOf('improvementField', 'MetricRegistry', faults, () =>
    source.improvementFieldProjection?.(at) ?? null,
  );
  const gauges = branchOf('gauges', 'MetricRegistry', faults, () =>
    source.gaugesProjection?.(at) ?? null,
  );

  const currentWork: CurrentWorkBranch | BranchUnavailable =
    'state' in operationalConsole
      ? unavailable('no operational console projection', 'OperationalConsoleStore')
      : {
          contract: operationalConsole.currentWorkContract,
          freshness: evaluateFreshness(at, at, head, policy('currentWork')),
        };

  // --- units ----------------------------------------------------------------
  // §7.1 asks for one record per semantic unit. The graph's unit rows are not on the
  // reader seam, so this build reports the count through `recognition` and states plainly
  // that the records themselves are not yet projected — a count is not a record set, and
  // an empty array here would read as "the graph is empty".
  //
  // DEV-P1-45: this said `unsupported`, and that is a different claim. `unsupported` is what the
  // other twenty-four branches report, and it means *no owning domain exists in this build* — the
  // reader should wait for the domain to be written. `unavailable` means *the domain is here and
  // has nothing for this snapshot* — the reader should investigate.
  //
  // `units` has an owning domain. `GraphRegistry` holds the rows; they are simply not exposed on
  // the `RegistrySource` seam this projector reads through. Reporting `unsupported` told an
  // operator to wait for something that had already arrived.
  //
  // The second argument is what makes this substantive rather than a relabelling. `unsupported`
  // hard-codes `expectedSource: null`, because a branch with no domain has no source to name.
  // `units` can name one, and naming it is the difference between "nothing here yet" and "here is
  // where this will come from once the seam carries it". That it *could* name a source is the
  // clearest evidence the original state was wrong.
  //
  // Gate 7 is unaffected: it is reported unreachable from `populated.has('units')`, and `units`
  // is still not populated. The gate's honesty did not depend on which unavailability state was
  // reported, which is precisely why this went unnoticed.
  const units: readonly UnitRecord[] | BranchUnavailable = unavailable(
    'unit records are not on the RegistrySource reader seam; recognition reports the counts',
    'GraphRegistry',
  );

  // --- runtime diagnostics --------------------------------------------------
  // §13.2 and gate 5: this is what a running instance reports *now*, and it is kept
  // structurally apart from assessment. A projection fault is a runtime fault; it is not
  // an assessment result and must never be read as one.
  const runtimeDiagnostics: RuntimeDiagnosticsBranch = {
    health: faults.length === 0 ? 'healthy' : 'degraded',
    reason: faults.length === 0 ? null : `${faults.length} branch projection(s) failed`,
    checkedAt: at,
    faults: faults.map((fault) => `${fault.branch}: ${fault.detail}`),
  };

  // --- capability declaration ----------------------------------------------
  const populated = new Set<string>();
  const branches: Readonly<Record<string, unknown>> = {
    target,
    projectProfile,
    cycle,
    repositoryInventory,
    recognition,
    q1,
    currentWork,
    units,
    measurementCatalogue,
    improvementField,
    gauges,
    operationalConsole,
    aiOrchestration,
    proofPipeline,
    greatBook,
    runtimeDiagnostics,
  };
  for (const name of BACKED_BRANCHES) {
    const value = branches[name];
    if (typeof value === 'object' && value !== null && !('state' in value)) populated.add(name);
  }

  const capability: CapabilityDeclaration = {
    contractVersion: STATUS_SCHEMA_VERSION,
    backedBranches: [...populated],
    unsupportedBranches: [...UNSUPPORTED_BRANCHES],
    // Claimed conservatively and by evidence. Gate 2 holds because the schema is strict;
    // gate 1 because this function is pure. Gate 3 does not hold while the console
    // view-model carries its own seal (ADR-0002), and saying so is the point of §1.
    // Gate 3 is claimed as of ADR-0002 step 5, and the claim is narrow enough to state
    // exactly: there is one integrity verdict. The console's `StateSeal.consistent` is read
    // from this body rather than formed independently, and its `snapshotHash` is documented
    // as a change-detection digest carrying no integrity claim. The failure gate 3 guards —
    // two authorities reaching two verdicts about one workspace — is structurally impossible.
    // Gate 4 is claimed as of DEV-P1-16: `clue status show|export`, `GET /api/status/current`
    // and the dashboard's console projection all descend from one composition
    // (`statusFromRuntime.ts`). Verified against the running server, not only in a test: a
    // CLI export and an API fetch of the same workspace produced byte-identical bodies once
    // the declared capture instant was equalised, and both seals verified independently.
    // `selftest/status-gate4-parity.test.ts` holds the invariant.
    satisfiedGates: [1, 2, 3, 4],
    unreachableGates: [
      ...(populated.has('units')
        ? []
        : [{ gate: 7, reason: 'unit records are not projected; only their counts are' }]),
    ],
  };

  const body = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: at,
    target,
    projectProfile,
    ...Object.fromEntries(
      UNSUPPORTED_BRANCHES.map((name) => [
        name,
        (() => {
          const override = UNSUPPORTED_REASON_OVERRIDES[name];
          return override === undefined
            ? unsupported(`no owning domain in this build (${name})`)
            : unsupported(override.reason, override.expectedSource);
        })(),
      ]),
    ),
    cycle,
    repositoryInventory,
    recognition,
    q1,
    currentWork,
    units,
    measurementCatalogue,
    goldenMetrics: unavailableGoldenMetrics(
      'no Golden backend in this build; src/metrics/golden/ is absent',
    ),
    improvementField,
    gauges,
    operationalConsole,
    aiOrchestration,
    proofPipeline,
    greatBook,
    runtimeDiagnostics,
    sources,
    capability,
  } as unknown as SealedBody;

  const provenance: SealProvenance = { ...options.provenance, generatedAt: at };
  return { snapshot: sealSnapshot(body, provenance), faults };
}
