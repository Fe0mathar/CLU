/**
 * `src/cli/` layout conformance.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 rev 2 — `commands/` contains
 *       one module per command domain, named `<domain>Commands.ts` for the domain as the
 *       operator types it; `output/` holds presentation helpers; `index.ts` composes the
 *       program and owns nothing else.
 *
 * Backlog: DEV-P1-07.
 *
 * ## Why this test is the argument for the amendment
 *
 * §7 previously enumerated eight command files. Four named commands that did not exist, and
 * twelve domains that did exist were unnamed. An enumeration can only be checked against
 * itself: nothing can tell you a list is wrong, only that a file is missing from it.
 *
 * A rule can be checked against reality. The closed authority registry already knows every
 * command the program declares, so "one module per domain" is a comparison between two things
 * the build actually has. That is the whole case for preferring a rule, and this file is it —
 * the amendment is only worth making if it buys a check, and here is the check.
 *
 * ## Why the suffix, and why this test had to change with it
 *
 * ADR-0003 rev 1 said the module is named for the domain exactly: `commands/graph.ts`. Four
 * of those names collided with the domain module they call — `commands/graph.ts` against
 * `analysis/source/graph.ts`, and the same for `snapshot`, `mission` and `audit`. A reader
 * with two tabs open could not tell which was which, and neither could a stack trace.
 *
 * The suffix removes all four collisions, matches the prior art the tree already had
 * (`consoleCommands.ts`), and aligns the file name with the export it contains
 * (`registerGraphCommands`). The rule is unchanged in substance: one module per domain, its
 * name derived mechanically from the domain. Only the derivation gained four characters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMAND_AUTHORITIES } from '../src/cli/commandAuthority.js';

/**
 * Locates the *authored* `src/cli/` from the compiled test.
 *
 * The obvious walk-up finds `dist/src/cli` first, which contains `index.js` and no `.ts` at
 * all — so the check would read the build output and report every domain missing. The
 * presence of `index.ts` is what distinguishes the source tree from its compilation.
 */
function cliDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'src', 'cli');
    if (existsSync(join(candidate, 'index.ts'))) return candidate;
    directory = dirname(directory);
  }
  throw new Error('the authored src/cli could not be located from the test');
}

/** Every command domain the closed registry declares: the first word of each command path. */
function declaredDomains(): readonly string[] {
  return [...new Set(COMMAND_AUTHORITIES.map((entry) => entry.command.split(' ')[0] ?? ''))].sort();
}

/**
 * Domains whose commands are registered from a module outside `commands/`.
 *
 * `console` is the one, and it is an accepted exception rather than an oversight:
 * `consoleCommands.ts` and `operationalConsoleCommands.ts` predate the decomposition and were
 * already coherent modules of their own. This test names the debt rather than hiding it — an
 * exception that has to be written down is one someone will eventually pay off.
 *
 * ADR-0003 rev 2 narrowed the debt without closing it. `consoleCommands.ts` is now *named*
 * conformantly — the suffix rule was taken from it — so only its location diverges. It was
 * left where it is deliberately: `operationalConsoleCommands.ts` attaches `console ui` and
 * `console export-ui-state` to the group `consoleCommands.ts` owns, so it is a helper of the
 * console module rather than a domain module. Moving the pair inward would trade this named
 * exception for a new one in `SHARED_MODULES`, which is not progress.
 */
const KNOWN_OUTSIDE_COMMANDS = ['console'];

/** Modules under `commands/` that implement no domain. */
const SHARED_MODULES = ['shared.ts'];

test('DEV-P1-07: every command domain has a module named for it', () => {
  const commands = join(cliDirectory(), 'commands');
  const present = new Set(readdirSync(commands).filter((name) => name.endsWith('.ts')));

  const missing = declaredDomains()
    .filter((domain) => !KNOWN_OUTSIDE_COMMANDS.includes(domain))
    .filter((domain) => !present.has(`${domain}Commands.ts`));

  assert.deepEqual(
    missing,
    [],
    `domains with no module in commands/: ${missing.join(', ')}. ` +
      'ADR-0003: one module per domain, named `<domain>Commands.ts`.',
  );
});

test('DEV-P1-07: every module under commands/ corresponds to a domain or is a shared helper', () => {
  // The other direction, and the one an enumeration could never give: a module that names no
  // domain is either a stale leftover from a renamed command or a file that should not be
  // there. Both are worth catching.
  const commands = join(cliDirectory(), 'commands');
  const domains = new Set(declaredDomains());

  const orphans = readdirSync(commands)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !SHARED_MODULES.includes(name))
    .filter((name) => !domains.has(name.replace(/Commands\.ts$/, '')));

  assert.deepEqual(
    orphans,
    [],
    `modules naming no command domain: ${orphans.join(', ')}. ` +
      'A domain module is `<domain>Commands.ts`; anything else must be a declared shared helper.',
  );
});

test('DEV-P1-07: index.ts composes the program and does not implement commands', () => {
  // The rule's third clause, and the one that decides whether the decomposition holds. A new
  // command added directly to `index.ts` would pass both tests above — the domain would have
  // no module and the check would fire, but only if someone also declared its authority.
  // This catches the more likely regression: a command body drifting back into the composer.
  const text = readFileSync(join(cliDirectory(), 'index.ts'), 'utf8');

  // `commandConsoleServe` is the accepted exception: the dashboard's `console serve`
  // subcommand attaches to the console group that `consoleCommands.ts` owns, and commander
  // rejects a second group of the same name. It is named here so the exception is explicit.
  const bodies = [...text.matchAll(/^(?:async )?function (command[A-Z]\w*)/gm)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== 'commandConsoleServe' && name !== 'commandPathOf');

  assert.deepEqual(
    bodies,
    [],
    `command bodies still in index.ts: ${bodies.join(', ')}. ` +
      'ADR-0003: index.ts composes the program and owns nothing else.',
  );
});
