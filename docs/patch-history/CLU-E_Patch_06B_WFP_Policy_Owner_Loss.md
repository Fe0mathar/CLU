# CLU-E Patch 06B — WFP policy owner loss

## Why

Patch 06A demonstrated real Windows broker requests for npm typecheck and CLU-E deep verification. The network fault evidence needs to distinguish policy enforcement on a live workload from loss of access caused by workload termination. The existing steady-state host loopback diagnostic and guardian loss checks answer different questions.

## What changed

- Add a separate Windows diagnostic for abrupt termination of one CLU-E-owned dynamic Windows Filtering Platform session owner. It uses the verified installed Microsoft MXC executable and diagnostic binaries compiled from pinned sources in a protected external stage.
- Run one disposable AppContainer fixture in a named Windows job. Obtain positive loopback bind controls for IPv4 TCP, IPv4 UDP, IPv6 TCP and IPv6 UDP before arming the WFP policies.
- Verify two separate sets of exact WFP filters for the fixture identity. End the owner process for one set, verify that its filters are absent, and verify the surviving set. Repeat the four bind attempts with the original fixture alive in the job and require access denied.
- Sample Base Filtering Engine service state and process identity and verify the job and both policy sets are gone before declaring successful cleanup.
- Include the diagnostic launcher in the exact release source bundle.

## How to run

Apply the ZIP using `APPLY-06B.bat`. Run `CLUE-Windows-WFP-Enforcement-Fault.bat` from the checkout as administrator. The report appears in the configured external evidence directory as `CLU-E_WINDOWS_WFP_ENFORCEMENT_FAULT_*.json`. The runner can execute on the normal Windows PC. It terminates its own test helper and keeps the shared Base Filtering Engine service running.

## Acceptance boundary

The report covers one WFP session owner exiting with Base Filtering Engine observed running under the same PID at the sampled checkpoints. Its socket evidence concerns confined loopback binds during that fault. Packet delivery to the host, an off-host LAN peer, and loss of Base Filtering Engine are outside this experiment. The diagnostic records `proofAuthorization: false`. Qualification of the installed production supervisor and a governed end-to-end proof run remain separate release steps.
