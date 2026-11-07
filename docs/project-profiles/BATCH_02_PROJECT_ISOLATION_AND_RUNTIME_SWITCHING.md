# CLU-E Project Profiles — Batch 2 Project Isolation and Runtime Switching

**Document class:** implementation receipt and safety contract  
**Batch:** 2 of 8  
**Implemented patches:** PP-09, PP-10, PP-11 runtime seam, PP-12  
**Status:** implementation complete in this patch; production activation remains explicit

## 1. Purpose

Batch 2 turns the Batch 1 Project Profile record into a physically isolated runtime context without changing the currently shipped startup selection automatically.

It establishes four guarantees:

1. one project workspace has one durable physical owner;
2. event, artifact and projection services can be bound to one governed project identity;
3. one validated profile record can assemble one complete real runtime generation;
4. a long-running process can switch Project A to Project B through one publication barrier with deterministic rollback.

## 2. Implemented ownership model

`src/memory/db.ts` owns a non-projection singleton:

```text
workspace_project_identity
```

It binds:

```text
projectId
targetRootIdentity
profileVersion
initialProfileHash
createdAt
origin
legacyProjectionHeadHash
legacyIndexedEvents
```

The singleton is not cleared by projection rebuild and is not included in projection digests. A successor profile hash may use the same workspace only when the stable Project ID and physical Target Root identity still match. The initial hash remains historical provenance.

Missing ownership has three explicit policies:

```text
reject
initialize-new
adopt-legacy
```

No ordinary activation silently adopts an existing database. Existing CLU history requires the dedicated `adoptLegacyWorkspaceForProfile` path, which records the pre-adoption projection head/count without rewriting history.

## 3. Project-scoped memory services

`EventLog` and `ArtifactStore` accept an optional bound `ProjectOperationIdentity`.

A caller that supplies an operation identity is checked against the bound project before append/read/write work. The physical namespace remains the primary isolation boundary; identity checks additionally reject stale request contexts crossing an active-project generation.

The implementation deliberately does not duplicate `projectId` into every event or blob row. Separate project workspaces already provide strict physical partitioning.

## 4. Runtime binding

`resolveProjectRuntimeBinding` performs these checks before opening project state:

```text
strict Project Profile record parse
projectProfileHash recomputation
live physical Target Root identity match
supported global-default / project-override keys
credential reference form
```

It materializes the existing internal `ClueConfig` shape from:

```text
installation-level v2 defaults
+
explicit durable clue-project-profile/1 record
```

The runtime then opens exactly the profile-owned:

```text
databasePath
eventLogRoot
artifactStoreRoot
workspaceRoot
shadowRoot
```

and exposes:

```text
projectProfile
projectIdentity
projectState
profileMode
```

Legacy callers that do not supply `projectProfile` follow the pre-existing v2 startup path unchanged.

## 5. Atomic runtime manager

`ProjectRuntimeManager` owns exactly one published runtime generation.

Activation order is:

```text
load target record
→ open and identity-check target runtime
→ validate target receipts
→ move durable registry pointer
→ build immutable publication receipt
→ publish target generation in memory
→ dispose previous runtime
```

New operation leases are refused during startup/switching. Any active lease blocks switching. A stale expected identity is rejected.

The publication receipt binds:

```text
runtime generation
Project ID
Target Root identity
Project Profile hash/profile generation
registry generation
physical database identity
Great Book identity
Target Root
inventory/snapshot identity
workspace root
activation timestamp
```

Database, Great Book and inventory identities are deterministic hashes of the relevant project/state bindings rather than display strings.

## 6. Failure behavior

Fault injection is implemented at:

```text
after-target-profile-load
after-target-runtime-open
before-registry-activation
after-registry-activation
before-runtime-publication
```

Before the pointer moves, failure leaves the previous generation active. After the pointer moves, the manager restores the previous pointer/generation. If restoration cannot be proven, it enters `BLOCKED` and publishes no mixed runtime.

Out-of-band registry mutation is checked before every new lease/switch:

- an update with the same governed profile hash refreshes generation metadata safely;
- a changed project, target identity or behavior-bearing profile hash blocks the manager;
- operations never continue under a registry/runtime contradiction.

## 7. Legacy workspace adoption

The explicit helper:

```text
adoptLegacyWorkspaceForProfile(record)
```

is allowed only for a profile whose provenance is:

```text
legacy-target-profile
```

It does not run when this ZIP is extracted. It does not create, move, clear or reinterpret `F:\CLU\workspace\clue` automatically.

## 8. Deliberate configuration-cutover boundary

The file-by-file strategy originally placed the shipped `config/clue.config.yaml` v3 cutover in PP-11. This patch intentionally provides the complete explicit runtime seam first but does **not** replace the current v2 startup configuration.

Reason: changing the installation startup selector before the backend API/CLI activation surface exists would create a partially operable control plane. The v3 loader/config cutover is therefore moved to the Backend API + CLI batch, where profile creation, migration, activation, recovery and status can be exposed together and tested as one deployable generation.

Consequences of applying Batch 2:

```text
existing startup behavior remains unchanged
no profile is activated automatically
no registry path is created automatically
no legacy workspace is adopted automatically
explicit code/tests can open and switch profile runtimes
```

## 9. Acceptance evidence

Automated Batch 2 tests:

```text
selftest/workspace-project-identity.test.ts
selftest/project-state-isolation.test.ts
selftest/project-profile-runtime.test.ts
selftest/project-switching.test.ts
```

They prove:

- new workspace ownership initialization;
- ownership survives projection rebuild;
- successor profile hash does not rewrite origin;
- wrong-project and wrong-target reuse is refused;
- legacy adoption records the existing head/count and preserves projections;
- Project A events/artifacts/projections are absent from Project B;
- stale event/artifact request identities are refused;
- real `openRuntime` assembly uses profile-owned state;
- read-only profile runtime reopens an already bound workspace;
- the legacy v2 runtime remains unchanged;
- all five switch identities publish together;
- switch-back reuses durable ownership/state identity;
- active operation leases block switching;
- every injected transition failure preserves A or blocks clearly;
- out-of-band behavior changes block stale runtime use.

## 10. Non-claims

Batch 2 does not yet claim:

```text
HTTP or CLI Project Profile management
automatic v3 configuration selection
project authority drift/mission/proof binding
Great Book logical-content isolation acceptance
recognition/SURF/DIVE rebind
Host/Git/Chrome/GPT readiness
Configuration UI
P2 formal closure
```

Those remain assigned to later batches.
