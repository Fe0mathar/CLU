# CLU-E Patch 05Z1 — Deep verification receipt

05Z passed the locked offline install, typecheck, build, and native SQLite query on the regular Windows account. The read-only `clue init` and `clue doctor --deep` commands both exited successfully. The diagnostic returned `OUTPUT_UNVERIFIED` when it parsed the deep verification summary.

`EventLog.append` starts sequence numbering at zero. `EventLog.verify` counts records from one. A fresh chain can therefore report `head 0 (1 records verified)`. The 05Z parser required the head to be positive and equal to the number of records. 05Z1 requires a nonempty chain with `records = head + 1` and retains the requirement that the artifact counts agree.

The diagnostic records bounded counts from the CLI. The host independently checks the staged log sequence, mission registration, SQLite header, and prepared tree. It checks these after a settled baseline execution even when the CLI summary cannot be accepted. The expected state is `GOVERNED_WORKLOAD_OBSERVED`, with `proofAuthorization: false`.
