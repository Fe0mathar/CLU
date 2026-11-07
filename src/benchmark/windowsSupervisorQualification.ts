import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { hostname, release, userInfo, version } from 'node:os';
import { win32 } from 'node:path';

import { asSha256, hashBytes, type Sha256 } from '../shared/ids.js';
import type { WindowsExecutionSupervisor } from './windowsExecutionSupervisor.js';

const QUALIFICATION_PATH = 'CLU_WINDOWS_SUPERVISOR_QUALIFICATION';
const QUALIFICATION_SHA256 = 'CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256';
const MAX_RECEIPT_BYTES = 1024 * 1024;

export const WINDOWS_SUPERVISOR_QUALIFICATION_SCHEMA = 'clue-console-probe-native-supervisor/1';
export const WINDOWS_SUPERVISOR_QUALIFICATION_CASES = [
  'allowed-command',
  'filesystem-denied',
  'secrets-denied',
  'network-denied',
  'descendant-timeout',
  'launcher-cancellation',
  'tamper-refused',
] as const;

interface QualificationHost {
  readonly hostnameSha256: Sha256;
  readonly principalSha256: Sha256;
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly osVersion: string;
  readonly nodeVersion: string;
  readonly nodeSha256: Sha256;
}

let nodePin: { readonly identity: string; readonly sha256: Sha256 } | undefined;

function executableSha256(path: string): Sha256 {
  const fd = openSync(path, 'r');
  try {
    const identity = () => {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.size < 1n) throw new Error('The Node executable is not a regular file.');
      return [path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('\0');
    };
    const before = identity();
    if (nodePin?.identity === before) return nodePin.sha256;
    const hash = createHash('sha256');
    const block = Buffer.alloc(1024 * 1024);
    for (let count = readSync(fd, block); count > 0; count = readSync(fd, block)) {
      hash.update(block.subarray(0, count));
    }
    if (identity() !== before) throw new Error('The Node executable changed while its identity was read.');
    const sha256 = asSha256(hash.digest('hex'));
    if (sha256 === undefined) throw new Error('Unable to capture the Node executable identity.');
    nodePin = { identity: before, sha256 };
    return sha256;
  } finally {
    closeSync(fd);
  }
}

export function captureWindowsQualificationHost(): QualificationHost {
  if (process.platform !== 'win32') throw new Error('Native Windows supervisor qualification requires Windows.');
  const account = userInfo();
  return {
    hostnameSha256: hashBytes(Buffer.from(hostname())),
    principalSha256: hashBytes(Buffer.from(`${account.username}\0${account.homedir}`)),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    osVersion: version(),
    nodeVersion: process.version,
    nodeSha256: executableSha256(realpathSync.native(process.execPath)),
  };
}

export function windowsSupervisorPathSha256(path: string): Sha256 {
  return hashBytes(Buffer.from(win32.normalize(path)));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function verifyWindowsSupervisorQualificationReceipt(
  value: unknown,
  supervisor: WindowsExecutionSupervisor,
  host: QualificationHost,
): void {
  const receipt = object(value);
  if (receipt === null || receipt['schemaVersion'] !== WINDOWS_SUPERVISOR_QUALIFICATION_SCHEMA ||
    typeof receipt['checkedAt'] !== 'string' || !Number.isFinite(Date.parse(receipt['checkedAt'])) ||
    new Date(receipt['checkedAt']).toISOString() !== receipt['checkedAt']) {
    throw new Error('The Windows supervisor qualification receipt is malformed.');
  }
  if (receipt['supervisorSha256'] !== supervisor.sha256 ||
    receipt['supervisorPathSha256'] !== windowsSupervisorPathSha256(supervisor.command)) {
    throw new Error('Windows supervisor qualification does not match this installed executable and pin.');
  }
  const recordedHost = object(receipt['host']);
  if (recordedHost === null || Object.entries(host).some(([key, expected]) => recordedHost[key] !== expected)) {
    throw new Error('Windows supervisor qualification does not match the current host, account and Node toolchain.');
  }
  const cases = object(receipt['cases']);
  if (receipt['canaryStatus'] !== 'PASS' || receipt['fixtureRemoved'] !== true || cases === null ||
    WINDOWS_SUPERVISOR_QUALIFICATION_CASES.some((name) => cases[name] !== 'PASS')) {
    throw new Error('Windows supervisor qualification requires all mandatory pre-proof canaries to pass.');
  }
}

function inside(root: string, path: string): boolean {
  const delta = win32.relative(root, path);
  return delta === '' || (!win32.isAbsolute(delta) && delta !== '..' && !delta.startsWith('..\\'));
}

/**
 * Require a locally generated, operator-pinned acceptance receipt. The trusted launcher's
 * pin is the authorization. A report alone cannot establish continuing OS containment.
 */
export function requireWindowsSupervisorQualification(
  supervisor: WindowsExecutionSupervisor,
  environment: NodeJS.ProcessEnv = process.env,
  prohibitedRoots: readonly string[] = [],
): Sha256 {
  const configuredPath = environment[QUALIFICATION_PATH];
  const configuredHash = environment[QUALIFICATION_SHA256];
  if (configuredPath === undefined || configuredHash === undefined) {
    throw new Error(`Windows proof requires ${QUALIFICATION_PATH} and ${QUALIFICATION_SHA256}; execution refused.`);
  }
  if (!/^[A-Za-z]:[\\/](?![\\/])/u.test(configuredPath) || !/\.json$/iu.test(configuredPath) ||
    configuredPath.slice(3).split(/[\\/]/u).some((part) =>
      part === '' || /[<>:"|?*\u0000-\u001f]|[ .]$/u.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    throw new Error('The Windows supervisor qualification receipt must be a canonical local .json path.');
  }
  const expected = asSha256(configuredHash);
  if (expected === undefined) throw new Error(`${QUALIFICATION_SHA256} must be a lowercase SHA-256 digest.`);
  if (process.platform !== 'win32') throw new Error('Native Windows supervisor qualification requires Windows.');

  const path = win32.normalize(configuredPath);
  let bytes: Buffer;
  try {
    const physical = realpathSync.native(path);
    if (win32.relative(path, physical) !== '' || prohibitedRoots.some((root) => inside(root, physical))) {
      throw new Error('The receipt path is aliased or inside an execution root.');
    }
    const before = lstatSync(physical);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_RECEIPT_BYTES) {
      throw new Error('The receipt must be one regular unlinked file of at most 1 MiB.');
    }
    const fd = openSync(physical, 'r');
    try {
      const unchanged = () => {
        const current = fstatSync(fd);
        return current.dev === before.dev && current.ino === before.ino && current.nlink === 1 &&
          current.size === before.size && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs;
      };
      if (!unchanged()) throw new Error('The receipt changed before it was opened.');
      bytes = Buffer.alloc(before.size);
      const count = readSync(fd, bytes);
      if (count !== bytes.length || !unchanged()) throw new Error('The receipt changed during pin verification.');
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error('Cannot read the Windows supervisor qualification receipt. Use a regular file outside the execution roots.');
  }
  if (hashBytes(bytes) !== expected) throw new Error('The Windows supervisor qualification receipt does not match its SHA-256 pin.');
  let receipt: unknown;
  try {
    receipt = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('The Windows supervisor qualification receipt is malformed.');
  }
  verifyWindowsSupervisorQualificationReceipt(receipt, supervisor, captureWindowsQualificationHost());
  return expected;
}
