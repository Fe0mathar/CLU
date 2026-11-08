# CLU-E Patch 05V — Host-first testing

## Purpose

CLU-E should prefer the actual Windows desktop for approved application and performance tests. The operator launches the bundled dashboard suite explicitly on the local checkout. The diagnostic records the chosen environment and source identity and measures the running dashboard on that same PC.

## Measurements

- The launcher runs the existing dashboard tests directly with the installed Node executable. Test paths come from committed dashboard test files. The actual local working bytes are measured, so existing edits to those files and dashboard source are reflected in the report. The input check bounds the scoped read and verifies the source before and after the run. Use this launch path for a checkout whose code you trust.
- The live HTTP baseline sends read-only requests to `127.0.0.1:47900` for the dashboard HTML and main JavaScript. It checks their SHA-256 against the checkout on every request and reports five sequential samples per asset after a warm-up. Each sample measures transfer through the end of the response body. Browser rendering performance requires a separate browser measurement.
- The JSON records test counts, elapsed wall-clock time, Git HEAD, the dashboard source fingerprint, local dirty state, Windows build information, and Node version. It contains aggregate test results and timing only. It lives outside the checkout.
- `HOST_TESTS_PASSED_BASELINE_PENDING` means the test suite passed and the separate HTTP measurement was unavailable or failed its validation. `SOURCE_MISMATCH` means the serving dashboard provided different HTML or JavaScript bytes. Open the intended checkout's dashboard and rerun the check.

## Installation and scope

The installer stages the exact manifest in a temporary index and commits only those paths. It permits unrelated unstaged and untracked files and refuses staged changes or a collision with a patch path. This allows the operator to keep the local interface changes in place.

This is the approved host diagnostic route. Formal proof continues to require the 05T production qualification and records the result separately. Sandbox is a possible fallback for operations whose host requirements cannot be met and whose Sandbox path can be qualified. A failure in this host run is recorded as a host result.

## Verification

Portable checks exercised the existing dashboard tests, local worktree byte identity, loopback response timing and mismatch detection, and exact manifest application over a checkout with unrelated local edits. Native Windows installer and launcher execution are acceptance steps.
