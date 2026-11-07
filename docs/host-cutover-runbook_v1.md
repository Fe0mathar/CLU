# Host Cutover Runbook — P0-final

**Status:** ready to execute
**Date:** 2026-08-10
**Host:** the reference machine, `F:\clu\clu` (Windows, PowerShell 7.x)
**Closes:** DEV-P2-05 (the DEP-P0-01 exit sequence), given ADR-0006 accepted 2026-08-10
**Rule of the runbook:** every step names its expected output. If reality disagrees, **stop
and report the verbatim output** — do not improvise past a mismatch. The refusals in this
system are load-bearing; several steps below are *expected* to refuse until their
predecessor completes.

---

## 0. What "done" looks like

`clue doctor` ends the day reading, among its lines:

```text
OK  tracked documents     11 present
OK  pack seal             17/17 declared files verified
OK  registration ⊆ pack   11 tracked documents all declared by the seal
OK  manifest ↔ seal       16 entries agree; amended: CLUE_Project_Directory_v9.md rev 9.1
OK  ratification          EVENT-… by creator …; seal current; discharges CLUE_Constitution_v9.md
OK  epoch                 P0-final sealed as EVENT-… by creator (boundary …, … blobs) at …
OK  target description    target description.md 92be35bb11e3…
```

## 1. Stage the files

**1a. Source files** — apply every delivered file from this session at its path. The set:
`tools/install-v9-pack.mjs` · `config/clue.config.yaml` · `CLUE_Project_Directory_v9.md` ·
`SHA256SUMS_v9.txt` · `DOCUMENTATION_MANIFEST_v9.json` · `target description.md` ·
`src/shared/schemas.ts` · `src/shared/ids.ts` · `src/control/mission.ts` ·
`src/memory/artifactStore.ts` · `src/cli/index.ts` · `src/cli/commandAuthority.ts` ·
`src/cli/commands/docsCommands.ts` · `src/cli/commands/doctorCommands.ts` ·
`src/cli/commands/epochCommands.ts` ·
`docs/architecture-decisions/ADR-0006-evidence-epoch-seal.md` ·
`docs/cycle-implementation-plan_v1.md` · `docs/host-cutover-runbook_v1.md` (this file) ·
five `selftest/` modules: `authority-ratification` · `event-fault-injection` ·
`navigator-seal-bindings` · `missing-source-categorisation` · `evidence-epoch` (`.test.ts`).

Note the three root documents land at their **v9/plain names** even though your tree still
holds v8 names — the installer resolves that next, by content.

**1b. Pack drop** — create `F:\clu\pack-drop\` containing **exactly**: the four unchanged
files from the original v9 pack delivery (`DOCUMENTATION_GOVERNANCE_v9.md`, `README_v9.md`,
`VALIDATION_REPORT_v9.md`, both templates — underscore filenames are fine, content is what
counts) **plus the three delivered current-state files**: `SHA256SUMS_v9.txt`,
`DOCUMENTATION_MANIFEST_v9.json`, `CLUE_Project_Directory_v9.md`.

> **Do not** put the original pack's old `SHA256SUMS_v9.txt` or manifest in the drop. The
> seal moved under the governed §7/§19.3 amendment; a stale seal in the drop makes the
> installer refuse with *"Two seals cannot both govern"* — that refusal working is correct,
> and the fix is a current drop, not a flag.

## 2. Install the pack (renames by content, copies the rest)

```powershell
cd F:\clu\clu
node tools\install-v9-pack.mjs --source F:\clu\pack-drop          # dry-run: review the plan
node tools\install-v9-pack.mjs --source F:\clu\pack-drop --apply
```

Expected plan: **10 renames** (your v8-named documents whose bytes already equal the
declared v9 content) and **8 copies** (the seven drop files plus the seal itself); then
`installed: repository root byte-agrees with the v9 seal.` and a receipt under
`workspace\installation\`. The Directory is a *copy*, not a rename — your on-disk
`CLUE_Project_Directory_v8.md` predates the rev 9.1 amendment, so its content matches
nothing declared and the installer correctly leaves it alone.

**2a. Retire the superseded Directory** — guarded, never blind:

```powershell
(Get-FileHash CLUE_Project_Directory_v8.md -Algorithm SHA256).Hash.ToLower()
# expected: 41b20391f6f599767dbd146aaf76e96d7a9d554f87d81e92babf48013a51bafc
Remove-Item CLUE_Project_Directory_v8.md    # only if the hash matched; otherwise STOP
```

Its v8 lineage survives in the pack's own §14 record and the rev 9.1 header.

## 3. Gate the build

```powershell
npx tsc --noEmit        # exit 0
npm run build           # exit 0
npm run selftest
```

Expected: **487 tests · 477 pass · 0 fail · 10 skipped** — your host's skip set is 10 (it
differs from the Linux sandbox's 5; both are platform-dependent skips, not failures). Any
`fail` count above zero: stop and report.

## 4. First doctor — expected honest gaps

`clue doctor` now shows the five installed-authority lines with **WARN ratification
(never performed)** and **WARN epoch (no epoch sealed)** — correct, those are Steps 6–7 —
plus `OK target description … 92be35bb11e3…`, and a **WARN missing sources** line in the
new categorized shape (`N cited but never ingested — … on disk outside the corpus … ·
… absent: target ← citer`). Your list will differ from the sandbox's: your workspace
ingested the v8 paths historically, so many old names resolve as known documents there.
Read it; don't fix anything from it today.

## 5. Successor mission and corpus

```powershell
clue init          # expect: many "document changed" lines (the renames, config, schemas,
                   # target description), then "amendment A2 in force"
clue docs ingest   # expect: the eleven under v9 names; superseded counts on moved content;
                   # a conflicts delta including the rev-1/rev-2 ADR pair — recorded, not fixed
clue init          # expect: no "document changed" lines — idempotence check
```

## 6. Ratify (Creator ceremony, interactive)

```powershell
clue docs ratify
```

The preview shows the seal `e4df60617c96…` (17 files) — the same bytes delivered, so the
phrase is `RATIFY e4df60617c96`. Expected receipt: an `EVENT-…` id, the full seal hash,
your typed statement, the timestamp. Running it twice: *"This pack state is already
ratified"* — correct.

## 7. Seal the epoch (Creator ceremony, interactive)

```powershell
clue epoch seal
```

The preview shows **your** legacy head — sequence and hash are machine-specific; type
`SEAL <the 12 hex characters shown>`. Expected receipt: boundary = that head, the seal
event at head+1, your blob census pinned under one manifest hash, `stands on` naming the
ratification from Step 6.

## 8. Close the day

```powershell
clue doctor          # the §0 picture, all OK
clue doctor --deep   # projection parity and integrity at full depth
```

Then produce the next session's baseline: a fresh `CLU.zip` of `F:\clu\clu` (the standing
rule holds — `ui/clue-dashboard/app.js` is only ever taken fresh, never from a snapshot).

## 9. If something refuses

Refusals you may legitimately meet, each meaning the system is working: *two seals* (§1b
note — stale drop), *drifted basis / register a successor* (you edited something after
`init` — run `clue init` again), *already ratified / already sealed* (re-runs),
*non-interactive input refused* (the ceremonies want a real console). Anything **else** —
especially a `fail` in the suite, a pack-seal mismatch, or a chain error — is a stop-and-
report, with the verbatim output.
