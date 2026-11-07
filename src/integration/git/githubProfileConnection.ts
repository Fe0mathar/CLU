/** Operator-initiated GitHub.com sign-in and read-only repository connection. */

import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';

const HOST = 'github.com';
const OWNER = '[A-Za-z0-9][A-Za-z0-9-]{0,38}';
const REPOSITORY_NAME = new RegExp(`^${OWNER}/(?!\\.{1,2}$)[A-Za-z0-9_.-]{1,100}$`, 'u');
const ACCOUNT_NAME = new RegExp(`^${OWNER}$`, 'u');
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_REPOSITORIES = 500;
const HOST_ENVIRONMENT = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSH_AUTH_SOCK',
]);

export interface GitHubProfileRepository {
  readonly nameWithOwner: string;
  readonly remoteUrl: string;
  readonly defaultBranch: string | null;
  readonly private: boolean;
}

type FailureState = 'AUTH_REQUIRED' | 'UNAVAILABLE' | 'FAILED';
type GitHubAuthResult =
  | { readonly state: 'CONNECTED'; readonly detail: string; readonly account: string }
  | { readonly state: FailureState; readonly detail: string; readonly account: null };

export interface GitHubProfileRepositoryList {
  readonly state: 'CONNECTED' | FailureState;
  readonly detail: string;
  readonly account: string | null;
  readonly repositories: readonly GitHubProfileRepository[];
}

export interface GitHubProfileRepositorySelection {
  readonly nameWithOwner: string;
  readonly branch: string;
}

export interface GitHubProfileRepositoryVerification {
  readonly state: 'CONNECTED' | FailureState | 'CHECKOUT_MISMATCH' | 'GIT_ACCESS_BLOCKED';
  readonly detail: string;
  readonly account: string | null;
  readonly repository: GitHubProfileRepository | null;
  readonly checkoutPath: string | null;
  readonly branch: string | null;
  readonly baseCommit: string | null;
}

interface HostCommand {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
}

function hostEnv(): NodeJS.ProcessEnv {
  // Do not pass through OpenAI keys, token overrides, Git config injection, or gh debug settings.
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const key = name.toUpperCase();
    if (HOST_ENVIRONMENT.has(key)) env[key] = value;
  }
  return env;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'));
}

function resolveHostCommand(name: 'gh.exe' | 'git.exe', checkout: string): HostCommand | null {
  if (process.platform !== 'win32') return null;
  const env = hostEnv();
  const entries = (env['PATH'] ?? '').split(delimiter);
  const trustedEntries: string[] = [];
  let executable: string | null = null;
  for (const raw of entries) {
    const entry = raw.trim().replace(/^"(.*)"$/u, '$1');
    if (!isAbsolute(entry) || entry.startsWith('\\\\')) continue;
    try {
      const physical = realpathSync.native(entry);
      if (isWithin(checkout, physical) || !statSync(physical).isDirectory()) continue;
      trustedEntries.push(physical);
      if (executable !== null) continue;
      const candidate = realpathSync.native(join(physical, name));
      if (!candidate.startsWith('\\\\') && !isWithin(checkout, candidate) && statSync(candidate).isFile()) {
        executable = candidate;
      }
    } catch {
      // A stale PATH entry or absent executable is not a usable tool.
    }
  }
  env['PATH'] = trustedEntries.join(delimiter);
  return executable === null ? null : { executable, env };
}

function runHost(
  command: HostCommand, args: readonly string[], cwd = dirname(command.executable),
  maxBuffer = 256 * 1024, timeout = 20_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command.executable, [...args], {
      cwd, env: command.env, encoding: 'utf8', timeout, maxBuffer, windowsHide: true,
    }, (error, stdout) => resolve(error === null ? stdout.trim() : null));
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function parseRepository(value: unknown): GitHubProfileRepository | null {
  const record = object(value);
  const name = record?.['full_name'];
  const privateRepository = record?.['private'];
  const defaultBranch = record?.['default_branch'];
  if (typeof name !== 'string' || !REPOSITORY_NAME.test(name) ||
    typeof privateRepository !== 'boolean') return null;
  return {
    nameWithOwner: name,
    remoteUrl: `https://${HOST}/${name}.git`,
    defaultBranch: typeof defaultBranch === 'string' && validBranch(defaultBranch) ? defaultBranch : null,
    private: privateRepository,
  };
}

function validBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= 255 && !branch.startsWith('-') && !/[\s\x00-\x1f\x7f]/u.test(branch);
}

function parseCheckoutRemote(value: string): { readonly name: string; readonly url: string } | null {
  const match = /^(https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^\s?#\\]+)$/iu.exec(value);
  if (match === null) return null;
  const prefix = match[1] ?? '';
  const path = match[2] ?? '';
  const name = path.replace(/\.git$/iu, '');
  return REPOSITORY_NAME.test(name) ? { name, url: `${prefix.toLowerCase()}${path}` } : null;
}

async function secureAuthentication(gh: HostCommand): Promise<GitHubAuthResult> {
  const raw = await runHost(gh, ['auth', 'status', '--hostname', HOST, '--active', '--json', 'hosts']);
  const accounts = object(object(parseJson(raw))?.['hosts'])?.[HOST];
  const active = Array.isArray(accounts)
    ? accounts.map(object).find((entry) => entry?.['active'] === true)
    : null;
  if (active?.['state'] !== 'success') {
    return { state: 'AUTH_REQUIRED', account: null, detail: 'Sign in with current GitHub CLI and confirm access to GitHub.com.' };
  }
  const login = active['login'];
  if (active['tokenSource'] !== 'keyring' || typeof login !== 'string' || !ACCOUNT_NAME.test(login)) {
    return { state: 'AUTH_REQUIRED', account: null, detail: 'CLU-E requires the active GitHub sign-in to use the Windows credential store. Fix the GitHub CLI credential store and sign in again.' };
  }
  return { state: 'CONNECTED', account: login, detail: 'GitHub account verified.' };
}

function canonicalCheckout(checkout: string): string | null {
  try {
    if (!isAbsolute(checkout)) return null;
    const root = realpathSync.native(checkout);
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

function githubTool(checkout: string): HostCommand | null {
  const gh = resolveHostCommand('gh.exe', checkout);
  return gh === null ? null : {
    ...gh, env: { ...gh.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  };
}

const SIGN_IN_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$host.UI.RawUI.WindowTitle = "CLU-E GitHub sign-in"',
  '$gh = $env:CLU_PROFILE_GH_EXECUTABLE',
  '& $gh auth login --hostname github.com --git-protocol https --web --clipboard',
  'if ($LASTEXITCODE -eq 0) {',
  '  $status = & $gh auth status --hostname github.com --active --json hosts | ConvertFrom-Json',
  '  $active = $status.hosts."github.com" | Where-Object { $_.active } | Select-Object -First 1',
  '  if ($active.state -eq "success" -and $active.tokenSource -eq "keyring") {',
  '    & $gh auth setup-git --hostname github.com',
  '    if ($LASTEXITCODE -eq 0) { Write-Host "Return to CLU-E and refresh repositories."; Start-Sleep -Seconds 3; exit 0 }',
  '  } else { Write-Host "Sign-in requires the Windows credential store. Review gh auth status." }',
  '}',
  'Read-Host "GitHub setup did not complete. Press Enter to close" | Out-Null',
  'exit 1',
].join('\r\n');

export async function launchGitHubProfileSignIn(
  checkout: string,
): Promise<{ readonly state: 'SIGN_IN_STARTED' | 'UNAVAILABLE' | 'FAILED'; readonly detail: string }> {
  const root = canonicalCheckout(checkout);
  const gh = root === null ? null : resolveHostCommand('gh.exe', root);
  const git = root === null ? null : resolveHostCommand('git.exe', root);
  const systemRoot = gh?.env['SYSTEMROOT'];
  if (gh === null || git === null || systemRoot === undefined || !isAbsolute(systemRoot)) {
    return { state: 'UNAVAILABLE', detail: 'Install Git and current GitHub CLI on the Windows host and reopen CLU-E.' };
  }
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = Buffer.from(SIGN_IN_SCRIPT, 'utf16le').toString('base64');
  const launcher = `$ErrorActionPreference = "Stop"; Start-Process -FilePath $env:CLU_PROFILE_GH_POWERSHELL -ArgumentList @("-NoLogo", "-NoProfile", "-EncodedCommand", "${script}") -WindowStyle Normal -WorkingDirectory (Split-Path -Parent $env:CLU_PROFILE_GH_EXECUTABLE)`;
  const started = await runHost({
    executable,
    env: {
      ...gh.env, CLU_PROFILE_GH_EXECUTABLE: gh.executable, CLU_PROFILE_GH_POWERSHELL: executable,
      GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    },
  }, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')]);
  return started === null
    ? { state: 'FAILED', detail: 'The Windows GitHub sign-in window could not be opened.' }
    : { state: 'SIGN_IN_STARTED', detail: 'Complete the GitHub browser sign-in using the one-time code in the Windows sign-in window, then refresh repositories.' };
}

export async function listGitHubProfileRepositories(checkout: string): Promise<GitHubProfileRepositoryList> {
  const root = canonicalCheckout(checkout);
  const gh = root === null ? null : githubTool(root);
  if (gh === null) {
    return { state: 'UNAVAILABLE', account: null, repositories: [], detail: 'Install current GitHub CLI on the Windows host and reopen CLU-E.' };
  }
  const auth = await secureAuthentication(gh);
  if (auth.state !== 'CONNECTED') return { ...auth, repositories: [] };
  const pages = parseJson(await runHost(gh, [
    'api', '--hostname', HOST, '--method', 'GET', '--paginate', '--slurp',
    'user/repos?per_page=100&sort=updated&direction=desc',
  ], undefined, 16 * 1024 * 1024, 45_000));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    return { state: 'FAILED', account: auth.account, repositories: [], detail: 'GitHub could not list repositories for the authenticated account.' };
  }
  const repositories = pages.flat().map(parseRepository).filter((entry) => entry !== null);
  return {
    ...auth,
    detail: repositories.length > MAX_REPOSITORIES ? 'Showing the 500 most recently updated repositories.' : auth.detail,
    repositories: repositories.slice(0, MAX_REPOSITORIES),
  };
}

export async function verifyGitHubProfileRepository(
  checkout: string, selection: GitHubProfileRepositorySelection,
): Promise<GitHubProfileRepositoryVerification> {
  const unavailable = { account: null, repository: null, checkoutPath: null, branch: null, baseCommit: null };
  if (!REPOSITORY_NAME.test(selection.nameWithOwner) || !validBranch(selection.branch)) {
    return { ...unavailable, state: 'FAILED', detail: 'Select a GitHub repository and a valid branch.' };
  }
  const root = canonicalCheckout(checkout);
  if (root === null) return { ...unavailable, state: 'CHECKOUT_MISMATCH', detail: 'The profile Target Root is not an available local directory.' };
  const gh = githubTool(root);
  const git = resolveHostCommand('git.exe', root);
  if (gh === null || git === null) {
    return { ...unavailable, state: 'UNAVAILABLE', detail: 'Install Git and current GitHub CLI on the Windows host and reopen CLU-E.' };
  }
  const auth = await secureAuthentication(gh);
  const result = { ...unavailable, account: auth.account, checkoutPath: root };
  if (auth.state !== 'CONNECTED') return { ...result, state: auth.state, detail: auth.detail };
  const repository = parseRepository(parseJson(await runHost(gh, [
    'api', '--hostname', HOST, '--method', 'GET', `repos/${selection.nameWithOwner}`,
  ])));
  if (repository === null || repository.nameWithOwner.toLowerCase() !== selection.nameWithOwner.toLowerCase()) {
    return { ...result, state: 'FAILED', detail: 'The signed-in account could not verify the selected repository.' };
  }

  const readGit = (args: readonly string[]) => runHost(git, [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args,
  ], root);
  const worktree = await readGit(['rev-parse', '--show-toplevel']);
  if (worktree === null || canonicalCheckout(worktree) !== root) {
    return { ...result, repository, state: 'CHECKOUT_MISMATCH', detail: 'Target Root must be the top-level folder of a local Git checkout. For existing source and an empty GitHub repository, initialize Git in the source folder and make a reviewed local commit first.' };
  }
  const [branch, baseCommit, remotes, validRef] = await Promise.all([
    readGit(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    readGit(['rev-parse', '--verify', 'HEAD^{commit}']),
    readGit(['config', '--local', '--no-includes', '--null', '--get-regexp', '^remote\\..*\\.url$']),
    readGit(['check-ref-format', `refs/heads/${selection.branch}`]),
  ]);
  if (branch !== selection.branch || baseCommit === null || !OBJECT_ID.test(baseCommit) || validRef === null) {
    return { ...result, repository, state: 'CHECKOUT_MISMATCH', detail: 'Check out the selected branch with a local commit before connecting it.' };
  }
  const matching = (remotes ?? '').split('\0')
    .map((record) => {
      const separator = record.indexOf('\n');
      return separator === -1 ? null : parseCheckoutRemote(record.slice(separator + 1));
    })
    .find((remote) => remote?.name.toLowerCase() === repository.nameWithOwner.toLowerCase());
  if (matching === undefined || matching === null) {
    return { ...result, repository, state: 'CHECKOUT_MISMATCH', detail: 'The local checkout has no credential-free GitHub remote matching the selected repository.' };
  }

  // Network Git runs outside the repository so repo-local helpers or URL rewrites
  // cannot run. GitHub sign-in configures the operator's GitHub-only host helper.
  const transport: HostCommand = {
    ...git, env: { ...git.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
  };
  const systemRoot = git.env['SYSTEMROOT'];
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    return { ...result, repository, branch, baseCommit, state: 'GIT_ACCESS_BLOCKED', detail: 'The Windows system directory could not be resolved for the isolated Git connection test.' };
  }
  const remoteArgv = [
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', 'ls-remote',
  ];
  const resolved = await runHost(transport, [...remoteArgv, '--get-url', '--', matching.url], systemRoot);
  const ref = `refs/heads/${branch}`;
  const observed = resolved === matching.url
    ? await runHost(transport, [...remoteArgv, '--refs', '--', matching.url, ref], systemRoot)
    : null;
  const branchVerified = observed?.split('\n').some((line) => {
    const [oid, name] = line.trim().split('\t');
    return oid !== undefined && OBJECT_ID.test(oid) && name === ref;
  }) === true;
  let emptyRemote = false;
  if (observed === '') {
    // An empty filtered response proves access, but could also mean a typo in
    // the branch name. Only a successful unfiltered query can prove emptiness.
    const allRefs = await runHost(transport, [...remoteArgv, '--refs', '--', matching.url], systemRoot);
    if (allRefs !== null && allRefs !== '') {
      return { ...result, repository, branch, baseCommit, state: 'CHECKOUT_MISMATCH', detail: 'The remote has Git refs, but the selected branch does not exist there. Select a branch present on both the local checkout and GitHub.' };
    }
    emptyRemote = allRefs === '';
  }
  if (!branchVerified && !emptyRemote) {
    return { ...result, repository, branch, baseCommit, state: 'GIT_ACCESS_BLOCKED', detail: 'GitHub API sign-in passed, but Git could not read the selected branch through the host credential helper or SSH agent.' };
  }

  return {
    state: 'CONNECTED',
    detail: emptyRemote
      ? 'Local checkout and Git transport verified. The GitHub repository is empty and ready for registration. The first branch must be published separately.'
      : 'GitHub account, repository, local checkout, branch, and Git transport verified.',
    account: auth.account, repository: { ...repository, remoteUrl: matching.url }, checkoutPath: root, branch, baseCommit,
  };
}
