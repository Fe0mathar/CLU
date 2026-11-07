# Directory §7 — replacement text (rev 2)

**Apply to:** `CLUE_Project_Directory_v9.md`, section `# 7. \`src/cli/\` — command entry points`
**Authority:** ADR-0003 rev 2
**Supersedes:** `ADR-0003-directory-section-7-replacement.md` (rev 1) — **do not apply that
file**; it names modules without the `Commands` suffix.
**Revision effect:** Directory `documentRevision` bumps; `packRelease` unchanged.

Replace the section's file block and add the paragraphs marked NEW. The responsibility
statement at the end is unchanged and is reproduced here only so the section reads whole.

---

# 7. `src/cli/` — command entry points

```text
src/cli/
├─ index.ts
├─ commandAuthority.ts
├─ commands/
│  ├─ <domain>Commands.ts
│  └─ shared.ts
└─ output/
   └─ formatter.ts
```

**NEW —** `commands/` contains one module per command domain, named `<domain>Commands.ts` for
the domain as the operator types it: `clue snapshot` is implemented by
`commands/snapshotCommands.ts`. A domain with several subcommands is a single module — `task
list`, `task show`, `task export` and the rest are all `commands/taskCommands.ts` — because a
domain, not a subcommand, is the unit an operator and a reviewer both reason about.

**NEW —** The suffix is load-bearing rather than decorative. Four domains share a name with the
domain module the command calls (`graph`, `snapshot`, `mission`, `audit`), and without the
suffix the CLI veneer and the authoritative owner are indistinguishable in an editor tab, a
stack frame, or a review diff. A module under `commands/` that implements no domain keeps a
plain unsuffixed name; `shared.ts` is the only one, and the missing suffix is what marks it as
a helper.

`commandAuthority.ts` holds the closed registry of every declared command with its capability,
mutation and mission requirements. `output/` contains presentation helpers shared across
command modules. `index.ts` composes the program, applies the authority hook, and owns nothing
else.

**NEW —** Command modules current or anticipated at the time of writing, informative and not a
closed set:

```text
initCommands.ts        recognizeCommands.ts    snapshotCommands.ts    graphCommands.ts
statusCommands.ts      doctorCommands.ts       metricsCommands.ts     candidatesCommands.ts
taskCommands.ts        consoleCommands.ts      claimsCommands.ts      conflictsCommands.ts
auditCommands.ts       missionCommands.ts      seedsCommands.ts       docsCommands.ts
cycleCommands.ts       benchmarkCommands.ts    gitCommands.ts
```

The last three name domains that do not exist yet. A module appears when its domain does; the
rule above governs, not this list. `consoleCommands.ts` and its helper
`operationalConsoleCommands.ts` currently sit at `src/cli/` rather than under `commands/` —
a location divergence recorded as a declared exception in
`selftest/cli-layout-conformance.test.ts` rather than left implicit.

The CLI is a thin transport over application services. It owns:

- command parsing;
- local interactive confirmation;
- human-readable output;
- exit codes;
- selection of a registered project and command profile.

It does not implement recognition, AI reasoning, Git operations, benchmark logic, or verdict
authority directly.

---

## What changed against rev 1

Rev 1 named modules for the domain exactly — `commands/graph.ts`. Rev 2 adds the `Commands`
suffix. The rule is unchanged in substance; only the derivation is, and ADR-0003 rev 2 records
why. `commandAuthority.ts` and `shared.ts` are now named in the tree block rather than existing
unlisted, which is what made `shared.ts` argue for itself in its own header.
