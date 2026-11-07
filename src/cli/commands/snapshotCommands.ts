/**
 * CLUE `snapshot` command.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain; the CLI is argument handling, one service call, and printing.
 *       §11.2 — `snapshot.ts` separates immutable content identity from capture identity and
 *       records the governed basis. This command invokes that; it defines none of it.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`.
 *
 * ## What the id is, and what it is not
 *
 * A snapshot id is a function of the scanned bytes **and the scan policy** — source roots,
 * excludes, modes, and the entries that were skipped — folded together under a versioned
 * identity rule (`SNAPSHOT_CONTENT_ID_VERSION`). It carries no volatile capture fact: not
 * the path scanned, not `captured_at`, not the origin, not Git state. Those live in the
 * capture receipt beside it.
 *
 * The consequence is the property every comparative measurement rests on: **the same bytes
 * under the same policy produce the same id wherever they sit on disk.** That is what lets a
 * shadow clone be proven identical to the canonical tree rather than assumed to be. Verified
 * directly — two trees with identical contents at different paths hash to one id.
 *
 * The policy half of that is easy to lose. Two captures of the same files under different
 * excludes are *different* snapshots, correctly: they scanned different programs. Folding the
 * basis into the id is what stops a narrowed exclude list looking like an unchanged tree.
 *
 * ## Three things the code says that the output does not
 *
 * **`--shadow` changes what is scanned, not how it is identified.** Origin is recorded on the
 * receipt so a reader knows which tree was walked, and is deliberately absent from the id —
 * which is the whole mechanism above.
 *
 * **`skipped` is never silent.** A symlink, an unreadable file, or a special file is recorded
 * with its path and reason rather than dropped, and a non-zero count prints as a warning.
 * Skipped entries are folded into the id, so a tree that became unreadable is a different
 * snapshot rather than a quietly smaller one.
 *
 * **`state: identical to a previous capture` is the expected result, not a failure.**
 * Recapturing an unchanged tree is how a run proves the tree did not move, so the command
 * reports it as `info` and still exits 0. The diff that follows lists changed paths and is
 * capped at 20 with a count of the remainder — the cap is presentation only and never
 * reaches the record.
 *
 * ## Authority
 *
 * `withLog: true, requireMission: true`, matching the registry: a snapshot is durable
 * evidence and must be attributable. It takes the single-writer lock and will lock out a
 * concurrent recognition. Both refusal paths — no registry, or a root that does not exist —
 * exit 1 before anything is captured.
 *
 * Behaviour is moved, not changed.
 */

import { existsSync } from 'node:fs';

import type { Command } from 'commander';

import { withRuntime } from '../../control/runtime.js';
import { printChecks, short, write } from '../output/formatter.js';
import { guarded as guardedWith } from './shared.js';

const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue snapshot                                                              */
/* ------------------------------------------------------------------------- */

function commandSnapshot(origin: 'canonical' | 'shadow'): number {
  return withRuntime({ withLog: true, requireMission: true }, (runtime) => {
    const snapshots = runtime.snapshots;
    if (snapshots === null) {
      write('Snapshot registry unavailable.');
      return 1;
    }

    const root = origin === 'shadow' ? runtime.config.shadow.root : runtime.config.project.root;
    if (!existsSync(root)) {
      write(`Cannot capture: ${root} does not exist.`);
      return 1;
    }

    const result = snapshots.capture({
      root,
      sourceRoots: runtime.config.project.source_roots,
      exclude: runtime.config.project.exclude,
      origin,
    });

    printChecks([
      { level: 'ok', label: 'snapshot', detail: result.record.id },
      {
        level: 'ok',
        label: 'files',
        detail: `${result.record.file_count} (${result.record.total_bytes} bytes)`,
      },
      {
        level: result.record.skipped_count === 0 ? 'ok' : 'warn',
        label: 'skipped',
        detail: result.record.skipped_count === 0 ? 'none' : `${result.record.skipped_count} entries`,
      },
      {
        level: result.alreadyKnown ? 'info' : 'ok',
        label: 'state',
        detail: result.alreadyKnown ? 'identical to a previous capture' : 'new',
      },
    ]);

    if (result.diff !== null && result.diff.changedPaths.length > 0) {
      write('');
      write(`changed since ${short(result.diff.from ?? 'nothing')}:`);
      for (const path of result.diff.changedPaths.slice(0, 20)) write(`  ${path}`);
      if (result.diff.changedPaths.length > 20) {
        write(`  … and ${result.diff.changedPaths.length - 20} more`);
      }
    }

    write('');
    write('Next: clue recognize');
    return 0;
  });
}

/** Registers the `snapshot` command. */
export function registerSnapshotCommands(program: Command): void {
  program
    .command('snapshot')
    .description('capture an immutable snapshot of the target source tree')
    .option('--shadow', 'capture the shadow clone instead of the canonical tree', false)
    .action((options: { shadow: boolean }) => {
      process.exitCode = runGuarded(() => commandSnapshot(options.shadow ? 'shadow' : 'canonical'));
    });
}