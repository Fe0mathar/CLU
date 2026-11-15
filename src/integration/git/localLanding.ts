/** Creator-confirmed local accepted branch, with Custodian receipts and exact rollback. */
import { z } from 'zod';
import { requireProofExecutionBoundary } from '../../benchmark/restrictedExecution.js';
import type { Runtime } from '../../control/runtime.js';
import type { PatchOperation } from '../../experiment/proof/executionCoordinator.js';
import { canonicalJson, hashCanonicalJson, requireSha256 } from '../../shared/ids.js';
import { redactSecretText } from '../../shared/secretSafety.js';
import { entityIdSchema, gitObjectIdSchema, sha256Schema, type EventRecord } from '../../shared/schemas.js';
import { assertActiveLandingProfile, inspectLandingEvidence, insistLanding } from './localLandingEvidence.js';
import { applyLocalLanding, inspectLocalLanding, prepareLocalLanding, revertLocalLanding, verifyLocalLanding } from './localLandingGit.js';
import { readLocalLandingPolicy } from './localLandingPolicy.js';
import { assertLandingVerificationConfigured, verifyAcceptedLanding } from './localLandingVerification.js';

export const LOCAL_LANDING_EVENTS = {
  prepared: 'landing.local_prepared',
  applied: 'landing.local_applied',
  verified: 'landing.local_verified',
  rollbackRequested: 'landing.local_rollback_requested',
  rolledBack: 'landing.local_rolled_back',
} as const;
const eventTypes: ReadonlySet<string> = new Set(Object.values(LOCAL_LANDING_EVENTS));

type LandingMode = 'apply' | 'rollback';
type Input = { readonly proofEventId: string; readonly patch: readonly PatchOperation[] };
type GitPlan = ReturnType<typeof prepareLocalLanding>;

export const localLandingScopeSchema = z.object({
  projectId: z.string().min(1), profileHash: z.string().min(1), profileGeneration: z.number().int().positive(),
  missionId: entityIdSchema, cycleId: entityIdSchema, proofEventId: entityIdSchema, proofEventSha256: sha256Schema,
  lockDigest: sha256Schema, contractHash: sha256Schema, patchDigest: sha256Schema, findingId: entityIdSchema,
  defaultBranch: z.string(), landingBranch: z.string(), baseCommit: gitObjectIdSchema, baseTree: gitObjectIdSchema,
  screenedInputsId: sha256Schema, candidateInputsId: sha256Schema,
  supervisorSha256: sha256Schema, qualificationSha256: sha256Schema,
}).strict();
type Scope = z.infer<typeof localLandingScopeSchema>;

export const localLandingPlanSchema = z.object({
  repositoryRoot: z.string(), targetRef: z.string(), landingRef: z.string(), landingBranchPrefix: z.string(),
  baseCommit: gitObjectIdSchema, baseTree: gitObjectIdSchema, acceptedCommit: gitObjectIdSchema, acceptedTree: gitObjectIdSchema,
  rollbackCommit: gitObjectIdSchema, proofId: entityIdSchema, proofTimestamp: z.string(),
}).strict();
export const localLandingCheckpointSchema = z.object({ scope: localLandingScopeSchema,
  plan: localLandingPlanSchema, digest: sha256Schema }).passthrough();
const commonPayload = localLandingCheckpointSchema;
type Body = z.infer<typeof commonPayload>;
type LandingRecord = { readonly event: EventRecord; readonly body: Body };
type History = {
  readonly prepared?: LandingRecord;
  readonly applied?: LandingRecord;
  readonly verified?: LandingRecord;
  readonly rollbackRequested?: LandingRecord;
  readonly rolledBack?: LandingRecord;
};
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

function historyOf(events: readonly EventRecord[], scope: Scope): History {
  const rows = events.filter((event) => eventTypes.has(event.type) &&
    (event.payload as { scope?: { proofEventId?: string } } | null)?.scope?.proofEventId === scope.proofEventId);
  const matching = (type: string): LandingRecord | undefined => {
    const found = rows.filter((event) => event.type === type);
    const event = found[0];
    insistLanding(found.length <= 1, 'The local landing journal contains a repeated checkpoint.');
    if (event === undefined) return undefined;
    const body = commonPayload.parse(event.payload);
    insistLanding(event.actor === 'custodian' && event.mission_version === scope.missionId && event.subject_id === scope.cycleId &&
      same(body.scope, scope) && body.digest === hashCanonicalJson({ scope: body.scope, plan: body.plan }),
    'The durable landing checkpoint no longer matches this exact review.');
    return { event, body };
  };
  const prepared = matching(LOCAL_LANDING_EVENTS.prepared);
  const applied = matching(LOCAL_LANDING_EVENTS.applied);
  const verified = matching(LOCAL_LANDING_EVENTS.verified);
  const rollbackRequested = matching(LOCAL_LANDING_EVENTS.rollbackRequested);
  const rolledBack = matching(LOCAL_LANDING_EVENTS.rolledBack);
  for (const row of [applied, verified, rollbackRequested, rolledBack]) {
    insistLanding(row === undefined || (prepared !== undefined && row.event.sequence > prepared.event.sequence &&
      row.body.digest === prepared.body.digest), 'A landing checkpoint lacks its exact earlier preparation.');
  }
  insistLanding((verified === undefined || (applied !== undefined && applied.event.sequence < verified.event.sequence)) &&
    (rollbackRequested === undefined || (applied !== undefined && applied.event.sequence < rollbackRequested.event.sequence &&
      (verified === undefined || verified.event.sequence < rollbackRequested.event.sequence))) &&
    (rolledBack === undefined || (rollbackRequested !== undefined && rollbackRequested.event.sequence < rolledBack.event.sequence)),
  'The landing verification or rollback checkpoints are out of order.');
  return { ...(prepared === undefined ? {} : { prepared }), ...(applied === undefined ? {} : { applied }),
    ...(verified === undefined ? {} : { verified }), ...(rollbackRequested === undefined ? {} : { rollbackRequested }),
    ...(rolledBack === undefined ? {} : { rolledBack }) };
}

function prepareReview(runtime: Runtime, input: Input) {
  const evidence = inspectLandingEvidence(runtime, input.proofEventId, input.patch);
  const profile = runtime.projectProfile;
  insistLanding(profile !== null, 'An exact active Project Profile is required.');
  const git = profile.profile.integrations.git;
  const prefix = runtime.config.patching.landing_branch_prefix;
  const landingBranch = prefix + evidence.cycle.id.toLowerCase() + '-' + evidence.proof.id.toLowerCase();
  const policy = readLocalLandingPolicy(runtime, evidence.lock, evidence.events, evidence.screened.snapshot_id,
    evidence.contract, evidence.change.path, evidence.original, evidence.content, input.proofEventId);
  const scope = localLandingScopeSchema.parse({
    projectId: profile.profile.projectId, profileHash: profile.projectProfileHash, profileGeneration: profile.generation,
    missionId: evidence.cycle.mission_version, cycleId: evidence.cycle.id, proofEventId: evidence.proof.id,
    proofEventSha256: evidence.proof.hash, lockDigest: evidence.lock.digest, contractHash: evidence.accepted.contract_hash,
    patchDigest: evidence.accepted.patch_digest, findingId: policy.approvedFindingId,
    defaultBranch: evidence.base.branch, landingBranch, baseCommit: evidence.base.commit, baseTree: evidence.base.tree,
    screenedInputsId: evidence.screened.inputs.id, candidateInputsId: evidence.candidate.inputs.id,
    supervisorSha256: evidence.candidate.execution_boundary.sha256,
    qualificationSha256: evidence.candidate.execution_boundary.qualificationSha256,
  });
  const history = historyOf(evidence.events, scope);
  const minPassingTests = evidence.candidate.result.measures.find(({ id }) => id === 'SIG-012')?.value;
  const maxSkippedTests = evidence.candidate.result.measures.find(({ id }) => id === 'SIG-013')?.value;
  insistLanding(minPassingTests !== undefined && Number.isSafeInteger(minPassingTests) && minPassingTests > 0 &&
    maxSkippedTests !== undefined && Number.isSafeInteger(maxSkippedTests) && maxSkippedTests >= 0,
  'The accepted candidate has no complete SCN-006 regression count.');
  const boundary = evidence.candidate.execution_boundary;
  const verification = {
    before: evidence.screened.inputs, candidate: evidence.candidate.inputs, path: evidence.change.path,
    content: evidence.content, boundary: { ...boundary, sha256: requireSha256(boundary.sha256, 'landing supervisor'),
      qualificationSha256: requireSha256(boundary.qualificationSha256, 'landing qualification') },
    timeoutSeconds: policy.verifyTimeoutSeconds, verifyCommands: policy.verifyCommands, minPassingTests, maxSkippedTests,
  };
  assertLandingVerificationConfigured(runtime, verification);
  const preparation = {
    repositoryRoot: git.repositoryRoot, targetBranch: evidence.base.branch, landingBranchPrefix: prefix, landingBranch,
    baseCommit: evidence.base.commit, baseTree: evidence.base.tree, proofId: evidence.proof.id, proofTimestamp: evidence.proof.timestamp,
    operations: [{ op: 'write' as const, path: evidence.change.path, content: evidence.content,
      sha256: evidence.change.sha256, baseSha256: evidence.before.hash }],
  };
  return { scope, history, verification, preparation };
}

const confirmationFor = (mode: LandingMode, scope: Scope): string => {
  const digest = hashCanonicalJson({ mode, scope });
  return `${mode === 'apply' ? 'LAND LOCAL' : 'ROLLBACK LOCAL'} ${scope.proofEventId} ${digest.slice(0, 16)}`;
};

export function previewAcceptedLanding(runtime: Runtime, input: Input) {
  const { scope, history } = prepareReview(runtime, input);
  const observation = history.prepared === undefined ? null : inspectLocalLanding(history.prepared.body.plan);
  return {
    schemaVersion: 'clue-local-landing/1', scope,
    stage: history.rolledBack ? 'ROLLED_BACK' : history.rollbackRequested ? 'ROLLBACK_PENDING'
      : history.verified ? 'VERIFIED' : history.applied ? 'VERIFICATION_PENDING' : history.prepared ? 'PREPARED' : 'READY',
    observation,
    applyConfirmation: confirmationFor('apply', scope),
    rollbackConfirmation: history.applied === undefined ? null : confirmationFor('rollback', scope),
  };
}

function receiptEvent(runtime: Runtime, type: string, body: Body, details?: unknown): EventRecord {
  const log = runtime.requireLog();
  const event = log.append({ type, actor: 'custodian', missionVersion: body.scope.missionId,
    subjectId: body.scope.cycleId, payload: { ...body, ...(details === undefined ? {} : { details }) },
    ...(runtime.projectIdentity === null ? {} : { operationIdentity: runtime.projectIdentity }) });
  runtime.projections.sync(log);
  return event;
}

function asCustodian<T>(runtime: Runtime, scope: Scope, target: string, command: string, work: () => T): T {
  assertActiveLandingProfile(runtime);
  const capability = 'git.land.canonical';
  const token = runtime.policy.issueToken('custodian', [capability], {
    ttlMs: 60_000, subjectId: scope.proofEventId, purpose: command,
  });
  try {
    return runtime.dispatcher.run({ actor: 'custodian', capability, target, gitRef: scope.landingBranch,
      command, tokenSecret: token.secret, subjectId: scope.proofEventId, purpose: command, args: scope }, work);
  } finally {
    runtime.policy.revokeToken(token.secret);
  }
}

export async function executeAcceptedLanding(runtime: Runtime, input: Input & {
  readonly mode: LandingMode;
  readonly confirmation: string;
}) {
  const { scope, history, verification, preparation } = prepareReview(runtime, input);
  insistLanding(input.confirmation === confirmationFor(input.mode, scope),
    'Use the exact confirmation displayed by landing preview.');
  const root = preparation.repositoryRoot;
  const act = <T>(name: string, work: () => T): T => asCustodian(runtime, scope, root, name, work);
  const record = (type: string, body: Body, details?: unknown): EventRecord => receiptEvent(runtime, type, body, details);
  const response = (state: 'VERIFIED' | 'ROLLED_BACK', event: EventRecord, plan: GitPlan) => ({
    schemaVersion: 'clue-local-landing/1', state, scope, plan, eventId: event.id, eventSha256: event.hash,
    details: (event.payload as { details?: unknown }).details ?? null,
  });
  if (history.rolledBack !== undefined) {
    const plan = history.rolledBack.body.plan;
    verifyLocalLanding(plan, 'rolled_back');
    return response('ROLLED_BACK', history.rolledBack.event, plan);
  }
  if (input.mode === 'apply' && history.verified !== undefined && history.rollbackRequested === undefined) {
    const plan = history.verified.body.plan;
    verifyLocalLanding(plan, 'applied');
    return response('VERIFIED', history.verified.event, plan);
  }
  if (input.mode === 'rollback') {
    insistLanding(history.applied !== undefined, 'No durable local application is available to roll back.');
  }
  if (input.mode === 'apply' && history.rollbackRequested === undefined) {
    const boundary = requireProofExecutionBoundary();
    insistLanding(same(boundary, verification.boundary), 'The active Windows supervisor qualification differs from the accepted proof.');
    insistLanding(process.env['CLU_OFFLINE_NPM_CACHE'] !== undefined,
      'The native verifier requires the reviewed offline npm cache from the proof session.');
  }

  const plan = act('landing.local.prepare', () => prepareLocalLanding(preparation));
  const body = commonPayload.parse({ scope, plan, digest: hashCanonicalJson({ scope, plan }) });
  if (history.prepared === undefined) record(LOCAL_LANDING_EVENTS.prepared, body);
  else insistLanding(history.prepared.body.digest === body.digest, 'Rebuilding the exact Git plan produced a different identity.');
  if (input.mode === 'rollback' || history.rollbackRequested !== undefined) {
    if (history.rollbackRequested === undefined) record(LOCAL_LANDING_EVENTS.rollbackRequested, body, { cause: 'creator' });
    const observation = act('landing.local.rollback', () => revertLocalLanding(plan));
    verifyLocalLanding(plan, 'rolled_back');
    return response('ROLLED_BACK', record(LOCAL_LANDING_EVENTS.rolledBack, body, observation), plan);
  }

  const applied = history.applied === undefined
    ? act('landing.local.apply', () => applyLocalLanding(plan))
    : verifyLocalLanding(plan, 'applied');
  if (history.applied === undefined) record(LOCAL_LANDING_EVENTS.applied, body, applied);
  let verificationChecks;
  try {
    verificationChecks = await verifyAcceptedLanding(runtime, verification);
    assertActiveLandingProfile(runtime);
    verifyLocalLanding(plan, 'applied');
  } catch (error) {
    const reason = redactSecretText(error instanceof Error ? error.message : String(error)).text.slice(0, 1024);
    record(LOCAL_LANDING_EVENTS.rollbackRequested, body, { cause: 'post_land_verification_failed', reason });
    const observation = act('landing.local.rollback', () => revertLocalLanding(plan));
    verifyLocalLanding(plan, 'rolled_back');
    return response('ROLLED_BACK', record(LOCAL_LANDING_EVENTS.rolledBack, body, { observation, reason }), plan);
  }
  return response('VERIFIED', record(LOCAL_LANDING_EVENTS.verified, body, { checks: verificationChecks }), plan);
}
