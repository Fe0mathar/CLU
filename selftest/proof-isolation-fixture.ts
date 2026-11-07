import { spawnSync } from 'node:child_process';

import { requireProofExecutionBoundary } from '../src/benchmark/restrictedExecution.js';

/** Native integration tests require the same operating-system boundary as real proof. */
export function nativeProofSkipReason(): string | false {
  try {
    const boundary = requireProofExecutionBoundary();
    if (boundary.kind === 'linux-bwrap') {
      const check = spawnSync('/usr/bin/bwrap', [
        '--unshare-all', '--unshare-user', '--disable-userns', '--assert-userns-disabled',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
        '--ro-bind-try', '/lib64', '/lib64', '--', '/usr/bin/true',
      ], { timeout: 3000, stdio: 'ignore' });
      if (check.status !== 0) return 'Linux OS containment is unavailable on this host.';
    }
    return false;
  } catch {
    return 'A native proof isolation supervisor is required.';
  }
}
