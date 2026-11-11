# CLU-E Documentation Governance v10

**Document status:** v10 release candidate — not active authority until explicit Creator ratification  
**Release:** CLU-E RPI Documentation Pack v10.0-rc1  
**Carried-forward basis:** `DOCUMENTATION_GOVERNANCE_v9.md`  
**Primary v10 change:** Project Profile authority, release promotion and historical P2 preservation  

This file preserves the complete v9 body below and adds the coordinated Project Profiles amendment at the end. Where the carried-forward single-target wording conflicts with the v10 amendment, the v10 amendment controls only after this pack is promoted, resealed, explicitly ratified, and a successor evidence epoch is opened. Until then, the installed v9 pack remains the P2 authority.

---

# Part I — Carried-forward v9 authority

# CLU-E Documentation Governance v9
## Authority Order, Single-Owner Rules, Terminology, Versioning, and Change Control

**Document status:** permanent normative documentation-governance contract  
**Revision:** 9.2 (pack release 9.0) — revision 8.0 content preserved at the v9 re-baseline; §17 records executable-alignment ADRs through ADR-0016 and §18 records the final ADR-0017 Creator decisions that require a fresh seal, ratification and evidence epoch.  
**Language:** English  
**Applies to:** the CLU-E permanent project knowledge base and every future coordinated documentation release  
**Does not contain:** executable-program backlog, current implementation maturity, sprint status, or transient audit findings

> **One concept has one authoritative owner. Other documents summarize the boundary and link to the owner.**

---

# 1. Purpose

CLU-E is described by several documents because methodology, constitutional authority, technical architecture, operation, AI policy, Git custody, measurement, status, interface behavior, and component-specific design are different kinds of truth. A multi-document system becomes unreliable when each file independently restates the same doctrine, evolves at a different speed, or mixes stable architecture with temporary implementation status.

This contract prevents that failure by defining:

- the release authority order;
- one owning document for each subject;
- permitted and prohibited duplication;
- canonical terminology;
- rules for normative and informative text;
- version and compatibility policy;
- separation of permanent knowledge from dynamic backlog;
- cross-document change procedure;
- conflict resolution and validation requirements.

---

# 2. Authority order

When two permanent documents appear to disagree, apply the following order only within the scope owned by each document:

1. `RPI_Core_Methodology_v9.md` — project-independent RPI conformance;
2. `CLUE_Constitution_v9.md` — CLU-E identity, authority, claim, and constitutional invariants;
3. domain contracts:
   - `CLUE_AI_Utilization_v9.md`;
   - `CLUE_Git_Integration_v9.md`;
   - `CLUE_Canonical_Measurement_Catalogue_v9.md`;
   - `CLUE_Status_Contract_v9.md`;
   - `CLUE_Q1_System_Navigator_v9.md`;
4. `CLUE_Architecture_v9.md` — component integration and record ownership;
5. `CLUE_Execution_Model_v9.md` — operational ordering and cycle transitions;
6. `CLUE_Interface_Design_v9.md` — presentation and operator interaction;
7. `CLUE_Project_Directory_v9.md` — source-tree placement and implementation ownership;
8. `README_v9.md` and `VALIDATION_REPORT_v9.md` — navigation and release evidence.

The order does not allow one document to override a higher document outside its own domain. For example, the Status Contract owns the status schema but cannot redefine an RPI verdict; the Interface Design owns presentation but cannot invent a status field; the Project Directory owns source placement but cannot alter the Git authority model.

---

# 3. Single-owner matrix

| Subject | Sole detailed owner | Permitted summaries elsewhere |
|---|---|---|
| RPI definition, proof doctrine, value, equilibrium | RPI Core Methodology | one-paragraph boundary summaries |
| CLU-E identity, roles, constitutional principles, claim limits | Constitution | role references and invariant citations |
| system planes, records, state machines, storage, services | Architecture | component names and integration references |
| end-to-end mission/cycle ordering | Execution Model | abbreviated diagrams only |
| AI roles, context, model routing, token policy, cache, AI ledger | AI Utilization | role boundaries and status links |
| repository/worktree/branch/commit/remote/cloud lifecycle | Git Integration | lifecycle state references only |
| metric identities, coordinates, definitions, applicability, gates | Measurement Catalogue | metric IDs and presentation rules |
| canonical operational snapshot schema | Status Contract | field consumption and display requirements |
| global operator UX and Configuration | Interface Design | no independent schema definitions |
| Q1 ALL/DIVE behavior, taxonomy, protocol, performance | Q1 System Navigator | concise Q1 purpose and mode summary |
| source paths and module responsibility | Project Directory | no duplicate architecture prose |
| current defects, open work, implementation sequence | external dynamic backlog | no permanent-copy restatement |

A domain owner may repeat a short constitutional rule when necessary to make a security or safety boundary understandable. The repeated text must be marked as an inherited invariant and may not be extended independently.

---

# 4. Permitted and prohibited repetition

## 4.1 Permitted

A non-owner document may include:

- a one-sentence definition;
- a compact boundary diagram;
- a field or metric identifier used by that document;
- a summary of an external state transition;
- a direct normative cross-reference;
- an example clearly labeled informative.

## 4.2 Prohibited

A non-owner document must not copy:

- complete record schemas owned elsewhere;
- full lifecycle descriptions owned elsewhere;
- the complete measurement catalogue or coordinate table;
- the complete Change-Set Partition;
- the complete Q1 taxonomy or interaction contract;
- file-by-file development plans;
- current implementation-status tables;
- duplicated acceptance gates with independently edited wording.

When a detailed section is moved to its owner, the former location must be replaced with a short summary and a link. It must not retain a near-duplicate “for convenience.”

---

# 5. Canonical terminology

## 5.1 Names

- The product name is **CLU-E**.
- The technical identifier, schema namespace, and historical file prefix may use **CLUE**.
- The methodology is **Recursive Project Improvement (RPI)**.
- A registered subject is a **Target Program**.
- The human mission authority is the **Creator**.
- The gated canonical writer is the **Custodian**.

## 5.2 Benchmark terminology

- **Master Benchmark** is the canonical term for the evolving whole-project observation instrument.
- **Candidate Benchmark** is the hypothesis-specific baseline/candidate proof instrument.
- **Central Benchmark** is a deprecated v7 alias for Master Benchmark. New normative prose must not use it except in migration notes.
- A candidate benchmark may contribute a durable scenario, signal, threshold rationale, or stress envelope to the Master Benchmark, but the historical A/B experiment is not automatically promoted.

## 5.3 Intent inputs

The exact configured filenames are:

```text
target description.md
benchmark.txt
```

`target description.md` is authoritative for declared intent, not observed implementation truth. `benchmark.txt` defines or references executable whole-project observation; it is not itself a result file.

## 5.4 Great Book terminology

- **Great Book** — durable record of accepted improvements, rejected hypotheses, negative knowledge, proof, value, invalidation, and provenance.
- **Great Book Improvement Field** — Q2 visualization of normalized contribution records on the canonical 10 × 10 grid.
- The historical phrase *Great Book of Efficiency* may appear only in migration context.

## 5.5 Equilibrium terminology

**Bounded Equilibrium** is the canonical stopping condition. It is always qualified by project snapshot, mission, benchmark, measurement, environment, model/tool, risk, budget, and value envelope. “Perfect” may be used as a presentation label only when it resolves to a valid bounded-equilibrium certificate and never as a claim of absolute optimality.

## 5.6 Q1 terminology

```text
ALL  = physical repository topology
DIVE = semantic architecture scoped by a selected physical file
```

Family and environment are ALL projection groups, not semantic architecture levels. File is DIVE context, not a visible DIVE hierarchy node.

---

# 6. Normative language

The words **must**, **must not**, **required**, and **prohibited** are normative. **Should** is a strong default that may be changed only by a documented policy decision. **May** is permitted behavior. **Example**, **recommended**, and **informative** do not create authority unless another normative sentence adopts them.

Every document header states:

- status;
- revision;
- language;
- scope;
- owning subject;
- intentionally excluded subjects.

---

# 7. Permanent knowledge versus dynamic state

## 7.1 Permanent knowledge base

The release archive may contain:

- methodology and constitutional rules;
- target architecture and data contracts;
- stable execution doctrine;
- component behavior and acceptance criteria;
- templates and schema examples;
- documentation governance and release validation.

## 7.2 Dynamic file outside the archive

The following belong in `CLU-E_Backlog_and_Program_Integrity_v8.md` or its successor:

- current P0/P1/P2 defects;
- current program-integrity audit;
- current implementation maturity;
- current file-by-file work items;
- active dependency order;
- temporary migration notes;
- completed/open status;
- current test evidence and host limitations;
- sprint or release planning.

A permanent document may state an acceptance rule or target file responsibility. It may not state whether the executable source currently satisfies that rule.

---

# 8. Target-specific material

CLU-E core documentation is target-independent. Target-specific profiles, including Murugan scenarios, metrics, capability catalogues, benchmark recipes, or domain packs, live with the registered Target Program or in a dedicated profile package.

Core documents may use Murugan as an informative example, but must not make Murugan paths, technologies, or objectives universal CLU-E requirements.

---

# 9. Cross-reference rules

- References use exact current filenames.
- A release may not contain references to superseded pack-local versions except in the migration section of this document.
- A domain summary ends with an explicit owner reference when more detail exists.
- Embedded hashes are used only when generated after documents are sealed; ordinary prose must not hardcode a hash that will become self-invalidating during editing.
- External standards or provider documents are informative unless the mission or policy explicitly imports them as an authority.

---

# 10. Versioning

## 10.1 Release version

The pack version identifies one coordinated documentation baseline. v8 is the first release governed by the single-owner model.

## 10.2 Document version

Each document has its own revision because domain contracts may evolve at different rates. A coordinated release records the exact set in `DOCUMENTATION_MANIFEST_v9.json`.

## 10.3 Breaking changes

A breaking change includes:

- altered authority boundary;
- renamed or repurposed canonical identifier;
- changed record semantics;
- changed state-machine transition;
- moved metric coordinate;
- changed Q1 entity meaning;
- changed benchmark authority;
- changed required input contract.

Breaking changes require:

1. explicit migration notes;
2. compatibility classification;
3. updates to every consuming contract;
4. validation fixtures;
5. no silent reinterpretation of historical evidence.

---

# 11. Change procedure

A coordinated documentation change follows:

```text
1. Identify the owning document.
2. Change the owner first.
3. List all consumers from the ownership matrix.
4. Replace consumer detail with the smallest sufficient reference.
5. Update terminology and schema versions.
6. Remove current-state material to the dynamic backlog.
7. Run structural, terminology, cross-reference, invariant, and checksum validation.
8. Seal the manifest and archive.
```

A change is incomplete when one document has the new rule while another still contains a competing old rule.

---

# 12. Conflict resolution

When a conflict is found:

1. classify it as wording, scope overlap, schema mismatch, authority conflict, or product decision;
2. resolve wording and overlap directly through the owner matrix;
3. resolve schema mismatch by the schema owner and update consumers;
4. resolve authority conflict in favor of the Constitution or RPI methodology as applicable;
5. ask the Creator only when two genuinely different product behaviors remain possible and source material does not establish which one is intended;
6. record the decision in the next governance migration section.

Silently averaging two contradictory behaviors is prohibited.

---

# 13. v7 to v8 reconciliation record

*Historical record. Filenames in this section are the pack-local names as of the v8 release and are intentionally not rewritten to v9.*

The v8 release applies these decisions:

| v7 overlap or conflict | v8 resolution |
|---|---|
| RPI cycle repeated in Constitution, Implementation, Strategy, AI strategy, and directory | detailed lifecycle owned by `CLUE_Execution_Model_v8.md`; other files retain only boundary summaries |
| AI model routing and token discipline spread across Strategy and Implementation | detailed ownership moved to `CLUE_AI_Utilization_v2.md` |
| full Git records and flows duplicated in Implementation, Status, Strategy, and Git contract | detailed lifecycle remains only in `CLUE_Git_Integration_v2.md`; Status projects it, Interface renders it |
| Q1 hierarchy in Interface conflicted with the newer Q1 strategy | `CLUE_Q1_System_Navigator_v2.md` supersedes the old hierarchy; Interface contains only the concise mode contract |
| `Domain → … → File → …` in DIVE | File removed as a visible semantic level and retained as scope context |
| ALL mixed physical and semantic hierarchy | ALL standardized to `Project → Family → Environment → File` |
| Central Benchmark versus Master Benchmark | Master Benchmark is canonical; Central Benchmark is deprecated |
| current implementation-status appendices embedded in permanent documents | removed from the archive and consolidated into the external dynamic backlog |
| AI and Q1 file-by-file work plans embedded in strategy documents | moved to the external dynamic backlog; permanent docs retain stable ownership and acceptance contracts |
| project directory mixed supplied-current files with target architecture | v8 directory is a target ownership map; current file conformance belongs to the backlog/audit |
| Murugan-specific domain packs inside the general implementation architecture | target-specific details are external profiles; core retains examples only |
| Great Book of Efficiency / Great Book Improvement Field used interchangeably | Great Book = durable ledger; Great Book Improvement Field = Q2 visualization |

---

# 14. v8 to v9 re-baseline record

The v9 release repairs a corrupted deployment of the v8 knowledge base and applies the following Creator-directed decisions. Content of every surviving v8 document is preserved verbatim; only filenames, headers, cross-references, and this governance record changed, plus the two additions noted below.

| Subject | v9 decision |
|---|---|
| filename/content displacement in the deployed v8 copy | five files carried the wrong document under their name (verified against the sealed v8 manifest by SHA-256); every document is restored under its correct name |
| `CLUE_Constitution_v8.md` content (sha256 `8d776ab6…`, 425 lines) | absent from the supplied corpus; `CLUE_Constitution_v9.md` is an explicit **reconstruction from inherited invariants** quoted by the surviving v8 documents, requires Creator ratification, and claims no verbatim v8 authority |
| Golden Metrics supplement (`metrics_suplementaiton.md`, proposed, unsealed, misspelled) | fused into `CLUE_Canonical_Measurement_Catalogue_v9.md` as **Part II — Golden Outcome Rail** by Creator direction; `GOLD-01`–`GOLD-04` remain a separate outcome rail and never occupy canonical 10 × 10 cells; the standalone file is retired |
| input templates | restored under `templates/target_description.template_v9.md` and `templates/benchmark.template_v9.txt`; the configured runtime filenames `target description.md` and `benchmark.txt` are unchanged |
| uniform `_v9` filenames | every pack file adopts the release version by Creator decision; each header records its prior standalone revision; `CLUE_Interface_Design_v9.md` supersedes standalone revision 10.0 without content rollback |
| Status wire schema | remains `5.0.0`; the document re-baseline is not a schema migration |
| Measurement Catalogue binding | revision 9.0 is a new catalogue version and hash (Part II added); all 100 canonical cells, IDs, and coordinates are byte-preserved from 6.0 |
| historical references | §13 keeps original v7/v8 filenames; the external dynamic backlog keeps its own name and versioning (`CLU-E_Backlog_and_Program_Integrity_v8.md` or successor) |
| release evidence | `README_v9.md`, `VALIDATION_REPORT_v9.md`, `DOCUMENTATION_MANIFEST_v9.json`, and `SHA256SUMS_v9.txt` supersede their v8 counterparts, which are retired with this release |

---

# 15. Release validation requirements

A permanent pack is releasable only when automated checks confirm:

- every required file exists;
- every internal Markdown link target exists;
- code fences are balanced;
- heading hierarchy is valid;
- no stale pack-local version filename remains;
- no current implementation-status appendix remains;
- no backlog file is present in the archive;
- `Master Benchmark` is used canonically;
- `target description.md` and `benchmark.txt` are present in the relevant contracts;
- Q1 ALL/DIVE invariants are consistent across Architecture, Status, Interface, and Q1;
- the complete Change-Set Partition remains consistent in the Git owner;
- the canonical measurement grid contains 100 unique active coordinates;
- manifest hashes and ZIP integrity pass.

---

# 16. Final governance rule

> **Stable architecture belongs in the knowledge base. Current unfinished work belongs in the backlog. One subject has one detailed owner, and every other document links rather than competes.**

---

# 17. 2026-08 executable-alignment amendment record

The v9 pack release number remains 9.0. The following document revisions were applied after
release to align permanent ownership and contracts with accepted, tested executable behavior.
They become governing authority only through the normal reseal and Creator-ratification
procedure; their presence on disk alone is not ratification.

| Record | Permanent effect |
|---|---|
| ADR-0001 / ADR-0002 / ADR-0007 | Status gains the sealed, single-projection implementation path and backed `cycle` branch |
| ADR-0003 rev 2 / ADR-0004 | one CLI module per command domain; mission-fact versus host-fact Status test |
| ADR-0006 | interactive, state-bound evidence-epoch seal |
| ADR-0008 / ADR-0010 | camelCase cycle owners and one-artifact Master Benchmark/harness contract |
| ADR-0011 | durable `proofPipeline`; Status wire 5.3.0 |
| ADR-0012 | ACCEPT and Great Book consequence in one event; Status wire 5.4.0 |
| ADR-0013 | governed, event-first Model Gateway; Status wire 5.5.0 |
| ADR-0014 | explicit target publication decision; Status wire 5.6.0 |
| ADR-0015 | read-only durable Proof & Benchmark Board |
| ADR-0016 | self-target instrument relocation and fail-closed P2 closure assessment |
| ADR-0017 | operational OpenAI exact-model/provider-budget boundary, Status 5.7.0 and manual local-first Git sync |

`CLUE_Status_Contract_v9.md` remains the v9 normative baseline. The additive runtime wire
revisions above are governed by their ratified ADRs and are composed by
`src/status/statusContractV5.ts`; historical Status snapshots keep their original schema
identity and are not rewritten.

Directory revision 9.4 registers the implemented P2 owners under `src/analysis/scenarios/`,
`src/benchmark/`, `src/proof/`, `src/experiment/proof/`, `src/greatBook/`,
`src/ai/gateway/`, `src/cycle/`, `src/closure/`, `src/status/`, `src/daemon/` and the
dashboard Proof Board. Conceptual future filenames elsewhere in the Directory do not become
competing owners for those implemented responsibilities.

The 2026-08-14 seal generated with this amendment supersedes the prior pack state. A prior
ratification or epoch remains valid evidence about its historical bytes but is not current for
P2 closure. `clue docs ratify` and then `clue epoch seal P2-authoritative` are required after
installation.


---

# 18. 2026-08-14 ADR-0017 ratification amendment (historical)

The ADR-0017 amendment recorded the Creator's operational D4 decision and manual local-first Git boundary before the final P2 evidence epoch:

- exact provider model `gpt-5.6`, validated against provider availability with no fallback;
- OpenAI Platform as sole monetary/billing authority;
- no local price or cap represented as provider billing truth;
- durable controlled pause after explicit provider billing/credit exhaustion;
- observed token use and provider-only remaining-token authority;
- manual Sync Git beside Start, with no automatic coupling and no P4 lifecycle claim;
- one proof-authoritative P2 cycle, ACCEPT-only Great Book entry and explicit Creator closure
  acceptance;
- Project Intent Model compiler and environment adapter registry retained as explicit P3 deferrals.

At that point the amended bytes required a new manifest and seal, interactive Creator ratification, and a current
`P2-authoritative` epoch before final cycle evidence could satisfy closure. ADR-0017 superseded
ADR-0016's former `PENDING_CREATOR_DECISION` D4 state without changing ADR-0016's self-target proof
and read-only closure-control decisions.

The successor P2 mission adopted the exact `gpt-6-astra` model and the active profile's
`REMOTE_REGISTERED` Git decision under ADR-0021. Those decisions are recorded in the historical
P2 evidence and carry forward in the relevant v10 owner documents. Exact model selection and
Git mode are profile-scoped. The manual Sync Git boundary and the P4 lifecycle deferral remain
in force.

---

# Part II — v10 Project Profiles amendment

## A. Release classification

The v10 pack is a coordinated release candidate that incorporates the Project Profiles supplement. The P2 receipt and its Creator approval preserve the historical v9 closure. The installed authority remains on v9 during v10 candidate preparation and review.

## B. Source preservation

The exact source supplement is preserved at:

```text
docs/source-authority/CLUE_CONFIGURATION_PROJECT_PROFILES_SUPPLEMENT_2026-08-14.md
```

The P2 formal-closure handoff and file-by-file strategy are retained as planning/evidence sources but do not automatically become permanent normative authority.

## C. Promotion gate

Promotion and acceptance follow this order.

1. Preserve the immutable P2 closure receipt and its Creator approval.
2. Complete authoritative Windows Project Profiles acceptance, using the P15A dashboard run as the live isolation evidence.
3. Verify `SHA256SUMS_v10.txt` and `DOCUMENTATION_MANIFEST_v10.json` and review the exact candidate.
4. Run `npm run project-profiles:promote-v10` and enter its interactive Creator confirmation. It coordinates the selected seal and manifest with the eight v10 owner-document registrations and preserves backups.
5. Bootstrap the successor mission and review the resulting governed input changes.
6. Ratify the selected v10 pack interactively, then seal `POST-P2-PROJECT-PROFILES` under the current mission.
7. Run representative recognition and proof work on at least two profiles.
8. Record explicit Creator acceptance of Project Profiles after reviewing the evidence.

Selection, ratification, epoch sealing and final acceptance each require their own Creator act.

## D. Drift

Any changed v10 governed byte changes the seal and makes prior v10 ratification stale. A changed project authority document separately changes that profile's authority basis and stales affected mission/proof assumptions. These two layers are related but not interchangeable.

## E. Historical P2 receipt

Once created, the P2 closure receipt is immutable historical evidence. Later v10 code, documents or Project Profile generations must not rewrite it or claim that P2 originally closed under v10.
