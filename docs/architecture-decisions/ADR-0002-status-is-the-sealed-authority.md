# ADR-0002 — Status is the sealed authority; the console view-model becomes its projection

**Status:** accepted, implemented (all five migration steps landed 2026-08-06)
**Date:** 2026-08-06
**Decided by:** Kacper (Creator), on a recommendation prepared from the v9 pack
**Implements:** `CLUE_Project_Directory_v9.md` §19.2–19.3, `CLUE_Status_Contract_v9.md` §20 gates 3 and 4
**Backlog:** Cluster C — `DEV-P1-10` … `DEV-P1-14`, and `DEV-P1-16` for the API route
**Successor needed:** the §19.3 lifecycle question below is unresolved and needs its own ADR
**Supersedes:** nothing
**Superseded by:** nothing

---

## Context

`src/ui/viewModel.ts` (1540 lines) defines `ConsoleSnapshot`, which carries a `StateSeal`.
`src/ui/consoleProjector.ts` produces it. `src/daemon/consoleStateService.ts` composes
reader → collector → projector → publisher and advances a revision only when the seal
changes. The pipeline works, is deterministic, and its zod validator is compile-time proven
identical to its interface in both directions.

It is also, structurally, the thing the Status Contract describes — and it sits one layer
below where the Directory places that authority:

> §19.2 — `statusContractV5.ts` is the machine schema owner corresponding to
> `CLUE_Status_Contract_v9.md`.
>
> §19.3 — Backend UI modules transform **sealed Status** and selected durable records into
> presentation-ready data. They do not independently compute metric meaning, infer Q1
> family placement, or maintain a second lifecycle state machine.

And the Status Contract forbids the alternative directly:

> §20 gate 3 — one and only one State Seal exists.
>
> §20 gate 4 — UI, CLI and API return the same body/hash.

Introducing `src/status/` beside the existing pipeline therefore creates two projectors,
two seals and two hashes. Both gates fail by construction, and the two bodies can disagree
about the same durable state with nothing to detect it.

## Decision

Status becomes the sealed authority. `StatusSnapshot` + `StatusSeal` are the one sealed
body; `ConsoleSnapshot` becomes a presentation projection *of* that body and stops carrying
a seal of its own.

`consoleStateService.ts` composes `statusProjector → statusSeal → consoleProjector →
publisher`, rather than reaching into the registries a second time.

## Why

The gates are not aspirational. A second seal is not a redundant copy — it is a second
opinion, computed from a second traversal of the same registries at a different instant. Two
seals over one workspace will disagree eventually, and when they do there is no rule for
which is right, because both were produced by an authority.

The Directory's layering also has a practical direction to it. Status is consumed by the
CLI, the HTTP API, exports, `clue status diff`, and future production diagnostics — none of
which render anything. Deriving those from a *console* view-model would make the console's
presentation concerns load-bearing for automation, which inverts the dependency the
Directory's §21 ordering states (Status projections sit above domain services and below
daemons and browser UI).

## Alternatives considered

**Keep both, and reconcile them.** Add a cross-check that the two seals agree over the same
durable head. Rejected: it institutionalises the duplication, and the reconciliation is
itself a third thing that can be wrong. It also does not satisfy gate 3, which counts seals
rather than requiring them to agree.

**Make the console seal the Status seal — rename rather than invert.** Superficially
cheapest. Rejected because the shapes are genuinely different: `StateSeal` binds a snapshot
hash and source list; `StatusSeal` binds event-log range, projection version, target
snapshot, mission and catalogue hashes, the Golden definition hash, and a consistency
result (§15, `supplementation_v9.md` §9.6). Renaming would leave the weaker binding in
place under a stronger name, which is worse than either honest option.

**Leave the console as-is and let Status be export-only.** Rejected: it is precisely the
"separate manual status format" §19 prohibits, and the two would drift the first time a
branch changed meaning on one side.

## The tension this decision does not resolve

`ConsoleSnapshot` currently carries state that Status cannot back.

`DashboardView` includes `startStop`, `crown`, `lens`, `sessions`, `progress`, `velocity`,
`forecasts` and `pipeline`; `ConfigurationView` includes the Chrome chain, PowerShell, IDE,
AI, testing, storage and safety sections plus a `ReadinessSummary`. Status v5.1.0 backs
eleven branches; several of those console members have no Status counterpart at all.

A naive inversion would therefore **lose information the operator currently sees.** Two
readings are available and this ADR does not choose between them:

1. Status gains the missing branches. Defensible for `sessions` and `pipeline`, which
   correspond to §9 (AI orchestration status) and §10 (findings and proof pipeline) — both
   are contract branches this build types as unsupported today, so the work is to back them
   rather than to invent them.
2. The console keeps sourcing operator-affordance state directly and declares it as
   non-Status. Defensible for the Chrome chain and readiness, which are local host facts
   rather than assessment truth.

The part that cannot be deferred: §19.3 says UI modules must not "maintain a second
lifecycle state machine", and the console's start/stop and Chrome-chain states arguably are
one. Whichever reading is taken, that specific question needs an answer before the console
is rewired, and it should be recorded as a successor to this ADR rather than settled in
passing during implementation.

## Implementation record

All five steps landed on 2026-08-06. Two decisions were made during implementation that this
ADR did not anticipate, and both belong here rather than only in code comments.

### One composition, not one projector

Step 3 established the direction and step 4 made Status a required input. That was not
sufficient. `clue status` filled the projector's options from the runtime — mission hash,
recognizer version, the catalogue loaded from disk, the Q1 pointer — while
`ConsoleStateService` passed **nulls** for all four, because it had no equivalent. One
workspace therefore produced two differently-populated Status bodies depending on which
surface asked: the CLI's catalogue branch backed, the dashboard's unavailable, from identical
durable state at the same moment.

That is the "separate manual status format" §19 prohibits, reached without anyone writing a
second format — two callers filling one options object differently was enough.
`src/status/statusFromRuntime.ts` is the single composition both now use, and a third caller
either uses it or is visibly not using it.

The general lesson is worth stating: making a projector pure moves the impurity to its
callers rather than removing it. Purity is what made determinism provable; it is not what
made the surfaces agree.

### The seal is split, and the obvious version was a regression

Step 5's obvious form is to repoint `ConsoleSnapshot.seal.snapshotHash` at the Status hash —
one hash, one seal, gate 3 closed. That was written, then checked against consumers:
`clueDashboardServer.publish()` compares `snapshotHash` to decide whether to send a new
revision. Two console bodies differing only in readiness or active tab share one Status hash,
so the dashboard would have stopped republishing on exactly the changes an operator watches
for. Tidier-looking change, real regression.

The split that landed:

| Member | Meaning | Source |
|---|---|---|
| `snapshotHash` | digest of *this* presentation body; change detection only | computed here |
| `statusHash` | which sealed Status body this presentation reflects | read from Status |
| `consistent` | whether that body is internally consistent | read from Status |

Gate 3 asks for one State Seal. What it guards is **two authorities reaching two verdicts
about one workspace**. After the split there is one verdict with one source, and the console
cannot form its own. `snapshotHash` carries no integrity claim and is documented on
`StateSeal` as what it is. A content digest used for change detection is not a second seal.

### Gate outcomes

Gates 1, 2, 3 and 4 are satisfied and the snapshot claims them. Gate 4 required
`DEV-P1-16`: `/api/status/current` was serving the console projection under the Status
Contract's own §17 route name, so the API's Status endpoint returned a different schema
entirely. The console projection moved to `/api/console/current`.

Gate 7 remains unreachable — unit records are not projected, only their counts — and the
`CapabilityDeclaration` branch says so about itself rather than leaving a reader to infer it.

## Migration implications

The migration is not a rewrite and must not be attempted as one. `viewModel.ts`'s contract
is large, proven, and consumed by the dashboard server, all four quadrants, and the
Q1 adapters. A staged order that keeps the suite green throughout:

1. `statusProjector.ts` produces `StatusSnapshot` from the registries. Both pipelines run;
   the console is untouched. *(Cluster C, `DEV-P1-12`.)*
2. A test asserts the two bodies agree over the same durable head, for every branch that
   exists on both sides. Any disagreement found here is a real defect in one of them, and
   is the cheapest moment to find it.
3. `consoleProjector.ts` takes `StatusSnapshot` as an input and sources its overlapping
   members from it, keeping its own seal temporarily.
4. The overlapping-member sources are removed from `consoleStateCollector.ts`; the
   remaining, non-Status members are explicitly labelled as such.
5. `StateSeal` is removed from `ConsoleSnapshot`, which instead references the Status seal
   by hash. Gates 3 and 4 are satisfied at this step and not before.

Steps 1 and 2 are the load-bearing ones. If step 2 finds no disagreement, the rest is
mechanical; if it finds one, the disagreement is more valuable than the migration.

**Outcome.** Step 2 found no disagreement in the overlapping values, and the rest was
mechanical as predicted — but it did find an *omission*: Status carried no `moduleCount`,
which the console reported from the same durable record. The staged order was worth its cost
for that alone. Every step kept the suite green, and the two tests that broke were the
migration's own markers firing as designed rather than regressions.

## Consequences

The interim period with two seals is over; it lasted one working session and was visible in
every snapshot produced during it, because the `CapabilityDeclaration` branch listed gate 3
under `unreachableGates` with the reason "the view-model seal is still upstream". That
mechanism is worth keeping in mind as a pattern: an incompleteness stated by the artifact
does not depend on anyone reading this file.

Two costs were accepted and both landed:

**A lossy fallback.** When Status cannot state the recognition topology, the console renders
the same uncommitted field it renders before any graph is built. `RecognitionTopology` has no
unavailable state, so "the graph could not be read" and "no graph yet" are indistinguishable
in that quadrant. Status distinguishes them. Giving the console contract an unavailable state
is a change to the console's own model and belongs with the successor ADR below.

**`RecognitionRecordInput` still exists.** Coverage is a derived measure over the recognition
result plus the language census, and no Status branch states it, so the console still reads
those fields directly. That is the honest boundary of the inversion rather than an oversight:
what Status can supply is sourced from it, what it cannot is read locally and visible as
such.

## Verification

- `selftest/status-console-agreement.test.ts` — step 2's agreement test, which found a field
  Status was missing (`moduleCount`, and with it `classDistribution`) *before* the inversion
  rather than after. That was the entire argument for doing step 2 first, and it paid.
  It also now holds the step-5 state: the console reports Status's verdict and cannot form
  its own, proved against an **inconsistent** Status — the first version asserted equality
  against a consistent one and passed even with the verdict hardcoded.
- `selftest/status-gate4-parity.test.ts` — one body and one hash given one declared instant.
- Verified against a running dashboard, not only in tests: a CLI export and an
  `/api/status/current` fetch of one workspace produced byte-identical bodies once the
  declared capture instant was equalised, and both seals verified independently.

**Not verified, and it cannot be from this repository:** whether the dashboard *renders*
correctly after the migration. No browser is executable here. `DEV-P1-16` fixed a case where
four active measures were silently dropped by the client, and that fix is guarded by a static
parity test against the canonical coordinate map — but the rendering itself needs a human
with the dashboard open.

## Open successor decision — §19.3 and the console's own lifecycle

Recorded here because it was flagged before implementation, was not resolved by it, and would
otherwise survive only in conversation.

§19.3 says backend UI modules "do not ... maintain a second lifecycle state machine". The
console's `startStop` phase and Chrome-chain stages arguably are one. The inversion did not
touch them: they are neither sourced from Status nor declared as deliberately non-Status,
which is the least defensible of the three possible states.

The two readings from this ADR's original tension section still stand — Status gains the
missing branches, or the console keeps local host affordances and declares them as
non-Status — and the answer differs by member. `sessions` and `pipeline` map to contract §9
and §10 and should become Status branches. Readiness and the Chrome chain are local host
facts and probably should not. Start/stop is the genuinely contested one.

This needs its own ADR before `DEV-P1-15` or `-17` touch the dashboard further.
