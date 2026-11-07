# CLU-E Status Contract v10

**Document status:** v10 release candidate — not active authority until explicit Creator ratification  
**Release:** CLU-E RPI Documentation Pack v10.0-rc1  
**Carried-forward basis:** `CLUE_Status_Contract_v9.md`  
**Primary v10 change:** Status 5.8.0 active-project identity and capability readiness  

This file preserves the complete v9 body below and adds the coordinated Project Profiles amendment at the end. Where the carried-forward single-target wording conflicts with the v10 amendment, the v10 amendment controls only after this pack is promoted, resealed, explicitly ratified, and a successor evidence epoch is opened. Until then, the installed v9 pack remains the P2 authority.

---

# Part I — Carried-forward v9 authority

# CLU-E Status Contract
## Canonical assessment, orchestration, and runtime-diagnostics snapshot

**Document status:** permanent normative canonical operational read contract  
**Revision:** 9.1 (pack release 9.0) — revision 5.0 content preserved at the v9 re-baseline; additive executable amendments ADR-0001/0007 and ADR-0011–0014/0017 advance the current runtime wire through `5.7.0` without rewriting historical snapshots.  
**Language:** English  
**Primary subject:** the one schema family used by the Dashboard, `CLU-E STATUS` button, CLI/API automation, status history, comparison, and future production diagnostics, Git/provider operations, remote review and CI visibility, cloud evidence recovery, and version-control history.  
**Normative companions:** `RPI_Core_Methodology_v9.md`, `CLUE_Constitution_v9.md`, `CLUE_Architecture_v9.md`, `CLUE_Execution_Model_v9.md`, `CLUE_AI_Utilization_v9.md`, `CLUE_Git_Integration_v9.md`, `CLUE_Canonical_Measurement_Catalogue_v9.md`, `CLUE_Interface_Design_v9.md`, and `CLUE_Q1_System_Navigator_v9.md`  
**Intentionally out of scope:** visual styling, benchmark implementation detail, target-specific thresholds, provider-specific styling, raw credentials, SQL implementation, current runtime status, and backlog.

> **The status does not decide what is true. It projects durable truth and proves which records produced the projection.**

> **RPI status is an account of a bounded improvement campaign, not a claim of absolute optimality. It must expose the Target Program, native environments, inferred intent, current method, proof authority, value horizon, residual unknowns, and the exact equilibrium envelope under which a conclusion is valid.**

---

# 1. Core-method declaration

`CLU-E Status` is a core CLU-E method, not a convenience report. It makes the system inspectable by a human, another tool, a future CLU-E instance, and a production diagnostic agent.

The same durable state must produce the same status body. The UI, CLI, HTTP API and exported JSON consume one validated snapshot; none assembles an independent interpretation.


Under RPI, the status also answers six system-level questions:

1. **What project state is being improved?**
2. **What intent and capability are being preserved or advanced?**
3. **Which native environment and cross-environment surface is under examination?**
4. **What evidence authority can prove the improvement claim?**
5. **What value or assurance is expected over the declared horizon, and which equilibrium boundary has been reached?**
6. **Which exact repository, Base Pin, worktree, branch, candidate commit, remote review, and publication state carries the campaign?**

`CLU-E Status` therefore projects both the implementation state of the engine and the epistemic state of the current RPI campaign. It must never present a specified-but-unimplemented RPI capability as operational.

Required surfaces:

```text
Dashboard / Configuration shell
CLU-E STATUS overlay
clue status show
clue status export
clue status validate
clue status diff
GET /api/status/current
GET /api/status/events
GET /api/project-inputs
GET /api/repository-inventory
GET /api/q1
GET /api/master-benchmark
GET /api/improvement-field
GET /api/gauges
GET /api/operational-console
GET /api/rpi/current
GET /api/environments
GET /api/capabilities
GET /api/method-frontier
GET /api/proof-instruments
GET /api/improvement-economics
GET /api/git/repositories
GET /api/git/state
GET /api/git/worktrees
GET /api/git/branches
GET /api/git/change-sets
GET /api/git/commits
GET /api/git/reviews
GET /api/git/remote-checks
GET /api/git/publications
GET /api/git/reconciliation
```

---

# 2. Truth boundaries

The contract preserves these distinctions:

```text
scanned                  ≠ recognized
recognized               ≠ purpose-understood
finding                  ≠ proven defect
patch-ready              ≠ worktree-applied
worktree-applied         ≠ candidate-commit-sealed
candidate-commit-sealed  ≠ proven
proven                   ≠ landing-eligible
landing-eligible         ≠ canonical
commit-created           ≠ proof
push-complete            ≠ accepted
review-open               ≠ approved
review-approved           ≠ RPI verdict
remote-check-green        ≠ RPI verdict
merge-complete            ≠ post-land verified
canonical                ≠ post-land verified
historically assessed    ≠ healthy now
AI model response        ≠ CLU-E terminal result
file discovered           ≠ environment understood
environment understood    ≠ cross-environment flow understood
implementation described  ≠ intent established
intent inferred           ≠ intent confirmed
current method named      ≠ method adequate
industry trend            ≠ applicable solution frontier
benchmark authored        ≠ benchmark valid
measured delta            ≠ causal improvement
local improvement         ≠ capability improvement
human preference          ≠ uncontrolled anecdote
cost forecast             ≠ realized lifetime value
local equilibrium         ≠ absolute optimality
local repository state    ≠ remote repository state
remote object reachable   ≠ evidence retained
Git history               ≠ CLU-E event-log truth
```

Every status field is either backed by durable source identities or explicitly `unknown`, `not_applicable`, `conflicted`, `stale`, or `unavailable`.

---

# 3. Top-level structure

A status snapshot contains:

```json
{
  "schemaVersion": "5.0.0",
  "generatedAt": "...",
  "target": {},
  "projectInputs": {},
  "assessmentEnvelope": {},
  "rpi": {},
  "cycle": {},
  "repositoryInventory": {},
  "recognition": {},
  "q1": {},
  "environments": [],
  "universalProjectRepresentation": {},
  "crossEnvironment": {},
  "purposeAndCapabilities": {},
  "intentAndMethods": {},
  "solutionFrontier": {},
  "currentWork": {},
  "units": [],
  "functionalities": [],
  "measurementCatalogue": {},
  "measureSessions": [],
  "proofInstruments": [],
  "humanEvaluations": [],
  "improvementField": {},
  "gauges": [{}, {}, {}, {}],
  "operationalConsole": {},
  "aiOrchestration": {},
  "findings": {},
  "proofPipeline": {},
  "benchmarks": {},
  "improvementEconomics": {},
  "versionControl": {},
  "integrations": {},
  "assessment": {},
  "runtimeDiagnostics": {},
  "greatBook": {},
  "equilibrium": {},
  "sources": [],
  "seal": {}
}
```

The detailed runtime schema is strict. Unknown additional fields are rejected until a schema revision defines them.

---

# 4. Target and Assessment Envelope

The target section identifies:

- target ID and name;
- Creator/canonical root, registered repository identity, repository-set role, and managed worktree-pool root without leaking secrets;
- source snapshot, Git State Envelope, Git Base Pin, protected-ref expectation, object format, and repository configuration fingerprint;
- mission and policy hashes;
- Purpose Catalogue and Capability Inventory hashes;
- Measurement Catalogue version/hash;
- recognizer and purpose-recognizer versions;
- evaluator/model-routing policy;
- Master Benchmark and scenario catalogue versions;
- environment fingerprint;
- time, token, call and compute budget;
- registered Environment Adapter set and exact adapter versions;
- Universal Project Representation schema/version/hash;
- cross-environment contract catalogue and platform matrix;
- intent-recovery and capability-classification policy;
- method-knowledge snapshot, source policy, freshness limit, and Applicable Solution Frontier policy;
- proof-authority policy, benchmark-synthesis policy, and human-evaluation protocol;
- improvement-value model, value horizon, discount/uncertainty policy, and assurance mandate;
- risk class, autonomy level, Custodian policy, rollback requirements, Git publication profile, approved remotes/providers, branch namespace policy, required remote checks, evidence classification, and retention policy.

Equilibrium and verdict claims are valid only inside this envelope. A change to the adapter set, method-knowledge snapshot, proof policy, value horizon, Git base, candidate tree, protected-ref policy, remote-check policy, evidence publication policy, or materially stronger approved model invalidates only the conclusions whose bounded envelope depends on that change; the invalidation relationship is explicit.

---

## 4.1 Project Inputs and Cycle Lock

The `projectInputs` branch reports the exact cycle-bound versions of:

```text
target description.md
benchmark.txt
```

For each file it exposes:

- configured absolute and repository-relative path;
- existence, readability, encoding, and parser/adapter state;
- content hash and immutable artifact reference;
- last successful load;
- repository and Git identity where applicable;
- current file hash versus active locked hash;
- `insideRepository`;
- `changedAfterCycleLock`;
- blocking errors and non-blocking warnings;
- the explicit transition required when changed: `CONTINUE_LOCKED`, `RESTART_WITH_NEW_INPUTS`, or `FORK_NEW_MISSION`.

The Project Intent part includes:

- `projectIntentModelVersion` and source hash;
- purpose, objective, capability, constraint, priority, environment, non-goal, trade-off, and ambiguity counts;
- critical objectives lacking an evidence path;
- intent conflicts and confirmation state.

The Master Benchmark part includes:

- selected source hash and normalized specification hash;
- benchmark version, parent, compatibility class, and bridge-run requirement;
- runner/adapter readiness;
- scenario, signal, gate, environment, and artifact counts;
- opening and closing run identities and validity;
- coverage and maturity;
- stability, variance, execution cost, and information-gain state;
- pending contributions and enrichment-review outcome;
- next-cycle vital-input identity.

Declared intent is never rendered as observed success. A selected benchmark file is never rendered as executable until normalization and deterministic validation pass.

---

# 5. Recognition status

Recognition reports separate dimensions:

- file scan;
- structural recognition;
- dependency resolution;
- purpose recognition;
- capability binding;
- runtime enrichment;
- test/benchmark coverage;
- unresolved references;
- provisional path-derived architecture;
- unsupported languages;
- stale records;
- environment identification by file and generated artifact;
- adapter support depth: `IDENTIFY_ONLY`, `PARSE`, `SEMANTIC`, `PATCH`, `PROVE`;
- native unit and native dependency extraction per environment;
- Universal Project Representation conversion coverage;
- capability-slice coverage across language and runtime boundaries;
- cross-environment contract and transformation coverage;
- cross-platform scenario coverage;
- unparsed, opaque, generated, binary, vendored, or policy-excluded artifacts.

Recognition is reported as a matrix, not one percentage. A completed file scan may coexist with incomplete recognition. `100% scanned` is never rendered as `100% understood`, and a TypeScript-complete graph is never rendered as project-complete when JavaScript, Python, WGSL, configuration, build, data, or other relevant environments remain unsupported.

---

## 5.1 Repository Inventory and Q1

The `repositoryInventory` branch reports physical truth independently of semantic recognition:

- inventory version/hash and capture/snapshot identity;
- eligible, excluded, generated, tracked, untracked, added, modified, removed, and reclassified counts;
- family and environment taxonomy version/hash;
- one file record per `fileLocationId` with current `fileVersionId`;
- classification source, confidence, reason, and classifier version;
- recognition state: pending, recognized, partial, unsupported, or failed;
- adapter depth and semantic-summary freshness;
- parity errors between inventory and semantic events.

The `q1` branch reports:

```text
mode: ALL | DIVE
ALL hierarchy: Project → Family → Environment → File
DIVE hierarchy: Domain → Subsystem → Module → Class/Type → Function/Method
```

It includes:

- active mode and separate camera/selection state;
- selected physical file and DIVE entry context;
- visible family/environment/file counts;
- filters, search, and relationship lens;
- unknown/unsupported/partial/failed counts;
- semantic memberships and confidence for the selected file;
- protocol version, stream hash, replay state, and projection integrity errors.

Status must reject any projection that duplicates one physical file in ALL, invents a file from a semantic unit, uses File as a visible DIVE hierarchy level, or permits zoom to change ALL into DIVE. The detailed component contract is `CLUE_Q1_System_Navigator_v9.md`.

---

# 6. Current Work Contract

At all times, if work is active, status answers:

## 6.1 WHAT

- target program;
- environment, artifact, native unit, UPR unit, capability slice, or cross-environment boundary;
- unit and granularity;
- source anchor;
- current canonical measure;
- applicability;
- current RPI pass: environment, capability, cross-environment, cross-platform, or whole-program synthesis;
- finding or clean-assessment task;
- lifecycle stage;
- repository ID, Base Pin, experiment worktree lease, CLU-E branch, and candidate commit when source modification is active.

## 6.2 WHY

- observed implementation and its evidence;
- inferred or declared intent, confidence, conflicts, and confirmation state;
- unit purpose and parent purpose;
- required capability and protected outcome;
- problem class and current method family;
- Applicable Solution Frontier candidates and why they are or are not applicable;
- evidence and confidence;
- ranking components, expected value, assurance priority, and value horizon;
- why the work outranks alternatives;
- blast radius and risk.

## 6.3 HOW PROVEN

- improvement claim and proof authority: instrumented, empirical, or both;
- proof contract, proof instrument, and local metric;
- instrument author, validation state, freeze hash, and observer-effect limits;
- baseline/candidate comparison rule and threshold;
- mandatory gates;
- Master Benchmark or capability benchmark guardrail;
- human-evaluation protocol when perception is authoritative;
- purpose, capability, workload, environment-contract, platform, and Git content-identity protections;
- whether remote review/check evidence is required and why it cannot substitute for the verdict.

## 6.4 WHO / MODEL

- logical session ID;
- role;
- model/version;
- route rationale;
- calls, tokens, cache use and context pressure;
- checkpoint, refutation and handoff state.

## 6.5 NEXT

- next tool, turn, checkpoint, benchmark, controlled human comparison, operator gate or terminal condition;
- expected remaining search/validation/publication cost and the stop rule that would establish the relevant equilibrium state;
- next Git transition, remote review/check wait state, reconciliation action, or landing gate when applicable.

---

# 7. Unit and functionality status

## 7.1 Unit records

Every in-scope unit may expose:

- stable and version IDs;
- native environment, adapter identity/support depth, and UPR identity;
- hierarchy and source anchor;
- purpose/intent status, evidence, confidence, conflicts, and confirmation state;
- problem class, current method, and method-adequacy state;
- monofile/polyfile and mono/polydependency classification;
- graph degree, centrality and reverse impact;
- applicable measures and session states;
- findings and terminal dispositions;
- proof/patch/certificate history and exact commit/tree provenance where applicable;
- last assessment and invalidation reasons;
- current runtime observations when available.

## 7.2 Functionality/capability records

A user-visible or system capability may span many units. It records:

- purpose and requirement level;
- implementing native and UPR units across all environments;
- cross-environment flows, contracts, conversions, and responsibility placement;
- current method family, alternatives considered, and frontier-distance vector;
- proving scenarios and benchmark indicators;
- assessment status;
- runtime health;
- last verified snapshot/environment/time;
- degraded, removed, added or unverified state;
- linked Great Book records.

Source-unit status and capability status are related but not interchangeable.

## 7.3 Environment, UPR, and boundary records

Every detected environment reports:

- environment ID, family, runtime/toolchain, and relevant versions;
- matched files and generated artifacts;
- adapter identity, version, support depth, and confidence;
- native parse/semantic/patch/proof coverage;
- unresolved, unsupported, opaque, vendored, and excluded counts;
- native validation tools and benchmark capabilities;
- local equilibrium state and invalidation triggers.

The `universalProjectRepresentation` branch reports:

- UPR schema/version/hash;
- native-to-UPR conversion coverage by environment;
- canonical units, edges, contracts, capabilities, data flows, and provenance completeness;
- information-loss warnings and environment-specific details retained outside the common layer.

Every cross-environment boundary reports producer, consumer, transport, schema/layout/unit/version contract, serialization or transfer cost, ownership, compatibility evidence, and unresolved semantic assumptions. Cross-platform records are separate and identify OS, browser, GPU, device, architecture, deployment, and toolchain scenarios.

---

# 8. Measurement Catalogue and sessions

Status reports:

- active catalogue version/hash;
- normalization-profile set version/hash;
- canonical ID grammar `M<Area><Ordinal>`;
- active 10 × 10 coordinate-map hash;
- four family definitions and colors;
- legacy alias-map hash;
- review freshness;
- active/experimental/deprecated/retired metric counts;
- applicability coverage;
- logical sessions by state and terminal outcome;
- decisive/proven yield per metric;
- false-positive, overlap, escaped-regression, double-counting, and gaming signals;
- cost per decisive verdict;
- pending AI catalogue/normalization-change proposals;
- Creator gates and effective-from-cycle.

Each logical Measure Assessment Session reports one unit, one canonical metric ID, one snapshot, one pass and one terminal outcome. Physical Batch/API calls are subordinate records.

Every metric status record includes:

```json
{
  "metricId": "MC04",
  "legacyIds": ["Q17"],
  "family": "TARGET_QUALITY",
  "area": "C",
  "grid": {"index": 17, "x": 7, "y": 2},
  "familyColor": "#00a3e0",
  "normalizationProfileHash": "sha256:...",
  "projectionType": "signed_score",
  "status": "active",
  "supportedScopes": ["native_unit", "capability", "cross_environment", "whole_program"],
  "admissibleEvidenceAuthorities": ["INSTRUMENTED", "EMPIRICAL"]
}
```

---

## 8.1 Great Book Improvement Field

The `improvementField` branch is the authoritative data projection for the 10 × 10 WebGPU field.

Required structure:

```json
{
  "projectionVersion": "1.0.0",
  "catalogueHash": "sha256:...",
  "normalizationProfilesHash": "sha256:...",
  "coordinateMapHash": "sha256:...",
  "aggregationMode": "CURRENT_CERTIFIED",
  "filters": {
    "targetIds": [],
    "scopeIds": [],
    "cycleIds": []
  },
  "grid": {
    "rows": 10,
    "columns": 10,
    "cells": []
  },
  "reservedCells": []
}
```

Every active cell reports:

- canonical metric ID and legacy aliases;
- X/Y coordinate and grid index;
- family, area, color, and metric label;
- positive and negative bounded heights;
- net normalized value;
- assessment coverage;
- confidence;
- freshness;
- equilibrium state;
- active, invalidated, expired and historical contribution counts;
- ordered segment IDs;
- last Great Book update.

Every segment reports:

- contribution ID;
- Great Book record ID;
- metric ID;
- target/scope/cycle;
- native result reference;
- normalization profile hash;
- native delta summary;
- magnitude score;
- confidence and freshness factors;
- normalized contribution;
- marginal display height;
- verdict and certificate state;
- proof-contract and benchmark references.

The field can aggregate evidence but cannot hide native evidence. A client must be able to resolve each segment to the complete source record.

Supported aggregation modes:

```text
CURRENT_CERTIFIED
SELECTED_CYCLE
HISTORICAL_NET
CONFIDENCE_ADJUSTED
AVERAGE_PER_EXPERIMENT
EXPERIMENT_COUNT
COVERAGE
EQUILIBRIUM
```

The active mode and filters are part of the sealed status.

## 8.2 Four Neon Gauges

The `gauges` branch contains **exactly four** projections.

Each gauge includes:

```json
{
  "slot": 1,
  "definitionId": "GAUGE-1",
  "selection": {"kind": "metric", "id": "MD04"},
  "scope": {"kind": "program", "id": "TGT-CLUE"},
  "aggregationMode": "CURRENT_CERTIFIED",
  "family": "TARGET_QUALITY",
  "familyColor": "#00a3e0",
  "projectionType": "signed_score",
  "nativeValue": {"value": 89.2, "unit": "fps"},
  "normalizedValue": 61.0,
  "gateState": null,
  "delta": 4.6,
  "trend": "improving",
  "confidence": 0.96,
  "coverage": 0.88,
  "freshness": 0.99,
  "warning": null
}
```

A categorical or gate-state metric may set `normalizedValue` to null and use an ordinal/category/gate projection. Missing or stale data is never represented as zero.

## 8.3 Operational Console

The `operationalConsole` branch describes the real ordered I/O and state stream used by the cinematic console.

```json
{
  "schemaVersion": "1.0.0",
  "firstSequence": 1001,
  "lastSequence": 1098,
  "droppedEvents": 0,
  "activeChannels": ["AI_MODEL", "BENCHMARK", "POWERSHELL", "CHROME_CDP", "GIT_CLOUD"],
  "currentWorkContract": {},
  "events": []
}
```

Each event includes:

- event ID and sequence;
- timestamp;
- channel;
- direction: inbound, outbound, or internal;
- kind: command, request, response, code, result, state, warning, error, checkpoint, artifact, or summary;
- title;
- `what`, `why`, current status, and next action when applicable;
- redacted payload/code/command preview;
- raw artifact reference;
- source IDs;
- task, logical session, run, benchmark, proof, patch, Git repository/worktree/branch/commit/review/check/publication, or landing IDs;
- duration;
- redaction state;
- optional cinematic cue.

Canonical channels:

```text
CLUE_CORE
RECOGNITION
AI_MODEL
BENCHMARK
POWERSHELL
CHROME_CDP
PROOF
CUSTODIAN
GIT_CLOUD
GREAT_BOOK
STATUS
```

The console may collapse repeated events, but the status must disclose the collapse count and preserve access to raw artifacts. Cinematic narrative must never introduce operations that do not exist in the event stream.

## 8.4 RPI Intent, Method, and Applicable Frontier

The `intentAndMethods` and `solutionFrontier` branches expose, for every assessed unit or capability:

```json
{
  "scopeId": "CAP-...",
  "observedImplementation": {},
  "intent": {
    "statement": "...",
    "status": "INFERRED | DECLARED | CONFIRMED | CONFLICTED | UNKNOWN",
    "confidence": 0.0,
    "evidence": [],
    "protectedOutcomes": []
  },
  "problemClass": {},
  "currentMethod": {},
  "applicableFrontier": {
    "knowledgeSnapshotHash": "sha256:...",
    "freshness": {},
    "candidateMethods": [],
    "excludedMethods": [],
    "frontierDistance": {}
  },
  "methodologicalOpportunities": []
}
```

A candidate method is not displayed as superior merely because it is newer or popular. The status exposes provenance, evidence maturity, constraints, expected advantages, expected costs, incompatibilities, uncertainty, and the experiment needed to decide applicability in the Target Program.

## 8.5 Proof Instruments and Improvement Economics

Every proposed or executed proof instrument reports:

- the exact improvement claim it is intended to test;
- evidence authority: `INSTRUMENTED`, `EMPIRICAL`, or `COMPOSITE`;
- subtype: analytic/exact, quantitative benchmark, constraint/conformance, central/capability outcome, or controlled human-perceptual evaluation;
- whether AI, a deterministic generator, a human, or an existing target fixture authored it;
- calibration, self-test, representativeness, sensitivity, repeatability, and observer-effect results;
- pre-result freeze timestamp and hash;
- baseline and candidate source/environment identities;
- decision rule, uncertainty, and invalidation conditions.

The `improvementEconomics` branch reports forecast and realized values separately:

```json
{
  "currency": "USD",
  "valueHorizon": {},
  "searchCost": {},
  "implementationCost": {},
  "validationCost": {},
  "expectedRiskCost": {},
  "forecastValue": {},
  "realizedValue": {},
  "assuranceValue": {},
  "improvementYield": null,
  "tokenEfficiency": null,
  "realizationConfidence": 0.0
}
```

Unknown or non-monetizable assurance value remains explicit; it is never coerced to zero.

## 8.6 Version Control and Cloud Publication

The `versionControl` branch is the authoritative **status projection** of the Git lifecycle. It is not the Git repository itself, the event log, or a verdict source.

Required shape:

```json
{
  "profileVersion": "1.0.0",
  "repositories": [],
  "repositorySets": [],
  "stateEnvelopes": [],
  "basePins": [],
  "worktreePool": {},
  "branches": [],
  "changeSets": [],
  "commits": [],
  "publications": [],
  "reviews": [],
  "remoteChecks": [],
  "reconciliation": [],
  "evidencePublications": [],
  "landingTransports": [],
  "warnings": []
}
```

### 8.6.1 Repository and Base Pin status

Every registered repository reports:

- repository ID, target/evidence/program role, local root identity, object format, default/protected refs;
- approved remotes and provider adapters, with purpose and allowed read/write namespaces;
- local HEAD, index/worktree cleanliness, submodule/LFS/sparse/partial-clone state;
- hooks, filters, signing and generated-content policy state;
- last fetch, remote reachability, ahead/behind/diverged state, and stale age;
- current `GitStateEnvelope` and `GitBasePin` IDs/hashes;
- whether the Creator working tree seal is valid.

The status never exposes credentials, raw remote tokens, or sensitive URLs beyond the approved redacted representation.

### 8.6.2 Worktree and branch status

Each CLU-E worktree/branch reports:

- repository, lease, task/cycle/patch owner, path identity, branch/ref, Base Pin and HEAD;
- lease state: `AVAILABLE`, `LEASED`, `EXPIRING`, `QUARANTINED`, `ARCHIVING`, `RELEASED`;
- clean/dirty/untracked counts and expected versus unexpected change state;
- build/server/process bindings;
- publication and retention policy;
- Creator-tree before/after seal result.

Branch lifecycle is separate from proof lifecycle:

```text
LOCAL_EXPERIMENT
PROVISIONAL_COMMIT
SEALED_CANDIDATE
PUBLISHED_REVIEW
REMOTE_CHECKS_PENDING
PROVEN_ACCEPTED
LANDING_ELIGIBLE
LANDED
REVERTED
REJECTED
ARCHIVED
DIVERGED
```

No branch state implies a verdict unless it resolves to a durable VerdictRecord.

### 8.6.3 Change-Set Partition and commit status

Every candidate reports:

- full changed-path inventory including added/deleted/renamed/untracked/ignored/generated/submodule/LFS surfaces;
- counts and identities by `CANDIDATE_IMPLEMENTATION`, `PROOF_INSTRUMENT_EPHEMERAL`, `PROOF_INSTRUMENT_DURABLE`, `REGRESSION_PROTECTION`, `GENERATED_ARTIFACT`, `DEPENDENCY_LOCK_UPDATE`, `DOCUMENTATION`, `EVIDENCE_POINTER`, `UNRELATED_CREATOR_CHANGE`, `INCIDENTAL_TOOL_MUTATION`, `FORBIDDEN_SURFACE`, and `UNKNOWN`;
- expected versus actual diff/tree/commit identities;
- provisional, sealed-candidate, accepted, landing, and revert commit receipts;
- structured trailer completeness and signing/verification state;
- verdict compatibility or invalidation reason.

`UNKNOWN`, `UNRELATED_CREATOR_CHANGE`, `INCIDENTAL_TOOL_MUTATION`, or `FORBIDDEN_SURFACE` produces a blocking state, never a hidden omission.

### 8.6.4 Remote review and checks

Each publication/review reports:

- remote/provider/repository identity;
- source and target refs, exact head/base commits, review object ID and redacted URL;
- review state, approvals, requested changes, comments, policy result, and last synchronized time;
- required and observed remote checks, each bound to exact commit/workflow/run/environment/artifacts;
- check conclusion and whether it is `INFORMATIONAL`, `PROTECTIVE_GATE`, or `REQUIRED_FOR_TRANSPORT`;
- stale-head, changed-base, provider-content-mutation, or webhook-replay warnings.

The status must visibly state:

```text
remote check green ≠ RPI proof
review approved ≠ RPI verdict
merge complete ≠ post-land verification
```

### 8.6.5 Evidence publication and cloud recovery

The projection reports:

- evidence manifest hash and classification;
- artifact-store/remote destination by registered identity;
- hashes, sizes, retention, encryption/access policy, upload/verification state;
- source commit, proof contract, run, verdict, Great Book, and certificate links;
- restore test state and last successful recovery time;
- local-only, deferred, failed, partial, expired, or complete publication state.

A PR or CI link without durable evidence-manifest reachability is visible as incomplete cloud durability.

### 8.6.6 Reconciliation and landing transport

Reconciliation records local/remote/protected-ref divergence without guessing:

- expected and observed refs/objects;
- classification: `IN_SYNC`, `AHEAD`, `BEHIND`, `DIVERGED`, `REWRITTEN`, `MISSING`, `UNAVAILABLE`;
- allowed action: fetch, publish, defer, new Base Pin/re-proof, archive, Creator decision;
- forbidden action: blind rebase, force push, semantic conflict auto-resolution, inherited stale verdict;
- landing transport and current G1–G12 gate state;
- post-land/ref verification and revert readiness.

---

# 9. AI orchestration status

The status must expose enough information to audit CLU-E-to-model operation without leaking secrets or full private prompts:

- active and queued logical sessions;
- physical calls/Batches in flight;
- model provider, model ID and role;
- selection rationale and escalation policy;
- input/output/cached tokens;
- call and monetary budget;
- context utilization;
- turn/checkpoint/handoff;
- refutation relationship;
- invalid/discarded responses;
- model performance by terminal outcome;
- calls avoided through deterministic tools/cache;
- benchmark/instrument synthesis calls, independent instrument-review calls, and freeze state;
- intent-recovery, problem-classification, method-landscape, applicability, and frontier-refutation roles;
- knowledge-source snapshot and freshness used by method intelligence;
- forecast value generated per call and later realized-value attribution.

A session is not `complete` because a model stopped generating. It is complete only after validated integration into a terminal CLU-E state.

The status must make the orchestration owner explicit: normal work is `CLU-E scheduler → logical session → approved AI role/call → validated artifact`, never a hidden chain of unrelated user-driven chats. It must also expose whether the strongest policy-required model was used, whether any downgrade or Batch route occurred, why it was allowed, and whether token savings preserved the required evidence and independent review.

---

# 10. Findings and proof pipeline

Every finding receives a terminal disposition. Status distinguishes:

```text
OBSERVATION_RECORDED
INTENT_INFERRED | INTENT_CONFIRMED | INTENT_CONFLICTED
PROBLEM_CLASSIFIED
CURRENT_METHOD_IDENTIFIED
FRONTIER_CANDIDATES_FILTERED
PROVISIONAL_FINDING | METHODOLOGICAL_OPPORTUNITY
CONFIRMED_FINDING
PROOF_INSTRUMENT_AUTHORED
PROOF_INSTRUMENT_VALIDATED
PROOF_CONTRACT_FROZEN
BASELINE_CAPTURED
PATCH_SEALED
CANDIDATE_APPLIED
PATCHED_EXPERIMENT
VERDICT
LANDING_ELIGIBILITY
AUTO | NOTIFY | OUTBOX
CANONICAL_LANDED
POST_LAND_VERIFIED | AUTO_REVERTED
GREAT_BOOK_RECORDED
```

It also records purpose/capability/workload gate outcomes and experiment admissibility.

---

# 11. Benchmarks

Status includes:

- initial cycle benchmark;
- latest fast guardrail;
- final full benchmark;
- post-land benchmark;
- benchmark and scenario hashes;
- validity and environment;
- FPS and overall rating where applicable;
- p50/p95/p99, stutter, RAM/GPU memory;
- console-signature delta;
- workload counters;
- purpose and capability result;
- net cycle classification and gray-area warning;
- improvement claim, proof authority, instrument ID/version/hash, and instrument author;
- instrument validation, calibration, sensitivity, observer-effect, and freeze state;
- local, capability, Master Benchmark, cross-environment, and cross-platform result levels;
- controlled human-evaluation protocol and preference/quality result when applicable;
- causal attribution, statistical/logical decisiveness, residual uncertainty, and validity verdict.

A target without FPS uses its target-specific profile; the schema marks non-applicable fields rather than fabricating zero. A result described as visible "to the naked eye" is admissible only as a declared human-perceptual authority under a controlled comparison record; it is never silently relabeled as an objective numeric proof.

---

# 12. Integrations and readiness

Each link is reported separately:

- database;
- event log;
- artifact store;
- canonical target;
- leased experiment worktree;
- file watcher;
- PowerShell host lifecycle;
- Chrome process;
- CDP endpoint;
- target tab/frame/execution context;
- runtime bridge;
- console collector;
- scenario engine;
- Model Gateway and OpenAI credentials/readiness;
- Proof Engine;
- Great Book hash chain;
- Landing Authority and Custodian;
- Environment Adapter registry and native toolchains;
- UPR builder and capability-slice projector;
- cross-environment contract analyser and cross-platform scenario matrix;
- intent and method intelligence services;
- method-knowledge/source registry and freshness monitor;
- benchmark-synthesis and proof-instrument validator;
- controlled human-evaluation recorder;
- improvement-value and horizon-realization engine.

`connected`, `ready`, `succeeded`, and `behavior proven` are distinct states.

---

# 13. Assessment versus runtime diagnostics

The snapshot contains two separate branches.

## 13.1 Assessment

What CLU-E has concluded under a frozen envelope, including measures, findings, evidence, proof and certificates.

## 13.2 Runtime diagnostics

What a running instance currently reports, including capability health, errors, resource state, version and freshness.

Production diagnostics may be `healthy`, `degraded`, `fault`, `unknown`, or `stale`. A valid historical certificate cannot override a fresh runtime fault.

---

# 14. Great Book and equilibrium

Status reports:

- latest accepted/rejected/inconclusive/invalid records;
- measurement-catalogue and normalization-profile review records;
- per-record metric contributions;
- contribution overlap and double-count checks;
- active/invalidated/expired contribution counts;
- negative-knowledge hits;
- certificates and invalidations;
- clean-pass progress;
- finding/test novelty;
- regression escapes;
- residual unknowns;
- equilibrium envelope and state by environment, capability, cross-environment surface, cross-platform surface, evidence sufficiency, current method frontier, AI capability, economic stop rule, and assurance mandate;
- search saturation and marginal expected value of the next admissible experiment;
- forecast and realized lifetime value, assurance gain, token efficiency, and attribution uncertainty;
- materially stronger AI, adapter, proof instrument, benchmark, method-knowledge snapshot, or framework triggers requiring recertification.

The Great Book section and Improvement Field must agree on contribution IDs, certificate state, catalogue hash, normalization profile, and current validity.


No single `equilibrium: true` field is sufficient. The status must identify the equilibrium dimension and bounded envelope. At minimum:

```text
EVIDENCE_EQUILIBRIUM
CAPABILITY_EQUILIBRIUM
ECONOMIC_EQUILIBRIUM
ASSURANCE_EQUILIBRIUM
ENVIRONMENT_EQUILIBRIUM
METHOD_FRONTIER_EQUILIBRIUM
PROJECT_RPI_EQUILIBRIUM
```

`PROJECT_RPI_EQUILIBRIUM` may be issued only when every required lower-level surface is either at equilibrium, explicitly not applicable, or explicitly excluded by approved policy, and all residual unknowns are visible.

---

# 15. State Seal and provenance

The seal binds the canonicalized snapshot body and records:

- status hash;
- generated timestamp;
- source event-log range;
- projection/database versions;
- target snapshot;
- catalogue and mission hashes;
- Environment Adapter set and UPR hashes;
- intent/method records and method-knowledge snapshot hashes;
- proof policy, instrument, benchmark, human-evaluation, and value-model hashes;
- consistency result.

The same durable inputs and declared timestamp must reproduce the same body and seal. A mismatch is a projector defect.

---

# 16. Button and interface behavior

The two-tab interface contains one persistent control in the top mission rail and inside the Operational Console quadrant:

```text
CLU-E STATUS
```

It opens an in-place overlay with:

- `VIEW STATUS`;
- `EXPORT JSON`;
- `VALIDATE SEAL`;
- `COMPARE PREVIOUS`.

It does not add a third tab. It may focus a unit in the Navigator or a configuration defect, but it never mutates analytical truth.

---

# 17. CLI and API

```text
clue status show
clue status export --output clue-status.json
clue status validate clue-status.json
clue status diff old.json new.json
clue status schema
clue improvement-field show
clue improvement-field export
clue gauges show
clue console tail

GET /api/status/current
GET /api/status/schema
GET /api/status/events
GET /api/project-inputs
GET /api/repository-inventory
GET /api/q1
GET /api/master-benchmark
GET /api/improvement-field
GET /api/gauges
GET /api/operational-console
GET /api/rpi/current
GET /api/environments
GET /api/upr/current
GET /api/capabilities
GET /api/cross-environment
GET /api/method-frontier
GET /api/proof-instruments
GET /api/human-evaluations
GET /api/improvement-economics
GET /api/git/repositories
GET /api/git/state
GET /api/git/worktrees
GET /api/git/branches
GET /api/git/change-sets
GET /api/git/commits
GET /api/git/reviews
GET /api/git/remote-checks
GET /api/git/publications
GET /api/git/reconciliation
```

Exports use atomic writes and content hashes. Status history is retained according to policy.

---

# 18. Failure and freshness rules

- failed projection leaves the last valid status visible and records a fault;
- unavailable data becomes unknown, not zero;
- stale data carries age, last source event and refresh requirement;
- partial target scans cannot emit committed-complete status;
- runtime health expires according to target profile;
- an invalid seal blocks automation and production-health claims;
- secrets and sensitive runtime values are redacted before export.
- unknown native values never become normalized zero;
- a missing normalization profile invalidates only the affected metric projection and is visible;
- a metric coordinate collision invalidates the entire field projection;
- a console sequence gap or dropped event count remains visible;
- a gauge whose selected metric is retired, stale, or not applicable reports that state rather than silently selecting another metric;
- an unsupported environment remains unsupported and blocks project-complete recognition claims;
- information loss during native-to-UPR projection is visible and blocks claims that require the lost semantics;
- inferred intent cannot be promoted to confirmed without the required evidence or Creator/operator authority;
- stale or weak method knowledge cannot support a state-of-the-art or frontier claim;
- an AI-authored benchmark that was not validated and frozen before candidate results is `INVALID_INSTRUMENT`;
- an uncontrolled visual preference cannot be reported as controlled empirical proof;
- forecast financial value is never reported as realized value;
- a local equilibrium cannot be promoted to project equilibrium while required environments, capabilities, boundaries, platforms, or proof authorities remain unknown;
- stale or changed Base Pins, candidate trees, review heads, protected refs, remote checks, or publication manifests invalidate only the claims that depend on them and remain visible;
- provider outage becomes `UNAVAILABLE` or `DEFERRED`, not a false failure or false success;
- remote divergence never triggers an implicit rebase/merge;
- deleted worktrees or branches cannot erase durable commits/evidence without a verified retention receipt;
- unclassified evidence, credential leakage risk, hook/filter ambiguity, unresolved submodule/LFS state, or unknown changed files blocks sealing/publication.


---

# 19. Maintenance and compatibility

The status schema is versioned independently. Additive optional fields require a minor version; changed meaning or removed fields require a major version. Migrations are deterministic and retain the original artifact.

The schema is derived from the same durable model used by the interface and future production diagnostics, Git/provider operations, remote review and CI visibility, cloud evidence recovery, and version-control history. No separate manual status format is allowed to drift.

---

# 20. Acceptance gates

The Status method is operational when:

1. one pure projector produces the same snapshot from the same durable inputs;
2. runtime schema validation rejects contradictory or unknown structures;
3. one and only one State Seal exists;
4. UI, CLI and API return the same body/hash;
5. assessment and runtime health cannot be conflated;
6. every active task exposes WHAT, WHY, HOW PROVEN, model and NEXT;
7. unit and functionality status both resolve to evidence;
8. measure sessions and physical calls reconcile exactly;
9. exports survive restart and validate independently;
10. a production diagnostic projection can be generated without granting assessment or write authority;
11. all 100 active v6 metrics resolve to unique canonical IDs and grid cells;
12. every field segment resolves to native evidence and one Great Book contribution;
13. no heterogeneous native values are directly summed;
14. exactly four gauge projections exist and respect their registered projection types;
15. operational-console events reconcile with source subsystem sequences and artifacts;
16. the Dashboard, CLI, exported JSON, Great Book, and field projection agree on family colors, modes, filters, values, and seal;
17. every in-scope artifact reports its environment and adapter support depth, including honest unsupported states;
18. native recognition and UPR projection are separately measurable and information-loss warnings are preserved;
19. capability and cross-environment records resolve to their implementing units, contracts, and proof scenarios;
20. intent status, problem class, current method, Applicable Solution Frontier, and confidence/provenance are exposed without converting inference into fact;
21. every accepted improvement names an admissible proof authority and a validated, pre-result-frozen proof instrument;
22. instrumented candidate proof and Master Benchmark/capability guardrails reconcile without hidden work reduction or metric substitution;
23. human-perceptual evidence, when used, follows a registered controlled comparison and remains distinguishable from objective numeric evidence;
24. forecast cost/value, realized value, assurance value, token efficiency, and value horizon are distinct fields with uncertainty;
25. equilibrium is reported by dimension and envelope; project RPI equilibrium cannot conceal unsupported or unresolved required surfaces;
26. the snapshot clearly distinguishes normative RPI capabilities from capabilities evidenced as implemented by the observed CLU-E runtime;
27. every active Git-backed campaign resolves to a repository registration, Git State Envelope, Base Pin, worktree lease, branch, Change-Set Partition, and exact candidate tree/commit;
28. Creator working-tree and protected-ref integrity are explicit and any unexpected mutation blocks progression;
29. commit, push, review, approval, remote-check, and merge states cannot be confused with proof/verdict/landing verification;
30. remote review/check records bind to exact commits and stale-head changes are visible;
31. cloud evidence manifests are hash-verifiable and their restore status is exposed;
32. divergence, provider outage, branch deletion, retention, and reconciliation have explicit non-destructive states;
33. Git/cloud projections reconcile across Status, Dashboard, CLI, API, Operational Console, Great Book, and landing receipts;
34. the version-control branch can represent honest empty, local-only, unsupported-provider, blocked, stale, partial, diverged, reverted, and recovered states;
35. both configured project-input files expose selected, validated, locked, current, and changed-after-lock identities;
36. declared Project Intent is never presented as observed implementation success;
37. Master Benchmark source, normalized specification, opening run, enrichment review, accepted version, closing run, and next-cycle input remain distinct;
38. Repository Inventory file count reconciles with Q1 ALL exactly once per physical file;
39. Q1 ALL and DIVE state conforms to the physical/semantic separation and preserves independent cameras;
40. benchmark maturity, critical objective coverage, stability, information gain, and unresolved closing anomalies are visible to the equilibrium gate.


> **CLU-E Status is the observable contract of the RPI engine: one sealed account of what it knows, what remains unknown, what it is improving, why the work is justified, how the claim will be proved, what value or assurance is expected, which equilibrium boundary applies, which exact Git/cloud state carries the evidence, and whether the running target is healthy now.**


---


---

# 21. Runtime wire 5.7.0 — provider authority and controlled pause

ADR-0017 advances the additive runtime wire from 5.6.0 to 5.7.0. The normative v9 branch ownership
remains unchanged; historical snapshots retain their original schema identities.

The backed `aiOrchestration` branch now exposes, without secrets:

- exact model identity and OpenAI provider;
- whether OpenAI Platform or CLU-E owns spending authority;
- whether local budget and local pricing are authoritative;
- enabled-route count and policy content hashes;
- submitted, completed, failed, refused and pending call counts;
- exact input, cached-input, output and total token usage;
- provider remaining tokens plus an explicit authority boolean (normally unknown/false);
- provider state, explicit budget-exhaustion pause, reason and operational readiness;
- latest durable gateway event identity.

Seal cross-checks require token arithmetic, call accounting, provider-pause consistency, and
provider-authority/local-authority exclusivity. A provider-budget pause is not inferred from local
zero caps or a generic rate limit. `versionControl` remains unsupported: the P2 manual Git sync
control is not the governed Git lifecycle and cannot populate that branch.

---

# Part II — v10 Project Profiles amendment

## A. Status wire 5.8.0

The v10 Project Profiles branch uses sealed Status schema `5.8.0`. Historical 5.7.0 snapshots remain historical and are never relabelled.

Status exposes:

```text
activeProject.projectId
activeProject.targetRootIdentity
activeProject.projectProfileHash
activeProject.profileGeneration
projectReadiness.level
projectReadiness.capabilities.*
authority.state / drift / conflicts
gateway.requestedModel
gateway.effectiveModel
gateway.credentialReference
gateway.credentialPresent
gateway.fallbackUsed
gateway.providerState
```

No secret bytes are present.

## B. Coherence rule

One Status frame must describe one runtime generation. A successor project identity cannot be paired with predecessor database, Great Book, graph, browser, gateway or authority state. Project switching clears/parks stale revision and seal state until a complete successor frame is available.

## C. Readiness semantics

Overall readiness is not a replacement for capability readiness. `READY_LOCAL_ONLY` is truthful when local proof is available and publication is not. A browser benchmark may be `NOT_REQUIRED` while proof is ready. Controlled provider pause blocks AI candidate generation without rewriting successful local proof evidence.

## D. Closure truth

Status may report P2 closed only after the formal assessment verifies the entire authoritative chain. A passing Project Profiles acceptance report or healthy Configuration UI does not count as P2 closure.
