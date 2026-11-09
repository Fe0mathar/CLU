# CLU-E Patch 06H2 — Supervisor deadline evidence

## Trigger

The 06H1 report `P2_WINDOWS_SUPERVISOR_QUALIFICATION_20261108-232441-494-a449bcce18c0492dab7a9c5b94f14bc0.json` matched the installed 06G2 supervisor and recorded six passing native canaries. The descendant deadline case observed both processes alive and then observed both exit. The supervisor returned `125`, its fail-closed result. The canary requires native deadline exit `124`, no host watchdog timeout, and verified tree termination.

The 06H1 report omitted the native refusal phase and job and filter cleanup evidence for that case. Those details are required before choosing a native correction.

## Change

- `tools/p2-windows-supervisor-qualify-06h2.mjs` collects the supervisor wall time, outer watchdog state, bounded diagnostic codes, and the validated Windows Filtering Platform lifecycle record from the deadline request directory. It captures the record before temporary fixture cleanup. The report includes only typed diagnostic fields.
- `tools/windows-supervisor/QualifyProductionProof.ps1` pins the new qualifier source in LF and CRLF form. It continues to verify the same installed 06G2 supervisor, Microsoft MXC engine, Node, prelude, and admission report.

The fixture scripts, request arguments, timeout budgets, qualification receipt schema, and pass criteria remain as in 06H1. The result of the instrumented Windows run determines whether a native correction is needed.

## Apply and verify

Extract the ZIP outside the checkout and run `APPLY-06H2.bat`. The installer checks the predecessor and payload hashes and commits the patch files locally. Run `CLUE-Windows-Qualify-Proof-Supervisor.bat` from a regular Windows session and attach the newest qualification JSON from `F:\CLU\release-evidence`.
