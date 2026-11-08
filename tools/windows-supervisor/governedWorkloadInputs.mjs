import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

const maxFiles = 2048;
const maxFileBytes = 8 * 1024 * 1024;
const maxTreeBytes = 64 * 1024 * 1024;
const safePart = /^[A-Za-z0-9_. ()-]+$/u;
const device = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const omittedDirectories = new Set([
  '.git', '.idea', '.vscode', 'chrome-profile', 'coverage', 'dist', 'node_modules', 'release',
  'release-evidence', 'shadow', 'workspace',
]);
const omittedNames = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.npmrc', '.netrc', '_netrc', 'id_rsa', 'id_ed25519']);
const generatedNames = new Set(['dist', 'node_modules']);
const benchmarkPath = 'targets/clu/benchmark/master-benchmark.md';
const cliPath = 'dist/src/cli/index.js';
const addonPath = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(parent, child) {
  const delta = relative(parent, child);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith('..' + sep));
}

function physicalDirectory(path) {
  return isAbsolute(path) && lstatSync(path).isDirectory() && relative(path, realpathSync.native(path)) === '';
}

function findGit(root) {
  const windows = process.platform === 'win32';
  const programFiles = [process.env.ProgramW6432, process.env.ProgramFiles].filter(Boolean);
  const defaults = windows ? programFiles.map((base) => join(base, 'Git', 'cmd')) : ['/usr/bin', '/usr/local/bin'];
  for (const dir of [...defaults, ...(process.env.PATH ?? '').split(delimiter)]) {
    if (!isAbsolute(dir)) continue;
    try {
      const path = join(dir, windows ? 'git.exe' : 'git');
      if (lstatSync(path).isFile() && relative(path, realpathSync.native(path)) === '' && !inside(root, path)) return path;
    } catch { /* Check the next installed location. */ }
  }
  throw new Error('GOVERNED_GIT_UNAVAILABLE');
}

function runGit(git, root, args, input) {
  const env = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  };
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  try {
    return execFileSync(git, ['--no-pager', '--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root, env, input, windowsHide: true, timeout: 30_000, maxBuffer: maxTreeBytes + maxFiles * 256,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('GOVERNED_GIT_QUERY_FAILED');
  }
}

function validatePath(path, identities) {
  const parts = path.split('/');
  if (path.length > 240 || parts.some((part) => !safePart.test(part) || part === '.' || part === '..' ||
      /^[ ]|[. ]$/u.test(part) || device.test(part))) throw new Error('GOVERNED_SOURCE_PATH_UNSAFE');
  for (let index = 1; index <= parts.length; index++) {
    const prefix = parts.slice(0, index).join('/');
    const key = prefix.toLowerCase();
    if (identities.has(key) && identities.get(key) !== prefix) throw new Error('GOVERNED_SOURCE_CASE_COLLISION');
    identities.set(key, prefix);
  }
  return parts;
}

function omitted(path, parts) {
  const name = parts.at(-1).toLowerCase();
  return parts.slice(0, -1).some((part) => omittedDirectories.has(part.toLowerCase())) ||
    omittedNames.has(name) || /^\.env(?:\.|$)/u.test(name) ||
    /\.(?:tsbuildinfo|node|pem|key|p12|pfx|jks|keystore|db(?:-wal|-shm)?|sqlite3?(?:-wal|-shm)?|log|zip|tgz)$/u.test(name) ||
    path.toLowerCase() === 'config/project-profiles.yaml' || /^config\/backups\//iu.test(path);
}

function listTree(bytes, head) {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\0') || !Buffer.from(text).equals(bytes)) throw new Error('GOVERNED_TREE_UNVERIFIED');
  const identities = new Map();
  const files = new Map();
  const rows = text.slice(0, -1).split('\0');
  if (rows.length > maxFiles) throw new Error('GOVERNED_TREE_TOO_LARGE');
  for (const row of rows) {
    const entry = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\r\n]+)$/u.exec(row);
    if (!entry || entry[3].length !== head.length) throw new Error('GOVERNED_TREE_UNVERIFIED');
    const [, mode, type, id, path] = entry;
    const parts = validatePath(path, identities);
    if (omitted(path, parts)) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || files.has(path)) throw new Error('GOVERNED_SOURCE_NOT_REGULAR');
    files.set(path, id);
  }
  return files;
}

function readBlobs(git, root, files) {
  const batch = [...files.values()].join('\n') + '\n';
  const data = runGit(git, root, ['cat-file', '--batch'], batch);
  const result = new Map();
  let offset = 0;
  let total = 0;
  for (const [path, oid] of files) {
    const newline = data.indexOf(10, offset);
    const prefix = oid + ' blob ';
    if (newline < offset || newline - offset > prefix.length + 9) throw new Error('GOVERNED_BLOB_UNVERIFIED');
    const header = data.toString('ascii', offset, newline);
    const sizeText = header.slice(prefix.length);
    if (!header.startsWith(prefix) || !/^(?:0|[1-9][0-9]{0,8})$/u.test(sizeText)) throw new Error('GOVERNED_BLOB_UNVERIFIED');
    const size = Number(sizeText);
    const end = newline + 1 + size;
    total += size;
    if (size > maxFileBytes || total > maxTreeBytes || data[end] !== 10) throw new Error('GOVERNED_BLOB_UNVERIFIED');
    result.set(path, data.subarray(newline + 1, end));
    offset = end + 1;
  }
  if (offset !== data.length) throw new Error('GOVERNED_BLOB_UNVERIFIED');
  return result;
}

function lockedPackage(blobs) {
  let manifest;
  let lock;
  try {
    manifest = JSON.parse(blobs.get('package.json'));
    lock = JSON.parse(blobs.get('package-lock.json'));
  } catch {
    throw new Error('GOVERNED_LOCK_UNVERIFIED');
  }
  const root = lock?.packages?.[''];
  const sqlite = lock?.packages?.['node_modules/better-sqlite3'];
  if (manifest?.name !== 'clue' || lock?.name !== manifest.name || lock?.version !== manifest.version ||
      root?.name !== manifest.name || root?.version !== manifest.version || lock.lockfileVersion !== 3 ||
      typeof manifest.scripts?.typecheck !== 'string' || typeof manifest.scripts?.build !== 'string' ||
      ![benchmarkPath, 'tsconfig.json', 'config/clue.config.yaml', 'targets/clu/profile.yaml'].every((path) => blobs.get(path)?.length > 0) ||
      !/^\d+\.\d+\.\d+$/u.test(sqlite?.version ?? '') || !/^sha512-[A-Za-z0-9+/=]+$/u.test(sqlite?.integrity ?? '')) {
    throw new Error('GOVERNED_LOCK_UNVERIFIED');
  }
  const benchmark = blobs.get(benchmarkPath);
  const lines = benchmark.toString('utf8').split(/\r?\n/u);
  const scenario = lines.findIndex((line) => /^(?:\|[ \t]*`SCN-005`[ \t]*\||(?:\*\*|#{2,6}[ \t]+)`?SCN-005`?(?=[ \t:.—-]))/u.test(line));
  if (scenario === -1 || !lines.slice(scenario, scenario + 4).some((line) => /`clue doctor --deep`/u.test(line))) {
    throw new Error('GOVERNED_BENCHMARK_SCENARIO_UNVERIFIED');
  }
  return {
    packageSha256: sha256(blobs.get('package.json')), lockSha256: sha256(blobs.get('package-lock.json')),
    benchmarkSha256: sha256(benchmark), benchmarkScenario: 'SCN-005', sqliteVersion: sqlite.version, sqliteIntegrity: sqlite.integrity,
  };
}

function writeTree(root, blobs) {
  for (const [path, bytes] of blobs) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    if (!physicalDirectory(dirname(file))) throw new Error('GOVERNED_STAGE_UNSAFE');
    writeFileSync(file, bytes, { flag: 'wx' });
  }
}

export function verifyGovernedSource(root, expected, { allowBuildOutputs = false } = {}) {
  const pending = [root];
  const seen = new Set();
  const expectedDirectories = new Set();
  for (const file of expected.keys()) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  let visited = 0;
  try {
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!physicalDirectory(directory)) return false;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++visited > maxFiles * 4) return false;
        const path = join(directory, entry.name);
        const key = relative(root, path).split(sep).join('/');
        if (allowBuildOutputs && directory === root && generatedNames.has(entry.name) && entry.isDirectory() && physicalDirectory(path)) continue;
        if (entry.isDirectory()) {
          if (!expectedDirectories.has(key)) return false;
          pending.push(path);
          continue;
        }
        const stats = lstatSync(path);
        const expectedFile = expected.get(key);
        if (!expectedFile || seen.has(key) || !entry.isFile() || !stats.isFile() || stats.nlink !== 1 ||
            stats.size !== expectedFile.size || relative(path, realpathSync.native(path)) !== '' ||
            sha256(readFileSync(path)) !== expectedFile.sha256) return false;
        seen.add(key);
      }
    }
    return seen.size === expected.size;
  } catch {
    return false;
  }
}

/** Hash the installed dependency and build trees without following links. */
export function inspectGovernedBuild(root) {
  const pending = [...generatedNames].map((name) => join(root, name));
  const records = new Map();
  let total = 0;
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!physicalDirectory(directory)) throw new Error('GOVERNED_BUILD_PATH_UNSAFE');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 30_000) throw new Error('GOVERNED_BUILD_TOO_LARGE');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      const stats = lstatSync(path);
      total += stats.size;
      if (!entry.isFile() || !stats.isFile() || stats.nlink !== 1 || relative(path, realpathSync.native(path)) !== '') {
        throw new Error('GOVERNED_BUILD_PATH_UNSAFE');
      }
      if (stats.size > 64 * 1024 * 1024 || total > 512 * 1024 * 1024) throw new Error('GOVERNED_BUILD_TOO_LARGE');
      const bytes = readFileSync(path);
      if (bytes.length !== stats.size) throw new Error('GOVERNED_BUILD_CHANGED');
      records.set(relative(root, path).split(sep).join('/'), { size: bytes.length, sha256: sha256(bytes) });
    }
  }
  const cli = records.get(cliPath);
  const addon = records.get(addonPath);
  if (!cli?.size || !addon?.size) throw new Error('GOVERNED_BUILD_OUTPUT_REQUIRED');
  const ordered = [...records].sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1);
  const buildInfoPath = 'dist/.tsbuildinfo';
  return {
    treeSha256: sha256(JSON.stringify(ordered)),
    protectedTreeSha256: sha256(JSON.stringify(ordered.filter(([path]) => path !== buildInfoPath))),
    buildInfoSha256: records.get(buildInfoPath)?.sha256 ?? null,
    fileCount: records.size, totalBytes: total, cliSha256: cli.sha256, nativeAddonSha256: addon.sha256,
  };
}

/** Materialize the selected committed source bytes in distinct disposable checkouts. */
export function stageGovernedSource(repoRoot, roots) {
  if (!physicalDirectory(repoRoot) || roots.length < 1 || roots.some((root, index) =>
    !physicalDirectory(root) || readdirSync(root).length !== 0 || inside(repoRoot, root) || inside(root, repoRoot) ||
    roots.slice(index + 1).some((other) => inside(root, other) || inside(other, root)))) throw new Error('GOVERNED_STAGE_UNSAFE');
  const git = findGit(repoRoot);
  const top = runGit(git, repoRoot, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  if (!isAbsolute(top) || relative(repoRoot, realpathSync.native(top)) !== '') throw new Error('GOVERNED_GIT_ROOT_UNVERIFIED');
  const readHead = () => runGit(git, repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim();
  const head = readHead();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) throw new Error('GOVERNED_GIT_HEAD_UNVERIFIED');
  const files = listTree(runGit(git, repoRoot, ['ls-tree', '-r', '-z', '--full-tree', head]), head);
  const blobs = readBlobs(git, repoRoot, files);
  const packageInfo = lockedPackage(blobs);
  const expected = new Map([...blobs].map(([path, bytes]) => [path, { size: bytes.length, sha256: sha256(bytes) }]));
  for (const root of roots) writeTree(root, blobs);
  if (readHead() !== head || !roots.every((root) => verifyGovernedSource(root, expected))) throw new Error('GOVERNED_SOURCE_CHANGED');
  return { head, scopeSha256: sha256(JSON.stringify([...expected])), ...packageInfo, expected };
}
