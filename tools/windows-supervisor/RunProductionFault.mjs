/** Runs only the fixed owner-loss fixture using an already verified production registration. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, isIPv4 } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { externalReportPath, writeExternalReport } from '../verification-support.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureSha256 = '01d2e81ed997d10f951816bf448a816fac167e65604175b329a0eb4244f2d6d8';
const nodeSha256 = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19';
const hex = /^[a-f0-9]{64}$/u;
const abortLine = /^\[CLU-E governed WFP\] ActiveFaultSample GOVERNED_WFP_ACTIVE_OWNER_LOSS_ABORT\r?$/gmu;
const receiptFlags = ['identityVerified', 'leaseVerified', 'jobEmpty', 'removalVerified', 'productionBackupVerified',
  'ownerExitVerified', 'nodeExited', 'releaseWithheld', 'backupSurvived'];

function exact(path, kind) {
  const info = lstatSync(path);
  if (relative(path, realpathSync.native(path)) !== '' ||
      (kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
    throw new Error('FAULT_PATH_UNVERIFIED');
  }
  return path;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function pin(path, expected, maxBytes) {
  exact(path, 'file');
  const before = lstatSync(path, { bigint: true });
  if (before.size < 1n || before.size > BigInt(maxBytes)) throw new Error('FAULT_FILE_SIZE_UNVERIFIED');
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (BigInt(bytes.length) !== before.size || before.ino !== after.ino || before.dev !== after.dev ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || digest(bytes) !== expected) {
    throw new Error('FAULT_FILE_PIN_UNVERIFIED');
  }
  return bytes;
}

function readFixture() {
  const path = exact(join(root, 'tools', 'windows-supervisor', 'ProductionFaultFixture.cjs'), 'file');
  if (lstatSync(path).size > 16000) throw new Error('FAULT_FIXTURE_SIZE_UNVERIFIED');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).replaceAll('\r\n', '\n');
  if (digest(source) !== fixtureSha256) throw new Error('FAULT_FIXTURE_PIN_UNVERIFIED');
  return source;
}

function privateIp(value) {
  if (!isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function options(args) {
  const keys = ['peer', 'peer-port', 'control-nonce', 'probe-nonce', 'supervisor', 'supervisor-sha', 'output'];
  if (args.length !== keys.length * 2) throw new Error('FAULT_ARGUMENTS_UNVERIFIED');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (args[i] !== '--' + key || !keys.includes(key) || Object.hasOwn(values, key)) throw new Error('FAULT_ARGUMENTS_UNVERIFIED');
    values[key] = args[i + 1];
  }
  if (!privateIp(values.peer) || !/^[1-9][0-9]{0,4}$/u.test(values['peer-port']) || Number(values['peer-port']) > 65535 ||
      !hex.test(values['control-nonce']) || !hex.test(values['probe-nonce']) || values['control-nonce'] === values['probe-nonce'] ||
      !hex.test(values['supervisor-sha']) || !/^[A-Za-z]:\\/u.test(values.supervisor)) throw new Error('FAULT_ARGUMENTS_UNVERIFIED');
  return { peer: values.peer, peerPort: Number(values['peer-port']), controlNonce: values['control-nonce'],
    probeNonce: values['probe-nonce'], image: values.supervisor, imageSha: values['supervisor-sha'],
    output: externalReportPath(root, values.output) };
}

function frame(role, sequence, nonce) {
  return 'CLU-E-PEER/2 ' + role + ' ' + String(sequence).padStart(6, '0') + ' ' + nonce + '\n';
}

function exchange(host, port, kind, sequence, nonce) {
  return new Promise((done) => {
    const socket = createConnection({ host, port, family: 4 });
    const request = frame(kind, sequence, nonce);
    const response = frame('ACK ' + kind, sequence, nonce);
    let observed = '';
    const timer = setTimeout(() => finish(false), 2000);
    function finish(value) {
      clearTimeout(timer);
      socket.destroy();
      done(value);
    }
    socket.on('error', () => finish(false));
    socket.on('end', () => finish(false));
    socket.on('data', (chunk) => {
      observed += chunk.toString('ascii');
      if (observed === response) finish(true);
      else if (!response.startsWith(observed)) finish(false);
    });
    socket.once('connect', () => {
      if (socket.remoteAddress !== host || socket.remotePort !== port) return finish(false);
      socket.write(request);
    });
  });
}

async function loopback(controlNonce, probeNonce, report) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(1600, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    let observed = '';
    socket.on('data', (chunk) => {
      observed += chunk.toString('ascii');
      if (observed.length > 100) return socket.destroy();
      if (!observed.endsWith('\n')) return;
      for (const sequence of [2, 3]) {
        if (observed === frame('L', sequence, probeNonce)) {
          report.hostLeakCount += 1;
          socket.destroy();
          return;
        }
      }
      for (const sequence of [1, 2, 3, 4]) {
        if (observed === frame('C', sequence, controlNonce) && socket.remoteAddress === '127.0.0.1') {
          socket.end(frame('ACK C', sequence, controlNonce));
          return;
        }
      }
      socket.destroy();
    });
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, done);
  });
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
    },
  };
}

async function positiveControl(options, endpoint, report, name, sequence) {
  const [host, peer] = await Promise.all([
    exchange('127.0.0.1', endpoint.port, 'C', sequence, options.controlNonce),
    exchange(options.peer, options.peerPort, 'C', sequence, options.controlNonce),
  ]);
  report.controls[name] = { sequence, host, peer };
  if (!host || !peer) throw new Error('FAULT_POSITIVE_CONTROL_UNVERIFIED');
}

function makeRequest(scratch, scope, endpoint, options, source) {
  const node = exact(realpathSync.native(process.execPath), 'file');
  const systemRoot = exact(realpathSync.native(process.env.SystemRoot ?? 'C:\\Windows'), 'directory');
  const system32 = exact(join(systemRoot, 'System32'), 'directory');
  const temp = join(scratch, 'temp');
  const home = join(scratch, 'home');
  const requests = join(scratch, 'requests');
  const cwd = join(scope, 'baseline');
  const workspace = join(scope, 'workspace');
  for (const path of [temp, home, requests, cwd, workspace]) mkdirSync(path);
  const cache = join(home, 'npm-cache');
  mkdirSync(cache);
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(home, name), '', { flag: 'wx' });
  const dir = mkdtempSync(join(requests, 'request-'));
  const file = join(dir, 'request.json');
  const env = {
    PATH: dirname(node) + ';' + system32, HOME: home, TEMP: temp, TMP: temp, TMPDIR: temp,
    CI: '1', NO_COLOR: '1', NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_USERCONFIG: join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
    NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: join(system32, 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
  };
  const bytes = JSON.stringify({
    schemaVersion: 'clue-proof-exec/1', command: node, cwd,
    args: ['-e', source, '--', 'clue-production-fault/1', String(endpoint.port), options.peer,
      String(options.peerPort), options.probeNonce],
    readOnlyRoots: [dirname(node), systemRoot, cwd], writableRoots: [workspace, temp, home], env, timeoutMs: 45000, denyNetwork: true,
  });
  writeFileSync(file, bytes, { flag: 'wx' });
  return { file, bytes, dir, temp, env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: system32 } };
}

function launch(image, request) {
  const child = spawn(image, ['--request-file', request.file], {
    cwd: request.dir, env: request.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let done = false;
  let stderr = '';
  let overflow = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderr.length + chunk.length > 64 * 1024) overflow = true;
    if (!overflow) stderr += chunk;
  });
  const result = new Promise((resolve) => {
    child.once('error', () => { done = true; resolve({ exit: null, abortMarker: false }); });
    child.once('close', (exit) => {
      done = true;
      const abortMarker = !overflow && [...stderr.matchAll(abortLine)].length === 1;
      const codes = [...stderr.matchAll(/^\[CLU-E (?:governed WFP|production proof|supervisor)\] ([A-Za-z0-9_ .()]{1,112})\r?$/gmu)]
        .slice(0, 6).map((match) => match[1]);
      resolve({ exit, abortMarker, codes: overflow ? [] : codes });
    });
  });
  return { result, exited: () => done, stop: () => { if (!done) child.kill(); } };
}

async function waitGate(request, phase, running) {
  const deadline = performance.now() + 24000;
  do {
    const matches = readdirSync(request.temp).filter((name) => /^clue-wfp-[a-f0-9]{32}$/u.test(name));
    if (matches.length > 1) throw new Error('FAULT_GATE_AMBIGUOUS');
    if (matches.length === 1) {
      const gate = exact(join(request.temp, matches[0]), 'directory');
      const marker = join(gate, 'wfp-' + phase + '-go.txt');
      if (lstatSync(marker, { throwIfNoEntry: false })) {
        if (readFileSync(exact(marker, 'file'), 'ascii') !== 'GO') throw new Error('FAULT_GATE_INVALID');
        return gate;
      }
    }
    if (running.exited()) throw new Error('FAULT_WRAPPER_EXITED_BEFORE_GATE');
    await pause(30);
  } while (performance.now() < deadline);
  throw new Error('FAULT_GATE_TIMEOUT');
}

function nativeReceipt(request) {
  const file = exact(join(request.dir, 'wfp-integration-result.json'), 'file');
  if (lstatSync(file).size > 4096) throw new Error('FAULT_RECEIPT_SIZE_UNVERIFIED');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  const sameLanes = (arr, size, expected) => Array.isArray(arr) && arr.length === size &&
    arr.every((code, index) => expected(code, index));
  const denied = (code, index) => index < 4 ? code === 10013 : [10013, 10051, 10061].includes(code);
  if (value?.schemaVersion !== 'clue-windows-production-fault/1' || value.proofAuthorization !== false ||
      !['PRODUCTION_WFP_ACTIVE_LOSS_OBSERVED', 'PRODUCTION_WFP_ACTIVE_LOSS_UNVERIFIED'].includes(value.state) ||
      !receiptFlags.every((flag) => typeof value[flag] === 'boolean')) throw new Error('FAULT_RECEIPT_SCHEMA_UNVERIFIED');
  const arrays = ['control', 'armed', 'active', 'fault'];
  const selected = Object.fromEntries(arrays.map((name) => [
    name, sameLanes(value[name], name === 'control' || name === 'armed' ? 4 : 6,
      (code) => Number.isInteger(code) && code >= 0 && code <= 65535) ? value[name] : null,
  ]));
  return {
    state: value.state,
    ...Object.fromEntries(receiptFlags.map((flag) => [flag, value[flag]])),
    ...selected,
    verified: value.state === 'PRODUCTION_WFP_ACTIVE_LOSS_OBSERVED' && receiptFlags.every((flag) => value[flag]) &&
      sameLanes(selected.control, 4, (code) => code === 0) && sameLanes(selected.armed, 4, (code) => code === 10013) &&
      sameLanes(selected.active, 6, denied) && sameLanes(selected.fault, 6, denied),
  };
}

async function drive(options, report) {
  let endpoint, scratch, scope, running, request;
  try {
    const node = realpathSync.native(process.execPath);
    pin(node, nodeSha256, 128 * 1024 * 1024);
    pin(options.image, options.imageSha, 16 * 1024 * 1024);
    const source = readFixture();
    endpoint = await loopback(options.controlNonce, options.probeNonce, report);
    await positiveControl(options, endpoint, report, 'before', 1);
    const temp = exact(realpathSync.native(tmpdir()), 'directory');
    scratch = exact(mkdtempSync(join(temp, 'clue-exec-')), 'directory');
    scope = exact(mkdtempSync(join(temp, 'clue-network-fault-')), 'directory');
    request = makeRequest(scratch, scope, endpoint, options, source);
    running = launch(options.image, request);
    for (const [phase, sequence] of [['active', 2], ['fault', 3]]) {
      const gate = await waitGate(request, phase, running);
      await positiveControl(options, endpoint, report, phase, sequence);
      if (running.exited()) throw new Error('FAULT_WRAPPER_EXITED_BEFORE_SAMPLE');
      writeFileSync(join(gate, 'wfp-peer-' + phase + '-ready.txt'), 'GO', { flag: 'wx' });
    }
    report.process = await Promise.race([running.result, pause(18000, null, { ref: false })]);
    if (!report.process) throw new Error('FAULT_WRAPPER_DEADLINE');
    report.native = nativeReceipt(request);
    report.requestUnchanged = readFileSync(exact(request.file, 'file'), 'utf8') === request.bytes;
    pin(options.image, options.imageSha, 16 * 1024 * 1024);
    report.imageReverified = true;
  } catch (error) {
    report.blocker = /^FAULT_[A-Z0-9_]{1,68}$/u.test(error?.message ?? '') ? error.message : 'FAULT_DRIVER_FAILED';
  } finally {
    if (running) {
      running.stop();
      report.process ??= await Promise.race([running.result, pause(3000, null, { ref: false })]);
      if (report.native === null && request && running.exited()) {
        try { report.native = nativeReceipt(request); } catch { /* Invalid or absent remains unverified. */ }
      }
    }
    if (endpoint) {
      try { await positiveControl(options, endpoint, report, 'after', 4); }
      catch { report.blocker ??= 'FAULT_RECOVERY_CONTROL_UNVERIFIED'; }
      await endpoint.close();
    }
    report.peerFinishAck = await exchange(options.peer, options.peerPort, 'F', 5, options.controlNonce);
    const owned = [scratch, scope].filter(Boolean);
    if (owned.length > 0) {
      report.cleanup = 'RETAINED';
      if (!running || (running.exited() && report.native?.jobEmpty === true && report.native?.removalVerified === true)) {
        try {
          for (const path of owned) rmSync(exact(path, 'directory'), { recursive: true, force: true, maxRetries: 3 });
          report.cleanup = 'REMOVED';
        } catch { report.blocker ??= 'FAULT_STAGE_CLEANUP_UNVERIFIED'; }
      }
    }
  }
  if (report.blocker === null && report.native?.verified && report.process?.exit === 125 && report.process.abortMarker &&
      report.requestUnchanged && report.imageReverified && report.hostLeakCount === 0 &&
      ['before', 'active', 'fault', 'after'].every((phase) => report.controls[phase]?.host && report.controls[phase]?.peer) &&
      report.cleanup === 'REMOVED' && report.peerFinishAck) {
    report.state = 'PRODUCTION_NETWORK_FAULT_OBSERVED';
  } else report.blocker ??= 'FAULT_REQUIRED_EVIDENCE_UNVERIFIED';
}

try {
  if (process.platform !== 'win32') throw new Error('FAULT_NATIVE_WINDOWS_REQUIRED');
  const settings = options(process.argv.slice(2));
  const report = { schemaVersion: 'clue-windows-production-fault-driver/1', checkedAt: new Date().toISOString(),
    state: 'PRODUCTION_NETWORK_FAULT_UNVERIFIED', proofAuthorization: false, supervisorSha256: settings.imageSha,
    scope: 'PRIMARY_OWNER_LOSS_HEALTHY_BFE_SAME_PC_VIRTUAL_IPV4_TCP', blocker: null,
    controls: {}, hostLeakCount: 0, native: null, process: null, requestUnchanged: false,
    imageReverified: false, peerFinishAck: false, cleanup: 'NOT_REQUIRED' };
  await drive(settings, report);
  writeExternalReport(root, settings.output, report);
  console.info('CLU-E native fault driver', report.state, report.blocker ?? '');
  if (report.state !== 'PRODUCTION_NETWORK_FAULT_OBSERVED') process.exitCode = 1;
} catch {
  console.error('CLU-E native fault driver could not write an evidence report.');
  process.exitCode = 2;
}
