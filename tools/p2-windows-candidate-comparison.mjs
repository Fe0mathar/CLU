#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { availableParallelism, release, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { externalReportPath, writeExternalReport } from './verification-support.mjs';
import { runDashboardComparison } from './windows-host-test/dashboardComparison.mjs';
import { prepareDashboardComparisonInputs } from './windows-host-test/dashboardTestInputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const defaultReport = join(dirname(root), 'release-evidence', `CLU-E_WINDOWS_CANDIDATE_COMPARISON_${stamp}_${randomBytes(4).toString('hex')}.json`);
const usage = 'Usage: node tools/p2-windows-candidate-comparison.mjs [--output <new external .json>]';

function requestedOutput(args) {
  if (args.length === 0) return defaultReport;
  if (args.length === 2 && args[0] === '--output' && /\.json$/iu.test(args[1])) return args[1];
  throw new Error('OPTIONS_INVALID');
}

function inside(parent, child) {
  const delta = relative(parent, child);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

async function confirmReviewed(inputs, signal) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || signal.aborted) return false;
  console.log(`Baseline: Git HEAD ${inputs.head.slice(0, 12)} · ${inputs.baselineSha256}`);
  console.log(`Candidate: current dashboard files · ${inputs.candidateSha256}`);
  console.log(`Changed dashboard files (${inputs.changedPaths.length}):`);
  for (const path of inputs.changedPaths.slice(0, 20)) console.log(`  ${path}`);
  if (inputs.changedPaths.length > 20) console.log('  The report lists all changed paths.');
  console.log('The copied code will run on your Windows PC with your current user permissions.');
  const consoleInput = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await consoleInput.question('If you reviewed and trust these changes, type COMPARE to run: ', { signal });
    return answer.trim().toUpperCase() === 'COMPARE';
  } catch {
    return false;
  } finally {
    consoleInput.close();
  }
}

async function compare(signal) {
  const report = {
    schemaVersion: 'clue-windows-reviewed-candidate-comparison/1',
    checkedAt: new Date().toISOString(),
    state: 'NATIVE_WINDOWS_REQUIRED',
    executionEnvironment: process.platform === 'win32' ? 'WINDOWS_HOST' : null,
    selectionReason: 'OPERATOR_REVIEWED_DASHBOARD_COMPARISON',
    proofAuthorization: false,
    approval: 'NOT_REQUESTED',
    cleanup: 'NOT_REQUIRED',
    host: {
      platform: process.platform, architecture: process.arch, osRelease: release(), nodeVersion: process.version,
      logicalParallelism: availableParallelism(), memoryGiB: Math.round(totalmem() / 2 ** 30),
    },
    source: null,
    comparison: null,
  };
  if (process.platform !== 'win32') return report;

  let stage;
  try {
    report.state = 'HOST_REVIEWED_COMPARISON_INPUTS_UNVERIFIED';
    const physicalRoot = realpathSync.native(root);
    const temp = realpathSync.native(tmpdir());
    if (inside(physicalRoot, temp)) throw new Error('HOST_TEST_COMPARISON_STAGE_OVERLAP');
    stage = mkdtempSync(join(temp, 'CLU-E-reviewed-'));
    const roots = { baseline: join(stage, 'baseline'), candidate: join(stage, 'candidate') };
    for (const path of Object.values(roots)) mkdirSync(path);
    const inputs = prepareDashboardComparisonInputs(physicalRoot, roots.baseline, roots.candidate);
    report.source = {
      baseline: { kind: 'COMMITTED_HEAD', head: inputs.head, scopeSha256: inputs.baselineSha256 },
      candidate: { kind: 'CURRENT_DASHBOARD', dirty: inputs.dirty, scopeSha256: inputs.candidateSha256 },
      changedPaths: inputs.changedPaths, fileCount: inputs.fileCount,
      sameTestFiles: true, testFileCount: inputs.trackedTestPaths.length,
    };
    if (inputs.changedPaths.length === 0) {
      report.state = 'HOST_REVIEWED_COMPARISON_NO_DASHBOARD_CHANGES';
      return report;
    }

    report.state = 'HOST_REVIEWED_COMPARISON_APPROVAL_REQUIRED';
    report.approval = 'AWAITING_OPERATOR';
    if (!await confirmReviewed(inputs, signal)) {
      report.approval = 'NOT_GRANTED';
      return report;
    }
    report.approval = 'OPERATOR_APPROVED_SCOPED_COPIES';
    report.state = 'HOST_REVIEWED_COMPARISON_EXECUTION_UNVERIFIED';
    report.comparison = await runDashboardComparison({
      node: realpathSync.native(process.execPath),
      roots,
      inputs,
      signal,
      progress: (round, side) => console.log(`Round ${round}/2 · testing the ${side} copy on Windows.`),
    });
    report.state = report.comparison.state;
  } catch (error) {
    if (/^HOST_TEST_[A-Z0-9_]{1,64}$/u.test(error.message)) report.inputBlocker = error.message;
  } finally {
    if (stage !== undefined) {
      report.cleanup = 'RETAINED';
      try {
        const entry = lstatSync(stage, { throwIfNoEntry: false });
        if (entry === undefined || (entry.isDirectory() && relative(stage, realpathSync.native(stage)) === '')) {
          rmSync(stage, { recursive: true, force: true, maxRetries: 2 });
          report.cleanup = 'REMOVED';
        }
      } catch { }
      if (report.cleanup === 'RETAINED') {
        console.log(`Temporary comparison files retained at ${stage}`);
        if (report.state === 'HOST_REVIEWED_COMPARISON_COMPLETE') report.state = 'HOST_REVIEWED_COMPARISON_CLEANUP_UNVERIFIED';
      }
    }
    if (signal.aborted) report.state = 'HOST_REVIEWED_COMPARISON_INTERRUPTED';
  }
  return report;
}

if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
  console.log(usage);
} else {
  const interrupt = new AbortController();
  const cancel = () => interrupt.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const output = externalReportPath(root, requestedOutput(process.argv.slice(2)));
    if (lstatSync(output, { throwIfNoEntry: false }) !== undefined) throw new Error('OUTPUT_EXISTS');
    const report = await compare(interrupt.signal);
    const written = writeExternalReport(root, output, report);
    console.log(`Windows reviewed candidate comparison ${report.state}`);
    console.log(`Comparison report: ${written}`);
    if (report.state !== 'HOST_REVIEWED_COMPARISON_COMPLETE') process.exitCode = 1;
  } catch (error) {
    if (error.message === 'OPTIONS_INVALID') console.error(usage);
    else console.error('Could not produce the comparison report. Use a new .json path outside the project.');
    process.exitCode = 2;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
