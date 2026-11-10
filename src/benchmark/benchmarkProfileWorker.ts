/** Fixed CLI worker for supervised, profile-bound clu-master benchmark scenarios. */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { buildProgram } from '../cli/index.js';
import {
  BENCHMARK_PROFILE_INPUTS_FILE,
  benchmarkWorkerProfile,
  isBenchmarkProfileCommand,
  isBenchmarkProfileContract,
  withBenchmarkProfileInputs,
} from '../control/projectProfiles/benchmarkProfileInputs.js';
import { findRepoRoot, withRuntime } from '../control/runtime.js';

try {
  const [sha256, ...command] = process.argv.slice(2);
  const temp = realpathSync.native(tmpdir());
  if (process.platform !== 'win32' || basename(temp) !== 'temp' ||
      !/^clue-exec-[A-Za-z0-9]+$/u.test(basename(dirname(temp))) ||
      sha256 === undefined || !/^[0-9a-f]{64}$/u.test(sha256) || !isBenchmarkProfileCommand(command)) {
    throw new Error('Supervised benchmark worker invocation is invalid.');
  }
  const repoRoot = realpathSync.native(process.cwd());
  if (relative(repoRoot, realpathSync.native(findRepoRoot())) !== '') {
    throw new Error('Supervised benchmark worker must run from its pinned CLU-E checkout.');
  }
  await withBenchmarkProfileInputs(join(temp, BENCHMARK_PROFILE_INPUTS_FILE), sha256, repoRoot, async () => {
    const benchmark = benchmarkWorkerProfile(repoRoot)?.profile.authority.masterBenchmark;
    if (benchmark === null || benchmark === undefined || !isBenchmarkProfileContract(benchmark.sha256)) {
      throw new Error('Supervised benchmark worker requires the exact clu-master@0.2.0 binding.');
    }
    // Verify the live workspace owner, durable mission and fresh projections before the
    // command can open a writer. Normal runtime command gates are checked again on use.
    withRuntime({ repoRoot, withLog: false, readOnly: true, requireMission: true }, () => {});
    await buildProgram().parseAsync(command, { from: 'user' });
  });
} catch (error) {
  process.stderr.write(`[CLU-E benchmark worker] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
