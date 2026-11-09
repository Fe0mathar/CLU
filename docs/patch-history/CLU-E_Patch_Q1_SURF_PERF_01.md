# Q1 SURF performance patch for the audited CLU-E update

9 November 2026

## Apply

This overlay targets the `updated.zip` audit release. Close the dashboard and copy the contents of the patch ZIP into `F:\CLU\CLU`, allowing its files to replace the corresponding project files. Reopen `CLUE-Dashboard.bat` and refresh the dashboard with Ctrl+F5. The patch uses the dependencies already installed for the audit release.

If you edited the dashboard locally, check its SHA-256 before copying. The patch expects `ui/clue-dashboard/app.js` at `f684b6c26d9b71c88129f2aebff5c9252a5b23ca73c2828de601d02926e78239`. The replacement hash is `2acb68f0809de39807fed1525c4b0adfd701978bb173884a508c36ebf7ef5673`.

## Changes

- Clear inherited Canvas2D shadows for micro-pattern strokes. Limit expensive node and anchor effects to focused states and retain the containment guide halo.
- Draw the idle SURF canvas once per second. Interaction, dirty frames and active animations can draw immediately.
- Port all 16 renderer edits onto the audited dashboard. The merged app preserves the audited START, Q3 and Git receipt paths.
- Pin the exact merged app and the audited recognition source in the Windows readiness probe. It reports the fingerprint baseline as `AUDITED_UPDATE_PLUS_Q1_SURF_PERF_01`. A source `MATCH` verifies the six pinned files. Native Windows readiness has separate gates.

## Verification

`npm run dashboard:verify` passed 188 tests. `npm run navigator:verify` passed 12 tests. The two new tests detect the inherited-shadow and idle-redraw regressions in the unpatched audit release. The readiness probe matched all six source fingerprints.

Pan FPS and frame time depend on the browser, GPU and project graph. Measure those on the Windows dashboard with the SURF performance probe after applying the patch.
