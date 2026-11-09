# CLU-E Patch 06K — Combined production network fault evidence

## Purpose

06J1 verified independent TCP connections between the Windows host and a disposable same-PC guest. 06K uses that endpoint to measure containment during primary guardian loss on the exact supervisor image that passed admission and native qualification. One launcher runs all three stages and writes a linked evidence bundle.

## Changes

- Add `CLUE-Windows-Production-Network-Fault.bat` for the combined run. Setup builds one protected production supervisor, keeps the registration alive for all stages, and binds the exact admission and seven-canary reports by SHA-256.
- Add an explicitly selected diagnostic lane to the supervisor build. The lane pins the harmless Node fixture, accepts only its exact request shape, and checks the live job and independent backup rules before releasing the post-loss sample. Regular production workloads keep their existing drain behavior.
- Start a fresh Windows Sandbox peer. Host loopback and guest controls run before, during, and after the injected fault. The fixture gets a separate nonce so a leaked probe cannot satisfy the independent controls. Record raw socket outcomes, native policy readback, job drain, policy removal, and exact Sandbox cleanup.
- Preserve the existing production qualification gate. The bundle carries `proofAuthorization: false` and `qualificationPromotion: false`.

## Scope and dependencies

Requires the current 06G3A supervisor setup lineage, the installed 05U Windows Sandbox host preflight, and a Windows host where 06J1 can reach the peer. The ZIP installer pins the seven replaced files to the released 06G2, 06G3 and 06G3A bytes. It commits the verified patch paths locally.

The fault is deliberate loss of one primary policy owner while BFE is healthy. TCP coverage is IPv4 on host loopback and the same-PC virtual switch. The bundle records physical off-host LAN as `NOT_TESTED`. Refused and unreachable outbound outcomes are preserved as observed no-delivery results under positive controls. The native readback records the exact rule sets independently.

## Acceptance

Review the combined report for matching supervisor and receipt hashes, admission, seven passing native canaries, active and backup-only observations on the same live job, recovery, and verified teardown. Use the report to decide whether it can contribute to a separately reviewed production qualification receipt.
