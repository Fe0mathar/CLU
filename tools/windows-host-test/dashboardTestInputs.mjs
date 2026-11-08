import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, realpathSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

const DASHBOARD = 'ui/clue-dashboard';
const HTML = DASHBOARD + '/index.html';
const APP = DASHBOARD + '/app.js';
const TEST = /^ui\/clue-dashboard\/test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/u;
const SAFE_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SCOPE_BYTES = 32 * 1024 * 1024;
const exactStats = { bigint: true };

function inside(root, file) {
  const delta = relative(root, file);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith('..' + sep));
}

function gitExecutable(root) {
  const windows = process.platform === 'win32';
  const name = windows ? 'git.exe' : 'git';
  const programs = [process.env.ProgramW6432, process.env.ProgramFiles].filter(Boolean);
  const directories = windows
    ? programs.map((path) => join(path, 'Git', 'cmd'))
    : ['/usr/bin', '/usr/local/bin'];
  for (const dir of [...directories, ...(process.env.PATH ?? '').split(delimiter)]) {
    if (!isAbsolute(dir)) continue;
    try {
      const candidate = join(dir, name);
      const physical = realpathSync.native(candidate);
      const stats = lstatSync(candidate);
      if (stats.isFile() && relative(candidate, physical) === '' && !inside(root, physical)) return physical;
    } catch { /* Check the next installed location. */ }
  }
  throw new Error('HOST_TEST_GIT_UNAVAILABLE');
}

function runGit(git, root, args, batchInput) {
  const env = {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  try {
    return execFileSync(git, [
      '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args,
    ], {
      cwd: root, env, windowsHide: true, timeout: 8000,
      ...(batchInput === undefined
        ? { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
        : { input: batchInput, maxBuffer: MAX_SCOPE_BYTES + MAX_FILES * 128, stdio: ['pipe', 'pipe', 'pipe'] }),
    });
  } catch {
    throw new Error('HOST_TEST_GIT_QUERY_FAILED');
  }
}

function listPaths(bytes) {
  if (bytes === '') return [];
  if (!bytes.endsWith('\0')) throw new Error('HOST_TEST_SCOPE_PATHS_INVALID');
  const paths = bytes.slice(0, -1).split('\0');
  const seen = new Set();
  if (paths.length > MAX_FILES) throw new Error('HOST_TEST_SCOPE_TOO_LARGE');
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key) || (path !== 'package.json' && !path.startsWith(DASHBOARD + '/')) ||
        path.split('/').some((part) => !SAFE_COMPONENT.test(part) || DEVICE.test(part) || part.endsWith('.'))) {
      throw new Error('HOST_TEST_SCOPE_PATHS_INVALID');
    }
    seen.add(key);
  }
  return paths.sort();
}

function sameFileMetadata(before, after) {
  return after.isFile() && after.nlink === 1n && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function readLocalFile(root, path, remaining) {
  const file = join(root, path);
  try {
    const before = lstatSync(file, exactStats);
    const isCanonical = () => relative(file, realpathSync.native(file)) === '';
    if (!before.isFile() || before.nlink !== 1n || !isCanonical()) {
      throw new Error('HOST_TEST_SCOPE_FILE_UNSAFE');
    }
    if (before.size > BigInt(Math.min(MAX_FILE_BYTES, remaining))) throw new Error('HOST_TEST_SCOPE_TOO_LARGE');

    const fd = openSync(file, 'r');
    try {
      // Older Windows libuv can report different device IDs for path and handle stats.
      // Compare each kind with itself, and verify the path's final opened handle below.
      const opened = fstatSync(fd, exactStats);
      const pathUnchanged = () => isCanonical() && sameFileMetadata(before, lstatSync(file, exactStats));
      if (!opened.isFile() || opened.nlink !== 1n || opened.size !== before.size || !pathUnchanged()) {
        throw new Error('HOST_TEST_SCOPE_CHANGED_DURING_READ');
      }
      const bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) throw new Error('HOST_TEST_SCOPE_CHANGED_DURING_READ');
        offset += count;
      }
      if (!pathUnchanged()) throw new Error('HOST_TEST_SCOPE_CHANGED_DURING_READ');
      const finalFd = openSync(file, 'r');
      try {
        if (!sameFileMetadata(opened, fstatSync(finalFd, exactStats)) ||
            !sameFileMetadata(opened, fstatSync(fd, exactStats)) || !pathUnchanged()) {
          throw new Error('HOST_TEST_SCOPE_CHANGED_DURING_READ');
        }
      } finally {
        closeSync(finalFd);
      }
      return bytes;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof Error && /^HOST_TEST_[A-Z_]+$/u.test(error.message)) throw error;
    throw new Error('HOST_TEST_SCOPE_FILE_UNAVAILABLE');
  }
}

function resolveDashboardScope(repoRoot) {
  let root;
  try {
    root = realpathSync.native(repoRoot);
  } catch {
    throw new Error('HOST_TEST_ROOT_UNVERIFIED');
  }
  const git = gitExecutable(root);
  try {
    const top = runGit(git, root, ['rev-parse', '--show-toplevel']).trim();
    if (relative(root, realpathSync.native(top)) !== '') throw new Error();
  } catch {
    throw new Error('HOST_TEST_ROOT_UNVERIFIED');
  }
  const head = runGit(git, root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) throw new Error('HOST_TEST_HEAD_UNVERIFIED');

  const scope = ['--', 'package.json', DASHBOARD];
  const committed = listPaths(runGit(git, root, ['ls-tree', '-r', '-z', '--name-only', head, ...scope]));
  // Include ignored paths in this scope check. Existing dashboard code can import local additions.
  const working = listPaths(runGit(git, root, ['ls-files', '-z', '--cached', '--others', ...scope]));
  if (committed.length !== working.length || committed.some((name, index) => name !== working[index])) {
    throw new Error('HOST_TEST_SCOPE_HAS_UNAPPROVED_PATHS');
  }
  const trackedTestPaths = committed.filter((path) => TEST.test(path));
  if (trackedTestPaths.length === 0 || ![HTML, APP, 'package.json'].every((path) => committed.includes(path))) {
    throw new Error('HOST_TEST_SCOPE_INCOMPLETE');
  }
  return { root, git, head, committed, trackedTestPaths };
}

function scopeFingerprint(digests) {
  return createHash('sha256').update(JSON.stringify([...digests])).digest('hex');
}

function captureScope({ root, git, head, committed, trackedTestPaths }, onFile) {
  const digests = new Map();
  let remaining = MAX_SCOPE_BYTES;
  for (const path of committed) {
    const bytes = readLocalFile(root, path, remaining);
    remaining -= bytes.length;
    digests.set(path, createHash('sha256').update(bytes).digest('hex'));
    onFile?.(path, bytes);
  }
  const dirty = runGit(git, root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']) !== '';
  return {
    head, dirty, trackedTestPaths,
    scopeSha256: scopeFingerprint(digests),
    htmlSha256: digests.get(HTML),
    appSha256: digests.get(APP),
    fileCount: committed.length,
  };
}

/** Capture committed dashboard input paths and their exact local bytes, including existing edits. */
export function captureDashboardTestInputs(repoRoot) {
  return captureScope(resolveDashboardScope(repoRoot));
}

function requirePhysicalDirectory(path) {
  if (!isAbsolute(path) || !lstatSync(path).isDirectory() || relative(path, realpathSync.native(path)) !== '') {
    throw new Error('HOST_TEST_COMPARISON_ROOT_UNSAFE');
  }
}

function requireEmptyDirectory(path) {
  requirePhysicalDirectory(path);
  const directory = opendirSync(path);
  try {
    if (directory.readSync() !== null) throw new Error('HOST_TEST_COMPARISON_ROOT_NOT_EMPTY');
  } finally {
    directory.closeSync();
  }
}

function readCommittedFiles({ git, root, head, committed }) {
  const tree = runGit(git, root, ['--no-replace-objects', 'ls-tree', '-r', '-z', head, '--', 'package.json', DASHBOARD]);
  const ids = new Map();
  if (!tree.endsWith('\0')) throw new Error('HOST_TEST_COMPARISON_TREE_INVALID');
  for (const row of tree.slice(0, -1).split('\0')) {
    const record = /^100(?:644|755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\n\r\t]+)$/u.exec(row);
    if (record === null || record[1].length !== head.length || ids.has(record[2])) {
      throw new Error('HOST_TEST_COMPARISON_TREE_INVALID');
    }
    ids.set(record[2], record[1]);
  }
  if (ids.size !== committed.length || committed.some((path) => !ids.has(path))) {
    throw new Error('HOST_TEST_COMPARISON_TREE_INVALID');
  }

  const bytes = runGit(git, root, ['--no-replace-objects', 'cat-file', '--batch'],
    committed.map((path) => ids.get(path) + '\n').join(''));
  const files = new Map();
  let offset = 0;
  let remaining = MAX_SCOPE_BYTES;
  for (const path of committed) {
    const lineEnd = bytes.indexOf(10, offset);
    const id = ids.get(path);
    const header = id + ' blob ';
    if (lineEnd < offset || lineEnd - offset > header.length + 9) {
      throw new Error('HOST_TEST_COMPARISON_BLOB_INVALID');
    }
    const line = bytes.toString('ascii', offset, lineEnd);
    const sizeText = line.slice(header.length);
    if (!line.startsWith(header) || !/^(?:0|[1-9][0-9]{0,8})$/u.test(sizeText)) {
      throw new Error('HOST_TEST_COMPARISON_BLOB_INVALID');
    }
    const size = Number(sizeText);
    const end = lineEnd + 1 + size;
    if (size > Math.min(MAX_FILE_BYTES, remaining) || bytes[end] !== 10) {
      throw new Error('HOST_TEST_COMPARISON_BLOB_INVALID');
    }
    files.set(path, bytes.subarray(lineEnd + 1, end));
    remaining -= size;
    offset = end + 1;
  }
  if (offset !== bytes.length) throw new Error('HOST_TEST_COMPARISON_BLOB_INVALID');
  return files;
}

function writeSnapshot(root, files) {
  requireEmptyDirectory(root);
  for (const [path, bytes] of files) {
    const components = path.split('/');
    const name = components.pop();
    let parent = root;
    for (const component of components) {
      requirePhysicalDirectory(parent);
      parent = join(parent, component);
      if (lstatSync(parent, { throwIfNoEntry: false }) === undefined) mkdirSync(parent);
    }
    requirePhysicalDirectory(parent);
    writeFileSync(join(parent, name), bytes, { flag: 'wx' });
  }
}

function snapshotPaths(root) {
  const files = [];
  const directories = [{ path: root, prefix: '' }];
  let visited = 0;
  while (directories.length > 0) {
    const { path, prefix } = directories.pop();
    requirePhysicalDirectory(path);
    const directory = opendirSync(path);
    try {
      let entry = directory.readSync();
      if (entry === null) throw new Error('HOST_TEST_COMPARISON_SNAPSHOT_UNSAFE');
      while (entry !== null) {
        if (++visited > MAX_FILES * 2) throw new Error('HOST_TEST_SCOPE_TOO_LARGE');
        const name = entry.name;
        if (!SAFE_COMPONENT.test(name) || DEVICE.test(name) || name.endsWith('.')) {
          throw new Error('HOST_TEST_COMPARISON_SNAPSHOT_UNSAFE');
        }
        const scoped = prefix + name;
        if (entry.isDirectory() && (scoped === 'ui' || scoped === DASHBOARD || scoped.startsWith(DASHBOARD + '/'))) {
          directories.push({ path: join(path, name), prefix: scoped + '/' });
        } else if (entry.isFile() && (scoped === 'package.json' || scoped.startsWith(DASHBOARD + '/'))) {
          files.push(scoped);
        } else {
          throw new Error('HOST_TEST_COMPARISON_SNAPSHOT_UNSAFE');
        }
        entry = directory.readSync();
      }
    } finally {
      directory.closeSync();
    }
  }
  return listPaths(files.join('\0') + '\0');
}

function comparisonError(error) {
  if (error instanceof Error && /^HOST_TEST_[A-Z_]+$/u.test(error.message)) return error;
  return new Error('HOST_TEST_COMPARISON_SNAPSHOT_UNAVAILABLE');
}

/** Verify the full materialized scope by file count and exact byte fingerprint. */
export function verifyDashboardComparisonSnapshot(root, expectedSha256, expectedFileCount) {
  try {
    const paths = snapshotPaths(root);
    if (paths.length !== expectedFileCount) return false;
    const digests = new Map();
    let remaining = MAX_SCOPE_BYTES;
    for (const path of paths) {
      const bytes = readLocalFile(root, path, remaining);
      remaining -= bytes.length;
      digests.set(path, createHash('sha256').update(bytes).digest('hex'));
    }
    if (scopeFingerprint(digests) !== expectedSha256) return false;
    const finalPaths = snapshotPaths(root);
    return finalPaths.length === paths.length && paths.every((path, index) => path === finalPaths[index]);
  } catch (error) {
    throw comparisonError(error);
  }
}

/** Stage the same approved dashboard paths from committed HEAD and the current working files. */
export function prepareDashboardComparisonInputs(repoRoot, baselineRoot, candidateRoot) {
  try {
    const scope = resolveDashboardScope(repoRoot);
    for (const destination of [baselineRoot, candidateRoot]) {
      requireEmptyDirectory(destination);
      if (inside(scope.root, destination) || inside(destination, scope.root)) {
        throw new Error('HOST_TEST_COMPARISON_ROOT_UNSAFE');
      }
    }
    if (inside(baselineRoot, candidateRoot) || inside(candidateRoot, baselineRoot) ||
        relative(dirname(baselineRoot), dirname(candidateRoot)) !== '') {
      throw new Error('HOST_TEST_COMPARISON_ROOT_UNSAFE');
    }

    const baseline = readCommittedFiles(scope);
    const candidate = new Map();
    const captured = captureScope(scope, (path, bytes) => candidate.set(path, bytes));
    const changedPaths = scope.committed.filter((path) => !baseline.get(path).equals(candidate.get(path)));
    if (changedPaths.some((path) => path === 'package.json' || path.startsWith(DASHBOARD + '/test/'))) {
      throw new Error('HOST_TEST_COMPARISON_TEST_SCOPE_CHANGED');
    }

    const baselineSha256 = scopeFingerprint([...baseline].map(([path, bytes]) =>
      [path, createHash('sha256').update(bytes).digest('hex')]));
    const candidateSha256 = captured.scopeSha256;
    writeSnapshot(baselineRoot, baseline);
    writeSnapshot(candidateRoot, candidate);
    const current = captureDashboardTestInputs(repoRoot);
    if (current.head !== captured.head || current.scopeSha256 !== candidateSha256 ||
        !verifyDashboardComparisonSnapshot(baselineRoot, baselineSha256, captured.fileCount) ||
        !verifyDashboardComparisonSnapshot(candidateRoot, candidateSha256, captured.fileCount)) {
      throw new Error('HOST_TEST_COMPARISON_SOURCE_CHANGED');
    }
    return {
      head: captured.head, dirty: captured.dirty, baselineSha256, candidateSha256,
      trackedTestPaths: captured.trackedTestPaths, fileCount: captured.fileCount, changedPaths,
    };
  } catch (error) {
    throw comparisonError(error);
  }
}
