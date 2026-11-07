# ADR-0004 — §19.3, the console's own lifecycle

**Status:** accepted
**Date:** 2026-08-09
**Decided by:** Kacper (Creator), 2026-08-09 — all four questions answered, three as recommended
**Proposed by:** this session, from `tools/console-probe.js` v3 run on the Creator's host
**Amends:** `CLUE_Project_Directory_v9.md` §19.3
**Blocks:** `DEV-P1-15`, `DEV-P1-17`
**Evidence:** `clue-console-probe-2026-08-09T08-49-02-158Z.json`

---

## Context

ADR-0002 completed the inversion: Status is the sealed authority and `ConsoleSnapshot` is a
projection of it. It did not settle what happens to the console's **own** state — readiness, the
start/stop phase, the Chrome injection chain, session counts, the pipeline board. Those exist in
the console and nowhere else, and until it is decided whether they belong in Status, neither
`DEV-P1-15` nor `DEV-P1-17` can proceed.

The continuation brief guessed at an answer: *"`sessions` and `pipeline` map to contract §9/§10
and should become Status branches; readiness and the Chrome chain are local host facts and
probably should not; `startStop` is contested."* That was a reading of the documents. This ADR
replaces it with a reading of the running system.

## The measurement

A read-only browser probe against the live daemon on the Creator's host, 2026-08-09. Six surfaces
at their real paths, and the same six searched for in the Status body.

| Surface | Path in the console body | Present in Status |
|---|---|---|
| `startStop` | `snapshot.dashboard.startStop` — `{phase, readiness}` | **no** |
| `readiness` | `…startStop.readiness` — `{status, sections[9], firstBlocking}` | **no** |
| `sessions` | `snapshot.dashboard.sessions` — `{counts, active[], calls}` | **no** |
| `pipeline` | `snapshot.dashboard.pipeline` — `{stages[10]}` | **no** |
| host config | `snapshot.configuration` — `{project, chrome, powershell, ide, ai, testing, storage, safety, readiness}` | **no** |
| `shell` | `snapshot.shell` | **no** |

Status carries none of them. Every one is console-local today.

**Status branch coverage checks out.** 35 branch-shaped keys; 24 `unsupported` each carrying
`no owning domain in this build`, three `unavailable` with specific reasons (`recognition`, `q1`,
`gauges` — no record for this snapshot), seven backed and carrying data. That matches the source
and confirms the daemon and the tree agree.

## Decision

**Readiness, the Chrome chain and the rest of `snapshot.configuration` stay local. They do not
become Status branches.**

**`sessions` and `pipeline` become Status branches**, currently `unsupported` with a stated
reason, converting to backed when `src/cycle/` exists.

**`startStop` stays local, and is reconsidered when `src/cycle/` exists.**

## Why — and why one of the questions did not need answering

I asked the Creator whether the console is meant to be usable from a machine that is not running
the daemon, believing the answer decided readiness. **It does not.** The probe settled it more
directly, and the answer is the same either way.

`readiness.sections` is nine entries: `project_repository`, `chrome_console`, `powershell`,
`ide_cooperation`, `ai_providers`, `testing_benchmarks`, `storage_ledger`, `safety_authority`,
`validation`. Seven of the nine are assertions about *installed software on one machine*. The
current value is `blocked`, `firstBlocking: chrome_console` — Chrome is not reachable on the
Creator's host right now.

A Status document is exportable, diffable and retained; `clue status export` produces a file that
outlives the run. If readiness were a branch, that file would assert "Chrome is not reachable"
as a durable, mission-attributable fact — and it would be false the moment it was read anywhere
else, including on the same machine an hour later after Chrome was started. **The problem is not
remote reading. It is that the fact has no lifetime.** That holds whether or not the console is
ever opened from a second machine, which is why the question I asked was the wrong one.

`snapshot.configuration.chrome` is `{chain, consolePreview, recentInjections, health}` — a live
view of a browser session. Nothing there survives a restart, and nothing there is evidence.

By the same test, `sessions` and `pipeline` go the other way. `sessions.counts` is
`{active, limit, queued, checkpointing, completed, failed, cancelled, recoveryRequired}` and
`pipeline.stages` is the ten named stages from `proof_contract_frozen` through `ledger`. These
are facts about **the mission's work**, not about the machine: how many measure sessions ran, how
far a proof got. They are exactly what a status document should carry, and their absence from
Status is a gap rather than a boundary.

`startStop` is `{phase, readiness}` — and it fails the test in both directions at once. `phase`
is a mission-level fact (is a cycle running) that Status ought to own; `readiness` is the host
fact that must stay local. It cannot become a branch while it is a compound of the two, and it
cannot be split usefully until `src/cycle/` gives `phase` something to mean beyond `stopped`.
Deferring it is not indecision — it is refusing to design against a domain that does not exist,
which is the same reason 24 branches are `unsupported` today.

## The test this ADR establishes

A console surface becomes a Status branch when it is a **fact about the mission's work** —
attributable, durable, meaningful when read later or elsewhere.

It stays local when it is a **fact about this host at this moment** — a running process, an
installed tool, a live browser session.

Where a surface is both, it stays local and is recorded as contested rather than split
speculatively.

## Consequences

**Accepted.** The console keeps state Status cannot vouch for, so the dashboard is not fully
reconstructible from a status document. That is correct: a status document should not be able to
reconstruct whether Chrome was running.

**Avoided.** The proposal would have added two branches and bumped the wire schema. Reading the
contract before writing the code showed both facts already have declared owners. The census stays
24 and 11, and `5.1.0` stands.

**Gained.** `DEV-P1-15` and `DEV-P1-17` are unblocked, and each surface now has a written
argument rather than an intuition.

## One finding this measurement turned up, outside the decision

`units` is declared **backed** in `statusContractV5.ts` and reports **`unsupported`** at runtime,
with the reason `unit records are not on the RegistrySource reader seam`.

`unsupported` means *no owning domain in this build* — the reason the other 24 give. But `units`
has an owning domain; the records exist and are not exposed on the reader seam. That is
`unavailable`, which is what `recognition`, `q1` and `gauges` correctly report for their own
missing records.

The distinction is load-bearing: `unsupported` says *this will change when the domain is built*,
`unavailable` says *the domain is here and has nothing for this snapshot*. A reader deciding
whether to wait or to investigate needs to tell them apart. This is the same shape as acceptance
gate 7, which is unreachable for the same reason and declares it honestly.

Logged as **`DEV-P1-45`**. It is a one-word change with a governance edge — which state a branch
reports is a statement about the build — so it is recorded here rather than made.

## What was decided

All four, on 2026-08-09.

1. **The test is adopted.** Mission fact versus host fact, as stated above. This is the load-bearing
   decision — the other three are consequences of it, and it is the only one of the four that is
   expensive to reverse.
2. **`sessions` and `pipeline` become Status-carried facts**, `unsupported` with a stated reason
   until `src/cycle/` exists. **The mechanism in the proposal was wrong and is corrected below —
   they need no new branches, and no schema change.** The decision as decided is unaffected; only
   how it is implemented.
3. **`startStop` is deferred**, not split. Splitting it would mean designing a representation for
   `phase` against a domain with no behaviour — every value it can take today is `stopped`.
   Deferring is a decision to decide later with the reasoning written down, not an absence of one.
4. **`DEV-P1-45` is approved.** `units` will report `unavailable`.

## Correction to decision 2 — the branches already exist

The proposal said `sessions` and `pipeline` should be **added** to `UNSUPPORTED_BRANCHES`, taking
it from 24 to 26. That was written from the probe output without checking the Status Contract, and
it is wrong. Recorded rather than quietly amended, because the reasoning is the useful part.

Reading `selftest/status-contract.test.ts` first showed the census test is stricter than assumed:
the two lists must **partition the keys of `statusSnapshotSchema` itself**. A name added to a list
without a matching schema field fails `no census entry names a branch the schema does not have`.
So the change could never have been two lists and a count — it would have needed new fields in a
`.strict()` wire schema, and therefore a wire-version decision under ADR-0001.

Checking the contract then showed none of that is necessary. **Both facts already have owning
branches, and both are already declared:**

| Console surface | Contract section | Existing branch | Current state |
|---|---|---|---|
| `snapshot.dashboard.sessions` — `{counts, active[], calls}` | §9 AI orchestration — "active and queued logical sessions", physical calls, budget | `aiOrchestration` | `unsupported` |
| `snapshot.dashboard.pipeline` — `{stages[10]}` | §10 Findings and proof pipeline | `proofPipeline` | `unsupported` |

The console's ten pipeline stages — `proof_contract_frozen`, `baseline_captured`, `patch_sealed`,
`shadow_applied`, `patched_experiment`, `verdict`, `landing_eligibility`, `canonical_landed`,
`post_land_verification`, `ledger` — are §10's own disposition sequence. They are not a new
concept needing a home; they are the concept, already named, waiting for a backend.

**So decision 2 requires no code change at all today.** The two branches exist, are declared, and
correctly report `unsupported` because `src/cycle/` does not exist. What decision 2 settles is
where these facts go *when* it does: into `aiOrchestration` and `proofPipeline`, not into new
branches and not left console-local. That is a real decision — the alternative was inventing
`sessions` and `pipeline` branches, which would have duplicated two existing ones and forced a
wire-schema bump for nothing.

The branch census stays 24 unsupported and 11 backed. The wire schema stays `5.1.0`. Five test
files that consume the branch lists stay untouched.

## Migration

1. **Decision 1 (the test)** — recorded here; no code.
2. **Decision 2** — no code today. When `src/cycle/` lands, `aiOrchestration` and `proofPipeline`
   become backed from it. This ADR is the record of where those facts belong.
3. **Decision 3** — no code; `startStop` stays console-local and is revisited with `src/cycle/`.
4. **Decision 4 (`DEV-P1-45`)** — one line in `src/status/statusProjector.ts`. `units` currently
   calls `unsupported(reason)`; it should call `unavailable(reason, expectedSource)`. The second
   argument is what makes the change substantive rather than cosmetic: `unavailable` carries
   `expectedSource`, the durable source that would have backed the branch, and `unsupported`
   passes `null` because there is nothing to name. `units` *can* name one — the graph's unit rows
   — which is the clearest evidence it was mislabelled. No test asserts the current state, so this
   is a single-file change.
5. **`DEV-P1-15` and `DEV-P1-17`**, now unblocked, each on its own terms.
6. **§19.3 replacement text** for `CLUE_Project_Directory_v9.md`, written here and applied to the
   sealed pack by the Creator, as with ADR-0003 rev 2.

Nothing above has been applied to the tree at the time this ADR was accepted.
