# ADR-0016 — self-target proof relocation and fail-closed P2 closure control

**Status:** implementation candidate for Creator ratification  
**Date:** 2026-08-14  
**Owner:** Experiment plane / governance read model / P2 closure

## Context

P2 engineering reached a vertical slice in which CLU-E can freeze a Proof Contract, bind a
baseline, execute a candidate, record a deterministic verdict, update Great Book memory and
render the durable result. The remaining reference target is CLU-E itself.

The registered `clu-master` harness legitimately invokes `clue` commands as child processes.
At the same time, `clue proof` must hold the canonical writer lock for the complete proof arm.
Running those children against the canonical configuration would therefore ask them to acquire
the lock their parent intentionally holds. ZIP 01 correctly refused this lock inversion, but
that refusal also made a real self-target proof-authoritative P2 cycle impossible.

P2 also lacked one machine decision that could distinguish:

- engineering defects;
- a missing Creator activation/deferral decision;
- outstanding ratification/epoch acts;
- missing live proof-cycle evidence; and
- a genuinely closed phase.

A Markdown ledger alone cannot make those distinctions authoritative.

## Decision 1 — relocate only the self-target instrument plane

`src/experiment/proof/executionCoordinator.ts` detects physical identity between the CLU-E
repository root and the selected target root. For that case only, after the exact candidate
patch is applied to a leased shadow, it rewrites the **shadow copies only** of:

```text
config/clue.config.yaml
targets/<active-target>/profile.yaml
```

The relocated profile points `project.root` at the candidate shadow. The relocated installation
configuration points `workspace.root` and `shadow.root` at lease-local sibling directories
outside the measured candidate tree. The shadow CLI is built and initialized before the
registered Master Benchmark runs.

Consequences:

- benchmark child `clue` processes use a different event log and projection store;
- the canonical writer lock remains held by the parent proof act without deadlock;
- canonical config/profile/source bytes are unchanged;
- candidate changes to either relocation authority are refused before execution;
- the before/after SHA-256 identities of the ephemeral relocation are included in the proof
  verdict payload;
- relocation files are instrument-plane changes, not candidate changes and never land.

This is not a Git worktree lease, publication, landing authority or a substitute for the P4
Git lifecycle. It is the narrow isolation needed to measure CLU-E as an ordinary local target.

## Decision 2 — exact candidate lease identity

A persistent proof shadow is reusable only when one marker binds all of:

```text
frozen contract hash
source snapshot identity
exact patch digest
```

The patch is validated and content-addressed before shadow mutation. A changed candidate or
source snapshot creates/reconstructs a distinct lease. The candidate patch is applied before
dependency installation so a candidate lockfile governs its own dependencies. `dist/` is
removed before static preparation so deleted or renamed source cannot survive as stale output.

## Decision 3 — P2 closure is a read-only computed result

`src/closure/p2ClosureAssessment.ts` owns a versioned closure read model. It consumes:

- sealed Status 5.6.0 and its capability census;
- the durable Proof Board and registered Master Benchmark integrity;
- verified `authority.pack_ratified` and `authority.epoch_sealed` records;
- the current Great Book gap/entry counts and last cycle closure;
- the explicit target `NO_REMOTE_YET` publication decision; and
- `config/policies/p2-closure.yaml`, which is part of the mission basis.

The endpoint `/api/p2-closure` is read-only and `no-store`. It reports exactly one state:

```text
ENGINEERING_BLOCKED
AWAITING_CREATOR_DECISION
READY_FOR_CEREMONY
CLOSED
```

The assessment performs no mutation. In particular it cannot ratify documents, seal an epoch,
activate a gateway, execute a benchmark/proof, close a cycle, write a release, or manufacture
an ACCEPT.

## Decision 4 — D4 cannot be defaulted

The shipped closure policy remains:

```text
PENDING_CREATOR_DECISION
```

The Creator may later record one of two honest states:

- `SAFE_DISABLED_DEFERRED` — gateway engineering accepted; routes, budgets, provider traffic
  and spend remain deliberately disabled beyond P2; or
- `OPERATIONAL` — exact routes, model/price identities, positive caps and credential environment
  are approved and the live gateway is operationally ready.

The decision is mission-bound. Merely installing the Model Gateway does not close D4.

## Decision 5 — phase scope enters the cycle lock by policy hash

`config/policies/p2-closure.yaml` is included in both the mission basis and the cycle
`policy_files` identity. Before a closure policy exists, the lock retains the historical
structural absences. With the policy installed:

- `PENDING_CREATOR_DECISION` remains a lock absence;
- `SAFE_DISABLED_DEFERRED` removes the model-provider absence only while the live gateway is
  actually disabled;
- `OPERATIONAL` removes it only while `gateway.enabled` is true; and
- the Project Intent Model and environment adapters are not counted as missing P2 inputs when
  their explicit P3 deferrals are bound by the policy hash.

This is what makes a zero-absence P2 lock reachable without pretending that P3 capabilities
exist. A dashboard statement cannot change the grade; changing phase scope changes policy bytes,
registers a successor mission and moves the lock digest.

## Decision 6 — governance reads do not take writer authority

Rare governance events are read through `EventLog.replayReadOnly(eventsDir)`. The method:

- acquires no lock and performs no write;
- ignores an unterminated, therefore uncommitted tail;
- verifies every committed record hash, sequence and chain link; and
- may operate while the real writer retains its lock.

A current epoch must stand on the latest current ratification and the current pack seal. An old
epoch whose name happens to be `P2-authoritative` cannot satisfy closure after documentation
moves on.

## P3 deferrals

The Project Intent Model compiler (`AMB-003`) and environment adapter registry remain explicit
P3 work. The P2 closure assessment names those deferrals and does not reinterpret them as P2
engineering failures.

## Acceptance

1. TypeScript typecheck and production build pass.
2. A self-target proof fixture executes its benchmark from the relocated shadow, records
   `ACCEPT`, and leaves canonical config/profile/source byte-identical.
3. A candidate touching relocation authority is refused.
4. Exact candidate leases are bound to contract, snapshot and patch identities.
5. Read-only governance replay works while the writer lock remains owned and refuses edited
   history.
6. `/api/p2-closure` is `no-store` and never reports CLOSED for a pending policy/tree.
7. The pure closure decision refuses engineering contradictions, Creator-policy contradictions,
   stale governance and missing proof/Great Book/cycle evidence independently.
8. A pending D4 policy keeps the cycle diagnostic; an explicit safe-disabled decision plus
   the two P3 deferrals can produce a true zero-absence P2 lock.
9. Proof/Great Book evidence counts only when it belongs to the latest closed cycle and current
   mission; historical success cannot close a moved world.
10. The Project Directory, manifest and pack seal are updated and require a new Creator
    ratification before closure.

## 2026-08-14 supersession note

ADR-0017 supersedes Decision 4's shipped `PENDING_CREATOR_DECISION` state. The Creator selected
`OPERATIONAL`, exact model `gpt-5.6`, OpenAI Platform budget authority, no local monetary
enforcement, controlled pause after explicit provider billing exhaustion, and provider-only
remaining-token authority. All other ADR-0016 decisions remain in force.
