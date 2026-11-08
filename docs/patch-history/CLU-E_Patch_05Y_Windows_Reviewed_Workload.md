# CLU-E Patch 05Y — Reviewed Windows workload

05X2 passed its pinned synthetic baseline and candidate fixtures on the Windows PC. Each run verified the scratch normalization and expected file access. The next acceptance step executes real CLU-E dashboard tests inside the same native supervisor path in the regular Windows session.

## How it runs

- The diagnostic reuses 05W staging to copy the approved dashboard scope from Git HEAD and the current local checkout. The suite files and package metadata must be identical across both copies. A console prompt displays the two fingerprints and changed paths and requires the operator's `RUN REVIEWED` approval before execution.
- The native request admits the exact pinned inline bootstrap, exact Node executable, and a fixed staged layout. It validates the protected manifest of dashboard test paths. Both measured checkouts are read-only, with separate writable workspace and scratch roots per side. The earlier 05X2 run exercised writable disposable candidate staging.
- The bootstrap normalizes the three observed scratch variables inside the confined process, checks its access boundary, and checks scratch inheritance in a separate Node child before launching the dashboard suite with a direct, fixed `node --test` invocation. The report records bounded counts and status. The host verifies the staged snapshots and expected markers.
- `REVIEWED_WORKLOADS_OBSERVED` requires both sides to pass with comparable test counts and verified cleanup. The report records `proofAuthorization: false`.

## Scope

This diagnostic qualifies the reviewed dashboard workload path for the recorded Windows session. Production qualification still requires governed Node and offline npm workload admission, isolation through the declared network fault, and the host-bound production qualification receipt for the exact supervisor.
