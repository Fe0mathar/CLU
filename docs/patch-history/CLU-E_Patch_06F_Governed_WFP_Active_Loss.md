# CLU-E Patch 06F

## Starting evidence

The 06E1 Windows report `CLU-E_WINDOWS_GOVERNED_WFP_OWNER_LOSS_20261108-221342-211-e33d406f.json` verified primary guardian exit, exact Node exit, job drain, and WFP removal with the direct npm release gate closed.

## Changes

- Add an explicitly selected active-loss diagnostic on the installed broker path. Launch a pinned Node loopback canary in the verified AppContainer job while the primary guardian and a separate backup owner both hold verified leases.
- Verify the live canary returns access denied on four bind lanes before deliberately terminating the primary guardian. Verify exact primary rule removal and the surviving backup lease, then repeat the four checks in the same Node process.
- Stop and drain the exact job. The backup checks that its policy is present at drain, then verifies removal of both leases. If the supervisor disappears or drain fails, the backup can terminate only the exact job it holds. A verified normal sequence and unchanged prepared inputs are required to pass.
- Use a dedicated canary gate. The direct npm release gate stays closed, and the pinned canary has no path into project code. The existing preparatory governed npm run and baseline deep doctor remain separate checks.

## Acceptance scope

A passing report returns `GOVERNED_WFP_ACTIVE_LOSS_OBSERVED`. This diagnostic tests a live fixed canary during primary guardian loss on one Windows PC. Simultaneous owner loss, BFE restart, off-host LAN behavior, and production proof authorization remain separate evidence items.
