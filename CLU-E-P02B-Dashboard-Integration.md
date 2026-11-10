# CLU-E P02B Dashboard Integration

P02B combines Configuration UX 01 and the CLUE Operator Agent as an overlay for
P02 with the P02A Zod hotfix applied. It adds a dashboard acceptance step before
the next cycle-engine patch. The P02 cycle and recovery protocol and the v9
documentation seal remain the basis for the Windows pilot.

## Apply and verify

1. Close the dashboard and let any active CLU-E commands finish.
2. Extract the ZIP contents into the directory containing
   `CLUE-Dashboard.bat`, for example `F:\CLU\CLU`. Replace the matching files.
3. Run `CLUE-Verify-Patch.bat`. It checks the installed bytes against
   `CLU-E-P02B-Manifest.json` and runs the local build, integration tests, and
   dashboard tests in an isolated checkout.
4. After the checks pass, press Enter for test-only verification or type
   `COMMIT P02B` for a local commit. For a run without a prompt, use
   `CLUE-Verify-Patch.bat --test-only`.
5. Send back the JSON file printed by the verifier. The report is saved under
   the sibling `release-evidence` directory, including when a gate fails.

The prerequisite is the reviewed P01A base
`2b848d5e394e0892264c85b254f25d040d2b5edb` with the exact P02 and P02A
files installed. The verifier accepts those changes already committed locally
or still present as the exact overlay. The P02B manifest covers the merged
installation. The earlier P02 manifest remains a receipt for that release.

The optional commit is local and limited to the manifest-listed paths. If P02
and P02A were copied in and are still uncommitted, it includes their verified
prerequisite paths so the tested checkout matches the commit. If unrelated
changes are detected, the verifier reports the blocker before it stages
anything. A test-only result is valid evidence for the local checks. A
self-targeting profile that requires a clean Git checkout needs the local
commit before its governed cycle pilot.

## What to verify in the dashboard

- **Configuration** opens on Overview. Try sidebar navigation and setting
  search, then edit a field and check that Review Changes, per-field Undo,
  Discard, and Save Changes reflect the current draft. When editing a profile
  other than the running one, check both identities in the header before saving.
- **Agents** has CLUE's identity and exact-model brain. Follow the credential
  instructions in that section, then select Test brain. The Operator Agent
  uses a separate binding from the Cycle Brain. Supply credential references
  in the identity, and keep actual keys in the credential store or environment.
- **Q4** supports `/help`, `/status`, `/start`, and `/git sync`.
  Start and Git sync go through their existing operator entry points. CLUE can
  discuss the bounded dashboard observations through its configured brain.
  Configuration changes and Git sync are explicit operator actions.
- **P02 recovery** remains its own Windows gate. Confirm the cycle ID before
  and after reopening the dashboard, then use the P02 pilot instructions to
  capture the checkpoint evidence through `SCREENED`.

Local verifier checks use test fixtures. A live CLUE brain check, the Windows
recovery pilot, and the two-profile A → B → A isolation check have separate
acceptance evidence. Keep v9 active while collecting those results.
