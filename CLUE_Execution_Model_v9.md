# CLU-E Execution Model v9
## End-to-End Mission, Cycle, Candidate, Benchmark, Landing, and Equilibrium Procedure

**Document status:** normative operating and execution contract  
**Revision:** 9.1 (pack release 9.0) — revision 8.0 content preserved at the v9 re-baseline; amended 2026-08-14 under ADR-0017 for provider-budget controlled pause/recovery and explicit local-first manual Git synchronization.  
**Language:** English  
**Methodology:** `RPI_Core_Methodology_v9.md`  
**Architecture:** `CLUE_Architecture_v9.md`  
**Scope:** ordering, prerequisites, transitions, evidence handoffs, failure behavior, and terminal conditions for actual CLU-E operation  
**Intentionally out of scope:** detailed component schemas, current implementation backlog, target-specific thresholds, and provider-specific API mechanics

> **A CLU-E cycle improves both the accepted project and the instrument used to observe the accepted project.**

---

# 1. Operating unit

A CLU-E mission contains one or more RPI cycles. A cycle is an immutable assessment and improvement campaign over one locked envelope.

```text
Mission
  → Cycle 1: P(0) to P(1)
  → Cycle 2: P(1) to P(2)
  → ...
  → Bounded Equilibrium or explicit suspension
```

Each accepted state becomes the baseline for the next cycle. A cycle may end without an accepted patch when it produces terminal negative knowledge, reduced uncertainty, verified adequacy, or a reasoned stop under the active value policy.

---

# 2. Required cycle inputs

A proof-authoritative cycle requires:

- registered Target Program and repository set;
- exact repository/content state and environment fingerprint;
- registered mission and policy versions;
- valid `target description.md`;
- valid `benchmark.txt`;
- Project Intent Model compiled from the target description;
- normalized executable Master Benchmark Specification;
- Measurement Catalogue version and target profile;
- adapter set and recognition policy;
- model/provider and token policy;
- approved tools and proof instruments;
- risk, autonomy, Custodian, Git, publication, budget, and value-horizon policy.

Recognition may be run in diagnostic mode without all inputs, but CLU-E must not claim complete project understanding, proof-authoritative cycle closure, or equilibrium without the required locked inputs.

---

# 3. Cycle initialization

## 3.1 Resolve and validate Configuration

CLU-E resolves all paths, repositories, protected surfaces, worktree roots, artifact roots, tool executables, browser profiles, providers, credentials, and policy files. Validation is fail-closed for write-capable or proof-authoritative operation.

## 3.2 Register mission version

The mission version binds:

- governing documentation and policy;
- Target Program registration;
- target-input hashes;
- configuration and environment policy;
- catalogue and adapter versions;
- AI routing and context policy;
- Git/Custodian policy;
- proof and benchmark policy;
- budget, risk, and value horizon.

No authoritative event is emitted under an incomplete bootstrap mission.

## 3.3 Lock cycle inputs

CLU-E snapshots and locks:

```text
target description.md
benchmark.txt
repository and Git basis
toolchain/environment
catalogue and target profile
adapter set
model policy
proof policy
budget/risk/value envelope
```

If either configured file changes after the lock, the active cycle continues only against the locked version unless the Creator explicitly restarts or forks.

## 3.4 Compile reusable models

- compile or reuse the Project Intent Model;
- normalize or reuse the Master Benchmark Specification;
- validate objective IDs, benchmark scenario IDs, telemetry schemas, and gates;
- create the initial objective-to-benchmark coverage map;
- identify unresolved intent ambiguities or benchmark execution blockers.

---

# 4. Opening Master Benchmark

The cycle begins with a valid whole-project observation.

CLU-E may reuse the preceding cycle's closing run only when all of the following match the reuse policy:

- accepted project snapshot;
- Master Benchmark version;
- environment and tool fingerprint;
- scenario inputs and seed policy;
- telemetry schema;
- freshness limit;
- artifact integrity.

Otherwise, CLU-E executes a new opening Master Benchmark.

The opening result establishes:

- project-wide native-unit vital signs;
- mandatory-gate state;
- objective and scenario coverage;
- anomalies and blind spots;
- environment stability;
- candidate seeds;
- a historical comparison anchor.

An invalid or non-reproducible opening run blocks proof-authoritative cycle work until repaired or explicitly scoped out by a new mission decision.

---

# 5. Deterministic recognition

## 5.1 Inventory

CLU-E inventories every eligible governed artifact, classifies its technology family and environment, records explicit exclusions, and creates stable location and immutable version identities.

Inventory is complete before semantic recognition is treated as project-complete. Unsupported files remain visible.

## 5.2 Native recognition

Each registered environment adapter performs the strongest supported native pass:

```text
identify → parse → semantic → patch-capable → prove-capable
```

The result contains native units, dependencies, diagnostics, unresolved references, and provenance.

## 5.3 UPR and capability reconstruction

Native results are linked into the Universal Project Representation. CLU-E reconstructs:

- domains, subsystems, modules, and responsibilities;
- capabilities and protected outcomes;
- runtime paths and data transformations;
- cross-environment contracts;
- platform-specific behavior;
- source/documentation alignment.

## 5.4 Incremental reuse

Unchanged recognition, semantic summaries, applicability, documentation mappings, and negative results are reused by content-addressed identity. Changed and affected entities are invalidated explicitly. A merged incremental result must be canonically equivalent to a full result for the same final basis.

---

# 6. AI semantic enrichment

AI receives compact, typed context after deterministic recognition. It may:

- infer responsibilities and semantic memberships;
- resolve ambiguities;
- map documentation and intent to implementation;
- identify unmodeled capability boundaries;
- preserve alternative interpretations;
- request missing evidence.

AI does not create physical files, source identities, compiler facts, benchmark numbers, or gate results.

The Project Intent Model supplies only relevant objective fragments. Stable semantic understanding is cached and invalidated only when its evidence changes.

---

# 7. Metric screening and measurement

Every target is screened against the complete metric catalogue at the applicability level.

```text
all metric IDs + compact metadata
→ deterministic prefilter
→ cached applicability matrix
→ AI review of ambiguous pairs
→ deep assessment of applicable metrics
```

CLU-E then runs cheap deterministic measures and always-run gates. It records:

- native values;
- measurement validity;
- evidence coverage;
- unresolved applicability;
- objective and capability relationships;
- affected-scope expansion rules.

No metric is ignored merely because it was absent from an AI prompt. No non-applicable metric receives expensive deep reasoning without justification.

---

# 8. Imperfection discovery and candidate formation

AI combines:

- deterministic anomalies;
- metric results;
- architecture and documentation mismatches;
- Project Intent Model objectives;
- Master Benchmark observations;
- runtime failures and long-tail behavior;
- method-frontier evidence;
- prior accepted/rejected knowledge.

It produces evidence-linked hypotheses rather than vague criticism.

A hypothesis includes:

- target and affected scope;
- observed evidence;
- protected intent/capability;
- claimed imperfection;
- expected outcome;
- uncertainty and alternatives;
- required proof;
- risk, reversibility, cost, and expected value;
- possible Master Benchmark lesson.

Equivalent hypotheses are deduplicated. Previously rejected hypotheses are reopened only when an explicit invalidation condition has changed.

---

# 9. Candidate prioritization

The prioritizer combines deterministic policy with AI judgment. It considers:

- expected persistent value or assurance;
- probability of proving the claim;
- evidence cost;
- risk and blast radius;
- reversibility;
- target priority;
- benchmark blind-spot reduction;
- method-level leverage;
- remaining token/compute budget;
- dependencies between candidates.

Strong models are reserved for the highest-value, highest-risk, or most ambiguous decisions. Mandatory security, correctness, or governance work cannot be deprioritized solely by economic score.

---

# 10. Candidate-specific proof design

For the selected hypothesis, CLU-E designs a frozen Proof Contract and Candidate Benchmark.

The contract defines:

- causal claim;
- baseline and candidate state;
- representative inputs;
- target measurements;
- affected-scope regression measurements;
- mandatory gates;
- warm-up, repetitions, duration, and statistics;
- invalid-run and confounder rules;
- required browser, compiler, profiler, database, or human instruments;
- success, non-inferiority, and rejection thresholds;
- environment fingerprint;
- rollback conditions.

The proof plan is validated against available execution capabilities before patching begins. An AI-authored instrument has no authority until this validation and freeze complete.

---

# 11. Baseline capture

CLU-E captures or reuses a baseline only when its validity conditions match the frozen contract.

The baseline package includes:

- exact project and Git Base Pin identity;
- exact benchmark version;
- environment and tool fingerprint;
- input dataset/seed identity;
- raw artifacts;
- deterministic digest;
- validity and variance state.

A stale, incompatible, or noisy baseline must be rerun. It cannot be repaired by narrative explanation.

---

# 12. Isolated candidate implementation

## 12.1 Acquire worktree lease

The Git Integration Service creates or leases a version-pinned experiment worktree and CLU-E-owned branch. The Creator tree remains protected.

## 12.2 Plan the smallest causal change

AI receives only the target code, required interfaces, nearby tests, project conventions, intent constraints, and affected-scope context. It proposes the smallest evidence-relevant patch and declares expected metric effects and risks.

## 12.3 Apply and classify

CLU-E applies the patch through typed write authority. Every changed file is classified under the Git Change-Set Partition. Unknown, unrelated, incidental, or forbidden changes block candidate sealing.

## 12.4 Static preparation

Before expensive proof, CLU-E runs:

- syntax and type checks;
- formatting/lint policy where authoritative;
- build prerequisites;
- affected tests;
- secret and protected-surface checks;
- diff and scope validation;
- candidate worktree cleanliness checks.

A failed candidate may be revised only when failure evidence changes the next attempt. Blind repeated generation is prohibited.

---

# 13. Candidate execution and evidence capture

CLU-E executes the frozen plan:

```text
build
→ unit/integration tests
→ browser/runtime scenarios
→ candidate benchmark repetitions
→ affected-scope guardrails
→ required remote checks or human evaluation
→ raw artifact capture
```

The Experiment Plane records instrument health separately from target behavior. Environment failure, flaky test, invalid benchmark, and candidate failure are not merged.

Raw logs, traces, profiles, screenshots, recordings, and measurements remain immutable. Deterministic code calculates statistics and produces a compact evidence digest.

---

# 14. Candidate assessment

AI receives the hypothesis, proof contract, baseline digest, candidate digest, metric deltas, gate results, anomalies, and artifact references.

It assesses:

1. whether the benchmark tested the intended claim;
2. whether the run was valid and reproducible;
3. whether the delta is statistically and practically meaningful;
4. whether any applicable metric regressed;
5. whether purpose, capability, workload, and environment contracts were preserved;
6. whether evidence is sufficient;
7. whether trade-offs comply with project policy;
8. which durable lesson should enter the Great Book and Master Benchmark review.

Deterministic authority then enforces hard gates, identity integrity, branch/lease validity, and policy.

Possible terminal dispositions:

```text
ACCEPT
REJECT
REVISE
DEFER
INVALID
```

Independent adjudication is used sparingly for high-impact conflict, unresolved interpretation, or final equilibrium.

---

# 15. Acceptance, commit, and landing

## 15.1 Seal accepted candidate

An accepted candidate is bound to:

- exact tree and parent;
- complete Change-Set Partition;
- proof contract and benchmark;
- baseline and candidate evidence;
- verdict;
- environment and catalogue;
- mission/cycle;
- required review/check state.

## 15.2 Create review or accepted commit

The Git service creates the appropriate immutable commit state. Commit creation does not retroactively prove the candidate; it packages the exact candidate that was proved.

## 15.3 Optional publication and review

Approved refs and evidence manifests may be published. Provider review and remote CI are ingested as provenance-bound evidence. A green remote check does not replace the RPI verdict.

## 15.4 Custodian landing

The Custodian verifies:

- protected-ref expectation;
- exact candidate identity;
- proof freshness;
- policy and required checks;
- no divergence or rewrite;
- reversibility.

It lands through the configured transport or refuses.

## 15.5 Post-land verification

CLU-E verifies the canonical state after landing. Failure triggers governed revert or operator escalation according to policy. Landing without post-land verification is not terminal success.

---

# 16. Great Book and knowledge update

Every terminal result records:

- claim and scope;
- intent/capability context;
- baseline/candidate identities;
- proof and evidence;
- verdict and uncertainty;
- cost and value;
- Git/publication/landing provenance;
- negative-knowledge and retry conditions;
- benchmark contribution.

Accepted changes invalidate and regenerate affected recognition, semantic summaries, applicability, tests, and benchmark coverage. Rejected paths remain queryable so later cycles do not rediscover the same dead end without changed evidence.

---

# 17. Master Benchmark enrichment review

After the cycle's candidate-search policy is complete, CLU-E freezes the accepted project state and closes the cycle through the Master Benchmark.

## 17.1 Collect contribution sources

- accepted improvements;
- semantic recognition conclusions;
- rejected or inconclusive experiments;
- runtime anomalies and historical regressions;
- objective, capability, environment, dependency, and metric changes;
- stress, boundary, holdout, and adversarial lessons;
- benchmark sensitivity results;
- permitted aggregated production/user telemetry.

## 17.2 Build coverage map

Map every scenario and signal to:

- Project Intent Model objectives;
- capabilities and critical journeys;
- domains/subsystems/runtime paths;
- environments and platforms;
- metric families and mandatory gates;
- known risks and historical failures.

## 17.3 Propose and critique

The Benchmark Curator proposes additions, consolidation, pruning, telemetry, thresholds, or stress changes. The Benchmark Critic independently challenges:

- overfitting;
- redundancy;
- implementation lock-in;
- unstable instrumentation;
- target leakage;
- missing holdouts;
- excessive execution cost;
- broken historical comparability.

## 17.4 Validate information gain

Deterministic validation checks reachability, safety, schemas, cleanup, repeatability, variance, timeouts, artifacts, and cost. Where practical, old and proposed benchmarks run against the same accepted snapshot.

A revision is accepted only when it adds useful project-level information at acceptable cost. A justified unchanged outcome is valid.

## 17.5 Version and bridge

Persist parentage, contribution provenance, coverage delta, runtime-cost delta, compatibility class, and bridge-run evidence.

---

# 18. Closing Master Benchmark

Execute the accepted Master Benchmark version against the complete accepted project snapshot.

The closing result must preserve native-unit vital signs and raw artifacts. AI assesses:

- objective and capability health;
- historical trends;
- stability and variance;
- critical coverage gaps;
- unexplained anomalies;
- benchmark maturity;
- blind spots;
- next-cycle candidate seeds.

The closing run does not re-prove every historical patch. It characterizes the complete accepted system and tests whether durable project-level lessons remain protected.

---

# 19. Next-cycle vital input

Cycle closure creates a compact handoff containing:

- accepted project and Git identity;
- Master Benchmark version and closing run;
- environment fingerprint;
- Project Intent Model version;
- objective/capability coverage;
- native vital signs and trends;
- anomalies and blind spots;
- unresolved uncertainty;
- benchmark maturity;
- negative knowledge;
- candidate seeds;
- invalidation and freshness conditions.

The next cycle reuses this input only when its identity and freshness conditions remain valid.

---

# 20. Bounded Equilibrium procedure

CLU-E does not declare equilibrium after one clean pass. It performs hierarchical challenge:

1. verify complete inventory and required native coverage;
2. verify critical intent-to-evidence paths;
3. inspect changed, weakly measured, and low-confidence regions;
4. revisit ambiguous applicability and prior rejections whose invalidation conditions changed;
5. sample apparently stable areas;
6. challenge method adequacy and frontier coverage;
7. challenge benchmark coverage, stability, and sensitivity;
8. execute repeated valid closing runs;
9. use strongest authorized final adjudication;
10. record residual unknowns and excluded scopes.

Equilibrium is blocked when the latest Master Benchmark reveals a supported opportunity. That observation starts another cycle.

---

# 21. Stop, resume, restart, and fork

## 21.1 Graceful stop

Stop prevents new leases and lets safe in-flight work checkpoint or terminate. Durable state remains resumable.

## 21.2 Resume

Resume verifies mission, cycle locks, projection parity, task leases, repository state, tool health, and artifact integrity before continuing.

## 21.3 Restart cycle

A restart creates a new cycle identity and new lock when material inputs changed. Prior evidence remains historical and may be reused only under explicit compatibility rules.

## 21.4 Fork mission

A fork is required when mission, protected intent, target registration, or constitutional policy materially changes. The new mission references but does not rewrite the old history.

---

# 22. Failure classification

Failures are classified before recovery:

```text
CONFIGURATION
MISSION_AUTHORITY
INVENTORY_OR_RECOGNITION
AI_PROVIDER_OR_SCHEMA
CONTEXT_OR_BUDGET
HYPOTHESIS
PATCH
BUILD_OR_TEST
INSTRUMENT
BENCHMARK_VALIDITY
ENVIRONMENT
GIT_OR_WORKTREE
REMOTE_OR_PROVIDER
LANDING_OR_POST_LAND
PROJECTION_OR_STORAGE
SECURITY_OR_POLICY
```

Recovery seeks the cheapest evidence-producing next action. Repeating the same action without changed evidence is not recovery.

---

# 23. Deterministic and AI responsibility by phase

| Phase | Deterministic authority | AI responsibility |
|---|---|---|
| Registration | paths, hashes, schemas, policies, exact state | identify ambiguities in intent/configuration |
| Recognition | inventory, parsing, symbols, diagnostics, edges | purpose, responsibility, semantic membership |
| Metrics | values, applicability rules, hard gates | ambiguous applicability and interpretation |
| Hypotheses | anomaly inputs and policy limits | synthesis, causality hypotheses, prioritization |
| Proof design | executable capability and schema validation | scenario, confounder, threshold, test design |
| Patch | scope, allowed files, diff validation | plan and generate smallest candidate |
| Execution | tools, measurements, statistics, artifacts | diagnose and interpret results |
| Verdict | identity, hard gates, authority | reasoned recommendation and trade-off analysis |
| Git | exact state, typed mutations, receipts | change rationale and review narrative |
| Benchmark closure | execution, stability, information-gain calculation | enrichment synthesis, critique, whole-project assessment |
| Equilibrium | coverage and gate evidence | challenge, residual reasoning, final recommendation |

---

# 24. Execution completion criteria

A cycle is complete only when:

- inputs were locked and identities preserved;
- opening Master Benchmark was valid or validly reused;
- required recognition and metric screening completed;
- every selected candidate reached terminal disposition;
- accepted changes were landed and post-land verified or remained explicitly unlanded by policy;
- Great Book records and negative knowledge were committed;
- benchmark contributions were reviewed;
- the accepted Master Benchmark version was persisted;
- the closing run was valid;
- next-cycle vital input or an equilibrium evidence package was created;
- all residual unknowns and deferred work are explicit.

Budget exhaustion, model outage, or operator stop may suspend a cycle, but do not complete it or establish equilibrium.

---

# 25. Final execution formula

```text
Lock intent and observation
→ understand the exact project
→ screen all measures
→ test one justified hypothesis at a time
→ isolate every mutation
→ freeze proof before seeing the result
→ accept only evidence-supported improvement
→ preserve exact version and negative knowledge
→ improve the whole-project benchmark
→ observe the complete accepted project again
→ repeat or establish bounded equilibrium
```

---

# 26. 2026-08-14 executable-alignment amendment — provider pause and manual sync

An explicit provider billing, credit or funding refusal is a recoverable external stop condition,
not a crash and not a negative proof verdict. The execution order is:

```text
complete the current durable gateway write
→ refuse new AI submissions
→ refuse a new pipeline start
→ suspend a live cycle without manufacturing one
→ Status/Q3 = provider-budget controlled pause
```

A generic rate limit follows ordinary retry/degradation policy and never becomes `LACK OF $`.
Recovery requires an explicit exact-model probe and durable provider-resumed event. That recovery
re-opens the gateway only; an operator-owned suspended cycle must still pass the normal verified
resume act.

Git synchronization is likewise outside automatic cycle choreography. `SYNC GIT` is an explicit
operator action separate from Start, proof, verdict and cycle closure. With no registered remote it
refuses without network activity. This narrow P2 convenience action does not replace the governed
P4 repository/worktree/landing/publication lifecycle.
