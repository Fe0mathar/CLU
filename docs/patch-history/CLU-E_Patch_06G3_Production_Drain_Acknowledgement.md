# CLU-E Patch 06G3 — Production drain acknowledgement

## Windows evidence

The 06H2 report `P2_WINDOWS_SUPERVISOR_QUALIFICATION_20261109-070953-948-582089680f3c42709e5e68198943b0bb.json` recorded six of seven required canaries passing against the exact 06G2 image. The deadline test observed both processes at 1,461 ms and verified that both exited. The native supervisor returned `125` after 5,124 ms with `Drain GOVERNED_WFP_GUARDIAN_PIPE_CLOSED`. The 7,000 ms outer watchdog did not fire. The request-side WFP record could not be verified by that qualifier. This places the failure in the drain exchange and leaves the precise elevated guardian cause unconfirmed.

## Change

- The production primary and backup independently confirm the exact job is empty and the retained Node process handle is signaled before acknowledging normal policy removal. Bounded rechecks accommodate transient differences between the two observations.
- The primary publishes a protected removal marker after both filter owners confirm removal. It sends the removal response and waits for the standard supervisor's acknowledgement. The supervisor verifies the protected acknowledgement before reporting a successful cleanup. The acknowledgement closes a delivery gap in the named-pipe exchange.
- A production guardian or backup failure leaves a bounded typed diagnostic in its protected run directory. The standard supervisor can include that diagnostic in the qualification report. Qualification also reports the stage of request-side WFP record validation when that record cannot be verified.
- The protected build pins the changed native sources. The launcher writes a new admission report and, on a verified pass, passes its exact hash, the installed image hash, and the current registration identity to the qualifier. Both reports are written outside the checkout.

## Verification on Windows

Run `CLUE-Windows-Proof-Supervisor.bat` from a regular Windows session after applying the patch. A qualification pass still requires all seven canaries and fixture cleanup. The deadline case requires native exit `124`, observed tree termination, and an idle outer watchdog. Formal proof and release checks are separate from this qualification.
