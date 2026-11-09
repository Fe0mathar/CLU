import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';

import { asSha256, hashBytes, type Sha256 } from '../shared/ids.js';

export interface WindowsExecutionSupervisor {
  readonly command: string;
  readonly argsPrefix: readonly string[];
  readonly sha256: Sha256;
}

/** The request passed by private file to the operator-qualified Windows supervisor. */
export interface WindowsExecutionSupervisorRequest {
  readonly schemaVersion: 'clue-proof-exec/1';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly readOnlyRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly denyNetwork: true;
}

const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const SUPERVISOR_PATH = 'CLU_WINDOWS_SUPERVISOR_PATH';
const SUPERVISOR_SHA256 = 'CLU_WINDOWS_SUPERVISOR_SHA256';

/** Expose a bounded native refusal code without forwarding supervisor stderr. */
export function describeWindowsSupervisorRefusal(stderr: string): string {
  const message = 'The Windows supervisor refused containment.';
  const code = /^\[CLU-E production proof\] (PRODUCTION_PROOF_[A-Z0-9_]{1,72})\r?$/mu.exec(stderr)?.[1];
  return code === undefined ? message : `${message} Native code: ${code}.`;
}

/**
 * Finds a locally installed, content-pinned launcher. The pin is a trust decision by the
 * operator. The Windows supervisor, not this resolver, enforces OS containment.
 */
export function resolveWindowsSupervisor(
  environment: NodeJS.ProcessEnv = process.env,
): WindowsExecutionSupervisor {
  const configuredPath = environment[SUPERVISOR_PATH];
  const configuredHash = environment[SUPERVISOR_SHA256];
  if (configuredPath === undefined || configuredHash === undefined) {
    throw new Error(
      `Windows execution requires an operator-qualified OS supervisor. Configure ${SUPERVISOR_PATH} and ${SUPERVISOR_SHA256}; execution refused.`,
    );
  }

  if (
    !/^[A-Za-z]:[\\/](?![\\/])/u.test(configuredPath) ||
    !/\.exe$/iu.test(configuredPath) ||
    configuredPath.slice(3).split(/[\\/]/u).some(
      (part) => part === '' || /[<>:"|?*\u0000-\u001f]|[ .]$/u.test(part),
    )
  ) {
    throw new Error(`${SUPERVISOR_PATH} must be an absolute local .exe path with canonical components.`);
  }
  const expected = asSha256(configuredHash);
  if (expected === undefined) {
    throw new Error(`${SUPERVISOR_SHA256} must be a lowercase SHA-256 digest.`);
  }
  if (process.platform !== 'win32') {
    throw new Error('Windows execution supervisor is only available on a native Windows host.');
  }

  const command = win32.normalize(configuredPath);
  const physical = realpathSync.native(command);
  if (win32.relative(command, physical) !== '') {
    throw new Error('Windows execution supervisor must not resolve through a link or path alias.');
  }

  const before = lstatSync(physical);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_EXECUTABLE_BYTES) {
    throw new Error('Windows execution supervisor must be one regular unlinked executable of at most 128 MiB.');
  }
  const contents = readFileSync(physical);
  const after = lstatSync(physical);
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    contents.byteLength !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error('Windows execution supervisor changed during pin verification.');
  }
  if (hashBytes(contents) !== expected) {
    throw new Error('Windows execution supervisor does not match its configured SHA-256 pin.');
  }

  return { command: physical, argsPrefix: ['--request-file'], sha256: expected };
}
