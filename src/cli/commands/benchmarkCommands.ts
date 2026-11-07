/**
 * `clue benchmark` — the Master Benchmark domain (DEV-P2-07, B4).
 *
 * Spec: ADR-0003 rev 2 — one module per command domain, and `benchmark` is what the
 *       operator types; ADR-0010 — one artifact, so `run` takes at most a path, never a
 *       contract/harness pair; `CLUE_Architecture_v9.md` §8 — argument handling, service
 *       calls, printing, and nothing else. The sequence itself lives in
 *       `src/control/benchmarkRun.ts`, the seam this command shares with the §18 cycle
 *       step so neither can fork the proven path.
 *
 * The harness drives `clue` itself as children, so the run executes outside the writer
 * lock. The seam pins its subject with a read-only runtime and rechecks it in the short
 * locked record phase. The authority declaration still reads
 * `mutates: true` — the command's durable effect is the recorded event — and the
 * mission gate is enforced where the mutation happens.
 *
 * §4 of the contract governs repetitions, warmups, and budgets; this command deliberately
 * exposes no override flags. A recorded run measures under the reviewed policy or it does
 * not measure (the runner's caller-override exists for tests and diagnostics, and a CLI
 * flag would quietly turn every run into a diagnostic).
 */

import type { Command } from 'commander';

import { findRepoRoot, loadConfig, withRuntime } from '../../control/runtime.js';
import {
  performBenchmarkRun,
  recordBenchmarkRun,
  resolveContract,
} from '../../control/benchmarkRun.js';
import { printChecks, short, write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

async function commandBenchmarkRun(options: { contract?: string }): Promise<number> {
  let repoRoot: string;
  let config: ReturnType<typeof loadConfig>;
  try {
    repoRoot = findRepoRoot();
    config = loadConfig(repoRoot);
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const contract = resolveContract(config, options.contract, process.cwd());
  if ('error' in contract) {
    write(contract.error);
    return 1;
  }

  if (!contract.registered) {
    write('REFUSED: executable benchmarks must be registered. Run clue benchmark run without --contract.');
    return 1;
  }
  write('Running the registered Master Benchmark:');
  write(`  contract   ${contract.path}`);
  write('');

  // Phase 1 — unlocked: the harness's children take the writer lock themselves.
  const performed = await performBenchmarkRun({
    repoRoot,
    config,
    contract,
    log: (line) => write(`  … ${line}`),
  });

  if (!performed.outcome.ok) {
    write('');
    write(`REFUSED at ${performed.outcome.stage}: ${performed.outcome.reason}`);
    return 1;
  }
  const outcome = performed.outcome;

  // Phase 2 — locked: one event, one artifact, then the receipt.
  return runGuarded(() =>
    withRuntime({ repoRoot, withLog: true, requireMission: true }, (runtime) => {
      const receipt = recordBenchmarkRun(runtime, performed);
      const { result, contract: stick } = outcome;
      write('');
      printChecks([
        {
          level: 'ok',
          label: 'benchmark',
          detail: `${stick.benchmark_id}@${stick.benchmark_version} (${stick.block_id}, ${stick.runner_adapter})`,
        },
        { level: 'ok', label: 'contract', detail: short(stick.sha256) },
        ...(contract.registered
          ? []
          : [{ level: 'warn' as const, label: 'proof', detail: 'diagnostic run only; not eligible as proof evidence' }]),
        {
          level: 'info',
          label: 'score',
          detail:
            result.unifiedScore === null
              ? 'null — no opening baseline to compare against (stated, not fabricated)'
              : result.unifiedScore.toFixed(4),
        },
        {
          level: result.incomplete.length === 0 ? 'ok' : 'warn',
          label: 'measures',
          detail: `${result.measures.length} collected, ${result.incomplete.length} incomplete`,
        },
        {
          level: 'info',
          label: 'protective',
          detail: result.protective
            .map((entry) => `${entry.id}=${entry.value === null ? 'null' : entry.value}`)
            .join(' '),
        },
        {
          level: outcome.budget.exhausted ? 'warn' : 'ok',
          label: 'budget',
          detail: `${Math.round(outcome.budget.spent_ms / 1000)} s spent${outcome.budget.exhausted ? ' — EXHAUSTED, run is incomplete' : ''}`,
        },
        { level: 'ok', label: 'recorded', detail: `${receipt.event.id} → artifact ${short(receipt.artifact.hash)}` },
      ]);
      for (const entry of result.incomplete) {
        write(`  incomplete  ${entry.id}: ${entry.reason}`);
      }
      return 0;
    }),
  );
}

/** Registers the `benchmark` commands. */
export function registerBenchmarkCommands(program: Command): void {
  const benchmark = program.command('benchmark').description('the Master Benchmark (Execution Model §17–§18)');
  benchmark
    .command('run')
    .description('execute the registered Master Benchmark and record the run (ADR-0010)')
    .option(
      '--contract <path>',
      'run an explicit contract instead of the registered input (recorded as out-of-registration)',
    )
    .action(async (options: { contract?: string }) => {
      process.exitCode = await commandBenchmarkRun(options);
    });
}
