/**
 * Server-side preparation helpers for the Configuration UI.
 *
 * The browser may collect operator input, but it must never invent a physical Target Root
 * identity, a governed-document hash, or a complete Project Profile shape. These helpers turn a
 * small, human-editable request into one strict `clue-project-profile/1` draft or one exact
 * governed-document binding. Persistence still belongs to ProjectProfileRegistry.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import { hashBytes } from '../../shared/ids.js';
import {
  asTargetRootIdentity,
  assertPathZonesDisjoint,
  normalisePathForStorage,
  resolvePathIdentity,
} from '../../shared/pathIdentity.js';
import {
  governedDocumentKindSchema,
  governedDocumentRoleSchema,
  PROJECT_PROFILE_VERSION,
  normaliseProjectIdInput,
  projectIdSchema,
  projectProfileSchema,
  type GovernedDocumentBinding,
  type MasterBenchmarkBinding,
  type ProjectProfile,
} from '../../shared/schemas.js';
import type { ProjectProfileRegistry } from './profileRegistry.js';

export const PROJECT_PROFILE_DRAFT_PREPARATION_VERSION =
  'clue-project-profile-draft-preparation/1' as const;
export const GOVERNED_DOCUMENT_PREPARATION_VERSION =
  'clue-governed-document-preparation/1' as const;

const draftRequestSchema = z
  .object({
    templateProjectId: projectIdSchema.nullable().optional(),
    projectId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(256).nullable().optional(),
    targetRoot: z.string().min(1),
    workspaceRoot: z.string().min(1),
    shadowRoot: z.string().min(1),
    browserProfileDirectory: z.string().min(1).nullable().optional(),
  })
  .strict();

const documentRequestSchema = z
  .object({
    targetRoot: z.string().min(1),
    path: z.string().min(1),
    bindingId: z.string().min(1).max(128),
    kind: governedDocumentKindSchema,
    role: governedDocumentRoleSchema,
    enabled: z.boolean().default(true),
    order: z.number().int().nonnegative(),
    benchmarkId: z.string().min(1).max(128).nullable().optional(),
    benchmarkVersion: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();

export type ProjectProfileDraftPreparationErrorCode =
  | 'PROJECT_DRAFT_TEMPLATE_REQUIRED'
  | 'PROJECT_DRAFT_ID_ALREADY_REGISTERED'
  | 'PROJECT_DRAFT_TARGET_ALREADY_REGISTERED'
  | 'PROJECT_DRAFT_PATH_INVALID'
  | 'GOVERNED_DOCUMENT_INVALID';

export class ProjectProfileDraftPreparationError extends Error {
  public constructor(
    public readonly code: ProjectProfileDraftPreparationErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ProjectProfileDraftPreparationError';
  }
}

export interface PreparedProjectProfileDraft {
  readonly preparationVersion: typeof PROJECT_PROFILE_DRAFT_PREPARATION_VERSION;
  readonly templateProjectId: string | null;
  readonly profile: ProjectProfile;
  readonly warnings: readonly string[];
}

export interface PreparedGovernedDocument {
  readonly preparationVersion: typeof GOVERNED_DOCUMENT_PREPARATION_VERSION;
  readonly binding: GovernedDocumentBinding | MasterBenchmarkBinding;
}

export interface FirstProjectDraftDefaults {
  readonly hostScript: string;
  readonly autonomousProfile: ProjectProfile['integrations']['powershell']['autonomousProfile'];
  readonly browserPort: number;
  readonly allowedOrigins: readonly string[];
  readonly modelId: string | null;
  readonly gatewayEnabled: boolean;
}

/**
 * Creates a non-persistent, strict new-project draft from one existing profile's installation
 * defaults. Target-specific authority, Git publication and browser target identity are cleared.
 */
export function prepareProjectProfileDraft(
  input: unknown,
  registry: ProjectProfileRegistry,
  firstDefaults?: () => FirstProjectDraftDefaults,
): PreparedProjectProfileDraft {
  const request = draftRequestSchema.parse(input);
  const projectId = normaliseProjectIdInput(request.projectId);

  const templateId = request.templateProjectId ?? null;
  const template = templateId === null ? null : registry.get(templateId)?.record.profile ?? null;
  if (template === null && (templateId !== null || firstDefaults === undefined)) {
    throw new ProjectProfileDraftPreparationError(
      'PROJECT_DRAFT_TEMPLATE_REQUIRED',
      templateId === null ? 'Installation defaults are unavailable for the first Project Profile.'
        : `Template Project Profile ${templateId} is not registered. Select an existing template or start from installation defaults.`,
      { projectId, templateProjectId: templateId },
    );
  }

  if (registry.get(projectId) !== null) {
    throw new ProjectProfileDraftPreparationError(
      'PROJECT_DRAFT_ID_ALREADY_REGISTERED',
      `PROJECT ID ALREADY REGISTERED: ${projectId}`,
      { projectId, existingProjectId: projectId },
    );
  }

  let target;
  let workspace;
  let shadow;
  let browserProfile;
  try {
    target = resolvePathIdentity(request.targetRoot, {
      zone: 'target',
      expectedKind: 'directory',
    });
    workspace = resolvePathIdentity(request.workspaceRoot, {
      zone: 'workspace',
      expectedKind: 'directory',
      mustExist: false,
    });
    shadow = resolvePathIdentity(request.shadowRoot, {
      zone: 'shadow',
      expectedKind: 'directory',
      mustExist: false,
    });
    const browserProfileInput =
      request.browserProfileDirectory ??
      join(dirname(workspace.canonicalPath), 'browser-profiles', projectId);
    browserProfile = resolvePathIdentity(browserProfileInput, {
      zone: 'browser-profile',
      expectedKind: 'directory',
      mustExist: false,
    });
    assertPathZonesDisjoint([target, workspace, shadow, browserProfile]);
  } catch (error) {
    throw new ProjectProfileDraftPreparationError(
      'PROJECT_DRAFT_PATH_INVALID',
      error instanceof Error ? error.message : String(error),
      { projectId },
    );
  }

  const duplicate = registry
    .listMetadata()
    .find((entry) => entry.targetRootIdentity === target.identity);
  if (duplicate !== undefined) {
    throw new ProjectProfileDraftPreparationError(
      'PROJECT_DRAFT_TARGET_ALREADY_REGISTERED',
      `TARGET ROOT ALREADY REGISTERED\nExisting Project: ${duplicate.projectId}`,
      { projectId, existingProjectId: duplicate.projectId },
    );
  }

  const roots = {
    projectId,
    displayName: request.displayName ?? projectId,
    targetRoot: target.displayPath,
    targetRootIdentity: asTargetRootIdentity(target.identity),
    workspaceRoot: workspace.displayPath,
    shadowRoot: shadow.displayPath,
    browserProfileDirectory: browserProfile.displayPath,
  };
  const profile = prepareNewTarget(roots, template ?? firstProjectSettings(roots, firstDefaults!()));

  return Object.freeze({
    preparationVersion: PROJECT_PROFILE_DRAFT_PREPARATION_VERSION,
    templateProjectId: templateId,
    profile,
    warnings: Object.freeze([
      'Target Description, Master Benchmark, Project Intent and Additional Governed Documents were intentionally cleared.',
      'Git publication was reset to NO_REMOTE_YET.',
      'Benchmark command/scenario and browser target URL were intentionally cleared for the new target.',
      'GPT credentials start with the installation default. A saved key from another profile is not copied.',
    ]),
  });
}

/** Builds one exact, hash-bound governed-document binding without trusting the browser. */
export function prepareGovernedDocument(
  input: unknown,
  now = new Date().toISOString(),
): PreparedGovernedDocument {
  const request = documentRequestSchema.parse(input);
  const bindingId = projectIdSchema.parse(request.bindingId.trim().toLowerCase());
  const targetRoot = resolveAbsoluteTarget(request.targetRoot);
  const requestedPath = request.path.trim();
  const resolvedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(targetRoot, requestedPath);

  if (!existsSync(resolvedPath)) {
    throw new ProjectProfileDraftPreparationError(
      'GOVERNED_DOCUMENT_INVALID',
      `Governed document does not exist: ${normalisePathForStorage(resolvedPath)}`,
      { path: normalisePathForStorage(resolvedPath) },
    );
  }
  if (extname(resolvedPath).toLowerCase() !== '.md') {
    throw new ProjectProfileDraftPreparationError(
      'GOVERNED_DOCUMENT_INVALID',
      `Governed document must be a .md file: ${normalisePathForStorage(resolvedPath)}`,
      { path: normalisePathForStorage(resolvedPath) },
    );
  }

  let identity;
  try {
    identity = resolvePathIdentity(resolvedPath, {
      zone: 'clue-state',
      expectedKind: 'file',
    });
  } catch (error) {
    throw new ProjectProfileDraftPreparationError(
      'GOVERNED_DOCUMENT_INVALID',
      error instanceof Error ? error.message : String(error),
      { path: normalisePathForStorage(resolvedPath) },
    );
  }

  const distinguishedOrder =
    request.kind === 'target-description'
      ? 0
      : request.kind === 'master-benchmark'
        ? 1
        : request.kind === 'project-intent'
          ? 2
          : request.order;
  const enabled = request.kind === 'additional' ? request.enabled : true;
  const pathForProfile = isAbsolute(requestedPath)
    ? identity.displayPath
    : requestedPath.replace(/\\/gu, '/');
  const base = {
    bindingId,
    kind: request.kind,
    path: pathForProfile,
    canonicalPath: identity.displayPath,
    sha256: hashBytes(readFileSync(identity.canonicalPath)),
    role: request.role,
    enabled,
    order: distinguishedOrder,
    validationState: 'VALID' as const,
    lastValidated: now,
  };
  const binding =
    request.kind === 'master-benchmark'
      ? ({
          ...base,
          kind: 'master-benchmark' as const,
          benchmarkId: request.benchmarkId ?? null,
          benchmarkVersion: request.benchmarkVersion ?? null,
        } satisfies MasterBenchmarkBinding)
      : (base satisfies GovernedDocumentBinding);

  return Object.freeze({
    preparationVersion: GOVERNED_DOCUMENT_PREPARATION_VERSION,
    binding: Object.freeze(binding),
  });
}

interface NewTargetRoots {
  readonly projectId: string;
  readonly displayName: string | null;
  readonly targetRoot: string;
  readonly targetRootIdentity: string;
  readonly workspaceRoot: string;
  readonly shadowRoot: string;
  readonly browserProfileDirectory: string;
}

type NewTargetSettings = Pick<ProjectProfile, 'recognition' | 'benchmarkRuntime' | 'integrations'>;

function firstProjectSettings(roots: NewTargetRoots, defaults: FirstProjectDraftDefaults): NewTargetSettings {
  return {
    recognition: {
      sourceRoots: ['.'],
      excludedPaths: ['.git', 'node_modules', 'dist'],
      buildConfig: null,
      adapters: ['javascript', 'typescript'],
      policy: { policyVersion: 'recognition-policy/1', fullScanOnActivation: false, reuseUnchangedSnapshot: true, followSymlinks: false },
    },
    benchmarkRuntime: {
      workingDirectory: roots.targetRoot, command: null, scenario: null, warmupRuns: 0,
      repetitions: 1, timeoutSeconds: 5_400, targetUrl: null, browserProfile: null,
      resolution: null, additionalRuntimeArgs: [],
    },
    integrations: {
      powershell: {
        executable: { source: 'global-default', defaultKey: 'powershell.executable', value: null },
        hostScript: defaults.hostScript, hostRootAuthority: 'project-profile',
        projectRoot: roots.targetRoot, workspaceRoot: roots.workspaceRoot, shadowRoot: roots.shadowRoot,
        autonomousProfile: defaults.autonomousProfile,
      },
      git: {
        repositoryRoot: roots.targetRoot, remote: null, provider: null, defaultBranch: 'main',
        protectedLandingPolicy: null, currentBasePin: null, publicationMode: 'NO_REMOTE_YET',
      },
      chrome: {
        executable: { source: 'global-default', defaultKey: 'browser.executable', value: null },
        launchMode: 'CLUE_MANAGED', dedicatedProfileDirectory: roots.browserProfileDirectory,
        remoteDebuggingPort: defaults.browserPort, allowedOrigins: [...defaults.allowedOrigins], targetUrl: null,
        targetSelectionRule: 'EXACT_PAGE_ID_THEN_URL_THEN_UNIQUE_ORIGIN',
      },
      gpt: {
        provider: 'openai', modelId: defaults.modelId,
        credential: { source: 'global-default', defaultKey: 'gateway.credential', value: null },
        enabled: defaults.gatewayEnabled && defaults.modelId !== null, fallbackPolicy: 'FORBID',
      },
    },
  };
}

function prepareNewTarget(input: NewTargetRoots, template: NewTargetSettings): ProjectProfile {
  const statePath = (...parts: string[]): string =>
    normalisePathForStorage(join(input.workspaceRoot, ...parts));

  return projectProfileSchema.parse({
    profileVersion: PROJECT_PROFILE_VERSION,
    recognition: structuredClone(template.recognition),
    projectId: input.projectId,
    displayName: input.displayName,
    targetRoot: input.targetRoot,
    targetRootIdentity: input.targetRootIdentity,
    workspaceRoot: input.workspaceRoot,
    shadowRoot: input.shadowRoot,
    authority: {
      targetDescription: null,
      masterBenchmark: null,
      projectIntent: null,
      additionalDocuments: [],
    },
    benchmarkRuntime: {
      ...template.benchmarkRuntime,
      workingDirectory: input.targetRoot,
      command: null,
      scenario: null,
      targetUrl: null,
      browserProfile: input.browserProfileDirectory,
    },
    integrations: {
      powershell: {
        ...template.integrations.powershell,
        projectRoot: input.targetRoot,
        workspaceRoot: input.workspaceRoot,
        shadowRoot: input.shadowRoot,
      },
      git: {
        ...template.integrations.git,
        repositoryRoot: input.targetRoot,
        remote: null,
        provider: null,
        currentBasePin: null,
        publicationMode: 'NO_REMOTE_YET',
      },
      chrome: {
        ...template.integrations.chrome,
        executable: { ...template.integrations.chrome.executable, defaultKey: 'browser.executable' },
        dedicatedProfileDirectory: input.browserProfileDirectory,
        targetUrl: null,
      },
      gpt: {
        ...template.integrations.gpt,
        credential: { source: 'global-default', defaultKey: 'gateway.credential', value: null },
      },
    },
    state: {
      databasePath: statePath('db', 'clue.db'),
      eventLogRoot: statePath('events'),
      artifactStoreRoot: statePath('artifacts'),
      greatBookScope: input.projectId,
      recognitionRoot: statePath('recognition'),
      proofRoot: statePath('proof'),
      cycleRoot: statePath('cycles'),
      snapshotRoot: statePath('snapshots'),
    },
    provenance: { source: 'native' },
  });
}

function resolveAbsoluteTarget(targetRoot: string): string {
  try {
    return resolvePathIdentity(targetRoot, {
      zone: 'target',
      expectedKind: 'directory',
    }).canonicalPath;
  } catch (error) {
    throw new ProjectProfileDraftPreparationError(
      'GOVERNED_DOCUMENT_INVALID',
      error instanceof Error ? error.message : String(error),
      { path: targetRoot },
    );
  }
}
