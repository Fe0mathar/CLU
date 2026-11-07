# CLU-E v10 Project Profiles Validation Report

**Release:** 10.0-rc1  
**Status:** package-host static acceptance passed; authoritative Windows, migration and live-connection evidence remain pending.

## Completed on the packaging host

The final cumulative Batch 1–8 tree was validated with:

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

The seven skips are exactly one Windows path-case check and six PowerShell/parser/host checks. They remain mandatory live Windows gates and are listed in `PROJECT_PROFILES_ACCEPTANCE_REPORT.json`.

## Authority boundary

```text
selected P2 documentation pack = v9
v10 candidate = sealed and verified
v10 selected = false
v10 ratified = false
Project Profiles Creator acceptance = not recorded
```

Batch 8 does not replace the authority basis used by the P2 closure ceremony.

## Required authoritative gates

The release is not fully accepted until the real Windows installation proves:

- native `better-sqlite3` loads and `npm run selftest` passes;
- Target Root case, slash, relative, junction and reparse aliases cannot bypass uniqueness;
- PowerShell Host handshake and root parity pass;
- one dedicated Chrome target can be selected and its request/response evidence is durable;
- `OPENAI_API_KEY` resolves and the live provider reports exact `gpt-5.6` with no fallback;
- the legacy workspace survives explicit adoption and Configuration-v3 cutover without history loss;
- no automatic Git synchronization occurs and `NO_REMOTE_YET` remains valid;
- the Creator explicitly accepts the Project Profiles implementation.

## Non-claims

This report does not ratify v10, seal an epoch, perform migration, activate a profile, contact OpenAI, run a live proof, create a Great Book entry, close P2 or record Creator approval.
