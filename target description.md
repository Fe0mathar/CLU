# Target Description

**Project name:** CLU-E
**Project ID:** `clu`
**Description version:** 0.2.0
**Owner:** Kacper (Creator)
**Last reviewed:** 2026-08-10

> This file defines declared project intent. It does not prove that the implementation satisfies the declaration. CLU-E compares it with repository, runtime, metric, test, benchmark, and Git evidence.

**Status: APPROVED — accepted by the Creator, 2026-08-10** (recorded from session acceptance). Constitution §2.1 makes protected intent the Creator's to define. Assembled from the permanent documentation pack, the ADRs, and the Creator's own statements in session, and now signed as the declared intent this system compares evidence against. Every row below is a *declaration*. Section 12 lists what is genuinely unresolved, and no section claims implementation.

**The target here is CLU-E itself.** `config/clue.config.yaml` sets `project.root` to the CLU-E repository, so this is the self-assessment description. Registering a different target — Murugan is the first intended one — means a different `target description.md` in that target's tree, not an edit to this file.

---

## 1. Purpose

CLU-E exists to drive a registered Target Program toward the highest achievable efficiency through **proof rather than opinion**, and to keep doing so across sessions that do not share memory.

The problem it solves is not "improve code". It is **continuity of intent despite discontinuity of sessions**. An AI model is a temporary working organ that loses context; CLU-E converts that memory limit into a time-and-systematicity problem by breaking work into controlled pieces and persisting the mission, findings, proofs and decision history so they outlive any one session. What survives is durable records, not a conversation.

Concretely: recognize a codebase into units and a dependency graph; measure it against a canonical catalogue; design a complete patch with a falsifiable proof contract frozen *before* the result; test it in an isolated shadow clone; and let a single gated Custodian land only changes proven by a valid benchmark that did not break a protective metric — recording the chain in the Great Book of Efficiency. Observation, hypothesis, proposal, implementation and proof stay separate record classes. Nothing counts as an improvement until it is proven.

CLU-E is a local working tree by design. It runs on the Creator's machine against a local copy of the target, because analysis, execution, orchestration and benchmarking all need the real program on real hardware. Git identity belongs to the target: a locally proven improvement reaches the world by being published to the target's own repository.

## 2. Intended users, operators, or consumers

| Group | Need or responsibility | Criticality |
|---|---|---|
| Creator | Defines protected intent, the observation contract, mission and policy versions, approvals and value policy (§2.1). Sole authority for governance decisions. | critical |
| Custodian | The one gated path that lands or reverts a change in canonical state (§2.2). | critical |
| Operator | Observes and commands through governed interfaces; those interfaces present truth and never create it (§2.3). | important |
| AI sessions | Advisory organs with bounded scope. Own no filesystem, Git, benchmark, metric, verdict or landing authority (§2.4). | important |
| Deterministic instruments | Parsers, compilers, test runners, profilers, benchmark runners, Git, browsers, databases — the factual execution authority in their domains (§2.5). | critical |

## 3. Primary journeys and workloads

| ID | Description | Representative input/state | Expected outcome | Priority |
|---|---|---|---|---|
| `JRN-001` | Register a target and its governed inputs | a local directory, a description, a benchmark contract | mission version registered, inputs hashed and cycle-locked | critical |
| `JRN-002` | Recognize the target into units and a dependency graph | a captured source snapshot | a replayable recognition run bound to that snapshot | critical |
| `JRN-003` | Measure against the canonical catalogue | a committed graph | measures recorded with provenance, unsupported ones stated as unsupported | critical |
| `JRN-004` | Design a candidate under a frozen proof contract | a finding and a hypothesis | a proof contract frozen before any result exists | critical |
| `JRN-005` | Prove a candidate in an isolated shadow clone | a leased experiment worktree from a Base Pin | baseline and candidate runs comparable under one contract | critical |
| `JRN-006` | Land a proven change through the Custodian | a positive verdict and an authority token | a sealed accepted commit and a landing receipt | critical |
| `JRN-007` | Close a cycle with a whole-project benchmark run | the accepted tree | a closing run comparable to the opening one | critical |
| `JRN-008` | Resume after a session ends | durable records only | the next session reconstructs mission, findings and decisions without the prior conversation | critical |
| `JRN-009` | Publish a proven improvement to the target's repository | an accepted branch and a registered remote | the improvement reaches the target's own Git history | high |
| `JRN-010` | Observe the system through the four-quadrant interface | a running daemon | a projection of durable records; never a second source of truth | important |

## 4. Core capabilities

| ID | Capability | Why it matters | Evidence path expected |
|---|---|---|---|
| `CAP-001` | Append-only hash-chained event log as the one durable state-transition authority | Everything else is rebuildable from it (§3.1) | direct |
| `CAP-002` | Content-addressed immutable artifact store | Evidence bytes are referenced by hash, never by location | direct |
| `CAP-003` | Rebuildable projections | Deleting SQLite and replaying must reproduce the same projections (§3.1) | direct |
| `CAP-004` | Deterministic recognition into units, edges and a graph | Measurement needs a stable structural basis | direct |
| `CAP-005` | Canonical measurement catalogue with explicit unsupported states | An unmeasurable thing must say so, not report zero (§3.3) | direct |
| `CAP-006` | Proof contracts frozen before results | The whole separation of proposal from proof rests on this (§4.3) | direct |
| `CAP-007` | Isolated experiment worktrees under lease | No candidate touches the Creator tree during ordinary experimentation | direct |
| `CAP-008` | Gated Custodian landing | One authority, one path, token-bound | direct |
| `CAP-009` | Great Book of Efficiency — the durable improvement ledger | The record that outlives sessions | direct |
| `CAP-010` | Status as a sealed projection over durable records | A dashboard must never become a source (ADR-0002, §3.5) | direct |
| `CAP-011` | Reproducible release and evidence packaging | A release must be re-derivable and self-consistent | direct |
| `CAP-012` | Whole-project observation at cycle close | A cycle without it is incomplete | direct |
| `CAP-013` | Publication of an accepted change to the target's remote | How local proof gains global exposure | not yet defined |

## 5. Strategic objectives

| ID | Objective statement | Priority | Benchmarkability | Success interpretation |
|---|---|---|---|---|
| `OBJ-001` | A session that ends loses no mission, finding, proof or decision | critical | direct | A new session reconstructs state from durable records alone, with no conversational carry-over |
| `OBJ-002` | No claim of improvement exists without admissible proof against a frozen baseline | critical | direct | Every accepted change resolves to a verdict, a contract frozen beforehand, and comparable runs |
| `OBJ-003` | Absence is always reported as absence | critical | direct | No invented zero, no invented healthy state; unsupported and unavailable stay distinguishable |
| `OBJ-004` | Durable state survives crash, restart and projection loss | critical | direct | Rebuild from events plus artifacts reproduces canonical projections exactly |
| `OBJ-005` | The canonical tree is modified only by the Custodian, only through a gated landing | critical | direct | No other path can write it; attempts are refused and recorded |
| `OBJ-006` | A release is exactly reproducible and self-consistent | high | direct | Same source produces the same archive bytes; every listed checksum verifies |
| `OBJ-007` | Every governed decision is recorded where a later reader can find it | high | qualitative | Architectural decisions resolve to an ADR; governance calls resolve to the Creator |
| `OBJ-008` | Declared intent is comparable against observed truth | critical | direct | Objectives here map to measures, and critical objectives without an evidence path are reported as such |
| `OBJ-009` | Cycles repeat until a formally defined Perfection and Equilibrium state is reached | critical | proxy | Equilibrium is claimed only inside a stated Assessment Envelope, never beyond it |
| `OBJ-010` | The operator can see what the system is doing and why, without that view becoming authoritative | high | qualitative | Interfaces project durable records and hold no independent state |

## 6. Critical behavior and invariants

Adopted from Constitution §4.2, which requires these to be true by construction. No policy, convenience or deployment choice may suspend them.

- `INV-001` — No session owns mission continuity.
- `INV-002` — No AI output becomes fact merely because it is fluent.
- `INV-003` — No candidate modifies the protected Creator tree during ordinary experimentation.
- `INV-004` — No verdict depends on an unversioned input.
- `INV-005` — No visual projection becomes a source of truth.
- `INV-006` — No projection database is required to recover durable state.
- `INV-007` — No accepted change can be confused with a different commit, tree, benchmark, environment or proof contract.
- `INV-008` — No complete cycle ends without whole-project observation.
- `INV-009` — No equilibrium claim hides unsupported scope or immature benchmark coverage.
- `INV-010` — Secrets never enter configuration, events, artifacts, streams or status; only the names of environment variables are stored.

## 7. Quality priorities

| Quality | Priority or policy | Notes |
|---|---|---|
| Correctness | Absolute. Never traded. | A wrong answer about the right place and a right answer about the wrong place are both failures |
| Reliability | Absolute for durable records. | Crash, restart or partial write must not produce a record that reads as complete |
| Security | High, and non-negotiable at the canonical-write and secret boundaries | Custodian-only writes; no credentials in config, URLs, events or status |
| Privacy | High | Redaction is applied before a payload reaches any stream or artifact link |
| Maintainability | High | Explicitly favoured over cleverness; a file must state why it is as it is |
| Extensibility | High | New environments, adapters and measures must not require a second authority for existing state |
| Performance | Conditional | Matters where it bounds a cycle's cost; never at the price of correctness or evidence completeness |
| Accessibility | Medium, declared for the interface surface | Directory §20.1 names focus, density and accessibility as acceptance criteria |
| User experience / visual fidelity | Medium–high for the console and navigator | Legibility of evidence is part of the product; decoration that implies unmeasured facts is not |

## 8. Non-negotiable constraints

| ID | Constraint | Authority/source | Required gate or evidence |
|---|---|---|---|
| `CON-001` | The event log is the sole state-transition authority | Constitution §3.1 | Rebuild-from-events reproduces projections |
| `CON-002` | Only the Custodian writes the canonical tree, and only through a gated landing | Constitution §2.2 | `security.canonical_source_writes: custodian_only`; refusal recorded otherwise |
| `CON-003` | A proof contract is frozen before any result exists | Constitution §4.3 | `proof.require_frozen_contract: true` |
| `CON-004` | An inconclusive result is not an improvement | Execution Model | `proof.inconclusive_counts_as_improvement: false` |
| `CON-005` | Secrets appear only as environment-variable names | Configuration policy | Schema rejects credential-shaped values; remote URLs refuse userinfo |
| `CON-006` | AI holds no filesystem, Git, benchmark, metric, verdict or landing authority | Constitution §2.4 | Capability model denies by default; every operation receipted |
| `CON-007` | `workspace/` is never source and never ships in a source release | Directory §2 | Release allowlist; verified per release |
| `CON-008` | A configured path absolute under another platform's rules is refused, never re-rooted | DEV-P1-35 | `CONFIG_PATH_FOREIGN` |
| `CON-009` | Unknown configuration keys are errors, not ignored | Schema is strict | Load fails on an unrecognised key |
| `CON-010` | No equilibrium claim outside its stated Assessment Envelope | Constitution §4.1 | Envelope recorded with every claim |

## 9. Supported environments and scale

| ID | Environment | Required/optional | Expected scale or load | Notes |
|---|---|---|---|---|
| `ENV-001` | Windows workstation, Node ≥ 22.11 | required | one Creator, one target at a time | The reference environment; the Creator's machine is the system of record |
| `ENV-002` | Linux, Node ≥ 22.11 | supporting | development and verification | Release archives reproduce byte-identically across ENV-001 and ENV-002 |
| `ENV-003` | PowerShell 7.x restricted host | required for target execution | approved commands only | Never an unrestricted shell |
| `ENV-004` | Chrome under a dedicated non-personal profile | required for browser-target proof | one leased profile | Never a personal profile |
| `ENV-005` | SQLite via `better-sqlite3` | required | projections only; rebuildable | Native addon; rebuilt per host by `npm ci` |
| `ENV-006` | Local dashboard on loopback, port 47900 | optional | single operator | Loopback unless authenticated |

## 10. Acceptable and unacceptable trade-offs

### Acceptable

- Slower cycles in exchange for complete evidence. Systematicity is the design's answer to the memory limit; speed is not.
- Discarding a rebuildable projection to guarantee correctness after a schema change. Projections are cheap; correctness is not.
- Reporting less rather than reporting an unproven more.
- Refusing to act where authority is unclear, and surfacing the decision to the Creator instead.
- Bounded retention of bulky evidence, provided what is discarded is named and hash-recorded.

### Unacceptable

- Any silent substitution — an invented zero, an assumed healthy state, a default standing in for an unread value.
- A verdict, metric or accepted change that depends on an unversioned input.
- A projection or dashboard becoming a source from which durable state is reconstructed.
- Speed or convenience purchased by weakening a gate, a lock or an authority boundary.
- A credential anywhere in configuration, events, artifacts, streams or status.
- Fluency substituting for proof.

## 11. Non-goals

- `NG-001` — CLU-E is not a hosted or multi-tenant service. It is a local working tree on the Creator's machine, by design.
- `NG-002` — CLU-E does not replace the target's own CI, review or release process. It produces proof and a publishable branch.
- `NG-003` — CLU-E does not autonomously merge or force-push. Publication policy is the Creator's.
- `NG-004` — CLU-E is not an IDE, a linter or a code-generation assistant. A generated patch is a candidate artifact, never an accepted improvement.
- `NG-005` — CLU-E does not claim general correctness of the target. It claims what its Assessment Envelope covers, and no more.
- `NG-006` — CLU-E does not optimise for benchmark numbers as an end. Purpose precedes metric.

## 12. Known risks and ambiguities

| ID | Risk or ambiguity | Why unresolved | Evidence or decision needed |
|---|---|---|---|
| `AMB-001` | The v9 pack is installed and sealed but not yet ratified | The pack is installed, seal-verified 17/17, and doctor tracks the state; `DOCUMENTATION_GOVERNANCE_v9.md` §14 still requires the Creator's act, for which `clue docs ratify` now exists (2026-08-10) | The Creator performs `clue docs ratify`; doctor then reports the act and what it discharges |
| `AMB-002` | **Resolved 2026-08-10** (`DEV-P2-02`) | All eleven documents renamed to their v9 filenames by content-addressed install and re-registered in `constitution.tracked_documents`; content byte-identical throughout, proven by seal verification and corpus re-ingest | None — retained as a stable ID; the next `clue init` on the reference host registers the successor mission bound to the v9 names |
| `AMB-003` | No Project Intent Model is compiled from this file | `src/intent/` does not exist; Directory §10 assigns nine modules there | Build the compiler, or state the objectives here as uncompiled |
| `AMB-004` | Objectives here have no declared measure mapping | `OBJ-008` requires it; nothing maps them yet | A mapping from `OBJ-*` to catalogue coordinates |
| `AMB-005` | `project.remote` is null; the publication path is unbuilt | `CAP-013` has no evidence path; §6.3 reserves the policy to the Creator | A remote, and a decision on whether publication is ever automatic |
| `AMB-006` | The mission gate is advisory, not enforced | Creator decision, 2026-08-09; deferred to `src/cycle/` | Revisit when `src/cycle/` exists |
| `AMB-007` | Ten tests are skipped on the reference host | Six need elevated symlink privileges; the rest are platform-structural | Run once elevated, or accept the gap explicitly |
| `AMB-008` | No cycle has ever completed | `src/cycle/` does not exist; no verdict, landing or Great Book entry has been produced | The first complete cycle under Execution Model §24 (completion criteria; §18 for the closing whole-project run) — the P2 exit criterion, carried by `DEV-P2-08`…`-12`. This row resolves only when that cycle's evidence exists, and an honest negative resolves it too |

## 13. Project-level success

CLU-E is successful when a Target Program can be handed to it and improved through repeated cycles that each end in a whole-project observation, where every accepted change resolves to a frozen proof contract, admissible evidence and a Custodian landing receipt, and where a session ending costs nothing but time.

The terminal state is **Perfection and Equilibrium**: a formally defined condition in which no admissible improvement remains within a stated Assessment Envelope. It is a claim about a bounded envelope, never about the program in general, and it is invalidated by a change to the inputs the envelope depends on.

Stated separately, because they must not be conflated: the *native measures* are the catalogue's, recorded with provenance and explicit unsupported states. The *qualitative judgement* — whether the system is trustworthy to run unattended against a target that matters — is the Creator's, and no measure substitutes for it.

## 14. Human-evaluation requirements

| ID | Subject | Evaluator profile | Method | Acceptance authority |
|---|---|---|---|---|
| `HEV-001` | Interface legibility: does the four-quadrant view make the evidence chain readable? | Creator | Direct use against a live daemon | Creator |
| `HEV-002` | Trustworthiness for unattended operation | Creator | Review of gates, receipts and refusals over a complete cycle | Creator |
| `HEV-003` | Whether a governance decision was correctly recorded and correctly scoped | Creator | ADR review | Creator |
| `HEV-004` | Whether a candidate's rationale is intelligible, not merely valid | Creator | Reading the candidate's own evidence chain | Creator |

## 15. References

Inputs, not proof of implementation.

- `CLUE_Constitution_v9.md` — roles, truth hierarchy, invariants
- `CLUE_Architecture_v9.md` — identity model, seals, durable records
- `CLUE_Project_Directory_v9.md` — responsibility ownership and target layout
- `CLUE_Execution_Model_v9.md` — the RPI cycle
- `CLUE_Canonical_Measurement_Catalogue_v9.md` — the measure set
- `CLUE_Status_Contract_v9.md` — the Status projection, §4.1 project inputs
- `CLUE_Git_Integration_v9.md` — repositories, Base Pins, worktrees, publication
- `CLUE_Q1_System_Navigator_v9.md`, `CLUE_Interface_Design_v9.md` — the operator surfaces
- `CLUE_AI_Utilization_v9.md` §25 — the contract for this file and for `benchmark.txt`
- `RPI_Core_Methodology_v9.md` — the improvement method
- ADR-0001 … ADR-0005 — recorded architectural decisions; ADR-0006 (evidence-epoch seal) proposed, awaiting the Creator
- `benchmark.txt` — the Master Benchmark contract, the observation half of this pair

## 16. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 0.1.0 | 2026-08-09 | First draft. Assembled from the v9 pack, the five ADRs and the Creator's session statements under `DEV-P1-29`. Not yet approved. | pending — Creator |
| 0.2.0 | 2026-08-10 | §12 reconciled to the tree after Gate 7's first half: `AMB-001` narrowed to the outstanding act, `AMB-002` resolved, `AMB-008` bound to the P2 exit criterion; §15 Execution Model reference corrected post-rename; ADR-0006 noted. No declaration changed. | approved 2026-08-10 — Creator |
