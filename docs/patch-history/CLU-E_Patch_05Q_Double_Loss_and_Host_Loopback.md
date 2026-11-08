# CLU-E Patch 05Q — Double loss and host loopback

## Why

05P verified on the target Windows host that all seven recorded job members exited after guardian termination while the six static WFP filters and sublayer were still present. Scoped recovery verified the named job was absent and removed the recorded policy. Two further questions remained. Would recovery still work after loss of both the coordinator and guardian? Does the MXC boundary deny host loopback in both directions independently of the package-scoped filters used for intra-sandbox loopback?

## Changes

- A new disposable double-loss case starts its own guardian, named job, and static filter set. The observer terminates the verified supervisor and waits for its retained process handle to signal. Before terminating the guardian, it independently checks that the guardian, all tracked job members, and the exact filters are still present.
- The double-loss guardian keeps the admitted disposable workload under its original deadline while the observer verifies the first death. After the second death, scoped recovery checks the recorded process identities and specific job absence, then removes the six filters and their sublayer. The observer independently verifies their absence.
- A separate MXC case uses the base host-network denial policy. A pinned host process and a pinned, identity-verified sandbox process open live loopback listeners. They attempt token exchanges in both directions for IPv4 TCP, IPv6 TCP, IPv4 UDP and IPv6 UDP. Host-side controls check each protocol and address family. The report records sender and receiver evidence separately and includes bounded fixture error codes when available. A missing or unverified fixture cannot support isolation acceptance.
- The launcher retains the 05P paired bind, supervisor-loss, and guardian-loss cases. It keeps distinct recovery intents for the two static cases and skips later cases when earlier cleanup is unverified.

## Acceptance

- `wfpStaticDoubleLoss.state = STATIC_DOUBLE_LOSS_AND_RECOVERY_OBSERVED` requires both deaths in order, the exit of every observed job member, retained static policy, the recovery receipt, and independent verification of removal.
- `wfpHostLoopback.state = HOST_LOOPBACK_ISOLATION_OBSERVED` requires the verified sandbox identity and job cleanup, all four passing host controls, both complete fixture records, and no observed token delivery in either direction in all four cases. The per-case socket outcome distinguishes access denied, connection failure, timeout, and unverified outcomes.
- These checks address the two specified disposable scenarios. BFE restart, exact per-filter attribution and production qualification remain separate. The report keeps `guardianLossQualified` and `proofAuthorization` false.

## Validation

Verified source interfaces, marker sequence, installer allowlist and exact predecessor hashes. Native compilation and the Windows runs remain to be confirmed.

- [MXC ProcessContainer networking](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/networking.md)
- [Windows process termination](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)
- [WFP object lifetime](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)
