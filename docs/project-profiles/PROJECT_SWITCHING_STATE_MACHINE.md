# CLU-E Project Profiles — Atomic Project Switching State Machine

**Document class:** post-P2 runtime design  
**Status:** Batch 2 runtime core implemented; later subsystem/readiness participants remain pending  
**Implementation:** `projectRuntimeManager.ts` + `projectActivation.ts`

## 1. Safety objective

Selecting Project B must never expose a mixed generation in which the UI names Project B while database, Great Book, recognition cache, proof state, SURF, DIVE, Host root or browser target still belongs to Project A.

The durable `active.json` pointer and runtime publication barrier are now coordinated by `ProjectRuntimeManager`. A pointer changed outside that coordinator is detected before the next operation; a behavior-bearing contradiction blocks the runtime.

## 2. States

```text
INACTIVE
ACTIVE(projectIdentity, runtimeGeneration)
QUIESCING(sourceIdentity)
PERSISTING_SOURCE(sourceIdentity)
LOADING_TARGET(targetIdentity)
VALIDATING_TARGET(targetIdentity)
PUBLISHING_TARGET(targetIdentity, runtimeGeneration)
BLOCKED(reason, lastSafeIdentity)
ROLLING_BACK(lastSafeIdentity)
```

Only `ACTIVE` permits project-scoped write operations. Transition states refuse new writes and allow only the transition coordinator's bounded work.

## 3. Requested transition

```text
ACTIVE A
  ↓ request B + expected A identity
QUIESCING A
  ↓ refuse new A writes; wait/cancel governed in-flight operations
PERSISTING_SOURCE A
  ↓ checkpoint A state and release A-scoped handles
LOADING_TARGET B
  ↓ load exact profile record, workspace identity, DB, Great Book, inventory and caches
VALIDATING_TARGET B
  ↓ validate authority, roots, Host/Git/Chrome/GPT capability required for intended operation
PUBLISHING_TARGET B
  ↓ atomically publish one runtime generation and rebind projections/UI
ACTIVE B
```

The durable profile registry mutation must be coordinated with this runtime transaction. The final visible active identity is published only after every mandatory subsystem has acknowledged the same Project ID, Target Root identity and profile hash.

## 4. Quiescence

Before switching away from A:

- reject new project-scoped writes;
- identify in-flight proof, cycle, landing, recognition and browser operations;
- refuse switching while an operation is noninterruptible;
- otherwise cancel or checkpoint only through the operation's governed semantics;
- flush database/event/artifact writes;
- persist A's latest durable inventory and state;
- invalidate process-local handles after checkpoint.

A stale request carrying A's prior profile hash must fail after B publishes.

## 5. Target loading

Loading B must resolve from the backend registry, not browser form state. It must verify:

```text
Project ID
physical Target Root identity
projectProfileHash
profile generation
workspace durable identity
project-state database identity
Great Book scope
recognition snapshot identity
authority hashes
required runtime integration identity
```

Cached objects must be keyed by the full governed project identity or recreated. No singleton may remain implicitly bound to A.

## 6. Publication barrier

The runtime coordinator assembles an immutable generation snapshot. Each participating subsystem returns a receipt naming the same target identity. Only then may the coordinator atomically replace the active runtime reference and emit one project-activated runtime event.

UI reads the published snapshot. It must not independently switch its Project ID before the backend publishes.

## 7. Failure and rollback

Before publication, any failure leaves A active or returns to A through `ROLLING_BACK`. If A cannot be safely restored, the system enters `BLOCKED` with no project-scoped writes enabled.

After publication, a later optional capability failure changes operation-specific readiness; it does not silently switch back. A mandatory identity contradiction blocks the project and requires governed repair.

No rollback may reuse partially loaded B state as A state.

## 8. Same-project reactivation

Re-selecting the already active exact profile is an idempotent no-op unless a governed refresh is explicitly requested. If only display/transient validation data changed and the profile hash is unchanged, the manager may refresh the published receipt without replacing project-scoped runtime resources. A behavior-relevant profile-hash change must be coordinated through the governed profile update/activation transaction. If such a change appears out of band while the current manager is active, the manager fails closed and enters `BLOCKED` rather than exposing a mixed generation.

## 9. Incremental recognition rule

Switching back to unchanged B loads B's durable inventory and recognition snapshot, checks target changes, and recognizes only invalidated units. A full scan is not triggered solely because another project was active in between, unless B's recognition policy or durable basis requires it.

## 10. Acceptance evidence

Later acceptance tests must capture, before and after a switch:

```text
database identity
Great Book identity
Target Root identity
inventory snapshot identity
projectProfileHash
SURF project identity
DIVE project identity
Host root
browser target identity where required
```

All must change from A to B as one published generation. Fault injection at every transition boundary must prove no mixed visible state and deterministic recovery.


## 11. Batch 2 implementation mapping

The implementation uses externally visible manager states:

```text
INACTIVE
STARTING
ACTIVE
SWITCHING
BLOCKED
DISPOSED
```

`SWITCHING` internally covers quiescence, target loading, validation, pointer publication and in-memory publication. Leases are the Batch 2 quiescence primitive: a switch is refused while any project operation holds one. Later proof, recognition, browser and landing services must execute through these leases or a stricter governed-operation coordinator.

The manager stages Project B while Project A remains published. The old runtime is disposed only after B has a matching registry pointer, workspace identity, event-log identity, artifact-store identity and immutable publication receipt.

Batch 2 publishes database, Great Book and inventory/snapshot **scope identities**. Later batches attach the logical Great Book, recognition and proof services themselves and extend the receipt with their durable heads.

The shipped installation still starts through the existing v2 target selector. Automatic active-profile startup is intentionally deferred until the Backend API/CLI batch can ship migration, activation and recovery as one complete control surface.
