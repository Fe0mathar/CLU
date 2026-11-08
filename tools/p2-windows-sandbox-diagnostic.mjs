#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { release, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { externalReportPath, writeExternalReport } from './verification-support.mjs';
import { buildWindowsSandboxConfiguration } from './windows-supervisor/windowsSandboxConfiguration.mjs';
import { parseWindowsSandboxInventory } from './windows-supervisor/windowsSandboxCli.mjs';
import { startWindowsSandboxHostEndpoint } from './windows-supervisor/windowsSandboxHostEndpoint.mjs';
import { exerciseWindowsSandboxSession } from './windows-supervisor/windowsSandboxSession.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'tools', 'windows-supervisor');
const maxReceiptBytes = 4096;
const lanes = ['ipv4Tcp', 'ipv6Tcp', 'ipv4Udp', 'ipv6Udp'];
const bindOutcomes = ['BIND_ALLOWED', 'BIND_DENIED', 'BIND_UNAVAILABLE', 'BIND_ERROR'];
const connectionOutcomes = ['NOT_REQUESTED', 'CONNECTION_OBSERVED', 'REFUSED', 'UNREACHABLE', 'TIMED_OUT', 'DENIED', 'ERROR'];
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const defaultReport = join(dirname(root), 'release-evidence', `CLU-E_WINDOWS_SANDBOX_DIAGNOSTIC_${stamp}_${randomBytes(4).toString('hex')}.json`);
const usage = 'Usage: node tools/p2-windows-sandbox-diagnostic.mjs [--check-only] [--output <new external .json>]';

function readOptions(args) {
  let checkOnly = false;
  let output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check-only' && !checkOnly) checkOnly = true;
    else if (args[i] === '--output' && output === undefined && /\.json$/iu.test(args[i + 1] ?? '')) output = args[++i];
    else throw new Error('OPTIONS_INVALID');
  }
  return { checkOnly, output: output ?? defaultReport };
}

function inside(parent, child) {
  const delta = relative(parent, child);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

function physicalDirectory(path) {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || relative(path, realpathSync.native(path)) !== '') {
    throw new Error('DIRECTORY_IDENTITY_UNVERIFIED');
  }
  return path;
}

function childEnvironment(systemRoot) {
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32') };
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'SystemDrive', 'ProgramFiles', 'ProgramData']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function invokeWindows(command, args, systemRoot, timeout, signal) {
  return new Promise((done) => {
    execFile(command, args, {
      cwd: join(systemRoot, 'System32'),
      env: childEnvironment(systemRoot), encoding: 'utf8', timeout, signal,
      maxBuffer: 32_768, windowsHide: true,
    }, (error, stdout, stderr) => {
      const hresult = (stderr.match(/\b0x[0-9a-f]{8}\b/iu) ?? stdout.match(/\b0x[0-9a-f]{8}\b/iu))?.[0] ?? null;
      done({
        code: error === null ? 0 : Number.isInteger(error.code) ? error.code : null,
        stdout,
        hresult,
        failure: error === null ? null : signal?.aborted ? 'INTERRUPTED' : error.killed ? 'TIME_OR_OUTPUT_LIMIT'
          : Number.isInteger(error.code) ? 'NONZERO_EXIT' : 'PROCESS_UNAVAILABLE',
      });
    });
  });
}

function validPreflight(value) {
  return value && ['SUPPORTED', 'HOME', 'UNKNOWN'].includes(value.edition) &&
    ['ENABLED', 'DISABLED', 'ABSENT', 'UNKNOWN'].includes(value.feature) &&
    (typeof value.hypervisorPresent === 'boolean' || value.hypervisorPresent === null) &&
    (value.appVersion === null || (typeof value.appVersion === 'string' && /^\d{1,8}(?:\.\d{1,8}){3}$/u.test(value.appVersion))) &&
    (value.cliKind === null && value.cliPath === null ||
      ['PACKAGE_ALIAS', 'USER_ALIAS', 'SYSTEM32'].includes(value.cliKind) &&
      typeof value.cliPath === 'string' && /^[A-Z]:\\[^\\].*\\wsb\.exe$/iu.test(value.cliPath) &&
      value.cliPath === win32.normalize(value.cliPath));
}

function readGuestResult(output, nonce) {
  physicalDirectory(output);
  const path = join(output, 'result.json');
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size < 2 || before.size > maxReceiptBytes || relative(path, realpathSync.native(path)) !== '') {
    throw new Error('FIXTURE_RESULT_FILE_INVALID');
  }
  const handle = openSync(path, 'r');
  let value;
  try {
    const sameFile = () => {
      const stat = fstatSync(handle);
      return stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
        stat.nlink === before.nlink && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    };
    if (!sameFile()) throw new Error('FIXTURE_RESULT_CHANGED');
    const bytes = Buffer.alloc(before.size);
    if (readSync(handle, bytes) !== bytes.length || !sameFile()) throw new Error('FIXTURE_RESULT_CHANGED');
    value = JSON.parse(bytes.toString('utf8'));
  } finally {
    closeSync(handle);
  }

  if (value?.schemaVersion !== 'clue-windows-sandbox-fixture-result/1' ||
      value.fixtureVersion !== 1 || value.nonce !== nonce ||
      !['PROTECTED', 'WRITE_SUCCEEDED', 'UNVERIFIED'].includes(value.inputWriteState) ||
      !connectionOutcomes.includes(value.hostConnection) ||
      !lanes.every((lane) => bindOutcomes.includes(value.localhost?.[lane]))) {
    throw new Error('FIXTURE_RESULT_INVALID');
  }
  const network = {};
  for (const field of ['upNonLoopbackAdapters', 'ipv4DefaultRoutes', 'ipv6DefaultRoutes']) {
    const count = value.network?.[field];
    if (count !== null && (!Number.isInteger(count) || count < 0 || count > 1024)) {
      throw new Error('FIXTURE_RESULT_NETWORK_INVALID');
    }
    network[field] = count;
  }
  return {
    fixtureVersion: value.fixtureVersion,
    inputWriteState: value.inputWriteState,
    localhost: Object.fromEntries(lanes.map((lane) => [lane, value.localhost[lane]])),
    hostConnection: value.hostConnection,
    network,
  };
}

function removeFixtureStage(stage) {
  for (const name of readdirSync(physicalDirectory(stage))) {
    if (!['input', 'output'].includes(name)) throw new Error('FIXTURE_STAGE_UNEXPECTED_ENTRY');
    const path = physicalDirectory(join(stage, name));
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('FIXTURE_STAGE_UNEXPECTED_ENTRY');
      unlinkSync(join(path, entry.name));
    }
    rmdirSync(path);
  }
  rmdirSync(stage);
}

async function collectGuestResult(output, nonce, connect, signal) {
  const began = performance.now();
  while (!signal.aborted && performance.now() - began < 55_000) {
    const fixture = readGuestResult(output, nonce);
    if (fixture !== null) return fixture;
    if (performance.now() - began >= 7_000) connect();
    await delay(300);
  }
  return null;
}

function assessFixture(report, stage) {
  const fixture = report.session?.fixture;
  if (fixture === null || fixture === undefined) return;
  const marker = lstatSync(join(stage, 'input', 'write-probe.txt'), { throwIfNoEntry: false });
  report.inputMapping = marker !== undefined || fixture.inputWriteState === 'WRITE_SUCCEEDED' ? 'WRITE_OBSERVED'
    : fixture.inputWriteState === 'PROTECTED' ? 'WRITE_DENIAL_OBSERVED' : 'UNVERIFIED';
  const outcomes = Object.values(fixture.localhost);
  report.guestLocalhost = outcomes.includes('BIND_ALLOWED') ? 'BIND_AVAILABLE'
    : outcomes.every((state) => state === 'BIND_DENIED') ? 'BIND_DENIED_OBSERVED' : 'UNVERIFIED';

  if (report.session.cleanup !== 'EXACT_SESSION_ABSENT') return;
  const { ipv4DefaultRoutes, ipv6DefaultRoutes } = fixture.network;
  if (report.inputMapping === 'WRITE_OBSERVED' || report.hostEndpoint.guestReachability === 'CONNECTION_OBSERVED' ||
      ipv4DefaultRoutes > 0 || ipv6DefaultRoutes > 0) {
    report.state = 'WSB_FIXTURE_BOUNDARY_MISMATCH';
  } else if (report.inputMapping === 'WRITE_DENIAL_OBSERVED') {
    report.state = 'WSB_FIXTURE_COMPLETED';
  }
}

async function diagnose(checkOnly, signal) {
  const [major, minor, build] = release().split('.').map(Number);
  const report = {
    schemaVersion: 'clue-windows-sandbox-diagnostic/1',
    checkedAt: new Date().toISOString(),
    proofAuthorization: false,
    state: 'NATIVE_WINDOWS_REQUIRED',
    mode: checkOnly ? 'SUPPORT_ONLY' : 'HARMLESS_FIXTURE',
    host: { platform: process.platform, architecture: process.arch, build: process.platform === 'win32' ? build : null },
    preflight: null,
    preflightInvocation: null,
    session: null,
    stageCleanup: 'NOT_REQUIRED',
    inputMapping: 'NOT_MEASURED',
    guestLocalhost: 'NOT_MEASURED',
    hostEndpoint: { control: 'NOT_MEASURED', guestReachability: 'NOT_MEASURED', correlatedHostReceipt: null },
  };
  if (process.platform !== 'win32') return report;
  if (major !== 10 || minor !== 0 || !Number.isInteger(build) || build < 26100) {
    report.state = 'WSB_WINDOWS_11_24H2_REQUIRED';
    return report;
  }

  let stage;
  let endpoint;
  let id;
  let sessionInvoked = false;
  try {
    report.state = 'WSB_HOST_PREFLIGHT_UNAVAILABLE';
    const configuredRoot = process.env.SystemRoot;
    if (!/^[A-Z]:\\[^\\]+$/iu.test(configuredRoot ?? '')) return report;
    const systemRoot = physicalDirectory(configuredRoot);
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const discovered = await invokeWindows(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(source, 'WindowsSandboxHostPreflight.ps1'),
    ], systemRoot, 24000, signal);
    report.preflightInvocation = { exitCode: discovered.code, failure: discovered.failure };
    if (discovered.code !== 0) return report;
    const preflight = JSON.parse(discovered.stdout.trim());
    if (!validPreflight(preflight)) return report;
    const { cliPath, cliKind, edition, feature, hypervisorPresent, appVersion } = preflight;
    report.preflight = { cliKind, edition, feature, hypervisorPresent, appVersion };
    if (preflight.edition === 'HOME') report.state = 'WSB_WINDOWS_EDITION_UNSUPPORTED';
    else if (['DISABLED', 'ABSENT'].includes(preflight.feature)) report.state = 'WSB_FEATURE_NOT_ENABLED';
    else if (cliPath === null) report.state = 'WSB_CLI_UNAVAILABLE';
    else {
      const invoke = (args, timeout, operationSignal) => invokeWindows(cliPath, args, systemRoot, timeout, operationSignal);
      if (checkOnly) {
        report.state = 'WSB_INVENTORY_UNAVAILABLE';
        const listed = await invoke(['list', '--raw'], 6000, signal);
        if (listed.code === 0) report.state = parseWindowsSandboxInventory(listed.stdout).length
          ? 'WSB_EXISTING_SESSION' : 'WSB_AVAILABLE_FOR_FIXTURE';
        return report;
      }
      report.state = 'WSB_FIXTURE_STAGE_UNAVAILABLE';
      const physicalRoot = realpathSync.native(root);
      const temp = physicalDirectory(realpathSync.native(tmpdir()));
      if (inside(physicalRoot, temp)) return report;
      stage = mkdtempSync(join(temp, 'CLU-E-wsb-'));
      const input = join(stage, 'input');
      const output = join(stage, 'output');
      mkdirSync(input);
      mkdirSync(output);
      const configuration = buildWindowsSandboxConfiguration(physicalDirectory(input), physicalDirectory(output));
      const nonce = randomBytes(16).toString('hex');
      endpoint = await startWindowsSandboxHostEndpoint(nonce);
      report.hostEndpoint.control = endpoint.state;
      copyFileSync(join(source, 'WindowsSandboxFixture.ps1'), join(input, 'fixture.ps1'));
      writeFileSync(join(input, 'request.json'), JSON.stringify({
        schemaVersion: 'clue-windows-sandbox-fixture-input/1', nonce, hostEndpoint: endpoint.endpoint,
      }), { flag: 'wx' });
      id = randomUUID();
      console.log('Checking the Windows Sandbox session inventory and running the fixture if it is clear.');
      console.log(`Requested Sandbox ID: ${id}`);
      report.state = 'WSB_LIFECYCLE_UNVERIFIED';
      sessionInvoked = true;
      report.session = await exerciseWindowsSandboxSession({
        id, configuration, invoke, signal,
        collect: (connect) => collectGuestResult(output, nonce, connect, signal),
      });
      report.state = report.session.state;
      report.hostEndpoint.correlatedHostReceipt = endpoint.nonceReceived?.() ?? null;
      const observedConnection = report.hostEndpoint.correlatedHostReceipt || report.session.fixture?.hostConnection === 'CONNECTION_OBSERVED';
      const controlAfter = await endpoint.control?.();
      if (endpoint.endpoint !== null) {
        report.hostEndpoint.control = controlAfter ? 'CONNECTED_BEFORE_AND_AFTER' : 'FINAL_CONTROL_UNVERIFIED';
      }
      const guest = report.session.fixture?.hostConnection;
      report.hostEndpoint.guestReachability = observedConnection ? 'CONNECTION_OBSERVED'
        : controlAfter && ['REFUSED', 'UNREACHABLE', 'TIMED_OUT', 'DENIED'].includes(guest)
          ? 'NO_CONNECTION_OBSERVED' : 'UNVERIFIED';
      assessFixture(report, stage);
    }
  } catch {
    if (report.session?.fixture) report.state = 'WSB_FIXTURE_EVIDENCE_UNVERIFIED';
  } finally {
    endpoint?.close?.();
    if (stage !== undefined) {
      report.stageCleanup = 'RETAINED';
      const cleanup = report.session?.cleanup;
      if (!sessionInvoked || ['NOT_REQUIRED', 'EXACT_SESSION_ABSENT', 'NO_OWNED_SESSION_OBSERVED'].includes(cleanup)) {
        try {
          removeFixtureStage(stage);
          report.stageCleanup = 'REMOVED';
        } catch { }
      } else {
        report.retainedSessionId = id;
      }
      if (report.stageCleanup === 'RETAINED') console.log(`Fixture stage retained at ${stage}`);
      if (report.stageCleanup === 'RETAINED' && report.state === 'WSB_FIXTURE_COMPLETED') {
        report.state = 'WSB_FIXTURE_STAGE_CLEANUP_UNVERIFIED';
      }
    }
    if (signal.aborted && report.state !== 'WSB_CLEANUP_UNVERIFIED') report.state = 'WSB_INTERRUPTED';
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
    const { checkOnly, output } = readOptions(process.argv.slice(2));
    const path = externalReportPath(root, output);
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) throw new Error('OUTPUT_EXISTS');
    const report = await diagnose(checkOnly, interrupt.signal);
    const written = writeExternalReport(root, path, report);
    console.log(`Windows Sandbox diagnostic ${report.state}`);
    console.log(`Diagnostic report: ${written}`);
    if (!['WSB_FIXTURE_COMPLETED', 'WSB_AVAILABLE_FOR_FIXTURE'].includes(report.state)) process.exitCode = 1;
  } catch (error) {
    if (error.message === 'OPTIONS_INVALID') console.error(usage);
    else console.error('Could not write the diagnostic. Use a new .json path outside the project.');
    process.exitCode = 2;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
