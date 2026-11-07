# CLU-E Patch 05B — Navigator inventory

**Date** 7 November 2026  
**Prerequisite** Cleaned Batch 8 `CLU.zip` with Patches 01–05 and 05A applied.  
**Patch 05A ZIP SHA-256** `55c0506f78b6ff4eb0758fc39f9ae085944eb02a53221a993d9f1f89a621c134`

## Finding and correction

The Windows browser report showed 550/550 physical SURF files, 219/445 recognition files, and Gate 38 unevaluated. The local before-patch replay found four visible physical files, one semantic snapshot file, and a 64-file TypeScript program in the same run. The two snapshots have distinct identities. Substituting the physical count into the old semantic comparison would give a false failure. The replay also reproduced the renderer replacing its physical snapshot ID with the graph commit's semantic capture ID.

Recognition now compares the governed physical inventory count with eligible file identities emitted to SURF. The writer checks duplicate locations and paths, conflicting removals, and enrichment that changes physical membership. The comparison is recorded in the current run pointer only after the matching stream seals. Status checks the active target, archive presence and size, and the matching durable graph identity before projecting that result. Older, degraded, or unavailable receipts yield pending. The focused probe corroborates the rendered run and physical membership separately from semantic recognition.

## Apply and verify

1. Stop the dashboard and any active recognition. Extract the ZIP directly into `F:\CLU\CLU` and allow replacements.
2. Restart the dashboard. From the project directory, run a fresh Navigator recognition and wait for it to finish.

```powershell
npm.cmd run recognize:navigator
```

3. Refresh the dashboard tab. Select **SURF** in Q1, then open **Configuration** and run the updated `tools/dashboard-status-probe.js` in the dashboard browser console.
4. Send back `CLU-E_Status_Navigator_<timestamp>.json`. Review the same-run identity checks, physical membership, Gate 38 and its receipt agreement. Semantic recognition coverage remains a separate observation.

The local after-patch replay verified a sealed 4/4 physical comparison, the rendered run and physical ID, and the independently valid Status seal. The build, 40 focused tests and 171 dashboard tests passed. Live acceptance still needs the focused JSON from Windows.

**Next step** Review the new JSON in depth before planning the next patch. A missing or failed native readiness check should have its own probe and evidence.

## Rollback

Restore replaced files from the cleaned Batch 8 plus Patches 01–05 and 05A. Remove the added entries and this manifest. Rebuild and run fresh Navigator recognition so the restored code writes a pointer in its earlier format. Preserve any existing evidence separately.

## File inventory

| Project-relative file | Purpose | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `selftest/navigator-inventory-parity.test.ts` | Exercise the real writer, archive and pointer with matching, missing and conflicting physical evidence. | Added | `d9f9ff2dbcc6c9afe3e63057f7ff3cafb265357a0dc4cb4511d3bb68b8dc6e81` |
| `selftest/status-projector.test.ts` | Check distinct pass, fail and pending states, including stale graph pointers. | `ab345a49c0ac7bbaae68ae2eb9733a1c003ebee02d9cf8418b3a8e71fa41e679` | `5a81a78d9407f024062a228e1692eb94d21f4372dc5f27b18bc905bc1dda8f1c` |
| `src/analysis/source/navigatorEvents.ts` | Measure physical membership from published batches and validate the committed inventory receipt. | `c5ab6f9ec8c4e7512aae54895ed437e299109cd14397cfc210cad928091db747` | `a2946cd2cb3f433742f9f3d7fcac0eb78b271bca73dad73128345fca92e13c1a` |
| `src/control/recognitionRun.ts` | Store the receipt in the current pointer after the matching run stream seals. | `1425f8c8a5dd928b3e2d06952f56026113b0dfe90475272bd23ae5298206a59a` | `5d1e84433261011b5bdbf99a8701b1111314a1e77063ef414f139c589176e699` |
| `src/status/statusFromRuntime.ts` | Read the active target’s sealed physical comparison. | `c1ce263303ee8a48be83466f17dc0eaee7e8cb363c7ec917eb7b52bcf1f63aec` | `30a125131f1f0ee5c4a411bf4515015082745760550ed2224d6892d218096270` |
| `src/status/statusProjector.ts` | Expose Gate 38 for the matching durable graph, using the physical comparison. | `3a9c5cf22c4b5312b8591cc11b4c137a3ab8a793598609a35e68533e0a58ee40` | `c6d1963172f4e087add7e50c7e1fe71164fefc9fd48676f24fd73f7441febf21` |
| `tools/dashboard-status-probe.js` | Compare browser, adapter and receipt using separate physical and semantic identities. | `6f5f28fc4bad3d6b02964a4640ca5a06a97fc533a1ec2494d66080055d68901c` | `60aade6389f0fa8184b3c57a43d7080e68149ddb69e25f211a8e72cf90fcc0ac` |
| `ui/clue-dashboard/app.js` | Keep the renderer’s physical snapshot and run identity through graph commit. | `19cec3e14f9a214eed44ba0642101d16ae0f6541e03d60e56ff181e9c318520f` | `93ac36cf5f3f2f6418303c687e624714c40dcef89a45f3559795a04f286258b0` |
| `ui/clue-dashboard/test/q1SurfInterface.test.mjs` | Guard physical identity against substitution with the semantic capture ID. | `f8269f73a056ebca6982f204d741cfba28580af45213ac57da9860f8de3c18fe` | `19548e09239c057e3f967148f08877fa9610321cb15ab61f40387ce7fc58cb80` |

This manifest is an added file. Its own hash is excluded from its table.
