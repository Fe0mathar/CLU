/**
 * CLUE `status` commands.
 *
 * Spec: `CLUE_Status_Contract_v9.md` §17 — `clue status show | export | validate | diff`,
 *       plus the workspace history this build adds (`history`, `retain`).
 *       §18 — an invalid seal blocks automation, which is why `validate` exits non-zero.
 * Directory: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 — one module per command
 *       domain, named `<domain>Commands.ts`; the CLI is a thin transport over application services.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. This is the first domain extracted,
 *          and it is deliberately the one added most recently: these six commands grew that
 *          file by ~240 lines in a single session, which is the shape of the problem the
 *          decomposition exists to stop.
 *
 * Backlog: DEV-P1-25 — `clue status report` replaces the hand-maintained `clue-status.md`.
 *          §19.2 makes Status the projection over durable records, and a second status document
 *          written by hand is a second answer to the same question with nothing to say which
 *          wins. The file it produced was dated 23 July, said "Mission: not yet registered" and
 *          "Nothing has been executed", and told the operator to `git init` — every line of it
 *          false by the time anyone read it. A generated one cannot go stale without the tree
 *          going stale with it.
 *
 * Behaviour is moved, not changed. Every command body below is the one that was in
 * `index.ts`, and the full suite is the check on that claim.
 *
 * The composition itself is not here. `projectStatusFromRuntime` in
 * `src/status/statusFromRuntime.ts` is what the daemon and the HTTP API also call, so this
 * module reads exactly what every other surface reads (§20 gate 4). What lives here is
 * argument handling, one service call, and printing — which is all §7 permits the CLI.
 */

import type { Command } from 'commander';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { withRuntime, type Runtime } from '../../control/runtime.js';
import { replaceFileSync, writeAllSync } from '../../shared/durableFs.js';
import { projectStatusFromRuntime } from '../../status/statusFromRuntime.js';
import { verifySeal } from '../../status/statusSeal.js';
import { STATUS_SCHEMA_VERSION } from '../../status/statusContractV5.js';
import {
  diffStatus,
  loadRetainedStatus,
  pruneStatusHistory,
  readStatusHistory,
  retainStatus,
} from '../../status/history.js';
import { printChecks, short, write } from '../output/formatter.js';

/**
 * Projects the sealed Status body (`DEV-P1-12`, Status Contract §17).
 *
 * Read-only by construction: the runtime is opened without the event-log writer, so running
 * `clue status` can never lock out recognition or the daemon.
 *
 * ADR-0002 step 5: the composition itself moved to `src/status/statusFromRuntime.ts`, which
 * the dashboard service also calls. It previously lived here, and the dashboard filled the
 * same options with nulls — two Status bodies over one workspace, differently populated
 * depending on who asked. §1 requires one snapshot with no surface assembling its own.
 */
function projectCurrentStatus(runtime: Runtime, capturedAt: string) {
  return projectStatusFromRuntime(runtime, { capturedAt });
}

/* ------------------------------------------------------------------------- */
/* clue status report — DEV-P1-25                                             */
/* ------------------------------------------------------------------------- */

/** Where the generated status document goes when no path is given. */
const STATUS_REPORT_DEFAULT = 'clue-status.md';

/**
 * Renders the sealed Status snapshot as Markdown.
 *
 * A projection of a projection, and it must behave like one: it reads the snapshot and adds no
 * fact of its own. Every number below is a count of something in the body, and where the body
 * says a branch is unavailable this says so too, with the branch's own stated reason rather than
 * a summary of it (§3.3 — absence is reported as absence, never as an invented zero).
 *
 * The seal is rendered whether or not it verifies. A status document that omits its own failed
 * seal is worse than no document, because it reads as a healthy one.
 */
function renderStatusReport(
  snapshot: ReturnType<typeof projectCurrentStatus>['snapshot'],
  faults: ReturnType<typeof projectCurrentStatus>['faults'],
): string {
  const verification = verifySeal(snapshot);
  const out: string[] = [];
  const row = (label: string, value: string): string => `| ${label} | ${value} |`;

  out.push('# CLU-E status');
  out.push('');
  out.push('**GENERATED — do not edit by hand.** Produced by `clue status report` from the sealed');
  out.push('Status snapshot. Editing this file changes nothing; the next run overwrites it.');
  out.push('');
  out.push('Status is a projection over durable records and never a source used to reconstruct');
  out.push('them (Constitution §3.5, Directory §19.2). Backlog: `DEV-P1-25`.');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(row('Generated at', snapshot.generatedAt));
  out.push(row('Schema', snapshot.schemaVersion));
  out.push(row('Status hash', `\`${snapshot.seal.statusHash}\``));
  out.push(
    row(
      'Seal',
      verification.valid
        ? `verified · ${String(verification.consistency.checks.length - verification.consistency.skipped)} cross-checks ran, ${String(verification.consistency.skipped)} skipped`
        : `**INVALID** — ${verification.failures.map((f) => f.detail).join('; ')}`,
    ),
  );
  out.push(
    row(
      'Consistency',
      snapshot.seal.consistent ? 'branches agree' : `**${snapshot.seal.inconsistencies.join('; ')}**`,
    ),
  );
  out.push(
    row(
      'Projection',
      faults.length === 0
        ? 'no branch reader failed'
        : `**${String(faults.length)} branch reader(s) failed** — ${faults.map((f) => `${f.branch}: ${f.detail}`).join('; ')}`,
    ),
  );
  out.push('');

  out.push('## Capability');
  out.push('');
  out.push(
    `${String(snapshot.capability.backedBranches.length)} branches are backed by durable state; ` +
      `${String(snapshot.capability.unsupportedBranches.length)} are specified by the contract and ` +
      'unimplemented in this build. The second number is not a defect count — it is what this ' +
      'build declares it cannot do, which §1 and gate 26 require it to state rather than imply.',
  );
  out.push('');
  out.push(`**Backed:** ${snapshot.capability.backedBranches.join(', ') || 'none'}`);
  out.push('');
  out.push(`**Unsupported:** ${snapshot.capability.unsupportedBranches.join(', ') || 'none'}`);
  out.push('');

  out.push('## Gates');
  out.push('');
  out.push(`**Satisfied:** ${snapshot.capability.satisfiedGates.join(', ') || 'none claimed'}`);
  out.push('');
  if (snapshot.capability.unreachableGates.length === 0) {
    out.push('**Unreachable:** none');
  } else {
    out.push('**Unreachable, with the reason:**');
    out.push('');
    for (const entry of snapshot.capability.unreachableGates) {
      out.push(`- gate ${String(entry.gate)} — ${entry.reason}`);
    }
  }
  out.push('');
  out.push(
    'A gate in neither list is undeclared: this build neither claims it nor explains why it ' +
      'cannot be reached. `CLUE_Status_Contract_v9.md` §20 defines considerably more gates than ' +
      'appear above, and the difference is unstated rather than satisfied.',
  );
  out.push('');

  out.push('## Branches');
  out.push('');
  out.push(
    'State comes from the capability declaration, not from inspecting the branch body. The first ' +
      'version of this renderer inferred it — anything without a `state` field was called ' +
      '`populated` — and it labelled `goldenMetrics` populated on a build where ADR-0001 declares ' +
      'the Golden branch explicitly UNAVAILABLE, because that branch names its own field ' +
      '`projectionState`. A projection that guesses is the invented healthy state §3.3 forbids, ' +
      'so nothing below is inferred: a branch the declaration does not classify is reported as ' +
      'undeclared rather than assumed well.',
  );
  out.push('');
  out.push('| Branch | State | Detail |');
  out.push('|---|---|---|');
  const skip = new Set(['schemaVersion', 'generatedAt', 'sources', 'capability', 'seal']);
  const backed = new Set(snapshot.capability.backedBranches);
  const unsupported = new Set(snapshot.capability.unsupportedBranches);
  for (const [name, value] of Object.entries(snapshot)) {
    if (skip.has(name)) continue;
    const branch = value as { state?: unknown; projectionState?: unknown; reason?: unknown };
    const own =
      typeof branch === 'object' && branch !== null
        ? typeof branch.state === 'string'
          ? branch.state
          : typeof branch.projectionState === 'string'
            ? branch.projectionState
            : null
        : null;

    // The branch's own word first, because it is the more specific fact; the declaration second,
    // because it is the one that covers a branch carrying no state of its own.
    const state =
      own ?? (backed.has(name) ? 'populated' : unsupported.has(name) ? 'unsupported' : 'undeclared');
    const detail =
      typeof branch === 'object' && branch !== null && typeof branch.reason === 'string'
        ? branch.reason
        : state === 'undeclared'
          ? 'in neither backedBranches nor unsupportedBranches — this build states nothing about it'
          : '—';
    out.push(`| \`${name}\` | ${state} | ${detail} |`);
  }
  out.push('');

  out.push('## Sources');
  out.push('');
  out.push('The durable source identities this body was assembled from (§15).');
  out.push('');
  if (snapshot.sources.length === 0) {
    out.push('_none_');
  } else {
    for (const source of snapshot.sources) out.push(`- \`${source}\``);
  }
  out.push('');
  return `${out.join('\n')}\n`;
}

function commandStatusReport(target: string | undefined): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const { snapshot, faults } = projectCurrentStatus(runtime, new Date().toISOString());
    const requested = target ?? STATUS_REPORT_DEFAULT;
    const path = isAbsolute(requested) ? requested : resolve(runtime.repoRoot, requested);

    // Same durable write as `export`: a reader sees the previous document or the new one, never
    // a half-written one.
    const temporary = `${path}.tmp`;
    const descriptor = openSync(temporary, 'w');
    try {
      writeAllSync(descriptor, Buffer.from(renderStatusReport(snapshot, faults), 'utf8'));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    replaceFileSync(temporary, path);

    printChecks([
      { level: 'ok', label: 'status report', detail: path },
      { level: 'ok', label: 'status hash', detail: short(snapshot.seal.statusHash) },
    ]);
    return 0;
  });
}

/** How many sealed status snapshots a workspace keeps. Status is reprojectable, so this is
 * workspace hygiene rather than an evidence-retention decision. */
const STATUS_HISTORY_KEEP = 20;

function commandStatusShow(asJson: boolean): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const { snapshot, faults } = projectCurrentStatus(runtime, new Date().toISOString());
    if (asJson) {
      write(JSON.stringify(snapshot, null, 2));
      return 0;
    }

    const verification = verifySeal(snapshot);
    const backed = snapshot.capability.backedBranches.length;
    const unsupported = snapshot.capability.unsupportedBranches.length;

    printChecks([
      { level: 'ok', label: 'schema', detail: snapshot.schemaVersion },
      { level: 'ok', label: 'status hash', detail: short(snapshot.seal.statusHash) },
      {
        level: verification.valid ? 'ok' : 'warn',
        label: 'seal',
        detail: verification.valid
          ? `verified · ${String(verification.consistency.checks.length - verification.consistency.skipped)} cross-checks ran, ${String(verification.consistency.skipped)} skipped`
          : verification.failures.map((failure) => failure.detail).join('; '),
      },
      {
        level: snapshot.seal.consistent ? 'ok' : 'warn',
        label: 'consistency',
        detail: snapshot.seal.consistent
          ? 'branches agree'
          : snapshot.seal.inconsistencies.join('; '),
      },
      {
        level: 'info',
        label: 'branches',
        detail: `${String(backed)} backed, ${String(unsupported)} unsupported (no owning domain in this build)`,
      },
      {
        level: faults.length === 0 ? 'ok' : 'warn',
        label: 'projection',
        detail:
          faults.length === 0
            ? 'no branch reader failed'
            : faults.map((fault) => `${fault.branch}: ${fault.detail}`).join('; '),
      },
      {
        level: 'info',
        label: 'gates',
        detail:
          `satisfied ${snapshot.capability.satisfiedGates.join(', ') || 'none'}; ` +
          `unreachable ${snapshot.capability.unreachableGates.map((entry) => String(entry.gate)).join(', ') || 'none'}`,
      },
    ]);
    for (const entry of snapshot.capability.unreachableGates) {
      write(`  gate ${String(entry.gate)}: ${entry.reason}`);
    }
    return 0;
  });
}

function commandStatusExport(target: string): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const { snapshot } = projectCurrentStatus(runtime, new Date().toISOString());
    const path = isAbsolute(target) ? target : resolve(runtime.repoRoot, target);
    // §17: exports use atomic writes and content hashes. The seal already carries the hash;
    // the durable primitives own the atomicity, so a reader never sees a half-written export.
    const temporary = `${path}.tmp`;
    const descriptor = openSync(temporary, 'w');
    try {
      writeAllSync(descriptor, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    replaceFileSync(temporary, path);
    printChecks([
      { level: 'ok', label: 'exported', detail: path },
      { level: 'ok', label: 'status hash', detail: short(snapshot.seal.statusHash) },
    ]);
    return 0;
  });
}

function commandStatusValidate(target: string): number {
  const path = isAbsolute(target) ? target : resolve(process.cwd(), target);
  const snapshot = loadRetainedStatus(path);
  const verification = verifySeal(snapshot);
  printChecks([
    { level: 'ok', label: 'file', detail: path },
    { level: 'ok', label: 'schema', detail: snapshot.schemaVersion },
    {
      level: verification.valid ? 'ok' : 'warn',
      label: 'seal',
      detail: verification.valid
        ? `verified · ${short(verification.recomputedHash)}`
        : verification.failures.map((failure) => `${failure.code}: ${failure.detail}`).join('; '),
    },
    {
      level: verification.consistency.consistent ? 'ok' : 'warn',
      label: 'consistency',
      detail: verification.consistency.consistent
        ? `${String(verification.consistency.checks.length - verification.consistency.skipped)} checks ran, ${String(verification.consistency.skipped)} skipped`
        : verification.consistency.inconsistencies.join('; '),
    },
  ]);
  // §18: an invalid seal blocks automation, so the exit code must carry that outward —
  // a pipeline that only reads stdout would otherwise treat a refusal as a pass.
  return verification.valid ? 0 : 1;
}

function commandStatusDiff(leftPath: string, rightPath: string): number {
  const left = loadRetainedStatus(isAbsolute(leftPath) ? leftPath : resolve(process.cwd(), leftPath));
  const right = loadRetainedStatus(isAbsolute(rightPath) ? rightPath : resolve(process.cwd(), rightPath));
  const diff = diffStatus(left, right);

  printChecks([
    { level: 'info', label: 'left', detail: `${diff.left.generatedAt} ${short(diff.left.statusHash)}` },
    { level: 'info', label: 'right', detail: `${diff.right.generatedAt} ${short(diff.right.statusHash)}` },
    {
      level: diff.identical ? 'ok' : 'info',
      label: 'result',
      detail: diff.identical ? 'identical' : `${String(diff.branches.length)} branch change(s)`,
    },
    ...(diff.schemaChanged
      ? [{ level: 'warn' as const, label: 'schema', detail: `${left.schemaVersion} → ${right.schemaVersion}` }]
      : []),
  ]);
  for (const branch of diff.branches) {
    // A coverage regression is the one result worth surfacing loudly: something that was
    // being observed no longer is.
    const level = branch.change === 'lost' ? 'warn' : 'info';
    printChecks([{ level, label: branch.branch, detail: `${branch.change}${branch.detail === null ? '' : ` — ${branch.detail}`}` }]);
  }
  return 0;
}

function commandStatusHistory(): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const history = readStatusHistory(runtime.workspaceRoot);
    if (history.entries.length === 0 && history.unreadable.length === 0) {
      printChecks([{ level: 'info', label: 'history', detail: 'no snapshots retained' }]);
      return 0;
    }
    for (const entry of history.entries) {
      printChecks([
        {
          level: entry.consistent ? 'ok' : 'warn',
          label: entry.generatedAt,
          detail: `${short(entry.statusHash)} · ${String(entry.bytes)} bytes`,
        },
      ]);
    }
    for (const bad of history.unreadable) {
      printChecks([{ level: 'warn', label: 'unreadable', detail: `${bad.path}: ${bad.reason}` }]);
    }
    return 0;
  });
}

function commandStatusRetain(): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const { snapshot } = projectCurrentStatus(runtime, new Date().toISOString());
    const retained = retainStatus(runtime.workspaceRoot, snapshot);
    const receipt = pruneStatusHistory(runtime.workspaceRoot, {
      keep: STATUS_HISTORY_KEEP,
      protect: [retained.statusHash],
    });
    printChecks([
      { level: 'ok', label: 'retained', detail: retained.path },
      { level: 'ok', label: 'status hash', detail: short(retained.statusHash) },
      ...(receipt.removed.length > 0
        ? [{ level: 'info' as const, label: 'retention', detail: `${String(receipt.removed.length)} older snapshot(s) removed` }]
        : []),
    ]);
    return 0;
  });
}

/**
 * Wraps a command body so a thrown runtime error becomes an exit code and a message rather
 * than a stack trace. Mirrors `runGuarded` in `index.ts`; the two converge when the last
 * domain is extracted and the wrapper moves to the shared surface.
 */
function guarded(work: () => number): number {
  try {
    return work();
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Registers the `status` command group. */
export function registerStatusCommands(program: Command): void {
  const status = program
    .command('status')
    .description(`the sealed CLU-E Status snapshot (Status Contract v${STATUS_SCHEMA_VERSION})`);

  status
    .command('show')
    .description('project and display the current sealed status')
    .option('--json', 'emit the complete validated snapshot instead of a summary', false)
    .action((options: { json: boolean }) => {
      process.exitCode = guarded(() => commandStatusShow(options.json));
    });

  status
    .command('export <path>')
    .description('write the sealed status snapshot to a file, atomically')
    .action((path: string) => {
      process.exitCode = guarded(() => commandStatusExport(path));
    });

  status
    .command('validate <path>')
    .description('verify an exported snapshot on its own; exit 1 when the seal is invalid')
    .action((path: string) => {
      process.exitCode = guarded(() => commandStatusValidate(path));
    });

  status
    .command('diff <left> <right>')
    .description('compare two exported snapshots branch by branch')
    .action((left: string, right: string) => {
      process.exitCode = guarded(() => commandStatusDiff(left, right));
    });

  status
    .command('report [path]')
    .description(`generate the Markdown status document (default: ${STATUS_REPORT_DEFAULT})`)
    .action((path: string | undefined) => {
      process.exitCode = guarded(() => commandStatusReport(path));
    });

  status
    .command('history')
    .description('list the sealed snapshots retained in the workspace')
    .action(() => {
      process.exitCode = guarded(commandStatusHistory);
    });

  status
    .command('retain')
    .description('project a snapshot into workspace/status/ and apply retention')
    .action(() => {
      process.exitCode = guarded(commandStatusRetain);
    });
}
