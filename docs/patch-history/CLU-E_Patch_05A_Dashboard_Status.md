# CLU-E Patch 05A — Dashboard Status

**Date** 7 November 2026  
**Prerequisite** Cleaned Batch 8 `CLU.zip` with Patches 01–05 applied.  
**Patch 05 ZIP SHA-256** `6c25ccb7d2e77656f7bf63b0011354b485e4dfb115cb1820be9c8bd51498758b`

## Finding and correction

The original acceptance probe expected every supported Status branch to be populated in every capture.
The supplied report had three explicitly unavailable branches and a valid, consistent Status seal.
The focused probe now checks the declaration against the branches populated in that capture and retries
frame comparison before treating moving revisions as inconclusive.

A local probe using the actual dashboard wiring, Status store and quadrant controllers reproduced all
four labels in the supplied report. Q1, Q2 and Q4 sent structured branches to a scalar reader and
displayed `malformed`. Q3 asked for `golden`, a branch absent from the wire schema.
The corrected panels use `repositoryInventory`, `improvementField`, `gauges` and
`operationalConsole`. Their accessible labels use counts and preserve explicit absence reasons.

## Apply and verify

1. Stop the dashboard. Extract the ZIP contents directly into `F:\CLU\CLU` and allow replacements.
2. Run `npm.cmd run dashboard:verify` from the project directory, then restart the dashboard and refresh its browser tab.
3. Open **Configuration** and wait for its controls to load. In the dashboard Console, paste the entire contents of `tools/dashboard-status-probe.js` and run it once.
4. Send back `CLU-E_Status_Navigator_<timestamp>.json`. Expect the Status seal and branch-inventory checks to pass, and each quadrant to agree with its declared Status branch. A stable frame is required to compare the four projection bodies.

The local pre/post fixture reproduced the reported defect and verified the correction. The full dashboard
test suite passed 170 tests. Live acceptance is due on the Windows installation. The Navigator section
keeps physical inventory and semantic recognition separate. It records Gate 38 as pending whenever the
backend has no comparison.

**Next patch** Analyze the focused JSON before deciding the scope of Patch 05B. Regenerate the release archive from the final clean source once the accepted corrections are applied.

## Rollback

Restore the replaced files from the cleaned Batch 8 plus Patches 01–05. Remove the added entries and
this manifest, then restart and refresh the dashboard.

## File inventory

| Project-relative file | Purpose | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `tools/dashboard-status-probe.js` | Run the focused read-only dashboard check and download the Status and Navigator evidence. | Added | `6f5f28fc4bad3d6b02964a4640ca5a06a97fc533a1ec2494d66080055d68901c` |
| `ui/clue-dashboard/app.js` | Mount the Status presentation in the normal dashboard entry point. | `d2159b34a3f8f3ce66ef4e01f809816ed44bcb2ee434afd4a3872eb7a4243789` | `19cec3e14f9a214eed44ba0642101d16ae0f6541e03d60e56ff181e9c318520f` |
| `ui/clue-dashboard/components/branchPresentation.js` | Render explicit wire-level unknown with its reason. | `e1eb6d8b6ebe2049597440be7eff22df2affc6fb96393e52db7eb2f2c4dd2360` | `05da12f6dbc73c27a5ae5589f4c47e595153c50f660f009833e650a5167633ab` |
| `ui/clue-dashboard/quadrants/statusPresentation.js` | Map the four quadrants to their real Status branches and accessible labels. | Added | `1ac8c5a687e36e6af6012d35cd2fd76ec7c200600f4b11fec0e31b6a85855451` |
| `ui/clue-dashboard/test/quadrantStatus.test.mjs` | Check populated, empty, unavailable, unknown and malformed branches through the live store/controller wiring. | Added | `62240e8aa7b800caf1e682aa6fa9d4295d5c54f5a2faeeb13278e21316a59024` |
| `ui/clue-dashboard/test/shellMarkup.test.mjs` | Check the dashboard entry point actually mounts the adapter. | `c3cc3a9099829b634e571153bf203cf49478342129be3032fbfaf382dc937a5c` | `0823102e48e0a5c8f7f576718eca6ba6b3e050190a16bcff7b538bddd9d8b574` |

This manifest is an added file. Its own hash is excluded from the table.
