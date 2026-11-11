# CLU-E v10 Project Profiles Validation Report

**Release** — 10.0-rc1

**Status** — prepared candidate with Windows profile qualification and a completed live dashboard isolation run. Full native candidate qualification, remaining live receipts and Creator acts are pending.

## Completed on the packaging host

The historical cumulative Batch 1–8 tree was validated with these results.

- TypeScript typecheck — **PASS**;
- production build — **PASS**;
- Project Profiles acceptance matrix — **28 requirements / 57 unique test files**, all selected automated steps **PASS**;
- complete repository selftest — **134 files, 846 tests, 839 pass, 7 environment-dependent skips, 0 fail**;
- dashboard verification — **169/169 PASS**;
- System Navigator — **28/28 syntax modules, 59/59 import edges, 12/12 tests PASS**;
- Operational Console — **11/11 PASS**;
- Great Book Improvement Field — **PASS**;
- Four Neon Gauges — **PASS**;
- v10 manifest/seal verification — **PASS**;
- credential scan of `config/` and `targets/` — **PASS**, no raw credential-like material found.

For Linux validation only, the installed `better-sqlite3` source was rebuilt against the packaging host's Node 22 headers. `node_modules` is excluded from the patch. This is strong portable evidence, but it is not a substitute for the native Windows run.

The seven packaging-host skips are one Windows path-case check and six PowerShell/parser/host checks. `PROJECT_PROFILES_ACCEPTANCE_REPORT.json` retains the original packaging baseline.

## Windows evidence collected after P2

| Evidence | Recorded scope |
|---|---|
| P14 profile qualification | `clue1` generation 9 matched its PowerShell Host roots and reported Git mode `REMOTE_REGISTERED`. OpenAI returned exact `gpt-6-astra` with fallback forbidden and unused. The separate fixture was qualified `READY_LOCAL_ONLY`. |
| P15 Windows installation | Commit `bc0db64` built successfully and passed all 126 focused integration tests. The installer seeded the separate B Navigator while A remained active. |
| P15A live dashboard switch | A → B → A passed. B loaded its seven-file inventory and distinct recognition graph with empty proof and Great Book history. A restored its 897-file inventory, recognition run, `EVENT-012055` accepted proof and `GBI-27c640ce3fc712050ca84250ca89da4a` Great Book entry. |

These reports cover the tested profiles and their recorded generations. The browser probe exercised the running dashboard through its normal activation controls. Its result provides evidence for live profile isolation.

`PROJECT_PROFILES_P16_REVIEW.json` records the exact evidence digests and the identities verified across P2, P14, P15 and P15A.

## Authority boundary

```text
selected P2 documentation pack = v9
v10 candidate = sealed and verified
v10 selected = false
v10 ratified = false
Project Profiles Creator acceptance = not recorded
```

Batch 8 prepared the original candidate. The P2 closure receipt remains bound to v9.

## Required authoritative gates

The refreshed candidate needs authoritative Windows evidence for the following checks.

- Native `better-sqlite3` loads and `npm run selftest` passes.
- Target Root uniqueness checks cover case, slash, relative, junction and reparse aliases.
- PowerShell Host handshake and root parity pass.
- The qualified profile selects one dedicated Chrome target and records durable profile-bound request and response evidence.
- The approved profile credential reference resolves and the requested and effective models match exactly with fallback forbidden and unused. P14 demonstrated this for `gpt-6-astra` on `clue1`.
- The legacy workspace survives explicit adoption and Configuration-v3 cutover without history loss.
- Git synchronization requires an explicit operator action on a registered remote. `NO_REMOTE_YET` remains valid for a local-only profile.

## Remaining Creator acts

After reviewing native and live evidence, the Creator may select v10, ratify the selected seal and set the successor epoch. Representative operations on two profiles and review of their resulting evidence precede final Creator acceptance.
