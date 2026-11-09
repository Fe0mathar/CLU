# CLU-E Patch 06L — Reviewed Windows production release

## Basis

The 06K combined run on November 9, 2026 observed production network containment under primary guardian loss for supervisor `f4fb6034fc446b0ffe20383feaf0704e9aa156d6d31e6dd41bc8d21d86daf59c`. The same native job remained under the independent backup rules during the fault sample. All six active and all six post-loss socket probes returned access denied. Host and guest control connections passed at every stage, with zero probe deliveries and verified job, rule, guest and staging cleanup.

## Changes

- Add a launcher for the exact 06K result and its two companion reports. It verifies the byte pins, native observations, production admission and seven native canaries before asking the operator to approve the declared scope.
- Emit a local V2 production qualification receipt with the nine passing cases and original host and installed image binding. The receipt links the three source evidence digests and the reviewed Git commit.
- Reuse the protected image and start a fresh production registration. The release gate receives the exact image and receipt pins, runs from a clean detached checkout of committed Git HEAD, and writes a launcher outcome beside the external evidence directory's release files.

## Scope

The approval covers a single primary guardian loss with BFE running. Network coverage uses host and confined loopback and the independent same-PC virtual IPv4 TCP peer. Off-host physical LAN is recorded as untested. Passing the formal packaging and integration gates is separate from live P2 proof and measurement parity.
