import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { describeWindowsSupervisorRefusal, resolveWindowsSupervisor } from '../src/benchmark/windowsExecutionSupervisor.js';
import { hashText } from '../src/shared/ids.js';

const pin = (path: string, sha256 = 'a'.repeat(64)): NodeJS.ProcessEnv => ({
  CLU_WINDOWS_SUPERVISOR_PATH: path,
  CLU_WINDOWS_SUPERVISOR_SHA256: sha256,
});

test('Windows containment refusals retain the bounded native code and omit raw stderr', () => {
  const message = 'The Windows supervisor refused containment.';
  const code = 'PRODUCTION_PROOF_SESSION_CONNECT_TIMEOUT';
  assert.equal(describeWindowsSupervisorRefusal(`private path\r\n[CLU-E production proof] ${code}\r\nother output`),
    `${message} Native code: ${code}.`);
  assert.equal(describeWindowsSupervisorRefusal(`[CLU-E production proof] ${code} private path\r\n`), message);
  assert.equal(describeWindowsSupervisorRefusal(`unrelated output: ${code}\n`), message);
});

test('Windows supervisor fails closed without an explicit absolute executable and content pin', () => {
  assert.throws(() => resolveWindowsSupervisor({}), /operator-qualified OS supervisor/);
  for (const path of [
    'supervisor.exe', 'C:supervisor.exe', 'C:\\trust\\..\\supervisor.exe',
    'C:\\trust\\supervisor.exe:stream', '\\\\server\\share\\supervisor.exe',
    '\\\\?\\C:\\trust\\supervisor.exe', 'C:\\trust.\\supervisor.exe',
    'C:\\trust\\supervisor.cmd',
  ]) {
    assert.throws(() => resolveWindowsSupervisor(pin(path)), /absolute local \.exe path/, path);
  }
  assert.throws(
    () => resolveWindowsSupervisor(pin('C:\\trust\\supervisor.exe', 'A'.repeat(64))),
    /lowercase SHA-256 digest/,
  );
  if (process.platform !== 'win32') {
    assert.throws(
      () => resolveWindowsSupervisor(pin('C:\\trust\\supervisor.exe')),
      /native Windows host/,
    );
  }
});

test('native Windows supervisor resolves only the exact pinned file', {
  skip: process.platform !== 'win32',
}, () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'clue-supervisor-')));
  try {
    const path = join(root, 'supervisor.exe');
    const original = 'identity fixture';
    const expected = hashText(original);
    writeFileSync(path, original);
    assert.deepEqual(resolveWindowsSupervisor(pin(path, expected)), {
      command: path, argsPrefix: ['--request-file'], sha256: expected,
    });
    writeFileSync(path, 'modified fixture');
    assert.throws(() => resolveWindowsSupervisor(pin(path, expected)), /SHA-256 pin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
