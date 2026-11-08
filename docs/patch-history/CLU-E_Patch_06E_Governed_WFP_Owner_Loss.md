# CLU-E Patch 06E

## Starting evidence

The 06D1 Windows report `CLU-E_WINDOWS_GOVERNED_WFP_20261108-215640-520-e905cb8a.json` returned `GOVERNED_WFP_WORKLOAD_OBSERVED`. The installed broker candidate typecheck ran with an authenticated guardian and a verified WFP lease. Its four loopback controls succeeded before arming and were denied with Winsock 10013 after arming. The job drained, lease removal was verified, and the disposable stage was removed.

## Changes

- Add an explicit owner-loss launcher and operator confirmation on the same Windows PC. Its protected, run-bound native image pins the fault mode at compile time.
- Run the installed broker candidate to its existing admission gate. Verify the same job, Node process and package identity, four successful controls, four denied armed binds and exact lease readback. Keep the release gate closed.
- Ask only the authenticated guardian to exit abruptly with the diagnostic exit code. Journal its exact sublayer and filter keys in the protected run directory. The standard supervisor observes guardian loss through its existing peer checks and terminates and drains its own Job Object.
- Have the elevated builder observe that exact guardian process exit. Launch an independent read-only verifier from the same protected image and confirm that the journaled WFP objects are absent. The wrapper also requires original Node exit and absence of the release gate.
- Record a separate expected-refusal result. Check that the candidate inputs and build outputs match the pre-fault values. Only verified cleanup authorizes removal of the disposable stage. The protected images and key journal are retained for audit.

## Acceptance scope

A passing report returns `GOVERNED_WFP_OWNER_LOSS_OBSERVED`. This verifies loss at the admission gate of the direct typecheck. The preparatory governed npm run is a separate check. Mid-command loss, off-host LAN, and BFE restart remain separate evidence items. The diagnostic records `proofAuthorization: false`.
