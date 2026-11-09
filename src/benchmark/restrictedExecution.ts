/** The proof command broker. Production execution always goes through an OS boundary. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { ExecFn } from './benchmarkRunner.js';
import { linuxContainmentInvocation, runBoundedProcess } from './containedProcess.js';
import { describeWindowsSupervisorRefusal, resolveWindowsSupervisor, type WindowsExecutionSupervisorRequest } from './windowsExecutionSupervisor.js';
import { requireWindowsSupervisorQualification } from './windowsSupervisorQualification.js';
import { windowsNodeEntryArgs } from './windowsNodeEntry.js';
import { hashBytes, type Sha256 } from '../shared/ids.js';

export type ExecutionBoundary =
  | { readonly kind: 'linux-bwrap'; readonly sha256: Sha256 }
  | { readonly kind: 'windows-supervisor'; readonly sha256: Sha256; readonly qualificationSha256: Sha256 };

export function requireProofExecutionBoundary(): ExecutionBoundary {
  if (process.platform === 'win32') {
    const supervisor = resolveWindowsSupervisor();
    const qualificationSha256 = requireWindowsSupervisorQualification(supervisor);
    return { kind: 'windows-supervisor', sha256: supervisor.sha256, qualificationSha256 };
  }
  if (process.platform !== 'linux' || !existsSync('/usr/bin/bwrap')) {
    throw new Error('Proof execution requires /usr/bin/bwrap on Linux or an operator-qualified Windows supervisor.');
  }
  return { kind: 'linux-bwrap', sha256: hashBytes(readFileSync('/usr/bin/bwrap')) };
}

function inside(root: string, path: string): boolean {
  const delta = relative(root, path);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

function directory(path: string): string {
  const physical = realpathSync.native(path);
  if (!lstatSync(physical).isDirectory()) throw new Error(`Isolation root must be a directory: ${path}.`);
  return physical;
}

function npmCli(nodePath: string): string {
  const configured = process.env['npm_execpath'];
  const possible = [
    configured,
    join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(nodePath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.platform === 'linux' ? ['/usr/bin/npm'] : []),
  ];
  for (const candidate of possible) {
    if (candidate === undefined || !isAbsolute(candidate) || !existsSync(candidate)) continue;
    const physical = realpathSync.native(candidate);
    if (basename(physical).toLowerCase() === 'npm-cli.js' && lstatSync(physical).isFile()) return physical;
  }
  throw new Error('Proof execution requires an installed npm CLI. Launch CLU-E using npm or install npm beside Node.');
}

function writeProofProgress(message: string): void {
  // Keep observation out of the proof pipe and drop updates if the console is backlogged.
  if (!process.stderr.writable || process.stderr.writableNeedDrain) return;
  console.error(message);
}

interface Scope {
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly mode: 'baseline' | 'candidate';
}

/** Returns a per-run broker and its private writable temporary state. */
export function createRestrictedExecution(scope: Scope): { exec: ExecFn; dispose: () => void; boundary: ExecutionBoundary } {
  const boundary = requireProofExecutionBoundary();
  const repoRoot = directory(scope.repoRoot);
  const cwd = directory(scope.projectRoot);
  const workspaceRoot = directory(scope.workspaceRoot);
  const node = realpathSync.native(process.execPath);
  const nodeBin = dirname(node);
  const nodeRoot = process.platform === 'linux' && basename(nodeBin) === 'bin' && !['/usr/bin', '/bin'].includes(nodeBin)
    ? dirname(nodeBin)
    : nodeBin;
  const readOnly = new Set([nodeRoot]);
  if (scope.mode === 'baseline' || repoRoot !== cwd) readOnly.add(repoRoot);
  if (scope.mode === 'baseline') readOnly.add(cwd);
  const writable = [workspaceRoot, ...(scope.mode === 'candidate' ? [cwd] : [])];
  const windows = process.platform === 'win32';
  const showProgress = windows && process.env['CLU_PROOF_VISIBLE'] === '1' && process.stderr.isTTY;
  let visibleCommandCount = 0;
  const systemRoot = windows ? directory(process.env['SystemRoot'] ?? 'C:\\Windows') : null;
  const toolDirs = [nodeBin];
  if (systemRoot !== null) {
    readOnly.add(systemRoot);
    toolDirs.push(join(systemRoot, 'System32'));
    const programs = process.env['ProgramFiles'];
    if (programs && isAbsolute(programs)) {
      const git = join(programs, 'Git');
      const powershell = join(programs, 'PowerShell', '7');
      if (existsSync(join(git, 'cmd', 'git.exe'))) {
        const physical = directory(git);
        readOnly.add(physical);
        toolDirs.push(join(physical, 'cmd'));
      }
      if (existsSync(join(powershell, 'pwsh.exe'))) {
        const physical = directory(powershell);
        readOnly.add(physical);
        toolDirs.push(physical);
      }
    }
  } else {
    toolDirs.push('/usr/bin', '/bin');
  }

  const scratch = mkdtempSync(join(tmpdir(), 'clue-exec-'));
  const privateRoot = directory(scratch);
  const childTemp = join(privateRoot, 'temp');
  const childHome = join(privateRoot, 'home');
  const requestRoot = join(privateRoot, 'requests');
  const cache = join(childHome, 'npm-cache');
  const childUserConfig = join(childHome, 'user.npmrc');
  const childGlobalConfig = join(childHome, 'global.npmrc');
  const dispose = () => rmSync(privateRoot, { recursive: true, force: true });
  try {
    for (const root of [childTemp, childHome, requestRoot]) mkdirSync(root);
    for (const path of [childUserConfig, childGlobalConfig]) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    const offlineCache = process.env['CLU_OFFLINE_NPM_CACHE'];
    if (scope.mode === 'candidate' && offlineCache) {
      if (!isAbsolute(offlineCache)) throw new Error('CLU_OFFLINE_NPM_CACHE must be an absolute directory path.');
      const seed = directory(offlineCache);
      if (inside(seed, privateRoot)) throw new Error('The offline npm cache overlaps the execution scratch directory.');
      cpSync(seed, cache, { recursive: true, dereference: false });
    }
    writable.push(childTemp, childHome);
    for (const allowed of readOnly) {
      if (writable.some((path) => inside(allowed, path) || inside(path, allowed))) {
        throw new Error('Writable proof roots must be disjoint from read-only inputs and toolchains.');
      }
    }
    for (const [index, left] of writable.entries()) {
      if (writable.slice(index + 1).some((right) => inside(left, right) || inside(right, left))) {
        throw new Error('Writable proof roots must be disjoint from each other.');
      }
    }
  } catch (error) {
    dispose();
    throw error;
  }

  const env: Record<string, string> = {
    PATH: toolDirs.join(delimiter),
    HOME: childHome,
    TEMP: childTemp,
    TMP: childTemp,
    TMPDIR: childTemp,
    CI: '1',
    NO_COLOR: '1',
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_USERCONFIG: childUserConfig,
    NPM_CONFIG_GLOBALCONFIG: childGlobalConfig,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  if (systemRoot !== null) {
    env['SystemRoot'] = systemRoot;
    env['WINDIR'] = systemRoot;
    env['ComSpec'] = join(systemRoot, 'System32', 'cmd.exe');
    env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';
    env['USERPROFILE'] = childHome;
    env['APPDATA'] = childHome;
    env['LOCALAPPDATA'] = childHome;
  }

  const exec: ExecFn = async (argv, opts) => {
    const [program, ...requested] = argv;
    if (program === undefined || requested.some((arg) => arg.includes('\0'))) {
      throw new Error('The proof command broker received invalid argv.');
    }
    const timeoutSeconds = opts?.timeoutSeconds ?? 900;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 5400) {
      throw new Error('The proof command timeout is outside the supported range.');
    }

    let args: readonly string[];
    let operation = 'Node workload';
    if (program === 'node' || program === process.execPath || program === node) {
      args = requested;
    } else if (program === 'npm') {
      const command = requested.join(' ');
      if (requested.length === 2 && requested[0] === 'run' && requested[1] === 'selftest') {
        // Static preparation already produced the pinned build. Run the same serial test
        // selection on both sides without granting a benchmark write access to source.
        if (!existsSync(join(cwd, 'dist', 'selftest'))) throw new Error('Build CLU-E before benchmarking.');
        args = ['--test', '--test-reporter=tap', '--test-concurrency=1', 'dist/selftest/**/*.test.js'];
        operation = 'npm run selftest';
      } else {
        if (scope.mode !== 'candidate' || !['ci', 'run typecheck', 'run build'].includes(command) ||
            requested.some((argument) => /\s/u.test(argument))) {
          throw new Error('The proof command broker refused an unapproved npm invocation.');
        }
        const cli = npmCli(node);
        const npmRoot = dirname(dirname(cli));
        if (writable.some((path) => inside(path, npmRoot) || inside(npmRoot, path))) {
          throw new Error('npm CLI must be installed outside writable proof roots.');
        }
        readOnly.add(npmRoot);
        args = [cli, ...requested];
        operation = `npm ${command}`;
      }
    } else {
      throw new Error('The proof command broker accepts only Node and approved npm invocations.');
    }

    const timeoutMs = Math.ceil(timeoutSeconds * 1000);
    const options = { cwd, env, timeoutMs, ...(opts?.signal === undefined ? {} : { signal: opts.signal }) };
    if (boundary.kind === 'linux-bwrap') {
      if (requireProofExecutionBoundary().sha256 !== boundary.sha256) throw new Error('Bubblewrap changed after proof setup.');
      const invocation = linuxContainmentInvocation({
        command: node, args, cwd, readOnlyRoots: [...readOnly], writableRoots: writable, env,
      });
      const result = await runBoundedProcess(invocation.command, invocation.args, options);
      if (/^bwrap:/mu.test(result.stderr)) throw new Error(`Linux proof isolation refused execution: ${result.stderr.trim().slice(0, 320)}`);
      if (result.timedOut) throw new Error('The isolated proof command exceeded its deadline.');
      if (result.code < 0) throw new Error('The isolated proof command could not complete within its process and output limits.');
      return result;
    }

    const supervisor = resolveWindowsSupervisor();
    const qualificationSha256 = requireWindowsSupervisorQualification(supervisor, process.env, [...readOnly, ...writable]);
    if (supervisor.sha256 !== boundary.sha256 || qualificationSha256 !== boundary.qualificationSha256 ||
        writable.some((path) => inside(path, supervisor.command))) {
      throw new Error('The Windows supervisor or qualification changed, or the supervisor is inside a writable proof root.');
    }
    const request: WindowsExecutionSupervisorRequest = {
      schemaVersion: 'clue-proof-exec/1',
      command: node,
      args: operation === 'Node workload' ? windowsNodeEntryArgs(args, cwd, [cwd, repoRoot, workspaceRoot]) : args,
      cwd, readOnlyRoots: [...readOnly], writableRoots: writable,
      env, timeoutMs, denyNetwork: true,
    };
    const requestDir = mkdtempSync(join(requestRoot, 'request-'));
    const requestFile = join(requestDir, 'request.json');
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const label = showProgress ? `[CLU-E proof ${scope.mode} #${++visibleCommandCount}] ${operation}` : null;
    try {
      writeFileSync(requestFile, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
      if (label !== null) {
        const started = performance.now();
        writeProofProgress(`${label} — starting isolated execution`);
        heartbeat = setInterval(() => {
          writeProofProgress(`${label} — running (${Math.floor((performance.now() - started) / 1000)}s)`);
        }, 10_000);
        heartbeat.unref();
      }
      const result = await runBoundedProcess(supervisor.command, [...supervisor.argsPrefix, requestFile], {
        ...options, cwd: requestDir, timeoutMs: timeoutMs + 2000,
      });
      if (label !== null) {
        const timedOut = result.timedOut || result.code === 124;
        writeProofProgress(
          `${label} — exit ${result.code} in ${Math.round(result.wallMs)}ms, timeout ${timedOut}, ` +
          `captured ${result.stdout.length} stdout / ${result.stderr.length} stderr characters`,
        );
      }
      if (result.code === 125) throw new Error(describeWindowsSupervisorRefusal(result.stderr));
      if (result.timedOut || result.code === 124) throw new Error('The isolated proof command exceeded its deadline.');
      if (result.code < 0) throw new Error('The isolated proof command could not complete within its process and output limits.');
      return result;
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      rmSync(requestDir, { recursive: true, force: true });
    }
  };
  return { exec, dispose, boundary };
}
