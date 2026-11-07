# CLU-E Project Profiles — Acceptance Plan

**Document class:** executable acceptance matrix  
**Status:** Batches 1–4 backend foundations implemented; later-batch browser/GPT/API/UI gates reserved  
**Scope:** complete Configuration Project Profiles supplement

## 1. Acceptance principles

- Backend enforces hard invariants; UI evidence alone is insufficient.
- Every persisted object is strict, versioned and secret-safe.
- Canonical physical identity, not path spelling, defines a target.
- Project switching is accepted only when all project-scoped state changes atomically.
- `NO_REMOTE_YET` is a valid local-only state.
- Fault-injection evidence is required at durable transaction boundaries.
- Windows-specific path, junction, PowerShell and Chrome behavior receives a final Windows run.

## 2. Batch 1 automated matrix

| Patch | Owner files | Automated acceptance |
|---|---|---|
| PP-01 Path identity | `src/shared/pathIdentity.ts` | dot/dot-dot, relative/absolute, slash/case rules, symlink/junction alias, missing/file/foreign path refusal, physical zone overlap, UNC/device-prefix normalization |
| PP-02 Operation identity | `src/shared/projectOperationIdentity.ts` | strict deterministic envelope, frozen output, missing/unknown/secret refusal, stale/cross-project mismatch |
| PP-03 Profile schema | `src/shared/schemas.ts` | exact version, Project ID grammar, absolute durable paths, authority kind/order/ID/path rules, state containment, integration contradictions, raw secret refusal |
| PP-04 Canonicalization/hash | `profileCanonicalization.ts`, `profileHash.ts` | key/order stability, transient/display exclusion, behavior changes move hash, credential reference bound, authority hash bound, secret rejection, tamper detection |
| PP-05 Store | `profileStore.ts` | create/read/list, optimistic concurrency, malformed/hash/noncanonical refusal, pre/post-replace fault behavior, temp cleanup, delete confirmation and target/workspace preservation |
| PP-06 Registry | `profileRegistry.ts` | unique ID/root, owner-naming duplicate error, active pointer parity, active update, deletion, physical alias refusal, state containment, registry tamper detection, four-boundary crash recovery |
| PP-07 Events | `profileEventLog.ts` | sequence/hash chain, replay, secret redaction, idempotent event transaction, tamper/incomplete-tail refusal, live/dead lock behavior |
| PP-08 Migration | `profileMigration.ts` | read-only plan, exact CLU mapping, no workspace movement, create/activate, repeated no-op, interrupted activation recovery, legacy byte conflict, malformed/ambiguous/missing input refusal |

Test files:

```text
selftest/project-root-identity.test.ts
selftest/project-operation-identity.test.ts
selftest/project-profile-schema.test.ts
selftest/project-profile-hash.test.ts
selftest/project-profile-store.test.ts
selftest/project-profile-registry.test.ts
selftest/project-profile-events.test.ts
selftest/project-profile-migration.test.ts
```

## 3. Batch 2 automated matrix

| Patch | Owner files | Automated acceptance |
|---|---|---|
| PP-09 Workspace identity | `src/memory/db.ts`, `src/shared/schemas.ts` | new-workspace initialization, rebuild preservation, successor-hash preservation, wrong project/target refusal, explicit legacy adoption with pre-adoption head/count, read-only refusal |
| PP-10 State services | `src/memory/eventLog.ts`, `src/memory/artifactStore.ts` | physical A/B separation and stale operation-identity refusal |
| PP-11 Runtime seam | `src/control/runtime.ts`, `projectRuntimeBinding.ts` | real writable/read-only profile runtime, exact profile hash and live target verification, profile-owned state roots, unchanged legacy v2 path |
| PP-12 Atomic switching | `projectRuntimeManager.ts`, `projectActivation.ts` | one generation, lease barrier, five-identity publication, switch-back reuse, five fault points, rollback, wrong-workspace refusal, out-of-band drift blocking |

Batch 2 test files:

```text
selftest/workspace-project-identity.test.ts
selftest/project-state-isolation.test.ts
selftest/project-profile-runtime.test.ts
selftest/project-switching.test.ts
```

The automatic installation-config v3 selector is deliberately moved to the Backend API + CLI batch so migration, activation and recovery become deployable together. Batch 2 keeps the current v2 startup path unchanged and exposes an explicit profile-bound runtime seam.

## 4. Supplement Definition-of-Done mapping

| Requirement | Planned completion batch | Acceptance evidence |
|---|---:|---|
| Multiple profiles persisted | 1 | registry/store tests with distinct projects |
| Editable/unique Project ID | 1 backend, 7 UI | schema/registry tests; UI interaction test later |
| Selectable Target Root | 7 | platform picker plus backend physical validation |
| Duplicate canonical Target Root forbidden | 1 | alias and owner-naming registry tests |
| Saved Projects dropdown | 7 | UI plus metadata API tests |
| Whole-context project switch | 2 | switching fault-injection matrix |
| Isolated SQL/project state | 2 | workspace identity and cross-project DB tests |
| Isolated Great Book | 3 | A ACCEPT absent in B, preserved on return |
| Isolated recognition cache/snapshot | 4 | A/B inventory and cache identity tests |
| Per-project Target Description | 1 schema, 3 validation, 7 UI | binding/hash/drift/UI tests |
| Per-project Master Benchmark | 1 schema, 3 validation, 7 UI | binding/hash/runtime consistency tests |
| Project Intent / Constraints | 1 schema, 3 authority, 7 UI | optional binding and conflict tests |
| Multiple Additional Documents | 1 schema, 3 authority, 7 UI | role/order/enabled/hash tests |
| Governed document drift detection | 3 | old/new SHA, stale mission/proof tests |
| Project-scoped recognition settings | 1 schema, 4 runtime | activation/reuse tests |
| PowerShell/Host settings/readiness | 4 | executable, handshake, root-parity matrix |
| Git settings/readiness | 4 | valid repo, root match, explicit local-only tests |
| Chrome settings/readiness | 5 | endpoint/target/origin/ambiguity/evidence tests |
| GPT settings/readiness and secret safety | 1 secret boundary, 5 runtime | exact model/no fallback/sanitized API tests |
| Metric Catalogue unchanged | 7/8 regression | existing catalogue/UI regression tests |
| Project-scoped benchmark runtime | 1 schema, 3/5 execution | command/scenario/browser consistency tests |
| Global default vs override explicit | 1 schema, 7 UI | source union and visual provenance tests |
| Operation-specific readiness | 5 | capability matrix tests |
| Deterministic version/hash | 1 | hash test suite |
| Profile identity in mission/proof | 3 | stale identity/refusal tests |
| SURF/DIVE switch with project | 4 | A/B projection reset/replay tests |
| No mixed state | 2 | publication barrier and fault injection |
| Reuse unchanged recognition state | 4 | switch away/back incremental test |
| Backend owns invariants | all | API negative tests and direct-backend tests |

## 5. Batch 1 completion gate

Batch 1 is acceptable only when:

```text
npm run typecheck
npm run build
all eight Batch 1 test files pass
full npm run selftest passes
npm run dashboard:verify passes with latest Q1 files unchanged
npm run navigator:verify passes
```

The patch ZIP must contain project-relative paths, a SHA-256 manifest and no generated `dist`, workspace, node_modules, credential, or runtime-state files.

## 6. Batch 2 completion gate

Batch 2 is acceptable only when:

```text
npm run typecheck
npm run build
all four Batch 2 test files pass
all Batch 1 Project Profile test files remain green
full selftest regression passes
npm run dashboard:verify passes with latest Q1 files unchanged
npm run navigator:verify passes
```

The patch must not change `config/clue.config.yaml`, execute migration/adoption, create an active profile, or include workspace/runtime state.

## 7. Windows acceptance gate

Before production migration/cutover, run on the real Windows installation:

- case and slash aliases for `F:\CLU\CLU`;
- junction/reparse aliases to the same target;
- UNC normalization if supported by the installation;
- exact physical disjointness of target/workspace/shadow/profile store/browser profile;
- preservation of `F:\CLU\workspace\clue` byte identity and history;
- PowerShell executable and host-script path handling;
- file fsync/atomic replace/lock behavior on the actual filesystem;
- interrupted migration recovery at every registry transaction boundary.

## 8. Batch 1/2 non-claims

Batches 1 and 2 do not yet claim:

- automatic installation startup from the active profile;
- SURF/DIVE switching or logical Great Book/recognition/proof isolation;
- complete authority drift/conflict reasoning;
- backend HTTP endpoints or CLI commands;
- Host, Git, Chrome or GPT live readiness;
- Configuration UI;
- P2 machine closure.

Those are intentionally covered by later batches and must not be inferred from foundation tests.

## 7. Batch 3 automated gates

| Capability | Evidence |
|---|---|
| deterministic live Project Authority manifest and disabled-document exclusion | `selftest/project-authority-binding.test.ts` |
| path/hash drift and proof-readiness refusal | `selftest/project-authority-binding.test.ts`, `selftest/authority-drift-stales-proof.test.ts` |
| structural and explicit semantic conflict blocking | `selftest/project-authority-conflict.test.ts` |
| conflict resolution requires an actually active successor generation | `selftest/project-authority-conflict.test.ts` |
| exact authority bytes in mission and AI context | `selftest/mission-profile-binding.test.ts` |
| Project Governance Basis in cycle input lock | `selftest/mission-profile-binding.test.ts` |
| ACCEPT/Great Book project identity parity and isolation | `selftest/great-book-project-isolation.test.ts` |
| Proof Contract/baseline/candidate/verdict/closure project isolation | `selftest/proof-cycle-project-isolation.test.ts` |
| project-scoped Benchmark Runtime and Master Benchmark consistency | `selftest/project-benchmark-runtime.test.ts` |
| legacy v1 proof/Great Book records remain readable | existing proof, cycle, closure, and Great Book regression suite |

Batch 3 acceptance requires the complete Batch 1 and Batch 2 focused suite because it extends the
same profile schemas, runtime binding, state isolation, mission, cycle, proof, and projection
surfaces. It also requires full repository, dashboard, Navigator, Operational Console, Great Book
field, and gauge verification.

Batch 3 does not activate a Project Profile or close P2. Operator-facing migration/activation and
automatic startup selection remain deferred to the coordinated Backend API + CLI batch.

## 9. Batch 4 automated gates

| Patch | Capability | Primary evidence |
|---|---|---|
| PP-19 | exact profile recognition configuration and identity; existing source roots/build file; deterministic nested exclusions | `selftest/project-recognition-isolation.test.ts`, `selftest/project-recognition-reuse.test.ts` |
| PP-19 | snapshots, cache, graph and inventory refuse cross-project/profile reuse | recognition isolation/reuse tests plus existing snapshot/cache/inventory regressions |
| PP-20 | graph/inventory pointers and Q1 streams require one coherent, explicitly authorized project generation | `selftest/surf-dive-project-switch.test.ts`, `selftest/runtimeRegistrySource.test.ts`, `ui/clue-dashboard/test/activeProjectIdentity.test.mjs`, `ui/clue-dashboard/test/q1ProjectSwitch.test.mjs` |
| PP-20 | Status store clears prior target revision/seal and never pairs a successor frame with predecessor Status | `ui/clue-dashboard/test/statusStore.test.mjs` |
| PP-21 | Host executable/script/root/identity readiness ladder, including `PATH`/`PATHEXT` resolution | `selftest/project-host-readiness.test.ts` |
| PP-21 | Project identity pinned in startup argv, request and response | `selftest/host-handshake.test.ts`, `selftest/host-ps1-git-params.test.ts` |
| PP-22 | repository/Target Root/base/branch/publication validation | `selftest/project-git-readiness.test.ts` |
| PP-22 | `NO_REMOTE_YET` is local-ready and contacts nothing | `selftest/project-git-readiness.test.ts`, `selftest/manual-git-sync.test.ts` |

Batch 4 also requires the complete pre-existing repository selftest suite because it changes
recognition basis schemas, graph artifact reads, Host wire envelopes, Git base-pin validation,
Status/console projection and Q1 generation behavior.

## 10. Batch 4 Windows gate

The delivery environment can verify the TypeScript Host client and inspect the PowerShell source.
The real Windows installation must additionally execute:

```text
profile-bound clue-host.ps1 startup
matching ProjectIdentityJson handshake
missing/mismatched identity refusal
Target/Workspace/Shadow root mismatch refusal
PowerShell executable/global-default resolution
Git worktree/root parity under F:\CLU\CLU
NO_REMOTE_YET readiness with no network contact
```

PowerShell-specific live tests are skipped only when `pwsh` is unavailable; the skip is an
explicit target-host gate, not a pass claim.

## 11. Batch 4 non-claims

Batch 4 does not claim:

- browser process/session/target readiness or capture evidence;
- GPT credential/model readiness;
- combined operation-specific Project Readiness;
- Configuration HTTP APIs or CLI activation;
- complete Project Profiles UI;
- live profile migration/activation;
- P2 ratification, proof ACCEPT, Great Book closure entry or Creator closure approval.


## 12. Batch 5 automated gates

| Patch | Capability | Primary evidence |
|---|---|---|
| PP-23 | deterministic Page ID / exact URL / unique-origin resolution and ambiguity refusal | `selftest/browser-target-resolution.test.ts` |
| PP-23 | dedicated managed-browser state, origin and project-generation binding | `selftest/project-browser-launch-script.test.ts` |
| PP-24 | immutable request/response/receipt hashes, secret boundary and tamper detection | `selftest/browser-execution-evidence.test.ts` |
| PP-25 | Project A park, Project B activate, rollback and active-registration protection | `selftest/project-browser-switching.test.ts` plus runtime-manager regressions |
| PP-26 | exact model, no fallback, credential reference, provider authority and controlled pause | `selftest/project-gateway-readiness.test.ts` |
| PP-26 | transport error redaction and project/generation terminal binding | `selftest/gateway-secret-redaction.test.ts`, `selftest/gateway-project-identity.test.ts`, existing gateway suite |
| PP-27 | `READY`, `READY_LOCAL_ONLY`, `INCOMPLETE`, `BLOCKED`, `INVALID` and capability combinations | `selftest/project-readiness.test.ts` |
| PP-28 | strict Status 5.8.0 branch, seal/history/projector/console and P2 closure version parity | `selftest/project-profile-status.test.ts` plus Status regression suite |

Batch 5 also requires the complete repository selftest suite because it changes BrowserAgent,
Gateway events/projections, runtime switching, Status schema/projection/seal and P2 closure wire
validation.

## 13. Batch 5 live Windows gate

The packaging environment does not claim a live Chrome or OpenAI connection. On the real Windows
installation, the operator must additionally prove:

```text
dedicated profile launch and exact state-file reuse
unrelated DevTools endpoint refusal
multiple matching tabs -> TARGET AMBIGUOUS
wrong origin and disappeared page refusal
one governed execution -> one valid evidence pair
Project A browser parked before Project B publication
OPENAI_API_KEY resolved only from the environment
provider reachable with requestedModel = effectiveModel = gpt-5.6
no fallback
provider funding exhaustion -> controlled PAUSE
Status 5.8.0 and Operational Console show one coherent active project generation
```

## 14. Batch 5 non-claims

Batch 5 does not claim:

- Configuration HTTP APIs or CLI project activation;
- automatic profile migration/adoption or startup cutover;
- a live browser/provider test in the packaging environment;
- Configuration UI;
- P2 ratification, authoritative proof ACCEPT, Great Book closure entry or Creator approval.
