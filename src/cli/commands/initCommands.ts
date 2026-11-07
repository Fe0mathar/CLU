/**
 * CLUE `init` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command domain,
 *       named `<domain>Commands.ts`.
 *       `CLUE_Architecture_v9.md` — the workspace layout and the founding mission version.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`.
 *
 * `init` is one of the three commands that must run before a mission exists (with `doctor`
 * and `docs`), which is why `commandAuthority.ts` exempts it from the mission requirement.
 * It is idempotent: running it on an existing workspace registers a successor mission version
 * if the governed inputs moved, and reports no change if they did not.
 *
 * Behaviour is moved, not changed.
 */

import type { Command } from 'commander';

import {
  createWorkspaceLayout,
  findRepoRoot,
  loadConfig,
  resolveConfigPaths,
  withRuntime,
} from '../../control/runtime.js';
import { printChecks, short, write, type Check } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue init                                                                  */
/* ------------------------------------------------------------------------- */

function commandInit(): number {
  const repoRoot = findRepoRoot();
  const config = resolveConfigPaths(loadConfig(repoRoot), repoRoot);
  createWorkspaceLayout(config.workspace.root);

  return withRuntime({ withLog: true, verifyLog: 'tail' }, (runtime) => {
    const log = runtime.requireLog();
    const mission = runtime.mission;
    if (mission === null) {
      write('Mission registry unavailable.');
      return 1;
    }

    runtime.projections.sync(log);
    const result = mission.bootstrap();

    const checks: Check[] = [
      { level: 'ok', label: 'workspace', detail: runtime.workspaceRoot },
      {
        level: 'ok',
        label: 'mission',
        detail: `${result.mission.id} (version ${result.mission.version}, ${result.change})`,
      },
      {
        level: 'ok',
        label: 'constitution',
        detail: `${runtime.config.constitution.file} ${short(result.mission.constitution_hash)}`,
      },
      {
        level: runtime.protectedRuleCount === 0 ? 'warn' : 'ok',
        label: 'protected surfaces',
        detail:
          runtime.protectedRuleCount === 0
            ? 'no rules loaded — patching policy is not in force'
            : `${runtime.protectedRuleCount} rule(s) from policy`,
      },
    ];

    for (const path of result.changedDocuments) {
      checks.push({ level: 'info', label: 'document changed', detail: path });
    }
    for (const amendment of result.mission.amendments) {
      checks.push({ level: 'info', label: `amendment ${amendment.code}`, detail: 'in force' });
    }

    printChecks(checks);
    write('');
    write('Next: clue docs ingest, then clue snapshot');
    return 0;
  });
}

/** Registers the `init` command. */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('create the workspace and register the current mission version')
    .action(() => {
      process.exitCode = runGuarded(commandInit);
    });
}
