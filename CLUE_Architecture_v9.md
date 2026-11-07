# CLU-E Architecture v9
## Permanent Technical Architecture, Data Model, State Boundaries, and Service Responsibilities

**Document status:** normative system architecture  
**Revision:** 9.0 (pack-coordinated) — content of revision 8.0 preserved verbatim. Re-baselined into the coordinated v9 documentation pack; see `DOCUMENTATION_GOVERNANCE_v9.md` §14.  
**Language:** English  
**Methodology:** `RPI_Core_Methodology_v9.md`  
**Constitution:** `CLUE_Constitution_v9.md`  
**Domain owners:** `CLUE_AI_Utilization_v9.md`, `CLUE_Git_Integration_v9.md`, `CLUE_Canonical_Measurement_Catalogue_v9.md`, `CLUE_Status_Contract_v9.md`, and `CLUE_Q1_System_Navigator_v9.md`  
**Scope:** component topology, identities, durable records, projections, state machines, service boundaries, deployment, security, and integration contracts  
**Intentionally out of scope:** current implementation status, file-by-file backlog, target-specific benchmark content, detailed metric definitions, detailed Git provider semantics, and visual styling

> **CLU-E is a deterministic evidence system with an AI reasoning layer—not an AI process surrounded by incidental tools.**

---

# 1. Architectural objective

CLU-E must support repeated, resumable, proof-authoritative project-improvement cycles across large polyglot repositories while preserving exact identity, explicit uncertainty, bounded authority, and reconstructible decisions.

The architecture must make these properties true by construction:

- no session owns mission continuity;
- no AI output becomes fact merely because it is fluent;
- no candidate modifies the protected Creator tree during ordinary experimentation;
- no verdict depends on an unversioned input;
- no visual projection becomes a source of truth;
- no projection database is required to recover durable state;
- no accepted change can be confused with a different commit, tree, benchmark, environment, or proof contract;
- no complete cycle ends without whole-project observation;
- no equilibrium claim hides unsupported scope or immature benchmark coverage.

---

# 2. System topology

```text
                         CREATOR / OPERATOR
                                │
                    Dashboard + Configuration
                                │
                    Canonical Status v5 snapshot
                                │
      ┌─────────────────────────┼─────────────────────────┐
      │                         │                         │
  Control Plane            Analysis Plane          Experiment Plane
      │                         │                         │
      │                  AI Reasoning Plane               │
      │                         │                         │
      └────────────── Evaluation / Equilibrium ───────────┘
                                │
                 Git Integration + Custodian Plane
                                │
             Event Log + Artifact Store + Projections
                                │
                  Target repositories and tools
```

CLU-E is logically divided into planes. A plane is a responsibility boundary, not necessarily a separate process.

## 2.1 Control Plane

Owns:

- configuration validation;
- mission registration and versioning;
- cycle locks;
- policy and capability tokens;
- durable task queue and dependencies;
- leases, attempts, retries, checkpoints, and terminal closure;
- context-packet construction;
- stop, resume, fork, and invalidation;
- orchestration across deterministic tools, AI, proof, Git, and status.

The Control Plane decides **what work is authorized and in which state**. It does not decide whether a candidate is empirically better.

## 2.2 Analysis Plane

Owns:

- repository inventory;
- physical artifact identity and classification;
- native environment adapters;
- source, document, schema, data, build, asset, and runtime recognition;
- native unit and dependency extraction;
- Universal Project Representation;
- purpose, capability, intent, problem-class, and method records;
- cross-environment contracts and impedance;
- metric applicability and deterministic measurements;
- finding and candidate seed generation;
- Q1 durable projection inputs.

The Analysis Plane establishes deterministic facts and stores AI semantic claims separately with provenance.

## 2.3 AI Reasoning Plane

Owns:

- typed AI task contracts;
- provider abstraction and approved-provider policy;
- model-tier routing;
- context minimization and retrieval;
- semantic enrichment;
- ambiguity resolution;
- documentation alignment;
- applicability reasoning for ambiguous cases;
- hypothesis formation and prioritization;
- proof-instrument and test design;
- patch planning and generation;
- result interpretation and cross-metric adjudication;
- benchmark enrichment proposals;
- equilibrium challenge;
- AI invocation ledger, token budgets, and content-addressed cache.

AI outputs are claims, classifications, plans, diffs, or recommendations. They never overwrite deterministic facts or mandatory gates.

## 2.4 Experiment and Proof Plane

Owns:

- isolated candidate execution;
- approved host commands;
- build, compiler, test, browser, profiler, database, and scenario controllers;
- Candidate Benchmark baseline and candidate runs;
- Master Benchmark runs;
- raw evidence capture;
- deterministic evidence digestion and statistics;
- console and instrument-health ledger;
- invalid-run detection;
- proof contract execution;
- post-land verification.

The Experiment Plane executes; it does not grant itself write authority or verdict authority.

## 2.5 Evaluation and Equilibrium Plane

Owns:

- candidate evidence packages;
- deterministic gate results;
- AI evidence interpretation;
- verdict recommendations;
- final policy decision assembly;
- Great Book contribution records;
- value and assurance accounting;
- challenge-pass planning;
- benchmark maturity assessment;
- bounded-equilibrium evidence package.

## 2.6 Git Integration and Custodian Plane

Owns:

- repository registration and exact Git state capture;
- Base Pins;
- leased worktrees and branch namespaces;
- complete change-set classification;
- provisional, review, accepted, landing, and recovery commits;
- remote fetch/push and expected-old-object protection;
- provider review and remote-check ingestion;
- evidence publication;
- reconciliation, retention, restoration, and revert;
- Custodian landing gates.

The detailed contract belongs to `CLUE_Git_Integration_v9.md`.

## 2.7 Memory Plane

Owns:

- append-only hash-chained events;
- immutable content-addressed artifacts;
- projection registration and deterministic rebuild;
- snapshot, mission, task, AI, benchmark, proof, Git, Great Book, and status history;
- retention policy and archive manifests.

Primary durable truth is the event/artifact system. Query databases and UI models are disposable projections.

## 2.8 Observability and Status Plane

Owns:

- source-faithful operational traffic;
- instrument and integration health;
- canonical Status v5 projection;
- state seals and source-head parity;
- CLI/API/SSE exposure;
- stale/unknown/unavailable diagnostics.

## 2.9 Interface Plane

Owns:

- exactly two top-level tabs: Dashboard and Configuration;
- four Dashboard quadrants;
- fullscreen behavior for each quadrant;
- one Start/Stop authority surface;
- operator inspection and configuration without independent truth assembly.

The Interface consumes Status and live projection streams. It never scans, classifies, measures, or decides independently.

---

# 3. Durable truth and storage model

## 3.1 Event log

The event log records ordered state transitions. Each record includes at minimum:

```text
event ID
sequence
previous event hash
event type and schema version
mission ID
cycle ID where applicable
target snapshot / capture / run identities
actor and authority receipt
timestamp
payload artifact references
record hash
```

The writer is single-authority. Lock ownership, short writes, torn tails, repair, rotation, and recovery are explicitly handled and receipted.

## 3.2 Artifact store

The artifact store contains immutable blobs addressed by cryptographic content hash. Typical artifacts include:

- source and configuration snapshots;
- target-input snapshots;
- recognition results;
- semantic summaries;
- AI context packets and outputs;
- benchmark specifications and results;
- logs, traces, profiles, screenshots, and recordings;
- candidate diffs and change-set manifests;
- proof contracts and verdict packages;
- status snapshots;
- Great Book records;
- Git/provider/cloud receipts.

Artifact storage must verify content on write and read. Export or cloud publication does not replace the local artifact identity.

## 3.3 Projections

SQLite or another query store may index durable state. Every projection declares:

- owned tables;
- schema version;
- event handlers;
- artifact rehydration handlers;
- reset order;
- sequence/identity behavior;
- canonical export for rebuild equivalence.

A full rebuild clears every registered projection, replays events, rehydrates artifact-backed bulk rows, and proves equivalence. A projection must never silently preserve stale rows.

## 3.4 State seals

A seal binds a projected snapshot to exact source heads. Depending on the surface, the seal includes:

- event-log head;
- artifact identities;
- mission version;
- target snapshot and capture;
- recognition run;
- Project Intent Model;
- Master Benchmark version;
- Measurement Catalogue version;
- model/tool policy;
- Git Base Pin and candidate identity;
- status schema version.

A mixed-generation snapshot is invalid.

---

# 4. Identity model

Identity is layered. No identifier is overloaded to mean both location and version.

## 4.1 Project and mission identity

```text
TargetProgramId       stable registration identity
MissionVersionId      immutable governed mission/configuration identity
CycleId               one locked RPI cycle under one mission version
AssessmentEnvelopeId  exact bounded claim envelope
```

## 4.2 Repository and file identity

```text
RepositoryId       registered repository identity
SnapshotContentId  immutable identity of governed content basis
CaptureId          one capture receipt, environment, Git, and time context
FileLocationId     stable repository + normalized relative path identity
FileVersionId      immutable capture/snapshot + path + content identity
```

A rename creates a new location identity and may be linked by a rename relation. It does not silently reuse the old path identity.

## 4.3 Semantic identity

A native semantic unit identity includes:

- environment adapter and identity-scheme version;
- file version;
- declaration kind;
- parent identity;
- signature, overload, member, local, or anonymous discriminator;
- stable native source anchor.

Duplicate logical identities and dangling internal edge endpoints are invalid recognition results. UPR identities link native units while preserving native provenance.

## 4.4 Experiment identity

```text
FindingId
HypothesisId
CandidateId
ProofContractId
CandidateBenchmarkVersionId
BaselineRunId
CandidateRunId
EvidencePackageId
VerdictId
```

A changed proof contract, benchmark, candidate tree, environment fingerprint, or measurement basis creates a new identity. It cannot inherit a prior verdict silently.

## 4.5 Master Benchmark identity

```text
MasterBenchmarkVersionId
MasterBenchmarkParentId
CoverageModelVersionId
ClosingRunId
NextCycleVitalInputId
```

Compatibility is classified as fully comparable, partially comparable, or requiring a bridge run.

## 4.6 Git identity

Git identity includes repository object format, Base Pin, tree, parent, commit, branch head, worktree lease, change-set partition, remote, review head, check run, and publication receipt. The Git contract owns the detailed records.

---

# 5. Target registration and Configuration

A Target Program registration contains:

- target ID, display name, and repository set;
- canonical Creator roots and protected refs;
- inventory roots and exclusions;
- adapter extraction scopes;
- worktree-pool and artifact roots;
- `target description.md` path;
- `benchmark.txt` path;
- Measurement Catalogue and target profile;
- approved tools, scenarios, and hosts;
- provider/model policy;
- risk, autonomy, Custodian, publication, and retention policy;
- environment and platform matrix;
- secret and data-minimization policy.

Configuration is not active merely because text fields are populated. It progresses through:

```text
ENTERED
RESOLVED
EXISTS
READABLE
SCHEMA_VALID
POLICY_VALID
TOOL_REACHABLE
MISSION_REGISTERED
CYCLE_READY
```

## 5.1 Project intent input

`target description.md` is loaded, normalized, hashed, snapshotted, and compiled into the Project Intent Model. The model records:

- purpose;
- users/operators/consumers;
- journeys and workloads;
- capabilities;
- critical behavior;
- strategic objectives;
- quality priorities;
- constraints and obligations;
- supported environments and scale;
- non-goals;
- acceptable and unacceptable trade-offs;
- ambiguities and benchmarkability.

## 5.2 Master Benchmark input

`benchmark.txt` is loaded, normalized, hashed, snapshotted, and compiled into a Master Benchmark Specification containing:

- runner and environment adapter;
- build/launch/readiness/cleanup;
- scenario IDs and controlled inputs;
- warm-up, repetition, duration, timeout, and invalid-run rules;
- telemetry schemas and native units;
- screenshots, traces, profiles, logs, and recordings;
- mandatory gates and regression signals;
- variance and stability policy;
- execution-cost budget;
- environment fingerprint requirements.

AI may propose interpretation or revisions. Deterministic validation establishes executability and authority.

## 5.3 Cycle lock

At cycle start, CLU-E locks the exact target description, benchmark, repository state, catalogue, adapters, model policy, proof policy, budget, and risk envelope. A changed input produces one explicit choice:

```text
CONTINUE_LOCKED
RESTART_WITH_NEW_INPUTS
FORK_NEW_MISSION
```

Silent mid-cycle mutation is prohibited.

---

# 6. Repository inventory and Q1 physical model

The physical inventory is authoritative for Q1 ALL membership. It is independent of semantic recognition.

Each eligible governed file produces one record with:

- location and version IDs;
- path, name, extension, bytes, hash, and physical format;
- primary technology family and environment;
- classification source, confidence, reason, and classifier version;
- inventory state;
- recognition state and adapter depth;
- semantic summary and memberships when available;
- tracked/untracked/generated/excluded facets where policy permits.

The classifier uses strongest evidence in this order:

```text
Creator override
→ adapter result
→ exact path/name rule
→ shebang/toolchain signature
→ extension/compound extension
→ media/binary signature
→ explicit unknown
```

Unknown and unsupported artifacts remain visible. The browser may render glyphs but may not classify files.

Q1 ALL groups each file once under:

```text
Project → Artifact Family → Environment → File
```

Q1 DIVE uses semantic units under:

```text
Domain → Subsystem → Module → Class/Type → Function/Method
```

The selected physical file is immutable DIVE context, not a visible hierarchy node. The complete interaction, protocol, taxonomy, and performance contract belongs to `CLUE_Q1_System_Navigator_v9.md`.

---

# 7. Native recognition and Universal Project Representation

## 7.1 Environment Adapter Registry

Every adapter declares:

- environment ID and version;
- supported files and artifacts;
- native entity/dependency model;
- deterministic facts it can prove;
- recognition depth: identify, parse, semantic, patch, prove;
- toolchain and runtime instruments;
- supported metrics;
- context extraction and evidence compression;
- unsupported categories and uncertainty behavior.

## 7.2 Recognition pipeline

```text
inventory basis
→ native adapter selection
→ native parse and diagnostics
→ unit identity and source anchors
→ native dependency extraction
→ runtime enrichment where available
→ UPR projection
→ purpose/capability binding
→ AI semantic enrichment
→ metric applicability
→ committed recognition result
```

Recognition results are complete artifacts. Incremental recognition must produce the same canonical complete result as a full recognition of the same final basis.

## 7.3 Universal Project Representation

UPR links:

- native artifacts and units;
- containment and memberships;
- calls/imports/references/data flows;
- schemas and transformations;
- capabilities and runtime paths;
- producer/consumer contracts;
- platform and environment boundaries;
- provenance and confidence.

UPR is language-neutral for cross-project reasoning but never discards native facts required for proof.

## 7.4 Semantic claims

AI semantic records are stored separately from deterministic facts. A record includes:

- primary and secondary responsibilities;
- domain/subsystem/module memberships;
- architectural role;
- purpose/intent relation;
- evidence references;
- assumptions and uncertainty;
- model, prompt, and context identity;
- confirmation state and invalidation conditions.

Manual Creator confirmations have higher project-knowledge authority than unconfirmed model classifications, but conflicting evidence remains visible.

---

# 8. Mission, tasks, and context

## 8.1 Mission registration

A mission version binds all behavior-governing inputs. Registration is a recoverable state machine ending in a final `mission.registered` commit event. Analysis, proof, patching, and landing cannot proceed under an uncommitted bootstrap mission.

## 8.2 Durable task queue

Tasks include:

- inventory and recognition;
- semantic enrichment;
- ambiguity resolution;
- documentation alignment;
- metric applicability;
- deterministic measurement;
- hypothesis formation;
- candidate prioritization;
- benchmark/test design;
- patch planning/generation;
- execution and evidence digestion;
- adjudication;
- benchmark enrichment;
- equilibrium challenge;
- Git/provider/recovery operations.

A task has type, scope, dependencies, risk, required evidence, authorized tools, token and compute budget, model tier, retry policy, lease, attempt token, checkpoint, and terminal state.

Lease owner, unexpired lease, attempt token, and state transition are checked atomically. Late results are rejected.

## 8.3 Context packets

A context packet is a typed, hashed artifact containing only the smallest evidentially complete material for one task:

```text
identity
structural facts
semantic context
intent fragments
applicable metric cards
change context
evidence digest
policy constraints
output schema
```

Missing essential sections make the packet non-runnable. Source content comes from the locked snapshot, not an unbound live tree.

## 8.4 Session packets

For manual or external worker exchange, export/import packets bind:

- mission, cycle, task, attempt, lease;
- exact context sections and provenance;
- exact output schema hash;
- permitted attachments;
- expiry and authority.

Imported results are validated before becoming accepted evidence. Attachments are classified, size-limited, secret-scanned, hashed, and manifested.

---

# 9. AI architecture boundary

The AI Plane uses four tiers:

```text
Tier 0  deterministic only
Tier 1  economical classification and summarization
Tier 2  general semantic reasoning and ordinary patch/test work
Tier 3  strongest approved reasoning for high-value architecture and adjudication
Tier 4  independent adjudication for material disputes or equilibrium
```

Routing considers task type, risk, affected scope, uncertainty, evidence quality, reversibility, expected value, prior disagreement, and remaining budget.

Every AI invocation records task, model policy, prompt template, input hashes, output hash, schema result, tokens, latency, retries, cache, cost, and downstream use. Detailed policy belongs to `CLUE_AI_Utilization_v9.md`.

---

# 10. Measurement and applicability

The canonical catalogue contains 100 stable coordinates in four families:

```text
Target Quality
Evidence and Assurance
Mandatory Acceptance Gates
CLU-E Self-Measures
```

Native units remain authoritative. Normalized values are used only for comparison and visualization.

Applicability uses a funnel:

```text
complete catalogue identifiers and compact metadata
→ deterministic exclusions and global gates
→ cached target-metric matrix
→ AI review of ambiguous cases
→ deep evaluation of selected metrics
→ affected-scope expansion after candidate change
```

Mandatory gates are never removable by AI. Detailed metric identities and rules belong to `CLUE_Canonical_Measurement_Catalogue_v9.md`.

---

# 11. Findings, hypotheses, and candidate selection

A finding is not automatically a defect. It contains:

- target scope;
- observed evidence;
- metric and intent context;
- claimed imperfection;
- uncertainty and alternatives;
- potential consequence;
- proposed improvement direction;
- required proof;
- risk, reversibility, cost, and expected value.

Equivalent findings are deduplicated. Negative results and prior rejected paths are consulted before a candidate is selected.

Prioritization combines deterministic scoring and AI reasoning. It cannot override mandatory policy priorities or risk limits.

---

# 12. Proof system

## 12.1 Proof Contract

A Proof Contract freezes before result interpretation:

- hypothesis and protected outcome;
- baseline and candidate identities;
- candidate benchmark specification;
- scenarios and inputs;
- target metrics and guardrails;
- thresholds and statistical rule;
- invalid-run conditions;
- environment/tool fingerprint;
- mandatory gates;
- human-evaluation protocol where applicable;
- required remote checks where applicable;
- rollback conditions.

## 12.2 Candidate Benchmark

The Candidate Benchmark is narrow enough to test the causal claim and broad enough to detect affected regressions. Baselines are reusable only while source, environment, tool, metric, and proof-contract validity conditions remain satisfied.

## 12.3 Master Benchmark

The Master Benchmark observes the complete accepted project. It provides opening vital signs, closing whole-project evidence, historical trends, regression awareness, coverage, and next-cycle candidate seeds.

It does not replay every historical A/B experiment. Accepted candidates emit compact contribution records that may promote durable scenarios, signals, gates, or stress envelopes.

## 12.4 Evidence digest

Raw evidence remains in the artifact store. AI first receives a deterministic digest containing:

- identities and environment;
- run validity;
- repetitions and warm-up;
- native statistics;
- metric deltas;
- gate results;
- diagnostic clusters;
- visual-diff summary;
- artifact references.

AI may request specific raw evidence on demand.

## 12.5 Verdict

A verdict requires:

```text
valid experiment
+ target claim supported or refuted
+ applicable metrics assessed
+ mandatory gates passed
+ no unacceptable affected-scope regression
+ exact identity and evidence integrity
```

The recommendation may be `ACCEPT`, `REJECT`, `REVISE`, `DEFER`, or `INVALID`. The final policy transition remains deterministic and authority-bound.

---

# 13. Candidate modification and custody

The normal change flow is:

```text
accepted hypothesis
→ leased version-pinned worktree
→ smallest controlled patch
→ complete change-set classification
→ build/test/benchmark
→ sealed candidate commit
→ evidence assessment
→ mandatory gates
→ Custodian landing or rejection
→ post-land verification or revert
```

The candidate may contain implementation, durable proof instruments, regression protection, dependency locks, documentation, and evidence pointers only when classified and authorized. Ephemeral instrumentation, generated output, unrelated Creator changes, incidental tool mutations, forbidden surfaces, and unknown changes follow the Git contract and may block sealing.

---

# 14. Great Book, value, and benchmark contributions

Every terminal experiment creates an immutable record. Accepted improvements additionally emit a `BenchmarkContributionRecord` containing:

- affected objective/capability;
- native-unit deltas;
- moved bottleneck or changed operating envelope;
- newly useful telemetry;
- discovered risk or blind spot;
- candidate benchmark reference;
- promotion/consolidation/pruning recommendation;
- expected information gain and cost;
- provenance and invalidation conditions.

Value records distinguish:

- expected technical value;
- assurance value;
- forecast economic or operational value;
- realized value;
- cost and opportunity cost;
- attribution confidence;
- value horizon.

No mandatory safety/correctness gate is reduced to a monetary score.

---

# 15. Master Benchmark governance

At cycle closure:

1. freeze the accepted project snapshot;
2. collect contribution records and durable lessons;
3. map objectives, capabilities, domains, runtime paths, metric families, gates, risks, and environments to current benchmark coverage;
4. use strong AI to propose enrichment, consolidation, pruning, telemetry, thresholds, or stress changes;
5. independently critique material revisions;
6. validate execution safety, reachability, schemas, repeatability, variance, cleanup, timeout, cost, and information gain deterministically;
7. classify historical comparability and run bridges when required;
8. persist the accepted benchmark version;
9. execute the final Master Benchmark against the accepted project;
10. assess vital signs, anomalies, trends, blind spots, and candidate seeds;
11. create `NextCycleVitalInput`.

Valid review outcomes include:

```text
BENCHMARK_REVISED
BENCHMARK_CONSOLIDATED
BENCHMARK_PRUNED
BENCHMARK_THRESHOLDS_UPDATED
BENCHMARK_STRESS_ENVELOPE_RAISED
BENCHMARK_UNCHANGED_NO_JUSTIFIED_REVISION
```

---

# 16. Equilibrium architecture

The Equilibrium subsystem tracks coverage and terminal state by:

- environment;
- domain/subsystem/module/file/unit;
- capability;
- cross-environment boundary;
- metric applicability;
- proof authority;
- method frontier;
- value/assurance horizon;
- benchmark coverage and maturity;
- unresolved uncertainty.

Challenge passes target changed, weakly measured, low-confidence, previously ambiguous, or apparently stable sampled regions. Independent final adjudication uses the strongest authorized reasoning tier only after deterministic compression.

`MasterBenchmarkEquilibriumGate` blocks equilibrium when:

- a critical objective lacks an evidence path;
- telemetry is unstable or non-discriminating;
- benchmark coverage has a material gap;
- a justified benchmark revision remains at acceptable cost;
- a closing run reveals an unresolved anomaly or candidate;
- a required environment or boundary remains silently unsupported.

---

# 17. Security and trust boundaries

## 17.1 Capability security

AI and workers receive typed capability tokens bound to mission, task, subject, attempt, purpose, path zone, command class, expiry, and constraints. Partial silent grants are prohibited.

## 17.2 Path security

All roots are resolved and realpathed before cross-field validation. Creator source, worktree pool, workspace, artifact root, browser profile, and protected surfaces obey explicit non-overlap rules. Symlink, junction, traversal, case, and reparse-point behavior is tested on the host platform.

## 17.3 Host security

The restricted host implements a closed command registry. It independently revalidates path zones and arguments. Raw shell strings from AI are not accepted.

## 17.4 Prompt-injection and data minimization

Project text is untrusted content, not authority. Context construction removes secrets, credentials, personal data, prohibited directories, and irrelevant repository material before external AI use. Provider policy is configurable by repository and file class.

## 17.5 Browser and network security

Browser agents use dedicated profiles, allowed origins, bounded response sizes, timeouts, content-type checks, redirect policy, and source-map restrictions. Dashboard control endpoints remain loopback-only unless authenticated and CSRF/origin protected.

## 17.6 Git and provider security

Credentials remain outside model context and ordinary evidence. Protected refs, expected old object IDs, signing, hooks, filters, submodules, LFS, sparse checkout, partial clones, and provider webhooks follow the Git owner contract.

---

# 18. Deployment and process model

The reference deployment is local-first:

- one single-writer CLU-E daemon;
- one or more read-only status/UI clients;
- local event and artifact memory;
- local target repositories and isolated worktrees;
- restricted host and dedicated browser process;
- optional external AI providers;
- optional Git remotes, provider APIs, remote checks, and cloud evidence storage.

Scaling may distribute recognition, model calls, benchmarks, or provider operations, but task leases, exact input identities, artifact hashes, and terminal events preserve one logical mission history.

No distributed worker may infer authority from network reachability alone.

---

# 19. Event families

Canonical event families include:

```text
mission.*
configuration.*
inventory.*
recognition.*
semantic.*
metric.*
task.*
ai.*
hypothesis.*
benchmark.*
test.*
candidate.*
evidence.*
verdict.*
git.*
provider.*
publication.*
landing.*
greatbook.*
equilibrium.*
status.*
recovery.*
```

Every family has a versioned schema. Unknown required events fail visibly; they are not silently dropped by projections.

---

# 20. Status and interface integration

Status v5 is the only supported operational read contract. It contains:

- project inputs and cycle lock;
- target and assessment envelope;
- recognition and Q1 inventory/semantic coverage;
- current work;
- measures, sessions, findings, proof, and benchmarks;
- AI orchestration;
- Git/cloud lifecycle;
- Great Book, value, and equilibrium;
- integration/runtime diagnostics;
- source identities and seal.

The Dashboard and Configuration interface render this snapshot and live streams. They may request actions through typed APIs but may not create an independent model of truth.

---

# 21. Domain ownership references

| Detailed subject | Owner |
|---|---|
| operational cycle ordering | `CLUE_Execution_Model_v9.md` |
| AI activity map, routing, token/cache policy | `CLUE_AI_Utilization_v9.md` |
| Git records, branch/commit/remote/provider flows | `CLUE_Git_Integration_v9.md` |
| metric definitions and coordinates | `CLUE_Canonical_Measurement_Catalogue_v9.md` |
| status JSON contract and freshness | `CLUE_Status_Contract_v9.md` |
| operator presentation and controls | `CLUE_Interface_Design_v9.md` |
| Q1 topology, taxonomy, protocol, performance | `CLUE_Q1_System_Navigator_v9.md` |
| target source-file placement | `CLUE_Project_Directory_v9.md` |

---

# 22. Architectural acceptance criteria

A CLU-E implementation conforms to this architecture only when:

- all governed inputs and state transitions have exact identities;
- mission registration precedes authoritative work;
- projections rebuild exactly from durable events and artifacts;
- inventory membership is independent of semantic recognition;
- semantic identities are collision-free and internal edges resolve;
- full and incremental recognition yield the same canonical complete result;
- AI outputs are typed, evidence-linked, budgeted, cached, and auditable;
- mandatory gates remain deterministic;
- task lease and attempt authority cannot be used after expiry;
- candidate mutation occurs only in isolated authorized state;
- the exact proved candidate is the only candidate eligible for landing;
- Status is sealed to compatible source heads;
- Q1 ALL/DIVE preserve physical/semantic separation;
- every complete cycle closes with governed Master Benchmark review and execution;
- equilibrium exposes residual unknowns and benchmark maturity;
- current backlog status is not embedded as permanent architecture.

---

# 23. Final architecture statement

```text
Deterministic facts establish what exists and what happened.
AI reasoning explains meaning and proposes what to test.
Proof instruments determine whether the claim survived.
Git and Custodian preserve exact, recoverable state transitions.
The Great Book preserves what was learned.
The Master Benchmark keeps the whole accepted project observable.
Status and the interface reveal the same sealed truth.
```

That combination—not any single model, benchmark, database, branch, or visualization—is CLU-E.
