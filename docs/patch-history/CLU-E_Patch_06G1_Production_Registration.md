# CLU-E Patch 06G1

## Observed failure

The 06G Windows report `CLU-E_WINDOWS_PRODUCTION_ADMISSION_20261108-225222-584-b638b2f0.json` verified the installed pair, the full baseline WFP lifecycle, and the network opt-out, environment, and root overlap refusals. The candidate stopped in `PRODUCTION_SESSION` before a WFP receipt or workload marker appeared. The npm case remained unrun and the diagnostic stage was retained.

## Changes

- Require the standard supervisor to receive the full registration `READY` line and return `ACK` before the elevated server disconnects. Windows can discard unread bytes on disconnect.
- Have the elevated server record acknowledgement in the exact protected run directory. The standard supervisor verifies that marker before proceeding to the guarded workload. All transport waits are bounded.
- Record bounded registration codes and exception sites in the diagnostic report. Refresh the protected source pins.

Run the same production admission diagnostic on Windows. A pass requires baseline, candidate, npm typecheck, exact policy cleanup, and `PRODUCTION_ADMISSION_OBSERVED`. The separate seven-case qualification still follows.
