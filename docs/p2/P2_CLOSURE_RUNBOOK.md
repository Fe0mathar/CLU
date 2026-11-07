# CLU-E P2 — Authoritative Closure Runbook

**Status:** execution runbook; running this document is not closure  
**Target installation:** `F:\CLU\CLU`  
**External workspace:** `F:\CLU\workspace\clue`  
**Evidence root:** `F:\CLU\workspace\clue\closure\P2-authoritative`

## 1. Non-negotiable terminal state

P2 is complete only when the live system proves:

```text
ratificationCurrent = true
epochName = P2-authoritative
epochCurrent = true
proofAttempts >= 1
verdicts >= 1
accepts >= 1
greatBookEntries >= 1
lastCycleGrade = proof-authoritative
lastCycleCriteriaMet = true
formalClosurePass = true
p2Closed = true
closureState = CLOSED
Creator approval recorded
```

Passing tests, a healthy dashboard, a positive manual benchmark or an installed Project Profiles patch does not substitute for this chain.

## 2. Freeze boundary

Before the ceremony:

1. install the cleaned Batch 8 tree and apply Patches 01–05 in order;
2. stop all parallel editing;
3. qualify the Windows execution supervisor, then verify the exact release archive on Windows;
4. generate the final-tree inventory and two authority manifests;
5. capture the exact Q1/SURF application and acceptance-test hashes;
6. do not change code, active P2 authority documents, benchmark inputs or proof inputs after ratification.

A changed active P2 document makes ratification stale. A changed candidate or Proof Contract requires a new proof-attempt identity.

## 3. Prepare the evidence directory

```powershell
$root = 'F:\CLU\workspace\clue\closure\P2-authoritative'
New-Item -ItemType Directory -Force -Path `
  "$root\00-preflight", `
  "$root\01-authority", `
  "$root\02-proof-inputs", `
  "$root\03-proof-evidence", `
  "$root\04-machine-closure", `
  "$root\05-release", `
  "$root\06-creator-approval" | Out-Null

Set-Location -LiteralPath 'F:\CLU\CLU'
npm.cmd run p2:closure-inventory -- --output-dir "$root\01-authority"
npm.cmd run p2:closure-preflight -- --output "$root\00-preflight\P2_CLOSURE_PREFLIGHT.json"
```

The inventory tool includes no API-key bytes. It records only `apiKeyPresent` and `env:OPENAI_API_KEY`.

## 4. Build and verify the release archive on Windows

Follow the [Windows execution supervisor guide](WINDOWS_EXECUTION_SUPERVISOR.md) on the
installation host and retain its native qualification evidence. Stop the dashboard and any
active benchmark or proof. Run from the clean local Git repository for `F:\CLU\CLU`.
Review and commit the installed source and packaging files before generating the archive.
Git can stay local. The archived source bytes must agree with the commit, including the line
endings of both sealed documentation packs. In a new local repository, set `core.autocrlf` to
`false` before staging and review `git diff --cached --name-only` before committing. Avoid Git
checkout filters that rewrite release files. Store proof inputs and logs outside the repository.

```powershell
Set-Location -LiteralPath 'F:\CLU\CLU'
git status --short
npm.cmd ci
npm.cmd run release:package -- --out "$root\05-release"
```

The package command extracts the exact ZIP into a fresh temporary directory, installs locked
dependencies, runs the regression gates, and verifies both documentation seals. Read the
generated release report. `RELEASE` is the required software package verdict for this ceremony.
`RELEASE_CANDIDATE` means a formal gate is still pending. `UNGATED` is a structural check.
Keep the ZIP, archive hash, per-file hashes, report, and gates log together. The archive keeps
v9 selected. Its verdict covers software packaging. The remaining sections establish live P2
closure and Creator approval.

## 5. Connection gates

Using the active CLU profile, explicitly verify:

```text
PowerShell/Host:
  executable exists
  host starts
  handshake succeeds
  Project ID and Target/Workspace/Shadow roots match

Git:
  repository root matches F:\CLU\CLU
  publication state is NO_REMOTE_YET
  no automatic fetch/pull/push occurred

Chrome, only when required by the selected proof:
  one dedicated debug endpoint
  one exact permitted page
  ambiguity/wrong-origin/disconnect fail closed

GPT:
  provider = openai
  requestedModel = gpt-5.6
  effectiveModel = gpt-5.6
  fallbackUsed = false
  apiKeyPresent = true
  operationallyReady = true
  problem = null
```

Do not paste the API key into reports or commands. The runtime resolves `OPENAI_API_KEY` from the environment.

## 6. Active and deferred authority

P2 ratification binds the installed v9 authority set and exact active benchmark/normative bytes. The Project Profiles supplement and v10 pack remain deferred post-P2 authority during this ceremony.

Required files:

```text
01-authority\P2_FINAL_TREE_INVENTORY.json
01-authority\P2_ACTIVE_AUTHORITY_MANIFEST.json
01-authority\P2_DEFERRED_POST_P2_AUTHORITY_MANIFEST.json
01-authority\P2_CLOSURE_CONTEXT.json
```

The deferred manifest must say:

```text
scope = post-P2
activeForP2Proof = false
implementationRequiredForP2Closure = false
```

## 7. Ratification and epoch

Ratification and epoch sealing are deliberate Creator acts and remain interactive.

```powershell
cd F:\CLU\CLU
node dist/src/cli/index.js docs ratify
node dist/src/cli/index.js epoch seal P2-authoritative
```

Verify live Status/API evidence:

```text
ratificationCurrent = true
epochName = P2-authoritative
epochCurrent = true
```

Do not continue if the ratified seal differs from the manifest captured in `01-authority`.

## 8. First authoritative proof candidate

Use a small, deterministic, low-risk CLU-E hotspot. The recommended screening target is `src/analysis/source/recognizer.ts`, limited to a behavior-preserving reduction in repeated project-file passes or temporary allocations.

The candidate is admissible only when:

- the baseline probe is stable above timing noise;
- recognized units, identities, hashes, edges and unresolved references remain exactly equal;
- typecheck/build/selftest and recognition parity pass;
- the patch is narrow and easy to roll back;
- no normative document changes;
- no Q1 redesign;
- no Project Intent compiler or adapter-registry work.

Copy and complete the templates in `templates/p2-closure/` into `02-proof-inputs`. Freeze their SHA-256 values before execution.

## 9. Durable proof cycle

Run the existing governed proof command with the frozen contract and candidate patch. The durable pipeline must produce a real verdict:

```text
REJECT
REVISE
INVALID
ACCEPT
```

For REJECT/REVISE/INVALID, preserve the evidence and create a successor candidate/proof attempt. Do not rewrite an old verdict and do not convert inconclusive evidence into success.

A successful attempt must prove measurable improvement without unacceptable regression.

## 10. ACCEPT and Great Book

On ACCEPT, verify atomically:

```text
accepts >= 1
greatBookEntries >= 1
```

The Great Book entry must bind the same project, target identity, profile/authority basis, mission, cycle, Proof Contract, candidate, verdict and benchmark basis. No manual Great Book entry is acceptable.

## 11. Cycle and machine closure

Close only under:

```text
lastCycleGrade = proof-authoritative
lastCycleCriteriaMet = true
```

Then capture:

```text
GET /api/p2-closure
sealed Status JSON
final browser probe when used
proof/verdict/ACCEPT/Great Book/cycle references
```

Required final machine state:

```text
formalClosurePass = true
p2Closed = true
closureState = CLOSED
```

Store evidence in `04-machine-closure`.

## 12. Release evidence and immutable receipt

After machine closure, retain the archive-bound `*.p0-acceptance-report.json` emitted by
the gated package command under `05-release`. Its adversarial probes and the separate full
suite result are assessed together in the release report. Create a historical receipt binding
hashes of:

- exact release ZIP and its gated release report;
- active authority manifest;
- final-tree inventory;
- ratification event;
- epoch seal;
- accepted proof attempt and verdict;
- Great Book entry;
- cycle closure;
- final `/api/p2-closure` response;
- final sealed Status;
- P0 acceptance report.

Later v10 promotion must never rewrite this receipt.

## 13. Creator approval

Only after machine closure, create:

```text
06-creator-approval\P2_CREATOR_APPROVAL.txt
```

with an explicit statement such as:

```text
Creator approval: P2 closure accepted.
```

Record date/time and the final closure-receipt SHA-256. This is the final human authority step.

## 14. Post-P2 Project Profiles promotion

After the P2 receipt is immutable:

1. complete live Project Profiles acceptance;
2. verify the v10 candidate seal and manifest;
3. review/update active tracked-document registration in a separate governed patch;
4. ratify v10 interactively;
5. seal `POST-P2-PROJECT-PROFILES`;
6. run representative recognition/proof work on two profiles;
7. record explicit Creator acceptance of Project Profiles.

The v10 release is not allowed to retroactively claim that P2 closed under v10.
