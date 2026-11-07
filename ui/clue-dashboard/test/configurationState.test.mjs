import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConfigurationState,
  recordMatchesActive,
} from '../configuration/configurationState.js';

test('Create New opens profile preparation in an empty registry', () => {
  const state = createConfigurationState();
  assert.equal(state.beginNewPreparation().ok, true);
  assert.equal(state.snapshot().draftMode, 'prepare');
  assert.equal(state.snapshot().newProjectInput.templateProjectId, null);
});

const hash = (letter) => `profile:v1:${letter.repeat(64)}`;
const target = (letter) => `path:v1:posix:${letter.repeat(64)}`;

function profile(projectId, letter) {
  return {
    profileVersion: 'clue-project-profile/1',
    projectId,
    displayName: projectId.toUpperCase(),
    targetRoot: `/targets/${projectId}`,
    targetRootIdentity: target(letter),
    workspaceRoot: `/workspace/${projectId}`,
    shadowRoot: `/shadow/${projectId}`,
    authority: { targetDescription: null, masterBenchmark: null, projectIntent: null, additionalDocuments: [] },
    recognition: { sourceRoots: ['src'], excludedPaths: [], buildConfig: null, adapters: ['typescript'], policy: { policyVersion: 'recognition-policy/1', fullScanOnActivation: false, reuseUnchangedSnapshot: true, followSymlinks: false } },
    benchmarkRuntime: { workingDirectory: `/targets/${projectId}`, command: null, scenario: null, warmupRuns: 1, repetitions: 3, timeoutSeconds: 600, targetUrl: null, browserProfile: null, resolution: null, additionalRuntimeArgs: [] },
    integrations: {
      powershell: { executable: { source: 'global-default', defaultKey: 'powershell.executable', value: null }, hostScript: '/host.ps1', hostRootAuthority: 'project-profile', projectRoot: `/targets/${projectId}`, workspaceRoot: `/workspace/${projectId}`, shadowRoot: `/shadow/${projectId}`, autonomousProfile: 'restricted' },
      git: { repositoryRoot: `/targets/${projectId}`, remote: null, provider: null, defaultBranch: 'main', protectedLandingPolicy: null, currentBasePin: null, publicationMode: 'NO_REMOTE_YET' },
      chrome: { executable: { source: 'global-default', defaultKey: 'browser.executable', value: null }, launchMode: 'CLUE_MANAGED', dedicatedProfileDirectory: `/browser/${projectId}`, remoteDebuggingPort: 9222, allowedOrigins: ['http://127.0.0.1:8080'], targetUrl: null, targetSelectionRule: 'EXACT_PAGE_ID_THEN_URL_THEN_UNIQUE_ORIGIN' },
      gpt: { provider: 'openai', modelId: 'gpt-5.6', credential: { source: 'project-override', defaultKey: 'gateway.credential', value: 'env:OPENAI_API_KEY' }, enabled: true, fallbackPolicy: 'FORBID' },
    },
    state: { databasePath: `/workspace/${projectId}/db/clue.db`, eventLogRoot: `/workspace/${projectId}/events`, artifactStoreRoot: `/workspace/${projectId}/artifacts`, greatBookScope: projectId, recognitionRoot: `/workspace/${projectId}/recognition`, proofRoot: `/workspace/${projectId}/proof`, cycleRoot: `/workspace/${projectId}/cycles`, snapshotRoot: `/workspace/${projectId}/snapshots` },
    provenance: { source: 'native' },
  };
}

function record(projectId, letter, generation = 1) {
  return {
    recordVersion: 'clue-project-profile-record/1',
    generation,
    projectProfileHash: hash(letter),
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    profile: profile(projectId, letter),
  };
}

function pointer(projectId, letter, generation = 1) {
  return {
    pointerVersion: 'clue-active-project/1',
    projectId,
    targetRootIdentity: target(letter),
    projectProfileHash: hash(letter),
    profileGeneration: generation,
    activatedAt: '2026-08-15T00:00:00.000Z',
  };
}

function listing() {
  return {
    registryGeneration: 2,
    active: pointer('alpha', 'a'),
    projects: [
      { projectId: 'alpha', displayName: 'ALPHA', generation: 1, projectProfileHash: hash('a'), targetRootIdentity: target('a') },
      { projectId: 'beta', displayName: 'BETA', generation: 1, projectProfileHash: hash('b'), targetRootIdentity: target('b') },
    ],
  };
}

test('PP-32: a Project A response is ignored after Project B becomes the selected generation', () => {
  const state = createConfigurationState();
  state.applyListing(listing());
  const alphaRead = state.beginProjectRead('alpha');
  const betaRead = state.beginProjectRead('beta');

  assert.deepEqual(state.applyProjectRead(alphaRead, { record: record('alpha', 'a') }), {
    applied: false,
    reason: 'STALE_PROJECT_RESPONSE',
  });
  assert.equal(state.applyProjectRead(betaRead, { record: record('beta', 'b') }).applied, true);
  assert.equal(state.snapshot().selectedRecord.profile.projectId, 'beta');
  assert.equal(state.snapshot().active.projectId, 'alpha', 'selection never fabricates activation');
});

test('PP-32/35: activation failure leaves Project A active while the Project B draft remains selected', () => {
  const state = createConfigurationState();
  state.applyListing(listing());
  const read = state.beginProjectRead('beta');
  state.applyProjectRead(read, { record: record('beta', 'b') });
  state.updateDraft('displayName', 'BETA SUCCESSOR');

  assert.equal(state.snapshot().dirty, true);
  assert.equal(state.snapshot().active.projectId, 'alpha');
  assert.equal(state.snapshot().selectedProjectId, 'beta');
  assert.equal(recordMatchesActive(state.snapshot().selectedRecord, state.snapshot().active), false);

  const token = state.beginActivation();
  state.applyFailure(token, 'RUNTIME_SWITCH_FAILED', 'Project B could not be published.');
  const failed = state.snapshot();
  assert.equal(failed.active.projectId, 'alpha');
  assert.equal(failed.selectedProjectId, 'beta');
  assert.match(failed.notice.message, /RUNTIME_SWITCH_FAILED/);
});

test('PP-32: a backend-prepared new-project draft remains non-persistent and distinct from active identity', () => {
  const state = createConfigurationState();
  state.applyListing(listing());
  assert.equal(state.beginNewPreparation('alpha').ok, true);
  const token = state.beginDraftPreparation();
  const prepared = state.applyPreparedDraft(token, {
    profile: profile('gamma', 'c'),
    warnings: ['Target authority was cleared.'],
  });

  assert.equal(prepared.applied, true);
  const snapshot = state.snapshot();
  assert.equal(snapshot.draftMode, 'create');
  assert.equal(snapshot.draft.projectId, 'gamma');
  assert.equal(snapshot.selectedRecord, null);
  assert.equal(snapshot.active.projectId, 'alpha');
  assert.equal(snapshot.dirty, true);
  assert.match(snapshot.notice.message, /Target authority was cleared/);
});
