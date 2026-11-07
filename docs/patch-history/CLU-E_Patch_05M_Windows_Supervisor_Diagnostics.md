# CLU-E Patch 05M — Windows supervisor diagnostics

**Applies to** the clean CLU-E checkout through Patch 05L.

## What changed

- Added a one-click ZIP installer. It verifies every payload hash against the patch manifest, checks the clean Git baseline, applies only the declared files, and records them in one local commit. An interrupted or conflicting installation reports the affected file or recovery location. GitHub publication is a separate operation.
- Added a source-built Windows diagnostic supervisor. It requests Microsoft MXC's native ProcessContainer backend using the stable 1.0.0 policy schema. The wrapper verifies the pinned engine bytes, sends the bounded request without a shell, and supervises the process tree with a Windows Job Object.
- Added a setup launcher that obtains Microsoft MXC v1.0.1 from its official GitHub release, verifies the release asset SHA-256 and Microsoft Authenticode signature, and builds the wrapper using Windows .NET Framework. It runs the existing native qualification cases against disposable fixtures and writes an external diagnostic JSON.

## Why proof remains blocked

The MXC policy blocks external and host network access. Microsoft documents intra-container loopback as outside that policy. CLU-E requires denial of a confined process's own loopback as well. A host-specific canary result does not extend MXC's documented guarantee.

The compiled supervisor is scoped to the native canary fixture layout and workload. The launcher exports an observation report with `proofAuthorization: false`, then removes the temporary supervisor settings from its session. A supported mechanism for enforcing intra-container loopback denial and successful native qualification are still required before production proof.

- [Microsoft MXC v1.0.1 release and signed binaries](https://github.com/microsoft/mxc/releases/tag/v1.0.1)
- [MXC ProcessContainer network policy](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/networking.md#model-3-externally-blocked-most-restrictive)
- [MXC Windows build support](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md)

## Apply and collect evidence

1. Close the dashboard. Extract the ZIP outside the CLU-E checkout and double-click **APPLY-05M.bat**. The default target is `F:\CLU\CLU`. A different checkout can be provided as the first argument. Wait for the local commit confirmation.
2. Double-click **CLUE-Windows-Supervisor.bat** inside the project. It requires native Windows, PowerShell 7, Node with the project's dependencies, Windows .NET Framework 4.x, and a Windows build that supports the requested ProcessContainer policy. The setup uses a process-scoped script execution setting.
3. Send the `CLU-E_MXC_SUPERVISOR_DIAGNOSTIC_*.json` written to `F:\CLU\release-evidence`. If the evidence directory itself could not be opened, capture the console's stop message.

The setup stores the supervisor under the current Windows profile and writes evidence beside the checkout.

## Verification and rollback

Portable checks cover archive hashes, Git commit scope, and the qualification runner's Linux refusal. Windows PowerShell, C# compilation, MXC enforcement and canary execution require the target Windows host.

The ZIP's `patch-manifest.json` lists each destination and the exact before and after hashes. To roll back a completed install, revert the installer-created local commit. Keep the external diagnostic JSON for comparison.
