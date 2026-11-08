#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalReportPath, writeExternalReport } from './verification-support.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = /^[a-f0-9]{64}$/u;
const timeoutMs = 30_000;
const expectedMarker = 'clue-production-admission\n';
const npmErrorCodes = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ENOSPC', 'EEXIST', 'EINVAL', 'EIO', 'ENAMETOOLONG',
  'EBUSY', 'ELOOP', 'ENOBUFS', 'ENOTCACHED', 'EINTEGRITY', 'ELIFECYCLE', 'EUSAGE', 'ETIMEDOUT',
  'ENOEXEC', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_ACCESS_DENIED', 'ERR_DLOPEN_FAILED',
]);
const childScript = [
  "const fs = require('node:fs'); const path = require('node:path');",
  "const [role, workspace] = process.argv.slice(1);",
  "const marker = 'clue-production-admission\\n';",
  "if (fs.readFileSync('input.txt', 'utf8') !== marker) process.exit(2);",
  "if (process.env.OPENAI_API_KEY !== undefined || process.env.CLU_WINDOWS_SUPERVISOR_PATH !== undefined) process.exit(3);",
  "const destination = path.join(process.cwd(), 'candidate-write.txt');",
  "let wrote = false; try { fs.writeFileSync(destination, marker, { flag: 'wx' }); wrote = true; } catch {}",
  "if (wrote !== (role === 'candidate')) process.exit(4);",
  "fs.writeFileSync(path.join(workspace, 'observed.txt'), marker, { flag: 'wx' });",
  "process.stdout.write('CLU_E_PRODUCTION_ADMISSION_' + role.toUpperCase() + '\\n');",
].join('\n');

function exact(path, directory) {
  const entry = lstatSync(path);
  if (relative(path, realpathSync.native(path)) !== '' ||
      (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) throw new Error('PATH_UNVERIFIED');
  return path;
}

function hashImage(path, expected) {
  exact(path, false);
  const before = lstatSync(path);
  if (before.size < 1 || before.size > 128 * 1024 * 1024) throw new Error('IMAGE_SIZE_UNVERIFIED');
  const content = readFileSync(path);
  const after = lstatSync(path);
  if (content.length !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs || createHash('sha256').update(content).digest('hex') !== expected) {
    throw new Error('IMAGE_PIN_UNVERIFIED');
  }
}

function readSmall(path) {
  exact(path, false);
  if (lstatSync(path).size > 4096) throw new Error('RECEIPT_SIZE_UNVERIFIED');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function observed(path) {
  try { return readFileSync(exact(path, false), 'utf8') === expectedMarker; }
  catch { return false; }
}

function lifecycle(requestDir) {
  try {
    const wfp = readSmall(join(requestDir, 'wfp-integration-result.json'));
    const fields = ['identityVerified', 'leaseVerified', 'jobEmpty', 'removalVerified', 'productionBackupVerified'];
    if (wfp?.schemaVersion !== 'clue-windows-production-wfp/1' || wfp.proofAuthorization !== false ||
        !fields.every((key) => typeof wfp[key] === 'boolean')) return null;
    const lanes = (values) => Array.isArray(values) && values.length === 4 && values.every((value) => [0, 10013].includes(value));
    if ((wfp.control !== null && !lanes(wfp.control)) || (wfp.armed !== null && !lanes(wfp.armed))) return null;
    const verified = wfp.state === 'PRODUCTION_WFP_LIFECYCLE_VERIFIED' && fields.every((key) => wfp[key] === true) &&
      wfp.control?.every((value) => value === 0) === true && wfp.armed?.every((value) => value === 10013) === true;
    return { verified, ...Object.fromEntries(fields.map((key) => [key, wfp[key]])), control: wfp.control, armed: wfp.armed };
  } catch {
    return null;
  }
}

function nativeDiagnostics(stderr) {
  const wfp = /^\[CLU-E governed WFP\] ([A-Za-z]{1,24}) ([A-Z0-9_]{1,90})$/mu.exec(stderr);
  const supervisor = /^\[CLU-E supervisor\] (?:REFUSED \(([A-Za-z][A-Za-z0-9]{0,63})\)\. ([A-Z_]{1,40})(?: ([A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63})?))?|(WIN32_ERROR_(-?[0-9]{1,10})) ([A-Z_]{1,40}))$/mu.exec(stderr);
  const production = /^\[CLU-E production proof\] (PRODUCTION_PROOF_[A-Z0-9_]{1,74})$/mu.exec(stderr);
  const workloadExits = [...stderr.matchAll(/^\[CLU-E supervisor\] WORKLOAD_EXIT_0x([0-9A-F]{8})$/gmu)];
  const wfpFirst = wfp !== null && (supervisor === null || wfp.index < supervisor.index);
  return {
    nativePhase: wfpFirst ? wfp[1] : supervisor?.[2] ?? supervisor?.[6] ?? null,
    nativeCode: wfpFirst ? wfp[2] : production?.[1] ?? supervisor?.[4] ?? null,
    productionSessionCode: production?.[1] ?? null,
    nativeException: supervisor?.[1] ?? null,
    nativeSite: supervisor?.[3] ?? null,
    nativeWin32Error: supervisor?.[5] === undefined ? null : Number(supervisor[5]),
    backendWorkloadExitCode: workloadExits.length === 1 ? Number.parseInt(workloadExits[0][1], 16) : null,
  };
}

function npmDiagnostics(stdout, stderr) {
  const trace = /^\[CLU-E production npm\] (PATH_WALK_COMPATIBILITY|PREFLIGHT_[A-Z0-9_]{1,48})$/mu.exec(stderr);
  const nodeError = /^Error(?:: ([A-Z][A-Z0-9_]{1,31}):| \[([A-Z][A-Z0-9_]{1,31})\]:)/mu.exec(stderr);
  const nodeCode = /^ {1,8}code: '([A-Z][A-Z0-9_]{1,31})',?$/mu.exec(stderr);
  const npmCode = /^npm (?:error|ERR!) code ([A-Z0-9_]{1,32})$/mu.exec(stderr);
  const code = nodeError?.[1] ?? nodeError?.[2] ?? nodeCode?.[1] ?? npmCode?.[1] ?? null;
  const syscall = /^(?:npm (?:error|ERR!) syscall (open|lstat|stat|realpath|mkdir|spawn|uv_cwd)| {1,8}syscall: '(open|lstat|stat|realpath|mkdir|spawn|uv_cwd)',?)$/mu.exec(stderr);
  let errorCategory = null;
  if (/^'node' is not recognized as an internal or external command,/mu.test(stderr)) {
    errorCategory = 'COMMAND_NOT_FOUND';
  } else if (code !== null) {
    errorCategory = npmErrorCodes.has(code) ? code : /^[0-9]{1,10}$/u.test(code) ? 'CHILD_EXIT' : 'OTHER';
  }
  return {
    trace: trace?.[1] ?? null,
    errorCategory,
    syscall: syscall?.[1] ?? syscall?.[2] ?? null,
    lifecycleHeaderSeen: /^> clue-production-admission@1\.0\.0 typecheck$/mu.test(stdout),
    commandHeaderSeen: /^> node typecheck\.cjs$/mu.test(stdout),
  };
}

function requestEnvironment(home, temp, systemRoot, path) {
  return {
    PATH: path, HOME: home, TEMP: temp, TMP: temp, TMPDIR: temp, CI: '1', NO_COLOR: '1',
    NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_CACHE: join(home, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
    NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
  };
}

function run(stage, supervisor, wrapperSha256, engineSha256, report) {
  const installed = dirname(supervisor);
  const systemRoot = exact(realpathSync.native(process.env.SystemRoot ?? 'C:\\Windows'), true);
  const programFiles = exact(realpathSync.native(process.env.ProgramFiles), true);
  const runRoot = join(programFiles, '.clue-proof-production-' + basename(dirname(stage)).slice('.setup-'.length));
  if (relative(join(runRoot, wrapperSha256, 'CLU-E-Windows-Supervisor.exe'), supervisor) !== '') {
    throw new Error('PROTECTED_IMAGE_SCOPE_UNVERIFIED');
  }
  const ready = readSmall(join(runRoot, 'ready.json'));
  if (ready?.schemaVersion !== 'clue-proof-production-installed-image/1' ||
      ready.wrapperSha256 !== wrapperSha256 || ready.engineSha256 !== engineSha256) throw new Error('PRODUCTION_MODE_UNVERIFIED');
  const verify = () => {
    hashImage(supervisor, wrapperSha256);
    hashImage(join(installed, 'wxc-exec.exe'), engineSha256);
  };
  verify();
  report.installedImage = { wrapperSha256, engineSha256, verifiedBefore: true, verifiedAfter: false };
  const node = exact(realpathSync.native(process.execPath), false);
  const nodeRoot = dirname(node);
  const npmRoot = exact(join(nodeRoot, 'node_modules', 'npm'), true);
  const npm = exact(join(npmRoot, 'bin', 'npm-cli.js'), false);
  const system32 = exact(join(systemRoot, 'System32'), true);
  const fixture = join(stage, 'production-fixture');
  mkdirSync(fixture);
  const tools = [nodeRoot, systemRoot];
  const search = [nodeRoot, system32];
  for (const [path, relativeBin, executable] of [
    [join(programFiles, 'Git'), 'cmd', 'git.exe'],
    [join(programFiles, 'PowerShell', '7'), '', 'pwsh.exe'],
  ]) {
    if (existsSync(join(path, relativeBin, executable))) {
      tools.push(exact(realpathSync.native(path), true));
      search.push(join(tools[tools.length - 1], relativeBin));
    }
  }
  const scratch = mkdtempSync(join(exact(realpathSync.native(tmpdir()), true), 'clue-exec-'));
  const temp = join(scratch, 'temp');
  const home = join(scratch, 'home');
  const requests = join(scratch, 'requests');
  for (const path of [temp, home, requests]) mkdirSync(path);
  mkdirSync(join(home, 'npm-cache'));
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(home, name), '', { flag: 'wx' });
  const env = requestEnvironment(home, temp, systemRoot, search.join(';'));
  const baseline = join(fixture, 'baseline');
  const candidate = join(fixture, 'candidate');
  const baselineWorkspace = join(fixture, 'baseline-workspace');
  const candidateWorkspace = join(fixture, 'candidate-workspace');
  for (const path of [baseline, candidate, baselineWorkspace, candidateWorkspace]) mkdirSync(path);
  for (const path of [baseline, candidate]) writeFileSync(join(path, 'input.txt'), expectedMarker, { flag: 'wx' });
  writeFileSync(join(candidate, 'package.json'), JSON.stringify({ name: 'clue-production-admission', version: '1.0.0',
    scripts: { typecheck: 'node typecheck.cjs' } }), { flag: 'wx' });
  writeFileSync(join(candidate, 'typecheck.cjs'), "require('node:fs').writeFileSync('npm-observed.txt', 'clue-production-admission\\n', {flag:'wx'});",
    { flag: 'wx' });
  const request = (role) => ({
    schemaVersion: 'clue-proof-exec/1', command: node,
    args: ['-e', childScript, role, role === 'baseline' ? baselineWorkspace : candidateWorkspace],
    cwd: role === 'baseline' ? baseline : candidate, readOnlyRoots: [...tools, baseline],
    writableRoots: role === 'baseline' ? [baselineWorkspace, temp, home] : [candidateWorkspace, candidate, temp, home],
    env, timeoutMs, denyNetwork: true,
  });
  function send(value, inspectNpm = false) {
    const dir = mkdtempSync(join(requests, 'request-'));
    const file = join(dir, 'request.json');
    const bytes = JSON.stringify(value);
    writeFileSync(file, bytes, { flag: 'wx' });
    const result = spawnSync(supervisor, ['--request-file', file], {
      cwd: dir, windowsHide: true, encoding: 'utf8', timeout: timeoutMs + 25_000, maxBuffer: 128 * 1024,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: system32 },
    });
    const wfp = lifecycle(dir);
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return {
      exitCode: result.status, failure: result.error?.code ?? null,
      ...nativeDiagnostics(stderr),
      ...(inspectNpm ? { npm: npmDiagnostics(stdout, stderr) } : {}),
      unchanged: readFileSync(file, 'utf8') === bytes, wfp, stdout,
    };
  }
  try {
    let passed = true;
    for (const [name, input] of [
      ['networkOptOut', { ...request('baseline'), denyNetwork: false }],
      ['unexpectedEnvironment', { ...request('baseline'), env: { ...env, NODE_OPTIONS: '--trace-warnings' } }],
      ['rootOverlap', { ...request('baseline'), writableRoots: [baseline, baselineWorkspace, temp, home] }],
    ]) {
      const { stdout, ...evidence } = send(input);
      const refused = evidence.exitCode === 125 && evidence.nativePhase === 'REQUEST_READ' &&
        evidence.failure === null && evidence.unchanged && evidence.wfp === null &&
        !stdout.includes('CLU_E_PRODUCTION_ADMISSION_') && !existsSync(join(baselineWorkspace, 'observed.txt'));
      report.refusals[name] = { ...evidence, passed: refused };
      passed = refused && passed;
    }
    if (!passed) return;
    for (const role of ['baseline', 'candidate', 'npmTypecheck']) {
      const input = role === 'npmTypecheck'
        ? { ...request('candidate'), args: [npm, 'run', 'typecheck'], readOnlyRoots: [...tools, baseline, npmRoot] }
        : request(role);
      const { stdout, ...evidence } = send(input, role === 'npmTypecheck');
      const marker = role === 'npmTypecheck'
        ? observed(join(candidate, 'npm-observed.txt'))
        : stdout.includes('CLU_E_PRODUCTION_ADMISSION_' + role.toUpperCase()) &&
          observed(join(role === 'baseline' ? baselineWorkspace : candidateWorkspace, 'observed.txt'));
      const scopesVerified = observed(join(baseline, 'input.txt')) && observed(join(candidate, 'input.txt')) &&
        !existsSync(join(baseline, 'candidate-write.txt')) && (role === 'baseline' || observed(join(candidate, 'candidate-write.txt')));
      const ok = evidence.exitCode === 0 && evidence.failure === null && evidence.unchanged &&
        evidence.wfp?.verified === true && marker && scopesVerified;
      report.cases[role] = { ...evidence, marker, scopesVerified, passed: ok };
      if (!ok) return;
    }
    rmSync(scratch, { recursive: true, force: true });
    report.scratchRetained = false;
    report.stageCleanupSafe = true;
    report.state = 'PRODUCTION_ADMISSION_OBSERVED';
  } finally {
    verify();
    report.installedImage.verifiedAfter = true;
  }
}

const args = process.argv.slice(2);
const report = { schemaVersion: 'clue-windows-production-admission/1', state: 'PRODUCTION_ADMISSION_UNVERIFIED',
  proofAuthorization: false, stageCleanupSafe: false, scratchRetained: true, cases: {}, refusals: {}, installedImage: null };
try {
  if (process.platform !== 'win32' || args.length !== 8 || args[0] !== '--stage' || args[2] !== '--supervisor' ||
      args[4] !== '--output' || !digest.test(args[6]) || !digest.test(args[7])) throw new Error('ARGUMENTS_UNVERIFIED');
  const stage = exact(args[1], true);
  const outer = dirname(stage);
  if (basename(stage) !== 'admission' || !/^\.setup-[a-f0-9]{32}$/u.test(basename(outer)) ||
      relative(join(outer, 'admission-result.json'), args[5]) !== '') throw new Error('STAGE_SCOPE_UNVERIFIED');
  const output = externalReportPath(root, args[5]);
  try {
    run(stage, exact(args[3], false), args[6], args[7], report);
  } catch (error) {
    report.state = 'PRODUCTION_ADMISSION_UNVERIFIED';
    report.stageCleanupSafe = false;
    report.error = /^[A-Z0-9_]{1,80}$/u.test(error?.message ?? '') ? error.message : error?.code ?? 'RUN_FAILED';
  }
  writeExternalReport(root, output, report);
  console.log(`Windows production admission ${report.state}`);
  if (report.state !== 'PRODUCTION_ADMISSION_OBSERVED') process.exitCode = 1;
} catch {
  console.error('Windows production admission could not produce a staged report.');
  process.exitCode = 2;
}
