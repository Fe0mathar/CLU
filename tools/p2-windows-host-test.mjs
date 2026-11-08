#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { availableParallelism, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { externalReportPath, writeExternalReport } from './verification-support.mjs';
import { measureDashboardHttpBaseline } from './windows-host-test/dashboardHttpBaseline.mjs';
import { captureDashboardTestInputs } from './windows-host-test/dashboardTestInputs.mjs';
import { runDashboardTests } from './windows-host-test/dashboardTestRunner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const defaultReport = join(dirname(root), 'release-evidence', `CLU-E_WINDOWS_HOST_TEST_${stamp}_${randomBytes(4).toString('hex')}.json`);
const usage = 'Usage: node tools/p2-windows-host-test.mjs --approved-dashboard-tests [--output <new external .json>]';

function readOptions(args) {
  if (args[0] !== '--approved-dashboard-tests') throw new Error('HOST_TEST_APPROVAL_REQUIRED');
  if (args.length === 1) return defaultReport;
  if (args.length === 3 && args[1] === '--output' && /\.json$/iu.test(args[2])) return args[2];
  throw new Error('HOST_TEST_OPTIONS_INVALID');
}

async function hostTest(signal) {
  const report = {
    schemaVersion: 'clue-windows-host-test/1',
    checkedAt: new Date().toISOString(),
    state: 'NATIVE_WINDOWS_REQUIRED',
    executionEnvironment: process.platform === 'win32' ? 'WINDOWS_HOST' : null,
    selectionReason: 'OPERATOR_APPROVED_DASHBOARD_SUITE_AND_LOCAL_HTTP',
    proofAuthorization: false,
    host: {
      platform: process.platform, architecture: process.arch, osRelease: release(), nodeVersion: process.version,
      logicalParallelism: availableParallelism(), memoryGiB: Math.round(totalmem() / 2 ** 30),
    },
    source: null,
    suite: { id: 'CLU_E_DASHBOARD', runner: 'NODE_TEST_TAP', concurrency: 1, state: 'NOT_RUN' },
    dashboardHttp: { state: 'NOT_RUN' },
  };
  if (process.platform !== 'win32') return report;

  let before;
  let node;
  try {
    before = captureDashboardTestInputs(root);
    node = realpathSync.native(process.execPath);
  } catch (error) {
    report.state = 'HOST_TEST_INPUTS_UNVERIFIED';
    if (/^HOST_TEST_[A-Z0-9_]{1,64}$/u.test(error.message)) report.inputBlocker = error.message;
    return report;
  }
  report.source = {
    head: before.head, dirty: before.dirty, scopeSha256: before.scopeSha256, fileCount: before.fileCount, stable: false,
  };
  console.log(`[1/2] Running ${before.trackedTestPaths.length} approved dashboard test files on Windows.`);
  Object.assign(report.suite, await runDashboardTests({ node, cwd: root, testPaths: before.trackedTestPaths, signal }));
  if (signal.aborted) {
    report.state = 'HOST_TEST_INTERRUPTED';
    return report;
  }

  console.log('[2/2] Measuring the running dashboard on 127.0.0.1:47900.');
  report.dashboardHttp = await measureDashboardHttpBaseline({
    expectedHtmlSha256: before.htmlSha256, expectedAppSha256: before.appSha256, signal,
  });
  if (signal.aborted) {
    report.state = 'HOST_TEST_INTERRUPTED';
    return report;
  }
  try {
    const after = captureDashboardTestInputs(root);
    report.source.stable = before.head === after.head && before.scopeSha256 === after.scopeSha256;
  } catch { }
  if (!report.source.stable) report.state = 'HOST_TEST_INPUTS_CHANGED';
  else if (report.suite.state !== 'PASSED') report.state = 'HOST_TEST_SUITE_' + report.suite.state;
  else report.state = report.dashboardHttp.state === 'MEASURED' ? 'HOST_TESTS_AND_HTTP_BASELINE_COMPLETE' : 'HOST_TESTS_PASSED_BASELINE_PENDING';
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
    const output = externalReportPath(root, readOptions(process.argv.slice(2)));
    if (lstatSync(output, { throwIfNoEntry: false }) !== undefined) throw new Error('HOST_TEST_OUTPUT_EXISTS');
    const report = await hostTest(interrupt.signal);
    const written = writeExternalReport(root, output, report);
    console.log(`Windows host test ${report.state}`);
    console.log(`Dashboard tests ${report.suite.state} | HTTP baseline ${report.dashboardHttp.state}`);
    console.log(`Host test report: ${written}`);
    if (!['HOST_TESTS_AND_HTTP_BASELINE_COMPLETE', 'HOST_TESTS_PASSED_BASELINE_PENDING'].includes(report.state)) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (['HOST_TEST_APPROVAL_REQUIRED', 'HOST_TEST_OPTIONS_INVALID'].includes(error.message)) console.error(usage);
    else console.error('Could not produce the host test report. Use a new .json path outside the project.');
    process.exitCode = 2;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
