/**
 * Project-scoped PowerShell/host readiness.
 *
 * The Project Profile is the root authority. This module resolves the effective executable,
 * validates all profile-owned roots before launch, and evaluates a typed handshake without ever
 * accepting a banner from another Project Profile generation.
 */

import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';

import {
  assertSamePathIdentity,
  resolvePathIdentity,
} from '../../shared/pathIdentity.js';
import {
  assertProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import { projectProfileRecordSchema, type ProjectProfileRecord } from '../../shared/schemas.js';
import { HostClientError, type HostBanner, type HostRoots } from '../../experiment/host/hostClient.js';
import { assertProjectProfileHash } from './profileHash.js';

export const PROJECT_HOST_READINESS_STATES = [
  'READY',
  'UNAVAILABLE',
  'INVALID PATH',
  'HANDSHAKE FAILED',
  'ROOT MISMATCH',
] as const;

export type ProjectHostReadinessState = (typeof PROJECT_HOST_READINESS_STATES)[number];

export interface ProjectHostLaunchBinding {
  readonly executable: string;
  readonly scriptPath: string;
  readonly roots: HostRoots;
  readonly projectIdentity: ProjectOperationIdentity;
}

export interface ProjectHostReadiness {
  readonly state: ProjectHostReadinessState;
  readonly ready: boolean;
  readonly code: string;
  readonly detail: string;
  readonly binding: ProjectHostLaunchBinding | null;
  readonly banner: HostBanner | null;
  readonly checkedAt: string;
}

export interface ProjectHostReadinessOptions {
  /** Installation-level value used when the profile selects the global PowerShell default. */
  readonly globalPowerShellExecutable: string;
  /**
   * The caller owns policy/token construction. The probe must launch/handshake using the exact
   * binding supplied here and return only a schema-validated HostBanner.
   */
  readonly probe: (binding: ProjectHostLaunchBinding) => Promise<HostBanner>;
  readonly checkedAt?: string;
  /** Environment used only to resolve a bare executable name through PATH/PATHEXT. */
  readonly environment?: NodeJS.ProcessEnv;
}

export type ProjectHostBindingProblemCode =
  | 'HOST_EXECUTABLE_UNAVAILABLE'
  | 'HOST_SCRIPT_INVALID'
  | 'HOST_ROOT_INVALID'
  | 'HOST_ROOT_MISMATCH';

export class ProjectHostBindingError extends Error {
  public readonly code: ProjectHostBindingProblemCode;

  public constructor(code: ProjectHostBindingProblemCode, message: string) {
    super(message);
    this.name = 'ProjectHostBindingError';
    this.code = code;
  }
}

/** Builds the exact immutable launch/handshake input for one profile generation. */
export function resolveProjectHostLaunchBinding(
  recordInput: ProjectProfileRecord,
  globalPowerShellExecutable: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProjectHostLaunchBinding {
  const record = projectProfileRecordSchema.parse(recordInput);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  const profile = record.profile;
  const powershell = profile.integrations.powershell;
  const executable =
    powershell.executable.source === 'global-default'
      ? globalPowerShellExecutable
      : powershell.executable.value;

  const resolvedExecutable = resolveExecutablePath(executable, environment);
  if (resolvedExecutable === null) {
    throw new ProjectHostBindingError(
      'HOST_EXECUTABLE_UNAVAILABLE',
      `PowerShell executable is unavailable: ${executable}`,
    );
  }
  if (!isFile(powershell.hostScript)) {
    throw new ProjectHostBindingError(
      'HOST_SCRIPT_INVALID',
      `PowerShell host script is not a file: ${powershell.hostScript}`,
    );
  }

  const target = resolvePathIdentity(profile.targetRoot, { zone: 'target', expectedKind: 'directory' });
  const projectRoot = resolvePathIdentity(powershell.projectRoot, { zone: 'target', expectedKind: 'directory' });
  try {
    assertSamePathIdentity(
      target,
      projectRoot,
      'PowerShell Project Root',
    );
  } catch (error) {
    throw new ProjectHostBindingError(
      'HOST_ROOT_MISMATCH',
      error instanceof Error ? error.message : String(error),
    );
  }

  const workspace = requiredDirectory(powershell.workspaceRoot, 'workspace');
  const profileWorkspace = requiredDirectory(profile.workspaceRoot, 'workspace');
  const shadow = requiredDirectory(powershell.shadowRoot, 'shadow');
  const profileShadow = requiredDirectory(profile.shadowRoot, 'shadow');
  const browserProfile = requiredDirectory(
    profile.integrations.chrome.dedicatedProfileDirectory,
    'clue-owned-state',
  );
  try {
    assertSamePathIdentity(profileWorkspace, workspace, 'PowerShell Workspace Root');
    assertSamePathIdentity(profileShadow, shadow, 'PowerShell Shadow Root');
  } catch (error) {
    throw new ProjectHostBindingError(
      'HOST_ROOT_MISMATCH',
      error instanceof Error ? error.message : String(error),
    );
  }

  return Object.freeze({
    executable: resolvedExecutable,
    scriptPath: powershell.hostScript,
    roots: Object.freeze({
      canonical: target.canonicalPath,
      workspace: workspace.canonicalPath,
      shadow: shadow.canonicalPath,
      browserProfile: browserProfile.canonicalPath,
    }),
    projectIdentity: operationIdentityFromProfileRecord(record),
  });
}

/** Executes one controlled handshake and classifies the exact explicit readiness state. */
export async function testProjectHostReadiness(
  recordInput: ProjectProfileRecord,
  options: ProjectHostReadinessOptions,
): Promise<ProjectHostReadiness> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  let record: ProjectProfileRecord;
  try {
    record = projectProfileRecordSchema.parse(recordInput);
    assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  } catch (error) {
    return frozenResult(
      'INVALID PATH',
      'HOST_PROFILE_INVALID',
      errorMessage(error),
      null,
      null,
      checkedAt,
    );
  }
  let binding: ProjectHostLaunchBinding;
  try {
    binding = resolveProjectHostLaunchBinding(
      record,
      options.globalPowerShellExecutable,
      options.environment ?? process.env,
    );
  } catch (error) {
    const fallback = fallbackBinding(record, options.globalPowerShellExecutable);
    if (error instanceof ProjectHostBindingError) {
      const state: ProjectHostReadinessState =
        error.code === 'HOST_EXECUTABLE_UNAVAILABLE'
          ? 'UNAVAILABLE'
          : error.code === 'HOST_ROOT_MISMATCH'
            ? 'ROOT MISMATCH'
            : 'INVALID PATH';
      return frozenResult(state, error.code, error.message, fallback, null, checkedAt);
    }
    return frozenResult(
      'INVALID PATH',
      'HOST_BINDING_INVALID',
      errorMessage(error),
      fallback,
      null,
      checkedAt,
    );
  }

  let banner: HostBanner;
  try {
    banner = await options.probe(binding);
  } catch (error) {
    const rootMismatch =
      error instanceof HostClientError &&
      ['ROOT_PARITY_MISMATCH', 'PROJECT_IDENTITY_MISMATCH', 'PATH_PARITY_MISMATCH', 'ZONE_PARITY_MISMATCH']
        .includes(error.code);
    return frozenResult(
      rootMismatch ? 'ROOT MISMATCH' : 'HANDSHAKE FAILED',
      rootMismatch ? 'HOST_ROOT_OR_IDENTITY_MISMATCH' : 'HOST_HANDSHAKE_FAILED',
      errorMessage(error),
      binding,
      null,
      checkedAt,
    );
  }

  try {
    if (banner.roots === undefined) throw new Error('host banner omitted operating roots');
    for (const zone of ['canonical', 'workspace', 'shadow', 'browserProfile'] as const) {
      const expected = resolvePathIdentity(binding.roots[zone], {
        zone: zone === 'canonical' ? 'target' : zone === 'browserProfile' ? 'clue-owned-state' : zone,
      });
      const actual = resolvePathIdentity(banner.roots[zone], {
        zone: zone === 'canonical' ? 'target' : zone === 'browserProfile' ? 'clue-owned-state' : zone,
      });
      assertSamePathIdentity(expected, actual, `host ${zone} root`);
    }
    if (banner.projectIdentity === undefined) {
      throw new Error('host banner omitted Project Profile identity');
    }
    assertProjectOperationIdentity(
      binding.projectIdentity,
      banner.projectIdentity,
      'PowerShell host readiness',
    );
  } catch (error) {
    return frozenResult(
      'ROOT MISMATCH',
      'HOST_ROOT_OR_IDENTITY_MISMATCH',
      errorMessage(error),
      binding,
      banner,
      checkedAt,
    );
  }

  return frozenResult(
    'READY',
    'HOST_READY',
    'PowerShell host handshake, roots, and Project Profile identity agree.',
    binding,
    banner,
    checkedAt,
  );
}

function requiredDirectory(
  path: string,
  zone: 'workspace' | 'shadow' | 'clue-owned-state',
): ReturnType<typeof resolvePathIdentity> {
  try {
    return resolvePathIdentity(path, { zone });
  } catch (error) {
    throw new ProjectHostBindingError(
      'HOST_ROOT_INVALID',
      `${zone} root is invalid: ${errorMessage(error)}`,
    );
  }
}

/** Resolves an absolute/path-qualified executable directly or a bare command through PATH. */
export function resolveExecutablePath(
  configured: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = configured.trim();
  if (value === '') return null;
  const qualified = isAbsolute(value) || value.includes('/') || value.includes('\\');
  if (qualified) {
    const candidate = isAbsolute(value) ? value : resolve(value);
    return isFile(candidate) ? candidate : null;
  }

  const pathValue = environment['PATH'] ?? environment['Path'] ?? environment['path'] ?? '';
  if (pathValue.trim() === '') return null;
  const windows = process.platform === 'win32';
  const extensions = windows && extname(value) === ''
    ? (environment['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((extension) => extension.trim())
        .filter(Boolean)
    : [''];
  for (const directory of pathValue.split(delimiter)) {
    const base = directory.trim() === '' ? process.cwd() : directory.trim();
    for (const extension of extensions) {
      const candidate = resolve(base, `${value}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function fallbackBinding(
  record: ProjectProfileRecord,
  globalPowerShellExecutable: string,
): ProjectHostLaunchBinding {
  const powershell = record.profile.integrations.powershell;
  return Object.freeze({
    executable:
      powershell.executable.source === 'global-default'
        ? globalPowerShellExecutable
        : powershell.executable.value,
    scriptPath: powershell.hostScript,
    roots: Object.freeze({
      canonical: powershell.projectRoot,
      workspace: powershell.workspaceRoot,
      shadow: powershell.shadowRoot,
      browserProfile: record.profile.integrations.chrome.dedicatedProfileDirectory,
    }),
    projectIdentity: operationIdentityFromProfileRecord(record),
  });
}

function frozenResult(
  state: ProjectHostReadinessState,
  code: string,
  detail: string,
  binding: ProjectHostLaunchBinding | null,
  banner: HostBanner | null,
  checkedAt: string,
): ProjectHostReadiness {
  return Object.freeze({
    state,
    ready: state === 'READY',
    code,
    detail,
    binding,
    banner,
    checkedAt,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
