# CLU-E Patch 05D — Navigator snapshot binding

**Date** 7 November 2026  
**Prerequisite** Cleaned CLU-E with Patches 01–05, 05A, 05B and 05C applied.  
**Patch 05C ZIP SHA-256** `739385203c6a89087b1c219c78f1c8d8142a4a77c88e56e271179c28b4dadd82`

## What changed

The Windows browser report showed that the adapter and durable inventory receipt agreed on the physical snapshot and all 636 files. The renderer reported a different snapshot ID. The stream uses `graph.committed`, and the renderer’s previous branch expected `graph-committed`. The raw message could therefore assign the semantic graph’s snapshot ID to the physical view.

The renderer now keeps the physical identity through the real event delivery paths. The updated focused probe reports a known identity mismatch as FAIL and missing evidence as PENDING. The Windows readiness probe verifies the updated source fingerprints.

## Apply and verify

1. Close the dashboard launcher. Extract the ZIP contents directly into `F:\CLU\CLU` and allow replacements.
2. Start `CLUE-Dashboard.bat` and reload its dashboard page with Ctrl+F5. Use the existing recognition run if the dashboard shows that the inventory has loaded.
3. In the Dashboard, select **SURF**. Wait for the inventory to finish loading. Paste the full contents of `tools\dashboard-status-probe.js` into the browser console and run it. The JSON downloads automatically. Keep the Navigator identity and inventory checks from this capture. Configuration is expected to be pending in this view.
4. Open **Configuration** and run the same probe again. Keep the second JSON for the Configuration panel check. Send both JSON files.

For the current recognition run, the renderer, adapter and receipt must agree on the physical snapshot and all 636 files. The rendered location and version identity check and both Gate 38 checks must pass. The Configuration panel check must pass in the second capture.

## Follow-up

The reported SURF slowdown is strongest in the overview and improves at deep zoom. Compare overview pan and zoom with deep zoom after replay has settled. This observation is tracked separately for performance profiling. Windows native release readiness also requires a fresh readiness report.

## Rollback

Restore the replaced files from the pre-05D project or reapply their original patch versions. Remove entries marked Added and this manifest.

## File inventory

| Project-relative file | Purpose | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `tools/dashboard-status-probe.js` | Distinguish conflicting identities from missing evidence. | `60aade6389f0fa8184b3c57a43d7080e68149ddb69e25f211a8e72cf90fcc0ac` | `59a27b1e35ce366bf12aa18cd4ad70b533cc4c9b78070e7a7136789145d5fac7` |
| `tools/p2-windows-readiness-probe.mjs` | Verify the expected 05D source fingerprints. | `4098ff80b680e76ac6e0ce9019b9469cfd37e78966f3f0ec9996a2b00b9c83b1` | `32f2c8a536ce56591388a74ff825e25d590812b4dc916ce952bec6279d9d91a8` |
| `ui/clue-dashboard/app.js` | Keep the renderer bound to the physical inventory snapshot through live delivery and replay. | `93ac36cf5f3f2f6418303c687e624714c40dcef89a45f3559795a04f286258b0` | `41225e60146539e6933f90cca808508bf4c6ca7397276309f666e8472746e103` |
| `ui/clue-dashboard/test/q1SurfInterface.test.mjs` | Exercise physical snapshot updates through live event shapes. | `19548e09239c057e3f967148f08877fa9610321cb15ab61f40387ce7fc58cb80` | `48137d0537ad431adb77d333918e9500b1e7f96f16585d12cd9fe87a590ea2c6` |

This manifest is an added file. Its own hash is excluded from its table.
