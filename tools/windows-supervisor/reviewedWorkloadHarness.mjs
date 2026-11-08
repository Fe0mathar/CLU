import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  prepareDashboardComparisonInputs, verifyDashboardComparisonSnapshot,
} from '../windows-host-test/dashboardTestInputs.mjs';

const schemaVersion = 'clue-windows-reviewed-workload/1';
const evidencePrefix = 'CLU_E_REVIEWED_WORKLOAD ';
const timeoutMs = 90_000;
const observed = 'clue-admission-observed-v1\n';
const trustedMarker = 'clue-admission-source-v1\n';
const esmCanary = "export default 'clue-reviewed-esm-canary-v1';\n";
const outsideMarker = 'clue-admission-outside-v1\n';
const privateMarker = 'clue-admission-private-v1\n';
const workloadStates = new Set(['WORKLOAD_PASSED', 'BOOTSTRAP_REFUSED', 'DESCENDANT_UNVERIFIED', 'WORKLOAD_FAILED']);
const fileStates = new Set(['PASSED', 'LAUNCH_FAILED', 'TIMEOUT', 'OUTPUT_LIMIT', 'TAP_UNVERIFIED', 'SUITE_FAILED', 'CHILD_REFUSED', 'NOT_RUN']);
const filePhases = new Set([
  'NOT_RUN', 'SPAWN', 'CHILD_START', 'CHILD_ENVIRONMENT', 'CANARY_PATH', 'CANARY_READ', 'CANARY_IMPORT',
  'TEST_PATH', 'TEST_READ', 'TEST_IMPORT', 'TEST_RUN',
]);
const fileCodes = new Set([
  'NONE', 'UNVERIFIED', 'MISMATCH', 'TEST_FAILURE', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP',
  'EIO', 'EMFILE', 'ENFILE', 'ENOSYS', 'EINVAL', 'ETIMEDOUT', 'ENOBUFS', 'ERR_ACCESS_DENIED', 'ERR_MODULE_NOT_FOUND',
  'ERR_INVALID_MODULE_SPECIFIER', 'ERR_UNSUPPORTED_ESM_URL_SCHEME', 'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_INVALID_PACKAGE_CONFIG', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM', 'ERR_INVALID_ARG_VALUE',
  'ERR_ASSERTION', 'SYNTAX_ERROR', 'OTHER',
]);
const fallbackCodes = new Set(['EACCES', 'EPERM']);
const canaryVerifiedPhases = new Set(['TEST_PATH', 'TEST_READ', 'TEST_IMPORT', 'TEST_RUN']);
const childRefusalPhases = new Set(['CHILD_ENVIRONMENT', 'CANARY_PATH', 'CANARY_READ', 'CANARY_IMPORT', 'TEST_PATH', 'TEST_READ', 'TEST_IMPORT']);
const testPathPattern = /^ui\/clue-dashboard\/test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/u;
const countFields = ['tests', 'pass', 'fail', 'cancelled', 'skipped'];
const checkFields = [
  'descendantScratchVerified', 'effectiveScratchVerified', 'checkoutWriteDenied',
  'privateReadDenied', 'hostEnvironmentAbsent',
];

function createFile(path, value) {
  writeFileSync(path, value, { flag: 'wx' });
}

function absent(path) {
  return lstatSync(path, { throwIfNoEntry: false }) === undefined;
}

function exactMarker(path, value) {
  const file = lstatSync(path, { throwIfNoEntry: false });
  return file?.isFile() === true && file.nlink === 1 && file.size === Buffer.byteLength(value) &&
    relative(path, realpathSync.native(path)) === '' &&
    readFileSync(path).equals(Buffer.from(value));
}

function makeSide(stage, side) {
  const root = join(stage, side);
  mkdirSync(root);
  const paths = {
    checkout: join(root, 'checkout'), workspace: join(root, 'workspace'), temp: join(root, 'scratch-temp'),
    home: join(root, 'scratch-home'), private: join(root, 'private'), outside: join(root, 'outside'),
  };
  for (const [name, path] of Object.entries(paths)) {
    if (name !== 'checkout') mkdirSync(path);
  }
  mkdirSync(join(paths.home, 'npm-cache'));
  createFile(join(paths.home, 'user.npmrc'), '');
  createFile(join(paths.home, 'global.npmrc'), '');
  createFile(join(paths.outside, 'forbidden.txt'), outsideMarker);
  createFile(join(paths.private, 'sealed.txt'), privateMarker);
  return paths;
}

function makeRequest({ side, paths, trusted, node, systemRoot, script }) {
  const { checkout, workspace, temp, home } = paths;
  const system32 = join(systemRoot, 'System32');
  return {
    schemaVersion: 'clue-proof-exec/1',
    command: node,
    args: ['-e', script, side],
    cwd: checkout,
    readOnlyRoots: [dirname(node), systemRoot, trusted, checkout],
    writableRoots: [workspace, temp, home],
    env: {
      PATH: dirname(node) + ';' + system32,
      SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: join(system32, 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp,
      CI: '1', NO_COLOR: '1',
      NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_CACHE: join(home, 'npm-cache'),
      NPM_CONFIG_USERCONFIG: join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
      NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
    timeoutMs,
    denyNetwork: true,
  };
}

function launchSupervisor({ supervisor, requestPath, systemRoot }) {
  return new Promise((done) => {
    execFile(supervisor, ['--request-file', requestPath], {
      cwd: dirname(supervisor),
      env: {
        SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32'),
        CLU_ADMISSION_HOST_SENTINEL: 'clue-admission-synthetic',
        OPENAI_API_KEY: 'clue-admission-synthetic',
        CLU_WINDOWS_SUPERVISOR_PATH: 'clue-admission-synthetic',
      },
      encoding: 'utf8', timeout: timeoutMs + 10_000, maxBuffer: 64 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      done({
        code: error === null ? 0 : Number.isInteger(error.code) ? error.code : null,
        failure: error === null ? null : error.killed ? 'TIME_OR_OUTPUT_LIMIT'
          : Number.isInteger(error.code) ? 'NONZERO_EXIT' : 'PROCESS_UNAVAILABLE',
        stdout: stdout ?? '', stderr: stderr ?? '',
      });
    });
  });
}

function nativeEvidence({ code, failure, stderr }) {
  const lines = stderr.split(/\r?\n/u);
  const refusalPhases = lines.map((line) =>
    /^\[CLU-E supervisor\] (?:REFUSED \([A-Za-z0-9]+\)\. |WIN32_ERROR_[0-9]+ )(REQUEST_READ|ENGINE_PIN|CONFIG_WRITE|ENGINE_RUN|ENGINE_LOG)(?: |$)/u.exec(line)?.[1],
  ).filter(Boolean);
  const engineRefusals = lines.map((line) =>
    /^\[CLU-E supervisor\] MXC_EXECUTION_REFUSED ENGINE_EXIT_(-?[0-9]{1,10}) ([A-Z_]{2,48})$/u.exec(line),
  ).filter(Boolean);
  const workloadExits = lines.map((line) => /^\[CLU-E supervisor\] WORKLOAD_EXIT_0x([0-9A-F]{8})$/u.exec(line)).filter(Boolean);
  const workloadExit = workloadExits.length === 1 ? Number.parseInt(workloadExits[0][1], 16) : null;
  const workloadExitVerified = code !== null && workloadExit !== null &&
    (workloadExit === (code >>> 0) || (code === 1 && [124, 125].includes(workloadExit)));
  return {
    exitCode: code, failure,
    refusalPhase: refusalPhases.length === 1 ? refusalPhases[0] : null,
    engineExitCode: engineRefusals.length === 1 ? Number(engineRefusals[0][1]) : null,
    engineRefusal: engineRefusals.length === 1 ? engineRefusals[0][2] : null,
    workloadExitVerified,
  };
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function fileDiagnostic(value, outcome) {
  if (!exactObject(value, ['phase', 'code', 'canaryRealpath', 'testRealpath'])) return null;
  const { phase, code, canaryRealpath, testRealpath } = value;
  const validRealpath = (state) => state === 'MATCH' || fileCodes.has(state);
  if (!filePhases.has(phase) || !fileCodes.has(code) || !validRealpath(canaryRealpath) || !validRealpath(testRealpath)) return null;
  const realpathsUnverified = canaryRealpath === 'UNVERIFIED' && testRealpath === 'UNVERIFIED';
  const coherent = {
    PASSED: phase === 'TEST_RUN' && code === 'NONE',
    SUITE_FAILED: phase === 'TEST_RUN' && code === 'TEST_FAILURE',
    TAP_UNVERIFIED: code === 'UNVERIFIED' && (phase === 'TEST_RUN' || (phase === 'CHILD_START' && realpathsUnverified)),
    CHILD_REFUSED: childRefusalPhases.has(phase) && code !== 'NONE' && code !== 'TEST_FAILURE',
    LAUNCH_FAILED: phase === 'SPAWN' && realpathsUnverified && !['NONE', 'ETIMEDOUT', 'ENOBUFS'].includes(code),
    TIMEOUT: phase === 'SPAWN' && code === 'ETIMEDOUT' && realpathsUnverified,
    OUTPUT_LIMIT: phase === 'SPAWN' && code === 'ENOBUFS' && realpathsUnverified,
    NOT_RUN: phase === 'NOT_RUN' && code === 'NONE' && realpathsUnverified,
  };
  if (!coherent[outcome]) return null;
  return { phase, code, canaryRealpath, testRealpath };
}

function workloadEvidence(stdout, side, testFileCount) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(evidencePrefix));
  if (lines.length !== 1 || lines[0].length > 12 * 1024) return null;
  let value;
  try { value = JSON.parse(lines[0].slice(evidencePrefix.length)); } catch { return null; }
  if (value?.side !== side || !workloadStates.has(value.state) ||
      !checkFields.every((name) => typeof value[name] === 'boolean')) return null;
  const suiteStarted = value.state === 'WORKLOAD_PASSED' || value.state === 'WORKLOAD_FAILED';
  const expectedExit = suiteStarted ? value.state === 'WORKLOAD_PASSED' ? 0 : 1 : null;
  const { executionMode, fallback, esmCanaryVerified, fileOutcomes } = value;
  if (executionMode === 'DIRECT_IMPORT_PRESERVE_SYMLINKS') {
    if (!suiteStarted || !exactObject(fallback, ['code', 'realpathCode']) ||
        !fallbackCodes.has(fallback.code) || !fallbackCodes.has(fallback.realpathCode)) return null;
  } else if (executionMode !== 'DIRECT_IMPORT' || fallback !== null) return null;
  if (value.exitCode !== expectedExit || !Array.isArray(fileOutcomes) ||
      fileOutcomes.length !== (suiteStarted ? testFileCount : 0) ||
      !fileOutcomes.every((outcome) => fileStates.has(outcome)) ||
      !Array.isArray(value.fileDiagnostics) || value.fileDiagnostics.length !== fileOutcomes.length) return null;
  const fileDiagnostics = value.fileDiagnostics.map((item, index) => fileDiagnostic(item, fileOutcomes[index]));
  if (fileDiagnostics.includes(null)) return null;
  const allCanariesVerified = suiteStarted && fileDiagnostics.every(({ phase }) => canaryVerifiedPhases.has(phase));
  if (esmCanaryVerified !== allCanariesVerified) return null;
  const firstNotRun = fileOutcomes.indexOf('NOT_RUN');
  if (firstNotRun !== -1 && !fileOutcomes.slice(firstNotRun).every((outcome) => outcome === 'NOT_RUN')) return null;
  const allFilesPassed = suiteStarted && fileOutcomes.every((outcome) => outcome === 'PASSED');
  const allTapVerified = suiteStarted && fileOutcomes.every((outcome) => outcome === 'PASSED' || outcome === 'SUITE_FAILED');
  const counts = Object.fromEntries(countFields.map((name) => [name, value[name]]));
  if (allTapVerified) {
    if (!countFields.every((name) => Number.isSafeInteger(counts[name]) && counts[name] >= 0) ||
        counts.tests < testFileCount || counts.pass + counts.fail + counts.cancelled + counts.skipped > counts.tests) return null;
  } else if (!countFields.every((name) => counts[name] === null)) return null;
  const checks = Object.fromEntries(checkFields.map((name) => [name, value[name]]));
  if (suiteStarted && !checkFields.every((name) => checks[name])) return null;
  if ((value.state === 'WORKLOAD_PASSED') !== allFilesPassed ||
      (allFilesPassed && (!esmCanaryVerified || counts.tests !== counts.pass))) return null;
  return {
    state: value.state, exitCode: value.exitCode, ...counts, ...checks, executionMode,
    fallback: fallback === null ? null : { code: fallback.code, realpathCode: fallback.realpathCode },
    esmCanaryVerified, fileOutcomes, fileDiagnostics,
  };
}

/** Run the already-reviewed dashboard snapshots as actual Node test workloads in native containment. */
export async function exerciseReviewedWorkloads({
  repoRoot, stage, supervisor, node, systemRoot, script, approve, invoke = launchSupervisor,
}) {
  const report = {
    schemaVersion, state: 'REVIEWED_WORKLOAD_INPUTS_UNVERIFIED', proofAuthorization: false,
    stageCleanupSafe: true, approval: 'NOT_REQUESTED', source: null, refusals: {}, cases: {},
  };
  try {
    const trusted = join(stage, 'trusted-source');
    mkdirSync(trusted);
    createFile(join(trusted, 'trusted.txt'), trustedMarker);
    const esmCanaryPath = join(trusted, 'reviewed-esm-canary.mjs');
    createFile(esmCanaryPath, esmCanary);
    const sides = ['baseline', 'candidate'];
    const paths = Object.fromEntries(sides.map((side) => [side, makeSide(stage, side)]));
    const copies = Object.fromEntries(sides.map((side) => [side, join(stage, 'stage-' + side)]));
    for (const path of Object.values(copies)) mkdirSync(path);
    const inputs = prepareDashboardComparisonInputs(repoRoot, copies.baseline, copies.candidate);
    for (const side of sides) renameSync(copies[side], paths[side].checkout);
    const testPaths = inputs.trackedTestPaths;
    if (testPaths.length < 1 || testPaths.length > 64 ||
        !testPaths.every((path) => path.length <= 128 && testPathPattern.test(path)) ||
        new Set(testPaths.map((path) => path.toLowerCase())).size !== testPaths.length) {
      throw new Error('HOST_TEST_REVIEWED_PATHS_UNVERIFIED');
    }
    const manifest = JSON.stringify({ schemaVersion, testPaths });
    if (Buffer.byteLength(manifest) > 4096) throw new Error('HOST_TEST_REVIEWED_MANIFEST_TOO_LARGE');
    const manifestPath = join(trusted, 'reviewed-workload.json');
    createFile(manifestPath, manifest);
    const digests = { baseline: inputs.baselineSha256, candidate: inputs.candidateSha256 };
    report.source = {
      baseline: { kind: 'COMMITTED_HEAD', head: inputs.head, scopeSha256: digests.baseline },
      candidate: { kind: 'CURRENT_DASHBOARD', dirty: inputs.dirty, scopeSha256: digests.candidate },
      changedPaths: inputs.changedPaths, fileCount: inputs.fileCount, sameTestFiles: true,
      testFileCount: testPaths.length, testPaths: [...testPaths],
      manifestSha256: createHash('sha256').update(manifest).digest('hex'),
      esmCanarySha256: createHash('sha256').update(esmCanary).digest('hex'),
    };
    if (inputs.changedPaths.length === 0) {
      report.state = 'REVIEWED_WORKLOAD_NO_DASHBOARD_CHANGES';
      return report;
    }
    report.state = 'REVIEWED_WORKLOAD_APPROVAL_REQUIRED';
    report.approval = 'NOT_GRANTED';
    if (await approve(report.source) !== true) return report;
    report.approval = 'OPERATOR_APPROVED_SCOPED_COPIES';

    function verifiedInputs() {
      return exactMarker(manifestPath, manifest) && exactMarker(join(trusted, 'trusted.txt'), trustedMarker) &&
        exactMarker(esmCanaryPath, esmCanary) &&
        sides.every((side) => verifyDashboardComparisonSnapshot(paths[side].checkout, digests[side], inputs.fileCount) &&
          exactMarker(join(paths[side].outside, 'forbidden.txt'), outsideMarker) &&
          exactMarker(join(paths[side].private, 'sealed.txt'), privateMarker));
    }

    async function send(request, entries) {
      const directory = mkdtempSync(join(entries.private, 'request-'));
      const requestPath = join(directory, 'request.json');
      const bytes = JSON.stringify(request);
      createFile(requestPath, bytes);
      const cleanupBefore = report.stageCleanupSafe;
      report.stageCleanupSafe = false;
      const result = await invoke({ supervisor, requestPath, systemRoot });
      const native = nativeEvidence(result);
      const preLaunchRefusal = native.exitCode === 125 && native.refusalPhase === 'REQUEST_READ';
      const settled = preLaunchRefusal || native.exitCode === 0 ||
        (native.exitCode !== null && native.exitCode !== 124 && native.exitCode !== 125 && native.workloadExitVerified);
      report.stageCleanupSafe = cleanupBefore && settled;
      return {
        native, preLaunchRefusal, stdout: result.stdout,
        requestUnchanged: exactMarker(requestPath, bytes),
      };
    }

    const requests = Object.fromEntries(sides.map((side) =>
      [side, makeRequest({ side, paths: paths[side], trusted, node, systemRoot, script })]));
    report.state = 'REVIEWED_WORKLOAD_SNAPSHOTS_CHANGED';
    if (!verifiedInputs()) return report;
    const baseline = requests.baseline;
    const writableCheckout = (request) => ({
      ...request, readOnlyRoots: request.readOnlyRoots.filter((entry) => entry !== request.cwd),
      writableRoots: [...request.writableRoots, request.cwd],
    });
    const negatives = [
      ['networkOptOut', { ...baseline, denyNetwork: false }, 'baseline'],
      ['writableBaseline', writableCheckout(baseline), 'baseline'],
      ['writableCandidate', writableCheckout(requests.candidate), 'candidate'],
      ['extraEnvironment', { ...baseline, env: { ...baseline.env, CLU_UNAPPROVED_FIXTURE_KEY: 'fixture' } }, 'baseline'],
      ['changedWorkload', { ...baseline, args: ['-e', script + '\n// changed reviewed workload\n', 'baseline'] }, 'baseline'],
    ];
    report.state = 'REVIEWED_WORKLOAD_REFUSALS_UNVERIFIED';
    for (const [id, request, side] of negatives) {
      const evidence = await send(request, paths[side]);
      const startMarkerAbsent = absent(join(paths[side].workspace, 'started.txt'));
      const state = evidence.preLaunchRefusal && startMarkerAbsent && evidence.requestUnchanged
        ? 'REFUSED_BEFORE_LAUNCH' : 'UNVERIFIED';
      report.refusals[id] = { ...evidence.native, state, startMarkerAbsent, requestUnchanged: evidence.requestUnchanged };
      if (evidence.preLaunchRefusal && !startMarkerAbsent) report.stageCleanupSafe = false;
      if (state !== 'REFUSED_BEFORE_LAUNCH') return report;
    }

    report.state = 'REVIEWED_WORKLOAD_EXECUTION_UNVERIFIED';
    for (const side of sides) {
      if (!verifiedInputs()) {
        report.state = 'REVIEWED_WORKLOAD_SNAPSHOTS_CHANGED';
        return report;
      }
      const entries = paths[side];
      const evidence = await send(requests[side], entries);
      const workload = workloadEvidence(evidence.stdout, side, testPaths.length);
      const host = {
        startedMarkerVerified: exactMarker(join(entries.workspace, 'started.txt'), observed),
        descendantMarkerVerified: exactMarker(join(entries.workspace, 'descendant.txt'), observed),
        protectedInputsUnchanged: evidence.requestUnchanged && verifiedInputs(),
      };
      const passed = evidence.native.exitCode === 0 && workload?.state === 'WORKLOAD_PASSED' && Object.values(host).every(Boolean);
      report.cases[side] = {
        ...evidence.native, state: passed ? 'ADMITTED_AND_OBSERVED' : evidence.preLaunchRefusal ? 'REQUEST_REFUSED' : 'UNVERIFIED',
        workload, host,
      };
      if (!report.stageCleanupSafe || !host.protectedInputsUnchanged) return report;
    }
    if (sides.every((side) => report.cases[side].state === 'ADMITTED_AND_OBSERVED')) {
      const baselineWorkload = report.cases.baseline.workload;
      const candidateWorkload = report.cases.candidate.workload;
      if (baselineWorkload.executionMode !== candidateWorkload.executionMode) {
        report.state = 'REVIEWED_WORKLOAD_RESOLVER_MODE_CHANGED';
      } else {
        report.state = baselineWorkload.tests === candidateWorkload.tests
          ? 'REVIEWED_WORKLOADS_OBSERVED' : 'REVIEWED_WORKLOAD_TEST_COUNT_CHANGED';
      }
    }
  } catch (error) {
    if (typeof error?.message === 'string' && /^HOST_TEST_[A-Z0-9_]{1,64}$/u.test(error.message)) {
      report.inputBlocker = error.message;
    }
  }
  return report;
}
