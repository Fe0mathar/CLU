/**
 * CLUE CLI command authority.
 *
 * Spec: CLUE_Architecture_v9 (capability-bounded authority; the CLI is a veneer over services);
 *       CLUE_Constitution_v9 (one write authority; mission governs what may run).
 * Backlog: DEV-P1-07 — a closed command-authority registry with read-only and mission defaults.
 *
 * Every CLI command is a named member of a fixed set, declared here rather than inferred from the
 * command tree. The closed set is the point: a command that is not declared has no authority, so
 * adding one to `buildProgram` without deciding what it may do fails loudly instead of inheriting
 * whatever the surrounding code happened to allow.
 *
 * Two defaults carry most of the weight.
 *
 * **Read-only unless declared otherwise.** `mutates` is an explicit property, not a guess made from
 * a verb in the command name. A reader that is quietly treated as a writer is how a "just looking"
 * command ends up holding the event-log writer lock and locking out the daemon.
 *
 * **Mission required unless declared otherwise.** Almost everything CLUE does is only meaningful
 * relative to a registered mission — a measurement with no mission is a number with nothing to hold
 * it to. The exceptions are the commands that exist precisely because there is no mission yet, or
 * that inspect the installation rather than the work: `init`, `doctor`, `docs`.
 *
 * This module deliberately holds no logic beyond the table and its lookups. It is imported by the
 * CLI and by its tests, and it must stay readable as a list.
 */

import type { Capability } from '../control/policy.js';

/** What a command is allowed to do. */
export interface CommandAuthority {
  /** Full command path as the user types it, e.g. `task export`. */
  readonly command: string;
  /**
   * The single capability the command exercises, or null when it touches no governed resource
   * (help-style commands that only read local configuration).
   */
  readonly capability: Capability | null;
  /** True when the command writes durable state and therefore needs the event-log writer lock. */
  readonly mutates: boolean;
  /** False only for commands that must run before, or independently of, a registered mission. */
  readonly requiresMission: boolean;
  /** Why this authority is what it is — kept short, and read by humans reviewing the table. */
  readonly rationale: string;
}

/**
 * The closed set. Order is the order a reader meets these commands in the workflow, not alphabetical,
 * because the sequence is itself documentation of how CLUE is driven.
 */
export const COMMAND_AUTHORITIES: readonly CommandAuthority[] = [
  {
    command: 'project list',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'lists installation-level Project Profile metadata before any target runtime is opened',
  },
  {
    command: 'project active',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'reads the registry pointer and Configuration-v3 selector without changing either',
  },
  {
    command: 'project show',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'reads one sanitized durable Project Profile record',
  },
  {
    command: 'project create',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'creates installation control-plane state before a mission or project runtime exists',
  },
  {
    command: 'project update',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'writes one optimistic-concurrency Project Profile successor generation',
  },
  {
    command: 'project delete',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'deletes profile registration only after a state-bound confirmation; never target/state trees',
  },
  {
    command: 'project validate',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'validates profile, authority, benchmark, recognition and Git identity without durable writes',
  },
  {
    command: 'project init',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'initializes one explicitly confirmed native workspace under its exact saved profile generation',
  },
  {
    command: 'project readiness',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'projects operation-specific readiness for one explicit profile generation',
  },
  {
    command: 'project preflight',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'inspects the exact active startup profile and local Windows proof prerequisites, emitting JSON to stdout',
  },
  {
    command: 'project test-host',
    capability: 'process.run.host',
    mutates: false,
    requiresMission: false,
    rationale: 'launches the restricted host only to verify exact roots and Project Profile identity',
  },
  {
    command: 'project test-git',
    capability: 'git.read.canonical',
    mutates: false,
    requiresMission: false,
    rationale: 'reads local Git identity/state and never synchronizes a remote',
  },
  {
    command: 'project browser-run',
    capability: 'browser.control',
    mutates: true,
    requiresMission: true,
    rationale: 'executes one explicitly pinned browser scenario in the active managed Chrome and records its evidence',
  },
  {
    command: 'project test-chrome',
    capability: 'browser.control',
    mutates: false,
    requiresMission: false,
    rationale: 'attaches only to the configured debug endpoint and probes one governed page target',
  },
  {
    command: 'project test-gpt',
    capability: 'model.call',
    mutates: false,
    requiresMission: false,
    rationale: 'performs a no-token exact-model provider readiness probe and exposes no credential bytes',
  },
  {
    command: 'project activate',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'writes the registry active pointer for one exact confirmed profile generation',
  },
  {
    command: 'project migrate-legacy',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'explicitly creates one Project Profile from the governed configuration-v2 target',
  },
  {
    command: 'project adopt-legacy',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'writes only a workspace ownership receipt while preserving projection/event history',
  },
  {
    command: 'project prepare-dashboard',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'prepares the explicitly confirmed active profile workspace and publishes its verified startup selector',
  },
  {
    command: 'project cutover-v3',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'backs up configuration-v2 and enables explicit profile-bound startup',
  },
  {
    command: 'project rollback-v3',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'removes only the v3 startup selector and preserves all profile/state/history data',
  },
  {
    command: 'landing preview',
    capability: 'git.read.canonical',
    mutates: false,
    requiresMission: true,
    rationale: 'reviews a current proof verdict and its exact local Git base without preparing objects',
  },
  {
    command: 'landing apply',
    capability: 'git.land.canonical',
    mutates: true,
    requiresMission: true,
    rationale: 'invokes the Custodian for one explicitly confirmed local accepted branch and records verification',
  },
  {
    command: 'landing rollback',
    capability: 'git.land.canonical',
    mutates: true,
    requiresMission: true,
    rationale: 'uses the exact prebuilt rollback for the reviewed local accepted branch',
  },
  {
    command: 'status show',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale:
      'projects the sealed Status body; read-only, and must remain runnable before a mission ' +
      'is registered so an unbootstrapped installation can still be inspected',
  },
  {
    command: 'status export',
    capability: 'fs.write.workspace',
    mutates: false,
    requiresMission: false,
    rationale:
      'writes a sealed Status snapshot to a file the operator names; it records nothing durable ' +
      'in the workspace and therefore needs no writer lock',
  },
  {
    command: 'status report',
    capability: 'fs.write.workspace',
    mutates: false,
    requiresMission: false,
    rationale:
      'DEV-P1-25: renders the sealed Status body as Markdown to a path the operator names, ' +
      'defaulting to clue-status.md. Same shape as `status export` — a projection written to a ' +
      'file, recording nothing durable, so no writer lock. It must run before a mission is ' +
      'registered for the same reason `status show` must: an unbootstrapped installation is ' +
      'exactly when someone wants to read its status',
  },
  {
    command: 'status validate',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'verifies an exported snapshot on its own; reads a file the operator names',
  },
  {
    command: 'status diff',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'compares two exported snapshots; reads two files the operator names',
  },
  {
    command: 'status history',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'lists the sealed snapshots retained in the workspace',
  },
  {
    command: 'status retain',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'writes a sealed snapshot into workspace/status/ and applies retention',
  },
  {
    command: 'gateway status',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale:
      'reads governed routing/budget identities and the rebuildable gateway_calls projection; ' +
      'it must remain usable while the gateway is deliberately disabled',
  },
  {
    command: 'gateway invoke',
    capability: 'model.call',
    mutates: true,
    requiresMission: true,
    rationale:
      'DEV-P2-09: validates mission, route and budget, records a call boundary, performs provider ' +
      'I/O without the writer lock, then records the exact receipt or refusal',
  },
  {
    command: 'gateway reconcile',
    capability: 'model.call',
    mutates: true,
    requiresMission: true,
    rationale:
      'DEV-P2-09: polls one already-recorded batch and appends only its provider receipt or ' +
      'terminal accounting result; no silent resubmission',
  },
  {
    command: 'gateway resume',
    capability: 'model.call',
    mutates: true,
    requiresMission: true,
    rationale:
      'P2 final activation: performs a no-token model probe, then appends one provider-resumed ' +
      'authority event; it never clears a budget pause by narrative or local timer',
  },
  {
    command: 'console status',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads operational console state',
  },
  {
    command: 'console capture',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'records a console capture as durable evidence',
  },
  {
    command: 'console clean',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'removes console working state',
  },
  {
    command: 'console signatures',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads recorded console signatures',
  },
  {
    command: 'console show',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads one console exchange',
  },
  {
    command: 'console classify',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'records a classification decision',
  },
  {
    command: 'console ui',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'renders console state for the UI',
  },
  {
    command: 'console export-ui-state',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'writes a UI state export to disk',
  },
  {
    command: 'console dashboard',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'serves the read-only console dashboard',
  },
  {
    command: 'console serve',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'serves a read-only view and must never take the writer lock',
  },
  {
    command: 'init',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: false,
    rationale: 'registers the first mission; requiring one would make it unreachable',
  },
  {
    command: 'doctor',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'diagnoses an installation that may have no mission yet',
  },
  {
    command: 'docs ingest',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'registers documents and claims as durable evidence',
  },
  {
    command: 'docs ratify',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      "DEV-P2-05: records the Creator's ratification of the installed documentation pack as a " +
      'durable authority event; interactive-only by design (no --yes), and the service refuses ' +
      'a pack that does not verify against its seal',
  },
  {
    command: 'epoch seal',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      "ADR-0006: records the Creator's evidence-epoch boundary as a durable authority event; " +
      'interactive-only by design (no --yes), and the service refuses an unratified, moved-on, ' +
      'or unverifiable state',
  },
  {
    command: 'cycle status',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale:
      'DEV-P2-08 S5: reads the stage machine\'s current row; a pure read that emits nothing, ' +
      'exempt like status/doctor so a drifted basis can still be inspected',
  },
  {
    command: 'cycle drive',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      'Advances the cycle through lock, opening evidence, recognition and screening. The optional ' +
      'findings assessment records the evidence-bound decision for the same screened cycle.',
  },
  {
    command: 'cycle suspend',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'DEV-P2-08 S5: records the operator\'s suspension with its reason (§21.1)',
  },
  {
    command: 'cycle resume',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      'DEV-P2-08 S5: returns a suspended cycle to the stage it remembers, after the resume ' +
      "planner's §21.2 verification — mission, lock, projections, log, artifacts — whose " +
      'receipt the resumed event carries; a failing verification refuses the resume',
  },
  {
    command: 'cycle close',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      'DEV-P2-08 closure tail: walks SCREENED → CLOSED with the §18 absence stated in the ' +
      'closing evidence, §19 as a truthful minimal handoff, and §24 derived from the cycle\'s ' +
      'own lock — a diagnostic ending recorded, never implied',
  },
  {
    command: 'cycle restart',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      'Execution Model §21.3: explicitly replace a screened diagnostic cycle under a ' +
      'superseded mission with a fresh identity, preserving the predecessor and its lock',
  },
  {
    command: 'cycle supersede',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'Execution Model §21.3: require exact Creator authorization to replace an unaccepted ' +
      'proof-authoritative cycle after its measured target inputs change',
  },
  {
    command: 'benchmark run',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      'DEV-P2-07 B4: executes the Master Benchmark contract (ADR-0010) and records the run as ' +
      'one durable event with the full result artifact. The run itself happens UNLOCKED — the ' +
      'harness drives clue as child processes and they take the writer lock per act — and only ' +
      'the short record phase mutates under this declaration; the §18 closing step shares the ' +
      'same seam (src/control/benchmarkRun.ts) so the cycle cannot fork the proven path',
  },
  {
    command: 'benchmark rebuild-projections',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'compares current status facts with a full event replay into a disposable projection database',
  },
  {
    command: 'benchmark verify-chain',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: false,
    rationale: 'verifies every committed workspace event without opening a writer or reading gateway credentials',
  },
  {
    command: 'proof',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale:
      'DEV-P2-11 Stage H: freezes the contract, binds the reusable baseline, executes one ' +
      'isolated candidate and records either the durable refusal or deterministic verdict. ' +
      'The writer lock is held for the complete proof arm. Tree-relative instruments run ' +
      'normally; a CLU-E self-target is measured through shadow-only config/workspace ' +
      'relocation so child clue processes use a distinct writer authority',
  },
  {
    command: 'snapshot',
    capability: 'fs.read.canonical',
    mutates: true,
    requiresMission: true,
    rationale: 'reads the canonical tree and records an immutable capture',
  },
  {
    command: 'recognize',
    capability: 'fs.read.canonical',
    mutates: true,
    requiresMission: true,
    rationale: 'recognises a snapshot and records the run',
  },
  {
    command: 'graph',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads the recognised graph projection',
  },
  {
    command: 'metrics',
    capability: 'fs.read.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'computes and records a metric set',
  },
  {
    command: 'candidates',
    capability: 'fs.read.workspace',
    // DEV-P1-37: declared `mutates: true` until now, and the rationale it carried — "ranks
    // candidates and records the ranking with its weights" — describes `metrics`, which is where
    // both writes actually happen. `commandCandidates` is a single bounded SELECT over
    // `ranked_candidates`.
    //
    // Over-restrictive rather than unsafe, so nothing was ever exposed by it. What it cost was
    // this table's trustworthiness, which is the only property it has: a reader who checks one
    // entry against its command and finds it wrong has no reason to believe the other thirty-five.
    //
    // Corrected after the attachment, not before. While `candidatesCommands.ts` still opened
    // `withLog: true`, a `mutates: false` here would have described a command that takes the
    // single-writer lock — trading a false statement for a different false statement.
    mutates: false,
    requiresMission: true,
    rationale: 'reads the ranking `clue metrics` recorded; writes nothing',
  },
  {
    command: 'task list',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads the queue projection',
  },
  {
    command: 'task show',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads one task and its attempt history',
  },
  {
    command: 'task from-candidate',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'creates a task from a ranked candidate',
  },
  {
    command: 'findings plan',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'records one evidence-bound findings assessment for a current screened profile cycle',
  },
  {
    command: 'task gateway-check',
    capability: 'model.call',
    mutates: true,
    requiresMission: true,
    rationale: 'leases a fixed Project Profile task, calls the governed gateway, and imports its validated result',
  },
  {
    command: 'task export',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'claims a lease and writes a packet folder',
  },
  {
    command: 'task import',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'accepts or rejects a result and records the outcome',
  },
  {
    command: 'task abandon',
    capability: 'fs.write.workspace',
    mutates: true,
    requiresMission: true,
    rationale: 'releases a lease and records the attempt outcome',
  },
  {
    command: 'claims',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads the claim projection',
  },
  {
    command: 'conflicts',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads preserved conflicts; resolving one is a separate authority',
  },
  {
    command: 'seeds',
    capability: 'fs.read.workspace',
    mutates: false,
    requiresMission: true,
    rationale: 'reads generated test seeds',
  },
  {
    command: 'audit tail',
    capability: 'fs.read.workspace',
    mutates: false,
    // DEV-P1-43: exempt. The audit log is what an operator reads when something is already
    // wrong, and "something is already wrong" includes "no mission was ever registered".
    // Requiring one would withdraw the diagnostic at the moment it is wanted.
    requiresMission: false,
    rationale: 'reads recent audit entries; diagnostics must work before a mission exists',
  },
  {
    command: 'audit denials',
    capability: 'fs.read.workspace',
    mutates: false,
    // DEV-P1-43: exempt, same argument as `audit tail`. A refused operation is the authority
    // model working; being unable to see refusals while unmissioned hides the one record that
    // explains why nothing is running.
    requiresMission: false,
    rationale: 'reads refused operations; diagnostics must work before a mission exists',
  },
  {
    command: 'mission',
    capability: 'fs.read.workspace',
    mutates: false,
    // DEV-P1-43: exempt, and this one was circular rather than merely unhelpful. The command
    // exists to report which mission is in force. Requiring a mission to run it means that on
    // the one workspace where the answer matters most — none registered — it refuses instead of
    // answering. Its own body already handles the empty case with `No mission registered. Run
    // \`clue init\`.`, which was written for a state the declaration claimed was unreachable.
    requiresMission: false,
    rationale: 'reads mission history, including the fact that there is none; registering one is `init`',
  },
];

const byCommand = new Map(COMMAND_AUTHORITIES.map((entry) => [entry.command, entry]));

/** An authority was requested for a command that the closed set does not declare. */
export class UnknownCommandAuthorityError extends Error {
  public readonly command: string;

  public constructor(command: string) {
    super(
      `Command "${command}" has no declared authority. Add it to COMMAND_AUTHORITIES with an ` +
        'explicit capability, mutates flag and mission requirement.',
    );
    this.name = 'UnknownCommandAuthorityError';
    this.command = command;
  }
}

/** The authority for a command path, or null when it is not declared. */
export function authorityFor(command: string): CommandAuthority | null {
  return byCommand.get(command) ?? null;
}

/** The authority for a command path; throws when the command is outside the closed set. */
export function requireAuthority(command: string): CommandAuthority {
  const authority = authorityFor(command);
  if (authority === null) throw new UnknownCommandAuthorityError(command);
  return authority;
}

/**
 * Whether a command needs the event-log writer lock.
 *
 * Read-only is the default answer, and the table is the only place that can change it — which is
 * what keeps a reader from silently acquiring the lock and blocking the daemon.
 */
export function commandMutates(command: string): boolean {
  return requireAuthority(command).mutates;
}
