# CLU-E Patch 06B1 — WFP stage permission verification

Patch 06B stopped on an elevated Windows desktop during the temporary directory access check. The report recorded cleanup as `REMOVED`, MXC verification as `NOT_STARTED`, and no native fault result.

The previous check compared serialized access control lists byte for byte. Patch 06B1 compares the protected directory's actual access rules against the intended rules. It requires the exact allowed principals, rights and inheritance flags, with exactly one entry per expected principal. This tolerates representation differences such as entry order. Unexpected rules still block execution.

The report separates stage permission verification from MXC engine verification so a future refusal identifies the failing prerequisite. The WFP experiment and production qualification boundary are defined in Patch 06B.
