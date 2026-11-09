# CLU-E Patch 06I1 — Production qualification receipt compatibility

## Predecessor

The 06I installer reported the installed `windowsSupervisorQualification.ts` SHA-256 as `abfa04aa42624386b01b13f682a93b4100eba5239ee39ad86f0b6ec23861c5a3`. That matches the exact Patch 05T source. The earlier 06I package used the 05I source as its base. Its installer stopped before applying changes to the 05T checkout.

## Change

Apply the Windows receipt metadata fix directly to the 05T verifier. The reader accepts an unset path volume serial when the matching file identifier is nonzero. It keeps the stable path and handle comparisons, link count and size limits, canonical path check, exact SHA-256 pin, and host and installed image bindings.

The production receipt schema remains `clue-windows-supervisor-production-qualification/2`. The verifier still requires explicit production authorization, cleanup, and all nine required cases, including `production-request-admission` and `network-boundary-fault`. The 06G3A V1 report with seven canaries is diagnostic evidence and remains ineligible for production authorization.

## Outstanding evidence

Retain the matching 06G3A production admission report for the qualified supervisor. Complete the declared network fault test on the exact production configuration and review its controlled endpoint and cleanup evidence before issuing a V2 receipt and running the gated release.
