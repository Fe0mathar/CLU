# CLU-E Patch 05N — Windows loopback filtering diagnostic

**Applies to** the clean CLU-E checkout through Patch 05M3.

05M3 passed the Windows fixture canaries. Its same-container TCP result describes one host observation. MXC's documented deny policy does not cover intra-container loopback. A release supervisor needs a separately verified control.

## What changed

- A fixed, SHA-256-pinned Node bootstrap waits before opening sockets. The supervisor queries the live process handle, verifies the pinned Node executable and supervisor-job membership, and reads the actual AppContainer package SID from the Windows token. The supplied MXC container label is for per-run isolation and is not used to derive a SID.
- On the filtered runs, the supervisor installs six temporary Windows Filtering Platform filters for that exact SID. The filters cover IPv4 and IPv6 bind, connect, and receive/accept. It checks the installed filters and their scope before releasing the socket tests. The test requires different observed identities for the unfiltered control and each subsequent run.
- The runner tests IPv4 and IPv6 TCP and UDP. It captures the unfiltered MXC result and host loopback controls. If MXC blocks the control as well, the result is `FILTER_BOUND_ATTRIBUTION_UNPROVEN`. The report distinguishes this from an observed difference.
- The supervisor checks that the diagnostic job is empty before normal lease release and verifies from an independent WFP session that the filters and their private sublayer are gone. The runner repeats this check on a supervisor-enforced deadline.

The lease is dynamic and package-scoped. The diagnostic requires Windows administrator access to add its temporary WFP objects. The installed MXC executable is reused after SHA-256 and signature verification. The WFP launcher requires the existing x64 engine under the current account and refuses if it cannot verify it.

## Apply and collect evidence

1. Extract the ZIP into a new empty folder outside `F:\CLU\CLU` and run **APPLY-05N.bat** normally. It verifies the manifest and creates a local commit.
2. From the signed-in Windows desktop, right-click **CLUE-Windows-WFP-Diagnostic.bat** in `F:\CLU\CLU` and choose **Run as administrator**, using the same Windows account that ran 05M3.
3. Send the latest `CLU-E_MXC_SUPERVISOR_DIAGNOSTIC_*.json` from `F:\CLU\release-evidence`. The report should show `wfpDiagnostic: true`.

05N uses only disposable fixtures and reports `proofAuthorization: false`. Production still needs evidence for descendant coverage and ordering after abrupt supervisor or filter-owner death. A dynamic session removes objects when its owner exits, so independent proof of process-tree termination before policy disappears is a separate release requirement.

Portable tests verified the bootstrap hash, loopback matrix, bounded evidence parser, archive hashes, and non-Windows refusal. Native C# compilation and WFP installation, traffic attribution and removal must be checked on Windows. The patch manifest records exact predecessor and replacement hashes. Revert the local patch commit to roll back.

- [Microsoft MXC ProcessContainer network policy](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/networking.md)
- [Microsoft WFP object lifetime](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)
- [Microsoft WFP filtering conditions](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-conditions-available-at-each-filtering-layer)
