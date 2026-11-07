# CLU-E Project Profiles — Batch 4 Recognition, SURF/DIVE, Host and Git

**Document class:** implementation receipt and operating boundary  
**Batch:** 4 of 8  
**Patch scope:** PP-19 through PP-22  
**Architecture scope:** post-P2 Project Profiles  
**Activation state:** implementation only; no profile migration, activation, live workspace adoption, Git synchronization, or P2 ceremony

## 1. Purpose

Batch 4 makes the active Project Profile identity operational across four boundaries that could
otherwise leak or misattribute state:

1. static recognition, snapshots, incremental cache, physical inventory and graph artifacts;
2. Q1 SURF/DIVE replay and live Navigator events;
3. the PowerShell host process and every host request/response;
4. Git repository readiness and explicit manual synchronization.

The shared rule is:

```text
projectId
+ targetRootIdentity
+ projectProfileHash
+ profileGeneration
+ recognitionConfigHash
```

must identify the active project generation before project-scoped recognition or visualization
state is reused. Host and Git operations use the stable Project Operation Identity subset:

```text
projectId
+ targetRootIdentity
+ projectProfileHash
```

A missing, stale or mismatched identity is a refusal, never an inferred match.

## 2. PP-19 — Project-scoped recognition

### 2.1 Recognition authority

`src/control/projectProfiles/projectRecognition.ts` resolves the profile-owned recognition input:

- Target Root;
- source roots;
- excluded paths;
- build/compiler configuration;
- configured adapters;
- recognition policy;
- deterministic recognition configuration hash;
- exact Project Profile generation.

The current static runtime supports the JavaScript/TypeScript adapter family. Configured adapters
that are not available are surfaced explicitly. A profile with no supported static adapter is
blocked instead of silently running a different recognition mode.

Source roots are resolved inside the canonical Target Root and must exist as directories. The
build/compiler configuration must exist as a file. Exclusions use deterministic project-relative
semantics: a simple name such as `dist` excludes matching path segments at any depth, while a
path such as `src/generated` excludes only that exact subtree. The same exclusions are applied to
both physical snapshot capture and semantic recognition, preventing SURF/DIVE parity drift.

The snapshot implementation records symlinks but does not follow them. Therefore
`followSymlinks=true` is refused until a later implementation can prove governed traversal parity.

### 2.2 Recognition identity

`src/shared/projectRecognitionIdentity.ts` defines:

```text
clue-project-recognition-identity/1
```

containing:

```text
operationIdentity
profileGeneration
recognitionConfigHash
```

The identity is strict, deterministic, secret-safe and hashable. It participates in:

- snapshot capture basis;
- recognizer basis;
- scan-cache planning and merge artifacts;
- recognition result artifacts;
- full-repository inventory identity;
- repository-inventory pointers;
- System Navigator events and graph pointers;
- daemon graph/run attribution.

A profile-bound reader refuses legacy identity-free artifacts and artifacts from another project or
profile generation.

### 2.3 Reuse and invalidation

Reactivating an unchanged profile generation reproduces the same recognition identity. Its durable
snapshot, recognition result, physical inventory and Navigator pointer remain reusable.

The following change the identity and invalidate predecessor cache/pointer reuse:

- Project ID;
- physical Target Root identity;
- Project Profile hash/generation;
- source roots;
- excluded paths;
- compiler/build configuration;
- adapter selection;
- recognition policy.

A changed recognition identity produces the explicit full-rescan reason:

```text
recognition-configuration-changed
```

Switching away and back does not itself force a full recognition. Reuse is governed by exact
identity and content parity, not by UI navigation history. When a profile explicitly sets
`fullScanOnActivation=true`, only a run explicitly marked as the activation run is forced to scan
fully; ordinary later runs remain eligible for incremental reuse.

## 3. PP-20 — SURF/DIVE project-generation rebinding

### 3.1 Durable pointer parity

Repository inventory and graph pointers carry the exact recognition identity. Readers may require
an expected identity; mismatch returns no pointer rather than stale state.

The daemon only attributes a run ID when all of these agree:

```text
snapshotId
resultHash
project recognition identity
```

### 3.2 Dashboard generation guard

Q1 maintains one active project/recognition generation guard. Identity fields must be read from one
coherent direct/governed recognition identity; unrelated nested fields are never assembled into an
apparent match. A project switch is accepted only after explicit authorization for that exact profile
generation and at a new stream boundary such as reset or inventory start. Before Project B is
published, Project A's physical and semantic state is cleared. After B is active:

- late Project A events are ignored;
- older profile generations are ignored;
- legacy identity-free events are ignored for a profile-bound stream;
- Project B cannot inherit A's stream seal or console revision;
- a console frame carrying Project B cannot be paired transiently with Project A Status;
- cancelling a pending activation reauthorizes the current generation but requires a fresh replay
  boundary before its projection is shown again;
- switching back to unchanged A may replay A's own durable pointer/state.

The latest Q1 visual behavior is preserved. Batch 4 modifies `app.js` only at the project-generation
integration seam.

### 3.3 Operational Console identity

The backend console projection exposes the exact active Project Recognition Identity under the
project configuration view. Legacy single-project startup reports `null` rather than inventing a
profile identity.

## 4. PP-21 — PowerShell/Host readiness

### 4.1 Explicit states

The Project Profile Host readiness service reports exactly:

```text
READY
UNAVAILABLE
INVALID PATH
HANDSHAKE FAILED
ROOT MISMATCH
```

It validates before launch:

- effective PowerShell executable, resolving a bare command such as `pwsh.exe` through the supplied
  `PATH`/`PATHEXT` environment while requiring path-qualified values to name a real file;
- host script;
- Target Root identity;
- workspace root;
- shadow root;
- browser profile root;
- exact Project Operation Identity.

### 4.2 Session and request binding

A profile-bound Host Client passes `-ProjectIdentityJson` at process startup. The host pins the
strict identity and requires every request envelope to carry the same identity. The host echoes the
identity on every response. The client independently validates response identity.

A missing or mismatched identity fails with:

```text
PROJECT_IDENTITY_MISMATCH
```

Root, path and zone parity checks remain in force. Project identity is additive and does not weaken
existing command, argument, path, capability or landing-ref restrictions.

### 4.3 Legacy compatibility

The pre-profile host path remains available when no Project Operation Identity is supplied. A
profile-bound client will never accept an unbound host, and an unbound client will never silently
attach to a profile-bound host.

## 5. PP-22 — Git readiness and explicit synchronization

### 5.1 Readiness is local and side-effect free

`inspectProjectGitReadiness` performs local validation only. It never fetches, pushes, merges or
contacts a remote endpoint. It validates:

- repository root is an existing directory;
- repository root resolves to the selected Target Root;
- Git is available;
- the root is a worktree and its reported top-level matches;
- current branch/HEAD/worktree state;
- default branch syntax;
- optional current base pin;
- remote/provider/publication-mode consistency;
- optional protected landing policy path.

Git base pins accept both current Git object formats:

```text
40 lowercase hex characters  (SHA-1 repositories)
64 lowercase hex characters  (SHA-256 repositories)
```

### 5.2 Local-only state

Both `NO_REMOTE_YET` and `LOCAL_ONLY` are valid local states. They report:

```text
READY_LOCAL_ONLY
localOperationsReady = true
publicationReady = false
```

This enables local recognition, proof, Great Book and optimization without publication.

### 5.3 Explicit synchronization

`manualProjectGitSync` requires the caller's expected Project Operation Identity. A stale identity is
refused before Git is spawned. Local-only profiles are refused before Git is spawned and no remote
is contacted.

For `REMOTE_REGISTERED`, the explicit sync path preserves the existing fail-closed behavior:

- dirty worktree refused;
- detached HEAD refused;
- diverged history refused;
- behind-only history fast-forwards;
- ahead-only history pushes;
- unchanged history performs no landing action.

`START CLU-E` does not call this function. Git synchronization remains a distinct operator action.

## 6. Files

### Created

```text
src/shared/projectRecognitionIdentity.ts
src/control/projectProfiles/projectRecognition.ts
src/control/projectProfiles/hostReadiness.ts
src/control/projectProfiles/gitReadiness.ts
selftest/project-recognition-fixture.ts
selftest/project-recognition-isolation.test.ts
selftest/project-recognition-reuse.test.ts
selftest/surf-dive-project-switch.test.ts
selftest/project-host-readiness.test.ts
selftest/project-git-readiness.test.ts
ui/clue-dashboard/test/activeProjectIdentity.test.mjs
ui/clue-dashboard/test/q1ProjectSwitch.test.mjs
docs/project-profiles/PROJECT_RECOGNITION_RUNTIME.md
docs/project-profiles/PROJECT_RUNTIME_CONNECTION_READINESS.md
```

### Modified

```text
scripts/clue-host.ps1
src/analysis/source/graph.ts
src/analysis/source/navigatorEvents.ts
src/analysis/source/recognizer.ts
src/analysis/source/repositoryInventory.ts
src/analysis/source/scanCache.ts
src/analysis/source/snapshot.ts
src/control/projectProfiles/index.ts
src/control/projectProfiles/projectRuntimeBinding.ts
src/control/recognitionRun.ts
src/daemon/consoleStateCollector.ts
src/daemon/runtimeRegistrySource.ts
src/experiment/host/hostClient.ts
src/integration/git/manualGitSync.ts
src/shared/schemas.ts
src/status/statusFromRuntime.ts
src/ui/consoleProjector.ts
src/ui/viewModel.ts
ui/clue-dashboard/app.js
ui/clue-dashboard/quadrants/q1Navigator.js
ui/clue-dashboard/state/statusStore.js
selftest/host-handshake.test.ts
selftest/host-ps1-git-params.test.ts
selftest/runtimeRegistrySource.test.ts
ui/clue-dashboard/test/statusStore.test.mjs
docs/project-profiles/PROJECT_PROFILE_ACCEPTANCE_PLAN.md
```

## 7. Safety and non-claims

Applying Batch 4 does not:

- edit `config/clue.config.yaml`;
- create, migrate, select or activate a Project Profile;
- adopt or rewrite `F:\CLU\workspace\clue`;
- write to `F:\CLU\shadow\clue`;
- run recognition;
- launch PowerShell;
- execute Git;
- contact a Git remote;
- change the Metric Catalogue;
- configure an OpenAI key;
- ratify documents, open `P2-authoritative`, run proof or close P2.

Browser target governance and GPT readiness belong to Batch 5. Backend APIs/CLI activation belong to
Batch 6. The complete Configuration UI belongs to Batch 7.

## 8. Validation receipt

The final Batch 4 source tree was validated on Node.js `v22.16.0` in the packaging environment:

```text
TypeScript typecheck                         PASS
Production build                             PASS
Focused Batch 4 tests                         53 total
                                               48 pass
                                                5 skipped (live pwsh unavailable)
                                                0 fail
Repository selftest files                    115/115 pass
Repository selftests                         789 total
                                              783 pass
                                                6 skipped
                                                0 fail
Dashboard tests                              141/141 pass
System Navigator                              12/12 pass
Operational Console                           11/11 pass
Great Book Improvement Field                 PASS
Four Neon Gauges                             PASS
```

The six repository skips are five live-PowerShell cases unavailable on the Linux packaging host and
one pre-existing Windows-only path-case test. They remain explicit Windows installation gates; no
skip is represented as a pass.
