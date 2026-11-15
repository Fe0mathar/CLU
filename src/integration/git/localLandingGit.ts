/** An offline Git transport for the Custodian's exact local accepted and rollback commits. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { hashBytes } from '../../shared/ids.js';
import { normaliseIdentityPath } from '../../shared/pathIdentity.js';

export type LocalLandingOperation =
  | { readonly op: 'write'; readonly path: string; readonly content: Uint8Array; readonly sha256: string;
      readonly baseSha256: string | null }
  | { readonly op: 'delete'; readonly path: string; readonly baseSha256: string };

export interface LocalLandingBase {
  readonly baseCommit: string;
  readonly baseTree: string;
}

export interface LocalLandingRequest extends LocalLandingBase {
  readonly repositoryRoot: string;
  readonly targetBranch: string;
  readonly landingBranch: string;
  readonly landingBranchPrefix: string;
  readonly proofId: string;
  readonly proofTimestamp: string;
  readonly operations: readonly LocalLandingOperation[];
}

export interface LocalLandingPlan extends LocalLandingBase {
  readonly repositoryRoot: string;
  readonly targetRef: string;
  readonly landingRef: string;
  readonly landingBranchPrefix: string;
  readonly acceptedCommit: string;
  readonly acceptedTree: string;
  readonly rollbackCommit: string;
  readonly proofId: string;
  readonly proofTimestamp: string;
}

export type LocalLandingState = 'not_applied' | 'applied' | 'rolled_back' | 'diverged';
export interface LocalLandingObservation {
  readonly state: LocalLandingState;
  readonly landingCommit: string | null;
  readonly targetCommit: string;
}

export class LocalLandingGitError extends Error {
  public constructor(public readonly code: string, detail: string) {
    super(detail);
    this.name = 'LocalLandingGitError';
  }
}

const identifier = /^EVENT-[0-9]+$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,209}$/u;
const blockedConfiguration = /^(?:include(?:if)?\.|filter\.|diff\..*\.(?:command|textconv)$|merge\..*\.driver$|core\.(?:hookspath|attributesfile|worktree|splitindex|sparsecheckout(?:cone)?)$|extensions\.partialclone$|remote\..*\.promisor$)/u;
const commitName = 'CLU-E Custodian';
const commitEmail = 'custodian@clue.invalid';
const attributes = ['filter', 'working-tree-encoding', 'ident', 'eol', 'text'] as const;
const allowedModes = new Set(['100644', '100755']);

const requireCondition: (condition: unknown, code: string, detail: string) => asserts condition = (condition, code, detail) => {
  if (!condition) throw new LocalLandingGitError(code, detail);
};

interface GitResult {
  readonly status: number;
  readonly output: Buffer;
}

interface Repository {
  readonly root: string;
  readonly gitDir: string;
  readonly objects: string;
  readonly oidLength: 40 | 64;
  readonly base: LocalLandingBase;
  readonly autocrlf: string;
  readonly eol: string;
  read(args: readonly string[], input?: string | Uint8Array, extraEnvironment?: NodeJS.ProcessEnv): Buffer;
  run(args: readonly string[], input?: string | Uint8Array, extraEnvironment?: NodeJS.ProcessEnv): GitResult;
}

function samePath(a: string, b: string): boolean {
  return normaliseIdentityPath(a) === normaliseIdentityPath(b);
}

function containsPath(root: string, path: string): boolean {
  const delta = relative(root, path);
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function exactPath(path: string, kind: 'directory' | 'file'): boolean {
  try {
    const stat = lstatSync(path);
    return samePath(realpathSync.native(path), path) && (kind === 'file' ? stat.isFile() : stat.isDirectory());
  } catch {
    return false;
  }
}

const hostEnvironment = new Set(['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA']);
const overrides = ['--no-optional-locks', '--no-replace-objects',
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
  '-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true', '-c', 'submodule.recurse=false',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'commit.gpgSign=false', '-c', 'core.quotePath=false'];

function gitTransport(root: string): (args: readonly string[], input?: string | Uint8Array,
  extraEnvironment?: NodeJS.ProcessEnv, useHostConfig?: boolean) => GitResult {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const key = name.toUpperCase();
    if (hostEnvironment.has(key)) env[process.platform === 'win32' ? key : name] = value;
  }

  const standardLocations = process.platform === 'win32'
    ? [env['PROGRAMFILES'], env['PROGRAMFILES(X86)']].filter((path): path is string => path !== undefined && isAbsolute(path))
      .map((path) => join(path, 'Git', 'cmd', 'git.exe'))
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  let executable: string | undefined;
  for (const path of standardLocations) {
    try {
      const git = realpathSync.native(path);
      if (containsPath(root, git) || !statSync(git).isFile()) continue;
      accessSync(git, constants.X_OK);
      executable = git;
      break;
    } catch {
      // Another standard installation path may be present.
    }
  }
  requireCondition(executable !== undefined, 'GIT_LANDING_EXECUTABLE_UNAVAILABLE',
    'An installed Git executable outside the target checkout is required.');
  const command = executable;
  const paths = process.platform === 'win32'
    ? [dirname(command), env['SYSTEMROOT'] === undefined ? '' : join(env['SYSTEMROOT'], 'System32')]
    : [dirname(command), '/usr/bin', '/bin'];
  return (args, input, extraEnvironment, useHostConfig) => {
    const child = spawnSync(command, [...(useHostConfig ? [] : overrides), ...args], {
      cwd: root, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      env: {
        ...env,
        PATH: paths.filter(Boolean).join(delimiter),
        LC_ALL: 'C',
        GIT_ATTR_NOSYSTEM: '1',
        ...(useHostConfig ? {} : { GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }),
        GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
        GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
        GIT_LITERAL_PATHSPECS: '1', ...extraEnvironment,
      },
      ...(input === undefined ? {} : { input }),
    });
    requireCondition(child.error === undefined && typeof child.status === 'number', 'GIT_LANDING_COMMAND_FAILED',
      `Git ${args[0]} could not finish within the local transport limits.`);
    return { status: child.status, output: child.stdout ?? Buffer.alloc(0) };
  };
}

function decoded(bytes: Buffer): string {
  const decoded = bytes.toString('utf8');
  requireCondition(Buffer.from(decoded, 'utf8').equals(bytes), 'GIT_LANDING_ENCODING_UNVERIFIED',
    'Git returned paths or metadata outside the supported UTF-8 encoding.');
  return decoded;
}

function splitNul(value: Buffer): string[] {
  if (value.length === 0) return [];
  const fields = decoded(value).split('\0');
  requireCondition(fields.pop() === '', 'GIT_LANDING_FORMAT_UNVERIFIED', 'Git returned incomplete NUL-delimited output.');
  return fields;
}

function requireObject(value: string, oidLength?: number): string {
  requireCondition(objectId.test(value) && (oidLength === undefined || value.length === oidLength) && !/^0+$/u.test(value),
    'GIT_LANDING_OBJECT_INVALID', 'Git did not identify an exact object.');
  return value;
}

function validBranch(value: string): boolean {
  return branchName.test(value) && value.split('/').every((part) =>
    part !== '' && !part.startsWith('.') && !part.endsWith('.') && !/\.lock$/iu.test(part)) && !value.includes('..');
}

function headRef(branch: string): string {
  requireCondition(validBranch(branch), 'GIT_LANDING_REF_INVALID', 'A safe local branch is required.');
  return `refs/heads/${branch}`;
}

function landingRef(branch: string, prefix: string, targetRef: string): string {
  const ref = headRef(branch);
  requireCondition(prefix.endsWith('/') && validBranch(prefix.slice(0, -1)) &&
    branch.startsWith(prefix) && branch.length > prefix.length && ref !== targetRef,
  'GIT_LANDING_REF_INVALID', 'Landing requires one inactive branch in the configured accepted ref namespace.');
  return ref;
}

function configurationValue(run: Repository['run'], name: string): string | null {
  const result = run(['config', '--get', '--null', name]);
  if (result.status === 1) return null;
  requireCondition(result.status === 0, 'GIT_LANDING_CONFIG_UNVERIFIED', 'Git configuration could not be inspected.');
  const [value, ...others] = splitNul(result.output);
  requireCondition(value !== undefined && others.length === 0, 'GIT_LANDING_CONFIG_UNVERIFIED',
    'Git configuration has conflicting values for a landing setting.');
  return value.toLowerCase();
}

function openRepository(repoRoot: string, targetRef: string, expected?: LocalLandingBase): Repository {
  requireCondition(isAbsolute(repoRoot) && exactPath(repoRoot, 'directory'), 'GIT_LANDING_ROOT_UNVERIFIED',
    'The target has to be an exact physical Git checkout.');
  const root = realpathSync.native(repoRoot);
  const gitDir = join(root, '.git');
  const objects = join(gitDir, 'objects');
  const directGitPath = [gitDir, objects, join(gitDir, 'refs'), join(gitDir, 'config'), join(gitDir, 'HEAD'), join(gitDir, 'index')];
  requireCondition(directGitPath.slice(0, 3).every((path) => exactPath(path, 'directory')) &&
    directGitPath.slice(3).every((path) => exactPath(path, 'file')) &&
    lstatSync(join(objects, 'info', 'alternates'), { throwIfNoEntry: false }) === undefined &&
    lstatSync(join(gitDir, 'commondir'), { throwIfNoEntry: false }) === undefined &&
    lstatSync(join(gitDir, 'info', 'attributes'), { throwIfNoEntry: false }) === undefined,
  'GIT_LANDING_REPOSITORY_UNSUPPORTED', 'An ordinary checkout with its own object database and tracked attributes is required.');

  const invoke = gitTransport(root);
  const run: Repository['run'] = (args, input, operationEnv) => invoke(args, input, operationEnv);
  const read: Repository['read'] = (args, input, operationEnv) => {
    const result = run(args, input, operationEnv);
    requireCondition(result.status === 0, 'GIT_LANDING_COMMAND_FAILED', `Git ${args[0]} refused the local operation.`);
    return result.output;
  };
  const get = (args: readonly string[]) => decoded(read(args)).trim();
  requireCondition(get(['rev-parse', '--is-inside-work-tree']) === 'true' &&
    samePath(get(['rev-parse', '--show-toplevel']), root) &&
    samePath(get(['rev-parse', '--absolute-git-dir']), gitDir) &&
    samePath(get(['rev-parse', '--path-format=absolute', '--git-common-dir']), gitDir),
  'GIT_LANDING_ROOT_UNVERIFIED', 'Git did not resolve the declared repository and checkout layout.');

  const config = invoke(['config', '--local', '--no-includes', '--name-only', '--null', '--list']);
  requireCondition(config.status === 0 && splitNul(config.output).every((key) => !blockedConfiguration.test(key)),
    'GIT_LANDING_CONFIG_UNSUPPORTED', 'Git configuration requires separate review for hooks, filters, alternate attributes, sparse checkout or external helpers.');
  const signing = configurationValue((args) => invoke(args, undefined, undefined, true), 'commit.gpgsign');
  requireCondition(signing === null || ['false', 'no', 'off', '0'].includes(signing),
    'GIT_LANDING_SIGNING_UNSUPPORTED', 'This checkout requires a signed commit; this local transport cannot sign it.');
  const autocrlf = configurationValue((args) => invoke(args, undefined, undefined, true), 'core.autocrlf') ?? 'false';
  const eol = configurationValue((args) => invoke(args, undefined, undefined, true), 'core.eol') ?? 'native';
  const externalAttributes = configurationValue((args) => invoke(args, undefined, undefined, true), 'core.attributesfile');
  requireCondition(externalAttributes === null, 'GIT_LANDING_CONFIG_UNSUPPORTED',
    'External Git attributes require separate review before exact landing.');
  const filemode = configurationValue(run, 'core.filemode') ?? 'true';
  requireCondition(['false', 'true', 'input', '0', '1', 'off', 'on', 'no', 'yes'].includes(autocrlf) &&
    ['native', 'lf', 'crlf'].includes(eol), 'GIT_LANDING_CONFIG_UNSUPPORTED', 'Git line-ending configuration is unsupported.');

  requireCondition(get(['symbolic-ref', '--quiet', 'HEAD']) === targetRef, 'GIT_LANDING_TARGET_BRANCH_MISMATCH',
    'Check out the registered target branch before executing the local landing.');
  const targetSymbol = run(['symbolic-ref', '--quiet', '--no-recurse', targetRef]);
  requireCondition(targetSymbol.status === 1, 'GIT_LANDING_TARGET_BRANCH_MISMATCH', 'The target branch must be a direct Git reference.');
  const format = get(['rev-parse', '--show-object-format']);
  requireCondition(format === 'sha1' || format === 'sha256', 'GIT_LANDING_FORMAT_UNVERIFIED', 'Git object format is unsupported.');
  const oidLength = format === 'sha1' ? 40 : 64;
  const baseCommit = requireObject(get(['rev-parse', '--verify', `${targetRef}^{commit}`]), oidLength);
  const baseTree = requireObject(get(['rev-parse', '--verify', `${baseCommit}^{tree}`]), oidLength);
  requireCondition(expected === undefined || (baseCommit === expected.baseCommit && baseTree === expected.baseTree),
    'GIT_LANDING_BASE_MOVED', 'The target branch or tree has moved since the accepted proof.');
  const state = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
  requireCondition(state.every((name) => lstatSync(join(gitDir, name), { throwIfNoEntry: false }) === undefined),
    'GIT_LANDING_DIRTY_WORKTREE', 'An unfinished Git operation holds this checkout.');
  const repository: Repository = { root, gitDir, objects, oidLength, base: { baseCommit, baseTree }, autocrlf, eol, read, run };
  verifyWorktree(repository, ['true', 'yes', 'on', '1'].includes(filemode));
  return repository;
}

export function inspectLocalLandingBase(repositoryRoot: string, expectedBranch: string): LocalLandingBase {
  return openRepository(repositoryRoot, headRef(expectedBranch)).base;
}

function validateProofIdentity(proofId: string, proofTimestamp: string): number {
  const milliseconds = Date.parse(proofTimestamp);
  requireCondition(identifier.test(proofId) && Number.isSafeInteger(milliseconds) && milliseconds >= 0 &&
    new Date(milliseconds).toISOString() === proofTimestamp,
  'GIT_LANDING_PROOF_ID_INVALID', 'An exact proof event ID and canonical UTC timestamp are required.');
  return Math.floor(milliseconds / 1000);
}

function changedPath(path: string): boolean {
  return path.length <= 250 && !path.includes('\\') && path.split('/').every((part) =>
    part !== '' && part !== '.' && part !== '..' && !/[<>:"|?*\u0000-\u001f\u007f]|[ .]$/u.test(part) &&
    !/^(?:\.git(?:[.~]|$)|git~[0-9]|\.gitattributes$|\.gitmodules$|\.gitconfig$)/iu.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part));
}

interface TreeEntry {
  readonly mode: string;
  readonly id: string;
}

function blobId(repo: Repository, bytes: Uint8Array): string {
  return createHash(repo.oidLength === 40 ? 'sha1' : 'sha256').update(
    'blob ' + bytes.length + '\0', 'utf8').update(bytes).digest('hex');
}

type EntryAttributes = ReadonlyMap<string, string>;

function indexAttributes(repo: Repository, paths: readonly string[]): Map<string, EntryAttributes> {
  const fields = splitNul(repo.read(['check-attr', '--cached', '-z', '--stdin', ...attributes], paths.join('\0') + '\0'));
  requireCondition(fields.length === paths.length * attributes.length * 3, 'GIT_LANDING_ATTRIBUTES_UNVERIFIED',
    'Tracked Git attributes could not be verified.');
  return new Map(paths.map((path, index) => [path, new Map(attributes.map((name, position) => {
    const key = (index * attributes.length + position) * 3;
    requireCondition(fields[key] === path && fields[key + 1] === name && fields[key + 2] !== undefined,
      'GIT_LANDING_ATTRIBUTES_UNVERIFIED', 'Tracked Git attributes changed during verification.');
    return [name, fields[key + 2]!];
  }))]));
}

function inactiveAttribute(value: string | undefined): boolean {
  return value === 'unspecified' || value === 'unset';
}

function canonicalEol(repo: Repository, values: EntryAttributes, bytes: Buffer): Buffer {
  const text = values.get('text');
  const eol = values.get('eol');
  const convert = text !== 'unset' && !bytes.includes(0) &&
    (text === 'set' || text === 'auto' || eol === 'lf' || eol === 'crlf' ||
      ['true', 'yes', 'on', '1', 'input'].includes(repo.autocrlf));
  if (!convert || bytes.indexOf('\r\n') === -1) return bytes;
  return Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
}

/** Check exact Git and worktree state without invoking status, external helpers or content filters. */
function verifyWorktree(repo: Repository, checkExecutable: boolean): void {
  requireCondition(repo.run(['diff-index', '--quiet', '--cached', '--no-ext-diff', '--no-textconv',
    repo.base.baseTree, '--']).status === 0 && repo.read(['ls-files', '--others', '--exclude-standard', '-z']).length === 0,
  'GIT_LANDING_DIRTY_WORKTREE', 'The target checkout has staged or untracked changes.');
  const entries = splitNul(repo.read(['ls-files', '--stage', '-v', '-z'])).map((entry) => {
    const match = /^H (100644|100755|120000) ([a-f0-9]+) 0\t([^\\\u0000-\u001f]+)$/u.exec(entry);
    requireCondition(match !== null && match[3]!.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      'GIT_LANDING_INDEX_UNSUPPORTED', 'The checkout has unmanaged index entries, Git links or hidden changes.');
    return { mode: match[1]!, id: requireObject(match[2]!, repo.oidLength), path: match[3]! };
  });
  const attribs = entries.length === 0 ? new Map<string, EntryAttributes>() : indexAttributes(repo, entries.map(({ path }) => path));
  const directories = new Set<string>();
  for (const { mode, id, path } of entries) {
    const file = join(repo.root, path);
    let parent = dirname(file);
    while (parent !== repo.root && !directories.has(parent)) {
      requireCondition(exactPath(parent, 'directory'), 'GIT_LANDING_DIRTY_WORKTREE', 'A tracked parent directory is missing or redirected.');
      directories.add(parent);
      parent = dirname(parent);
    }
    const stat = lstatSync(file, { throwIfNoEntry: false });
    requireCondition(stat !== undefined && stat.size <= 32 * 1024 * 1024 &&
      (mode === '120000' && stat.isSymbolicLink() || exactPath(file, 'file')),
    'GIT_LANDING_DIRTY_WORKTREE', 'A tracked path is modified, missing or outside the local materialization limits.');
    requireCondition(!checkExecutable || mode === '120000' || ((stat.mode & 0o100) !== 0) === (mode === '100755'),
      'GIT_LANDING_DIRTY_WORKTREE', 'A tracked file has a modified executable bit.');
    const bytes = stat.isSymbolicLink() ? readlinkSync(file, { encoding: 'buffer' }) : readFileSync(file);
    const mapping = attribs.get(path)!;
    requireCondition(blobId(repo, bytes) === id || (mode !== '120000' &&
      ['filter', 'working-tree-encoding', 'ident'].every((name) => inactiveAttribute(mapping.get(name))) &&
      blobId(repo, canonicalEol(repo, mapping, bytes)) === id),
    'GIT_LANDING_DIRTY_WORKTREE', 'A tracked file does not reproduce its Git blob under the verified byte mapping.');
  }
}

interface PreparedOperation {
  readonly operation: LocalLandingOperation;
  readonly base: TreeEntry | null;
  readonly replacement: TreeEntry | null;
}

function verifyCleanWorktreePath(repo: Repository, path: string, base: TreeEntry | null, baseSha: string | null): void {
  let local = repo.root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    local = join(local, part);
    const stat = lstatSync(local, { throwIfNoEntry: false });
    if (stat === undefined && base === null) return;
    const leaf = index === parts.length - 1;
    requireCondition(stat !== undefined && (leaf ? base !== null && stat.size <= 16 * 1024 * 1024 &&
      exactPath(local, 'file') : exactPath(local, 'directory')),
      'GIT_LANDING_PATH_COLLISION', 'A changed path overlaps an untracked, linked or non-regular working tree entry.');
  }
  requireCondition(baseSha !== null && base !== null && hashBytes(readFileSync(local)) === baseSha &&
    hashBytes(repo.read(['cat-file', 'blob', base.id])) === baseSha,
    'GIT_LANDING_BASE_BYTES_MISMATCH', 'The exact bytes used in proof differ from the pinned Git base blob.');
}

function requireExactAttributes(repo: Repository, path: string, bytes: Buffer | null): void {
  const values = indexAttributes(repo, [path]).get(path)!;
  const [filter, encoding, ident, eol, text] = attributes.map((attribute) => values.get(attribute));
  requireCondition(inactiveAttribute(filter) && inactiveAttribute(encoding) && inactiveAttribute(ident) &&
    ['unspecified', 'unset', 'lf', 'crlf'].includes(eol ?? '') && ['unspecified', 'unset', 'set', 'auto'].includes(text ?? ''),
  'GIT_LANDING_ATTRIBUTES_UNSUPPORTED', 'Worktree filters, encodings or identity expansion prevent an exact landing.');
  const binary = text === 'unset' || bytes?.includes(0) === true;
  const crlfCheckout = eol === 'crlf' || (eol !== 'lf' && (['true', 'yes', 'on', '1'].includes(repo.autocrlf) ||
    ['set', 'auto'].includes(text ?? '') && (repo.eol === 'crlf' || repo.eol === 'native' && process.platform === 'win32')));
  requireCondition(bytes === null || (canonicalEol(repo, values, bytes).equals(bytes) && (binary || !crlfCheckout || !bytes.includes(10))),
    'GIT_LANDING_ATTRIBUTES_UNSUPPORTED',
    'The configured checkout would translate the exact proved bytes.');
}

function validateOperations(repo: Repository, operations: readonly LocalLandingOperation[]): PreparedOperation[] {
  requireCondition(operations.length > 0 && operations.length <= 1024,
    'GIT_LANDING_CHANGE_SET_INVALID', 'A bounded, non-empty proof change set is required.');
  const paths = new Set<string>();
  return operations.map((operation) => {
    const path = operation.path;
    const key = path.normalize('NFC').toLowerCase();
    requireCondition(changedPath(path) && !paths.has(key), 'GIT_LANDING_CHANGE_SET_INVALID',
      'The proof contains an unsafe, reserved or repeated path.');
    paths.add(key);
    const hits = splitNul(repo.read(['ls-tree', '-z', repo.base.baseTree, '--', path]));
    let base: TreeEntry | null = null;
    if (hits.length > 0) {
      const match = /^(\d{6}) blob ([a-f0-9]+)\t([\s\S]+)$/u.exec(hits[0] ?? '');
      requireCondition(hits.length === 1 && match !== null && match[3] === path && allowedModes.has(match[1] ?? ''),
        'GIT_LANDING_CHANGE_SET_INVALID', 'The exact proof change does not identify a regular Git blob.');
      base = { mode: match[1]!, id: requireObject(match[2]!, repo.oidLength) };
    }
    requireCondition(base === null ? operation.op === 'write' && operation.baseSha256 === null :
      typeof operation.baseSha256 === 'string' && sha256.test(operation.baseSha256), 'GIT_LANDING_BASE_BYTES_MISMATCH',
    'The patch lacks the exact source identity of an existing or deleted proof input.');
    verifyCleanWorktreePath(repo, path, base, operation.baseSha256);
    const content = operation.op === 'write' ? Buffer.from(operation.content) : null;
    requireExactAttributes(repo, path, content);
    if (operation.op === 'delete') return { operation, base, replacement: null };
    requireCondition(content !== null && content.length <= 16 * 1024 * 1024 && hashBytes(content) === operation.sha256,
      'GIT_LANDING_CANDIDATE_BYTES_MISMATCH', 'Candidate change bytes do not match the accepted patch digest.');
    const id = blobId(repo, content);
    requireCondition(id !== base?.id, 'GIT_LANDING_CHANGE_SET_INVALID', 'The proposed write leaves the Git blob unchanged.');
    return { operation: { ...operation, content }, base, replacement: { mode: base?.mode ?? '100644', id } };
  });
}

function exactChangeSet(repo: Repository, acceptedTree: string, operations: readonly PreparedOperation[],
  env: NodeJS.ProcessEnv): void {
  const raw = splitNul(repo.read(['diff-tree', '--raw', '--no-abbrev', '--no-renames', '-r', '-z',
    repo.base.baseTree, acceptedTree, '--'], undefined, env));
  requireCondition(raw.length === operations.length * 2,
    'GIT_LANDING_TREE_MISMATCH', 'Git prepared changes outside the exact accepted Change-Set Partition.');
  const byPath = new Map(operations.map((item) => [item.operation.path, item]));
  const zero = '0'.repeat(repo.oidLength);
  for (let index = 0; index < raw.length; index += 2) {
    const path = raw[index + 1]!;
    const item = byPath.get(path);
    requireCondition(item !== undefined, 'GIT_LANDING_TREE_MISMATCH', 'Git prepared a path outside the accepted patch.');
    const { base, replacement } = item;
    const status = base === null ? 'A' : replacement === null ? 'D' : 'M';
    const expected = `:${base?.mode ?? '000000'} ${replacement?.mode ?? '000000'} ${base?.id ?? zero} ${replacement?.id ?? zero} ${status}`;
    requireCondition(raw[index] === expected, 'GIT_LANDING_TREE_MISMATCH',
      'Git prepared a different blob, file mode or operation than the accepted patch.');
    byPath.delete(path);
  }
}

function message(proofId: string, rollback: boolean): string {
  return `CLU-E ${rollback ? 'rollback' : 'accepted change'} ${proofId}\n\nCLU-E-Proof-Event: ${proofId}\n`;
}

function commit(repo: Repository, tree: string, parent: string, proofId: string, proofTimestamp: string,
  rollback: boolean, env: NodeJS.ProcessEnv): string {
  const time = validateProofIdentity(proofId, proofTimestamp);
  const identities = {
    GIT_AUTHOR_NAME: commitName, GIT_AUTHOR_EMAIL: commitEmail, GIT_AUTHOR_DATE: `@${time} +0000`,
    GIT_COMMITTER_NAME: commitName, GIT_COMMITTER_EMAIL: commitEmail, GIT_COMMITTER_DATE: `@${time} +0000`,
  };
  return requireObject(decoded(repo.read(['commit-tree', tree, '-p', parent, '-F', '-'], message(proofId, rollback),
    { ...identities, ...env })).trim(), repo.oidLength);
}

function buildObjects(repo: Repository, request: LocalLandingRequest, operations: readonly PreparedOperation[],
  env: NodeJS.ProcessEnv): Pick<LocalLandingPlan, 'acceptedCommit' | 'acceptedTree' | 'rollbackCommit'> {
  const zero = '0'.repeat(repo.oidLength);
  repo.read(['read-tree', repo.base.baseTree], undefined, env);
  for (const { operation, replacement } of operations) {
    if (operation.op === 'write') {
      const id = decoded(repo.read(['hash-object', '-w', '--no-filters', '--stdin'], operation.content, env)).trim();
      requireCondition(id === replacement?.id, 'GIT_LANDING_CANDIDATE_BYTES_MISMATCH', 'Git stored different candidate bytes.');
    }
  }
  const commands = operations.map(({ operation, replacement }) =>
    `${replacement?.mode ?? '0'} ${replacement?.id ?? zero}\t${operation.path}\0`).join('');
  repo.read(['update-index', '-z', '--index-info'], commands, env);
  const acceptedTree = requireObject(decoded(repo.read(['write-tree'], undefined, env)).trim(), repo.oidLength);
  exactChangeSet(repo, acceptedTree, operations, env);
  const acceptedCommit = commit(repo, acceptedTree, repo.base.baseCommit, request.proofId, request.proofTimestamp, false, env);
  const rollbackCommit = commit(repo, repo.base.baseTree, acceptedCommit, request.proofId, request.proofTimestamp, true, env);
  return { acceptedCommit, acceptedTree, rollbackCommit };
}

function verifyCommits(repo: Repository, plan: LocalLandingPlan): void {
  const time = validateProofIdentity(plan.proofId, plan.proofTimestamp);
  const expected = (tree: string, parent: string, rollback: boolean) =>
    `tree ${tree}\nparent ${parent}\nauthor ${commitName} <${commitEmail}> ${time} +0000\n` +
    `committer ${commitName} <${commitEmail}> ${time} +0000\n\n${message(plan.proofId, rollback)}`;
  [plan.acceptedTree, plan.acceptedCommit, plan.rollbackCommit].forEach((oid) => requireObject(oid, repo.oidLength));
  requireCondition(plan.acceptedTree !== repo.base.baseTree &&
    decoded(repo.read(['cat-file', 'commit', plan.acceptedCommit])) === expected(plan.acceptedTree, repo.base.baseCommit, false) &&
    decoded(repo.read(['cat-file', 'commit', plan.rollbackCommit])) === expected(repo.base.baseTree, plan.acceptedCommit, true),
  'GIT_LANDING_COMMIT_MISMATCH', 'Git could not verify the exact accepted and reverse commit trees and parentage.');
}

function branchHead(repo: Repository, ref: string): string | null {
  const symbolic = repo.run(['symbolic-ref', '--quiet', '--no-recurse', ref]);
  requireCondition(symbolic.status === 1, 'GIT_LANDING_REF_DIVERGED', 'The accepted branch cannot be a symbolic Git reference.');
  const exists = repo.run(['show-ref', '--exists', ref]);
  if (exists.status === 2) return null;
  requireCondition(exists.status === 0, 'GIT_LANDING_REF_DIVERGED', 'The accepted ref could not be verified.');
  return requireObject(decoded(repo.read(['show-ref', '--verify', '--hash', ref])).trim(), repo.oidLength);
}

function requireInactive(repo: Repository, ref: string): void {
  const worktrees = splitNul(repo.read(['worktree', 'list', '--porcelain', '-z']));
  requireCondition(worktrees.some((line) => line.startsWith('worktree ')) &&
    !worktrees.some((line) => line.startsWith('branch ') && line.slice('branch '.length).toLowerCase() === ref.toLowerCase()),
    'GIT_LANDING_REF_CHECKED_OUT', 'The accepted branch must not be checked out in any worktree.');
  for (const parts of [ref.split('/'), ['logs', ...ref.split('/')]]) {
    for (const [index, component] of parts.entries()) {
      const physical = join(repo.gitDir, ...parts.slice(0, index), component);
      const stat = lstatSync(physical, { throwIfNoEntry: false });
      const isLeaf = index === parts.length - 1;
      requireCondition(stat === undefined || exactPath(physical, isLeaf ? 'file' : 'directory'),
        'GIT_LANDING_REF_PATH_UNVERIFIED', 'The accepted branch has a non-regular ref or reflog path.');
    }
  }
}

function requireLocalObjects(repo: Repository): void {
  requireCondition(readdirSync(repo.objects).every((name) => exactPath(join(repo.objects, name), 'directory')),
    'GIT_LANDING_REPOSITORY_UNSUPPORTED', 'Git object storage contains a redirected or non-directory entry.');
}

function verifyPlanRef(plan: LocalLandingPlan): void {
  requireCondition(plan.targetRef.startsWith('refs/heads/') &&
    plan.targetRef === headRef(plan.targetRef.slice('refs/heads/'.length)) &&
    plan.landingRef.startsWith('refs/heads/') &&
    plan.landingRef === landingRef(plan.landingRef.slice('refs/heads/'.length), plan.landingBranchPrefix, plan.targetRef),
  'GIT_LANDING_REF_INVALID', 'The receipt does not bind a permitted local landing ref.');
}

function observation(repo: Repository, plan: LocalLandingPlan): LocalLandingObservation {
  const landingCommit = branchHead(repo, plan.landingRef);
  let state: LocalLandingState = 'diverged';
  if (landingCommit === null) state = 'not_applied';
  if (landingCommit === plan.acceptedCommit) state = 'applied';
  if (landingCommit === plan.rollbackCommit) state = 'rolled_back';
  return { state, landingCommit, targetCommit: repo.base.baseCommit };
}

export function prepareLocalLanding(request: LocalLandingRequest): LocalLandingPlan {
  const targetRef = headRef(request.targetBranch);
  const acceptedRef = landingRef(request.landingBranch, request.landingBranchPrefix, targetRef);
  validateProofIdentity(request.proofId, request.proofTimestamp);
  const repo = openRepository(request.repositoryRoot, targetRef, request);
  requireInactive(repo, acceptedRef);
  const operations = validateOperations(repo, request.operations);
  const temporary = realpathSync.native(tmpdir());
  requireCondition(!containsPath(repo.root, temporary), 'GIT_LANDING_TEMP_PATH_UNVERIFIED',
    'Git landing requires private temporary storage outside the target checkout.');
  const work = mkdtempSync(join(temporary, 'clue-landing-'));
  try {
    const objectPath = join(work, 'objects');
    // Git accepts one C-style quoted alternate path, including platform path separators.
    const alternate = JSON.stringify(repo.objects);
    const indexPath = join(work, 'index');
    const quarantine = {
      GIT_INDEX_FILE: indexPath, GIT_OBJECT_DIRECTORY: objectPath, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate,
    };
    // Avoid Git init in the quarantine because a repository template may contain hooks.
    mkdirSync(objectPath, { mode: 0o700 });
    const staged = buildObjects(repo, request, operations, quarantine);
    const plan: LocalLandingPlan = {
      repositoryRoot: repo.root, targetRef, landingRef: acceptedRef, landingBranchPrefix: request.landingBranchPrefix,
      baseCommit: repo.base.baseCommit, baseTree: repo.base.baseTree, proofId: request.proofId,
      proofTimestamp: request.proofTimestamp, ...staged,
    };
    const state = observation(repo, plan).state;
    requireCondition(state !== 'diverged', 'GIT_LANDING_REF_DIVERGED', 'The accepted branch already belongs to different history.');
    if (state === 'not_applied') {
      requireLocalObjects(repo);
      const actual = buildObjects(repo, request, operations, { GIT_INDEX_FILE: join(work, 'approved-index') });
      requireCondition(actual.acceptedTree === plan.acceptedTree && actual.acceptedCommit === plan.acceptedCommit &&
        actual.rollbackCommit === plan.rollbackCommit, 'GIT_LANDING_TREE_MISMATCH',
      'Git did not reproduce the verified accepted tree and reverse commit.');
    }
    verifyCommits(repo, plan);
    return plan;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function inspectLocalLanding(plan: LocalLandingPlan): LocalLandingObservation {
  verifyPlanRef(plan);
  const repo = openRepository(plan.repositoryRoot, plan.targetRef, plan);
  requireInactive(repo, plan.landingRef);
  verifyCommits(repo, plan);
  return observation(repo, plan);
}

export function verifyLocalLanding(plan: LocalLandingPlan, expectedState: LocalLandingState): LocalLandingObservation {
  const actual = inspectLocalLanding(plan);
  requireCondition(actual.state === expectedState, 'GIT_LANDING_REF_STATE_MISMATCH', 'Git did not reproduce the expected landing state.');
  return actual;
}

function transition(plan: LocalLandingPlan, base: LocalLandingState, result: LocalLandingState): LocalLandingObservation {
  verifyPlanRef(plan);
  const repo = openRepository(plan.repositoryRoot, plan.targetRef, plan);
  requireInactive(repo, plan.landingRef);
  verifyCommits(repo, plan);
  const current = observation(repo, plan);
  if (current.state === result) return current;
  requireCondition(current.state === base, 'GIT_LANDING_REF_STATE_MISMATCH',
    'The accepted branch changed or the requested landing transition is no longer current.');
  const update = result === 'applied'
    ? `create ${plan.landingRef} ${plan.acceptedCommit}`
    : `update ${plan.landingRef} ${plan.rollbackCommit} ${plan.acceptedCommit}`;
  const transaction = `start\nverify ${plan.targetRef} ${plan.baseCommit}\n${update}\nprepare\ncommit\n`;
  const changed = repo.run(['update-ref', '--no-deref', '-m', `CLU-E ${result} ${plan.proofId}`, '--stdin'], transaction);
  requireCondition(changed.status === 0, 'GIT_LANDING_REF_STATE_MISMATCH', 'Git compare-and-swap refused the landing transition.');
  return verifyLocalLanding(plan, result);
}

export function applyLocalLanding(plan: LocalLandingPlan): LocalLandingObservation {
  return transition(plan, 'not_applied', 'applied');
}

export function revertLocalLanding(plan: LocalLandingPlan): LocalLandingObservation {
  return transition(plan, 'applied', 'rolled_back');
}
