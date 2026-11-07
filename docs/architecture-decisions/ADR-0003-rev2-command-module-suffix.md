# ADR-0003 rev 2 — a command module is `<domain>Commands.ts`

**Status:** accepted; documentation amendment pending Creator application to the sealed pack
**Date:** 2026-08-07
**Decided by:** Kacper (Creator)
**Amends:** ADR-0003 rev 1, and through it `CLUE_Project_Directory_v9.md` §7
**Backlog:** `DEV-P1-07`
**Supersedes:** the naming clause of ADR-0003 rev 1 only. Everything else in rev 1 stands.

---

## Context

ADR-0003 rev 1 replaced §7's enumeration of eight command files with a rule: one module per
command domain, **named for the domain as the operator types it**. The rule was right. The
derivation was written without checking what the names would collide with.

Applied literally it produced four filename collisions, each between a command module and the
exact domain module it calls:

```text
commands/snapshot.ts   →  analysis/source/snapshot.ts
commands/graph.ts      →  analysis/source/graph.ts
commands/mission.ts    →  control/mission.ts
commands/audit.ts      →  control/audit.ts
```

The collision is not a compiler problem — the paths differ, imports resolve. It is a problem
for every human and every tool that shows a file by its basename: an editor tab strip, a stack
frame, a grep result, a review diff. `graph.ts` calling `graph.ts` is ambiguous in exactly the
places where a reader is trying to work out which layer they are in.

Rev 1 also recorded `consoleCommands.ts` and `operationalConsoleCommands.ts` as *exceptions* to
its own rule. They were not exceptions. They were the convention the repository already had,
and the rule was written past them.

## Decision

A command module is named `<domain>Commands.ts`, where `<domain>` is the domain as the operator
types it. `clue graph` is implemented by `commands/graphCommands.ts`.

A module under `commands/` that implements no domain keeps a plain, unsuffixed name.
`shared.ts` is the only one, and the absence of the suffix is now the signal that it is a
helper rather than a domain.

Everything else in rev 1 is unchanged: one module per domain, a domain with several subcommands
is one module, `output/` holds presentation helpers, `index.ts` composes the program and owns
nothing else.

## Why a suffix rather than the bare domain name

**It removes all four collisions and cannot create new ones.** A domain module and the domain
module it calls can never share a basename, because one always carries the suffix.

**It matches prior art instead of overriding it.** `consoleCommands.ts` was in the tree before
the decomposition began. Rev 1 discarded that convention and then had to name it as an
exception — a rule that needs an exception on the day it is written is usually describing the
wrong thing.

**It aligns the file with its export.** Every module exports `register<Domain>Commands`. The
file is now named after what it contains rather than after the domain it happens to serve.

**It stays mechanically checkable, which was rev 1's whole argument.** The derivation is
`domain + 'Commands.ts'` instead of `domain + '.ts'` — one expression either way, and
`selftest/cli-layout-conformance.test.ts` checks both directions of it against the closed
authority registry.

## Alternatives considered

**Keep `<domain>.ts` and live with four collisions.** Rejected. The cost is paid continuously
by every reader, and it grows: `metrics`, `claims` and `conflicts` all have plausible future
domain modules of the same name.

**Rename the *domain* modules instead.** Rejected outright. The domain modules are the
authoritative owners named by Directory §11; renaming an owner to make room for a CLI veneer
inverts the dependency the Directory establishes.

**Put commands in per-domain subdirectories (`commands/graph/index.ts`).** Rejected. It trades
four ambiguous basenames for sixteen identical ones.

**Suffix only the four that collide.** Rejected. A rule that applies to four of fifteen files
is an enumeration wearing a rule's clothes, which is the exact failure rev 1 was written to fix.

## Affected contracts

- `CLUE_Project_Directory_v9.md` §7 — via the replacement text in
  `ADR-0003-directory-section-7-replacement.md`, which is updated alongside this rev
- `DOCUMENTATION_GOVERNANCE_v9.md` — single-owner change to one section; the Directory's
  `documentRevision` bumps, `packRelease` does not
- Nothing else

**This ADR does not seal the pack.** The amendment is written here and applied by the Creator.

## Migration

Applied to the tree in the same turn this was written:

- 15 modules renamed under `src/cli/commands/`; `shared.ts` unchanged
- `src/cli/index.ts` — 15 import specifiers repointed
- four modules whose own headers cited their old path — `doctor`, `init`, `recognize`,
  `status` — reconciled to the amended rule
- `selftest/cli-layout-conformance.test.ts` — both directions of the derivation updated
- `src/cli/commands/shared.ts` — the paragraph arguing for its own existence retired; under
  the amended rule it is sanctioned rather than excused

`src/cli/consoleCommands.ts` and `src/cli/operationalConsoleCommands.ts` were **not** moved.
`consoleCommands.ts` is now conformantly *named* — the suffix rule was taken from it — so only
its location diverges, and it remains the single declared exception in the conformance test.
`operationalConsoleCommands.ts` attaches `console ui` and `console export-ui-state` to the
group `consoleCommands.ts` owns, which makes it a helper of that module rather than a domain
module; moving the pair inward would trade one named exception for a new entry in
`SHARED_MODULES`. That is not progress, and the debt stays where it can be seen.

## Consequences

Accepted: sixteen file paths change, and any external reference to them breaks. The cost is
one-off and was paid while the suite was green.

Gained: no command module shares a basename with the domain module it calls; the repository has
one naming convention rather than a convention and an exception; and `shared.ts` no longer has
to argue for itself in its own header.

## Verification

`selftest/cli-layout-conformance.test.ts`, three assertions, all passing.

The check was confirmed non-vacuous: reverting one rename — `graphCommands.ts` back to
`graph.ts` — failed assertions 1 and 2 (`domains with no module in commands/: graph`, and the
orphan direction). Restored, three of three pass. A rule that cannot fail is not a check, and
this one fails when the rule is broken.
