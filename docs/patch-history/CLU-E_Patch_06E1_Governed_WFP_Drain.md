# CLU-E Patch 06E1

## Observed failure

The 06E Windows report `CLU-E_WINDOWS_GOVERNED_WFP_OWNER_LOSS_20261108-220801-045-1d459b91.json` verified the original guardian's diagnostic exit, an empty Job Object, and a withheld release gate. The immediate zero-time wait did not confirm that the already-open Node process handle was signaled. This stopped the wrapper before it read the protected WFP cleanup marker.

## Changes

- Wait up to five seconds for the retained Node process handle after the job reports zero active processes. Require the handle to signal. Keep timeout and native wait error distinct.
- Verify the protected WFP cleanup marker independently of the Node wait result. Require both results for a pass.
- Keep the guardian-loss event and the drain error in distinct fields in the owner-loss report. Update the canonical native and elevated builder pins.

The test still verifies loss before the direct npm typecheck is released. The report must show `GOVERNED_WFP_OWNER_LOSS_OBSERVED` with both exact process exit and WFP removal verified. The diagnostic carries no production proof authorization.
