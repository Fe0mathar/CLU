# Directory §7 — replacement text

**Apply to:** `CLUE_Project_Directory_v9.md`, section `# 7. \`src/cli/\` — command entry points`
**Authority:** ADR-0003
**Revision effect:** Directory `documentRevision` bumps; `packRelease` unchanged.

Replace the section's file block and add the two paragraphs marked NEW. The responsibility
statement at the end is unchanged and is reproduced here only so the section reads whole.

---

# 7. `src/cli/` — command entry points

```text
src/cli/
├─ index.ts
├─ commands/
│  └─ <domain>.ts
└─ output/
   └─ formatter.ts
```

**NEW —** `commands/` contains one module per command domain, named for the domain as the
operator types it: `clue snapshot` is implemented by `commands/snapshot.ts`. A domain with
several subcommands is a single module — `task list`, `task show`, `task export` and the rest
are all `commands/task.ts` — because a domain, not a subcommand, is the unit an operator and a
reviewer both reason about.

`output/` contains presentation helpers shared across command modules. `index.ts` composes the
program, applies the authority hook, and owns nothing else.

**NEW —** Command modules current or anticipated at the time of writing, informative and not a
closed set:

```text
init.ts        recognize.ts    snapshot.ts     graph.ts
status.ts      doctor.ts       metrics.ts      candidates.ts
task.ts        console.ts      claims.ts       conflicts.ts
audit.ts       mission.ts      seeds.ts        docs.ts
cycle.ts       benchmark.ts    git.ts
```

The last three name domains that do not exist yet. A module appears when its domain does; the
rule above governs, not this list.

The CLI is a thin transport over application services. It owns:

- command parsing;
- local interactive confirmation;
- human-readable output;
- exit codes;
- selection of a registered project and command profile.

It does not implement recognition, AI reasoning, Git operations, benchmark logic, or verdict
authority directly.

---

## What changed and why

The previous block enumerated eight command files. Four of them — `cycle`, `benchmark`, `git`,
`export` — named commands that do not exist, while twelve domains that do exist were unnamed.
The list was not stale from neglect: it was drawn before the command set existed, and the
command set was discovered rather than designed.

`export.ts` is dropped rather than retained. There is no `export` domain — `status export` and
`task export` are subcommands of their own domains, and the rule assigns them there.

ADR-0003 records the alternatives, including the option of enumerating the nine missing names
instead, and why a rule was preferred.
