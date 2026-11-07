# CLU-E RPI Documentation Pack v9

**Release date:** 2026-08-04
**Language:** English
**Methodology:** Recursive Project Improvement (RPI)
**Reference engine:** CLU-E
**Release purpose:** one standardized, non-duplicative permanent knowledge base describing what CLU-E is, how it works, and how it is executed — restored to full name/content integrity after a corrupted v8 deployment.

> **RPI is the method. CLU-E is the durable engine. Evidence decides whether a candidate is an improvement.**

---

## 1. What changed in v9

v9 is a **repair and re-baseline release**. The deployed v8 copy carried five documents under the wrong filenames (verified against the sealed v8 manifest by SHA-256), had lost the Constitution's content entirely, and carried one unsealed loose supplement. v9 restores every document under its correct name and applies these Creator-directed decisions (full record: `DOCUMENTATION_GOVERNANCE_v9.md` §14):

- every surviving v8 document's content is **preserved verbatim**; only filenames, headers, and cross-references changed;
- `CLUE_Constitution_v9.md` is an explicit **reconstruction from inherited invariants** quoted by the surviving documents — clause-level provenance included, **pending Creator ratification**, claiming no v8 verbatim authority;
- the Golden Metrics supplement is **fused into the Measurement Catalogue as Part II — Golden Outcome Rail** (`GOLD-01`–`GOLD-04`); the canonical 100 cells are byte-preserved and Golden Metrics never occupy grid coordinates; the standalone (misspelled, unsealed) file is retired;
- the two input templates are restored under `templates/` with v9 names; the configured runtime filenames `target description.md` and `benchmark.txt` are unchanged;
- every pack file adopts a uniform **`_v9`** name; each header records its prior standalone revision (`CLUE_Interface_Design_v9.md` supersedes standalone revision 10.0 — a renumber, not a rollback);
- the original v9 re-baseline preserved Status wire `5.0.0`; ratifiable executable amendments now compose the current runtime wire through `5.7.0` without rewriting historical snapshots;
- a fresh manifest and checksum seal replace the v8 release evidence.

All v8 standardization decisions remain in force: Master Benchmark is canonical (Central Benchmark deprecated); Q1 **ALL** is physical `Project → Family → Environment → File`; Q1 **DIVE** is semantic `Domain → Subsystem → Module → Class/Type → Function/Method` with the selected file as context; the **Great Book** is the durable ledger and the **Great Book Improvement Field** its Q2 visualization; current implementation work lives only in the external dynamic backlog.

---

## 2. The system in one diagram

```text
Creator-defined project intent
        +
locked target description.md
        +
locked benchmark.txt
        +
exact repository / environment state
                ↓
Deterministic inventory and native recognition
                ↓
Universal Project Representation and AI semantic enrichment
                ↓
Metric applicability, findings, and evidence-linked hypotheses
                ↓
Candidate-specific proof design
                ↓
Isolated Git worktree implementation and deterministic execution
                ↓
Evidence digest, AI interpretation, mandatory gates, Custodian decision
                ↓
Accepted project state and Great Book record
                ↓
Master Benchmark enrichment review and final whole-project run
                ↓
Next-cycle vital input or bounded equilibrium
```

---

## 3. Reading order

1. **`RPI_Core_Methodology_v9.md`** — the project-independent method, proof doctrine, Master Benchmark lifecycle, value model, and bounded equilibrium.
2. **`CLUE_Constitution_v9.md`** — identity, roles, truth hierarchy, authority boundaries, constitutional invariants, and claim limits *(reconstruction — pending Creator ratification)*.
3. **`CLUE_Architecture_v9.md`** — planes, records, state machines, identity, storage, services, and security boundaries.
4. **`CLUE_Execution_Model_v9.md`** — the exact operational sequence from target registration through cycle closure, benchmark enrichment, and equilibrium.
5. **`CLUE_AI_Utilization_v9.md`** — where AI belongs, where it does not, context construction, routing, caching, auditability, and AI-efficient benchmark governance.
6. **`CLUE_Git_Integration_v9.md`** — local Git, worktree, branch, commit, remote, review, publication, reconciliation, retention, and recovery.
7. **`CLUE_Canonical_Measurement_Catalogue_v9.md`** — Part I: the canonical 100-measure system, applicability, native evidence, normalization, Great Book contribution rules; Part II: the Golden Outcome Rail (`GOLD-01`–`GOLD-04`).
8. **`CLUE_Status_Contract_v9.md`** — the one sealed operational read model (v9 baseline `5.0.0`, current additive runtime wire `5.7.0`).
9. **`CLUE_Interface_Design_v9.md`** — the two-tab, four-quadrant operator interface and Configuration behavior.
10. **`CLUE_Q1_System_Navigator_v9.md`** — the complete permanent ALL/DIVE System Navigator contract.
11. **`CLUE_Project_Directory_v9.md`** — the target source-tree and responsibility map for implementing the architecture.
12. **`DOCUMENTATION_GOVERNANCE_v9.md`** — authority order, single-owner rules, terminology, versioning, conflict resolution, and the v7→v8 and v8→v9 migration records.
13. **`templates/target_description.template_v9.md`** and **`templates/benchmark.template_v9.txt`** — target-project input templates.
14. **`VALIDATION_REPORT_v9.md`**, **`DOCUMENTATION_MANIFEST_v9.json`**, and **`SHA256SUMS_v9.txt`** — release validation and integrity evidence.

---

## 4. Document ownership at a glance

| Question | Authoritative document |
|---|---|
| What is the general improvement method? | `RPI_Core_Methodology_v9.md` |
| What may CLU-E claim or do? | `CLUE_Constitution_v9.md` |
| Which components and records exist? | `CLUE_Architecture_v9.md` |
| What happens during an actual cycle? | `CLUE_Execution_Model_v9.md` |
| How is AI used and budgeted? | `CLUE_AI_Utilization_v9.md` |
| How are versions isolated, committed, published, and recovered? | `CLUE_Git_Integration_v9.md` |
| Which measures, gates, and Golden Metrics exist? | `CLUE_Canonical_Measurement_Catalogue_v9.md` |
| What does the operational snapshot contain? | `CLUE_Status_Contract_v9.md` |
| How is status presented and controlled? | `CLUE_Interface_Design_v9.md` |
| How exactly does Q1 ALL/DIVE behave? | `CLUE_Q1_System_Navigator_v9.md` |
| Which source area owns each responsibility? | `CLUE_Project_Directory_v9.md` |
| How are documentation conflicts prevented? | `DOCUMENTATION_GOVERNANCE_v9.md` |
| What remains to be built or repaired now? | external dynamic backlog (`CLU-E_Backlog_and_Program_Integrity_v8.md` or successor), not this archive |

A non-owning document may summarize another domain only to explain a boundary. It must link to the owning document instead of restating the full contract.

---

## 5. Permanent knowledge versus dynamic work state

This archive contains only durable project knowledge: methodology, constitution, target architecture, execution doctrine, data and interface contracts, acceptance rules, templates, and documentation governance. It intentionally excludes current implementation percentages, defects and audit findings, open development tasks, file-by-file remediation order, sprint sequencing, temporary notes, and current test results — those belong to the separately versioned dynamic backlog. This separation prevents an old delivery snapshot from becoming permanent architectural truth.

---

## 6. Canonical terminology

```text
RPI                    Recursive Project Improvement methodology
CLU-E                  reference engine and durable institution implementing RPI
CLUE                   technical namespace and file/schema prefix
Target Program         registered project being assessed or improved
Creator                human authority defining mission and protected intent
Custodian              sole ordinary authority for canonical landing/revert
Project Intent Model   structured form compiled from target description.md
Master Benchmark       evolving whole-project observation instrument
Candidate Benchmark    hypothesis-specific A/B proof instrument
Golden Outcome Rail    GOLD-01..04 project-level outcome projections (Catalogue Part II)
Great Book             durable improvement and negative-knowledge ledger
Great Book Field       Q2 visualization of Great Book contributions
ALL                    Q1 physical repository topology
DIVE                   Q1 semantic architecture scoped by a selected file
Bounded Equilibrium    snapshot- and envelope-specific terminal state
```

---

## 7. Release integrity

`SHA256SUMS_v9.txt` contains hashes for every release file except itself. `DOCUMENTATION_MANIFEST_v9.json` records document roles, versions, prior revisions, sizes, and hashes. `VALIDATION_REPORT_v9.md` states exactly what was checked in building v9 — including the hash-verified displacement map of the corrupted v8 copy — and what was deliberately outside documentation validation.

Documentation validation establishes internal coherence of this knowledge base. It does not certify executable CLU-E, any target program, or any improvement claim.

---

## 8. Executable-alignment amendments

The permanent v9 pack has additive executable-alignment amendments through Status wire 5.7.0.
ADR-0017 records the operational OpenAI gateway boundary, provider-side monetary authority,
controlled billing-exhaustion pause, exact token-use telemetry and manual local-first Git Sync.
ADR-0020 proposes `gpt-5.6-sol` as the exact legacy P2 model. The governance record in §19 explains
the model check, Creator ratification and evidence epoch. P2 closure also requires a real
proof-authoritative ACCEPT cycle.
