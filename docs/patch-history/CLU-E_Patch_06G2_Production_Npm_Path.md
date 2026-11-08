# CLU-E Patch 06G2

## Observed failure

The 06G1 report `CLU-E_WINDOWS_PRODUCTION_ADMISSION_20261108-225946-167-ff34d07c.json` passed baseline, candidate and malformed-request checks. It verified job drain and WFP cleanup for all three launches. The npm case returned exit code 1 before producing its typecheck marker. The diagnostic retained the stage because the overall check failed.

## Changes

- Reuse the earlier governed npm path handling for the exact admitted npm route. The native host first verifies the canonical package path. After WFP release, the trusted bootstrap opens the regular single-link manifest and checks Node's path resolution. A specific `EACCES` or `EPERM` on that path walk enables two fixed Node flags for npm and its children.
- Stage the diagnostic's writable npm cache before the run. Retain bounded npm failure categories and lifecycle evidence in the report.
- Preserve the request environment allowlist, exact WFP release conditions and existing npm pass criteria. Refresh the source pins.

The 06G1 report establishes that npm exited before its marker. The Windows rerun determines whether path compatibility is needed and whether the full npm case passes. The installed image still needs the separate seven-case qualification.
