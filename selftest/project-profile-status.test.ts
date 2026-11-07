/** PP-28 — Status 5.8.0 exposes one exact Project Profile generation and readiness basis. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AiOrchestrationFacts,
  ProjectProfileFacts,
  RegistrySource,
} from '../src/daemon/consoleStateCollector.js';
import type { ProjectOperationIdentity } from '../src/shared/projectOperationIdentity.js';
import {
  isBranchUnavailable,
  parseStatusSnapshot,
  STATUS_SCHEMA_VERSION,
} from '../src/status/statusContractV5.js';
import { projectStatus, type ProjectStatusOptions } from '../src/status/statusProjector.js';
import { verifySeal } from '../src/status/statusSeal.js';

const AT = '2026-08-15T01:00:00.000Z';
const IDENTITY: ProjectOperationIdentity = {
  projectId: 'clu',
  targetRootIdentity: `path:v1:test:${'a'.repeat(64)}`,
  projectProfileHash: `profile:v1:${'b'.repeat(64)}`,
};

function capability(
  state: ProjectProfileFacts['capabilities']['recognition']['state'],
  ready: boolean,
  required: boolean,
  code: string,
) {
  return { state, ready, required, code } as const;
}

function profileFacts(overrides: Partial<ProjectProfileFacts> = {}): ProjectProfileFacts {
  return {
    profileMode: 'project-profile',
    projectIdentity: IDENTITY,
    profileGeneration: 3,
    assessmentAvailable: true,
    overallReadiness: 'READY_LOCAL_ONLY',
    readyForLocalWork: true,
    readyForRequestedOperations: true,
    capabilities: {
      recognition: capability('READY', true, true, 'PROJECT_RECOGNITION_READY'),
      proof: capability('READY', true, true, 'PROOF_READY'),
      browserBenchmark: capability('NOT_REQUIRED', true, false, 'BROWSER_BENCHMARK_NOT_REQUIRED'),
      aiCandidateGeneration: capability('READY', true, true, 'GATEWAY_READY'),
      gitPublication: capability('READY_LOCAL_ONLY', true, false, 'NO_REMOTE_YET'),
      custodianLanding: capability('NOT_REQUIRED', true, false, 'CUSTODIAN_LANDING_NOT_REQUIRED'),
    },
    authorityState: 'CURRENT',
    authorityConflictState: 'CLEAR',
    authorityManifestHash: 'c'.repeat(64),
    configuredAuthorityHash: 'd'.repeat(64),
    recognitionConfigurationHash: 'e'.repeat(64),
    assessedAt: AT,
    ...overrides,
  };
}

function gatewayFacts(
  projectIdentity: ProjectOperationIdentity | null = IDENTITY,
  profileGeneration: number | null = 3,
): AiOrchestrationFacts {
  return {
    configured: true,
    enabled: true,
    provider: 'openai',
    projectIdentity,
    profileGeneration,
    credentialReference: 'env:OPENAI_API_KEY',
    requestedModel: 'gpt-5.6',
    effectiveModel: 'gpt-5.6',
    fallbackUsed: false,
    apiKeyEnv: 'OPENAI_API_KEY',
    apiKeyPresent: true,
    operationallyReady: true,
    policyProblems: [],
    budgetHash: '1'.repeat(64),
    routingHash: '2'.repeat(64),
    priceScheduleVersion: 'OPENAI-2026-08',
    enabledRouteCount: 1,
    defaultMode: 'interactive',
    model: 'gpt-5.6',
    budgetAuthority: 'openai_platform',
    localBudgetEnforced: false,
    localPricingAuthoritative: false,
    providerState: 'ready',
    providerPaused: false,
    providerBudgetExhausted: false,
    providerPauseReason: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerRemainingTokens: null,
      providerRemainingTokensAuthoritative: false,
    },
    submitted: 0,
    completed: 0,
    failed: 0,
    refused: 0,
    pending: 0,
    todayActualUsd: null,
    monthActualUsd: null,
    reservedUsd: null,
    dailyHardUsd: 0,
    monthlyHardUsd: 0,
    degradationAction: null,
    latest: null,
  };
}

function source(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    currentMission: () => ({
      missionId: 'MISSION-000001',
      title: 'CLU-E',
      constitutionHash: 'f'.repeat(64),
      lastChange: 'unchanged',
    }),
    latestSnapshot: () => null,
    recognitionFor: () => null,
    runIdForSnapshot: () => null,
    configReadiness: () => ({ status: 'ready', sections: [] }) as never,
    stateSources: () => ['events:42'],
    projectProfileFacts: () => profileFacts(),
    aiOrchestrationFacts: () => gatewayFacts(),
    ...overrides,
  };
}

function options(): ProjectStatusOptions {
  return {
    capturedAt: AT,
    targetId: 'clu',
    targetName: 'CLU-E',
    canonicalRoot: '/repo',
    missionBasisHash: '3'.repeat(64),
    recognizerVersion: 'clue-recognizer/4',
    catalogue: null,
    q1: null,
    provenance: {
      eventLogFrom: 0,
      eventLogTo: 42,
      projectionVersion: 'clue.projections/8',
      goldenDefinitionHash: null,
    },
  };
}

test('PP-28: Status 5.8.0 seals active identity, readiness, authority and exact-model gateway parity', () => {
  const report = projectStatus(source(), options());
  const snapshot = parseStatusSnapshot(report.snapshot);
  assert.equal(STATUS_SCHEMA_VERSION, '5.8.0');
  assert.equal(isBranchUnavailable(snapshot.projectProfile), false);
  if (isBranchUnavailable(snapshot.projectProfile)) return;
  assert.deepEqual(snapshot.projectProfile.projectIdentity, IDENTITY);
  assert.equal(snapshot.projectProfile.profileGeneration, 3);
  assert.equal(snapshot.projectProfile.overallReadiness, 'READY_LOCAL_ONLY');
  assert.equal(snapshot.projectProfile.capabilities.proof.state, 'READY');
  assert.equal(snapshot.projectProfile.capabilities.gitPublication.state, 'READY_LOCAL_ONLY');
  assert.ok(snapshot.capability.backedBranches.includes('projectProfile'));
  assert.equal(isBranchUnavailable(snapshot.aiOrchestration), false);
  if (isBranchUnavailable(snapshot.aiOrchestration)) return;
  assert.equal(snapshot.aiOrchestration.credentialReference, 'env:OPENAI_API_KEY');
  assert.equal(snapshot.aiOrchestration.requestedModel, 'gpt-5.6');
  assert.equal(snapshot.aiOrchestration.effectiveModel, 'gpt-5.6');
  assert.equal(snapshot.aiOrchestration.fallbackUsed, false);
  const verified = verifySeal(snapshot);
  assert.equal(verified.valid, true, verified.failures.map((failure) => failure.detail).join('; '));
  assert.equal(
    verified.consistency.checks.find((check) => check.id === 'project-profile-identity')?.outcome,
    'pass',
  );
});

test('PP-28: a gateway from another profile generation makes the Status seal inconsistent', () => {
  const other: ProjectOperationIdentity = {
    ...IDENTITY,
    projectProfileHash: `profile:v1:${'9'.repeat(64)}`,
  };
  const report = projectStatus(
    source({ aiOrchestrationFacts: () => gatewayFacts(other, 4) }),
    options(),
  );
  const verified = verifySeal(report.snapshot);
  assert.equal(verified.valid, true, 'the seal must still bind the contradictory evidence exactly');
  assert.equal(verified.consistency.consistent, false);
  assert.match(
    verified.consistency.checks.find((check) => check.id === 'project-profile-identity')?.detail ?? '',
    /another Project Profile generation/u,
  );
});

test('PP-28: legacy config-v2 status states Project Profile absence explicitly', () => {
  const populatedSource = source({
    aiOrchestrationFacts: () => gatewayFacts(null, null),
  });
  const { projectProfileFacts: _projectProfileFacts, ...legacySource } = populatedSource;
  const report = projectStatus(legacySource, options());
  assert.equal(isBranchUnavailable(report.snapshot.projectProfile), true);
  if (!isBranchUnavailable(report.snapshot.projectProfile)) return;
  assert.equal(report.snapshot.projectProfile.state, 'unavailable');
  assert.equal(report.snapshot.capability.backedBranches.includes('projectProfile'), false);
  assert.equal(verifySeal(report.snapshot).valid, true);
});
