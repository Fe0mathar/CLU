# CLU-E Patch 06D1

## Observed failure

The first 06D Windows report verified the installed MXC executable and reached `GOVERNED_WFP_PROTECTED_BUILD`. Setup stopped before accepting the installed-image receipt. The report contained no workload result or supervisor image hash. It recorded that the diagnostic stage was retained.

The delivered `WfpIntegratedRun.cs` used `Regex` and `RegexOptions` without importing `System.Text.RegularExpressions`. This prevents the pinned native sources from compiling. The first report did not record how far the elevated builder progressed.

## Changes

- Add the missing namespace import and update its canonical SHA-256 in both setup paths. Update the elevated builder's own source pin.
- Map the elevated builder's process exit status to a bounded category in `installation.buildFailure`. The category distinguishes preflight, operator token, input verification, protected root, source pins, compilation, image verification, guardian startup and ready receipt publication. Setup also reports launch, wait and receipt validation failures.
- Keep the existing installed-image receipt and guardian authorization checks. A build failure category is diagnostic evidence only.

## Windows acceptance

Run `CLUE-Windows-Governed-WFP.bat` from the regular Windows session. Approve same-account elevation, then type `RUN GOVERNED` if prompted. Collect the new JSON report. The combined workload milestone requires `GOVERNED_WFP_WORKLOAD_OBSERVED` with the workload, enforcement and cleanup evidence. The diagnostic sets `proofAuthorization` to false.
