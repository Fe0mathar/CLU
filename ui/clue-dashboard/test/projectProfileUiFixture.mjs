export const PROFILE_HASH_A = `profile:v1:${'a'.repeat(64)}`;
export const PROFILE_HASH_B = `profile:v1:${'b'.repeat(64)}`;
export const ROOT_ID_A = `path:v1:target:${'1'.repeat(64)}`;
export const ROOT_ID_B = `path:v1:target:${'2'.repeat(64)}`;

export function profile(projectId = 'alpha') {
  const isBeta = projectId === 'beta';
  const root = isBeta ? 'F:/Targets/Beta' : 'F:/Targets/Alpha';
  const workspace = isBeta ? 'F:/CLU/workspace/beta' : 'F:/CLU/workspace/alpha';
  const shadow = isBeta ? 'F:/CLU/shadow/beta' : 'F:/CLU/shadow/alpha';
  const targetRootIdentity = isBeta ? ROOT_ID_B : ROOT_ID_A;
  return {
    profileVersion: 'clue-project-profile/1',
    projectId,
    displayName: projectId.toUpperCase(),
    targetRoot: root,
    targetRootIdentity,
    workspaceRoot: workspace,
    shadowRoot: shadow,
    authority: {
      targetDescription: {
        bindingId: 'target-description', kind: 'target-description', path: 'target-description.md',
        canonicalPath: `${root}/target-description.md`, sha256: '3'.repeat(64), role: 'product-requirements',
        enabled: true, order: 0, validationState: 'VALID', lastValidated: '2026-08-15T00:00:00.000Z',
      },
      masterBenchmark: {
        bindingId: 'master-benchmark', kind: 'master-benchmark', path: 'master-benchmark.md',
        canonicalPath: `${root}/master-benchmark.md`, sha256: '4'.repeat(64), role: 'performance',
        enabled: true, order: 1, validationState: 'VALID', lastValidated: '2026-08-15T00:00:00.000Z',
        benchmarkId: 'master', benchmarkVersion: '1',
      },
      projectIntent: null,
      additionalDocuments: [],
    },
    recognition: {
      sourceRoots: ['src'], excludedPaths: ['dist', 'node_modules'], buildConfig: 'tsconfig.json',
      adapters: ['typescript'],
      policy: { policyVersion: 'recognition-policy/1', fullScanOnActivation: false, reuseUnchangedSnapshot: true, followSymlinks: false },
    },
    benchmarkRuntime: {
      workingDirectory: root, command: 'npm run selftest', scenario: 'master', warmupRuns: 1,
      repetitions: 3, timeoutSeconds: 600, targetUrl: null, browserProfile: null,
      resolution: null, additionalRuntimeArgs: [],
    },
    integrations: {
      powershell: {
        executable: { source: 'global-default', defaultKey: 'powershell.executable', value: null },
        hostScript: `${root}/scripts/host.ps1`, hostRootAuthority: 'project-profile', projectRoot: root,
        workspaceRoot: workspace, shadowRoot: shadow, autonomousProfile: 'restricted',
      },
      git: {
        repositoryRoot: root, remote: null, provider: null, defaultBranch: 'main', protectedLandingPolicy: null,
        currentBasePin: null, publicationMode: 'NO_REMOTE_YET',
      },
      chrome: {
        executable: { source: 'global-default', defaultKey: 'browser.executable', value: null },
        launchMode: 'CLUE_MANAGED', dedicatedProfileDirectory: `F:/CLU/browser-profiles/${projectId}`,
        remoteDebuggingPort: isBeta ? 9223 : 9222, allowedOrigins: ['http://127.0.0.1:8080'],
        targetUrl: 'http://127.0.0.1:8080', targetSelectionRule: 'EXACT_PAGE_ID_THEN_URL_THEN_UNIQUE_ORIGIN',
      },
      gpt: {
        provider: 'openai', modelId: 'gpt-5.6',
        credential: { source: 'project-override', defaultKey: 'gateway.credential', value: 'env:OPENAI_API_KEY' },
        enabled: true, fallbackPolicy: 'FORBID',
      },
    },
    state: {
      databasePath: `${workspace}/db/clue.db`, eventLogRoot: `${workspace}/events`, artifactStoreRoot: `${workspace}/artifacts`,
      greatBookScope: projectId, recognitionRoot: `${workspace}/recognition`, proofRoot: `${workspace}/proof`,
      cycleRoot: `${workspace}/cycles`, snapshotRoot: `${workspace}/snapshots`,
    },
    provenance: { source: 'native' },
  };
}

export function record(projectId = 'alpha', generation = 1) {
  const p = profile(projectId);
  return {
    profile: p,
    generation,
    projectProfileHash: projectId === 'beta' ? PROFILE_HASH_B : PROFILE_HASH_A,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

export function pointer(projectId = 'alpha', generation = 1) {
  const r = record(projectId, generation);
  return {
    projectId,
    targetRootIdentity: r.profile.targetRootIdentity,
    projectProfileHash: r.projectProfileHash,
    profileGeneration: generation,
    activatedAt: '2026-08-15T00:00:00.000Z',
  };
}

export function metadata(projectId = 'alpha', generation = 1) {
  const r = record(projectId, generation);
  return {
    projectId,
    displayName: r.profile.displayName,
    targetRoot: r.profile.targetRoot,
    targetRootIdentity: r.profile.targetRootIdentity,
    generation,
    projectProfileHash: r.projectProfileHash,
    updatedAt: r.updatedAt,
  };
}

export function snapshot(projectId = 'alpha', generation = 1) {
  const r = record(projectId, generation);
  return {
    phase: 'ready', registryGeneration: 2, projects: [metadata('alpha'), metadata('beta')], active: pointer('alpha'),
    selectedProjectId: projectId, selectedRecord: r, draft: structuredClone(r.profile), draftMode: 'update',
    newProjectInput: null, dirty: false, legacyConfiguration: null, validation: null, readiness: null,
    readinessOperation: 'local-proof', connectionChecks: { host: null, git: null, browser: null, gateway: null },
    pending: null, notice: null, error: null, revision: 1,
  };
}
