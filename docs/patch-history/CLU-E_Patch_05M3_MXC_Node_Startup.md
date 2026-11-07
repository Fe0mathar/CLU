# CLU-E Patch 05M3 — MXC Node startup canary

**Applies to** the clean CLU-E checkout through Patch 05M2.

The 05M2 run reused verified MXC v1.0.1 and returned `0xC0000142` for both positive canaries. Windows defines this status as DLL initialization failure. MXC's issue tracker reports the same status from Node in non-interactive BaseContainer sessions on the same Windows build. The previous report omitted session data, and the old policy also disabled Win32k.

- Test Node startup on the signed-in Windows desktop with Win32k enabled for the pinned qualification fixture. MXC policy requests container-scoped handle and atom isolation, no clipboard, no input injection, no IME, and no desktop or system settings control.
- Record the launch session ID, interactive state, and whether the supervisor matched the workload's exit to MXC's protected audit record.
- The setup reuses the previously verified MXC executable and the existing canary admission rules. The report has `proofAuthorization: false`. Native proof requires supported intra-container loopback enforcement.

## Apply and collect evidence

1. Extract the ZIP into a new, empty folder outside `F:\CLU\CLU` and run **APPLY-05M3.bat**. It verifies the manifest and creates the local commit.
2. Double-click **CLUE-Windows-Supervisor.bat** in `F:\CLU\CLU` from your signed-in Windows desktop. The first checkpoint is `allowed-command PASS` for baseline and candidate.
3. Send the newest `CLU-E_MXC_SUPERVISOR_DIAGNOSTIC_*.json` from `F:\CLU\release-evidence`.

Portable tests verified the exit-code collector and scoped policy change. Native Windows still needs to validate the canary policy. The archive manifest records exact hashes. To roll back, revert the installer-created local commit.

- [Microsoft NTSTATUS values](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55)
- [Microsoft MXC issue 1465](https://github.com/microsoft/mxc/issues/1465)
- [MXC 1.0.0 policy](https://github.com/microsoft/mxc/blob/main/docs/containment-policy/1.0.0/policy.md)
