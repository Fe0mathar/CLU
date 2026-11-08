import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const fixturePrefix = 'CLU_E_ADMISSION_FIXTURE ';
const observed = 'clue-admission-observed-v1\n';
const trustedMarker = 'clue-admission-source-v1\n';
const checkoutMarker = 'clue-admission-checkout-v1\n';
const outsideMarker = 'clue-admission-outside-v1\n';
const privateMarker = 'clue-admission-private-v1\n';
const booleans = [
  'cwdMatches', 'checkoutRead', 'trustedSourceRead', 'workspaceWrite', 'tempWrite', 'homeWrite',
  'sourceWriteDenied', 'outsideReadDenied', 'privateReadDenied', 'hostEnvironmentAbsent', 'scratchEnvironmentMatches',
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
    readFileSync(path).equals(Buffer.from(value));
}

function makeSide(stage, side) {
  const root = join(stage, side);
  mkdirSync(root);
  const paths = Object.fromEntries(['checkout', 'workspace', 'scratch-temp', 'scratch-home', 'private', 'outside']
    .map((name) => [name, join(root, name)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  mkdirSync(join(paths['scratch-home'], 'npm-cache'));
  createFile(join(paths['scratch-home'], 'user.npmrc'), '');
  createFile(join(paths['scratch-home'], 'global.npmrc'), '');
  createFile(join(paths.checkout, 'input.txt'), checkoutMarker);
  createFile(join(paths.outside, 'forbidden.txt'), outsideMarker);
  createFile(join(paths.private, 'sealed.txt'), privateMarker);
  return paths;
}

function makeRequest({ side, paths, trusted, node, systemRoot, script }) {
  const temp = paths['scratch-temp'];
  const home = paths['scratch-home'];
  const system32 = join(systemRoot, 'System32');
  return {
    schemaVersion: 'clue-proof-exec/1',
    command: node,
    args: ['-e', script, side],
    cwd: paths.checkout,
    readOnlyRoots: [dirname(node), systemRoot, trusted, ...(side === 'baseline' ? [paths.checkout] : [])],
    writableRoots: [paths.workspace, temp, home, ...(side === 'candidate' ? [paths.checkout] : [])],
    env: {
      PATH: dirname(node) + ';' + system32,
      SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: join(system32, 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp,
      CI: '1', NO_COLOR: '1',
      NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_CACHE: join(home, 'npm-cache'),
      NPM_CONFIG_USERCONFIG: join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
      NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
    timeoutMs: 20_000,
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
      encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true,
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

function nativeEvidence(result) {
  const lines = result.stderr.split(/\r?\n/u);
  const phases = lines.map((line) =>
    /^\[CLU-E supervisor\] (?:REFUSED \([A-Za-z0-9]+\)\. |WIN32_ERROR_[0-9]+ )(REQUEST_READ|ENGINE_PIN|CONFIG_WRITE|ENGINE_RUN|ENGINE_LOG)(?: |$)/u.exec(line)?.[1]
  ).filter(Boolean);
  const engineRefusal = lines.map((line) =>
    /^\[CLU-E supervisor\] MXC_EXECUTION_REFUSED ENGINE_EXIT_(-?[0-9]{1,10}) ([A-Z_]{2,48})$/u.exec(line)
  ).find(Boolean);
  return {
    exitCode: result.code, failure: result.failure,
    refusalPhase: phases.length === 1 ? phases[0] : null,
    engineExitCode: engineRefusal ? Number(engineRefusal[1]) : null,
    engineRefusal: engineRefusal?.[2] ?? null,
    workloadExitVerified: lines.some((line) => /^\[CLU-E supervisor\] WORKLOAD_EXIT_0x[0-9A-F]{8}$/u.test(line)),
  };
}

function fixtureEvidence(stdout, side) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(fixturePrefix));
  if (lines.length !== 1 || lines[0].length > 2048) return null;
  let value;
  try { value = JSON.parse(lines[0].slice(fixturePrefix.length)); } catch { return null; }
  if (value?.side !== side || !booleans.every((name) => typeof value[name] === 'boolean') ||
      !['ALLOWED', 'DENIED', 'UNVERIFIED'].includes(value.checkoutWrite)) return null;
  return { ...Object.fromEntries(booleans.map((name) => [name, value[name]])), checkoutWrite: value.checkoutWrite };
}

export async function exerciseProofAdmissionFixtures({ stage, supervisor, node, systemRoot, script, invoke = launchSupervisor }) {
  const report = {
    schemaVersion: 'clue-windows-proof-admission-fixture/1',
    state: 'PRODUCTION_SHAPED_FIXTURE_SETUP_UNVERIFIED',
    proofAuthorization: false,
    stageCleanupSafe: true,
    cases: {},
    refusals: {},
  };
  try {
    const trusted = join(stage, 'trusted-source');
    mkdirSync(trusted);
    createFile(join(trusted, 'trusted.txt'), trustedMarker);
    const paths = { baseline: makeSide(stage, 'baseline'), candidate: makeSide(stage, 'candidate') };
    const requests = Object.fromEntries(Object.entries(paths).map(([side, entries]) =>
      [side, makeRequest({ side, paths: entries, trusted, node, systemRoot, script })]));

    async function send(request, entries) {
      const requestDir = mkdtempSync(join(entries.private, 'request-'));
      const requestPath = join(requestDir, 'request.json');
      const text = JSON.stringify(request);
      createFile(requestPath, text);
      const cleanupBefore = report.stageCleanupSafe;
      report.stageCleanupSafe = false;
      const result = await invoke({ supervisor, requestPath, systemRoot });
      const native = nativeEvidence(result);
      const preLaunchRefusal = native.exitCode === 125 && native.refusalPhase === 'REQUEST_READ';
      const settled = preLaunchRefusal || native.exitCode === 0 ||
        (native.exitCode !== null && native.exitCode !== 124 && native.exitCode !== 125 && native.workloadExitVerified);
      report.stageCleanupSafe = cleanupBefore && settled;
      return {
        native, preLaunchRefusal, stdout: result.stdout, requestUnchanged: exactMarker(requestPath, text),
        started: exactMarker(join(entries.workspace, 'started.txt'), observed),
        startMarkerAbsent: absent(join(entries.workspace, 'started.txt')),
      };
    }

    report.state = 'PRODUCTION_SHAPED_REFUSALS_UNVERIFIED';
    const baseline = requests.baseline;
    const negatives = {
      networkOptOut: { ...baseline, denyNetwork: false },
      writableBaseline: {
        ...baseline, readOnlyRoots: baseline.readOnlyRoots.filter((entry) => entry !== paths.baseline.checkout),
        writableRoots: [...baseline.writableRoots, paths.baseline.checkout],
      },
      extraEnvironment: { ...baseline, env: { ...baseline.env, CLU_UNAPPROVED_FIXTURE_KEY: 'fixture' } },
      changedWorkload: { ...baseline, args: ['-e', script + '\n// changed fixture\n', 'baseline'] },
    };
    for (const [id, request] of Object.entries(negatives)) {
      const evidence = await send(request, paths.baseline);
      report.refusals[id] = {
        ...evidence.native,
        state: evidence.preLaunchRefusal && evidence.startMarkerAbsent && evidence.requestUnchanged
          ? 'REFUSED_BEFORE_LAUNCH' : 'UNVERIFIED',
        started: evidence.started, startMarkerAbsent: evidence.startMarkerAbsent, requestUnchanged: evidence.requestUnchanged,
      };
      if (report.refusals[id].state !== 'REFUSED_BEFORE_LAUNCH') return report;
    }

    report.state = 'PRODUCTION_SHAPED_FIXTURES_UNVERIFIED';
    for (const [side, entries] of Object.entries(paths)) {
      const evidence = await send(requests[side], entries);
      const workload = fixtureEvidence(evidence.stdout, side);
      const marker = join(entries.checkout, 'checkout-write.txt');
      const host = {
        allowedWritesVerified: evidence.started &&
          exactMarker(join(entries.workspace, 'workspace-write.txt'), observed) &&
          exactMarker(join(entries['scratch-temp'], 'temp-write.txt'), observed) &&
          exactMarker(join(entries['scratch-home'], 'home-write.txt'), observed),
        checkoutWriteVerified: side === 'candidate' ? exactMarker(marker, observed) : absent(marker),
        protectedInputsUnchanged: evidence.requestUnchanged &&
          exactMarker(join(trusted, 'trusted.txt'), trustedMarker) &&
          exactMarker(join(entries.checkout, 'input.txt'), checkoutMarker) &&
          exactMarker(join(entries.outside, 'forbidden.txt'), outsideMarker) &&
          exactMarker(join(entries.private, 'sealed.txt'), privateMarker) &&
          absent(join(trusted, 'source-write.txt')),
      };
      const passed = evidence.native.exitCode === 0 && workload !== null &&
        booleans.every((name) => workload[name]) &&
        workload.checkoutWrite === (side === 'candidate' ? 'ALLOWED' : 'DENIED') &&
        Object.values(host).every(Boolean);
      report.cases[side] = {
        state: passed ? 'ADMITTED_AND_OBSERVED' : evidence.preLaunchRefusal ? 'REQUEST_REFUSED' : 'UNVERIFIED',
        ...evidence.native, workload, host,
      };
      if (!report.stageCleanupSafe) return report;
    }
    if (report.stageCleanupSafe && Object.values(report.cases).every((entry) => entry.state === 'ADMITTED_AND_OBSERVED')) {
      report.state = 'PRODUCTION_SHAPED_FIXTURES_OBSERVED';
    }
  } catch { /* Preserve the bounded state and any completed case evidence. */ }
  return report;
}
