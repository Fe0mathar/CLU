#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { externalReportPath, writeExternalReport } from './verification-support.mjs';
import { exerciseReviewedWorkloads } from './windows-supervisor/reviewedWorkloadHarness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node tools/p2-windows-reviewed-workload-diagnostic.mjs --stage <staged admission dir> --supervisor <staged supervisor> --output <staged report>';

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

async function approve(source) {
  console.log(`Baseline Git HEAD ${source.baseline.head.slice(0, 12)} | ${source.baseline.scopeSha256}`);
  console.log(`Candidate current dashboard files | ${source.candidate.scopeSha256}`);
  console.log(`Changed dashboard files (${source.changedPaths.length}):`);
  for (const path of source.changedPaths) console.log(`  ${path}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const consoleInput = createInterface({ input: process.stdin, output: process.stdout });
  const cancel = new AbortController();
  const deadline = setTimeout(() => cancel.abort(), 120_000);
  consoleInput.once('SIGINT', () => cancel.abort());
  try {
    const answer = await consoleInput.question('If you reviewed these changes, type RUN REVIEWED to test both copies: ', { signal: cancel.signal });
    return answer.trim() === 'RUN REVIEWED';
  } catch {
    return false;
  } finally {
    clearTimeout(deadline);
    consoleInput.close();
  }
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
      schemaVersion: 'clue-windows-reviewed-workload/1', state: 'NATIVE_WINDOWS_REQUIRED',
      proofAuthorization: false, stageCleanupSafe: true, cases: {},
    };
    if (process.platform === 'win32') {
      const supervisor = checkedPath(args[3], false);
      const node = checkedPath(realpathSync.native(process.execPath), false);
      const systemRoot = checkedPath(realpathSync.native(process.env.SystemRoot ?? 'C:\\Windows'), true);
      const fixture = checkedPath(join(physicalRoot, 'tools', 'windows-supervisor', 'ReviewedWorkloadBootstrap.cjs'), false);
      const bytes = readFileSync(fixture);
      if (bytes.length < 1 || bytes.length > 12 * 1024 || bytes.some((byte) => byte === 0 || byte > 127)) throw new Error('BOOTSTRAP_BYTES_UNVERIFIED');
      report = await exerciseReviewedWorkloads({ repoRoot: physicalRoot, stage, supervisor, node, systemRoot, script: bytes.toString('ascii'), approve });
    }
    writeExternalReport(physicalRoot, output, report);
    console.log(`Windows reviewed workload ${report.state}`);
    if (report.state !== 'REVIEWED_WORKLOADS_OBSERVED') process.exitCode = 1;
  } catch {
    console.error('Windows reviewed workload diagnostic could not produce a staged report.');
    process.exitCode = 2;
  }
}
