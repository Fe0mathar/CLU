# CLU-E Patch 06B3 — Distinct WFP sublayer priorities

The 06B2 Windows report verified the retained run's cleanup and cleared the fresh stage. The fresh run reached the helper's WFP install step. Both leases requested priority 65534, and the helper's sublayer read back as 65533. The exact readback check stopped the experiment before fault injection.

06B3 assigns 65534 to the owner selected for termination and 65533 to the backup. This tests the workload after the higher-priority owner is gone and the lower-priority backup remains. The test verifies the role-specific priority at installation and in a fresh observation alongside the existing identity, filter, bind and cleanup checks. Expected and observed values appear in the report.

Apply using `APPLY-06B3.bat`. Run `CLUE-Windows-WFP-Enforcement-Fault.bat` as administrator and submit the newest `CLU-E_WINDOWS_WFP_ENFORCEMENT_FAULT_*.json`. A passing result qualifies the scoped owner-loss experiment. Production qualification remains separate.
