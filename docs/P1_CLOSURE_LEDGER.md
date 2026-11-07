# CLU-E P1 Closure Ledger

**Document class:** dynamic implementation evidence and closure control; not permanent constitutional authority  
**Ledger version:** 1.1  
**Assessment date:** 2026-08-13  
**Target:** `clu` / CLU-E self-target  
**Repository root on Creator host:** `F:\CLU\CLU`  
**Original backlog authority:** `DEV-P1-01` through `DEV-P1-30` from the updated program-integrity audit  
**Current decision:** **P1 engineering is complete. The ending patch contains the last missing Creator-host test and the deterministic closure runner; formal closure is one successful host ceremony away.**

---

## 1. Closure vocabulary

| State | Meaning |
|---|---|
| **CLOSED** | Implementation and item-local evidence satisfy the original obligation on the current architecture. |
| **CLOSED — SCOPE SPLIT** | The P1 responsibility is satisfied; an explicitly separated operational/history obligation belongs to P2 or later. |
| **CODE-CLOSED — EVIDENCE PENDING** | The required production logic is present, but the exact adversarial or Creator-host evidence required for formal closure is still missing. |
| **CLOSURE ACT PENDING** | The implementation exists and has already worked on an earlier exact baseline, but a final act must be repeated against the completed P1 tree. |
| **OPEN** | A material implementation defect remains. |

No row is closed merely because the full suite is green. Each row must identify its implementation surface and item-local evidence or an explicit governed scope split.

---

## 2. Current measured baseline

### 2.1 Creator-host Windows evidence

The latest fully supplied Windows run after the dashboard-server authority suite establishes:

```text
TypeScript typecheck:   PASS
Production build:       PASS
Dashboard authority:    7 / 7 PASS
Doctor containment:     5 / 5 PASS
Full self-test suite:   572 tests
Passed:                 562
Failed:                   0
Skipped:                 10
```

The ending patch adds seven BrowserAgent fetch-policy tests. Its expected final Windows baseline is:

```text
Full self-test suite:   579 tests
Passed:                 569
Failed:                   0
Skipped:                 10
```

The ten skips are platform-conditioned tests already named by the suite. They are not converted to passes.

### 2.2 Live installation state

The latest `doctor --deep` evidence before the final containment regression file established:

```text
Target identity:        OK
Target description:     OK
Master Benchmark:       OK
Documentation seal:     17 / 17 verified
Mission:                MISSION-000014, version 14, 25 documents
Event log:              373 records verified
Projections:            in step with event log
Artifacts:              58 / 58 verified
Queue:                  clean
```

Still deliberately outstanding:

```text
Documentation ratification: never performed
Evidence epoch:          not sealed
First cycle:             not opened
Remote:                  recorded null
Gateway:                 disabled until Stage D2
```

### 2.3 Live Status evidence

`clue status report` generated a Status Contract `5.2.0` report with:

```text
Seal:                    verified
Consistency:             branches agree
Projection:              no branch reader failed
Backed branches:         10
Explicitly unsupported:  23
```

Unsupported later-stage branches are stated as unsupported rather than fabricated as healthy.

### 2.4 Prior exact release authority

The last exact archive before the P1 completion batch was:

```text
clue-0.1.0-2026-08-13T07-02-26-238Z.zip
SHA-256: e563c5e3a2013314a903cef920a9544de3b43f120354c23223b1dce44b2b6b3f
Files: 380
```

That archive proved deterministic packaging, clean extraction, `npm ci`, typecheck, build, the then-current suite, and P0 acceptance with archive/tree equality. It is no longer the exact identity of the current P1 tree because the P1 completion files were added afterward.

---

## 3. Executive reconciliation

| Classification | Count | IDs |
|---|---:|---|
| **CLOSED** | **25** | 01–07, 09–23, 25, 27, 28 |
| **CLOSED — SCOPE SPLIT** | **1** | 29 |
| **CLOSURE TEST PACKAGED — HOST RUN PENDING** | **1** | 24 |
| **CLOSURE ACT PENDING** | **3** | 08, 26, 30 |
| **OPEN implementation defects** | **0** | — |

### Interpretation

```text
Material engineering implementation: 30 / 30
Formally resolved ledger rows:       26 / 30
Rows awaiting one host run/sealing:    4 / 30
Material design gaps in P1:           0
```

This means P1 development is complete, but the phase is not yet formally closed.

---

## 4. Thirty-row closure matrix

| ID | Original primary surface | Disposition | Current implementation/evidence | Remaining action |
|---|---|---|---|---|
| `DEV-P1-01` | `src/memory/eventLog.ts` | **CLOSED** | Checked full writes; stale-lock recovery with durable receipt; PID/start-time handling where available; torn-tail repair receipt; periodic checkpoint; checkpoint-backed history refusal; lock-ownership-safe close; runtime checkpoint cadence. Evidence: `kernel.test.ts`, `eventlog-lock-ownership.test.ts`, `runtime-log-cadence.test.ts`. | None. |
| `DEV-P1-02` | `src/memory/artifactStore.ts` | **CLOSED** | Shared durable filesystem primitives, whole-file copy, content verification, race-safe content dedupe/no replacement, atomic export replacement and writable destination. Evidence: `kernel.test.ts`. | None. |
| `DEV-P1-03` | `src/control/audit.ts` | **CLOSED** | Independent hash-chained audit authority; execution IDs; async-aware `runAsync`; synchronous API refuses async work; archive manifest and chain continuity across rotation. Evidence: `kernel.test.ts`. | None. |
| `DEV-P1-04` | `src/analysis/metrics/registry.ts` | **CLOSED** | Complete field replacement on re-record/re-rank; multi-run history; partial bulk projection detection; rebuild support. Historical metric assertion is now green. Evidence: `metrics.test.ts`, full Windows suite. | None. |
| `DEV-P1-05` | `src/analysis/documents/claimRegistry.ts` | **CLOSED** | Content-derived claim identity; content/location separation; normalized domains/subjects; legal transitions; conflict resolution preconditions; no `MAX(id)+1` authority. Evidence: `documents.test.ts`. | None. |
| `DEV-P1-06` | `src/analysis/source/navigatorEvents.ts` | **CLOSED** | Stream receipt hash; immutable seal; validated current pointer; observable writer degradation; bounded retention protecting the current run; replayable NDJSON. Evidence: `systemNavigatorObserver.test.ts`. | None. |
| `DEV-P1-07` | `src/cli/index.ts` | **CLOSED** | Closed command-authority registry; read-only and mission defaults; command domains extracted into named modules; `index.ts` composes rather than implements; undeclared commands refused. Evidence: `command-authority.test.ts`, `cli-layout-conformance.test.ts`, ADR-0003. | None. |
| `DEV-P1-08` | `package.json` / release | **CLOSURE ACT PENDING** | `tools/release.mjs` implements clean allowlist packaging, deterministic ZIP, clean extraction, `npm ci`, exact hashes and archive-bound gates. It passed on the exact P0 baseline. | Run the same gated release against the completed P1 tree and retain its exact report/hash. |
| `DEV-P1-09` | `.gitignore` | **CLOSED** | Correct `.gitignore` exists; misnamed predecessor is retired; generated state, DBs, profiles, worktrees, `node_modules`, `dist`, release output and large streams are governed. | Confirm the final release contains `.gitignore` and not the undotted predecessor. |
| `DEV-P1-10` | Status wire / former `src/ui/viewModel.ts` | **CLOSED** | Superseded by `src/status/statusContractV5.ts`, wire `5.2.0`; closed branch census; strict unknown-branch refusal; unsupported branches require reasons; one State Seal; Golden values cannot be invented. Evidence: `status-contract.test.ts`. | None. |
| `DEV-P1-11` | former console projector identity/seal responsibility | **CLOSED** | Superseded by `src/status/statusSeal.ts`; deterministic body seal; full-body coverage; tamper/foreign-seal refusal; consistency re-evaluated from provenance; cross-branch disagreement detected. Evidence: `status-seal.test.ts`. | None. |
| `DEV-P1-12` | collector/projector | **CLOSED** | Superseded by sealed `src/status/statusProjector.ts`; deterministic capture instant; no clock drift; unsupported/unavailable distinction; reader failure contained to one branch; partial scan not complete. Evidence: `status-projector.test.ts`. | None. |
| `DEV-P1-13` | status service/freshness | **CLOSED** | Staleness carries age/source/limit; unavailable is null, never zero; last-valid value retained with fault; invalid seals block health/automation; field-specific blast radius; deferred rules named. Evidence: `status-freshness.test.ts`. | None. |
| `DEV-P1-14` | runtime registry/history | **CLOSED** | Responsibility split under ADR-0002 into sealed projection and `src/status/history.ts`; retained snapshot validates after restart; unreadable/tampered files are surfaced; retention is bounded; diffs distinguish coverage, value, reason and capability changes. Evidence: `status-history.test.ts`. | None. |
| `DEV-P1-15` | `src/daemon/clueDashboardServer.ts` | **CLOSED** | Loopback-or-authenticated exposure, Host/Origin/bearer enforcement, bounded uploads, chunked UTF-8-safe Navigator replay, backpressure-aware single-flight pumping, timeout recovery with one durable phase receipt, and server-owned SSE shutdown. Evidence: `clue-dashboard-server-authority.test.ts`, 7/7 PASS on the Creator Windows host. | None. |
| `DEV-P1-16` | `ui/clue-dashboard/app.js` | **CLOSED** | Dashboard decomposed into quadrant controllers, one Status store, selection bus, fullscreen contract and closed action registry. Backend coordinate parity tests pass. Audit-host dashboard suite: 108/108 pass. | Include `npm run dashboard:verify` in the final P1 release evidence. |
| `DEV-P1-17` | `ui/clue-dashboard/index.html` | **CLOSED** | Exactly Dashboard and Configuration tabs; one tablist; landmarks; panels within `main`; keyboard/focus semantics; DOM-owned state; configuration is a panel, not a drawer; shared tested shell modules. Audit-host dashboard suite: 108/108 pass. | Include `npm run dashboard:verify` in final P1 release evidence. |
| `DEV-P1-18` | `config/measurements/catalogue.yaml` | **CLOSED** | Catalogue v6, 100 active coordinates, activation metrics required, production registry verified. Evidence: `catalogue.test.ts`, catalogue selftest 27/27. | None. |
| `DEV-P1-19` | `src/analysis/measure/catalogue.ts` | **CLOSED** | Explicit migration declaration required; v3 loads only as history and is refused for production; v6 production gate passes. Evidence: `catalogue.test.ts`. | None. |
| `DEV-P1-20` | `src/shared/measurementCoordinates.ts` | **CLOSED** | Exact 100-coordinate map, unique active cells, no historic coordinate shifts or new legacy aliases, backend/UI parity. Evidence: `improvementFieldProjection.test.ts`, `dashboard-catalogue-parity.test.ts`. | None. |
| `DEV-P1-21` | `src/experiment/console/consoleLedger.ts` | **CLOSED** | Registered sessions; ordered raw batches; scenario/checkpoint identity; immutable batch bytes; all attribution revisions retained; replay after DB loss; multi-session and multi-checkpoint accounting. Evidence: 14 tests in `console-ledger.test.ts`. | None. |
| `DEV-P1-22` | `src/observability/operationalConsole/store.ts` | **CLOSED** | Tokenized writer lock; stale recovery; ownership-safe release; listener isolation; bounded verified replay with dropped-event declaration; tampered/partial lines refused. Evidence: `operationalConsole.test.ts`. | None. |
| `DEV-P1-23` | `src/observability/operationalConsole/recorder.ts` | **CLOSED** | Source channel is required by type; request/response payloads become content-addressed artifacts with hashes; redaction decision is derived; run/call/session/task correlation required for exchanges; uncorrelated exchange leaves no durable orphan. Evidence: `operationalConsole.test.ts`; production callers bind identities. | None. |
| `DEV-P1-24` | `src/experiment/browser/browserAgent.ts` | **CLOSURE TEST PACKAGED — HOST RUN PENDING** | Browser/profile/document/session identity is implemented. Parsed origin authority rejects user-info host disguises; redirects and final-URL drift fail closed; media type is exact; declared and streamed bodies are bounded; the configured attachment timeout governs later source-map requests. The ending patch contains `browser-agent-fetch-policy.test.ts` with seven adversarial cases. | Run the included dedicated test and full Windows suite through `tools/p1-close.ps1`; require 7/7 and zero full-suite failures. |
| `DEV-P1-25` | `clue-status.md` | **CLOSED** | `clue status report` now generates the file from sealed Status. Current report: schema 5.2.0, verified seal, branches agree, no reader failed; unsupported branches are explicit. | Regenerate once after final P1 release/ratification so the timestamp and source identities match the closure epoch. |
| `DEV-P1-26` | `MANIFEST.txt` | **CLOSURE ACT PENDING** | Replacement operator manifest exists, but it identifies the earlier exact P0 archive and is stale after the P1 completion batch. | Regenerate from the final P1 exact release, including archive SHA, file count, toolchain, test totals, documentation state, Git state and limitations. |
| `DEV-P1-27` | `CONFIG-EDIT.md` | **CLOSED** | Replaced obsolete one-time edit model with `active_target → profile.yaml` workflow. Active profile is mission-bound by exact path/hash; edits cause drift; one successor restores authority; inactive/legacy modes are correctly separated. Evidence: `mission-profile-binding.test.ts` 4/4 on Windows. | None. |
| `DEV-P1-28` | evidence spine + registries | **CLOSED** | Seven-stage registry-aware chain from mission → snapshot → recognition → task → context → packet → accepted result; nonexistent/mismatched records refused; context basis changes when sections are dropped/unavailable. Evidence: `kernel.test.ts`, `context-spine-basis.test.ts`. | None. |
| `DEV-P1-29` | target registration and Master Benchmark | **CLOSED — SCOPE SPLIT** | Active `clu` profile registers `target description.md` and `targets/clu/benchmark/master-benchmark.md`; benchmark marked Creator-approved; benchmark contract 24/24; `doctor --deep` resolves both inside repository and mission 14 binds 25 documents. | Actual baseline/candidate benchmark history and strict §18 lock are P2-07 work, not silently claimed as P1 evidence. |
| `DEV-P1-30` | acceptance/release tooling | **CLOSURE ACT PENDING** | Item-local P0 probes, fingerprints, isolated complete suite and exact archive/tree binding are implemented and passed on the previous exact release. | Run `tools/release.mjs` on the completed P1 tree, then run `tools/p0-acceptance.mjs` against that exact new archive and require `overall: PASS`. |

---

## 5. Reconciliation correction completed

The five doctor containment tests no longer impersonate original `DEV-P1-29`. Their names use the non-colliding closure identifier:

```text
P1-CLOSURE-DIAG-01
```

All five execute successfully on the Creator Windows host, including drive-letter/case normalization and a lexical in-repository link that physically escapes the repository. Original `DEV-P1-29` remains supported only by the target profile, approved Master Benchmark, benchmark contract tests and `doctor --deep`.

---

## 6. Formal P1 closure sequence

The ending patch installs the last test plus `tools/p1-close.ps1`. Run the closure script from the repository root:

```powershell
pwsh -NoProfile -File .\tools\p1-close.ps1
```

The script performs, in order:

1. Typecheck and production build.
2. Dedicated BrowserAgent, dashboard-server, doctor-containment, mission-profile and task-authority tests.
3. The complete self-test suite and dashboard verification.
4. Interactive Creator documentation ratification when `doctor --deep` says it has never been performed.
5. A post-ratification deep-doctor check and sealed Status regeneration.
6. A gated deterministic release using `tools/release.mjs --write-root`.
7. Exact-archive `tools/p0-acceptance.mjs` with `archiveMatchesTree: true` and `overallPass: true`.
8. Detached `release/P1-CLOSURE-RECEIPT.json` and `.md` generation.

The script accepts either:

- `RELEASE`, when a real clean Git commit/tree identifies the exact bytes; or
- `RELEASE_CANDIDATE`, only when portable gates and native Windows proof pass, with absent Git provenance recorded explicitly.

Use `-RequireFormalRelease` to refuse the second case.

The script does **not** run:

```text
clue epoch seal
clue cycle drive
clue cycle close
```

Those acts begin the proof-authoritative P2 epoch and must occur only after the final P1 release is preserved.

---

## 7. Closure decision rule

P1 is closed when the generated detached receipt records all of the following:

```text
BrowserAgent fetch-policy:       7 / 7 PASS
Full self-test suite:            0 FAIL
Dashboard verification:         PASS
Documentation ratification:     verified by doctor
Exact release portable gates:   PASS
Native Windows qualification:   PASS
P0 acceptance overall:          PASS
Archive/tree binding:            MATCH
Root MANIFEST.txt:               generated by the exact release
Root clue-status.md:             regenerated
```

If Git provenance is absent, the receipt closes P1 with that absence explicitly recorded; it does not relabel `RELEASE_CANDIDATE` as `RELEASE`.

---

## 8. P2 hand-off

After preserving the P1 archive, manifest, acceptance report and closure receipt, the next phase starts with the evidence-epoch seal and first lock-governed cycle. Remote publication, Model Gateway policy, proof-pipeline Status, Great Book recording and the complete candidate loop remain P2 responsibilities.
