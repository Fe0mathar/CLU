import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = join(dirname(root), 'release-evidence');
const defaultManifest = existsSync(join(root, 'CLU-E-P03-Manifest.json'))
  ? 'CLU-E-P03-Manifest.json' : 'CLU-E-P02B-Manifest.json';
const checks = {
  'dashboard-p02b': [
    'clue-dashboard-server-authority', 'dashboard-cycle-progress', 'resume-planner', 'cycle-closure',
    'clue-agent', 'release-packaging',
  ],
  'native-proof-p03': [
    'p03-native-proof-pilot', 'proof-cli', 'proof-verdict-protocol',
    'proof-cycle-project-isolation', 'windows-verification-tools', 'release-packaging',
  ],
};
const pendingWindowsChecks = {
  'dashboard-p02b': [
    'Live Windows P02 cycle interruption and recovery',
    'Live Windows A to B to A profile isolation',
    'Live dashboard operator review and real CLUE brain test',
  ],
  'native-proof-p03': ['Native Windows frozen-contract proof pilot and durable verdict'],
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isCommit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function need(condition, code, message) {
  if (!condition) throw new GateError(code, message);
}

function safePath(value) {
  return typeof value === 'string' && value.length <= 240 && value.split('/').every((part) =>
    /^[a-z0-9][a-z0-9._ -]*[a-z0-9_-]$/i.test(part) || /^[a-z0-9]$/i.test(part)
  ) && value.split('/').every((part) =>
    !/^(?:node_modules|dist|workspace|release-evidence)$/i.test(part) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)
  );
}

function fileAt(directory, path, missingAllowed = false) {
  const parts = path.split('/');
  let cursor = directory;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (missingAllowed && error.code === 'ENOENT') return join(directory, ...parts);
      throw error;
    }
    need(i < parts.length - 1 ? stat.isDirectory() : stat.isFile(),
      'UNSAFE_PATCH_PATH', `Expected an ordinary file path for ${path}.`);
  }
  return cursor;
}

function matches(bytes, expected) {
  if (bytes === null) return expected === null;
  if (digest(bytes) === expected) return true;
  // A Git checkout may convert archive LF to CRLF for text on Windows.
  const text = bytes.toString('utf8');
  return text.includes('\r\n') && Buffer.from(text).equals(bytes) &&
    digest(Buffer.from(text.replaceAll('\r\n', '\n'))) === expected;
}

function parseArgs(args) {
  let manifest = defaultManifest;
  let offer = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest') manifest = args[++i];
    else if (args[i] === '--offer-commit' || args[i] === '--commit') offer = true;
    else if (args[i] === '--test-only') offer = false;
    else throw new GateError('INVALID_ARGS', 'Use --test-only or --commit, optionally with --manifest FILE.');
  }
  need(typeof manifest === 'string' && /^CLU-E-[A-Z0-9-]+-Manifest\.json$/.test(manifest),
    'INVALID_MANIFEST_NAME', 'Use a CLU-E patch manifest in the project directory.');
  return { manifest, offer };
}

function readManifest(name) {
  const bytes = readFileSync(fileAt(root, name));
  need(bytes.length <= 256 * 1024, 'INVALID_MANIFEST', 'The patch manifest is too large.');
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new GateError('INVALID_MANIFEST', 'The patch manifest is not valid JSON.');
  }
  need(data?.schemaVersion === 1 && /^[A-Z0-9-]{1,32}$/.test(data.patchId) &&
    name === `CLU-E-${data.patchId}-Manifest.json` &&
    Object.hasOwn(checks, data.gate) && Array.isArray(data.baseCommits) &&
    data.baseCommits.length > 0 && data.baseCommits.every(isCommit) &&
    Array.isArray(data.baseFiles) && Array.isArray(data.files) && data.files.length > 0 &&
    data.baseFiles.length + data.files.length <= 300,
  'INVALID_MANIFEST', 'The patch manifest does not match the verifier contract.');

  const names = new Set([name.toLowerCase()]);
  for (const [entries, payload] of [[data.baseFiles, false], [data.files, true]]) {
    for (const entry of entries) {
      need(safePath(entry?.path) && isHash(entry.sha256) && !names.has(entry.path.toLowerCase()) &&
        (!payload || entry.baseSha256 === null || isHash(entry.baseSha256)),
      'INVALID_MANIFEST_FILE', 'The manifest contains an unsafe, duplicate or invalid file entry.');
      names.add(entry.path.toLowerCase());
    }
  }
  return { ...data, name, bytes };
}

function osEnvironment() {
  const allow = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
    'LANG', 'LC_ALL', 'TZ', 'TEMP', 'TMP', 'TMPDIR', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allow.has(name.toUpperCase())));
}

function runGit(args, { cwd = root, env, accepted = [0] } = {}) {
  const result = spawnSync('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args,
  ], { cwd, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  need(!result.error && accepted.includes(result.status), 'GIT_FAILED',
    `Git ${args[0]} failed. Check the repository and your local Git setup.`);
  return result;
}

const gitText = (args, options) => runGit(args, options).stdout.toString('utf8').trim();
const nulPaths = (bytes) => bytes.toString('utf8').split('\0').filter(Boolean);

function sameLocation(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function repositoryRoot(env) {
  const top = realpathSync(gitText(['rev-parse', '--show-toplevel'], { env }));
  need(sameLocation(top, root), 'GIT_ROOT_MISMATCH', 'Extract the patch in the CLU-E Git repository root.');
}

function gitBlob(ref, path, env) {
  const result = runGit(['cat-file', 'blob', `${ref}:${path}`], { env, accepted: [0, 128] });
  return result.status === 0 ? result.stdout : null;
}

function verifyBase(head, manifest, env) {
  if (manifest.baseCommits.includes(head)) return 'pinned';
  const previous = new Map([
    ...manifest.baseFiles.map(({ path, sha256 }) => [path, sha256]),
    ...manifest.files.map(({ path, baseSha256 }) => [path, baseSha256]),
  ]);
  const current = new Map([
    ...manifest.baseFiles.map(({ path, sha256 }) => [path, sha256]),
    ...manifest.files.map(({ path, sha256 }) => [path, sha256]),
    [manifest.name, digest(manifest.bytes)],
  ]);
  for (const base of manifest.baseCommits) {
    const ancestry = runGit(['merge-base', '--is-ancestor', base, head], { env, accepted: [0, 1, 128] });
    if (ancestry.status !== 0) continue;
    const changed = nulPaths(runGit(['diff', '--name-only', '--no-renames', '-z', base, head, '--'], { env }).stdout);
    for (const [kind, expected] of [['predecessor', previous], ['already-patched', current]]) {
      if (changed.every((path) => expected.has(path)) &&
        [...expected].every(([path, hash]) => matches(gitBlob(head, path, env), hash))) return kind;
    }
  }
  throw new GateError('UNSUPPORTED_BASE', 'Git HEAD does not match the pinned base or the verified patch snapshots.');
}

function verifyLive(manifest, head, env) {
  const payloads = new Map([
    ...[...manifest.baseFiles, ...manifest.files].map(({ path, sha256 }) => {
      let bytes;
      try {
        bytes = readFileSync(fileAt(root, path));
      } catch (error) {
        if (error instanceof GateError) throw error;
        throw new GateError('PATCH_FILE_MISSING', `Cannot read ${path}.`);
      }
      need(matches(bytes, sha256), 'PATCH_FILE_MISMATCH', `Checksum mismatch for ${path}.`);
      return [path, bytes];
    }),
    [manifest.name, manifest.bytes],
  ]);
  need(readFileSync(fileAt(root, manifest.name)).equals(manifest.bytes),
    'MANIFEST_CHANGED', 'The manifest changed during verification.');
  need(gitText(['rev-parse', 'HEAD'], { env }) === head,
    'HEAD_CHANGED', 'Git HEAD changed during verification.');
  const staged = nulPaths(runGit(['diff', '--cached', '--name-only', '--no-renames', '-z', '--'], { env }).stdout);
  need(staged.length === 0, 'STAGED_CHANGES', 'Git already has staged changes. The verifier left the index alone.');
  const status = nulPaths(runGit(['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z'], { env }).stdout);
  const other = status.filter((item) => !payloads.has(item.slice(3))).length;
  need(other === 0, 'UNRELATED_CHANGES', `Git sees ${other} change(s) outside the verified overlay.`);
  return payloads;
}

function isolateEnvironment(env, scratch, autoCrlf) {
  const home = join(scratch, 'home');
  const tmp = join(scratch, 'temp');
  const emptyGitConfig = join(scratch, 'gitconfig');
  const hooks = join(scratch, 'empty-hooks');
  for (const dir of [home, tmp, hooks]) mkdirSync(dir);
  writeFileSync(emptyGitConfig, '');
  const isolated = Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^(HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|TEMP|TMP|TMPDIR)$/i.test(name)
  ));
  return {
    ...isolated, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
    TEMP: tmp, TMP: tmp, TMPDIR: tmp, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_VALUE_1: autoCrlf || 'false',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function copyDependencies(target) {
  const source = realpathSync(join(root, 'node_modules'));
  const destination = join(target, 'node_modules');
  need(lstatSync(destination, { throwIfNoEntry: false }) === undefined,
    'UNSAFE_DEPENDENCY_DESTINATION', 'The isolated checkout already has a node_modules entry.');
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => {
      const targetPath = realpathSync(entry);
      const delta = relative(source, targetPath);
      need(delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta),
        'EXTERNAL_DEPENDENCY_LINK', 'A dependency links outside the installed node_modules directory.');
      return true;
    },
  });
}

function writeCandidate(head, payloads, candidate, env) {
  const entries = nulPaths(runGit(['ls-tree', '-r', '-z', head], { env }).stdout);
  need(entries.every((entry) => /^100(?:644|755) blob /u.test(entry)),
    'UNSAFE_BASE_ENTRY', 'The Git base contains a link or submodule outside this verifier’s checkout scope.');
  runGit(['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', '--', root, candidate], { env });
  runGit(['checkout', '--quiet', '--detach', head], { cwd: candidate, env });
  for (const [path, bytes] of payloads) {
    const destination = fileAt(candidate, path, true);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  runGit(['add', '--', ...payloads.keys()], { cwd: candidate, env });
  return gitText(['write-tree'], { cwd: candidate, env });
}

function testGate(report, name, args, candidate, env) {
  const start = Date.now();
  console.log(`Running ${name}...`);
  const result = spawnSync(process.execPath, args, {
    cwd: candidate, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    windowsHide: true, timeout: 5 * 60 * 1000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const passed = !result.error && result.status === 0;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const details = {};
  if (name === 'build') {
    details.diagnostics = [...output.matchAll(/^([\w./-]+\.tsx?)\((\d+),(\d+)\): error (TS\d+)/gm)]
      .filter((match) => safePath(match[1])).slice(0, 8)
      .map(([, file, line, column, code]) => ({ file, line: Number(line), column: Number(column), code }));
  } else {
    for (const [, label, count] of output.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)) {
      details[label] = Number(count);
    }
    if (!passed) {
      // TAP positions identify the failure without retaining dynamic labels or test payloads.
      details.failedTestNumbers = [...output.matchAll(/^not ok (\d+)/gm)].slice(0, 8).map(([, count]) => Number(count));
    }
  }
  report.gates.push({
    name, status: passed ? 'passed' : 'failed', exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT', elapsedMs: Date.now() - start, details,
  });
  need(passed, 'CHECK_FAILED', `${name} failed. See the test output above.`);
}

function recheckLive(manifest, head, payloads, env) {
  const rechecked = verifyLive(manifest, head, env);
  need([...payloads].every(([path, bytes]) => bytes.equals(rechecked.get(path))),
    'WORKTREE_CHANGED', 'The installed files changed after testing. Run verification again.');
}

async function commitIfApproved(options, manifest, head, payloads, tree, env, report, isolatedEnv) {
  if (!options.offer || !process.stdin.isTTY || !process.stdout.isTTY) return;
  if (tree === gitText(['rev-parse', `${head}^{tree}`], { env })) {
    report.commit.status = 'already-committed';
    return;
  }
  const branch = gitText(['symbolic-ref', '--quiet', 'HEAD'], { env, accepted: [0, 1] });
  need(branch.startsWith('refs/heads/'), 'DETACHED_HEAD', 'A local commit requires a checked-out branch.');
  console.log(`Verified ${manifest.patchId}. A local commit can include the patch and any uncommitted verified prerequisites.`);
  console.log('Press Enter to keep your current Git history.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await prompt.question(`Type COMMIT ${manifest.patchId} to create the local commit: `);
  } finally {
    prompt.close();
  }
  if (answer !== `COMMIT ${manifest.patchId}`) {
    report.commit.status = 'declined';
    return;
  }
  recheckLive(manifest, head, payloads, env);
  // Preserve configured author identity while suppressing local hooks and automatic signing.
  const commitEnv = {
    ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: isolatedEnv.GIT_CONFIG_VALUE_0,
  };
  let stagedTree = null;
  try {
    runGit(['add', '--', ...payloads.keys()], { env: commitEnv });
    stagedTree = gitText(['write-tree'], { env: commitEnv });
    need(stagedTree === tree, 'INDEX_TREE_MISMATCH', 'The staged Git tree differs from the tested checkout.');
    need(gitText(['rev-parse', 'HEAD'], { env }) === head &&
      gitText(['symbolic-ref', '--quiet', 'HEAD'], { env, accepted: [0, 1] }) === branch,
    'HEAD_CHANGED', 'The current Git branch or commit changed during verification.');
    // Commit the immutable verified tree and compare-and-swap the reviewed branch ref.
    const message = `Apply verified CLU-E patch ${manifest.patchId}`;
    const commit = gitText(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', head, '-m', message], { env: commitEnv });
    runGit(['update-ref', '-m', message, branch, commit, head], { env: commitEnv });
    report.commit = { status: 'committed', commit };
    need(gitText(['rev-parse', `${commit}^{tree}`], { env }) === tree,
      'COMMIT_TREE_MISMATCH', 'The resulting commit differs from the tested tree.');
  } catch (error) {
    // Undo only this verifier's staging, provided HEAD and the staged tree are still ours.
    if (stagedTree === tree && gitText(['rev-parse', 'HEAD'], { env }) === head &&
      gitText(['write-tree'], { env: commitEnv }) === stagedTree) {
      runGit(['restore', '--staged', '--', ...payloads.keys()], { env: commitEnv });
    }
    throw error;
  }
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true });
  need(lstatSync(reportDir).isDirectory(), 'UNSAFE_REPORT_DIR', 'The release-evidence folder must be a regular directory.');
  const when = report.completedAt.replace(/[:.]/g, '-');
  const file = join(reportDir, `CLU-E-${report.patchId ?? 'Patch'}-Verification-${when}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`JSON report: ${file}`);
}

const report = {
  schemaVersion: 1,
  patchId: null,
  manifestSha256: null,
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: 'failed',
  gitBase: null,
  candidateTree: null,
  versions: { node: process.version },
  gates: [],
  commit: { status: 'not-requested', commit: null },
  liveWindowsChecks: { status: 'pending', checks: [] },
  blocker: null,
};
let scratch;
try {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readManifest(options.manifest);
  report.patchId = manifest.patchId;
  report.liveWindowsChecks.checks = pendingWindowsChecks[manifest.gate];
  report.manifestSha256 = digest(manifest.bytes);
  const env = osEnvironment();
  repositoryRoot(env);
  const head = gitText(['rev-parse', 'HEAD'], { env });
  const autoCrlf = gitText(['config', '--get', 'core.autocrlf'], { env, accepted: [0, 1] });
  report.gitBase = { commit: head, kind: verifyBase(head, manifest, env) };
  const payloads = verifyLive(manifest, head, env);
  report.gates.push({ name: 'base-and-overlay', status: 'passed' });
  mkdirSync(reportDir, { recursive: true });
  need(lstatSync(reportDir).isDirectory(), 'UNSAFE_REPORT_DIR', 'The release-evidence folder must be a regular directory.');
  scratch = mkdtempSync(join(reportDir, '.clue-verification-'));
  const candidate = join(scratch, 'source');
  const isolatedEnv = isolateEnvironment(env, scratch, autoCrlf);
  report.candidateTree = writeCandidate(head, payloads, candidate, isolatedEnv);
  copyDependencies(candidate);
  for (const pkg of ['typescript', 'zod']) {
    report.versions[pkg] = JSON.parse(readFileSync(join(candidate, 'node_modules', pkg, 'package.json'), 'utf8')).version;
  }
  testGate(report, 'build', ['node_modules/typescript/bin/tsc'], candidate, isolatedEnv);
  const tests = checks[manifest.gate].map((file) => `dist/selftest/${file}.test.js`);
  testGate(report, 'integration', ['--test', '--test-reporter=tap', '--test-concurrency=1', ...tests], candidate, isolatedEnv);
  const dashboard = readdirSync(join(candidate, 'ui', 'clue-dashboard', 'test'))
    .filter((file) => file.endsWith('.test.mjs')).sort().map((file) => `ui/clue-dashboard/test/${file}`);
  need(dashboard.length > 0, 'NO_DASHBOARD_TESTS', 'The dashboard test suite is missing.');
  testGate(report, 'dashboard', ['--test', '--test-reporter=tap', '--test-concurrency=1', ...dashboard], candidate, isolatedEnv);
  const changesAfterTests = runGit(['diff', '--quiet', '--'], {
    cwd: candidate, env: isolatedEnv, accepted: [0, 1],
  });
  need(changesAfterTests.status === 0 &&
    runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: candidate, env: isolatedEnv }).stdout.length === 0 &&
    gitText(['write-tree'], { cwd: candidate, env: isolatedEnv }) === report.candidateTree,
  'TEST_INPUT_CHANGED', 'Verification modified a source file in the isolated checkout.');
  recheckLive(manifest, head, payloads, env);
  await commitIfApproved(options, manifest, head, payloads, report.candidateTree, env, report, isolatedEnv);
  report.status = 'passed';
} catch (error) {
  report.blocker = error instanceof GateError ? { code: error.code, message: error.message }
    : { code: 'VERIFIER_ERROR', message: 'Verification could not finish. Check that the patch, Git, and local dependencies are installed.' };
  console.error(report.blocker.message);
  process.exitCode = 1;
} finally {
  if (scratch) {
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); }
    catch { report.cleanup = 'incomplete'; }
  }
  report.completedAt = new Date().toISOString();
  try { writeReport(report); }
  catch { console.error('Could not write the JSON report to the sibling release-evidence folder.'); process.exitCode = 1; }
}
