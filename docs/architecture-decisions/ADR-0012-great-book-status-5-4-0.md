# ADR-0012 — accepted proof becomes durable Great Book memory; Status wire 5.4.0

**Status:** implementation candidate for Creator ratification  
**Date:** 2026-08-13  
**Owner:** Great Book / Status wire / DEV-P2-12

## Decision

An accepted proof verdict and its recursive-memory consequence are one authority act.
`CycleOrchestrator.candidate()` derives an immutable Great Book entry before appending
`proof.verdict_recorded`, and embeds the complete recording in that same event payload.
There is no second append whose failure could leave an authoritative `ACCEPT` without its
Great Book consequence.

SQLite is a rebuildable read model only. The new `great-book` projection validates the
embedded entry, checks parity with the enclosing verdict and event identity, and then
projects it for read-only Status and Improvement Field consumers. Projection schema
advances from 5 to 6 so an existing workspace clears and replays its event-derived tables
under the new module set.

## Entry identity and contents

A Great Book entry is content-addressed and binds:

- target, mission and cycle identity;
- frozen hypothesis and causal claim;
- proof-contract hash;
- baseline and candidate digests and snapshot identities;
- patch digest and exact change-set;
- benchmark-run and artifact references;
- normalization identity;
- one or more canonical 10 × 10 measurement contributions;
- recording time.

The entry hash is recomputed on every read. A changed field therefore cannot remain a valid
entry merely because SQLite still contains a row.

## Canonical coordinate policy

The optional `ProofContract.great_book` block freezes target-specific mappings before
candidate observation. Each mapping names an active canonical coordinate, a declared native
proof measure, scope, confidence and coverage. Unknown measures, reserved cells, duplicate
coordinates and the system-owned coordinates below are refused by the strict contract.

Every valid `ACCEPT` additionally records two deterministic system contributions:

- `MI05` — the frozen causal claim was accepted by the proof authority;
- `MJ06` — all mandatory proof gates held.

This means an ordinary accepted proof cannot disappear from recursive memory merely because
its native signal ID is not itself a catalogue coordinate. No post-result model chooses a
cell. When native IDs already are active canonical IDs, they may be carried directly; an
explicit frozen mapping remains the preferred target-specific contract.

`REJECT`, `REVISE` and `INVALID` remain durable proof outcomes but do not become proven
improvement entries.

## Recording gaps

A new production `ACCEPT` is expected to carry a valid entry. The projection nevertheless
recognizes an explicit `not_recorded` consequence for forensic compatibility. Such an
accepted-without-entry event becomes a durable recording gap. Status consistency fails while
any gap exists; the system does not reinterpret it as an empty Great Book.

Verdict events written before this ADR have no `great_book` member. They remain valid proof
history and are not retroactively rewritten into lessons they never claimed to record.

## Status and Q2

`greatBook` moves from `unsupported` to a typed, backed Status branch. The wire version
advances from `5.3.0` to `5.4.0`. The branch reports entry count, contribution count,
recording-gap count, latest entry/cycle identity, normalization identity and freshness.

The existing 10 × 10 Improvement Field reads the same projected entries. Status consistency
cross-checks:

- Great Book contribution count against rendered Q2 segments;
- latest-entry presence against entry count;
- normalization identity across both branches;
- zero accepted-without-entry gaps.

A connected workspace with no accepted proof is a backed empty state and says so. It is not
reported as “Great Book evidence is not connected.”

## Consequences

- Status schema becomes `5.4.0`.
- Projection schema becomes `6` and existing derived tables are replayed.
- `greatBook` enters `BACKED_BRANCHES` and leaves the unsupported census.
- Accepted proof memory survives process restart and complete SQLite deletion/rebuild.
- The dashboard remains a reader; it does not create, classify or certify Great Book entries.
- Directory registration and formal ratification remain part of the later governance ZIP.

## Acceptance

1. typecheck and production build are green;
2. an isolated real proof command records `ACCEPT` and one matching Great Book entry without
   changing canonical source;
3. entry identity, event parity, restart/replay, tamper refusal and transaction rollback are
   permanently tested;
4. a schema-5 workspace migrates to projection schema 6 with both Great Book tables present;
5. Status reports `5.4.0`, backs `greatBook`, and its seal cross-checks Q2;
6. connected-empty and reader-failure states are distinguished honestly;
7. the Great Book field build/verification and complete self-test suite remain green.
