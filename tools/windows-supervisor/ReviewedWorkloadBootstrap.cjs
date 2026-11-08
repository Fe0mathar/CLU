'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const side = process.argv[1];
const cwd = process.cwd();
const root = path.dirname(cwd);
const admission = path.dirname(root);

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
  return fs.lstatSync(file).isFile() && samePath(fs.realpathSync.native(file), file);
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
    if (typeof name !== 'string' || name.length > 128 ||
        !/^ui\/clue-dashboard\/test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/u.test(name) ||
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

const result = {
  side: side === 'baseline' || side === 'candidate' ? side : 'unverified',
  state: 'BOOTSTRAP_REFUSED',
  exitCode: null, tests: null, pass: null, fail: null, cancelled: null, skipped: null,
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
  const suite = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...tests], {
    cwd, env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
  });
  result.exitCode = Number.isSafeInteger(suite.status) ? suite.status : null;
  const counts = readTapCounts(suite.stdout ?? '');
  if (counts === null) return;
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) result[key] = counts[key];
  if (suite.error === undefined && suite.status === 0 && counts.pass === counts.tests) result.state = 'WORKLOAD_PASSED';
}

try {
  run();
} catch {
  // Emit only the bounded evidence already collected.
}
console.log('CLU_E_REVIEWED_WORKLOAD ' + JSON.stringify(result));
process.exitCode = result.state === 'WORKLOAD_PASSED' ? 0 : 1;
