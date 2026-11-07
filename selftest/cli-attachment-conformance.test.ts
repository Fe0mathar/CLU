/**
 * DEV-P1-38 / DEV-P1-36 — a command declared read-only must not open with the event-log writer.
 *
 * Spec: `CLUE_Architecture_v9.md` — single-writer daemon; exactly one process may hold the event
 *       log, and everything else reads projections.
 *       `CLUE_Project_Directory_v9.md` §7 as amended by ADR-0003 rev 2 — `commands/` holds one
 *       module per domain, which is what makes the module-to-domain mapping below mechanical
 *       rather than a maintained list.
 *
 * Backlog: DEV-P1-38 — five commands declared `mutates: false` opened `withRuntime({ withLog:
 *          true })` and so took the single-writer lock to read: `graph`, `claims`, `conflicts`,
 *          `seeds`, `mission`. Each has been corrected; this file is what stops them drifting
 *          back.
 *
 * ## Why the registry could not catch this itself
 *
 * `commandAuthority.ts` describes itself as the single reviewable statement of what each command
 * may do, and `mutates` is documented there as "writes durable state and therefore needs the
 * event-log writer lock". That sentence was true of the table and false of the program. Nothing
 * in `src/` read the field — `commandMutates` was exported and called only from
 * `command-authority.test.ts` — so every call site chose its own attachment and five chose
 * wrongly, for years of revisions, while the table said otherwise and no one compared them.
 *
 * This is the narrow half of `DEV-P1-36`. It does not make the declaration *drive* the
 * attachment; it makes the two agree, checkably, which is the part that can be done without
 * threading a command path through sixteen call sites. The wide half — `requiresMission`, which
 * still has no consumer anywhere in `src/` — remains open.
 *
 * ## Why a source scan rather than a runtime assertion
 *
 * The honest alternative is to run each command and observe whether it acquires the lock. That
 * needs a workspace, a second process holding the writer, and a real target — which is exactly
 * how each of the five fixes was proven, and exactly what a self-test should not depend on. The
 * property here is static: it is a claim about what the code *asks for*, and asking is visible
 * in the text.
 *
 * The scan strips comments first. Four of these modules discuss `withLog: false` in their
 * headers, and a check that read prose as code would pass for the wrong reason — which is the
 * failure mode this whole file exists to prevent, reproduced inside the detector.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMAND_AUTHORITIES } from '../src/cli/commandAuthority.js';

/* ------------------------------------------------------------------------- */
/* Locating and reading the authored source                                   */
/* ------------------------------------------------------------------------- */

/**
 * Locates the *authored* `src/cli/` from the compiled test.
 *
 * The obvious walk-up finds `dist/src/cli` first, which contains `index.js` and no `.ts` at all.
 * The presence of `index.ts` is what distinguishes the source tree from its compilation.
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

/**
 * Removes block and line comments.
 *
 * Deliberately crude: it does not understand a `/*` inside a string literal. That is acceptable
 * here because the input is a fixed set of files in this repository rather than arbitrary
 * TypeScript, and a false strip would show up as a missing attachment — a loud failure — rather
 * than a silently permitted one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
}

/** Every `withLog:` literal actually passed to `withRuntime` in a module's code. */
function attachments(source: string): boolean[] {
  const found: boolean[] = [];
  const pattern = /withRuntime(?:Async)?\s*\(\s*\{[^}]*?withLog:\s*(true|false)/gu;
  for (const match of stripComments(source).matchAll(pattern)) {
    found.push(match[1] === 'true');
  }
  return found;
}

/* ------------------------------------------------------------------------- */
/* The declared exception                                                     */
/* ------------------------------------------------------------------------- */

/**
 * `doctor` is declared `mutates: false` and opens `withLog: true`, and that is correct.
 *
 * It passes `verifyLog: deep ? 'full' : 'tail'` — its job includes verifying the event log's own
 * hash chain, and there is no read-only way to open a log. `withLog: false` does not open the
 * log at all, so the check would not become cheaper, it would disappear.
 *
 * This is the difference between a command that takes the writer to reach *projections* — which
 * is what the five defects were — and one that takes it to inspect *the log itself*. The first
 * is an accident; the second is the command's purpose. Recorded as a named exception with its
 * reason, on the principle that an exception someone has to write down is one someone can
 * eventually pay off; `mutates` does not currently have a value that expresses "reads the log",
 * and inventing one is a change to the registry's shape rather than to this test.
 */
const DECLARED_WRITER_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['doctor', 'verifies the event log chain itself (verifyLog); a log cannot be opened read-only'],
]);

/**
 * Domains whose declaration is itself under question, excluded so this test cannot ratify one.
 *
 * **Currently empty, and deliberately kept.**
 *
 * `candidates` was the entry here. It was declared `mutates: true` while its body was a single
 * bounded `SELECT` over `ranked_candidates` — the registry's rationale ("records the ranking with
 * its weights") described `metrics`, which performs both writes. Declaration and attachment
 * therefore *agreed*, and a naive comparison would have called that a pass.
 *
 * Excluding it rather than accommodating it was the point. A conformance test that returns green
 * for a command whose declaration is known to be false is worse than one that says nothing: it
 * converts an open question into an apparent answer.
 *
 * `DEV-P1-37` closed it in three ordered steps, and the order was not cosmetic. The attachment
 * moved to `withLog: false` first, then the declaration to `mutates: false`; the reverse order
 * would have produced a command declared read-only that still took the writer lock — the same
 * disagreement with the sign flipped. Only once both agreed *and were both right* did removing
 * this entry mean anything. `candidates` is now an ordinary read-only domain, checked by the rule
 * below like its seven siblings.
 *
 * The mechanism stays because the next contested declaration is a question of when rather than
 * whether — thirty-six entries were reviewed by hand, one was wrong, and nothing yet forces the
 * table to agree with the program beyond the two properties this file checks. An empty map costs
 * nothing and gives the next such finding somewhere honest to sit; the alternative is that
 * whoever finds it either excludes it silently or lets the suite go red on a known issue.
 */
const CONTESTED_DECLARATIONS: ReadonlyMap<string, string> = new Map();

/* ------------------------------------------------------------------------- */
/* Tests                                                                      */
/* ------------------------------------------------------------------------- */

/** Domains where every declared command is read-only. */
function readOnlyDomains(): string[] {
  const byDomain = new Map<string, boolean[]>();
  for (const entry of COMMAND_AUTHORITIES) {
    const domain = entry.command.split(' ')[0] ?? entry.command;
    const list = byDomain.get(domain);
    if (list === undefined) byDomain.set(domain, [entry.mutates]);
    else list.push(entry.mutates);
  }
  return [...byDomain.entries()]
    .filter(([, values]) => values.every((mutates) => !mutates))
    .map(([domain]) => domain)
    .sort();
}

test('DEV-P1-38: a domain declared entirely read-only does not open with the writer', () => {
  const commands = cliDirectory();
  const offenders: string[] = [];

  for (const domain of readOnlyDomains()) {
    if (DECLARED_WRITER_EXCEPTIONS.has(domain)) continue;
    if (CONTESTED_DECLARATIONS.has(domain)) continue;

    const file = join(commands, 'commands', `${domain}Commands.ts`);
    if (!existsSync(file)) continue; // console lives outside commands/; covered by its own layout test

    const opened = attachments(readFileSync(file, 'utf8'));
    assert.notEqual(
      opened.length,
      0,
      `${domain}Commands.ts: no withRuntime attachment found — the scan is broken, not the code`,
    );
    if (opened.some((withLog) => withLog)) offenders.push(domain);
  }

  assert.deepEqual(
    offenders,
    [],
    `declared mutates: false but opens withLog: true — takes the single-writer lock to read: ${offenders.join(', ')}`,
  );
});

test('DEV-P1-38 / DEV-P1-37: the six corrected commands attach read-only, individually', () => {
  // Named one by one rather than derived. The test above would still pass if a future edit
  // widened `DECLARED_WRITER_EXCEPTIONS` to cover one of these; naming them makes that edit
  // visible as a deletion here rather than invisible as an addition there.
  //
  // `candidates` joins the five late and by a different route. The other five were declared
  // read-only and attached as writers; `candidates` was declared a writer, attached as one, and
  // was neither. It is listed with them because the end state is identical and the reason it
  // arrived is recorded above, not because the defect was the same.
  const commands = join(cliDirectory(), 'commands');
  for (const domain of ['graph', 'claims', 'conflicts', 'seeds', 'mission', 'candidates']) {
    const opened = attachments(readFileSync(join(commands, `${domain}Commands.ts`), 'utf8'));
    assert.deepEqual(
      opened,
      [false],
      `${domain} must open read-only (DEV-P1-38 / DEV-P1-37); found ${JSON.stringify(opened)}`,
    );

    // Both halves, not just the one that was broken most often.
    //
    // The rule above only inspects domains the registry calls read-only, so flipping a
    // declaration back to `mutates: true` removes that domain from its scope rather than failing
    // it — the check quietly stops applying instead of complaining. That gap was found by
    // reverting the `candidates` declaration and watching all five tests pass.
    //
    // Asserting the declaration here closes it: for these six, the answer is fixed in both the
    // table and the call site, and either one moving is a failure.
    const declared = COMMAND_AUTHORITIES.filter((entry) => entry.command.split(' ')[0] === domain);
    assert.notEqual(declared.length, 0, `${domain} has no entry in the authority registry`);
    for (const entry of declared) {
      assert.equal(
        entry.mutates,
        false,
        `${entry.command} must stay declared read-only; a writer here would put the domain ` +
          'outside the rule above rather than in breach of it',
      );
    }
  }
});

test('DEV-P1-38: audit remains the reference implementation', () => {
  // `audit` was already correct and is what the other five were modelled on. If it ever regresses,
  // the pattern being copied from is wrong, so it is asserted separately from the rule.
  const file = join(cliDirectory(), 'commands', 'auditCommands.ts');
  assert.deepEqual(attachments(readFileSync(file, 'utf8')), [false]);
});

test('DEV-P1-38: every declared exception is real, current, and reasoned', () => {
  const commands = join(cliDirectory(), 'commands');
  const declared = new Set(readOnlyDomains());

  for (const [domain, reason] of DECLARED_WRITER_EXCEPTIONS) {
    assert.ok(
      declared.has(domain),
      `${domain} is excepted but is no longer declared read-only; delete the exception`,
    );
    assert.ok(reason.trim().length > 0, `${domain}'s exception must state why`);
    // An exception that no longer takes the writer is stale: it grants permission nobody uses,
    // and the next reader has to work out whether it is load-bearing.
    const opened = attachments(readFileSync(join(commands, `${domain}Commands.ts`), 'utf8'));
    assert.ok(
      opened.some((withLog) => withLog),
      `${domain} is excepted but no longer opens with the writer; delete the exception`,
    );
  }

  for (const [domain, reason] of CONTESTED_DECLARATIONS) {
    assert.ok(reason.trim().length > 0, `${domain}'s exclusion must state why`);
    assert.ok(
      COMMAND_AUTHORITIES.some((entry) => entry.command.split(' ')[0] === domain),
      `${domain} is excluded but is not in the registry at all`,
    );
  }
});

test('DEV-P1-36: the scan sees code and not prose', () => {
  // Four of the corrected modules discuss `withLog: false` in their headers. If comments counted,
  // this suite would pass for the wrong reason — the exact failure it exists to prevent.
  const withOnlyProse = `
    /** A header mentioning withRuntime({ withLog: true }) in passing. */
    // and a line comment: withRuntime({ withLog: true })
    export const nothing = 1;
  `;
  assert.deepEqual(attachments(withOnlyProse), []);

  const withCode = `
    /** Header says withRuntime({ withLog: true }). */
    function run() { return withRuntime({ withLog: false }, (r) => 0); }
  `;
  assert.deepEqual(attachments(withCode), [false]);
});
