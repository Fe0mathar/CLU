import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';

const DASHBOARD = 'ui/clue-dashboard';
const HTML = DASHBOARD + '/index.html';
const APP = DASHBOARD + '/app.js';
const TEST = /^ui\/clue-dashboard\/test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/u;
const SAFE_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SCOPE_BYTES = 32 * 1024 * 1024;

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

function runGit(git, root, args) {
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
      cwd: root, env, windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
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

function readLocalFile(root, path, remaining) {
  const file = join(root, path);
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || relative(file, realpathSync.native(file)) !== '') {
      throw new Error('HOST_TEST_SCOPE_FILE_UNSAFE');
    }
    if (before.size > MAX_FILE_BYTES || before.size > remaining) throw new Error('HOST_TEST_SCOPE_TOO_LARGE');

    const fd = openSync(file, 'r');
    try {
      const sameFile = () => {
        const stat = fstatSync(fd);
        return stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
          stat.nlink === before.nlink && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
      };
      if (!sameFile()) throw new Error('HOST_TEST_SCOPE_CHANGED_DURING_READ');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) throw new Error('HOST_TEST_SCOPE_CHANGED_DURING_READ');
        offset += count;
      }
      if (!sameFile()) throw new Error('HOST_TEST_SCOPE_CHANGED_DURING_READ');
      return bytes;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof Error && /^HOST_TEST_[A-Z_]+$/u.test(error.message)) throw error;
    throw new Error('HOST_TEST_SCOPE_FILE_UNAVAILABLE');
  }
}

/** Capture committed dashboard input paths and their exact local bytes, including existing edits. */
export function captureDashboardTestInputs(repoRoot) {
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

  const digests = new Map();
  let remaining = MAX_SCOPE_BYTES;
  for (const path of committed) {
    const bytes = readLocalFile(root, path, remaining);
    remaining -= bytes.length;
    digests.set(path, createHash('sha256').update(bytes).digest('hex'));
  }
  const dirty = runGit(git, root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']) !== '';
  return {
    head, dirty, trackedTestPaths,
    scopeSha256: createHash('sha256').update(JSON.stringify([...digests])).digest('hex'),
    htmlSha256: digests.get(HTML),
    appSha256: digests.get(APP),
    fileCount: committed.length,
  };
}
