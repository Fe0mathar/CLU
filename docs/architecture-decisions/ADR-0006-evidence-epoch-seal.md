# ADR-0006 — the evidence-epoch seal

**Status:** accepted — all three requested decisions taken as proposed by the Creator, 2026-08-10 (record as specified; `epoch` as its own CLI domain; epoch name `P0-final`)
**Date:** 2026-08-10
**Proposed by:** this session, as the design half of `DEV-P2-05` (Gate 7, `DEP-P0-01`)
**Depends on:** the ratification slice landed 2026-08-10 (`authority.pack_ratified`,
`clue docs ratify`, doctor's installed-authority block)
**Blocks:** the `DEP-P0-01` exit; the P2 cycle's claim that its evidence was produced under
the governed epoch
**Numbering note:** ADR-0005 (target registration) is referenced by `schemas.ts`, `doctor`,
and the configuration but has no file in this directory — its decision text lives in those
comments. That gap is recorded here rather than repeated; this ADR takes the next number.

---

## Context

`DEP-P0-01` requires two acts this repository has no record type for: *seal the legacy
bootstrap event head and blob manifest* and *register the final P0 evidence epoch*.

The workspace's event log began life during bootstrap: events produced under evolving
schemas, provisional identity grammars, and pre-P1 code. All of it is true history and none
of it is evidence a governed cycle may cite as produced under the ratified authority. Today
that boundary exists only as knowledge in the Creator's head and in session notes. The
epoch seal makes it a durable, attributable fact: **everything at or before this head is
legacy; everything after was produced under the ratified v9 authority and the final
grammars.**

The ratification slice proved the pattern this proposal reuses: a schema-validated payload,
a mission-service act, a closed-registry CLI command with a state-bound confirmation
phrase, a doctor line that consumes the record, and a permanent test module.

## The record

Event type `authority.epoch_sealed`, owned by the mission service — the same §8 reasoning
as ratification: authority registered before authoritative work. Actor `creator`.

Payload (`epochSealSchema`, strict):

| Field | Meaning |
|---|---|
| `epoch_name` | the boundary's name; `P0-final` for this cutover |
| `legacy_head_sequence` | the log head sequence at the moment of sealing — the seal event itself lands at the next sequence, so the boundary is exact |
| `legacy_head_hash` | the chain hash at that head, taken after a full `log.verify()` |
| `blob_manifest_sha256` | sha256 over the canonical JSON of every artifact blob as `{hash, bytes}`, sorted by hash |
| `blob_count` | census of that manifest |
| `ratification_event_id` | the `authority.pack_ratified` event this epoch stands on |
| `ratified_seal_sha256` | copied from that record, so the payload is self-contained |
| `sealed_by` | literal `creator` |
| `statement` | the exact confirmation phrase typed |
| `sealed_at` | timestamp |

## Guards and refusals

1. **A mission must be in force** — the envelope requires it, as with ratification.
2. **The ratification must be current.** The live seal must hash-equal the latest
   ratification's `seal_sha256`, and every pack file must verify against the seal at the
   moment of sealing. An epoch over an unratified or drifted pack is refused: the epoch's
   entire meaning is "produced under the ratified authority", and that claim must be true
   at the instant it is recorded.
3. **The chain must verify.** `log.verify()` (full) runs before the head is bound. Sealing
   a corrupt chain is refused; the sealed periodic checkpoint (`DEV-P1-01`) corroborates
   the same head independently, but the epoch does not depend on it.
4. **One seal per name.** Re-sealing `P0-final` is refused citing the existing event.
   Future epochs take new names; the query surface returns the latest per name.
5. **Nothing is deleted, rotated, or rewritten.** Legacy events remain exactly where they
   are — the log is append-only truth. The epoch is an interpretive boundary consumers
   read, not a mutation of history.

## What this enables

The host cutover sequence becomes checkable rather than remembered, in this order on the
Creator's machine: install + config (done) → `clue init` (the post-authority mission) →
`clue docs ratify` → **`clue epoch seal`** → `clue snapshot` → `clue recognize` →
projection rebuild → `clue doctor --deep` → release archive. Doctor gains a fifth
installed-authority line: `epoch P0-final sealed as EVENT-… (boundary N)` or `no epoch
sealed — legacy and governed evidence are not yet distinguished`. When `src/cycle/` exists,
a cycle's evidence-spine root can assert `sequence > legacy_head_sequence` as a machine
check that its inputs are governed-epoch evidence.

## Alternatives considered

**A filesystem receipt only** (like the installer's JSON): rejected — a receipt outside the
log is not on the evidence spine, cannot be mission-attributed, and does not survive the
workspace's own recovery guarantees.

**Reusing the periodic checkpoint as the epoch:** rejected — the checkpoint is mechanical
and recurring; the epoch is a deliberate, named, Creator-attributed act that additionally
binds the blob manifest and the ratification. The two corroborate each other and stay
distinct.

**Log rotation at the boundary:** rejected outright — it would mutate history to express a
fact about it, which the Constitution's append-only rule exists to forbid.

## Migration, if accepted

Mirrors the ratified slice, one file per turn: `schemas.ts` (`epochSealSchema`) →
`mission.ts` (`sealEpoch()` / `epoch(name)`, blob-manifest computation over
`listBlobRelativePaths`) → `commandAuthority.ts` + `epochCommands.ts` (`clue epoch seal`,
interactive, phrase `SEAL <first 12 of the legacy head hash>` read off the preview via the
static `EventLog.readHead`, so no lock is held at the prompt) → doctor's fifth line →
`selftest/evidence-epoch.test.ts`. The host runbook is a separate document, drafted after
this ADR is decided.

## Acceptance criteria

- Sealing on a verified, ratified, mission-bearing workspace records the payload above and
  reads back; the event's sequence is `legacy_head_sequence + 1`.
- Each guard has a named refusal test: missionless, unratified pack, drifted pack,
  corrupt chain, duplicate name, empty statement, non-TTY.
- A blob added after sealing changes nothing about the record; a blob manifest recomputed
  at the boundary state reproduces `blob_manifest_sha256`.
- Doctor reports sealed/unsealed correctly on both states.

## Decisions requested from the Creator

1. **Adopt the record as specified** (name, fields, guards) — or amend.
2. **`epoch` as its own CLI domain** (`epochCommands.ts`, per the §7 rule that a domain is
   what the operator types) — or fold under an existing domain.
3. **Epoch name `P0-final`** for this cutover — or another name.

Nothing below `## Migration` is applied until these are answered.
