# CLU-E Patch 05X2 — Windows scratch bootstrap

The 05X1 report `CLU-E_WINDOWS_PROOF_ADMISSION_20261108-091933-639-4d395aed.json` recorded the same outcome in both fixtures. Seven scratch variables matched. `TEMP`, `TMP`, and `LOCALAPPDATA` resolved to different absolute paths. All file-access checks and four request-refusal controls passed. Windows documents AppContainer startup remapping for those three variables. The report classified them as `OTHER_PATH`, so the exact locations and containment tier are unknown.

After the native supervisor validates the pinned request, the fixture checks its disposable roots, host sentinel exclusion, and the initial values of the seven unaffected variables. It then sets only the three affected variables in its own Node process from the approved scratch directories. An unexpected mismatch in another variable, or a missing, empty, or relative value in the three affected variables, blocks normalization. The initial values are never used for file access. The report preserves the redacted initial and effective classifications and records `scratchBootstrap`.

Success requires all ten effective values to match. The fixture checks `os.tmpdir()` and `os.homedir()` against the expected directories before writing a separate marker through each resolved path. The host verifies both marker files at their expected destinations along with the original direct filesystem checks, baseline and candidate permissions, and prelaunch refusal controls. The normal cleanup requirement applies.

This change is scoped to the pinned diagnostic process. The report retains `proofAuthorization: false`. Production qualification requires admission of a real baseline and candidate, workload startup and descendant evidence, and network containment under faults.

References

- [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [Node.js OS API](https://nodejs.org/api/os.html)
