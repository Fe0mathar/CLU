#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { externalReportPath, writeExternalReport } from './verification-support.mjs';
import { exerciseGovernedWorkload } from './windows-supervisor/governedWorkloadHarness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node tools/p2-windows-governed-workload-diagnostic.mjs --stage <staged admission dir> --supervisor <staged supervisor> --output <staged report>';

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

async function approve({ source, cache }) {
  console.log(`Committed Git HEAD ${source.head.slice(0, 12)} | ${source.scopeSha256}`);
  console.log(`Dependency lock | ${source.lockSha256}`);
  console.log(`Master Benchmark contract | ${source.benchmarkSha256}`);
  console.log(`Installed npm CLI | ${source.npmCliSha256}`);
  console.log(`Native SQLite cache archive | ${cache.prebuild.sha256}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const consoleInput = createInterface({ input: process.stdin, output: process.stdout });
  const cancel = new AbortController();
  const deadline = setTimeout(() => cancel.abort(), 120_000);
  consoleInput.once('SIGINT', () => cancel.abort());
  try {
    const answer = await consoleInput.question('Type RUN GOVERNED to approve this committed source and the staged offline inputs: ', { signal: cancel.signal });
    return answer.trim() === 'RUN GOVERNED';
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
    'broker-doctor': 'Checking the direct CLU-E doctor --deep request.',
  }[phase];
  if (message) console.log(message);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else if (args.length !== 6 || args[0] !== '--stage' || args[2] !== '--supervisor' || args[4] !== '--output') {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    const stage = checkedPath(args[1], true);
    const outer = dirname(stage);
    const physicalRoot = realpathSync.native(root);
    const expectedExe = join(outer, 'bin', 'CLU-E-Windows-Supervisor.exe');
    const expectedOutput = join(outer, 'admission-result.json');
    if (basename(stage) !== 'admission' || !/^\.setup-[0-9a-f]{32}$/u.test(basename(outer)) ||
        !isAbsolute(args[3]) || relative(expectedExe, args[3]) !== '' ||
        !isAbsolute(args[5]) || relative(expectedOutput, args[5]) !== '' ||
        inside(physicalRoot, outer) || inside(outer, physicalRoot) || readdirSync(stage).length !== 0 ||
        lstatSync(expectedOutput, { throwIfNoEntry: false }) !== undefined) throw new Error('STAGE_SCOPE_UNVERIFIED');
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
      report = await exerciseGovernedWorkload({
        repoRoot: physicalRoot, stage, supervisor, node, systemRoot, script: bytes.toString('ascii'), approve, progress,
      });
    }
    writeExternalReport(physicalRoot, output, report);
    console.log(`Windows governed workload ${report.state}`);
    if (report.state !== 'GOVERNED_WORKLOAD_OBSERVED') process.exitCode = 1;
  } catch {
    console.error('Windows governed workload diagnostic could not produce a staged report.');
    process.exitCode = 2;
  }
}
