# CLU-E Constitution v9
## Identity, Roles, Truth Hierarchy, Authority Boundaries, and Constitutional Invariants

**Document status:** reconstructed constitutional contract — **pending Creator ratification**
**Revision:** 9.0 (reconstruction 1.0)
**Language:** English
**Methodology:** `RPI_Core_Methodology_v9.md`
**Normative companions:** `CLUE_Architecture_v9.md`, `CLUE_Execution_Model_v9.md`, `CLUE_AI_Utilization_v9.md`, `CLUE_Git_Integration_v9.md`, `CLUE_Canonical_Measurement_Catalogue_v9.md`, `CLUE_Status_Contract_v9.md`, `CLUE_Interface_Design_v9.md`, `CLUE_Q1_System_Navigator_v9.md`, and `CLUE_Project_Directory_v9.md`
**Intentionally out of scope:** component schemas, operational ordering, metric definitions, Git mechanics, current implementation status, and backlog.

> **Reconstruction notice.** The original `CLUE_Constitution_v8.md` content (sealed v8 manifest: sha256 `8d776ab6343a8951cd488b7c9cf78c0af4594b269c828a57977c365a9cdc971a`, 425 lines, 2 721 words) was absent from the corpus available at the v9 re-baseline; the file carrying its name held a different document. Under CLU-E's own rule that nothing may be invented, this v9 Constitution contains **only** principles recoverable from the surviving v8 documents — inherited invariants they quote, roles and limits they define, and boundaries they enforce. Section 9 maps every article to its recovery source. No sentence here claims to be v8 verbatim text. If the original v8 file is recovered, the Creator resolves any divergence under `DOCUMENTATION_GOVERNANCE_v9.md` §12; until ratification, where this document and a surviving v8-content document conflict, the surviving document prevails within its scope.

---

# 1. Identity

1.1 **Recursive Project Improvement (RPI)** is the methodology. **CLU-E** is the durable engine and institution that implements it. A different implementation may conform to RPI without reproducing CLU-E; CLU-E may not violate RPI.

1.2 CLU-E exists to drive a registered **Target Program** toward its highest demonstrated fitness for protected intent — through proof, not opinion. Its defining property is **continuity of intent despite discontinuity of sessions**: no session owns mission continuity, and no unique mission state may exist only inside a model context window. The mission, findings, proofs, and decision history are durable records that outlive any session.

1.3 CLU-E is a deterministic evidence system with an AI reasoning layer — not an AI process surrounded by incidental tools. An AI model is a temporary working organ of the institution: it may read, interpret, hypothesize, design, and propose; it may not remember for the institution, decide for the institution, or accept its own results.

1.4 CLU-E may register itself as a Target Program. Self-assessment follows the same registration, evidence, and proof rules as any other target and never receives a privileged proof path.

---

# 2. Roles and human authority

2.1 The **Creator** is the human mission authority. The Creator defines protected intent (`target description.md`), the whole-project observation contract (`benchmark.txt`), mission and policy versions, required approvals, and value policy. The Creator's working tree is protected: no candidate modifies it during ordinary experimentation.

2.2 The **Custodian** is the sole ordinary authority for landing a change into, or reverting a change from, the canonical accepted state. Custodian action is gated: it requires a valid frozen proof contract, admissible evidence, all applicable mandatory gates passed, and an authority token. No other module, model, or convenience path may land or revert.

2.3 An **Operator** observes and commands through governed interfaces. Interfaces present truth; they do not create it.

2.4 **AI roles** are advisory organs with bounded scope. AI owns no filesystem, Git, benchmark, metric, verdict, or landing authority. AI may recommend a verdict; only the deterministic evaluation state machine may issue one.

2.5 **Deterministic instruments** — parsers, compilers, test runners, profilers, benchmark runners, Git, browsers, databases — are the factual execution authority in their domains. AI does not replace them; it interprets what they establish.

---

# 3. Truth hierarchy

When sources of information disagree, authority descends in this order, each binding the levels below it:

```text
1. deterministic native evidence from validated instruments
2. durable records: append-only event log + immutable content-addressed artifacts
3. compiled governed models (Project Intent Model, Master Benchmark Specification,
   Universal Project Representation) — versioned, hashed, provenance-linked
4. AI interpretation — schema-validated, ledgered, uncertainty-preserving
5. projections, Status snapshots, and presentation — rebuildable, never authoritative
```

3.1 The append-only, hash-chained event log is the one durable state-transition authority. Projection databases contain no independent truth: deleting them and rebuilding from events plus artifacts must reproduce the same canonical projections.

3.2 No AI output becomes fact merely because it is fluent. An AI claim becomes usable only after schema validation, provenance recording, and — where it asserts improvement — admissible proof.

3.3 Absence of evidence is reported as `UNKNOWN`, `OPEN`, `STALE`, or `UNAVAILABLE` — never as an invented zero, an invented healthy state, or a silently substituted value.

3.4 `target description.md` is authoritative for **declared intent**, never for observed truth. A declared objective does not prove it is met; CLU-E compares declaration with deterministic structure, executable behavior, and benchmark evidence.

3.5 No visual projection, dashboard, or export is a source of truth, and Status is a projection over durable records — never a source used to reconstruct them.

---

# 4. Constitutional invariants

## 4.1 Epistemic invariants (inherited verbatim set)

The following rules are quoted across the surviving v8 documents as CLU-E's constitutional rules and are adopted here unchanged:

1. purpose before metric;
2. proof before improvement;
3. proposal, state, and proof remain separate;
4. no hidden trade-off;
5. no equilibrium claim beyond the Assessment Envelope;
6. every environment in its native semantics before cross-environment synthesis;
7. intent before method judgment;
8. applicable frontier before trend following;
9. proof authority and instrument validity before verdict;
10. forecast value distinct from realized value;
11. local equilibrium distinct from project RPI equilibrium.

## 4.2 Structural invariants (true by construction)

The architecture must make these properties true by construction, and no policy, convenience, or deployment choice may suspend them:

1. no session owns mission continuity;
2. no AI output becomes fact merely because it is fluent;
3. no candidate modifies the protected Creator tree during ordinary experimentation;
4. no verdict depends on an unversioned input;
5. no visual projection becomes a source of truth;
6. no projection database is required to recover durable state;
7. no accepted change can be confused with a different commit, tree, benchmark, environment, or proof contract;
8. no complete cycle ends without whole-project observation;
9. no equilibrium claim hides unsupported scope or immature benchmark coverage.

## 4.3 Process separation

Observation, hypothesis, proposal, implementation, and proof are distinct record classes with distinct owners. Nothing counts as an improvement until its claim survives an admissible comparison against a frozen baseline under a proof contract frozen **before** the result. A generated patch is a candidate artifact, not an accepted improvement. Execution instruments may collect evidence; they may not reinterpret or accept their own results.

---

# 5. Authority boundaries

5.1 Authority is issued as scoped, expiring capability and attempt tokens. Control-plane code may decide that an action is **permitted**; it may never decide that a candidate is **improved** — that belongs solely to the evaluation state machine under the proof contracts.

5.2 A missing or malformed safety policy **fails closed** for any mode that could mutate files, execute external tools, call an external AI provider, or land Git changes.

5.3 No module may bypass control, authority, evidence, or Status boundaries merely because it can reach the same filesystem or process. The restricted host executes only its closed command registry and never accepts an arbitrary shell command from AI or browser code.

5.4 Experiment isolation is mandatory: candidates are built and tested in leased, isolated worktrees against an immutable pinned basis; every mutation is classified by the Change-Set Partition; quarantine and cleanup are governed, receipted operations.

5.5 Provider state is subordinate: a remote review, approval, or passing check is evidence to reconcile — never an RPI verdict and never a landing authority.

---

# 6. Claim limits

6.1 CLU-E claims an improvement only for the exact scope, snapshot, environment, benchmark version, and proof contract that produced its evidence — nothing broader.

6.2 **Bounded Equilibrium** is the only terminal quality claim. It is always qualified by project snapshot, mission, benchmark, measurement, environment, model/tool, risk, budget, and value envelope. "Perfect" may be used as a presentation label only when it resolves to a valid bounded-equilibrium certificate, and never as a claim of absolute optimality.

6.3 A failed applicable mandatory gate (`MJ01`–`MJ07`) blocks `ACCEPTED_PROVEN` regardless of positive movement elsewhere; gate failures, protected-capability losses, and correctness or safety regressions are never averaged away by gains.

6.4 Forecast value is never presented as realized value; unknown assurance value is never coerced to zero; a target-specific gray area is reported, never converted into improvement.

6.5 Historical evidence is never silently reinterpreted: retired identifiers are not reused, renames do not rewrite history, and a breaking change requires explicit migration under documentation governance.

---

# 7. Custody and durable memory

7.1 The **Great Book** is the durable institutional ledger of accepted improvements, rejected hypotheses, negative knowledge, proofs, value, invalidation, and provenance. Rejected and inconclusive outcomes are first-class records: a measure session is never forced to manufacture a patch.

7.2 Every completed cycle closes with a deterministic whole-project Master Benchmark run; its result seeds the next cycle's vital input. A cycle with accepted patches but no closing run is incomplete.

7.3 Every landing is reversible under the active custody policy: a verified rollback or restoration path appropriate to the change's risk is a precondition of acceptance, not an afterthought.

---

# 8. Amendment and ratification

8.1 This reconstruction is subordinate to Creator ratification. Ratification, amendment, or replacement follows the change procedure and conflict-resolution rules of `DOCUMENTATION_GOVERNANCE_v9.md`; within the authority order, this document holds the Constitution's rank only for the principles it contains.

8.2 If the original v8 Constitution content is recovered (verifiable against sha256 `8d776ab6…`), a clause-level reconciliation is mandatory; divergences are product decisions for the Creator, and the outcome is recorded in the next governance migration section.

8.3 No amendment may weaken an inherited invariant of §4.1, a structural invariant of §4.2, or a mandatory gate, except by explicit Creator decision recorded as a breaking change with migration notes.

---

# 9. Reconstruction provenance map

| Article(s) | Recovered from (v9 filename, carrying preserved v8 content) |
|---|---|
| 1.1, 4.3 (frozen-baseline rule), 1.4 | `RPI_Core_Methodology_v9.md` §1–§2 (method/engine distinction; recursion; self-assessment without privileged proof) |
| 1.2–1.3, 4.2, 3.1, 3.5 | `CLUE_Architecture_v9.md` §1 architectural objective ("true by construction" list) and preamble |
| 2.1–2.2, terminology of roles | `README_v9.md` §6 canonical terminology; `DOCUMENTATION_GOVERNANCE_v9.md` §5.1 |
| 2.4–2.5, 3.2 | `CLUE_AI_Utilization_v9.md` executive conclusion; `CLUE_Project_Directory_v9.md` §12 (AI layer owns no authority), §15.4 (evaluation issues verdicts), §16 (instruments may not accept themselves) |
| 3 (hierarchy), 3.3 | `CLUE_Status_Contract_v9.md` preamble and `UNKNOWN`-not-invented rule; `CLUE_Project_Directory_v9.md` §9 (event log sole authority; SQLite no independent truth), §19.2 |
| 3.4 | `DOCUMENTATION_GOVERNANCE_v9.md` §5.3; `CLUE_Architecture_v9.md` §25.3 |
| 4.1 | `CLUE_Canonical_Measurement_Catalogue_v9.md` Part I §12 ("CLU-E retains its own constitutional rules", quoted unchanged) |
| 5.1–5.3 | `CLUE_Project_Directory_v9.md` §3.3 (fail closed), §5.1 (restricted host), §8 (control plane limits), §21 rules |
| 5.4–5.5 | `CLUE_Git_Integration_v9.md` and `CLUE_Project_Directory_v9.md` §17 (worktree isolation, Change-Set Partition, provider approval ≠ verdict) |
| 6.2 | `DOCUMENTATION_GOVERNANCE_v9.md` §5.5 (Bounded Equilibrium; "Perfect" as label only) |
| 6.3 | `CLUE_Canonical_Measurement_Catalogue_v9.md` Part I §2.3 and §6 (Area J gates) |
| 6.4 | `CLUE_Canonical_Measurement_Catalogue_v9.md` Part I (MJ06 gray-area rule; MK19 forecast/realized separation) |
| 6.5, 8.1–8.3 | `DOCUMENTATION_GOVERNANCE_v9.md` §10.3, §11, §12; `CLUE_Project_Directory_v9.md` §23 |
| 7.1–7.3 | `README_v9.md` §6; `CLUE_Canonical_Measurement_Catalogue_v9.md` Part I §1 and §3.7; `CLUE_Execution_Model_v9.md` §1–§2; Part II §G7.7 |

---

# 10. Final constitutional rule

> **The institution remembers; the session assists. Deterministic evidence outranks interpretation, interpretation outranks presentation, and nothing is an improvement until it is proven against a frozen baseline within an explicit envelope. Whatever a session, a model, a projection, or a convenience path suggests — the event log, the proof contract, the mandatory gates, and the Custodian decide.**
