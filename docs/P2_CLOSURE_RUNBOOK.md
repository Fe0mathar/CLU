# CLU-E P2 Closure Runbook

**Runbook version:** 1.4

**Prepared:** 2026-08-14. ADR-0021 alignment on 2026-11-11.

**Purpose:** convert the engineering-complete and Creator-configured P2 tree into one formally
closed, evidence-backed state without allowing configuration, UI or scripts to invent a verdict.

## 1. Prepare the release installation

Install the cleaned Batch 8 package and Patches 01–05 in order in `F:\CLU\CLU`.
Use the [authoritative Windows runbook](p2/P2_CLOSURE_RUNBOOK.md) for the release archive,
Git binding, Windows proof supervisor qualification and closure evidence.

Restart `CLUE-Dashboard.bat`. The launcher builds and performs idempotent initialization/migration.

## 2. Configure the provider credential outside CLU-E

Create a Windows user or system environment variable named:

```text
OPENAI_API_KEY
```

Set its value through Windows Environment Variables or another host secret facility. Do not put the
value in YAML, `.env` inside the repository, browser console, email, chat, logs or screenshots.
Restart the dashboard/terminal process after setting it.

CLU-E does not configure or enforce the monetary budget. OpenAI Platform remains the sole budget
and credit authority. Local zero caps are compatibility fields, not a disabled gateway. The exact
route model for the ADR-0021 successor is `gpt-6-astra`. The adapter checks that identity before
use and refuses fallback.

Run the final browser probe. Before governance/evidence ceremony, a healthy state is:

```text
integrationPass: true
model: gpt-6-astra
budgetAuthority: openai_platform
localBudgetEnforced: false
providerPaused: false
activationReady: true
formalClosurePass: false
```

If the key is missing or the model is unavailable, integration may still pass while
`activationReady` remains false. Do not open the closure cycle until activation is ready.

## 3. Provider exhaustion and recovery

An explicit OpenAI billing/funding exhaustion response:

1. records one durable failure;
2. blocks new gateway submissions;
3. suspends a live cycle after the durable write;
4. causes Q3 to render `LACK OF $` through the separately installed interface.

Generic rate limiting does not receive this label.

After provider funding is restored, run the controlled model probe/resume act:

```powershell
node dist/src/cli/index.js gateway resume
```

This clears the gateway provider pause only. A suspended cycle remains operator-owned and must pass
the normal verified cycle-resume act; provider recovery never resumes it automatically.

## 4. Manual Git Sync

`SYNC GIT` is separate from `START CLU-E`. The ADR-0021 successor expects the registered remote
in the active Project Profile. With a registered remote, operator-initiated Sync Git permits:

- no change;
- ahead-only push;
- behind-only fast-forward.

Dirty, detached or diverged state is refused. A legacy `NO_REMOTE_YET` profile reports
`NO_REMOTE_CONFIGURED` without contacting the remote. P2 proof and closure are local-first.
The full publication, landing and recovery lifecycle remains P4 scope.

## 5. Ratify the amended documentation pack

Run interactively:

```powershell
node dist/src/cli/index.js docs ratify
```

Read the preview and type the exact phrase printed by the command:

```text
RATIFY <12-character state token>
```

The interactive act records explicit Creator approval of the installed bytes, exact model and
budget policy, registered remote decision and P3 deferrals. Register the successor mission
before ratifying an amended pack.

## 6. Seal the P2 evidence epoch

After ratification, use the mission-specific name for a successor. Replace the mission ID
with the one reported by the active installation.

```powershell
node dist/src/cli/index.js epoch seal 'P2-authoritative-<mission-id>'
```

Type the exact `SEAL <token>` phrase. The epoch must stand on the latest ratification and current
seal. Older evidence remains historical and cannot close the moved world.

## 7. Open and drive one local closure cycle

```powershell
node dist/src/cli/index.js cycle drive
```

The cycle must reach `SCREENED`, carry the registered benchmark and report no removable input-lock
absence. Stop on mission, ratification, provider, benchmark or scenario refusal.

## 8. Freeze one small, deterministic proof candidate

Qualify the [Windows execution supervisor](p2/WINDOWS_EXECUTION_SUPERVISOR.md) before recording the
opening benchmark. From the built project root, run the registered benchmark after the cycle
reaches `SCREENED`.

```powershell
node dist/src/cli/index.js benchmark run
```

Keep the recorded event and result artifact as the opening baseline. Stop if a required
measurement is missing or incomplete. Keep the proof inputs and evidence outside the screened
project tree. Copy the two files in `templates/p2-closure` into a dedicated folder such as
`F:\CLU\release-evidence\p2\proof-inputs` and name them `proof-contract.json` and
`candidate-patch.json`.

| Contract field | Source |
|---|---|
| `cycle_id` and `mission_version` | Current screened cycle from `clue cycle status` and current mission from `clue mission`. |
| `snapshot_id` | Full ID in the screened cycle evidence. Verify that the fresh `benchmark.run_recorded` event has the same `payload.snapshot_id`. |
| `environment_fingerprint` | Copy the triple from the same cycle's `cycle.inputs_locked` event at `payload.lock.environment_fingerprint`. |
| `contract_version` and `project_basis` | Use version `1` for the stock v9 installation when the lock has no `project_basis`. If the lock carries one, use version `2` and copy `payload.lock.project_basis` verbatim as the top-level `project_basis` object. |

The workspace event log is `events\events.ndjson` under the workspace root in the stock v9
installation. For `SCREENED`, find the matching `cycle.stage_advanced` event and read the
referenced blob at `blobs\sha256\<first 2 hex>\<next 2 hex>\<full evidence hash>`. Its
`snapshot_id` is the binding the proof CLI checks. Use the selected profile's event and artifact
roots if the cycle is Project Profile-bound.

Replace the zero IDs and descriptions in the contract with the current evidence and describe
the exact candidate and representative workload. The stock template targets `clu-master`
`SIG-001` in milliseconds, with one warmup and three measured repetitions, median aggregation,
and a 5,400-second run cap. Its six mandatory count gates protect recognized units and edges,
unresolved imports, stored metrics, passing tests and skipped tests. The numeric 5% gain and
2% regression thresholds are examples. Freeze thresholds suited to measured baseline noise
before observing the candidate.

The candidate manifest accepts `version: 1` and `operations`. A `write` operation carries
either full UTF-8 replacement text in `content` or a relative `source` within the manifest
directory. For the supplied example, save the complete candidate recognizer file as
`recognizer.candidate.ts` next to the manifest. Preserve the original source separately for
rollback. Record the SHA-256 hashes of the contract, manifest, replacement file and original
source with the release evidence before running proof.

```powershell
$proofInputs = 'F:\CLU\release-evidence\p2\proof-inputs'
node dist/src/cli/index.js proof `
  --contract (Join-Path $proofInputs 'proof-contract.json') `
  --patch (Join-Path $proofInputs 'candidate-patch.json')
```

Preserve every recorded outcome. For P2 closure, verify one durable `ACCEPT` and the matching
Great Book entry for the same proof attempt. A revision gets its own attempt with inputs frozen
before execution.

## 9. Close the cycle

After a durable verdict:

```powershell
node dist/src/cli/index.js cycle close
```

The command performs the registered §18 closing benchmark, derives §24 from this exact cycle and
writes the §19 handoff. Required final state:

```text
grade: proof-authoritative
criteriaMet: true
```

## 10. Confirm and preserve closure

Restart/refresh the dashboard and rerun the final browser probe. Formal success is:

```text
integrationPass: true
activationReady: true
formalClosurePass: true
p2Closed: true
closureState: CLOSED
blockers: []
```

Retain the ZIP, release report, and P0 evidence already emitted by the gated package command.
Capture the final Status separately.

```powershell
node dist/src/cli/index.js status report
```

Keep the exact release ZIP/hash/report, final Status, P0 report, probe JSON, proof contract, patch
manifest, verdict/Great Book/cycle identities and ratification/epoch receipts together. Without Git
identity, retain the truthful `RELEASE_CANDIDATE` qualification.
