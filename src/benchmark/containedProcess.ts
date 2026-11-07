import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const WINDOWS_CLEANUP_MS = 5_000;
const BUBBLEWRAP = '/usr/bin/bwrap';
const LINUX_RUNTIME_ROOTS = ['/usr', '/lib', '/lib64', '/bin'] as const;
const LINUX_RESERVED_ROOTS = ['/dev', '/etc', '/proc', '/root', '/run', '/sys'] as const;
const SANDBOX_HOME = '/tmp/clu-e-home';

interface BoundedProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface BoundedProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
  readonly timedOut: boolean;
}

function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // A failed spawn or a group that has already exited has nothing left to kill.
    child.kill('SIGKILL');
  }
}

async function killWindowsTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  if (!win32.isAbsolute(systemRoot)) {
    child.kill();
    return;
  }
  await new Promise<void>((done) => {
    const taskkill = spawn(win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      done();
    };
    const timer = setTimeout(() => {
      taskkill.kill();
      taskkill.unref();
      finish();
    }, WINDOWS_CLEANUP_MS);
    taskkill.once('error', finish);
    taskkill.once('close', finish);
  });
}

/**
 * Runs one child with a shared stdout/stderr budget and a wall-clock deadline.
 * POSIX gets a process group for ordinary descendant cleanup. Windows uses this
 * only for trusted supervisors that implement their own containment and cleanup.
 */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError('Process timeout must be positive and within the supported timer range.');
  }
  const start = performance.now();
  if (options.signal?.aborted === true) {
    return Promise.resolve({
      code: -1, stdout: '', stderr: 'Process execution was cancelled before launch.', wallMs: 0, timedOut: false,
    });
  }
  const windows = process.platform === 'win32';
  return new Promise<BoundedProcessResult>((resolveResult) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: !windows,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number, detail = '', timedOut = false) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const capturedError = Buffer.concat(stderr).toString('utf8');
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: capturedError === '' ? detail : detail === '' ? capturedError : `${capturedError}\n${detail}`,
        wallMs: performance.now() - start,
        timedOut,
      });
    };
    const stop = async (detail: string, timedOut = false) => {
      if (stopping || settled) return;
      stopping = true;
      if (windows) await killWindowsTree(child);
      else killProcessGroup(child);
      // Even an escaped descendant holding a pipe cannot prolong the deadline.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      settle(-1, detail, timedOut);
    };
    const onAbort = () => {
      void stop('Process execution was cancelled.');
    };
    const capture = (destination: Buffer[], chunk: Buffer) => {
      if (stopping || settled) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining > 0) destination.push(chunk.subarray(0, remaining));
      outputBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        void stop(`Process exceeded the combined output limit (${MAX_OUTPUT_BYTES} bytes).`);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('exit', () => {
      // Clean up background descendants even when the leader exits successfully.
      if (!windows && !stopping) killProcessGroup(child);
    });
    child.once('error', (error) => {
      if (!stopping) settle(-1, `Process launch failed: ${error.message}`);
    });
    child.once('close', (code, signal) => {
      if (!stopping) settle(code ?? -1, signal === null ? '' : `Process terminated by ${signal}.`);
    });
    timer = setTimeout(() => {
      void stop(`Process timed out after ${options.timeoutMs} ms.`, true);
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
  });
}

interface LinuxContainmentOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly readOnlyRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

interface ContainedInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

interface LinuxMount {
  readonly path: string;
  readonly directory: boolean;
}

function contains(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return childPath === '' || (childPath !== '..' && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath));
}

function physicalPath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Linux containment requires an absolute path: ${path}`);
  return realpathSync(path);
}

function mountRoot(path: string, writable: boolean): LinuxMount {
  const physical = physicalPath(path);
  if (resolve(path) !== physical) {
    throw new Error(`Linux containment requires a physical mount root: ${path}`);
  }
  const home = homedir();
  if (
    physical === '/' || physical === '/tmp' || physical === '/home' ||
    contains(physical, home) ||
    LINUX_RESERVED_ROOTS.some((reserved) => contains(reserved, physical) || contains(physical, reserved)) ||
    contains(SANDBOX_HOME, physical) || contains(physical, SANDBOX_HOME)
  ) {
    throw new Error(`Linux containment refused a reserved or broad mount root: ${physical}`);
  }
  const stats = statSync(physical);
  if (!stats.isDirectory() && (writable || !stats.isFile())) {
    throw new Error(`Linux containment needs an existing directory or a readonly regular file: ${physical}`);
  }
  return { path: physical, directory: stats.isDirectory() };
}

function uniqueMounts(roots: readonly string[], writable: boolean): readonly LinuxMount[] {
  return [...new Set(roots)].map((root) => mountRoot(root, writable));
}

function mountContains(mount: LinuxMount, path: string): boolean {
  return mount.directory ? contains(mount.path, path) : mount.path === path;
}

function privateLocation(value: string | undefined, fallback: string, writable: readonly LinuxMount[]): string {
  if (value === undefined) return fallback;
  if (!isAbsolute(value) || !writable.some((mount) => mountContains(mount, resolve(value)))) {
    throw new Error(`Linux containment requires a private mounted HOME/TEMP path: ${value}`);
  }
  return resolve(value);
}

/**
 * Builds a Linux invocation without a host-root mount or a network namespace escape.
 * All inputs and writable areas are explicit. Failure to launch bubblewrap never
 * falls back to uncontained execution.
 */
export function linuxContainmentInvocation(options: LinuxContainmentOptions): ContainedInvocation {
  if (process.platform !== 'linux' || !existsSync(BUBBLEWRAP)) {
    throw new Error('Linux containment requires /usr/bin/bwrap.');
  }
  const runtimeRoots = LINUX_RUNTIME_ROOTS.filter((root) => existsSync(root));
  const runtimePhysicalRoots = runtimeRoots.map((root) => ({ path: physicalPath(root), directory: true }));
  const readOnly = uniqueMounts(options.readOnlyRoots, false);
  const writable = uniqueMounts(options.writableRoots, true);
  const readable = [...runtimePhysicalRoots, ...readOnly];
  for (const write of writable) {
    const conflicting = readable.find((read) => mountContains(read, write.path) || contains(write.path, read.path));
    if (conflicting !== undefined) {
      throw new Error(`Linux containment writable root overlaps a readonly root: ${write.path} and ${conflicting.path}`);
    }
  }

  const command = physicalPath(options.command);
  const cwd = physicalPath(options.cwd);
  const mounted = [...readable, ...writable];
  if (!mounted.some((mount) => mountContains(mount, command)) || !statSync(command).isFile()) {
    throw new Error(`Linux containment executable is outside mounted roots or is not a regular file: ${command}`);
  }
  if (!mounted.some((mount) => mount.directory && mountContains(mount, cwd)) || !statSync(cwd).isDirectory()) {
    throw new Error(`Linux containment working directory is outside mounted roots or is not a directory: ${cwd}`);
  }

  const env = {
    ...options.env,
    HOME: privateLocation(options.env['HOME'], SANDBOX_HOME, writable),
    TMPDIR: privateLocation(options.env['TMPDIR'], '/tmp', writable),
    TEMP: privateLocation(options.env['TEMP'], '/tmp', writable),
    TMP: privateLocation(options.env['TMP'], '/tmp', writable),
  };
  const bwrapArgs = [
    '--unshare-all',
    '--unshare-user',
    '--disable-userns',
    '--assert-userns-disabled',
    '--die-with-parent',
    '--cap-drop', 'ALL',
    '--proc', '/proc',
    '--dev', '/dev',
    '--size', String(128 * 1024 * 1024), '--tmpfs', '/tmp',
    '--dir', SANDBOX_HOME,
    '--clearenv',
  ];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || /^(?:LD_|DYLD_|GCONV_PATH$|GLIBC_TUNABLES$|BASH_ENV$|NODE_OPTIONS$)/u.test(name)) {
      throw new Error(`Linux containment refused an unsafe environment variable name: ${name}`);
    }
    bwrapArgs.push('--setenv', name, value);
  }
  for (const root of runtimeRoots) bwrapArgs.push('--ro-bind', root, root);
  for (const mount of readOnly) {
    if (!runtimePhysicalRoots.some((runtime) => mountContains(runtime, mount.path))) {
      bwrapArgs.push('--ro-bind', mount.path, mount.path);
    }
  }
  for (const mount of writable) bwrapArgs.push('--bind', mount.path, mount.path);
  bwrapArgs.push('--chdir', cwd, '--', command, ...options.args);
  return Object.freeze({ command: BUBBLEWRAP, args: Object.freeze(bwrapArgs) });
}
