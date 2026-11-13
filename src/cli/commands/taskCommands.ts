/**
 * CLUE `task` commands.
 *
 * Spec: `CLUE_Architecture_v9.md` — the durable, dependency-aware work queue; a task packet
 *       is exported, run in a session, and imported back as a validated result.
 *       `CLUE_Project_Directory_v9.md` §7 — the CLI is a thin transport over application
 *       services: argument handling, one service call, and printing.
 *
 * Backlog: DEV-P1-07 — decomposing `src/cli/index.ts`. Second domain extracted.
 *          DEV-P1-38 — `task list` and `task show` took the writer lock to read.
 *
 * These six commands are the Creator-as-transport loop the CLI exists to make possible:
 *
 *     clue task from-candidate   turn a ranked candidate into durable work
 *     clue task export           a portable packet to run in a session
 *     clue task import           validated, integrated, or refused with a reason
 *
 * ## DEV-P1-38 — two of the six are readers, and now attach as readers
 *
 * `task list` and `task show` are declared `mutates: false`, write nothing, and used to open
 * `withRuntime({ withLog: true })` — taking the **single-writer event-log lock** to print a
 * queue. The other four genuinely write and keep the writer, correctly.
 *
 * This module is why the pair survived six rounds of the same fix.
 * `cli-attachment-conformance.test.ts` checks domains whose commands are *all* declared
 * read-only; `task` is mixed, so a reader inside it is outside the rule and stayed invisible
 * while `graph`, `claims`, `conflicts`, `seeds`, `mission` and `candidates` were corrected one
 * by one. They were found by `tools/decision-probe.mjs`, which compares every declaration
 * against its call site rather than only the ones a rule can reach — the same widening that
 * turned up the mission-gate rows.
 *
 * It also could not be fixed when it was found. `requireQueue()` would have thrown on every
 * invocation: `TaskQueue` was built only on the writable branch of `openRuntime`, so the lock
 * was the sole route to this command's own data. `runtime.ts` revision 10 merged the two
 * branches — after the same omission had recurred four times — and this is the first change to
 * depend on that.
 *
 * The four writers are unchanged, including their `requireMission: true`. Exporting a packet or
 * importing a result is evidence production, and evidence is attributable to a mission or it is
 * not evidence.
 */

import type { Command } from 'commander';

import { withRuntime, type Runtime } from '../../control/runtime.js';
import { runTaskGatewayCheck } from '../../control/taskGatewayBridge.js';
import { z } from 'zod';
import type { TaskLane, TaskState } from '../../control/tasks.js';
import { printChecks, SYMBOL, short, truncate, write } from '../output/formatter.js';
import { guarded as guardedWith, latestSnapshot } from './shared.js';

const MANUAL_WORKER = 'creator-manual';
/** A manual packet is worked on at human pace, not machine pace. */
const MANUAL_LEASE_MS = 6 * 60 * 60 * 1000;

/* ------------------------------------------------------------------------- */
/* Output schemas                                                             */
/* ------------------------------------------------------------------------- */
/* Registered here so the manual packet loop works today. These move to their own module
 * when the gateway lands and the worker roles multiply; the registry is the durable
 * thing, this list is not. */

const findingReportSchema = z
  .object({
    summary: z.string().min(1),
    findings: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            anchor: z.string().min(1),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const patchDesignSchema = z
  .object({
    hypothesis: z.string().min(1),
    falsifier: z.string().min(1),
    changed_files: z.array(z.string().min(1)).min(1),
    diff: z.string().min(1),
    guardrails: z.array(z.string().min(1)).min(1),
    risks: z.array(z.string()),
  })
  .strict();

function registerOutputSchemas(runtime: Runtime): void {
  runtime.schemas.register(
    {
      name: 'analysis.finding',
      schema: findingReportSchema,
      example: {
        summary: 'what was examined and concluded',
        findings: [
          {
            statement: 'the buffer is reallocated every frame',
            anchor: 'src/render/frame.ts:41-58',
            confidence: 0.8,
          },
        ],
      },
      notes: [
        'Every finding must cite a path and line range, or the id of a record you were given.',
        'A finding you cannot anchor belongs in `limitations`, not in the list.',
      ],
    },
    ['CANDIDATE_REVIEW', 'METRIC_ANALYZE', 'UNIT_SUMMARIZE', 'DOC_EXTRACT'],
  );

  runtime.schemas.register(
    {
      name: 'patch.design',
      schema: patchDesignSchema,
      example: {
        hypothesis: 'hoisting the allocation out of the loop removes N-1 allocations per frame',
        falsifier: 'a valid run in which allocation count per frame is unchanged',
        changed_files: ['src/render/frame.ts'],
        diff: '--- a/src/render/frame.ts\n+++ b/src/render/frame.ts\n@@ ...',
        guardrails: ['typecheck remains clean', 'no new console error signatures'],
        risks: ['the buffer is shared if the caller reenters'],
      },
      notes: [
        'The diff must apply cleanly to the exact snapshot you were given.',
        'A hypothesis with no falsifier is not a hypothesis; state what observation would refute it.',
      ],
    },
    ['PATCH_DESIGN'],
  );
}

/** Local binding so the extracted bodies read exactly as they did in `index.ts`. */
const runGuarded = (work: () => number): number => guardedWith(work, write);

/* ------------------------------------------------------------------------- */
/* clue task                                                                  */
/* ------------------------------------------------------------------------- */

function commandTaskList(state?: string): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const queue = runtime.requireQueue();
    const tasks = queue.list({
      ...(state === undefined ? {} : { state: state as TaskState }),
      limit: 40,
    });

    if (tasks.length === 0) {
      write('No tasks.');
      return 0;
    }

    for (const task of tasks) {
      write(
        `${task.id}  ${task.state.padEnd(10)} ${task.lane.padEnd(13)} ${task.type.padEnd(18)} ` +
          `attempts ${task.attempts}/${task.max_attempts}  ${task.subject_id ?? ''}`,
      );
    }
    write('');
    const stats = queue.stats();
    write(
      `spent ${stats.totalSpent.toFixed(4)} · oldest pending ${stats.oldestPendingAgeSeconds ?? 0}s`,
    );
    return 0;
  });
}

function commandTaskShow(taskId: string): number {
  return withRuntime({ withLog: false }, (runtime) => {
    const queue = runtime.requireQueue();
    const task = queue.get(taskId);
    if (task === null) {
      write(`Unknown task ${taskId}.`);
      return 1;
    }

    write(`${task.id}  ${task.type}`);
    write('');
    write(`  state       ${task.state}${task.terminal_reason === null ? '' : ` — ${task.terminal_reason}`}`);
    write(`  lane        ${task.lane} (priority ${task.priority})`);
    write(`  subject     ${task.subject_id ?? 'none'}`);
    write(`  snapshot    ${task.snapshot_id === null ? 'none' : short(task.snapshot_id)}`);
    write(`  input       ${short(task.input_hash)}`);
    write(`  output      ${task.output_hash === null ? 'none' : short(task.output_hash)}`);
    write(`  budget      ${task.spent.toFixed(4)} of ${task.budget.toFixed(2)}`);
    write(
      `  lease       ${task.lease_owner ?? 'none'}` +
        `${task.lease_expires_at === null ? '' : ` until ${task.lease_expires_at}`}`,
    );

    const attempts = queue.attempts(taskId);
    if (attempts.length > 0) {
      write('');
      write('  attempts:');
      for (const attempt of attempts) {
        write(
          `    ${attempt.attempt}. ${attempt.worker} — ${attempt.outcome ?? 'in flight'}` +
            (attempt.detail === null ? '' : `: ${truncate(attempt.detail, 70)}`),
        );
      }
    }
    return 0;
  });
}

/**
 * Turns a ranked candidate into durable work.
 *
 * The bridge from Stage E to Stage D. The candidate itself becomes the task's input
 * artifact, so the packet a worker eventually receives carries the reasoning that
 * selected it rather than a bare identifier.
 */
function commandTaskFromCandidate(logicalId: string, snapshotOverride?: string): number {
  return withRuntime({ withLog: true, requireMission: true }, (runtime) => {
    const queue = runtime.requireQueue();
    const metrics = runtime.metrics;
    if (metrics === null) {
      write('Metric registry unavailable.');
      return 1;
    }

    const snapshotId = latestSnapshot(runtime, snapshotOverride);
    const candidate = metrics
      .candidates(snapshotId, { limit: 5000 })
      .find((entry) => entry.logicalId === logicalId);

    if (candidate === undefined) {
      write(`${logicalId} is not a ranked candidate in snapshot ${short(snapshotId)}.`);
      return 1;
    }
    if (candidate.kind === 'excluded') {
      write(`${logicalId} is excluded: ${candidate.exclusionReason ?? 'no reason recorded'}`);
      write('Excluded candidates are findings for the Creator, not work for CLUE.');
      return 1;
    }

    const type = candidate.kind === 'patch' ? 'PATCH_DESIGN' : 'CANDIDATE_REVIEW';
    const lane: TaskLane = candidate.kind === 'patch' ? 'patch_design' : 'analysis';

    const input = runtime.artifacts.putJson(
      { candidate, snapshotId, generatedAt: new Date().toISOString() },
      { label: `${logicalId}-candidate.json` },
    );

    const task = queue.create({
      type,
      lane,
      priority: Math.min(1, candidate.priority * 10),
      inputHash: input.hash,
      subjectId: logicalId,
      snapshotId,
    });

    printChecks([
      { level: 'ok', label: 'task', detail: `${task.id} (${task.state})` },
      { level: 'info', label: 'type', detail: `${type} in lane ${lane}` },
      { level: 'info', label: 'input', detail: short(input.hash) },
    ]);
    write('');
    write(`Next: clue task export ${task.id} --to <folder>`);
    return 0;
  });
}

/**
 * Writes a portable packet and takes the task's lease.
 *
 * The lease is the point: a result can only be imported by the worker that holds one,
 * so exporting and importing are two halves of the same attempt. Re-exporting renews
 * rather than re-attempts, because looking at a packet twice is not two tries at the
 * work.
 */
function commandTaskExport(taskId: string, destination: string): number {
  return withRuntime({ withLog: true, requireMission: true }, (runtime) => {
    const queue = runtime.requireQueue();
    const packets = runtime.packets;
    const builder = runtime.contextBuilder;
    if (packets === null || builder === null) {
      write('Packet service or context builder unavailable.');
      return 1;
    }
    registerOutputSchemas(runtime);

    const existing = queue.get(taskId);
    if (existing === null) {
      write(`Unknown task ${taskId}.`);
      return 1;
    }

    const claim = queue.claimById(taskId, MANUAL_WORKER, { leaseMs: MANUAL_LEASE_MS });
    if (claim === null) {
      write(`Task ${taskId} is ${existing.state} and cannot be leased by ${MANUAL_WORKER}.`);
      if (existing.lease_owner !== null) {
        write(`  currently held by ${existing.lease_owner} until ${existing.lease_expires_at ?? 'unknown'}`);
      }
      return 1;
    }

    const schema = runtime.schemas.forTaskType(claim.task.type);
    if (schema === null) {
      write(`No output schema registered for task type "${claim.task.type}".`);
      return 1;
    }

    const built = builder.build(claim.task, {
      directive:
        `Examine ${claim.task.subject_id ?? 'the subject'} and respond under the schema below. ` +
        'Cite an anchor for every claim; state anything you could not determine.',
      outputSchemaName: schema.name,
      outputNotes: schema.notes,
      subjectUnitId: claim.task.subject_id,
      snapshotId: claim.task.snapshot_id,
    });

    if (!built.fits) {
      write('The essential context does not fit the budget. This task must be split.');
      write('');
      write(built.decomposition?.reason ?? 'no reason recorded');
      for (const subtask of built.decomposition?.subtasks ?? []) write(`  ${subtask.label}`);
      // The lease is returned rather than held, and no failure is recorded: nothing was
      // tried, so nothing should count against the task's attempts.
      queue.abandon(taskId, MANUAL_WORKER, claim.leaseToken, 'context did not fit; task needs decomposition');
      return 1;
    }

    const exported = packets.export(claim.task, built.sections, destination, claim.leaseToken);

    printChecks([
      { level: 'ok', label: 'packet', detail: exported.directory },
      { level: 'ok', label: 'hash', detail: short(exported.manifest.packet_hash) },
      { level: 'info', label: 'sections', detail: String(exported.manifest.section_count) },
      {
        level: 'info',
        label: 'context',
        detail: `~${exported.manifest.estimated_tokens} of ${exported.manifest.token_budget} tokens`,
      },
      {
        level: 'info',
        label: 'lease',
        detail:
          `${MANUAL_WORKER} until ${claim.leaseExpiresAt}` +
          `${claim.renewed ? ' (renewed — attempt unchanged)' : ` (attempt ${claim.attempt})`}`,
      },
    ]);

    for (const dropped of built.dropped) {
      write(
        `${SYMBOL.info} ${'enrichment omitted'.padEnd(34)} ${dropped.kind} (${dropped.estimatedTokens} tokens)`,
      );
    }
    for (const unavailable of built.unavailable) {
      write(
        `${SYMBOL.warn} ${'section unavailable'.padEnd(34)} ${unavailable.kind}: ${unavailable.reason}`,
      );
    }

    write('');
    write('Run the packet, then: clue task import <result folder>');
    return 0;
  });
}

function commandTaskImport(directory: string): number {
  return withRuntime({ withLog: true, requireMission: true }, (runtime) => {
    const packets = runtime.packets;
    if (packets === null) {
      write('Packet service unavailable.');
      return 1;
    }
    registerOutputSchemas(runtime);

    const report = packets.import(directory);

    printChecks([
      {
        level: report.outcome === 'accepted' ? 'ok' : report.outcome === 'conflicted' ? 'warn' : 'fail',
        label: 'outcome',
        detail: report.outcome,
      },
      { level: 'info', label: 'task', detail: report.taskId },
      ...(report.reason === null
        ? []
        : [{ level: 'fail' as const, label: 'reason', detail: report.reason }]),
      { level: 'info', label: 'detail', detail: report.detail },
      ...(report.outputHash === null
        ? []
        : [{ level: 'info' as const, label: 'output', detail: short(report.outputHash) }]),
    ]);

    if (report.outcome === 'conflicted') {
      write('');
      write('Both results are kept. A disagreement between workers is work, not an error.');
    }
    return report.outcome === 'rejected' ? 1 : 0;
  });
}

function commandTaskAbandon(taskId: string, reason: string): number {
  return withRuntime({ withLog: true, requireMission: true }, (runtime) => {
    const queue = runtime.requireQueue();
    const task = queue.release(taskId, reason);
    write(`${task.id} released — state ${task.state}, attempts unchanged at ${task.attempts}.`);
    return 0;
  });
}


/** Registers the `task` command group. */
export function registerTaskCommands(program: Command): void {
  const task = program.command('task').description('durable work');
  task
    .command('gateway-check')
    .description('run one fixed, profile-bound task through the live Model Gateway')
    .action(async () => {
      const result = await runTaskGatewayCheck();
      write(JSON.stringify(result));
      process.exitCode = result.state === 'COMPLETED' || result.state === 'ALREADY_COMPLETED' ? 0 : 1;
    });
  task
    .command('list')
    .description('list tasks')
    .option('--state <state>', 'pending | blocked | leased | completed | failed | dead | cancelled')
    .action((options: { state?: string }) => {
      process.exitCode = runGuarded(() => commandTaskList(options.state));
    });
  task
    .command('show <taskId>')
    .description('show a task and its attempt history')
    .action((taskId: string) => {
      process.exitCode = runGuarded(() => commandTaskShow(taskId));
    });
  task
    .command('from-candidate <logicalId>')
    .description('turn a ranked candidate into a durable task')
    .option('--snapshot <id>', 'snapshot to read; defaults to the latest')
    .action((logicalId: string, options: { snapshot?: string }) => {
      process.exitCode = runGuarded(() => commandTaskFromCandidate(logicalId, options.snapshot));
    });
  task
    .command('export <taskId>')
    .description('write a portable session packet and take its lease')
    .requiredOption('--to <folder>', 'destination folder')
    .action((taskId: string, options: { to: string }) => {
      process.exitCode = runGuarded(() => commandTaskExport(taskId, options.to));
    });
  task
    .command('import <folder>')
    .description('validate and integrate a result folder')
    .action((folder: string) => {
      process.exitCode = runGuarded(() => commandTaskImport(folder));
    });
  task
    .command('abandon <taskId>')
    .description('release a lease without recording a failure')
    .option('--reason <reason>', 'why', 'released by the Creator')
    .action((taskId: string, options: { reason: string }) => {
      process.exitCode = runGuarded(() => commandTaskAbandon(taskId, options.reason));
    });
}
