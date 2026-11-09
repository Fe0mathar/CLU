/** Explicit operator diagnostics. Only fixed canaries and registered project settings reach hosts. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';

import { gatewayRequestSchema, invokeGateway, readGatewayStatus } from '../ai/gateway/modelGateway.js';
import type { Runtime } from '../control/runtime.js';
import { resolveExecutablePath } from '../control/projectProfiles/hostReadiness.js';
import { BrowserAgent, BrowserAgentError, originAllowed, type TargetInfo } from '../experiment/browser/browserAgent.js';
import { probeChromeConsole } from '../experiment/browser/browserConsoleProbe.js';
import { attestManagedProjectChrome, chromeLauncherPowerShellArgs } from '../experiment/browser/managedChromeHost.js';
import { verifyGitHubProfileRepository } from '../integration/git/githubProfileConnection.js';
import { operationIdentityFromProfileRecord } from '../shared/projectOperationIdentity.js';
import { assertSamePathIdentity, resolveTargetRootIdentity } from '../shared/pathIdentity.js';
import { hashCanonicalJson } from '../shared/ids.js';
import { describeTargetPublication } from '../shared/targetPublication.js';
import { gitRemoteSchema } from '../shared/schemas.js';

export const readinessRequestSchema = z.object({ capability: z.enum(['git', 'ai', 'chrome', 'console']) }).strict();
export type ReadinessCapability = z.infer<typeof readinessRequestSchema>['capability'];
export type ReadinessState = 'ready' | 'pending' | 'failed' | 'unknown';
export interface ReadinessCheck {
  readonly label: string;
  readonly state: ReadinessState;
  readonly detail: string;
}
export interface DashboardReadiness {
  readonly state: ReadinessState;
  readonly summary: string;
  readonly checks: readonly ReadinessCheck[];
}

function single(label: string, state: ReadinessState, detail: string): DashboardReadiness {
  return { state, summary: detail, checks: [{ label, state, detail }] };
}

export async function checkDashboardReadiness(runtime: Runtime, capability: Exclude<ReadinessCapability, 'console'>): Promise<DashboardReadiness> {
  switch (capability) {
    case 'git': return checkGit(runtime);
    case 'ai': return checkAi(runtime);
    case 'chrome': return checkChrome(runtime);
  }
}

export function registeredGitHubRepository(remote: string): string | null {
  if (!gitRemoteSchema.safeParse(remote).success) return null;
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}?)(?:\.git)?$/iu.exec(remote);
  return match?.[1] ?? null;
}

async function checkGit(runtime: Runtime): Promise<DashboardReadiness> {
  const profile = runtime.projectProfile?.profile.integrations.git;
  const legacy = runtime.config.project;
  const remote = profile === undefined
    ? describeTargetPublication(legacy.remote, legacy.credential_env, legacy.remote_decision).remote
    : profile.publicationMode === 'REMOTE_REGISTERED' ? profile.remote : null;
  if (remote === null) return single('Registered remote', 'pending', 'The active project is local-only. Register a remote in Configuration.');
  const repository = registeredGitHubRepository(remote);
  if (repository === null) {
    return single('Remote authentication', 'pending', 'This readiness check can verify GitHub.com accounts and transports. The configured remote has no supported authentication probe.');
  }
  const checkout = profile?.repositoryRoot ?? legacy.root;
  try {
    assertSamePathIdentity(resolveTargetRootIdentity(checkout), resolveTargetRootIdentity(legacy.root), 'Readiness checkout');
  } catch {
    return single('Local checkout', 'failed', 'The configured Git checkout is unavailable or differs from the active target.');
  }
  const result = await verifyGitHubProfileRepository(checkout, {
    nameWithOwner: repository, branch: profile?.defaultBranch ?? legacy.main_branch,
  });
  if (result.state === 'AUTH_REQUIRED') return single('GitHub authentication', 'pending', 'Sign in to GitHub in Configuration, then test again.');
  if (result.state === 'UNAVAILABLE') return single('Git host', 'pending', 'The Windows Git and GitHub CLI prerequisites are unavailable.');
  if (result.state !== 'CONNECTED') {
    return single('Repository transport', 'failed', result.state === 'CHECKOUT_MISMATCH'
      ? 'The active checkout, configured branch or remote did not match the repository.'
      : 'The GitHub account or Git transport could not verify the registered repository.');
  }
  if (result.repository?.remoteUrl !== remote) {
    return single('Repository transport', 'failed', 'The checkout transport verified by Git does not exactly match the registered remote.');
  }
  return {
    state: 'ready', summary: 'GitHub authentication and read access verified.', checks: [
      { label: 'GitHub authentication', state: 'ready', detail: 'The GitHub API verified a signed-in account.' },
      { label: 'Repository transport', state: 'ready', detail: 'Git read access to the registered repository was verified.' },
      { label: 'Publication', state: 'unknown', detail: 'Publication is verified by a separately requested Git Sync receipt.' },
    ],
  };
}

async function checkAi(runtime: Runtime): Promise<DashboardReadiness> {
  const profile = runtime.projectProfile;
  if (!runtime.config.gateway.enabled || profile?.profile.integrations.gpt.enabled === false) {
    return single('OpenAI', 'pending', 'The Model Gateway is disabled for this project.');
  }
  const status = readGatewayStatus(runtime);
  if (status.providerPaused) return single('OpenAI', 'pending', 'The provider budget is paused. Resolve the provider billing state before testing.');
  if (!status.apiKeyPresent) return single('OpenAI credential', 'pending', 'The configured credential is unavailable. Set it in Configuration.');
  if (!status.operationallyReady || status.requestedModel === null) {
    return single('OpenAI model policy', 'failed', 'The gateway does not have a valid exact-model route. Review Configuration.');
  }
  const result = await invokeGateway(gatewayRequestSchema.parse({
    version: 1, task_type: 'UNIT_SUMMARIZE',
    input: 'Return the single word READY.',
    instructions: 'This is a brief connection check. Return one word.',
    max_output_tokens: 256, metadata: { source: 'dashboard-readiness' },
  }), {
    repoRoot: runtime.repoRoot,
    ...(profile === null ? {} : { projectProfile: profile }),
    requireInteractive: true,
    expectedRuntimeDigest: hashCanonicalJson([
      runtime.config.project.root,
      runtime.workspaceRoot,
      runtime.projectBinding?.recognition.identity ?? null,
    ]),
  });
  if (result.state === 'completed' && result.record.model === status.requestedModel && result.outputText.trim() !== '') {
    return single('OpenAI model', 'ready', 'A live request completed on the configured exact model.');
  }
  if (result.state === 'refused' || result.state === 'batch_pending') {
    return single('OpenAI model', 'pending', 'The live interactive check is currently unavailable under the gateway policy.');
  }
  return single('OpenAI model', 'failed', 'The provider did not complete the live check on the configured exact model.');
}

function hostEnvironment(runtime: Runtime): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:path|pathext|systemroot|systemdrive|windir|userprofile|home|homedrive|homepath|appdata|localappdata|programdata|programfiles(?:\(x86\))?|temp|tmp)$/iu.test(name),
  ).map(([name, value]) => [name.toUpperCase(), value]));
  env['PATH'] = (env['PATH'] ?? '').split(delimiter).flatMap((value) => {
    const directory = hostPath(runtime, value.trim().replace(/^"(.*)"$/u, '$1'));
    return directory === null ? [] : [directory];
  }).join(delimiter);
  env['PATHEXT'] = '.EXE';
  return env;
}

function hostPath(runtime: Runtime, path: string): string | null {
  if (!isAbsolute(path) || path.startsWith('\\\\')) return null;
  try {
    const canonical = realpathSync.native(path);
    if (canonical.startsWith('\\\\')) return null;
    for (const root of [runtime.repoRoot, runtime.config.project.root, runtime.workspaceRoot, runtime.config.shadow.root]) {
      let realRoot = root;
      try { realRoot = realpathSync.native(root); } catch { /* A configured but absent root can still be compared. */ }
      const subpath = relative(realRoot.toLowerCase(), canonical.toLowerCase());
      if (subpath === '' || (!isAbsolute(subpath) && subpath !== '..' && !subpath.startsWith(`..${sep}`))) return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

function powerShell(runtime: Runtime, env: NodeJS.ProcessEnv): string | null {
  const configured = runtime.projectProfile?.profile.integrations.powershell.executable;
  const value = configured?.source === 'project-override' ? configured.value : runtime.config.powershell.executable;
  if (/[\\/]/u.test(value) && !isAbsolute(value)) return null;
  const located = resolveExecutablePath(value, env);
  if (located === null || !/^(?:pwsh|powershell)\.exe$/iu.test(basename(located))) return null;
  return hostPath(runtime, located);
}

function windowsDirectory(runtime: Runtime, env: NodeJS.ProcessEnv): string | null {
  return hostPath(runtime, env['SYSTEMROOT'] ?? '');
}

function runProbe(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((done) => {
    execFile(executable, args, { cwd, env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      done(error === null ? stdout.replace(/^\uFEFF/u, '').trim() : null);
    });
  });
}

/** Optional compatibility check for Windows batch launchers. */
export async function checkDashboardCmd(runtime: Runtime): Promise<ReadinessCheck> {
  if (process.platform !== 'win32') {
    return { label: 'CMD compatibility', state: 'unknown', detail: 'The Windows CMD check is only available on Windows.' };
  }
  const env = hostEnvironment(runtime);
  const cwd = windowsDirectory(runtime, env);
  const cmd = cwd === null ? null : hostPath(runtime, join(cwd, 'System32', 'cmd.exe'));
  const token = `CLUE_SHELL_${randomUUID().replaceAll('-', '')}`;
  const output = cmd === null || cwd === null ? null : await runProbe(cmd, ['/d', '/q', '/c', `echo ${token}`], cwd, env);
  return {
    label: 'CMD compatibility', state: output === token ? 'ready' : 'failed',
    detail: output === token ? 'The Windows CMD executable returned the expected output.' : 'The fixed CMD command failed or the system executable is unavailable.',
  };
}

export function matchesChromeTarget(candidate: TargetInfo, expectedUrl: string, port: number): boolean {
  if (candidate.type !== 'page' || !/^[a-z0-9_-]{1,128}$/iu.test(candidate.id)) return false;
  try {
    const target = new URL(candidate.url);
    const socket = new URL(candidate.webSocketDebuggerUrl);
    return target.href === expectedUrl && target.username === '' && target.password === '' &&
      socket.href === `ws://127.0.0.1:${String(port)}/devtools/page/${candidate.id}`;
  } catch {
    return false;
  }
}

export { probeChromeConsole };

async function checkChrome(runtime: Runtime): Promise<DashboardReadiness> {
  if (process.platform !== 'win32') return single('Dedicated test window', 'pending', 'The dedicated Chrome window must be checked on the Windows CLU-E host.');
  const record = runtime.projectProfile;
  const chrome = record?.profile.integrations.chrome;
  const port = chrome?.remoteDebuggingPort ?? runtime.config.browser.remote_debugging_port;
  const allowed = chrome?.allowedOrigins ?? runtime.config.browser.allowed_origins;
  const identity = record === null ? null : operationIdentityFromProfileRecord(record);
  let targetUrl: string;
  let chromeInstanceId: string | undefined;
  if (record !== null) {
    try {
      ({ targetUrl, chromeInstanceId } = await attestManagedProjectChrome(runtime, record));
    } catch (error) {
      const detail = error instanceof Error ? runtime.secrets.redact(error.message) : 'Open the dedicated Chrome window in Configuration.';
      return single('Dedicated test window', 'pending', detail);
    }
  } else {
    const env = hostEnvironment(runtime);
    const pwsh = powerShell(runtime, env);
    const cwd = windowsDirectory(runtime, env);
    if (pwsh === null || cwd === null) return single('Dedicated test window', 'pending', 'PowerShell is unavailable for the dedicated-window check.');
    const directory = hostPath(runtime, runtime.config.browser.profile_dir);
    if (directory === null) return single('Dedicated test window', 'pending', 'The dedicated browser profile is unavailable outside the project and workspace roots.');
    const report = await runProbe(pwsh, [...chromeLauncherPowerShellArgs(runtime.repoRoot),
      '-Status', '-Json', '-ProfileDir', directory, '-Port', String(port), '-ForbiddenRoots', runtime.config.project.root,
    ], cwd, env);
    if (report === null) return single('Dedicated test window', 'pending', 'Open the dedicated Chrome test window before testing.');
    try {
      const result = z.object({
        status: z.literal('ok'), headless: z.literal(false), listenerVerified: z.literal(true), targetUrl: z.string().max(8192),
      }).parse(JSON.parse(report) as unknown);
      const url = new URL(result.targetUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !originAllowed(url.href, allowed)) {
        return single('Dedicated test window', 'failed', 'The managed target does not match the configured permitted page.');
      }
      targetUrl = url.href;
    } catch {
      return single('Dedicated test window', 'failed', 'The launcher did not verify a visible Chrome window and its loopback debugger.');
    }
  }
  let agent: BrowserAgent | null = null;
  try {
    agent = await BrowserAgent.attach({
      host: '127.0.0.1', port, allowedOrigins: allowed, requestTimeoutMs: 3_000,
      selectTarget: (targets) => {
        const matches = targets.filter((target) => matchesChromeTarget(target, targetUrl, port));
        return matches.length === 1 ? matches[0] ?? null : null;
      },
      ...(record === null || identity === null || chromeInstanceId === undefined ? {} : {
        projectIdentity: identity, profileGeneration: record.generation, chromeInstanceId,
      }),
    });
    const browser = agent;
    const observed = await probeChromeConsole(browser, (source) => {
      const bound = `globalThis.location.href === ${JSON.stringify(targetUrl)} ? (${source}) : null`;
      return record === null || identity === null ? browser.evaluate(bound) : browser.evaluateGoverned(bound, {
          projectIdentity: identity, profileGeneration: record.generation,
          browserSessionId: browser.identity().sessionId, targetPageId: browser.target.id, targetUrl,
      });
    });
    const ready = observed.executed && observed.captured;
    return {
      state: ready ? 'ready' : 'failed', summary: ready ? 'Dedicated Chrome verified in both directions.' : 'The managed Chrome console did not complete both directions.',
      checks: [
        { label: 'Dedicated test window', state: 'ready', detail: 'Visible Chrome and its loopback debugger share the verified process.' },
        { label: 'Command execution', state: observed.executed ? 'ready' : 'failed', detail: observed.executed ? 'Chrome returned the fixed probe result.' : 'Chrome did not return the fixed probe result.' },
        { label: 'Console capture', state: observed.captured ? 'ready' : 'failed', detail: observed.captured ? 'The matching console event reached CLU-E.' : 'The matching console event did not reach CLU-E.' },
      ],
    };
  } catch (error) {
    if (error instanceof BrowserAgentError && error.code === 'ENDPOINT_UNREACHABLE') {
      return single('DevTools target discovery', 'pending', error.message);
    }
    return single('Chrome console', 'failed', 'The debugger could not attach to the exact dedicated page or complete the console exchange.');
  } finally {
    agent?.close();
  }
}
