/** Local, typed Git publication of one verified accepted ref to its registered GitHub repository. */
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { runBoundedProcess } from '../../benchmark/containedProcess.js';
import { verifyLocalLanding, type LocalLandingPlan } from './localLandingGit.js';

export interface AcceptedPublicationRemoteState {
  readonly remote: string;
  readonly ref: string;
  readonly commit: string | null;
  readonly baseRef: string;
  readonly baseCommit: string;
}

export interface AcceptedPublicationReceipt extends AcceptedPublicationRemoteState {
  readonly commit: string;
  readonly disposition: 'CREATED' | 'ALREADY_PRESENT' | 'RECOVERED';
}

export interface AcceptedPublicationGit {
  inspect(): Promise<AcceptedPublicationRemoteState>;
  publish(expectedRemoteCommit: string | null): Promise<AcceptedPublicationReceipt>;
}

type PublicationErrorCode =
  | 'PUBLICATION_REMOTE_INVALID'
  | 'PUBLICATION_SCOPE_INVALID'
  | 'PUBLICATION_ORIGIN_MISMATCH'
  | 'PUBLICATION_LOCAL_STATE_CHANGED'
  | 'PUBLICATION_GIT_UNAVAILABLE'
  | 'PUBLICATION_REMOTE_UNAVAILABLE'
  | 'PUBLICATION_REMOTE_RESPONSE_INVALID'
  | 'PUBLICATION_REMOTE_BASE_CHANGED'
  | 'PUBLICATION_REMOTE_CONFLICT'
  | 'PUBLICATION_REMOTE_EXPECTATION_CHANGED'
  | 'PUBLICATION_PUSH_UNCONFIRMED';

export class AcceptedPublicationGitError extends Error {
  public constructor(public readonly code: PublicationErrorCode, message: string) {
    super(message);
    this.name = 'AcceptedPublicationGitError';
  }
}

interface GitReply {
  readonly code: number;
  readonly stdout: string;
}

interface AcceptedPublicationTransportInput {
  readonly remote: string;
  readonly ref: string;
  readonly commit: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly landingBranchPrefix?: string;
  readonly verifyLocal: () => void | Promise<void>;
  readonly invoke: (args: readonly string[]) => Promise<GitReply>;
}

const oid = /^[0-9a-f]{40}$/u;
const refGrammar = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const requireCondition: (condition: unknown, code: PublicationErrorCode, detail: string) => asserts condition =
  (condition, code, detail) => {
    if (!condition) throw new AcceptedPublicationGitError(code, detail);
  };

/** Strictly admit the credential-free direct GitHub HTTPS transport. */
export function normalizeAcceptedGitHubRemote(value: string): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,104})$/u.exec(value);
  const owner = match?.[1];
  const name = match?.[2]?.replace(/\.git$/u, '');
  requireCondition(owner !== undefined && !owner.includes('--') && name !== undefined && name.length > 0 && name.length <= 100 &&
    name !== '.' && name !== '..' && !/\.git$/iu.test(name),
  'PUBLICATION_REMOTE_INVALID', 'P44 requires a registered, credential-free https://github.com/OWNER/REPOSITORY Git URL.');
  return `https://github.com/${owner}/${name}.git`;
}

function validBranch(name: string): boolean {
  return refGrammar.test(name) && !name.includes('..') &&
    name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/iu.test(part));
}

function exactOid(value: string): boolean {
  return oid.test(value) && !/^0+$/u.test(value);
}

function readRemoteRefs(reply: GitReply, input: AcceptedPublicationTransportInput): Map<string, string> {
  requireCondition(reply.code === 0 || reply.code === 2,
    'PUBLICATION_REMOTE_UNAVAILABLE', 'GitHub repository access could not be verified. Check connectivity and the Windows Git credential.');
  const rows = reply.stdout.split(/\r?\n/u).filter((line) => line !== '');
  const refs = new Map<string, string>();
  requireCondition((reply.code === 2 && rows.length === 0) || (reply.code === 0 && rows.length > 0 && rows.length <= 2),
    'PUBLICATION_REMOTE_RESPONSE_INVALID', 'GitHub returned an unexpected reference response.');
  for (const row of rows) {
    const [value, ref, ...extra] = row.split('\t');
    requireCondition(value !== undefined && exactOid(value) && ref !== undefined && extra.length === 0 &&
      (ref === input.ref || ref === input.baseRef) && !refs.has(ref),
    'PUBLICATION_REMOTE_RESPONSE_INVALID', 'GitHub returned an ambiguous or unexpected reference response.');
    refs.set(ref, value);
  }
  return refs;
}

function wasCreated(reply: GitReply, ref: string): boolean {
  return reply.code === 0 && reply.stdout.split(/\r?\n/u).some((line) => {
    const [flag, destination] = line.split('\t');
    return flag === '*' && destination?.endsWith(':' + ref) === true;
  });
}

/** The explicit Git protocol, also usable with an isolated fixture transport. */
export function makeAcceptedPublicationGit(input: AcceptedPublicationTransportInput): AcceptedPublicationGit {
  const remote = normalizeAcceptedGitHubRemote(input.remote);
  const { ref, commit, baseRef, baseCommit } = input;
  const prefix = input.landingBranchPrefix ?? 'clue/accepted/';
  const heads = 'refs/heads/';
  requireCondition(ref.startsWith(heads + prefix) && baseRef.startsWith(heads) &&
    prefix.endsWith('/') && validBranch(prefix.slice(0, -1)) &&
    validBranch(ref.slice(heads.length)) && validBranch(baseRef.slice(heads.length)) &&
    ref.toLowerCase() !== baseRef.toLowerCase() && exactOid(commit) && exactOid(baseCommit) && commit !== baseCommit,
  'PUBLICATION_SCOPE_INVALID', 'Publication requires an exact accepted-branch commit, its separate approved parent ref, and a permitted branch name.');

  const inspect = async (): Promise<AcceptedPublicationRemoteState> => {
    await input.verifyLocal();
    const reply = await input.invoke(['ls-remote', '--exit-code', '--refs', '--heads', '--', remote, ref, baseRef]);
    const refs = readRemoteRefs(reply, input);
    requireCondition(refs.get(baseRef) === baseCommit, 'PUBLICATION_REMOTE_BASE_CHANGED',
      'The GitHub default branch is missing or differs from the accepted proof parent. Review the remote base before publication.');
    await input.verifyLocal();
    return { remote, ref, commit: refs.get(ref) ?? null, baseRef, baseCommit };
  };
  return {
    inspect,
    async publish(expectedRemoteCommit) {
      requireCondition(expectedRemoteCommit === null || expectedRemoteCommit === commit,
        'PUBLICATION_REMOTE_EXPECTATION_CHANGED', 'The reviewed remote state is outside this exact publication.');
      const before = await inspect();
      requireCondition(before.commit === null || before.commit === commit, 'PUBLICATION_REMOTE_CONFLICT',
        'The GitHub accepted branch already names a different commit. The existing branch was preserved.');
      if (before.commit === commit) return { ...before, commit, disposition: 'ALREADY_PRESENT' };
      requireCondition(expectedRemoteCommit === null, 'PUBLICATION_REMOTE_EXPECTATION_CHANGED',
        'The verified GitHub branch disappeared after review. Review its new state before creating it.');

      // An empty expected lease means create-only. It prevents a race from rewriting
      // a branch that appeared after inspection, even if that branch is an ancestor.
      const argv = ['push', '--porcelain', '--no-verify', '--no-signed', '--no-follow-tags', '--recurse-submodules=no',
        `--force-with-lease=${ref}:`, '--', remote, `${commit}:${ref}`];
      const result = await input.invoke(argv).catch((): GitReply => ({ code: -1, stdout: '' }));
      const after = await inspect();
      requireCondition(after.commit === null || after.commit === commit, 'PUBLICATION_REMOTE_CONFLICT',
        'The GitHub accepted branch now names a different commit. No retry or overwrite was attempted.');
      requireCondition(after.commit === commit, 'PUBLICATION_PUSH_UNCONFIRMED',
        'The precise GitHub branch could not be confirmed. Check the saved publication intent before retrying.');
      return { ...after, commit, disposition: wasCreated(result, ref) ? 'CREATED' : 'RECOVERED' };
    },
  };
}

function insideOrEqual(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === '' || (diff !== '..' && !diff.startsWith('..' + sep) && !isAbsolute(diff));
}

function physical(path: string, kind: 'directory' | 'file', installedTool = false): string {
  const actual = realpathSync.native(path);
  const stat = lstatSync(path);
  requireCondition(relative(path, actual) === '' &&
    (kind === 'file' ? stat.isFile() && (installedTool || stat.nlink === 1) : stat.isDirectory()),
  'PUBLICATION_GIT_UNAVAILABLE', 'The Git publication runtime contains an unexpected path alias or file type.');
  return actual;
}

interface WindowsGit {
  readonly executable: string;
  readonly environment: NodeJS.ProcessEnv;
}

function installedWindowsGit(): WindowsGit {
  requireCondition(process.platform === 'win32', 'PUBLICATION_GIT_UNAVAILABLE',
    'The production publication transport requires the configured Windows Git Credential Manager.');
  const environment: NodeJS.ProcessEnv = {};
  const allowed = new Set(['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMW6432', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN']);
  for (const [name, value] of Object.entries(process.env)) {
    const key = name.toUpperCase();
    if (allowed.has(key) && value !== undefined) environment[key] = value;
  }
  const programFiles = environment['PROGRAMW6432'] ?? environment['PROGRAMFILES'];
  const systemRoot = environment['SYSTEMROOT'];
  requireCondition(programFiles !== undefined && isAbsolute(programFiles) && systemRoot !== undefined && isAbsolute(systemRoot),
    'PUBLICATION_GIT_UNAVAILABLE', 'Windows could not identify the installed Git or system directory.');
  try {
    const install = physical(join(programFiles, 'Git'), 'directory');
    const executable = physical(join(install, 'cmd', 'git.exe'), 'file', true);
    const systemBin = physical(join(systemRoot, 'System32'), 'directory');
    const helpers = ['mingw64', 'mingw32'].map((arch) => ({
      exec: join(install, arch, 'libexec', 'git-core'), bin: join(install, arch, 'bin'),
    })).flatMap(({ exec, bin }) => [exec, bin].map((cred) => ({ exec, bin, cred })));
    for (const { exec, bin, cred } of helpers) {
      try {
        const gitCore = physical(exec, 'directory');
        const gitBin = physical(bin, 'directory');
        physical(join(gitCore, 'git-remote-https.exe'), 'file', true);
        const manager = physical(join(cred, 'git-credential-manager.exe'), 'file', true);
        return {
          executable,
          environment: {
            ...environment, PATH: [...new Set([dirname(manager), gitCore, gitBin, dirname(executable), systemBin])].join(delimiter),
            GIT_EXEC_PATH: gitCore, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_COUNT: '0',
            GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GCM_GUI_PROMPT: '0',
            GIT_ALLOW_PROTOCOL: 'https', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
            GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
          },
        };
      } catch {
        // Git for Windows may install its Credential Manager beside Git or its helpers.
      }
    }
  } catch {
    // A nonphysical Git path cannot provide the reviewed executable and credential helper.
  }
  throw new AcceptedPublicationGitError('PUBLICATION_GIT_UNAVAILABLE',
    'The standard Git for Windows installation and its Git Credential Manager are required for publication.');
}

/** Reports installed executables only. It does not start a process or access credentials. */
export function inspectAcceptedPublicationHost(): {
  readonly available: boolean;
  readonly code: 'PUBLICATION_GIT_AVAILABLE' | 'PUBLICATION_GIT_UNAVAILABLE';
} {
  try {
    installedWindowsGit();
    return { available: true, code: 'PUBLICATION_GIT_AVAILABLE' };
  } catch {
    return { available: false, code: 'PUBLICATION_GIT_UNAVAILABLE' };
  }
}

const gitSettings = [
  '--no-optional-locks', '--no-replace-objects',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'credential.helper=', '-c', 'credential.helper=manager', '-c', 'credential.interactive=never',
  '-c', 'http.sslVerify=true', '-c', 'http.sslBackend=schannel', '-c', 'http.followRedirects=false',
  '-c', 'push.followTags=false', '-c', 'push.gpgSign=false', '-c', 'push.recurseSubmodules=no',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
] as const;

/** Production adapter. Local Git config, Git aliases, and remote push URLs cannot select its transport. */
export function createAcceptedPublicationGit(
  plan: LocalLandingPlan,
  registeredRemote: string,
  requireActiveProfile: () => void = () => {},
): AcceptedPublicationGit {
  const remote = normalizeAcceptedGitHubRemote(registeredRemote);
  const native = installedWindowsGit();
  const root = physical(plan.repositoryRoot, 'directory');
  const gitDir = physical(join(root, '.git'), 'directory');
  const objects = physical(join(gitDir, 'objects'), 'directory');
  const temp = physical(tmpdir(), 'directory');
  requireCondition(!insideOrEqual(root, temp), 'PUBLICATION_GIT_UNAVAILABLE',
    'Publication scratch must be outside the target checkout.');

  const run = (cwd: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}, timeoutMs = 45_000): Promise<GitReply> =>
    runBoundedProcess(native.executable, [...gitSettings, ...args], { cwd, env: { ...native.environment, ...extra }, timeoutMs });
  const verifyLocal = async () => {
    requireActiveProfile();
    try {
      const state = verifyLocalLanding(plan, 'applied');
      requireCondition(state.landingCommit === plan.acceptedCommit && state.targetCommit === plan.baseCommit,
        'PUBLICATION_LOCAL_STATE_CHANGED', 'The verified local accepted branch or its base changed.');
    } catch {
      throw new AcceptedPublicationGitError('PUBLICATION_LOCAL_STATE_CHANGED',
        'The verified local accepted branch or its base changed. Review its current state before publication.');
    }
    const config = physical(join(gitDir, 'config'), 'file');
    const result = await run(temp, ['config', '--file', config, '--no-includes', '--null', '--get-all', 'remote.origin.url']);
    const entries = result.stdout.split('\0');
    let origin: string | null = null;
    if (result.code === 0 && entries.length === 2 && entries[1] === '') {
      const raw = entries[0];
      if (raw !== undefined) {
        try { origin = normalizeAcceptedGitHubRemote(raw); } catch { /* A non-GitHub origin has no publication authority. */ }
      }
    }
    requireCondition(origin !== null && origin.toLowerCase() === remote.toLowerCase(), 'PUBLICATION_ORIGIN_MISMATCH',
      'The checkout origin differs from the registered GitHub repository.');
    requireActiveProfile();
  };

  const invoke = async (args: readonly string[]): Promise<GitReply> => {
    const scratch = mkdtempSync(join(temp, 'clue-p44-git-'));
    try {
      const bare = join(scratch, 'repository.git');
      const initialized = await run(scratch, ['init', '--quiet', '--bare', '--template=', '--object-format=sha1', bare]);
      requireCondition(initialized.code === 0, 'PUBLICATION_GIT_UNAVAILABLE',
        'Git could not initialize isolated publication metadata.');
      const environment = { GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(physical(objects, 'directory')) };
      // The controlled bare metadata owns Git's internal state. The borrowed object
      // directory is a fallback for reads. Push names the approved object, not a mutable ref.
      requireActiveProfile();
      return await run(scratch, [`--git-dir=${bare}`, ...args], environment, args[0] === 'push' ? 120_000 : 45_000);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  };
  return makeAcceptedPublicationGit({
    remote, ref: plan.landingRef, commit: plan.acceptedCommit, baseRef: plan.targetRef, baseCommit: plan.baseCommit,
    landingBranchPrefix: plan.landingBranchPrefix, verifyLocal, invoke,
  });
}
