/**
 * DEV-P1-07 — the CLI's command-authority registry is closed and complete.
 *
 * The registry only means anything if it covers the command tree exactly: a command the program
 * declares but the table omits would fail at run time, and a table entry with no command is a stale
 * grant. Both directions are checked here against the real program.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Command } from 'commander';

import { buildProgram } from '../src/cli/index.js';
import {
  COMMAND_AUTHORITIES,
  UnknownCommandAuthorityError,
  authorityFor,
  commandMutates,
  requireAuthority,
} from '../src/cli/commandAuthority.js';

/** Every runnable command path in the program, e.g. `task export`. */
function commandPaths(command: Command, prefix: readonly string[] = []): string[] {
  const paths: string[] = [];
  for (const child of command.commands) {
    const path = [...prefix, child.name()];
    const grandchildren = commandPaths(child, path);
    // A pure group (e.g. `task`) is only a namespace when it has no action of its own; commander
    // still lists it, so treat a node with children as runnable only if the registry declares it.
    if (grandchildren.length === 0) paths.push(path.join(' '));
    else {
      if (authorityFor(path.join(' ')) !== null) paths.push(path.join(' '));
      paths.push(...grandchildren);
    }
  }
  return paths;
}

test('DEV-P1-07: every command the program declares has a declared authority', () => {
  const missing = commandPaths(buildProgram())
    .filter((path) => authorityFor(path) === null)
    .filter((path) => path !== 'help');
  assert.deepEqual(missing, [], `commands without declared authority: ${missing.join(', ')}`);
});

test('DEV-P1-07: the registry declares no command the program does not have', () => {
  const declared = new Set(commandPaths(buildProgram()));
  const stale = COMMAND_AUTHORITIES.map((entry) => entry.command).filter(
    (command) => !declared.has(command),
  );
  assert.deepEqual(stale, [], `authority declared for absent commands: ${stale.join(', ')}`);
});

test('DEV-P1-07: read-only and mission are the defaults, and the exceptions are deliberate', () => {
  // Only the commands that must run before a mission exists, or that inspect the installation,
  // are exempt from requiring one.
  //
  // DEV-P1-12 added `status show` and `status export` to this set deliberately. Status
  // Contract §1 makes the status a core method for making the system inspectable, and §18
  // requires unavailable data to become an explicit unknown rather than a refusal. An
  // installation with no registered mission is exactly when an operator most needs to see
  // the state, and the projector already renders that honestly: the `target` branch reports
  // unavailable with its reason, and every other branch still projects. A status command
  // that refused to run without a mission would be inspection that only works once nothing
  // needs inspecting.
  // DEV-P1-43 added `mission`, `audit tail` and `audit denials`, on the Creator's decision and
  // by the same argument. They were surfaced by `tools/decision-probe.mjs`, which listed the
  // eleven commands that would begin refusing on a mission-less workspace if this column were
  // enforced — the point of the exercise being that a declaration nothing reads is a declaration
  // nobody has had to defend.
  //
  // `mission` was circular rather than merely unhelpful: the command exists to report which
  // mission is in force, so requiring one meant that on the single workspace where the answer
  // matters most — none registered — it would refuse instead of answering. Its body already
  // handles that case, and had done so for a state the declaration claimed was unreachable.
  //
  // `audit tail` and `audit denials` are the diagnostics an operator reaches for when something
  // is already wrong, and "no mission was ever registered" is one of the things that can be
  // wrong. A refused operation is the authority model working; hiding that record while
  // unmissioned withdraws the only explanation of why nothing is running.
  //
  // The other eight commands on the probe's refusal list — `status history`, `status retain`,
  // `docs ingest`, `graph`, `candidates`, `claims`, `conflicts`, `seeds` — keep the requirement.
  // Each produces or consumes evidence, where attribution to a mission is the point rather than
  // an obstacle. That is a judgement rather than a measurement, and it is recorded here so the
  // next person to disagree has something to disagree with.
  //
  // DEV-P1-25 added `status report`, and it is the same command as `status export` in a
  // different serialisation: it projects the sealed body and writes it to a path the operator
  // names. Declaring it `true` while `export` is `false` would mean the JSON form of a status is
  // inspectable on an unmissioned workspace and the readable form is not, which is a distinction
  // with nothing behind it. The argument that it writes into the repository by default does not
  // separate them either — `export` writes wherever it is told, including there.
  const withoutMission = COMMAND_AUTHORITIES.filter((entry) => !entry.requiresMission).map(
    (entry) => entry.command,
  );
  assert.deepEqual(withoutMission.sort(), [
    'audit denials',
    'audit tail',
    // A corrupt or unbootstrapped log must remain inspectable before a mission can open.
    'benchmark verify-chain',
    // DEV-P2-08 S5 (2026-08-10, plan D4 accepted): `cycle status` is a pure read that emits
    // nothing, exempt like status/doctor so a drifted basis can still be inspected — and this
    // ledger refused it until the exemption was recorded here, which is the ledger working.
    'cycle status',
    'doctor',
    'gateway status',
    'init',
    'mission',
    // Batch 6 makes Project Profiles the installation-level control plane. These commands must
    // remain usable before a target mission exists: they create/select the target context within
    // which missions, recognition, proof and evidence will subsequently run. Their mutation and
    // capability declarations are still enforced independently by the closed authority registry.
    'project activate',
    'project active',
    'project adopt-legacy',
    'project create',
    'project cutover-v3',
    'project delete',
    'project init',
    'project list',
    'project migrate-legacy',
    'project preflight',
    'project prepare-dashboard',
    'project readiness',
    'project rollback-v3',
    'project show',
    'project test-chrome',
    'project test-git',
    'project test-gpt',
    'project test-host',
    'project update',
    'project validate',
    'status diff',
    'status export',
    'status report',
    'status show',
    'status validate',
  ]);
  // The enumeration is deliberate where ADR-0003 chose a rule, and the difference is the point:
  // a command module missing from `commands/` is an omission, but an exemption from the mission
  // gate is a decision. This list exists to make adding one impossible to do quietly — the three
  // above could not be declared without failing here first, which is exactly what happened.
  // `status history` and `status retain` DO require a mission, and the split is the point:
  // reading a file the operator hands you needs no mission, but reading or writing the
  // workspace's own retained history is work under a mission and is declared as such.

  // The pre-supersession inventory was majority read-only. Later explicit write
  // capabilities are checked individually here and still need a written rationale.
  const mutating = COMMAND_AUTHORITIES.filter((entry) => entry.mutates);
  assert.ok(mutating.length < COMMAND_AUTHORITIES.length, 'not every command mutates');
  const supersession = requireAuthority('cycle supersede');
  assert.equal(supersession.mutates, true);
  assert.equal(supersession.requiresMission, true);
  assert.equal(supersession.capability, 'fs.write.workspace');
  const gatewayCheck = requireAuthority('task gateway-check');
  assert.equal(gatewayCheck.mutates, true);
  assert.equal(gatewayCheck.requiresMission, true);
  assert.equal(gatewayCheck.capability, 'model.call');
  const findingsPlan = requireAuthority('findings plan');
  assert.equal(findingsPlan.mutates, true);
  assert.equal(findingsPlan.requiresMission, true);
  assert.equal(findingsPlan.capability, 'fs.write.workspace');
  const preSupersession = COMMAND_AUTHORITIES.filter((entry) => !entry.command.startsWith('landing ') &&
    !entry.command.startsWith('publication ') && entry !== supersession && entry !== gatewayCheck && entry !== findingsPlan);
  assert.ok(
    preSupersession.filter((entry) => !entry.mutates).length >= preSupersession.filter((entry) => entry.mutates).length,
    'read-only is at least as common as mutating in the pre-supersession command inventory',
  );
  for (const entry of mutating) {
    assert.ok(entry.rationale.trim().length > 0, `${entry.command} states why it mutates`);
    assert.notEqual(entry.capability, null, `${entry.command} names the capability it exercises`);
  }

  // The read-only serving commands must never be marked mutating: they must not take the lock.
  for (const command of ['benchmark verify-chain', 'console dashboard', 'console serve', 'console ui']) {
    assert.equal(commandMutates(command), false, `${command} must stay read-only`);
  }
});

test('P43: the CLI exposes a read-only landing preview and explicit Custodian mutations', () => {
  const landing = buildProgram().commands.find((command) => command.name() === 'landing');
  assert.ok(landing);
  assert.deepEqual(landing.commands.map((command) => command.name()), ['preview', 'apply', 'rollback']);
  for (const command of landing.commands) {
    const preview = command.name() === 'preview';
    const authority = requireAuthority(`landing ${command.name()}`);
    assert.equal(authority.requiresMission, true);
    assert.equal(authority.mutates, !preview);
    assert.equal(authority.capability, preview ? 'git.read.canonical' : 'git.land.canonical');
    assert.ok(command.options.some(({ long, mandatory }) => long === '--patch' && mandatory));
    assert.equal(command.options.some(({ long, mandatory }) => long === '--confirmation' && mandatory), !preview);
  }
});

test('P44: publication needs an accepted proof event and an explicit confirmation for the push', () => {
  const publication = buildProgram().commands.find((command) => command.name() === 'publication');
  assert.ok(publication);
  assert.deepEqual(publication.commands.map((command) => command.name()), ['preview', 'push']);
  for (const command of publication.commands) {
    const preview = command.name() === 'preview';
    const authority = requireAuthority(`publication ${command.name()}`);
    assert.equal(authority.requiresMission, true);
    assert.equal(authority.mutates, !preview);
    assert.equal(authority.capability, preview ? 'git.read.canonical' : 'git.push.accepted');
    assert.equal(command.registeredArguments.length, 1);
    assert.equal(command.registeredArguments[0]?.required, true);
    assert.equal(command.options.some(({ long, mandatory }) => long === '--confirmation' && mandatory), !preview);
  }
});

test('DEV-P2-07 B4: `benchmark run` is a declared mutating act under mission, lock inversion stated', () => {
  const entry = COMMAND_AUTHORITIES.find((candidate) => candidate.command === 'benchmark run');
  assert.ok(entry !== undefined, 'benchmark run must be a member of the closed set');
  if (entry === undefined) return;
  assert.equal(entry.capability, 'fs.write.workspace');
  assert.equal(entry.mutates, true, 'the durable effect is the recorded event');
  assert.equal(entry.requiresMission, true, 'a run is evidence, and evidence binds to a mission');
  // The one unusual thing about this command is choreography, not authority: the run executes
  // unlocked because its children take the writer lock themselves. That inversion must be
  // discoverable from the ledger alone, so the rationale is required to state it.
  assert.match(entry.rationale, /UNLOCKED/);
  assert.match(entry.rationale, /benchmarkRun\.ts/);
});

test('DEV-P1-07: an undeclared command has no authority and is refused', () => {
  assert.equal(authorityFor('not-a-command'), null);
  assert.throws(
    () => requireAuthority('not-a-command'),
    (error: unknown) => error instanceof UnknownCommandAuthorityError,
  );
});
