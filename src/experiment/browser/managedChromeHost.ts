/** Windows ownership boundary for one dedicated, visible, project-bound Chrome. */

import { execFile, type ExecFileException } from 'node:child_process';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { resolveExecutablePath } from '../../control/projectProfiles/hostReadiness.js';
import { assertProjectProfileHash } from '../../control/projectProfiles/profileHash.js';
import { loadLegacyConfig, type Runtime } from '../../control/runtime.js';
import { hashCanonicalJson } from '../../shared/ids.js';
import { assertPathIdentity, containsPath, resolvePathIdentity, resolveTargetRootIdentity } from '../../shared/pathIdentity.js';
import type { ProjectProfileRecord } from '../../shared/schemas.js';
import { redactSecretText } from '../../shared/secretSafety.js';
import { originAllowed } from './browserAgent.js';

const launcherStatus = z.object({ status: z.string(), message: z.string() });
const verifiedLauncherStatus = z.object({
  status: z.literal('ok'),
  listenerVerified: z.literal(true),
  headless: z.literal(false),
  statePid: z.number().int().positive().max(2 ** 31 - 1),
  port: z.number().int().min(1024).max(65535),
  projectId: z.string(),
  targetRootIdentity: z.string(),
  profileHash: z.string(),
  generation: z.number().int().positive(),
  profile: z.string(),
  targetUrl: z.string(),
  webSocketUrl: z.string(),
});

export class ManagedChromeHostError extends Error {
  public constructor(
    public readonly state: 'UNAVAILABLE' | 'BLOCKED',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedChromeHostError';
  }
}

export interface ManagedProjectChrome {
  readonly pid: number;
  readonly targetUrl: string;
  readonly port: number;
  readonly chromeInstanceId: string;
}

/** Use the same process-scoped policy as the bundled CLU-E PowerShell host. */
export function chromeLauncherPowerShellArgs(repoRoot: string): string[] {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text',
    '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'launch-test-browser.ps1'),
  ];
}

export function readManagedChromeLauncherOutput(
  execution: {
    readonly error: Pick<ExecFileException, 'code' | 'signal' | 'killed'> | null;
    readonly stdout: string;
    readonly stderr: string;
  },
  redact: (text: string) => string,
): unknown {
  let output: unknown;
  try {
    output = JSON.parse(execution.stdout.replace(/^\uFEFF/u, '')) as unknown;
  } catch {
    output = null;
  }
  const status = launcherStatus.safeParse(output);
  if (execution.error === null && status.success && status.data.status === 'ok') return output;

  const safeDetail = (text: string): string => redactSecretText(redact(text)).text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, '')
    .trim()
    .slice(0, 1_000);
  const statusDetail = status.success && status.data.status !== 'ok' ? safeDetail(status.data.message) : '';
  const detail = statusDetail || safeDetail(execution.stderr) || (status.success ? '' : safeDetail(execution.stdout));
  const { error } = execution;
  const outcome = error?.killed === true
    ? 'timed out or was terminated'
    : error?.signal
      ? `was stopped by ${error.signal}`
      : typeof error?.code === 'number'
        ? `exited with code ${error.code}`
        : typeof error?.code === 'string'
          ? `could not run (${safeDetail(error.code)})`
          : status.success ? 'reported a failure' : 'returned no valid status';
  throw new ManagedChromeHostError('BLOCKED', `Chrome PowerShell launcher ${outcome}. ${detail || 'No PowerShell error text was returned.'}`);
}

export function openManagedProjectChrome(runtime: Runtime, record: ProjectProfileRecord): Promise<ManagedProjectChrome> {
  return verifyManagedProjectChrome(runtime, record, true);
}

export function attestManagedProjectChrome(runtime: Runtime, record: ProjectProfileRecord): Promise<ManagedProjectChrome> {
  return verifyManagedProjectChrome(runtime, record, false);
}

async function verifyManagedProjectChrome(
  runtime: Runtime,
  record: ProjectProfileRecord,
  launch: boolean,
): Promise<ManagedProjectChrome> {
  if (process.platform !== 'win32') {
    throw new ManagedChromeHostError('UNAVAILABLE', 'The visible Chrome launcher requires an interactive Windows session.');
  }
  const profile = record.profile;
  const chrome = profile.integrations.chrome;
  const powershell = profile.integrations.powershell;
  const url = chrome.targetUrl === null ? null : new URL(chrome.targetUrl);
  if (chrome.launchMode !== 'CLUE_MANAGED' || url === null || url.username || url.password ||
      !originAllowed(url.href, chrome.allowedOrigins) || chrome.remoteDebuggingPort < 1024) {
    throw new ManagedChromeHostError('BLOCKED', 'Save CLU-E Managed mode, a permitted HTTP(S) Target URL and a debugging port from 1024 to 65535.');
  }
  if (powershell.autonomousProfile === 'disabled') {
    throw new ManagedChromeHostError('BLOCKED', 'The selected Project Profile disables PowerShell host operations.');
  }
  assertProjectProfileHash(record, `Project Profile ${profile.projectId}`);
  assertPathIdentity(profile.targetRootIdentity, resolveTargetRootIdentity(profile.targetRoot), 'Managed Chrome target root');

  const config = runtime.config;
  const installation = loadLegacyConfig(runtime.repoRoot);
  const forbidden = [...new Set([
    runtime.repoRoot, config.project.root, runtime.workspaceRoot, config.shadow.root,
    profile.targetRoot, profile.workspaceRoot, profile.shadowRoot,
  ])].map((root) => resolvePathIdentity(root, { zone: 'clue-state', expectedKind: 'directory', mustExist: false }).canonicalPath);
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => /^(?:path|systemroot|systemdrive|windir|comspec|userprofile|home|homedrive|homepath|appdata|localappdata|programdata|programfiles(?:\(x86\))?|temp|tmp)$/iu.test(name))
    .map(([name, value]) => [name.toUpperCase(), value]));
  environment['PATH'] = (environment['PATH'] ?? '').split(delimiter).flatMap((entry) =>
    externalPath(entry.trim().replace(/^"(.*)"$/u, '$1'), forbidden, 'directory') ?? [],
  ).join(delimiter);
  environment['PATHEXT'] = '.EXE';
  const systemRoot = externalPath(environment['SYSTEMROOT'] ?? '', forbidden, 'directory');
  const pwsh = executablePath(
    powershell.executable.source === 'project-override' ? powershell.executable.value : installation.powershell.executable,
    'pwsh.exe', environment, forbidden,
  );
  const executable = executablePath(
    chrome.executable.source === 'project-override' ? chrome.executable.value : installation.browser.executable,
    'chrome.exe', environment, forbidden,
  );
  if (pwsh === null || executable === null || systemRoot === null) {
    throw new ManagedChromeHostError('UNAVAILABLE', 'Configure Chrome and PowerShell 7 executables outside the project, workspace and shadow directories.');
  }
  const directory = resolvePathIdentity(chrome.dedicatedProfileDirectory, {
    zone: 'browser-profile', expectedKind: 'directory', mustExist: false,
  }).canonicalPath;
  if (isNetworkPath(directory) || forbidden.some((root) => containsPath(root, directory) || containsPath(directory, root))) {
    throw new ManagedChromeHostError('BLOCKED', 'Choose a dedicated local Chrome profile outside the project, workspace and shadow directories.');
  }
  const personalProfiles = [
    ['LOCALAPPDATA', 'Google', 'Chrome', 'User Data'],
    ['LOCALAPPDATA', 'Microsoft', 'Edge', 'User Data'],
    ['LOCALAPPDATA', 'BraveSoftware'],
    ['APPDATA', 'Google', 'Chrome'],
  ] as const;
  for (const [variable, ...suffix] of personalProfiles) {
    const home = environment[variable];
    if (home === undefined || !isAbsolute(home)) continue;
    const personal = resolvePathIdentity(join(home, ...suffix), {
      zone: 'browser-profile', expectedKind: 'directory', mustExist: false,
    }).canonicalPath;
    if (containsPath(personal, directory) || containsPath(directory, personal)) {
      throw new ManagedChromeHostError('BLOCKED', 'Choose a dedicated profile that is separate from personal browser data.');
    }
  }
  const port = chrome.remoteDebuggingPort;
  const args = [
    ...chromeLauncherPowerShellArgs(runtime.repoRoot),
    ...(launch ? ['-Executable', executable, '-Url', url.href, '-AllowedOrigin', url.origin] : ['-Status']),
    '-ProfileDir', directory, '-Port', String(port), '-ForbiddenRoots', profile.targetRoot,
    '-ProjectId', profile.projectId, '-TargetRootIdentity', profile.targetRootIdentity,
    '-ProjectProfileHash', record.projectProfileHash, '-ProfileGeneration', String(record.generation), '-Json',
  ];
  const launched = await new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>((done) => {
    execFile(pwsh, args, {
      cwd: systemRoot, env: environment, windowsHide: true, timeout: launch ? 50_000 : 15_000, maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      done({ error, stdout, stderr });
    });
  });
  const output = readManagedChromeLauncherOutput(launched, (text) => runtime.secrets.redact(text));
  const status = verifiedLauncherStatus.safeParse(output);
  if (!status.success || status.data.projectId !== profile.projectId ||
      status.data.targetRootIdentity !== profile.targetRootIdentity || status.data.profileHash !== record.projectProfileHash ||
      status.data.generation !== record.generation || status.data.port !== port || status.data.targetUrl !== url.href ||
      status.data.profile.toLowerCase() !== directory.toLowerCase() ||
      !new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/browser/[a-f0-9-]+$`, 'iu').test(status.data.webSocketUrl)) {
    throw new ManagedChromeHostError('BLOCKED', 'The launcher could not verify the exact visible Chrome and its loopback debugger. Close the dedicated test window and reopen it from Configuration.');
  }
  return {
    pid: status.data.statePid,
    port,
    targetUrl: status.data.targetUrl,
    chromeInstanceId: `chrome-instance:v1:${hashCanonicalJson([status.data.statePid, status.data.webSocketUrl])}`,
  };
}

function isNetworkPath(path: string): boolean {
  return /^(?:\\\\|\/\/)/u.test(path);
}

function externalPath(path: string, roots: readonly string[], kind: 'directory' | 'file'): string | null {
  if (!isAbsolute(path) || isNetworkPath(path)) return null;
  try {
    const { canonicalPath } = resolvePathIdentity(path, { zone: 'clue-state', expectedKind: kind });
    return !isNetworkPath(canonicalPath) && roots.every((root) => !containsPath(root, canonicalPath)) ? canonicalPath : null;
  } catch {
    return null;
  }
}

function executablePath(
  configured: string,
  name: string,
  environment: NodeJS.ProcessEnv,
  forbidden: readonly string[],
): string | null {
  if (/[\\/]/u.test(configured) && !isAbsolute(configured)) return null;
  const found = resolveExecutablePath(configured, environment);
  const path = found === null ? null : externalPath(found, forbidden, 'file');
  return path !== null && basename(path).toLowerCase() === name ? path : null;
}
