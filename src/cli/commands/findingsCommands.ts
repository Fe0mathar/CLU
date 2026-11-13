import type { Command } from 'commander';
import { assessCurrentFindings, CycleFindingsError } from '../../control/cycleFindings.js';
import { withRuntime } from '../../control/runtime.js';
import { write } from '../output/formatter.js';

export function registerFindingsCommands(program: Command): void {
  program.command('findings').description('evidence-bound cycle findings')
    .command('plan').description('record a candidate decision for the current screened cycle')
    .action(() => {
      try {
        const receipt = withRuntime({ withLog: true, requireMission: true, verifyLog: 'full',
          allowStaleHeartbeatReclaim: false }, assessCurrentFindings);
        write(JSON.stringify(receipt));
        process.exitCode = 0;
      } catch (error) {
        const known = error instanceof CycleFindingsError;
        write(JSON.stringify({ schemaVersion: 'clue-cycle-findings/1', outcome: 'BLOCKED',
          code: known ? error.code : 'FINDINGS_WORKSPACE_UNAVAILABLE',
          reason: known ? error.message : 'The current workspace or its governed evidence could not be verified.' }));
        process.exitCode = 1;
      }
    });
}
