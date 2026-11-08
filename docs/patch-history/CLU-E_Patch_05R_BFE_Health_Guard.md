# CLU-E Patch 05R — BFE health guard

## Purpose

Patch 05Q measured loopback isolation against the host and containment after simultaneous loss of the diagnostic supervisor and guardian. Patch 05R adds a separate diagnostic for what happens when the controller detects a loss of Base Filtering Engine (BFE) health while a pinned fixture is running.

## Changes

- The diagnostic controller queries the Windows Service Control Manager for BFE status before launching MXC, before releasing the fixture gate, and during native job observation. An unavailable or non-running service, an unavailable PID, or a changed PID latches the first failure.
- The controller checks its WFP sublayer and every installed filter against the expected package SID and policy before releasing the fixture. The controller publishes a private readiness marker once it verifies the fixture identities and their denied binds.
- The host harness then writes a private fault marker. After a successful read of the original BFE PID, the controller substitutes a different PID in memory to exercise its cancellation path. The existing native job handler terminates the job and waits until Windows reports zero active processes. The controller checks that the fault is still latched and that the expected WFP policy remains installed, then releases the lease and verifies removal independently.
- Setup adds `wfpBfeGuard` to the diagnostic JSON and skips the case if cleanup from an earlier diagnostic case is unverified.

## Acceptance

The expected state is `wfpBfeGuard.state = BFE_GUARD_CANCELLATION_OBSERVED`. The harness checks the explicit native cancellation code, the marker exchange, the verified fixture and job identities, the latched synthetic fault, the empty job, policy readback after cancellation, and independently verified removal. A run with unverified cleanup retains its stage.

## Scope

The test uses disposable pinned fixtures and a dynamic WFP lease. The service query is read-only. The synthetic fault exercises cancellation after detected health loss. Polling service status can miss changes between samples, and an unchanged service PID cannot establish that enforcement survived a BFE interruption. Actual BFE interruption, exact filter-event attribution, and qualification of the production supervisor remain open. Diagnostic receipts retain `proofAuthorization = false` and `bfeRestartQualified = false`.

Package and source checks were performed against the exact 05O Windows archive with 05P and 05Q applied. Native compilation and acceptance require the Windows diagnostic run.
