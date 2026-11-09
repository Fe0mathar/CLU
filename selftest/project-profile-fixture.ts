/** Shared deterministic Project Profile fixtures used across Batches 1-6. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashText } from '../src/shared/ids.js';
import {
  normalisePathForStorage,
  resolveTargetRootIdentity,
} from '../src/shared/pathIdentity.js';
import {
  PROJECT_PROFILE_VERSION,
  projectProfileSchema,
  type ProjectProfile,
} from '../src/shared/schemas.js';

export const FIXED_AT = '2026-08-14T12:00:00.000Z';
export const FIXED_TIME = FIXED_AT;
export const FIXED_TIME_2 = '2026-08-14T12:01:00.000Z';

export interface ProfileFixtureOptions {
  readonly projectId?: string;
  readonly targetRoot?: string;
  readonly workspaceRoot?: string;
  readonly shadowRoot?: string;
  readonly displayName?: string | null;
}

export interface ProjectProfileFixture {
  readonly root: string;
  readonly ownsRoot: boolean;
  readonly profiles: string;
  readonly profilesRoot: string;
  readonly target: string;
  readonly workspace: string;
  readonly shadow: string;
  readonly browserProfile: string;
  readonly targetDescription: string;
  readonly masterBenchmark: string;
  readonly hostScript: string;
  readonly profile: ProjectProfile;
  /** Compatibility aliases used by the original Batch 1 tests. */
  readonly targetRoot: string;
  readonly workspaceRoot: string;
  readonly shadowRoot: string;
  readonly descriptionPath: string;
  readonly benchmarkPath: string;
  readonly draft: ProjectProfile;
  deferCleanup(cleanup: () => void): void;
  dispose(): void;
}

export type ProfileFixture = ProjectProfileFixture;

function writeTargetFiles(target: string, projectId: string): {
  readonly targetDescription: string;
  readonly masterBenchmark: string;
} {
  mkdirSync(join(target, 'src'), { recursive: true });
  mkdirSync(join(target, 'selftest'), { recursive: true });
  const targetDescription = join(target, 'target-description.md');
  const masterBenchmark = join(target, 'master-benchmark.md');
  writeFileSync(targetDescription, `# ${projectId}\n\nTarget description.\n`, 'utf8');
  writeFileSync(masterBenchmark, `# ${projectId}\n\nMaster benchmark.\n`, 'utf8');
  writeFileSync(join(target, 'tsconfig.json'), '{}\n', 'utf8');
  return { targetDescription, masterBenchmark };
}

function createProfileAt(
  root: string,
  options: ProfileFixtureOptions,
): {
  readonly target: string;
  readonly workspace: string;
  readonly shadow: string;
  readonly browserProfile: string;
  readonly targetDescription: string;
  readonly masterBenchmark: string;
  readonly hostScript: string;
  readonly profile: ProjectProfile;
} {
  const projectId = options.projectId ?? 'alpha';
  const target = options.targetRoot ?? join(root, `target-${projectId}`);
  const workspace = options.workspaceRoot ?? join(root, `workspace-${projectId}`);
  const shadow = options.shadowRoot ?? join(root, `shadow-${projectId}`);
  const browserProfile = join(root, `browser-${projectId}`);
  const hostScript = join(root, `host-${projectId}.ps1`);

  for (const directory of [target, workspace, shadow, browserProfile]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const directory of [
    join(workspace, 'db'),
    join(workspace, 'events'),
    join(workspace, 'artifacts'),
    join(workspace, 'recognition'),
    join(workspace, 'proof'),
    join(workspace, 'cycles'),
    join(workspace, 'snapshots'),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(hostScript, '# CLU-E fixture host\n', 'utf8');
  const files = writeTargetFiles(target, projectId);
  const targetRoot = normalisePathForStorage(target);
  const workspaceRoot = normalisePathForStorage(workspace);
  const shadowRoot = normalisePathForStorage(shadow);
  const targetDescription = normalisePathForStorage(files.targetDescription);
  const masterBenchmark = normalisePathForStorage(files.masterBenchmark);

  const profile = projectProfileSchema.parse({
    profileVersion: PROJECT_PROFILE_VERSION,
    projectId,
    displayName: options.displayName === undefined ? projectId.toUpperCase() : options.displayName,
    targetRoot,
    targetRootIdentity: resolveTargetRootIdentity(target),
    workspaceRoot,
    shadowRoot,
    authority: {
      targetDescription: {
        bindingId: 'target-description',
        kind: 'target-description',
        path: 'target-description.md',
        canonicalPath: targetDescription,
        sha256: hashText(`# ${projectId}\n\nTarget description.\n`),
        role: 'product-requirements',
        enabled: true,
        order: 0,
        validationState: 'VALID',
        lastValidated: FIXED_AT,
      },
      masterBenchmark: {
        bindingId: 'master-benchmark',
        kind: 'master-benchmark',
        path: 'master-benchmark.md',
        canonicalPath: masterBenchmark,
        sha256: hashText(`# ${projectId}\n\nMaster benchmark.\n`),
        role: 'testing',
        enabled: true,
        order: 1,
        validationState: 'VALID',
        lastValidated: FIXED_AT,
        benchmarkId: 'fixture-master',
        benchmarkVersion: '1.0.0',
      },
      projectIntent: null,
      additionalDocuments: [],
    },
    recognition: {
      sourceRoots: ['selftest', 'src'],
      excludedPaths: ['dist', 'node_modules'],
      buildConfig: 'tsconfig.json',
      adapters: ['typescript'],
      policy: {
        policyVersion: 'recognition-policy/1',
        fullScanOnActivation: false,
        reuseUnchangedSnapshot: true,
        followSymlinks: false,
      },
    },
    benchmarkRuntime: {
      workingDirectory: targetRoot,
      command: 'npm run selftest',
      scenario: 'fixture-master',
      warmupRuns: 1,
      repetitions: 3,
      timeoutSeconds: 600,
      targetUrl: null,
      browserProfile: null,
      resolution: null,
      additionalRuntimeArgs: [],
    },
    integrations: {
      powershell: {
        executable: {
          source: 'global-default',
          defaultKey: 'powershell.executable',
          value: null,
        },
        hostScript: normalisePathForStorage(hostScript),
        hostRootAuthority: 'project-profile',
        projectRoot: targetRoot,
        workspaceRoot,
        shadowRoot,
        autonomousProfile: 'restricted',
      },
      git: {
        repositoryRoot: targetRoot,
        remote: null,
        provider: null,
        defaultBranch: 'main',
        protectedLandingPolicy: null,
        currentBasePin: null,
        publicationMode: 'NO_REMOTE_YET',
      },
      chrome: {
        executable: {
          source: 'global-default',
          defaultKey: 'browser.executable',
          value: null,
        },
        launchMode: 'CLUE_MANAGED',
        dedicatedProfileDirectory: normalisePathForStorage(browserProfile),
        remoteDebuggingPort: 9222,
        allowedOrigins: ['http://127.0.0.1:8080'],
        targetUrl: 'http://127.0.0.1:8080',
        targetSelectionRule: 'EXACT_PAGE_ID_THEN_URL_THEN_UNIQUE_ORIGIN',
      },
      gpt: {
        provider: 'openai',
        modelId: 'gpt-5.6',
        credential: {
          source: 'project-override',
          defaultKey: 'gateway.credential',
          value: 'env:OPENAI_API_KEY',
        },
        enabled: true,
        fallbackPolicy: 'FORBID',
      },
    },
    state: {
      databasePath: normalisePathForStorage(join(workspace, 'db', 'clue.db')),
      eventLogRoot: normalisePathForStorage(join(workspace, 'events')),
      artifactStoreRoot: normalisePathForStorage(join(workspace, 'artifacts')),
      greatBookScope: projectId,
      recognitionRoot: normalisePathForStorage(join(workspace, 'recognition')),
      proofRoot: normalisePathForStorage(join(workspace, 'proof')),
      cycleRoot: normalisePathForStorage(join(workspace, 'cycles')),
      snapshotRoot: normalisePathForStorage(join(workspace, 'snapshots')),
    },
    provenance: { source: 'native' },
  });

  return {
    target,
    workspace,
    shadow,
    browserProfile,
    targetDescription: files.targetDescription,
    masterBenchmark: files.masterBenchmark,
    hostScript,
    profile,
  };
}

export function makeProjectProfileFixture(
  rootOrOptions?: string | ProfileFixtureOptions,
  maybeOptions: ProfileFixtureOptions = {},
): ProjectProfileFixture {
  const explicitRoot = typeof rootOrOptions === 'string' ? rootOrOptions : undefined;
  const options = typeof rootOrOptions === 'object' ? rootOrOptions : maybeOptions;
  const root = explicitRoot ?? mkdtempSync(join(tmpdir(), 'clue-project-profile-'));
  const ownsRoot = explicitRoot === undefined;
  mkdirSync(root, { recursive: true });
  const created = createProfileAt(root, options);
  const profiles = join(root, 'profiles-control-plane');
  const cleanups: (() => void)[] = [];
  return {
    root,
    ownsRoot,
    profiles,
    profilesRoot: profiles,
    ...created,
    targetRoot: created.target,
    workspaceRoot: created.workspace,
    shadowRoot: created.shadow,
    descriptionPath: created.targetDescription,
    benchmarkPath: created.masterBenchmark,
    draft: created.profile,
    deferCleanup(cleanup): void {
      cleanups.push(cleanup);
    },
    dispose(): void {
      // Windows keeps open SQLite files locked. Release resources before removing the fixture.
      const failures: unknown[] = [];
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Project Profile fixture cleanup failed.');
      if (ownsRoot) rmSync(root, { recursive: true, force: true });
    },
  };
}

export function cloneProfile(
  profile: ProjectProfile,
  mutate: (draft: Record<string, unknown>) => void,
): ProjectProfile {
  const draft = structuredClone(profile) as unknown as Record<string, unknown>;
  mutate(draft);
  return projectProfileSchema.parse(draft);
}

export function makeSiblingProjectProfile(
  fixture: ProjectProfileFixture,
  projectId: string,
): ProjectProfile {
  return createProfileAt(fixture.root, { projectId }).profile;
}
