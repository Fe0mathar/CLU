'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const side = process.argv[1];
const requestedOperation = process.argv[2];
const brokerOperation = (side === 'candidate' && requestedOperation === 'broker-typecheck') ||
  (side === 'baseline' && requestedOperation === 'broker-doctor') ? requestedOperation : undefined;
const cwd = process.cwd();
const root = path.dirname(cwd);
const admission = path.dirname(root);
const workspace = path.join(root, 'workspace');
const trusted = path.join(admission, 'trusted-source');
const marker = 'clue-admission-observed-v1\n';
const scratchKeys = ['TEMP', 'TMP', 'LOCALAPPDATA'];
const permittedErrors = [
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'EIO', 'ENOSPC',
  'ENOTCACHED', 'EINTEGRITY', 'EUSAGE', 'ERR_ACCESS_DENIED', 'ERR_MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED', 'ERR_ASSERTION',
];
const stageNames = ['offlineInstall', 'typecheck', 'build', 'nativeSqlite', 'initWorkspace', 'doctorDeep'];

const result = {
  side: side === 'baseline' || side === 'candidate' ? side : 'unverified',
  state: 'BOOTSTRAP_REFUSED',
  exitCode: null,
  effectiveScratchVerified: false,
  hostEnvironmentAbsent: false,
  checkoutWriteVerified: false,
  privateReadDenied: false,
  trustedSourceRead: false,
  npmCacheWritable: false,
  stages: Object.fromEntries(stageNames.map((name) => [name, receipt('NOT_RUN', 'NONE', null)])),
  doctorDeepVerified: false,
  doctorEvidence: null,
  ...(brokerOperation ? { brokerOperation } : {}),
};

function receipt(state, code, exitCode) {
  return { state, code, exitCode };
}

function samePath(actual, expected) {
  return typeof actual === 'string' && path.isAbsolute(actual) && path.relative(expected, actual) === '';
}

function exactPath(file, check) {
  const info = fs.lstatSync(file);
  return check(info) && samePath(fs.realpathSync.native(file), file);
}

function exactFile(file) {
  return exactPath(file, (info) => info.isFile() && info.nlink === 1);
}

function exactDirectory(file) {
  return exactPath(file, (info) => info.isDirectory());
}

function absent(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) === undefined;
}

function writeMarker(file) {
  fs.writeFileSync(file, marker, { encoding: 'ascii', flag: 'wx' });
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

function checkoutWrite() {
  try {
    writeMarker(path.join(cwd, brokerOperation ? 'broker-checkout-write.txt' : 'checkout-write.txt'));
  } catch (error) {
    return side === 'baseline' && ['EACCES', 'EPERM', 'EROFS'].includes(error.code);
  }
  return side === 'candidate';
}

function hostEnvironmentAbsent() {
  return ['CLU_ADMISSION_HOST_SENTINEL', 'OPENAI_API_KEY', 'CLU_WINDOWS_SUPERVISOR_PATH',
    'CLU_WINDOWS_SUPERVISOR_SHA256', 'NODE_OPTIONS', 'NODE_PATH'].every((key) => process.env[key] === undefined);
}

function scratchLayout() {
  const temp = path.join(root, 'scratch-temp');
  const home = path.join(root, 'scratch-home');
  const cache = path.join(home, 'npm-cache');
  const vars = {
    TEMP: temp, TMP: temp, TMPDIR: temp,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_USERCONFIG: path.join(home, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(home, 'global.npmrc'),
  };
  if (![temp, home, cache].every(exactDirectory)) return null;
  for (const [key, expected] of Object.entries(vars)) {
    const value = process.env[key];
    if (!samePath(value, expected) && (!scratchKeys.includes(key) || !value || !path.isAbsolute(value))) return null;
  }
  for (const key of scratchKeys) process.env[key] = vars[key];
  if (!samePath(os.tmpdir(), temp) || !samePath(os.homedir(), home) ||
      !exactDirectory(os.tmpdir()) || !exactDirectory(os.homedir())) return null;
  if (![vars.NPM_CONFIG_USERCONFIG, vars.NPM_CONFIG_GLOBALCONFIG].every((file) =>
    exactFile(file) && fs.statSync(file).size === 0)) return null;
  return { vars, cache };
}

function trustedMarkerRead() {
  const file = path.join(trusted, 'trusted.txt');
  const expected = 'clue-admission-source-v1\n';
  return exactFile(file) && fs.statSync(file).size === Buffer.byteLength(expected) &&
    fs.readFileSync(file, 'ascii') === expected;
}

function cacheWritable(cache) {
  const file = path.join(cache, 'governed-cache-write.txt');
  writeMarker(file);
  fs.unlinkSync(file);
  return absent(file);
}

function checkedManifest() {
  const packagePath = path.join(cwd, 'package.json');
  if (!['package.json', 'package-lock.json', 'tsconfig.json', 'targets/clu/benchmark/master-benchmark.md']
    .every((name) => exactFile(path.join(cwd, name)))) return null;
  if (!['.npmrc', 'npm-shrinkwrap.json'].every((name) => absent(path.join(cwd, name)))) return null;
  const generated = ['dist', 'node_modules'].map((name) => path.join(cwd, name));
  if (brokerOperation && !generated.every(exactDirectory)) return null;
  if (side === 'baseline') return packagePath;
  if ((!brokerOperation && !generated.every(absent)) ||
      fs.statSync(packagePath).size > 128 * 1024) return null;
  const { scripts } = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const blockedScripts = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare',
    'pretypecheck', 'posttypecheck', 'prebuild', 'postbuild'];
  if (scripts?.typecheck !== 'tsc --noEmit' || scripts.build !== 'tsc' ||
      blockedScripts.some((name) => Object.hasOwn(scripts, name))) return null;
  return packagePath;
}

function childEnvironment(vars, packagePath) {
  const env = { ...vars };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'CI', 'NO_COLOR',
    'NPM_CONFIG_OFFLINE', 'NPM_CONFIG_AUDIT', 'NPM_CONFIG_FUND', 'NPM_CONFIG_UPDATE_NOTIFIER']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  // As in the reviewed ESM diagnostic, use a known readable exact file to distinguish
  // a Windows ancestor-walk denial from a missing or redirected staged input.
  const fd = fs.openSync(packagePath, 'r');
  try {
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) !== 1) return null;
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (!samePath(fs.realpathSync(packagePath), packagePath)) return null;
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) return null;
    // Fixed only for this reviewed, regular, copied tree. npm's own Node children
    // also need the flags, so the scoped environment is used instead of argv alone.
    env.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main';
  }
  return env;
}

const sqliteProbe = [
  "'use strict';",
  "const path = require('node:path');",
  "try {",
  "  const Sqlite = require(path.join(process.cwd(), 'node_modules', 'better-sqlite3', 'lib', 'index.js'));",
  "  const db = new Sqlite(':memory:');",
  "  try {",
  "    db.exec('CREATE TABLE fixture (value INTEGER NOT NULL); INSERT INTO fixture VALUES (73)');",
  "    if (db.prepare('SELECT value FROM fixture').get()?.value !== 73) throw new Error('mismatch');",
  "  } finally { db.close(); }",
  "  console.log('CLU_E_GOVERNED_SQLITE_OK');",
  "} catch (error) {",
  "  const allowed = " + JSON.stringify(permittedErrors) + ";",
  "  const code = error?.code === 'MODULE_NOT_FOUND' ? 'ERR_MODULE_NOT_FOUND' : error?.code;",
  "  console.error('CLU_E_GOVERNED_SQLITE_ERROR ' + (allowed.includes(code) ? code : 'OTHER'));",
  "  process.exitCode = 1;",
  "}",
].join('\n');

function stageFailureCode(child) {
  const output = (child.stderr ?? '') + '\n' + (child.stdout ?? '');
  const codes = output.matchAll(/^(?:(?:npm (?:error|ERR!) code|CLU_E_GOVERNED_SQLITE_ERROR) ([A-Z_]+)|.*\[([A-Z_]+)\]:)/gmu);
  for (const [, explicit, node] of codes) {
    const code = explicit ?? node;
    if (permittedErrors.includes(code)) return code;
  }
  return /\berror TS\d{4,5}:/u.test(output) ? 'TYPESCRIPT_DIAGNOSTICS' : 'NONZERO_EXIT';
}

function spawnStage(args, env, deadline) {
  const timeout = Math.floor(deadline - performance.now());
  if (timeout <= 0) return { stage: receipt('TIMEOUT', 'ETIMEDOUT', null) };
  let child;
  try {
    child = spawnSync(process.execPath, args, {
      cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
    });
  } catch (error) {
    child = { error };
  }
  if (child.error) {
    const code = child.error.code;
    if (code === 'ETIMEDOUT') return { stage: receipt('TIMEOUT', code, null) };
    if (code === 'ENOBUFS') return { stage: receipt('OUTPUT_LIMIT', code, null) };
    return { stage: receipt('LAUNCH_FAILED', permittedErrors.includes(code) ? code : 'OTHER', null) };
  }
  const exitCode = Number.isInteger(child.status) && child.status >= 0 && child.status <= 255 ? child.status : null;
  if (exitCode !== 0) return { stage: receipt('FAILED', stageFailureCode(child), exitCode), stdout: child.stdout ?? '' };
  return { stage: receipt('PASSED', 'NONE', 0), stdout: child.stdout ?? '' };
}

function readDoctorEvidence(stdout) {
  const logs = [...stdout.matchAll(/^( {2}OK|WARN|FAIL|INFO) +event log +([^\r\n]*)\r?$/gmu)];
  const artifacts = [...stdout.matchAll(/^( {2}OK|WARN|FAIL|INFO) +artifacts +([^\r\n]*)\r?$/gmu)];
  const evidence = {
    eventLogState: logs.length === 0 ? 'ABSENT' : 'UNVERIFIED', eventLogHead: null, recordsVerified: null,
    artifactState: artifacts.length === 0 ? 'ABSENT' : 'UNVERIFIED', artifactsChecked: null, artifactsVerified: null,
  };
  if (logs.length === 1) {
    const [, level, detail] = logs[0];
    if (level === 'WARN') evidence.eventLogState = 'UNAVAILABLE';
    if (level === '  OK') {
      if (detail === 'empty') evidence.eventLogState = 'EMPTY';
      const counts = /^head (0|[1-9]\d{0,8}) \((0|[1-9]\d{0,8}) records verified\)$/u.exec(detail);
      if (counts) {
        evidence.eventLogHead = Number(counts[1]);
        evidence.recordsVerified = Number(counts[2]);
        // EventLog.append numbers the first event 0; verify counts all records.
        evidence.eventLogState = evidence.recordsVerified === evidence.eventLogHead + 1 ? 'VERIFIED' : 'MISMATCH';
      }
    }
  }
  if (artifacts.length === 1) {
    const [, level, detail] = artifacts[0];
    const counts = /^(0|[1-9]\d{0,8})\/(0|[1-9]\d{0,8}) verified(, (?:0|[1-9]\d{0,8}) damaged)?$/u.exec(detail);
    if (counts) {
      evidence.artifactsVerified = Number(counts[1]);
      evidence.artifactsChecked = Number(counts[2]);
      evidence.artifactState = level === '  OK' && counts[3] === undefined &&
        evidence.artifactsVerified === evidence.artifactsChecked ? 'VERIFIED' : 'MISMATCH';
    }
  }
  return evidence;
}

function run() {
  if (process.argv.length !== (brokerOperation ? 3 : 2) || result.side === 'unverified' ||
      path.basename(cwd) !== 'checkout' || path.basename(root) !== side || path.basename(admission) !== 'admission') return;
  if (!exactDirectory(workspace)) return;
  writeMarker(path.join(workspace, brokerOperation ? 'broker-started.txt' : 'started.txt'));
  result.hostEnvironmentAbsent = hostEnvironmentAbsent();
  result.checkoutWriteVerified = checkoutWrite();
  result.privateReadDenied = readDenied(path.join(root, 'private', 'sealed.txt')) &&
    readDenied(path.join(root, 'outside', 'forbidden.txt'));
  result.trustedSourceRead = trustedMarkerRead();
  if (!result.hostEnvironmentAbsent || !result.checkoutWriteVerified || !result.privateReadDenied || !result.trustedSourceRead) return;

  const layout = scratchLayout();
  if (!layout) return;
  result.effectiveScratchVerified = true;
  result.npmCacheWritable = cacheWritable(layout.cache);
  if (!result.npmCacheWritable) return;
  const packagePath = checkedManifest();
  if (!packagePath) return;
  const env = childEnvironment(layout.vars, packagePath);
  if (!env) return;

  const cli = path.join(cwd, 'dist', 'src', 'cli', 'index.js');
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const addon = path.join(cwd, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!exactFile(side === 'candidate' ? npm : cli)) return;
  if (brokerOperation === 'broker-typecheck' && !exactFile(cli)) return;
  if (brokerOperation === 'broker-doctor' && !['events/events.ndjson', 'db/clue.db']
    .every((name) => exactFile(path.join(workspace, 'mission', name)))) return;
  const steps = side === 'candidate' ? [
    ['offlineInstall', [npm, 'ci', '--offline', '--no-audit', '--no-fund'], () => exactFile(addon)],
    ['typecheck', [npm, 'run', 'typecheck']],
    ['build', [npm, 'run', 'build'], () => exactFile(cli)],
    ['nativeSqlite', ['-e', sqliteProbe], (stdout) => stdout.trim() === 'CLU_E_GOVERNED_SQLITE_OK'],
  ] : [
    ['initWorkspace', [cli, 'init']],
    ['doctorDeep', [cli, 'doctor', '--deep'], () => result.doctorEvidence.eventLogState === 'VERIFIED' &&
      result.doctorEvidence.artifactState === 'VERIFIED'],
  ];
  result.state = 'GOVERNED_FAILED';
  result.exitCode = 1;
  const deadline = performance.now() + (side === 'candidate' ? 350_000 : 112_000);
  const brokerStage = brokerOperation === 'broker-typecheck' ? 'typecheck' : 'doctorDeep';
  for (const [name, args, verify] of steps) {
    if (brokerOperation && name !== brokerStage) continue;
    const { stage, stdout } = spawnStage(args, env, deadline);
    result.stages[name] = stage;
    if (name === 'doctorDeep' && typeof stdout === 'string') result.doctorEvidence = readDoctorEvidence(stdout);
    if (stage.state !== 'PASSED') return;
    if (verify) {
      result.stages[name] = receipt('OUTPUT_UNVERIFIED', 'PROTOCOL_UNVERIFIED', 0);
      if (!verify(stdout)) return;
      result.stages[name] = stage;
    }
  }
  result.doctorDeepVerified = side === 'baseline';
  result.state = 'GOVERNED_PASSED';
  result.exitCode = 0;
}

try {
  run();
} catch {
  // Keep only bounded status evidence even when filesystem access is refused.
}
console.log('CLU_E_GOVERNED_WORKLOAD ' + JSON.stringify(result));
process.exitCode = result.state === 'GOVERNED_PASSED' ? 0 : 1;
