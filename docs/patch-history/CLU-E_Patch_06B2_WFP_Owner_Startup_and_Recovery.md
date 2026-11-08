# CLU-E Patch 06B2 — WFP owner startup and retained-run recovery

The 06B1 Windows run verified the protected stage, the MXC binary and the original workload. All four baseline binds succeeded. The second WFP lease process started but returned no ready receipt. The controller reported `WFP_FAULT_OWNER_NOT_READY`, a state that combined early exit and timeout. The workload job and backup policy were removed. Setup retained the protected stage because the second owner's exact filter keys were unavailable.

06B2 adds a read-only reconciliation path for that specific legacy failure. It checks the original protected records and the exact named job, checks for live staged executables, and enumerates WFP sessions and sublayers for the diagnostic's known labels. It checks exact legacy keys when a valid ready receipt exists. A refusal or incomplete check blocks the fresh test. The historical stage stays available, and its reconciliation has its own evidence fields.

For fresh tests, the controller records the helper's exact sublayer and filter keys before starting it. The helper reports bounded startup milestones and error information. The controller distinguishes early exit from readiness timeout and can verify exact key absence after an early exit. A fresh passing result still requires the controlled owner termination, live workload denial in all four lanes, and verified cleanup. The report carries no production proof authorization.

Apply using `APPLY-06B2.bat`, then run `CLUE-Windows-WFP-Enforcement-Fault.bat` as administrator. Submit the newest `CLU-E_WINDOWS_WFP_ENFORCEMENT_FAULT_*.json`.
