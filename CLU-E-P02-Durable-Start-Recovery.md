# CLU-E P02 Durable Start and Recovery

Apply this overlay to the clean P01A commit
`2b848d5e394e0892264c85b254f25d040d2b5edb`. P02 uses the current v9 documentation
and its existing cycle events. Its dashboard worker drives the cycle through
`SCREENED`. Later stages retain their existing governed entry points.

## Apply

1. Close the CLU-E Dashboard and wait for active CLU-E commands to finish.
2. In `F:\CLU\CLU`, verify that `git rev-parse HEAD` matches the P01A commit
   above and `git status --short --branch` shows a clean checkout.
3. Extract the ZIP contents into the folder that contains `CLUE-Dashboard.bat`.
   The manifest lists every file and its expected SHA-256.
4. From that folder, run the build and checks in PowerShell.

~~~powershell
npm.cmd run build
node --test --test-concurrency=1 dist/selftest/clue-dashboard-server-authority.test.js dist/selftest/dashboard-cycle-progress.test.js dist/selftest/resume-planner.test.js dist/selftest/cycle-closure.test.js
npm.cmd run dashboard:verify
~~~

After those checks pass, stage and review the overlay before committing locally.
For this self-targeting profile, a clean checkout is required by the Git preflight.

~~~powershell
$patch = Get-Content -LiteralPath .\CLU-E-P02-Manifest.json -Raw | ConvertFrom-Json
foreach ($entry in $patch.files) {
    if ((Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -ne $entry.afterSha256) {
        throw "Patch verification failed for $($entry.path)"
    }
}
$paths = @($patch.files.path) + @($patch.metadataFiles)
git add -- $paths
git diff --cached --check
git diff --cached --stat
~~~

~~~powershell
git commit -m "Add durable dashboard Start and recovery"
git status --short --branch
~~~

## Run the Windows pilot

Open `CLUE-Dashboard.bat` on the intended profile. Enter `/status` in Q4 first.
The active cycle ID, current stage, and most recent projected checkpoint are
shown when available. Use an approved pilot workspace if the active profile
already has an open cycle at `SCREENED` or a later stage and you need to test
a fresh drive. Its existing result remains visible and `/start` attaches to
that result.

1. Enter `/start` in Q4. A second request while the worker is
   running attaches to the same dispatch. The canonical cycle ID appears as
   soon as the opening checkpoint is projected.
2. For the interruption test, close the dashboard terminal after a
   pre-screening checkpoint appears. Wait for the old cycle worker to exit.
   Reopen the dashboard and enter `/status`. The previous cycle ID should be
   present. Enter `/start` to continue it after verification. The worker
   checks the event chain, projection freshness, mission, lock, and relevant
   evidence before advancing an existing opening checkpoint. If the worker is
   still alive, its writer lock can defer the retry.
3. Check that the same cycle reaches `SCREENED` and that another
   `/start` returns the saved cycle. `SCREENED` records that screening
   finished. The closure and its verdict are separate cycle events.

For a deliberate pause, use the existing CLI while no cycle worker is active.

~~~powershell
node .\dist\src\cli\index.js cycle suspend --reason "Windows P02 pilot pause"
node .\dist\src\cli\index.js cycle resume
~~~

After `cycle resume` verifies and restores the earlier stage, return to Q4 and
enter `/start` to continue through screening. If resume reports drift, retain the
failure details and inspect the named inputs before retrying.

## Capture evidence

In the dashboard tab's DevTools Console, run this after the worker finishes and
before closing the dashboard. Copy the returned JSON for review.

~~~javascript
const run = await (await fetch('/api/run', { cache: 'no-store' })).json();
console.log(JSON.stringify({
  cycleId: run.cycleId,
  stage: run.cycleStage,
  state: run.state,
  cycleCurrent: run.cycleCurrent,
  cycleMissionMatches: run.cycleMissionMatches,
  recoveryRequired: run.recoveryRequired,
  checkpoints: run.checkpoints,
  eventAppends: run.eventAppends
}, null, 2));
~~~

Checkpoint receipts are recovered from the event projection after reopening.
`state` describes the worker in the current dashboard session. `cycleStage`
describes the most recent projected stage of the active or last closed cycle.
`eventAppends` is per successful worker attempt and is available in that
dashboard session. It records count, total milliseconds, and maximum
milliseconds for synchronous journal writes and their filesystem sync calls.
Use the reviewed Windows launcher on the new committed HEAD to validate the
updated release and collect the separate two-profile A → B → A isolation
evidence before v10 promotion.
