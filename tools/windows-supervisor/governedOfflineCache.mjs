import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const MiB = 1024 * 1024;
const MAX_LOCK = 2 * MiB;
const MAX_TARBALL = 16 * MiB;
const MAX_CACHE = 64 * MiB;
const MAX_PREBUILD = 12 * MiB;
const MAX_UNPACKED = 48 * MiB;
const MAX_PACKAGES = 512;
const PACKAGE_NAME = '(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+';
const LOCK_PACKAGE_PATH = new RegExp(`^node_modules/${PACKAGE_NAME}(?:/node_modules/${PACKAGE_NAME})*$`, 'u');
const SHA512 = /^sha512-([A-Za-z0-9+/]{86}==)$/u;
const NATIVE_VERSION = '11.10.0';

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

function refuse(code) {
  throw new Error(code);
}

function contained(parent, path) {
  const difference = relative(parent, path);
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith('..' + sep));
}

function physicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) ||
      (process.platform === 'win32' && !/^[A-Za-z]:[\\/](?![\\/])/u.test(path))) refuse('OFFLINE_CACHE_PATH_INVALID');
  const canonical = resolve(path);
  const status = lstatSync(canonical, { throwIfNoEntry: false });
  if (!status?.isDirectory() || relative(canonical, realpathSync.native(canonical)) !== '') {
    refuse('OFFLINE_CACHE_PATH_INVALID');
  }
  return canonical;
}

function sourceRoot(configured) {
  if (configured !== undefined) return { root: physicalDirectory(configured), kind: 'EXPLICIT' };
  for (const [envKey, kind] of [['LOCALAPPDATA', 'LOCAL_NPM_CACHE'], ['APPDATA', 'ROAMING_NPM_CACHE']]) {
    const base = process.env[envKey];
    if (!base || !isAbsolute(base)) continue;
    try {
      const root = physicalDirectory(join(base, 'npm-cache'));
      physicalDirectory(join(root, '_cacache'));
      return { root, kind };
    } catch { /* Try the other standard npm cache root. */ }
  }
  refuse('OFFLINE_NPM_CACHE_UNAVAILABLE');
}

function sameFile(before, after) {
  return after.isFile() && after.nlink === 1n && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function readBoundedFile(path, max) {
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (before === undefined) return null;
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(max) ||
      relative(path, realpathSync.native(path)) !== '') refuse('OFFLINE_CACHE_FILE_INVALID');
  const file = openSync(path, 'r');
  try {
    const opened = fstatSync(file, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== before.size) refuse('OFFLINE_CACHE_FILE_INVALID');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(file, bytes, offset, bytes.length - offset, offset);
      if (count === 0) refuse('OFFLINE_CACHE_FILE_CHANGED');
      offset += count;
    }
    if (!sameFile(before, lstatSync(path, { bigint: true })) ||
        relative(path, realpathSync.native(path)) !== '') refuse('OFFLINE_CACHE_FILE_CHANGED');
    const final = openSync(path, 'r');
    try {
      if (!sameFile(opened, fstatSync(final, { bigint: true })) ||
          !sameFile(opened, fstatSync(file, { bigint: true }))) refuse('OFFLINE_CACHE_FILE_CHANGED');
    } finally {
      closeSync(final);
    }
    return bytes;
  } finally {
    closeSync(file);
  }
}

function allowsPlatform(list, value) {
  if (list === undefined) return true;
  const entries = typeof list === 'string' ? [list] : list;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 32 ||
      entries.some((entry) => typeof entry !== 'string' || !/^!?[a-z0-9_-]+$/u.test(entry))) {
    refuse('OFFLINE_LOCKFILE_INVALID');
  }
  if (value === undefined) return false;
  if (entries.length === 1 && entries[0] === 'any') return true;
  if (entries.includes('!' + value)) return false;
  return entries.includes(value) || entries.every((entry) => entry.startsWith('!'));
}

function lockedPackages(lock, platform, architecture, libc) {
  if (lock?.lockfileVersion !== 3 || lock.packages === null || typeof lock.packages !== 'object' ||
      Array.isArray(lock.packages) || !Object.hasOwn(lock.packages, '')) refuse('OFFLINE_LOCKFILE_INVALID');
  const entries = Object.entries(lock.packages);
  if (entries.length > MAX_PACKAGES + 1) refuse('OFFLINE_LOCKFILE_INVALID');
  const packages = [];
  for (const [location, entry] of entries) {
    if (location === '') continue;
    if (location.length > 512 || !LOCK_PACKAGE_PATH.test(location) || !entry || entry.link || entry.inBundle ||
        typeof entry.version !== 'string' || !/^[0-9][A-Za-z0-9.+-]{0,95}$/u.test(entry.version) ||
        typeof entry.resolved !== 'string' || !/^https:\/\/registry\.npmjs\.org\/[A-Za-z0-9_@.\/%+~-]+\.tgz$/u.test(entry.resolved)) {
      refuse('OFFLINE_LOCKFILE_INVALID');
    }
    const matches = typeof entry.integrity === 'string' && SHA512.exec(entry.integrity);
    if (!matches) refuse('OFFLINE_LOCKFILE_INVALID');
    const expected = Buffer.from(matches[1], 'base64');
    if (expected.length !== 64 || expected.toString('base64') !== matches[1]) refuse('OFFLINE_LOCKFILE_INVALID');
    const osOk = allowsPlatform(entry.os, platform);
    const cpuOk = allowsPlatform(entry.cpu, architecture);
    const libcOk = allowsPlatform(entry.libc, libc);
    if (!(osOk && cpuOk && libcOk)) {
      if (entry.optional === true) continue;
      refuse('OFFLINE_NPM_REQUIRED_PLATFORM_MISMATCH');
    }
    const name = location.split('node_modules/').at(-1);
    packages.push({ id: name + '@' + entry.version, digest: expected.toString('hex') });
  }
  return packages.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function contentPath(digest) {
  return ['_cacache', 'content-v2', 'sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4)];
}

function nativeFilename(abi) {
  const basename = `better-sqlite3-v${NATIVE_VERSION}-node-v${abi}-win32-x64.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${NATIVE_VERSION}/${basename}`;
  return hash('sha512', url).slice(0, 6) + '-' + basename;
}

function inspectNativeExports(bytes, abi) {
  if (bytes.length < 512 || bytes.toString('ascii', 0, 2) !== 'MZ') return false;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 ||
      bytes.readUInt16LE(pe + 4) !== 0x8664 || !(bytes.readUInt16LE(pe + 22) & 0x2000)) return false;
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const sections = optional + optionalSize;
  if (sectionCount < 1 || sectionCount > 96 || optionalSize < 120 ||
      sections + 40 * sectionCount > bytes.length || bytes.readUInt16LE(optional) !== 0x20b ||
      bytes.readUInt32LE(optional + 108) < 1 || bytes.readUInt32LE(optional + 116) < 40) return false;

  function rawOffset(rva, length) {
    for (let index = 0; index < sectionCount; index++) {
      const section = sections + index * 40;
      const start = bytes.readUInt32LE(section + 12);
      const size = bytes.readUInt32LE(section + 16);
      const fileOffset = bytes.readUInt32LE(section + 20);
      if (rva >= start && rva - start + length <= size && fileOffset + rva - start + length <= bytes.length) {
        return fileOffset + rva - start;
      }
    }
    return -1;
  }

  const table = rawOffset(bytes.readUInt32LE(optional + 112), 40);
  if (table < 0) return false;
  const count = bytes.readUInt32LE(table + 24);
  if (count < 1 || count > 4096) return false;
  const names = rawOffset(bytes.readUInt32LE(table + 32), count * 4);
  if (names < 0) return false;
  const symbol = Buffer.from('node_register_module_v' + abi + '\0', 'ascii');
  for (let index = 0; index < count; index++) {
    const name = rawOffset(bytes.readUInt32LE(names + index * 4), symbol.length);
    if (name >= 0 && bytes.subarray(name, name + symbol.length).equals(symbol)) return true;
  }
  return false;
}

function tarText(header, start, length) {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? length : nul).toString('latin1');
}

function tarNumber(header, start, length) {
  const value = header.subarray(start, start + length).toString('latin1').replace(/[\0 ]+$/u, '').trimStart();
  return /^[0-7]+$/u.test(value) ? Number.parseInt(value, 8) : NaN;
}

function validNativeArchive(compressed, abi) {
  let archive;
  try { archive = gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED }); }
  catch { return false; }
  let position = 0;
  let binary = null;
  const entries = new Set();
  while (position + 512 <= archive.length) {
    const header = archive.subarray(position, position + 512);
    if (header.every((value) => value === 0)) {
      return archive.length - position >= 1024 && archive.subarray(position).every((value) => value === 0) &&
        binary !== null && inspectNativeExports(binary, abi);
    }
    if (entries.size >= 4 || !tarText(header, 257, 6).startsWith('ustar') || tarText(header, 345, 155) !== '') return false;
    let checksum = 0;
    for (let index = 0; index < header.length; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== tarNumber(header, 148, 8)) return false;
    const name = tarText(header, 0, 100).replace(/^\.\//u, '').replace(/\/$/u, '');
    if (entries.has(name)) return false;
    entries.add(name);
    const size = tarNumber(header, 124, 12);
    const type = header[156];
    const data = position + 512;
    if (!Number.isSafeInteger(size) || size < 0 || data + size > archive.length) return false;
    if (type === 53) {
      if (size !== 0 || !['', 'build', 'build/Release'].includes(name)) return false;
    } else if ((type === 0 || type === 48) && name === 'build/Release/better_sqlite3.node' && binary === null) {
      binary = archive.subarray(data, data + size);
    } else {
      return false;
    }
    position = data + Math.ceil(size / 512) * 512;
  }
  return false;
}

function writeCacheFile(root, components, data) {
  let parent = root;
  for (const component of components.slice(0, -1)) {
    const next = join(physicalDirectory(parent), component);
    if (lstatSync(next, { throwIfNoEntry: false }) === undefined) mkdirSync(next);
    parent = physicalDirectory(next);
  }
  writeFileSync(join(physicalDirectory(parent), components.at(-1)), data, { flag: 'wx' });
}

export function stageGovernedOfflineCache({
  lockfile, sourceCache = process.env.CLU_OFFLINE_NPM_CACHE, destinationCache,
  platform = process.platform, architecture = process.arch, abi = process.versions.modules, libc,
}) {
  const report = {
    state: 'BLOCKED', blocker: null, sourceKind: null, packageCount: 0, contentCount: 0,
    missingPackageCount: 0, missingPackageIds: [], lockfileSha256: null, manifestSha256: null,
    prebuild: { state: 'NOT_CHECKED', abi: null, filename: null, sha256: null },
  };
  let context = 'OFFLINE_LOCKFILE_INVALID';
  try {
    if (typeof lockfile !== 'string' || !isAbsolute(lockfile)) refuse(context);
    const bytes = readBoundedFile(resolve(lockfile), MAX_LOCK);
    if (bytes === null) refuse(context);
    const lock = JSON.parse(bytes.toString('utf8'));
    const packages = lockedPackages(lock, platform, architecture, libc);
    report.lockfileSha256 = hash('sha256', bytes);
    report.packageCount = packages.length;

    context = 'OFFLINE_NPM_CACHE_UNAVAILABLE';
    const { root: source, kind } = sourceRoot(sourceCache);
    report.sourceKind = kind;
    const destination = physicalDirectory(destinationCache);
    if (contained(source, destination) || contained(destination, source) || readdirSync(destination).length !== 0) {
      refuse('OFFLINE_CACHE_DESTINATION_UNSAFE');
    }

    context = 'OFFLINE_NPM_PACKAGE_INTEGRITY_FAILED';
    const content = new Map();
    const missing = new Set();
    let totalBytes = 0;
    for (const { id, digest } of packages) {
      if (!content.has(digest)) {
        const tarball = readBoundedFile(join(source, ...contentPath(digest)), MAX_TARBALL);
        if (tarball !== null) {
          if (hash('sha512', tarball) !== digest || totalBytes + tarball.length > MAX_CACHE) refuse(context);
          totalBytes += tarball.length;
        }
        content.set(digest, tarball);
      }
      if (content.get(digest) === null) missing.add(id);
    }
    report.missingPackageCount = missing.size;
    report.missingPackageIds = [...missing].slice(0, 32);
    if (missing.size !== 0) refuse('OFFLINE_NPM_PACKAGE_MISSING');

    let prebuild = null;
    const sqlite = lock.packages['node_modules/better-sqlite3'];
    if (sqlite !== undefined) {
      context = 'OFFLINE_SQLITE_PREBUILD_INVALID';
      if (platform !== 'win32' || architecture !== 'x64' || sqlite.version !== NATIVE_VERSION ||
          typeof abi !== 'string' || !/^[1-9][0-9]{1,4}$/u.test(abi)) {
        report.prebuild.state = 'UNSUPPORTED';
        refuse('OFFLINE_SQLITE_PLATFORM_UNSUPPORTED');
      }
      const filename = nativeFilename(abi);
      report.prebuild = { state: 'INVALID', abi, filename, sha256: null };
      prebuild = readBoundedFile(join(source, '_prebuilds', filename), MAX_PREBUILD);
      if (prebuild === null) {
        report.prebuild.state = 'MISSING';
        refuse('OFFLINE_SQLITE_PREBUILD_MISSING');
      }
      if (!validNativeArchive(prebuild, abi)) refuse(context);
      report.prebuild.state = 'VERIFIED_LOCAL_BYTES';
      report.prebuild.sha256 = hash('sha256', prebuild);
    } else {
      report.prebuild.state = 'NOT_REQUIRED';
    }

    context = 'OFFLINE_CACHE_STAGE_FAILED';
    const manifest = [];
    for (const [digest, tarball] of content) {
      writeCacheFile(destination, contentPath(digest), tarball);
      manifest.push({ sha512: digest, sha256: hash('sha256', tarball), bytes: tarball.length });
    }
    if (prebuild !== null) writeCacheFile(destination, ['_prebuilds', report.prebuild.filename], prebuild);
    manifest.sort((a, b) => a.sha512 < b.sha512 ? -1 : a.sha512 > b.sha512 ? 1 : 0);
    report.contentCount = content.size;
    report.manifestSha256 = hash('sha256', JSON.stringify({
      lockfileSha256: report.lockfileSha256, platform, architecture, content: manifest, prebuild: report.prebuild,
    }));
    report.state = 'READY';
  } catch (error) {
    report.blocker = /^OFFLINE_[A-Z0-9_]{3,64}$/u.test(error?.message) ? error.message : context;
  }
  return report;
}
