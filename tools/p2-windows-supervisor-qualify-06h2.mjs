/** Native canaries for the separately installed Windows proof supervisor. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { externalReportPath, writeExternalReport } from './verification-support.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRED = [
  'allowed-command', 'filesystem-denied', 'secrets-denied', 'network-denied',
  'descendant-timeout', 'launcher-cancellation', 'tamper-refused',
];
const HOST_ONLY_KEYS = ['CLU_HOST_ONLY_CANARY', 'OPENAI_API_KEY', 'CLU_WINDOWS_SUPERVISOR_PATH', 'CLU_WINDOWS_SUPERVISOR_SHA256'];
const NORMAL_TIMEOUT = 12_000;
const PROCESS_DEADLINE = 5_000;
const DESCENDANT_DELAY = 8_000;

async function loopbackMatrix(net, dgram) {
  const socketState = (error, phase) => {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error?.code)) return 'UNAVAILABLE';
    if (['EACCES', 'EPERM'].includes(error?.code)) return phase + '_DENIED';
    return phase + '_ERROR';
  };

  function tcp(host) {
    return new Promise((resolve) => {
      let client;
      let finished = false;
      let phase = 'BIND';
      const server = net.createServer((peer) => peer.destroy());
      const timer = setTimeout(() => finish(phase + '_TIMEOUT'), 800);
      function finish(state) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        client?.destroy();
        server.close();
        resolve(state);
      }
      server.on('error', (error) => finish(socketState(error, 'BIND')));
      server.listen(0, host, () => {
        if (finished) return;
        phase = 'CONNECT';
        client = net.createConnection({ host, port: server.address().port });
        client.on('error', (error) => finish(socketState(error, 'CONNECT')));
        client.once('connect', () => finish('DELIVERED'));
      });
    });
  }

  function udp(host, type) {
    return new Promise((resolve) => {
      const receiver = dgram.createSocket(type);
      let sender;
      let finished = false;
      let phase = 'BIND';
      const timer = setTimeout(() => finish(phase + '_TIMEOUT'), 800);
      function close(socket) {
        if (socket) try { socket.close(); } catch { /* never bound or already closed */ }
      }
      function finish(state) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        close(sender);
        close(receiver);
        resolve(state);
      }
      receiver.on('error', (error) => finish(socketState(error, 'BIND')));
      receiver.on('message', (bytes) => { if (bytes.equals(Buffer.from('CLU-E'))) finish('DELIVERED'); });
      receiver.bind(0, host, () => {
        if (finished) return;
        phase = 'SEND';
        sender = dgram.createSocket(type);
        sender.on('error', (error) => finish(socketState(error, 'SEND')));
        sender.send('CLU-E', receiver.address().port, host, (error) => {
          if (error) finish(socketState(error, 'SEND'));
        });
      });
    });
  }

  return Object.fromEntries(await Promise.all([
    ['ipv4Tcp', tcp('127.0.0.1')], ['ipv6Tcp', tcp('::1')],
    ['ipv4Udp', udp('127.0.0.1', 'udp4')], ['ipv6Udp', udp('::1', 'udp6')],
  ].map(async ([name, result]) => [name, await result])));
}

const WFP_BOOTSTRAP = [
  "const fs = require('node:fs');",
  "const [mode, pidFile, gate] = process.argv.slice(1);",
  "const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));",
  "fs.writeFileSync(pidFile, String(process.pid), {flag:'wx'});",
  "(async () => {",
  "for (let i = 0; !fs.existsSync(gate); i++) { if (i >= 280) throw Error('gate'); await sleep(20); }",
  "if (fs.readFileSync(gate, 'utf8') !== 'GO') throw Error('gate');",
  "if (mode === 'deadline') { await sleep(20000); return; }",
  "const result = await (" + loopbackMatrix.toString() + ")(require('node:net'), require('node:dgram'));",
  "process.stdout.write(JSON.stringify(result));",
  "})().catch(() => { process.exitCode = 2; });",
].join('\n');

function wfpLeaseEvidence(run) {
  const pattern = /^\[CLU-E WFP\] (control|filtered|deadline) (0|1) ([0-6]) (0|1) (0|1) (0|1) (0|1)\r?$/gmu;
  const rows = [...run.stderr.matchAll(pattern)];
  if (rows.length !== 1) return null;
  const [, mode, token, filters, gate, jobEmpty, filtersRemoved, uniqueSid] = rows[0];
  return {
    mode, observedInJobPackageSid: token === '1', filterCount: Number(filters),
    gateReleased: gate === '1', jobEmpty: jobEmpty === '1', filtersRemoved: filtersRemoved === '1',
    uniqueSid: uniqueSid === '1',
  };
}

function wfpDropEvidence(run) {
  const ids = [...run.stderr.matchAll(/^\[CLU-E WFP IDS\] (65534) ([1-9]\d{0,19}(?: [1-9]\d{0,19}){5})\r?$/gmu)];
  const events = [...run.stderr.matchAll(/^\[CLU-E WFP DROPS\] ([A-Z0-9_]{1,96}) (\d{1,10}(?: \d{1,10}){9})\r?$/gmu)];
  const filterIds = ids.length === 1 ? ids[0][2].split(' ') : [];
  if (new Set(filterIds).size !== 6 || filterIds.some((id) => BigInt(id) > 18446744073709551615n)) {
    return { filterIds: null, verifiedSublayerWeight: null, state: 'FILTER_IDS_UNVERIFIED', hitsByFilter: null, bindHits: null };
  }
  const verifiedSublayerWeight = Number(ids[0][1]);
  const counts = events.length === 1 ? events[0][2].split(' ').map(Number) : [];
  if (counts.length !== 10 || counts.some((count) => count > 2147483647)) {
    return { filterIds, verifiedSublayerWeight, state: 'BFE_EVENT_EVIDENCE_UNAVAILABLE', hitsByFilter: null, bindHits: null };
  }
  return {
    filterIds, verifiedSublayerWeight,
    state: events[0][1],
    hitsByFilter: counts.slice(0, 6),
    bindHits: { ipv4Tcp: counts[6], ipv6Tcp: counts[7], ipv4Udp: counts[8], ipv6Udp: counts[9] },
  };
}

function matrixEvidence(value) {
  const keys = ['ipv4Tcp', 'ipv6Tcp', 'ipv4Udp', 'ipv6Udp'];
  const states = /^(DELIVERED|UNAVAILABLE|(?:BIND|CONNECT|SEND)_(?:DENIED|ERROR|TIMEOUT))$/u;
  if (value === null || typeof value !== 'object' ||
      !keys.every((key) => typeof value[key] === 'string' && states.test(value[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

async function exerciseWfp(report, run, workspace) {
  const dgram = await import('node:dgram');
  const net = await import('node:net');
  const hostBefore = await loopbackMatrix(net, dgram);
  const collect = async (mode, timeoutMs = NORMAL_TIMEOUT) => {
    const startedAt = new Date().toISOString();
    const result = await run({ timeoutMs, args: [
      '-e', WFP_BOOTSTRAP, mode, join(workspace, 'wfp-' + mode + '-pid.txt'), join(workspace, 'wfp-' + mode + '-gate.txt'),
    ] });
    return {
      startedAt, finishedAt: new Date().toISOString(),
      exitCode: result.code, timedOut: result.timedOut, lease: wfpLeaseEvidence(result),
      matrix: matrixEvidence(parsedOutput(result)), diagnostic: supervisorDiagnostic(result),
      dropEvidence: mode === 'filtered' ? wfpDropEvidence(result) : null,
      wfpError: result.stderr.match(/^\[CLU-E WFP ERROR\] (WFP_[A-Z0-9_]{1,70}(?:_0x[A-F0-9]{8})?)\r?$/mu)?.[1] ?? null,
    };
  };
  const control = await collect('control');
  const filtered = await collect('filtered');
  const deadline = filtered.lease?.filterCount === 6 ? await collect('deadline', 5000) : null;
  const hostAfter = await loopbackMatrix(net, dgram);
  const validLease = (item, mode) => item?.lease?.mode === mode &&
    item.lease.observedInJobPackageSid === true &&
    item.lease.filterCount === 6 && item.lease.gateReleased && item.lease.jobEmpty &&
    item.lease.filtersRemoved && item.lease.uniqueSid;
  const hostControl = Object.values(hostBefore).every((value) => value === 'DELIVERED') &&
    Object.values(hostAfter).every((value) => value === 'DELIVERED');
  const containedBlocked = filtered.matrix !== null &&
    Object.values(filtered.matrix).every((value) => value.endsWith('_DENIED'));
  const controlCompleted = control.matrix !== null && control.lease?.mode === 'control' &&
    control.lease.observedInJobPackageSid && control.lease.filterCount === 0 &&
    control.lease.gateReleased && control.lease.jobEmpty;
  const controlledDifference = containedBlocked && control.matrix !== null &&
    Object.values(control.matrix).every((value) => value === 'DELIVERED');
  const bindContrast = Boolean(controlCompleted && filtered.matrix !== null &&
    Object.entries(control.matrix).every(([key, value]) => {
      const postBindStep = key.endsWith('Tcp') ? 'CONNECT_' : 'SEND_';
      return (value === 'DELIVERED' || value.startsWith(postBindStep)) && filtered.matrix[key] === 'BIND_DENIED';
    }));
  const leaseLifecycle = validLease(filtered, 'filtered') && validLease(deadline, 'deadline') &&
    deadline.exitCode === 124 && !deadline.timedOut;
  report.wfp = { hostBefore, hostAfter, hostControl, control, filtered, deadline, containedBlocked,
    controlCompleted, controlledDifference, bindContrast, leaseLifecycle };
  if (!leaseLifecycle || !hostControl || !controlCompleted || !containedBlocked) report.wfpStatus = 'FAIL';
  else if (bindContrast) report.wfpStatus = 'BIND_DENIAL_CONTRAST_OBSERVED';
  else if (controlledDifference) report.wfpStatus = 'FILTER_DIFFERENTIAL_OBSERVED';
  else report.wfpStatus = 'FILTER_BOUND_ATTRIBUTION_UNPROVEN';
  console.info('[CLU-E WFP diagnostic]', report.wfpStatus);
}

function sameText(path, expected) {
  try { return readFileSync(path, 'utf8') === expected; }
  catch { return false; }
}

function parsedOutput(run) {
  if (run.code !== 0 || run.timedOut) return null;
  try { return JSON.parse(run.stdout); }
  catch { return null; }
}

function supervisorDiagnostic(run) {
  // Report a bounded code from the supervisor's refusal path. Keep raw output private.
  if (run.code !== 125) return null;
  const phase = '(?:REQUEST_READ|ENGINE_PIN|CONFIG_WRITE|ENGINE_RUN|ENGINE_LOG)';
  const site = '(?:SITE_UNAVAILABLE|(?:Protocol|Supervisor|NativeJob)\\.[A-Za-z][A-Za-z0-9]{0,63})';
  const logState = '(?:LOG_UNAVAILABLE|LOG_LIMIT|LOG_RECORD_INVALID|ENFORCEMENT_DEGRADED|CONFIG_REJECTED|EXIT_RECORD_MISMATCH|NO_EXIT_RECORD)';
  const pattern = new RegExp(
    '^\\[CLU-E supervisor\\] (MXC_IMAGE_PIN_MISMATCH|MXC_EXECUTION_REFUSED(?: ENGINE_EXIT_-?\\d{1,10} ' + logState +
    ')?|WIN32_ERROR_\\d{1,10}(?: ' + phase + ')?|REFUSED \\([A-Za-z]{1,64}\\)\\.(?: ' + phase + ' ' + site + ')?)\\r?$',
    'gmu',
  );
  const matches = [...run.stderr.matchAll(pattern)];
  return matches.length === 1 ? matches[0][1] : null;
}

function windowsExitEvidence(run) {
  if (!Number.isInteger(run.code) || run.code < -2147483648 || run.code > 4294967295) return null;
  const hex = '0x' + (run.code >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const markers = [...run.stderr.matchAll(/^\[CLU-E supervisor\] WORKLOAD_EXIT_(0x[A-F0-9]{8})\r?$/gmu)];
  return {
    hex,
    confirmedWorkloadExit: markers.length === 1 && markers[0][1] === hex,
  };
}

function deadlineNativeNotes(run) {
  const wfp = /^\[CLU-E governed WFP\] (NodeStart|Control|Armed|Workload|Drain|OwnerLoss|Active|ActiveFault|ActiveFaultSample) (GOVERNED_WFP_[A-Z0-9_]{1,62}|WIN32_ERROR_[0-9]{1,10}|TIMEOUT|REFUSED)\r?$/gmu;
  const production = /^\[CLU-E production proof\] (PRODUCTION_PROOF_[A-Z0-9_]{1,74})\r?$/gmu;
  const terminal = /^\[CLU-E supervisor\] (GOVERNED_WFP_INTEGRATION_INCOMPLETE|WFP_BOOTSTRAP_LIFECYCLE_INCOMPLETE|PRODUCTION_PROOF_[A-Z0-9_]{1,74})\r?$/mu;
  return {
    supervisorDiagnostic: supervisorDiagnostic(run) ?? terminal.exec(run.stderr)?.[1] ?? null,
    wfp: [...run.stderr.matchAll(wfp)].slice(0, 4).map(([, phase, code]) => ({ phase, code })),
    production: [...run.stderr.matchAll(production)].slice(0, 4).map(([, code]) => code),
    exitEvidence: windowsExitEvidence(run),
  };
}

function deadlineWfpReceipt(staged, privateRoot) {
  const unverified = { state: 'UNVERIFIED' };
  const path = join(staged.dir, 'wfp-integration-result.json');
  try {
    if (dirname(staged.dir) !== privateRoot || !/^request-[A-Za-z0-9]{6}$/u.test(basename(staged.dir)) ||
        staged.file !== join(staged.dir, 'request.json') || !lstatSync(staged.dir).isDirectory() ||
        relative(staged.dir, realpathSync.native(staged.dir)) !== '') return unverified;
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (!before) return { state: 'ABSENT' };
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 4096 ||
        relative(path, realpathSync.native(path)) !== '') return unverified;
    const sameFile = (item) => item.isFile() && item.nlink === 1 && item.dev === before.dev &&
      item.ino === before.ino && item.size === before.size && item.mtimeMs === before.mtimeMs && item.ctimeMs === before.ctimeMs;
    const fd = openSync(path, 'r');
    const bytes = Buffer.alloc(before.size);
    try {
      if (!sameFile(fstatSync(fd))) return unverified;
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) return unverified;
        offset += count;
      }
      if (!sameFile(fstatSync(fd)) || !sameFile(lstatSync(path)) ||
          relative(path, realpathSync.native(path)) !== '') return unverified;
    } finally { closeSync(fd); }

    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const receipt = JSON.parse(text);
    const flags = ['identityVerified', 'leaseVerified', 'jobEmpty', 'removalVerified', 'productionBackupVerified'];
    const keys = ['schemaVersion', 'state', ...flags, 'control', 'armed', 'proofAuthorization'];
    const writtenKeys = [...text.matchAll(/"([A-Za-z]+)"\s*:/gu)].map(([, key]) => key);
    const lanes = (value) => value === null || (Array.isArray(value) && value.length === 4 &&
      value.every((code) => code === 0 || code === 10013));
    if (receipt === null || typeof receipt !== 'object' || Object.keys(receipt).length !== keys.length ||
        writtenKeys.length !== keys.length || !keys.every((key) => writtenKeys.includes(key) && Object.hasOwn(receipt, key)) ||
        receipt.schemaVersion !== 'clue-windows-production-wfp/1' || receipt.proofAuthorization !== false ||
        !['PRODUCTION_WFP_LIFECYCLE_VERIFIED', 'PRODUCTION_WFP_LIFECYCLE_UNVERIFIED'].includes(receipt.state) ||
        !flags.every((key) => typeof receipt[key] === 'boolean') || !lanes(receipt.control) || !lanes(receipt.armed)) return unverified;
    if (receipt.state === 'PRODUCTION_WFP_LIFECYCLE_VERIFIED' && (!flags.every((key) => receipt[key]) ||
        !receipt.control?.every((code) => code === 0) || !receipt.armed?.every((code) => code === 10013))) return unverified;
    return { state: 'VALID', receipt };
  } catch {
    return unverified;
  }
}

function writeRequest(root, request) {
  const dir = mkdtempSync(join(root, 'request-'));
  const file = join(dir, 'request.json');
  writeFileSync(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  return { dir, file };
}

function positiveProbe(paths, token, oddArgument) {
  const script = [
    "const fs = require('node:fs');",
    "const [input, output, token, expectedCwd, oddArgument] = process.argv.slice(1);",
    "fs.writeFileSync(output, token, {flag:'wx'});",
    "process.stdout.write(JSON.stringify({read:fs.readFileSync(input,'utf8')===token,",
    "cwd:process.cwd().toLowerCase()===expectedCwd.toLowerCase(), oddArgument, marker:process.env.CLU_ALLOWED_CANARY===token}));",
  ].join(' ');
  return {
    script,
    args: [paths.input, paths.output, token, paths.cwd, oddArgument],
  };
}

const FILE_PROBE = [
  "const fs=require('node:fs');",
  "const [readonly, outside, otherWorkspace, fakeCredential, traversal, alias, stream, requestFile, marker] = process.argv.slice(1);",
  "function denies(operation){try{operation();return false;}catch(error){return ['EACCES','EPERM','ENOENT','ENOTDIR','ELOOP'].includes(error.code);}}",
  "const denied=(path)=>denies(()=>fs.readFileSync(path))&&denies(()=>fs.writeFileSync(path,'unexpected-canary'));",
  "fs.writeFileSync(marker,'started',{flag:'wx'});",
  "process.stdout.write(JSON.stringify({readonly:denies(()=>fs.writeFileSync(readonly,'unexpected-canary')),",
  "outside:denied(outside), otherWorkspace:denied(otherWorkspace), fakeCredential:denied(fakeCredential),",
  "traversal:denied(traversal), alias:denied(alias), stream:denies(()=>fs.writeFileSync(stream,'unexpected-canary')),",
  "request:denies(()=>fs.readFileSync(requestFile))}));",
].join(' ');

const JUNCTION_PROBE = [
  "const fs=require('node:fs');",
  "const [target, marker]=process.argv.slice(1);",
  "function denies(operation){try{operation();return false;}catch(error){return ['EACCES','EPERM','ENOENT','ENOTDIR','ELOOP'].includes(error.code);}}",
  "fs.writeFileSync(marker,'started',{flag:'wx'});",
  "process.stdout.write(JSON.stringify({denied:denies(()=>fs.readFileSync(target))&&denies(()=>fs.writeFileSync(target,'unexpected-canary'))}));",
].join(' ');

const SOCKET_PROBE = [
  "const net=require('node:net');",
  "const endpoints=JSON.parse(process.argv[1]);",
  "function reachable(host,port){return new Promise(resolve=>{const s=net.createConnection({host,port});",
  "function finish(value){s.destroy();resolve(value);}s.setTimeout(800,()=>finish(false));",
  "s.once('connect',()=>finish(true));s.once('error',()=>finish(false));});}",
  "async function localRoundTrip(){const server=net.createServer(s=>s.destroy());",
  "const address=await new Promise(resolve=>{server.once('error',()=>resolve(null));server.listen(0,'127.0.0.1',()=>resolve(server.address()));});",
  "if(address===null)return false;try{return await reachable('127.0.0.1',address.port);}finally{server.close();}}",
  "(async()=>{const [loopback,lan]=await Promise.all(endpoints.map(({host,port})=>reachable(host,port)));",
  "process.stdout.write(JSON.stringify({loopbackBlocked:!loopback,lanBlocked:!lan,guestLoopbackBlocked:!(await localRoundTrip())}));",
  "})().catch(()=>{process.exitCode=2;});",
].join(' ');

const DESCENDANT_PROBE = [
  "const fs=require('node:fs');",
  "const [pids,started,lateMarker,delayMs]=process.argv.slice(1);",
  "const code='const fs=require(\"node:fs\"); fs.writeFileSync(process.argv[1],\"started\",{flag:\"wx\"});'",
  "  +'setTimeout(()=>fs.writeFileSync(process.argv[2],\"survived\",{flag:\"wx\"}), Number(process.argv[3]));';",
  "const child=require('node:child_process').spawn(process.execPath,['-e',code,started,lateMarker,delayMs],",
  "  {stdio:'ignore',windowsHide:true});",
  "child.once('spawn',()=>fs.writeFileSync(pids, JSON.stringify({parent:process.pid,descendant:child.pid}),{flag:'wx'}));",
  "child.once('error',()=>{process.exitCode=2;});",
  "setTimeout(()=>{},Number(delayMs)+2000);",
].join(' ');

function reachable(host, port) {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    const finish = (value) => { socket.destroy(); done(value); };
    socket.setTimeout(1_000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function listener(host) {
  const server = createServer((socket) => socket.destroy());
  // Keep the handler installed even after bind so an asynchronous network event is not fatal.
  await new Promise((done, reject) => {
    server.on('error', reject);
    server.listen(0, host, done);
  });
  return { host, port: server.address().port, close: () => server.close() };
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
  }
}

function readProcessPair(files) {
  if (!sameText(files.started, 'started')) return null;
  try {
    const pids = JSON.parse(readFileSync(files.pids, 'utf8'));
    if (pids.parent === pids.descendant || alive(pids.parent) !== true || alive(pids.descendant) !== true) return null;
    return pids;
  } catch { return null; }
}

async function observeProcessPair(files, budget) {
  const started = performance.now();
  while (performance.now() - started < budget) {
    const pids = readProcessPair(files);
    if (pids !== null) return pids;
    await delay(40);
  }
  return null;
}

async function observeTermination(files, pids) {
  if (pids === null) return false;
  const started = performance.now();
  while (performance.now() - started < 1_500) {
    if (alive(pids.parent) === false && alive(pids.descendant) === false && !existsSync(files.lateMarker)) return true;
    await delay(50);
  }
  return false;
}

function fixturePaths(output, name) {
  return { pids: join(output, name + '-pids.json'), started: join(output, name + '-started.txt'), lateMarker: join(output, name + '-survived.txt') };
}

async function exercise({ report, root, supervisor, resolveWindowsSupervisor, runBoundedProcess, wfpDiagnostic }) {
  const write = join(root, 'workspace');
  const candidate = join(root, 'candidate');
  const readonly = join(root, 'canonical-fixture');
  const outside = join(root, 'outside');
  const otherWorkspace = join(root, 'other-workspace');
  const privateRoot = join(root, 'private');
  const childTemp = join(write, 'temp');
  const systemRoot = realpathSync.native(process.env.SystemRoot ?? 'C:\\Windows');
  const node = realpathSync.native(process.execPath);
  const nodeDir = dirname(node);
  const system32 = join(systemRoot, 'System32');
  const token = randomBytes(16).toString('hex');
  const oddArgument = 'quoted space "&|%;^\\';
  for (const path of [write, candidate, readonly, outside, otherWorkspace, privateRoot, childTemp]) mkdirSync(path);
  const readonlyFile = join(readonly, 'source-canary.txt');
  const outsideFile = join(outside, 'private-canary.txt');
  const otherFile = join(otherWorkspace, 'separate-workspace.txt');
  const fakeCredential = join(outside, 'fake-credential.txt');
  for (const file of [readonlyFile, outsideFile, otherFile, fakeCredential]) writeFileSync(file, token, { flag: 'wx' });
  const caseAlias = join(outside, 'PRIVATE-CANARY.TXT');
  const readonlyAds = readonlyFile + ':clue-qualification-canary';
  const env = {
    PATH: nodeDir + ';' + system32, SystemRoot: systemRoot, WINDIR: systemRoot,
    ComSpec: join(system32, 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: childTemp,
    TMP: childTemp, TMPDIR: childTemp, HOME: childTemp, USERPROFILE: childTemp, APPDATA: childTemp,
    LOCALAPPDATA: childTemp, CLU_ALLOWED_CANARY: token,
  };
  const transportEnv = { ...env };
  const request = {
    schemaVersion: 'clue-proof-exec/1', command: node, args: [], cwd: readonly,
    readOnlyRoots: [nodeDir, systemRoot, readonly], writableRoots: [write],
    env, timeoutMs: NORMAL_TIMEOUT, denyNetwork: true,
  };
  function assertSameSupervisor() {
    const current = resolveWindowsSupervisor();
    if (current.sha256 !== supervisor.sha256 || current.command !== supervisor.command) throw new Error('changed supervisor');
  }
  async function run(overrides, outerEnv = transportEnv, captureDeadline = false) {
    assertSameSupervisor();
    const staged = writeRequest(privateRoot, { ...request, ...overrides });
    const result = await runBoundedProcess(supervisor.command, [...supervisor.argsPrefix, staged.file], {
      cwd: staged.dir, env: outerEnv, timeoutMs: (overrides.timeoutMs ?? NORMAL_TIMEOUT) + 2_000,
    });
    return captureDeadline ? { ...result, deadlineWfp: deadlineWfpReceipt(staged, privateRoot) } : result;
  }
  if (wfpDiagnostic) {
    await exerciseWfp(report, run, write);
    return;
  }
  function set(id, state, evidence = {}) {
    report.cases[id] = state;
    report.caseEvidence[id] = evidence;
    console.info('[CLU-E native qualification]', id, state);
  }

  const baseline = positiveProbe({ input: readonlyFile, output: join(write, 'baseline.txt'), cwd: readonly }, token, oddArgument);
  const changed = positiveProbe({ input: readonlyFile, output: join(candidate, 'candidate.txt'), cwd: candidate }, token, oddArgument);
  const baseRun = await run({ args: ['-e', baseline.script, ...baseline.args] });
  const candidateRun = await run({ cwd: candidate, writableRoots: [write, candidate], args: ['-e', changed.script, ...changed.args] });
  const passed = (result, file) => {
    const value = parsedOutput(result);
    return value?.read === true && value.cwd === true && value.marker === true && value.oddArgument === oddArgument && sameText(file, token);
  };
  const baselinePass = passed(baseRun, baseline.args[1]);
  const candidatePass = passed(candidateRun, changed.args[1]);
  set('allowed-command', baselinePass && candidatePass ? 'PASS' : 'FAIL', {
    baselinePass, candidatePass, baselineExit: baseRun.code, candidateExit: candidateRun.code,
    baselineDiagnostic: supervisorDiagnostic(baseRun), candidateDiagnostic: supervisorDiagnostic(candidateRun),
    baselineExitEvidence: windowsExitEvidence(baseRun), candidateExitEvidence: windowsExitEvidence(candidateRun),
  });
  if (!baselinePass || !candidatePass) return;

  let adsPremise = false;
  try {
    writeFileSync(readonlyAds, token, { flag: 'wx' });
    adsPremise = sameText(readonlyAds, token);
  } catch { /* the fixture cannot prove this check on unsupported filesystems */ }
  const traversal = write + '\\..\\outside\\private-canary.txt';
  const staged = writeRequest(privateRoot, request);
  writeFileSync(staged.file, JSON.stringify({ ...request, args: ['-e', FILE_PROBE, readonlyFile, outsideFile,
    otherFile, fakeCredential, traversal, caseAlias, readonlyAds, staged.file, join(write, 'filesystem-started.txt')] }));
  assertSameSupervisor();
  const filesystem = parsedOutput(await runBoundedProcess(supervisor.command, [...supervisor.argsPrefix, staged.file], {
    cwd: staged.dir, env: transportEnv, timeoutMs: NORMAL_TIMEOUT + 2_000,
  }));
  const junction = join(candidate, 'host-alias');
  const junctionMarker = join(write, 'junction-started.txt');
  let junctionPremise = false;
  let junctionBlocked = false;
  try {
    symlinkSync(outside, junction, 'junction');
    const aliasFile = join(junction, 'private-canary.txt');
    junctionPremise = sameText(aliasFile, token);
    if (junctionPremise) {
      const result = await run({
        cwd: candidate, writableRoots: [write, candidate], args: ['-e', JUNCTION_PROBE, aliasFile, junctionMarker],
      });
      junctionBlocked = parsedOutput(result)?.denied === true || (result.code === 125 && !existsSync(junctionMarker));
    }
  } catch { /* unknown availability is not a pass */ }
  finally { if (existsSync(junction)) rmSync(junction, { force: true }); }
  const unchanged = [readonlyFile, outsideFile, otherFile, fakeCredential].every((file) => sameText(file, token));
  const aliasPremise = sameText(caseAlias, token) && sameText(traversal, token);
  const filePass = filesystem !== null &&
    ['readonly', 'outside', 'otherWorkspace', 'fakeCredential', 'traversal', 'alias', 'stream', 'request']
      .every((key) => filesystem[key] === true);
  set('filesystem-denied', filePass && unchanged && adsPremise && sameText(readonlyAds, token) &&
    aliasPremise && junctionPremise && junctionBlocked ? 'PASS' : 'FAIL',
  { filePass, unchanged, adsPremise, aliasPremise, junctionPremise, junctionBlocked });

  const secretScript = [
    "const present=Object.keys(process.env).map(key=>key.toUpperCase());",
    "const requested=JSON.parse(process.argv[1]);",
    "process.stdout.write(JSON.stringify({denied:requested.every(key=>!present.includes(key)), allowlisted:!!process.env.CLU_ALLOWED_CANARY}));",
  ].join(' ');
  const fakeHostEnv = { ...transportEnv, ...Object.fromEntries(HOST_ONLY_KEYS.map((name) => [name, 'fixture-only-' + token])) };
  const secretRun = await run({ args: ['-e', secretScript, JSON.stringify(HOST_ONLY_KEYS)] }, fakeHostEnv);
  const secret = parsedOutput(secretRun);
  set('secrets-denied', secret?.denied === true && secret.allowlisted === true &&
    !secretRun.stdout.includes(token) && !secretRun.stderr.includes(token) ? 'PASS' : 'FAIL',
  { exit: secretRun.code, syntheticCanaries: true });

  const listeners = [];
  const lan = Object.values(networkInterfaces()).flat().find((value) => value?.family === 'IPv4' && !value.internal);
  try {
    if (lan === undefined) throw new Error('no active IPv4 interface');
    listeners.push(await listener('127.0.0.1'));
    listeners.push(await listener(lan.address));
    const endpoints = listeners.map(({ host, port }) => ({ host, port }));
    const hostControl = (await Promise.all(endpoints.map(({ host, port }) => reachable(host, port)))).every(Boolean);
    const network = hostControl ? parsedOutput(await run({ args: ['-e', SOCKET_PROBE, JSON.stringify(endpoints)] })) : null;
    set('network-denied', network?.loopbackBlocked === true && network.lanBlocked === true &&
      network.guestLoopbackBlocked === true ? 'PASS' : 'FAIL',
    { hostControl, hostLoopbackBlocked: network?.loopbackBlocked === true, nonLoopbackHostEndpointBlocked: network?.lanBlocked === true,
      confinedLoopbackBlocked: network?.guestLoopbackBlocked === true });
  } catch {
    set('network-denied', 'NOT_EXECUTED', { liveControlledEndpoints: false });
  } finally {
    for (const item of listeners) item.close();
  }

  const timed = fixturePaths(write, 'deadline');
  const deadlineStarted = performance.now();
  const timeout = run({ timeoutMs: PROCESS_DEADLINE, args: ['-e', DESCENDANT_PROBE, timed.pids, timed.started,
    timed.lateMarker, String(DESCENDANT_DELAY)] }, transportEnv, true);
  const timedPids = await observeProcessPair(timed, PROCESS_DEADLINE - 300);
  const pairObservedAfterMs = timedPids === null ? null : Math.round(performance.now() - deadlineStarted);
  const timeoutResult = await timeout;
  const timedTreeGone = await observeTermination(timed, timedPids);
  set('descendant-timeout', timeoutResult.code === 124 && !timeoutResult.timedOut && timedTreeGone ? 'PASS' : 'FAIL',
    { exit: timeoutResult.code, nativePairObserved: timedPids !== null, treeGone: timedTreeGone,
      hostWatchdogTimedOut: timeoutResult.timedOut, nativeRequestTimeoutMs: PROCESS_DEADLINE,
      hostWatchdogTimeoutMs: PROCESS_DEADLINE + 2_000, nativeWallMs: Math.round(timeoutResult.wallMs), pairObservedAfterMs,
      native: deadlineNativeNotes(timeoutResult), wfpReceipt: timeoutResult.deadlineWfp });

  const cancelled = fixturePaths(write, 'cancelled');
  const stop = writeRequest(privateRoot, { ...request, args: ['-e', DESCENDANT_PROBE, cancelled.pids, cancelled.started,
    cancelled.lateMarker, String(DESCENDANT_DELAY)] });
  assertSameSupervisor();
  const launcher = spawn(supervisor.command, [...supervisor.argsPrefix, stop.file], {
    cwd: stop.dir, env: transportEnv, stdio: 'ignore', windowsHide: true,
  });
  const launcherExit = new Promise((done) => {
    launcher.once('exit', () => done(true));
    launcher.once('error', () => done(false));
  });
  const cancelledPids = await observeProcessPair(cancelled, PROCESS_DEADLINE - 300);
  // Windows child.kill() terminates this process handle. Do not kill the descendant
  // from the probe or use taskkill /T here, since either would mask missing job cleanup.
  const stopped = launcher.exitCode === null && launcher.signalCode === null && launcher.kill();
  const exited = await Promise.race([launcherExit, delay(2_000, false, { ref: false })]);
  if (!exited) launcher.unref();
  const cancelledTreeGone = await observeTermination(cancelled, cancelledPids);
  set('launcher-cancellation', stopped && exited && cancelledTreeGone ? 'PASS' : 'FAIL',
    { directLauncherTermination: stopped, launcherExited: exited, nativePairObserved: cancelledPids !== null,
      treeGone: cancelledTreeGone });

  let missingPinRefused = false;
  let wrongPinRefused = false;
  try { resolveWindowsSupervisor({}); } catch { missingPinRefused = true; }
  const badPin = supervisor.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  try {
    resolveWindowsSupervisor({ CLU_WINDOWS_SUPERVISOR_PATH: supervisor.command, CLU_WINDOWS_SUPERVISOR_SHA256: badPin });
  } catch { wrongPinRefused = true; }
  const marker = join(write, 'forbidden-launch.txt');
  const args = ['-e', "require('node:fs').writeFileSync(process.argv[1], 'unexpected', {flag:'wx'});", marker];
  const refusals = [];
  for (const invalid of [
    { schemaVersion: 'clue-proof-exec/invalid' }, { denyNetwork: false },
    { writableRoots: [write, readonly] }, { cwd: outside },
  ]) {
    const refused = await run({ ...invalid, args });
    refusals.push(refused.code === 125 && !refused.timedOut && !existsSync(marker));
  }
  set('tamper-refused', missingPinRefused && wrongPinRefused && refusals.every(Boolean) ? 'PASS' : 'FAIL',
    { missingPinRefused, wrongPinRefused, malformedRequestsRefused: refusals.filter(Boolean).length, malformedRequestsTested: refusals.length });
}

async function qualify(wfpDiagnostic) {
  const report = {
    schemaVersion: 'clue-console-probe-native-supervisor/1', checkedAt: new Date().toISOString(),
    status: 'PENDING', canaryStatus: 'PENDING', blocker: null, supervisorSha256: null, supervisorPathSha256: null, host: null,
    cases: Object.fromEntries([...REQUIRED, 'measurement-parity'].map((id) => [id, 'NOT_EXECUTED'])),
    caseEvidence: {}, fixtureRemoved: null,
  };
  if (wfpDiagnostic) {
    report.wfpStatus = 'NOT_EXECUTED';
    report.wfp = null;
  }
  if (process.platform !== 'win32') {
    report.blocker = 'NATIVE_WINDOWS_REQUIRED';
    return report;
  }

  let root;
  try {
    let modules;
    try {
      modules = await Promise.all([
        import('../dist/src/benchmark/windowsExecutionSupervisor.js'), import('../dist/src/benchmark/containedProcess.js'),
        import('../dist/src/benchmark/windowsSupervisorQualification.js'),
      ]);
    } catch {
      report.blocker = 'BUILD_REQUIRED';
      return report;
    }
    const [{ resolveWindowsSupervisor }, { runBoundedProcess }, { captureWindowsQualificationHost, windowsSupervisorPathSha256 }] = modules;
    let supervisor;
    try { supervisor = resolveWindowsSupervisor(); }
    catch {
      report.blocker = 'SUPERVISOR_PIN_UNVERIFIED';
      return report;
    }
    report.supervisorSha256 = supervisor.sha256;
    report.supervisorPathSha256 = windowsSupervisorPathSha256(supervisor.command);
    report.host = captureWindowsQualificationHost();
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'clue-supervisor-qualify-')));
    await exercise({ report, root, supervisor, resolveWindowsSupervisor, runBoundedProcess, wfpDiagnostic });
  } catch {
    report.blocker = 'CANARY_RUNNER_ERROR';
  } finally {
    if (root !== undefined) {
      try {
        rmSync(root, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
        report.fixtureRemoved = !existsSync(root);
      } catch { report.fixtureRemoved = false; }
    }
  }
  if (wfpDiagnostic) {
    report.canaryStatus = 'NOT_EXECUTED';
    report.status = report.blocker === null && report.fixtureRemoved === true &&
      ['BIND_DENIAL_CONTRAST_OBSERVED', 'FILTER_DIFFERENTIAL_OBSERVED', 'FILTER_BOUND_ATTRIBUTION_UNPROVEN'].includes(report.wfpStatus)
      ? 'WFP_DIAGNOSTIC_COMPLETE' : 'WFP_DIAGNOSTIC_FAILED';
    if (report.status === 'WFP_DIAGNOSTIC_FAILED') report.blocker ??= 'WFP_PROBE_EVIDENCE_INCOMPLETE';
  } else if (report.blocker !== null || report.fixtureRemoved === false || REQUIRED.some((id) => report.cases[id] === 'FAIL')) {
    report.canaryStatus = 'FAIL';
    report.status = 'FAIL';
    report.blocker ??= 'REQUIRED_CANARY_FAILED';
  } else if (report.fixtureRemoved === true && REQUIRED.every((id) => report.cases[id] === 'PASS')) {
    report.canaryStatus = 'PASS';
    report.status = 'MEASUREMENT_PENDING';
  } else {
    report.blocker = 'REQUIRED_CANARIES_NOT_EXECUTED';
  }
  return report;
}

const args = process.argv.slice(2);
const wfpDiagnostic = args.at(-1) === '--wfp-diagnostic';
if (wfpDiagnostic) args.pop();
const usage = 'Usage: node tools/p2-windows-supervisor-qualify.mjs --output <external .json> [--wfp-diagnostic]';
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else if (args.length !== 2 || args[0] !== '--output' || !/\.json$/iu.test(args[1])) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    externalReportPath(ROOT, args[1]);
    const report = await qualify(wfpDiagnostic);
    writeExternalReport(ROOT, args[1], report);
    console.info('[CLU-E native qualification]', report.wfpStatus ?? report.canaryStatus, report.blocker ?? report.status);
    if (wfpDiagnostic ? report.status !== 'WFP_DIAGNOSTIC_COMPLETE' : report.canaryStatus !== 'PASS') process.exitCode = 1;
  } catch {
    console.error('[CLU-E native qualification] REPORT_OUTPUT_UNAVAILABLE');
    process.exitCode = 2;
  }
}
