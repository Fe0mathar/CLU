# CLU-E Canonical Measurement Catalogue
## State-of-the-art, AI-reviewed quality, evidence, and improvement measures

**Document status:** permanent normative core-method companion to `RPI_Core_Methodology_v9.md`, `CLUE_Constitution_v9.md`, `CLUE_Architecture_v9.md`, `CLUE_Execution_Model_v9.md`, `CLUE_Git_Integration_v9.md`, `CLUE_Status_Contract_v9.md`, and `CLUE_Interface_Design_v9.md`  
**Catalogue revision:** 9.0 (pack-coordinated) — all 100 canonical identities and coordinates preserved unchanged from revision 6.0, which standardized Master Benchmark terminology and the v8 authority set without moving or repurposing any cell. Revision 9.0 adds Part II, the Golden Outcome Rail (`GOLD-01`–`GOLD-04`), integrated from the formerly standalone proposed supplement; the four Golden Metrics never occupy canonical 10 × 10 cells. Re-baselined into the coordinated v9 documentation pack; see `DOCUMENTATION_GOVERNANCE_v9.md` §14.  
**Language:** English  
**Primary subject:** the canonical measurement system used by CLU-E to recognize imperfection, rank findings, reconstruct and protect intent, evaluate method adequacy, design proof instruments and contracts, judge regressions, account for durable project value or assurance, and learn which measures remain useful over repeated RPI cycles, including Git-backed version integrity, reversible delivery, remote review/check provenance, cloud evidence durability, and recovery.  
**Intentionally out of scope:** target-specific benchmark implementation, fixed numerical thresholds for every target, authoritative financial valuation without target policy, current activation/results status, backlog, and detailed analyzer source code.

> **A metric is not truth. It is a disciplined question asked of evidence.**
>
> **No measure may define success by itself. Purpose, capabilities, workload, correctness, and admissible evidence remain mandatory.**
>
> **The Measurement Catalogue and its normalization profiles are themselves improved by CLU-E. Its effectiveness is reviewed against the Great Book after every cycle and at every equilibrium review.**
>
> **The Catalogue identifies what quality question is being asked. The proof authority identifies how an answer can be established. These are orthogonal: a performance, reliability, architectural, methodological, or perceptual improvement may require instrumented evidence, empirical evidence, or a governed combination of both.**

---

# 1. Core-method declaration

The Measurement Catalogue is one of CLU-E's core methods inside Recursive Project Improvement (RPI), alongside:

1. native-environment and cross-environment recognition;
2. the Universal Project Representation and dependency/capability graph;
3. purpose and intent recovery, problem classification, and method intelligence;
4. systematic multithreading and durable mission state;
5. validated proof instruments and frozen proof contracts;
6. local, capability, Master Benchmark, cross-environment, cross-platform, and controlled human benchmarks;
7. the Great Book and value-horizon accounting;
8. environment, capability, cross-environment, cross-platform, and whole-project passes;
9. multidimensional equilibrium.

Every assessment cycle is bound to an immutable catalogue version and hash. Every finding must name the measure or measures that exposed it. Every proof contract must identify:

- the local or systemic measure being improved;
- the improvement claim, target scope, and value or assurance hypothesis;
- the evidence authority: instrumented, empirical, or composite;
- the proof instrument, observable indicator, validation record, and pre-result freeze hash;
- the capability, Master Benchmark, cross-environment, cross-platform, and human-perceptual protections that apply;
- the global protective measures that must not regress;
- the mandatory preservation gates;
- the assurance conditions that make the evidence admissible.

The catalogue is not a static checklist. It is a versioned scientific instrument. The Great Book records whether each measure generated useful findings, false positives, duplicated other measures, missed regressions, encouraged metric gaming, or cost more than the knowledge it produced. Those records drive catalogue evolution.

The catalogue is intentionally easy to maintain. Every measure is one independent, stable-ID record loaded from a machine-readable registry and rendered into this Markdown companion. Prompts, dashboards, status exports, applicability tasks, and proof templates reference measure IDs rather than embedding private copies of the list. Adding, recalibrating, splitting, merging, deprecating, or retiring a measure therefore creates a new catalogue version without requiring a redesign of CLU-E's orchestration or data model.

AI evaluation of the catalogue is mandatory. CLU-E uses specialized reviewer sessions, including a frontier-model Measurement Auditor, a blind outcome reviewer, a regression/coverage critic, a metric-gaming adversary, and a cost analyst. They assess the catalogue against Great Book outcomes; they may propose changes, but no model may silently weaken purpose, capability, workload, correctness, evidence, regression, or reversibility gates.

Catalogue evaluation and ordinary measure assessment are executed as **CLU-E-owned model conversations**, not as independent `user → model` chats. The scheduler creates a durable logical session, chooses the strongest appropriate approved model for the risk and ambiguity of the task, provides only the smallest sufficient evidence-grounded context, preserves checkpoints outside the model window, orders independent refutation or synthesis roles, and records calls, input/output/cached tokens, cost, model version, terminal outcome, and later correctness. Token economy is optimized only after truth, purpose preservation, and independent challenge are protected.

---

# 2. Measurement architecture and canonical coordinate system

CLU-E separates four metric families that are displayed together but never conflated.

## 2.1 Target Quality Metrics — Areas A–H (`MA`–`MH`)

These assess properties of the Target Program, unit, workflow, capability, or whole system.

**Family key:** `TARGET_QUALITY`  
**Canonical color:** Neon Blue `#00a3e0`

Areas:

| Area | Canonical IDs | Subject |
|---|---|---|
| A | `MA01–MA06` | Purpose, value, and outcome |
| B | `MB01–MB07` | Functional, semantic, and data integrity |
| C | `MC01–MC15` | Architecture, maintainability, and comprehension |
| D | `MD01–MD10` | Performance, resource efficiency, and sustainability |
| E | `ME01–ME07` | Reliability, resilience, and safety |
| F | `MF01–MF06` | Security, privacy, provenance, and governance |
| G | `MG01–MG08` | Compatibility, flexibility, delivery, interaction, and cross-environment integrity |
| H | `MH01–MH03` | Transparency, system-wide synthesis, and method adequacy |

## 2.2 Evidence and Assurance Metrics — Area I (`MI`)

These assess whether CLU-E is justified in believing its conclusion.

**Family key:** `EVIDENCE_ASSURANCE`  
**Canonical color:** CLU-E Gold `#f4af2d`  
**Canonical IDs:** `MI01–MI12`

A Target Program can be excellent while evidence about it is weak. A finding can be real while a particular experiment is invalid. The interface and proof engine must preserve this distinction.

## 2.3 Mandatory Preservation and Acceptance Gates — Area J (`MJ`)

These are non-negotiable decision gates, not ordinary quality dimensions.

**Family key:** `ACCEPTANCE_GATES`  
**Canonical color:** Orange/Red `#ff5500`  
**Canonical IDs:** `MJ01–MJ07`

A failed applicable gate blocks `ACCEPTED_PROVEN`, regardless of positive movement elsewhere.

## 2.4 CLU-E Self-Metrics — Area K (`MK`)

These assess CLU-E’s own effectiveness, economy, orchestration, status fidelity, custody safety, and equilibrium credibility.

**Family key:** `CLUE_SELF`  
**Canonical color:** Analytical Green `#39ff88`  
**Canonical IDs:** `MK01–MK19`

Green is a permanent family color only inside metric visualizations and gauges. In lifecycle surfaces, green may still indicate candidate-worktree application, but the interface must distinguish family identity from lifecycle state through metric IDs, labels, geometry, and motion. Color alone is never sufficient.

## 2.5 Target-Specific Indicators (`I.*`)

Indicators are native observations supplied by a Target Program adapter or benchmark, such as FPS, p95 frame time, retained memory, error rate, accessibility conformance, or model accuracy.

Indicators provide evidence for one or more canonical metrics. They are not additional canonical metric coordinates and do not occupy ordinary cells in the Great Book Improvement Field unless promoted through a catalogue revision.

## 2.6 Canonical metric ID grammar

Every canonical metric uses:

```text
M + Area Letter + two-digit ordinal
```

Examples:

```text
MA01  first metric in Purpose / Value
MC04  fourth metric in Architecture
MI03  third Evidence / Assurance metric
MJ06  sixth mandatory gate
MK14  fourteenth CLU-E self-metric
```

Properties:

- the `M` prefix always means metric;
- the area letter identifies the stable subject district;
- the ordinal is stable within that area;
- IDs are immutable once referenced by a completed cycle, Great Book record, certificate, status artifact, or visualization;
- retired IDs are never reused;
- substantive semantic replacement receives a new ID;
- historic aliases remain resolvable.

## 2.7 Legacy alias compatibility

Catalogue v3 preserves deterministic aliases from v2:

```text
Q01–Q60  → MA01–MH02
A01–A11  → MI01–MI11
G01–G07  → MJ01–MJ07
S01–S18  → MK01–MK18
```

Catalogue v4 activates the four cells that were reserved in v3. The new IDs `MH03`, `MG08`, `MI12`, and `MK19` have no v2 legacy aliases. Historic coordinates 1–96 and every historic alias remain unchanged; no completed record is renumbered.

The exact one-to-one mapping is recorded in the coordinate table below and in the machine-readable registry. New records must use v6 canonical IDs. Historic records may display both canonical and legacy IDs.

## 2.8 Canonical 10 × 10 Great Book grid

The Great Book Improvement Field uses one stable 10 × 10 floor grid. Each metric owns one permanent cell. The coordinate is derived from the canonical order and never shifts because a label changes.

```text
gridIndex = 1..100
x = ((gridIndex - 1) mod 10) + 1
y = floor((gridIndex - 1) / 10) + 1
```

Allocation:

- cells 1–60: the v3 Target Quality district;
- cells 61–71: the v3 Evidence and Assurance district;
- cells 72–78: Acceptance Gates;
- cells 79–96: the v3 CLU-E Self-Metrics district;
- cell 97: `MH03` Method adequacy and applicable-frontier position;
- cell 98: `MG08` Cross-environment contract integrity and impedance;
- cell 99: `MI12` Evidence-plan and benchmark-synthesis validity;
- cell 100: `MK19` RPI value yield and horizon realization.

Catalogue v6 retains the v4 activation and v5 semantic contract for the frozen expansion cells rather than shifting any historic coordinate. Consequently, family districts remain visually recognizable but are no longer strictly contiguous. The family ID, label, and color remain authoritative categorical metadata; physical adjacency is never used to infer semantics.

The grid is a visual coordinate system, not a quality ranking. A metric’s physical position never implies greater importance.

### Canonical coordinate table

| Grid | X | Y | Canonical ID | Legacy ID | Family | Area | Metric |
|---:|---:|---:|---|---|---|---|---|
| 1 | 1 | 1 | `MA01` | `Q01` | `TARGET_QUALITY` | A | Purpose alignment |
| 2 | 2 | 1 | `MA02` | `Q02` | `TARGET_QUALITY` | A | Utility and value realization |
| 3 | 3 | 1 | `MA03` | `Q03` | `TARGET_QUALITY` | A | Capability preservation and evolution |
| 4 | 4 | 1 | `MA04` | `Q04` | `TARGET_QUALITY` | A | Workload integrity |
| 5 | 5 | 1 | `MA05` | `Q05` | `TARGET_QUALITY` | A | Stakeholder and user outcome |
| 6 | 6 | 1 | `MA06` | `Q06` | `TARGET_QUALITY` | A | Economy and total cost of ownership |
| 7 | 7 | 1 | `MB01` | `Q07` | `TARGET_QUALITY` | B | Functional completeness |
| 8 | 8 | 1 | `MB02` | `Q08` | `TARGET_QUALITY` | B | Functional correctness |
| 9 | 9 | 1 | `MB03` | `Q09` | `TARGET_QUALITY` | B | Contract and API conformance |
| 10 | 10 | 1 | `MB04` | `Q10` | `TARGET_QUALITY` | B | State and data integrity |
| 11 | 1 | 2 | `MB05` | `Q11` | `TARGET_QUALITY` | B | Temporal and concurrency correctness |
| 12 | 2 | 2 | `MB06` | `Q12` | `TARGET_QUALITY` | B | Determinism and controlled variability |
| 13 | 3 | 2 | `MB07` | `Q13` | `TARGET_QUALITY` | B | Numerical and precision integrity |
| 14 | 4 | 2 | `MC01` | `Q14` | `TARGET_QUALITY` | C | Complexity proportionality |
| 15 | 5 | 2 | `MC02` | `Q15` | `TARGET_QUALITY` | C | Architectural coherence |
| 16 | 6 | 2 | `MC03` | `Q16` | `TARGET_QUALITY` | C | Cohesion |
| 17 | 7 | 2 | `MC04` | `Q17` | `TARGET_QUALITY` | C | Coupling and dependency surface |
| 18 | 8 | 2 | `MC05` | `Q18` | `TARGET_QUALITY` | C | Modularity and replaceability |
| 19 | 9 | 2 | `MC06` | `Q19` | `TARGET_QUALITY` | C | Boundary and interface quality |
| 20 | 10 | 2 | `MC07` | `Q20` | `TARGET_QUALITY` | C | Responsibility concentration |
| 21 | 1 | 3 | `MC08` | `Q21` | `TARGET_QUALITY` | C | Redundancy |
| 22 | 2 | 3 | `MC09` | `Q22` | `TARGET_QUALITY` | C | Dead code |
| 23 | 3 | 3 | `MC10` | `Q23` | `TARGET_QUALITY` | C | Obsolescence |
| 24 | 4 | 3 | `MC11` | `Q24` | `TARGET_QUALITY` | C | Technical debt |
| 25 | 5 | 3 | `MC12` | `Q25` | `TARGET_QUALITY` | C | Architectural entropy and evolvability |
| 26 | 6 | 3 | `MC13` | `Q26` | `TARGET_QUALITY` | C | Analyzability and understandability |
| 27 | 7 | 3 | `MC14` | `Q27` | `TARGET_QUALITY` | C | Testability |
| 28 | 8 | 3 | `MC15` | `Q28` | `TARGET_QUALITY` | C | Observability |
| 29 | 9 | 3 | `MD01` | `Q29` | `TARGET_QUALITY` | D | Intrinsic efficiency |
| 30 | 10 | 3 | `MD02` | `Q30` | `TARGET_QUALITY` | D | Cost amplification |
| 31 | 1 | 4 | `MD03` | `Q31` | `TARGET_QUALITY` | D | Critical-path influence |
| 32 | 2 | 4 | `MD04` | `Q32` | `TARGET_QUALITY` | D | Throughput and latency |
| 33 | 3 | 4 | `MD05` | `Q33` | `TARGET_QUALITY` | D | Tail behavior and cost predictability |
| 34 | 4 | 4 | `MD06` | `Q34` | `TARGET_QUALITY` | D | Memory and resource lifecycle |
| 35 | 5 | 4 | `MD07` | `Q35` | `TARGET_QUALITY` | D | I/O, network, and storage efficiency |
| 36 | 6 | 4 | `MD08` | `Q36` | `TARGET_QUALITY` | D | Scalability |
| 37 | 7 | 4 | `MD09` | `Q37` | `TARGET_QUALITY` | D | Degradation shape and resource adaptability |
| 38 | 8 | 4 | `MD10` | `Q38` | `TARGET_QUALITY` | D | Energy and carbon efficiency |
| 39 | 9 | 4 | `ME01` | `Q39` | `TARGET_QUALITY` | E | Reliability and availability |
| 40 | 10 | 4 | `ME02` | `Q40` | `TARGET_QUALITY` | E | Fragility and blast radius |
| 41 | 1 | 5 | `ME03` | `Q41` | `TARGET_QUALITY` | E | Fault isolation and containment |
| 42 | 2 | 5 | `ME04` | `Q42` | `TARGET_QUALITY` | E | Resilience and recovery |
| 43 | 3 | 5 | `ME05` | `Q43` | `TARGET_QUALITY` | E | Graceful degradation and fallback quality |
| 44 | 4 | 5 | `ME06` | `Q44` | `TARGET_QUALITY` | E | Reversibility and rollback |
| 45 | 5 | 5 | `ME07` | `Q45` | `TARGET_QUALITY` | E | Safety and fail-safe behavior |
| 46 | 6 | 5 | `MF01` | `Q46` | `TARGET_QUALITY` | F | Security |
| 47 | 7 | 5 | `MF02` | `Q47` | `TARGET_QUALITY` | F | Privacy and data minimization |
| 48 | 8 | 5 | `MF03` | `Q48` | `TARGET_QUALITY` | F | Supply-chain and provenance integrity |
| 49 | 9 | 5 | `MF04` | `Q49` | `TARGET_QUALITY` | F | Abuse and misuse resistance |
| 50 | 10 | 5 | `MF05` | `Q50` | `TARGET_QUALITY` | F | Autonomy appropriateness and human control |
| 51 | 1 | 6 | `MF06` | `Q51` | `TARGET_QUALITY` | F | Auditability, accountability, and policy conformance |
| 52 | 2 | 6 | `MG01` | `Q52` | `TARGET_QUALITY` | G | Compatibility and interoperability |
| 53 | 3 | 6 | `MG02` | `Q53` | `TARGET_QUALITY` | G | Backward and forward compatibility |
| 54 | 4 | 6 | `MG03` | `Q54` | `TARGET_QUALITY` | G | Portability |
| 55 | 5 | 6 | `MG04` | `Q55` | `TARGET_QUALITY` | G | Adaptability and plasticity |
| 56 | 6 | 6 | `MG05` | `Q56` | `TARGET_QUALITY` | G | Deployability and operability |
| 57 | 7 | 6 | `MG06` | `Q57` | `TARGET_QUALITY` | G | Accessibility, inclusivity, and usability |
| 58 | 8 | 6 | `MG07` | `Q58` | `TARGET_QUALITY` | G | Reusability and generalization |
| 59 | 9 | 6 | `MH01` | `Q59` | `TARGET_QUALITY` | H | Explainability and transparency |
| 60 | 10 | 6 | `MH02` | `Q60` | `TARGET_QUALITY` | H | Quality balance and Pareto integrity |
| 61 | 1 | 7 | `MI01` | `A01` | `EVIDENCE_ASSURANCE` | I | Purpose-context sufficiency |
| 62 | 2 | 7 | `MI02` | `A02` | `EVIDENCE_ASSURANCE` | I | Measurement validity |
| 63 | 3 | 7 | `MI03` | `A03` | `EVIDENCE_ASSURANCE` | I | Benchmark representativeness |
| 64 | 4 | 7 | `MI04` | `A04` | `EVIDENCE_ASSURANCE` | I | Coverage completeness |
| 65 | 5 | 7 | `MI05` | `A05` | `EVIDENCE_ASSURANCE` | I | Causal attribution |
| 66 | 6 | 7 | `MI06` | `A06` | `EVIDENCE_ASSURANCE` | I | Confidence and uncertainty calibration |
| 67 | 7 | 7 | `MI07` | `A07` | `EVIDENCE_ASSURANCE` | I | Knowledge freshness |
| 68 | 8 | 7 | `MI08` | `A08` | `EVIDENCE_ASSURANCE` | I | Instrument self-validity and observer effect |
| 69 | 9 | 7 | `MI09` | `A09` | `EVIDENCE_ASSURANCE` | I | Reproducibility and replicability |
| 70 | 10 | 7 | `MI10` | `A10` | `EVIDENCE_ASSURANCE` | I | Regression sensitivity |
| 71 | 1 | 8 | `MI11` | `A11` | `EVIDENCE_ASSURANCE` | I | Scope-of-claim integrity and residual unknowns |
| 72 | 2 | 8 | `MJ01` | `G01` | `ACCEPTANCE_GATES` | J | Purpose Preservation |
| 73 | 3 | 8 | `MJ02` | `G02` | `ACCEPTANCE_GATES` | J | Capability Preservation |
| 74 | 4 | 8 | `MJ03` | `G03` | `ACCEPTANCE_GATES` | J | Workload Integrity |
| 75 | 5 | 8 | `MJ04` | `G04` | `ACCEPTANCE_GATES` | J | Correctness and Contract Integrity |
| 76 | 6 | 8 | `MJ05` | `G05` | `ACCEPTANCE_GATES` | J | Evidence Admissibility |
| 77 | 7 | 8 | `MJ06` | `G06` | `ACCEPTANCE_GATES` | J | Global Regression Guardrail |
| 78 | 8 | 8 | `MJ07` | `G07` | `ACCEPTANCE_GATES` | J | Reversibility and Recovery |
| 79 | 9 | 8 | `MK01` | `S01` | `CLUE_SELF` | K | Cost per proven improvement |
| 80 | 10 | 8 | `MK02` | `S02` | `CLUE_SELF` | K | Time to terminal disposition |
| 81 | 1 | 9 | `MK03` | `S03` | `CLUE_SELF` | K | Finding precision |
| 82 | 2 | 9 | `MK04` | `S04` | `CLUE_SELF` | K | Regression escape rate |
| 83 | 3 | 9 | `MK05` | `S05` | `CLUE_SELF` | K | Repeated-work rate |
| 84 | 4 | 9 | `MK06` | `S06` | `CLUE_SELF` | K | Coverage and uncertainty reduction |
| 85 | 5 | 9 | `MK07` | `S07` | `CLUE_SELF` | K | Forecast calibration |
| 86 | 6 | 9 | `MK08` | `S08` | `CLUE_SELF` | K | Instrument validity rate |
| 87 | 7 | 9 | `MK09` | `S09` | `CLUE_SELF` | K | Test-catalogue efficiency |
| 88 | 8 | 9 | `MK10` | `S10` | `CLUE_SELF` | K | Mission continuity |
| 89 | 9 | 9 | `MK11` | `S11` | `CLUE_SELF` | K | Custody safety |
| 90 | 10 | 9 | `MK12` | `S12` | `CLUE_SELF` | K | Equilibrium credibility |
| 91 | 1 | 10 | `MK13` | `S13` | `CLUE_SELF` | K | Measure-session token efficiency |
| 92 | 2 | 10 | `MK14` | `S14` | `CLUE_SELF` | K | Model-routing value |
| 93 | 3 | 10 | `MK15` | `S15` | `CLUE_SELF` | K | Catalogue maintainability |
| 94 | 4 | 10 | `MK16` | `S16` | `CLUE_SELF` | K | Catalogue-review effectiveness |
| 95 | 5 | 10 | `MK17` | `S17` | `CLUE_SELF` | K | Conversation-orchestration integrity |
| 96 | 6 | 10 | `MK18` | `S18` | `CLUE_SELF` | K | Status fidelity |
| 97 | 7 | 10 | `MH03` | — | `TARGET_QUALITY` | H | Method adequacy and applicable-frontier position |
| 98 | 8 | 10 | `MG08` | — | `TARGET_QUALITY` | G | Cross-environment contract integrity and impedance |
| 99 | 9 | 10 | `MI12` | — | `EVIDENCE_ASSURANCE` | I | Evidence-plan and benchmark-synthesis validity |
| 100 | 10 | 10 | `MK19` | — | `CLUE_SELF` | K | RPI value yield and horizon realization |

## 2.9 Four-family color policy

The family color is categorical metadata. It does not decide verdict, magnitude, freshness, or lifecycle.

| Family | Base color | Meaning in the field |
|---|---|---|
| `TARGET_QUALITY` | `#00a3e0` | proven change in the assessed program |
| `EVIDENCE_ASSURANCE` | `#f4af2d` | change in the strength, admissibility, coverage, or trustworthiness of evidence |
| `ACCEPTANCE_GATES` | `#ff5500` | gate state, hardening, failure, or recovery |
| `CLUE_SELF` | `#39ff88` | change in CLU-E’s own effectiveness and integrity |

Rules:

1. family colors are stable across targets, cycles, status exports, gauges, and Great Book history;
2. lifecycle state is an orthogonal channel expressed through motion, cap glyphs, outlines, labels, and status text;
3. negative contribution is shown below the floor and receives an orange/red fault core while retaining a family-identifying edge;
4. selected cells receive a Gold focus halo without replacing the family color;
5. stale or low-confidence evidence reduces opacity, never changes family identity;
6. color is always accompanied by an ID and label for accessibility and auditability.


# 3. General rules

## 3.1 No universal scalar score

CLU-E must not collapse the catalogue into one opaque number. Software quality is multi-objective. A single score hides trade-offs and invites gaming.

The canonical result is a **quality vector** containing:

- applicable measures;
- values or evidence-backed assessments;
- confidence;
- scope;
- limitations;
- purpose relationship;
- regression relationship.

A composite score may be displayed for navigation only when every component, weight, normalization rule, and uncertainty is visible. It never has verdict authority by itself.

## 3.2 Applicability is explicit

Not every measure applies to every function, file, module, or target. Each measure receives one applicability state:

```text
REQUIRED
APPLICABLE
CONDITIONAL
NOT_APPLICABLE
UNKNOWN
CONFLICTED
```

`NOT_APPLICABLE` requires a reason. `UNKNOWN` creates a recognition or instrumentation task. It does not silently become a pass.

## 3.3 Measure types

A measure may produce:

```text
numeric
boolean
ordinal
categorical
vector
curve or distribution
evidence-backed qualitative assessment
unknown
conflicted
not applicable
```

CLU-E must not fabricate a number where the evidence supports only a categorical judgment.

## 3.3A Evidence authorities and proof instruments

Measure type and proof authority are separate dimensions.

The two primary evidence authorities are:

```text
INSTRUMENTED
EMPIRICAL
```

`INSTRUMENTED` evidence includes:

- analytic or exact proof, including operation counts, complexity properties, invariant proofs, schema equivalence, and deterministic constraint checks;
- quantitative experimental proof, including CPU, GPU, memory, size, energy, latency, throughput, allocation, transfer, reliability, and other controlled measurements;
- constraint/conformance proof, where a registered violation changes to a verified pass without unacceptable regression.

`EMPIRICAL` evidence includes:

- central, capability, scenario, cross-environment, cross-platform, or production outcome evidence;
- controlled human-perceptual or expert judgment where the claimed property is genuinely visual, interactive, experiential, semantic, or otherwise not reducible to one objective local number.

A proof contract may require `COMPOSITE` evidence from both authorities. For example, a shader optimization can require lower GPU time under an instrumented benchmark, an unchanged visual-equivalence gate, a non-regressing Master Benchmark, and a controlled human comparison for perceived quality.

The AI may author a benchmark or evaluation protocol, but authorship is not validity. Before candidate results are available, the instrument must be independently reviewed or self-validated for:

- claim alignment;
- workload representativeness;
- calibration and units;
- sensitivity to meaningful change;
- repeatability and noise;
- observer effect;
- gaming and work-reduction resistance;
- baseline/candidate symmetry;
- decision rule and uncertainty;
- freeze identity.

A benchmark created or modified after reading the candidate result cannot provide decisive proof for that candidate unless a new independent baseline/candidate experiment is run under the newly frozen instrument.

## 3.4 Purpose inheritance

Every local measure is interpreted inside the hierarchy:

```text
Program
└── Domain
    └── Subsystem
        └── Module
            └── File
                └── Class / Type
                    └── Function / Method
```

A local optimization is invalid when it damages the purpose or required capabilities of a parent level.

## 3.4A Native-environment, capability, cross-environment, and platform scope

Every instantiated measure declares its assessment scope:

```text
NATIVE_ARTIFACT
NATIVE_UNIT
ENVIRONMENT
CAPABILITY_SLICE
CROSS_ENVIRONMENT_BOUNDARY
CROSS_PLATFORM_SCENARIO
WHOLE_PROGRAM
RPI_ENGINE
```

A TypeScript function, WGSL shader, Python tool, SQL query, JSON contract, Docker image, browser scenario, and GPU platform are not interchangeable measurement surfaces. Each native environment uses its own parser, semantics, tools, indicators, and proof methods. The Universal Project Representation makes relations comparable without erasing native details.

Cross-environment assessment asks whether independently valid components cooperate correctly and efficiently. It covers schema/layout/unit/version consistency, serialization and memory-copy cost, responsibility placement, duplicated logic, ownership, change propagation, error semantics, lifecycle mismatch, and platform assumptions.

A whole-project or equilibrium claim must declare the environments and platforms covered. Unsupported or opaque required surfaces remain residual unknowns; they cannot be converted into a passing score.

## 3.5 Comparison and baseline

A change-related claim requires an explicit comparison:

- before versus after;
- baseline versus patched;
- target versus known-good reference;
- current curve versus required envelope;
- current architecture versus declared contract.

The comparison method is frozen before results are interpreted.

## 3.5A Improvement value and value horizon

RPI separates **proof of technical change** from **valuation of that change**.

A technically proven improvement may create:

- direct operating savings;
- avoided capital or infrastructure cost;
- reduced developer or operator effort;
- increased throughput, capacity, availability, quality, or user outcome;
- reduced expected loss from failure, security, compliance, or safety risk;
- non-monetized assurance required by mission or policy.

For economic decisions, the target profile declares a value horizon and the assumptions used to estimate lifetime value. Forecast and realized value remain separate. A small per-operation saving can justify substantial initial token and validation spend when execution volume and lifetime make the cumulative value material. Conversely, a large local percentage with negligible lifetime effect may not justify its risk or complexity.

The default economic comparison is:

```text
expected lifetime value or assurance benefit
>
search cost + implementation cost + validation cost + expected risk cost
```

This is a prioritization and stopping rule, not a universal gate. Assurance campaigns may continue when monetary return is unknown or negative if the mission requires higher reliability, security, safety, correctness, or confidence.

---

## 3.6 Maintainable registry and single source of truth

The normative human-readable catalogue and the machine-readable registry must represent the same content hash. The production source of truth is a schema-validated registry containing one record per measure, assurance measure, gate, indicator profile, and self-measure.

Required properties:

- stable IDs survive wording and implementation changes;
- each record can be added, revised, deprecated, or retired independently;
- no measure list is duplicated in prompts, UI code, status schemas, or analyzers;
- generated Markdown remains reviewable by humans;
- catalogue diffs show semantic changes, not regenerated noise;
- compatibility aliases allow historic records to resolve retired IDs;
- every cycle binds to one immutable catalogue hash;
- runtime code rejects a registry whose generated Markdown or schema hash disagrees.

A target profile activates and configures canonical measures; it does not fork their meaning without a new profile version.

## 3.7 Logical Measure Assessment Sessions

Every `REQUIRED` or `APPLICABLE` measure for a recognized unit produces a logical session identity:

```text
(target_id, scope_id, environment_set, measure_id, snapshot_id, pass_id, catalogue_hash)
```

A logical session is an auditable epistemic boundary. It may map to one interactive API conversation, one Batch item, or a resumed sequence of calls. Physical batching is permitted for economy, but evidence, prompts, outputs, confidence, cost, and terminal state remain isolated per logical session.

Valid terminal outcomes include proven improvement, no imperfection found, refuted hypothesis, regression, purpose violation, insufficient context, inconclusive/invalid experiment, duplicate, expert omission, and reasoned deferral. A measure session is never forced to manufacture a patch.

## 3.8 CLU-E-driven model orchestration

The user does not manually conduct thousands of model conversations. CLU-E drives them through the Model Orchestrator. For every measure session it:

1. selects the model and execution lane;
2. constructs the smallest sufficient context pack;
3. states purpose, scope, measure, evidence and completion criteria;
4. validates the response schema and citations;
5. asks the next turn only when required by missing evidence or refutation;
6. escalates to a stronger model when risk, uncertainty or novelty crosses policy;
7. launches independent refutation for consequential claims;
8. stores checkpoints, token/call use and terminal outcome;
9. records whether the session concerns native implementation, intent recovery, problem classification, method landscape, applicability, proof-instrument design, empirical evaluation, value estimation, or equilibrium;
10. binds method-intelligence conclusions to a versioned knowledge-source snapshot and freshness policy.

Frontier models are reserved for purpose reconstruction, system reasoning, causal diagnosis, proof design, patch design, adversarial review and global synthesis. Deterministic tools, cached facts, Batch, and smaller models handle extraction, normalization, applicability screening and low-risk repetition. This is quality-maximizing orchestration under explicit token economy, not indiscriminate cost cutting.

## 3.9 Native evidence and normalized visualization

Every metric result stores two parallel representations:

```text
native evidence
+
normalized visualization contribution
```

The native representation is authoritative and contains the real unit, baseline, result, distribution, direction, uncertainty, benchmark, scope, and limitations. The normalized representation exists only to compare and visualize heterogeneous metrics.

CLU-E must never add FPS, bytes, milliseconds, percentages, categorical judgments, and gate states directly.

## 3.10 Normalization Profile

Every canonical metric owns a versioned `NormalizationProfile`:

```yaml
metric_id: MA01
profile_version: 1
profile_hash: sha256
method: threshold_bands | relative_change | distance_to_target |
        noise_adjusted_effect | distribution_shift | categorical_map |
        gate_state | target_profile_composite
direction: higher_is_better | lower_is_better | target_range |
           categorical | bidirectional
native_unit: string | categorical
gray_area: optional
meaningful_threshold: optional
exceptional_threshold: optional
clamp: [-100, 100]
target_profile_overrides: []
```

A profile change creates a new version and hash. It never rewrites historical contributions.

## 3.11 Contribution pipeline

For one Great Book result:

```text
native effect
→ metric-specific magnitude score [-100, +100]
→ evidence confidence factor [0,1]
→ freshness factor [0,1]
→ optional visible scope factor
→ normalized contribution
```

Recommended default:

```text
normalizedContribution =
    magnitudeScore
  × evidenceConfidence
  × freshnessFactor
```

Scope or strategic weights may be applied only in an explicitly selected comparison mode and must remain visible. They do not alter the underlying Great Book record.

A mandatory gate failure cannot be transformed into a positive contribution. Purpose violation, capability loss, workload reduction, inadmissible evidence, or failed global regression guardrail blocks the positive improvement record.

## 3.12 Bounded stacked-column aggregation

The default field shows current certified evidence and must remain comparable across metrics with different numbers of historic experiments.

For contributions `cᵢ`:

```text
positive = Σ max(cᵢ, 0)
negative = Σ max(-cᵢ, 0)

upHeight   = 100 × (1 - exp(-positive / 100))
downHeight = -100 × (1 - exp(-negative / 100))
```

Each Great Book segment receives the marginal height it adds to the bounded column. This preserves the stacked history while preventing old or frequently tested metrics from becoming arbitrarily tall merely because they have more records.

The inspector always exposes:

- native baseline and result;
- native unit;
- unadjusted magnitude score;
- confidence and freshness factors;
- normalized contribution;
- exact Great Book record and proof contract;
- whether the contribution remains certified.

## 3.13 Aggregation modes

The field supports explicit modes:

- `CURRENT_CERTIFIED` — default; only currently valid, non-invalidated evidence;
- `SELECTED_CYCLE` — contributions created in one cycle;
- `HISTORICAL_NET` — complete positive and negative history;
- `CONFIDENCE_ADJUSTED` — certified history adjusted by evidence and freshness;
- `AVERAGE_PER_EXPERIMENT` — useful when comparing measures with unequal activity;
- `EXPERIMENT_COUNT` — density/attention view, never called improvement;
- `COVERAGE` — assessment coverage rather than improvement;
- `EQUILIBRIUM` — clean-pass and residual-uncertainty state.

The active mode must be permanently visible. A renderer may not call one mode by another name.

## 3.14 Great Book contribution identity

Every stack segment is one immutable contribution:

```yaml
contribution_id: MCON-...
great_book_record_id: GBR-...
metric_id: MC04
legacy_metric_id: Q17
catalogue_hash: sha256
normalization_profile_hash: sha256
target_id: TGT-...
scope_id: UNIT-... | ENV-... | BOUNDARY-... | PLATFORM-... | CAP-... | DOMAIN-... | PROGRAM-...
environment_ids: [ENV-...]
cycle_id: CYC-...
evidence_authority: INSTRUMENTED | EMPIRICAL | COMPOSITE
proof_instrument_id: INS-...
method_opportunity_id: optional
native:
  baseline: ...
  result: ...
  delta: ...
  unit: ...
normalized:
  magnitude_score: -100..100
  evidence_confidence: 0..1
  freshness_factor: 0..1
  contribution: -100..100
verdict: ...
certificate_status: active | invalidated | expired
proof_contract_id: ...
value:
  horizon_id: VH-...
  forecast_value: optional
  realized_value: optional
  assurance_gain: optional
  attribution_confidence: 0..1
```

One improvement may contribute to multiple metrics, but it has exactly one primary metric and zero or more secondary contributions. Contribution weights must not double-count one native effect as several independent achievements.

## 3.15 Four configurable neon gauges

The Dashboard contains exactly four gauge projections. Each gauge selects one canonical metric or one explicitly defined family aggregate.

Every gauge shows:

- metric ID and name;
- family color;
- native value and unit;
- normalized value or gate state;
- delta and trend;
- confidence;
- coverage;
- freshness;
- selected scope and aggregation mode;
- warning when the result is unknown, stale, gray-area, or not applicable.

A gauge cannot invent a percentage for a categorical metric. It uses the metric’s registered projection type: signed normalized score, percentage, count, ratio, ordinal, gate state, or distribution summary.

## 3.16 Measurement visualization is non-authoritative

The 3D field and gauges are projections over the Great Book, catalogue, normalization profiles, certificates, and status contract. They may aggregate and focus evidence, but they never replace native evidence, issue verdicts, change catalogue definitions, or create Great Book records.


# 4. Canonical Target Quality Measures

## Area A — Purpose, value, and outcome (`MA`)

### MA01 — Purpose alignment

**Question:** Does the unit and the complete program still serve the reason they exist?  
**Evidence:** Purpose Records, mission documents, user-visible outcomes, contracts, scenarios, Creator declarations.  
**Failure patterns:** metric improvement by narrowing or redefining purpose; local convenience overriding the program mission.  
**Typical verdict impact:** failure triggers `REJECTED_PURPOSE_VIOLATION`.

### MA02 — Utility and value realization

**Question:** Does the unit deliver real value to users, the system, the Creator, or a protected recovery/safety path?  
**Evidence:** use frequency, dependent capabilities, user impact, strategic value, recovery role, cost of absence.  
**Failure patterns:** elegant but unused features; legacy functions with no current value; expensive mechanisms with negligible outcome.

### MA03 — Capability preservation and evolution

**Question:** Are required capabilities preserved, and are newly claimed capabilities real and verifiable?  
**Evidence:** Capability Inventory, approved scenarios, public contracts, integration tests, runtime facts.  
**Failure patterns:** higher FPS through disabling a feature; API simplification that removes supported cases; silent capability degradation.

### MA04 — Workload integrity

**Question:** Did the improved result come from doing the same required work, rather than skipping, reducing, caching incorrectly, or hiding it?  
**Evidence:** completed-work counters, entity counts, simulation steps, visual outputs, scenario checkpoints, workload hashes.  
**Failure patterns:** rendering fewer objects; reducing simulation frequency; bypassing expensive validation; changing the benchmark workload.

### MA05 — Stakeholder and user outcome

**Question:** Does the change improve or preserve outcomes experienced by the people and systems the target exists to serve?  
**Evidence:** task success, error rates, interaction outcomes, expert evaluation, user-visible latency, accessibility, safety impact.  
**Failure patterns:** internal optimization that worsens user experience or operator burden.

### MA06 — Economy and total cost of ownership

**Question:** Is the delivered outcome proportional to total cost over the lifecycle?  
**Evidence:** CPU/GPU time, memory, energy, network, storage, AI calls, maintenance effort, operational burden, licensing, test cost.  
**Failure patterns:** moving cost to another layer; reducing runtime cost while greatly increasing maintenance or infrastructure cost.

---

## Area B — Functional, semantic, and data integrity (`MB`)

### MB01 — Functional completeness

**Question:** Does the system implement all required functions in the assessed scope?  
**Evidence:** capability inventory, requirements traceability, scenario coverage, missing-path analysis.  
**Failure patterns:** optimization that silently removes edge cases or partial functionality.

### MB02 — Functional correctness

**Question:** Does the system produce the correct output and state for valid inputs and expected conditions?  
**Evidence:** unit, contract, integration, scenario, property-based, and reference tests.  
**Failure patterns:** faster execution with incorrect results; success indicated before the authoritative fact exists.

### MB03 — Contract and API conformance

**Question:** Are public and internal contracts respected, versioned, and used as intended?  
**Evidence:** type contracts, schemas, protocol tests, payload validation, consumer/provider compatibility.  
**Failure patterns:** request treated as fact; payload drift; undocumented breaking change; internal detail leaked as public API.

### MB04 — State and data integrity

**Question:** Is authoritative state correct, consistent, durable where required, and free from contradictory sources of truth?  
**Evidence:** authority maps, persistence tests, transaction tests, replay, hash comparison, invariants.  
**Failure patterns:** writing a derived copy; lost updates; duplicated authority; stale cache presented as truth.

### MB05 — Temporal and concurrency correctness

**Question:** Are ordering, timing, synchronization, races, cancellation, and exactly-once/at-most-once guarantees correct?  
**Evidence:** deterministic schedules, race probes, event ordering, lease tests, queue histories, terminal-outcome checks.  
**Failure patterns:** state advanced on request rather than confirmation; double completion; race-dependent behavior.

### MB06 — Determinism and controlled variability

**Question:** For the same controlled input, is the result repeatable where required, and is intentional variability explainable and bounded?  
**Evidence:** seeded replays, distribution comparison, event-sequence hashes, environment declarations.  
**Failure patterns:** load-order dependence, uncontrolled randomness, hardware-dependent divergence without an envelope.

### MB07 — Numerical and precision integrity

**Question:** Are calculations stable, sufficiently precise, correctly bounded, and resistant to overflow, underflow, drift, and accumulated error?  
**Evidence:** reference calculations, tolerance tests, long-run drift, extreme-value tests, deterministic numeric fixtures.  
**Failure patterns:** faster approximation outside fidelity policy; unstable geometry; precision loss that appears only at scale.

---

## Area C — Architecture, maintainability, and comprehension (`MC`)

### MC01 — Complexity proportionality

**Question:** Is implementation and cognitive complexity proportional to the responsibility and value delivered?  
**Evidence:** state count, branches, exception paths, dependencies, hidden assumptions, change effort, cognitive complexity.  
**Failure patterns:** large framework for a small task; accidental state machine; complexity reduced by hiding behavior rather than simplifying it.

### MC02 — Architectural coherence

**Question:** Does the unit follow the current architecture, authority model, lifecycle, and common system patterns?  
**Evidence:** architecture claims, pattern conformance, domain rules, source-of-truth boundaries, lifecycle tests.  
**Failure patterns:** a new local standard; foreign-body subsystem; bypass of shared infrastructure.

### MC03 — Cohesion

**Question:** Do the responsibilities grouped inside a unit belong together and change for related reasons?  
**Evidence:** responsibility map, change history, call and data clusters, purpose records.  
**Failure patterns:** unrelated behavior packed into one manager; file serving several independent domains.

### MC04 — Coupling and dependency surface

**Question:** How strongly and in how many ways does the unit depend on or influence other units?  
**Evidence:** directed graph, weighted edge types, reverse impact, shared state, dynamic edges, authority crossings.  
**Failure patterns:** hidden temporal coupling; broad fan-in/fan-out; string dispatch; shared mutable state.

### MC05 — Modularity and replaceability

**Question:** Can the unit be isolated, disabled, tested, versioned, replaced, or independently evolved through a stable boundary?  
**Evidence:** interface tests, dependency inversion, feature toggles, independent fixtures, replacement experiments.  
**Failure patterns:** logic permanently embedded in the runtime; no seam for testing or replacement.

### MC06 — Boundary and interface quality

**Question:** Are boundaries small, explicit, stable, validated, and free of implementation leakage?  
**Evidence:** API size, schema precision, error contracts, versioning, adapter boundaries, boundary tests.  
**Failure patterns:** wide interfaces; ambiguous errors; implicit global state; duplicated boundary models.

### MC07 — Responsibility concentration

**Question:** Has too much authority, state, or coordination accumulated in one function, class, file, or module?  
**Evidence:** centrality, responsibility count, touched domains, owned state, change frequency, blast radius.  
**Failure patterns:** god objects, universal managers, one module controlling unrelated systems.

### MC08 — Redundancy

**Question:** Does active behavior, data, state, infrastructure, or authority unnecessarily duplicate another implementation?  
**Evidence:** semantic similarity, parallel code paths, duplicate caches, duplicated schemas, dual authorities.  
**Failure patterns:** two active render paths; repeated normalization; separate local standards.

### MC09 — Dead code

**Question:** Is the unit proven unused in the declared evidence envelope?  
**Evidence:** static reachability, registrations, reflection/string search, runtime traces, configuration, public consumers, recovery roles.  
**Failure patterns:** declaring code dead because no direct caller is visible; deleting dormant recovery or feature-gated paths.

### MC10 — Obsolescence

**Question:** Does the unit still fit current architecture, dependencies, platforms, and supported workflows?  
**Evidence:** current patterns, deprecation records, replacement paths, compatibility matrix, usage and maintenance history.  
**Failure patterns:** code retained only because removal is difficult; new code written against an already superseded approach.

### MC11 — Technical debt

**Question:** What deliberate or accidental compromise exists, why, at what cost, and under what removal condition?  
**Evidence:** debt records, owner, age, interest cost, blocked changes, defect association, exit condition.  
**Failure patterns:** TODO without owner; permanent temporary adapter; debt hidden as ordinary architecture.

### MC12 — Architectural entropy and evolvability

**Question:** Is the architecture becoming more ordered and easier to extend, or accumulating exceptions and unpredictable change propagation?  
**Evidence:** exception count, naming divergence, boundary erosion, graph growth, change amplification, local standards.  
**Failure patterns:** every feature requires another special case; responsibilities become less clear after each patch.

### MC13 — Analyzability and understandability

**Question:** Can a competent human or AI reconstruct what the unit does, why it exists, and what will be affected by change?  
**Evidence:** purpose confidence, source clarity, graph completeness, documentation, naming, traceability, onboarding effort.  
**Failure patterns:** behavior discoverable only through tribal knowledge; misleading names; purpose inferred from one weak clue.

### MC14 — Testability

**Question:** Can behavior be isolated, controlled, observed, reproduced, and falsified at reasonable cost?  
**Evidence:** deterministic fixtures, test seams, scenario controls, stable outputs, coverage, test cost and flakiness.  
**Failure patterns:** only end-to-end manual verification; no authoritative observable output; hidden clock or global state.

### MC15 — Observability

**Question:** Does the unit reveal enough state, timing, errors, degradation, and causal context to diagnose and prove behavior?  
**Evidence:** logs, metrics, traces, health reports, state snapshots, attribution, last-activity and fallback declarations.  
**Failure patterns:** silent fallback; warning without source; black-box subsystem; telemetry removed to make the system look clean.

---

## Area D — Performance, resource efficiency, and sustainability (`MD`)

### MD01 — Intrinsic efficiency

**Question:** Does the unit perform required work with minimal inherent waste, even when current hardware hides the cost?  
**Evidence:** operation counts, allocations, copies, transfers, redundant work, cache hit/miss behavior.  
**Failure patterns:** per-frame allocations; avoidable data copies; repeated parsing; polling while idle.

### MD02 — Cost amplification

**Question:** How does a small unit cost multiply through frequency, scale, duration, concurrency, or fan-out?  
**Evidence:** unit cost × invocation rate × object/user count × duration × concurrency.  
**Failure patterns:** tiny cost dismissed although executed millions of times.

### MD03 — Critical-path influence

**Question:** Does the unit determine or materially affect completion time of a critical workflow?  
**Evidence:** traces, barriers, synchronous chains, CPU/GPU dependencies, queue waits, scheduler ordering.  
**Failure patterns:** optimizing off-path work while ignoring a blocking stage; local speedup hidden behind a slower barrier.

### MD04 — Throughput and latency

**Question:** How much useful work is completed per unit time, and how long does a required operation take?  
**Evidence:** FPS, requests/sec, tasks/sec, input latency, startup/load time, median duration.  
**Failure patterns:** throughput increased by reducing work; average latency hides tail behavior.

### MD05 — Tail behavior and cost predictability

**Question:** Are p95/p99/worst-case latency, jitter, stutter, spikes, and resource bursts controlled and predictable?  
**Evidence:** distributions, long-frame count, worst case, variance, memory spikes, queue depth.  
**Failure patterns:** good average FPS with severe stutter; rare but catastrophic pauses.

### MD06 — Memory and resource lifecycle

**Question:** Are memory, GPU resources, handles, listeners, workers, timers, buffers, and caches owned, reused, bounded, and released correctly?  
**Evidence:** baseline/peak/retained memory, growth slope, create-use-destroy balance, high-water marks, leak probes.  
**Failure patterns:** resource churn; unreleased listeners; cache without eviction; device-loss recreation gaps.

### MD07 — I/O, network, and storage efficiency

**Question:** Are reads, writes, requests, serialization, storage, retries, and transfers necessary, batched, cached, and bounded?  
**Evidence:** bytes transferred, request counts, retry rates, file reads, serialization cost, cache performance.  
**Failure patterns:** repeated full-file reads; chatty APIs; redundant uploads; unbounded retry loops.

### MD08 — Scalability

**Question:** How does cost and quality change as load, users, entities, worlds, modules, data, or time increase?  
**Evidence:** load curves, complexity class, saturation points, queue growth, horizontal/vertical scaling.  
**Failure patterns:** demo-scale success with quadratic collapse; hidden global lock.

### MD09 — Degradation shape and resource adaptability

**Question:** When resources decline or load rises, does the system degrade gradually, transparently, and according to policy?  
**Evidence:** quality profiles, throttling behavior, fallback path, minimum/standard/high/extreme environments.  
**Failure patterns:** sudden cliff; silent quality collapse; hard dependence on one hardware tier.

### MD10 — Energy and carbon efficiency

**Question:** Is the required outcome achieved with justified energy use and, where relevant, reduced software carbon intensity?  
**Evidence:** energy proxy, runtime duration, hardware utilization, SCI-compatible functional-unit measurement, AI token/inference cost.  
**Failure patterns:** faster wall-clock result requiring disproportionate energy; idle GPU work; unnecessary model calls.

---

## Area E — Reliability, resilience, and safety (`ME`)

### ME01 — Reliability and availability

**Question:** Does the system perform correctly and remain available over the required operating period?  
**Evidence:** failure rate, uptime/SLO, error budget, long-run tests, success ratio, mean time between failures.  
**Failure patterns:** passes short tests but decays over time; intermittent unavailable state.

### ME02 — Fragility and blast radius

**Question:** How much damage can a small defect, failed dependency, or local change cause?  
**Evidence:** reverse impact, failure injection, affected units, data loss scope, cascading effects.  
**Failure patterns:** one NPC stops the runtime; one config error blocks unrelated features.

### ME03 — Fault isolation and containment

**Question:** Are faults contained within clear boundaries without corrupting unrelated state or workflows?  
**Evidence:** sandboxing, process boundaries, error propagation, circuit breakers, transaction isolation.  
**Failure patterns:** one worker crash poisons shared state; malformed plugin crashes the core.

### ME04 — Resilience and recovery

**Question:** Can the system detect failure, preserve truth, recover, resume, and reconstruct state correctly?  
**Evidence:** restart tests, event replay, device-loss recovery, lease expiry, backup restore, recovery time.  
**Failure patterns:** recovery requires hidden memory; restart loses mission state; corrupted projections cannot rebuild.

### ME05 — Graceful degradation and fallback quality

**Question:** When a preferred capability is unavailable, does the fallback remain explicit, safe, useful, and purpose-consistent?  
**Evidence:** fallback scenarios, quality delta, user/operator notification, bounded feature loss.  
**Failure patterns:** silent demotion; fallback produces misleading result; failure turns into total shutdown unnecessarily.

### ME06 — Reversibility and rollback

**Question:** Can the change or operation be undone completely, safely, and with verified restoration?  
**Evidence:** reverse patch, rollback test, pre/post hash, transactional boundary, state migration path.  
**Failure patterns:** irreversible migration without threshold; rollback exists only on paper.

### ME07 — Safety and fail-safe behavior

**Question:** Does the system identify hazards, prevent unsafe states, warn appropriately, and fail in the safest available mode?  
**Evidence:** hazard analysis, protected surfaces, fail-safe tests, operational limits, safety warnings.  
**Failure patterns:** optimization bypasses a guard; failure defaults to an unsafe action.

---

## Area F — Security, privacy, provenance, and governance (`MF`)

### MF01 — Security

**Question:** Does the system preserve confidentiality, integrity, availability, authenticity, and resistance to exploitation?  
**Evidence:** threat model, attack-surface analysis, vulnerability tests, authorization tests, secure configuration, incident history.  
**Failure patterns:** new feature expands attack surface without controls; client trusts unvalidated input.

### MF02 — Privacy and data minimization

**Question:** Are only necessary data collected, processed, exposed, and retained with appropriate purpose, access, and lifecycle controls?  
**Evidence:** data inventory, retention, access logs, anonymization, local-processing options, deletion tests.  
**Failure patterns:** telemetry retained indefinitely; secrets or personal data enter model context unnecessarily.

### MF03 — Supply-chain and provenance integrity

**Question:** Can source, dependencies, builds, artifacts, models, and deployment inputs be traced and protected from tampering?  
**Evidence:** lockfiles, SBOM/provenance, signed or hash-bound artifacts, reproducible builds, dependency policy, SLSA-style attestations.  
**Failure patterns:** unpinned dependency; build cannot be traced to source; artifact substituted after verification.

### MF04 — Abuse and misuse resistance

**Question:** Can legitimate features be exploited to cause harm, bypass policy, manipulate evidence, or gain unintended authority?  
**Evidence:** misuse cases, prompt-injection tests, rate limits, content boundaries, adversarial scenarios.  
**Failure patterns:** source comments authorize tool calls; benchmark is gamed; public endpoint enables destructive action.

### MF05 — Autonomy appropriateness and human control

**Question:** Is autonomous authority proportional, bounded, interruptible, reviewable, and subordinate to the Creator's mission?  
**Evidence:** capability tokens, approval gates, stop controls, mode policy, override tests, authority map.  
**Failure patterns:** agent can broaden its own permissions; no reliable stop; recommendation silently becomes execution.

### MF06 — Auditability, accountability, and policy conformance

**Question:** Can decisions, commands, changes, evidence, and responsible actors be reconstructed and checked against policy?  
**Evidence:** append-only audit, receipts, hashes, decision provenance, policy version, actor identity.  
**Failure patterns:** no record of who omitted a finding; landing cannot be reconstructed; policy changed mid-experiment.

---

## Area G — Compatibility, flexibility, delivery, and interaction (`MG`)

### MG01 — Compatibility and interoperability

**Question:** Does the unit coexist and exchange information correctly with required systems, data, protocols, and environments?  
**Evidence:** protocol tests, coexistence tests, schema compatibility, integration matrices.  
**Failure patterns:** valid locally but incompatible with another module or platform.

### MG02 — Backward and forward compatibility

**Question:** Are supported saves, APIs, data formats, scripts, worlds, clients, and migrations preserved across versions?  
**Evidence:** versioned fixtures, migration tests, old-client/new-server tests, serialization round trips.  
**Failure patterns:** optimization invalidates saves; old content loads silently wrong.

### MG03 — Portability

**Question:** What effort and risk are required to run the system on another compatible OS, browser, GPU, device, or infrastructure profile?  
**Evidence:** shared-code ratio, platform adapters, compatibility tests, setup effort, environment exceptions.  
**Failure patterns:** core logic bound to one platform; hidden driver assumption.

### MG04 — Adaptability and plasticity

**Question:** Can the system adapt quality, capacity, configuration, and behavior to different resources and contexts without architectural fracture?  
**Evidence:** configuration profiles, feature detection, adaptive quality, fallback behavior, adapter boundaries.  
**Failure patterns:** every new environment adds another special case; quality cannot scale down safely.

### MG05 — Deployability and operability

**Question:** Can the system be installed, configured, started, monitored, upgraded, rolled back, and operated reliably?  
**Evidence:** clean install, startup, readiness, health, deployment time, rollback, operator runbook, DORA-style delivery indicators where applicable.  
**Failure patterns:** works only on the author's machine; ambiguous readiness; command started but success is unknown.

### MG06 — Accessibility, inclusivity, and usability

**Question:** Can intended users understand, perceive, operate, and recover from errors in the interface, including users with disabilities?  
**Evidence:** WCAG-aligned tests where applicable, keyboard access, contrast, reduced motion, error prevention, task success, human evaluation.  
**Failure patterns:** essential state encoded only by color; controls inaccessible without pointer; cinematic effects make the tool unusable.

### MG07 — Reusability and generalization

**Question:** Can a component or method be reused in another valid context without hidden assumptions or disproportionate adaptation?  
**Evidence:** adapter tests, parameterization, dependency isolation, reuse history, contract clarity.  
**Failure patterns:** copied code because original cannot be reused; generic layer that actually encodes one target.

### MG08 — Cross-environment contract integrity and impedance

**Question:** Do languages, runtimes, data formats, GPU/CPU boundaries, build tools, services, and platforms exchange the same meaning with proportionate transformation and coordination cost?  
**Evidence:** Universal Project Representation flows; schema/layout/unit/version contracts; producer-consumer tests; serialization, transfer, copy, marshalling and synchronization measurements; ownership and lifecycle records; change-propagation analysis; cross-platform scenarios.  
**Failure patterns:** individually correct components disagree about units, nullability, layout, ordering, timing, ownership, or error semantics; hidden padding or repeated conversion; duplicate computation across TypeScript/WGSL/Python/SQL; work placed on the wrong side of a boundary; one contract change requires unsynchronized manual edits.  
**Typical verdict impact:** correctness conflicts may trigger `REJECTED_CONTRACT_VIOLATION`; disproportionate boundary cost or responsibility placement creates a `METHODOLOGICAL_OPPORTUNITY` requiring cross-environment proof.

---

## Area H — Transparency and system-wide synthesis (`MH`)

### MH01 — Explainability and transparency

**Question:** Can CLU-E and relevant stakeholders explain what the system did, why, on what evidence, with what uncertainty, and what would change the conclusion?  
**Evidence:** source-grounded responsibility, decision traces, causal narrative, counter-evidence, confidence, limitations.  
**Failure patterns:** opaque score; unexplained AI verdict; purpose inferred without provenance.

### MH02 — Quality balance and Pareto integrity

**Question:** Does the change improve the overall quality vector without hiding an unacceptable trade-off?  
**Evidence:** before/after measure vector, mandatory gates, Pareto comparison, Creator trade-off policy, Master Benchmark.  
**Failure patterns:** faster but less correct; simpler but less secure; lower memory but severe tail latency; local gain with global loss.

### MH03 — Method adequacy and applicable-frontier position

**Question:** Given the protected intent, problem class, workload, constraints, and value horizon, is the current method an adequate way to achieve the outcome, and how far is it from the Applicable Solution Frontier?  
**Evidence:** observed implementation; declared/inferred/confirmed intent; problem-class record; current-method record; provenance- and freshness-bound method landscape; applicability exclusions; Pareto vector; controlled candidate experiments; capability and Master Benchmark outcomes.  
**Failure patterns:** perfecting a locally efficient implementation of an inferior method; assuming the implementation defines the intent; adopting a fashionable method without applicability evidence; overlooking an established method that better satisfies the same outcome under project constraints; claiming state of the art from stale or untraceable knowledge.  
**Typical verdict impact:** creates a `METHODOLOGICAL_OPPORTUNITY`, not an automatic rewrite. Acceptance requires a frozen comparative experiment proving that the candidate method is better for this target and does not violate mandatory gates.

---

# 5. Area I — Evidence and Assurance Metrics (`MI`)

These measures determine whether CLU-E may trust its own conclusions.

## MI01 — Purpose-context sufficiency

Is the local, parent, subsystem, and program purpose understood well enough to judge the candidate?

## MI02 — Measurement validity

Does the chosen indicator actually measure the claimed property, with correct units, collection, and interpretation?

## MI03 — Benchmark representativeness

Does the benchmark exercise meaningful, purpose-relevant workloads rather than a convenient but unrepresentative path?

## MI04 — Coverage completeness

How much of the declared source, dependency, runtime, scenario, platform, purpose, and capability surface was actually assessed?

## MI05 — Causal attribution

Is the observed change attributable to the patch rather than noise, unrelated changes, caching, environment drift, or measurement interference?

## MI06 — Confidence and uncertainty calibration

Does stated confidence match historical accuracy, evidence strength, ambiguity, and residual uncertainty?

## MI07 — Knowledge freshness

Are source, documents, dependencies, benchmark, graph, environment, and prior conclusions current for this assessment?

## MI08 — Instrument self-validity and observer effect

Has the parser, probe, benchmark, fixture, browser bridge, or analyzer proven that it works and does not materially distort what it measures?

## MI09 — Reproducibility and replicability

Can the result be repeated in the same environment, and where required reproduced in another compatible environment?

## MI10 — Regression sensitivity

Would the active tests and measures detect meaningful degradation, interaction effects, and cumulative drift?

## MI11 — Scope-of-claim integrity and residual unknowns

Is the conclusion limited to the evidence envelope, with unknowns, exclusions, and deferred surfaces explicitly preserved?

## MI12 — Evidence-plan and benchmark-synthesis validity

Is the complete evidence plan appropriate to the improvement claim, independently validated, resistant to work reduction and gaming, and frozen before candidate results are interpreted?

This measure covers both primary authorities:

- **instrumented:** analytic/exact proof, quantitative benchmarks, and constraint/conformance checks;
- **empirical:** capability/Master Benchmark/cross-platform outcomes and controlled human-perceptual evaluation.

Evidence includes claim-to-instrument traceability, author identity, calibration, representativeness, sensitivity, repeatability, observer-effect analysis, baseline/candidate symmetry, randomization/blinding where applicable, decision thresholds, freeze hash, and invalidation conditions. A benchmark generated by AI is admissible only after the same validation required of any other instrument.

---

# 6. Area J — Mandatory Preservation and Acceptance Gates (`MJ`)

A patch cannot receive `ACCEPTED_PROVEN` unless all applicable gates pass.

## MJ01 — Purpose Preservation

The program and modified unit still serve their declared purpose.

## MJ02 — Capability Preservation

All required capabilities are preserved or improved; none is silently removed, narrowed, or materially degraded.

## MJ03 — Workload Integrity

The patched benchmark and scenario perform the same required work as the baseline.

## MJ04 — Correctness and Contract Integrity

Required outputs, state, ordering, APIs, persistence, and safety contracts remain valid.

## MJ05 — Evidence Admissibility

The proof contract was frozen, instruments were healthy, preconditions were met, environment and source identities were correct, and the result is statistically or logically decisive under the registered policy.

## MJ06 — Global Regression Guardrail

The Master Benchmark and protective measures show no unacceptable system-wide regression. Target-specific gray areas are reported, never converted into improvement.

## MJ07 — Reversibility and Recovery

The patch has a verified rollback or restoration path appropriate to its risk and is safe to land under the active custody policy.

---

# 7. Target-Specific Measurement Profiles

The canonical catalogue is universal. Each Target Program defines a profile that maps concrete indicators to applicable measures.

## 7.1 Murugan profile

Typical indicators include:

- average/median FPS;
- p50/p95/p99/worst frame time;
- stutter and long-frame count;
- CPU and GPU phase time;
- RAM and GPU-memory baseline, peak, retained growth, and churn;
- entity, simulation-step, draw, dispatch, upload, and completed-work counts;
- startup, world-load, asset-load, and interaction latency;
- visual and simulation fidelity;
- console signatures and WebGPU validation errors;
- device-loss and recovery behavior;
- platform and adapter profile;
- purpose and capability coverage.

The FPS rule is target policy, not a universal quality definition:

```text
more than +3 FPS     possible measurable gain, subject to evidence and guardrails
between -3 and +3    measurement gray area; not a proven FPS improvement
less than -3 FPS     unacceptable global regression unless mission policy is explicitly amended
```

Average FPS alone never controls the verdict.

## 7.2 CLU-E self-assessment profile

Typical indicators include:

- time and cost per terminal finding;
- time, tokens, calls, and compute per proven improvement;
- false-positive and refutation rate;
- regression escape rate;
- repeated rejected-hypothesis rate;
- graph and purpose coverage growth;
- restart/resume success;
- event replay equality;
- forecast calibration;
- benchmark and instrument validity rate;
- automatic-revert success;
- mission and evidence continuity after session loss.

## 7.3 AI-system profile

When the target contains AI, the profile should additionally instantiate:

- task effectiveness and groundedness;
- uncertainty calibration;
- robustness to distribution shift and adversarial input;
- data quality and provenance;
- fairness and harmful-bias risk where relevant;
- explainability and contestability;
- human oversight and controllability;
- prompt-injection, model-extraction, poisoning, and unsafe-tool-use resistance;
- inference latency, cost, energy, and fallback quality.

These indicators map into the canonical measures rather than creating a second conflicting quality model.

## 7.4 Web and interactive-interface profile

Where applicable, use WCAG 2.2-aligned accessibility evidence, keyboard and assistive-technology tests, reduced-motion behavior, readable contrast, task completion, error prevention, and recovery.

## 7.5 Polyglot RPI profile

A project containing multiple languages, runtimes, shader systems, configuration formats, build tools, data stores, services, or platforms instantiates at least:

- environment inventory and adapter support depth;
- native semantic coverage and unsupported-surface count;
- UPR conversion coverage and information-loss warnings;
- capability slices spanning native units;
- cross-environment contract integrity, transformation cost, responsibility placement, and change propagation;
- cross-platform behavior and fallback scenarios;
- intent confidence, problem-class confidence, current-method confidence, and method-knowledge freshness;
- Applicable Solution Frontier candidates and explicit exclusions;
- proof-instrument validity by evidence authority;
- forecast/realized value and assurance gain over the declared horizon;
- equilibrium state by environment, capability, frontier, evidence, economics, assurance, and whole project.

---

## 7.6 Git-integrated RPI profile

This profile applies when the Target Program, CLU-E program, evidence repository, or auxiliary repository is Git-backed. It introduces **no fifth metric family and no new canonical metric cells**. Git facts are target-specific indicators and evidence inputs mapped to existing quality, assurance, gate, and CLU-E self-measures.

Git does not define improvement. It supplies exact version state, isolation, provenance, transport, review/check evidence, reversibility, durability, and recovery signals required to prove and preserve an improvement.

### 7.6.1 Canonical Git/RPI indicators

| Indicator | Native observation | Primary canonical mappings |
|---|---|---|
| `I.GIT.REPOSITORY_COVERAGE` | registered/material repositories ÷ discovered repositories; repository-set completeness | `MI04`, `MI11`, `MK06` |
| `I.GIT.STATE_ENVELOPE_COMPLETENESS` | HEAD/index/worktree/refs/remotes/config/hooks/filters/submodule/LFS fields captured and verified | `MF03`, `MF06`, `MI02`, `MI09` |
| `I.GIT.BASE_REACHABILITY` | Base Pin objects reachable locally/remotely; exact source snapshot reconciliation | `MF03`, `MI05`, `MI09`, `MJ05` |
| `I.GIT.CREATOR_TREE_ISOLATION` | before/after Creator working-tree and index seal; unexpected writes | `MF05`, `MF06`, `MI05`, `MJ04`, `MJ07`, `MK11` |
| `I.GIT.WORKTREE_LEASE_INTEGRITY` | worktree/branch/Base Pin/owner/expiry/path consistency; quarantine events | `ME03`, `ME06`, `MF06`, `MK10`, `MK11` |
| `I.GIT.CHANGESET_ATTRIBUTION` | all changed/untracked/generated/submodule/LFS surfaces classified; unknown/forbidden counts | `MC08`, `MF03`, `MF06`, `MI04`, `MI05`, `MI11`, `MJ04`, `MJ05` |
| `I.GIT.CANDIDATE_IDENTITY_INTEGRITY` | expected vs actual file/diff/tree/commit; proof binding compatibility | `MB03`, `MB04`, `MF03`, `MI05`, `MI09`, `MJ04`, `MJ05` |
| `I.GIT.BRANCH_LIFECYCLE_INTEGRITY` | experiment/review/accepted/archive state transitions; stale or orphaned refs | `MC02`, `MG05`, `MF06`, `MK10`, `MK11` |
| `I.GIT.REMOTE_SYNC` | ahead/behind/diverged/rewritten/missing/unavailable; last successful reconciliation | `MG01`, `MG02`, `MG05`, `ME04`, `MI07`, `MI11` |
| `I.GIT.REVIEW_PROVENANCE` | review head/base, approvals/comments/policy state bound to exact commits | `MF03`, `MF06`, `MI05`, `MI07`, `MI09` |
| `I.GIT.REMOTE_CHECK_COMPLETENESS` | required/observed checks, exact commit binding, freshness, artifacts, protected role | `MG05`, `MI03`, `MI04`, `MI09`, `MI10`, `MJ05`, `MJ06` |
| `I.GIT.LANDING_REVERSIBILITY` | accepted tree equality, landing receipt, reverse path, post-land verification/revert | `ME04`, `ME06`, `MF06`, `MJ06`, `MJ07`, `MK11` |
| `I.GIT.EVIDENCE_CLOUD_DURABILITY` | manifest/object reachability, classification, upload verification, retention, restore test | `ME01`, `ME04`, `MF02`, `MF03`, `MF06`, `MI09`, `MK10` |
| `I.GIT.CREDENTIAL_AND_PUBLICATION_SAFETY` | least privilege, secret scan, classification gate, denied unsafe publication | `MF01`, `MF02`, `MF05`, `MF06`, `MJ05`, `MK11` |
| `I.GIT.RECONCILIATION_SAFETY` | no blind rebase/force push/conflict invention; new Base Pin/re-proof when required | `ME06`, `MF03`, `MF05`, `MF06`, `MI05`, `MJ04`, `MJ05`, `MJ07`, `MK11` |
| `I.GIT.CLOUD_RECOVERY_COMPLETENESS` | accepted experiment reconstructible after local worktree/artifact loss | `ME04`, `MI09`, `MK10`, `MK12` |

### 7.6.2 Mandatory Git protections

The following are gate inputs, not optional weighted quality signals:

- Creator working tree and index remain unchanged during autonomous experimentation;
- Base Pin, source snapshot, candidate tree, commit, diff, and proof contract reconcile;
- the Change-Set Partition contains no unknown, unrelated Creator, incidental tool, or forbidden material;
- credentials and unclassified evidence are not published;
- content-changing rebase, squash, amend, provider edit, conflict resolution, or generated refresh cannot inherit an old verdict;
- remote checks required by policy are current and bound to the exact candidate, but are never themselves a verdict;
- protected-ref landing is exact, permit-bound, post-verified, and reversible;
- submodule, LFS, hook/filter, signing, sparse/partial clone, and generated-content state is either known and admissible or explicitly blocks the claim.

These protections map primarily to `MJ04`, `MJ05`, `MJ06`, and `MJ07`, with `MF03`, `MF06`, `MI05`, `MI09`, and `MK11` supplying the supporting quality and assurance evidence.

### 7.6.3 Measurement and normalization rule

Git indicators retain native units such as:

- repository/ref/worktree/change counts;
- object and manifest hashes;
- exact commit/tree identities;
- ahead/behind distance;
- time since fetch/check/publication/restore;
- percentage of classified changed surfaces;
- required checks passed/current/stale;
- publication bytes and restore success;
- denied unsafe operations;
- landing/revert recovery time.

They may feed a versioned normalization profile for dashboards, but unlike native units are never summed directly. `remote-check-green`, `review-approved`, or `merge-complete` may not normalize to `proven`. Proof and version-control lifecycle remain separate dimensions.

### 7.6.4 Catalogue review questions

After each cycle, the Catalogue Review asks:

- did Git indicators prevent stale-base, unrelated-change, or content-drift errors;
- did remote checks catch regressions not found locally, and were they correctly classified as protective rather than verdict evidence;
- did publication/retention preserve enough evidence for independent reconstruction;
- were branch/worktree operations token- and time-efficient;
- did provider-specific complexity add value beyond the generic Git core;
- did any indicator encourage gaming, such as optimizing for green CI while weakening the actual proof;
- did false positives or missing Git coverage delay valid improvement or expose risk.

---

# 8. Canonical Measure Record

Each instantiated measure is stored with at least:

```yaml
measure_instance_id: MSI-...
catalogue_version: 6.0
catalogue_hash: sha256
measure_id: MH03
name: Method adequacy and applicable-frontier position
target_id: TGT-...
scope_id: UNT-... | ENV-... | BND-... | CAP-... | PLT-... | PRG-... | RPI-...
environment_ids: [ENV-...]
upr_scope_id: optional
snapshot_id: SNP-...
applicability: REQUIRED | APPLICABLE | CONDITIONAL | NOT_APPLICABLE | UNKNOWN | CONFLICTED
purpose_context_id: PURCTX-...
intent_record_id: optional
problem_class_id: optional
current_method_id: optional
frontier_snapshot_id: optional
indicator_ids: [IND-...]
evidence_authority: INSTRUMENTED | EMPIRICAL | COMPOSITE
proof_instrument_ids: [INS-...]
evidence_artifacts: [sha256]
result:
  type: numeric | boolean | ordinal | categorical | vector | assessment | unknown
  value: ...
baseline: ...
comparison: ...
confidence: 0.0-1.0
limitations: []
residual_unknowns: []
value:
  horizon_id: optional
  forecast_value: optional
  realized_value: optional
  assurance_gain: optional
  attribution_confidence: optional
finding_ids: []
review_state: current | stale | invalidated
```

Every result resolves to exact evidence and the catalogue version used to interpret it.

---

# 9. Integration into one CLU-E cycle

```text
Freeze Assessment Envelope, adapter set, method-knowledge snapshot, value policy, and Catalogue hash
→ inventory all artifacts and identify native environments
→ recognize native structure/semantics and project into the UPR
→ recover purpose/intent and bind cross-environment capability slices
→ classify problem and identify the current method where method adequacy is relevant
→ construct and filter the Applicable Solution Frontier
→ determine measure applicability by native, capability, boundary, platform, whole-program, and RPI scope
→ create one logical Measure Assessment Session per applicable scope/measure pair
→ route each session to the appropriate AI role or deterministic tool
→ collect indicators, evidence, refutations and terminal outcomes
→ generate and rank implementation, architectural, cross-environment, methodological, and assurance findings
→ state the improvement claim and select evidence authority
→ author or select, validate, and freeze the proof instrument and contract
→ capture baseline
→ patch the isolated experiment worktree
→ rerun local, capability, Master Benchmark, cross-environment, cross-platform, and controlled human evidence as required
→ apply mandatory gates
→ issue verdict
→ record forecast and realized value/assurance separately in the Great Book
→ update CLU-E Status and multidimensional equilibrium
→ review measurement and instrument effectiveness with AI
→ re-recognize the new canonical state and begin the next cycle
```

All findings must identify:

1. the canonical measure(s) that exposed the imperfection or opportunity;
2. the native environment, UPR/capability/boundary/platform scope, and target-specific indicator(s) that supplied evidence;
3. the observed implementation, protected intent, problem class, current method, and frontier record where applicable;
4. the improvement claim and evidence authority;
5. the validated proof instrument, local proof metric, and pre-result freeze identity;
6. the capability, Master Benchmark, cross-environment, cross-platform, and human-perceptual protections;
7. the mandatory gates;
8. the assurance measures required for admissibility;
9. the value horizon and whether value is forecast, realized, non-monetized assurance, or unknown.

---

# 10. Measurement Catalogue Review against the Great Book

## 10.1 This review is a core CLU-E method

The Measurement Catalogue must be reviewed using the Great Book's accumulated experimental history. This is not optional documentation maintenance. It is part of CLU-E's learning loop.

The Great Book records, for every finding and experiment:

- measure IDs that generated or supported the finding;
- evidence and confidence;
- patch hypothesis;
- terminal disposition;
- actual local and global outcome;
- regression or purpose violation;
- analysis, test, token, call, and compute cost;
- false-positive, duplicate, and missed-defect information;
- whether the measure encouraged gaming or useful instrumentation;
- whether a later cycle invalidated the conclusion.

## 10.2 Review cadence

### Light review — after every completed cycle

CLU-E updates empirical statistics for each used measure and flags anomalies.

### Full review — after three full cycles or equilibrium evaluation

CLU-E evaluates the whole catalogue, target profile, weights, applicability rules, and evidence costs.

### Triggered review

A full or scoped review is also required after:

- a materially stronger AI evaluator;
- mission or purpose change;
- major benchmark change;
- new Target Program type;
- serious escaped regression;
- detected metric gaming;
- important new standard or measurement method;
- repeated `CONTEXT_INSUFFICIENT` or `INVALID_EXPERIMENT` outcomes.

## 10.3 Measure-effectiveness statistics

For each measure, CLU-E tracks at least:

- **decisive yield:** terminal findings produced per use;
- **proven-improvement yield:** accepted improvements attributable to the measure;
- **false-positive rate:** suspected findings later refuted;
- **regression-escape contribution:** important regressions the measure failed to protect;
- **overlap:** findings substantially duplicated by another measure;
- **unique coverage:** defect classes found only through this measure;
- **cost per decisive verdict:** analysis and test cost;
- **confidence calibration:** whether confidence predicted correctness;
- **gaming pressure:** cases where optimization targeted the metric rather than purpose;
- **cross-target portability:** whether the measure transfers or needs a profile-specific form;
- **freshness:** time since evidence and calibration were last validated;
- **environment portability:** whether the measure works across its declared native and cross-environment scopes;
- **proof-authority coverage:** whether instrumented and empirical claims receive appropriate instruments;
- **instrument-synthesis validity:** acceptance and invalidation rate of AI-authored proof instruments;
- **method-frontier value:** proven improvements found by changing method rather than polishing implementation;
- **value realization:** forecast versus realized benefit or assurance over the registered horizon.

## 10.4 Permitted catalogue actions

A review may:

```text
RETAIN
RECALIBRATE
REWEIGHT_FOR_RANKING
CHANGE_APPLICABILITY
STRENGTHEN_EVIDENCE_REQUIREMENTS
SPLIT
MERGE
PROMOTE_FROM_EXPERIMENTAL
DEMOTE_TO_EXPERIMENTAL
DEPRECATE
RETIRE
ADD_NEW_MEASURE
ADD_OR_CHANGE_TARGET_PROFILE
```

No action rewrites historical experiments. Old records remain bound to the old catalogue hash.

## 10.5 Governance protections

A measure must not be weakened or removed merely because it produces inconvenient findings or blocks a desired patch.

Catalogue change requires:

- a documented reason;
- Great Book evidence;
- affected targets and historical results;
- expected benefit and risk;
- Creator approval for changes to mandatory gates or purpose doctrine;
- a new catalogue version and hash;
- certificate-impact analysis.

## 10.6 Measurement-review record

Every full review creates an immutable Great Book record:

```yaml
record_kind: MEASUREMENT_CATALOGUE_REVIEW
previous_catalogue_hash: ...
new_catalogue_hash: ...
cycles_reviewed: [...]
experiments_reviewed: 0
measure_actions:
  - metric_id: M<area><ordinal>
    action: RETAIN | RECALIBRATE | SPLIT | ...
    evidence: [...]
blind_spots_discovered: []
gaming_cases: []
regressions_escaped: []
creator_approval: ...
effective_from_cycle: ...
```

---

## 10.7 AI review protocol

A catalogue review is itself a model-orchestrated CLU-E campaign. It uses role separation:

- **Measurement Auditor** — evaluates whether definitions remain state of the art and internally coherent;
- **Outcome Reviewer** — receives measure IDs and raw Great Book outcomes without the original designers' reasoning;
- **Coverage Critic** — looks for escaped defect classes and unmeasured purpose/capability surfaces;
- **Gaming Adversary** — searches for ways a target or optimizer could satisfy the metric while becoming worse;
- **Cost Analyst** — evaluates tokens, calls, benchmark time and human intervention per decisive result;
- **Catalogue Synthesizer** — proposes a versioned change set after reading all conflicting reviews.

The strongest available model is used for full synthesis and high-risk gate review. Routine statistics, record extraction and overlap clustering use deterministic analysis, Batch or smaller models. Every review has a token budget, evidence set, output schema, independent refutation plan and stopping rule.

## 10.8 Change proposal and activation

AI-generated catalogue proposals enter `PROPOSED_CATALOGUE_CHANGE`. They are tested against historic Great Book records and current target profiles before activation. A proposal must state:

- what question changes;
- why current evidence is insufficient;
- which records and certificates are affected;
- expected gain in coverage, precision or economy;
- new gaming or blind-spot risks;
- migration and compatibility mapping;
- whether Creator approval is required.

Activation creates a new catalogue version and hash. It never silently changes an active cycle, frozen proof contract, or historical verdict.

# 11. Area K — CLU-E Self-Metrics (`MK`)

CLU-E must measure whether its measurement system is itself efficient and trustworthy.

## MK01 — Cost per proven improvement

Total analysis, AI, benchmark, and human cost divided by accepted proven improvements.

## MK02 — Time to terminal disposition

Elapsed time from finding creation to accepted, rejected, omitted, deferred, inconclusive, or invalid terminal state.

## MK03 — Finding precision

Proportion of investigated findings that survive refutation and become confirmed defects or justified improvements.

## MK04 — Regression escape rate

Meaningful regressions not detected by the active catalogue and protective suite before landing.

## MK05 — Repeated-work rate

Previously resolved or rejected hypotheses repeated without new evidence.

## MK06 — Coverage and uncertainty reduction

Growth of recognized, purpose-understood, dependency-resolved, runtime-enriched, and test-covered scope.

## MK07 — Forecast calibration

Accuracy of P50/P80 estimates for calls, sessions, patches, experiments, and cycle completion.

## MK08 — Instrument validity rate

Proportion of planned experiments that produce admissible evidence rather than `INVALID_TEST` or avoidable `SKIP`.

## MK09 — Test-catalogue efficiency

Unique defects protected per unit of test execution cost, adjusted for flakiness and overlap.

## MK10 — Mission continuity

Ability to restart, replay, recover, and resume without unique state existing only in a lost session.

## MK11 — Custody safety

Landing-gate correctness, exact-diff receipt success, post-land verification, and automatic-revert reliability.

## MK12 — Equilibrium credibility

Whether later stronger assessments confirm or expose blind spots in earlier equilibrium certificates.

---

## MK13 — Measure-session token efficiency

Tokens and calls per terminal measure-session result, segmented by role, model, target and outcome quality.

## MK14 — Model-routing value

Improvement in precision, proof quality or risk detection achieved by frontier-model escalation relative to its additional cost.

## MK15 — Catalogue maintainability

Time and error rate required to add, revise, validate, document and activate a measure without duplicated changes across the system.

## MK16 — Catalogue-review effectiveness

Defects, blind spots, duplicate measures, gaming cases and escaped regressions discovered through AI catalogue review, compared with review cost.

## MK17 — Conversation-orchestration integrity

Proportion of logical measure sessions whose task identity, context hash, model-selection rationale, checkpoints, refutation links, token/call telemetry, validated artifacts and terminal outcome are fully reconstructible without a user manually carrying context between AI model sessions.

## MK18 — Status fidelity

Agreement between durable assessment/runtime state and exported `clue-status.json`, including replay equivalence, unit and capability coverage, freshness, contradiction rate, State Seal validity and separation of historical assessment from current runtime health.

## MK19 — RPI value yield and horizon realization

The verified persistent project value or assurance created by RPI relative to total search, token, compute, implementation, validation, human, and expected-risk cost, measured over the declared value horizon.

This metric keeps distinct:

- forecast lifetime value;
- realized value observed to date;
- non-monetized assurance gain;
- token efficiency;
- improvement yield;
- attribution confidence;
- search saturation and marginal expected value of the next experiment.

A small native saving may have high lifetime value at large volume or long duration. A visually dramatic local percentage may have negligible durable value. Forecast values are never presented as realized values, and unknown assurance value is never coerced to zero.

# 12. Informative alignment with external frameworks

This catalogue is CLU-E-specific and purpose-first. It is informed by, but not replaced by:

- ISO/IEC 25010:2023 — software and ICT product quality models;
- ISO/IEC 5055:2021 — automated source-code quality measures;
- ISO/IEC 25012 — data quality model;
- ISO/IEC 25059:2023 — quality model for AI systems;
- NIST SP 800-218 SSDF and SP 800-218A — secure software and AI development practices;
- SLSA v1.2 — software supply-chain provenance and integrity;
- W3C WCAG 2.2 — web accessibility requirements and testable success criteria;
- DORA software-delivery performance research and metrics;
- Software Carbon Intensity / ISO/IEC 21031:2024 — software carbon measurement.

External frameworks provide vocabulary, known quality dimensions, and target-specific evidence methods. CLU-E retains its own constitutional rules:

- purpose before metric;
- proof before improvement;
- proposal, state, and proof remain separate;
- no hidden trade-off;
- no equilibrium claim beyond the Assessment Envelope;
- every environment in its native semantics before cross-environment synthesis;
- intent before method judgment;
- applicable frontier before trend following;
- proof authority and instrument validity before verdict;
- forecast value distinct from realized value;
- local equilibrium distinct from project RPI equilibrium.

---

# 13. Final canonical rule

> **CLU-E does not improve the easiest number, the most fashionable method, or the best-understood language. Through RPI it improves the Target Program's demonstrated fitness for protected intent across native environments, capabilities, boundaries, platforms, and a versioned quality vector, under admissible evidence and explicit value or assurance policy.**
>
> **The Catalogue asks the questions through 100 stable `M<Area><Ordinal>` coordinates. Environment adapters and the UPR identify the real scope. Intent and method intelligence establish what outcome and solution class are being judged. The proof authority and validated instrument define how the claim can be established. Native observations remain authoritative; normalization makes heterogeneous contributions visually comparable without replacing their units. The Great Book records technical proof, empirical outcome, forecast and realized value, residual unknowns, and the exact equilibrium envelope. Repeated outcomes and AI review improve the Catalogue, instruments, method knowledge, and RPI process themselves.**


---


---

---

# Part II — Golden Outcome Rail (`GOLD-01`–`GOLD-04`)

**Integration status:** integrated at catalogue revision 9.0 from the formerly standalone proposed supplement (`metrics_suplementaiton.md`, supplement revision 1.0), by Creator direction recorded in `DOCUMENTATION_GOVERNANCE_v9.md` §14. The supplement's content is preserved below; its sections are renumbered `G1`–`G18` to keep Part I numbering canonical.

**Standing:** Part I (Sections 1–13) is the canonical 10 × 10 catalogue; its 100 cells, IDs, and coordinates are unchanged. The four Golden Metrics of this Part are governed project-level **outcome projections** rendered on a separate Golden Outcome Rail. They are not a fifth canonical family, never occupy Great Book grid coordinates, and follow the same constitutional rules as every other measure: native evidence first, `UNKNOWN` over invented zero, `NOT_COMPARABLE` over silent bridging, and no gate averaged away. Where the text below says "this supplement," read "this Part."

## G1. Executive decision

CLU-E already has a complete canonical 10 × 10 Measurement Catalogue. Its 100 stable cells must not be moved, reused, or displaced.

The four measures introduced here are therefore **not a fifth canonical family and do not occupy new Great Book grid coordinates**. They are governed, project-level outcome projections derived from:

- canonical measures;
- Target Program indicators;
- accepted-improvement records;
- the locked Master Benchmark;
- environment-bound runtime telemetry;
- frozen normalization profiles;
- mandatory preservation gates.

They appear **next to** the existing metrics as a separate **Golden Outcome Rail**.

The four Golden Metrics are:

| ID | Name | Primary question |
|---|---|---|
| `GOLD-01` | **Objective Translation Efficiency** | Are CLU-E's accepted engineering improvements actually moving the Target Program's declared objectives? |
| `GOLD-02` | **Cross-Environment Flow Efficiency** | How much end-to-end execution is useful work, and how much is lost crossing runtime, language, process, or data boundaries? |
| `GOLD-03` | **Master Benchmark Net Gain** | How much has the complete accepted Target Program improved against the locked Master Benchmark? |
| `GOLD-04` | **Sustainable Capacity at Target Quality** | How much workload can the Target Program sustain while still meeting its locked performance and quality contract? |

The governing principle is:

> **Local proof establishes that a patch did what it claimed. Golden Metrics establish whether the accepted project is moving toward its real purpose.**

---

## G2. Why this supplement is necessary

A technically valid CLU-E cycle may produce:

- fewer allocations;
- smaller code;
- cleaner dependency structure;
- faster isolated functions;
- reduced memory in one subsystem;
- lower token or build cost;
- more reliable tests.

Those are real improvements. They do not automatically prove that the Target Program's user-visible result improved.

For Murugan, CLU-E could theoretically complete several successful local optimizations while the complete renderer remains near the same frame rate. The result would be a more efficient implementation of the same insufficient outcome.

This supplement prevents that failure by separating:

```text
LOCAL ENGINEERING GAIN
    from
PRODUCT OBJECTIVE GAIN
```

and by making lack of translation an explicit measurable state rather than an observation the Creator must notice manually after several cycles.

---

## G3. Relationship to the canonical catalogue

### G3.1 No fifth family

The four existing canonical families remain unchanged:

```text
TARGET_QUALITY
EVIDENCE_ASSURANCE
ACCEPTANCE_GATES
CLUE_SELF
```

Golden Metrics are a **cross-catalogue projection layer**. Each one resolves back to the canonical measures, indicators, proof contracts, benchmark runs, and Great Book contributions that produced it.

They must never create competing truth.

### G3.2 No coordinate changes

The 10 × 10 Great Book field remains exactly 100 cells.

Golden Metrics:

- have no ordinary grid coordinate;
- do not push, replace, or renumber canonical measures;
- do not create a fifth district on the field;
- are displayed in a separate rail or instrument group;
- may highlight the canonical cells contributing to their current result.

### G3.3 Known canonical relationships

The exact mapping is target-profile-dependent, but the following relationships are expected:

| Golden Metric | Principal canonical relationships |
|---|---|
| `GOLD-01` | Purpose alignment, utility, method adequacy / Applicable Solution Frontier position, benchmark-synthesis validity, RPI value yield |
| `GOLD-02` | `MG08` Cross-environment contract integrity and impedance, plus applicable performance, reliability, portability, and efficiency measures |
| `GOLD-03` | All Master-Benchmark-covered Target Quality measures, `MI12` evidence-plan and benchmark-synthesis validity, and `MK19` RPI value yield and horizon realization |
| `GOLD-04` | Applicable performance, scalability, resilience, and quality-preservation measures, supported by `MI12` and `MK19` |

### G3.4 Gold does not mean generic success

The visual color is:

```text
Primary gold:     #F4AF2D
Hot evidence core:#FFE7A3
Dark gold backing:#4A3100
```

Gold means:

- proof-sensitive objective focus;
- selected strategic importance;
- verified evidence concentration.

It must not mean “everything is good.”

A regression may still be displayed in the Golden Rail, using:

- the gold frame to identify the instrument;
- negative geometry, downward motion, a minus glyph, broken fill, or warning text to show direction;
- orange/red fault treatment for gate failure;
- a dashed or incomplete frame for stale or insufficient evidence.

Color is never the only carrier of state.

---

## G4. Shared Golden Metric contract

### G4.1 Applicability

Golden Metrics are project-level or cycle-level measures. They are not ordinary function-level metrics.

They may be:

```text
REQUIRED
APPLICABLE
CONDITIONAL
NOT_APPLICABLE
UNKNOWN
CONFLICTED
```

For Murugan, all four should normally be `REQUIRED` once the necessary instrumentation exists.

### G4.2 Evidence requirements

Every Golden Metric result must bind to:

- Target Program registration;
- active mission and Project Intent Model;
- accepted project snapshot;
- Master Benchmark version and hash;
- benchmark environment fingerprint;
- normalization-profile version and hash;
- relevant proof-contract and verdict IDs;
- raw telemetry artifacts;
- comparison baseline;
- coverage and confidence;
- limitations and invalidity conditions.

A displayed Golden Metric with no valid evidence must show `UNKNOWN`, never zero.

### G4.3 No raw-unit addition

FPS, milliseconds, bytes, percentages, error counts, quality judgments, and capacity values must never be directly added.

Every Golden Metric stores:

1. native evidence;
2. a separately frozen normalization method;
3. the normalized project-level projection;
4. the native breakdown from which the projection was derived.

### G4.4 Mandatory gates remain superior

A positive Golden Metric cannot override:

- correctness failure;
- visual-quality regression;
- security regression;
- protected-capability loss;
- invalid experiment;
- benchmark non-comparability;
- environment mismatch;
- missing required coverage.

A mandatory gate failure changes the Golden Metric status to a blocking state. Positive values may remain visible as observations, but they cannot authorize an improvement verdict.

### G4.5 Required result states

Golden Metrics use the following common states:

```text
UNKNOWN
BASELINE_ONLY
MEASURED
PRODUCT_GAIN
ENGINEERING_ONLY
REGRESSION
NON_CONVERGENCE
NOT_COMPARABLE
INVALID_EXPERIMENT
BLOCKED_BY_GATE
STALE
```

---

## G5. GOLD-01 — Objective Translation Efficiency

### G5.1 Purpose

`GOLD-01` detects the exact failure mode in which CLU-E repeatedly proves local engineering improvements while the Target Program's meaningful outcome does not materially improve.

It answers:

> **Of the accepted changes that were intended to move a project objective, how many actually produced a material, admissible improvement in the corresponding Master Benchmark objective?**

Maintenance, documentation, observability, and developer-experience work remain valuable, but must not be counted as failed product translations when they were never intended to move a product objective.

### G5.2 Unit and shape

Primary display:

```text
translation_rate_pct: 0–100%
```

Required secondary values:

```text
objective_seeking_accepted_count
translated_count
engineering_only_count
regression_count
weighted_objective_gain
non_convergence_streak
coverage
confidence
```

The complete result is a vector. The percentage is only its primary instrument value.

### G5.3 Candidate declaration requirement

Before an experiment begins, every candidate must declare one of:

```text
OBJECTIVE_SEEKING
MAINTENANCE
RELIABILITY
ASSURANCE
DEVELOPER_EXPERIENCE
INSTRUMENTATION
```

An `OBJECTIVE_SEEKING` candidate must identify:

- objective IDs from the Project Intent Model;
- expected Master Benchmark scenarios;
- expected native indicator direction;
- materiality threshold;
- guardrails;
- causal hypothesis;
- invalidity conditions.

This declaration is frozen before results are observed.

### G5.4 Translation event

An accepted objective-seeking improvement is considered **translated** only when:

1. its local proof contract passes;
2. the corresponding Master Benchmark result improves beyond its frozen gray area;
3. the improvement is admissible under the frozen environment and benchmark version;
4. all mandatory preservation gates pass;
5. the objective attribution remains credible.

### G5.5 Primary formula

Let `I` be the set of accepted `OBJECTIVE_SEEKING` improvements in the selected scope.

For improvement `i`:

```text
w_i = frozen objective importance weight
T_i = 1 when the improvement translated, otherwise 0
```

Then:

```text
Objective Translation Efficiency
    = 100 × Σ(w_i × T_i) / Σ(w_i)
```

If the denominator is zero, the result is `UNKNOWN`, not `0%`.

### G5.6 Magnitude companion

A rate alone can hide whether translated improvements were tiny or large. Therefore the record also stores:

```text
weighted_objective_gain
```

This is computed from target-normalized Master Benchmark contribution records, not from raw local metric deltas.

### G5.7 Non-convergence rule

A project enters `NON_CONVERGENCE` when all of the following hold:

- one or more local engineering gains were accepted;
- the selected product objective remained below its target;
- cumulative Master Benchmark gain remained inside the frozen gray area;
- the condition persisted for the configured number of completed cycles.

The cycle threshold is Target Program policy. A recommended initial value is three completed cycles, but it is not universal.

The required response is not “perform more of the same.” It is:

```text
freeze current strategy
→ inspect the actual critical path
→ reassess the Current Method
→ reopen the Applicable Solution Frontier
→ propose architectural or instrumentation changes
```

### G5.8 Verdict interpretation

| Result | Meaning |
|---|---|
| `PRODUCT_GAIN` | Accepted objective-seeking work materially moved the declared objective |
| `ENGINEERING_ONLY` | Local engineering proof passed, but project-level objective gain did not clear the gray area |
| `REGRESSION` | The accepted project worsened the objective or a protected product outcome |
| `NON_CONVERGENCE` | Repeated accepted engineering work failed to move the unresolved project objective |
| `UNKNOWN` | No admissible objective-seeking comparison exists |

### G5.9 Murugan example

Illustrative only:

```text
Accepted objective-seeking improvements: 6
Materially translated improvements:      2
Objective Translation Efficiency:        33.3%
Engineering-only improvements:           4
Master Benchmark gain:                   +2.1%
Target:                                  60 FPS
Current:                                 25 FPS
Non-convergence streak:                  2 cycles
```

This result would not say that CLU-E failed. It would say that the current optimization strategy is producing mostly local gain and should be challenged before another similar cycle.

---

## G6. GOLD-02 — Cross-Environment Flow Efficiency

### G6.1 Purpose

Modern Target Programs often cross several execution environments:

```text
JavaScript
→ TypeScript
→ Node.js
→ Python
→ WebAssembly
→ WGSL / WebGPU
→ PowerShell
→ native process
→ browser worker
→ database or network service
```

A boundary can introduce:

- process startup;
- queue wait;
- serialization and deserialization;
- schema conversion;
- buffer copying;
- file-system round trips;
- IPC or network latency;
- synchronization;
- retry and timeout cost;
- context switching;
- duplicated validation;
- conversion defects.

`GOLD-02` measures the efficiency of the complete flow and of each boundary.

It answers:

> **How much of the end-to-end critical path performs useful target work, and how much is consumed by movement and translation between environments?**

### G6.2 Required instrumentation model

Every measured flow receives:

```text
flow_id
objective_id
scenario_id
entry_environment
exit_environment
ordered_environment_path
critical_path_spans
boundary_spans
payload identities
output identity
correctness verdict
environment fingerprint
```

Each boundary span is classified as one of:

```text
QUEUE_WAIT
PROCESS_STARTUP
SERIALIZE
DESERIALIZE
SCHEMA_CONVERT
COPY
IPC
FILE_ROUND_TRIP
NETWORK
SYNC_WAIT
RETRY
OTHER_BOUNDARY
```

### G6.3 Primary formula

For one end-to-end critical path:

```text
T_total
    = elapsed time from accepted input to validated output

T_boundary
    = critical-path time spent in boundary overhead

Cross-Environment Flow Efficiency
    = 100 × (1 - T_boundary / T_total)
```

The calculation uses the critical path, not a naive sum of overlapping parallel spans.

### G6.4 Required companion values

```text
end_to_end_ms
boundary_overhead_ms
useful_compute_ms
boundary_overhead_pct
environment_hop_count
serialized_bytes
copied_bytes
copy_count
queue_wait_ms
process_startup_ms
retry_count
conversion_error_rate
throughput
p50
p95
p99
```

### G6.5 Correctness and comparability gates

The metric is invalid when:

- output semantics changed without an approved objective change;
- workload differs;
- payload size differs without normalization;
- environment fingerprints are incompatible;
- instrumentation omits a material boundary;
- parallel spans are double-counted;
- retry behavior is hidden;
- the result was measured only on a warm or only on a cold path when both matter.

Higher efficiency is not automatically better if total latency worsens. Therefore the Golden Rail always displays both:

```text
efficiency percentage
and
end-to-end native latency / throughput
```

### G6.6 Aggregation across flows

A project-wide value may be produced only from a frozen weighting policy based on:

- objective criticality;
- observed traffic share;
- scenario importance;
- protected capability.

A rarely used internal tool path must not outweigh the main user-visible runtime path merely because it has more recorded spans.

### G6.7 Cross-environment finding generation

CLU-E should create candidates when:

- boundary overhead dominates a critical path;
- the same payload is repeatedly serialized or copied;
- process startup is paid per operation rather than per session;
- a language/runtime boundary exists only because of historical architecture;
- retry or conversion failures materially increase total cost;
- data is converted through several intermediate forms;
- GPU/CPU synchronization dominates the frame;
- a boundary can be replaced by a shared memory, persistent process, binary schema, batched call, direct GPU path, or consolidated runtime.

### G6.8 Murugan examples

Possible measured paths include:

```text
TypeScript scene logic
→ WebGPU command construction
→ WGSL compute / render
→ GPU completion

TypeScript editor
→ Python asset processing
→ serialized asset
→ browser import

Node orchestration
→ PowerShell host
→ Git / benchmark process
→ structured receipt
```

A low `GOLD-02` result should identify the exact boundary responsible, not merely show one aggregate percentage.

---

## G7. GOLD-03 — Master Benchmark Net Gain

### G7.1 Purpose

`GOLD-03` is the project-level answer to:

> **How much better is the complete accepted Target Program than the frozen baseline under the locked Master Benchmark?**

It is the principal whole-project result measure.

It must remain distinct from:

- candidate-specific proof benchmarks;
- local function or module metrics;
- one isolated FPS sample;
- subjective claims of improvement;
- code-quality changes with no project-level outcome.

### G7.2 Comparison envelope

A valid comparison binds:

```text
baseline project snapshot
current accepted project snapshot
Master Benchmark version and hash
scenario manifest
telemetry manifest
Project Intent objective set
normalization profile
environment fingerprint
warm-up policy
sample count
statistical method
quality and correctness guardrails
```

If the Master Benchmark changed materially, a bridge run is required. Otherwise the result is `NOT_COMPARABLE`.

### G7.3 Native evidence remains primary

For Murugan, the native result should retain at least the applicable values among:

```text
average FPS
1% low FPS
p95 and p99 frame time
CPU frame time
GPU frame time
VRAM peak
visible splat count
scene-load time
stutter count
frame pacing
visual-quality equivalence
scenario completion
```

No Golden score replaces these native values.

### G7.4 Normalized objective contribution

For benchmark objective `j`:

```text
b_j = baseline value
c_j = current value
t_j = target value
w_j = frozen objective weight
d_j = direction: MAXIMIZE or MINIMIZE
```

For a maximizing metric:

```text
p_j = (c_j - b_j) / max(|t_j - b_j|, epsilon)
```

For a minimizing metric:

```text
p_j = (b_j - c_j) / max(|b_j - t_j|, epsilon)
```

`p_j` is then:

- adjusted for the frozen gray area;
- bounded by the normalization profile so one outlier cannot dominate;
- invalidated when its evidence or environment is invalid.

The project-level result is:

```text
Master Benchmark Net Gain
    = 100 × Σ(w_j × p_j) / Σ(w_j)
```

This is a **project-specific objective aggregate**, not a universal software-quality score.

### G7.5 Non-offsettable regressions

The following cannot be averaged away by gains elsewhere:

- correctness failure;
- protected capability loss;
- unacceptable visual-quality reduction;
- security or safety regression;
- mandatory gate failure;
- benchmark invalidity;
- environment mismatch.

When one occurs:

```text
status = BLOCKED_BY_GATE or REGRESSION
```

The normalized gain may be retained for diagnosis, but cannot produce an improvement verdict.

### G7.6 Required companion values

```text
native_results[]
objective_contributions[]
net_gain_pct
coverage_pct
confidence
comparable_scenario_count
not_comparable_scenario_count
regression_count
guardrail_state
benchmark_version
environment_fingerprint
```

### G7.7 Cycle rule

Every completed RPI cycle must end with a deterministic Master Benchmark run.

The result becomes:

- the final `GOLD-03` value for that cycle;
- a vital baseline for the next cycle;
- a source of new findings and benchmark-enrichment candidates;
- an equilibrium gate.

A cycle with accepted patches but no final Master Benchmark run is incomplete.

---

## G8. GOLD-04 — Sustainable Capacity at Target Quality

### G8.1 Purpose

This is the additional Golden Metric proposed in this supplement.

A fixed-workload benchmark can hide important progress:

- FPS may be capped;
- latency may already be below a threshold;
- the benchmark may be too small to expose headroom;
- a faster system may simply spend more time idle;
- the current scenario may remain below the desired target even though capacity improved materially.

`GOLD-04` asks:

> **What is the maximum workload the Target Program can sustain while still satisfying the locked performance, correctness, quality, and stability contract?**

This measures architectural headroom rather than only improvement at one fixed workload.

### G8.2 General definition

Let `W` be a target-defined workload scale.

Examples:

```text
visible splats
active entities
concurrent users
requests per second
records processed
simulation agents
model tokens per second
asset volume
scene complexity
```

Let `PASS(W)` mean that all frozen service and quality constraints pass at workload `W`.

Then:

```text
Sustainable Capacity at Target Quality
    C* = max W such that PASS(W) is true
```

### G8.3 Capacity gain

```text
capacity_gain_pct
    = 100 × (C*_current - C*_baseline) / C*_baseline
```

Required companion values:

```text
baseline_capacity
current_capacity
target_capacity
capacity_gain_pct
capacity_headroom_ratio
limiting_constraint
failure_boundary
confidence
```

Where:

```text
capacity_headroom_ratio = C*_current / target_capacity
```

### G8.4 Murugan profile

A useful Murugan definition could be:

```text
Maximum visible Gaussian splats
at:
  p95 frame time <= 16.67 ms
  p99 frame time within the configured stability limit
  fixed resolution
  fixed visual-quality profile
  fixed camera path
  fixed scene semantics
  fixed hardware and driver policy
  no correctness or rendering defect
```

Additional capacity dimensions may be independently defined for:

- active NPCs;
- streamed world tiles;
- dynamic lights;
- editor overlays;
- physics entities;
- concurrent AI agents.

They must not be merged into one raw capacity number unless a frozen composite workload model exists.

### G8.5 Why this metric is valuable

`GOLD-04` detects improvements that `GOLD-03` may understate and exposes architectural limitations that local metrics cannot see.

Examples:

- fixed scene remains at 60 FPS because of VSync, but supported splat count rises by 40%;
- fixed scene improves only slightly, but thermal or memory stability at larger workloads improves substantially;
- local optimization reduces one pass, yet the sustainable capacity does not move because another bottleneck immediately dominates;
- an architectural rewrite materially expands the feasible workload frontier.

### G8.6 Search method

Capacity should be measured through a deterministic staircase or binary-search procedure:

```text
start from validated baseline workload
→ increase workload
→ repeat stable trials
→ stop at first reproducible contract failure
→ refine around the boundary
→ record limiting constraint
```

The procedure, sample count, warm-up, failure rule, and maximum search range are frozen before candidate results are interpreted.

---

## G9. Combined interpretation

The four metrics are designed to answer different questions.

| Situation | GOLD-01 | GOLD-02 | GOLD-03 | GOLD-04 | Interpretation |
|---|---:|---:|---:|---:|---|
| Cleaner code, unchanged product | Low / engineering-only | May improve | Flat | Flat | Local optimization is not translating |
| Boundary optimization | May rise | Strong rise | Moderate rise | Moderate rise | Cross-environment overhead was real |
| Major renderer redesign | High | May be unchanged | Strong rise | Strong rise | Architectural product gain |
| Benchmark gain through quality reduction | Appears positive until gate | Any | Blocked | Blocked | Invalid improvement |
| Fixed benchmark capped but larger scene supported | High | Any | Small/flat | Strong rise | Real headroom improvement |
| Three cycles of local gain, no objective movement | Non-convergence | Any | Flat | Flat | Reopen architecture / method frontier |

No one Golden Metric is sufficient by itself.

---

## G10. Effect on candidate ranking

### G10.1 Required candidate fields

Every candidate should add:

```yaml
golden_metric_ids: []
objective_ids: []
candidate_class: OBJECTIVE_SEEKING | MAINTENANCE | RELIABILITY | ASSURANCE | DEVELOPER_EXPERIENCE | INSTRUMENTATION
expected_master_benchmark_effect: []
expected_capacity_effect: []
suspected_critical_path_share: null
cross_environment_flow_ids: []
causal_hypothesis: ""
non_convergence_response: null
```

### G10.2 Performance labeling rule

A candidate may be labeled `PERFORMANCE` only when it names:

- an objective;
- a relevant Master Benchmark scenario or flow;
- a native expected effect;
- a proof method;
- a global guardrail.

Otherwise it is classified as maintenance, structural hygiene, instrumentation, or another honest class.

### G10.3 Ranking influence

Golden Metrics should influence ranking through explicit evidence such as:

- observed critical-path share;
- expected objective contribution;
- current non-convergence streak;
- cross-environment overhead share;
- capacity-limiting constraint;
- evidence confidence;
- proof feasibility.

Ease of change and local proof readiness remain useful, but must not allow a small easy optimization to outrank a well-supported critical bottleneck indefinitely.

### G10.4 Strategy escalation rule

When `GOLD-01` reports `NON_CONVERGENCE`, CLU-E must:

1. reduce priority for further changes based on the same unsupported optimization theory;
2. increase priority of profiling and causal-instrumentation tasks;
3. reassess `MH03` Method adequacy and Applicable Solution Frontier position;
4. propose at least one architectural alternative or stronger instrument;
5. require Creator visibility before continuing the same strategy.

---

## G11. UI integration

### G11.1 Golden Outcome Rail

The canonical 10 × 10 field remains unchanged.

Add a four-instrument rail beside Q2:

```text
┌───────────────────────────────────────────┬──────────────┐
│                                           │ GOLD-01      │
│       CANONICAL 10 × 10 GREAT BOOK        │ objective    │
│       GRID OR SPHERE                      ├──────────────┤
│                                           │ GOLD-02      │
│                                           │ environment  │
│                                           ├──────────────┤
│                                           │ GOLD-03      │
│                                           │ benchmark    │
│                                           ├──────────────┤
│                                           │ GOLD-04      │
│                                           │ capacity     │
└───────────────────────────────────────────┴──────────────┘
```

In a narrow panel, the rail may become a horizontal four-instrument strip.

The rail must not cover, resize unpredictably, or replace canonical metric cells.

### G11.2 Instrument content

Each Golden instrument shows:

```text
ID and short name
primary native or normalized value
delta from baseline
state label
trend
coverage
confidence
benchmark or flow version
evidence seal
```

Hover or click opens:

- native breakdown;
- exact formula;
- contributing canonical metrics;
- objective IDs;
- evidence artifacts;
- environment fingerprint;
- limitations;
- invalidity conditions;
- contributing Great Book entries.

### G11.3 Cross-highlighting

Selecting a Golden Metric highlights:

- canonical cells contributing to it;
- relevant Q1 units, modules, capability slices, or environment boundaries;
- relevant Q3 gauge if pinned;
- corresponding benchmark and host events in Q4.

This is one shared State-Sealed selection, not separate UI truth.

### G11.4 Q3 gauges

Golden Metrics may be pinned to the Four Neon Gauges, but do not automatically replace the operator's configured gauge set.

When pinned:

- the gauge receives a gold evidence frame;
- native value and normalized value remain distinguishable;
- categorical states are not forced into fake percentages;
- negative direction uses geometry and labels, not a color swap alone.

### G11.5 Sphere mode

In Q2 sphere mode, the Golden Outcome Rail should remain a fixed adjacent instrument rail rather than becoming ordinary sphere sectors. This preserves the distinction between:

```text
canonical catalogue coordinates
and
project-level outcome projections
```

---

## G12. Status contract projection

A future Status projection should include:

```yaml
goldenMetrics:
  schemaVersion: 1
  definitionHash: sha256
  cycleId: CYCLE-...
  targetId: TGT-...
  projectSnapshotId: sha256
  masterBenchmark:
    version: "..."
    hash: sha256
    environmentFingerprint: sha256
  items:
    - id: GOLD-01
      name: Objective Translation Efficiency
      state: PRODUCT_GAIN | ENGINEERING_ONLY | REGRESSION | NON_CONVERGENCE | UNKNOWN
      native: {}
      normalized: null
      delta: null
      coverage: 0.0
      confidence: 0.0
      evidenceArtifacts: []
      canonicalMeasureIds: []
      objectiveIds: []
      limitations: []
      stale: false
```

The Status State Seal must bind the Golden Metric definition hash, benchmark identity, environment identity, project snapshot, and evidence artifacts.

---

## G13. Suggested machine definition

Illustrative structure:

```yaml
schema_version: 1
supplement_id: CLUE_GOLDEN_METRICS
version: 1.0.0
canonical_catalogue_companion: CLUE_Canonical_Measurement_Catalogue_v6
display:
  family_key: GOLDEN_OUTCOME
  primary_colour: "#F4AF2D"
  hot_core_colour: "#FFE7A3"
  ordinary_grid_coordinates: false
metrics:
  - id: GOLD-01
    name: Objective Translation Efficiency
    direction: MAXIMIZE
    result_type: vector
    scope: PROJECT_CYCLE
    requires:
      - accepted_improvement_ledger
      - project_intent_model
      - master_benchmark_contributions
      - mandatory_gates
  - id: GOLD-02
    name: Cross-Environment Flow Efficiency
    direction: MAXIMIZE
    result_type: vector
    scope: PROJECT_FLOW
    requires:
      - distributed_trace
      - environment_path
      - boundary_span_classification
      - correctness_gate
  - id: GOLD-03
    name: Master Benchmark Net Gain
    direction: MAXIMIZE
    result_type: vector
    scope: PROJECT_CYCLE
    requires:
      - locked_master_benchmark
      - baseline_run
      - current_run
      - normalization_profile
      - mandatory_gates
  - id: GOLD-04
    name: Sustainable Capacity at Target Quality
    direction: MAXIMIZE
    result_type: vector
    scope: PROJECT_CAPACITY
    requires:
      - workload_scaler
      - target_quality_contract
      - capacity_search_protocol
      - environment_fingerprint
```

---

## G14. Evidence and anti-gaming rules

### G14.1 Objective gaming

CLU-E must not improve `GOLD-03` or `GOLD-04` by silently changing:

- resolution;
- quality preset;
- visible content;
- camera path;
- workload;
- target threshold;
- warm-up;
- sample window;
- hardware;
- driver;
- benchmark code;
- acceptance criteria.

Any approved change creates a new benchmark or environment version and may require a bridge run.

### G14.2 Candidate relabeling

A change cannot be labeled maintenance before execution and relabeled objective-seeking afterwards merely because the benchmark improved.

The candidate class is frozen before results.

An unexpected product gain may be recorded as a discovery, but it does not retroactively alter the original proof contract.

### G14.3 Selective scenario reporting

All required Master Benchmark scenarios execute. CLU-E may not report only scenarios that improved.

Missing or invalid scenarios reduce coverage and may block the result.

### G14.4 Average-only reporting

For interactive performance, average FPS or mean latency is insufficient. Applicable tail and stability measures remain mandatory.

### G14.5 Score compensation

A large gain in one objective cannot compensate for a non-offsettable protected regression.

### G14.6 Benchmark overfitting

Repeated optimization against a fixed visible path requires:

- holdout or challenge scenarios where feasible;
- benchmark-enrichment review;
- independent benchmark critique;
- stability and comparability checks.

---

## G15. Implementation plan

### G15.1 Proposed files

```text
config/measurements/golden-metrics.yaml
src/analysis/metrics/goldenMetrics.ts
src/analysis/metrics/objectiveTranslation.ts
src/analysis/environments/flowEfficiency.ts
src/experiment/masterBenchmark/masterBenchmarkGain.ts
src/experiment/masterBenchmark/capacitySearch.ts
src/status/goldenMetricsProjection.ts
selftest/golden-metrics.test.ts
selftest/cross-environment-flow.test.ts
selftest/master-benchmark-gain.test.ts
selftest/capacity-search.test.ts
```

Existing Status, Great Book, gauge, and dashboard files would receive projection and rendering changes.

### G15.2 Recommended implementation order

### Phase 1 — definitions and records

- define strict schemas;
- define definition hash and versioning;
- define native result records;
- define normalization and invalidity rules;
- bind definitions to mission/cycle authority.

### Phase 2 — Master Benchmark integration

- emit benchmark contribution records per accepted improvement;
- implement `GOLD-03`;
- implement benchmark comparability and bridge-run rules;
- implement final cycle result.

### Phase 3 — objective translation

- classify candidates before experiments;
- connect contributions to objective IDs;
- implement `GOLD-01`;
- implement non-convergence state and strategy escalation.

### Phase 4 — environment telemetry

- instrument cross-environment critical paths;
- classify boundary overhead;
- implement `GOLD-02`;
- generate boundary-specific findings.

### Phase 5 — capacity search

- define workload scalers;
- implement deterministic capacity-boundary search;
- implement `GOLD-04`;
- add Murugan splat/NPC/tile capacity profiles.

### Phase 6 — UI and Status

- add Golden Outcome Rail;
- add cross-highlighting;
- make Golden Metrics gauge-selectable;
- project through the sealed Status contract;
- preserve explicit stale, unknown, invalid, and blocked states.

---

## G16. Acceptance criteria

The supplement is operational only when all of the following pass:

1. The canonical 100-cell catalogue remains byte- and coordinate-compatible.
2. The Golden Metrics definition has a version and content hash.
3. Each Golden Metric resolves to native evidence and contributing canonical measures.
4. Missing evidence produces `UNKNOWN`, not zero.
5. Benchmark and environment changes produce `NOT_COMPARABLE` unless a valid bridge exists.
6. Mandatory gate failure cannot be averaged away.
7. Objective-seeking candidate classification is frozen before results.
8. A local improvement with no material product gain produces `ENGINEERING_ONLY`.
9. Repeated local gain without product convergence produces `NON_CONVERGENCE`.
10. Cross-environment flow calculation uses critical-path time and does not double-count parallel spans.
11. Master Benchmark gain retains all required native telemetry and scenario coverage.
12. Capacity search reproduces the same boundary within its frozen statistical tolerance.
13. Q2 displays four Golden instruments beside, not inside, the canonical field.
14. Gold is not the sole state carrier and does not imply generic success.
15. Status, Q2, Q3, Q4, CLI export, and durable artifacts agree on one Golden Metric identity.
16. Rebuilding projections reproduces the same Golden Metric records from events and artifacts.
17. A complete RPI cycle cannot close without a valid final `GOLD-03` result.
18. Performance equilibrium cannot be declared while `GOLD-01` is in unresolved `NON_CONVERGENCE`.
19. Golden Metric definitions, benchmark identity, normalization profile, and project snapshot are bound into the cycle evidence spine.
20. Adversarial tests prove that quality reduction, selective scenario omission, benchmark mutation, environment drift, and candidate relabeling cannot manufacture a Golden gain.

---

## G17. Initial Murugan policy recommendation

For Murugan, begin with the following priorities:

```text
GOLD-01
  Track whether accepted performance candidates produce material change in
  frame-time / FPS / capacity objectives.

GOLD-02
  Instrument TypeScript → WebGPU/WGSL, TypeScript → Python asset tooling,
  and Node → PowerShell benchmark/Git flows separately.

GOLD-03
  Use a fixed set of representative scenes with average FPS, 1% low,
  p95/p99 frame time, CPU/GPU frame time, VRAM, load time, and visual-quality guardrails.

GOLD-04
  Measure maximum visible splats at the locked target frame-time and quality,
  then add separate capacity profiles for active NPCs and streamed world tiles.
```

The initial non-convergence policy should be conservative:

```text
Three completed objective-seeking cycles
with accepted local gains
but no material GOLD-03 or GOLD-04 movement
    → NON_CONVERGENCE
    → mandatory Current Method / Applicable Solution Frontier review
```

This threshold should later be calibrated from Great Book evidence.

---

## G18. Final policy statement

The canonical Measurement Catalogue asks whether the project is correct, valuable, efficient, secure, maintainable, evidenced, and safely improvable.

The Golden Metrics add a narrower strategic question:

> **Is CLU-E's work actually moving the complete Target Program toward the outcome the Creator cares about?**

They do not replace local measures. They prevent local measures from becoming the finish line.

The required relationship is:

```text
canonical metrics
    → expose and prove local or systemic improvements

Golden Metrics
    → prove whether accepted improvements translate into project-level outcome,
      efficient cross-environment execution,
      Master Benchmark gain,
      and sustainable capacity

mandatory gates
    → prevent either layer from purchasing gain through unacceptable regression
```

With this supplement, CLU-E may still accept engineering-only improvements when they are valuable. It must simply name them honestly and must not confuse a cleaner implementation with completion of the Target Program's unresolved objective.
