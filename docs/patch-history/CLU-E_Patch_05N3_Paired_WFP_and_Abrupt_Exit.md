# CLU-E Patch 05N3 — Paired WFP binds and abrupt exit

## Why

05N2 installed and read back all six temporary filters at weight 65534. The filtered workload failed in four socket tests and cleanup passed after normal exit and deadline. The control and filtered workloads had different AppContainer identities. The TCP test used listener setup, which left the precise failing operation uncertain. The report recorded zero matching Windows drop events.

## Changes

- The WFP launcher builds a separate diagnostic controller and a hash-pinned fixture in a disposable stage. It reuses the existing verified MXC x64 executable, ProcessContainer policy, native job, package identity validation and six-filter WFP lease.
- One fixture process uses fresh sockets for direct IPv4 and IPv6 TCP and UDP binds. The controller retains the exact process handle, verifies its image, AppContainer SID and job membership, and gates the three rounds before installation, after readback and after independent verification of removal. The fixture records native return codes.
- The filtered round records any matching BFE drop events. Where needed, the launcher queries already recorded Security event 5159 within the filtered round's window. The report separates paired causality from exact Windows filter attribution.
- A separate disposable fixture starts a child and grandchild. Each must report access denied for all four direct binds under the verified package policy before an outside observer terminates the exact diagnostic supervisor. The observer holds process handles and independently queries the six filter IDs and sublayer. It reports only the ordering it can distinguish and records any observed successful bind markers.
- The launcher writes a single external JSON and leaves production proof gated with `proofAuthorization: false`. Existing event collection and audit settings are used as configured.

## Acceptance

- `wfpPaired.state: PAIRED_BIND_CAUSALITY_OBSERVED` requires four zero codes before and after and four 10013 codes during filtering, plus retained identity, verified removal and an empty job.
- `wfpAttribution.state: ALL_BIND_DROPS_ATTRIBUTED` requires matching filter events for all four binds. When matching telemetry is absent, attribution remains open.
- `wfpCrash.state: CRASH_CLEANUP_ORDER_OBSERVED` requires an observation of all three tracked fixture processes exited while all filters were still present, followed by verified filter removal and supervisor exit. If transitions fall in the same sampling gap, ordering remains unresolved. This is evidence about three disposable processes on this host. Production still requires an enforceable cleanup order for the entire job.

## Validation

The package was checked against the deployed 05N, 05N1 and 05N2 file hashes. The native compilation, MXC startup, event delivery and forced-exit observations require the Windows run.
