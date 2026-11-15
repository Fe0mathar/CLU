/** Publish one exact, locally verified proof commit to a registered GitHub accepted branch. */
import { z } from 'zod';
import type { Runtime } from '../../control/runtime.js';
import { PROOF_EVENT_TYPES } from '../../proof/proofContract.js';
import { canonicalJson, hashBytes, hashCanonicalJson, requireSha256 } from '../../shared/ids.js';
import { resolveTargetRootIdentity } from '../../shared/pathIdentity.js';
import { artifactRefSchema, entityIdSchema, gitObjectIdSchema, isoTimestampSchema, sha256Schema,
  type EventRecord } from '../../shared/schemas.js';
import { createAcceptedPublicationGit, inspectAcceptedPublicationHost, normalizeAcceptedGitHubRemote } from './acceptedPublicationGit.js';
import { LOCAL_LANDING_EVENTS, localLandingCheckpointSchema } from './localLanding.js';
import { assertActiveLandingProfile, inspectLandingEvidence, insistLanding, landingJournal } from './localLandingEvidence.js';
import { readLocalAcceptedWrite, verifyLocalLanding } from './localLandingGit.js';

export const ACCEPTED_PUBLICATION_EVENTS = {
  requested: 'publication.accepted_requested',
  deferred: 'publication.accepted_deferred',
  verified: 'publication.accepted_verified',
} as const;

const check = (name: string) => z.object({ name: z.literal(name), durationMs: z.number().int().nonnegative() }).strict();
const verifiedCheckpoint = localLandingCheckpointSchema.extend({ details: z.object({
  checks: z.tuple([check('dependency_install'), check('typecheck'), check('build'), check('regression_suite')]),
}).strict() }).strict();
const proofWrite = z.object({
  change_set: z.tuple([z.object({ op: z.literal('write'), path: z.string().min(1),
    sha256: sha256Schema, bytes: z.number().int().positive().max(16 * 1024 * 1024) }).strict()]),
});
const operationSchema = z.object({
  schemaVersion: z.literal('clue-accepted-publication/1'), provider: z.literal('github'),
  classification: z.literal('PROJECT_REMOTE'), layer: z.literal('SOURCE_BRANCH'),
  projectId: z.string().min(1), profileGeneration: z.number().int().positive(), profileHash: z.string().min(1),
  targetRootIdentity: z.string().min(1), missionId: entityIdSchema, cycleId: entityIdSchema,
  proofEventId: entityIdSchema, proofEventSha256: sha256Schema, verdictArtifactSha256: sha256Schema,
  landingEventId: entityIdSchema, landingEventSha256: sha256Schema, landingDigest: sha256Schema,
  remote: z.string().min(1), localRef: z.string().min(1), remoteRef: z.string().min(1),
  remoteBaseRef: z.string().min(1), expectedRemoteBaseCommit: gitObjectIdSchema,
  expectedRemoteOldCommit: z.null(), commit: gitObjectIdSchema, tree: gitObjectIdSchema,
}).strict();
type Operation = z.infer<typeof operationSchema>;

const eventIdentity = z.object({ operation: operationSchema, operationSha256: sha256Schema }).strict();
const requestPayload = eventIdentity.extend({ confirmedAt: isoTimestampSchema,
  approval: z.literal('CREATOR_CONFIRMED_SOURCE_BRANCH') }).strict();
const deferredPayload = eventIdentity.extend({ requestEventId: entityIdSchema, requestEventSha256: sha256Schema,
  code: z.string().regex(/^PUBLICATION_[A-Z0-9_]{1,80}$/u) }).strict();
const dispositionSchema = z.enum(['CREATED', 'ALREADY_PRESENT', 'RECOVERED']);
const completedPayload = eventIdentity.extend({
  requestEventId: entityIdSchema, requestEventSha256: sha256Schema,
  observedAt: isoTimestampSchema, disposition: dispositionSchema,
  remoteCommit: gitObjectIdSchema, remoteBaseCommit: gitObjectIdSchema,
  response: artifactRefSchema,
}).strict();
const responseSchema = z.object({
  schemaVersion: z.literal('clue-accepted-publication-observation/1'), remote: z.string().min(1), ref: z.string().min(1),
  commit: gitObjectIdSchema, baseRef: z.string().min(1), baseCommit: gitObjectIdSchema,
  disposition: dispositionSchema, observedAt: isoTimestampSchema,
}).strict();

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

function validateReceiptOrder(events: readonly EventRecord[], operation: Operation, operationSha256: string) {
  const candidates = events.filter((event) => Object.values(ACCEPTED_PUBLICATION_EVENTS).some((type) => type === event.type) &&
    (event.payload as { operation?: { proofEventId?: string } } | null)?.operation?.proofEventId === operation.proofEventId);
  const requests = candidates.filter(({ type }) => type === ACCEPTED_PUBLICATION_EVENTS.requested);
  const completed = candidates.filter(({ type }) => type === ACCEPTED_PUBLICATION_EVENTS.verified);
  const [request] = requests;
  const [verified] = completed;
  for (const event of candidates) {
    const body = eventIdentity.passthrough().parse(event.payload);
    const actor = event.type === ACCEPTED_PUBLICATION_EVENTS.requested ? 'creator' : 'custodian';
    insistLanding(event.actor === actor && event.mission_version === operation.missionId &&
      event.subject_id === operation.cycleId && operationSha256 === body.operationSha256 && same(operation, body.operation),
    'An existing publication receipt belongs to a different project, proof, commit or destination.');
    if (event.type === ACCEPTED_PUBLICATION_EVENTS.deferred) {
      const deferred = deferredPayload.parse(event.payload);
      insistLanding(deferred.requestEventId === request?.id && deferred.requestEventSha256 === request?.hash,
        'A deferred publication does not bind its original authorization.');
    }
  }
  insistLanding(requests.length <= 1 && completed.length <= 1 &&
    (request !== undefined || candidates.length === 0) &&
    candidates.every((event) => event === request || (request !== undefined && event.sequence > request.sequence &&
      (verified === undefined || event === verified || event.sequence < verified.sequence))),
  'The publication journal contains an inconsistent request or result history.');
  if (request !== undefined) requestPayload.parse(request.payload);
  if (verified === undefined) return { request, verified: undefined, receipt: undefined };
  const receipt = completedPayload.parse(verified.payload);
  insistLanding(receipt.requestEventId === request?.id && receipt.requestEventSha256 === request?.hash &&
    receipt.remoteCommit === operation.commit && receipt.remoteBaseCommit === operation.expectedRemoteBaseCommit,
  'The publication result does not confirm the approved GitHub reference.');
  return { request, verified, receipt };
}

function reviewAcceptedPublication(runtime: Runtime, proofEventId: string) {
  const events = landingJournal(runtime);
  const proof = events.find((event) => event.id === proofEventId);
  insistLanding(proof?.type === PROOF_EVENT_TYPES.verdictRecorded &&
    (proof.payload as { disposition?: string } | null)?.disposition === 'ACCEPT',
  'GitHub publication needs an ACCEPT verdict and a verified P43 landing.');
  const profile = runtime.projectProfile;
  insistLanding(profile !== null, 'Publication requires the active saved Project Profile.');
  assertActiveLandingProfile(runtime);
  const git = profile.profile.integrations.git;
  insistLanding(git.publicationMode === 'REMOTE_REGISTERED' && git.provider === 'github' && git.remote !== null,
    'The active Project Profile must register a GitHub remote for source publication.');
  const remote = normalizeAcceptedGitHubRemote(git.remote);

  const forProof = events.filter((event) => (event.payload as { scope?: { proofEventId?: string } } | null)
    ?.scope?.proofEventId === proof.id && Object.values(LOCAL_LANDING_EVENTS).some((type) => type === event.type));
  const exactlyOne = (type: string) => {
    const rows = forProof.filter((event) => event.type === type);
    const result = rows[0];
    insistLanding(rows.length === 1 && result !== undefined, 'Publication requires a complete, verified P43 landing.');
    return result;
  };
  const prepared = exactlyOne(LOCAL_LANDING_EVENTS.prepared);
  const applied = exactlyOne(LOCAL_LANDING_EVENTS.applied);
  const verified = exactlyOne(LOCAL_LANDING_EVENTS.verified);
  const { plan, scope, digest } = verifiedCheckpoint.parse(verified.payload);
  insistLanding(forProof.length === 3 && proof.sequence < prepared.sequence && prepared.sequence < applied.sequence &&
    applied.sequence < verified.sequence && [prepared, applied, verified].every(
      (event) => event.actor === 'custodian' && event.subject_id === proof.subject_id &&
        event.mission_version === proof.mission_version),
  'The active proof has an invalid landing sequence or a pending or completed rollback.');
  for (const event of [prepared, applied]) {
    const body = localLandingCheckpointSchema.parse(event.payload);
    insistLanding(same({ scope, plan, digest }, { scope: body.scope, plan: body.plan, digest: body.digest }),
      'P43 landing checkpoints do not agree on the accepted commit.');
  }
  insistLanding(digest === hashCanonicalJson({ scope, plan }) && scope.proofEventId === proof.id &&
    scope.proofEventSha256 === proof.hash && scope.projectId === profile.profile.projectId &&
    scope.profileHash === profile.projectProfileHash && scope.profileGeneration === profile.generation &&
    scope.missionId === proof.mission_version && scope.cycleId === proof.subject_id &&
    scope.defaultBranch === git.defaultBranch && plan.targetRef === 'refs/heads/' + scope.defaultBranch &&
    plan.landingRef === 'refs/heads/' + scope.landingBranch && plan.baseCommit === scope.baseCommit &&
    plan.baseTree === scope.baseTree && plan.proofId === proof.id && plan.proofTimestamp === proof.timestamp &&
    resolveTargetRootIdentity(plan.repositoryRoot) === profile.profile.targetRootIdentity &&
    resolveTargetRootIdentity(git.repositoryRoot) === profile.profile.targetRootIdentity &&
    plan.landingBranchPrefix === runtime.config.patching.landing_branch_prefix,
  'The prior local operation no longer matches the active profile, accepted branch or proof parent.');

  const [provedWrite] = proofWrite.parse(proof.payload).change_set;
  const bytes = readLocalAcceptedWrite(plan, provedWrite.path);
  insistLanding(hashBytes(bytes) === provedWrite.sha256 && bytes.length === provedWrite.bytes,
    'The locally committed blob does not reproduce the accepted source bytes.');
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  insistLanding(runtime.secrets.redact(content) === content, 'The proposed source contains registered or credential-shaped secret material.');
  const evidence = inspectLandingEvidence(runtime, proof.id, [{ op: 'write', path: provedWrite.path, content }]);
  insistLanding(scope.contractHash === evidence.accepted.contract_hash && scope.patchDigest === evidence.accepted.patch_digest &&
    scope.lockDigest === evidence.lock.digest && scope.candidateInputsId === evidence.candidate.inputs.id &&
    scope.screenedInputsId === evidence.screened.inputs.id &&
    scope.supervisorSha256 === evidence.candidate.execution_boundary.sha256 &&
    scope.qualificationSha256 === evidence.candidate.execution_boundary.qualificationSha256,
  'The local landing receipt does not reproduce the current proof inputs and verifier.');
  const operation = operationSchema.parse({
    schemaVersion: 'clue-accepted-publication/1', provider: 'github', classification: 'PROJECT_REMOTE', layer: 'SOURCE_BRANCH',
    projectId: scope.projectId, profileHash: scope.profileHash, profileGeneration: scope.profileGeneration,
    targetRootIdentity: profile.profile.targetRootIdentity, missionId: scope.missionId, cycleId: scope.cycleId,
    proofEventId: proof.id, proofEventSha256: proof.hash, verdictArtifactSha256: evidence.accepted.artifacts.verdict.hash,
    landingEventId: verified.id, landingEventSha256: verified.hash, landingDigest: digest, remote,
    localRef: plan.landingRef, remoteRef: plan.landingRef, remoteBaseRef: plan.targetRef,
    expectedRemoteBaseCommit: plan.baseCommit, expectedRemoteOldCommit: null, commit: plan.acceptedCommit, tree: plan.acceptedTree,
  });
  const operationSha256 = hashCanonicalJson(operation);
  const history = validateReceiptOrder(events, operation, operationSha256);
  if (history.receipt !== undefined) {
    const ref = history.receipt.response;
    const raw = runtime.artifacts.getBytes(requireSha256(ref.hash, 'publication response'));
    const response = responseSchema.parse(JSON.parse(raw.toString('utf8')));
    insistLanding(raw.length === ref.bytes && response.remote === operation.remote && response.ref === operation.remoteRef &&
      response.commit === operation.commit && response.baseRef === operation.remoteBaseRef &&
      response.baseCommit === operation.expectedRemoteBaseCommit && response.disposition === history.receipt.disposition &&
      response.observedAt === history.receipt.observedAt,
    'The stored publication observation differs from its verified GitHub receipt.');
  }
  return { operation, operationSha256, plan, history };
}

function confirmationFor(operation: Operation, digest: string): string {
  return `PUBLISH SOURCE ${operation.proofEventId} ${digest.slice(0, 16)}`;
}

/** Local inspection only. The push command checks the remote after receiving this confirmation. */
export function previewAcceptedPublication(runtime: Runtime, proofEventId: string) {
  const { operation, operationSha256, history } = reviewAcceptedPublication(runtime, proofEventId);
  return {
    operation, operationSha256, state: history.verified ? 'RECORDED' : history.request ? 'PENDING_REMOTE' : 'READY',
    requestEventId: history.request?.id ?? null, verifiedEventId: history.verified?.id ?? null,
    confirmation: confirmationFor(operation, operationSha256), host: inspectAcceptedPublicationHost(),
  };
}

function recordPublication(runtime: Runtime, operation: Operation, type: string, payload: unknown): EventRecord {
  const log = runtime.requireLog();
  const identity = runtime.projectIdentity;
  insistLanding(identity !== null, 'Publication requires a bound Project Profile workspace.');
  const actor = type === ACCEPTED_PUBLICATION_EVENTS.requested ? 'creator' : 'custodian';
  const event = log.append({ type, actor, missionVersion: operation.missionId,
    subjectId: operation.cycleId, payload, operationIdentity: identity });
  runtime.projections.sync(log);
  return event;
}

export async function publishAcceptedSource(runtime: Runtime, proofEventId: string, confirmation: string) {
  const { operation, operationSha256, plan, history } = reviewAcceptedPublication(runtime, proofEventId);
  insistLanding(confirmation === confirmationFor(operation, operationSha256),
    'Use the exact PUBLISH SOURCE confirmation displayed by publication preview.');
  const identity = { operation, operationSha256 };
  const record = (type: string, payload: unknown) => recordPublication(runtime, operation, type, payload);
  const command = 'publication.push.accepted';
  const capability = 'git.push.accepted';
  const token = runtime.policy.issueToken('custodian', [capability], {
    ttlMs: 60_000, subjectId: proofEventId, purpose: command,
  });
  try {
    return await runtime.dispatcher.runAsync({
      actor: 'custodian', capability, target: plan.repositoryRoot, gitRef: plan.landingRef.slice('refs/heads/'.length),
      command, subjectId: proofEventId, purpose: command, tokenSecret: token.secret, args: operation,
    }, async () => {
      assertActiveLandingProfile(runtime);
      verifyLocalLanding(plan, 'applied');
      if (history.verified !== undefined) {
        const transport = createAcceptedPublicationGit(plan, operation.remote, () => assertActiveLandingProfile(runtime));
        const observed = await transport.inspect();
        insistLanding(observed.commit === operation.commit, 'The recorded remote branch is missing or has moved.');
        return { state: 'VERIFIED', ...identity, eventId: history.verified.id, eventSha256: history.verified.hash,
          requestEventId: history.request?.id, disposition: history.receipt?.disposition };
      }
      const request = history.request ?? record(ACCEPTED_PUBLICATION_EVENTS.requested,
        requestPayload.parse({ ...identity, confirmedAt: new Date().toISOString(), approval: 'CREATOR_CONFIRMED_SOURCE_BRANCH' }));
      let observation;
      try {
        const transport = createAcceptedPublicationGit(plan, operation.remote, () => assertActiveLandingProfile(runtime));
        observation = await transport.publish(operation.expectedRemoteOldCommit);
      } catch (error) {
        const source = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
        const code = typeof source === 'string' && /^PUBLICATION_[A-Z0-9_]{1,80}$/u.test(source)
          ? source : 'PUBLICATION_TRANSPORT_UNAVAILABLE';
        const deferred = record(ACCEPTED_PUBLICATION_EVENTS.deferred,
          deferredPayload.parse({ ...identity, requestEventId: request.id, requestEventSha256: request.hash, code }));
        return { state: 'PENDING_REMOTE', ...identity, code, eventId: deferred.id, eventSha256: deferred.hash,
          requestEventId: request.id };
      }

      assertActiveLandingProfile(runtime);
      verifyLocalLanding(plan, 'applied');
      const observedAt = new Date().toISOString();
      const disposition = history.request !== undefined && observation.disposition === 'ALREADY_PRESENT'
        ? 'RECOVERED' : observation.disposition;
      const response = responseSchema.parse({
        schemaVersion: 'clue-accepted-publication-observation/1', remote: observation.remote, ref: observation.ref,
        commit: observation.commit, baseRef: observation.baseRef, baseCommit: observation.baseCommit,
        disposition, observedAt,
      });
      insistLanding(response.remote === operation.remote && response.ref === operation.remoteRef &&
        response.commit === operation.commit && response.baseRef === operation.remoteBaseRef &&
        response.baseCommit === operation.expectedRemoteBaseCommit, 'GitHub did not confirm the exact reviewed result.');
      const artifact = runtime.artifacts.putJson(response, { label: proofEventId + '-github-observation.json' });
      const verified = record(ACCEPTED_PUBLICATION_EVENTS.verified, completedPayload.parse({
        ...identity, requestEventId: request.id, requestEventSha256: request.hash, observedAt,
        disposition, remoteCommit: response.commit, remoteBaseCommit: response.baseCommit, response: artifact,
      }));
      return { state: 'VERIFIED', ...identity, eventId: verified.id, eventSha256: verified.hash,
        requestEventId: request.id, disposition };
    });
  } finally {
    runtime.policy.revokeToken(token.secret);
  }
}
