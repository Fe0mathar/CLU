# ADR-0008 — Cycle module filenames: camelCase, and §18's pending amendment

**Status:** accepted — decision **D2** of the cycle implementation plan, taken by the
Creator 2026-08-10 in the batch acceptance of D1–D5. This document is the durable record
of a decision that until now lived only in session history — the exact failure mode this
system exists to prevent, repaired here.
**Date of record:** 2026-08-10
**Applies to:** `src/cycle/` module filenames; `CLUE_Project_Directory_v9.md` §18.2's
informative listing

---

## 1. Context

Directory §18.2 lists the cycle modules in PascalCase — `CycleOrchestrator.ts`,
`CycleRegistry.ts`, and siblings. Every module in the tree is camelCase (`mission.ts`,
`statusProjector.ts`, `claimRegistry.ts`, `navigatorEvents.ts`), and ADR-0003 established
the governing precedent: when a rule of practice supersedes the Directory's informative
text, the practice is recorded and the Directory is amended — the document follows the
decided reality, not the other way around.

## 2. Decision (as accepted)

Cycle modules are named in camelCase, matching the tree. §18.2's listing is to be amended
to the decided names.

## 3. The names as built

The decision is already enacted in code; this table is the record's evidence, measured
from the tree on the date of record:

| §18.2 as sealed | As built | State |
|---|---|---|
| `CycleRegistry.ts` | `src/cycle/cycleRegistry.ts` | built, suite-pinned |
| `CycleInputLock.ts`¹ | `src/cycle/cycleInputLock.ts` | built, suite-pinned |
| `CycleOrchestrator.ts` | `src/cycle/cycleOrchestrator.ts` | built, suite-pinned |
| `ResumePlanner.ts`¹ | `src/cycle/resumePlanner.ts` | built, suite-pinned |
| `NextCycleVitalInput.ts`¹ | `src/cycle/nextCycleVitalInput.ts` | pending (deferred slice) |

¹ Where §18.2's sealed text and the plan name the module differently in detail, the
accepted plan's module set governs; the amendment will reconcile the listing to the five
names in the middle column.

## 4. Application — deferred, deliberately

Amending §18.2 is a **governed pack change**: an edit to a sealed document, a
`SHA256SUMS_v9.txt` re-seal, a `DOCUMENTATION_MANIFEST_v9.json` revision entry, and a
ratification that thereby goes stale until the Creator re-ratifies — exactly the
DEV-P2-03 shape. Churning the seal for one listing is poor stewardship of the
ratification ceremony, so the amendment **batches with the next Directory change** (the
ADR-0003 rev 2 §7 replacement took the same route before its batch landed).

## 5. Honesty while unapplied

Until the amendment lands, the sealed Directory and the tree disagree on these names.
The reading order is: **this record governs the filenames; §18.2's listing is informative
and known-stale on exactly this point.** Doctor's `manifest ↔ seal` line stays green
throughout, because the seal covers the Directory as it currently is — the disagreement
is between the sealed text and the decided practice, not between the disk and the seal,
and this paragraph is where that disagreement is stated rather than discovered.
