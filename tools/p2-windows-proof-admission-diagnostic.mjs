#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { externalReportPath, writeExternalReport } from './verification-support.mjs';
import { exerciseProofAdmissionFixtures } from './windows-supervisor/proofAdmissionHarness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node tools/p2-windows-proof-admission-diagnostic.mjs --stage <staged admission dir> --supervisor <staged supervisor> --output <staged report>';

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
    const expectedExe = join(outer, 'bin', 'CLU-E-Windows-Supervisor.exe');
    const expectedOutput = join(outer, 'admission-result.json');
    if (basename(stage) !== 'admission' || !/^\.setup-[0-9a-f]{32}$/u.test(basename(outer)) ||
        relative(expectedExe, args[3]) !== '' || relative(expectedOutput, args[5]) !== '' ||
        !isAbsolute(args[5]) || inside(realpathSync.native(root), outer) || readdirSync(stage).length !== 0 ||
        lstatSync(expectedOutput, { throwIfNoEntry: false }) !== undefined) {
      throw new Error('STAGE_SCOPE_UNVERIFIED');
    }
    const output = externalReportPath(root, expectedOutput);
    let report;
    if (process.platform !== 'win32') {
      report = {
        schemaVersion: 'clue-windows-proof-admission-fixture/1', state: 'NATIVE_WINDOWS_REQUIRED',
        proofAuthorization: false, stageCleanupSafe: true, cases: {}, refusals: {},
      };
    } else {
      const supervisor = checkedPath(args[3], false);
      const node = checkedPath(realpathSync.native(process.execPath), false);
      const systemRoot = checkedPath(realpathSync.native(process.env.SystemRoot ?? 'C:\\Windows'), true);
      const fixture = checkedPath(join(root, 'tools', 'windows-supervisor', 'ProofAdmissionFixture.cjs'), false);
      const bytes = readFileSync(fixture);
      if (bytes.length < 1 || bytes.length > 8192 || bytes.some((byte) => byte === 0 || byte > 127)) {
        throw new Error('FIXTURE_BYTES_UNVERIFIED');
      }
      report = await exerciseProofAdmissionFixtures({ stage, supervisor, node, systemRoot, script: bytes.toString('ascii') });
    }
    writeExternalReport(root, output, report);
    console.log(`Windows proof admission diagnostic ${report.state}`);
    if (report.state !== 'PRODUCTION_SHAPED_FIXTURES_OBSERVED') process.exitCode = 1;
  } catch {
    console.error('Windows proof admission diagnostic could not produce a staged report.');
    process.exitCode = 2;
  }
}
