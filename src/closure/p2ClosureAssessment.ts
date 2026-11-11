/**
 * P2 closure assessment — one read-only decision over already-authoritative records.
 *
 * This module does not execute a cycle, issue a verdict, ratify documents, seal an epoch,
 * or activate the Model Gateway. It joins Status, the durable Proof Board, the current
 * pack ratification/epoch records, and one mission-bound Creator policy file. Absence is
 * a blocker with an exact action; it is never promoted to PASS by narrative.
 */

import { join } from 'node:path';

import { AUTHORITY_EVENT_TYPES, verifyInstalledPackAgainstSeal } from '../control/mission.js';
import type { Runtime } from '../control/runtime.js';
import { CYCLE_EVENT_TYPES } from '../cycle/cycleRegistry.js';
import { readProofBoard, type ProofBoardView } from '../daemon/proofBoardProjection.js';
import { EventLog } from '../memory/eventLog.js';
import {
  P2_CLOSURE_POLICY_PATH as CLOSURE_POLICY_PATH,
  P2_EXACT_OPENAI_MODELS,
  matchesP2Publication,
  readP2ClosurePolicy,
  type P2ClosurePolicy as ClosurePolicy,
} from '../control/p2ClosurePolicy.js';
export {
  P2_CLOSURE_POLICY_PATH,
  p2ClosurePolicySchema,
  type P2ClosurePolicy,
} from '../control/p2ClosurePolicy.js';
import { cycleClosedSchema, epochSealSchema, packRatificationSchema } from '../shared/schemas.js';
import {
  STATUS_SCHEMA_VERSION,
  isBranchUnavailable,
  type StatusSnapshot,
} from '../status/statusContractV5.js';
import { projectStatusFromRuntime } from '../status/statusFromRuntime.js';

export const P2_CLOSURE_ASSESSMENT_VERSION = '1.0.0' as const;
export interface P2ClosureBlocker {
  readonly id: string;
  readonly category: 'engineering' | 'creator-decision' | 'governance' | 'evidence';
  readonly detail: string;
  readonly action: string;
}

export interface P2ClosureFacts {
  readonly statusSchemaVersion: string;
  readonly statusConsistent: boolean;
  readonly runtimeHealth: string | null;
  readonly proofPipelineBacked: boolean;
  readonly greatBookBacked: boolean;
  readonly aiOrchestrationBacked: boolean;
  readonly versionControlUnsupported: boolean;
  readonly benchmarkRegistered: boolean;
  readonly benchmarkIntegrity: boolean;
  readonly remoteDecision: string | null;
  readonly localOnly: boolean;
  readonly publicationPermitted: boolean;
  readonly gatewayEnabled: boolean | null;
  readonly gatewayOperationallyReady: boolean | null;
  readonly gatewayEnabledRouteCount: number | null;
  readonly gatewayBudgetAuthority: string | null;
  readonly gatewayLocalBudgetEnforced: boolean | null;
  readonly gatewayModel: string | null;
  readonly gatewayProviderPaused: boolean | null;
  readonly gatewayDailyHard: number | null;
  readonly gatewayMonthlyHard: number | null;
  readonly currentMissionVersionId: string | null;
  readonly lastCycleId: string | null;
  readonly lastCycleMissionCurrent: boolean;
  readonly lastCycleClosureAfterEpoch: boolean;
  readonly statusCycleAgreement: boolean;
  readonly proofAttempts: number;
  readonly verdicts: number;
  readonly accepts: number;
  /** ACCEPT verdicts for the latest closed cycle that carry a recorded Great Book entry. */
  readonly greatBookEntries: number;
  readonly greatBookRecordingGaps: number;
  readonly lastCycleGrade: string | null;
  readonly lastCycleCriteriaMet: boolean | null;
  readonly ratificationCurrent: boolean;
  readonly epochName: string | null;
  readonly epochCurrent: boolean;
}

export interface P2ClosureDecision {
  readonly state:
    | 'CLOSED'
    | 'READY_FOR_CEREMONY'
    | 'AWAITING_CREATOR_DECISION'
    | 'ENGINEERING_BLOCKED';
  readonly closed: boolean;
  readonly blockers: readonly P2ClosureBlocker[];
}

export interface P2ClosureAssessment {
  readonly schemaVersion: typeof P2_CLOSURE_ASSESSMENT_VERSION;
  readonly generatedAt: string;
  readonly targetId: string;
  readonly missionVersionId: string | null;
  readonly policy: ClosurePolicy;
  readonly policyHash: string;
  readonly facts: P2ClosureFacts;
  readonly decision: P2ClosureDecision;
  readonly p3Deferrals: readonly [
    'Project Intent Model compiler (AMB-003)',
    'environment adapter registry',
  ];
}

function blocker(
  id: string,
  category: P2ClosureBlocker['category'],
  detail: string,
  action: string,
): P2ClosureBlocker {
  return { id, category, detail, action };
}

/** Pure closure decision. Tests exercise this separately from runtime collection. */
export function decideP2Closure(
  policy: ClosurePolicy,
  facts: P2ClosureFacts,
): P2ClosureDecision {
  const blockers: P2ClosureBlocker[] = [];
  const engineering = (condition: boolean, id: string, detail: string, action: string): void => {
    if (!condition) blockers.push(blocker(id, 'engineering', detail, action));
  };

  engineering(facts.statusSchemaVersion === STATUS_SCHEMA_VERSION, 'P2-STATUS-WIRE',
    `Status wire is ${facts.statusSchemaVersion}, expected ${STATUS_SCHEMA_VERSION}.`, 'Install the complete P2 ZIP sequence and restart the dashboard.');
  engineering(facts.statusConsistent, 'P2-STATUS-CONSISTENCY',
    'Status seal reports an inconsistency.', 'Resolve the named Status inconsistency before closure.');
  engineering(facts.runtimeHealth === 'healthy', 'P2-RUNTIME-HEALTH',
    `Runtime health is ${facts.runtimeHealth ?? 'unknown'}.`, 'Run doctor and repair runtime diagnostics.');
  engineering(facts.proofPipelineBacked, 'P2-PROOF-PIPELINE',
    'proofPipeline is not backed.', 'Restore durable proof events → Status projection.');
  engineering(facts.greatBookBacked, 'P2-GREAT-BOOK',
    'greatBook is not backed.', 'Restore verdict → durable Great Book recording.');
  engineering(facts.aiOrchestrationBacked, 'P2-GATEWAY',
    'aiOrchestration is not backed.', 'Restore gateway policy/projection integration.');
  engineering(facts.versionControlUnsupported, 'P2-GIT-SCOPE',
    'versionControl does not state the expected P4 deferral.', 'Do not imply a Git lifecycle that P2 did not implement.');
  engineering(facts.benchmarkRegistered && facts.benchmarkIntegrity, 'P2-BENCHMARK',
    'The registered Master Benchmark or its harness integrity is not current.', 'Register and integrity-verify clu-master before opening the closure cycle.');
  const expectedPublication = policy.publication?.decision ?? 'NO_REMOTE_YET';
  engineering(
    matchesP2Publication(expectedPublication, {
      decision: facts.remoteDecision, localOnly: facts.localOnly, publicationPermitted: facts.publicationPermitted,
    }),
    expectedPublication === 'NO_REMOTE_YET' ? 'P2-REMOTE-ABSENCE' : 'P2-REMOTE-POLICY',
    `P2 expects ${expectedPublication} with governed publication disabled. Live decision=${facts.remoteDecision ?? 'absent'}, localOnly=${facts.localOnly}, publicationPermitted=${facts.publicationPermitted}.`,
    'Match the active Project Profile to the ratified D5 remote decision. Governed publication requires its own authority.',
  );
  engineering(facts.greatBookRecordingGaps === 0, 'P2-GREAT-BOOK-GAPS',
    `${facts.greatBookRecordingGaps} accepted verdict recording gap(s) exist.`, 'Repair Great Book event/projection parity.');
  engineering(facts.statusCycleAgreement, 'P2-CYCLE-PROJECTION',
    'Status latest-cycle closure does not agree with the verified durable cycle.closed event.',
    'Rebuild projections and repair the cycle Status reader before closure.');

  if (policy.gateway.decision === 'PENDING_CREATOR_DECISION') {
    blockers.push(blocker(
      'P2-D4-GATEWAY-DECISION',
      'creator-decision',
      'The gateway is engineered but the Creator has not closed activation policy.',
      `Edit ${CLOSURE_POLICY_PATH}: choose SAFE_DISABLED_DEFERRED or OPERATIONAL and record the decision identity.`,
    ));
  } else if (policy.gateway.decision === 'SAFE_DISABLED_DEFERRED') {
    const safeDisabled =
      facts.gatewayEnabled === false &&
      facts.gatewayOperationallyReady === false &&
      facts.gatewayEnabledRouteCount === 0 &&
      facts.gatewayDailyHard === 0 &&
      facts.gatewayMonthlyHard === 0;
    if (!safeDisabled) {
      blockers.push(blocker(
        'P2-D4-SAFE-DISABLED-CONTRADICTION',
        'creator-decision',
        'The policy records SAFE_DISABLED_DEFERRED but live gateway policy is not fully disabled.',
        'Restore zero caps, zero enabled routes and gateway.enabled=false, or record OPERATIONAL instead.',
      ));
    }
  } else {
    const creatorPolicyCoherent =
      P2_EXACT_OPENAI_MODELS.some((model) => model === policy.gateway.model) &&
      policy.gateway.budget_authority === 'OPENAI_PLATFORM' &&
      policy.gateway.local_budget_enforced === false &&
      policy.gateway.provider_exhaustion_action === 'CONTROLLED_PAUSE' &&
      policy.gateway.remaining_token_authority === 'PROVIDER_ONLY';
    if (!creatorPolicyCoherent) {
      blockers.push(blocker(
        'P2-D4-CREATOR-POLICY-CONTRADICTION',
        'creator-decision',
        'The OPERATIONAL decision does not encode the complete Creator-approved OpenAI authority boundary.',
        `Record an approved exact model (${P2_EXACT_OPENAI_MODELS.join(' or ')}), OPENAI_PLATFORM budget authority, no local budget enforcement, CONTROLLED_PAUSE and PROVIDER_ONLY token-balance authority.`,
      ));
    }
    const operational =
      facts.gatewayEnabled === true &&
      facts.gatewayOperationallyReady === true &&
      facts.gatewayEnabledRouteCount !== null &&
      facts.gatewayEnabledRouteCount > 0 &&
      facts.gatewayBudgetAuthority === 'openai_platform' &&
      facts.gatewayLocalBudgetEnforced === false &&
      facts.gatewayModel === policy.gateway.model &&
      facts.gatewayProviderPaused === false;
    if (!operational) {
      blockers.push(blocker(
        'P2-D4-OPERATIONAL-CONTRADICTION',
        'creator-decision',
        `P2 expects a ready OpenAI gateway for ${policy.gateway.model ?? 'the selected exact model'}. Live model=${facts.gatewayModel ?? 'absent'}, ready=${facts.gatewayOperationallyReady ?? 'unknown'}.`,
        'Verify the active gateway uses the ratified exact model, its credential and routes are ready, and OpenAI Platform owns spending. Clear an explicit provider-budget pause with `clue gateway resume` when applicable.',
      ));
    }
  }

  if (!facts.ratificationCurrent) {
    blockers.push(blocker(
      'P2-RATIFICATION',
      'governance',
      'The installed documentation pack does not verify against the latest Creator ratification.',
      'Use `clue doctor` to check the installed pack. Repair any drift, then ratify the current pack when required.',
    ));
  }
  const successorEpoch = facts.currentMissionVersionId === null
    ? null
    : `P2-authoritative-${facts.currentMissionVersionId}`;
  const p2EpochName = facts.epochName === 'P2-authoritative' ||
    (successorEpoch !== null && facts.epochName === successorEpoch);
  if (!p2EpochName || !facts.epochCurrent) {
    blockers.push(blocker(
      'P2-EPOCH',
      'governance',
      `Latest evidence epoch is ${facts.epochName ?? 'absent'} and current=${String(facts.epochCurrent)}; expected the current P2-authoritative boundary.`,
      'After ratification, seal P2-authoritative if unused. For a successor, seal ' +
        `${successorEpoch ?? 'P2-authoritative-<current-mission-id>'}` +
        ' and type the state-bound phrase.',
    ));
  }

  if (facts.proofAttempts < 1 || facts.verdicts < 1) {
    blockers.push(blocker(
      'P2-PROOF-AUTHORITATIVE-CYCLE',
      'evidence',
      'No complete durable proof attempt with a verdict exists.',
      'Drive a cycle, record its opening benchmark, run `clue proof`, then close the cycle.',
    ));
  }
  if (facts.accepts < 1 || facts.greatBookEntries < 1) {
    blockers.push(blocker(
      'P2-FIRST-PROVEN-IMPROVEMENT',
      'evidence',
      'No real ACCEPT is linked to a durable Great Book entry.',
      'Run one honest candidate whose frozen contract proves an improvement; do not manufacture ACCEPT.',
    ));
  }
  if (
    facts.lastCycleGrade !== 'proof-authoritative' ||
    facts.lastCycleCriteriaMet !== true ||
    !facts.lastCycleMissionCurrent ||
    !facts.lastCycleClosureAfterEpoch
  ) {
    blockers.push(blocker(
      'P2-CYCLE-CLOSURE',
      'evidence',
      `Latest closure is cycle=${facts.lastCycleId ?? 'none'}, grade/criteria=${facts.lastCycleGrade ?? 'none'}/${String(facts.lastCycleCriteriaMet)}, currentMission=${String(facts.lastCycleMissionCurrent)}, afterEpoch=${String(facts.lastCycleClosureAfterEpoch)}.`,
      'Run `clue cycle close` after the verdict and closing Master Benchmark complete.',
    ));
  }

  const closed = blockers.length === 0;
  if (closed) return { state: 'CLOSED', closed: true, blockers };
  if (blockers.some((item) => item.category === 'engineering')) {
    return { state: 'ENGINEERING_BLOCKED', closed: false, blockers };
  }
  if (blockers.some((item) => item.category === 'creator-decision')) {
    return { state: 'AWAITING_CREATOR_DECISION', closed: false, blockers };
  }
  return { state: 'READY_FOR_CEREMONY', closed: false, blockers };
}


export function proofFactsForLatestClosure(
  board: ProofBoardView,
  lastCycleId: string | null,
  minimumSequenceExclusive = -1,
  maximumSequenceExclusive = Number.POSITIVE_INFINITY,
): Pick<P2ClosureFacts, 'currentMissionVersionId' | 'lastCycleId' | 'proofAttempts' | 'verdicts' | 'accepts' | 'greatBookEntries'> {
  const currentMissionVersionId = board.missionVersionId;
  const closureAttempts = lastCycleId === null
    ? []
    : board.proofAttempts.filter((attempt) =>
        attempt.cycleId === lastCycleId &&
        currentMissionVersionId !== null &&
        attempt.missionVersion === currentMissionVersionId &&
        attempt.contract.sequence > minimumSequenceExclusive &&
        attempt.contract.sequence < maximumSequenceExclusive,
      );
  const closureVerdicts = closureAttempts
    .map(({ contract, verdict }) =>
      verdict !== null &&
      verdict.sequence > contract.sequence &&
      verdict.sequence < maximumSequenceExclusive
        ? verdict
        : null,
    )
    .filter((verdict): verdict is NonNullable<typeof verdict> => verdict !== null);
  const closureAccepts = closureVerdicts.filter((verdict) => verdict.disposition === 'ACCEPT');
  return {
    currentMissionVersionId,
    lastCycleId,
    proofAttempts: closureAttempts.length,
    verdicts: closureVerdicts.length,
    accepts: closureAccepts.length,
    greatBookEntries: closureAccepts.filter((verdict) =>
      verdict.greatBookState === 'recorded' && verdict.greatBookEntryId !== null,
    ).length,
  };
}

export function collectP2ClosureFacts(
  status: StatusSnapshot,
  board: ProofBoardView,
  governance: {
    readonly ratificationCurrent: boolean;
    readonly epochName: string | null;
    readonly epochCurrent: boolean;
    readonly epochSequence: number | null;
    readonly latestClosure: {
      readonly cycleId: string;
      readonly sequence: number;
      readonly missionVersion: string | null;
      readonly grade: string;
      readonly criteriaMet: boolean;
    } | null;
  },
): P2ClosureFacts {
  const target = isBranchUnavailable(status.target) ? null : status.target;
  const cycle = isBranchUnavailable(status.cycle) ? null : status.cycle;
  const greatBook = isBranchUnavailable(status.greatBook) ? null : status.greatBook;
  const ai = isBranchUnavailable(status.aiOrchestration) ? null : status.aiOrchestration;
  const runtimeDiagnostics = isBranchUnavailable(status.runtimeDiagnostics)
    ? null
    : status.runtimeDiagnostics;
  const latestClosure = governance.latestClosure;
  const proofFacts = proofFactsForLatestClosure(
    board,
    latestClosure?.cycleId ?? null,
    governance.epochCurrent && governance.epochSequence !== null
      ? governance.epochSequence
      : Number.MAX_SAFE_INTEGER,
    latestClosure?.sequence,
  );
  const statusClosure = cycle?.lastClosure ?? null;
  const statusCycleAgreement =
    (latestClosure === null && statusClosure === null) ||
    (latestClosure !== null &&
      statusClosure !== null &&
      statusClosure.cycleId === latestClosure.cycleId &&
      statusClosure.grade === latestClosure.grade &&
      statusClosure.criteriaMet === latestClosure.criteriaMet);
  return {
    statusSchemaVersion: status.schemaVersion,
    statusConsistent: status.seal.consistent,
    runtimeHealth: runtimeDiagnostics?.health ?? null,
    proofPipelineBacked: status.capability.backedBranches.includes('proofPipeline'),
    greatBookBacked: status.capability.backedBranches.includes('greatBook'),
    aiOrchestrationBacked: status.capability.backedBranches.includes('aiOrchestration'),
    versionControlUnsupported:
      status.capability.unsupportedBranches.includes('versionControl') &&
      isBranchUnavailable(status.versionControl) && status.versionControl.state === 'unsupported',
    benchmarkRegistered: board.registeredBenchmark.state === 'registered',
    benchmarkIntegrity:
      board.registeredBenchmark.state === 'registered' &&
      board.registeredBenchmark.integrityVerified === true,
    remoteDecision: target?.publication.decision ?? null,
    localOnly: target?.publication.localOnly === true,
    publicationPermitted: target?.publication.publicationPermitted ?? false,
    gatewayEnabled: ai?.enabled ?? null,
    gatewayOperationallyReady: ai?.operationallyReady ?? null,
    gatewayEnabledRouteCount: ai?.enabledRouteCount ?? null,
    gatewayBudgetAuthority: ai?.budgetAuthority ?? null,
    gatewayLocalBudgetEnforced: ai?.localBudgetEnforced ?? null,
    gatewayModel: ai?.model ?? null,
    gatewayProviderPaused: ai?.providerPaused ?? null,
    gatewayDailyHard: ai?.spendUsd.dailyHard ?? null,
    gatewayMonthlyHard: ai?.spendUsd.monthlyHard ?? null,
    ...proofFacts,
    lastCycleMissionCurrent:
      latestClosure !== null &&
      proofFacts.currentMissionVersionId !== null &&
      latestClosure.missionVersion === proofFacts.currentMissionVersionId,
    lastCycleClosureAfterEpoch:
      latestClosure !== null &&
      governance.epochCurrent &&
      governance.epochSequence !== null &&
      latestClosure.sequence > governance.epochSequence,
    statusCycleAgreement,
    greatBookRecordingGaps: greatBook?.recordingGapCount ?? -1,
    lastCycleGrade: latestClosure?.grade ?? null,
    lastCycleCriteriaMet: latestClosure?.criteriaMet ?? null,
    ratificationCurrent: governance.ratificationCurrent,
    epochName: governance.epochName,
    epochCurrent: governance.epochCurrent,
  };
}

export function assessP2Closure(
  runtime: Runtime,
  generatedAt = new Date().toISOString(),
): P2ClosureAssessment {
  const { policy, sha256 } = readP2ClosurePolicy(runtime.repoRoot);
  const status = projectStatusFromRuntime(runtime, { capturedAt: generatedAt }).snapshot;
  let latestRatification: {
    readonly eventId: string;
    readonly sequence: number;
    readonly missionVersion: string | null;
    readonly sealPath: string;
    readonly manifestPath: string;
    readonly sealSha256: string;
    readonly manifestSha256: string;
    readonly constitutionPath: string;
    readonly constitutionSha256: string;
    readonly declaredFileCount: number;
  } | null = null;
  let latestEpoch: {
    readonly sequence: number;
    readonly missionVersion: string | null;
    readonly epochName: string;
    readonly ratificationEventId: string;
    readonly ratifiedSealSha256: string;
  } | null = null;
  let latestClosure: {
    readonly cycleId: string;
    readonly sequence: number;
    readonly missionVersion: string | null;
    readonly grade: string;
    readonly criteriaMet: boolean;
  } | null = null;
  const eventsRoot = runtime.projectState?.eventLogRoot ?? join(runtime.workspaceRoot, 'events');
  for (const record of EventLog.replayReadOnly(eventsRoot)) {
    if (record.type === AUTHORITY_EVENT_TYPES.packRatified) {
      const parsed = packRatificationSchema.safeParse(record.payload);
      if (!parsed.success || record.actor !== 'creator' || record.subject_id !== record.mission_version) {
        throw new Error(`governance event ${record.id} has an invalid ratification payload`);
      }
      latestRatification = {
        eventId: record.id,
        sequence: record.sequence,
        missionVersion: record.mission_version,
        sealPath: parsed.data.seal_path,
        manifestPath: parsed.data.manifest_path,
        sealSha256: parsed.data.seal_sha256,
        manifestSha256: parsed.data.manifest_sha256,
        constitutionPath: parsed.data.constitution_path,
        constitutionSha256: parsed.data.constitution_sha256,
        declaredFileCount: parsed.data.declared_file_count,
      };
    } else if (record.type === AUTHORITY_EVENT_TYPES.epochSealed) {
      const parsed = epochSealSchema.safeParse(record.payload);
      if (!parsed.success || record.actor !== 'creator' || record.subject_id !== record.mission_version ||
          parsed.data.legacy_head_sequence !== record.sequence - 1 ||
          parsed.data.legacy_head_hash !== record.previous_hash) {
        throw new Error(`governance event ${record.id} has an invalid epoch payload`);
      }
      latestEpoch = {
        sequence: record.sequence,
        missionVersion: record.mission_version,
        epochName: parsed.data.epoch_name,
        ratificationEventId: parsed.data.ratification_event_id,
        ratifiedSealSha256: parsed.data.ratified_seal_sha256,
      };
    } else if (record.type === CYCLE_EVENT_TYPES.closed) {
      const parsed = cycleClosedSchema.safeParse(record.payload);
      if (!parsed.success) {
        throw new Error(`cycle event ${record.id} has an invalid closure payload`);
      }
      if (record.subject_id !== parsed.data.cycle_id) {
        throw new Error(`cycle event ${record.id} subject does not match its closure payload`);
      }
      latestClosure = {
        cycleId: parsed.data.cycle_id,
        sequence: record.sequence,
        missionVersion: record.mission_version,
        grade: parsed.data.grade,
        criteriaMet: parsed.data.criteria_met,
      };
    }
  }
  const currentMissionVersionId = runtime.mission?.current()?.id ?? null;
  let installedPack: ReturnType<typeof verifyInstalledPackAgainstSeal> | null = null;
  if (latestRatification !== null && latestRatification.missionVersion === currentMissionVersionId) {
    try {
      installedPack = verifyInstalledPackAgainstSeal(runtime.repoRoot, 'assess P2 closure');
    } catch {
      // Preserve the read-only assessment and present an actionable governance blocker on drift.
    }
  }
  const ratificationCurrent =
    latestRatification !== null &&
    currentMissionVersionId !== null &&
    installedPack !== null &&
    latestRatification.missionVersion === currentMissionVersionId &&
    latestRatification.sealPath === installedPack.pack.sealFile &&
    latestRatification.manifestPath === installedPack.pack.manifestFile &&
    latestRatification.sealSha256 === installedPack.sealSha &&
    latestRatification.manifestSha256 === installedPack.declared.get(latestRatification.manifestPath) &&
    latestRatification.constitutionPath === runtime.config.constitution.file &&
    latestRatification.constitutionSha256 === installedPack.declared.get(latestRatification.constitutionPath) &&
    latestRatification.declaredFileCount === installedPack.declared.size;
  const epochCurrent =
    ratificationCurrent &&
    latestEpoch !== null &&
    latestRatification !== null &&
    currentMissionVersionId !== null &&
    installedPack !== null &&
    latestEpoch.missionVersion === currentMissionVersionId &&
    latestEpoch.sequence > latestRatification.sequence &&
    latestEpoch.ratificationEventId === latestRatification.eventId &&
    latestEpoch.ratifiedSealSha256 === installedPack.sealSha;
  // The dashboard's recent-attempt limit is a display concern, not a closure boundary.
  const board = readProofBoard(runtime, generatedAt, latestClosure?.cycleId);
  const facts = collectP2ClosureFacts(status, board, {
    ratificationCurrent,
    epochName: latestEpoch?.epochName ?? null,
    epochCurrent,
    epochSequence: latestEpoch?.sequence ?? null,
    latestClosure,
  });
  return {
    schemaVersion: P2_CLOSURE_ASSESSMENT_VERSION,
    generatedAt,
    targetId: runtime.config.project.id,
    missionVersionId: runtime.mission?.current()?.id ?? null,
    policy,
    policyHash: sha256,
    facts,
    decision: decideP2Closure(policy, facts),
    p3Deferrals: [
      'Project Intent Model compiler (AMB-003)',
      'environment adapter registry',
    ],
  };
}
