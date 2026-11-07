/**
 * Console snapshot projector.
 *
 * Spec: CLUE_Milestone_Review_and_Forward_Plan_v3.md §5.2 (the one deterministic read-side
 *       that assembles the complete ConsoleSnapshot), and the interface contract in
 *       viewModel.ts. Doctrine: CLUE_v3.md — the console displays proven state, never
 *       optimistic interpretation; Zasada 17 / A4 — a projection renders durable knowledge
 *       and never becomes it.
 *
 * This is the bridge from "components work individually" to "the program has one coherent
 * view of itself". Every UI area — the Dashboard, the System Navigator, the future two-tab
 * renderer — reads one {@link ConsoleSnapshot}; this function is the single place that state
 * is assembled, sealed, and validated. Three properties define it.
 *
 *   **It is pure and deterministic.** It takes explicit durable inputs rather than reaching
 *   into a live Runtime, so the same durable state always produces the same snapshot and a
 *   projection rebuilt from the event log yields an equivalent one (§5.2 acceptance). The
 *   daemon is responsible for gathering the inputs from the registries; the assembly logic
 *   is testable without a database, a clock, or a filesystem.
 *
 *   **It does not fabricate.** CLUE's whole purpose forbids showing state it cannot support.
 *   Where a plane has not produced data yet — no live sessions, no calls, no findings, an
 *   empty ledger — the snapshot carries the contract's honest empty or idle shape, not
 *   invented rows. A graph is never shown committed unless a committed recognition record
 *   exists; recognition completeness is derived, never assumed from a finished scan.
 *
 *   **It seals what it emits.** The projector computes one {@link StateSeal} over the
 *   assembled snapshot — a hash, the source identities it was built from, a capture time,
 *   and a consistency result — then validates the whole object with the strict runtime schema
 *   ({@link parseConsoleSnapshot}) before returning it. A snapshot that fails its own contract
 *   is a projector defect and throws here rather than misleading a renderer.
 *
 * The seal's `capturedAt` and the snapshot hash are the only two values that depend on the
 * caller supplying a timestamp; everything else is a pure function of the durable inputs, so
 * a replay with the same inputs and the same timestamp is byte-identical.
 */

import { hashCanonicalJson } from '../shared/ids.js';
import type { Sha256 } from '../shared/ids.js';
import type { ProjectRecognitionIdentity } from '../shared/projectRecognitionIdentity.js';
import { computeCoverage } from '../analysis/source/coverage.js';
import type { CoverageReport } from '../analysis/source/coverage.js';
import {
  parseConsoleSnapshot,
  type CommandCrown,
  type ConfigurationView,
  type ConsoleSnapshot,
  type ConsoleTab,
  type DashboardView,
  type HealthLevel,
  type MissionIdentity,
  type PipelinePanel,
  type ReadinessSummary,
  type RecognitionField,
  type RecognitionIdentity,
  type RecognitionTopology,
  type SessionsPanel,
  type ShellState,
  type StateSeal,
} from './viewModel.js';
import {
  emptyFourNeonGauges,
  type FourNeonGaugesView,
} from './fourNeonGauges.js';
import {
  emptyGreatBookImprovementField,
  type GreatBookImprovementFieldView,
} from './greatBookImprovementField.js';
import { emptyOperationalConsoleProjection } from '../observability/operationalConsole/projection.js';
import { isBranchUnavailable, type StatusSnapshot } from '../status/statusContractV5.js';
import type { OperationalConsoleProjection } from '../observability/operationalConsole/contract.js';

/* ------------------------------------------------------------------------- */
/* Durable inputs                                                             */
/* ------------------------------------------------------------------------- */

/** The mission version in force, as the mission registry records it. */
export interface MissionInput {
  readonly missionId: string;
  readonly title: string;
  readonly constitutionHash: string;
  /** Whether the latest change was constitutional, architectural, or neither. */
  readonly lastChange: 'initial' | 'constitutional' | 'architectural' | 'unchanged';
}

/**
 * The active recognition run, if one has committed a graph for the current snapshot.
 *
 * Identity here is read, never minted (P0.3): every field carries a durable fact or an
 * explicit null — a missing identity is declared, not papered over with a neighbouring
 * value that happens to be non-null.
 */
export interface RunInput {
  /**
   * The recognition run that produced the committed graph, recovered from the
   * `graph/current.json` pointer. Null when the committed graph predates the pointer or
   * the pointer does not match this snapshot: the run happened, its identity was not
   * durably recorded, and the console says so rather than substituting a hash or a
   * snapshot id in its place.
   */
  readonly runId: string | null;
  readonly snapshotId: string;
  /** Present only once graph.committed sealed the run; null while provisional or absent. */
  readonly committed: {
    /**
     * Content identity of the committed graph: the durable record's `result_hash`, the
     * sha256 of the stored recognition artifact (units, edges, unresolved).
     */
    readonly graphSha256: string;
    /**
     * The durable graph plane keys the recognition record by snapshot id and content
     * hash; a distinct record identity does not exist in the schema yet. Null until it
     * does — never a copied snapshot id pretending to be a second identity.
     */
    readonly recognitionRecordId: string | null;
  } | null;
}

/** The committed recognition record for the snapshot (the durable graph summary). */
/**
 * What this projector still needs from the recognition record directly.
 *
 * ADR-0002 step 4 removed `unitCount`, `moduleCount` and `classDistribution`: they fed the
 * topology and nothing else, and the topology now comes from sealed Status. What remains
 * feeds {@link computeCoverage}, which Status does not carry — coverage is a derived
 * measure over the recognition result plus the language census, and no Status branch states
 * it. That is the honest boundary of this step: the members Status can supply are sourced
 * from it, and the ones it cannot are still read here and are visible as such.
 */
export interface RecognitionRecordInput {
  readonly edgeCount: number;
  readonly unresolvedCount: number;
  readonly filesInProgram: number;
  readonly filesRecognised: number;
  readonly semanticDiagnostics: number;
  /** Per-language file census from the snapshot manifest, for unsupported-language residual. */
  readonly languageCensus: Readonly<Record<string, number>>;
}

/** The source snapshot summary. */
export interface SnapshotInput {
  readonly snapshotId: string;
  readonly fileCount: number;
  readonly capturedAt: string;
}

/**
 * Everything the projector needs, all durable or explicitly provisional. The daemon fills
 * this from the registries; a test fills it with literals. `recognition` is null before any
 * run has committed — the snapshot then shows an idle, uncommitted recognition field rather
 * than inventing one.
 */
export interface ProjectorInput {
  readonly capturedAt: string;
  /**
   * The sealed Status body (ADR-0002, steps 3 and 4).
   *
   * Required as of step 4. Directory §19.3 places this module downstream of sealed Status,
   * and step 3 made that true for the recognition topology while leaving a parallel
   * derivation in place as a fallback. Keeping both would have preserved exactly the defect
   * the inversion exists to remove: two code paths deriving one fact, free to disagree the
   * moment one of them is edited. The fallback is gone and the topology has one source.
   */
  readonly status: StatusSnapshot;
  readonly operator: string;
  readonly activeTab: ConsoleTab;
  readonly mission: MissionInput;
  readonly snapshot: SnapshotInput | null;
  readonly run: RunInput | null;
  readonly recognition: RecognitionRecordInput | null;
  /** Exact active Project Profile generation, or null in the legacy single-project runtime. */
  readonly projectRecognition?: ProjectRecognitionIdentity | null;
  /** Optional authoritative Great Book projection. Unknown data stays explicitly empty. */
  readonly improvementField?: GreatBookImprovementFieldView;
  /** Optional authoritative four-gauge projection. Exactly four slots are required. */
  readonly gauges?: FourNeonGaugesView;
  /** Readiness of the configuration sections, as the config registry evaluates them. */
  readonly readiness: ReadinessSummary;
  /** Source identities the snapshot was assembled from (event-log offset, db version, …). */
  readonly sources: readonly string[];
  /**
   * The real Quadrant 4 operational-console projection, when the collector has read one
   * from the recorded traffic stream. Optional and defaulting to the empty projection:
   * absent recorded traffic must render as an empty console, never as invented activity,
   * and the projector stays pure — the file read lives in the read-side collector, not
   * here. Built by {@link projectOperationalConsole} from the append-only NDJSON.
   */
  readonly operationalConsole?: OperationalConsoleProjection;
}

/* ------------------------------------------------------------------------- */
/* Empty / idle shapes (honest absence, never fabricated data)                */
/* ------------------------------------------------------------------------- */

const EMPTY_SESSIONS: SessionsPanel = {
  counts: {
    active: 0,
    limit: 0,
    queued: 0,
    checkpointing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    recoveryRequired: 0,
  },
  active: [],
  calls: {
    today: 0,
    thisCycle: 0,
    inFlight: 0,
    queued: 0,
    successful: 0,
    failed: 0,
    retries: 0,
    discarded: 0,
    avoidedByCache: 0,
    remaining: 0,
    burnRatePerHour: 0,
  },
};

/** An idle pipeline: every stage present but not reached. No stage claims progress it lacks. */
function idlePipeline(): PipelinePanel {
  return {
    stages: [
      { stage: 'proof_contract_frozen', state: 'not_reached', detail: null },
      { stage: 'baseline_captured', state: 'not_reached', detail: null },
      { stage: 'patch_sealed', state: 'not_reached', detail: null },
      { stage: 'shadow_applied', state: 'not_reached', detail: null },
      { stage: 'patched_experiment', state: 'not_reached', detail: null },
      { stage: 'verdict', state: 'not_reached', detail: null },
      { stage: 'landing_eligibility', state: 'not_reached', detail: null },
      { stage: 'canonical_landed', state: 'not_reached', detail: null },
      { stage: 'post_land_verification', state: 'not_reached', detail: null },
      { stage: 'ledger', state: 'not_reached', detail: null },
    ],
  };
}

/* ------------------------------------------------------------------------- */
/* Recognition field                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Builds the recognition field from the committed record, or an empty idle field when no run
 * has committed. Findings are empty here: they belong to the deep-review plane, which has not
 * produced any, so the field shows none rather than inventing them. Coverage informs the
 * topology counts but the field itself carries structural totals, not the coverage ratios
 * (those live in the CLI/HUD today and will bind into the snapshot in the read-side work).
 *
 * The field itself is deliberately run-agnostic state: the identical committed graph must
 * project identically whichever run produced it, so the daemon's revision and the seal
 * hash stay stable across re-runs. The graph's *identity* is provenance, and it travels
 * on {@link StateSeal.graph} beside the hash — see {@link graphProvenance}.
 */
/**
 * Provenance of the recognition state for {@link StateSeal.graph} (P0.3). Read, never
 * minted: whenever a run is named — even provisionally, before its graph commits — the
 * identity is carried; every absent component stays null. Null only while no run exists
 * for the current snapshot. Lives beside the seal hash, not inside it, so re-running the
 * same graph re-seals to the same `snapshotHash` while still naming which run produced it.
 * One nuance follows from revision-advances-only-on-state-change: when a later run
 * re-commits an identical graph, the daemon keeps the earlier published seal — and with
 * it the earlier run's provenance — which is consistent: the displayed state is that
 * graph, and the provenance names a run that truly produced it.
 */
function graphProvenance(run: RunInput | null): RecognitionIdentity | null {
  if (run === null) return null;
  return {
    runId: run.runId,
    snapshotId: run.snapshotId,
    graphSha256: (run.committed?.graphSha256 ?? null) as Sha256 | null,
    recognitionRecordId: run.committed?.recognitionRecordId ?? null,
  };
}

/**
 * What the field shows before a graph is committed, and the single definition of it.
 *
 * Previously written out twice — once for the no-record case and once as the derivation's
 * zero state — which is how two "empty" representations drift apart.
 */
const UNCOMMITTED_TOPOLOGY: RecognitionTopology = {
  filesRecognized: 0,
  modules: 0,
  functions: 0,
  classDistribution: {
    monofile_monodependency: 0,
    monofile_polydependency: 0,
    polyfile_monodependency: 0,
    polyfile_polydependency: 0,
  },
  currentTarget: null,
  hiddenEdges: 0,
};

/**
 * The recognition topology, sourced from sealed Status.
 *
 * ADR-0002 step 3. Status and this projector previously derived the same five numbers from
 * the same durable record by two separate code paths — the situation §4.2 calls a second
 * wire authority, and the one that makes two operator surfaces capable of disagreeing about
 * one workspace. Where Status has already stated the topology, it is read rather than
 * recomputed.
 *
 * Returns null when there is no Status body, or when its recognition branch is a stated
 * non-value. Both are honest: a Status that could not read the graph must not be turned into
 * a topology of zeroes here, because zero units is a measurement and "the graph is
 * unavailable" is not.
 */
function topologyFromStatus(status: StatusSnapshot): RecognitionTopology | null {
  const branch = status.recognition;
  if (isBranchUnavailable(branch)) return null;
  const distribution = branch.classDistribution;
  const cell = (key: string): number => distribution[key] ?? 0;
  return {
    filesRecognized: branch.filesRecognised,
    modules: branch.moduleCount,
    functions: branch.unitCount,
    classDistribution: {
      monofile_monodependency: cell('monofile-monodependency'),
      monofile_polydependency: cell('monofile-polydependency'),
      polyfile_monodependency: cell('polyfile-monodependency'),
      polyfile_polydependency: cell('polyfile-polydependency'),
    },
    currentTarget: branch.snapshotId,
    hiddenEdges: branch.unresolvedCount,
  };
}

function projectRecognitionField(
  recognition: RecognitionRecordInput | null,
  run: RunInput | null,
  status: StatusSnapshot,
): { field: RecognitionField; coverage: CoverageReport | null } {
  if (recognition === null) {
    return { field: { topology: UNCOMMITTED_TOPOLOGY, findings: [] }, coverage: null };
  }

  const coverage = computeCoverage({
    stats: {
      filesInProgram: recognition.filesInProgram,
      filesRecognised: recognition.filesRecognised,
      unitsByKind: {},
      edgesByKind: { edge: recognition.edgeCount },
      unresolvedByKind: {},
      syntacticDiagnostics: 0,
      semanticDiagnostics: recognition.semanticDiagnostics,
      elapsedMs: 0,
    },
    // The durable record carries a count, not the per-reference detail; represent the
    // unresolved total as a single kind so the ratio is still honest. `module-unresolved`
    // is the most general unresolved kind; the count is what drives the coverage measure.
    unresolved: Array.from({ length: recognition.unresolvedCount }, () => ({
      kind: 'module-unresolved' as const,
      detail: '',
      anchor: { path: '', startLine: 0, endLine: 0, startByte: 0, endByte: 0 },
      fromLogicalId: null,
    })),
    languageCensus: recognition.languageCensus,
  });

  // ADR-0002 step 4: the topology has one source. When Status states it, that is the
  // topology. When Status does not — its recognition branch is a stated non-value — the
  // console renders the same uncommitted field it renders before any graph is committed.
  //
  // That fallback is honest but lossy, and the loss is worth naming: `RecognitionTopology`
  // has no way to say "unavailable", so a graph that could not be read and a graph that has
  // not been built render identically. Status distinguishes them; this quadrant cannot.
  // Giving the console contract an unavailable state is a change to the console's own model
  // and belongs with the successor ADR that §19.3's "no second lifecycle state machine"
  // question already needs.
  //
  // `currentTarget` keeps the run's snapshot id: Status names the snapshot that was
  // recognised, this field names what the console is pointed at. The same value in practice,
  // but not the same claim, so it keeps its own source.
  const fromStatus = topologyFromStatus(status);
  const topology: RecognitionTopology =
    fromStatus === null
      ? UNCOMMITTED_TOPOLOGY
      : { ...fromStatus, currentTarget: run?.snapshotId ?? fromStatus.currentTarget };

  return { field: { topology, findings: [] }, coverage };
}

/* ------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* ------------------------------------------------------------------------- */

function projectShell(input: ProjectorInput, systemHealth: HealthLevel): ShellState {
  const identity: MissionIdentity = {
    missionId: input.mission.missionId,
    title: input.mission.title,
    constitutionHash: input.mission.constitutionHash as Sha256,
    lastChange: input.mission.lastChange,
  };
  return {
    identity,
    activeTab: input.activeTab,
    operator: input.operator,
    systemHealth,
    emergencyFault: null,
    configurationNeedsAttention: input.readiness.status === 'blocked',
  };
}

function projectCrown(input: ProjectorInput): CommandCrown {
  return {
    campaign: input.mission.title,
    cycle: 0,
    snapshot: (input.snapshot?.snapshotId ?? input.mission.constitutionHash) as Sha256,
    uptime: 0,
    sessions: EMPTY_SESSIONS.counts,
    calls: {
      today: 0,
      inFlight: 0,
      queued: 0,
      successfulRatio: 100,
      remaining: 0,
      limit: 0,
      burnRatePerHour: 0,
    },
    integrations: [],
  };
}

/**
 * Assembles a complete, sealed, validated {@link ConsoleSnapshot} from durable inputs. Throws
 * if the assembled snapshot fails its own contract — a projector defect must never reach a
 * renderer as a malformed snapshot.
 */
/* ------------------------------------------------------------------------- */
/* ADR-0004 — the surfaces this console owns and Status deliberately does not  */
/* ------------------------------------------------------------------------- */

/**
 * Console state that is **deliberately not** a Status branch, with the reason for each.
 *
 * ADR-0002 left these in the least defensible of three possible states: *"neither sourced from
 * Status nor declared as deliberately non-Status"*. ADR-0004 decided they stay local. This is the
 * declaration half — without it the decision lives only in a document, and the code still looks
 * like an oversight to anyone reading it.
 *
 * ## The test that put them here
 *
 * A console surface belongs in Status when it is a fact about **the mission's work** — durable,
 * attributable, still true when read later or elsewhere. It stays local when it is a fact about
 * **this host at this moment**.
 *
 * The deciding evidence was measured rather than argued. On the Creator's machine, `readiness`
 * reported `blocked` with `firstBlocking: chrome_console`, across nine sections of which seven —
 * `chrome_console`, `powershell`, `ide_cooperation`, `ai_providers`, `testing_benchmarks`,
 * `safety_authority`, `validation` — assert something about installed software on one computer.
 *
 * A Status document is exported, retained and diffed; `clue status export` writes a file that
 * outlives the run. Were readiness a branch, that file would carry "Chrome is not reachable" as a
 * durable mission fact — false the moment it is read anywhere else, including on the same machine
 * an hour later once Chrome is running. **The disqualifying property is not that the fact is
 * local; it is that the fact has no lifetime**, and a status document is a claim that outlives
 * its capture.
 *
 * ## What is NOT in this list, and why that matters
 *
 * `sessions` and `pipeline` are absent deliberately. They are facts about the mission's work —
 * session counts, and how far a proof travelled through the ten stages from
 * `proof_contract_frozen` to `ledger` — and the Status Contract already owns them at §9
 * (`aiOrchestration`) and §10 (`proofPipeline`). Both are now backed by durable authority:
 * `aiOrchestration` reads governed gateway policy plus `gateway.*` events, while
 * `proofPipeline` reads `proof.*` events. The console must consume those Status branches rather
 * than assembling a second local account of model calls or proof progress.
 *
 * `startStop` is absent for the opposite reason: it is `{phase, readiness}` and fails the test in
 * both directions at once. `phase` is a mission fact Status should own; `readiness` is the host
 * fact that must not leave. It cannot be split usefully while every value `phase` can take is
 * `stopped`, so ADR-0004 defers it rather than designing against a domain with no behaviour.
 * Being deferred is why it is neither listed here nor treated as a branch — and that is now a
 * recorded position rather than the undeclared state ADR-0002 objected to.
 */
export const CONSOLE_LOCAL_SURFACES: ReadonlyMap<string, string> = new Map([
  [
    'configuration.chrome',
    'a live browser session — chain, console preview, recent injections, health. Nothing here ' +
      'survives a restart, and nothing here is evidence.',
  ],
  [
    'configuration.powershell',
    'an executable on this machine. A status document naming it would assert a fact about a host ' +
      'it may never be read on.',
  ],
  [
    'configuration.ide',
    'IDE cooperation is a property of the operator’s desktop, not of the mission.',
  ],
  [
    'configuration.ai',
    'provider reachability and credentials-present are host-and-moment facts; the *results* of ' +
      'AI work belong to §9 aiOrchestration, which is a branch.',
  ],
  [
    'configuration.testing',
    'whether a test runner is installed here. The benchmark *results* are mission facts and are ' +
      'not projected from this.',
  ],
  [
    'configuration.storage',
    'local ledger reachability. The ledger contents are durable; whether this host can reach them ' +
      'is not.',
  ],
  [
    'configuration.safety',
    'the protected-surface policy as loaded on this host. The policy itself is governed and ' +
      'durable; whether this process could read it is a runtime fact.',
  ],
  [
    'configuration.readiness',
    'the nine-section roll-up. Seven sections assert installed software; the summary inherits ' +
      'their lifetime, which is none.',
  ],
  [
    'shell',
    'active tab, operator name, and the derived health roll-up shown in the mission rail. A tab ' +
      'selection is not a fact about the target program.',
  ],
]);

export function projectConsoleSnapshot(input: ProjectorInput): ConsoleSnapshot {

  // System health is derived, never asserted: blocked configuration is the only signal this
  // read-only projection currently has, so anything else is 'ok'. The daemon will widen this
  // as integration health becomes available.
  const systemHealth: HealthLevel = input.readiness.status === 'blocked' ? 'degraded' : 'ok';

  const { field: recognition } = projectRecognitionField(input.recognition, input.run, input.status);

  const dashboard: DashboardView = {
    startStop: { phase: 'stopped', readiness: input.readiness },
    crown: projectCrown(input),
    lens: {
      now: null,
      next: { summary: 'No session queued', timing: { by: 'none' }, reason: '', automatic: false },
      then: {
        milestone: 'Coherent state projection',
        kind: 'snapshot',
        dependsOnOperator: false,
        earliest: { by: 'none' },
      },
    },
    sessions: EMPTY_SESSIONS,
    recognition,
    progress: {
      recognition: input.recognition === null ? 0 : 100,
      deep_review: 0,
      proven_improvement: 0,
      certification: 0,
      test_maturity: 0,
    },
    velocity: { rows: [] },
    forecasts: { forecasts: [] },
    pipeline: idlePipeline(),
    improvementField: input.improvementField ?? emptyGreatBookImprovementField(input.capturedAt),
    gauges: input.gauges ?? emptyFourNeonGauges(input.capturedAt),
    ledger: {
      recent: [],
      equilibrium: {
        newFindingRate: 0,
        newTestRate: 0,
        repeatedFindingRate: 0,
        regressionEscapeRate: 0,
        cleanCycleCount: 0,
        domainsApproachingEquilibrium: [],
      },
    },
    operationalConsole: input.operationalConsole ?? emptyOperationalConsoleProjection(input.capturedAt),
  };

  const configuration: ConfigurationView = {
    project: {
      activeProject: input.projectRecognition ?? null,
      scanRoot: { absolute: null, state: 'empty', zone: null },
      maintenanceRoot: { absolute: null, state: 'empty', zone: null },
      artifactRoot: { absolute: null, state: 'empty', zone: null },
      branch: null,
      commit: null,
      dirtyFileCount: 0,
      lastIndexed: input.snapshot?.capturedAt ?? null,
      watcherActive: false,
      snapshotAligned: input.snapshot !== null,
      excludedPaths: [],
      health: 'unknown',
    },
    chrome: { chain: [], consolePreview: [], recentInjections: [], health: 'unknown' },
    powershell: {
      processId: null,
      version: null,
      workingDirectory: null,
      workingDirectoryZone: null,
      recentCommands: [],
      health: 'unknown',
    },
    ide: {
      ideType: null,
      workspace: null,
      patchHandoffEnabled: false,
      handoffVerified: false,
      health: 'unknown',
    },
    ai: {
      providers: [],
      sessionPolicy: {
        maxParallelSessions: 0,
        maxCallsPerSession: 0,
        dailyCallCap: 0,
        cycleCallCap: 0,
        contextUtilisationThreshold: 0,
        automaticNextSession: false,
        pauseAfterCheckpoint: true,
      },
      health: 'unknown',
    },
    testing: {
      browserProfileControlled: false,
      warmups: 0,
      iterations: 0,
      preregisteredBenchmarkRequired: true,
      health: 'unknown',
    },
    storage: {
      databaseLocation: null,
      artifactRoot: null,
      ledgerLocation: null,
      // Deep review §5.9: the chain was once shown valid without ledger evidence. A
      // positive integrity claim requires a verification fact from the durable plane;
      // until the ledger check reaches the reader seam, “not verified” is declared.
      hashChainValid: null,
      freeDiskBytes: null,
      health: 'unknown',
    },
    safety: {
      canonicalWriteProtected: true,
      maintenanceRootWritable: false,
      landingMode: 'NOTIFY',
      shellPolicy: 'restricted',
      chromeInjectionPolicy: 'audited',
      health: 'unknown',
    },
    readiness: input.readiness,
  };

  const shell = projectShell(input, systemHealth);

  // The seal binds everything above. Its hash is over the sealed body (shell + both views),
  // so any change to the projected state changes the hash; consistency is a self-check the
  // producer sets false if it detected a contradiction while assembling (none can occur here
  // because the contract makes contradictions unconstructable, so it is always true).
  const sealedBody = { shell, dashboard, configuration };

  // ADR-0002 step 5: this projection stops making an integrity claim of its own.
  //
  // §20 gate 3 requires one and only one State Seal. The danger it guards is two independent
  // *verdicts* about one workspace: when they disagree there is no rule for which is right,
  // because both were produced by an authority. `consistent` is therefore read from the
  // sealed Status body. The console can no longer assert integrity — it reports Status's
  // finding — and `statusHash` names exactly which sealed body this presentation reflects.
  //
  // `snapshotHash` stays a digest of *this* body, and deliberately so. It is not an integrity
  // seal and is documented on `StateSeal` as what it is: the change-detection value the
  // publisher uses to decide whether a new revision is worth sending. Repointing it at the
  // Status hash would have been the tidier-looking change and a real regression — two console
  // bodies differing only in readiness or active tab share one Status hash, so the dashboard
  // would have stopped republishing on exactly the changes an operator is watching for.
  //
  // `capturedAt`, `sources` and `graph` remain the console's own: they describe this
  // projection's capture and provenance, not an independent claim about durable truth.
  const seal: StateSeal = {
    snapshotHash: hashCanonicalJson(sealedBody),
    statusHash: input.status.seal.statusHash,
    capturedAt: input.capturedAt,
    consistent: input.status.seal.consistent,
    sources: [...input.sources],
    // Provenance beside the hash (P0.3): which graph — and, when recorded, which run —
    // the run-agnostic sealed body reflects.
    graph: graphProvenance(input.run),
  };

  // Validate against the strict runtime schema before returning: a projector that emits an
  // invalid snapshot is a defect, and it must fail here rather than in a renderer.
  return parseConsoleSnapshot({ seal, ...sealedBody });
}
