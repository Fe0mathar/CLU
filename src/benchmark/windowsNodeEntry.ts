import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { hashBytes } from '../shared/ids.js';

const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const ENTRY_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const DEVICE_COMPONENT = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\s*\.|$)/iu;

// This runs after the pinned supervisor arms the native boundary. The original
// entry path and arguments go to Node's own CLI, including its CJS/ESM handling.
const ENTRY_BOOTSTRAP = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [entry, pin, ...args] = process.argv.slice(1);
const flags = [];
try {
  const before = fs.lstatSync(entry, { bigint: true });
  const exact = (stat) => stat.isFile() && stat.nlink === 1n && stat.ino === before.ino &&
    stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
  if (!exact(before) || before.size > ${MAX_ENTRY_BYTES}n || path.relative(entry, fs.realpathSync.native(entry)) !== '') {
    throw new Error('Invalid entry');
  }
  const fd = fs.openSync(entry, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!exact(opened) || (opened.dev !== before.dev && (before.dev !== 0n || before.ino === 0n))) {
      throw new Error('Entry changed before open');
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Entry truncated');
      offset += count;
    }
    const finalHandle = fs.fstatSync(fd, { bigint: true });
    const finalPath = fs.lstatSync(entry, { bigint: true });
    if (createHash('sha256').update(bytes).digest('hex') !== pin || !exact(finalHandle) || finalHandle.dev !== opened.dev ||
        !exact(finalPath) || finalPath.dev !== before.dev ||
        path.relative(entry, fs.realpathSync.native(entry)) !== '') throw new Error('Entry changed');
  } finally { fs.closeSync(fd); }
  try {
    if (path.relative(entry, fs.realpathSync(entry)) !== '') throw new Error('Aliased entry');
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
    // MXC can admit the exact file while denying JS's parent-by-parent path walk.
    flags.push('--preserve-symlinks', '--preserve-symlinks-main');
    console.error('[CLU-E proof entry] PATH_WALK_COMPATIBILITY');
  }
} catch {
  console.error('[CLU-E proof entry] ENTRY_POINT_UNVERIFIED');
  process.exit(1);
}
const child = require('node:child_process').spawn(process.execPath, [...flags, entry, ...args], {
  cwd: process.cwd(), env: process.env, shell: false, stdio: 'inherit', windowsHide: true,
});
child.once('error', () => {
  console.error('[CLU-E proof entry] ENTRY_LAUNCH_FAILED');
  process.exitCode = 1;
});
child.once('exit', (code) => { process.exitCode = code === null ? 1 : code; });
`;

function sameFile(before: BigIntStats, current: BigIntStats): boolean {
  return current.isFile() && current.nlink === 1n && current.ino === before.ino &&
    current.size === before.size && current.mtimeNs === before.mtimeNs && current.ctimeNs === before.ctimeNs;
}

/** Add the in-boundary path-walk check only for a verified project entry point. */
export function windowsNodeEntryArgs(args: readonly string[], cwd: string, roots: readonly string[]): readonly string[] {
  const [name, ...rest] = args;
  if (name === undefined || name.startsWith('-') || !ENTRY_EXTENSIONS.has(extname(name).toLowerCase()) || args.length > 252) {
    return args;
  }
  // Keep unsupported command shapes on the native request validation path.
  const originalParts = name.replace(/^[A-Za-z]:[\\/]/u, '').split(/[\\/]/u);
  if (originalParts.some((part) => part === '' || /[. ]$|[\x00-\x1f"<>:|?*]/u.test(part) || DEVICE_COMPONENT.test(part))) {
    return args;
  }
  const entry = resolve(cwd, name);
  const local = roots.map((root) => ({ root, path: relative(root, entry) })).find(({ path }) =>
    path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  if (local === undefined) return args;

  try {
    const parts = local.path.split(sep);
    let checked = local.root;
    for (const part of parts.slice(0, -1)) {
      checked = join(checked, part);
      if (!lstatSync(checked).isDirectory()) return args;
    }
    if (relative(entry, realpathSync.native(entry)) !== '') return args;
    const before = lstatSync(entry, { bigint: true });
    if (!sameFile(before, before) || before.size > MAX_ENTRY_BYTES) return args;
    const fd = openSync(entry, 'r');
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!sameFile(before, opened) || (opened.dev !== before.dev && (before.dev !== 0n || before.ino === 0n))) return args;
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) return args;
        offset += count;
      }
      const finalHandle = fstatSync(fd, { bigint: true });
      const finalPath = lstatSync(entry, { bigint: true });
      if (!sameFile(before, finalHandle) || finalHandle.dev !== opened.dev || !sameFile(before, finalPath) ||
          finalPath.dev !== before.dev || relative(entry, realpathSync.native(entry)) !== '') return args;
      return ['-e', ENTRY_BOOTSTRAP, '--', entry, hashBytes(bytes), ...rest];
    } finally { closeSync(fd); }
  } catch {
    return args;
  }
}
