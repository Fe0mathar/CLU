# ADR-0003 — `src/cli/commands/` is defined by a rule, not an enumeration

**Status:** accepted; documentation amendment pending Creator application to the sealed pack
**Date:** 2026-08-06
**Decided by:** Kacper (Creator)
**Amends:** `CLUE_Project_Directory_v9.md` §7
**Backlog:** `DEV-P1-07`
**Supersedes:** nothing
**Superseded by:** nothing

---

## Context

`DEV-P1-07` decomposes `src/cli/index.ts`. Six domains are out; nine remain. The extraction
stopped because of a governance problem rather than a technical one: **§7 enumerates eight
command files, and nine of the twelve real command domains are not among them.**

The enumeration as written:

```text
src/cli/
├─ index.ts
├─ commands/
│  ├─ init.ts       ├─ status.ts
│  ├─ recognize.ts  ├─ doctor.ts
│  ├─ cycle.ts      ├─ git.ts
│  ├─ benchmark.ts  └─ export.ts
└─ output/
   └─ formatter.ts
```

Set against the command surface the CLI actually has:

| §7 names it, and it exists | §7 names it, no commands exist | Exists, §7 does not name it |
|---|---|---|
| `init`, `recognize`, `status`, `doctor` | `cycle`, `benchmark`, `git`, `export` | `snapshot`, `graph`, `metrics`, `candidates`, `claims`, `conflicts`, `seeds`, `mission`, `docs`, `task`, `console`, `audit` |

Four of the eight named files describe commands that do not exist. Twelve domains that do
exist are unnamed. The list is not out of date because files were extracted — **it was
written before the command set existed, and the command set grew legitimately past it.**

This is not a defect in §7. Directory §26 is explicit: *"The directory is a map of
responsibility, not a claim that every target file already exists."* The map was drawn
forward, which is what a target layout is for. What it did not anticipate is that the CLI's
domains would be discovered rather than designed.

The immediate cost is concrete. Extracting the nine means either creating nine filenames the
contract does not sanction, or stopping with `index.ts` at 922 lines holding exactly the set
the contract never described. One file — `commands/shared.ts` — was already added this way,
justified in its own header, which is a precedent worth not repeating silently.

## Decision

Amend §7 so `commands/` is governed by a **rule** rather than a list:

> `commands/` contains one module per command domain, named for the domain as the operator
> types it (`snapshot` → `commands/snapshot.ts`). A domain with several subcommands is one
> module (`task list`, `task show`, … → `commands/task.ts`). `output/` contains presentation
> helpers shared across command modules. `index.ts` composes the program and owns nothing
> else.

Keep the existing eight names as **informative examples**, marked as such, so the aspirational
ones (`cycle`, `benchmark`, `git`) still record intent without reading as a closed set.

## Why a rule rather than nine more names

**An enumeration is wrong the moment a command is added.** Adding nine names fixes today and
guarantees another amendment at the next domain. A rule is checkable against any future
command set, which is what a permanent contract should be.

**The rule is more testable than the list.** "One module per domain, named for the domain"
can be asserted mechanically against the built program — the closed authority registry
already enumerates every domain, so a conformance test is a few lines. An enumeration can
only be checked against itself.

**It matches how §7 already reasons about the CLI.** The section's substance is the
responsibility statement — the CLI owns parsing, confirmation, output, exit codes, and
project selection, and implements no recognition, AI, Git, benchmark or verdict logic. That
holds regardless of how many files the commands occupy. The file list was illustration; this
amendment makes the illustration say so.

## Alternatives considered

**Enumerate the nine.** Rejected: correct today, stale at the next command, and it would need
this same ADR again. It also entrenches the idea that the Directory tracks files rather than
responsibilities.

**Stop extracting at 922 lines.** Genuinely defensible, and it was the standing
recommendation before this decision: every §7-named domain that exists is out, and what
remains is precisely the set the contract never described. Rejected because it leaves
`index.ts` as a permanent mixed bag for a reason unrelated to any property of the code —
and because the nine will keep growing, since new commands land in `index.ts` by default.

**Extract them anyway and record the divergence.** Rejected outright. That is drift with a
paper trail, and this project's whole method is that a contract governs or it does not.
`shared.ts` was one instance of it; nine more would make the exception the rule.

**Move the CLI's file layout out of the Directory entirely.** Attractive in that file
granularity is arguably an implementation detail. Rejected: §7 is also where the CLI's
authority boundary lives, and separating the two would leave the boundary in a document with
nothing else in it.

## Affected contracts

- `CLUE_Project_Directory_v9.md` §7 — the amendment itself
- `DOCUMENTATION_GOVERNANCE_v9.md` — this is a single-owner change to one section; it needs a
  document revision bump on the Directory, not a pack release
- Nothing else. No other document depends on §7's file enumeration.

## Migration implications

**For the pack.** §7's `commands/` block is replaced by the rule above, with the eight
existing names retained and marked informative. The Directory's `documentRevision` moves;
`packRelease` does not. **This ADR does not seal the pack — the amendment is written here and
applied by the Creator**, because the permanent documentation set is not this session's to
edit.

**For the tree.** `commands/shared.ts` becomes conformant retroactively: it is a helper shared
across command modules, which is what the rule permits. It stops being an exception argued
for in its own header.

**For the remaining extraction.** The nine domains move under the rule with no further
naming decisions: `snapshot.ts`, `graph.ts`, `metrics.ts`, `candidates.ts`, `claims.ts`,
`conflicts.ts`, `seeds.ts`, `mission.ts`, `docs.ts`.

**For the four aspirational names.** `cycle`, `benchmark` and `git` keep their intent as
examples. `export.ts` is a live question the rule answers differently than the list did: there
is no `export` domain — `status export` and `task export` are subcommands of their own
domains, so no `commands/export.ts` should be created.

## Consequences

Accepted: the Directory becomes marginally less specific about the CLI, and a reader can no
longer learn the command set by reading §7. That is honest rather than costly — reading §7
already did not tell you the command set, it told you a set that was four-eighths fictional.

Gained: the tree and its map can agree without an amendment per command, `shared.ts` stops
being an exception, and the rule is mechanically checkable in a way the list never was.

## Verification

The rule admits a conformance test that the enumeration did not: every command domain in the
built program has a module named for it under `commands/`, and every module under `commands/`
corresponds to a domain or is a shared helper. `selftest/command-authority.test.ts` already
enumerates the domains from the closed authority registry, so the check has its input.

That test is not written yet — it belongs with the remaining extraction, since asserting the
rule while nine domains still live in `index.ts` would only assert a failure.
