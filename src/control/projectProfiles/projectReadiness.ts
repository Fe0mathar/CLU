/**
 * Operation-specific Project Profile readiness aggregation.
 *
 * One global green flag is deliberately insufficient. Each requested capability is evaluated
 * independently and every result is bound to one exact Project Profile generation. A missing
 * remote is a legitimate READY_LOCAL_ONLY state for local recognition/proof, while required
 * browser or AI integrations fail only the operations that actually depend on them.
 */

import {
  assertProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import {
  projectProfileRecordSchema,
  type ProjectProfileRecord,
} from '../../shared/schemas.js';
import type { AuthorityConflictAssessment } from './authorityConflict.js';
import type { ResolvedProjectBenchmarkRuntime } from './benchmarkRuntime.js';
import type { ProjectBrowserReadiness } from './browserReadiness.js';
import type { ProjectGatewayReadiness } from './gatewayReadiness.js';
import type { ProjectGitReadiness } from './gitReadiness.js';
import type { ProjectHostReadiness } from './hostReadiness.js';
import {
  assertProjectProfileHash,
  computeProjectBenchmarkRuntimeHash,
  computeProjectRecognitionHash,
} from './profileHash.js';
import type { ProjectAuthoritySnapshot } from './projectAuthority.js';
import type { ResolvedProjectRecognitionConfiguration } from './projectRecognition.js';

export const PROJECT_READINESS_LEVELS = [
  'READY',
  'READY_LOCAL_ONLY',
  'INCOMPLETE',
  'BLOCKED',
  'INVALID',
] as const;
export type ProjectReadinessLevel = (typeof PROJECT_READINESS_LEVELS)[number];

export const PROJECT_CAPABILITY_STATES = [
  'READY',
  'READY_LOCAL_ONLY',
  'NOT_REQUIRED',
  'INCOMPLETE',
  'BLOCKED',
  'INVALID',
] as const;
export type ProjectCapabilityState = (typeof PROJECT_CAPABILITY_STATES)[number];

export interface ProjectCapabilityReadiness {
  readonly state: ProjectCapabilityState;
  readonly ready: boolean;
  readonly required: boolean;
  readonly code: string;
  readonly detail: string;
}

export interface ProjectReadinessRequirements {
  readonly recognition: boolean;
  readonly proof: boolean;
  readonly browserBenchmark: boolean;
  readonly aiCandidateGeneration: boolean;
  readonly gitPublication: boolean;
  readonly custodianLanding: boolean;
}

export const DEFAULT_LOCAL_PROOF_REQUIREMENTS: ProjectReadinessRequirements = Object.freeze({
  recognition: true,
  proof: true,
  browserBenchmark: false,
  aiCandidateGeneration: false,
  gitPublication: false,
  custodianLanding: false,
});

export interface ProjectReadinessInput {
  readonly record: ProjectProfileRecord;
  readonly authority: ProjectAuthoritySnapshot;
  readonly authorityConflicts: AuthorityConflictAssessment;
  readonly benchmarkRuntime: ResolvedProjectBenchmarkRuntime;
  readonly recognition: ResolvedProjectRecognitionConfiguration | null;
  readonly recognitionError?: { readonly code: string; readonly detail: string } | null;
  readonly host: ProjectHostReadiness | null;
  readonly git: ProjectGitReadiness | null;
  readonly browser: ProjectBrowserReadiness | null;
  readonly gateway: ProjectGatewayReadiness | null;
  readonly metricCatalogueValid: boolean;
  readonly metricCatalogueDetail?: string;
  readonly custodianLandingConfigured?: boolean;
  readonly requirements?: Partial<ProjectReadinessRequirements>;
  readonly checkedAt?: string;
}

export interface ProjectReadinessAssessment {
  readonly assessmentVersion: 'clue-project-readiness/1';
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly level: ProjectReadinessLevel;
  readonly readyForLocalWork: boolean;
  readonly readyForRequestedOperations: boolean;
  readonly requirements: ProjectReadinessRequirements;
  readonly authorityState: ProjectAuthoritySnapshot['state'];
  readonly authorityConflictState: AuthorityConflictAssessment['state'];
  readonly benchmarkRuntimeState: ResolvedProjectBenchmarkRuntime['state'];
  readonly capabilities: {
    readonly projectIdentity: ProjectCapabilityReadiness;
    readonly targetRoot: ProjectCapabilityReadiness;
    readonly authority: ProjectCapabilityReadiness;
    readonly recognition: ProjectCapabilityReadiness;
    readonly host: ProjectCapabilityReadiness;
    readonly gitLocal: ProjectCapabilityReadiness;
    readonly proof: ProjectCapabilityReadiness;
    readonly browserBenchmark: ProjectCapabilityReadiness;
    readonly aiCandidateGeneration: ProjectCapabilityReadiness;
    readonly gitPublication: ProjectCapabilityReadiness;
    readonly custodianLanding: ProjectCapabilityReadiness;
    readonly metricCatalogue: ProjectCapabilityReadiness;
  };
  readonly blockers: readonly string[];
  readonly checkedAt: string;
}

export function assessProjectReadiness(input: ProjectReadinessInput): ProjectReadinessAssessment {
  const record = projectProfileRecordSchema.parse(input.record);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  const identity = operationIdentityFromProfileRecord(record);
  assertReadinessInputsBelongToProfile(record, identity, input);
  const requirements: ProjectReadinessRequirements = Object.freeze({
    ...DEFAULT_LOCAL_PROOF_REQUIREMENTS,
    ...input.requirements,
    browserBenchmark:
      input.requirements?.browserBenchmark ?? input.benchmarkRuntime.browserRequired,
  });

  const projectIdentity = ready(true, 'PROJECT_IDENTITY_VALID', 'Project Profile identity and deterministic hash are valid.');
  const targetRoot = ready(true, 'TARGET_ROOT_VALID', `Target Root identity is ${identity.targetRootIdentity}.`);
  const authority = authorityCapability(input.authority, input.authorityConflicts);
  const recognition = recognitionCapability(input, requirements.recognition);
  const host = hostCapability(input.host);
  const gitLocal = gitLocalCapability(input.git);
  const metricCatalogue = input.metricCatalogueValid
    ? ready(true, 'METRIC_CATALOGUE_VALID', input.metricCatalogueDetail ?? 'Metric Catalogue is valid.')
    : invalid(true, 'METRIC_CATALOGUE_INVALID', input.metricCatalogueDetail ?? 'Metric Catalogue validation failed.');

  const proof = proofCapability(
    requirements.proof,
    authority,
    recognition,
    input.benchmarkRuntime,
    metricCatalogue,
  );
  const browserBenchmark = browserCapability(requirements.browserBenchmark, input.browser);
  const aiCandidateGeneration = gatewayCapability(requirements.aiCandidateGeneration, input.gateway);
  const gitPublication = publicationCapability(requirements.gitPublication, input.git);
  const custodianLanding = input.custodianLandingConfigured === true
    ? ready(requirements.custodianLanding, 'CUSTODIAN_LANDING_READY', 'Custodian landing is configured.')
    : requirements.custodianLanding
      ? incomplete(true, 'CUSTODIAN_LANDING_NOT_CONFIGURED', 'Custodian landing is required but not configured.')
      : notRequired('CUSTODIAN_LANDING_NOT_REQUIRED', 'Custodian landing is not required for the requested operation.');

  const capabilities = Object.freeze({
    projectIdentity,
    targetRoot,
    authority,
    recognition,
    host,
    gitLocal,
    proof,
    browserBenchmark,
    aiCandidateGeneration,
    gitPublication,
    custodianLanding,
    metricCatalogue,
  });
  const required = Object.entries(capabilities)
    .filter(([, item]) => item.required)
    .map(([name, item]) => ({ name, item }));
  const blockers = required
    .filter(({ item }) => !item.ready)
    .map(({ name, item }) => `${name}: ${item.code} — ${item.detail}`);
  const readyForLocalWork =
    projectIdentity.ready &&
    targetRoot.ready &&
    authority.ready &&
    recognition.ready &&
    gitLocal.ready &&
    proof.ready &&
    metricCatalogue.ready;
  const level = overallLevel(required.map(({ item }) => item), input.git, readyForLocalWork);

  return Object.freeze({
    assessmentVersion: 'clue-project-readiness/1',
    projectIdentity: identity,
    profileGeneration: record.generation,
    level,
    readyForLocalWork,
    readyForRequestedOperations: blockers.length === 0,
    requirements,
    authorityState: input.authority.state,
    authorityConflictState: input.authorityConflicts.state,
    benchmarkRuntimeState: input.benchmarkRuntime.state,
    capabilities,
    blockers: Object.freeze(blockers),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  });
}


function assertReadinessInputsBelongToProfile(
  record: ProjectProfileRecord,
  identity: ProjectOperationIdentity,
  input: ProjectReadinessInput,
): void {
  assertProjectOperationIdentity(identity, input.authority.operationIdentity, 'Project Authority readiness');
  if (input.authority.profileGeneration !== record.generation) {
    throw new Error(
      `Project Authority readiness: profile generation ${input.authority.profileGeneration} does not match active generation ${record.generation}`,
    );
  }
  if (input.authority.manifest !== null) {
    assertProjectOperationIdentity(
      identity,
      input.authority.manifest.operationIdentity,
      'Project Authority manifest readiness',
    );
    if (input.authority.manifest.profileGeneration !== record.generation) {
      throw new Error(
        `Project Authority manifest readiness: profile generation ${input.authority.manifest.profileGeneration} does not match active generation ${record.generation}`,
      );
    }
  }

  const expectedRecognitionHash = computeProjectRecognitionHash(record.profile);
  if (input.authority.recognitionConfigHash !== expectedRecognitionHash) {
    throw new Error('Project Authority readiness: recognition configuration hash does not match the active Project Profile.');
  }
  if (input.recognition !== null) {
    assertProjectOperationIdentity(
      identity,
      input.recognition.identity.operationIdentity,
      'Project recognition readiness',
    );
    if (input.recognition.identity.profileGeneration !== record.generation) {
      throw new Error(
        `Project recognition readiness: profile generation ${input.recognition.identity.profileGeneration} does not match active generation ${record.generation}`,
      );
    }
    if (
      input.recognition.identity.recognitionConfigHash !== expectedRecognitionHash ||
      input.recognition.recognitionConfigHash !== expectedRecognitionHash
    ) {
      throw new Error('Project recognition readiness: recognition configuration hash does not match the active Project Profile.');
    }
  }

  const expectedBenchmarkRuntimeHash = computeProjectBenchmarkRuntimeHash(record.profile);
  if (
    input.benchmarkRuntime.projectId !== identity.projectId ||
    input.benchmarkRuntime.targetRootIdentity !== identity.targetRootIdentity ||
    input.benchmarkRuntime.runtimeHash !== expectedBenchmarkRuntimeHash
  ) {
    throw new Error('Project benchmark readiness: runtime identity does not match the active Project Profile.');
  }

  if (input.host?.binding !== null && input.host?.binding !== undefined) {
    assertProjectOperationIdentity(identity, input.host.binding.projectIdentity, 'Project host readiness');
  }
  if (input.git !== null) {
    assertProjectOperationIdentity(identity, input.git.projectIdentity, 'Project Git readiness');
  }
  if (input.browser !== null) {
    assertProjectOperationIdentity(identity, input.browser.projectIdentity, 'Project browser readiness');
    if (input.browser.profileGeneration !== record.generation) {
      throw new Error(
        `Project browser readiness: profile generation ${input.browser.profileGeneration} does not match active generation ${record.generation}`,
      );
    }
  }
  if (input.gateway !== null) {
    assertProjectOperationIdentity(identity, input.gateway.projectIdentity, 'Project gateway readiness');
    if (input.gateway.profileGeneration !== record.generation) {
      throw new Error(
        `Project gateway readiness: profile generation ${input.gateway.profileGeneration} does not match active generation ${record.generation}`,
      );
    }
  }
}

function authorityCapability(
  snapshot: ProjectAuthoritySnapshot,
  conflicts: AuthorityConflictAssessment,
): ProjectCapabilityReadiness {
  if (conflicts.state !== 'CLEAR') {
    return invalid(true, 'AUTHORITY_CONFLICT', 'Project Authority contains an unresolved or stale conflict.');
  }
  switch (snapshot.state) {
    case 'CURRENT':
      return snapshot.proofReady
        ? ready(true, 'PROJECT_AUTHORITY_CURRENT', 'All enabled governed documents are current and proof-ready.')
        : incomplete(true, 'PROJECT_AUTHORITY_NOT_PROOF_READY', 'Project Authority is current but lacks a proof-ready manifest.');
    case 'INCOMPLETE':
      return incomplete(true, 'PROJECT_AUTHORITY_INCOMPLETE', joinIssues(snapshot.issues));
    case 'DRIFTED':
      return blocked(true, 'PROJECT_AUTHORITY_DRIFTED', joinIssues(snapshot.issues));
    case 'INVALID':
      return invalid(true, 'PROJECT_AUTHORITY_INVALID', joinIssues(snapshot.issues));
  }
}

function recognitionCapability(
  input: ProjectReadinessInput,
  requiredFlag: boolean,
): ProjectCapabilityReadiness {
  if (input.recognition === null) {
    return incomplete(
      requiredFlag,
      input.recognitionError?.code ?? 'PROJECT_RECOGNITION_INCOMPLETE',
      input.recognitionError?.detail ?? 'Project recognition configuration has not been validated.',
    );
  }
  return ready(
    requiredFlag,
    input.recognition.unsupportedAdapters.length === 0
      ? 'PROJECT_RECOGNITION_READY'
      : 'PROJECT_RECOGNITION_READY_WITH_DEFERRED_ADAPTERS',
    input.recognition.unsupportedAdapters.length === 0
      ? 'Recognition configuration is valid.'
      : `Recognition is ready for supported adapters; deferred adapters: ${input.recognition.unsupportedAdapters.join(', ')}.`,
  );
}

function hostCapability(host: ProjectHostReadiness | null): ProjectCapabilityReadiness {
  if (host === null) return notRequired('HOST_NOT_REQUIRED', 'Host readiness is evaluated independently when a host-backed operation is requested.');
  if (host.ready) return ready(false, host.code, host.detail);
  return host.state === 'ROOT MISMATCH'
    ? invalid(false, host.code, host.detail)
    : blocked(false, host.code, host.detail);
}

function gitLocalCapability(git: ProjectGitReadiness | null): ProjectCapabilityReadiness {
  if (git === null) return incomplete(true, 'GIT_NOT_TESTED', 'Git repository readiness has not been tested.');
  if (git.localOperationsReady) {
    return git.state === 'READY_LOCAL_ONLY'
      ? localOnly(true, git.code, git.detail)
      : ready(true, git.code, git.detail);
  }
  return git.state === 'INVALID'
    ? invalid(true, git.code, git.detail)
    : blocked(true, git.code, git.detail);
}

function proofCapability(
  requiredFlag: boolean,
  authority: ProjectCapabilityReadiness,
  recognition: ProjectCapabilityReadiness,
  runtime: ResolvedProjectBenchmarkRuntime,
  metricCatalogue: ProjectCapabilityReadiness,
): ProjectCapabilityReadiness {
  if (!requiredFlag) return notRequired('PROOF_NOT_REQUIRED', 'Proof is not required for the requested operation.');
  if (authority.state === 'INVALID' || metricCatalogue.state === 'INVALID' || runtime.state === 'INVALID') {
    return invalid(
      true,
      'PROOF_BASIS_INVALID',
      runtime.issues.map((issue) => `${issue.code}: ${issue.detail}`).join('; ') || 'Proof authority is invalid.',
    );
  }
  if (!authority.ready || !recognition.ready || !metricCatalogue.ready) {
    return blocked(true, 'PROOF_PREREQUISITE_NOT_READY', 'Current Project Authority, recognition, and Metric Catalogue are required for proof.');
  }
  if (runtime.state !== 'READY') {
    return incomplete(
      true,
      'BENCHMARK_RUNTIME_INCOMPLETE',
      runtime.issues.map((issue) => `${issue.code}: ${issue.detail}`).join('; ') || 'Benchmark runtime is incomplete.',
    );
  }
  return ready(true, 'PROOF_READY', 'Project Authority, recognition, Metric Catalogue, and benchmark runtime are ready.');
}

function browserCapability(
  requiredFlag: boolean,
  browser: ProjectBrowserReadiness | null,
): ProjectCapabilityReadiness {
  if (!requiredFlag) return notRequired('BROWSER_BENCHMARK_NOT_REQUIRED', 'The selected benchmark does not require Chrome.');
  if (browser === null) return incomplete(true, 'BROWSER_NOT_TESTED', 'Browser readiness has not been tested.');
  if (browser.ready) return ready(true, browser.code, browser.detail);
  if (browser.state === 'TARGET AMBIGUOUS' || browser.state === 'ORIGIN FORBIDDEN') {
    return invalid(true, browser.code, browser.detail);
  }
  return blocked(true, browser.code, browser.detail);
}

function gatewayCapability(
  requiredFlag: boolean,
  gateway: ProjectGatewayReadiness | null,
): ProjectCapabilityReadiness {
  if (!requiredFlag) return notRequired('AI_CANDIDATE_GENERATION_NOT_REQUIRED', 'AI candidate generation is not required for the requested operation.');
  if (gateway === null) return incomplete(true, 'GATEWAY_NOT_TESTED', 'GPT/Model Gateway readiness has not been tested.');
  if (gateway.ready) return ready(true, gateway.code, gateway.detail);
  if (gateway.state === 'POLICY MISMATCH' || gateway.state === 'MODEL UNAVAILABLE') {
    return invalid(true, gateway.code, gateway.detail);
  }
  if (gateway.state === 'INCOMPLETE' || gateway.state === 'CREDENTIAL MISSING') {
    return incomplete(true, gateway.code, gateway.detail);
  }
  return blocked(true, gateway.code, gateway.detail);
}

function publicationCapability(
  requiredFlag: boolean,
  git: ProjectGitReadiness | null,
): ProjectCapabilityReadiness {
  if (git === null) {
    return requiredFlag
      ? incomplete(true, 'GIT_NOT_TESTED', 'Git publication readiness has not been tested.')
      : notRequired('GIT_PUBLICATION_NOT_REQUIRED', 'Remote publication is not required for local work.');
  }
  if (git.publicationReady) return ready(requiredFlag, 'GIT_PUBLICATION_READY', git.detail);
  if (!requiredFlag && git.localOperationsReady) return localOnly(false, git.code, git.detail);
  if (git.state === 'INVALID') return invalid(true, git.code, git.detail);
  return blocked(true, git.code, git.detail);
}

function overallLevel(
  required: readonly ProjectCapabilityReadiness[],
  git: ProjectGitReadiness | null,
  readyForLocalWork: boolean,
): ProjectReadinessLevel {
  if (required.some((item) => item.state === 'INVALID')) return 'INVALID';
  if (required.some((item) => item.state === 'BLOCKED')) return 'BLOCKED';
  if (required.some((item) => item.state === 'INCOMPLETE')) return 'INCOMPLETE';
  if (readyForLocalWork && git?.state === 'READY_LOCAL_ONLY') return 'READY_LOCAL_ONLY';
  return 'READY';
}

function ready(required: boolean, code: string, detail: string): ProjectCapabilityReadiness {
  return Object.freeze({ state: 'READY', ready: true, required, code, detail });
}
function localOnly(required: boolean, code: string, detail: string): ProjectCapabilityReadiness {
  return Object.freeze({ state: 'READY_LOCAL_ONLY', ready: true, required, code, detail });
}
function notRequired(code: string, detail: string): ProjectCapabilityReadiness {
  return Object.freeze({ state: 'NOT_REQUIRED', ready: true, required: false, code, detail });
}
function incomplete(required: boolean, code: string, detail: string): ProjectCapabilityReadiness {
  return Object.freeze({ state: 'INCOMPLETE', ready: false, required, code, detail });
}
function blocked(required: boolean, code: string, detail: string): ProjectCapabilityReadiness {
  return Object.freeze({ state: 'BLOCKED', ready: false, required, code, detail });
}
function invalid(required: boolean, code: string, detail: string): ProjectCapabilityReadiness {
  return Object.freeze({ state: 'INVALID', ready: false, required, code, detail });
}

function joinIssues(issues: readonly { readonly code: string; readonly detail: string }[]): string {
  return issues.length === 0
    ? 'Project Authority is not ready.'
    : issues.map((issue) => `${issue.code}: ${issue.detail}`).join('; ');
}
