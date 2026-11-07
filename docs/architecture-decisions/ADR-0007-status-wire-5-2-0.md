# ADR-0007 — Status wire 5.2.0: the `cycle` branch becomes backed

**Status:** accepted — D1–D3 taken as proposed by the Creator, 2026-08-11 (scope: `cycle` only; closure carries `unmetCount`; bump taken now)
**Date:** 2026-08-10
**Owner:** the Status wire (`src/status/statusContractV5.ts`), under ADR-0001's versioning
authority and the governed contract `CLUE_Status_Contract_v9.md` §19
**Trigger:** DEV-P2-08 S7. The `cycle` branch has carried
`unsupported — no owning domain in this build` since 5.1.0. The owning domain now exists,
runs, and has closed a cycle; the S7-interim override made the *reason* truthful, and this
ADR is the recorded step that makes the *data* possible.

---

## 1. The procedure this follows

The DEV-P1-51 note inside the contract module records the law: giving a
`BranchUnavailable` branch a populated variant is **a schema change, a
`STATUS_SCHEMA_VERSION` bump, and ADR-0001 territory** — and it was deferred there partly
because the v9 pack was unratified. That precondition cleared on 2026-08-10: the pack is
ratified (`authority.pack_ratified`) and the evidence epoch sealed (`authority.epoch_sealed`).
Contract §19 classifies additive optional structure as a **minor** version. This revision is
exactly that: `5.1.0 → 5.2.0`, one branch gaining a typed variant, nothing changed or
removed.

## 2. Scope — one branch, deliberately

Three branches were candidates. Two are declined, on ADR-0004's own principle — deferring
`startStop`, it wrote: *"splitting it would mean designing a representation for `phase`
against a domain with no behaviour."* The same test applies here:

- **`aiOrchestration` stays `unsupported`.** §9's surface is the gateway's story — sessions,
  calls, budgets, roles, refutation relationships. The gateway is disabled and no
  orchestration domain runs; a backed branch of zeros would imply a domain that observed
  zeros. Its typed shape belongs to DEV-P2-09's own ADR, designed against real behaviour.
- **`proofPipeline` stays `unsupported`.** §10's ten dispositions are the candidate loop's
  vocabulary, and no finding has ever entered that loop. Its shape belongs with DEV-P2-11.
- **`cycle` becomes backed.** Its domain exists (`src/cycle/`: registry, lock, orchestrator),
  its truth is durable (the `cycles` projection; `cycle.*` events), and it has behaviour to
  report: a first closure, honestly unmet, at EVENT-015224. This is the branch with a
  backend waiting, not a representation in search of one.

The S7-interim reason overrides for the two deferred branches continue to state exactly
this, naming their arrival items.

## 3. The typed shape

Camel-case on the wire, matching every existing backed branch. Additive union alongside
`BranchUnavailable`:

```ts
const cycleCurrentSchema = z
  .object({
    id: z.string().min(1),
    stage: z.enum([
      'OPENED', 'INPUTS_LOCKED', 'OPENING_EVIDENCE', 'RECOGNIZED', 'SCREENED',
      'CANDIDATES', 'CLOSING_EVIDENCE', 'HANDOFF', 'CLOSED', 'SUSPENDED',
    ]),
    grade: z.enum(['diagnostic', 'proof-authoritative']).nullable(),
    lockDigest: sha256.nullable(),
    suspendedFrom: z.string().nullable(),
    openedAt: isoTimestamp,
    updatedAt: isoTimestamp,
  })
  .strict();

const cycleClosureSchema = z
  .object({
    cycleId: z.string().min(1),
    closedAt: isoTimestamp,
    grade: z.enum(['diagnostic', 'proof-authoritative']),
    criteriaMet: z.boolean(),
    unmetCount: z.number().int().nonnegative(),
    stageReached: z.string().min(1),
  })
  .strict();

const cycleBranchSchema = z
  .object({
    state: z.literal('backed'),
    current: cycleCurrentSchema.nullable(),
    lastClosure: cycleClosureSchema.nullable(),
    freshness: freshnessSchema,
  })
  .strict();
```

**`unmetCount`, not the list.** The §24 reasons live in the closure event and the handoff
artifact — evidence-side, where they are sealed and complete. The wire carries the verdict
and its weight; a consumer wanting the reasons follows the cycle id into evidence. This
keeps the branch lean without hiding that anything is unmet (§2: the count *is* the honest
emptiness, made countable). Decision D2 below.

Both `current` and `lastClosure` nullable, independently: a fresh workspace is
`{backed, null, null}` — backed and truthfully empty, which is the contract's founding
distinction between "the domain answers: nothing yet" and "no domain answers".

## 4. Consequences across the build

- `statusContractV5.ts` — the schema above; `STATUS_SCHEMA_VERSION = '5.2.0'`; `cycle`
  moves from `UNSUPPORTED_BRANCHES` to `BACKED_BRANCHES` (the census partition test
  enforces exactly this pairing, which is why it cannot be done quietly).
- `statusProjector.ts` — populates from the projection and the log: `readCurrentCycle`
  plus the latest `cycle.closed` payload. The closed-event scan currently private to
  doctor (`latestClosedCycle`) moves to `cycleRegistry.ts` as the shared reader; doctor
  and the projector consume one implementation.
- The `cycle` entry leaves the S7-interim override table — its reason dissolves because
  the data arrives, which was the override's stated end state.
- Tests — the census partition, the contract round-trips, and every pin on `'5.1.0'`
  move together; sealed 5.1.0 snapshots in history remain valid under §19's minor rule
  and are not migrated.
- The console projector's §9/§10 notes are untouched; nothing local changes.

## 5. Acceptance criteria

1. `status export` on a workspace with a live cycle carries
   `cycle.state = 'backed'` with the current row's id/stage/grade/lockDigest.
2. On the twin (no live cycle, one closure): `current: null`,
   `lastClosure.criteriaMet: false`, `unmetCount: 9`, and the branch's freshness bound.
3. On a virgin workspace: `{backed, null, null}`.
4. The capability declaration reports `contractVersion: '5.2.0'` with `cycle` among
   `backedBranches`; the census partition test passes with the moved name.
5. Doctor's cycle line and the branch agree on the same underlying readers.

## 6. Decisions requested from the Creator

- **D1** — scope: 5.2.0 types `cycle` only; `aiOrchestration`/`proofPipeline` defer to
  DEV-P2-09/DEV-P2-11's own ADRs.
- **D2** — the closure carries `unmetCount`, with the reasons remaining evidence-side.
- **D3** — take the bump now (the branch lands next slice) rather than batching with a
  future revision.

Accepted 2026-08-11 with all three as proposed; the implementation slice followed immediately.
