import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { linuxContainmentInvocation, runBoundedProcess } from '../src/benchmark/containedProcess.js';

const linuxWithoutBubblewrap = process.platform !== 'linux' || !existsSync('/usr/bin/bwrap');

test('bounded process uses the explicit environment and stops at a shared output limit', async () => {
  const options = { cwd: process.cwd(), env: { CLUE_PROCESS_TEST: 'fixture' }, timeoutMs: 5_000 };
  const ordinary = await runBoundedProcess(
    process.execPath, ['-e', 'process.stdout.write(process.env.CLUE_PROCESS_TEST)'], options,
  );
  assert.equal(ordinary.code, 0);
  assert.equal(ordinary.stdout, 'fixture');

  const excessive = await runBoundedProcess(process.execPath, [
    '-e', 'process.stdout.write("a".repeat(3 * 1024 * 1024)); process.stderr.write("b".repeat(3 * 1024 * 1024));',
  ], options);
  assert.equal(excessive.code, -1);
  assert.equal(excessive.timedOut, false);
  assert.match(excessive.stderr, /combined output limit/u);
  assert.ok(Buffer.byteLength(excessive.stdout + excessive.stderr) < 4 * 1024 * 1024 + 150);
});

test('bounded process reports cancellation before spawning', async () => {
  const cancelled = await runBoundedProcess(process.execPath, ['-e', 'process.exit(42)'], {
    cwd: process.cwd(), env: {}, timeoutMs: 1_000, signal: AbortSignal.abort(),
  });
  assert.equal(cancelled.code, -1);
  assert.equal(cancelled.timedOut, false);
  assert.match(cancelled.stderr, /cancelled before launch/u);
});

test('POSIX timeout kills a grandchild that would otherwise keep running', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'clue-process-group-'));
  const marker = join(root, 'grandchild-survived');
  try {
    const grandchild = 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "escaped"), 600)';
    const leader = 'require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], {stdio:"inherit"}); process.stdout.write("started"); setInterval(() => {}, 1000)';
    const result = await runBoundedProcess(process.execPath, ['-e', leader, grandchild, marker], {
      cwd: root, env: {}, timeoutMs: 300,
    });
    assert.equal(result.stdout, 'started');
    assert.equal(result.timedOut, true);
    await delay(700);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux mounts only explicit inputs and rejects readonly/writable overlap', { skip: linuxWithoutBubblewrap }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clue-bwrap-args-')));
  try {
    const readonlyRoot = join(root, 'readonly');
    const writableRoot = join(root, 'writable');
    const nested = join(readonlyRoot, 'nested');
    const hidden = join(root, 'not-mounted');
    for (const path of [nested, writableRoot, hidden]) mkdirSync(path, { recursive: true });
    const command = realpathSync(process.execPath);
    const options = {
      command, args: ['--version'], cwd: writableRoot,
      readOnlyRoots: [readonlyRoot, dirname(command)], writableRoots: [writableRoot], env: { HOME: writableRoot },
    };
    const invocation = linuxContainmentInvocation(options);
    assert.equal(invocation.command, '/usr/bin/bwrap');
    assert.ok(invocation.args.includes('--unshare-all'));
    assert.ok(invocation.args.includes('--die-with-parent'));
    assert.ok(invocation.args.includes('--clearenv'));
    assert.ok(invocation.args.indexOf('--tmpfs') < invocation.args.indexOf('--bind'));
    assert.deepEqual(invocation.args.slice(-3), ['--', command, '--version']);
    assert.ok(!invocation.args.includes(root));
    assert.ok(!invocation.args.includes(hidden));
    assert.throws(
      () => linuxContainmentInvocation({ ...options, writableRoots: [nested] }),
      /overlaps a readonly root/u,
    );
    assert.throws(
      () => linuxContainmentInvocation({ ...options, readOnlyRoots: ['/', ...options.readOnlyRoots] }),
      /reserved or broad/u,
    );
    assert.throws(
      () => linuxContainmentInvocation({ ...options, cwd: hidden }),
      /working directory is outside mounted roots/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux bubblewrap enforces real filesystem and network isolation when host namespaces are available', { skip: linuxWithoutBubblewrap }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clue-bwrap-live-')));
  try {
    const input = join(root, 'input');
    const output = join(root, 'output');
    const hidden = join(root, 'host-only.txt');
    mkdirSync(input);
    mkdirSync(output);
    writeFileSync(join(input, 'proof.txt'), 'frozen');
    writeFileSync(hidden, 'host only');
    const command = realpathSync(process.execPath);
    const script = [
      'const fs = require("node:fs");',
      'const os = require("node:os");',
      'const [input, output, hidden] = process.argv.slice(1);',
      'let inputWriteBlocked = false;',
      'try { fs.writeFileSync(input, "tamper"); } catch { inputWriteBlocked = true; }',
      'fs.writeFileSync(output, "candidate");',
      'process.stdout.write(JSON.stringify({ source: fs.readFileSync(input, "utf8"), inputWriteBlocked,',
      'hostFileVisible: fs.existsSync(hidden), outerEnvironmentVisible: process.env.CLUE_HOST_CANARY !== undefined,',
      'externalInterface: Object.values(os.networkInterfaces()).flat().some(iface => !iface.internal) }));',
    ].join(' ');
    const invocation = linuxContainmentInvocation({
      command, args: ['-e', script, join(input, 'proof.txt'), join(output, 'result.txt'), hidden],
      cwd: output, readOnlyRoots: [input, dirname(command)], writableRoots: [output], env: {},
    });
    const result = await runBoundedProcess(invocation.command, invocation.args, {
      cwd: output, env: { CLUE_HOST_CANARY: 'synthetic' }, timeoutMs: 5_000,
    });
    if (result.code !== 0 && /^bwrap: .*Operation not permitted/mu.test(result.stderr)) {
      t.skip(`Host refused Linux containment namespaces: ${result.stderr.trim()}`);
      return;
    }
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      source: 'frozen', inputWriteBlocked: true, hostFileVisible: false,
      outerEnvironmentVisible: false, externalInterface: false,
    });
    assert.equal(existsSync(join(output, 'result.txt')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
