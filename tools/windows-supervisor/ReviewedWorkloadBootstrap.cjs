'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const side = process.argv[1];
const cwd = process.cwd();
const root = path.dirname(cwd);
const admission = path.dirname(root);
const filePrefix = 'CLU_E_REVIEWED_FILE ';
const errorCodes = [
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EIO', 'EMFILE', 'ENFILE', 'ENOSYS', 'EINVAL',
  'ETIMEDOUT', 'ENOBUFS', 'ERR_ACCESS_DENIED', 'ERR_MODULE_NOT_FOUND', 'ERR_INVALID_MODULE_SPECIFIER',
  'ERR_UNSUPPORTED_ESM_URL_SCHEME', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_INVALID_PACKAGE_CONFIG',
  'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM', 'ERR_INVALID_ARG_VALUE', 'ERR_ASSERTION',
];

function samePath(actual, expected) {
  return typeof actual === 'string' && path.isAbsolute(actual) && path.relative(expected, actual) === '';
}

function canonicalDirectory(expected) {
  try {
    if (!fs.lstatSync(expected).isDirectory()) return null;
    const canonical = fs.realpathSync.native(expected);
    return samePath(canonical, expected) ? canonical : null;
  } catch {
    return null;
  }
}

function matchesDirectory(actual, expected, canonical) {
  return canonical !== null && samePath(actual, expected) && path.normalize(actual) === actual &&
    fs.realpathSync.native(actual) === canonical;
}

function scratchLayout(root) {
  const temp = path.join(root, 'scratch-temp');
  const home = path.join(root, 'scratch-home');
  return {
    temp, home,
    vars: {
      TEMP: temp, TMP: temp, TMPDIR: temp,
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      NPM_CONFIG_CACHE: path.join(home, 'npm-cache'),
      NPM_CONFIG_USERCONFIG: path.join(home, 'user.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: path.join(home, 'global.npmrc'),
    },
  };
}

function hostEnvironmentAbsent() {
  return ['CLU_ADMISSION_HOST_SENTINEL', 'OPENAI_API_KEY', 'CLU_WINDOWS_SUPERVISOR_PATH',
    'CLU_WINDOWS_SUPERVISOR_SHA256', 'NODE_OPTIONS', 'NODE_PATH'].every((key) => process.env[key] === undefined);
}

function verifyScratch(layout) {
  if (!Object.entries(layout.vars).every(([key, expected]) => samePath(process.env[key], expected))) return false;
  const os = require('node:os');
  return matchesDirectory(os.tmpdir(), layout.temp, canonicalDirectory(layout.temp)) &&
    matchesDirectory(os.homedir(), layout.home, canonicalDirectory(layout.home));
}

function writeMarker(file) {
  fs.writeFileSync(file, 'clue-admission-observed-v1\n', { encoding: 'ascii', flag: 'wx' });
}

function readDenied(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    return ['EACCES', 'EPERM', 'ENOENT'].includes(error.code);
  }
  fs.closeSync(fd);
  return false;
}

function checkoutWriteDenied() {
  try {
    writeMarker(path.join(cwd, 'checkout-write.txt'));
  } catch (error) {
    return ['EACCES', 'EPERM', 'EROFS'].includes(error.code);
  }
  return false;
}

function exactFile(file) {
  const info = fs.lstatSync(file);
  return info.isFile() && info.nlink === 1 && samePath(fs.realpathSync.native(file), file);
}

function reviewedPathName(name) {
  return typeof name === 'string' && name.length <= 128 &&
    /^ui\/clue-dashboard\/test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/u.test(name);
}

function reviewedPaths() {
  const file = path.join(admission, 'trusted-source', 'reviewed-workload.json');
  if (!exactFile(file)) return null;
  const fd = fs.openSync(file, 'r');
  let data;
  try {
    const buffer = Buffer.alloc(4097);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size === buffer.length) return null;
    data = JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
  if (!data || Object.keys(data).length !== 2 || data.schemaVersion !== 'clue-windows-reviewed-workload/1' ||
      !Array.isArray(data.testPaths) || data.testPaths.length < 1 || data.testPaths.length > 64) return null;

  const identities = new Set();
  for (const name of data.testPaths) {
    if (!reviewedPathName(name) ||
        identities.has(name.toLowerCase()) || !exactFile(path.join(cwd, name))) return null;
    identities.add(name.toLowerCase());
  }
  return data.testPaths;
}

function childEnvironment(layout) {
  const env = { ...layout.vars };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'CI', 'NO_COLOR',
    'NPM_CONFIG_OFFLINE', 'NPM_CONFIG_AUDIT', 'NPM_CONFIG_FUND', 'NPM_CONFIG_UPDATE_NOTIFIER']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

function descendantCheck(env) {
  const source = [
    "'use strict';const fs=require('node:fs'),path=require('node:path');",
    samePath, canonicalDirectory, matchesDirectory, scratchLayout, hostEnvironmentAbsent, verifyScratch, writeMarker,
    "try { const root=path.dirname(process.cwd()); if (!hostEnvironmentAbsent() || !verifyScratch(scratchLayout(root))) process.exitCode=1;",
    "else writeMarker(path.join(root,'workspace','descendant.txt')); } catch { process.exitCode=1; }",
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd, env, timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true,
  });
  return child.status === 0 && child.error === undefined;
}

function readTapCounts(text) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const hits = [...text.matchAll(new RegExp('^# ' + key + ' (\\d+)\\r?$', 'gmu'))];
    if (hits.length !== 1 || !Number.isSafeInteger(Number(hits[0][1]))) return null;
    counts[key] = Number(hits[0][1]);
  }
  return counts.tests > 0 && counts.tests === counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo
    ? counts : null;
}

function errorCode(error) {
  if (errorCodes.includes(error?.code)) return error.code;
  return error instanceof SyntaxError ? 'SYNTAX_ERROR' : 'OTHER';
}

function fileDiagnostic(phase, code) {
  return { phase, code, canaryRealpath: 'UNVERIFIED', testRealpath: 'UNVERIFIED' };
}

async function fileWorker() {
  const { pathToFileURL } = require('node:url');
  const cwd = process.cwd();
  const root = path.dirname(cwd);
  const canary = path.join(path.dirname(root), 'trusted-source', 'reviewed-esm-canary.mjs');
  const canaryValue = 'clue-reviewed-esm-canary-v1';
  const canaryText = `export default '${canaryValue}';\n`;
  const evidence = fileDiagnostic('CHILD_ENVIRONMENT', 'MISMATCH');
  function plainRealpath(file) {
    try {
      return samePath(fs.realpathSync(file), file) ? 'MATCH' : 'MISMATCH';
    } catch (error) {
      return errorCode(error);
    }
  }
  async function importApprovedFile() {
    const name = process.argv[1];
    if (process.argv.length !== 2 || !reviewedPathName(name) || !hostEnvironmentAbsent() ||
        !verifyScratch(scratchLayout(root))) return;
    evidence.phase = 'CANARY_PATH';
    if (!exactFile(canary)) return;
    evidence.canaryRealpath = plainRealpath(canary);
    if (evidence.canaryRealpath === 'MISMATCH') return;
    evidence.phase = 'CANARY_READ';
    if (fs.statSync(canary).size !== Buffer.byteLength(canaryText) || fs.readFileSync(canary, 'utf8') !== canaryText) return;
    evidence.phase = 'CANARY_IMPORT';
    if ((await import(pathToFileURL(canary).href)).default !== canaryValue) return;

    const test = path.join(cwd, name);
    evidence.phase = 'TEST_PATH';
    if (!exactFile(test)) return;
    evidence.testRealpath = plainRealpath(test);
    if (evidence.testRealpath === 'MISMATCH') return;
    evidence.phase = 'TEST_READ';
    const fd = fs.openSync(test, 'r');
    try {
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) !== 1) return;
    } finally {
      fs.closeSync(fd);
    }
    evidence.phase = 'TEST_IMPORT';
    await import(pathToFileURL(test).href);
    evidence.phase = 'TEST_RUN';
    evidence.code = 'NONE';
  }
  try {
    await importApprovedFile();
  } catch (error) {
    evidence.code = errorCode(error);
  }
  console.error(filePrefix + JSON.stringify(evidence));
  if (evidence.phase !== 'TEST_RUN') process.exitCode = 1;
}

const workerSource = [
  "'use strict';const fs=require('node:fs'),path=require('node:path');",
  'const errorCodes=' + JSON.stringify(errorCodes) + ', filePrefix=' + JSON.stringify(filePrefix) + ';',
  samePath, canonicalDirectory, matchesDirectory, scratchLayout, hostEnvironmentAbsent, verifyScratch,
  exactFile, reviewedPathName, errorCode, fileDiagnostic, fileWorker, 'fileWorker();',
].join('\n');
const childPhases = ['CHILD_ENVIRONMENT', 'CANARY_PATH', 'CANARY_READ', 'CANARY_IMPORT',
  'TEST_PATH', 'TEST_READ', 'TEST_IMPORT', 'TEST_RUN'];

function readFileDiagnostic(stderr) {
  const lines = stderr.split(/\r?\n/u).filter((line) => line.startsWith(filePrefix));
  if (lines.length !== 1 || lines[0].length > 512) return null;
  try {
    const { phase, code, canaryRealpath, testRealpath } = JSON.parse(lines[0].slice(filePrefix.length));
    const pathCodes = ['UNVERIFIED', 'MATCH', 'MISMATCH', 'OTHER', ...errorCodes];
    if (!childPhases.includes(phase) ||
        !(phase === 'TEST_RUN' ? code === 'NONE' : ['MISMATCH', 'SYNTAX_ERROR', 'OTHER', ...errorCodes].includes(code)) ||
        !pathCodes.includes(canaryRealpath) || !pathCodes.includes(testRealpath)) return null;
    return { phase, code, canaryRealpath, testRealpath };
  } catch {
    return null;
  }
}

function runReviewedFile(test, env, timeout, preserveSymlinks) {
  const args = ['--test-reporter=tap'];
  if (preserveSymlinks) args.push('--preserve-symlinks');
  args.push('-e', workerSource, test);
  let child;
  try {
    child = spawnSync(process.execPath, args, {
      cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
    });
  } catch (error) {
    child = { error };
  }
  if (child.error) {
    const code = errorCode(child.error);
    const outcome = code === 'ETIMEDOUT' ? 'TIMEOUT' : code === 'ENOBUFS' ? 'OUTPUT_LIMIT' : 'LAUNCH_FAILED';
    return { outcome, diagnostic: fileDiagnostic('SPAWN', code) };
  }
  const diagnostic = readFileDiagnostic(child.stderr ?? '');
  if (!diagnostic) return { outcome: 'TAP_UNVERIFIED', diagnostic: fileDiagnostic('CHILD_START', 'UNVERIFIED') };
  if (diagnostic.phase !== 'TEST_RUN') return { outcome: 'CHILD_REFUSED', diagnostic };
  const counts = readTapCounts(child.stdout ?? '');
  if (!counts) return { outcome: 'TAP_UNVERIFIED', diagnostic: { ...diagnostic, code: 'UNVERIFIED' } };
  const passed = child.status === 0 && counts.pass === counts.tests;
  return { outcome: passed ? 'PASSED' : 'SUITE_FAILED', counts,
    diagnostic: { ...diagnostic, code: passed ? 'NONE' : 'TEST_FAILURE' } };
}

const result = {
  side: side === 'baseline' || side === 'candidate' ? side : 'unverified',
  state: 'BOOTSTRAP_REFUSED',
  exitCode: null, tests: null, pass: null, fail: null, cancelled: null, skipped: null,
  fileOutcomes: [], fileDiagnostics: [], executionMode: 'DIRECT_IMPORT', fallback: null, esmCanaryVerified: false,
  descendantScratchVerified: false, effectiveScratchVerified: false,
  checkoutWriteDenied: false, privateReadDenied: false, hostEnvironmentAbsent: hostEnvironmentAbsent(),
};

function run() {
  if (process.argv.length !== 2 || result.side !== side || (side !== 'baseline' && side !== 'candidate') ||
      path.basename(cwd) !== 'checkout' || path.basename(root) !== side || path.basename(admission) !== 'admission') return;
  writeMarker(path.join(root, 'workspace', 'started.txt'));
  result.checkoutWriteDenied = checkoutWriteDenied();
  result.privateReadDenied = readDenied(path.join(root, 'private', 'sealed.txt'));
  if (!result.hostEnvironmentAbsent || !result.checkoutWriteDenied || !result.privateReadDenied ||
      !readDenied(path.join(root, 'outside', 'forbidden.txt'))) return;

  const layout = scratchLayout(root);
  if (canonicalDirectory(layout.temp) === null || canonicalDirectory(layout.home) === null) return;
  const rewrite = ['TEMP', 'TMP', 'LOCALAPPDATA'];
  for (const [key, expected] of Object.entries(layout.vars)) {
    const value = process.env[key];
    if (!samePath(value, expected) && (!rewrite.includes(key) || !value || !path.isAbsolute(value))) return;
  }
  for (const key of rewrite) process.env[key] = layout.vars[key];

  result.effectiveScratchVerified = verifyScratch(layout);
  if (!result.effectiveScratchVerified) return;
  const tests = reviewedPaths();
  if (!tests) return;
  const env = childEnvironment(layout);
  result.state = 'DESCENDANT_UNVERIFIED';
  result.descendantScratchVerified = descendantCheck(env);
  if (!result.descendantScratchVerified) return;

  result.state = 'WORKLOAD_FAILED';
  result.exitCode = 1;
  result.fileOutcomes = tests.map(() => 'NOT_RUN');
  result.fileDiagnostics = tests.map(() => fileDiagnostic('NOT_RUN', 'NONE'));
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0 };
  let allCountsVerified = true;
  let preserveSymlinks = false;
  const deadline = performance.now() + 70_000;
  for (const [index, test] of tests.entries()) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) {
      allCountsVerified = false;
      break;
    }
    let execution = runReviewedFile(test, env, remaining, preserveSymlinks);
    const { phase, code, canaryRealpath } = execution.diagnostic;
    const retryBudget = Math.floor(deadline - performance.now());
    const permissionCodes = ['EACCES', 'EPERM'];
    // Retry only the first, untouched test after a trusted canary path failure.
    // The host stages and verifies regular copies; each child still checks native paths.
    if (index === 0 && retryBudget > 0 && phase === 'CANARY_IMPORT' &&
        permissionCodes.includes(code) && permissionCodes.includes(canaryRealpath)) {
      preserveSymlinks = true;
      result.executionMode = 'DIRECT_IMPORT_PRESERVE_SYMLINKS';
      result.fallback = { code, realpathCode: canaryRealpath };
      execution = runReviewedFile(test, env, retryBudget, preserveSymlinks);
    }
    const { outcome, counts, diagnostic } = execution;
    result.fileOutcomes[index] = outcome;
    result.fileDiagnostics[index] = diagnostic;
    if (index === 0 && diagnostic.phase.startsWith('CANARY_')) {
      allCountsVerified = false;
      break;
    }
    if (counts) {
      for (const key of Object.keys(totals)) totals[key] += counts[key];
    } else {
      allCountsVerified = false;
    }
  }
  result.esmCanaryVerified = result.fileDiagnostics.every(({ phase }) => phase.startsWith('TEST_'));
  if (!allCountsVerified || !Object.values(totals).every(Number.isSafeInteger)) return;
  Object.assign(result, totals);
  if (result.fileOutcomes.every((outcome) => outcome === 'PASSED')) {
    result.exitCode = 0;
    result.state = 'WORKLOAD_PASSED';
  }
}

try {
  run();
} catch {
  // Emit only the bounded evidence already collected.
}
console.log('CLU_E_REVIEWED_WORKLOAD ' + JSON.stringify(result));
process.exitCode = result.state === 'WORKLOAD_PASSED' ? 0 : 1;
