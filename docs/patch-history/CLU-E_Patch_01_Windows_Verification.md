# CLU-E Patch 01 — Windows verification

**Date** 7 November 2026  
**Prerequisite** Cleaned Batch 8 `CLU.zip` with dependencies installed using `npm.cmd ci`.  
**Baseline ZIP SHA-256** `812394bbda741505c58afa41d06b58eb72365b80a5a6f5599cdf3b366538166c`

## What changed and why

The verification scripts launch npm’s JavaScript entry point through Node on Windows. This fixes direct `npm.cmd` spawning. Preflight now fails when Windows or a required host tool is unavailable, and records separate tool diagnostics. Fresh verification reports go to an external directory. A migration report without `--output` prints JSON to the terminal so the sealed report at the project root stays intact.

## File inventory

| Project-relative file | Change | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `tools/verification-support.mjs` | Resolve the npm CLI through Node on Windows and validate and atomically write external report files. | `Added` | `63dacde0eb0b1838b4e7e0ce242127cb3801b905ecad082b78e2bbe1a19482fa` |
| `tools/p2-closure-preflight.mjs` | Make Windows, host tool, version, path and active-seal failures explicit blockers. | `35ac4c3d01a1dbc1b8906fccfd6f4c6fc9bf6416916ac32c05f85c670fce6784` | `c3a08d5c173154f19bf2a65a73df114d8e18ae4a103713da00bf9e3df41306ed` |
| `tools/project-profiles-acceptance.mjs` | Use the npm launcher for the full matrix and surface the failing step diagnostic. | `44d3006c933e9c72a9b37945727f1fc58e7d1df79b0fb94b8b60d7c0d5b42771` | `8a876e8d850150769e93c153d68d3f9dd35fb0f6c3330c98a3e54919f2b79fac` |
| `tools/project-profiles-migration-report.mjs` | Emit JSON to stdout by default and protect sealed Project Profiles reports. | `63c4f6b674fc496a9a66217c4f829e15da830cd07f40b9a7ac9fc316151ba591` | `8562304604dba774d74c16bbea04e826f55ded5e36815239a4260a949e76d824` |
| `tools/p2-closure-inventory.mjs` | Require all four inventory outputs to resolve outside the project. | `73e149f202cbd76f2fd86907f9924c8afd847fd2ac764822757b0f03cce04bc6` | `7071fdae7c2bfb6690723d2e7a8cec74627946d671e4626366c8292c806b381d` |
| `selftest/windows-verification-tools.test.ts` | Exercise the Windows npm invocation contract, output containment and sealed-report preservation. | `Added` | `25f6cedca9f4445e8b8623c4803c0e808eceecf06052a9ff1e07e559e0541954` |

This manifest is an added file. Its own hash is excluded from its table.

## Apply and verify

Compare the four replacement files with their before hashes if the local tree has edits. Extract the ZIP contents into `F:\CLU\CLU`, allowing those four files to be replaced. Run the following from that folder in Windows PowerShell.

```powershell
$evidence = 'F:\CLU\release-evidence\Patch01'
npm.cmd run project-profiles:acceptance -- --full --output "$evidence\PROJECT_PROFILES_ACCEPTANCE_REPORT.json"
npm.cmd run p2:closure-preflight -- --output "$evidence\P2_CLOSURE_PREFLIGHT.json"
```

The acceptance command should complete the npm-driven checks. Preflight returns exit 1 and writes a report if a required tool, directory, credential reference, or other prerequisite is missing. Its ready result permits live runtime verification. The live provider and Windows acceptance evidence are separate.

## Verification recorded

- Fresh TypeScript typecheck and build passed on Linux.
- The three Patch 01 regression tests and ten documentation and acceptance-matrix tests passed.
- The complete portable Project Profiles acceptance runner passed, with its native-only subset explicitly skipped. Both documentation seals passed.
- Linux preflight reported the unsupported host, unavailable PowerShell and absent credential. The inventory and migration commands wrote reports to an external directory.
- Run the native checks above to verify the actual Windows npm, PowerShell and SQLite installation.

## Rollback and next step

Restore the four replaced files from the cleaned Batch 8 baseline. Remove the two added code/test files and this manifest. Preserve the external reports as evidence of the attempt.

Once Windows qualification for this patch is recorded, continue with **Patch 02 — Exact proof inputs**.
