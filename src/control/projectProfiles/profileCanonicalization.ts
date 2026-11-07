/** Deterministic canonicalization for clue-project-profile/1. */

import { normalisePath } from '../../shared/ids.js';
import { normalisePathForStorage } from '../../shared/pathIdentity.js';
import { projectProfileSchema, type ProjectProfile } from '../../shared/schemas.js';

export interface ProjectProfileGlobalDefaults {
  readonly powershellExecutable?: string | null;
  readonly powershellHostScript?: string | null;
  readonly chromeExecutable?: string | null;
  readonly gptCredentialReference?: string | null;
}

export interface ProjectProfileCanonicalizationOptions {
  /** Reserved for configuration-v3 effective-setting materialization. */
  readonly globalDefaults?: ProjectProfileGlobalDefaults;
}

export type ProfileCanonicalizationErrorCode = 'INVALID_PROFILE';

export class ProfileCanonicalizationError extends Error {
  public readonly code: ProfileCanonicalizationErrorCode;

  public constructor(code: ProfileCanonicalizationErrorCode, message: string) {
    super(message);
    this.name = 'ProfileCanonicalizationError';
    this.code = code;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniquePaths(values: readonly string[]): string[] {
  return [...values]
    .map((value) => normalisePath(value.trim()))
    .sort(compareText);
}

function canonicalDocument<T extends NonNullable<ProjectProfile['authority']['targetDescription']>>(
  binding: T,
): T {
  return {
    ...binding,
    path: binding.path.trim().replace(/\\/gu, '/'),
    canonicalPath: normalisePathForStorage(binding.canonicalPath.trim()),
  };
}

function parseProfile(value: unknown): ProjectProfile {
  const parsed = projectProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProfileCanonicalizationError(
      'INVALID_PROFILE',
      `Invalid Project Profile: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** Returns one deterministic, schema-valid profile representation. */
export function canonicalizeProjectProfile(
  value: unknown,
  _options: ProjectProfileCanonicalizationOptions = {},
): ProjectProfile {
  const profile = parseProfile(value);
  const additionalDocuments = profile.authority.additionalDocuments
    .map((binding) => canonicalDocument(binding))
    .sort((left, right) => left.order - right.order || compareText(left.bindingId, right.bindingId));

  const canonical: ProjectProfile = {
    profileVersion: profile.profileVersion,
    projectId: profile.projectId,
    displayName: profile.displayName?.trim() ?? null,
    targetRoot: normalisePathForStorage(profile.targetRoot.trim()),
    targetRootIdentity: profile.targetRootIdentity,
    workspaceRoot: normalisePathForStorage(profile.workspaceRoot.trim()),
    shadowRoot: normalisePathForStorage(profile.shadowRoot.trim()),
    authority: {
      targetDescription:
        profile.authority.targetDescription === null
          ? null
          : canonicalDocument(profile.authority.targetDescription),
      masterBenchmark:
        profile.authority.masterBenchmark === null
          ? null
          : canonicalDocument(profile.authority.masterBenchmark),
      projectIntent:
        profile.authority.projectIntent === null
          ? null
          : canonicalDocument(profile.authority.projectIntent),
      additionalDocuments,
    },
    recognition: {
      sourceRoots: sortedUniquePaths(profile.recognition.sourceRoots),
      excludedPaths: sortedUniquePaths(profile.recognition.excludedPaths),
      buildConfig:
        profile.recognition.buildConfig === null
          ? null
          : profile.recognition.buildConfig.trim().replace(/\\/gu, '/'),
      adapters: [...profile.recognition.adapters].sort(compareText),
      policy: { ...profile.recognition.policy },
    },
    benchmarkRuntime: {
      workingDirectory: normalisePathForStorage(profile.benchmarkRuntime.workingDirectory.trim()),
      command: profile.benchmarkRuntime.command?.trim() ?? null,
      scenario: profile.benchmarkRuntime.scenario?.trim() ?? null,
      warmupRuns: profile.benchmarkRuntime.warmupRuns,
      repetitions: profile.benchmarkRuntime.repetitions,
      timeoutSeconds: profile.benchmarkRuntime.timeoutSeconds,
      targetUrl: profile.benchmarkRuntime.targetUrl?.trim() ?? null,
      browserProfile:
        profile.benchmarkRuntime.browserProfile === null
          ? null
          : normalisePathForStorage(profile.benchmarkRuntime.browserProfile.trim()),
      resolution: profile.benchmarkRuntime.resolution,
      additionalRuntimeArgs: [...profile.benchmarkRuntime.additionalRuntimeArgs],
    },
    integrations: {
      powershell: {
        executable: { ...profile.integrations.powershell.executable },
        hostScript: normalisePathForStorage(profile.integrations.powershell.hostScript.trim()),
        hostRootAuthority: profile.integrations.powershell.hostRootAuthority,
        projectRoot: normalisePathForStorage(profile.integrations.powershell.projectRoot.trim()),
        workspaceRoot: normalisePathForStorage(profile.integrations.powershell.workspaceRoot.trim()),
        shadowRoot: normalisePathForStorage(profile.integrations.powershell.shadowRoot.trim()),
        autonomousProfile: profile.integrations.powershell.autonomousProfile,
      },
      git: {
        repositoryRoot: normalisePathForStorage(profile.integrations.git.repositoryRoot.trim()),
        remote: profile.integrations.git.remote,
        provider: profile.integrations.git.provider,
        defaultBranch: profile.integrations.git.defaultBranch.trim(),
        protectedLandingPolicy:
          profile.integrations.git.protectedLandingPolicy === null
            ? null
            : normalisePathForStorage(profile.integrations.git.protectedLandingPolicy.trim()),
        currentBasePin: profile.integrations.git.currentBasePin,
        publicationMode: profile.integrations.git.publicationMode,
      },
      chrome: {
        executable: { ...profile.integrations.chrome.executable },
        launchMode: profile.integrations.chrome.launchMode,
        dedicatedProfileDirectory: normalisePathForStorage(
          profile.integrations.chrome.dedicatedProfileDirectory.trim(),
        ),
        remoteDebuggingPort: profile.integrations.chrome.remoteDebuggingPort,
        allowedOrigins: [...profile.integrations.chrome.allowedOrigins]
          .map((origin) => origin.trim())
          .sort(compareText),
        targetUrl: profile.integrations.chrome.targetUrl?.trim() ?? null,
        targetSelectionRule: profile.integrations.chrome.targetSelectionRule,
      },
      gpt: {
        provider: profile.integrations.gpt.provider,
        modelId: profile.integrations.gpt.modelId?.trim() ?? null,
        credential: { ...profile.integrations.gpt.credential },
        enabled: profile.integrations.gpt.enabled,
        fallbackPolicy: profile.integrations.gpt.fallbackPolicy,
      },
    },
    state: {
      databasePath: normalisePathForStorage(profile.state.databasePath.trim()),
      eventLogRoot: normalisePathForStorage(profile.state.eventLogRoot.trim()),
      artifactStoreRoot: normalisePathForStorage(profile.state.artifactStoreRoot.trim()),
      greatBookScope: profile.state.greatBookScope,
      recognitionRoot: normalisePathForStorage(profile.state.recognitionRoot.trim()),
      proofRoot: normalisePathForStorage(profile.state.proofRoot.trim()),
      cycleRoot: normalisePathForStorage(profile.state.cycleRoot.trim()),
      snapshotRoot: normalisePathForStorage(profile.state.snapshotRoot.trim()),
    },
    provenance: { ...profile.provenance },
  };
  return projectProfileSchema.parse(canonical);
}

/**
 * Stable behavior-bearing hash input. Presentation and revalidation timestamps do not move the
 * profile identity; credential references and all effective behavior do.
 */
export function canonicalProjectProfileHashInput(value: unknown): unknown {
  const profile = canonicalizeProjectProfile(value);
  const document = (binding: Record<string, unknown> | null): unknown => {
    if (binding === null) return null;
    const {
      lastValidated: _lastValidated,
      validationState: _validationState,
      ...identity
    } = binding;
    return identity;
  };
  return {
    profileVersion: profile.profileVersion,
    projectId: profile.projectId,
    targetRoot: profile.targetRoot,
    targetRootIdentity: profile.targetRootIdentity,
    workspaceRoot: profile.workspaceRoot,
    shadowRoot: profile.shadowRoot,
    authority: {
      targetDescription: document(profile.authority.targetDescription),
      masterBenchmark: document(profile.authority.masterBenchmark),
      projectIntent: document(profile.authority.projectIntent),
      additionalDocuments: profile.authority.additionalDocuments.map((entry) => document(entry)),
    },
    recognition: profile.recognition,
    benchmarkRuntime: profile.benchmarkRuntime,
    integrations: profile.integrations,
    state: profile.state,
    provenance: profile.provenance,
  };
}
