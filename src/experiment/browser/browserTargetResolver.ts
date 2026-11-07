/**
 * Deterministic governed browser-target resolution for one Project Profile generation.
 *
 * Resolution never guesses. A pinned page id is authoritative while it remains selected; if it
 * disappears the caller must explicitly re-resolve. Without a pin, an exact configured URL wins,
 * then one and only one page under the allowed-origin set. Multiple eligible pages are blocked.
 */

import { hashCanonicalJson } from '../../shared/ids.js';
import {
  canonicalProjectOperationIdentity,
  operationIdentityFromProfileRecord,
  type ProjectOperationIdentity,
} from '../../shared/projectOperationIdentity.js';
import { projectProfileRecordSchema, type ProjectProfileRecord } from '../../shared/schemas.js';
import { assertProjectProfileHash } from '../../control/projectProfiles/profileHash.js';
import { originAllowed, type TargetInfo } from './browserAgent.js';

export const BROWSER_TARGET_RESOLUTION_STATES = [
  'READY',
  'TARGET NOT FOUND',
  'TARGET AMBIGUOUS',
  'ORIGIN FORBIDDEN',
  'TARGET DISCONNECTED',
] as const;

export type BrowserTargetResolutionState = (typeof BROWSER_TARGET_RESOLUTION_STATES)[number];

export interface GovernedBrowserTargetIdentity {
  readonly projectIdentity: ProjectOperationIdentity;
  readonly profileGeneration: number;
  readonly chromeInstanceId: string;
  readonly debugEndpoint: string;
  readonly targetPageId: string;
  readonly targetUrl: string;
  readonly targetOrigin: string;
  readonly targetTitle: string;
  readonly targetType: string;
  readonly webSocketDebuggerUrl: string;
}

export interface BrowserTargetResolutionReady {
  readonly state: 'READY';
  readonly ready: true;
  readonly code: 'BROWSER_TARGET_READY';
  readonly detail: string;
  readonly selectedBy: 'PINNED_PAGE_ID' | 'EXACT_TARGET_URL' | 'UNIQUE_ALLOWED_ORIGIN';
  readonly target: GovernedBrowserTargetIdentity;
  readonly eligibleTargets: readonly BrowserTargetCandidate[];
}

export interface BrowserTargetResolutionBlocked {
  readonly state: Exclude<BrowserTargetResolutionState, 'READY'>;
  readonly ready: false;
  readonly code:
    | 'BROWSER_TARGET_NOT_FOUND'
    | 'BROWSER_TARGET_AMBIGUOUS'
    | 'BROWSER_ORIGIN_FORBIDDEN'
    | 'BROWSER_TARGET_DISCONNECTED';
  readonly detail: string;
  readonly selectedBy: null;
  readonly target: null;
  readonly eligibleTargets: readonly BrowserTargetCandidate[];
}

export type BrowserTargetResolution =
  | BrowserTargetResolutionReady
  | BrowserTargetResolutionBlocked;

export interface BrowserTargetCandidate {
  readonly targetPageId: string;
  readonly title: string;
  readonly url: string;
  readonly origin: string | null;
  readonly type: string;
  readonly allowed: boolean;
}

export interface ResolveBrowserTargetInput {
  readonly record: ProjectProfileRecord;
  readonly targets: readonly TargetInfo[];
  readonly host?: string;
  readonly selectedTargetPageId?: string | null;
}

/**
 * Resolves one exact page according to the Project Profile's declared target-selection rule.
 * The returned identity is complete enough to be passed to BrowserAgent.attachGoverned without
 * reinterpreting any profile field in the caller.
 */
export function resolveGovernedBrowserTarget(
  input: ResolveBrowserTargetInput,
): BrowserTargetResolution {
  const record = projectProfileRecordSchema.parse(input.record);
  assertProjectProfileHash(record, `Project Profile ${record.profile.projectId}`);
  const profile = record.profile;
  const chrome = profile.integrations.chrome;
  const projectIdentity = canonicalProjectOperationIdentity(
    operationIdentityFromProfileRecord(record),
  );
  const host = input.host ?? '127.0.0.1';
  const debugEndpoint = `${host}:${String(chrome.remoteDebuggingPort)}`;
  const chromeInstanceId = `chrome-instance:v1:${hashCanonicalJson({
    projectIdentity,
    profileGeneration: record.generation,
    launchMode: chrome.launchMode,
    dedicatedProfileDirectory: chrome.dedicatedProfileDirectory,
    debugEndpoint,
  })}`;

  const pages = input.targets.filter(
    (target) => target.type === 'page' && target.id.length > 0 && target.webSocketDebuggerUrl.length > 0,
  );
  const candidates = pages.map((target): BrowserTargetCandidate => ({
    targetPageId: target.id,
    title: target.title,
    url: target.url,
    origin: originOf(target.url),
    type: target.type,
    allowed: originAllowed(target.url, chrome.allowedOrigins),
  }));
  const allowed = pages.filter((target) => originAllowed(target.url, chrome.allowedOrigins));

  const pinned = input.selectedTargetPageId ?? null;
  if (pinned !== null) {
    const exactPinned = pages.find((target) => target.id === pinned) ?? null;
    if (exactPinned === null) {
      return blocked(
        'TARGET DISCONNECTED',
        'BROWSER_TARGET_DISCONNECTED',
        `Previously selected browser target ${pinned} is no longer available; explicit re-resolution is required.`,
        candidates,
      );
    }
    if (!originAllowed(exactPinned.url, chrome.allowedOrigins)) {
      return blocked(
        'ORIGIN FORBIDDEN',
        'BROWSER_ORIGIN_FORBIDDEN',
        `Previously selected browser target ${pinned} is outside the Project Profile allowed origins.`,
        candidates,
      );
    }
    return ready(
      exactPinned,
      'PINNED_PAGE_ID',
      projectIdentity,
      record.generation,
      chromeInstanceId,
      debugEndpoint,
      candidates,
    );
  }

  if (chrome.targetUrl !== null) {
    const exactUrl = pages.filter((target) => canonicalUrl(target.url) === canonicalUrl(chrome.targetUrl ?? ''));
    const exactAllowed = exactUrl.filter((target) => originAllowed(target.url, chrome.allowedOrigins));
    if (exactUrl.length > 0 && exactAllowed.length === 0) {
      return blocked(
        'ORIGIN FORBIDDEN',
        'BROWSER_ORIGIN_FORBIDDEN',
        `Configured target URL ${chrome.targetUrl} resolves only to pages outside the allowed origins.`,
        candidates,
      );
    }
    if (exactAllowed.length === 1) {
      const target = exactAllowed[0];
      if (target === undefined) throw new Error('browser target resolution invariant failed');
      return ready(
        target,
        'EXACT_TARGET_URL',
        projectIdentity,
        record.generation,
        chromeInstanceId,
        debugEndpoint,
        candidates,
      );
    }
    if (exactAllowed.length > 1) {
      return blocked(
        'TARGET AMBIGUOUS',
        'BROWSER_TARGET_AMBIGUOUS',
        `${exactAllowed.length} eligible pages match the configured target URL ${chrome.targetUrl}; select one exact Page ID.`,
        candidates,
      );
    }
  }

  if (allowed.length === 1) {
    const target = allowed[0];
    if (target === undefined) throw new Error('browser target resolution invariant failed');
    return ready(
      target,
      'UNIQUE_ALLOWED_ORIGIN',
      projectIdentity,
      record.generation,
      chromeInstanceId,
      debugEndpoint,
      candidates,
    );
  }
  if (allowed.length > 1) {
    return blocked(
      'TARGET AMBIGUOUS',
      'BROWSER_TARGET_AMBIGUOUS',
      `${allowed.length} eligible pages match the Project Profile allowed origins; select one exact Page ID.`,
      candidates,
    );
  }
  if (pages.length > 0) {
    return blocked(
      'ORIGIN FORBIDDEN',
      'BROWSER_ORIGIN_FORBIDDEN',
      `No debuggable page is inside the Project Profile allowed origins (${chrome.allowedOrigins.join(', ')}).`,
      candidates,
    );
  }
  return blocked(
    'TARGET NOT FOUND',
    'BROWSER_TARGET_NOT_FOUND',
    `No debuggable page exists on ${debugEndpoint}.`,
    candidates,
  );
}

function ready(
  target: TargetInfo,
  selectedBy: BrowserTargetResolutionReady['selectedBy'],
  projectIdentity: ProjectOperationIdentity,
  profileGeneration: number,
  chromeInstanceId: string,
  debugEndpoint: string,
  candidates: readonly BrowserTargetCandidate[],
): BrowserTargetResolution {
  const targetOrigin = originOf(target.url);
  if (targetOrigin === null) {
    return blocked(
      'ORIGIN FORBIDDEN',
      'BROWSER_ORIGIN_FORBIDDEN',
      `Target ${target.id} has no permitted HTTP(S) origin.`,
      candidates,
    );
  }
  return Object.freeze({
    state: 'READY',
    ready: true,
    code: 'BROWSER_TARGET_READY',
    detail: `Resolved target ${target.id} by ${selectedBy}.`,
    selectedBy,
    target: Object.freeze({
      projectIdentity,
      profileGeneration,
      chromeInstanceId,
      debugEndpoint,
      targetPageId: target.id,
      targetUrl: target.url,
      targetOrigin,
      targetTitle: target.title,
      targetType: target.type,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }),
    eligibleTargets: Object.freeze([...candidates]),
  });
}

function blocked(
  state: BrowserTargetResolutionBlocked['state'],
  code: BrowserTargetResolutionBlocked['code'],
  detail: string,
  candidates: readonly BrowserTargetCandidate[],
): BrowserTargetResolutionBlocked {
  return Object.freeze({
    state,
    ready: false,
    code,
    detail,
    selectedBy: null,
    target: null,
    eligibleTargets: Object.freeze([...candidates]),
  });
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username.length > 0 || url.password.length > 0) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
