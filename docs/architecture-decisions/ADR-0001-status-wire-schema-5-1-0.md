# ADR-0001 — Status wire schema is 5.1.0 with an explicitly unavailable Golden branch

**Status:** accepted
**Date:** 2026-08-06
**Decided by:** Kacper (Creator), on a recommendation prepared from the v9 pack
**Implements:** `CLUE_Status_Contract_v9.md`, as amended by `supplementation_v9.md` §9
**Backlog:** `DEV-P1-10`
**Supersedes:** nothing
**Superseded by:** nothing

---

## Context

Two documents in the permanent pack state different wire schema versions for the same
contract.

| Source | States |
|---|---|
| `CLUE_Status_Contract_v9.md`, header | wire schema `5.0.0`; "this document re-baseline changes no field, branch, or semantic and is not a schema migration" |
| `CLUE_Status_Contract_v9.md` §3 | `"schemaVersion": "5.0.0"`, 37 branches, no `goldenMetrics` |
| `supplementation_v9.md` §9.1–9.2 | canonical wire schema becomes `5.1.0`; top-level adds `goldenMetrics`, placed after `measurementCatalogue` |
| `supplementation_v9.md` §15 | integration matrix: Status must "migrate wire schema to 5.1.0 and add exact Golden branch/API/seal/failure rules" |

`src/status/statusContractV5.ts` had to emit one of them. The choice is not cosmetic: the
version is a compatibility identity, and a producer that emits the wrong one commits every
consumer to a migration.

There is no Golden backend in this tree. `src/metrics/golden/` — the six modules
`supplementation_v9.md` §11.2 assigns — does not exist, and neither does the
`config/measurements/golden-outcome.yaml` or `schemas/golden-outcome/` it depends on.

## Decision

Emit `schemaVersion: "5.1.0"`, with `goldenMetrics` **present and explicitly
`UNAVAILABLE`**: four items, one per stable Golden ID, all values null, each carrying the
reason.

## Why

`supplementation_v9.md` §2.2 gives the supplement temporary precedence over exactly the
passages it names, until the v9.1 release is sealed. §15 names this migration. So on the
face of the authority rules, 5.1.0 wins.

§2.3 makes it decisive rather than merely preferable:

> A partial state in which, for example, the Catalogue defines Golden Metrics while Status
> still rejects the branch is not a releasable documentation baseline.

`DEV-P1-18/19/20` already migrated the catalogue to v6 with 100 active coordinates. The
Catalogue half of that atomic transaction is complete. Emitting `5.0.0` would deliberately
construct the state §2.3 forbids, and would guarantee a rewrite of every consumer once the
other half landed.

The `UNAVAILABLE` branch is not a workaround for the absent backend — it is what the
branch's own contract prescribes for exactly this situation. §9.1 requires a migrated
snapshot to carry "an explicit `UNAVAILABLE` migration state and no invented metric
values". §9.4 requires one item per Golden ID and states that "a non-applicable or
unavailable metric is represented by an explicit item, not omission". §9.8 clause 8 adds
that missing values never become zero or a healthy state.

## Alternatives considered

**Emit 5.0.0 and omit the branch.** Follows the Status Contract's own header literally.
Rejected: it ignores the supplement's stated precedence, and it constructs the §2.3
half-state whose other half is already built. It also defers rather than avoids the work —
the branch arrives eventually, and every 5.0.0 body written in the interim needs migrating.

**Emit 5.1.0 but omit the branch until a backend exists.** Attractive because it avoids
carrying a structure with nothing in it. Rejected: §9.4 is explicit that omission is not a
permitted representation of an unavailable metric, and the reason is sound — an absent key
and a stated unavailability are read very differently by an automated consumer, and only
one of them is checkable.

**Emit 5.1.0 with the branch populated from placeholder or zero values.** Rejected
without hesitation. §9.8 clause 8 and Status §18 both forbid it, and a zero in a Golden
slot is precisely the kind of number an operator would act on.

**Wait for the v9.1 pack to be sealed and build against that.** Rejected: sealing v9.1
requires the recovered `CLUE_Constitution_v8.md` bytes, which are outstanding on the
Creator's side. Blocking implementation on a documentation release that is itself blocked
would stall Cluster C indefinitely, and the decision is determinable now from the authority
rules already in force.

## Affected contracts

- `CLUE_Status_Contract_v9.md` §3 (top-level structure) and §19 (versioning)
- `supplementation_v9.md` §9 in full, §14.4 (release validation), §15 (integration matrix)
- `CLUE_Canonical_Measurement_Catalogue_v9.md` — the other half of the atomic transaction,
  already migrated
- `CLUE_Project_Directory_v9.md` §19.2 — the schema owner this decision is realised in

## Migration implications

**For this repository.** `STATUS_SCHEMA_VERSION` is `'5.1.0'` and the schema rejects any
other value, so a 5.0.0 body cannot be parsed as a status snapshot. No 5.0.0 bodies exist
yet — Status had no machine owner before `DEV-P1-10` — so there is nothing to migrate.

**When a Golden backend arrives.** `src/metrics/golden/` and
`src/status/goldenMetricsProjection.ts` populate the branch; `projectionState` moves from
`UNAVAILABLE` to `READY` or `PARTIAL`; `definitionSet` becomes non-null; the seal's
`goldenDefinitionHash` becomes non-null (`supplementation_v9.md` §9.6). None of that is a
schema change — the shapes are already declared — so no version bump is required.

**When the v9.1 pack is sealed.** The Status Contract document itself should be corrected
to state 5.1.0 in its header and §3. Until then this ADR is the record of why the code and
the document disagree, and the disagreement is deliberate rather than an oversight.

**For downstream consumers.** None exist yet. The dashboard consumes
`ConsoleSnapshot`, not Status — see ADR-0002, which addresses that.

## Consequences

Accepted: the code leads the permanent documentation on one field, and anyone reading
`CLUE_Status_Contract_v9.md` alone will find a version that does not match the producer.
That cost is real and is mitigated only by this record and by the module header of
`src/status/statusContractV5.ts`, which carries the same reasoning inline.

Gained: the catalogue and Status agree, the atomic transaction §2.3 requires is coherent
from the implementation side, and no consumer is committed to a migration that was
foreseeable at the time of writing.

## Verification

`selftest/status-contract.test.ts` proves the version is `5.1.0`, that a `5.0.0` body is
refused, that the Golden branch carries exactly four unique stable IDs, and that an item
stating no result cannot also report a value. `selftest/status-seal.test.ts` proves the
last of those again from the seal's consistency evaluation, so the rule holds whether the
body is validated or sealed.
