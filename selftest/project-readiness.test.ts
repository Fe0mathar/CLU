/** PP-27 — operation-specific readiness and legitimate READY_LOCAL_ONLY state. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessAuthorityConflicts } from '../src/control/projectProfiles/authorityConflict.js';
import { resolveProjectBenchmarkRuntime } from '../src/control/projectProfiles/benchmarkRuntime.js';
import type { ProjectGatewayReadiness } from '../src/control/projectProfiles/gatewayReadiness.js';
import type { ProjectGitReadiness } from '../src/control/projectProfiles/gitReadiness.js';
import { inspectProjectAuthority } from '../src/control/projectProfiles/projectAuthority.js';
import { assessProjectReadiness } from '../src/control/projectProfiles/projectReadiness.js';
import { resolveProjectRecognitionConfiguration } from '../src/control/projectProfiles/projectRecognition.js';
import { ProjectProfileRegistry } from '../src/control/projectProfiles/profileRegistry.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

function gatewayReady(record: ReturnType<ProjectProfileRegistry['create']>): ProjectGatewayReadiness {
  return {
    state: 'READY', ready: true, code: 'GATEWAY_READY', detail: 'exact model ready',
    projectIdentity: operationIdentityFromProfileRecord(record), profileGeneration: record.generation,
    provider: 'openai', requestedModel: 'gpt-5.6', effectiveModel: 'gpt-5.6',
    fallbackPolicy: 'FORBID', fallbackUsed: false,
    credentialReference: 'env:OPENAI_API_KEY', credentialPresent: true, providerReachable: true,
    providerState: 'ready', providerPauseReason: null,
    spendAuthority: 'openai_platform', localBudgetEnforced: false,
    checkedAt: '2026-08-15T01:00:00.000Z',
  };
}

function gitLocal(record: ReturnType<ProjectProfileRegistry['create']>): ProjectGitReadiness {
  return {
    state: 'READY_LOCAL_ONLY', code: 'NO_REMOTE_YET',
    detail: 'local proof is available; publication is not configured',
    projectIdentity: operationIdentityFromProfileRecord(record),
    repositoryRoot: record.profile.targetRoot, repositoryTopLevel: record.profile.targetRoot,
    publicationMode: 'NO_REMOTE_YET', remote: null, provider: null, defaultBranch: 'main',
    branch: 'main', head: 'a'.repeat(40), dirty: false,
    localOperationsReady: true, explicitSyncReady: false, publicationReady: false,
    checkedAt: '2026-08-15T01:00:00.000Z',
  };
}

function inputFor(record: ReturnType<ProjectProfileRegistry['create']>) {
  mkdirSync(`${record.profile.targetRoot}/src`, { recursive: true });
  const authority = inspectProjectAuthority(record);
  const runtime = resolveProjectBenchmarkRuntime(record, authority.manifest);
  return {
    record,
    authority,
    authorityConflicts: assessAuthorityConflicts(authority),
    benchmarkRuntime: { ...runtime, state: 'READY' as const, issues: [] },
    recognition: resolveProjectRecognitionConfiguration(record),
    host: null,
    git: gitLocal(record),
    browser: null,
    gateway: gatewayReady(record),
    metricCatalogueValid: true,
    metricCatalogueDetail: 'catalogue is production ready',
    checkedAt: '2026-08-15T01:00:00.000Z',
  } as const;
}

test('local recognition/proof/AI readiness is READY_LOCAL_ONLY when NO_REMOTE_YET is intentional', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
  const result = assessProjectReadiness({ ...inputFor(record), requirements: { aiCandidateGeneration: true } });
  assert.equal(result.level, 'READY_LOCAL_ONLY');
  assert.equal(result.readyForRequestedOperations, true);
  assert.equal(result.readyForLocalWork, true);
  assert.equal(result.capabilities.proof.state, 'READY');
  assert.equal(result.capabilities.aiCandidateGeneration.state, 'READY');
  assert.equal(result.capabilities.gitPublication.state, 'READY_LOCAL_ONLY');
  assert.equal(result.capabilities.browserBenchmark.state, 'NOT_REQUIRED');
});

test('optional remote/browser/host capabilities do not globally block local proof', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
  const result = assessProjectReadiness({
    ...inputFor(record),
    requirements: { browserBenchmark: false, aiCandidateGeneration: false, gitPublication: false, custodianLanding: false },
  });
  assert.equal(result.readyForRequestedOperations, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.capabilities.host.required, false);
});

test('required browser benchmark and gateway pause block only their intended capabilities', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
  const paused: ProjectGatewayReadiness = {
    ...gatewayReady(record), state: 'CONTROLLED PAUSE', ready: false,
    code: 'PROVIDER_BUDGET_PAUSED', detail: 'provider funding exhausted', effectiveModel: null,
    providerState: 'paused_budget', providerPauseReason: 'provider funding exhausted',
  };
  const result = assessProjectReadiness({
    ...inputFor(record), browser: null, gateway: paused,
    requirements: { browserBenchmark: true, aiCandidateGeneration: true },
  });
  assert.equal(result.level, 'BLOCKED');
  assert.equal(result.capabilities.proof.state, 'READY');
  assert.equal(result.capabilities.browserBenchmark.state, 'INCOMPLETE');
  assert.equal(result.capabilities.aiCandidateGeneration.state, 'BLOCKED');
  assert.equal(result.readyForRequestedOperations, false);
});

test('authority drift fails proof closed without inventing a replacement authority basis', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
  writeFileSync(fixture.targetDescription, '# drifted target\n', 'utf8');
  const authority = inspectProjectAuthority(record);
  const result = assessProjectReadiness({
    ...inputFor(record),
    authority,
    authorityConflicts: assessAuthorityConflicts(authority),
    benchmarkRuntime: { ...resolveProjectBenchmarkRuntime(record, authority.manifest), state: 'READY' as const, issues: [] },
  });
  assert.equal(result.authorityState, 'DRIFTED');
  assert.equal(result.capabilities.authority.state, 'BLOCKED');
  assert.equal(result.capabilities.proof.ready, false);
  assert.equal(result.readyForRequestedOperations, false);
});


test('readiness rejects a connection result from another Project Profile generation', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = new ProjectProfileRegistry(fixture.profiles).create(fixture.profile, { actor: 'creator' });
  const gateway = gatewayReady(record);
  const staleGateway: ProjectGatewayReadiness = {
    ...gateway,
    projectIdentity: {
      ...gateway.projectIdentity,
      projectProfileHash: `profile:v1:${'9'.repeat(64)}`,
    },
    profileGeneration: record.generation + 1,
  };
  assert.throws(
    () => assessProjectReadiness({ ...inputFor(record), gateway: staleGateway }),
    /Project gateway readiness identity mismatch in projectProfileHash|profile generation/u,
  );
});
