/**
 * PP-36 — cumulative Project Profiles acceptance across persistence, authority,
 * browser targeting, readiness, API safety and profile-only deletion.
 *
 * This suite intentionally composes the public control-plane seams rather than
 * testing private helpers. The SQLite-backed atomic runtime-switch matrix remains
 * in project-profiles-fault-injection-acceptance.test.ts and the existing PP-12 tests.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { assessAuthorityConflicts } from '../src/control/projectProfiles/authorityConflict.js';
import { resolveProjectBenchmarkRuntime } from '../src/control/projectProfiles/benchmarkRuntime.js';
import { inspectProjectAuthority } from '../src/control/projectProfiles/projectAuthority.js';
import { assessProjectReadiness } from '../src/control/projectProfiles/projectReadiness.js';
import { resolveProjectRecognitionConfiguration } from '../src/control/projectProfiles/projectRecognition.js';
import {
  ProfileRegistryError,
  ProjectProfileRegistry,
} from '../src/control/projectProfiles/profileRegistry.js';
import type { ProjectGatewayReadiness } from '../src/control/projectProfiles/gatewayReadiness.js';
import type { ProjectGitReadiness } from '../src/control/projectProfiles/gitReadiness.js';
import {
  deleteConfirmation,
  ProjectProfilesApiService,
} from '../src/daemon/projectProfilesApi.js';
import { resolveGovernedBrowserTarget } from '../src/experiment/browser/browserTargetResolver.js';
import type { Runtime } from '../src/control/runtime.js';
import { operationIdentityFromProfileRecord } from '../src/shared/projectOperationIdentity.js';
import {
  makeProjectProfileFixture,
  makeSiblingProjectProfile,
} from './project-profile-fixture.js';

const CHECKED_AT = '2026-08-15T18:00:00.000Z';

function minimalRuntime(repoRoot: string): Runtime {
  return { repoRoot, projectProfile: null } as unknown as Runtime;
}

function gatewayReady(record: ReturnType<ProjectProfileRegistry['create']>): ProjectGatewayReadiness {
  return {
    state: 'READY',
    ready: true,
    code: 'GATEWAY_READY',
    detail: 'exact model ready',
    projectIdentity: operationIdentityFromProfileRecord(record),
    profileGeneration: record.generation,
    provider: 'openai',
    requestedModel: 'gpt-5.6',
    effectiveModel: 'gpt-5.6',
    fallbackPolicy: 'FORBID',
    fallbackUsed: false,
    credentialReference: 'env:OPENAI_API_KEY',
    credentialPresent: true,
    providerReachable: true,
    providerState: 'ready',
    providerPauseReason: null,
    spendAuthority: 'openai_platform',
    localBudgetEnforced: false,
    checkedAt: CHECKED_AT,
  };
}

function gitLocal(record: ReturnType<ProjectProfileRegistry['create']>): ProjectGitReadiness {
  return {
    state: 'READY_LOCAL_ONLY',
    code: 'NO_REMOTE_YET',
    detail: 'local proof is ready; publication is deliberately unavailable',
    projectIdentity: operationIdentityFromProfileRecord(record),
    repositoryRoot: record.profile.targetRoot,
    repositoryTopLevel: record.profile.targetRoot,
    publicationMode: 'NO_REMOTE_YET',
    remote: null,
    provider: null,
    defaultBranch: 'main',
    branch: 'main',
    head: 'a'.repeat(40),
    dirty: false,
    localOperationsReady: true,
    explicitSyncReady: false,
    publicationReady: false,
    checkedAt: CHECKED_AT,
  };
}

function localProofReadiness(record: ReturnType<ProjectProfileRegistry['create']>) {
  const authority = inspectProjectAuthority(record);
  const resolvedBenchmarkRuntime = resolveProjectBenchmarkRuntime(record, authority.manifest);
  // Benchmark parsing/consistency has dedicated PP-18 coverage. This cumulative test supplies
  // the same project-bound runtime identity in its accepted state to exercise readiness composition.
  const benchmarkRuntime = { ...resolvedBenchmarkRuntime, state: 'READY' as const, issues: [] };
  return assessProjectReadiness({
    record,
    authority,
    authorityConflicts: assessAuthorityConflicts(authority),
    benchmarkRuntime,
    recognition: resolveProjectRecognitionConfiguration(record),
    host: null,
    git: gitLocal(record),
    browser: null,
    gateway: gatewayReady(record),
    metricCatalogueValid: true,
    metricCatalogueDetail: 'catalogue parity suite green',
    requirements: { recognition: true, proof: true, aiCandidateGeneration: true },
    checkedAt: CHECKED_AT,
  });
}

test('PP-36: two profiles persist with exact independent generations and duplicate physical targets fail closed', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profilesRoot);
  const alpha = registry.create(fixture.profile, { actor: 'creator', reason: 'ACCEPTANCE_A' });
  const betaProfile = makeSiblingProjectProfile(fixture, 'beta');
  const beta = registry.create(betaProfile, { actor: 'creator', reason: 'ACCEPTANCE_B' });

  const reopened = new ProjectProfileRegistry(fixture.profilesRoot);
  reopened.verifyIntegrity();
  assert.deepEqual(reopened.listMetadata().map((item) => item.projectId), ['alpha', 'beta']);
  assert.equal(reopened.getProfile('alpha').generation, alpha.generation);
  assert.equal(reopened.getProfile('beta').projectProfileHash, beta.projectProfileHash);
  assert.notEqual(alpha.profile.targetRootIdentity, beta.profile.targetRootIdentity);
  assert.notEqual(alpha.profile.state.databasePath, beta.profile.state.databasePath);
  assert.notEqual(alpha.profile.state.recognitionRoot, beta.profile.state.recognitionRoot);
  assert.notEqual(alpha.profile.state.greatBookScope, beta.profile.state.greatBookScope);

  const duplicate = {
    ...betaProfile,
    projectId: 'duplicate-alpha-target',
    targetRoot: alpha.profile.targetRoot,
    targetRootIdentity: alpha.profile.targetRootIdentity,
    benchmarkRuntime: {
      ...betaProfile.benchmarkRuntime,
      workingDirectory: alpha.profile.targetRoot,
    },
    integrations: {
      ...betaProfile.integrations,
      powershell: {
        ...betaProfile.integrations.powershell,
        projectRoot: alpha.profile.targetRoot,
      },
      git: {
        ...betaProfile.integrations.git,
        repositoryRoot: alpha.profile.targetRoot,
      },
    },
    state: {
      ...betaProfile.state,
      greatBookScope: 'duplicate-alpha-target',
    },
  };
  assert.throws(
    () => registry.create(duplicate, { actor: 'creator', reason: 'DUPLICATE_ROOT_NEGATIVE' }),
    (error: unknown) =>
      error instanceof ProfileRegistryError &&
      error.code === 'TARGET_ROOT_ALREADY_REGISTERED' &&
      error.existingProjectId === 'alpha',
  );
});

test('PP-36: local proof and AI work are ready while publication remains explicitly local-only', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = new ProjectProfileRegistry(fixture.profilesRoot).create(fixture.profile, {
    actor: 'creator',
    reason: 'READINESS_ACCEPTANCE',
  });
  const authority = inspectProjectAuthority(record);
  assert.equal(authority.state, 'CURRENT');
  assert.equal(authority.proofReady, true);

  const readiness = localProofReadiness(record);
  assert.equal(readiness.level, 'READY_LOCAL_ONLY');
  assert.equal(readiness.readyForLocalWork, true);
  assert.equal(readiness.readyForRequestedOperations, true);
  assert.equal(readiness.capabilities.recognition.ready, true);
  assert.equal(readiness.capabilities.proof.ready, true);
  assert.equal(readiness.capabilities.aiCandidateGeneration.ready, true);
  assert.equal(readiness.capabilities.gitPublication.state, 'READY_LOCAL_ONLY');
  assert.equal(readiness.capabilities.browserBenchmark.state, 'NOT_REQUIRED');
});

test('PP-36: governed-document drift blocks proof without silently changing the profile generation', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profilesRoot);
  const record = registry.create(fixture.profile, { actor: 'creator', reason: 'DRIFT_ACCEPTANCE' });
  const profilePath = join(fixture.profilesRoot, 'profiles', `${record.profile.projectId}.json`);
  const originalProfileBytes = readFileSync(profilePath);

  writeFileSync(fixture.targetDescription, '# alpha\n\nChanged authority bytes.\n', 'utf8');
  const authority = inspectProjectAuthority(record);
  assert.equal(authority.state, 'DRIFTED');
  assert.equal(authority.proofReady, false);
  assert.deepEqual(readFileSync(profilePath), originalProfileBytes);
  assert.equal(registry.getProfile(record.profile.projectId).generation, record.generation);
});

test('PP-36: browser resolution refuses ambiguity, wrong origin and a disappeared pinned page', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const record = new ProjectProfileRegistry(fixture.profilesRoot).create(fixture.profile, {
    actor: 'creator',
    reason: 'BROWSER_ACCEPTANCE',
  });
  const target = (id: string, url: string) => ({
    id,
    type: 'page',
    title: id,
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  });

  const ambiguous = resolveGovernedBrowserTarget({
    record,
    targets: [
      target('A', 'http://127.0.0.1:8080'),
      target('B', 'http://127.0.0.1:8080'),
    ],
  });
  assert.equal(ambiguous.code, 'BROWSER_TARGET_AMBIGUOUS');
  assert.equal(ambiguous.ready, false);

  const wrongOrigin = resolveGovernedBrowserTarget({
    record,
    targets: [target('X', 'https://example.invalid/')],
  });
  assert.equal(wrongOrigin.code, 'BROWSER_ORIGIN_FORBIDDEN');

  const disconnected = resolveGovernedBrowserTarget({
    record,
    targets: [target('A', 'http://127.0.0.1:8080')],
    selectedTargetPageId: 'MISSING',
  });
  assert.equal(disconnected.code, 'BROWSER_TARGET_DISCONNECTED');
});

test('PP-36: direct backend deletion removes only CLU-E profile metadata and preserves target/workspace/shadow', (t) => {
  const fixture = makeProjectProfileFixture();
  t.after(() => fixture.dispose());
  const registry = new ProjectProfileRegistry(fixture.profilesRoot);
  const record = registry.create(fixture.profile, { actor: 'daemon', reason: 'DELETE_ACCEPTANCE' });
  const service = new ProjectProfilesApiService({
    registry,
    runtime: minimalRuntime(fixture.root),
    actor: 'daemon',
  });

  const receipt = service.delete(
    record.profile.projectId,
    record.generation,
    deleteConfirmation(record),
  ) as {
    readonly deleted: boolean;
    readonly targetRepositoryDeleted: boolean;
    readonly projectWorkspaceDeleted: boolean;
  };
  assert.equal(receipt.deleted, true);
  assert.equal(receipt.targetRepositoryDeleted, false);
  assert.equal(receipt.projectWorkspaceDeleted, false);
  assert.equal(existsSync(fixture.target), true);
  assert.equal(existsSync(fixture.workspace), true);
  assert.equal(existsSync(fixture.shadow), true);
});
