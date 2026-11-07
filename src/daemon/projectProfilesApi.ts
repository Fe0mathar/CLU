/**
 * Server-authoritative Project Profile API.
 *
 * The HTTP router delegates here; all persistence, optimistic concurrency, canonical Target Root
 * uniqueness, readiness, secret filtering and deletion safety remain in control-plane services.
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadMeasurementCatalogue } from '../analysis/measure/catalogue.js';
import { GATEWAY_TASK_TYPES, loadGatewayPolicies } from '../ai/gateway/policy.js';
import type { Runtime } from '../control/runtime.js';
import {
  assessAuthorityConflicts,
  assessProjectReadiness,
  prepareGovernedDocument,
  prepareProjectProfileDraft,
  ProjectProfileDraftPreparationError,
  inspectProjectAuthority,
  inspectProjectGitReadiness,
  ProjectProfileRegistry,
  resolveProjectBenchmarkRuntime,
  resolveProjectRecognitionConfiguration,
  testProjectBrowserReadiness,
  testProjectGatewayReadiness,
  testProjectHostReadiness,
  type ProjectBrowserReadiness,
  type ProjectGatewayReadiness,
  type ProjectHostLaunchBinding,
  type ProjectHostReadiness,
  type ProjectReadinessAssessment,
  type ProjectReadinessRequirements,
} from '../control/projectProfiles/index.js';
import {
  hasWindowsOpenAiCredential,
  promptWindowsOpenAiCredential,
  readWindowsOpenAiCredential,
  windowsOpenAiCredentialReference,
} from '../control/projectProfiles/windowsOpenAiCredential.js';
import { HostClient, type HostBanner } from '../experiment/host/hostClient.js';
import { originAllowed } from '../experiment/browser/browserAgent.js';
import { resolveExecutablePath } from '../control/projectProfiles/hostReadiness.js';
import {
  launchGitHubProfileSignIn,
  listGitHubProfileRepositories,
  verifyGitHubProfileRepository,
} from '../integration/git/githubProfileConnection.js';
import { assertNoSecretMaterial, redactSecretText } from '../shared/secretSafety.js';
import {
  projectIdSchema,
  projectProfileSchema,
  type Actor,
  type ProjectProfileRecord,
} from '../shared/schemas.js';

export const PROJECT_PROFILES_API_VERSION = 'clue-project-profiles-api/1' as const;
export const PROJECT_PROFILES_API_MAX_BODY_BYTES = 1024 * 1024;

export interface ProjectProfileStaticValidation {
  readonly validationVersion: 'clue-project-profile-validation/1';
  readonly projectId: string;
  readonly generation: number;
  readonly projectProfileHash: string;
  readonly valid: boolean;
  readonly state: 'VALID' | 'INCOMPLETE' | 'BLOCKED' | 'INVALID';
  readonly authority: ReturnType<typeof inspectProjectAuthority>;
  readonly authorityConflicts: ReturnType<typeof assessAuthorityConflicts>;
  readonly benchmarkRuntime: ReturnType<typeof resolveProjectBenchmarkRuntime>;
  readonly recognition: ReturnType<typeof resolveProjectRecognitionConfiguration> | null;
  readonly recognitionError: { readonly code: string; readonly detail: string } | null;
  readonly git: ReturnType<typeof inspectProjectGitReadiness>;
  readonly problems: readonly string[];
  readonly checkedAt: string;
}

export interface ProjectProfilesApiOptions {
  readonly registry: ProjectProfileRegistry;
  readonly runtime: Runtime;
  readonly actor?: Actor;
  /**
   * Live atomic runtime switching is optional because a legacy dashboard owns one Runtime. When
   * absent, HTTP activation fails closed instead of changing only the registry while the page keeps
   * displaying the old target. Offline activation remains available through the CLI.
   */
  readonly activateProject?: (
    record: ProjectProfileRecord,
    actor: Actor,
  ) => Promise<unknown> | unknown;
  readonly hostProbe?: (binding: ProjectHostLaunchBinding) => Promise<HostBanner>;
  /** Interactive Windows account and key operations are for the loopback dashboard. */
  readonly allowHostConnections?: boolean;
  readonly now?: () => string;
}

export class ProjectProfilesApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ProjectProfilesApiError';
  }
}

type ConnectionCache = {
  host?: ProjectHostReadiness;
  browser?: ProjectBrowserReadiness;
  gateway?: ProjectGatewayReadiness;
};

export function validateProjectProfileRecord(
  record: ProjectProfileRecord,
  checkedAt = new Date().toISOString(),
): ProjectProfileStaticValidation {
  const authority = inspectProjectAuthority(record);
  const authorityConflicts = assessAuthorityConflicts(authority);
  const benchmarkRuntime = resolveProjectBenchmarkRuntime(record, authority.manifest);
  let recognition: ReturnType<typeof resolveProjectRecognitionConfiguration> | null = null;
  let recognitionError: { readonly code: string; readonly detail: string } | null = null;
  try {
    recognition = resolveProjectRecognitionConfiguration(record);
  } catch (error) {
    recognitionError = {
      code: errorCode(error, 'PROJECT_RECOGNITION_INVALID'),
      detail: safeMessage(error),
    };
  }
  const git = inspectProjectGitReadiness(record, { checkedAt });
  const problems = [
    ...authority.issues.map((issue) => `${issue.code}: ${issue.detail}`),
    ...authorityConflicts.structuralReasons,
    ...authorityConflicts.unresolved.map((item) => `${item.conflictId}: ${item.description}`),
    ...authorityConflicts.staleResolutions.map((item) => `${item.conflictId}: stale resolution`),
    ...benchmarkRuntime.issues.map((issue) => `${issue.code}: ${issue.detail}`),
    ...(recognitionError === null ? [] : [`${recognitionError.code}: ${recognitionError.detail}`]),
    ...(git.localOperationsReady ? [] : [`${git.code}: ${git.detail}`]),
  ];
  const invalid =
    authority.state === 'INVALID' ||
    authorityConflicts.state !== 'CLEAR' ||
    benchmarkRuntime.state === 'INVALID' ||
    git.state === 'INVALID';
  const blocked = authority.state === 'DRIFTED' || git.state === 'BLOCKED';
  const incomplete =
    authority.state === 'INCOMPLETE' ||
    benchmarkRuntime.state === 'INCOMPLETE' ||
    recognition === null;
  const state: ProjectProfileStaticValidation['state'] = invalid
    ? 'INVALID'
    : blocked
      ? 'BLOCKED'
      : incomplete
        ? 'INCOMPLETE'
        : 'VALID';
  return Object.freeze({
    validationVersion: 'clue-project-profile-validation/1' as const,
    projectId: record.profile.projectId,
    generation: record.generation,
    projectProfileHash: record.projectProfileHash,
    valid: state === 'VALID',
    state,
    authority,
    authorityConflicts,
    benchmarkRuntime,
    recognition,
    recognitionError,
    git,
    problems: Object.freeze(problems),
    checkedAt,
  });
}

export class ProjectProfilesApiService {
  public readonly registry: ProjectProfileRegistry;
  private readonly runtime: Runtime;
  private readonly actor: Actor;
  private readonly activateProject: ProjectProfilesApiOptions['activateProject'];
  private readonly hostProbe: (binding: ProjectHostLaunchBinding) => Promise<HostBanner>;
  private readonly now: () => string;
  private readonly allowHostConnections: boolean;
  private readonly connections = new Map<string, ConnectionCache>();
  private readonly credentialPrompts = new Set<string>();

  public constructor(options: ProjectProfilesApiOptions) {
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.actor = options.actor ?? 'daemon';
    this.activateProject = options.activateProject;
    this.hostProbe = options.hostProbe ?? ((binding) => defaultHostProbe(binding, this.runtime));
    this.now = options.now ?? (() => new Date().toISOString());
    this.allowHostConnections = options.allowHostConnections === true;
  }

  public list(): unknown {
    this.registry.recover();
    this.registry.verifyIntegrity();
    return {
      apiVersion: PROJECT_PROFILES_API_VERSION,
      registryGeneration: this.registry.readState().generation,
      active: this.registry.active(),
      projects: this.registry.listMetadata(),
    };
  }

  public show(projectId: string): unknown {
    const record = this.requireRecord(projectId);
    return {
      apiVersion: PROJECT_PROFILES_API_VERSION,
      active: this.registry.active(),
      record,
    };
  }

  /** Prepare one strict non-persistent profile draft from small operator input. */
  public prepareDraft(input: unknown): unknown {
    assertNoSecretMaterial(input, 'Project Profile draft preparation request');
    return prepareProjectProfileDraft(input, this.registry, () => {
      const config = this.runtime.config;
      const models = new Set<string>();
      if (config.gateway.enabled) {
        const { routing } = loadGatewayPolicies(this.runtime.repoRoot, config);
        for (const task of GATEWAY_TASK_TYPES) {
          const route = routing.routes[task];
          if (route.enabled && route.model !== null) models.add(route.model);
        }
      }
      return {
        hostScript: join(this.runtime.repoRoot, 'scripts', 'clue-host.ps1'),
        autonomousProfile: config.powershell.autonomous_profile,
        browserPort: config.browser.remote_debugging_port,
        allowedOrigins: config.browser.allowed_origins,
        modelId: models.size === 1 ? [...models][0] ?? null : null,
        gatewayEnabled: config.gateway.enabled,
      };
    });
  }

  /** Resolve and hash one governed Markdown document without making the browser authority. */
  public prepareDocument(input: unknown): unknown {
    assertNoSecretMaterial(input, 'Governed document preparation request');
    return prepareGovernedDocument(input, this.now());
  }

  public create(profileInput: unknown, actor = this.actor): unknown {
    assertNoSecretMaterial(profileInput, 'Project Profile create request');
    const profile = projectProfileSchema.parse(profileInput);
    const record = this.registry.create(profile, { actor, reason: 'API_CREATE' });
    return { apiVersion: PROJECT_PROFILES_API_VERSION, record };
  }

  public update(
    projectId: string,
    profileInput: unknown,
    expectedGeneration: number,
    actor = this.actor,
  ): unknown {
    assertNoSecretMaterial(profileInput, 'Project Profile update request');
    const id = projectIdSchema.parse(projectId);
    this.requireNoCredentialPrompt(id);
    const profile = projectProfileSchema.parse(profileInput);
    if (profile.projectId !== id) {
      throw new ProjectProfilesApiError(
        'PROJECT_ID_REBIND_FORBIDDEN',
        `Request path names ${id}, but the draft declares ${profile.projectId}.`,
        409,
      );
    }
    const record = this.registry.update(id, profile, expectedGeneration, {
      actor,
      reason: 'API_UPDATE',
    });
    this.connections.delete(cacheKey(record));
    return { apiVersion: PROJECT_PROFILES_API_VERSION, record };
  }

  public delete(
    projectId: string,
    expectedGeneration: number,
    confirmation: unknown,
    actor = this.actor,
  ): unknown {
    const id = projectIdSchema.parse(projectId);
    this.requireNoCredentialPrompt(id);
    const current = this.requireRecord(id);
    const expectedPhrase = deleteConfirmation(current);
    if (confirmation !== expectedPhrase) {
      throw new ProjectProfilesApiError(
        'DELETE_CONFIRMATION_REQUIRED',
        `Deleting this CLU-E Project Profile requires exact confirmation: ${expectedPhrase}`,
        409,
      );
    }
    if (
      this.runtime.projectProfile?.profile.projectId === id ||
      this.registry.activeProjectId() === id
    ) {
      throw new ProjectProfilesApiError(
        'ACTIVE_PROJECT_DELETE_FORBIDDEN',
        `Project ${id} is active. Activate another project and restart/switch the runtime before deletion.`,
        409,
      );
    }
    this.registry.delete(id, expectedGeneration, { actor, reason: 'API_DELETE_PROFILE_ONLY' });
    this.connections.delete(cacheKey(current));
    return {
      apiVersion: PROJECT_PROFILES_API_VERSION,
      deleted: true,
      projectId: id,
      targetRepositoryDeleted: false,
      projectWorkspaceDeleted: false,
    };
  }

  public async activate(
    projectId: string,
    expectedGeneration: number,
    expectedProfileHash: string,
    actor = this.actor,
  ): Promise<unknown> {
    this.requireNoCredentialPrompt(projectId);
    const record = this.requireRecord(projectId);
    assertRecordPrecondition(record, expectedGeneration, expectedProfileHash);
    if (this.activateProject === undefined) {
      throw new ProjectProfilesApiError(
        'RUNTIME_SWITCH_UNAVAILABLE',
        'This dashboard owns a single legacy Runtime and cannot truthfully publish a live project switch. Use `clue project activate` for next-startup activation, or start the dashboard through a ProjectRuntimeManager.',
        409,
      );
    }
    const result = await this.activateProject(record, actor);
    const pointer = this.registry.active();
    if (pointer === null || pointer.projectId !== record.profile.projectId) {
      throw new ProjectProfilesApiError(
        'ACTIVATION_PUBLICATION_MISMATCH',
        'The runtime switch returned without publishing the requested registry generation.',
        500,
      );
    }
    return { apiVersion: PROJECT_PROFILES_API_VERSION, pointer, result };
  }

  public validate(projectId: string): ProjectProfileStaticValidation {
    return validateProjectProfileRecord(this.requireRecord(projectId), this.now());
  }

  public readiness(
    projectId: string,
    operation: 'local-proof' | 'ai-candidate' | 'browser-benchmark' | 'publication' = 'local-proof',
  ): ProjectReadinessAssessment {
    const record = this.requireRecord(projectId);
    const validation = this.validate(projectId);
    const connection = this.connections.get(cacheKey(record)) ?? {};
    const metric = this.metricCatalogueState();
    return assessProjectReadiness({
      record,
      authority: validation.authority,
      authorityConflicts: validation.authorityConflicts,
      benchmarkRuntime: validation.benchmarkRuntime,
      recognition: validation.recognition,
      recognitionError: validation.recognitionError,
      host: connection.host ?? null,
      git: validation.git,
      browser: connection.browser ?? null,
      gateway: connection.gateway ?? null,
      metricCatalogueValid: metric.valid,
      metricCatalogueDetail: metric.detail,
      requirements: requirementsFor(operation),
      checkedAt: this.now(),
    });
  }

  public async testHost(projectId: string): Promise<ProjectHostReadiness> {
    const record = this.requireRecord(projectId);
    const result = await testProjectHostReadiness(record, {
      globalPowerShellExecutable: this.runtime.config.powershell.executable,
      probe: this.hostProbe,
      checkedAt: this.now(),
    });
    this.remember(record, { host: result });
    return result;
  }

  public testGit(projectId: string): ReturnType<typeof inspectProjectGitReadiness> {
    const record = this.requireRecord(projectId);
    return inspectProjectGitReadiness(record, { checkedAt: this.now() });
  }

  public signInGitHub(projectId: string): ReturnType<typeof launchGitHubProfileSignIn> {
    this.requireHostConnections();
    return launchGitHubProfileSignIn(this.requireRecord(projectId).profile.targetRoot);
  }

  public listGitHub(projectId: string): ReturnType<typeof listGitHubProfileRepositories> {
    this.requireHostConnections();
    return listGitHubProfileRepositories(this.requireRecord(projectId).profile.targetRoot);
  }

  public async connectGitHub(
    projectId: string, expectedGeneration: number, repository: string, branch: string,
  ): Promise<unknown> {
    this.requireHostConnections();
    this.requireNoCredentialPrompt(projectId);
    const current = this.requireCurrentGeneration(projectId, expectedGeneration);
    const result = await verifyGitHubProfileRepository(current.profile.targetRoot, { nameWithOwner: repository, branch });
    if (result.state !== 'CONNECTED' || result.repository === null ||
        result.branch === null || result.baseCommit === null) return result;
    this.requireNoCredentialPrompt(projectId);
    const profile = current.profile;
    const git = {
      ...profile.integrations.git,
      repositoryRoot: profile.targetRoot,
      provider: 'github' as const,
      remote: result.repository.remoteUrl,
      defaultBranch: result.branch,
      publicationMode: 'REMOTE_REGISTERED' as const,
    };
    const previous = profile.integrations.git;
    if (previous.repositoryRoot === git.repositoryRoot && previous.provider === git.provider &&
        previous.remote === git.remote && previous.defaultBranch === git.defaultBranch &&
        previous.publicationMode === git.publicationMode) {
      const latest = this.requireCurrentGeneration(projectId, expectedGeneration);
      return { ...result, record: latest };
    }
    const record = this.registry.update(
      projectId, { ...profile, integrations: { ...profile.integrations, git } }, expectedGeneration,
      { actor: this.actor, reason: 'CONNECT_GITHUB_REPOSITORY' },
    );
    this.connections.delete(cacheKey(current));
    return { ...result, record };
  }

  public openAiKeyStatus(projectId: string): unknown {
    this.requireHostConnections();
    const { profile } = this.requireRecord(projectId);
    const stored = hasWindowsOpenAiCredential(profile.projectId);
    const credential = profile.integrations.gpt.credential;
    const bound = credential.source === 'project-override' &&
      credential.value === windowsOpenAiCredentialReference(profile.projectId);
    return {
      state: stored && bound ? 'stored' : 'unavailable',
      detail: stored && bound ? 'A Windows Credential Manager key is bound to this profile.'
        : stored ? 'A Windows key is saved but this profile uses a different credential reference.'
          : 'A Windows Credential Manager key is unavailable for this profile.',
    };
  }

  public async setOpenAiKey(projectId: string, expectedGeneration: number): Promise<unknown> {
    this.requireHostConnections();
    this.requireCurrentGeneration(projectId, expectedGeneration);
    if (this.credentialPrompts.size !== 0) {
      throw new ProjectProfilesApiError('OPENAI_KEY_PROMPT_BUSY', 'Complete the open Windows key prompt first.', 409);
    }
    this.credentialPrompts.add(projectId);
    try {
      const result = await promptWindowsOpenAiCredential(projectId);
      if (result.state === 'cancelled') return { state: result.state, detail: 'Key entry was cancelled.' };
      if (result.state === 'unsupported') return { state: result.state, detail: 'Key entry requires an interactive Windows dashboard.' };
      if (result.state !== 'stored') return { state: result.state, detail: 'Windows could not save the key.' };
      const latest = this.requireCurrentGeneration(projectId, expectedGeneration);
      const profile = latest.profile;
      const gpt = profile.integrations.gpt;
      const credential = gpt.credential;
      const alreadyBound = credential.source === 'project-override' && credential.value === result.credentialReference;
      const record = alreadyBound ? latest : this.registry.update(
        projectId,
        {
          ...profile,
          integrations: {
            ...profile.integrations,
            gpt: {
              ...gpt,
              credential: {
                source: 'project-override',
                defaultKey: 'gateway.credential',
                value: result.credentialReference,
              },
            },
          },
        },
        expectedGeneration,
        { actor: this.actor, reason: 'BIND_WINDOWS_OPENAI_CREDENTIAL' },
      );
      this.connections.delete(cacheKey(latest));
      return { state: 'stored', detail: 'Key saved in Windows Credential Manager. Test the configured model to confirm access.', record };
    } finally {
      this.credentialPrompts.delete(projectId);
    }
  }

  public async testBrowser(projectId: string, writeVisibleMarker = false): Promise<ProjectBrowserReadiness> {
    const record = this.requireRecord(projectId);
    const result = await testProjectBrowserReadiness(record, {
      globalChromeExecutable: this.runtime.config.browser.executable,
      checkedAt: this.now(),
      writeVisibleMarker,
    });
    this.remember(record, { browser: result });
    return result;
  }

  public async openTestChrome(projectId: string, expectedGeneration: number): Promise<unknown> {
    this.requireHostConnections();
    const record = this.requireCurrentGeneration(projectId, expectedGeneration);
    if (process.platform !== 'win32') return { state: 'UNAVAILABLE', detail: 'The visible Chrome launcher requires an interactive Windows session.' };
    const profile = record.profile;
    const chrome = profile.integrations.chrome;
    const url = chrome.targetUrl === null ? null : new URL(chrome.targetUrl);
    if (chrome.launchMode !== 'CLUE_MANAGED' || url === null || url.username || url.password ||
        !originAllowed(url.href, chrome.allowedOrigins) || chrome.remoteDebuggingPort < 1024) {
      return { state: 'BLOCKED', detail: 'Save CLU-E Managed mode, a permitted HTTP(S) Target URL and a debugging port from 1024 to 65535.' };
    }
    const config = this.runtime.config;
    const pwsh = resolveExecutablePath(config.powershell.executable, process.env);
    const executable = resolveExecutablePath(
      chrome.executable.source === 'global-default' ? config.browser.executable : chrome.executable.value,
      process.env,
    );
    if (pwsh === null || executable === null) {
      return { state: 'UNAVAILABLE', detail: 'The configured PowerShell or Chrome executable is unavailable.' };
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      /^(?:path|pathext|systemroot|systemdrive|windir|comspec|userprofile|home|homedrive|homepath|appdata|localappdata|programdata|programfiles(?:\(x86\))?|temp|tmp)$/iu.test(name),
    ));
    const args = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(this.runtime.repoRoot, 'scripts', 'launch-test-browser.ps1'),
      '-Executable', executable, '-ProfileDir', chrome.dedicatedProfileDirectory,
      '-Port', String(chrome.remoteDebuggingPort), '-Url', url.href, '-AllowedOrigin', url.origin,
      '-ForbiddenRoots', profile.targetRoot,
      '-ProjectId', profile.projectId, '-TargetRootIdentity', profile.targetRootIdentity,
      '-ProjectProfileHash', record.projectProfileHash, '-ProfileGeneration', String(record.generation), '-Json',
    ];
    const launched = await new Promise<{ ok: boolean; headless: boolean | null; detail: string }>((done) => {
      execFile(pwsh, args, { cwd: this.runtime.repoRoot, env, windowsHide: true, timeout: 45_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        try {
          const output = requireObject(JSON.parse(stdout.replace(/^\uFEFF/u, '')));
          done({
            ok: error === null && output['status'] === 'ok',
            headless: typeof output['headless'] === 'boolean' ? output['headless'] : null,
            detail: typeof output['message'] === 'string' ? safeMessage(output['message']) : 'The launcher returned no status detail.',
          });
        } catch {
          done({ ok: false, headless: null, detail: 'The Chrome launcher did not return a valid result. Check PowerShell and the project browser settings.' });
        }
      });
    });
    if (!launched.ok || launched.headless !== false) {
      return { state: 'BLOCKED', detail: launched.ok ? 'The registered session is headless. Close it before opening a visible test window.' : launched.detail };
    }
    this.requireCurrentGeneration(projectId, expectedGeneration);
    const tested = await this.testBrowser(projectId, true);
    return tested.ready ? {
      ...tested, detail: 'Dedicated Chrome connected. Open DevTools Console to see the CLU-E verification message.',
    } : tested;
  }

  public async testGpt(projectId: string): Promise<ProjectGatewayReadiness> {
    const record = this.requireRecord(projectId);
    const policies = loadGatewayPolicies(this.runtime.repoRoot, this.runtime.config);
    const result = await testProjectGatewayReadiness(record, this.runtime.config, policies, {
      globalCredentialReference: `env:${this.runtime.config.gateway.api_key_env}`,
      resolveCredentialReference: async (reference) =>
        reference === windowsOpenAiCredentialReference(record.profile.projectId)
          ? readWindowsOpenAiCredential(reference) : null,
      checkedAt: this.now(),
    });
    this.remember(record, { gateway: result });
    return result;
  }

  private metricCatalogueState(): { readonly valid: boolean; readonly detail: string } {
    try {
      const loaded = loadMeasurementCatalogue(
        readText(join(this.runtime.repoRoot, 'config', 'measurements', 'catalogue.yaml')),
      );
      return {
        valid: true,
        detail: `Metric Catalogue ${loaded.identity.contentHash} is valid.`,
      };
    } catch (error) {
      return { valid: false, detail: safeMessage(error) };
    }
  }

  private requireRecord(projectId: string): ProjectProfileRecord {
    this.registry.recover();
    this.registry.verifyIntegrity();
    return this.registry.getProfile(projectIdSchema.parse(projectId));
  }

  private requireHostConnections(): void {
    if (!this.allowHostConnections) {
      throw new ProjectProfilesApiError('LOCAL_DASHBOARD_REQUIRED', 'Open Configuration on the local dashboard to manage Windows credentials.', 403);
    }
  }

  private requireNoCredentialPrompt(projectId: string): void {
    if (this.credentialPrompts.has(projectId)) {
      throw new ProjectProfilesApiError('OPENAI_KEY_PROMPT_BUSY', 'Complete the Windows key prompt before changing this profile.', 409);
    }
  }

  private requireCurrentGeneration(projectId: string, expectedGeneration: number): ProjectProfileRecord {
    const record = this.requireRecord(projectId);
    assertRecordPrecondition(record, expectedGeneration, record.projectProfileHash);
    return record;
  }

  private remember(record: ProjectProfileRecord, update: ConnectionCache): void {
    const key = cacheKey(record);
    this.connections.set(key, { ...(this.connections.get(key) ?? {}), ...update });
  }
}

/** HTTP adapter. Returns true only when the route belongs to /api/projects. */
export async function handleProjectProfilesApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ProjectProfilesApiService,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'projects') return false;

  try {
    let data: unknown;
    if (parts.length === 2 && request.method === 'GET') {
      data = service.list();
      return reply(response, 200, data);
    }
    if (parts.length === 2 && request.method === 'POST') {
      const body = await readJsonBody(request);
      data = service.create(requireObject(body)['profile'] ?? body);
      return reply(response, 201, data);
    }

    if (parts.length === 3 && parts[2] === 'prepare-draft' && request.method === 'POST') {
      return reply(response, 200, service.prepareDraft(await readJsonBody(request)));
    }
    if (parts.length === 3 && parts[2] === 'prepare-document' && request.method === 'POST') {
      return reply(response, 200, service.prepareDocument(await readJsonBody(request)));
    }

    const projectId = decodeURIComponent(parts[2] ?? '');
    if (projectId === '') throw new ProjectProfilesApiError('PROJECT_ID_REQUIRED', 'Project ID is required.');
    const action = parts[3] ?? null;

    if (parts.length === 3 && request.method === 'GET') {
      return reply(response, 200, service.show(projectId));
    }
    if (parts.length === 3 && request.method === 'PUT') {
      const body = requireObject(await readJsonBody(request));
      return reply(
        response,
        200,
        service.update(
          projectId,
          body['profile'],
          requiredGeneration(body),
        ),
      );
    }
    if (parts.length === 3 && request.method === 'DELETE') {
      const body = requireObject(await readJsonBody(request));
      return reply(
        response,
        200,
        service.delete(
          projectId,
          requiredGeneration(body),
          body['confirmation'],
        ),
      );
    }
    if (request.method === 'POST' && action === 'activate') {
      const body = requireObject(await readJsonBody(request));
      const expectedHash = body['expectedProfileHash'];
      if (typeof expectedHash !== 'string') {
        throw new ProjectProfilesApiError('PROFILE_HASH_REQUIRED', 'expectedProfileHash is required.');
      }
      return reply(
        response,
        200,
        await service.activate(
          projectId,
          requiredGeneration(body),
          expectedHash,
        ),
      );
    }
    if (request.method === 'POST' && action === 'validate') {
      return reply(response, 200, service.validate(projectId));
    }
    if (request.method === 'GET' && action === 'readiness') {
      return reply(response, 200, service.readiness(projectId, parseOperation(url.searchParams.get('operation'))));
    }
    if (request.method === 'POST' && action === 'test-host') {
      return reply(response, 200, await service.testHost(projectId));
    }
    if (request.method === 'POST' && action === 'test-git') {
      return reply(response, 200, service.testGit(projectId));
    }
    if (request.method === 'POST' && action === 'test-chrome') {
      return reply(response, 200, await service.testBrowser(projectId));
    }
    if (parts.length === 4 && request.method === 'POST' && action === 'open-test-chrome') {
      const body = requireObject(await readJsonBody(request));
      return reply(response, 200, await service.openTestChrome(projectId, requiredGeneration(body)));
    }
    if (request.method === 'POST' && action === 'test-gpt') {
      return reply(response, 200, await service.testGpt(projectId));
    }
    if (parts.length === 4 && request.method === 'POST' && action === 'github-sign-in') {
      return reply(response, 200, await service.signInGitHub(projectId));
    }
    if (parts.length === 4 && request.method === 'GET' && action === 'github-repositories') {
      return reply(response, 200, await service.listGitHub(projectId));
    }
    if (parts.length === 4 && request.method === 'POST' && action === 'github-connect') {
      const body = requireObject(await readJsonBody(request));
      const repository = body['repository'];
      const branch = body['branch'];
      if (typeof repository !== 'string' || typeof branch !== 'string') {
        throw new ProjectProfilesApiError('GITHUB_SELECTION_REQUIRED', 'Select a repository and branch.');
      }
      return reply(response, 200, await service.connectGitHub(projectId, requiredGeneration(body), repository, branch));
    }
    if (parts.length === 4 && action === 'openai-key') {
      if (request.method === 'GET') return reply(response, 200, service.openAiKeyStatus(projectId));
      if (request.method === 'POST') {
        const body = requireObject(await readJsonBody(request));
        return reply(response, 200, await service.setOpenAiKey(projectId, requiredGeneration(body)));
      }
    }
    throw new ProjectProfilesApiError('PROJECT_ROUTE_NOT_FOUND', 'Project Profile endpoint not found.', 404);
  } catch (error) {
    const mapped = mapError(error);
    return reply(response, mapped.status, {
      apiVersion: PROJECT_PROFILES_API_VERSION,
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        ...mapped.details,
      },
    });
  }
}

export function deleteConfirmation(record: ProjectProfileRecord): string {
  return `DELETE PROFILE ${record.profile.projectId} ${record.generation} ${record.projectProfileHash.slice(0, 12)}`;
}

async function defaultHostProbe(binding: ProjectHostLaunchBinding, runtime: Runtime): Promise<HostBanner> {
  const subjectId = `PROJECT-READINESS-${binding.projectIdentity.projectId}`;
  const token = runtime.policy.issueToken('daemon', ['process.run.host'], {
    subjectId,
    purpose: 'project-readiness',
    attempt: 1,
  });
  const client = new HostClient({
    executable: binding.executable,
    scriptPath: binding.scriptPath,
    policy: runtime.policy,
    actor: 'daemon',
    tokenSecret: token.secret,
    operationSubjectId: subjectId,
    operationPurpose: 'project-readiness',
    operationAttempt: 1,
    hostRoots: binding.roots,
    projectIdentity: binding.projectIdentity,
  });
  try {
    const result = await client.start();
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    client.stop();
    runtime.policy.revokeToken(token.secret);
  }
}

function requirementsFor(
  operation: 'local-proof' | 'ai-candidate' | 'browser-benchmark' | 'publication',
): Partial<ProjectReadinessRequirements> {
  switch (operation) {
    case 'local-proof':
      return { recognition: true, proof: true };
    case 'ai-candidate':
      return { recognition: true, proof: true, aiCandidateGeneration: true };
    case 'browser-benchmark':
      return { recognition: true, proof: true, browserBenchmark: true };
    case 'publication':
      return { recognition: true, proof: true, gitPublication: true };
  }
}

function parseOperation(
  value: string | null,
): 'local-proof' | 'ai-candidate' | 'browser-benchmark' | 'publication' {
  if (value === null || value === 'local-proof') return 'local-proof';
  if (value === 'ai-candidate' || value === 'browser-benchmark' || value === 'publication') return value;
  throw new ProjectProfilesApiError(
    'READINESS_OPERATION_INVALID',
    `Unknown readiness operation ${JSON.stringify(value)}.`,
  );
}

function cacheKey(record: ProjectProfileRecord): string {
  return `${record.profile.projectId}:${record.generation}:${record.projectProfileHash}`;
}

function assertRecordPrecondition(
  record: ProjectProfileRecord,
  expectedGeneration: number,
  expectedHash: string,
): void {
  if (
    record.generation !== expectedGeneration ||
    record.projectProfileHash !== expectedHash
  ) {
    throw new ProjectProfilesApiError(
      'PROFILE_PRECONDITION_FAILED',
      `Project ${record.profile.projectId} is generation ${record.generation} / ${record.projectProfileHash}; the request expected ${expectedGeneration} / ${expectedHash}.`,
      409,
      { currentGeneration: record.generation, currentProfileHash: record.projectProfileHash },
    );
  }
}

function requiredGeneration(body: Record<string, unknown>): number {
  const value = body['expectedGeneration'];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ProjectProfilesApiError(
      'EXPECTED_GENERATION_REQUIRED',
      'expectedGeneration must be a positive integer.',
    );
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectProfilesApiError('JSON_OBJECT_REQUIRED', 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > PROJECT_PROFILES_API_MAX_BODY_BYTES) {
      throw new ProjectProfilesApiError(
        'REQUEST_TOO_LARGE',
        `Project Profile request exceeds ${PROJECT_PROFILES_API_MAX_BODY_BYTES} bytes.`,
        413,
      );
    }
    chunks.push(bytes);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
    assertNoSecretMaterial(value, 'Project Profiles API request');
    return value;
  } catch (error) {
    if (error instanceof ProjectProfilesApiError) throw error;
    if (error instanceof SyntaxError) {
      throw new ProjectProfilesApiError('JSON_INVALID', `Request body is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

function reply(response: ServerResponse, status: number, value: unknown): true {
  assertNoSecretMaterial(value, 'Project Profiles API response');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(status >= 400 ? value : {
    apiVersion: PROJECT_PROFILES_API_VERSION,
    ok: true,
    data: value,
  }));
  return true;
}

function mapError(error: unknown): ProjectProfilesApiError {
  if (error instanceof ProjectProfilesApiError) return error;
  if (error instanceof ProjectProfileDraftPreparationError) {
    const status = error.code.includes('ALREADY_REGISTERED') ? 409 : 400;
    return new ProjectProfilesApiError(error.code, error.message, status, error.details);
  }
  const code = errorCode(error, 'PROJECT_PROFILE_OPERATION_FAILED');
  const status =
    code.includes('NOT_FOUND') || code === 'PROJECT_NOT_REGISTERED' || code === 'PROFILE_NOT_FOUND'
      ? 404
      : code.includes('CONFLICT') || code.includes('ALREADY') || code.includes('FORBIDDEN') || code.includes('LOCKED')
        ? 409
        : code.includes('MALFORMED') || code.includes('INVALID') || code.includes('REQUIRED')
          ? 400
          : 500;
  const details: Record<string, unknown> = {};
  if (error !== null && typeof error === 'object') {
    for (const key of ['projectId', 'existingProjectId', 'currentGeneration', 'path'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (value !== undefined && value !== null) details[key] = value;
    }
  }
  return new ProjectProfilesApiError(code, safeMessage(error), status, details);
}

function errorCode(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const value = (error as { readonly code?: unknown }).code;
    if (typeof value === 'string' && value !== '') return value;
  }
  return fallback;
}

function safeMessage(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error)).text;
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
