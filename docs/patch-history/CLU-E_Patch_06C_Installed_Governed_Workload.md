# CLU-E Patch 06C — Installed governed workload diagnostic

## Why

Patch 06A exercised the governed workload through a temporary supervisor executable. Patch 06B3 verified the separate WFP owner-loss experiment on the Windows host. The next local step is to exercise the governed candidate from its installed layout and record which installed binaries served its requests.

## Changes

- Add a standard-user Windows launcher for the installed governed diagnostic. It compiles the existing stage-bound candidate and places the wrapper and verified Microsoft MXC sidecar together under a separate content-addressed diagnostic installation.
- Route the existing governed harness through that exact installed executable. Check the canonical two-file layout and both hashes before and after execution, with the setup process also checking the MXC signature.
- Preserve the governed source review, offline dependency preparation, request allowlist, direct npm typecheck, CLU-E deep verification and prelaunch refusal checks.
- Record installed-image evidence and cleanup separately. An unsettled run retains its owned files for diagnosis.
- Include the launcher in the exact release bundle.

## Scope

This is an installed-path diagnostic on the operator's PC. The candidate is bound to the disposable stage compiled for the run. The evidence covers the governed workload and its installed image. The earlier WFP fixture report covers its separate owner-loss experiment. The report keeps `proofAuthorization: false`, `offHostLan: NOT_TESTED` and `bfeRestartQualified: false`. Release qualification requires the final supervisor configuration and its own evidence.

Apply using `APPLY-06C.bat` and run `CLUE-Windows-Installed-Governed-Workload.bat` as the normal Windows user. Review the displayed committed source and offline inputs before typing `RUN GOVERNED`. Send the latest `CLU-E_WINDOWS_INSTALLED_GOVERNED_WORKLOAD_*.json`.
