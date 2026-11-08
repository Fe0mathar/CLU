#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { externalReportPath, writeExternalReport } from './verification-support.mjs';
import { exerciseGovernedWorkload } from './windows-supervisor/governedWorkloadHarness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node tools/p2-windows-governed-workload-diagnostic.mjs --stage <staged admission dir> --supervisor <supervisor> --output <staged report> [--installed|--installed-wfp|--installed-wfp-owner-loss <wrapper SHA-256> <engine SHA-256>]';
const sha256Pattern = /^[0-9a-f]{64}$/u;
const supervisorName = 'CLU-E-Windows-Supervisor.exe';
const engineName = 'wxc-exec.exe';
const maxInstalledImageBytes = 128n * 1024n * 1024n;

function inside(parent, child) {
  const delta = relative(parent, child);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

function checkedPath(path, directory) {
  if (!isAbsolute(path)) throw new Error('NONLOCAL_PATH');
  const entry = lstatSync(path);
  if ((directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1) ||
      relative(path, realpathSync.native(path)) !== '') throw new Error('PATH_IDENTITY_UNVERIFIED');
  return path;
}

function verifyInstalledImage(path, expectedSha256) {
  const file = checkedPath(path, false);
  const fd = openSync(file, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > maxInstalledImageBytes) {
      throw new Error('INSTALLED_IMAGE_FILE_UNVERIFIED');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (let remaining = Number(before.size); remaining > 0;) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) throw new Error('INSTALLED_IMAGE_READ_UNVERIFIED');
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.nlink !== 1n || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs || hash.digest('hex') !== expectedSha256) {
      throw new Error('INSTALLED_IMAGE_HASH_UNVERIFIED');
    }
    checkedPath(file, false);
  } finally {
    closeSync(fd);
  }
}

function verifyInstalledPair(supervisor, wrapperSha256, engineSha256) {
  const directory = dirname(supervisor);
  for (let current = directory; ; current = dirname(current)) {
    checkedPath(current, true);
    if (dirname(current) === current) break;
  }
  const entries = readdirSync(directory).sort();
  if (entries.length !== 2 || entries[0] !== supervisorName || entries[1] !== engineName) {
    throw new Error('INSTALLED_IMAGE_PAIR_UNVERIFIED');
  }
  verifyInstalledImage(supervisor, wrapperSha256);
  verifyInstalledImage(join(directory, engineName), engineSha256);
}

function verifyOwnerLossMode(supervisor, wrapperSha256, engineSha256) {
  const ready = checkedPath(join(dirname(dirname(supervisor)), 'ready.json'), false);
  const size = lstatSync(ready).size;
  if (size < 2 || size > 4096) throw new Error('OWNER_LOSS_IMAGE_MODE_UNVERIFIED');
  const receipt = JSON.parse(readFileSync(ready, 'utf8'));
  if (receipt === null || typeof receipt !== 'object' || Object.keys(receipt).length !== 4 ||
      receipt.schemaVersion !== 'clue-governed-wfp-owner-loss-installed-image/1' ||
      receipt.wrapperSha256 !== wrapperSha256 || receipt.engineSha256 !== engineSha256 ||
      !Number.isInteger(receipt.guardianPid) || receipt.guardianPid < 1 || receipt.guardianPid > 2147483647) {
    throw new Error('OWNER_LOSS_IMAGE_MODE_UNVERIFIED');
  }
}

async function approve({ source, cache, integratedWfp = false, ownerLoss = false }) {
  console.log(`Committed Git HEAD ${source.head.slice(0, 12)} | ${source.scopeSha256}`);
  console.log(`Dependency lock | ${source.lockSha256}`);
  console.log(`Master Benchmark contract | ${source.benchmarkSha256}`);
  console.log(`Installed npm CLI | ${source.npmCliSha256}`);
  console.log(`Native SQLite cache archive | ${cache.prebuild.sha256}`);
  if (ownerLoss) console.log('The owner-loss test terminates the disposable WFP guardian while the direct npm typecheck is held.');
  else if (integratedWfp) console.log('The direct npm typecheck runs with the scoped WFP lease after the control and deny checks.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const consoleInput = createInterface({ input: process.stdin, output: process.stdout });
  const cancel = new AbortController();
  const deadline = setTimeout(() => cancel.abort(), 120_000);
  consoleInput.once('SIGINT', () => cancel.abort());
  try {
    const confirmation = ownerLoss ? 'RUN OWNER LOSS' : 'RUN GOVERNED';
    const answer = await consoleInput.question(`Type ${confirmation} to approve this committed source and the staged offline inputs: `, { signal: cancel.signal });
    return answer.trim() === confirmation;
  } catch {
    return false;
  } finally {
    clearTimeout(deadline);
    consoleInput.close();
  }
}

function progress(phase) {
  const message = {
    candidate: 'Running offline install, typecheck, build and native SQLite inside MXC.',
    baseline: 'Initializing the disposable workspace and running SCN-005 from the read-only tree.',
    'broker-typecheck': 'Checking the direct npm typecheck request.',
    'broker-owner-loss': 'Testing WFP guardian loss while the direct npm typecheck remains held.',
    'broker-doctor': 'Checking the direct CLU-E doctor --deep request.',
  }[phase];
  if (message) console.log(message);
}

const args = process.argv.slice(2);
const ownerLoss = args[6] === '--installed-wfp-owner-loss';
const integratedWfp = args[6] === '--installed-wfp' || ownerLoss;
const installed = args.length === 9 && (args[6] === '--installed' || integratedWfp) &&
  args[7].length === 64 && args[8].length === 64 && sha256Pattern.test(args[7]) && sha256Pattern.test(args[8]);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else if ((args.length !== 6 && !installed) || args[0] !== '--stage' || args[2] !== '--supervisor' || args[4] !== '--output') {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    const stage = checkedPath(args[1], true);
    const outer = dirname(stage);
    const physicalRoot = realpathSync.native(root);
    let expectedExe = installed
      ? join(dirname(outer), 'installed-diagnostics', args[7], supervisorName)
      : join(outer, 'bin', supervisorName);
    if (integratedWfp) {
      if (process.platform !== 'win32' || !process.env.ProgramFiles) throw new Error('PROTECTED_INSTALL_ROOT_UNAVAILABLE');
      const programFiles = checkedPath(process.env.ProgramFiles, true);
      const id = basename(outer).slice('.setup-'.length);
      expectedExe = join(programFiles, `.clue-governed-wfp-${id}`, args[7], supervisorName);
    }
    const expectedOutput = join(outer, 'admission-result.json');
    if (basename(stage) !== 'admission' || !/^\.setup-[0-9a-f]{32}$/u.test(basename(outer)) ||
        !isAbsolute(args[3]) || (installed ? args[3] !== expectedExe : relative(expectedExe, args[3]) !== '') ||
        !isAbsolute(args[5]) || relative(expectedOutput, args[5]) !== '' ||
        inside(physicalRoot, outer) || inside(outer, physicalRoot) || readdirSync(stage).length !== 0 ||
        lstatSync(expectedOutput, { throwIfNoEntry: false }) !== undefined) throw new Error('STAGE_SCOPE_UNVERIFIED');
    if (installed && (inside(physicalRoot, dirname(expectedExe)) || inside(dirname(expectedExe), physicalRoot))) {
      throw new Error('INSTALLED_IMAGE_SCOPE_UNVERIFIED');
    }
    const output = externalReportPath(physicalRoot, expectedOutput);
    let report = {
      schemaVersion: 'clue-windows-governed-workload/1', state: 'NATIVE_WINDOWS_REQUIRED',
      proofAuthorization: false, stageCleanupSafe: true, cases: {},
    };
    if (process.platform === 'win32') {
      const supervisor = checkedPath(args[3], false);
      const node = checkedPath(realpathSync.native(process.execPath), false);
      const systemRoot = checkedPath(realpathSync.native(process.env.SystemRoot ?? 'C:\\Windows'), true);
      const fixture = checkedPath(join(physicalRoot, 'tools', 'windows-supervisor', 'GovernedWorkloadBootstrap.cjs'), false);
      const bytes = readFileSync(fixture);
      if (bytes.length < 1 || bytes.length > 16 * 1024 || bytes.some((byte) => byte === 0 || byte > 127)) throw new Error('BOOTSTRAP_BYTES_UNVERIFIED');
      if (installed) verifyInstalledPair(supervisor, args[7], args[8]);
      if (ownerLoss) verifyOwnerLossMode(supervisor, args[7], args[8]);
      let wfpPrelude;
      if (integratedWfp) {
        const prelude = checkedPath(join(physicalRoot, 'tools', 'windows-supervisor', 'GovernedWfpBindPrelude.cjs'), false);
        const preludeBytes = readFileSync(prelude);
        if (preludeBytes.length < 1 || preludeBytes.length > 4096 ||
            preludeBytes.some((byte) => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126))) {
          throw new Error('GOVERNED_WFP_PRELUDE_UNVERIFIED');
        }
        wfpPrelude = preludeBytes.toString('ascii');
      }
      report = await exerciseGovernedWorkload({
        repoRoot: physicalRoot, stage, supervisor, node, systemRoot, script: bytes.toString('ascii'), approve, progress,
        ...(integratedWfp ? { integratedWfp, wfpPrelude } : {}), ...(ownerLoss ? { ownerLoss } : {}),
      });
      if (installed) {
        verifyInstalledPair(supervisor, args[7], args[8]);
        report.installedImage = { wrapperSha256: args[7], engineSha256: args[8], verifiedBefore: true, verifiedAfter: true };
      }
    }
    writeExternalReport(physicalRoot, output, report);
    console.log(`Windows governed workload ${report.state}`);
    const expectedState = ownerLoss ? 'GOVERNED_WORKLOAD_OWNER_LOSS_OBSERVED' : 'GOVERNED_WORKLOAD_OBSERVED';
    if (report.state !== expectedState) process.exitCode = 1;
  } catch {
    console.error('Windows governed workload diagnostic could not produce a staged report.');
    process.exitCode = 2;
  }
}
