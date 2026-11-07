# CLU-E — File-by-File Strategy for Full P2 Closure and Project Profiles Completion

**Strategy version:** 1.0  
**Prepared:** 14 August 2026  
**Inspected project baseline:** `CLU(20260814-144249).zip`  
**P2 authority:** `CLUE_P2_FORMAL_CLOSURE_HANDOFF(1).md`  
**Post-P2 authority candidate:** `CLUE_CONFIGURATION_PROJECT_PROFILES_SUPPLEMENT_2026-08-14(1).md`  
**Live installation:** `F:\CLU\CLU`  
**Durable workspace:** `F:\CLU\workspace\clue`  
**Shadow:** `F:\CLU\shadow\clue`

---

## 1. Executive decision

Full completion must be executed as **two strictly serial programmes**.

```text
PROGRAMME A — FORMALLY CLOSE P2
    exact final tree
    → operational OpenAI gateway
    → frozen and ratified authority
    → P2-authoritative epoch
    → one real durable proof cycle
    → real ACCEPT
    → atomic Great Book entry
    → proof-authoritative cycle closure
    → machine state CLOSED
    → explicit Creator approval

PROGRAMME B — IMPLEMENT THE PROJECT PROFILES SUPPLEMENT
    approved post-P2 authority baseline
    → profile schema/store
    → atomic project activation
    → project-scoped state and authority
    → runtime integrations
    → readiness
    → API/CLI/UI
    → full isolation and switching acceptance suite
    → new governed documentation release
```

The programmes must not be interleaved.

The Configuration supplement explicitly applies to the **post-P2 architecture** and is currently a **proposed normative implementation supplement**. It must influence closure discipline now, but its multi-project implementation must not be pulled into the P2 proof cycle. P2 itself is already described as engineering-complete and ready for authoritative closure; unrelated features, Q1 redesign, and P3 work are outside that closure scope.

### 1.1 Definition of “full completion” in this strategy

This strategy calls the work complete only when both milestones have been reached:

#### Milestone A — P2 formally closed

```text
ratificationCurrent = true
epochName = P2-authoritative
epochCurrent = true
proofAttempts >= 1
verdicts >= 1
accepts >= 1
greatBookEntries >= 1
lastCycleGrade = proof-authoritative
lastCycleCriteriaMet = true
formalClosurePass = true
p2Closed = true
closureState = CLOSED
Creator explicitly approves P2 closure
```

#### Milestone B — Project Profiles supplement complete

All Definition-of-Done items from the Configuration supplement pass, including:

- multiple durable Project Profiles;
- unique editable Project ID;
- unique canonical Target Root;
- atomic full-context switching;
- isolated state, Great Book, recognition, proof and cycles;
- governed authority documents and drift detection;
- project-scoped recognition and benchmark runtime;
- PowerShell, Git, Chrome and GPT readiness;
- credential secrecy and exact-model enforcement;
- deterministic profile version/hash in governed operation identity;
- SURF/DIVE rebinding without mixed state;
- backend-enforced invariants;
- complete acceptance tests.

---

## 2. Rules that govern every step

### 2.1 Final-baseline rule

The inspected archive is a planning baseline, not yet the authoritative closure baseline. The next complete archive supplied by the Creator becomes the proposed final tree. Before any write to live closure state, it must be compared against this inspected archive and all P2-relevant changes must be explained.

### 2.2 Green-build rule

“File by file” means every file has a named owner, purpose and order. It does **not** mean intentionally producing broken intermediate commits. Where a schema change requires a service and a test to change together, those files form one atomic patch unit. Every patch unit must end with a green typecheck/build and its focused tests.

### 2.3 No manual truth rule

No JSON file, UI field, Markdown report or operator statement may invent:

- a ratification;
- an epoch;
- a verdict;
- an ACCEPT;
- a Great Book contribution;
- a proof-authoritative cycle closure;
- machine P2 closure.

Those states must come from the existing durable event/projection pipeline. The human statement is required only after the machine state is actually closed.

### 2.4 No secret rule

`OPENAI_API_KEY` must never enter:

- the repository;
- YAML or profile JSON;
- proof contracts or candidate manifests;
- logs or screenshots;
- browser requests;
- evidence bundles;
- Great Book;
- generated reports.

Only the reference `env:OPENAI_API_KEY` may be persisted.

### 2.5 No silent fallback rule

The requested and effective model must both be exactly:

```text
gpt-5.6
```

An unavailable model is a refusal, not permission to substitute another model.

### 2.6 Local-only is valid

The first authoritative P2 cycle remains:

```text
remote = null
publicationState = NO_REMOTE_YET
localOnly = true
publicationPermitted = false
```

This permits local recognition, proof, Great Book and closure. `START CLU-E` must not synchronize Git.

### 2.7 Authority drift rule

After ratification and epoch sealing:

- do not edit active normative documents;
- do not edit the Master Benchmark;
- do not edit behavior-relevant configuration;
- do not edit the canonical source tree manually;
- do not adjust proof thresholds after observing candidate results.

Any such change makes the current authority/proof basis stale and requires a new ratification and epoch.

---

## 3. Current inspected architecture and ownership map

The current archive already contains the principal P2 closure machinery.

| Concern | Existing owner files |
|---|---|
| Installation and target choice | `config/clue.config.yaml`, `targets/clu/profile.yaml` |
| P2 operational policy | `config/policies/p2-closure.yaml`, `routing.yaml`, `budget.yaml`, `patching.yaml` |
| Authority/mission binding | `src/control/mission.ts`, `src/control/runtime.ts`, `src/shared/schemas.ts` |
| Ratification and epoch | `src/cli/commands/docsCommands.ts`, `src/cli/commands/epochCommands.ts` |
| Model gateway | `src/ai/gateway/policy.ts`, `modelGateway.ts`, `openaiAdapter.ts`, `gatewayProjection.ts` |
| Proof contract and verdict | `src/proof/proofContract.ts`, `baselineRegistry.ts`, `verdict.ts` |
| Proof execution | `src/experiment/proof/executionCoordinator.ts`, `src/cli/commands/proofCommands.ts` |
| Cycle state and closure | `src/cycle/cycleInputLock.ts`, `cycleRegistry.ts`, `cycleOrchestrator.ts`, `proofClosure.ts`, `resumePlanner.ts` |
| Great Book | `src/greatBook/greatBookEntry.ts`, `greatBookProjection.ts` |
| Durable memory | `src/memory/db.ts`, `eventLog.ts`, `artifactStore.ts` |
| Formal P2 assessment | `src/closure/p2ClosureAssessment.ts`, `src/control/p2ClosurePolicy.ts` |
| Dashboard/API | `src/daemon/clueDashboardServer.ts`, `proofBoardProjection.ts`, `ui/clue-dashboard/*` |
| Master Benchmark | `targets/clu/benchmark/master-benchmark.md`, `src/benchmark/benchmarkRunner.ts` |
| Status/release evidence | `src/status/*`, `tools/release.mjs`, `tools/p0-acceptance.mjs` |

### 3.1 Existing single-project precursor

`targets/clu/profile.yaml` already identifies:

- `projectId = clu`;
- target root `F:/CLU/CLU`;
- source/document roots and excludes;
- `NO_REMOTE_YET`;
- Target Description;
- Master Benchmark.

This is a valid single-target precursor for closing P2. It is **not** the complete `clue-project-profile/1` multi-project control plane required by the supplement.

### 3.2 Current inspected validation result

On the inspected archive:

- TypeScript typecheck passed.
- Dashboard tests passed `118/118`.
- System Navigator verification passed `12/12`.
- A full selftest could not be treated as authoritative in the Linux analysis environment because the bundled `better-sqlite3.node` binary is Windows-native. The complete build/selftest/benchmark must therefore be run fresh on the live Windows installation.
- `clue-status.md` is generated historical output and must be regenerated after closure; it must not be used as current truth during preflight.

---

## 4. Evidence and working-directory layout

Do not place ceremony inputs or generated evidence into the frozen canonical repository after ratification. Use the preserved external workspace.

```text
F:\CLU\workspace\clue\closure\P2-authoritative\
├── 00-preflight\
├── 01-authority\
├── 02-proof-inputs\
├── 03-proof-results\
├── 04-machine-closure\
├── 05-release\
└── 06-creator-approval\
```

Recommended files:

```text
00-preflight\P2_FINAL_TREE_INVENTORY.json
00-preflight\P2_PRE_CEREMONY_READINESS.json
00-preflight\P2_COMMAND_TRANSCRIPT.txt

01-authority\P2_ACTIVE_AUTHORITY_MANIFEST.json
01-authority\P2_DEFERRED_POST_P2_MANIFEST.json
01-authority\P2_CLOSURE_CONTEXT.json
01-authority\RATIFICATION_RECEIPT.json
01-authority\EPOCH_RECEIPT.json

02-proof-inputs\proof-contract.json
02-proof-inputs\candidate-patch.json
02-proof-inputs\candidate-rollback.json
02-proof-inputs\candidate-screening.json

03-proof-results\proof-attempt.json
03-proof-results\verdict.json
03-proof-results\great-book-reference.json
03-proof-results\cycle-close-reference.json

04-machine-closure\p2-closure.json
04-machine-closure\status.json
04-machine-closure\final-browser-probe.json

05-release\release.zip
05-release\release.zip.sha256
05-release\p0-acceptance-report.json
05-release\clue-status.md

06-creator-approval\P2_CREATOR_APPROVAL.txt
06-creator-approval\P2_FORMAL_CLOSURE_RECEIPT.json
```

`P2_CLOSURE_CONTEXT.json` is a transitional closure evidence artifact, not a claim that the post-P2 Project Profile implementation already exists. Use a truthful schema name such as:

```text
clue-p2-closure-context/1
```

It should bind, without secret bytes:

```text
projectId
targetRootIdentity
workspaceRoot
shadowRoot
activeTargetProfileHash
authorityManifestHash
masterBenchmarkHash
credentialReference = env:OPENAI_API_KEY
provider = openai
requestedModel = gpt-5.6
publicationState = NO_REMOTE_YET
readiness = READY_LOCAL_ONLY
```

---

# PROGRAMME A — FORMAL P2 CLOSURE

## 5. A0 — Receive and freeze the final candidate tree

### Objective

Establish one exact, explainable source tree before any ratification or proof action.

### Procedure

1. Receive the final complete project archive after the Creator’s last update.
2. Extract it to a clean comparison directory, not over the live installation.
3. Compare it against the inspected archive at file path, size and SHA-256 level.
4. Classify every changed file as:
   - intended final update;
   - generated output;
   - historical package residue;
   - accidental conflict;
   - P3/post-P2 work that must be removed or deferred.
5. Resolve every P2-relevant conflict before installing the final tree.
6. Copy/install the accepted tree to `F:\CLU\CLU`.
7. Stop parallel edits.
8. Generate `P2_FINAL_TREE_INVENTORY.json` with path, size and SHA-256 for all closure-relevant files.

### Hard stop

Do not continue if:

- the intended Q1/SURF update is missing;
- `ui/clue-dashboard/app.js` is not the accepted version;
- an unreviewed normative document is active;
- the current Master Benchmark changed without review;
- any P3 implementation entered the P2 tree;
- the repository, workspace or shadow roots differ from the confirmed paths.

---

## 6. A1 — P2 file-by-file freeze and validation map

The following table defines what to do with each current owner file before the ceremony.

### 6.1 Root, package and installation files

| File | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `package.json` | **VERIFY + FREEZE** | Scripts still expose `typecheck`, `build`, `selftest`, `p0:acceptance`, `dashboard:verify`, `navigator:verify`; no surprise lifecycle hook or remote action. | SHA captured; `npm run typecheck` and `npm run build` pass. |
| `package-lock.json` | **VERIFY + FREEZE** | Lockfile matches `package.json`; no unexplained dependency drift. | `npm ci` or existing governed install completes on Windows; lock hash captured. |
| `tsconfig.json` | **VERIFY + FREEZE** | Compiler settings are the same basis used by recognition and build. | `tsc --noEmit` passes. |
| `.gitignore` | **VERIFY + FREEZE** | Workspace, secrets, browser profiles and generated evidence are not accidentally versioned. | No secret/evidence path becomes trackable. |
| `CLUE-Dashboard.bat` | **VERIFY + FREEZE** | Starts the current backend, builds when intended, does not auto-sync Git. | Dashboard starts against `F:\CLU\workspace\clue`; no network Git operation. |
| `scripts/clue-host.ps1` | **VERIFY + FREEZE** | Restricted host handshake and root authority match current project/shadow roots. | Host tests and root-parity tests pass on Windows. |
| `scripts/launch-test-browser.ps1` | **CONDITIONAL VERIFY** | Required only if the selected proof or final probe uses the managed browser flow. | Exact configured Chrome/debug endpoint works; otherwise classify browser proof as not required for candidate. |

### 6.2 Installation configuration and policies

| File | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `config/clue.config.yaml` | **VERIFY + FREEZE** | `active_target: clu`; workspace and shadow exact; OpenAI enabled; `api_key_env: OPENAI_API_KEY`; no key bytes; PowerShell/Chrome paths current. | Config schema passes; runtime resolves one coherent target; hash captured. |
| `targets/clu/profile.yaml` | **VERIFY + FREEZE** | `id: clu`; root `F:/CLU/CLU`; `NO_REMOTE_YET`; correct Target Description and Master Benchmark bindings. | No root drift; publication is explicit local-only; hash captured. |
| `config/policies/p2-closure.yaml` | **VERIFY + FREEZE** | Exact model and operational closure rules remain aligned with the handoff. | Policy loads with no contradiction; hash captured. |
| `config/policies/routing.yaml` | **VERIFY + FREEZE** | Required route uses exact `gpt-5.6`; route is enabled; no fallback route. | Gateway status reports exact model. |
| `config/policies/budget.yaml` | **VERIFY + FREEZE** | OpenAI Platform is budget authority; no local dollar cap blocks activation. | `budgetAuthority = openai_platform`; local enforcement false. |
| `config/policies/patching.yaml` | **VERIFY + FREEZE** | Candidate writes remain constrained to the shadow/proof process; canonical writes remain protected. | Candidate manifest cannot traverse or write outside allowed target paths. |
| `config/measurements/catalogue.yaml` and catalogue authority files | **VERIFY + FREEZE** | Metric Catalogue remains valid and unchanged by the supplement. | Catalogue validation and parity tests pass. |

### 6.3 Governing documents and seals

| File | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `CLUE_Constitution_v9.md` | **VERIFY + FREEZE** | Exact tracked file and seal entry. | SHA matches `SHA256SUMS_v9.txt`. |
| `RPI_Core_Methodology_v9.md` | **VERIFY + FREEZE** | Same. | SHA matches. |
| `CLUE_AI_Utilization_v9.md` | **VERIFY + FREEZE** | OpenAI/gateway authority and proof use remain current. | SHA matches. |
| `CLUE_Git_Integration_v9.md` | **VERIFY + FREEZE** | Local-first/explicit synchronization boundary remains current. | SHA matches. |
| `CLUE_Canonical_Measurement_Catalogue_v9.md` | **VERIFY + FREEZE** | Measurement authority unchanged. | SHA matches. |
| `CLUE_Status_Contract_v9.md` | **VERIFY + FREEZE** | Status 5.7.0 expectations align with runtime. | SHA matches and status tests pass. |
| `CLUE_Q1_System_Navigator_v9.md` | **VERIFY + FREEZE** | Current Q1/SURF implementation does not contradict tracked authority. | SHA matches and Navigator tests pass. |
| `CLUE_Architecture_v9.md` | **VERIFY + FREEZE** | Runtime/mission/proof ownership remains aligned. | SHA matches. |
| `CLUE_Execution_Model_v9.md` | **VERIFY + FREEZE** | Proof-authoritative cycle and closure semantics remain aligned. | SHA matches. |
| `CLUE_Interface_Design_v9.md` | **VERIFY + FREEZE** | This is the tracked interface authority unless the final archive intentionally promotes another version through a coordinated pack update. | SHA matches. |
| `CLUE_Project_Directory_v9.md` | **VERIFY + FREEZE** | Current file ownership and CLI decomposition remain aligned. | SHA matches. |
| `DOCUMENTATION_MANIFEST_v9.json` | **VERIFY + FREEZE** | Every permanent/tracked entry agrees with the seal and installed file. | Manifest validation passes. |
| `SHA256SUMS_v9.txt` | **VERIFY + FREEZE** | Every declared hash passes. | `clue doctor --deep` reports installed authority healthy. |
| `DOCUMENTATION_GOVERNANCE_v9.md` | **VERIFY + FREEZE** | Ratification and amendment rules remain the process authority. | No unresolved governance contradiction. |
| `VALIDATION_REPORT_v9.md` | **PRESERVE AS RELEASE EVIDENCE** | Do not treat historical validation as replacement for fresh runtime evidence. | Retained, but fresh tests are run. |
| `README_v9.md` | **PRESERVE** | Navigation only; do not silently make it mission authority. | Pack/manifest classification remains correct. |
| `CLUE_Interface_Design_v10.md` and older duplicate document versions | **CLASSIFY, DO NOT SILENTLY RATIFY** | Determine whether each is historical residue, a future draft, or an intended final authority update. | Only the files explicitly bound by config/mission enter P2 ratification. Any intended promotion requires a coordinated manifest/seal update before freeze. |
| `CLUE_CONFIGURATION_PROJECT_PROFILES_SUPPLEMENT_2026-08-14.md` | **HASH AS DEFERRED POST-P2 AUTHORITY** | Preserve exact bytes, document class, post-P2 scope and proposed status. Do not add it to the active P2 proof basis. | Appears in `P2_DEFERRED_POST_P2_MANIFEST.json`, `activeForP2Proof=false`. |

### 6.4 Target authority and benchmark

| File | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `target description.md` | **VERIFY + FREEZE** | Exists, hashes correctly, and remains the current CLU-E target context. | Mission binds exact hash. |
| `targets/clu/benchmark/master-benchmark.md` | **VERIFY + FREEZE** | Harness integrity passes; benchmark ID/version and mandatory signals remain current; no change after proof results. | Benchmark validation succeeds and opening benchmark can execute on Windows. |
| `src/benchmark/harnessBlock.ts` | **VERIFY + FREEZE** | Canonical harness extraction/integrity logic unchanged. | Benchmark unit tests pass. |
| `src/benchmark/benchmarkRunner.ts` | **VERIFY + FREEZE** | Executes the registered benchmark with environment fingerprint, repetitions, warmup and evidence. | `selftest/benchmark-runner.test.ts` passes; benchmark preflight succeeds. |
| `src/control/benchmarkRun.ts` | **VERIFY + FREEZE** | Runtime uses the registered benchmark and current mission/cycle basis. | Cycle input lock sees benchmark as present/current. |

### 6.5 Configuration, runtime and authority binding

| File | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `src/shared/schemas.ts` | **VERIFY + FREEZE** | Current v2 config/profile schemas reject malformed or mixed roots. Do not add post-P2 Project Profiles here before closure. | Config identity/path/zone tests pass. |
| `src/control/runtime.ts` | **VERIFY + FREEZE** | Resolves `targets/clu/profile.yaml`, exact workspace/shadow roots and one coherent active target. | Runtime opens the preserved live workspace; no root mismatch. |
| `src/control/mission.ts` | **VERIFY + FREEZE** | Mission binds tracked docs, target profile, target description, benchmark and policy/config authority exactly as implemented. | Current mission hash is stable between repeated read-only checks. |
| `src/control/contextBuilder.ts` | **VERIFY + FREEZE** | AI context uses current governed basis; no deferred supplement silently enters it. | Context-spine tests pass. |
| `src/shared/evidenceIdentity.ts` | **VERIFY + FREEZE** | Evidence identity remains current mission/epoch/snapshot bound. | Evidence identity and epoch tests pass. |
| `src/shared/commandContext.ts` | **VERIFY + FREEZE** | Command operations use one runtime identity. | Command authority tests pass. |
| `src/shared/durableFs.ts` | **VERIFY + FREEZE** | Atomic/durable write behavior is intact. | Fault-injection and lock tests pass. |

### 6.6 OpenAI gateway

| File | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `src/ai/gateway/policy.ts` | **VERIFY + FREEZE** | Exact provider/model route, no silent fallback, OpenAI Platform authority. | Gateway tests pass. |
| `src/ai/gateway/modelGateway.ts` | **VERIFY + FREEZE** | Key is read from environment; exact-model probe; controlled pause/resume; durable writes precede suspension. | `gateway status` operational; funding-failure behavior tested. |
| `src/ai/gateway/openaiAdapter.ts` | **VERIFY + FREEZE** | Provider calls do not expose key; exact model returned/validated. | Authenticated model probe succeeds with `gpt-5.6`. |
| `src/ai/gateway/gatewayProjection.ts` | **VERIFY + FREEZE** | Status exposes configured/enabled/key-present/ready/pause without secret bytes. | `/api/config`, Status and Q3 agree. |
| `src/cli/commands/gatewayCommands.ts` | **VERIFY + FREEZE** | `gateway status` and `gateway resume` report sanitized state; no key output. | CLI test/manual preflight passes. |

### 6.7 Proof, cycle and Great Book

| File | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `src/proof/proofContract.ts` | **VERIFY + FREEZE** | Contract requires frozen IDs, baseline/candidate states, metrics, gates, repetitions, warmups, invalidation/confounder rules, environment and rollback. | Proof contract tests pass. |
| `src/proof/baselineRegistry.ts` | **VERIFY + FREEZE** | Baseline is durable and identity-bound. | Baseline/proof tests pass. |
| `src/proof/verdict.ts` | **VERIFY + FREEZE** | Durable `REJECT`, `REVISE`, `INVALID`, `ACCEPT`; no ad-hoc success. | Verdict tests pass. |
| `src/experiment/proof/executionCoordinator.ts` | **VERIFY + FREEZE** | Runs baseline/candidate under frozen contract, captures evidence and rollback. | Proof pipeline tests pass. |
| `src/cli/commands/proofCommands.ts` | **VERIFY + FREEZE** | Candidate manifest accepts only governed relative file writes/deletes; no traversal/duplicate target. | Proof CLI tests pass. |
| `src/cycle/cycleInputLock.ts` | **VERIFY + FREEZE** | Locks current mission, authority, benchmark, snapshot and required inputs. | Input-lock test passes; live cycle reaches `SCREENED`. |
| `src/cycle/cycleRegistry.ts` | **VERIFY + FREEZE** | Durable cycle identities/stages/grade. | Cycle registry tests pass. |
| `src/cycle/cycleOrchestrator.ts` | **VERIFY + FREEZE** | Drives one current-mission cycle and refuses stale/missing inputs. | Orchestration tests pass. |
| `src/cycle/proofClosure.ts` | **VERIFY + FREEZE** | Derives proof-authoritative criteria from actual cycle evidence. | Proof-closure tests pass. |
| `src/cycle/resumePlanner.ts` | **VERIFY + FREEZE** | Suspended cycles require controlled operator resume; provider recovery does not auto-resume. | Resume tests pass. |
| `src/greatBook/greatBookEntry.ts` | **VERIFY + FREEZE** | Great Book is ACCEPT-only and created atomically from verdict consequence. | Great Book tests pass. |
| `src/greatBook/greatBookProjection.ts` | **VERIFY + FREEZE** | Projection reflects durable ACCEPT consequences only. | Proof board/Great Book projection agree. |
| `src/memory/db.ts` | **VERIFY + FREEZE** | Opens the preserved workspace database and current migrations safely. | Full Windows selftest passes against a disposable test workspace; live workspace backup exists. |
| `src/memory/eventLog.ts` | **VERIFY + FREEZE** | Append/read/replay/lock semantics remain durable. | Event fault-injection, lock and replay tests pass. |
| `src/memory/artifactStore.ts` | **VERIFY + FREEZE** | Evidence artifacts are content-addressed and preserved. | Proof artifacts resolve by recorded hash. |

### 6.8 Formal closure, Status and dashboard

| File | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `src/control/p2ClosurePolicy.ts` | **VERIFY + FREEZE** | Loads the current P2 operational policy without contradiction. | Closure policy tests pass. |
| `src/closure/p2ClosureAssessment.ts` | **VERIFY + FREEZE** | Read-only assessment checks current ratification/epoch, operational gateway, proof/verdict/ACCEPT/Great Book and proof-authoritative cycle. | `/api/p2-closure` is truthful: open before proof, closed only after full chain. |
| `src/status/statusContractV5.ts` | **VERIFY + FREEZE** | Status wire version/shape remains current. | Status contract tests pass. |
| `src/status/statusFromRuntime.ts` | **VERIFY + FREEZE** | Status derives from the same runtime/durable truth as API and UI. | Status/API/console agreement tests pass. |
| `src/status/statusProjector.ts` | **VERIFY + FREEZE** | Projection includes current gateway/cycle/proof/Great Book evidence. | Status projector tests pass. |
| `src/status/statusSeal.ts` | **VERIFY + FREEZE** | Generated status is sealed and verifiable. | `status validate` succeeds. |
| `src/status/freshness.ts`, `history.ts` | **VERIFY + FREEZE** | Stale output is distinguished from live state; retained history does not replace current projection. | Freshness/history tests pass. |
| `src/daemon/clueDashboardServer.ts` | **VERIFY + FREEZE** | `/api/config`, `/api/p2-closure`, Status and control routes are loopback/authority safe; no future profile CRUD added before P2 closes. | Dashboard server authority tests pass. |
| `src/daemon/proofBoardProjection.ts` | **VERIFY + FREEZE** | Board counts and identities agree with durable proof state. | Proof-board tests pass. |
| `src/daemon/runtimeRegistrySource.ts` | **VERIFY + FREEZE** | Runtime registry reflects the current target only. | Runtime registry tests pass. |
| `ui/clue-dashboard/index.html` | **VERIFY + FREEZE** | Accepted Q1/SURF and Configuration shell remain intact. | Shell markup tests pass. |
| `ui/clue-dashboard/app.js` | **VERIFY + FREEZE** | Exact latest accepted Q1/SURF file; no concurrent edit during ceremony. | Dashboard test suite and browser probes pass. |
| `ui/clue-dashboard/configuration/configurationPanel.js` | **VERIFY + FREEZE** | Current read-only health view remains truthful; do not implement full profiles here before closure. | Configuration panel tests pass. |
| `ui/clue-dashboard/configuration/actionContracts.js` | **VERIFY + FREEZE** | Closed action registry; no secret-bearing action; Start and Git sync remain separate. | Action-contract tests pass. |
| `P2_FINAL_BACKEND_GOVERNANCE_BROWSER_PROBE.js` | **RUN READ-ONLY** | Final integration, activation and closure fields. | Before ceremony: integration pass, activation ready, closure open. After cycle: all closure fields closed, blockers empty. |
| `Q1_SURF_DIVE_BROWSER_PROBE.js` and accepted Q1 probes | **RUN READ-ONLY** | Q1/SURF fixes retained, no runtime regression. | Probe outputs pass before freeze and after final restart. |

### 6.9 Tests, release and generated outputs

| File/group | P2 action | Required verification | Acceptance gate |
|---|---|---|---|
| `selftest/**/*.test.ts` | **RUN FRESH ON WINDOWS** | Full suite against a disposable workspace and native Windows dependencies. | Zero failures; documented skips only if contractually allowed. |
| `ui/clue-dashboard/test/*.test.mjs` | **RUN** | All dashboard contracts, Q1/Q3/proof board/configuration behavior. | All tests pass. |
| `ui/system-navigator/test/*.test.mjs` and verifier | **RUN** | Navigator stream/layout/identity integrity. | Verification and all tests pass. |
| `tools/p0-acceptance.mjs` | **RUN AFTER CLOSURE** | Confirms P0/P1 baseline did not regress. | Fresh report passes or any non-P2 limitation is explicitly documented. |
| `tools/release.mjs` | **RUN AFTER CLOSURE** | Creates exact release bundle/hash from the closed tree/evidence. | Release artifact and SHA preserved. |
| `clue-status.md` | **REGENERATE, NEVER HAND EDIT** | Generated after machine closure via `status report`. | Matches sealed current Status. |
| `p0-acceptance-report.json` | **REGENERATE** | Current result, not historical copy. | Stored with release evidence. |
| historical `P2_ZIP_*`, hotfix and input-baseline files | **PRESERVE/CLASSIFY** | Historical evidence only; do not allow them to override current source truth. | Final inventory classifies each as history, not active authority. |

---

## 7. A2 — Fresh Windows pre-ceremony validation

Run from a clean PowerShell session in `F:\CLU\CLU`.

```powershell
npm run typecheck
npm run build
npm run selftest
npm run dashboard:verify
npm run navigator:verify
node dist/src/cli/index.js doctor --deep
node dist/src/cli/index.js status show
node dist/src/cli/index.js gateway status
```

Also run the accepted Q1/SURF probe and the final backend/governance browser probe.

### Required pre-ceremony state

```text
runtime healthy
current Q1/SURF fixes retained
no known runtime regression
project root = F:\CLU\CLU
workspace root = F:\CLU\workspace\clue
shadow root = F:\CLU\shadow\clue
publication = NO_REMOTE_YET
Start CLU-E does not auto-sync Git
tracked authority hashes valid
Master Benchmark valid
P2 closure still OPEN because ceremony has not happened
```

Create `P2_PRE_CEREMONY_READINESS.json` from observed facts. Do not manually set readiness to pass.

### Hard stop

Do not ratify if any test failure, root mismatch, authority drift, benchmark integrity failure, mixed target state, or unexplained Status contradiction remains.

---

## 8. A3 — Build the two authority manifests

### 8.1 Active P2 Authority Manifest

Generate `P2_ACTIVE_AUTHORITY_MANIFEST.json` from the **actual current mission authority**, not from a hand-maintained list alone.

It must include at minimum:

- every `constitution.tracked_documents` file;
- `config/clue.config.yaml`;
- active `targets/clu/profile.yaml`;
- `target description.md`;
- `targets/clu/benchmark/master-benchmark.md`;
- P2 closure/routing/budget/patching policies bound by the mission;
- Metric Catalogue authority and any schema/contract files that `src/control/mission.ts` actually binds;
- canonical relative path, SHA-256, role and ordering.

Cross-check the manifest against the current mission hash and `SHA256SUMS_v9.txt`.

### 8.2 Deferred Post-P2 Manifest

Generate `P2_DEFERRED_POST_P2_MANIFEST.json` for:

```text
CLUE_CONFIGURATION_PROJECT_PROFILES_SUPPLEMENT_2026-08-14.md
```

Required fields:

```json
{
  "documentClass": "configuration/interface supplement",
  "originalStatus": "proposed normative implementation supplement",
  "scope": "post-P2",
  "activeForP2Proof": false,
  "implementationRequiredForP2Closure": false,
  "canonicalPath": "...",
  "sha256": "..."
}
```

### 8.3 Authority-conflict check

Before ratification, explicitly confirm:

- no active document weakens the Master Benchmark;
- no active document permits model fallback;
- no active document makes remote publication mandatory for P2;
- no active document requires Project Profiles as a P2 gate;
- no active document contradicts protected proof behavior;
- deferred post-P2 material is not silently treated as current implementation truth.

Unresolved conflict inside the active P2 set is a ratification blocker.

---

## 9. A4 — Activate and verify the OpenAI gateway

### 9.1 Provision the key

Create the Windows user or system environment variable:

```text
OPENAI_API_KEY
```

Do not place it in a command transcript containing its value. Restart every dashboard, terminal and host process that must inherit the environment.

### 9.2 Verify exact operational identity

Run:

```powershell
node dist/src/cli/index.js gateway status
```

Where an authenticated exact-model probe is required by the installed build/runbook, execute the controlled gateway probe/resume operation.

Required state:

```text
provider = openai
requestedModel = gpt-5.6
effectiveModel = gpt-5.6
configured = true
enabled = true
apiKeyPresent = true
operationallyReady = true
problem = null
fallbackUsed = false
providerPaused = false
budgetAuthority = openai_platform
localBudgetEnforced = false
```

Persist only sanitized state.

### 9.3 Funding-exhaustion test

The automated test suite must prove that explicit billing/credit exhaustion:

1. finishes the current durable write/checkpoint;
2. records the failure;
3. refuses new AI submissions;
4. preserves state;
5. surfaces controlled pause/Q3 `LACK OF $`;
6. does not auto-resume a suspended cycle after gateway recovery.

This may be proved with mocked provider responses; do not intentionally exhaust live credit.

---

## 10. A5 — Final freeze, ratification and epoch

After all preflight checks pass:

1. Capture final hashes of the canonical source tree and active authority.
2. Mark the tree frozen in the command transcript.
3. Run interactively:

```powershell
node dist/src/cli/index.js docs ratify
```

4. Read the preview and type the exact state-bound phrase printed by the command:

```text
RATIFY <token>
```

5. Verify:

```text
ratificationCurrent = true
```

6. Immediately seal the fresh epoch:

```powershell
node dist/src/cli/index.js epoch seal P2-authoritative
```

7. Type the exact state-bound phrase:

```text
SEAL <token>
```

8. Verify:

```text
epochName = P2-authoritative
epochCurrent = true
```

9. Save sanitized ratification and epoch receipts under `01-authority`.

### Hard stop

If any source, configuration, policy, tracked document, target profile or benchmark changes after this point, do not continue the existing proof cycle. Renew the authority basis, ratification and epoch.

---

## 11. A6 — Recommended first P2 proof candidate

### 11.1 Candidate identity

```text
Candidate ID: P2-CAND-REC-ALLOC-01
Primary target file: src/analysis/source/recognizer.ts
Purpose: reduce avoidable allocation/repeated-pass cost while preserving recognition truth exactly
```

This is a recommendation based on the inspected tree and Master Benchmark. The final candidate remains conditional on fresh Windows baseline measurements from the final archive.

### 11.2 Permitted behavior-preserving changes

The candidate patch may perform only narrowly scoped mechanical optimizations such as:

1. Build the project-file/module-path projection once and reuse it for:
   - extraction selection;
   - parity checks;
   - program-file hash construction;
   - file counts.
2. Replace per-file `units.slice(...)`, `edges.slice(...)` and `unresolved.slice(...)` observer allocations with index-based iteration over the newly appended range.
3. Build the logical-ID set and duplicate list in one pass rather than mapping all IDs multiple times.
4. Reuse already-computed module paths instead of repeatedly calling `relative`/normalization for the same source file.

### 11.3 Forbidden candidate changes

Do not:

- change identity grammar or recognizer version;
- remove TypeScript checker resolution;
- weaken snapshot parity;
- suppress unresolved references;
- alter edge kinds/confidence;
- change sort order, hashes, unit/edge identities or counts;
- change the Master Benchmark or thresholds after measuring;
- add a semantic “fast path” whose parity is not already proved;
- edit the canonical file manually during the ceremony.

The candidate must be represented only through `candidate-patch.json` and applied by the proof pipeline to the governed shadow/candidate state.

### 11.4 Candidate tests

Existing gates to run:

- `selftest/source.test.ts`;
- `selftest/recognizer-identity.test.ts`;
- `selftest/snapshot-identity.test.ts`;
- `selftest/snapshot-canonical-basis.test.ts`;
- `selftest/graph-edge-identity.test.ts`;
- `selftest/graph-identity-parity.test.ts`;
- `selftest/recognition-run-physical-inventory.test.ts`;
- `selftest/systemNavigatorObserver.test.ts`;
- full selftest;
- Master Benchmark protective signals.

Add a focused regression test only if the implementation introduces a newly observable boundary. Do not add a test merely to bless changed output; all output should remain identical.

### 11.5 Pre-authoritative screening gate

Before freezing the formal proof contract, run exploratory screening outside the authoritative attempt using the same final host and representative command.

Recommended go/no-go rule:

```text
median improvement >= 2%
measurement spread remains within Master Benchmark quality limits
all identity/count/hash/protective outputs identical
```

The exact threshold must be selected and frozen **before** the authoritative baseline/candidate result is observed. If the candidate cannot produce a signal safely above timing noise, discard it and profile the next measured hotspot. Do not weaken the threshold.

### 11.6 Proof signal binding

Primary target signals:

- `SIG-001` — cold recognition time;
- `SIG-006` — incremental recognition time, where the change affects it.

Mandatory regression/protection set must include, as defined by the registered benchmark:

- unit count;
- edge count;
- unresolved-import/reference counts;
- metric count;
- test pass/skip state;
- graph/result identity where required;
- benchmark completeness;
- no timing or environment invalidation.

### 11.7 Fallback candidate policy

If fresh profiling shows `recognizer.ts` is no longer a measurable hotspot, select the next candidate only through this process:

1. run the frozen Master Benchmark opening/baseline scenarios;
2. profile the highest-cost scenario without changing source;
3. choose one narrow file/function inside that scenario;
4. define exact output/protective parity;
5. perform non-authoritative screening;
6. freeze a new contract before formal observation.

Do not choose a broad Configuration/Project Profiles refactor as the P2 candidate.

---

## 12. A7 — Create proof inputs without moving authority

### 12.1 `proof-contract.json`

Create in `02-proof-inputs`, not the canonical repository. It must bind:

```text
schema/version
project/mission identity
cycle ID
snapshot/capture/baseline IDs
ratification and epoch identity
Master Benchmark ID/version/hash
candidate ID and hypothesis
representative inputs
opening/baseline state
candidate state
primary target measurements
regression/protective measurements
mandatory gates
warmup count
repetition count
aggregation
thresholds
environment fingerprint
invalidation and confounder rules
rollback procedure
```

### 12.2 `candidate-patch.json`

Create a strict manifest targeting only:

```text
src/analysis/source/recognizer.ts
```

unless a focused test file is genuinely required. Use exact whole-file hashes/contents according to the current CLI schema. No absolute paths, traversal, duplicate targets or unrelated files.

### 12.3 `candidate-rollback.json`

Preserve the exact original file bytes/hash so the candidate can be reversed deterministically. The proof engine’s own rollback remains authoritative; this file is an operator-readable companion receipt.

### 12.4 Input freeze

Hash all three input files before running the proof. Do not edit them after results begin. A revision creates new candidate/contract identities and a new proof attempt.

---

## 13. A8 — Run the authoritative proof cycle

1. Open/drive the cycle:

```powershell
node dist/src/cli/index.js cycle drive
```

2. Verify the cycle reaches `SCREENED` and carries:
   - current mission;
   - current ratification;
   - current `P2-authoritative` epoch;
   - registered Master Benchmark;
   - no removable input-lock absence.

3. Run:

```powershell
node dist/src/cli/index.js proof `
  --contract F:\CLU\workspace\clue\closure\P2-authoritative\02-proof-inputs\proof-contract.json `
  --patch F:\CLU\workspace\clue\closure\P2-authoritative\02-proof-inputs\candidate-patch.json
```

4. Preserve every durable outcome.

### Outcome handling

#### `INVALID`

- Preserve the attempt and invalidation reason.
- Correct the contract/environment/candidate basis without rewriting history.
- Create a new version/attempt.

#### `REJECT`

- Preserve the verdict.
- Do not create a Great Book entry.
- Analyze whether the candidate is slower or regressive.
- Either revise narrowly or abandon it.

#### `REVISE`

- Preserve the verdict and requested evidence/change.
- Create a new candidate version and, where required, new contract identity.
- Rerun through the durable pipeline.

#### `ACCEPT`

Verify all of the following:

```text
measurable improvement demonstrated
no unacceptable regression
authoritative pipeline produced verdict
accepts >= 1
one atomic Great Book contribution exists
Great Book identity points to this verdict/candidate/benchmark basis
```

Do not manufacture or manually insert an ACCEPT or Great Book record.

---

## 14. A9 — Close the cycle and verify machine closure

After a real ACCEPT:

```powershell
node dist/src/cli/index.js cycle close
```

Required cycle state:

```text
lastCycleGrade = proof-authoritative
lastCycleCriteriaMet = true
```

Then refresh/restart the dashboard as required and read the formal assessment:

```text
GET /api/p2-closure
```

Run the final browser probe.

Required machine state:

```text
formalClosurePass = true
p2Closed = true
closureState = CLOSED
blockers = []
```

Also verify:

```text
proofAttempts >= 1
verdicts >= 1
accepts >= 1
greatBookEntries >= 1
```

No unresolved equivalent blocker may remain for:

```text
P2-D4-OPERATIONAL-CONTRADICTION
P2-RATIFICATION
P2-EPOCH
P2-PROOF-AUTHORITATIVE-CYCLE
P2-FIRST-PROVEN-IMPROVEMENT
P2-CYCLE-CLOSURE
```

---

## 15. A10 — Generate final P2 release evidence

After machine closure, run:

```powershell
node dist/src/cli/index.js status report
node tools/release.mjs
node tools/p0-acceptance.mjs
npm run dashboard:verify
npm run navigator:verify
```

Preserve:

- final sealed Status and generated `clue-status.md`;
- `/api/p2-closure` JSON;
- final browser probe JSON;
- proof contract and candidate manifest hashes;
- all proof/verdict/Great Book/cycle IDs;
- ratification/epoch receipts;
- fresh P0 acceptance report;
- release ZIP and SHA-256;
- exact final source-tree inventory;
- truthful `RELEASE_CANDIDATE` qualification while no Git remote/release identity exists.

### Historical closure receipt

The current formal assessment is intentionally current-mission based. Later post-P2 authority and code changes may make a *current* assessment no longer describe the old P2 moment. Before changing the project after closure, create immutable historical evidence:

`P2_FORMAL_CLOSURE_RECEIPT.json` should bind:

```text
closedAt
final mission hash
ratification ID/hash
epoch ID/hash
cycle ID
proof attempt ID
verdict ID
greatBook entry ID
Master Benchmark hash
final p2-closure JSON hash
final status hash
release artifact hash
Creator approval file hash
```

This is a preservation receipt, not a second closure mechanism.

---

## 16. A11 — Creator approval

Only after machine closure is verified, the Creator records exactly or equivalently:

```text
Creator approval: P2 closure accepted.
```

Store it in:

```text
F:\CLU\workspace\clue\closure\P2-authoritative\06-creator-approval\P2_CREATOR_APPROVAL.txt
```

Hash it and include the hash in `P2_FORMAL_CLOSURE_RECEIPT.json`.

At that moment, and only then, P2 is formally closed.

---

# PROGRAMME B — PROJECT PROFILES SUPPLEMENT

## 17. B0 — Post-P2 activation barrier

Do not start Programme B until all Programme A conditions pass and the Creator approval is stored.

After P2 closure:

1. Preserve the entire P2 evidence directory read-only.
2. Create a new development branch/worktree or patch baseline for post-P2 work.
3. Promote the Configuration supplement only through explicit Creator/governance approval.
4. Open a distinct post-P2 programme/epoch, recommended:

```text
POST-P2-PROJECT-PROFILES
```

5. Do not reuse the name `P2-authoritative` for new evidence.

### 17.1 Proposed storage decision

The supplement specifies required behavior but does not prescribe an exact storage technology or filesystem layout. This strategy proposes:

```text
F:\CLU\profiles\
├── registry.json
├── active.json
├── profiles\
│   ├── clu.json
│   └── <projectId>.json
└── events\profile-events.ndjson
```

Each project profile points to its own durable workspace, for example:

```text
F:\CLU\workspace\clue
F:\CLU\workspace\murugan
```

This preserves the current CLU workspace in place. A separate workspace/database per project is the simplest safe implementation because the existing database, event log, artifact store, graph, Great Book, recognition and proof projections are already rooted under a workspace.

Exact filenames and the profile-store root are **proposed implementation choices**. They may be changed during design review as long as all supplement invariants remain enforced by the backend.

---

## 18. B1 — Documentation and compatibility preparation

Before code changes, create a governed migration plan. Do not mutate the closed v9 pack in place.

### Files to create

| Proposed file | Purpose | Acceptance gate |
|---|---|---|
| `docs/project-profiles/PROJECT_PROFILE_MIGRATION_PLAN.md` | Maps legacy `active_target` + `targets/<id>/profile.yaml` into `clue-project-profile/1`; promises preservation of `F:\CLU\workspace\clue`. | Reviewed before schema/store implementation. |
| `docs/project-profiles/PROJECT_PROFILE_STORAGE_DECISION.md` | Records selected profile store, atomic write model, workspace isolation and deletion semantics. | Decision approved; no secret storage. |
| `docs/project-profiles/PROJECT_PROFILE_API_CONTRACT.md` | Defines CRUD/activate/validate/test/readiness request and response shapes. | Backend remains authority; secrets never returned. |
| `docs/project-profiles/PROJECT_SWITCHING_STATE_MACHINE.md` | Defines stop/persist/load/validate/activate transition and refusal states. | No mixed-generation state permitted. |
| `docs/project-profiles/PROJECT_AUTHORITY_CONFLICT_POLICY.md` | Defines precedence, structural conflict checks and Creator resolution workflow. | No silent arbitrary resolution. |
| `docs/project-profiles/PROJECT_PROFILE_ACCEPTANCE_PLAN.md` | Executable matrix for every supplement DoD item. | Every item maps to automated test or explicit governed manual test. |

### Important limitation

The supplement recommends surfacing authority conflicts but does not specify a complete algorithm for automatically detecting semantic contradictions in arbitrary natural-language documents. Implement:

- deterministic structural checks;
- explicit conflict records;
- hash/role/order/enable validation;
- optional AI-assisted conflict suggestions;
- mandatory Creator resolution for semantic conflicts.

Do not claim perfect automatic semantic conflict detection without a separately governed design and evidence.

---

## 19. B2 — Canonical path and operation identity foundation

### Patch PP-01 — canonical target-root identity

#### Create `src/shared/pathIdentity.ts`

Responsibilities:

- resolve absolute paths;
- normalize separators;
- canonicalize platform case rules;
- resolve real path/reparse/junction aliases where available;
- return both display path and stable `targetRootIdentity`;
- compare identities safely;
- reject missing/invalid roots;
- distinguish target, workspace, shadow and CLU-owned state zones.

#### Create `selftest/project-root-identity.test.ts`

Required cases:

- case differences;
- slash differences;
- relative vs absolute aliases;
- `.`/`..` normalization;
- junction/symlink alias where Windows test environment permits;
- two textual paths resolving to the same physical root;
- invalid and missing root;
- root-zone overlap refusal.

#### Gate

```text
same canonical target root always yields same identity
different physical targets do not collide
duplicate alias paths can be refused server-side
```

### Patch PP-02 — governed operation identity

#### Create `src/shared/projectOperationIdentity.ts`

Canonical shared envelope:

```ts
{
  projectId,
  targetRootIdentity,
  projectProfileHash
}
```

Provide schema, canonicalization and equality/assertion helpers. Important commands/events may extend it but must not redefine it.

#### Create `selftest/project-operation-identity.test.ts`

Prove:

- deterministic canonical form;
- missing fields refused;
- stale/mismatched identity refused;
- secret values cannot enter identity.

---

## 20. B3 — Full profile schema and deterministic hashing

### Patch PP-03 — schema

#### Modify `src/shared/schemas.ts`

Add a versioned profile schema equivalent to:

```text
profileVersion = clue-project-profile/1
projectId
targetRoot
targetRootIdentity
workspaceRoot
shadowRoot
authority
recognition
benchmarkRuntime
integrations.powershell
integrations.git
integrations.chrome
integrations.gpt
state
proof/cycle/snapshot metadata references
```

Requirements:

- Project ID regex `[a-z0-9][a-z0-9._-]*`;
- trim/lowercase on explicit creation input, never silent rename after creation;
- no path separators/control characters;
- profile schema version mandatory;
- credential **reference** allowed, secret bytes forbidden;
- explicit global-default vs project-override representation;
- legacy `targets/<id>/profile.yaml` schema retained only for migration/compatibility;
- strict unknown-field behavior where needed to prevent silent reinterpretation.

#### Create `selftest/project-profile-schema.test.ts`

Test every required field, invalid ID, malformed authority items, duplicate order, raw secret keys, incompatible schema and supported optional fields.

### Patch PP-04 — canonicalization and hash

#### Create `src/control/projectProfiles/profileCanonicalization.ts`

Responsibilities:

- normalize one validated draft to a deterministic canonical profile;
- sort fields/documents explicitly;
- resolve global defaults and supported project overrides;
- omit transient health/status fields from stored authority;
- retain credential reference but never secret bytes.

#### Create `src/control/projectProfiles/profileHash.ts`

Responsibilities:

- produce deterministic `projectProfileHash` over all behavior-relevant settings;
- exclude secret bytes and transient timestamps;
- bind credential references, authority hashes, recognition config, benchmark runtime and integration settings as governed;
- provide hash versioning.

#### Create `selftest/project-profile-hash.test.ts`

Prove:

- same canonical profile produces same hash regardless of input key order;
- behavior-relevant change changes hash;
- display-only/transient health change does not;
- secret bytes are rejected, not hashed;
- credential reference change changes hash;
- authority document change changes profile/authority basis.

---

## 21. B4 — Profile store, registry, events and migration

### Patch PP-05 — atomic profile store

#### Create `src/control/projectProfiles/profileStore.ts`

Responsibilities:

- read/write versioned profiles;
- durable temp-write + fsync + atomic replace;
- reject malformed/incompatible profiles;
- never expose secret bytes;
- safe concurrent update generation checks;
- list profile metadata without opening target workspaces;
- delete only CLU-E-owned profile data after explicit confirmation.

#### Create `selftest/project-profile-store.test.ts`

Test atomicity, interrupted writes, invalid schema, generation conflict, enumeration and delete safety.

### Patch PP-06 — registry and uniqueness

#### Create `src/control/projectProfiles/profileRegistry.ts`

Responsibilities:

- unique Project ID;
- unique canonical Target Root;
- project-to-profile path registry;
- active pointer lookup;
- clear `TARGET ROOT ALREADY REGISTERED` response naming the existing project;
- registry update atomically coupled to profile creation/deletion.

#### Create `selftest/project-profile-registry.test.ts`

Test duplicate IDs and all duplicate-root aliases required by the supplement.

### Patch PP-07 — profile event log

#### Create `src/control/projectProfiles/profileEventLog.ts`

Record sanitized events such as:

```text
project-profile.created
project-profile.updated
project-profile.activated
project-profile.validation_failed
project-profile.deleted
project-authority.changed
```

Bind old/new generation and hashes; never store credentials.

#### Create `selftest/project-profile-events.test.ts`

Prove event ordering, redaction and durable replay.

### Patch PP-08 — legacy migration

#### Create `src/control/projectProfiles/profileMigration.ts`

Migrate the current installation:

```text
config/clue.config.yaml active_target = clu
targets/clu/profile.yaml
workspace = F:\CLU\workspace\clue
shadow = F:\CLU\shadow\clue
```

into one `clue-project-profile/1` profile without moving or deleting the workspace.

Rules:

- migration is explicit/idempotent;
- legacy profile bytes/hash are recorded;
- existing workspace history is preserved;
- incompatible or ambiguous legacy state fails closed;
- no silent profile reinterpretation.

#### Create `selftest/project-profile-migration.test.ts`

Test current CLU migration, repeated migration, malformed legacy data and preservation of paths/history.

---

## 22. B5 — Workspace identity and project-scoped persistence

### Patch PP-09 — workspace identity guard

#### Modify `src/memory/db.ts`

Add a durable workspace identity record/table or equivalent containing at least:

```text
projectId
targetRootIdentity
profileVersion
initialProfileHash
createdAt
```

On open:

- a new empty workspace may initialize identity;
- an existing workspace must match the selected profile identity;
- mismatch is `ROOT/WORKSPACE IDENTITY MISMATCH` and blocks activation;
- historical records are not rewritten when the current profile hash changes;
- migrations remain explicit/versioned.

#### Create `selftest/workspace-project-identity.test.ts`

Prove wrong-project workspace reuse is refused and current CLU workspace migration preserves records.

### Patch PP-10 — project-scoped memory services

#### Modify

- `src/memory/eventLog.ts`
- `src/memory/artifactStore.ts`

Only as needed to accept/assert active project operation identity and workspace ownership. Do not add `projectId` to every row if separate workspace databases already provide strict physical isolation; add explicit identity to cross-workspace/exported artifacts where needed.

#### Create `selftest/project-state-isolation.test.ts`

With Project A and B workspaces, prove events/artifacts written to A never appear in B.

---

## 23. B6 — Active-profile runtime and atomic switching

### Patch PP-11 — active profile loader

#### Modify `config/clue.config.yaml`

Move installation configuration to a new explicit version, for example:

```text
version: 3
profiles.registry_root: F:/CLU/profiles
profiles.active_pointer: F:/CLU/profiles/active.json
```

Keep global defaults for:

- PowerShell executable;
- Chrome executable;
- OpenAI provider/credential reference;
- Metric Catalogue;
- adapter registry placeholder;
- global UI preferences.

Do not copy target-specific roots into global settings.

#### Modify `src/control/runtime.ts`

Responsibilities after migration:

- load the active profile through the profile store;
- resolve global defaults + supported project overrides;
- open profile-owned workspace/database/artifact store/event log;
- assert workspace identity;
- expose active `projectId`, `targetRootIdentity`, `projectProfileHash`;
- refuse mixed legacy/current profile fields;
- support a read-only global runtime for listing/validating profiles without activating them.

#### Update/create tests

- `selftest/config-identity.test.ts`;
- `selftest/config-path-portability.test.ts`;
- `selftest/config-zones.test.ts`;
- `selftest/runtime-gate.test.ts`;
- `selftest/runtime-readonly.test.ts`.

### Patch PP-12 — atomic activation service

#### Create `src/control/projectProfiles/projectActivation.ts`

Implement the switching workflow:

```text
request Project B
→ refuse/finish unsafe Project A writes
→ persist/close A
→ load and validate B profile
→ open B workspace/database
→ load B Great Book/recognition/proof state
→ validate required integrations for intended operations
→ create complete B runtime generation
→ atomically publish B as active
```

No visible active pointer changes until the complete B generation is ready.

#### Create `src/control/projectProfiles/projectRuntimeManager.ts`

For long-running dashboard/daemon use:

- own exactly one active runtime generation;
- lease/refuse operations during switch;
- close old runtime only after safe handoff;
- publish one active-project event;
- prevent stale request contexts from crossing generations.

#### Create `selftest/project-switching.test.ts`

Prove the five required identities change atomically:

```text
database identity
Great Book identity
target root
inventory snapshot
profile hash
```

Also inject failure at each transition step and prove Project A remains coherently active or the system enters a clear blocked state—never mixed A/B state.

---

## 24. B7 — Project Authority bindings and drift

### Patch PP-13 — authority model

#### Create `src/control/projectProfiles/projectAuthority.ts`

Model:

- Target Description;
- Master Benchmark;
- optional Project Intent/Constraints;
- zero or more Additional Governed Documents;
- role, enabled state, explicit order;
- canonical path, SHA-256, validation time/state;
- active authority manifest/hash.

Rules:

- Master Benchmark remains a distinguished first-class authority;
- disabled additional documents remain stored but are excluded from active basis;
- no filesystem enumeration order;
- changed bytes produce changed authority hash/state;
- required missing/invalid benchmark blocks proof readiness.

#### Create `selftest/project-authority-binding.test.ts`

Test role/order/enable/hash, missing files, path aliases, benchmark distinction and deterministic manifest.

### Patch PP-14 — drift and conflict state

#### Create `src/control/projectProfiles/authorityConflict.ts`

Responsibilities:

- detect structural conflicts such as duplicate distinguished roles, invalid precedence metadata, duplicate canonical file bindings with conflicting roles, or profile declarations inconsistent with proof requirements;
- support explicit semantic conflict records requiring Creator resolution;
- return `AUTHORITY CONFLICT` and `INVALID/BLOCKED` rather than silently choosing;
- preserve conflict evidence and resolution identity.

#### Create `selftest/project-authority-conflict.test.ts`

Test structural conflicts, unresolved explicit conflict records and resolved successor authority generation.

### Patch PP-15 — mission/context integration

#### Modify `src/control/mission.ts`

Bind at least:

```text
projectId
targetRootIdentity
projectProfileHash
active authority document hashes
Master Benchmark hash
recognition config hash
```

A profile/authority change creates a successor mission and stales relevant old proof assumptions. Historical evidence remains bound to its old mission.

#### Modify `src/control/contextBuilder.ts`

Expose exact active governed documents and hashes to:

- candidate generation;
- experiment planning;
- proof interpretation;
- project analysis;
- relevant recognition/AI reasoning.

Never expose disabled documents or credential bytes.

#### Modify `src/cycle/cycleInputLock.ts`

Lock the full project operation identity and active authority/benchmark/readiness into each cycle.

#### Update tests

- `selftest/context-spine-basis.test.ts`;
- `selftest/mission-basis-gate.test.ts`;
- `selftest/mission-profile-binding.test.ts`;
- `selftest/cycle-input-lock.test.ts`;
- new `selftest/authority-drift-stales-proof.test.ts`.

---

## 25. B8 — Great Book, proof, cycle and benchmark identity isolation

### Patch PP-16 — Great Book identity

#### Modify

- `src/greatBook/greatBookEntry.ts`
- `src/greatBook/greatBookProjection.ts`

Each contribution must explicitly bind:

```text
projectId
targetRootIdentity
projectProfileHash or mission identity
proof verdict
accepted candidate
benchmark basis
```

Even with separate workspaces, exported/projection records must carry explicit identity.

#### Create `selftest/great-book-project-isolation.test.ts`

Create Project A and B, ACCEPT in A, switch to B, prove zero A entries, switch back and prove A history intact.

### Patch PP-17 — proof and cycle identity

#### Modify

- `src/proof/proofContract.ts`
- `src/proof/baselineRegistry.ts`
- `src/proof/verdict.ts`
- `src/experiment/proof/executionCoordinator.ts`
- `src/cycle/cycleRegistry.ts`
- `src/cycle/cycleOrchestrator.ts`
- `src/cycle/proofClosure.ts`
- `src/cycle/resumePlanner.ts`

Requirements:

- every new governed record binds `projectOperationIdentity`;
- stale UI/request identity is refused;
- candidate/baseline/verdict cannot cross project boundaries;
- historical legacy records remain readable and are not rewritten;
- ACCEPT consequence enters only the same project’s Great Book;
- project switch refuses active unsafe proof/cycle writes.

#### Create `selftest/proof-cycle-project-isolation.test.ts`

Prove A proof/cycle/baseline/verdict cannot be read or closed as B.

### Patch PP-18 — benchmark runtime

#### Create `src/control/projectProfiles/benchmarkRuntime.ts`

Resolve project-scoped:

```text
working directory
benchmark command/scenario
warmup
repetitions
timeout
target URL
browser profile/resolution
additional args
```

Validate consistency with the Master Benchmark when values are duplicated.

#### Modify

- `src/control/benchmarkRun.ts`
- `src/benchmark/benchmarkRunner.ts`
- `src/proof/proofContract.ts`

Bind runtime configuration hash to benchmark/proof evidence.

#### Create `selftest/project-benchmark-runtime.test.ts`

Test per-project settings, inconsistency refusal, environment fingerprint and conditional browser requirement.

---

## 26. B9 — Recognition, durable inventory and SURF/DIVE switching

### Patch PP-19 — recognition configuration

#### Modify

- `src/control/recognitionRun.ts`
- `src/analysis/source/snapshot.ts`
- `src/analysis/source/repositoryInventory.ts`
- `src/analysis/source/scanCache.ts`
- `src/analysis/source/graph.ts`

Consume project-scoped:

```text
source roots
excluded paths
build/compiler config
adapter selection
recognition policy
recognition config hash
```

Rules:

- caches/snapshots/graph pointers remain inside the active project workspace;
- cache keys bind project/target/profile/recognition basis;
- switching away and back to unchanged project reuses its durable state;
- switching project never reuses another project’s cache;
- full recognition is not triggered solely because an unchanged project was reactivated.

#### Update/create tests

- `selftest/recognition-run-physical-inventory.test.ts`;
- `selftest/scan-cache-merge.test.ts`;
- `selftest/repository-inventory.test.ts`;
- `selftest/snapshot-identity.test.ts`;
- new `selftest/project-recognition-isolation.test.ts`;
- new `selftest/project-recognition-reuse.test.ts`.

### Patch PP-20 — SURF/DIVE rebinding

#### Modify

- `src/daemon/runtimeRegistrySource.ts`
- `src/status/statusFromRuntime.ts`
- `src/ui/viewModel.ts`
- `ui/clue-dashboard/quadrants/q1Navigator.js`
- `ui/clue-dashboard/state/statusStore.js`
- `ui/clue-dashboard/app.js` only for project-generation integration

Requirements:

- active Project ID visible in Dashboard/Q1/Proof Board/Great Book/Operational Console;
- Project A physical inventory and semantic graph are cleared/parked before Project B is published;
- Q1 receives one new project generation and resets/replays from B only;
- stale network/SSE payload carrying A identity is ignored after B activation;
- switching back to A replays A durable inventory.

#### Create/update tests

- `selftest/runtimeRegistrySource.test.ts`;
- `selftest/navigator-physical-inventory.test.ts`;
- `selftest/graph-identity-parity.test.ts`;
- `ui/clue-dashboard/test/statusStore.test.mjs`;
- `ui/clue-dashboard/test/q1ProjectSwitch.test.mjs`;
- `selftest/surf-dive-project-switch.test.ts`.

---

## 27. B10 — PowerShell/Host and Git readiness

### Patch PP-21 — PowerShell/Host

#### Create `src/control/projectProfiles/hostReadiness.ts`

Return explicit states:

```text
READY
UNAVAILABLE
INVALID PATH
HANDSHAKE FAILED
ROOT MISMATCH
```

#### Modify

- `src/experiment/host/hostClient.ts`
- `scripts/clue-host.ps1`

Bind every handshake/command to active project operation identity, project root and workspace/shadow authority. Reject stale or mismatched roots.

#### Update/create tests

- `selftest/host-handshake.test.ts`;
- `selftest/host-path-parity.test.ts`;
- `selftest/host-ps1-git-params.test.ts`;
- `selftest/project-host-readiness.test.ts`.

### Patch PP-22 — Git

#### Create `src/control/projectProfiles/gitReadiness.ts`

Validate:

```text
repository root belongs to target
remote/provider explicit
default branch/policy
current base pin
publication mode
NO_REMOTE_YET distinguished from invalid
```

#### Modify `src/integration/git/manualGitSync.ts`

Resolve active project Git settings. Preserve invariants:

- Start never synchronizes Git;
- sync is explicit;
- `NO_REMOTE_YET` contacts nothing and remains `READY_LOCAL_ONLY`;
- dirty/detached/diverged state is refused;
- no cross-project repository root.

#### Update/create tests

- `selftest/manual-git-sync.test.ts`;
- `selftest/git-argv.test.ts`;
- `selftest/git-ref-policy.test.ts`;
- `selftest/project-git-readiness.test.ts`.

---

## 28. B11 — Chrome/browser execution and capture

This is a substantial governed subsystem, not merely a path field.

### Patch PP-23 — browser readiness and target resolution

#### Create `src/control/projectProfiles/browserReadiness.ts`

Return explicit states:

```text
READY
CHROME NOT FOUND
DEBUG ENDPOINT UNAVAILABLE
SESSION NOT ESTABLISHED
TARGET NOT FOUND
TARGET AMBIGUOUS
ORIGIN FORBIDDEN
TARGET DISCONNECTED
EXECUTION CHANNEL FAILED
CAPTURE CHANNEL FAILED
```

#### Create `src/experiment/browser/browserTargetResolver.ts`

Implement resolution order:

```text
1. exact previously selected Page ID if valid
2. exact configured target URL
3. unique page under allowed origin
4. otherwise block as ambiguous
```

Bind:

```text
Chrome Instance ID
Browser Session ID
Target/Page ID
Target URL/Origin
Chrome version
Debug endpoint
project operation identity
```

#### Modify `src/experiment/browser/browserAgent.ts`

Use only the selected governed target. Reject unrelated origin and stale project/session identity.

#### Update `scripts/launch-test-browser.ps1`

Support CLU-E-managed project-specific profile directory, debug port and target URL. Never attach to ordinary Chrome by guessing desktop windows.

#### Create `selftest/browser-target-resolution.test.ts`

Test multiple instances, multiple matching tabs, wrong origin and target disappearance.

### Patch PP-24 — execution/capture ledger

#### Create `src/experiment/browser/browserExecutionLedger.ts`

For every governed execution persist:

```text
browserExecutionId
projectId
projectProfileHash
mission/scenario/proof binding
browserSessionId
targetPageId
targetUrl/origin
Chrome version
request hash
response hash
startedAt/completedAt
status
sanitized result/console/performance references
```

No secret or unrelated page content leakage.

#### Create `selftest/browser-execution-evidence.test.ts`

Prove one request/response pair, exact target binding, content hashes, timeout/failure states and project switching isolation.

### Patch PP-25 — project browser switching

Add browser session park/release/activate behavior to `projectActivation.ts` and `projectRuntimeManager.ts`.

Test that Project A target can never remain active after Project B is published.

---

## 29. B12 — GPT/OpenAI profile configuration and safety

### Patch PP-26 — gateway readiness

#### Create `src/control/projectProfiles/gatewayReadiness.ts`

Resolve:

- global provider/default credential reference;
- optional supported project override;
- exact requested/effective model;
- key reference/presence;
- provider reachability;
- operational and controlled-pause state.

Return no secret bytes.

#### Modify

- `src/ai/gateway/policy.ts`
- `src/ai/gateway/modelGateway.ts`
- `src/ai/gateway/openaiAdapter.ts`
- `src/ai/gateway/gatewayProjection.ts`

Requirements:

- all calls bind active project operation identity;
- exact model, no fallback;
- credential reference only in profile;
- per-project readiness where configuration differs;
- OpenAI Platform remains budget authority unless a later separately governed policy changes it;
- logs/evidence/Great Book/API use sanitized projection only.

#### Create/update tests

- `selftest/gateway.test.ts`;
- `selftest/project-gateway-readiness.test.ts`;
- `selftest/gateway-secret-redaction.test.ts`;
- `selftest/gateway-project-identity.test.ts`.

### Important UI contract correction

Current `ui/clue-dashboard/configuration/actionContracts.js` rejects any payload key containing `credential`. The future UI needs to carry a safe **credential reference**, not a secret. Do not simply weaken the regex. Instead:

- define a strict typed profile payload schema;
- allow only a field such as `credentialReference` whose value matches an approved reference grammar (`env:NAME` or credential-store ID);
- continue rejecting `apiKey`, raw `credential`, token, password, authorization and secret bytes;
- prove the backend independently enforces the same rule.

---

## 30. B13 — Project readiness and Status contract

### Patch PP-27 — readiness service

#### Create `src/control/projectProfiles/projectReadiness.ts`

Compute overall:

```text
READY
READY_LOCAL_ONLY
INCOMPLETE
BLOCKED
INVALID
```

And independent capabilities:

```text
Recognition Ready
Proof Ready
Browser Benchmark Ready
AI Candidate Generation Ready
Git Publication Ready
Custodian Landing Ready
```

Rules:

- missing optional remote does not block local proof;
- missing/invalid required Master Benchmark blocks proof readiness;
- exact-model/key failure blocks AI operations only;
- browser can be `NOT_REQUIRED` for non-browser operations;
- hard invariant violation is `INVALID`;
- health failure of configured required connection is `BLOCKED`.

#### Create `selftest/project-readiness.test.ts`

Cover every state and capability combination.

### Patch PP-28 — Status and active identity

#### Modify

- `src/status/statusContractV5.ts` through a governed additive/new wire version;
- `src/status/statusFromRuntime.ts`;
- `src/status/statusProjector.ts`;
- `src/status/freshness.ts`;
- `src/daemon/runtimeRegistrySource.ts`;
- `src/observability/operationalConsole/contract.ts` and projections as required.

Expose:

```text
activeProjectId
targetRootIdentity
projectProfileHash
profileGeneration
overall readiness
capability readiness
authority drift/conflict state
```

Do not reinterpret historical Status snapshots. Use explicit schema migration/versioning.

#### Update tests

- status contract/projector/freshness/history/seal tests;
- status-console agreement;
- runtime registry;
- new profile-readiness Status tests.

---

## 31. B14 — Backend API

The frontend must remain a control/presentation layer. Backend owns all persistence, canonicalization, uniqueness, hashing, activation and readiness.

### Patch PP-29 — API service module

#### Create `src/daemon/projectProfilesApi.ts`

Implement equivalents of:

```text
GET    /api/projects
GET    /api/projects/:id
POST   /api/projects
PUT    /api/projects/:id
DELETE /api/projects/:id
POST   /api/projects/:id/activate
POST   /api/projects/:id/validate
POST   /api/projects/:id/test-host
POST   /api/projects/:id/test-git
POST   /api/projects/:id/test-chrome
POST   /api/projects/:id/test-gpt
GET    /api/projects/:id/readiness
```

All mutations:

- validate server-side;
- use generation/precondition checks;
- enforce ID/root uniqueness;
- never return secrets;
- never delete canonical target repository;
- require explicit confirmation for CLU-E-owned state deletion;
- carry/request active operation identity where appropriate;
- return structured refusal codes.

### Patch PP-30 — server integration

#### Modify `src/daemon/clueDashboardServer.ts`

Delegate project endpoints to `projectProfilesApi.ts`; do not put profile business logic into the HTTP router. Preserve loopback/token/request-size/security policies.

Rework `/api/config` into either:

- installation/global operational health; and
- active project profile/readiness endpoints;

or a clearly versioned combined response. Do not silently change its old meaning.

#### Create/update tests

- `selftest/project-profiles-api.test.ts`;
- `selftest/clue-dashboard-server-authority.test.ts`;
- request-size/auth/secret-redaction tests;
- concurrent generation conflict tests;
- deletion safety tests.

---

## 32. B15 — CLI before full UI

Implement CLI operations first so every backend function is operable and testable without the browser.

### Patch PP-31 — project commands

#### Create `src/cli/commands/projectCommands.ts`

Recommended surface:

```text
clue project list
clue project show <id>
clue project create --file <draft>
clue project update <id> --file <draft> --expected-generation <n>
clue project validate <id>
clue project activate <id>
clue project delete <id> --confirmation <state-bound phrase>
clue project readiness <id>
clue project test-host <id>
clue project test-git <id>
clue project test-chrome <id>
clue project test-gpt <id>
clue project migrate-legacy
```

No CLI output may print raw credentials.

#### Modify

- `src/cli/index.ts`;
- `src/cli/commandAuthority.ts`.

Declare read-only vs mutating authority. Destructive deletion requires state-bound explicit confirmation.

#### Create tests

- `selftest/project-cli.test.ts`;
- update CLI layout/attachment/command-authority tests.

---

## 33. B16 — Configuration UI control plane

Do not expand the monolithic `app.js` with the full form. Use small testable modules.

### Patch PP-32 — shell and state

#### Create

- `ui/clue-dashboard/configuration/configurationState.js`
- `ui/clue-dashboard/configuration/projectSelector.js`
- `ui/clue-dashboard/configuration/projectEditor.js`

Responsibilities:

- list/select/create/save/delete;
- explicit profile generation/hash;
- keyboard-editable Project ID;
- Target Root selection through backend/host-supported directory picker where available;
- draft vs active profile distinction;
- unsaved changes warning;
- no active switch until backend confirms complete activation.

#### Modify `ui/clue-dashboard/index.html`

Create the PROJECT section and a scalable full Configuration layout. Active target remains visible outside Configuration.

#### Tests

- selector/editor/state unit tests;
- stale generation refusal;
- duplicate ID/root error rendering;
- no mixed active/draft state.

### Patch PP-33 — authority editor

#### Create `ui/clue-dashboard/configuration/authorityEditor.js`

Support:

- Target Description;
- Master Benchmark;
- optional Project Intent;
- multiple Additional Governed Documents;
- role, order, enabled state, remove;
- hash/validation/drift/conflict display.

Tests must prove deterministic ordering, disabled state, drift and conflict rendering.

### Patch PP-34 — runtime integration editors

#### Create

- `recognitionEditor.js`
- `hostEditor.js`
- `gitEditor.js`
- `browserEditor.js`
- `gatewayEditor.js`
- `benchmarkRuntimeEditor.js`
- `projectReadinessPanel.js`

Each module owns only its section and consumes typed backend responses. Global default vs project override must be visually explicit.

### Patch PP-35 — action contracts and app integration

#### Modify `ui/clue-dashboard/configuration/actionContracts.js`

Declare all project read/mutation/test actions, payload schema and authority. Permit only safe credential references through strict schema; reject raw secret-like values.

#### Modify `ui/clue-dashboard/configuration/configurationPanel.js`

Turn the current simple readiness renderer into the top-level composition/readiness summary, not the full state authority.

#### Modify `ui/clue-dashboard/app.js`

Only:

- mount modules;
- route requests through declared action client;
- propagate active project generation/identity to Q1, proof board, Great Book and header;
- clear stale view state on project switch.

Do not place profile persistence, validation or canonicalization in `app.js`.

#### Tests

Add focused tests per module plus:

- no secret in request payload;
- exact active project identity shown;
- Project A stale response ignored after B activation;
- switch failure leaves A visible/active;
- operation-specific readiness rendering;
- browser ambiguity and wrong-origin states;
- `NO_REMOTE_YET` renders `READY_LOCAL_ONLY`, not failure.

---

## 34. B17 — Complete acceptance matrix

Every row below must have automated evidence unless explicitly marked governed manual/browser test.

| Supplement requirement | Primary files | Required acceptance test |
|---|---|---|
| Multiple profiles created/persisted | schema/store/registry/API/CLI/UI | Create A/B, restart, list and load exact generations. |
| Editable unique Project ID | schema/registry/editor | Keyboard edit; duplicate rejected; no silent rename. |
| Selectable Target Root | API/host/editor | Directory selection/manual path; canonical identity shown. |
| Duplicate canonical root forbidden | pathIdentity/registry | Case/slash/relative/junction aliases all rejected. |
| Saved Projects dropdown | selector/API | Existing projects listed; selection does not yet imply activation until backend confirms. |
| Full-context atomic switch | activation/runtime manager | DB/Great Book/root/inventory/profile hash change together; injected failures never mix state. |
| Isolated SQL/project state | runtime/db/workspace guard | A writes invisible to B. |
| Isolated Great Book | Great Book identity/projection | A ACCEPT absent in B; retained after switching back. |
| Isolated recognition cache/snapshot | recognition/workspaces | B never reuses A cache; A unchanged state reused on return. |
| Target Description per project | authority model/UI | A/B bind different files/hashes. |
| Master Benchmark per project | authority/benchmark runtime | Missing/invalid benchmark blocks proof readiness. |
| Project Intent supported | authority/UI/context | Optional document binds when enabled; no compiler claim yet. |
| Multiple additional docs | authority/UI | Add/remove several documents. |
| Role/order/enabled/hash | authority/hash/UI | Deterministic basis; disabled omitted; change alters hash. |
| Governed drift detected | authority/mission | Modify C; `AUTHORITY CHANGED`; old proof basis stale. |
| Recognition project-scoped | profile/recognition | Roots/excludes/config differ safely by project. |
| PowerShell visible/testable | host readiness/UI/API | Executable/start/handshake/root parity. |
| Git visible/testable | Git readiness/UI/API | Local-only distinct from invalid; Start never syncs. |
| Chrome visible/testable | browser subsystem/UI/API | managed endpoint, exact target, ambiguity/origin/disconnect refusals. |
| GPT visible/testable | gateway readiness/UI/API | credential present, provider reachable, exact model, no fallback. |
| GPT secrets protected | schemas/store/API/UI/log/evidence | Secret scanners and explicit negative tests find no raw key. |
| Metric Catalogue unchanged | existing catalogue | Existing validation/parity suite remains green. |
| Benchmark Runtime scoped | benchmarkRuntime | A/B runtime parameters isolated and benchmark-consistent. |
| Global defaults vs overrides | canonicalization/UI | Effective values and source labels correct. |
| Operation-specific readiness | readiness/status/UI | Optional remote/browser do not block unrelated local work. |
| Deterministic profile version/hash | hash service | Canonical/order tests; behavior change changes hash. |
| Profile identity in mission/proof | mission/cycle/proof | Every governed operation binds project identity. |
| SURF/DIVE switch correctly | runtime registry/Q1 | No A nodes visible in B; replay B; return A reuses A. |
| No mixed state | activation/runtime/UI | Fault-injection at each switching stage. |
| Backend enforces invariants | APIs/store/services | Direct API calls cannot bypass UI restrictions. |
| Safe deletion | store/API/CLI/UI | Profile/state deletion never deletes target repository. |

---

## 35. B18 — Documentation release and governance completion

The full Project Profiles implementation changes configuration, persistence, mission identity, Status, runtime switching, APIs and UI. It requires a coordinated new documentation release. Do not edit the ratified v9 pack in place.

### 35.1 Proposed v10 authority pack updates

Update the owner documents whose contracts changed:

| Document | Required update |
|---|---|
| `CLUE_Architecture_v10.md` | Global vs project configuration, profile store, runtime generations, state isolation, activation architecture. |
| `CLUE_Execution_Model_v10.md` | Project operation identity, switching barriers, stale-proof behavior, per-project cycles/benchmarks. |
| `CLUE_Interface_Design_v10.md` | Full Configuration control plane, active-project identity, readiness and errors. Resolve the currently present untracked v10 file through coordinated governance rather than assuming it is final. |
| `CLUE_Project_Directory_v10.md` | New `src/control/projectProfiles`, API/UI modules, profile-store layout and ownership. |
| `CLUE_AI_Utilization_v10.md` | Governed document context, credential references, exact model per project, profile identity in AI requests. |
| `CLUE_Git_Integration_v10.md` | Per-project repo/remote/publication settings and local-only semantics. |
| `CLUE_Status_Contract_v10.md` | Active Project ID/profile hash/readiness/capability fields and schema migration. |
| `CLUE_Q1_System_Navigator_v10.md` | SURF/DIVE project switching, generation reset/replay and stale-event rejection. |
| `DOCUMENTATION_GOVERNANCE_v10.md` | Profile authority/change/drift and supplement promotion process, if governance ownership changes. |

Carry forward unchanged constitutional/RPI/Metric Catalogue text only through the normal manifest process; do not create needless semantic changes.

### 35.2 Create coordinated release evidence

```text
DOCUMENTATION_MANIFEST_v10.json
SHA256SUMS_v10.txt
README_v10.md
VALIDATION_REPORT_v10.md
PROJECT_PROFILES_MIGRATION_REPORT.json
PROJECT_PROFILES_ACCEPTANCE_REPORT.json
```

Update `config/clue.config.yaml` tracked-document registration only when the complete v10 pack is ready. Then:

1. run all static, selftest, dashboard, Navigator and acceptance suites;
2. validate every v10 hash;
3. ratify the new authority pack;
4. seal the `POST-P2-PROJECT-PROFILES` epoch;
5. run a representative local proof/recognition cycle on at least two profiles;
6. preserve migration and isolation evidence;
7. obtain explicit Creator acceptance of the Project Profiles implementation.

The P2 closure receipt remains historical evidence and must not be rewritten.

---

## 36. Recommended patch delivery sequence

Every package below must leave the project buildable and testable.

```text
P2-CLOSE-00  final archive delta audit and inventory; no source change
P2-CLOSE-01  preflight/readiness/authority manifests; external evidence only
P2-CLOSE-02  proof contract + recognizer candidate manifest; external inputs only
P2-CLOSE-03  ceremony evidence, ACCEPT, Great Book, cycle closure, release receipt

PP-01  pathIdentity.ts + project-root-identity test
PP-02  projectOperationIdentity.ts + test
PP-03  full profile schema + schema tests
PP-04  profile canonicalization/hash + tests
PP-05  atomic profile store + tests
PP-06  registry/uniqueness + tests
PP-07  profile event log + tests
PP-08  legacy migration + tests
PP-09  workspace identity guard + tests
PP-10  memory/artifact isolation + tests
PP-11  config v3 + active profile runtime + updated runtime tests
PP-12  atomic activation/runtime manager + switching tests
PP-13  project authority model + tests
PP-14  conflict/drift service + tests
PP-15  mission/context/cycle lock integration + tests
PP-16  Great Book identity/isolation + tests
PP-17  proof/cycle identity/isolation + tests
PP-18  benchmark runtime + tests
PP-19  recognition profile/cache isolation + tests
PP-20  SURF/DIVE rebinding + tests
PP-21  PowerShell/Host readiness + tests
PP-22  Git readiness + tests
PP-23  browser readiness/target resolver + tests
PP-24  browser execution/capture ledger + tests
PP-25  browser project-switch integration + tests
PP-26  GPT readiness/safety/project identity + tests
PP-27  operation-specific readiness + tests
PP-28  Status/active identity wire migration + tests
PP-29  project API service + tests
PP-30  dashboard server integration + tests
PP-31  project CLI + authority tests
PP-32  Configuration shell/project selector/editor + tests
PP-33  authority editor + tests
PP-34  integration editors/readiness panel + tests
PP-35  action contracts/app active-project integration + tests
PP-36  full cross-project/fault-injection/browser acceptance suite
PP-37  v10 documentation pack, migration report, ratification and release
```

No package should contain unrelated Q1 visual work, adapter-registry implementation or Project Intent Model compiler work.

---

## 37. Explicitly deferred beyond this strategy’s Project Profiles completion

The following remain separate P3 or later programmes unless a new authority document promotes them:

```text
Project Intent Model compiler (AMB-003)
universal environment adapter registry
full P4 governed remote landing lifecycle
automatic semantic understanding of every natural-language authority conflict
```

Project Profiles must provide the clean configuration hooks for those future systems, but must not claim their implementation.

---

## 38. Final go/no-go checklist

### Before P2 ceremony

```text
[ ] latest complete archive received and audited
[ ] exact final tree inventory/hash captured
[ ] no parallel edits
[ ] Q1/SURF latest accepted version retained
[ ] typecheck/build/full Windows selftest pass
[ ] dashboard and Navigator suites pass
[ ] doctor/status/runtime roots agree
[ ] active authority manifest complete and conflict-free
[ ] supplement hashed as deferred post-P2 authority
[ ] Master Benchmark valid
[ ] OPENAI_API_KEY present only in host environment
[ ] exact gpt-5.6 operational, no fallback
[ ] NO_REMOTE_YET explicit and valid
[ ] Start does not sync Git
```

### P2 ceremony

```text
[ ] docs ratified; ratificationCurrent=true
[ ] P2-authoritative epoch sealed/current
[ ] cycle reaches SCREENED
[ ] proof contract/candidate/rollback frozen
[ ] at least one durable proof attempt and verdict
[ ] one real ACCEPT
[ ] atomic Great Book contribution
[ ] cycle closes proof-authoritative with criteriaMet=true
[ ] formalClosurePass=true
[ ] p2Closed=true
[ ] closureState=CLOSED
[ ] blockers=[]
[ ] final release/status/P0/probe evidence preserved
[ ] Creator approval recorded
[ ] immutable P2 closure receipt stored
```

### Project Profiles completion

```text
[ ] full versioned profile schema/store/registry
[ ] unique Project ID and canonical Target Root
[ ] preserved legacy CLU profile/workspace migration
[ ] atomic project activation and no mixed state
[ ] isolated workspace/database/events/artifacts
[ ] isolated Great Book, recognition, proof and cycles
[ ] authority bindings, roles/order/enabled/hash/drift/conflicts
[ ] profile identity in mission and governed operations
[ ] project-scoped recognition and benchmark runtime
[ ] PowerShell/Git/Chrome/GPT readiness
[ ] exact model and credential secrecy
[ ] operation-specific READY/READY_LOCAL_ONLY/etc.
[ ] backend CRUD/activate/validate/test/readiness APIs
[ ] CLI operations and authority controls
[ ] modular Configuration UI
[ ] SURF/DIVE active-project switch and replay
[ ] all supplement acceptance tests and fault injection pass
[ ] v10 documentation pack validated, ratified and epoch-sealed
[ ] Creator accepts Project Profiles implementation
```

---

## 39. Terminal completion statement

The project reaches the intended full state only when:

```text
P2 has an immutable, machine-verifiable and Creator-approved closure receipt
AND
Project Profiles satisfy the complete post-P2 Definition of Done under a new governed authority generation
AND
no deferred P3 capability is falsely reported as implemented.
```

This sequence preserves the truth of P2, prevents scope expansion during its closure, and then implements the Configuration supplement as the first disciplined post-P2 architectural programme.
