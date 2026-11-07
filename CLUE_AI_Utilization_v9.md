# CLU-E AI Utilization and Reasoning Architecture

**Document status:** permanent normative AI architecture and governance contract  
**Revision:** 9.2 (pack release 9.0). Revision 2.0 content was preserved at the v9 re-baseline. ADR-0017 established the operational OpenAI provider boundary. ADR-0020 proposes its successor model identity for Creator ratification.  
**Language:** English  
**Document purpose:** Define where artificial intelligence belongs in CLU-E, where it does not belong, and how CLU-E uses approved reasoning models throughout RPI without wasting tokens, weakening evidence quality, or turning model output into an unauditable source of truth.  
**Normative companions:** `CLUE_Constitution_v9.md`, `CLUE_Architecture_v9.md`, `CLUE_Execution_Model_v9.md`, `CLUE_Canonical_Measurement_Catalogue_v9.md`, and `CLUE_Status_Contract_v9.md`

**Target system:** CLU-E — an evidence-gated, Git-integrated, iterative project-improvement platform operating over a selected local repository, dedicated project metrics, native development tools, Chrome-based runtime tests, benchmarks, and immutable evidence.

**Scope:** AI responsibility, context, routing, token economy, caching, auditability, privacy, semantic enrichment, candidate reasoning, and AI governance of project intent and the Master Benchmark.  
**Intentionally out of scope:** current implementation status and file-by-file backlog.

---

# 1. Executive conclusion

CLU-E should use AI extensively, but selectively.

The project should not attempt to replace parsers, compilers, test runners, profilers, Git, browsers, databases, or numerical calculations with language-model reasoning. Those tools produce direct, reproducible facts more cheaply and more reliably than AI.

AI should be applied where CLU-E must interpret meaning, reason across heterogeneous evidence, generate hypotheses, design experiments, create controlled changes, compare trade-offs, and decide whether available evidence supports an improvement.

The fundamental architecture should therefore be:

```text
Deterministic project facts
        ↓
Compact evidence and context packets
        ↓
AI semantic reasoning
        ↓
Executable plans and structured hypotheses
        ↓
Deterministic execution and measurement
        ↓
Compact result evidence
        ↓
AI interpretation and cross-metric assessment
        ↓
Deterministic acceptance gates and Git authority
```

The most important token-efficiency policy is:

> Every target should be considered against the complete metric catalogue at the applicability level, but only the relevant metrics should receive deep AI assessment.

CLU-E should therefore avoid both extremes:

- **Too little AI:** using AI only as a patch generator would leave most of its reasoning power unused.
- **AI everywhere:** sending every file, symbol, metric, log, and project document to a model repeatedly would be expensive, slow, noisy, and less reliable.

The correct approach is a progressive reasoning funnel. Deterministic mechanisms remove irrelevant work first. Small or economical models perform classification and routing. Strong reasoning models receive only the context required for high-value decisions. All reusable interpretation is persisted, content-addressed, and invalidated only when its underlying evidence changes.

This allows CLU-E to use powerful AI in every segment where it creates real value while preserving scalability across large, polyglot repositories and repeated improvement cycles.

---

# 2. Deterministic recognition is the permanent foundation

CLU-E recognition begins with deterministic project facts. This is an architectural rule, not a temporary limitation. The system discovers repository files, classifies formats and environments, parses source through native adapters, identifies declarations, extracts symbols, resolves provable imports or references, builds structural relationships, records diagnostics, and persists exact events and artifacts without requiring AI.

That capability is called:

```text
Deterministic structural recognition
```

It establishes facts such as file existence, path, hash, language/environment, declarations, signatures, compiler diagnostics, provable dependencies, snapshot changes, and observed runtime paths.

AI is added **after** deterministic recognition to infer human-level meaning: responsibility, purpose, semantic membership, documentation alignment, ambiguity, method adequacy, imperfection hypotheses, benchmark design, and evidence interpretation. AI enrichment never replaces the physical inventory or native facts.

```text
Repository
  → deterministic inventory and native recognition
  → Universal Project Representation
  → AI semantic enrichment
  → metric applicability
  → evidence-linked hypotheses
  → controlled experiments and patches
```

This separation is required for accuracy, auditability, privacy, token efficiency, replay, and Q1 truth. ALL remains physical and deterministic; DIVE may display AI semantic claims with confidence and provenance.

---

# 3. Why token efficiency is a core architectural requirement

Token efficiency is not merely a cost-saving feature. It is required for CLU-E to achieve its intended purpose.

## 3.1 CLU-E is an iterative system

A conventional coding assistant may answer one question or generate one patch. CLU-E repeatedly performs recognition, diagnosis, hypothesis generation, testing, evaluation, and re-recognition until equilibrium is reached.

A wasteful prompt design is therefore multiplied across:

- thousands of files;
- tens of thousands of symbols;
- many project metrics;
- several candidate patches per imperfection;
- repeated benchmark runs;
- repeated improvement passes;
- several languages and execution environments;
- project history and Git branches.

A prompt that is merely inefficient once becomes prohibitive when executed thousands of times.

## 3.2 Large contexts can reduce reasoning quality

Providing more tokens does not automatically produce better conclusions. Irrelevant files, non-applicable metrics, repeated documentation, unfiltered logs, and distant dependencies can distract the model from the actual decision.

CLU-E should seek the **smallest context that remains evidentially complete for the current question**.

A compact, well-structured context packet containing the target, its role, relevant dependencies, applicable metrics, baseline evidence, and constraints is generally more useful than an undifferentiated repository dump.

## 3.3 Strong models should be reserved for strong decisions

The most capable models should be used for work such as:

- difficult architectural interpretation;
- benchmark design;
- complex patch planning;
- cross-metric trade-off reasoning;
- high-risk change assessment;
- final equilibrium adjudication.

They should not spend most of their capacity determining that a shader-frame-time metric does not apply to a Markdown file.

## 3.4 Efficiency increases total scientific search

Every token not wasted on repeated context can be used to:

- evaluate another candidate;
- design a stronger benchmark;
- inspect an uncertain subsystem;
- generate an alternative patch;
- challenge a previous conclusion;
- perform an independent adjudication;
- search further before declaring equilibrium.

The objective is not to minimize AI usage. The objective is to maximize **useful AI reasoning per unit of cost, latency, and context**.

## 3.5 Reproducibility requires bounded inputs

An AI decision is easier to audit when its input packet is explicit, versioned, hashed, and limited to known evidence. Repeatedly supplying a changing, oversized repository context makes it difficult to understand why a conclusion was reached or which facts influenced it.

## 3.6 Polyglot support increases the need for routing

CLU-E is intended to support many programming languages and environments. Each environment has different facts, tools, metrics, and proof methods. Token-efficient routing ensures that a SQL query is assessed with database evidence, a WGSL shader with GPU evidence, and a PowerShell script with execution-policy and shell evidence rather than with a universal but largely irrelevant prompt.

## 3.7 Equilibrium cannot be affordable without reuse

Equilibrium requires multiple complete passes and deliberate attempts to find remaining improvements. If every pass re-summarizes every unchanged file and re-reads every unchanged metric definition, the cost grows without adding knowledge.

CLU-E must remember verified project understanding as versioned artifacts and revisit it only when relevant inputs change.

---

# 4. Foundational division of responsibility

CLU-E should separate four layers of authority.

## 4.1 Deterministic fact layer

This layer establishes observable project truth.

Typical responsibilities include:

- repository inventory;
- file hashing and snapshots;
- language and environment detection;
- AST and compiler-based extraction;
- symbol identity and references;
- dependency graphs;
- build and test execution;
- browser automation;
- profiler and benchmark collection;
- numerical aggregation and statistics;
- Git branch, commit, diff, and rollback operations;
- event-chain and artifact integrity;
- acceptance-gate execution.

AI must not be allowed to overwrite facts produced by this layer.

## 4.2 Semantic reasoning layer

This layer interprets project facts.

Typical responsibilities include:

- purpose and responsibility inference;
- domain, subsystem, and module assignment;
- documentation alignment;
- metric applicability reasoning;
- imperfection discovery;
- risk identification;
- hypothesis formation;
- benchmark and test design;
- patch planning and generation;
- root-cause analysis;
- result interpretation;
- equilibrium reasoning.

AI outputs from this layer are claims, hypotheses, classifications, or plans. They are not automatically facts.

## 4.3 Evidence evaluation layer

This layer combines deterministic measurements and AI interpretation.

It answers questions such as:

- Did the benchmark test the intended hypothesis?
- Is the observed change meaningful?
- Is the result reproducible?
- Did another applicable metric regress?
- Is the evidence sufficient for a decision?
- Did the patch improve the local target but damage the broader system?

AI can reason here, but final acceptance must still respect deterministic gates.

## 4.4 Authority layer

This layer controls what CLU-E is allowed to change and land.

It must remain deterministic and policy-bound.

It should enforce:

- branch and workspace isolation;
- allowed file scopes;
- required test suites;
- mandatory metric gates;
- maximum risk or change budgets;
- valid task leases;
- required human approvals where configured;
- commit and landing rules;
- rollback conditions.

AI may recommend an action. It must not silently grant itself authority.

---

# 5. Core AI utilization principles

## Principle 1 — Use deterministic tools wherever the answer can be established exactly

Do not use tokens to count files, calculate percentiles, resolve a compiler error that the compiler already explains, compute a hash, compare numeric benchmark values, or determine whether a test process exited successfully.

## Principle 2 — AI interprets evidence; it does not manufacture evidence

Every meaningful AI conclusion should reference the artifacts, symbols, metrics, requirements, test runs, or benchmark runs that support it.

## Principle 3 — Consider all metrics, deeply assess only relevant metrics

CLU-E should never ignore a metric merely because it was omitted from a prompt. The complete metric catalogue should be screened systematically. However, screening does not require full reasoning over the complete metric specification for every target.

## Principle 4 — Reuse unchanged understanding

Semantic summaries, applicability maps, architectural assignments, documentation alignments, and evidence digests should be cached against content hashes and dependency versions.

## Principle 5 — Escalate model strength with decision value and uncertainty

Classification should use an economical model or deterministic rules. High-impact architectural changes should use stronger reasoning and, when justified, independent adjudication.

## Principle 6 — Send deltas, not the entire project

After onboarding, AI should receive changed entities and the minimum affected context. Unchanged project knowledge should be referenced by stable identifiers or compact summaries.

## Principle 7 — Preserve uncertainty

AI must be able to return `unknown`, `insufficient evidence`, `conditionally applicable`, or `requires runtime observation`. Forced certainty wastes tokens and creates false confidence.

## Principle 8 — Structured output precedes prose

AI outputs should conform to machine-validated schemas. Human-readable explanations can be generated from those records, but prose should not be the sole system interface.

## Principle 9 — Every AI invocation has a budget and purpose

An invocation should declare:

- task type;
- target scope;
- maximum context class;
- selected model tier;
- expected output schema;
- token budget;
- retry policy;
- cache policy;
- required evidence references.

## Principle 10 — Token usage is itself a CLU-E self-measure

CLU-E should track useful reasoning yield, cache-hit rate, tokens per accepted improvement, tokens per rejected hypothesis, and tokens spent on non-applicable analysis.

## Principle 11 — Project intent is a versioned AI input, not assumed context

The configured `target description.md` is the authoritative human-provided statement of project purpose, objectives, priorities, and constraints. CLU-E should compile it into a reusable Project Intent Model, retrieve only relevant objective fragments for ordinary AI calls, and never confuse declared intent with proof that the implementation satisfies it.

## Principle 12 — Candidate proof and project-wide observation are separate

Candidate-specific benchmarks prove or reject individual improvements. The configured `benchmark.txt` is the evolving Master Benchmark for the complete accepted project. It should retain durable measurement lessons from completed work without replaying every historical A/B experiment.

## Principle 13 — Every cycle improves observation as well as implementation

Every completed RPI cycle must perform a Master Benchmark enrichment review and finish with a deterministic Master Benchmark run. The resulting project-wide vital signs, coverage gaps, anomalies, and candidate seeds become first-class input to the next cycle. Enrichment review is mandatory; uncontrolled benchmark growth is not.

---

# 6. AI activity map across the RPI lifecycle

The following sections define where AI should be used, what it should receive, what it should produce, and how token usage should be controlled.

## 6.1 Semantic enrichment

### Purpose

Translate deterministic structure into proposed human-level meaning.

### AI activities

- infer primary and secondary responsibilities;
- assign domain, subsystem, module, and capability memberships;
- identify architectural roles such as adapter, orchestrator, repository, renderer, validator, or boundary component;
- infer likely side effects and state ownership;
- detect responsibility overlap;
- identify symbols whose names do not match their behavior;
- explain how one file can contribute to several logical modules.

### Required deterministic input

- target symbol or file summary;
- declarations and signatures;
- selected implementation fragments;
- imports, exports, calls, and references;
- relevant comments and documentation;
- immediate runtime observations where available;
- existing architectural taxonomy.

### Structured output

```json
{
  "entityId": "...",
  "primaryResponsibility": "...",
  "secondaryResponsibilities": ["..."],
  "domainMemberships": [
    {"domainId": "...", "confidence": 0.91, "evidenceRefs": ["..."]}
  ],
  "moduleMemberships": [
    {"moduleId": "...", "confidence": 0.84, "evidenceRefs": ["..."]}
  ],
  "uncertainties": ["..."],
  "requiresReview": false
}
```

### Token-efficiency policy

- enrich at symbol-group or responsibility level, not one trivial symbol at a time;
- reuse file and module summaries across related symbols;
- process unchanged entities only when their dependencies, documentation, or taxonomy changes;
- use strong models only for ambiguous, cross-domain, or high-impact entities;
- avoid sending complete files when signatures, selected bodies, call relations, and summaries are sufficient.

### Q1 integration

- **ALL mode remains deterministic.** AI does not decide whether a file exists or which physical repository group contains it.
- **DIVE mode may display semantic enrichment.** AI-derived domains, modules, responsibilities, and multiple memberships should carry confidence and provenance.
- AI assignments should be visibly distinguishable from deterministic relationships and manually confirmed architecture.

---

## 6.2 Ambiguity resolution

### Purpose

Resolve cases that deterministic language analysis cannot classify confidently.

### Examples

- dynamic imports;
- reflection;
- dependency injection;
- framework conventions;
- configuration-driven behavior;
- generated code boundaries;
- one file serving several modules;
- aliases and misleading names;
- runtime-only relationships.

### Token-efficiency policy

AI should receive only the unresolved relationship, its local evidence neighborhood, and the relevant framework rules. It should not receive the full repository unless the ambiguity is genuinely project-wide.

The output must preserve alternative interpretations when evidence is incomplete.

---

## 6.3 Documentation-to-implementation alignment

### Purpose

Determine whether project documentation, architecture descriptions, requirements, and current implementation agree.

### AI activities

- map documented capabilities to implementation entities;
- find documented features with no implementation evidence;
- find implementation behavior with no documented architectural home;
- identify conflicting terminology;
- detect obsolete documentation;
- distinguish aspirational design from implemented state;
- propose documentation updates or implementation work items.

### Token-efficiency policy

- documentation should be chunked into stable, addressable claims;
- implementation should be represented through semantic summaries and evidence references;
- compare claim-to-implementation mappings incrementally;
- rerun only mappings affected by changed documentation or changed implementation entities;
- avoid repeatedly sending the entire documentation pack.

---

## 6.4 Metric applicability assessment

### Purpose

Determine which metrics are relevant to a target, candidate, or affected scope.

This is the key mechanism that allows CLU-E to consider the complete metric system without paying for deep evaluation against every metric.

### Applicability states

Each target-metric pair should produce one of:

- `applicable`;
- `conditionally_applicable`;
- `not_applicable`;
- `unknown`;
- `global_gate`;
- `periodic_global_measure`.

### Deterministic prefilter

The metric catalogue should contain machine-readable metadata such as:

- supported entity types;
- supported languages and environments;
- required evidence types;
- required runtime instruments;
- architectural scopes;
- change-impact categories;
- exclusions;
- cost class;
- mandatory-gate status;
- minimum recognition confidence;
- dependencies on other metrics.

This metadata can eliminate most irrelevant pairings without AI.

### AI applicability review

AI should review only:

- ambiguous cases;
- semantic metrics that cannot be selected from syntax alone;
- targets with multiple responsibilities;
- candidates whose side effects broaden the affected scope;
- new or changed metrics with insufficient deterministic rules.

### Recommended policy

> Every target is screened against every metric identifier and its compact applicability metadata. Only selected metrics receive their full definitions and deep assessment instructions.

This preserves complete coverage without a combinatorial token explosion.

---

## 6.5 Imperfection discovery

### Purpose

Identify evidence-supported opportunities for improvement.

### AI activities

- analyze applicable metric results;
- detect contradictions between design intent and implementation;
- identify duplication, unclear responsibilities, weak boundaries, obsolete abstractions, performance opportunities, missing validation, insufficient evidence, or risky behavior;
- distinguish defects from legitimate trade-offs;
- produce explicit hypotheses rather than vague criticism.

### Required output

Each proposed imperfection should include:

- target scope;
- observed evidence;
- applicable metric references;
- claimed deficiency;
- uncertainty;
- possible consequences;
- proposed improvement direction;
- expected evidence needed to verify it;
- estimated risk and cost.

### Token-efficiency policy

- perform cheap static and metric anomaly detection before asking AI to search broadly;
- prioritize hotspots, changed areas, low-confidence areas, failed gates, and architecture/documentation mismatches;
- use AI to explain and connect anomalies rather than rediscover raw facts;
- deduplicate semantically equivalent hypotheses before deeper work.

---

## 6.6 Candidate prioritization

### Purpose

Select which imperfection should consume benchmark, patch, and test resources.

### AI activities

- estimate likely value;
- assess uncertainty;
- compare risk and reversibility;
- identify required environments and evidence cost;
- determine affected scope;
- identify dependencies between candidates;
- avoid candidates that merely shift complexity.

### Token-efficiency policy

Use compact hypothesis cards rather than source code. Strong-model reasoning is justified only for the highest-value or most ambiguous candidates.

The prioritization engine should combine AI reasoning with deterministic scores and project policy. AI should not silently override mandatory priorities or risk limits.

---

## 6.7 Benchmark and experiment design

### Purpose

Design a valid way to prove or reject an improvement hypothesis.

This is one of the highest-value AI uses in CLU-E.

### AI activities

- define the baseline scenario;
- select representative inputs;
- identify confounding variables;
- select warm-up and repetition requirements;
- define target measurements and regression measurements;
- define success thresholds;
- select browser, compiler, profiler, database, or test instruments;
- identify acceptance gates;
- define invalid-run conditions;
- specify rollback conditions.

### Deterministic responsibilities

- run the benchmark;
- control the environment where possible;
- calculate statistics;
- record raw evidence;
- compare hashes and configurations;
- detect process failures;
- enforce repetition counts and thresholds.

### Token-efficiency policy

- AI designs the benchmark once per hypothesis version;
- baseline results are reused until invalidated by a relevant project or environment change;
- raw logs are summarized deterministically before AI review;
- only anomalous excerpts and evidence references are sent;
- numeric comparison is calculated locally rather than delegated to the model.

---

## 6.8 Test generation and test-gap analysis

### Purpose

Create evidence where required behavior is not adequately tested.

### AI activities

- identify missing test cases;
- generate unit, integration, browser, visual, property-based, or adversarial tests;
- map tests to requirements, metrics, and candidate risks;
- check whether a test would fail before the patch and pass after it;
- identify tests that only restate implementation details.

### Token-efficiency policy

- provide the test target, public contract, relevant implementation, existing nearby tests, and failure evidence;
- do not provide the complete test suite unless architectural consistency requires it;
- reuse test-style summaries and framework conventions;
- use deterministic coverage and mutation data to focus AI on real gaps.

---

## 6.9 Patch planning and generation

### Purpose

Produce a controlled candidate transformation.

### AI activities

- plan the smallest evidence-relevant change;
- identify impacted symbols and files;
- propose alternatives;
- generate a patch;
- explain expected metric effects;
- identify risks and required tests;
- respect one-file-at-a-time policy where configured;
- separate implementation, test, and documentation changes.

### Token-efficiency policy

- send only the target file sections, necessary interfaces, call-site summaries, project coding rules, and applicable constraints;
- avoid sending unrelated repository content;
- patch by diff rather than regenerating whole files where safe;
- use stronger models for architectural or cross-language changes;
- cache project conventions and inject them as concise rules;
- terminate retries when evidence shows the hypothesis is wrong rather than repeatedly regenerating code.

---

## 6.10 Execution-result interpretation

### Purpose

Interpret compiler diagnostics, test failures, browser behavior, profiler results, screenshots, runtime traces, and benchmark outputs.

### AI activities

- diagnose likely root causes;
- separate patch failures from environment failures;
- identify invalid benchmark runs;
- connect failures to affected architecture;
- recommend the next evidence-producing action;
- summarize large result sets.

### Token-efficiency policy

- preprocess results into structured digests;
- collapse repeated stack traces and duplicate diagnostics;
- send only representative log excerpts;
- perform numeric aggregation locally;
- use screenshot or visual reasoning only when deterministic pixel, layout, or accessibility checks are insufficient;
- preserve links to full raw artifacts rather than embedding them in every prompt.

---

## 6.11 Candidate assessment against metrics

### Purpose

Determine whether the patch produced a genuine improvement.

### Required evaluation scope

A candidate should be assessed against:

1. the metrics directly targeted by the hypothesis;
2. all metrics determined to be applicable to the changed entities;
3. metrics applicable to affected callers, consumers, or runtime paths;
4. mandatory project gates;
5. selected subsystem regression metrics;
6. periodic project-wide metrics when the change is broad enough to require them.

### AI activities

- interpret whether measured deltas support the hypothesis;
- assess practical significance;
- identify metric trade-offs;
- evaluate evidence quality;
- determine whether the benchmark was valid;
- identify local improvement with global regression;
- produce a reasoned recommendation.

### Deterministic responsibilities

- calculate metric values and deltas;
- enforce hard thresholds;
- fail mandatory gates;
- verify artifact integrity;
- verify branch and snapshot identity;
- reject incomplete evidence packages.

### Token-efficiency policy

AI should receive a result card, not every raw artifact:

```text
Hypothesis
Target and affected scope
Baseline summary
Candidate summary
Metric deltas
Gate results
Evidence quality flags
Anomalies
Relevant excerpts
Links to full artifacts
```

Raw artifacts should be retrieved only when the model identifies a specific unresolved question.

---

## 6.12 Cross-metric trade-off adjudication

### Purpose

Determine whether a candidate is better overall when metrics disagree.

### Example

```text
Frame time: improved by 7.8%
Memory: regressed by 1.4%
Complexity: improved
Startup time: unchanged
Visual correctness: passed
Mandatory gates: passed
Evidence confidence: high
```

AI can reason about the trade-off, but it must follow the project’s metric families and policy. It must not arbitrarily sum incompatible native units or override mandatory acceptance gates.

### Token-efficiency policy

Use strong-model reasoning only after deterministic measurement and applicability selection have reduced the decision to a compact set of meaningful conflicts.

For high-impact changes, CLU-E may request an independent second assessment using the same evidence packet. Disagreement should trigger review rather than an uncontrolled chain of additional agents.

---

## 6.13 Root-cause analysis and recovery

### Purpose

Determine why a candidate, benchmark, test, or recognition stage failed.

### AI activities

- distinguish incorrect patch, incorrect hypothesis, incomplete context, invalid benchmark, flaky test, environmental instability, missing adapter support, or stale evidence;
- propose the cheapest next diagnostic action;
- decide whether to revise, retry, defer, or reject.

### Token-efficiency policy

Use failure clustering and deterministic diagnostics first. AI should analyze one representative failure group at a time rather than the complete output of every failed process.

---

## 6.14 Evidence summarization and decision records

### Purpose

Produce a concise, reconstructible record of what was attempted and why it was accepted or rejected.

### AI activities

- summarize hypothesis, method, evidence, result, uncertainty, and decision;
- explain metric trade-offs;
- create human-readable review material;
- generate documentation updates from structured evidence.

### Token-efficiency policy

Decision records should be generated from stored structured data. The model should not reread the repository to summarize an experiment whose evidence package is already complete.

---

## 6.15 Equilibrium assessment

### Purpose

Determine whether CLU-E has reached a state where no additional evidence-supported improvement is currently available under the selected metrics, constraints, and environment.

### AI activities

- analyze remaining hypotheses and unresolved uncertainty;
- challenge previous classifications;
- inspect low-confidence or weakly measured regions;
- compare architecture, documentation, implementation, tests, and runtime evidence;
- determine whether rejected candidates reveal new search directions;
- distinguish genuine equilibrium from incomplete search coverage.

### Deterministic inputs

- completed pass records;
- coverage by domain, subsystem, module, file, and symbol;
- metric applicability coverage;
- unresolved recognition areas;
- failed and rejected candidates;
- unchanged evidence hashes;
- mandatory gate status;
- project snapshot identity.

### Token-efficiency policy

Equilibrium passes should be hierarchical:

1. reuse stable entity summaries;
2. inspect changed and low-confidence areas first;
3. perform targeted challenge passes;
4. sample apparently stable areas;
5. use the strongest reasoning model for final adjudication only after the evidence space has been compressed.

CLU-E should never spend tokens repeatedly proving that unchanged, high-confidence, already-covered entities remain unchanged when their content and dependencies have identical hashes.

---

# 7. Should CLU-E ask AI to assess a target against all metrics?

The correct answer is: **yes at the screening level, no at the deep-reasoning level.**

## 7.1 Why a naive all-by-all assessment is unacceptable

Assume a project contains:

- 2,000 files;
- 20,000 functions and methods;
- 100 metrics.

A naive function-to-metric matrix contains:

```text
20,000 × 100 = 2,000,000 target-metric pairs
```

If each pair consumed only 300 tokens, the total would already be approximately 600 million tokens, mostly to produce `not applicable` decisions.

That would become even larger when repeated after changes or across multiple improvement passes.

## 7.2 Recommended metric funnel

```text
Complete metric catalogue
        ↓
Deterministic metadata prefilter
        ↓
Cached applicability matrix
        ↓
AI review of ambiguous applicability
        ↓
Deep assessment of selected metrics
        ↓
Candidate-specific affected-scope expansion
        ↓
Mandatory gates and broad regression checks
```

## 7.3 Metric classes

### A. Always-run deterministic gates

Examples:

- syntax and compilation;
- required tests;
- unresolved-reference policy;
- artifact integrity;
- repository cleanliness;
- prohibited dependency policy;
- security constraints;
- branch and lease authority;
- required build outputs.

These generally do not require AI to determine applicability.

### B. Target-selected metrics

Examples:

- GPU frame time;
- memory allocation;
- SQL execution efficiency;
- API compatibility;
- accessibility;
- documentation alignment;
- architectural cohesion;
- shader binding correctness;
- network latency;
- data-integrity behavior.

These require deterministic rules, semantic applicability reasoning, or both.

### C. Periodic global metrics

Examples:

- complete architecture consistency;
- full-project security analysis;
- end-to-end browser regression;
- total repository complexity;
- global documentation alignment;
- dependency health;
- full equilibrium coverage.

These should run after major changes, at milestones, or during equilibrium passes rather than after every trivial patch.

## 7.4 Applicability should be reusable

The target-metric applicability matrix should be cached using keys derived from:

- target content hash;
- target semantic-summary version;
- dependency-neighborhood version;
- metric-definition version;
- language-adapter version;
- project taxonomy version;
- runtime-role version where applicable.

If none of these inputs change, CLU-E should reuse the previous applicability decision.

## 7.5 Conditionally applicable metrics

Some metrics become relevant only when a candidate changes behavior.

For example, an internal function may not initially require API compatibility analysis. If a patch exports it or changes a public type, the metric becomes applicable.

Applicability must therefore be recalculated for the **candidate impact graph**, not only the original target.

---

# 8. Context architecture: what AI should actually receive

CLU-E should never treat the prompt as an improvised text dump. Each invocation should be built from a typed context packet.

## 8.1 Context packet categories

### Identity

- project snapshot ID;
- Git branch and commit;
- target entity IDs;
- language and environment;
- adapter versions;
- AI task type.

### Structural facts

- signatures and declarations;
- selected implementation fragments;
- direct callers and callees;
- imports, exports, and dependencies;
- data or state relationships;
- runtime reachability where known.

### Semantic context

- cached responsibilities;
- domain and module memberships;
- architectural constraints;
- related documentation claims;
- confidence and uncertainty.

### Metric context

- applicable metric cards;
- mandatory gates;
- baseline values;
- target thresholds;
- evidence requirements;
- known trade-off policies.

### Change context

- hypothesis;
- patch or proposed diff;
- affected-scope summary;
- prior attempts;
- known risks.

### Evidence context

- test summaries;
- benchmark summaries;
- diagnostic clusters;
- selected traces or screenshots;
- artifact references;
- environment validity flags.

### Output contract

- required JSON schema;
- allowed decision states;
- required evidence references;
- uncertainty requirements;
- maximum output size.

## 8.2 Context should be layered

Use a retrieval hierarchy:

```text
Level 0: target card
Level 1: immediate symbol/file neighborhood
Level 2: module and responsibility context
Level 3: subsystem context
Level 4: project constitution and global constraints
Level 5: full project evidence, retrieved only when justified
```

Most invocations should remain within Levels 0–2.

## 8.3 Context expansion should be demand-driven

The first invocation may return:

```json
{
  "status": "insufficient_context",
  "requestedEvidence": [
    "caller-summary:entity-123",
    "metric-card:M-044",
    "runtime-trace:scenario-8"
  ]
}
```

CLU-E can then retrieve only the requested evidence rather than preloading every possible artifact.

## 8.4 Use summaries as indexes, not as replacements for evidence

A summary allows efficient routing and reasoning. When a decision depends on a precise implementation detail, CLU-E must provide or retrieve the source evidence.

Summaries should always retain references to their underlying artifacts and hashes.

---

# 9. Hierarchical, content-addressed project memory

Token efficiency depends on CLU-E maintaining its own durable project understanding.

## 9.1 Required summary hierarchy

```text
Project summary
  → domain summaries
    → subsystem summaries
      → module summaries
        → file summaries
          → symbol summaries
```

Each summary should contain:

- entity identity;
- purpose and responsibility;
- public contract;
- dependencies;
- important side effects;
- applicable metric families;
- evidence coverage;
- unresolved uncertainties;
- content and dependency hashes;
- model and prompt version used to create it.

## 9.2 Invalidation rules

A summary should be regenerated only when relevant inputs change, including:

- entity content;
- public interfaces of dependencies;
- documentation claims mapped to the entity;
- project taxonomy;
- language-adapter output;
- metric definitions affecting the summary;
- runtime evidence that contradicts it.

## 9.3 Delta reasoning

After a commit, CLU-E should determine:

- directly changed entities;
- structurally affected entities;
- semantically affected modules;
- invalidated applicability decisions;
- invalidated benchmarks;
- stable knowledge that can be reused.

AI should receive the delta and affected context, not a complete reintroduction to the project.

## 9.4 Manual confirmations

User-confirmed architectural assignments should be retained as high-authority project knowledge. AI may challenge them when evidence conflicts, but it should not silently replace them.

---

# 10. Model-routing strategy

CLU-E should use multiple reasoning tiers rather than one model for every task.

## Tier 0 — No AI

Use deterministic tools for:

- discovery;
- parsing;
- symbol extraction;
- hashing;
- Git operations;
- compilation;
- test execution;
- benchmark execution;
- numeric calculations;
- schema validation;
- hard gate enforcement.

## Tier 1 — Economical classifier or local model

Use for:

- language/environment routing assistance;
- metric applicability triage;
- log clustering;
- summary extraction;
- simple responsibility classification;
- output normalization;
- low-risk documentation classification.

## Tier 2 — General reasoning model

Use for:

- semantic enrichment;
- moderate imperfection analysis;
- test-gap analysis;
- ordinary patch planning;
- benchmark refinement;
- result interpretation;
- root-cause analysis.

## Tier 3 — Strongest reasoning model

Use for:

- cross-module architecture;
- difficult multi-language boundaries;
- high-impact patch design;
- benchmark validity disputes;
- cross-metric trade-off adjudication;
- high-risk candidate assessment;
- equilibrium challenge and final adjudication.

## Tier 4 — Independent adjudication

Use sparingly when:

- the change is high-impact or difficult to reverse;
- two metrics conflict materially;
- evidence is valid but interpretation remains uncertain;
- the primary assessment and deterministic indicators disagree;
- the system is about to declare equilibrium.

Independent adjudication should reuse the same compact evidence packet. It should not duplicate full repository analysis.

## Routing factors

Model selection should consider:

- task type;
- target risk;
- affected scope;
- uncertainty;
- evidence quality;
- expected value;
- reversibility;
- prior model disagreement;
- remaining token budget.

---

# 11. Token-budget controls

Exact token counts will depend on the selected provider and model, but CLU-E should define design budgets for each task class.

The following are architectural targets, not provider guarantees.

| Task class | Typical context target | Typical output target | Preferred tier |
|---|---:|---:|---|
| Applicability classification | 300–1,500 tokens | 50–300 tokens | Tier 1 |
| File or symbol semantic enrichment | 1,000–5,000 | 200–1,200 | Tier 1–2 |
| Imperfection hypothesis | 2,000–8,000 | 300–1,500 | Tier 2 |
| Benchmark design | 3,000–12,000 | 600–2,500 | Tier 2–3 |
| Focused patch generation | 3,000–15,000 | 500–4,000 | Tier 2–3 |
| Failure diagnosis | 1,500–8,000 | 300–1,500 | Tier 2 |
| Candidate adjudication | 3,000–15,000 | 500–2,000 | Tier 2–3 |
| Equilibrium adjudication | 8,000–30,000 | 1,000–4,000 | Tier 3–4 |

These budgets should be exceeded only through an explicit escalation decision.

## 11.1 Hard and soft budgets

Each mission should have:

- a soft token budget that triggers context compression or lower-cost routing;
- a hard token budget that prevents uncontrolled continuation;
- a reserved adjudication budget for high-value final reasoning;
- a retry budget;
- a maximum number of alternative candidates.

## 11.2 Retry policy

Retries should occur only for identifiable reasons:

- schema-invalid output;
- transient provider failure;
- missing evidence request;
- contradiction requiring clarification;
- explicitly selected alternate candidate.

Do not repeatedly send the same prompt hoping for a better answer without changing evidence, instructions, or model tier.

## 11.3 Output minimization

Machine-facing invocations should request compact structured results. Long narrative explanations should be produced only for user review, documentation, or contested decisions.

## 11.4 Token reservation

CLU-E should reserve a meaningful portion of the mission budget for:

- benchmark interpretation;
- regression analysis;
- final adjudication;
- equilibrium challenge.

Spending nearly the entire budget during initial semantic enrichment would reduce the quality of the decisions that matter most.

---

# 12. Caching strategy

AI caching must be explicit and evidence-aware.

## 12.1 Recommended cache key

An AI result cache key should include:

```text
AI task type
+ prompt-template version
+ model policy/version
+ target artifact hashes
+ dependency-context hashes
+ metric-definition hashes
+ project-policy hash
+ requested output-schema version
```

## 12.2 Cacheable outputs

- semantic entity summaries;
- domain and module membership suggestions;
- metric applicability classifications;
- documentation claim mappings;
- test-style summaries;
- benchmark plans tied to unchanged hypotheses;
- evidence digests;
- rejected-hypothesis explanations;
- project convention summaries.

## 12.3 Non-reusable or conditionally reusable outputs

- candidate acceptance decisions after evidence changes;
- equilibrium declarations after repository changes;
- benchmark conclusions after environment changes;
- risk assessments after dependency or policy changes;
- patch outputs after source context changes.

## 12.4 Negative-result caching

A well-supported `not applicable`, `insufficient evidence`, or `candidate rejected` result is valuable knowledge. CLU-E should cache it with its reasons and invalidation conditions so it does not rediscover the same dead end during every pass.

---

# 13. AI output contracts

Every AI activity should return a schema-validated artifact.

## 13.1 Required common fields

```json
{
  "taskId": "...",
  "taskType": "...",
  "projectSnapshotId": "...",
  "targetEntityIds": ["..."],
  "status": "completed | insufficient_evidence | not_applicable | failed",
  "claims": [],
  "evidenceRefs": [],
  "metricRefs": [],
  "assumptions": [],
  "uncertainties": [],
  "confidence": 0.0,
  "requestedAdditionalEvidence": [],
  "recommendedNextAction": "..."
}
```

## 13.2 Claims must be evidence-linked

A statement such as “this file mixes orchestration and persistence responsibilities” should reference the symbols, calls, writes, or documentation claims from which the conclusion was drawn.

## 13.3 Confidence is not proof

A high model confidence value cannot replace tests, measurements, or acceptance gates. Confidence only communicates the model’s certainty about an interpretation.

## 13.4 AI must be allowed to abstain

The schema must support:

- insufficient context;
- unsupported language semantics;
- missing runtime evidence;
- conflicting documentation;
- ambiguous metric applicability;
- inconclusive benchmark.

---

# 14. AI invocation ledger and auditability

Every invocation should create an immutable ledger record containing:

- task and mission IDs;
- project snapshot and Git identity;
- provider and model class;
- model configuration relevant to reproducibility;
- prompt-template version;
- input artifact references and hashes;
- output artifact hash;
- schema-validation result;
- input and output token counts;
- cache-hit status;
- latency;
- retry count;
- estimated or recorded cost where available;
- downstream decision using the output;
- user or policy approval where required.

CLU-E does not need to expose private model reasoning. It does need to preserve the evidence packet, structured output, and decision path.

The objective is decision reconstructibility:

```text
Which facts were provided?
Which task was requested?
Which structured claim was returned?
Which evidence was produced afterward?
Which deterministic gates accepted or rejected the candidate?
```

---

# 15. Benchmark evidence compression

Benchmarking can generate enormous data volumes. Raw evidence must remain stored, but most AI assessments should use compact digests.

## 15.1 Deterministic digest contents

- environment identity;
- tool versions;
- input dataset identity;
- baseline and candidate commit IDs;
- repetition count;
- warm-up status;
- valid and invalid runs;
- median, mean, variance, percentiles, and confidence calculations where relevant;
- gate results;
- error and warning clusters;
- performance deltas;
- visual-diff summary;
- links to raw traces, logs, profiles, and screenshots.

## 15.2 Progressive evidence retrieval

AI first receives the digest. It may then request:

- a specific trace span;
- one profiler hotspot;
- a representative console failure;
- a selected screenshot pair;
- a particular test case;
- a source fragment connected to the anomaly.

This prevents every assessment from carrying the full evidence archive.

## 15.3 Visual assessment

For Chrome or WebGPU projects, CLU-E should apply deterministic checks first:

- screenshot dimensions and existence;
- pixel or perceptual-diff thresholds;
- DOM state;
- layout metrics;
- console and GPU errors;
- frame timing;
- accessibility tree checks where applicable.

AI vision should be used when the question is semantic or perceptual, such as whether an animation remains understandable, whether a composition preserves intended hierarchy, or whether a rendering artifact is visually unacceptable despite passing a simple pixel threshold.

---

# 16. AI and Git workflow

AI may propose and explain changes, but the Git workflow must remain controlled by CLU-E’s authority layer.

Recommended flow:

```text
Accepted hypothesis
  → isolated branch/worktree
  → AI patch plan
  → controlled file modification
  → deterministic diff validation
  → build and tests
  → benchmark execution
  → AI evidence assessment
  → deterministic gates
  → commit with evidence references
  → optional review/approval
  → controlled landing
```

Token efficiency is improved by storing patch rationale, benchmark plan, and evidence under the candidate ID. Later stages should reference those artifacts rather than asking the model to reconstruct the entire history.

Rejected branches should preserve enough evidence to prevent repeated generation of the same invalid approach.

---

# 17. AI and polyglot project support

CLU-E should use one language-neutral AI reasoning kernel over a Universal Project Representation, while preserving native language facts and native proof tools.

Each environment adapter should declare:

- supported file and entity types;
- structural-recognition depth;
- semantic facts it can deterministically prove;
- runtime instruments;
- available compilers, interpreters, linters, and test frameworks;
- supported metrics;
- unavailable proof categories;
- context-extraction rules;
- evidence-compression rules.

Examples:

## TypeScript

- compiler API and AST facts;
- imports, symbols, types, diagnostics;
- Node or browser tests;
- bundle and runtime metrics.

## WGSL

- syntax and binding declarations;
- TypeScript-to-shader resource relations;
- browser/WebGPU compilation;
- GPU validation and frame measurements;
- visual evidence.

## PowerShell

- command and pipeline structure;
- execution policy and environment;
- filesystem and process effects;
- script tests and exit evidence.

## SQL

- schema and query structure;
- execution plans;
- database constraints;
- transaction behavior;
- data correctness and performance evidence.

AI prompts should be built from the adapter’s native facts and metric cards. This is more efficient and more accurate than a generic prompt that treats all source files alike.

---

# 18. Privacy and data-minimization requirements

Token efficiency and privacy reinforce each other.

CLU-E should send the minimum required source and evidence to an external AI provider.

Required controls include:

- configurable provider policy by repository and file class;
- exclusion of secrets, credentials, personal data, binaries, and prohibited directories;
- local redaction and secret scanning before context construction;
- optional local-model routing for sensitive classification tasks;
- explicit evidence references instead of unnecessary raw content;
- retention policy for prompts and outputs;
- user-visible indication of what context leaves the local environment;
- separate handling of organization-confidential documentation.

No AI task should receive complete repository content merely because it is technically available.

---

# 19. Token-efficiency self-measures

CLU-E should measure its own AI efficiency as part of the CLU-E Self-Measures family.

Recommended measures include:

## Consumption

- input tokens per task type;
- output tokens per task type;
- tokens per candidate;
- tokens per accepted improvement;
- tokens per rejected candidate;
- tokens per completed RPI pass;
- tokens by model tier;
- tokens by language/environment.

## Reuse

- semantic-summary cache-hit rate;
- applicability-cache hit rate;
- evidence-digest reuse rate;
- percentage of invocations using delta context;
- repeated-context ratio;
- negative-result reuse rate.

## Quality

- AI claims later contradicted by deterministic evidence;
- schema-invalid output rate;
- abstention correctness;
- applicability false-positive and false-negative rate;
- patch acceptance rate;
- benchmark-plan invalidation rate;
- adjudication disagreement rate.

## Efficiency

- proportion of tokens spent on non-applicable metrics;
- useful evidence references per 1,000 tokens;
- accepted metric improvement per token budget;
- average context level used;
- escalation rate from economical to strong models;
- retries without new evidence;
- duplicate hypothesis rate.

## Governance

- AI invocation without complete ledger record;
- output used outside its authorized purpose;
- decision made without required evidence;
- external-provider context-policy violations;
- model-tier violations.

These measures should help CLU-E improve its own reasoning economy over time.

---

# 20. Failure patterns CLU-E must avoid

## 20.1 Sending the entire repository for every question

This wastes tokens, increases distraction, weakens reproducibility, and scales poorly.

## 20.2 Asking AI to perform exact computations

Compilers, profilers, parsers, statistics libraries, and test runners should produce facts. AI should interpret them.

## 20.3 Deeply evaluating every metric for every entity

This creates a combinatorial explosion dominated by non-applicable work.

## 20.4 Re-summarizing unchanged code

Stable semantic artifacts should be reused until invalidated.

## 20.5 Treating AI summaries as source truth

Summaries are indexes and interpretations. Source, runtime, and evidence artifacts remain authoritative.

## 20.6 Allowing prose-only output

Unstructured prose is difficult to validate, compare, cache, and execute.

## 20.7 Using the strongest model for trivial routing

This spends the highest-value reasoning capacity on low-value decisions.

## 20.8 Using a cheap model for final high-risk adjudication

Efficiency must not reduce decision quality where the risk or value justifies stronger reasoning.

## 20.9 Unlimited agent multiplication

Multiple agents can duplicate context and generate conflicting interpretations. Parallelism should be used only where tasks are independent or independent adjudication is valuable.

## 20.10 Repeated retries without new evidence

A failed hypothesis should not consume an open-ended sequence of patch generations. Retry only when the failure provides information that changes the next attempt.

## 20.11 Allowing AI to declare its own benchmark successful

Benchmark validity and gate status must be grounded in deterministic execution evidence.

## 20.12 Declaring equilibrium because the token budget ended

Budget exhaustion means the mission is incomplete, not that the project reached equilibrium.

---

# 21. Recommended end-to-end AI-efficient improvement loop

```text
1. Select, validate, hash, snapshot, and cycle-lock `target description.md` and `benchmark.txt`.
2. Compile or reuse the Project Intent Model and normalized Master Benchmark Specification.
3. Acquire a valid opening Master Benchmark result: reuse the previous cycle-closing run only when snapshot, benchmark, environment, and freshness rules permit; otherwise execute it.
4. Detect repository delta deterministically.
5. Update structural recognition and affected graph projections.
6. Reuse all unchanged semantic and applicability artifacts.
7. Re-enrich only invalidated entities, using relevant project-intent objectives.
8. Screen the complete metric catalogue using deterministic metadata.
9. Ask AI only about ambiguous metric applicability.
10. Run cheap deterministic measures and gates.
11. Ask AI to form evidence-linked imperfection hypotheses.
12. Deduplicate and prioritize hypotheses using project intent and Master Benchmark observations.
13. Select one candidate under risk and token budgets.
14. Ask AI to design the candidate-specific benchmark and required tests.
15. Validate the benchmark plan against executable capabilities.
16. Record or reuse a valid candidate baseline.
17. Ask AI to plan and generate the smallest controlled patch.
18. Apply the patch in an isolated Git workspace.
19. Execute compiler, tests, Chrome scenarios, and candidate benchmarks.
20. Compress raw results into a deterministic evidence digest.
21. Ask AI to assess the candidate against applicable metrics.
22. Run all mandatory deterministic acceptance gates.
23. Accept, reject, revise, or defer the candidate.
24. Commit accepted changes with evidence references; cache rejected paths and invalidation conditions.
25. Emit compact benchmark-contribution records from accepted improvements, recognition conclusions, runtime anomalies, and failed or inconclusive experiments.
26. Rebuild affected recognition and semantic artifacts, then continue candidate work until the cycle search policy is complete.
27. Build the project-objective and architecture coverage map for the current Master Benchmark.
28. Ask AI to synthesize a benchmark-enrichment proposal from durable cycle lessons.
29. Independently critique material benchmark revisions for overfitting, redundancy, instability, implementation lock-in, and excessive runtime.
30. Validate proposed benchmark revisions deterministically and measure their information gain.
31. Version and persist the accepted `benchmark.txt`, preserving provenance and historical-comparability status.
32. Execute the final Master Benchmark against the complete accepted project snapshot.
33. Ask AI to assess the project-wide vital signs, coverage, trends, anomalies, and next-cycle candidate seeds.
34. Start another cycle when the enriched benchmark reveals a supported opportunity; otherwise continue complete challenge passes until the strengthened equilibrium policy is satisfied.
```

At each step, CLU-E should know exactly why AI is or is not required. The final Master Benchmark run does not re-prove every accepted patch. It characterizes the resulting whole project, preserves durable measurement lessons, and supplies the next cycle with a stronger observational baseline.

---

# 22. Capability dependency layers

## Phase 0 — AI governance foundation

The AI subsystem depends on the following foundation before patch-generation authority may be enabled:

- provider abstraction;
- model-tier policy;
- typed invocation contracts;
- prompt-template registry;
- token budgets;
- invocation ledger;
- content-addressed AI cache;
- secret and context policy;
- schema validation;
- evidence-reference requirements.

**Exit condition:** AI can be invoked reproducibly, budgeted, audited, cached, and prevented from acting outside its role.

## Phase 1 — Semantic enrichment

Add AI after deterministic recognition to produce:

- responsibility summaries;
- domain and module memberships;
- uncertainty records;
- documentation mappings;
- DIVE-mode semantic overlays.

**Exit condition:** AI enrichment is clearly separated from deterministic facts, persists as versioned artifacts, and invalidates correctly on source changes.

## Phase 2 — Metric applicability engine

Implement:

- machine-readable metric applicability metadata;
- deterministic prefilter;
- AI ambiguity review;
- cached target-metric matrix;
- candidate impact expansion;
- applicability quality metrics.

**Exit condition:** CLU-E can demonstrate that all metrics were considered while deep prompts include only relevant metrics.

## Phase 3 — Hypothesis and benchmark intelligence

Implement:

- imperfection-hypothesis schema;
- prioritization;
- benchmark-plan generation;
- test-gap analysis;
- baseline reuse;
- evidence digest generation.

**Exit condition:** AI hypotheses lead to executable, measurable experiments rather than untestable recommendations.

## Phase 4 — Patch and candidate adjudication

Implement:

- scoped patch context;
- controlled patch generation;
- affected-scope recalculation;
- result interpretation;
- cross-metric adjudication;
- deterministic acceptance authority;
- Git evidence linkage.

**Exit condition:** No AI-generated patch can be accepted without complete evidence and mandatory gates.

## Phase 5 — Equilibrium intelligence

Implement:

- pass coverage;
- challenge strategies;
- low-confidence targeting;
- negative-result reuse;
- independent final adjudication;
- equilibrium evidence package.

**Exit condition:** An equilibrium declaration proves search coverage and absence of supported improvements rather than absence of remaining budget or ideas.

## Phase 6 — Project intent and evolving Master Benchmark

Implement:

- Configuration file selectors for `target description.md` and `benchmark.txt`;
- immutable cycle-input snapshots and hash-change handling;
- the Project Intent Model and objective retrieval;
- the normalized Master Benchmark Specification;
- benchmark-contribution records;
- objective, architecture, runtime-path, metric-family, and environment coverage mapping;
- AI benchmark enrichment and independent critique;
- deterministic benchmark revision validation and information-gain assessment;
- benchmark versioning, bridge runs, and historical-comparability classification;
- final cycle-closing Master Benchmark execution;
- next-cycle vital-input generation;
- equilibrium gates for benchmark maturity, coverage, stability, and unresolved anomalies.

**Exit condition:** Every completed cycle leaves both the accepted project and its whole-project observation instrument in a stronger, versioned, reproducible state, and the final Master Benchmark result can seed the next cycle without re-reading the entire mission history.

---

# 23. Stable implementation ownership

Detailed file-by-file work items are dynamic and therefore maintained in the external `CLU-E_Backlog_and_Program_Integrity_v8.md`, not in the permanent knowledge base. The stable ownership boundaries are:

| Capability | Owning source area |
|---|---|
| provider abstraction, routing, task policy, token budget, ledger, cache, context policy, schema validation | `src/ai/` |
| semantic enrichment, ambiguity, summaries, invalidation, documentation alignment | `src/ai/` with native facts from `src/analysis/` |
| deterministic applicability metadata and affected-scope expansion | `src/analysis/measure/` and `src/analysis/metrics/` |
| hypotheses, deduplication, prioritization, patch planning and generation | `src/improvement/` |
| candidate benchmark design, baseline reuse, evidence digestion, Master Benchmark governance | `src/benchmark/` |
| test-gap analysis and generated proof instruments | `src/testing/` |
| candidate interpretation, trade-off adjudication, and failure diagnosis | `src/evaluation/` |
| challenge passes and equilibrium assessment | `src/equilibrium/` |
| target-description loading and Project Intent Model | `src/intent/` |
| cycle locking and next-cycle handoff | `src/control/` and `src/cycle/` |
| AI status and operator inspection | `src/status/`, `src/ui/`, and the Dashboard |

Exact target paths and responsibilities are owned by `CLUE_Project_Directory_v9.md`. Current implementation order and open items remain outside the documentation archive.

---

# 24. Acceptance criteria for AI utilization

CLU-E’s AI integration should not be considered complete until the following are true.

## Separation of truth and interpretation

- deterministic recognition works without AI;
- AI enrichment cannot create or delete physical repository files in Q1 ALL;
- AI claims are stored separately from deterministic facts;
- every claim carries provenance and confidence.

## Metric completeness and efficiency

- every target can prove that the full metric catalogue was screened;
- deep AI prompts contain only applicable or conditionally applicable metrics;
- mandatory gates cannot be filtered out by AI;
- applicability results are cached and correctly invalidated;
- token use on non-applicable metrics is measured.

## Context discipline

- no ordinary task sends the full repository by default;
- every invocation uses a typed context packet;
- changed projects use delta context;
- summaries retain references to source evidence;
- the model can request additional evidence explicitly.

## Model routing

- economical tasks do not automatically use the strongest model;
- high-risk final decisions cannot be forced through a low-capability tier solely to reduce cost;
- escalation and independent adjudication are policy-driven;
- retries are bounded and evidence-driven.

## Evidence authority

- AI does not execute measurements itself;
- raw evidence is stored independently of AI summaries;
- numeric metrics are calculated deterministically;
- no candidate is accepted solely from an AI recommendation;
- mandatory gates remain deterministic.

## Auditability

- every invocation has a ledger record;
- token use and cache behavior are observable;
- input and output artifacts are hashed;
- prompt and schema versions are recorded;
- decisions can be reconstructed from evidence.

## Equilibrium integrity

- equilibrium is not declared because the token budget ended;
- stable knowledge is reused across passes;
- low-confidence and uncovered areas remain visible;
- final equilibrium assessment uses complete coverage evidence;
- unresolved unsupported environments are explicitly excluded from the claim.

## Project-intent and Master Benchmark integrity

- Configuration exposes explicit selectors for `target description.md` and `benchmark.txt`;
- both files are validated, hashed, snapshotted, and locked to the active cycle;
- mid-cycle file changes cannot silently alter the active mission;
- the target description is compiled into a versioned Project Intent Model and is not resent in full for ordinary calls;
- declared intent is never treated as evidence of implementation success;
- candidate-specific proof benchmarks remain distinct from the Master Benchmark;
- every accepted improvement emits a compact benchmark-contribution record;
- every completed cycle performs a benchmark-enrichment review using accepted changes, semantic conclusions, runtime evidence, failed experiments, coverage gaps, objective changes, and environment changes;
- proposed benchmark revisions are checked for new information, stability, non-duplication, cost, historical comparability, and overfitting;
- the final Master Benchmark executes deterministically against the complete accepted project snapshot;
- its output preserves native-unit telemetry and does not collapse unrelated metrics into one raw total;
- final results, coverage, trends, anomalies, and blind spots are assessed and stored as next-cycle vital input;
- equilibrium is blocked while a critical objective lacks an evidence path, the benchmark remains materially enrichable, or final benchmark evidence exposes an unresolved candidate.

---

# 25. Project intent and the evolving Master Benchmark

## 25.1 Executive decision

CLU-E Configuration must expose two explicit project-level file inputs:

```text
target description.md
benchmark.txt
```

They form a continuous contract between project purpose, project observation, and recursive improvement.

`target description.md` tells AI what the project is for, who or what it serves, what it must achieve, what must not be sacrificed, and how project-level success should be interpreted. It is the semantic north star for CLU-E reasoning.

`benchmark.txt` tells CLU-E how to exercise and observe the complete accepted project. It is the evolving Master Benchmark: a project-level vital-sign instrument that begins with the user’s initial harness or recipe and becomes more comprehensive as CLU-E understands the architecture, proves improvements, encounters failures, and learns which scenarios expose the project’s real quality.

The locked lifecycle is:

```text
project intent
    → structural recognition
    → AI semantic understanding
    → local imperfection search
    → candidate-specific proof
    → accepted project improvements
    → durable benchmark lessons
    → Master Benchmark enrichment
    → final whole-project benchmark
    → next-cycle vital input
    → stronger subsequent search
```

This makes equilibrium deliberately more difficult and more valuable. CLU-E cannot stop merely because no obvious local patch remains. It must also show that the project is being observed by a mature, representative, stable benchmark and that the latest whole-project evidence does not reveal another justified direction for improvement.

## 25.2 Configuration behavior

Each selector should show:

- absolute path and repository-relative path where available;
- existence, readability, and encoding status;
- content hash;
- parser or adapter status;
- last successful load;
- snapshot and mission to which the version is bound;
- whether the file is inside the selected repository;
- whether it changed after the active cycle was locked;
- blocking errors and non-blocking warnings;
- actions to open and reload the file.

At cycle start, CLU-E captures immutable copies and hashes of both files. The active cycle reasons from those exact versions. A manual edit during the cycle must trigger an explicit deterministic state transition rather than silently changing the mission:

```text
continue with the locked version
restart from a new input snapshot
fork a new mission using the changed inputs
```

Recognition may run without the files, but a proof-authoritative full RPI cycle should not claim complete project understanding or equilibrium without a locked project-intent input and a valid Master Benchmark.

The preferred location is within the target repository so that both inputs participate in Git history and reproducible checkout. External files may be supported, but CLU-E must still snapshot and hash them as mission inputs.

## 25.3 `target description.md`: project purpose as reusable AI context

The target description should state, where applicable:

- project purpose;
- intended users, operators, or consumers;
- primary journeys and workloads;
- core capabilities;
- critical behavior;
- strategic objectives;
- quality priorities;
- non-negotiable constraints;
- supported environments and expected scale;
- safety, privacy, security, compliance, or accessibility obligations;
- non-goals;
- acceptable and unacceptable trade-offs;
- definitions of project-level success.

For Murugan, it could establish that the target is a responsive browser-based WebGPU game and creation environment, that representative scenes must remain smooth and correct, and that optimizations must not damage extensibility, visual fidelity, or intended gameplay behavior.

The file is authoritative for **declared intent**, not for **observed truth**. A statement that a feature exists does not prove it. A performance objective does not prove that it is met. CLU-E must compare the description with deterministic structure, executable behavior, tests, metrics, and benchmark evidence.

### Project Intent Model

AI should read the complete Markdown only during onboarding, when its content hash changes, or during a deliberate global re-interpretation. It should compile the file into a versioned Project Intent Model containing stable objective and capability identifiers.

A conceptual record is:

```json
{
  "source_hash": "sha256:...",
  "purpose": "...",
  "objectives": [
    {
      "id": "OBJ-RENDER-01",
      "statement": "Maintain smooth interactive rendering in representative gameplay scenes",
      "priority": "critical",
      "benchmarkability": "direct"
    }
  ],
  "capabilities": [],
  "constraints": [],
  "quality_priorities": [],
  "non_goals": [],
  "operating_environments": [],
  "ambiguities": []
}
```

Ordinary AI calls receive only the relevant objective IDs, concise excerpts, and evidence references. CLU-E does not repeatedly pay to resend the complete description.

The Project Intent Model should inform semantic enrichment, module assignment, metric applicability, candidate prioritization, benchmark selection, trade-off adjudication, project-level assessment, and equilibrium. It must not override deterministic facts or mandatory gates.

## 25.4 `benchmark.txt`: the Master Benchmark contract

`benchmark.txt` is the user-selected Master Benchmark definition for the complete accepted project. It is not the raw result file and not merely a prose request. It defines or references the executable process that starts the target, reaches representative states, collects telemetry, records artifacts, and terminates cleanly.

The file may contain a declarative recipe, an adapter-specific executable payload, or references to benchmark scripts in the repository. CLU-E must normalize it into a deterministic Master Benchmark Specification before execution. AI may help interpret and improve the human-authored benchmark, but an unvalidated AI reading must never become the execution authority.

The normalized specification should identify:

- benchmark version and parent;
- runner and environment adapter;
- supported target snapshot or compatibility range;
- build and launch commands;
- readiness, setup, and cleanup conditions;
- scenario identifiers and controlled inputs;
- warm-up, duration, repetition, and timeout rules;
- telemetry channels and schemas;
- required traces, screenshots, logs, profiles, or recordings;
- native-unit metrics;
- deterministic gates;
- variance and invalid-run rules;
- execution-cost budget;
- hardware and software environment metadata.

For a game, the Master Benchmark should normally return a vector of vital signs rather than one misleading score. For example:

- average FPS;
- median, p95, and p99 frame time;
- long-frame or stutter count;
- CPU and GPU timing where available;
- memory level and growth;
- loading and transition time;
- console errors;
- visual and behavioral gates;
- scenario completion state.

The values remain in native units. They may be normalized for comparison or visualization, but unrelated measurements must not be added into a fictitious raw total.

## 25.5 Candidate benchmark versus Master Benchmark

CLU-E needs both scopes.

A **candidate-specific benchmark** proves or rejects one improvement hypothesis. It may be narrow, temporary, and specialized. Its complete A/B evidence remains attached to that candidate.

The **Master Benchmark** characterizes the whole currently accepted project. It provides stable project-level vital signs, broad regression awareness, system coverage, and the starting evidence for the next RPI cycle.

Accepted improvements are therefore leveraged rather than redundantly re-proven:

```text
candidate benchmark
    → proves one change
    → emits a durable measurement lesson
    → may contribute a selected scenario, signal, gate, or stress level
      to the Master Benchmark

Master Benchmark
    → does not repeat every historical A/B experiment
    → observes the accepted project as a whole
    → preserves useful project-level learning
```

For example, after a rendering optimization is proven and accepted, the Master Benchmark may raise representative scene complexity, add the affected scene to project-wide coverage, retain p99 frame-time telemetry because stutter became important, or record a higher accepted operating envelope. It normally does not need to replay the exact old-versus-new experiment.

The rule is:

> Promote the durable measurement lesson, not the entire historical experiment.

A compact regression floor may still be retained when losing an accepted capability would materially damage the project. This is not re-proving the old patch; it is protecting the currently accepted project state and informing future cycles.

## 25.6 Sources of benchmark enrichment

Every cycle must consider the following sources.

### Accepted improvements

Each accepted improvement emits a Benchmark Contribution Record containing the affected capability, achieved native-unit deltas, new operating envelope, moved bottleneck, newly available telemetry, discovered risks, candidate-benchmark references, and a reasoned promotion recommendation.

### AI semantic conclusions from recognition

As AI understands domains, subsystems, modules, runtime paths, state transitions, and cross-environment boundaries, it may identify critical capabilities or interactions absent from the current benchmark. Proposed additions must map to recognized entities, project objectives, or runtime evidence and must survive deterministic validation.

### Rejected and inconclusive experiments

A failed patch can expose missing telemetry, excessive variance, an untested visual transition, an unavailable environment, a hidden dependency, or an instrument that perturbs behavior. The patch can remain rejected while its lesson improves the Master Benchmark.

### Runtime anomalies and historical regressions

Intermittent errors, long-tail latency, memory drift, races, crashes, and previously repaired regressions are strong sources of durable low-cost scenarios or signals.

### Project-intent, documentation, and metric changes

A new critical objective without a benchmark or evidence path is a coverage gap. Changed requirements, supported environments, architecture, or metrics must trigger benchmark-coverage reassessment.

### Environment and dependency changes

Browser versions, GPU drivers, runtimes, databases, dependencies, hardware classes, and deployment environments can change the meaning of results. The benchmark should capture the relevant fingerprint and introduce representative compatibility coverage where justified.

### Stress, boundary, holdout, and adversarial scenarios

Long-duration runs, larger workloads, boundary values, randomized seeds, cold and warm starts, resource pressure, degraded dependencies, malformed input, fault injection, and scenarios withheld from candidate optimization help prevent benchmark gaming.

### Benchmark sensitivity analysis

A benchmark that cannot detect meaningful degradations is not mature. In disposable sandboxes, CLU-E may use historical failures, controlled mutation, or safe fault injection to test whether the Master Benchmark reacts to important defects.

### Production or user telemetry

Where privacy and project policy permit, aggregated real-world telemetry can identify representative workloads, device classes, failure distributions, and bottlenecks that synthetic scenarios miss. Deterministic privacy controls and data reduction remain authoritative.

## 25.7 End-of-cycle enrichment and closing run

Every completed cycle should perform the following sequence.

1. **Freeze the accepted project state.** Accepted changes form one immutable snapshot; rejected and inconclusive patches are excluded.
2. **Collect compact contribution records.** Use structured lessons rather than replaying full AI conversations and raw evidence.
3. **Build the coverage map.** Map current benchmark scenarios and signals to project objectives, capabilities, domains, subsystems, runtime paths, metric families, gates, risks, and environments.
4. **Synthesize enrichment with strong AI.** Propose additions, pruning, consolidation, stress changes, telemetry changes, or threshold changes, each with expected information gain and cost.
5. **Critique material revisions independently.** Look for redundancy, overfitting, unstable instrumentation, implementation lock-in, target leakage, missing holdouts, and excessive runtime.
6. **Validate deterministically.** Check authorization, runner availability, reachability, schema validity, repeatability, variance, cleanup, timeout behavior, cost, and artifact completeness.
7. **Measure information gain.** Run the current and proposed benchmark on the same accepted project where practical. Reject longer revisions that merely repeat existing signals.
8. **Version and persist the accepted benchmark.** Record parentage, provenance, coverage delta, execution-cost delta, compatibility class, bridge-run evidence, and Git identity.
9. **Execute the final Master Benchmark.** Run it against the complete accepted project snapshot and preserve all structured results and raw artifact references.
10. **Assess project-wide evidence with AI.** Compare intent, current capabilities, prior trends, coverage, stability, anomalies, and known blind spots.
11. **Produce next-cycle vital input.** Persist benchmark version, project snapshot, environment fingerprint, objective coverage, native-unit vital signs, trends, anomalies, blind spots, maturity, and candidate seeds.

The final result becomes the default opening intelligence for the next CLU-E cycle. It may be reused only when the project snapshot, benchmark version, environment fingerprint, and freshness policy still match. Otherwise, CLU-E reruns the benchmark.

## 25.8 Enrichment without benchmark bloat

The benchmark should become more informative, not merely larger. Forcing a textual addition every cycle would eventually create a slow, duplicated, fragile, overfitted suite.

The locked rule should be:

> Every cycle performs an evidence-backed benchmark-enrichment review. Every durable lesson is recorded in the benchmark knowledge and coverage model. `benchmark.txt` changes only when a revision adds useful project-level information at acceptable cost.

Valid cycle outcomes include:

```text
BENCHMARK_REVISED
BENCHMARK_CONSOLIDATED
BENCHMARK_PRUNED
BENCHMARK_THRESHOLDS_UPDATED
BENCHMARK_STRESS_ENVELOPE_RAISED
BENCHMARK_UNCHANGED_NO_JUSTIFIED_REVISION
```

The last outcome is valid only when the review proves that no proposal offers sufficient information gain. Benchmark pruning is itself improvement when it removes obsolete, duplicated, noisy, or implementation-coupled coverage while preserving historical evidence.

## 25.9 Historical comparability and bridge runs

An evolving benchmark can break trend continuity. Each revision must therefore be classified as:

- **fully comparable** — scenario and metric meaning are unchanged;
- **partially comparable** — stable identifiers continue while coverage is added or removed;
- **non-comparable without a bridge run** — instrumentation, scenario meaning, environment, or telemetry semantics changed materially.

When practical, CLU-E should run the old and new benchmark versions against the same accepted snapshot to establish a transition baseline. It must not pretend that unlike measurements form one continuous series.

Thresholds should not tighten automatically after every improvement. A new threshold must reflect project intent, measurement stability, risk, and a deliberately accepted capability floor. A one-time peak result should not become an unrealistic gate.

## 25.10 Token-efficient use of both files

The two files are persistent project knowledge, not content to resend on every invocation.

For `target description.md`:

- read the complete file only when its hash changes or a global reassessment is required;
- compile it into stable objective, capability, constraint, priority, and ambiguity records;
- retrieve only relevant objective IDs and excerpts;
- cache interpretations against the file hash and prompt-contract version.

For `benchmark.txt`:

- parse the complete file only when its hash changes;
- store a compact scenario, telemetry, gate, coverage, and environment manifest;
- give candidate calls only relevant benchmark references;
- summarize each accepted improvement into one contribution record;
- normalize Master Benchmark telemetry before AI assessment;
- keep raw samples, traces, screenshots, logs, and profiles in the artifact store;
- perform one consolidated strong-model enrichment synthesis near cycle closure rather than asking every candidate call to redesign the Master Benchmark.

The pattern is:

```text
full project-intent read rarely
    → compact intent retrieval frequently

full Master Benchmark read rarely
    → compact scenario and coverage retrieval frequently

raw benchmark evidence stored once
    → normalized evidence assessed repeatedly
```

This fully leverages AI while keeping recursive operation sustainable.

## 25.11 AI roles in Master Benchmark governance

Three reasoning roles should be separated.

**Benchmark Curator** maps intent and architecture to current coverage, gathers contribution records, and proposes enrichment, consolidation, or pruning.

**Benchmark Critic** independently challenges overfitting, redundancy, instability, target leakage, implementation lock-in, missing holdouts, and excessive execution cost.

**Master Benchmark Assessor** interprets the final project-wide result, compares trends and coverage, identifies anomalies and candidate seeds, and assesses benchmark maturity.

Deterministic systems remain responsible for parsing, execution, telemetry collection, statistics, gates, versioning, Git operations, and artifact integrity.

## 25.12 How this strengthens equilibrium

Without an evolving Master Benchmark, CLU-E could reach a shallow state in which no currently selected local candidate passes its proof benchmark. That does not establish that the project is globally understood or well observed.

The stronger equilibrium contract requires:

1. sufficient physical and semantic recognition coverage;
2. an evidence path for every critical objective in `target description.md`;
3. stabilized candidate search across repeated passes;
4. representative whole-project scenarios;
5. stable and discriminating telemetry;
6. no unexplained project-wide anomaly;
7. no unjustified critical coverage gap;
8. no valuable remaining benchmark enrichment at acceptable cost;
9. stable repeated closing runs under the documented environment policy;
10. no evidence-supported candidate produced by the latest Master Benchmark assessment.

A new benchmark scenario may expose a problem after local improvement work seemed complete. In that case, equilibrium is not declared. The observation becomes input to another cycle.

```text
better understanding
    → better benchmark
    → stronger observation
    → harder improvement problem
    → better accepted project
    → still better understanding
```

Eventually, the implementation, semantic model, metric coverage, and Master Benchmark stabilize together. That is a materially stronger and more defensible equilibrium.

## 25.13 Master-benchmark self-measures

CLU-E should measure the benchmark itself using signals such as:

- critical-objective and capability coverage;
- domain, subsystem, runtime-path, metric-family, gate, and environment coverage;
- scenario redundancy;
- telemetry stability and unexplained variance;
- historical regression-detection rate;
- mutation or fault-detection sensitivity;
- execution time and instrumentation overhead;
- flaky-run rate;
- environment reproducibility;
- information gain per minute;
- accepted and rejected contributions per cycle;
- benchmark growth and pruning rate;
- proportion of next-cycle candidates originating from Master Benchmark evidence.

The objective is not maximum benchmark size. It is maximum trustworthy project insight within an acceptable execution and maintenance budget.

## 25.14 Final contract

```text
target description.md
    → defines what the project is intended to achieve

benchmark.txt
    → defines how the complete accepted project is exercised and observed

CLU-E cycle
    → improves both the implementation and the quality of observation

final Master Benchmark run
    → creates the vital baseline and candidate seeds for the next cycle
```

The Master Benchmark is not a static final exam. It is a living, versioned project instrument that matures with the project while remaining deterministic, comparable where possible, auditable, and bounded in cost.

---

# 26. Final policy statement

CLU-E should be designed to use AI wherever human-like interpretation, synthesis, creativity, or cross-evidence reasoning is required. It should simultaneously avoid using AI for facts and operations that deterministic project tools can establish directly.

The intended balance is:

```text
Maximum AI reasoning value
without maximum AI context consumption
```

CLU-E should consider every metric, but it should not repeatedly explain every metric to the model. It should recognize every project entity deterministically, but it should not ask AI to rediscover the repository. It should use strong models for architecture, experiments, patches, adjudication, and equilibrium, but it should first compress the problem into a precise evidence packet.

The governing rule is:

> Spend tokens on uncertainty, meaning, hypotheses, experiment design, and judgment. Do not spend them on facts already known, context already summarized, metrics already ruled out, or evidence already measured.

The configured `target description.md` gives that reasoning a stable semantic purpose. The evolving `benchmark.txt` gives the complete accepted project an increasingly capable instrument of observation. Candidate benchmarks prove individual changes; the Master Benchmark promotes durable lessons, closes each cycle, and supplies vital evidence to the next one.

With this architecture, token efficiency does not weaken CLU-E. It is what allows CLU-E to apply powerful AI repeatedly, deeply, and sustainably across the full Recursive Project Improvement lifecycle while improving both the project and the benchmark used to understand it.

---

# 27. 2026-08-14 executable-alignment amendment — provider budget authority

## 27.1 Operational provider and model identity

For the P2 reference installation, OpenAI is the active provider. ADR-0017 originally recorded
`gpt-5.6`. Its proposed ADR-0020 successor selects `gpt-5.6-sol` as the exact model identity for
enabled P2 routes. This revision requires Creator ratification before it governs P2 closure.

The adapter verifies access to the selected ID for the configured provider project and key before
submission. The provider's effective model must also match the request on completion. A missing
or different model causes refusal. Project Profiles record their selected model independently and
the runtime checks that selection against the applicable routing policy.

## 27.2 Money, usage and remaining allowance

OpenAI Platform/project/key is the sole authority for money, credit and provider billing limits.
CLU-E does not enforce a second local monetary ceiling and does not present locally estimated cost
as provider billing truth. It records exact provider-reported input, cached-input, output and total
tokens for durable analysis.

A remaining-token value may be displayed only when it comes from a provider-authoritative allowance
surface. In the absence of such a surface, remaining tokens are `UNAVAILABLE`, never inferred from
money or a local policy number.

## 27.3 Controlled provider-budget pause

A generic rate limit is not lack of money. Only explicit billing, credit or funding exhaustion
creates `PROVIDER_BUDGET_EXHAUSTED`. After the current durable write completes, new AI submissions
and a new CLU-E pipeline start are refused. Status and Q3 render `LACK OF $` and controlled pause.
Recovery requires an explicit exact-model probe followed by a durable provider-resumed event.

`REJECT`, `REVISE` and `INVALID` proof results remain durable evidence available to subsequent AI
analysis. Only an accepted proven improvement enters the Great Book as positive recursive memory.
