/**
 * Client-side draft problems for the Project Profile Configuration surface.
 *
 * The backend remains the only authority that accepts or refuses a profile. This module exists so
 * an operator learns about a refusal next to the field that causes it, before a round trip, instead
 * of from an error code after pressing SAVE.
 *
 * Two severities, deliberately different in consequence:
 *
 *   error    mirrors a rule the backend schema enforces unambiguously (a required value, an integer
 *            range, a publication-mode/remote contradiction). It blocks SAVE in the browser because
 *            the request would be refused anyway.
 *   warning  advice the browser cannot decide with certainty (URL syntax, a missing but optional
 *            binding). It never blocks SAVE; the backend decides.
 *
 * A rule is an `error` only when it is at least as permissive as `projectProfileSchema`. A stricter
 * browser check would strand an operator with a profile the backend would have accepted.
 */

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
export const TARGET_ROOT_IDENTITY_PATTERN = /^path:v1:[a-z0-9._-]+:[0-9a-f]{64}$/u;
export const PROJECT_PROFILE_HASH_PATTERN = /^profile:v1:[0-9a-f]{64}$/u;
export const CREDENTIAL_REFERENCE_PATTERN = /^(?:env:[A-Z][A-Z0-9_]{0,63}|credential-store:[A-Za-z0-9][A-Za-z0-9._:/-]{0,191})$/u;

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function blank(value) {
  return String(value ?? '').trim() === '';
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function looksLikeUrl(value) {
  try {
    return Boolean(new URL(String(value)));
  } catch {
    return false;
  }
}

/**
 * Returns every known problem of a draft, each bound to the section and field that owns it.
 *
 * @param {object|null|undefined} profile
 * @returns {{section:string, path:string, severity:'error'|'warning', message:string}[]}
 */
export function draftIssues(profile) {
  if (!profile || typeof profile !== 'object') {
    return [{ section: 'project', path: '', severity: 'error', message: 'No Project Profile draft is loaded.' }];
  }
  const issues = [];
  const error = (section, path, message) => issues.push({ section, path, severity: 'error', message });
  const warning = (section, path, message) => issues.push({ section, path, severity: 'warning', message });

  /* ---- the nine rules this surface has always enforced, in their original order and wording ---- */
  if (!PROJECT_ID_PATTERN.test(String(profile.projectId ?? ''))) error('project', 'projectId', 'Project ID is invalid.');
  if (blank(profile.targetRoot)) error('project', 'targetRoot', 'Target Root is required.');
  if (!TARGET_ROOT_IDENTITY_PATTERN.test(String(profile.targetRootIdentity ?? ''))) {
    error('project', 'targetRootIdentity', 'Target Root identity must be resolved by the backend.');
  }
  if (blank(profile.workspaceRoot)) error('project', 'workspaceRoot', 'Workspace Root is required.');
  if (blank(profile.shadowRoot)) error('project', 'shadowRoot', 'Shadow Root is required.');
  if (blank(profile.integrations?.powershell?.hostScript)) {
    error('powershell-host', 'integrations.powershell.hostScript', 'PowerShell Host Script is required.');
  }
  if (blank(profile.integrations?.chrome?.dedicatedProfileDirectory)) {
    error('browser', 'integrations.chrome.dedicatedProfileDirectory', 'Dedicated browser profile directory is required.');
  }
  const resolution = profile.benchmarkRuntime?.resolution;
  if (resolution !== null && resolution !== undefined) {
    if (!Number.isSafeInteger(resolution.width) || resolution.width < 1 || !Number.isSafeInteger(resolution.height) || resolution.height < 1) {
      error('benchmark-runtime', 'benchmarkRuntime.resolution', 'Benchmark resolution requires both a positive width and height, or neither.');
    }
  }
  const credential = profile.integrations?.gpt?.credential;
  if (credential?.source === 'project-override' && !CREDENTIAL_REFERENCE_PATTERN.test(String(credential.value ?? ''))) {
    error('gpt-gateway', 'integrations.gpt.credential', 'GPT override must be an env:/credential-store: reference, never secret bytes.');
  }

  /* ---- rules mirrored from projectProfileSchema so a refusal is explained before the request ---- */
  if (typeof profile.displayName === 'string' && profile.displayName.length > 256) {
    error('project', 'displayName', 'Display name can be at most 256 characters.');
  }

  const recognition = profile.recognition;
  if (recognition) {
    if (!Array.isArray(recognition.sourceRoots) || recognition.sourceRoots.length === 0) {
      error('recognition', 'recognition.sourceRoots', 'At least one source root is required.');
    }
    for (const [path, label] of [
      ['recognition.sourceRoots', 'source root'],
      ['recognition.excludedPaths', 'excluded path'],
      ['recognition.adapters', 'adapter'],
    ]) {
      const repeated = duplicates(recognition[path.split('.')[1]]);
      if (repeated.length) error('recognition', path, `Duplicate ${label}: ${repeated.join(', ')}.`);
    }
    const badAdapters = (Array.isArray(recognition.adapters) ? recognition.adapters : [])
      .filter((id) => typeof id !== 'string' || id.length > 64 || !ADAPTER_ID_PATTERN.test(id));
    if (badAdapters.length) {
      error('recognition', 'recognition.adapters', `Adapter IDs use lowercase letters, digits, dot, dash and underscore: ${badAdapters.join(', ')}.`);
    }
  }

  const runtime = profile.benchmarkRuntime;
  if (runtime) {
    if (!Number.isSafeInteger(runtime.warmupRuns) || runtime.warmupRuns < 0) {
      error('benchmark-runtime', 'benchmarkRuntime.warmupRuns', 'Warm-up runs must be 0 or more.');
    }
    if (!Number.isSafeInteger(runtime.repetitions) || runtime.repetitions < 1) {
      error('benchmark-runtime', 'benchmarkRuntime.repetitions', 'Repetitions must be at least 1.');
    }
    if (!Number.isSafeInteger(runtime.timeoutSeconds) || runtime.timeoutSeconds < 1) {
      error('benchmark-runtime', 'benchmarkRuntime.timeoutSeconds', 'Timeout must be at least 1 second.');
    }
    if (runtime.targetUrl !== null && runtime.targetUrl !== undefined && !looksLikeUrl(runtime.targetUrl)) {
      warning('benchmark-runtime', 'benchmarkRuntime.targetUrl', 'This does not look like a complete URL (for example http://127.0.0.1:8080).');
    }
  }

  const host = profile.integrations?.powershell;
  if (host?.executable?.source === 'project-override' && blank(host.executable.value)) {
    error('powershell-host', 'integrations.powershell.executable', 'Enter the full path of the PowerShell executable, or use the installation default.');
  }

  const git = profile.integrations?.git;
  if (git) {
    if (git.publicationMode === 'NO_REMOTE_YET' && git.remote !== null && git.remote !== undefined) {
      error('git', 'integrations.git.remote', 'Publication mode NO_REMOTE_YET requires the remote to be empty. Clear the remote or change the publication mode.');
    }
    if (git.publicationMode === 'REMOTE_REGISTERED' && (git.remote === null || git.remote === undefined)) {
      error('git', 'integrations.git.remote', 'Publication mode REMOTE_REGISTERED requires a remote.');
    }
    if (blank(git.defaultBranch)) error('git', 'integrations.git.defaultBranch', 'Default branch is required.');
    if (git.currentBasePin !== null && git.currentBasePin !== undefined && !GIT_OBJECT_ID_PATTERN.test(String(git.currentBasePin))) {
      error('git', 'integrations.git.currentBasePin', 'Base pin must be a 40- or 64-character lowercase Git object ID, or empty.');
    }
  }

  const chrome = profile.integrations?.chrome;
  if (chrome) {
    if (chrome.executable?.source === 'project-override' && blank(chrome.executable.value)) {
      error('browser', 'integrations.chrome.executable', 'Enter the full path of the Chrome executable, or use the installation default.');
    }
    if (!Number.isSafeInteger(chrome.remoteDebuggingPort) || chrome.remoteDebuggingPort < 1 || chrome.remoteDebuggingPort > 65535) {
      error('browser', 'integrations.chrome.remoteDebuggingPort', 'Port must be between 1 and 65535.');
    }
    if (!Array.isArray(chrome.allowedOrigins) || chrome.allowedOrigins.length === 0) {
      error('browser', 'integrations.chrome.allowedOrigins', 'At least one allowed origin is required.');
    } else {
      const repeated = duplicates(chrome.allowedOrigins);
      if (repeated.length) error('browser', 'integrations.chrome.allowedOrigins', `Duplicate allowed origin: ${repeated.join(', ')}.`);
    }
    if (chrome.targetUrl !== null && chrome.targetUrl !== undefined && !looksLikeUrl(chrome.targetUrl)) {
      warning('browser', 'integrations.chrome.targetUrl', 'This does not look like a complete URL (for example http://127.0.0.1:8080).');
    }
  }

  const gpt = profile.integrations?.gpt;
  if (gpt?.enabled === true && (gpt.modelId === null || gpt.modelId === undefined || blank(gpt.modelId))) {
    error('gpt-gateway', 'integrations.gpt.modelId', 'An enabled AI gateway needs an exact model. Choose a model or turn the gateway off.');
  }

  /* ---- advice only ---- */
  const authority = profile.authority;
  if (authority) {
    if (!authority.targetDescription) {
      warning('project-authority', 'authority.targetDescription', 'No Target Description is bound yet.');
    }
    if (!authority.masterBenchmark) {
      warning('project-authority', 'authority.masterBenchmark', 'No Master Benchmark is bound yet, so proof readiness stays incomplete.');
    }
  }

  return issues;
}

/** The messages that block SAVE, in a stable order. */
export function blockingProblems(profile) {
  return draftIssues(profile).filter((issue) => issue.severity === 'error').map((issue) => issue.message);
}

export function issuesForSection(issues, section) {
  return (Array.isArray(issues) ? issues : []).filter((issue) => issue.section === section);
}

export function countBySeverity(issues, severity) {
  return (Array.isArray(issues) ? issues : []).filter((issue) => issue.severity === severity).length;
}
