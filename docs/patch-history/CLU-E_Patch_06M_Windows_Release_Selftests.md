# CLU-E Patch 06M — Windows release selftests

The 06L Windows rerun for commit `c829b353b622243d6401c1407584d8624cf03eba` built the source and extracted package and verified all 796 archived files. The selftest stage failed 31 of 911 tests and ended the gate before Project Profiles acceptance, native proof assessment and P0.

## Windows selftest fixes

- Compare serialized profile paths in their storage format and live runtime paths in native form. Close the Project Profile runtimes, event logs and SQLite stores before removing their fixture directories.
- Verify direct Node project entry points and retain Node's normal launch semantics. For a verified entry whose ordinary JavaScript path walk fails with access denied in the Windows boundary, select the fixed loader flags already used for that failure class. Keep the exact supervisor and qualification checks, original execution roots, job containment and network denial.
- Surface bounded proof fixture output on failure. The 06L log showed four install failures at direct Node entry points, including scripts that simply exit successfully. The specific path-walk error is a diagnosis based on that pattern and prior Windows evidence. The Windows rerun will verify it.

Apply the patch before rerunning the existing 06L launcher against the newly committed source. Inspect the launcher result, final release report and gates log for the verdict.
