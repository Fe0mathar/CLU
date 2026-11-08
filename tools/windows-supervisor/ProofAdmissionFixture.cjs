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

const cwdMatches = process.argv.length === 2 && (side === 'baseline' || side === 'candidate') &&
  path.basename(cwd) === 'checkout' && path.basename(caseRoot) === side &&
  path.basename(admissionRoot) === 'admission';
const workspace = path.join(caseRoot, 'workspace');
const scratchTemp = path.join(caseRoot, 'scratch-temp');
const scratchHome = path.join(caseRoot, 'scratch-home');
const trustedSource = path.join(admissionRoot, 'trusted-source');

const started = cwdMatches && writeMarker(path.join(workspace, 'started.txt')) === 'ALLOWED';
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
  scratchEnvironmentMatches: ['TEMP', 'TMP', 'TMPDIR'].every((key) => samePath(process.env[key], scratchTemp)) &&
    ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].every((key) => samePath(process.env[key], scratchHome)) &&
    samePath(process.env.NPM_CONFIG_CACHE, path.join(scratchHome, 'npm-cache')) &&
    samePath(process.env.NPM_CONFIG_USERCONFIG, path.join(scratchHome, 'user.npmrc')) &&
    samePath(process.env.NPM_CONFIG_GLOBALCONFIG, path.join(scratchHome, 'global.npmrc')),
};

console.log('CLU_E_ADMISSION_FIXTURE ' + JSON.stringify(result));
const expectedCheckout = side === 'baseline' ? 'DENIED' : 'ALLOWED';
process.exitCode = Object.entries(result).every(([key, value]) => {
  if (key === 'side') return cwdMatches;
  if (key === 'checkoutWrite') return value === expectedCheckout;
  return value === true;
}) ? 0 : 1;
