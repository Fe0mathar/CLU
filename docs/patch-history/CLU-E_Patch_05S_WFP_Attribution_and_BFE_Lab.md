# CLU-E Patch 05S — WFP attribution and BFE interruption lab

## Starting evidence

The 05R Windows report observed cancellation after a synthetic BFE process change. It recorded 15 status samples, verified the empty job, and independently verified filter removal. The 05Q static loss and host-loopback cases passed again. The paired bind outcomes were allow, deny, allow across IPv4 and IPv6 TCP and UDP. The Windows Security log had no corresponding bind events in that run.

## Exact bind attribution

The paired test now reads the live ALE resource-assignment layer IDs and uses the PID of the fixture it pins and verifies in the job. The Security query captures a pre-run record watermark. A match requires Windows event 5159 from the Security channel, a newer record in the bounded time window, the pinned fixture PID, the exact runtime layer and filter IDs, the expected protocol, and the loopback address. It reports aggregate counts and lane coverage. The pre-existing WFP event tally remains a separate source of evidence. [Microsoft Security event 5159](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-5159)

The standard diagnostic reads current policy and existing events. If `wfpAttribution.exactState` stays `BIND_DENIED_EXACT_ATTRIBUTION_UNPROVEN`, check the accompanying `systemAudit` and `security` states. For a controlled repeat, an operator can enable failure auditing in the checkpointed lab guest. Use an elevated Command Prompt **inside that guest** and run the standard diagnostic again. [Microsoft audit policy command](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/auditpol-set)

```bat
"%SystemRoot%\System32\auditpol.exe" /set /subcategory:{0CCE9226-69AE-11D9-BED3-505054503030} /failure:enable
```

## Optional real BFE interruption lab

Use a disposable Hyper-V Windows 11 x64 guest. While preparing the guest, install the same CLU-E dependencies and verify MXC with the existing setup under the guest account that will run the diagnostic. Use a separate CLU-E copy and no production credentials. Remove the guest's virtual network adapters in Hyper-V, disable guest sharing or host-drive redirection, and take a checkpoint. Use the VM console for the test. The lab launcher checks the guest identity and adapter status and requires explicit confirmation. The Hyper-V host configuration establishes the offline boundary.

1. Apply 05S to the lab copy. In the guest, open a second elevated Command Prompt and prepare the stop command below. Leave it unexecuted.
2. Run **CLUE-Windows-WFP-BFE-Lab.bat** as administrator in the guest and type `DISPOSABLE OFFLINE HYPER-V GUEST`. The standard canaries run first. When the lab prints **READY**, execute the stop command in the guest's second window. The native fixture has a 25-second deadline from launch, so be ready to switch windows.
3. When the lab reports **STOPPED**, execute the start command in the guest. Let the diagnostic finish and export the resulting JSON. Keep the retained stage if requested, then revert the guest checkpoint after collecting evidence.

```bat
"%SystemRoot%\System32\sc.exe" stop BFE
"%SystemRoot%\System32\sc.exe" start BFE
```

If the service manager rejects the stop, let the diagnostic finish and return its report plus the stop error. Running dependent services can block a service stop. The experiment uses the normal service manager stop request and treats refusal as a blocked test. [Microsoft service stop behavior](https://learn.microsoft.com/en-us/windows/win32/services/stopping-a-service)

The expected result is `wfpBfeLab.state = BFE_LAB_CANCELLATION_OBSERVED`. It requires the harness to observe BFE stopped then running, the native watcher to latch a real health fault, the job to become empty, and a fresh WFP session to verify that the recorded sublayer and filters are absent after recovery. The pinned fixture repeatedly attempts loopback binds, and an observed successful bind produces `BFE_LAB_ESCAPE_OBSERVED`. A run with no observed escape establishes only the sampled result. A bind between samples or a bind whose process was terminated before publishing its marker can go unobserved.

## Release boundary

Microsoft documents that static WFP objects disappear when BFE stops. The lab uses the existing dynamic fixture lease to measure cancellation and cleanup across a real service transition. Continuous enforcement and qualification of the exact production supervisor require separate evidence. The diagnostic keeps `proofAuthorization` and `bfeRestartQualified` false. [Microsoft WFP object lifetimes](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)

Source and package checks were performed against the exact 05R predecessor. Windows compilation, Security event availability, and the live guest test require execution on Windows.
