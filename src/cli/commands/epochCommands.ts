/**
 * `clue epoch` — the evidence-epoch domain (ADR-0006, accepted 2026-08-10).
 *
 * Spec: ADR-0006 (the record, the guards, the phrase); `CLUE_Execution_Model_v9.md` §21 is
 *       untouched by this — sealing draws a boundary in history, it does not stop anything.
 * Layout: ADR-0003 rev 2 — `epoch` is its own domain because it is what the operator types.
 *
 * The CLI's share of the act mirrors `docs ratify` deliberately, because the two ceremonies
 * make the same three promises:
 *
 * **Interactive only.** No `--yes`; non-TTY input is refused. A boundary a script can draw
 * is a side effect, not an act.
 *
 * **The phrase is bound to the state.** The operator types `SEAL <first 12 of the legacy
 * head hash>`, read off the preview — a head remembered from an earlier session cannot seal
 * today's log. The preview reads the head through the static `EventLog.readHead`, so no
 * human sits at a prompt holding the writer lock.
 *
 * **The service decides.** Ratification currency, full-chain verification, the blob
 * manifest, duplicate names, and the mission basis are all re-checked inside the lock at
 * the moment of the act. If the head moved between preview and act, the record binds the
 * *true* verified head and the receipt shows it — the preview informs; the record is never
 * wrong.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { Command } from 'commander';

import { findRepoRoot, loadConfig, withRuntime } from '../../control/runtime.js';
import { EventLog } from '../../memory/eventLog.js';
import { write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

async function commandEpochSeal(epochName: string): Promise<number> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    write('epoch seal is an interactive Creator act; non-interactive input is refused');
    write('(no --yes exists by design).');
    return 1;
  }

  let headSequence: number;
  let headHash: string;
  try {
    const repoRoot = findRepoRoot();
    const config = loadConfig(repoRoot);
    const eventsDir = join(config.workspace.root, 'events');
    if (!existsSync(eventsDir)) {
      write('No event log yet — run `clue init` before sealing an epoch.');
      return 1;
    }
    const head = EventLog.readHead(eventsDir);
    if (head === null) {
      write('The event log is empty — run `clue init` before sealing an epoch.');
      return 1;
    }
    headSequence = head.sequence;
    headHash = head.hash;
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }

  write(`You are about to seal evidence epoch \`${epochName}\`:`);
  write('');
  write(`  legacy head   sequence ${headSequence}, hash ${headHash}`);
  write('  meaning       everything at or before this head is bootstrap-era history;');
  write('                everything after was produced under the ratified authority');
  write('');
  write('Inside the lock, the service re-verifies: the ratification is current, every pack');
  write('file agrees with its seal, the whole event chain verifies, and every artifact blob');
  write('hashes to its name. Any disagreement refuses the act. Nothing is deleted or rotated.');
  write('');

  const token = headHash.slice(0, 12);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question(`Type exactly \`SEAL ${token}\` to proceed, anything else aborts: `)
  ).trim();
  rl.close();

  if (answer !== `SEAL ${token}`) {
    write('Aborted — nothing was recorded.');
    return 1;
  }

  return runGuarded(() =>
    withRuntime({ withLog: true, verifyLog: 'tail' }, (runtime) => {
      const record = runtime
        .requireMission()
        .sealEpoch({ epochName, statement: answer });
      write('');
      write(`Sealed as ${record.event_id} (sequence ${record.sequence}).`);
      write(`  epoch       ${record.epoch_name}`);
      write(`  boundary    sequence ${record.legacy_head_sequence}, hash ${record.legacy_head_hash}`);
      write(`  blobs       ${record.blob_count} pinned under ${record.blob_manifest_sha256}`);
      write(`  stands on   ${record.ratification_event_id} (seal ${record.ratified_seal_sha256.slice(0, 12)}…)`);
      write(`  statement   ${record.statement}`);
      write(`  at          ${record.sealed_at}`);
      return 0;
    }),
  );
}

/** Registers the `epoch` commands. */
export function registerEpochCommands(program: Command): void {
  const epoch = program.command('epoch').description('evidence-epoch boundaries');
  epoch
    .command('seal')
    .description("record the Creator's evidence-epoch boundary (ADR-0006)")
    .argument('[name]', 'epoch name', 'P0-final')
    .action(async (name: string) => {
      process.exitCode = await commandEpochSeal(name);
    });
}
