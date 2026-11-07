/** Native canaries for the separately installed Windows proof supervisor. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const matches = [...run.stderr.matchAll(/^\[CLU-E supervisor\] (MXC_IMAGE_PIN_MISMATCH|MXC_EXECUTION_REFUSED|WIN32_ERROR_\d{1,10}|REFUSED \([A-Za-z]{1,64}\)\.)\r?$/gmu)];
  return matches.length === 1 ? matches[0][1] : null;
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

async function exercise({ report, root, supervisor, resolveWindowsSupervisor, runBoundedProcess }) {
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
  async function run(overrides, outerEnv = transportEnv) {
    assertSameSupervisor();
    const staged = writeRequest(privateRoot, { ...request, ...overrides });
    return await runBoundedProcess(supervisor.command, [...supervisor.argsPrefix, staged.file], {
      cwd: staged.dir, env: outerEnv, timeoutMs: (overrides.timeoutMs ?? NORMAL_TIMEOUT) + 2_000,
    });
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
  const timeout = run({ timeoutMs: PROCESS_DEADLINE, args: ['-e', DESCENDANT_PROBE, timed.pids, timed.started,
    timed.lateMarker, String(DESCENDANT_DELAY)] });
  const timedPids = await observeProcessPair(timed, PROCESS_DEADLINE - 300);
  const timeoutResult = await timeout;
  const timedTreeGone = await observeTermination(timed, timedPids);
  set('descendant-timeout', timeoutResult.code === 124 && !timeoutResult.timedOut && timedTreeGone ? 'PASS' : 'FAIL',
    { exit: timeoutResult.code, nativePairObserved: timedPids !== null, treeGone: timedTreeGone });

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

async function qualify() {
  const report = {
    schemaVersion: 'clue-console-probe-native-supervisor/1', checkedAt: new Date().toISOString(),
    status: 'PENDING', canaryStatus: 'PENDING', blocker: null, supervisorSha256: null, supervisorPathSha256: null, host: null,
    cases: Object.fromEntries([...REQUIRED, 'measurement-parity'].map((id) => [id, 'NOT_EXECUTED'])),
    caseEvidence: {}, fixtureRemoved: null,
  };
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
    await exercise({ report, root, supervisor, resolveWindowsSupervisor, runBoundedProcess });
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
  if (report.blocker !== null || report.fixtureRemoved === false || REQUIRED.some((id) => report.cases[id] === 'FAIL')) {
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
const usage = 'Usage: node tools/p2-windows-supervisor-qualify.mjs --output <external .json>';
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else if (args.length !== 2 || args[0] !== '--output' || !/\.json$/iu.test(args[1])) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    externalReportPath(ROOT, args[1]);
    const report = await qualify();
    writeExternalReport(ROOT, args[1], report);
    console.info('[CLU-E native qualification]', report.canaryStatus, report.blocker ?? report.status);
    if (report.canaryStatus !== 'PASS') process.exitCode = 1;
  } catch {
    console.error('[CLU-E native qualification] REPORT_OUTPUT_UNAVAILABLE');
    process.exitCode = 2;
  }
}
