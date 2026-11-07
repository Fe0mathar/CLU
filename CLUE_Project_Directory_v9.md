# CLU-E Project Directory v9
## Canonical Target Source Tree, Module Ownership, Dependency Direction, and Runtime Data Boundaries

**Document status:** Permanent target responsibility map  
**Version:** 9.0 (pack-coordinated), document revision 9.4 — version 8.0 content preserved at the v9 re-baseline; amended through ADR-0017 to register the operational OpenAI provider boundary, Status 5.7.0, controlled provider pause, manual local-first Git sync and final P2 closure-policy owners. Pack release unchanged.  
**System:** CLU-E — Recursive Project Improvement reference engine  
**Detailed owners:** Architecture v9, Execution Model v9, and the domain contracts named below  

---

# 1. Purpose

This document assigns each permanent CLU-E responsibility to one canonical source area. It answers:

- where a capability belongs;
- which module owns a durable record or transition;
- which dependencies are allowed;
- which files are program source, configuration, generated output, or runtime state;
- how the four interface quadrants map to backend projections;
- where target-project inputs and the evolving Master Benchmark are implemented.

It does **not** describe current implementation completeness, current defects, or the order in which missing files should be created. Those belong to the external dynamic backlog.

The paths below are the canonical target layout. A physical implementation may temporarily retain compatibility wrappers, but every responsibility must resolve to the owner defined here and no second module may become an independent authority for the same state.

---

# 2. Top-level directory contract

```text
CLU-E/
├─ README.md
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ .gitignore
├─ config/
├─ docs/
├─ schemas/
├─ scripts/
├─ selftest/
├─ src/
├─ targets/
├─ ui/
└─ workspace/                 runtime data only; not permanent knowledge
```

| Path | Responsibility |
|---|---|
| `README.md` | operator-facing entry point to the executable repository; it links to, but does not duplicate, the permanent documentation pack |
| `package.json` | package identity, supported engines, scripts, and distributable-file allowlist |
| `package-lock.json` | exact dependency resolution for a reproducible installation |
| `tsconfig.json` | compiler contract for authored TypeScript |
| `.gitignore` | generated, secret-bearing, cache, worktree, profile, and runtime-state exclusions |
| `config/` | governed installation and target-registration policy |
| `docs/` | component-local implementation documentation that remains subordinate to the permanent documentation pack |
| `schemas/` | versioned machine schemas at process, artifact, packet, and UI boundaries |
| `scripts/` | narrowly scoped operator and restricted-host entry points |
| `selftest/` | deterministic tests and conformance fixtures |
| `src/` | backend, orchestration, evidence, integration, and status implementation |
| `targets/` | versioned target profiles and target-owned benchmark/supporting inputs selected by `project.active_target` |
| `ui/` | browser-side presentation and interaction only |
| `workspace/` | append-only events, immutable artifacts, projections, streams, worktrees, profiles, temporary execution state, and exports |

`workspace/` is never source code and must not be bundled into a source release or permanent documentation archive.

---

# 3. Configuration tree

```text
config/
├─ clue.config.yaml
├─ policies/
│  ├─ authority.yaml
│  ├─ paths.yaml
│  ├─ patching.yaml
│  ├─ routing.yaml
│  ├─ budget.yaml
│  ├─ equilibrium.yaml
│  ├─ p2-closure.yaml
│  ├─ privacy.yaml
│  ├─ retention.yaml
│  ├─ git.yaml
│  └─ benchmark.yaml
├─ measurements/
│  ├─ catalogue.yaml
│  └─ normalization.yaml
├─ environments/
│  └─ adapters.yaml
└─ ui/
   └─ presentation.yaml

targets/
└─ <target-id>/
   ├─ profile.yaml
   └─ benchmark/
      └─ master-benchmark.md
```

## 3.1 `config/clue.config.yaml`

Owns installation-level defaults and references to separately versioned policy files. It may define:

- workspace root;
- artifact and event-store locations;
- local service endpoints;
- approved browser profile and executables;
- default provider routing policy;
- status publication settings;
- active target selection through `project.active_target`.

It must not contain target-project secrets, mutable run state, or hardcoded evidence results.

## 3.2 `targets/<target-id>/profile.yaml`

Registers one target project or repository set. It owns:

- project ID and display name;
- repository registrations and roles;
- governed inventory roots and exclusions;
- native adapter extraction scopes;
- path to `target description.md`;
- path to the target's Master Benchmark;
- supported environments;
- required human approvals;
- benchmark environment policy;
- deployment-specific provider restrictions;
- project-specific risk and change budgets.

The active profile is selected by `config/clue.config.yaml → project.active_target`. Profile
paths resolve under the executable target contract and there is exactly one active target
authority. The profile points to project inputs but does not duplicate their content.

## 3.3 `config/policies/`

| File | Sole responsibility |
|---|---|
| `authority.yaml` | capability issuance, role restrictions, approval requirements, and command classes |
| `paths.yaml` | canonical source, workspace, shadow, worktree, browser-profile, export, and prohibited-root relationships |
| `patching.yaml` | protected surfaces, change-size limits, permitted file classes, and candidate mutation restrictions |
| `routing.yaml` | AI provider/model tiers, permitted task classes, escalation, fallback, and budget policy |
| `budget.yaml` | exact price schedule, reservations, call/token ceilings, degradation, and hard spend authority |
| `equilibrium.yaml` | evidence, capability, economic, assurance, and stop-policy inputs |
| `p2-closure.yaml` | mission-bound Creator decision for P2 gateway closure and explicit P3 deferrals; never a phase result |
| `privacy.yaml` | redaction, secret scanning, data classification, external-provider exclusions, and retention |
| `retention.yaml` | event, artifact, evidence, branch, worktree, benchmark, and export retention classes |
| `git.yaml` | approved repositories, remotes, providers, refs, signing, review, publication, and landing policy |
| `benchmark.yaml` | runner authorization, execution budgets, environment matching, variance, freshness, and bridge-run policy |

A missing or malformed safety policy must fail closed for any mode that could mutate files, execute external tools, call an external AI provider, or land Git changes.

## 3.4 `config/measurements/`

`catalogue.yaml` is the machine-readable form of the canonical 100-measure catalogue. `normalization.yaml` contains versioned visualization transforms and reference ranges. Native evidence and verdict rules remain defined by the catalogue, not by UI configuration.

## 3.5 `config/environments/adapters.yaml`

Registers enabled Environment Adapters and their capability slices. It may enable or disable installed adapters but may not claim a semantic or proof capability absent from the adapter implementation.

## 3.6 `config/ui/presentation.yaml`

Contains non-authoritative presentation preferences such as density, motion, accessibility, display units, and local layout defaults. It cannot redefine lifecycle states, measure meaning, Q1 classification, or verdicts.

---

# 4. Documentation and schema tree

```text
docs/
├─ architecture-decisions/
├─ adapters/
├─ benchmarks/
├─ dashboard/
├─ system-navigator/
├─ great-book-field/
├─ gauges/
└─ operational-console/

schemas/
├─ events/
├─ artifacts/
├─ ai/
├─ inventory/
├─ recognition/
├─ metrics/
├─ experiments/
├─ benchmark/
├─ git/
├─ status/
└─ ui/
```

## 4.1 `docs/`

Component-local documentation explains implementation details, local extension points, and developer workflows. It must:

- identify the permanent contract it implements;
- avoid redefining constitutional or RPI rules;
- carry a compatibility/version statement;
- link current work to the external backlog rather than embedding stale task lists.

Architecture decision records belong under `docs/architecture-decisions/` and preserve alternatives, decision date, affected contracts, migration implications, and supersession state.

## 4.2 `schemas/`

Every cross-process or durable JSON/NDJSON shape has one versioned schema owner. Schemas must be:

- strict by default;
- independently testable;
- content-addressed where embedded in packets;
- backward-compatible only through explicit migration;
- referenced by exact schema ID and version in the record that uses them.

The TypeScript type system may mirror a schema but cannot silently become a second wire authority.

---

# 5. Scripts and self-tests

```text
scripts/
├─ clue-host.ps1
├─ launch-test-browser.ps1
├─ verify-release.mjs
└─ install-profile.ps1

selftest/
├─ kernel.test.ts
├─ documents.test.ts
├─ source.test.ts
├─ inventory.test.ts
├─ orchestration.test.ts
├─ ai.test.ts
├─ metrics.test.ts
├─ benchmark.test.ts
├─ git.test.ts
├─ status.test.ts
├─ console.test.ts
└─ fixtures/
```

## 5.1 `scripts/clue-host.ps1`

The Windows restricted-host boundary. It implements only the closed command registry exposed by the host client. It independently:

- resolves and classifies paths;
- rejects traversal, junction, symlink, and root-overlap escapes;
- validates command-specific arguments;
- executes approved filesystem, process, browser, benchmark, and Git operations;
- returns typed receipts;
- never accepts an arbitrary shell command from AI or browser code.

## 5.2 `scripts/launch-test-browser.ps1`

Starts the dedicated test browser with the governed profile, debugging endpoint, extensions, and flags required by the selected project policy.

## 5.3 `scripts/verify-release.mjs`

Runs package, schema, documentation-reference, manifest, checksum, build, and test gates required for a release artifact.

## 5.4 `selftest/`

Tests are organized by responsibility, not by historical implementation phase. Each durable subsystem must prove:

- schema rejection behavior;
- exact replay or rehydration;
- identity uniqueness;
- idempotency;
- fail-closed authority;
- deterministic output under equal inputs;
- crash/restart and partial-failure behavior where applicable.

Large mixed-language, large-repository, benchmark, Git, and status fixtures belong under `selftest/fixtures/` and are not production data.

---

# 6. Backend source tree

```text
src/
├─ cli/
├─ control/
├─ memory/
├─ config/
├─ intent/
├─ analysis/
├─ ai/
├─ metrics/
├─ improvement/
├─ testing/
├─ benchmark/
├─ evaluation/
├─ proof/
├─ greatBook/
├─ equilibrium/
├─ cycle/
├─ closure/
├─ experiment/
├─ integration/
├─ observability/
├─ status/
├─ ui/
├─ daemon/
└─ shared/
```

The top-level source areas follow the dependency direction in Section 21. A browser module or integration adapter may not bypass control, authority, evidence, or status boundaries merely because it can access the same local filesystem or process.

---

# 7. `src/cli/` — command entry points

```text
src/cli/
├─ index.ts
├─ commandAuthority.ts
├─ commands/
│  ├─ <domain>Commands.ts
│  └─ shared.ts
└─ output/
   └─ formatter.ts
```

**NEW —** `commands/` contains one module per command domain, named `<domain>Commands.ts` for
the domain as the operator types it: `clue snapshot` is implemented by
`commands/snapshotCommands.ts`. A domain with several subcommands is a single module — `task
list`, `task show`, `task export` and the rest are all `commands/taskCommands.ts` — because a
domain, not a subcommand, is the unit an operator and a reviewer both reason about.

**NEW —** The suffix is load-bearing rather than decorative. Four domains share a name with the
domain module the command calls (`graph`, `snapshot`, `mission`, `audit`), and without the
suffix the CLI veneer and the authoritative owner are indistinguishable in an editor tab, a
stack frame, or a review diff. A module under `commands/` that implements no domain keeps a
plain unsuffixed name; `shared.ts` is the only one, and the missing suffix is what marks it as
a helper.

`commandAuthority.ts` holds the closed registry of every declared command with its capability,
mutation and mission requirements. `output/` contains presentation helpers shared across
command modules. `index.ts` composes the program, applies the authority hook, and owns nothing
else.

**NEW —** Command modules current or anticipated at the time of writing, informative and not a
closed set:

```text
initCommands.ts        recognizeCommands.ts    snapshotCommands.ts    graphCommands.ts
statusCommands.ts      doctorCommands.ts       metricsCommands.ts     candidatesCommands.ts
taskCommands.ts        consoleCommands.ts      claimsCommands.ts      conflictsCommands.ts
auditCommands.ts       missionCommands.ts      seedsCommands.ts       docsCommands.ts
cycleCommands.ts       benchmarkCommands.ts    proofCommands.ts       gatewayCommands.ts
gitCommands.ts
```

`cycleCommands.ts`, `benchmarkCommands.ts`, `proofCommands.ts` and `gatewayCommands.ts` are
implemented command domains. `gitCommands.ts` remains an informative future owner only. A module
appears when its domain does; the rule above governs, not this list. `consoleCommands.ts` and its helper
`operationalConsoleCommands.ts` currently sit at `src/cli/` rather than under `commands/` —
a location divergence recorded as a declared exception in
`selftest/cli-layout-conformance.test.ts` rather than left implicit.

The CLI is a thin transport over application services. It owns:

- command parsing;
- local interactive confirmation;
- human-readable output;
- exit codes;
- selection of a registered project and command profile.

It does not implement recognition, AI reasoning, Git operations, benchmark logic, or verdict
authority directly.

---

# 8. `src/control/` — authority and orchestration control plane

```text
src/control/
├─ runtime.ts
├─ mission.ts
├─ authority.ts
├─ policy.ts
├─ audit.ts
├─ tasks.ts
├─ contextBuilder.ts
├─ sessionPackets.ts
├─ commandDispatcher.ts
└─ leases.ts
```

| File | Responsibility |
|---|---|
| `runtime.ts` | compose read-only, maintenance, analysis, experiment, and landing runtimes from validated dependencies |
| `mission.ts` | register immutable mission versions and amendments before authoritative work |
| `authority.ts` | issue, validate, and revoke scoped capability and attempt tokens |
| `policy.ts` | load and evaluate governed policy; fail closed for malformed safety rules |
| `audit.ts` | correlate requested action, authority, execution, result, and evidence receipt |
| `tasks.ts` | durable dependency-aware queue, attempts, leases, retries, and terminal states |
| `contextBuilder.ts` | construct typed, minimal, evidence-linked context packets from immutable inputs |
| `sessionPackets.ts` | export/import exact task packets and validate returned results and attachments |
| `commandDispatcher.ts` | route typed commands to authorized services; no arbitrary command execution |
| `leases.ts` | shared lease/attempt compare-and-swap primitives where not embedded in task or Git state machines |

Control-plane code may decide that an action is permitted. It may not decide that a candidate is improved without the Evaluation and proof contracts.

---

# 9. `src/memory/` — durable evidence and rebuildable projections

```text
src/memory/
├─ eventLog.ts
├─ artifactStore.ts
├─ db.ts
├─ projectionRegistry.ts
├─ canonicalJson.ts
├─ integrity.ts
└─ export.ts
```

| File | Responsibility |
|---|---|
| `eventLog.ts` | one append-only, hash-chained durable state-transition authority |
| `artifactStore.ts` | immutable content-addressed blobs and safe export |
| `db.ts` | SQLite connection modes, transactions, migration, and projection storage |
| `projectionRegistry.ts` | declare every projection table, reset order, replay handler, and artifact rehydrator |
| `canonicalJson.ts` | stable canonical serialization used for hashes and signatures |
| `integrity.ts` | chain, blob, projection-head, seal, and cross-record parity checks |
| `export.ts` | canonical evidence and release export manifests |

SQLite contains no independent truth. Deleting it and rebuilding from events plus artifacts must reproduce the same canonical projections.

---

# 10. `src/config/` and `src/intent/` — project registration and purpose

```text
src/config/
├─ ProjectInputConfig.ts
├─ ConfigLoader.ts
├─ ConfigValidator.ts
└─ ConfigSnapshot.ts

src/intent/
├─ TargetDescriptionLoader.ts
├─ ProjectIntentModel.ts
├─ ProjectIntentCompiler.ts
├─ IntentRetriever.ts
└─ IntentAlignment.ts
```

## 10.1 Configuration modules

- `ProjectInputConfig.ts` owns the registered paths, hashes, validation, and cycle-lock metadata for `target description.md` and `benchmark.txt`.
- `ConfigLoader.ts` reads installation, project, policy, adapter, measurement, and UI configuration without applying business decisions.
- `ConfigValidator.ts` performs schema and cross-field validation, including realpath/non-overlap safety.
- `ConfigSnapshot.ts` produces the immutable configuration basis included in a mission and cycle seal.

## 10.2 Intent modules

- `TargetDescriptionLoader.ts` loads, normalizes, hashes, and snapshots the selected Markdown.
- `ProjectIntentModel.ts` defines stable purpose, objective, capability, constraint, priority, environment, non-goal, and ambiguity records.
- `ProjectIntentCompiler.ts` converts the complete description into the versioned model.
- `IntentRetriever.ts` provides only relevant objective fragments to a task or AI invocation.
- `IntentAlignment.ts` maps declared intent to implementation and evidence while preserving the distinction between a claim and proof.

---

# 11. `src/analysis/` — deterministic recognition and project representation

```text
src/analysis/
├─ environments/
│  ├─ adapterRegistry.ts
│  ├─ artifactTaxonomy.ts
│  ├─ artifactClassifier.ts
│  └─ capabilityRegistry.ts
├─ source/
│  ├─ snapshot.ts
│  ├─ repositoryInventory.ts
│  ├─ recognizer.ts
│  ├─ scanCache.ts
│  ├─ graph.ts
│  ├─ navigatorEvents.ts
│  └─ navigatorProjection.ts
├─ upr/
│  ├─ model.ts
│  ├─ builder.ts
│  ├─ identity.ts
│  └─ provenance.ts
├─ documents/
│  ├─ documentRegistry.ts
│  ├─ claimRegistry.ts
│  ├─ conflictRegistry.ts
│  └─ documentationAlignment.ts
├─ purpose/
│  ├─ purposeRecords.ts
│  └─ responsibilityMap.ts
├─ method/
│  └─ frontier.ts
├─ proof/
│  └─ instruments.ts
└─ value/
   └─ realization.ts
```

## 11.1 Environment Adapter Registry

`adapterRegistry.ts` owns installed adapters and exact capability declarations. Each adapter reports:

- physical formats and languages;
- inventory classification support;
- structural and semantic recognition depth;
- native compilers, linters, tests, profilers, browsers, databases, or interpreters;
- metric and proof-instrument support;
- limitations and unsupported states.

The registry is language-neutral. Adapter-specific code may be placed under `src/analysis/environments/adapters/<adapter-id>/`.

## 11.2 Artifact taxonomy and inventory

- `artifactTaxonomy.ts` defines the versioned family/environment registry used by Q1 ALL.
- `artifactClassifier.ts` performs conservative backend-owned classification with provenance and confidence.
- `snapshot.ts` separates immutable content identity from capture identity and records the governed basis.
- `repositoryInventory.ts` creates one physical file record per eligible repository artifact, independent of semantic recognition.
- `navigatorProjection.ts` publishes inventory before semantic enrichment.

## 11.3 Recognition and graph

- `recognizer.ts` coordinates adapters over an exact immutable basis and emits collision-free source identities.
- `scanCache.ts` decides safe incremental reuse and always produces a complete canonical merged result.
- `graph.ts` owns durable semantic unit and relationship projections, unresolved references, provenance, and endpoint integrity.
- `navigatorEvents.ts` owns the versioned inventory/recognition stream consumed by Q1.

## 11.4 Universal Project Representation

- `model.ts` defines language-neutral entities, capabilities, runtime paths, data relationships, and uncertainty.
- `builder.ts` merges native adapter output without discarding native evidence.
- `identity.ts` owns stable UPR identity and alias/migration records.
- `provenance.ts` maps every UPR claim back to exact native artifacts and tool output.

## 11.5 Documents, purpose, method, proof instruments, and value

These modules preserve structured understanding outside source syntax:

- document content identity and location/version identity;
- claims, conflicts, evidence, and lifecycle;
- semantic responsibility and purpose records;
- Problem Class, Current Method, and Solution Frontier;
- proposed or calibrated proof instruments;
- forecast, partial, realized, invalidated, and superseded value records.

AI may propose records in these areas, but the registries retain provenance, authority, and explicit uncertainty.

## 11.6 Implemented governed scenario evidence

The P2 Stage G2 implementation is owned by:

```text
src/analysis/scenarios/
├─ scenarioRunner.ts
├─ nodeConsoleCapture.ts
└─ nodeAttributor.ts
```

`scenarioRunner.ts` executes only the named `runtime.scripts` set under the existing writer-lock choreography and refuses any script that would recursively invoke `clue`. `nodeConsoleCapture.ts` preserves source-faithful Node diagnostics; `nodeAttributor.ts` maps frames back to recognized units without blind path rewriting. Scenario evidence is collected here and consumed by metrics/proof services; this area never issues a verdict.

---

# 12. `src/ai/` — semantic reasoning infrastructure

```text
src/ai/
├─ AiProvider.ts
├─ AiModelRouter.ts
├─ AiTaskPolicy.ts
├─ AiTokenBudget.ts
├─ AiInvocationLedger.ts
├─ AiResultCache.ts
├─ AiContextPolicy.ts
├─ AiSchemaValidator.ts
├─ PromptTemplateRegistry.ts
├─ AiContextPacket.ts
├─ SemanticEnrichmentService.ts
├─ SemanticSummaryStore.ts
├─ SemanticInvalidation.ts
├─ DocumentationAlignmentService.ts
└─ AmbiguityResolutionService.ts
```

The AI layer owns no filesystem, Git, benchmark, metric, verdict, or landing authority.

| Module | Responsibility |
|---|---|
| provider/router/policy | provider-neutral invocation and risk/value/uncertainty-based model selection |
| token budget | mission, task, retry, and reserved-adjudication budgets |
| invocation ledger | immutable provider/model, input-hash, output-hash, schema, token, latency, cache, and downstream-use records |
| result cache | content-addressed reusable interpretations with explicit invalidation |
| context policy | redaction, sensitivity, provider eligibility, and permitted context levels |
| schema validator | reject malformed AI output before it becomes a claim or plan |
| prompt registry | version prompt contracts and required evidence/output schemas |
| context packet | typed identity, structure, intent, metric, change, and evidence inputs |
| semantic services | responsibility inference, documentation alignment, ambiguous relationships, and hierarchical summaries |

Deployment configuration may restrict CLU-E to one approved provider. The source architecture remains provider-neutral so provider policy is not confused with system truth.

## 12.1 Implemented P2 Model Gateway boundary

The governed P2 implementation is owned by:

```text
src/ai/gateway/
├─ policy.ts
├─ gatewayProjection.ts
├─ openaiAdapter.ts
└─ modelGateway.ts
```

- `policy.ts` strictly validates `config/policies/budget.yaml` and `routing.yaml`, including exact model/price identity, caps and degradation policy;
- `modelGateway.ts` owns event-first admission, short writer phases, unlocked provider I/O and terminal reconciliation;
- `openaiAdapter.ts` owns bounded Responses and Batch transport and never persists a credential value;
- `gatewayProjection.ts` rebuilds call/accounting state consumed by Status `aiOrchestration`.

The shipped policy is implemented but safe-disabled. Activation remains an explicit Creator decision recorded in `config/policies/p2-closure.yaml`; source availability alone grants no provider traffic or spend authority.

---

# 13. `src/metrics/` — catalogue applicability and measurements

```text
src/metrics/
├─ CatalogueLoader.ts
├─ MetricApplicabilityMetadata.ts
├─ MetricApplicabilityRules.ts
├─ MetricApplicabilityService.ts
├─ CandidateMetricScope.ts
├─ MetricRunner.ts
├─ MetricRegistry.ts
├─ Normalization.ts
└─ AiEfficiencyMetrics.ts
```

- `CatalogueLoader.ts` validates the canonical 100-measure machine catalogue and its hash.
- applicability modules prove that every measure was screened while deep assessment is limited to relevant measures;
- `CandidateMetricScope.ts` expands evaluation from the initial target to affected dependencies and runtime paths;
- `MetricRunner.ts` invokes deterministic native instruments and stores native evidence;
- `MetricRegistry.ts` records values, applicability, quality, provenance, and invalidation;
- `Normalization.ts` creates comparison/display values without altering native units;
- `AiEfficiencyMetrics.ts` measures CLU-E’s own reasoning economy and evidence yield.

Metric code calculates and records facts. It does not form an RPI verdict by itself.

---

# 14. `src/improvement/` — finding and candidate intelligence

```text
src/improvement/
├─ ImperfectionHypothesisService.ts
├─ HypothesisDeduplicator.ts
├─ CandidatePrioritizer.ts
├─ PatchPlanningService.ts
├─ PatchGenerationService.ts
└─ CandidateRegistry.ts
```

| Module | Responsibility |
|---|---|
| `ImperfectionHypothesisService.ts` | create evidence-linked, metric-scoped, uncertainty-preserving improvement hypotheses |
| `HypothesisDeduplicator.ts` | detect repeated or semantically equivalent hypotheses and reuse prior decisions |
| `CandidatePrioritizer.ts` | combine intent, evidence, expected value, risk, reversibility, cost, and policy |
| `PatchPlanningService.ts` | propose the smallest causal change and affected scope |
| `PatchGenerationService.ts` | produce controlled candidate diffs under explicit file and authority limits |
| `CandidateRegistry.ts` | own candidate identity, state, hypothesis link, branch/worktree link, and terminal result |

A generated patch is a candidate artifact, not an accepted improvement.

## 14.1 Implemented Great Book recursive-memory owner

The durable P2 Great Book implementation is owned by:

```text
src/greatBook/
├─ greatBookEntry.ts
└─ greatBookProjection.ts
```

An `ACCEPT` verdict and its Great Book consequence are one event-first authority act. `greatBookEntry.ts` creates and validates the content-addressed entry; `greatBookProjection.ts` rebuilds immutable entries and contribution rows from `proof.verdict_recorded`. `src/ui/greatBookImprovementField.ts` is a reader of that projection and cannot manufacture an improvement.

---

# 15. `src/testing/`, `src/benchmark/`, and `src/evaluation/`

```text
src/testing/
├─ TestGapAnalysisService.ts
├─ TestPlanRegistry.ts
├─ TestRunner.ts
└─ TestEvidenceDigest.ts

src/benchmark/
├─ BenchmarkDesignService.ts
├─ BaselineRegistry.ts
├─ BenchmarkEvidenceDigest.ts
├─ MasterBenchmarkLoader.ts
├─ MasterBenchmarkSpec.ts
├─ MasterBenchmarkNormalizer.ts
├─ BenchmarkContributionRecord.ts
├─ MasterBenchmarkCoverage.ts
├─ MasterBenchmarkEnrichmentService.ts
├─ MasterBenchmarkCritic.ts
├─ MasterBenchmarkValidator.ts
├─ MasterBenchmarkVersionStore.ts
├─ MasterBenchmarkRunner.ts
└─ MasterBenchmarkAssessmentService.ts

src/evaluation/
├─ ProofContract.ts
├─ CandidateAssessmentService.ts
├─ TradeoffAdjudicationService.ts
├─ FailureDiagnosisService.ts
├─ VerdictRegistry.ts
└─ EvidenceQuality.ts
```

## 15.1 Testing

The testing area identifies missing proof, defines test plans, invokes approved runners, and compresses results. Native test frameworks remain the factual execution authority.

## 15.2 Candidate benchmarks

`BenchmarkDesignService.ts` creates a hypothesis-specific proof plan. `BaselineRegistry.ts` owns reuse and invalidation. `BenchmarkEvidenceDigest.ts` gives AI a compact summary while preserving raw evidence references.

## 15.3 Master Benchmark

- `MasterBenchmarkLoader.ts` loads and snapshots `benchmark.txt`.
- `MasterBenchmarkSpec.ts` owns the normalized executable contract.
- `MasterBenchmarkNormalizer.ts` converts the configured representation without giving AI execution authority.
- `BenchmarkContributionRecord.ts` captures durable measurement lessons from accepted and rejected work.
- `MasterBenchmarkCoverage.ts` maps scenarios/signals to objectives, capabilities, runtime paths, measures, environments, and risks.
- enrichment and critic services propose and independently challenge revisions.
- validator, version store, runner, and assessor own deterministic execution, versioning, bridge evidence, final vital signs, and next-cycle seeds.

## 15.4 Evaluation

The Evaluation area owns the Proof Contract, evidence quality, candidate-level assessment, cross-measure trade-offs, failure classification, and verdict records. Hard gates remain deterministic. AI may recommend a verdict, but only the evaluation state machine may issue the authoritative RPI verdict after all required evidence and authority checks pass.

## 15.5 Implemented P2 benchmark and deterministic proof core

The current executable owners are:

```text
src/benchmark/
├─ harnessBlock.ts
└─ benchmarkRunner.ts

src/proof/
├─ proofContract.ts
├─ baselineRegistry.ts
└─ verdict.ts
```

`harnessBlock.ts` and `benchmarkRunner.ts` parse, integrity-check and execute the single registered Master Benchmark artifact. `proofContract.ts` freezes the question before candidate observation; `baselineRegistry.ts` binds/reuses only compatible opening evidence; `verdict.ts` is the sole deterministic `ACCEPT | REJECT | REVISE | INVALID` authority. These concrete owners supersede conceptual filename examples in §§15.2–15.4 wherever the two differ.

---

# 16. `src/experiment/` — isolated execution instruments

```text
src/experiment/
├─ host/
│  └─ hostClient.ts
├─ browser/
│  ├─ browserAgent.ts
│  └─ scenarioDriver.ts
├─ console/
│  └─ consoleLedger.ts
├─ process/
│  └─ processRunner.ts
├─ workspace/
│  └─ experimentWorkspace.ts
└─ proof/
   └─ executionCoordinator.ts
```

The Experiment plane executes an already authorized plan. It owns:

- typed calls to the restricted host;
- dedicated browser discovery, navigation, scenarios, screenshots, traces, and console evidence;
- process execution receipts and timeouts;
- raw console/source maps and source-faithful attribution;
- experiment workspace preparation and cleanup;
- orchestration of baseline and candidate runs under one Proof Contract.

It may collect evidence. It may not reinterpret or accept its own result.

For a CLU-E self-target, `executionCoordinator.ts` owns the only permitted instrument-plane relocation. It rewrites the **shadow copies only** of `config/clue.config.yaml` and the active target profile so benchmark child processes use the candidate tree and a lease-local workspace outside the canonical writer lock. Candidate changes to either relocation authority are refused; canonical bytes are never edited; the before/after instrumentation hashes are carried into the proof verdict. This is not Git/worktree publication authority and does not implement §17.

---

# 17. `src/integration/git/` — complete version-control lifecycle

```text
src/integration/git/
├─ repositoryRegistry.ts
├─ stateCapture.ts
├─ basePin.ts
├─ worktreePool.ts
├─ changeSetPartition.ts
├─ commitLifecycle.ts
├─ publication.ts
├─ reconciliation.ts
├─ retention.ts
├─ recovery.ts
└─ providers/
   ├─ providerAdapter.ts
   └─ <provider-id>.ts
```

| Module | Responsibility |
|---|---|
| repository registry | approved repositories, roles, object formats, refs, remotes, providers, and policy versions |
| state capture/Base Pin | exact local Git state, dirty/untracked content, filters, hooks, LFS, submodules, sparse/partial state, and immutable candidate basis |
| worktree pool | isolated leased worktrees, ownership, expiry, quarantine, cleanup, and Creator-tree protection |
| changeset partition | classify every mutation as intended, required support, incidental, unrelated, generated, forbidden, or unknown |
| commit lifecycle | provisional, sealed, accepted, landed, rejected, reverted, and superseded commit states |
| publication | governed branch/tag/evidence publication with idempotent receipts |
| reconciliation | compare local Git, provider, CI/check, and evidence state without treating provider approval as an RPI verdict |
| retention/recovery | preserve or dispose branches, worktrees, objects, manifests, and evidence under policy with receipts |
| provider adapters | reviews, comments, checks, workflows, branch protection, merge/close, and webhook verification |

`src/control/gitLifecycleOrchestrator.ts` coordinates this domain but does not replace its registries or the Custodian authority.

---

# 18. `src/equilibrium/` and `src/cycle/`

```text
src/equilibrium/
├─ EquilibriumCoverage.ts
├─ ChallengePassPlanner.ts
├─ EquilibriumAssessmentService.ts
├─ MasterBenchmarkEquilibriumGate.ts
└─ EquilibriumRegistry.ts

src/cycle/
├─ cycleOrchestrator.ts
├─ cycleRegistry.ts
├─ cycleInputLock.ts
├─ proofClosure.ts
├─ nextCycleVitalInput.ts
└─ resumePlanner.ts
```

## 18.1 Equilibrium

- tracks physical, semantic, metric, proof, objective, environment, and benchmark coverage;
- targets changed, weakly measured, low-confidence, contradictory, and sampled stable areas;
- preserves explicit residual uncertainty;
- blocks equilibrium when the Master Benchmark remains materially enrichable or exposes an unresolved supported candidate;
- records a bounded equilibrium claim tied to exact project, benchmark, environment, mission, and policy identities.

## 18.2 Cycle

The cycle modules own the durable stage machine described by the Execution Model:

- initialize and lock inputs;
- obtain opening Master Benchmark evidence;
- coordinate recognition, AI, measures, candidates, proof, and landing;
- collect benchmark contributions;
- close with enrichment and final whole-project execution;
- produce next-cycle vital input;
- stop, resume, restart, or fork without losing authority or evidence.

The orchestrator invokes domain services; it does not absorb their logic. `proofClosure.ts` derives the §24 candidate-loop result from durable verdict events for the exact cycle; it does not use a hardcoded diagnostic sentence or accept a foreign-cycle verdict.

## 18.3 P2 phase policy and `src/closure/` — scope is bound, closure is read-only

```text
src/control/
└─ p2ClosurePolicy.ts

src/closure/
└─ p2ClosureAssessment.ts
```

`p2ClosurePolicy.ts` strictly parses the mission-bound D4 decision and the two P3 deferrals in
`config/policies/p2-closure.yaml`. `cycleInputLock.ts` includes that file in `policy_files`: a
pending D4 remains an absence, while an explicit safe-disabled or operational decision may remove
the provider absence only when it agrees with live configuration. The two post-P2 domains leave
`absent` only because their deferral is content-addressed by the lock, not because the modules are
invented.

`p2ClosureAssessment.ts` joins sealed Status, the durable Proof Board, verified ratification/epoch events and the same policy. It reports `ENGINEERING_BLOCKED`, `AWAITING_CREATOR_DECISION`, `READY_FOR_CEREMONY`, or `CLOSED`. It performs no ratification, epoch seal, benchmark, proof, cycle transition, gateway activation or release. Proof and Great Book evidence count only for the latest closed cycle under the current mission. `CLOSED` is emitted only when every required fact is already durable and mutually consistent.

---

# 19. `src/observability/`, `src/status/`, `src/ui/`, and `src/daemon/`

```text
src/observability/
├─ operationalConsole/
│  ├─ store.ts
│  ├─ recorder.ts
│  ├─ redaction.ts
│  └─ reconciliation.ts
└─ telemetry/
   └─ health.ts

src/status/
├─ statusContractV5.ts
├─ statusProjector.ts
├─ statusSeal.ts
├─ freshness.ts
└─ history.ts

src/ui/
├─ viewModel.ts
├─ actionContracts.ts
├─ versionControlProjection.ts
└─ presentationPolicy.ts

src/daemon/
├─ clueDashboardServer.ts
├─ proofBoardProjection.ts
├─ statusService.ts
├─ eventStreamService.ts
├─ navigatorStreamService.ts
└─ runtimeRegistrySource.ts
```

## 19.1 Observability

The operational console store preserves source-faithful exchanges from CLU-E, AI providers, host, browser, Git, benchmark runners, and external tools. Redaction is explicit and auditable. Observability may diagnose authority or instrument health but may not create a verdict.

## 19.2 Status

`statusContractV5.ts` is the machine schema owner corresponding to `CLUE_Status_Contract_v9.md`. The projector joins compatible source heads only. The seal binds schema, mission, project snapshot, cycle, benchmark, Git, catalogue, and source-event identities. Missing evidence becomes `UNKNOWN`, `OPEN`, `STALE`, or `UNAVAILABLE`, never an invented zero or healthy state.

## 19.3 Backend UI view models

Backend UI modules transform sealed Status and selected durable records into presentation-ready data. They do not independently compute metric meaning, infer Q1 family placement, or maintain a second lifecycle state machine.

Which console surfaces Status carries is decided by the ADR-0004 test (accepted 2026-08-09): a console surface becomes a Status branch when it is a **fact about the mission's work** — attributable, durable, meaningful when read later or elsewhere; it stays local when it is a **fact about this host at this moment** — a running process, an installed tool, a live browser session. Where a surface is both, it stays local and is recorded as contested rather than split speculatively.

Applied to the probed surfaces: readiness, the Chrome injection chain, and the rest of `snapshot.configuration` stay console-local — a status document should not be able to reconstruct whether Chrome was running. The implemented mission facts are carried by typed branches: `cycle` (introduced in 5.2.0), `proofPipeline` (5.3.0), `greatBook` (5.4.0), and `aiOrchestration` (introduced in 5.5.0 and extended by ADR-0017); the target publication decision entered `target` in 5.6.0. The current composed runtime wire is 5.7.0. `versionControl` remains explicitly unsupported because the governed Git lifecycle is deferred. `startStop` remains console-local. ADR-0004's mission-fact/host-fact test still decides future additions; the presence of a dashboard panel never creates a branch by itself.

## 19.4 Daemons and services

Daemons are local transport and single-writer process boundaries. They own:

- loopback/authenticated HTTP and SSE exposure;
- bounded replay and reconnect;
- command request forwarding to typed control services;
- atomic Status publication;
- stream health and source-head reporting.

They do not execute shell or Git commands directly.

`proofBoardProjection.ts` is the backend read-model owner for recorded benchmark runs and proof attempts. `clueDashboardServer.ts` exposes it read-only at `/api/proof-board` and exposes the non-mutating P2 closure decision at `/api/p2-closure`, both with `Cache-Control: no-store`. Neither endpoint executes an instrument or computes a verdict.

---

# 20. Browser interface tree

```text
ui/
├─ clue-dashboard/
│  ├─ index.html
│  ├─ app.js
│  ├─ state/
│  ├─ quadrants/
│  ├─ configuration/
│  ├─ fullscreen/
│  └─ components/
├─ system-navigator/
│  ├─ docs/
│  ├─ src/
│  ├─ test/
│  ├─ tools/
│  └─ demo/
├─ great-book-field/
├─ four-neon-gauges/
└─ operational-console/
```

## 20.1 `ui/clue-dashboard/`

The unified shell owns:

- exactly two top-level tabs: Dashboard and Configuration;
- one sealed Status state store;
- quadrant selection and cross-highlighting bus;
- shared fullscreen behavior for every meaningful window;
- accessibility, focus, density, and error/unknown presentation;
- action requests through typed backend contracts.

It must not recreate Q1, metric, Git, benchmark, or verdict state locally.

The P2 Proof & Benchmark Board is mounted by `ui/clue-dashboard/workspaces/proofBoard.js`. It renders `/api/proof-board`, validates summary/event parity and displays the recorded disposition exactly. It does not call `decide()`, execute a benchmark, read secret values or convert a positive-looking delta into `ACCEPT`.

## 20.2 `ui/system-navigator/` — Q1

Canonical browser modules include:

```text
src/
├─ protocol.js
├─ SystemNavigator.js
├─ SystemNavigatorElement.js
├─ core/
│  ├─ RepositoryModel.js
│  ├─ AllLayoutEngine.js
│  ├─ AllFrameBuilder.js
│  ├─ NavigatorModeState.js
│  ├─ GraphModel.js
│  └─ LayoutEngine.js
├─ render/
├─ input/
├─ ui/
│  ├─ Hud.js
│  ├─ Inspector.js
│  └─ EnvironmentGlyphs.js
└─ adapters/
   ├─ ClueRecognitionAdapter.js
   └─ SseNavigatorAdapter.js
```

Responsibilities are divided as follows:

- `RepositoryModel` and ALL modules render physical `Project → Family → Environment → File` topology;
- `GraphModel` and DIVE layout render semantic `Domain → Subsystem → Module → Class/Type → Function/Method` structure;
- `NavigatorModeState` owns separate cameras, selections, and exact file handoff;
- protocol/adapters consume backend authority and never classify files in the browser;
- render/input/HUD/Inspector present and navigate truth without mutating it.

The detailed contract is solely `CLUE_Q1_System_Navigator_v9.md`.

## 20.3 `ui/great-book-field/` — Q2

Renders the Great Book Improvement Field from canonical measures, applicability, evidence quality, value, and Great Book records. It preserves native units in inspection and uses normalized coordinates only for truthful comparison. It does not sum incompatible measures.

## 20.4 `ui/four-neon-gauges/` — Q3

Renders the four stable measure families:

- Target Quality Measures;
- Evidence & Assurance Measures;
- Mandatory Acceptance Gates;
- CLU-E Self-Measures.

It consumes catalogue and Status projections. It does not define thresholds or applicability.

## 20.5 `ui/operational-console/` — Q4

Renders source-faithful operational traffic, instrument health, correlation, redaction, and evidence references. It preserves the difference between absence, filtered data, redaction, failure, and unsupported source.

---

# 21. Dependency direction

The canonical dependency direction is:

```text
shared primitives
    ↓
configuration + memory
    ↓
control authority
    ↓
analysis / intent / adapters
    ↓
AI + metrics + improvement planning
    ↓
testing / benchmark / experiment / Git integration
    ↓
evaluation + equilibrium + cycle orchestration
    ↓
Status projections
    ↓
daemons and browser UI
```

Additional rules:

1. `src/shared/` depends on no domain service.
2. `src/memory/` does not depend on UI, AI providers, Git providers, or target adapters.
3. native adapters may depend on shared evidence interfaces but not on browser UI.
4. AI services consume typed context and registries; they do not import mutable host or Git implementations.
5. experiment and Git modules require authority tokens and return typed evidence receipts.
6. evaluation consumes evidence; execution instruments never import verdict registries to accept themselves.
7. Status is a projection over durable records, not a source used to reconstruct those records.
8. browser UI imports only browser-safe contracts and receives records through adapters or services.
9. no module may read `workspace/` ad hoc when a registry or store owns that data.

Circular domain authority is prohibited. Shared interface extraction is preferred to mutual imports.

---

# 22. Runtime workspace tree

```text
workspace/
├─ events/
├─ artifacts/
├─ projections/
├─ streams/
├─ audit/
├─ status/
├─ cycles/
├─ experiments/
├─ benchmarks/
├─ git/
│  ├─ worktrees/
│  ├─ quarantine/
│  └─ receipts/
├─ browser-profiles/
├─ temporary/
└─ exports/
```

| Area | Contract |
|---|---|
| `events/` | append-only hash-chained event segments and chain metadata |
| `artifacts/` | immutable content-addressed blobs |
| `projections/` | disposable databases and indexes |
| `streams/` | sealed and live NDJSON/SSE source files with bounded retention |
| `audit/` | durable action/execution receipts when not fully represented in the primary event log |
| `status/` | sealed Status snapshots and history indexes |
| `cycles/` | cycle locks, checkpoint pointers, and resumable state references |
| `experiments/` | isolated run directories and raw instrument outputs |
| `benchmarks/` | normalized specifications, raw results, digests, versions, bridge runs, and coverage artifacts |
| `git/` | leased worktrees, quarantine, and lifecycle receipts |
| `browser-profiles/` | dedicated non-source browser state |
| `temporary/` | disposable files with deterministic cleanup policy |
| `exports/` | explicitly created evidence, review, release, or diagnostic packages |

No program logic may depend on a temporary path remaining available after its owning stage closes. Durable records reference artifacts by hash, not by transient location alone.

---

# 23. File identity and rename rules

Source placement and evidence use distinct identities:

```text
fileLocationId  = repository identity + normalized relative path
fileVersionId   = project snapshot + normalized relative path + content hash
```

A rename creates a new location identity. Git may link old and new locations through a separately evidenced rename relation. It must not silently rewrite historical evidence.

Semantic unit identities must include sufficient parent, declaration-kind, signature, and source-anchor information to remain collision-free. An alias/migration record may connect identity scheme versions; direct silent reuse is prohibited.

---

# 24. Ownership and extension rules

A new capability is added by:

1. identifying its constitutional and RPI boundary;
2. choosing one domain owner in this directory;
3. defining durable records and exact identities in Architecture;
4. defining its operational transition in the Execution Model when needed;
5. adding strict schemas and tests;
6. exposing its state through Status rather than a private UI channel;
7. extending the UI only after backend truth exists;
8. recording current implementation work in the external backlog, not this file.

A new environment is normally added through an Environment Adapter and taxonomy entry. A new Git provider is added through a provider adapter. A new AI provider is added through `AiProvider`. A new visualization consumes existing Status/catalogue records unless it introduces a genuinely new governed backend concept.

---

# 25. Directory conformance criteria

A CLU-E implementation conforms to this directory contract when:

- every durable responsibility has one source owner;
- the source tree respects the dependency direction;
- project intent and Master Benchmark inputs have explicit configuration, loading, model, snapshot, and cycle-lock owners;
- repository inventory and semantic recognition are separate;
- AI, experiment, Git, and UI code cannot bypass authority and evidence stores;
- candidate and Master Benchmark responsibilities remain distinct;
- Git local state, provider state, evidence publication, reconciliation, and retention have separate owners;
- Status is the single UI read contract;
- Q1 ALL and DIVE use separate physical and semantic models;
- all four quadrants support the shared shell and fullscreen contract;
- runtime workspace and dependencies are excluded from authored source and release packages;
- current defects, progress, and implementation sequencing remain outside the permanent knowledge base.

---

# 26. Final directory statement

The directory is a map of responsibility, not a claim that every target file already exists. Its purpose is to ensure that CLU-E grows without creating competing authorities, duplicated state machines, browser-local truth, or one monolithic orchestrator.

```text
one responsibility
    → one canonical owner
    → one durable record path
    → one governed Status projection
    → one truthful operator presentation
```

---

# 27. Revision 9.4 — ADR-0017 ownership amendment

The following executable owners are registered for the final P2 activation boundary:

```text
src/ai/gateway/policy.ts
  strict OpenAI provider-authority, exact-model and non-authoritative local-pricing policy

src/ai/gateway/openaiAdapter.ts
  bounded Responses/Batch HTTP, exact-model probe and typed billing-vs-rate-limit classification

src/ai/gateway/modelGateway.ts
  event-first calls, provider-budget pause/resume, exact token accounting and operational Status

src/ai/gateway/gatewayProjection.ts
  replayable gateway calls and provider-resumed event authority

src/integration/git/manualGitSync.ts
  explicit local-first unchanged/fast-forward/push sync; no governed P4 lifecycle authority

src/daemon/clueDashboardServer.ts
  controlled Start refusal during provider-budget pause and the manual `/api/control/git-sync` act

src/control/p2ClosurePolicy.ts
  mission-bound OPERATIONAL D4 decision and P3 phase deferrals

src/closure/p2ClosureAssessment.ts
  read-only corroboration of exact model, provider authority, ceremony and proof-cycle closure
```

Status wire 5.7.0 owns provider budget authority, exact model, durable pause and token usage. Manual
Git Sync does not change the explicit `versionControl: unsupported` P4 boundary.
