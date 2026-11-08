import { execFile } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';

import { readTapCounts } from '../release-readiness.mjs';

const nodeOptions = ['--test', '--test-concurrency=1', '--test-reporter=tap'];

function testEnvironment(node) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const system32 = env.SystemRoot === undefined ? [] : [join(env.SystemRoot, 'System32')];
  env.PATH = [dirname(node), ...system32].join(delimiter);
  return env;
}

export function runDashboardTests({ node, cwd, testPaths, signal }) {
  const began = performance.now();
  return new Promise((done) => {
    execFile(node, [...nodeOptions, ...testPaths], {
      cwd,
      env: testEnvironment(node),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 75_000,
      signal,
      windowsHide: true,
    }, (error, stdout) => {
      const counts = readTapCounts(stdout ?? '');
      const exitCode = error === null ? 0 : Number.isInteger(error.code) ? error.code : null;
      let state;
      if (signal.aborted) state = 'INTERRUPTED';
      else if (error?.killed || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') state = 'TIME_OR_OUTPUT_LIMIT';
      else if (counts === null) state = 'TAP_UNVERIFIED';
      else if (counts.fail > 0 || counts.cancelled > 0 || exitCode !== 0) state = 'FAILED';
      else state = counts.pass === counts.tests ? 'PASSED' : 'INCOMPLETE';
      done({
        state, exitCode, counts, fileCount: testPaths.length,
        elapsedMs: Math.round(performance.now() - began),
      });
    });
  });
}
