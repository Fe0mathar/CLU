# CLU-E Patch 05N4 — Windows guardian diagnostic

## Why

05N3 demonstrated direct bind success, access denied and success again for IPv4 and IPv6 over TCP and UDP in the same verified sandbox process. Exact Windows event attribution remained open. After abrupt supervisor termination, the observer verified the processes and filters were gone. Two samples left their order unresolved.

## Changes

- The abrupt-exit scenario starts a separate diagnostic guardian. The guardian owns the native Windows job and the dynamic package-scoped WFP lease. The outer diagnostic supervisor serves as the process the observer terminates.
- The guardian watches a retained handle to that supervisor. On loss, it initiates termination of the whole job and waits for native job accounting to report zero active processes. It publishes a private marker while the WFP lease is still held.
- An independent observer verifies that the supervisor and all three tracked fixtures have exited, the guardian is live, and all six filters and the sublayer are present. It publishes a private acknowledgement. The guardian consumes that acknowledgement, releases the filters, and records its own removal check. The observer independently verifies policy removal and guardian exit.
- If the acknowledgement is absent, the guardian may clean up after it has verified the job is empty. That run cannot satisfy the ordering acceptance criterion. The launcher retains a disposable stage when guardian completion cannot be verified.
- The paired test still checks direct binds and matches any existing BFE or Security events to exact filter IDs. The report now includes a read-only snapshot of the Windows system failure-audit setting for Filtering Platform Connection. System audit policy provides context. Exact matching events remain the attribution criterion.

## Acceptance

- `wfpPaired.state` remains `PAIRED_BIND_CAUSALITY_OBSERVED`.
- `wfpCrash.state` is `GUARDIAN_CLEANUP_ORDER_OBSERVED` only when the independent observer and guardian both supply the ordered evidence. Unavailable escape markers, missing acknowledgements and incomplete cleanup withhold acceptance.
- `wfpAttribution.state` is assessed independently. `ALL_BIND_DROPS_ATTRIBUTED` requires four matching Windows events.
- The result covers supervisor loss in a disposable test. Loss of the guardian itself remains unqualified. Production proof remains gated with `proofAuthorization: false`.

## Validation

Static interface, ordering and scope checks, the archive manifest, and a clean Git overlay were verified. Windows compilation, job and filter lifetime, and audit delivery require native validation.

- [Windows Filtering Platform object lifetime](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)
- [Windows job termination](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
- [Windows system audit policy query](https://learn.microsoft.com/en-us/windows/win32/api/ntsecapi/nf-ntsecapi-auditquerysystempolicy)
