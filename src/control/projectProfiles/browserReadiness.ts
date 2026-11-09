/** Project-scoped Chrome/browser readiness and exact target identity. */

import { existsSync, statSync } from 'node:fs';

import {
  BrowserAgent,
  BrowserAgentError,
  type BrowserSessionIdentity,
  type TargetInfo,
} from '../../experiment/browser/browserAgent.js';
import { probeChromeConsole } from '../../experiment/browser/browserConsoleProbe.js';
import type { ManagedProjectChrome } from '../../experiment/browser/managedChromeHost.js';
import {
  resolveGovernedBrowserTarget,
  type GovernedBrowserTargetIdentity,
} from '../../experiment/browser/browserTargetResolver.js';
import {
  assertProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import { projectProfileRecordSchema, type ProjectProfileRecord } from '../../shared/schemas.js';
import { resolveExecutablePath } from './hostReadiness.js';
import { assertProjectProfileHash } from './profileHash.js';

export const PROJECT_BROWSER_READINESS_STATES = [
  'READY',
  'CHROME NOT FOUND',
  'DEBUG ENDPOINT UNAVAILABLE',
  'SESSION NOT ESTABLISHED',
  'TARGET NOT FOUND',
  'TARGET AMBIGUOUS',
  'ORIGIN FORBIDDEN',
  'TARGET DISCONNECTED',
  'EXECUTION CHANNEL FAILED',
  'CAPTURE CHANNEL FAILED',
] as const;
export type ProjectBrowserReadinessState =
  (typeof PROJECT_BROWSER_READINESS_STATES)[number];

export interface ProjectBrowserReadiness {
  readonly state: ProjectBrowserReadinessState;
  readonly code: string;
  readonly detail: string;
  readonly ready: boolean;
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly launchMode: 'CLUE_MANAGED' | 'ATTACH_TO_EXISTING';
  readonly executable: string | null;
  readonly dedicatedProfileDirectory: string;
  readonly debugEndpoint: string;
  readonly allowedOrigins: readonly string[];
  readonly configuredTargetUrl: string | null;
  readonly resolvedTarget: GovernedBrowserTargetIdentity | null;
  readonly sessionIdentity: BrowserSessionIdentity | null;
  readonly checkedAt: string;
}

export interface ProjectBrowserReadinessOptions {
  readonly globalChromeExecutable: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly previousTargetPageId?: string | null;
  readonly checkedAt?: string;
  readonly requestTimeoutMs?: number;
  readonly managedChrome?: ManagedProjectChrome;
  readonly attestManagedChrome?: () => Promise<ManagedProjectChrome>;
  /** Enabled only after the host has verified a newly opened dedicated test window. */
  readonly writeVisibleMarker?: boolean;
  readonly listTargets?: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<readonly TargetInfo[]>;
  /** Test seam; production attaches to the exact resolved target and probes execution/capture. */
  readonly probeSession?: (
    target: GovernedBrowserTargetIdentity,
    input: {
      readonly record: ProjectProfileRecord;
      readonly host: string;
      readonly requestTimeoutMs: number;
    },
  ) => Promise<BrowserSessionIdentity>;
}

export async function testProjectBrowserReadiness(
  recordInput: ProjectProfileRecord,
  options: ProjectBrowserReadinessOptions,
): Promise<ProjectBrowserReadiness> {
  const record = projectProfileRecordSchema.parse(recordInput);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  const projectIdentity = operationIdentityFromProfileRecord(record);
  const chrome = record.profile.integrations.chrome;
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const configuredExecutable =
    chrome.executable.source === 'global-default'
      ? options.globalChromeExecutable
      : chrome.executable.value;
  const executable = resolveExecutablePath(
    configuredExecutable,
    options.environment ?? process.env,
  );
  const debugEndpoint = `${host}:${String(chrome.remoteDebuggingPort)}`;
  const base = {
    projectIdentity,
    profileGeneration: record.generation,
    launchMode: chrome.launchMode,
    executable,
    dedicatedProfileDirectory: chrome.dedicatedProfileDirectory,
    debugEndpoint,
    allowedOrigins: Object.freeze([...chrome.allowedOrigins]),
    configuredTargetUrl: chrome.targetUrl,
    checkedAt,
  } as const;

  if (executable === null) {
    return result(
      'CHROME NOT FOUND',
      'CHROME_EXECUTABLE_UNAVAILABLE',
      `Configured Chrome executable is unavailable: ${configuredExecutable}`,
      base,
    );
  }
  if (
    chrome.launchMode === 'CLUE_MANAGED' &&
    (!existsSync(chrome.dedicatedProfileDirectory) ||
      !safeIsDirectory(chrome.dedicatedProfileDirectory))
  ) {
    return result(
      'CHROME NOT FOUND',
      'CHROME_PROFILE_DIRECTORY_UNAVAILABLE',
      `Managed Chrome profile directory is unavailable: ${chrome.dedicatedProfileDirectory}`,
      base,
    );
  }

  let targets: readonly TargetInfo[];
  let managed: ManagedProjectChrome | undefined;
  try {
    managed = options.managedChrome ?? await options.attestManagedChrome?.();
    targets = await (options.listTargets ?? BrowserAgent.listTargets)(
      host,
      chrome.remoteDebuggingPort,
      timeoutMs,
    );
  } catch (error) {
    return result(
      'DEBUG ENDPOINT UNAVAILABLE',
      'DEBUG_ENDPOINT_UNAVAILABLE',
      errorMessage(error),
      base,
    );
  }

  const resolution = resolveGovernedBrowserTarget({
    record,
    targets,
    host,
    selectedTargetPageId: options.previousTargetPageId ?? null,
  });
  if (resolution.target === null) {
    return result(
      resolution.state,
      resolution.code,
      resolution.detail,
      base,
    );
  }
  if (managed !== undefined && (resolution.selectedBy !== 'EXACT_TARGET_URL' ||
      managed.port !== chrome.remoteDebuggingPort || resolution.target.targetUrl !== managed.targetUrl)) {
    return result(
      'TARGET NOT FOUND',
      'BROWSER_MANAGED_TARGET_MISMATCH',
      'The exact configured page is unavailable in the verified dedicated Chrome instance.',
      base,
    );
  }
  const target = managed === undefined ? resolution.target : {
    ...resolution.target, chromeInstanceId: managed.chromeInstanceId,
  };

  let session: BrowserSessionIdentity;
  try {
    session = await (options.probeSession ?? defaultSessionProbe)(target, {
      record,
      host,
      requestTimeoutMs: timeoutMs,
      writeVisibleMarker: options.writeVisibleMarker ?? false,
    });
  } catch (error) {
    const mapped = browserFailure(error);
    return result(mapped.state, mapped.code, mapped.detail, base, target);
  }

  try {
    if (session.projectIdentity === null) {
      throw new Error('browser session omitted Project Profile identity');
    }
    assertProjectOperationIdentity(
      projectIdentity,
      session.projectIdentity,
      'browser readiness session',
    );
    if (session.profileGeneration !== record.generation) {
      throw new Error(
        `browser session profile generation ${String(session.profileGeneration)} does not match active generation ${String(record.generation)}`,
      );
    }
    if (session.targetId !== target.targetPageId) {
      throw new Error(
        `browser session attached to ${session.targetId}, expected ${target.targetPageId}`,
      );
    }
    if (session.chromeInstanceId !== target.chromeInstanceId) {
      throw new Error('browser session Chrome instance identity does not match target resolution');
    }
  } catch (error) {
    return result(
      'SESSION NOT ESTABLISHED',
      'BROWSER_SESSION_IDENTITY_MISMATCH',
      errorMessage(error),
      base,
      target,
      session,
    );
  }

  return result(
    'READY',
    'BROWSER_READY',
    'Chrome endpoint, exact permitted target, execution channel, capture channel and Project Profile identity are ready.',
    base,
    target,
    session,
  );
}

async function defaultSessionProbe(
  target: GovernedBrowserTargetIdentity,
  input: {
    readonly record: ProjectProfileRecord;
    readonly host: string;
    readonly requestTimeoutMs: number;
    readonly writeVisibleMarker: boolean;
  },
): Promise<BrowserSessionIdentity> {
  const chrome = input.record.profile.integrations.chrome;
  const agent = await BrowserAgent.attach({
    host: input.host,
    port: chrome.remoteDebuggingPort,
    allowedOrigins: chrome.allowedOrigins,
    expectedTargetId: target.targetPageId,
    projectIdentity: target.projectIdentity,
    profileGeneration: target.profileGeneration,
    chromeInstanceId: target.chromeInstanceId,
    requestTimeoutMs: input.requestTimeoutMs,
  });
  try {
    const expected = {
      projectIdentity: target.projectIdentity,
      profileGeneration: target.profileGeneration,
      browserSessionId: agent.identity().sessionId,
      targetPageId: target.targetPageId,
      targetUrl: target.targetUrl,
    };
    const roundTrip = await probeChromeConsole(agent, (source) => agent.evaluateGoverned(source, expected));
    if (!roundTrip.executed) {
      throw new BrowserReadinessProbeError(
        'EXECUTION CHANNEL FAILED',
        'EXECUTION_CHANNEL_FAILED',
        'The exact Chrome page did not return the verification value.',
      );
    }
    if (!roundTrip.captured) {
      throw new BrowserReadinessProbeError(
        'CAPTURE CHANNEL FAILED',
        'CAPTURE_CHANNEL_FAILED',
        'The matching Chrome console event did not reach CLU-E.',
      );
    }
    if (input.writeVisibleMarker) {
      await agent.evaluateGoverned("console.info('[CLU-E] Dedicated browser connection verified')", expected);
    }
    return agent.identity();
  } finally {
    agent.close();
  }
}

class BrowserReadinessProbeError extends Error {
  public constructor(
    public readonly state: ProjectBrowserReadinessState,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserReadinessProbeError';
  }
}

function browserFailure(error: unknown): {
  readonly state: ProjectBrowserReadinessState;
  readonly code: string;
  readonly detail: string;
} {
  if (error instanceof BrowserReadinessProbeError) {
    return { state: error.state, code: error.code, detail: error.message };
  }
  if (error instanceof BrowserAgentError) {
    const state: ProjectBrowserReadinessState =
      error.code === 'ENDPOINT_UNREACHABLE'
        ? 'DEBUG ENDPOINT UNAVAILABLE'
        : error.code === 'NO_TARGET'
          ? 'TARGET NOT FOUND'
          : error.code === 'TARGET_AMBIGUOUS'
            ? 'TARGET AMBIGUOUS'
            : error.code === 'TARGET_DISCONNECTED'
              ? 'TARGET DISCONNECTED'
              : error.code === 'ORIGIN_REFUSED'
                ? 'ORIGIN FORBIDDEN'
                : error.code === 'NOT_CONNECTED'
                  ? 'SESSION NOT ESTABLISHED'
                  : 'EXECUTION CHANNEL FAILED';
    return { state, code: error.code, detail: error.message };
  }
  return {
    state: 'EXECUTION CHANNEL FAILED',
    code: 'EXECUTION_CHANNEL_FAILED',
    detail: errorMessage(error),
  };
}

function result(
  state: ProjectBrowserReadinessState,
  code: string,
  detail: string,
  base: {
    readonly projectIdentity: ProjectOperationIdentity;
    readonly profileGeneration: number;
    readonly launchMode: 'CLUE_MANAGED' | 'ATTACH_TO_EXISTING';
    readonly executable: string | null;
    readonly dedicatedProfileDirectory: string;
    readonly debugEndpoint: string;
    readonly allowedOrigins: readonly string[];
    readonly configuredTargetUrl: string | null;
    readonly checkedAt: string;
  },
  resolvedTarget: GovernedBrowserTargetIdentity | null = null,
  sessionIdentity: BrowserSessionIdentity | null = null,
): ProjectBrowserReadiness {
  return Object.freeze({
    state,
    code,
    detail,
    ready: state === 'READY',
    ...base,
    resolvedTarget,
    sessionIdentity,
  });
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
