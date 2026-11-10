# CLU-E P03 Native Proof Pilot

P03 follows the Windows P02B dashboard acceptance. It runs one controlled
proof against a disposable target and records the native execution and verdict.
The pilot uses the installed Windows proof supervisor and the existing
frozen-contract command.

## Install and verify

1. Close CLU-E and let any active CLU-E commands finish.
2. Extract the ZIP into the directory containing `CLUE-Dashboard.bat`, for
   example `F:\CLU\CLU`. The expected clean base is P02B commit
   `5c3a6a4854e96951e1cbcc8619e6902f59b077de`.
   If the earlier P02B probe files are still untracked in that folder,
   move them to `F:\CLU\release-evidence` before verification.
3. Run `CLUE-Verify-Patch.bat`. It checks the P03 manifest, builds an
   isolated checkout, and runs the integration and dashboard suites.
4. After those checks pass, type `COMMIT P03` at the optional commit prompt
   to create the exact local checkout used by the native pilot. Press Enter
   for verification only. The verifier writes a JSON report under the
   sibling `release-evidence` directory.

## Run the native pilot

Run `CLUE-Windows-P03-Proof-Pilot.bat` from your regular Windows session.
Review the displayed scope, type `QUALIFY AND RUN P03`, and approve the
Windows elevation prompt for the pinned supervisor. Keep the terminal open
until it prints the JSON report path.

This launcher uses the existing reviewed production admission and
qualification evidence from the sibling `release-evidence` directory. The
pilot runs from the committed P03 source. Its fixture uses the legacy-config
runtime with a version 1 proof contract and a diagnostic cycle lock. The
expected synthetic cost falls from 100 to 80 and the guard stays at 497.
CLU-E records an isolated baseline, freezes the proof contract, binds that
baseline, measures the isolated candidate, and saves the verdict. The pilot
reopens the journal, checks the `ACCEPT` verdict and Great Book entry, then
removes the fixture. Their identities remain in the JSON report. The cycle
ends at `SCREENED`.

Send back the `CLU-E_WINDOWS_P03_PROOF_PILOT_*.json` from
`F:\CLU\release-evidence`. The report separates local verifier success
from native proof success or a native blocker.

The acceptance scope is one synthetic proof and a durable verdict. The
production `clue1` benchmark, the v10 promotion and ratification, and
publication or landing remain separate gates.
