'use strict';

const fs = require('node:fs');
const path = require('node:path');
const side = process.argv[1];
const cwd = process.cwd();
const caseRoot = path.dirname(cwd);
const admissionRoot = path.dirname(caseRoot);
const marker = 'clue-admission-observed-v1\n';
const denyRead = new Set(['EACCES', 'EPERM', 'ENOENT']);
const denyWrite = new Set(['EACCES', 'EPERM', 'EROFS']);

function writeMarker(file) {
  try {
    fs.writeFileSync(file, marker, { encoding: 'ascii', flag: 'wx' });
    return 'ALLOWED';
  } catch (error) {
    return denyWrite.has(error.code) ? 'DENIED' : 'UNVERIFIED';
  }
}

function readMarker(file, expected) {
  const expectedBytes = Buffer.from(expected, 'ascii');
  const bytes = Buffer.alloc(expectedBytes.length + 1);
  try {
    const fd = fs.openSync(file, 'r');
    try {
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      return count === expectedBytes.length && bytes.subarray(0, count).equals(expectedBytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function readDenied(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    return denyRead.has(error.code);
  }
  fs.closeSync(fd);
  return false;
}

function samePath(actual, expected) {
  if (typeof actual !== 'string' || !path.isAbsolute(actual)) return false;
  return path.relative(expected, actual) === '';
}

function canonicalDrivePath(value) {
  return /^[a-z]:\\/i.test(value) && !/[/:*?"<>|\u0000-\u001f]/u.test(value.slice(3)) &&
    path.win32.normalize(value) === value &&
    value.slice(3).split('\\').every((part) => part.length > 0 && !/[. ]$/.test(part));
}

function classifyScratchPath(actual, expected, kind) {
  if (actual === undefined) return 'MISSING';
  if (actual === '') return 'EMPTY';
  if (samePath(actual, expected)) return 'MATCH';
  if (!path.isAbsolute(actual)) return 'RELATIVE';
  if (process.platform !== 'win32') return 'OTHER_PATH';

  if (actual.startsWith('\\\\?\\') && canonicalDrivePath(actual.slice(4)) &&
      samePath(actual.slice(4), expected)) {
    return 'EXTENDED_PATH_ALIAS';
  }
  if (canonicalDrivePath(actual)) {
    const appContainer = /\\Packages\\sandbox\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\AC(\\Temp)?$/i.exec(actual);
    if (appContainer && kind === 'temp' && appContainer[1]) return 'APP_CONTAINER_TEMP';
    if (appContainer && kind === 'home' && !appContainer[1]) return 'APP_CONTAINER_PROFILE';
  }
  return 'OTHER_PATH';
}

const cwdMatches = process.argv.length === 2 && (side === 'baseline' || side === 'candidate') &&
  path.basename(cwd) === 'checkout' && path.basename(caseRoot) === side &&
  path.basename(admissionRoot) === 'admission';
const workspace = path.join(caseRoot, 'workspace');
const scratchTemp = path.join(caseRoot, 'scratch-temp');
const scratchHome = path.join(caseRoot, 'scratch-home');
const trustedSource = path.join(admissionRoot, 'trusted-source');

const started = cwdMatches && writeMarker(path.join(workspace, 'started.txt')) === 'ALLOWED';
const scratchEnvironment = Object.fromEntries([
  ...['TEMP', 'TMP', 'TMPDIR'].map((key) => [key, scratchTemp, 'temp']),
  ...['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].map((key) => [key, scratchHome, 'home']),
  ['NPM_CONFIG_CACHE', path.join(scratchHome, 'npm-cache')],
  ['NPM_CONFIG_USERCONFIG', path.join(scratchHome, 'user.npmrc')],
  ['NPM_CONFIG_GLOBALCONFIG', path.join(scratchHome, 'global.npmrc')],
].map(([key, expected, kind]) => [key, classifyScratchPath(process.env[key], expected, kind)]));
const result = {
  side: side === 'baseline' || side === 'candidate' ? side : 'unverified',
  cwdMatches,
  checkoutRead: started && readMarker(path.join(cwd, 'input.txt'), 'clue-admission-checkout-v1\n'),
  trustedSourceRead: started && readMarker(path.join(trustedSource, 'trusted.txt'), 'clue-admission-source-v1\n'),
  workspaceWrite: started && writeMarker(path.join(workspace, 'workspace-write.txt')) === 'ALLOWED',
  tempWrite: started && writeMarker(path.join(scratchTemp, 'temp-write.txt')) === 'ALLOWED',
  homeWrite: started && writeMarker(path.join(scratchHome, 'home-write.txt')) === 'ALLOWED',
  checkoutWrite: started ? writeMarker(path.join(cwd, 'checkout-write.txt')) : 'UNVERIFIED',
  sourceWriteDenied: started && writeMarker(path.join(trustedSource, 'source-write.txt')) === 'DENIED',
  outsideReadDenied: started && readDenied(path.join(caseRoot, 'outside', 'forbidden.txt')),
  privateReadDenied: started && readDenied(path.join(caseRoot, 'private', 'sealed.txt')),
  hostEnvironmentAbsent: ['CLU_ADMISSION_HOST_SENTINEL', 'OPENAI_API_KEY', 'CLU_WINDOWS_SUPERVISOR_PATH']
    .every((key) => process.env[key] === undefined),
  scratchEnvironmentMatches: Object.values(scratchEnvironment).every((value) => value === 'MATCH'),
  scratchEnvironment,
};

console.log('CLU_E_ADMISSION_FIXTURE ' + JSON.stringify(result));
const expectedCheckout = side === 'baseline' ? 'DENIED' : 'ALLOWED';
process.exitCode = Object.entries(result).every(([key, value]) => {
  if (key === 'side') return cwdMatches;
  if (key === 'checkoutWrite') return value === expectedCheckout;
  if (key === 'scratchEnvironment') return true;
  return value === true;
}) ? 0 : 1;
