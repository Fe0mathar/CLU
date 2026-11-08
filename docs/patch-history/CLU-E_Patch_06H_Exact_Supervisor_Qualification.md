# CLU-E Patch 06H

## Starting evidence

The 06G2 report `CLU-E_WINDOWS_PRODUCTION_ADMISSION_20261108-230639-951-0546a7ce.json` returned `PRODUCTION_ADMISSION_OBSERVED`. Baseline, candidate and npm typecheck passed against the same protected supervisor. All three cases verified their backup lease, empty job and WFP cleanup. The npm case reported `PATH_WALK_COMPATIBILITY` and completed the script.

## Changes

- Add a standard-user launcher for the seven existing native canaries. Bind it to the exact passed report and its installed 06G2 image.
- Start a fresh elevated registration session for the live standard PowerShell process, then run the pinned qualification script from that standard process. The supervisor and MXC executable hashes are checked before and after.
- Keep the qualification JSON outside the checkout and publish its path and hash. Qualification receipt pins remain an explicit later launcher action.

The native image remains the one that passed admission. The seven-case receipt covers the tested host and toolchain. The current network case exercises host loopback, a non-loopback address on this PC, and confined loopback. Independent off-host traffic and a BFE service restart remain outside this run.
