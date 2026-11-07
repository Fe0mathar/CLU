# CLU-E Cycle Implementation Plan v1

**Status:** accepted and implemented — D1–D5 taken as proposed by the Creator, 2026-08-10; P2 closure amendments recorded 2026-08-14
**Date:** 2026-08-10
**Authored by:** session, as DEV-P2-08 groundwork
**Authority:** `CLUE_Execution_Model_v9.md` and `CLUE_Project_Directory_v9.md` §18.2 govern;
this plan only sequences their build and flags where practice must diverge or the spec is
broken. Nothing here amends a governed document; the amendments it proposes go through ADRs.

---

## 1. Three findings that shape the plan

**F1 — the exit criterion cites a section that does not exist.** "Execution Model §7.2" appears
in the program backlog's P2 exit criterion, in shipped code
(`doctorCommands.ts` line 65), in `config/clue.config.yaml` (§54 comment), and in
`target description.md` `AMB-008` (which this session wrote, following the backlog). The
Execution Model has no §7.2 — §7 has no subsections, in v9 or in the verbatim-preserved v8
content. The sections that actually carry the cited meaning are **§24 (Execution completion
criteria)** for "a cycle is complete only when…" and **§18 (Closing Master Benchmark)** for the
whole-project closing run specifically. **Resolution:** D1 was accepted; the in-tree references use §24, with §18 where the closing run alone is meant. The external dynamic backlog remains independently versioned and is not made authoritative by this plan.

**F2 — Directory §18's filenames contradict the tree's convention.** §18 names
`CycleOrchestrator.ts`, `CycleRegistry.ts`, … in PascalCase. Every module in the tree is
camelCase (`mission.ts`, `statusProjector.ts`, `claimRegistry.ts`), and ADR-0003 established
the precedent that the Directory is amended when a rule of practice supersedes its informative
text. *Proposed:* camelCase filenames (`cycleOrchestrator.ts` …) and an ADR amending §18's
listing, mirroring ADR-0003 rev 2's §7 treatment. **Resolution:** D2 was accepted and applied by ADR-0008; Directory revision 9.3 retains the implemented camelCase owners.

**F3 — the gateway is disabled, and the Execution Model already says what that means.**
§2: recognition may run in diagnostic mode without all inputs, but CLU-E "must not claim …
proof-authoritative cycle closure" without the required locked inputs — which include the
model/provider policy, a valid Master Benchmark, and the compiled Project Intent Model. At plan time none of the three existed. **Resolution:** the diagnostic first-cycle decision remains historical truth; the registered `clu-master` and fail-closed Model Gateway later removed the P2-removable absences. The Project Intent Model compiler (`AMB-003`) remains an explicit P3 deferral and is not silently claimed by P2. Creator decision D3.

## 2. What already exists, mapped to the Execution Model

| EM phase | Existing service (wired in `withRuntime`) |
|---|---|
| §3.1–3.2 registration | `MissionRegistry` (versions, amendments, ratification) |
| §3.3 input identities | `project.inputs` registration, tracked-document hashes, catalogue loader (v6 gate) |
| §5 recognition | `SnapshotRegistry`, `GraphRegistry`, recognizer identity v4, navigator stream |
| §7 screening | `MetricRegistry` (multi-run history, `verifyProjection`), catalogue v6/100 |
| §8–§9 candidates | `candidates` command authority (four ordered steps, DEV-P1-37) |
| corpus ground truth | `ClaimRegistry` (content/location identity, conflicts, missing sources) |
| work distribution | `TaskQueue`, `SessionPacketService`, `contextBuilder` |
| evidence | `EventLog` (checkpointed, fault-tested), `ArtifactStore`, evidence spine (`spineLink`/`spineSeal` across 7 phases) |
| audit/authority | `AuditLog`, `AuditedDispatcher`, closed `commandAuthority`, `PolicyEngine` |

The orchestrator's job (§18.2) is exactly the Directory's sentence: *invoke these; absorb
nothing.*

## 3. Module plan (camelCase per F2, pending D2)

**`cycleRegistry.ts`** — durable cycle identities and the stage machine's record of truth.
Owns the `cycle.*` event namespace (D5): `cycle.opened`, `cycle.inputs_locked`,
`cycle.stage_advanced`, `cycle.suspended`, `cycle.resumed`, `cycle.closed`. Records
`CYCLE-######` ids (the global entity grammar), each bound to the mission in force. Projection
table `cycles` (id, mission, stage, grade, lock digest, opened/closed timestamps), rebuildable
like every projection. Illegal stage transitions are refused by a legality table, the
`ClaimTransitionError` pattern from DEV-P1-05.

**`cycleInputLock.ts`** — §2/§3.3 made computable. Assembles the input identity set: target
description hash (registered input), benchmark hash (when registered), tracked-document
content hashes (from the mission basis), catalogue version, policy file hashes, environment
fingerprint (node/OS/tool versions), ratification event id, epoch name when ADR-0006 lands.
Produces a canonical digest and a **grade**: `proof-authoritative` only when every §2 input is
present and valid; otherwise `diagnostic`, with the absent inputs enumerated in the lock record
itself — the lock states what it could not lock.

**`cycleOrchestrator.ts`** — the driver. Advances the stage machine by invoking existing
services (snapshot → recognize → screen), records each advance as an event with the evidence
spine link, and stops honestly at the first stage whose prerequisites are absent. No domain
logic; every "how" stays in the domain service.

**`nextCycleVitalInput.ts`** — §19's handoff record: accepted identity, closing evidence
references, coverage, anomalies, negative knowledge, seeds, freshness conditions. First
diagnostic cycles produce a truthful subset with absences named.

**`resumePlanner.ts`** — §21.2's verify-before-continue: mission unchanged, lock digest
reproducible, projection parity, artifact integrity, log verified. Refusal-shaped like doctor.

## 4. The stage machine

```text
OPENED
  → INPUTS_LOCKED            (lock computed; grade recorded)
  → OPENING_EVIDENCE         (§4: benchmark when authoritative; snapshot vitals when diagnostic)
  → RECOGNIZED               (§5)
  → SCREENED                 (§7)
  → CANDIDATES               (§8–§15 loop — out of first-slice scope, D3)
  → CLOSING_EVIDENCE         (§18)
  → HANDOFF                  (§19)
  → CLOSED                   (§24 criteria evaluated and recorded, met or honestly unmet)

any stage → SUSPENDED → (resumePlanner) → prior stage
```

Every arrow is an event; the registry's legality table is the only authority on arrows; the
orchestrator holds no state of its own.

## 5. Slice order (one file per turn, each with its proof)

S1 `schemas.ts` — cycle record and lock payload schemas.
S2 `cycleRegistry.ts` — events, legality table, projection, queries; tests next turn.
S3 `cycleInputLock.ts` — digest + grade; adversarial tests (absent input ⇒ diagnostic, named).
S4 `cycleOrchestrator.ts` — OPENED→SCREENED path over existing services on the twin.
S5 `commandAuthority.ts` + `cycleCommands.ts` — `cycle open|status|advance|suspend|resume`
   (paired turn; the parity test forces it, as with `docs ratify`).
S6 doctor — a `cycle` line: current stage, grade, lock digest, or `none opened`.
S7 status — ADR-0004's owning branches (`proofPipeline`, `aiOrchestration`) move from
   `unsupported` to truthful minimal payloads once stages exist to report.
S8+ the candidate loop (§8–§15), gated on P2-09…-12 and the D3 decision.

## 6. Standing gates this plan touches

**DEV-P1-36** deferred the `requiresMission` enforcement flip "pending `src/cycle/`
development" — that trigger fires at S5. *Proposed:* flip enforcement on in the same paired
turn as `cycleCommands.ts`. Creator decision D4.

**ADR-0006** (evidence epoch) is independent machinery, but ordering matters for meaning: a
first cycle opened *after* the epoch seal can assert its evidence is governed-epoch by
construction. The plan recommends: decide ADR-0006, seal, then S4's first live run.

## 7. Non-goals of S1–S7

No AI phases, no patching, no landing, no equilibrium, no benchmark authoring. A diagnostic
cycle that reaches CLOSED with §24's criteria *recorded as unmet with reasons* is a success for
this plan — the Execution Model's own words: a cycle may end in "terminal negative knowledge,
reduced uncertainty, verified adequacy, or a reasoned stop" (§1).

## 8. Decisions requested from the Creator

- **D1** — repair the §7.2 citations to §24 (and §18 where the closing run is meant); four
  sites listed in F1.
- **D2** — camelCase cycle filenames with a §18 amendment ADR, or follow §18 as written.
- **D3** — first cycle is a diagnostic cycle per §2's provision, with the candidate loop
  deferred to P2-09…-12 — or hold all cycle work until proof-authoritative inputs exist.
- **D4** — flip `requiresMission` enforcement at S5.
- **D5** — `cycle.*` event namespace, registry-owned, mirroring `authority.*`.

A bare "accepted" takes all five as proposed. S1 begins after that word and not before.
