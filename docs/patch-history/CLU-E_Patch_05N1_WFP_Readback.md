# CLU-E Patch 05N1 — WFP readback and cleanup

**Applies to** the clean CLU-E checkout through Patch 05N.

The 05N Windows run observed the correct in-job AppContainer identity and reached the filter transaction. The combined sublayer readback check refused the filtered fixture. Its gate remained closed and the timeout trial was skipped.

- Check the documented sublayer persistence bit independently of other returned flags. Check the exact key, configured weight, and unassigned provider separately. An absent provider and an empty provider GUID represent the unassigned case in this diagnostic.
- Refuse disabled filters using the Windows SDK flag. Verify exact filter identity, block action, provider, single condition, and package SID. Report the failing field or returned numeric flags instead of a combined mismatch.
- After an attempted install fails, close the dynamic session and check the affected keys from an independent WFP session. Report the job-empty observation after terminating the fixture, including the failure path.

The initial unfiltered MXC control denied IPv4 and IPv6 TCP and timed out on IPv4 and IPv6 UDP. Filter installation, removal, and independent evidence of traffic attribution are separate checks. This diagnostic carries `proofAuthorization: false`.

## Apply and collect evidence

1. Extract the ZIP into a new empty folder outside `F:\CLU\CLU` and run **APPLY-05N1.bat** normally. It verifies the manifest and creates the local commit.
2. In the project directory, right-click **CLUE-Windows-WFP-Diagnostic.bat** and choose **Run as administrator**, using the same Windows account.
3. Send the newest `CLU-E_MXC_SUPERVISOR_DIAGNOSTIC_*.json` from `F:\CLU\release-evidence`.

The archive manifest records the 05N predecessor hashes and replacement hashes. Revert the local patch commit to roll back. Native compilation, readback, and the timeout trial require the Windows retry.

- [Microsoft WFP sublayer fields](https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_sublayer0)
- [Microsoft WFP filter fields](https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_filter0)
- [Microsoft WFP session lifetime](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)
