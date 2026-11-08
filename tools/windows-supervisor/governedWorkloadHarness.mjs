import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { stageGovernedOfflineCache } from './governedOfflineCache.mjs';
import { inspectGovernedBuild, stageGovernedSource, verifyGovernedSource } from './governedWorkloadInputs.mjs';

const schemaVersion = 'clue-windows-governed-workload/1';
const evidencePrefix = 'CLU_E_GOVERNED_WORKLOAD ';
const timeouts = { candidate: 360_000, baseline: 120_000 };
const observed = 'clue-admission-observed-v1\n';
const trustedMarker = 'clue-admission-source-v1\n';
const outsideMarker = 'clue-admission-outside-v1\n';
const privateMarker = 'clue-admission-private-v1\n';
const workloadStates = new Set(['GOVERNED_PASSED', 'GOVERNED_FAILED', 'BOOTSTRAP_REFUSED']);
const checkFields = [
  'effectiveScratchVerified', 'hostEnvironmentAbsent', 'checkoutWriteVerified',
  'privateReadDenied', 'trustedSourceRead', 'npmCacheWritable',
];
const steps = {
  candidate: ['offlineInstall', 'typecheck', 'build', 'nativeSqlite'],
  baseline: ['initWorkspace', 'doctorDeep'],
};
const stageNames = [...steps.candidate, ...steps.baseline];
const stageStates = new Set(['NOT_RUN', 'PASSED', 'FAILED', 'TIMEOUT', 'OUTPUT_LIMIT', 'LAUNCH_FAILED', 'OUTPUT_UNVERIFIED']);
const stageCodes = new Set([
  'NONE', 'NONZERO_EXIT', 'PROTOCOL_UNVERIFIED', 'ETIMEDOUT', 'ENOBUFS', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR',
  'EISDIR', 'EINVAL', 'EIO', 'ENOSPC', 'ENOTCACHED', 'EINTEGRITY', 'EUSAGE', 'ERR_ACCESS_DENIED',
  'ERR_MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED', 'ERR_ASSERTION', 'TYPESCRIPT_DIAGNOSTICS', 'OTHER',
]);
const doctorLogStates = new Set(['VERIFIED', 'ABSENT', 'EMPTY', 'UNAVAILABLE', 'UNVERIFIED', 'MISMATCH']);
const doctorArtifactStates = new Set(['VERIFIED', 'ABSENT', 'UNVERIFIED', 'MISMATCH']);
const eventFields = ['id', 'sequence', 'timestamp', 'type', 'mission_version', 'actor', 'subject_id', 'payload', 'previous_hash', 'hash'];
const sha256Pattern = /^[0-9a-f]{64}$/u;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createFile(path, value) {
  writeFileSync(path, value, { flag: 'wx' });
}

function absent(path) {
  return lstatSync(path, { throwIfNoEntry: false }) === undefined;
}

function exactFile(path, maxBytes) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.nlink !== 1 || entry.size > maxBytes || relative(path, realpathSync.native(path)) !== '') return null;
  const bytes = readFileSync(path);
  return bytes.length === entry.size ? bytes : null;
}

function exactMarker(path, value) {
  return exactFile(path, Buffer.byteLength(value))?.equals(Buffer.from(value)) === true;
}

function makeSide(stage, side) {
  const root = join(stage, side);
  mkdirSync(root);
  const paths = {
    checkout: join(root, 'checkout'), workspace: join(root, 'workspace'), temp: join(root, 'scratch-temp'),
    home: join(root, 'scratch-home'), private: join(root, 'private'), outside: join(root, 'outside'),
  };
  for (const [name, path] of Object.entries(paths)) {
    if (name !== 'checkout' || side === 'candidate') mkdirSync(path);
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
  const candidate = side === 'candidate';
  const system32 = join(systemRoot, 'System32');
  return {
    schemaVersion: 'clue-proof-exec/1', command: node, args: ['-e', script, side], cwd: checkout,
    readOnlyRoots: [dirname(node), systemRoot, trusted, ...(candidate ? [] : [checkout])],
    writableRoots: [workspace, temp, home, ...(candidate ? [checkout] : [])],
    env: {
      PATH: dirname(node) + ';' + system32,
      SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: join(system32, 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp,
      CI: '1', NO_COLOR: '1',
      NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_CACHE: join(home, 'npm-cache'),
      NPM_CONFIG_USERCONFIG: join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
      NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
    timeoutMs: timeouts[side], denyNetwork: true,
  };
}

function launchSupervisor({ supervisor, requestPath, systemRoot, timeoutMs }) {
  return new Promise((done) => {
    execFile(supervisor, ['--request-file', requestPath], {
      cwd: dirname(supervisor),
      env: {
        SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32'),
        CLU_ADMISSION_HOST_SENTINEL: 'clue-admission-synthetic',
        OPENAI_API_KEY: 'clue-admission-synthetic', CLU_WINDOWS_SUPERVISOR_PATH: 'clue-admission-synthetic',
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
    exitCode: code, failure, refusalPhase: refusalPhases.length === 1 ? refusalPhases[0] : null,
    engineExitCode: engineRefusals.length === 1 ? Number(engineRefusals[0][1]) : null,
    engineRefusal: engineRefusals.length === 1 ? engineRefusals[0][2] : null, workloadExitVerified,
  };
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function stageEvidence(value) {
  if (!exactObject(value, ['state', 'code', 'exitCode'])) return null;
  const { state, code, exitCode } = value;
  if (!stageStates.has(state) || !stageCodes.has(code)) return null;
  const coherent = {
    NOT_RUN: code === 'NONE' && exitCode === null,
    PASSED: code === 'NONE' && exitCode === 0,
    FAILED: code !== 'NONE' && (exitCode === null || (Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= 255)),
    TIMEOUT: code === 'ETIMEDOUT' && exitCode === null,
    OUTPUT_LIMIT: code === 'ENOBUFS' && exitCode === null,
    LAUNCH_FAILED: code !== 'NONE' && exitCode === null,
    OUTPUT_UNVERIFIED: code === 'PROTOCOL_UNVERIFIED' && exitCode === 0,
  };
  return coherent[state] ? { state, code, exitCode } : null;
}

function doctorEvidence(value) {
  const keys = ['eventLogState', 'eventLogHead', 'recordsVerified', 'artifactState', 'artifactsChecked', 'artifactsVerified'];
  if (!exactObject(value, keys)) return null;
  const { eventLogState, eventLogHead, recordsVerified, artifactState, artifactsChecked, artifactsVerified } = value;
  if (!doctorLogStates.has(eventLogState) || !doctorArtifactStates.has(artifactState)) return null;
  const validPair = (state, first, second, relation, allowEqualMismatch = false) => {
    if (state !== 'VERIFIED' && state !== 'MISMATCH') return first === null && second === null;
    if (![first, second].every((number) => Number.isSafeInteger(number) && number >= 0 && number <= 999_999_999)) return false;
    if (allowEqualMismatch && state === 'MISMATCH') return true;
    return (state === 'VERIFIED') === relation(first, second);
  };
  if (!validPair(eventLogState, eventLogHead, recordsVerified, (head, count) => count - 1 === head) ||
      !validPair(artifactState, artifactsChecked, artifactsVerified, (checked, verified) => checked === verified, true)) return null;
  return { eventLogState, eventLogHead, recordsVerified, artifactState, artifactsChecked, artifactsVerified };
}

function workloadEvidence(stdout, side) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(evidencePrefix));
  if (lines.length !== 1 || lines[0].length > 4096) return null;
  let value;
  try { value = JSON.parse(lines[0].slice(evidencePrefix.length)); } catch { return null; }
  if (value?.side !== side || !workloadStates.has(value.state) || !exactObject(value.stages, stageNames) ||
      !checkFields.every((name) => typeof value[name] === 'boolean')) return null;
  const checks = Object.fromEntries(checkFields.map((name) => [name, value[name]]));
  const stages = Object.fromEntries(stageNames.map((name) => [name, stageEvidence(value.stages[name])]));
  if (Object.values(stages).includes(null)) return null;
  const selected = steps[side];
  if (!stageNames.filter((name) => !selected.includes(name)).every((name) => stages[name].state === 'NOT_RUN')) return null;
  const passed = value.state === 'GOVERNED_PASSED';
  const refused = value.state === 'BOOTSTRAP_REFUSED';
  if (value.exitCode !== (refused ? null : passed ? 0 : 1) || value.doctorDeepVerified !== (passed && side === 'baseline')) return null;
  const doctor = value.doctorEvidence === null ? null : doctorEvidence(value.doctorEvidence);
  if (value.doctorEvidence !== null && doctor === null) return null;
  if (!['PASSED', 'FAILED', 'OUTPUT_UNVERIFIED'].includes(stages.doctorDeep.state) && doctor !== null) return null;
  if (['PASSED', 'OUTPUT_UNVERIFIED'].includes(stages.doctorDeep.state) && doctor === null) return null;
  if (value.doctorDeepVerified && (doctor.eventLogState !== 'VERIFIED' || doctor.artifactState !== 'VERIFIED')) return null;
  if (!refused && !Object.values(checks).every(Boolean)) return null;
  if (passed) {
    if (!selected.every((name) => stages[name].state === 'PASSED')) return null;
  } else if (refused) {
    if (!selected.every((name) => stages[name].state === 'NOT_RUN')) return null;
  } else {
    const firstIncomplete = selected.findIndex((name) => stages[name].state !== 'PASSED');
    if (firstIncomplete === -1 || !selected.slice(firstIncomplete + 1).every((name) => stages[name].state === 'NOT_RUN')) return null;
  }
  return { state: value.state, exitCode: value.exitCode, ...checks, stages, doctorDeepVerified: value.doctorDeepVerified, doctorEvidence: doctor };
}

function stageBaseline(paths, expected) {
  const configRelative = 'config/clue.config.yaml';
  const profileRelative = 'targets/clu/profile.yaml';
  const configPath = join(paths.checkout, configRelative);
  const profilePath = join(paths.checkout, profileRelative);
  const config = parseYaml(readFileSync(configPath, 'utf8'), { maxAliasCount: 0 });
  const profile = parseYaml(readFileSync(profilePath, 'utf8'), { maxAliasCount: 0 });
  if (config?.version !== 2 || config?.project?.active_target !== 'clu' || profile?.id !== 'clu' ||
      ![config.workspace, config.shadow, config.browser, config.gateway].every((value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value))) throw new Error('GOVERNED_STAGED_CONFIG_UNVERIFIED');
  const portable = (path) => path.replaceAll('\\', '/');
  config.workspace.root = portable(join(paths.workspace, 'mission'));
  config.shadow.root = portable(join(paths.workspace, 'shadow'));
  config.browser.profile_dir = portable(join(paths.workspace, 'browser-profile'));
  config.gateway.enabled = false;
  profile.root = portable(paths.checkout);
  const verified = new Map(expected);
  const instrumentation = [
    [configRelative, configPath, config, ['workspace.root', 'shadow.root', 'browser.profile_dir', 'gateway.enabled']],
    [profileRelative, profilePath, profile, ['root']],
  ].map(([relativePath, path, value, fields]) => {
    const after = Buffer.from(stringifyYaml(value, { lineWidth: 0 }));
    const before = verified.get(relativePath);
    const afterSha256 = sha256(after);
    writeFileSync(path, after);
    verified.set(relativePath, { size: after.length, sha256: afterSha256 });
    return { path: relativePath, fields, beforeSha256: before.sha256, afterSha256 };
  });
  return { verified, instrumentation };
}

function inspectBaselineWorkspace(workspace) {
  const mission = join(workspace, 'mission');
  const result = { eventLogVerified: false, eventLogHead: null, eventLogRecords: null, sqliteHeaderVerified: false };
  try {
    const db = exactFile(join(mission, 'db', 'clue.db'), 32 * 1024 * 1024);
    result.sqliteHeaderVerified = db?.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) === true;
  } catch { /* The projection file could not be checked. */ }
  try {
    const bytes = exactFile(join(mission, 'events', 'events.ndjson'), 1024 * 1024);
    if (!bytes?.length) return result;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) return result;
    const lines = text.slice(0, -1).split('\n');
    if (lines.length > 4096) return result;
    let previousHash = null;
    let missionRegistered = false;
    for (const [sequence, line] of lines.entries()) {
      const record = JSON.parse(line);
      if (!exactObject(record, eventFields) || record.sequence !== sequence || record.previous_hash !== previousHash ||
          typeof record.hash !== 'string' || !sha256Pattern.test(record.hash) ||
          typeof record.type !== 'string' || record.type.length === 0) return result;
      previousHash = record.hash;
      if (record.type === 'mission.registered' && typeof record.mission_version === 'string' &&
          /^MISSION-[0-9]{6,}$/u.test(record.mission_version) && record.subject_id === record.mission_version &&
          record.payload?.id === record.mission_version) missionRegistered = true;
    }
    if (missionRegistered) {
      result.eventLogVerified = true;
      result.eventLogHead = lines.length - 1;
      result.eventLogRecords = lines.length;
    }
  } catch { /* The event log could not be checked. */ }
  return result;
}

/** Run fixed native offline preparation followed by a clean-scope governed CLU-E CLI scenario. */
export async function exerciseGovernedWorkload({
  repoRoot, stage, supervisor, node, systemRoot, script, approve,
  invoke = launchSupervisor, stageCache = stageGovernedOfflineCache, progress,
}) {
  const report = {
    schemaVersion, state: 'GOVERNED_INPUTS_UNVERIFIED', proofAuthorization: false, stageCleanupSafe: true,
    approval: 'NOT_REQUESTED', source: null, cache: null, prepared: null, instrumentation: [], refusals: {}, cases: {},
  };
  try {
    const trusted = join(stage, 'trusted-source');
    mkdirSync(trusted);
    createFile(join(trusted, 'trusted.txt'), trustedMarker);
    const candidate = makeSide(stage, 'candidate');
    const baseline = makeSide(stage, 'baseline');
    const input = stageGovernedSource(repoRoot, [candidate.checkout]);
    const npmCliPath = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmCli = exactFile(npmCliPath, 1024 * 1024);
    if (!npmCli?.length) throw new Error('GOVERNED_NPM_CLI_UNVERIFIED');
    const { expected, ...source } = input;
    report.source = { ...source, fileCount: expected.size, npmCliSha256: sha256(npmCli) };
    report.state = 'GOVERNED_OFFLINE_CACHE_UNVERIFIED';
    report.cache = await stageCache({
      lockfile: join(candidate.checkout, 'package-lock.json'),
      destinationCache: join(candidate.home, 'npm-cache'),
    });
    const prebuild = report.cache?.prebuild;
    if (report.cache?.state !== 'READY' || report.cache.lockfileSha256 !== report.source.lockSha256 ||
        !/^[0-9a-f]{64}$/u.test(report.cache.manifestSha256) || prebuild?.state !== 'VERIFIED_LOCAL_BYTES' ||
        !/^[a-z0-9][a-z0-9_.-]{1,180}\.tar\.gz$/iu.test(prebuild.filename) || !/^[0-9a-f]{64}$/u.test(prebuild.sha256)) return report;
    const cachedArchive = join(candidate.home, 'npm-cache', '_prebuilds', prebuild.filename);

    function prebuildIntact() {
      const bytes = exactFile(cachedArchive, 12 * 1024 * 1024);
      return bytes?.length > 0 && sha256(bytes) === prebuild.sha256;
    }

    report.state = 'GOVERNED_APPROVAL_REQUIRED';
    report.approval = 'NOT_GRANTED';
    if (await approve({ source: report.source, cache: report.cache }) !== true) return report;
    report.approval = 'OPERATOR_APPROVED_GOVERNED_HEAD';

    function protectedInputs() {
      const cli = exactFile(npmCliPath, 1024 * 1024);
      return cli?.equals(npmCli) === true && exactMarker(join(trusted, 'trusted.txt'), trustedMarker) &&
        [candidate, baseline].every((paths) =>
          exactMarker(join(paths.outside, 'forbidden.txt'), outsideMarker) &&
          exactMarker(join(paths.private, 'sealed.txt'), privateMarker) &&
          exactMarker(join(paths.home, 'user.npmrc'), '') && exactMarker(join(paths.home, 'global.npmrc'), ''));
    }

    async function send(request, paths) {
      const requestDir = mkdtempSync(join(paths.private, 'request-'));
      const requestPath = join(requestDir, 'request.json');
      const bytes = JSON.stringify(request);
      createFile(requestPath, bytes);
      const cleanupBefore = report.stageCleanupSafe;
      report.stageCleanupSafe = false;
      const nativeResult = await invoke({ supervisor, requestPath, systemRoot, timeoutMs: request.timeoutMs });
      const native = nativeEvidence(nativeResult);
      const preLaunchRefusal = native.exitCode === 125 && native.refusalPhase === 'REQUEST_READ';
      const settled = preLaunchRefusal || native.exitCode === 0 ||
        (native.exitCode !== null && native.exitCode !== 124 && native.exitCode !== 125 && native.workloadExitVerified);
      report.stageCleanupSafe = cleanupBefore && settled;
      return { native, preLaunchRefusal, stdout: nativeResult.stdout, requestUnchanged: exactMarker(requestPath, bytes) };
    }

    async function refusal(id, request, paths) {
      const evidence = await send(request, paths);
      const startMarkerAbsent = absent(join(paths.workspace, 'started.txt'));
      if (evidence.preLaunchRefusal && !startMarkerAbsent) report.stageCleanupSafe = false;
      const passed = evidence.preLaunchRefusal && startMarkerAbsent && evidence.requestUnchanged;
      report.refusals[id] = {
        ...evidence.native, state: passed ? 'REFUSED_BEFORE_LAUNCH' : 'UNVERIFIED',
        startMarkerAbsent, requestUnchanged: evidence.requestUnchanged,
      };
      return passed;
    }

    report.state = 'GOVERNED_SOURCE_CHANGED';
    if (!protectedInputs() || !prebuildIntact() || !verifyGovernedSource(candidate.checkout, expected)) return report;
    const candidateRequest = makeRequest({ side: 'candidate', paths: candidate, trusted, node, systemRoot, script });
    report.state = 'GOVERNED_REFUSALS_UNVERIFIED';
    for (const [id, request] of [
      ['networkOptOut', { ...candidateRequest, denyNetwork: false }],
      ['extraEnvironment', { ...candidateRequest, env: { ...candidateRequest.env, CLU_UNAPPROVED_FIXTURE_KEY: 'fixture' } }],
      ['changedWorkload', { ...candidateRequest, args: ['-e', script + '\n// changed governed workload\n', 'candidate'] }],
      ['readOnlyCandidate', {
        ...candidateRequest, readOnlyRoots: [...candidateRequest.readOnlyRoots, candidate.checkout],
        writableRoots: candidateRequest.writableRoots.filter((path) => path !== candidate.checkout),
      }],
    ]) {
      if (!await refusal(id, request, candidate)) return report;
    }

    report.state = 'GOVERNED_CANDIDATE_UNVERIFIED';
    if (!protectedInputs() || !prebuildIntact() || !verifyGovernedSource(candidate.checkout, expected)) return report;
    progress?.('candidate');
    const candidateEvidence = await send(candidateRequest, candidate);
    const candidateWorkload = workloadEvidence(candidateEvidence.stdout, 'candidate');
    const checkoutMarker = join(candidate.checkout, 'checkout-write.txt');
    const checkoutWriteVerified = report.stageCleanupSafe && exactMarker(checkoutMarker, observed);
    if (checkoutWriteVerified) unlinkSync(checkoutMarker);
    const candidateHost = {
      startedMarkerVerified: report.stageCleanupSafe && exactMarker(join(candidate.workspace, 'started.txt'), observed), checkoutWriteVerified,
      protectedInputsUnchanged: report.stageCleanupSafe && candidateEvidence.requestUnchanged && protectedInputs() &&
        verifyGovernedSource(candidate.checkout, expected, { allowBuildOutputs: true }),
    };
    const candidatePassed = candidateEvidence.native.exitCode === 0 && candidateWorkload?.state === 'GOVERNED_PASSED' &&
      Object.values(candidateHost).every(Boolean);
    report.cases.candidate = {
      ...candidateEvidence.native, state: candidatePassed ? 'ADMITTED_AND_OBSERVED' : 'UNVERIFIED',
      workload: candidateWorkload, host: candidateHost,
    };
    if (!candidatePassed || !report.stageCleanupSafe) return report;

    report.state = 'GOVERNED_PREPARED_TREE_UNVERIFIED';
    report.prepared = inspectGovernedBuild(candidate.checkout);
    renameSync(candidate.checkout, baseline.checkout);
    const { verified, instrumentation } = stageBaseline(baseline, expected);
    report.instrumentation = instrumentation;
    if (!verifyGovernedSource(baseline.checkout, verified, { allowBuildOutputs: true })) return report;
    const baselineRequest = makeRequest({ side: 'baseline', paths: baseline, trusted, node, systemRoot, script });
    if (!await refusal('writableBaseline', {
      ...baselineRequest, readOnlyRoots: baselineRequest.readOnlyRoots.filter((path) => path !== baseline.checkout),
      writableRoots: [...baselineRequest.writableRoots, baseline.checkout],
    }, baseline)) {
      report.state = 'GOVERNED_REFUSALS_UNVERIFIED';
      return report;
    }

    if (!protectedInputs() || !verifyGovernedSource(baseline.checkout, verified, { allowBuildOutputs: true }) ||
        inspectGovernedBuild(baseline.checkout).treeSha256 !== report.prepared.treeSha256) return report;
    report.state = 'GOVERNED_BASELINE_UNVERIFIED';
    progress?.('baseline');
    const baselineEvidence = await send(baselineRequest, baseline);
    const baselineWorkload = workloadEvidence(baselineEvidence.stdout, 'baseline');
    const baselineHost = {
      startedMarkerVerified: report.stageCleanupSafe && exactMarker(join(baseline.workspace, 'started.txt'), observed),
      checkoutWriteDenied: report.stageCleanupSafe && absent(join(baseline.checkout, 'checkout-write.txt')),
      protectedInputsUnchanged: report.stageCleanupSafe && baselineEvidence.requestUnchanged && protectedInputs() &&
        verifyGovernedSource(baseline.checkout, verified, { allowBuildOutputs: true }),
      preparedTreeUnchanged: false, missionWorkspaceVerified: false,
      missionWorkspace: null, doctorEventLogMatches: null,
    };
    if (report.stageCleanupSafe) {
      const workspace = inspectBaselineWorkspace(baseline.workspace);
      baselineHost.missionWorkspace = workspace;
      baselineHost.missionWorkspaceVerified = workspace.eventLogVerified && workspace.sqliteHeaderVerified;
      const doctor = baselineWorkload?.doctorEvidence;
      if (workspace.eventLogVerified && doctor && doctor.eventLogHead !== null) {
        baselineHost.doctorEventLogMatches = doctor.eventLogHead === workspace.eventLogHead &&
          doctor.recordsVerified === workspace.eventLogRecords;
      }
      try {
        baselineHost.preparedTreeUnchanged = inspectGovernedBuild(baseline.checkout).treeSha256 === report.prepared.treeSha256;
      } catch { /* The prepared tree cannot be re-attested. */ }
    }
    const baselinePassed = baselineEvidence.native.exitCode === 0 && baselineWorkload?.state === 'GOVERNED_PASSED' &&
      baselineHost.startedMarkerVerified && baselineHost.checkoutWriteDenied && baselineHost.protectedInputsUnchanged &&
      baselineHost.preparedTreeUnchanged && baselineHost.missionWorkspaceVerified && baselineHost.doctorEventLogMatches === true;
    report.cases.baseline = {
      ...baselineEvidence.native, state: baselinePassed ? 'ADMITTED_AND_OBSERVED' : 'UNVERIFIED',
      workload: baselineWorkload, host: baselineHost,
    };
    if (baselinePassed && report.stageCleanupSafe) report.state = 'GOVERNED_WORKLOAD_OBSERVED';
  } catch (error) {
    if (typeof error?.message === 'string' && /^GOVERNED_[A-Z0-9_]{1,70}$/u.test(error.message)) report.inputBlocker = error.message;
  }
  return report;
}
