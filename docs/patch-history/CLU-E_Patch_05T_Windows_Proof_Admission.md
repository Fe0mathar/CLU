# CLU-E Patch 05T — Windows proof admission

## Why

The 05S development-host report confirmed paired bind denials, bidirectional loopback isolation, guardian-loss recovery, and cancellation after a simulated BFE fault. The Security query found no exact filter events, and the live BFE lab had yet to run.

The Windows launcher also had an independent admission gap. A seven-canary fixture report could be pinned as proof authority, even though the bundled supervisor's request parser accepts only its pinned qualification fixtures. That could advertise readiness for real proof requests the installed executable would refuse.

## Changes

- The fixture runner labels its output `FIXTURE_DIAGNOSTIC` and sets `proofAuthorization` to `false`. A successful run uses `FIXTURE_CANARIES_PASSED`.
- Windows Setup validates independently supplied production receipts. Running the optional fixture suite prints its report location and leaves admission tied to the separately supplied production receipt.
- The shared verifier used by Windows Setup, closure preflight, and proof execution rejects legacy fixture receipts and explicit diagnostic authorization. It requires the new `clue-windows-supervisor-production-qualification/2` receipt with explicit production scope and authorization, exact binary and receipt pins, host and Node identity, cleanup, and nine passing pre-proof cases.
- The two added cases cover actual broker-shaped request admission and network containment during the declared enforcement fault. The Windows readiness report identifies production qualification as the pending step.

## Acceptance and remaining work

Tests cover rejection of passing legacy fixtures, nested diagnostic output, missing or false authorization, missing production cases, and mismatched host and executable identity. The version 2 contract keeps measurement parity as part of the later proof run.

Producing a version 2 receipt requires the actual production supervisor and reviewed native evidence. The bundled fixture runner produces version 1 diagnostic reports. The production Windows boundary, live Windows qualification, and the first end-to-end proof cycle remain release work.
