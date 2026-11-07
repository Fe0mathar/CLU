# CLU-E Patch 05M2 — MXC canary diagnostics

**Applies to** the clean CLU-E checkout with 05M1 installed.

The first Windows 05M1 report confirmed the MXC archive and executable, then recorded exit 125 and `ArgumentException` for both positive canaries. This established supervisor refusal and left the exact throw site open. One masking bug was identified in the supervisor's audit reader. It attempted to parse every line containing an opening brace, including MXC's human-readable logs.

- Read only MXC's documented audit record prefix and report malformed records separately. Preserve the backend exit code and the allowlisted audit classification on refusal.
- Report the supervisor phase and a local source method or Win32 error number. Evidence omits raw command output, stack traces, free-text exception messages and filesystem paths.
- Reuse an installed v1.0.1 x64 engine when it matches the exact image SHA-256 observed after the verified 05M1 extraction. Verify the staged copy again, including Microsoft Authenticode. Otherwise use the existing official release download.

## Apply and collect evidence

1. Extract this ZIP into a new empty folder outside `F:\CLU\CLU`.
2. Run **APPLY-05M2.bat**. The installer verifies the manifest and commits the changes locally.
3. Run **CLUE-Windows-Supervisor.bat** in `F:\CLU\CLU`. On the reference installation, expect the setup to reuse the verified x64 engine. Send the latest `CLU-E_MXC_SUPERVISOR_DIAGNOSTIC_*.json` from `F:\CLU\release-evidence`.

The patched collector passed portable tests for old and new diagnostic codes and rejection of free-text and ambiguous output. The Windows retry checks native compilation and the canary results. This is a diagnostic patch, with proof authorization still gated on the supported containment boundary.

The archive manifest records the exact predecessor and replacement hashes. Revert the installer-created commit to roll back.

- [Microsoft MXC auxiliary diagnostic record format](https://github.com/microsoft/mxc/blob/main/docs/development/architecture/telemetry.md#local-audit-log-records)
