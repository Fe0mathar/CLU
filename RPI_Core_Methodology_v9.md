# Recursive Project Improvement — RPI
## Core Methodology and Conformance Standard

**Document status:** founding normative methodology  
**Revision:** 9.0 (pack-coordinated) — content of revision 3.0 preserved verbatim; that revision added versioned project-intent input, the evolving whole-project Master Benchmark, mandatory closing observation, benchmark maturity, and next-cycle vital input. Re-baselined into the coordinated v9 documentation pack; see `DOCUMENTATION_GOVERNANCE_v9.md` §14.  
**Language:** English  
**Applies to:** any software, data, infrastructure, interactive, scientific, AI, embedded, or mixed-technology project whose state can be observed, changed in isolation, and evaluated against evidence  
**Reference implementation:** CLU-E  
**Normative companions for the CLU-E implementation:** `CLUE_Constitution_v9.md`, `CLUE_Architecture_v9.md`, `CLUE_Execution_Model_v9.md`, `CLUE_AI_Utilization_v9.md`, `CLUE_Git_Integration_v9.md`, `CLUE_Canonical_Measurement_Catalogue_v9.md`, `CLUE_Status_Contract_v9.md`, and `CLUE_Interface_Design_v9.md`

> **RPI converts bounded AI and computation into verified, persistent project value.**
>
> **A candidate change is not an improvement until its claim survives an admissible comparison against a frozen baseline.**

---

# 1. Purpose

Recursive Project Improvement, abbreviated **RPI**, is a general method for repeatedly improving a project that already performs its intended function.

RPI does not primarily ask whether the project works at all. Conventional tests, requirements checks, and release gates already answer that question. RPI begins after a usable baseline exists and asks a different question:

> **Can the same protected purpose and required capabilities be delivered better, and can that improvement be proved?**

“Better” may mean lower latency, lower memory use, smaller artifacts, lower energy use, higher reliability, stronger security, clearer architecture, better human experience, greater compatibility, improved maintainability, more accurate behavior, or another project-specific outcome. RPI does not assume that all such outcomes can be reduced to one number.

RPI is **recursive in the operational sense**:

```text
accepted project state P(n)
  → recognize and model
  → identify an improvable claim
  → design a proof instrument
  → produce and test a candidate
  → accept only admissible improvement
  → accepted project state P(n+1)
  → repeat
```

The accepted result of one cycle becomes the baseline of the next. RPI is not, by definition, recursive self-modification of the AI engine. The project is improved by an external improvement system. The improvement system may itself be assessed through the same method, but self-assessment is a separate target registration and never receives a privileged proof path.

---

# 2. Canonical distinction: RPI and CLU-E

RPI is the **methodology**. CLU-E is an **engine that implements the methodology**.

```text
RPI   = the general doctrine, records, proof rules, and stopping conditions
CLU-E = the durable orchestration, recognition, experiment, memory, custody,
        and operator system that applies RPI to registered Target Programs
```

A different implementation may conform to RPI without reproducing CLU-E’s interface, storage engine, model provider, or programming language. It must, however, preserve the RPI invariants defined by this document.

---

# 3. Scope and non-goals

RPI covers:

- complete-project and scoped-project recognition;
- native analysis inside each implementation environment;
- capability and intent reconstruction across implementation boundaries;
- comparison of the current method with applicable established and emerging methods;
- hypothesis formation;
- AI-authored or tool-authored benchmark design;
- frozen proof contracts;
- isolated candidate implementation;
- local and system-level evidence;
- human perceptual judgment where the outcome is irreducibly human;
- acceptance, rejection, memory, invalidation, and repeated cycles;
- value-horizon and assurance accounting;
- bounded equilibrium;
- versioned project-state identity, isolated change lines, remote durability, and recoverable publication when the implementation profile requires them.

RPI does not imply:

- that newer technology is automatically better;
- that an AI recommendation is evidence;
- that every quality dimension must be monetized;
- that a project can reach absolute perfection;
- that a single score can represent the whole project;
- that the improvement engine may rewrite canonical source without a custody boundary;
- that a benchmark may be changed after the candidate result is known;
- that a local gain may hide a global regression;
- that unsupported artifacts may be silently ignored;
- that human judgment is inferior evidence when the protected outcome is human perception;
- that Git or any particular version-control provider is mandatory for every RPI implementation;
- that a commit, push, review approval, or green cloud pipeline is itself an RPI verdict.

---

# 4. Core state model

RPI preserves the following states as distinct:

```text
observation
hypothesis
improvement claim
proposal
isolated candidate implementation
measurement result
admissible evidence
verdict
canonical landing
post-land verification
proven improvement
```

The transitions are one-way unless a later invalidation reopens the question. In particular:

```text
proposal             ≠ project state
isolated candidate implementation ≠ accepted change
measured difference   ≠ admissible evidence
positive local result ≠ system improvement
verdict                ≠ write authority
canonical landing      ≠ verified integration
version-control commit  ≠ proven improvement
remote publication      ≠ canonical acceptance
```

An RPI implementation must preserve durable identities and provenance across these states.

---

# 5. The RPI improvement object

The atomic object of RPI is not a patch alone. It is a **Proven Improvement Package**:

```text
Improvement Claim
+ Purpose and Capability Context
+ Baseline Identity
+ Candidate Identity
+ Proof Contract
+ Proof Instrument
+ Native Evidence
+ Protective Results
+ Verdict
+ Value Horizon
+ Reproduction and Reversal Material
+ Version-State and Publication Provenance when applicable
```

A patch without a proof package is only a proposal. A benchmark result without a frozen claim is only an observation. A visible difference without a controlled comparison is only an impression.

A canonical improvement claim contains at least:

```yaml
claim_id: RPI-CLM-...
target_scope: unit | capability | environment | cross_environment | project
protected_purpose: reference
protected_capabilities: [reference]
current_state: baseline reference
claimed_change: concise causal statement
primary_outcome: what is expected to improve
protective_outcomes: what must not regress
evidence_authority: INSTRUMENTED | EMPIRICAL
subtype: ANALYTIC | QUANTITATIVE | SYSTEM_OUTCOME | HUMAN_PERCEPTUAL | CONSTRAINT
value_horizon: execution | release | deployment_fleet | project_lifetime | assurance
uncertainty: explicit
```

---

# 6. Two proof authorities

RPI organizes proof through **two primary authorities**. They answer the user’s central question: how can an external AI system know that a project is actually better?

## 6.1 Instrumented proof

Instrumented proof is produced by an explicit, inspectable instrument operating on the studied object or a controlled representation of it.

It includes:

### Analytic proof

A result follows from a valid derivation or exact structural comparison, for example:

- an artifact contains fewer bytes;
- one buffer copy has been eliminated;
- the number of calls has changed from `n` to `1` under a stated invariant;
- an algorithmic upper bound changes from `O(n²)` to `O(n log n)`;
- an unreachable branch has been proved unreachable under the complete entry-point model;
- a contract violation is eliminated by construction.

Analytic proof must state its assumptions. An asymptotic improvement does not by itself prove a real runtime gain at the project’s operating scale.

### Quantitative experimental proof

A controlled benchmark measures native values such as:

- CPU or GPU time;
- wall-clock latency;
- throughput;
- memory, allocation, transfer, storage, or network cost;
- bundle or binary size;
- energy proxy;
- error rate;
- accuracy;
- recovery time;
- availability or failure frequency.

The benchmark must compare the same protected work under a frozen protocol. A numerical difference is not accepted when instrument health, sample adequacy, workload integrity, or causal attribution is insufficient.

### Constraint proof

A candidate removes a violation or satisfies a mandatory property without an unacceptable regression, for example:

```text
security violation → no violation
schema mismatch     → contract-conformant
race condition      → excluded by a proven synchronization rule
unsupported target  → supported under the declared envelope
```

Constraint proof is not “less mathematical” because it is boolean. The relevant outcome is the transition from non-conformance to conformance under a valid test or derivation.

## 6.2 Empirical proof

Empirical proof judges the effect in the complete operating context or through the intended observer.

It includes:

### System-outcome proof

The project or capability performs better in the Master Benchmark or another representative whole-project benchmark even when local costs trade off. Examples include:

- a targeting capability achieves a higher valid hit rate;
- a renderer delivers better frame pacing under the same scene and quality contract;
- a recovery flow loses fewer operations;
- an application completes a user task more reliably;
- the complete project consumes less cost under the same workload.

System-outcome proof has authority over a local metric when the local optimization exists only to serve the protected system outcome.

### Human-perceptual proof

The intended result is judged by a human because the protected outcome is perception, comprehension, artistic quality, usability, comfort, or another human experience that cannot be honestly replaced by a proxy.

Examples include:

- animation appears more natural;
- visual composition is clearer;
- an interaction is easier to understand;
- audio feels less fatiguing;
- an NPC response appears more coherent.

Human judgment must still be controlled where practical. RPI should use identical scenarios, A/B presentation, randomized or blind ordering, stable capture conditions, explicit criteria, and preserved observations. The human is an instrument, not an undocumented exception.

## 6.3 Relationship between the authorities

The two authorities are complementary:

```text
instrumented proof asks: what objectively changed in the studied object?
empirical proof asks: did the protected outcome improve in operation or perception?
```

A candidate may require both. A lower-memory renderer is not accepted if the central scene becomes visually worse. A visibly better animation is not accepted if it violates a safety or compatibility gate. RPI therefore permits one primary authority and any number of protective authorities.

---

# 7. AI-authored proof instruments

A defining property of RPI is that the project does not need a hand-written benchmark for every possible future improvement.

The improvement engine may design the proof instrument itself. It must:

1. understand the improvement claim;
2. determine which observation would confirm it;
3. determine which observation would refute it;
4. identify protected purpose, capabilities, workload, and contracts;
5. design a repeatable baseline/candidate comparison;
6. validate the instrument against known-good and known-bad fixtures where possible;
7. freeze the protocol before candidate results are interpreted;
8. execute and preserve raw evidence;
9. report limitations and residual uncertainty.

The candidate and its proof instrument are coupled:

```text
Candidate Change = Implementation + Frozen Proof Contract + Proof Instrument
```

An AI-authored benchmark is not trusted because the AI authored it. It becomes admissible only after instrument validation, protocol freezing, provenance, and the same protective gates applied to any other benchmark.

---

# 8. Candidate proof and whole-project proof

RPI requires distinct instruments for a candidate's causal claim and for the accepted project as a whole.

## 8.1 Candidate-specific proof

Candidate proof tests the exact causal claim under a frozen Proof Contract:

```text
claimed local or scoped outcome after
  compared with
claimed local or scoped outcome before
```

The comparison may use lower, higher, equal, non-inferior, constraint, qualitative, or composite criteria. It answers whether the candidate achieved what it claimed without violating its affected scope.

## 8.2 Capability and global guardrails

Consequential changes also run the applicable capability, cross-environment, platform, security, correctness, recovery, and global regression protections. Canonical acceptance requires:

```text
Candidate Proof = PASS
and Mandatory Gates = PASS
and Affected-Scope Guardrails = PASS
and, when required, Capability or Whole-Project Guardrails = IMPROVED or NON-INFERIOR
```

## 8.3 Master Benchmark

The **Master Benchmark** is the versioned whole-project observation instrument. It is different from the candidate benchmark. It opens and closes complete cycles, preserves project-level vital signs, exposes broad regressions and blind spots, and supplies candidate seeds to the next cycle.

A candidate benchmark proves or rejects one hypothesis. A durable measurement lesson from an accepted, rejected, or inconclusive experiment may enrich the Master Benchmark, but the full historical A/B experiment is not automatically promoted.

Every complete cycle performs a Master Benchmark enrichment review and ends with a valid run against the complete accepted project snapshot. Benchmark revisions are accepted only when they add trustworthy information at acceptable cost. Consolidation and pruning are legitimate improvements; uncontrolled growth is not.

The former term *Central Benchmark* is a deprecated alias for Master Benchmark.

---

# 9. Intent and capability before optimization

RPI cannot safely judge an implementation without reconstructing why it exists.

For each relevant unit or capability, the system distinguishes:

```text
Observed Implementation — what the source and runtime actually do
Inferred Intent         — what outcome the unit appears intended to produce
Protected Capability    — what the project must continue to provide
Problem Class           — the general class of problem being solved
Current Method          — the method family presently used
```

Intent must not be inferred from code alone. Evidence priority normally includes:

1. Creator-approved mission and capability declarations;
2. public contracts, callers, consumers, schemas, and external behavior;
3. valid tests and scenarios;
4. source behavior and side effects;
5. runtime observations;
6. architecture and design documents;
7. comments and names as weak evidence.

When intent is uncertain, RPI creates a knowledge task. It does not optimize the implementation’s accidental behavior as though it were the protected purpose.

## 9.1 Versioned project-intent source

A conforming RPI implementation must bind declared mission intent to a versioned source. The CLU-E profile uses the configured file `target description.md` and compiles it into a Project Intent Model containing stable objective, capability, constraint, priority, environment, non-goal, trade-off, benchmarkability, and ambiguity records.

Declared intent is not proof that the implementation satisfies it. It is compared with source, runtime behavior, tests, documentation, and benchmark evidence. Ordinary reasoning tasks receive only the relevant intent fragments rather than the complete document.

---

# 10. Method intelligence and the Applicable Solution Frontier

A project can be locally optimized while using a weak class of method. RPI must therefore ask not only whether the implementation is efficient, but whether the **chosen method is adequate**.

The method-intelligence sequence is:

```text
Intent Recovery
→ Problem-Class Classification
→ Current-Method Identification
→ Method-Landscape Retrieval
→ Applicability Filtering
→ Applicable Solution Frontier
→ Methodological Opportunity
→ Candidate Experiment
```

## 10.1 Applicable Solution Frontier

The **Applicable Solution Frontier** is the set of solution methods that:

- solve the same protected problem class;
- are compatible with the project’s constraints;
- have sufficiently fresh and credible evidence;
- are feasible in the target environment;
- are potentially superior in at least one relevant dimension;
- do not require an unacceptable sacrifice in another protected dimension.

It is not a popularity list and not a synonym for the newest industry trend. A fashionable technique may be inapplicable, too costly, nondeterministic, unmaintainable, or unsupported by the project’s scale and operating constraints.

## 10.2 Methodological Opportunity

A **Methodological Opportunity** exists when the current implementation performs its intended function, but a different applicable method family may produce a materially better protected outcome.

A methodological opportunity is a hypothesis, not a verdict. It records:

- intent and problem class;
- current method and its limitations;
- candidate method family;
- evidence sources and freshness;
- applicability assumptions;
- expected gains and costs;
- proposed experiment;
- confidence and disconfirming conditions.

The system must be able to conclude that the current simpler method remains preferable.

## 10.3 Knowledge provenance and freshness

Method intelligence must preserve:

- source identity;
- publication or release date;
- scope and target conditions;
- evidence type;
- known limitations;
- compatibility constraints;
- review freshness;
- conflicting sources.

A method-landscape snapshot is bound to an assessment cycle. New research, new libraries, new hardware, or a materially stronger AI model can invalidate an earlier frontier conclusion and reopen equilibrium.

---

# 11. Universal and polyglot project recognition

RPI is project-oriented, not language-oriented. A real repository may contain TypeScript, JavaScript, Python, WGSL, SQL, PowerShell, Rust, configuration, schemas, markup, assets, build files, tests, generated artifacts, and runtime protocols.

Universality requires two simultaneous truths:

1. every artifact is understood according to the native semantics of its environment;
2. the complete project is understood across environment boundaries.

## 11.1 Environment

An **Environment** is a language, runtime, execution substrate, data system, build system, deployment platform, or governed artifact family that has distinct semantics and validation rules.

Examples:

```text
TypeScript / JavaScript runtime
Python runtime
WGSL / WebGPU shader environment
SQL database engine
PowerShell host
HTML / CSS / DOM
JSON / YAML / schema configuration
Docker / container build
Windows / Linux / browser / GPU platform profile
```

## 11.2 Environment adapter

Each environment is integrated through a versioned adapter that declares its actual capability:

```yaml
environment_id: ENV-WGSL
adapter_version: 1.0
supports:
  identification: FULL
  parsing: FULL
  symbol_resolution: PARTIAL
  data_flow: PARTIAL
  native_metrics: FULL
  patch_generation: GUARDED
  benchmark_generation: PARTIAL
  validation: FULL
confidence:
  syntax: 0.99
  semantics: 0.84
  optimization: 0.73
limitations: []
```

An adapter must not claim the same depth for a compiler-resolved TypeScript project and a heuristically scanned unknown DSL. Unsupported or partial recognition remains visible and reduces the evidence envelope.

## 11.3 Universal Project Representation

Native parsers produce different abstract syntax trees. RPI therefore requires a **Universal Project Representation**, abbreviated **UPR**, above those native structures.

The UPR represents:

- artifacts and environments;
- units and source anchors;
- purpose and capability;
- problem class and current method;
- calls, data flow, control flow, resource flow, ownership, and lifecycle;
- contracts and schemas;
- runtime observations;
- cross-environment transformations;
- evidence and confidence.

The UPR does not erase native semantics. It links every universal record back to the native adapter evidence that supports it.

## 11.4 Three mandatory analysis passes

An RPI engine performs distinct passes:

### Environment-native pass

Each environment is assessed with its own rules, tools, benchmarks, and method knowledge.

### Capability pass

Files and units from any number of environments are grouped by the capability they jointly implement. The object of judgment is the outcome, not the file extension.

### Cross-environment pass

The engine evaluates boundaries and responsibility placement, including:

- type and schema compatibility;
- unit and precision consistency;
- serialization and transformation cost;
- buffer layout and alignment;
- copying and transfer frequency;
- duplicated logic;
- ownership and lifecycle mismatch;
- error and cancellation propagation;
- version skew;
- computations placed in the wrong environment;
- manual change-propagation risk.

A fourth, separate **cross-platform pass** evaluates operating systems, browsers, devices, GPU vendors, architectures, and deployment profiles. Cross-environment and cross-platform are related but not interchangeable.

## 11.5 Cross-environment impedance

**Cross-environment impedance** is the friction created when collaborating environments use different type systems, memory models, concurrency models, units, lifecycle rules, error models, or representations.

RPI does not require all impedance to be removed. It requires the cost, risk, and necessity of the boundary to be understood and evaluated against alternatives.

---

# 12. Value, cost, and the improvement horizon

RPI converts current expenditure into persistent project value:

```text
AI tokens + compute + engineering + validation + risk
  → verified change
  → repeated future benefit or assurance
```

The immediate cost and the lifetime value may be separated by years and billions of executions.

A value model may use:

```text
Expected Lifetime Value
  = sum(discounted operational savings)
  + avoided expected loss
  + option value
  + capability value
  + assurance value
  - search cost
  - implementation cost
  - validation cost
  - expected change risk
```

A small saving per operation may justify a large one-time investigation when the operation is repeated at scale. Conversely, a numerically positive micro-optimization may remain irrational when its maintenance and verification burden exceeds its lifetime value.

## 12.1 Improvement for return

The candidate is justified because expected economic value exceeds total improvement cost.

## 12.2 Improvement for assurance

The candidate is justified by reliability, safety, security, compliance, auditability, predictability, or mission confidence even when direct financial return cannot be estimated reliably.

Mandatory assurance gates are not traded away because a weighted financial score looks positive.

## 12.3 Value horizon

Every consequential improvement states the horizon over which value is expected:

```text
single execution
single release
deployment fleet
contract or product lifetime
risk/assurance horizon
strategic option horizon
```

Forecast value and realized value remain separate. The Great Book may update realized value as operational evidence accumulates.

---

# 13. Multi-objective improvement

RPI does not assume a single optimum. A candidate may improve one property and worsen another.

The canonical result is a vector:

```text
Δ performance
Δ memory
Δ reliability
Δ security
Δ maintainability
Δ human outcome
Δ cost
Δ uncertainty
```

Acceptance uses:

- mandatory gates;
- non-inferiority limits;
- explicit trade-off policy;
- Pareto comparison;
- project-specific priorities;
- human authority for irreducible mission choices.

A composite score may assist navigation, but it may not hide its components or possess verdict authority by itself.

---

# 14. RPI cycle

A complete RPI cycle is:

```text
1. Register the Target Program and freeze mission, intent source, repository/content state,
   environment, adapters, model/tool policy, measurement catalogue, risk, budget, value,
   version/publication policy, and Master Benchmark definition.
2. Validate, hash, snapshot, and lock the project-intent input and Master Benchmark input.
3. Compile or reuse the structured Project Intent Model and executable Master Benchmark Specification.
4. Execute or validly reuse the opening Master Benchmark and record whole-project vital signs,
   coverage, anomalies, blind spots, and candidate seeds.
5. Inventory every relevant artifact and environment.
6. Perform environment-native recognition and diagnostics.
7. Build or refresh the Universal Project Representation.
8. Recover intent, capabilities, problem classes, current methods, and cross-environment contracts.
9. Screen the complete measurement catalogue and deeply assess applicable measures.
10. Retrieve and filter the Applicable Solution Frontier where relevant.
11. Form, deduplicate, and rank evidence-linked implementation or methodological hypotheses.
12. Select one candidate under value, risk, reversibility, proof-readiness, and resource policy.
13. Design, validate, and freeze the candidate-specific proof contract and instruments.
14. Capture or reuse a valid baseline.
15. Create an isolated, version-pinned candidate state and classify every changed surface.
16. Implement the smallest safe causal change.
17. Execute deterministic build, tests, scenarios, candidate benchmark, and applicable guardrails.
18. Preserve raw evidence and create a deterministic evidence digest.
19. Interpret the evidence, enforce mandatory gates, and issue an admissible terminal disposition.
20. Seal, publish, land, and post-land verify only the exact accepted candidate under custody policy.
21. Record accepted, rejected, invalid, deferred, and negative knowledge in durable memory.
22. Re-recognize the accepted state and continue candidate work until the cycle search policy closes.
23. Collect durable benchmark contributions and build objective/capability/architecture coverage.
24. Propose, critique, validate, consolidate, prune, or revise the Master Benchmark.
25. Version the accepted benchmark and preserve comparability or bridge-run evidence.
26. Execute the final Master Benchmark against the complete accepted project snapshot.
27. Assess whole-project vital signs, coverage, anomalies, blind spots, and candidate seeds.
28. Produce next-cycle vital input.
29. Start another cycle when supported work remains; otherwise perform challenge passes and
   establish or refuse bounded equilibrium.
```

A cycle may complete without a patch. Reduced uncertainty, a refuted hypothesis, a validated current method, better instrumentation, benchmark pruning, or a reasoned decision not to spend further resources is terminal knowledge.

---

# 15. Equilibrium

RPI equilibrium is bounded. It never means that the project is objectively perfect.

A project is in RPI equilibrium only relative to:

```text
Project State
× Protected Mission and Capabilities
× Measurement Catalogue
× Project Intent Model
× Master Benchmark Version, Coverage, and Stability
× Environment Coverage
× Applicable Solution Frontier Snapshot
× AI and Tool Capability
× Evidence Standard
× Risk Policy
× Budget and Value Horizon
```

RPI distinguishes:

## 15.1 Evidence equilibrium

No further claim can be admitted because current instruments or evidence are insufficient. The correct next action may be better instrumentation rather than another patch.

## 15.2 Capability equilibrium

The current AI, tools, adapters, and method knowledge cannot discover and prove another acceptable improvement.

## 15.3 Economic equilibrium

The expected marginal value of further search is below its expected total cost under the active value policy.

## 15.4 Assurance equilibrium

The required assurance envelope has been met and further assurance work is below policy priority, not because all risk has disappeared.

## 15.5 Environment equilibrium

Each native environment, each capability slice, each material cross-environment boundary, and each required platform profile has reached its own declared terminal state or explicit residual-unknown state.

A global equilibrium certificate is invalid when a required environment was unsupported or a material cross-environment boundary was never assessed.

## 15.6 Observation and benchmark equilibrium

Every critical objective has an admissible evidence path; the Master Benchmark is representative, stable, discriminating, and bounded in execution cost; no valuable enrichment remains at acceptable cost; repeated closing runs are valid; and the latest closing assessment reveals no unresolved evidence-supported candidate. A large benchmark is not automatically mature.

Equilibrium is reopened by:

- source or dependency change;
- mission or capability change;
- new operating environment;
- new evidence;
- a new, materially improved, or invalidated Master Benchmark;
- changed cost or value horizon;
- a materially stronger AI model;
- a changed Applicable Solution Frontier;
- an adapter upgrade that increases recognition depth;
- a regression or production incident.
- a required repository or remote version becoming unavailable, divergent, rewritten, or stale;
- a required remote check or publication guarantee changing state.

---

# 16. Memory and negative knowledge

RPI must remember not only accepted improvements, but also:

- rejected candidates;
- invalid experiments;
- hypotheses disproved by evidence;
- methods considered and found inapplicable;
- benchmark weaknesses;
- context gaps;
- human preference results;
- cost estimates and realized value;
- conditions under which an old conclusion should be revisited.

This prevents repeated token expenditure on the same failed idea and allows a future model or changed environment to reopen the idea for a reason rather than by amnesia.

---

# 17. Governance and custody

RPI requires a separation between reasoning, proof, and canonical write authority.

A conformant engine must ensure:

- candidate generation cannot silently redefine the protected mission;
- the evaluator cannot modify the judge of the same experiment after seeing results;
- the benchmark author does not receive automatic authority to declare its own instrument valid;
- canonical writes occur only after a valid verdict and policy gates;
- every landing is receipted and reversible where technically possible;
- post-land verification is mandatory;
- policy and proof-contract versions are immutable for the judged comparison;
- the operator can stop the system without destroying durable state;
- secrets and untrusted project text cannot broaden tool authority.

---

# 18. Versioned project state and remote durability

RPI requires exact identity and recoverable transition of project states, but it does not mandate Git or any one hosting provider. A conforming implementation may use Git, another version-control system, content-addressed snapshots, immutable images, or an equivalent mechanism.

When a project is version-controlled, the implementation must preserve these distinctions:

```text
local modification       ≠ versioned change
versioned change         ≠ proved improvement
published change         ≠ accepted change
review approval          ≠ RPI verdict
remote merge             ≠ post-integration verification
```

The implementation must be able to determine:

- the exact baseline bytes and version-graph position;
- the exact candidate bytes and complete change set;
- which changes belong to the candidate, proof instrument, regression protection, generated output, or incidental mutation;
- the isolated change line on which the experiment was executed;
- the canonical state transition and reversal path;
- whether a remote or cloud publication represents the same candidate that was proved;
- whether later divergence invalidates landing readiness or an equilibrium claim.

Remote publication is valuable for durability, collaboration, independent checks, and continuation on another machine. It remains a transport and evidence surface. The RPI event, artifact, proof, and verdict records retain their own durable identities and must be verifiable even when a hosting provider is unavailable.

A version-control-specific implementation profile may add branch, commit, review, CI, signing, retention, and remote-security rules. CLU-E uses the Git profile defined in `CLUE_Git_Integration_v9.md`.

---

# 19. Failure modes RPI must resist

A conformant implementation explicitly guards against:

- optimizing accidental behavior instead of intent;
- reducing required workload to improve a metric;
- benchmark overfitting;
- changing the threshold after results;
- selecting a fashionable but inapplicable method;
- measuring one environment while ignoring boundary cost;
- treating scan completion as semantic understanding;
- comparing different builds, seeds, workloads, or environments;
- accepting a mean improvement that worsens tail behavior;
- hiding a regression through aggregation;
- fabricating a number for a qualitative outcome;
- letting a human preference result masquerade as universal truth;
- treating a model’s confidence as evidence;
- repeating a failed hypothesis without changed conditions;
- calculating short-term cost while ignoring lifetime scale;
- monetizing a mandatory safety or correctness gate;
- declaring equilibrium with unsupported artifacts or unresolved material boundaries.
- using the Creator’s active working tree as an uncontrolled experiment surface;
- treating a commit, push, review approval, or green remote pipeline as proof by itself;
- preserving a verdict after rebasing, merging, or otherwise changing the proved candidate;
- allowing remote divergence, history rewrite, or missing version objects to remain silent;
- publishing unclassified evidence or credentials to a remote.

---

# 20. RPI conformance levels

## 20.1 RPI-L1 — Controlled iterative improvement

Required:

- explicit baseline and candidate;
- frozen claim and acceptance rule;
- isolated change;
- admissible local evidence;
- regression guardrails;
- durable verdict and reversal path.
- exact version-state identity or equivalent reproducible state identity.

## 20.2 RPI-L2 — Project-capability improvement

Adds:

- purpose and capability records;
- Master Benchmark or capability benchmarks;
- persistent experiment memory;
- multi-objective gates;
- repeated cycles and bounded equilibrium.

## 20.3 RPI-L3 — Universal polyglot improvement

Adds:

- versioned environment adapters;
- Universal Project Representation;
- environment-native, capability, and cross-environment passes;
- explicit unsupported-surface coverage;
- cross-platform evidence envelopes.

## 20.4 RPI-L4 — Method-intelligent improvement

Adds:

- problem-class and current-method recognition;
- provenance-bound Applicable Solution Frontier;
- methodological opportunities;
- benchmark synthesis and independent instrument review;
- knowledge-freshness invalidation.

## 20.5 RPI-L5 — Economically and epistemically governed improvement

Adds:

- value-horizon accounting;
- forecast versus realized value;
- token, compute, validation, and risk yield;
- economic, capability, evidence, assurance, and environment equilibrium;
- self-assessment without privileged proof.
- governed remote durability, review, and external-check integration when required by the project profile.

CLU-E is designed to implement RPI-L5. Its current runtime may be at a lower conformance level until the required components are built and verified.

---

# 21. Minimal canonical records

A conformant implementation must be able to reconstruct at least:

```text
Target Registration
Version-State / Repository Registration when applicable
Assessment Envelope
Artifact and Environment Inventory
Adapter Capability and Coverage
Universal Project Representation Snapshot
Purpose and Capability Records
Problem-Class and Current-Method Records
Applicable Solution Frontier Snapshot
Finding or Methodological Opportunity
Improvement Claim
Proof Contract
Proof Instrument Definition
Baseline and Candidate Runs
Isolated Change-Line / Worktree Record when applicable
Complete Change-Set Classification
Version Commit and Publication Receipts when applicable
Native Evidence
Protective Gate Results
Verdict
Landing and Reversal Receipt
Great Book Record
Value Forecast and Realization Record
Equilibrium or Invalidation Record
```

The exact storage technology is implementation-specific. Durable identity, provenance, replayability, and truth boundaries are not.

---

# 22. Final definition

> **Recursive Project Improvement is an externally driven, evidence-gated method that repeatedly converts bounded AI reasoning and computation into measurable, persistent improvement of a protected project. It recognizes the project in every native environment and across their boundaries, reconstructs intent and current method, compares the method with the applicable solution frontier, binds each experiment to an exact and isolated project state, designs and freezes the evidence needed to test a causal claim, accepts only changes that improve the protected outcome without unacceptable regression, preserves version, publication, reversal, and evidence provenance, records both positive and negative knowledge, and repeats until the current evidence, capability, assurance, environment, or economic frontier is exhausted.**

For CLU-E:

```text
RPI defines what disciplined recursive project improvement is.
CLU-E makes that discipline durable, executable, inspectable, and safe.
```
