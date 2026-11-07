# CLU-E Patch 05C — Windows readiness probe

**Date** 7 November 2026  
**Prerequisite** Cleaned Batch 8 `CLU.zip` with Patches 01–05, 05A and 05B applied.  
**Patch 05B ZIP SHA-256** `4377836a6540adc3941ee2ab458c1ce3ab6f5f406ad5b38514a22879e29e6644`

## What and why

This diagnostic patch adds a shareable Windows readiness report. The preceding local preflight verified both documentation packs and recorded Windows acceptance as blocked on Linux. The Windows 05B dashboard report and a supervisor qualification receipt are still due. The next repair depends on the installation and native evidence.

The probe checks the local toolchain and in-memory SQLite, documentation and host preflight, local Git, and the proof supervisor configuration. It writes a redacted JSON report to an external path. The reported pin is a binary identity check. Native isolation, the live provider check, the governed proof, and the release decision each need their own evidence.

## Apply and verify

Extract the ZIP contents into `F:\CLU\CLU`. Open Windows PowerShell in that directory, in the environment used to launch the dashboard. Build first if `dist` is missing or stale.

```powershell
npm.cmd run build
node .\tools\p2-windows-readiness-probe.mjs --output 'F:\CLU\release-evidence\P2_WINDOWS_READINESS.json'
```

The command still writes the report when it finds a blocker and returns a nonzero exit code. Send `P2_WINDOWS_READINESS.json` together with the latest `CLU-E_Status_Navigator_*.json` from Patch 05B. The focused probe was tested on the local portable tree. Windows results come from the installation host.

## Next step

Review both reports before changing Windows proof behavior. When a compatible pinned supervisor is available, qualify it against the canaries in `docs/p2/WINDOWS_EXECUTION_SUPERVISOR.md`. Formal v9 closure follows the native and live acceptance gates in `docs/p2/P2_CLOSURE_RUNBOOK.md`.

## Rollback

Remove the entries marked Added and this manifest. Keep collected evidence separately.

## File inventory

| Project-relative file | Purpose | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `tools/p2-windows-readiness-probe.mjs` | Collect redacted preflight, native toolchain, installation and local Git evidence. | Added | `4098ff80b680e76ac6e0ce9019b9469cfd37e78966f3f0ec9996a2b00b9c83b1` |

This manifest is an added file. Its own hash is excluded from its table.
