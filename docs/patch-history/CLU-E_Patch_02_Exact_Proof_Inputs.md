# CLU-E Patch 02 — Exact proof inputs

**Date** 7 November 2026  
**Prerequisite** Cleaned Batch 8 `CLU.zip` with Patch 01 applied and pinned dependencies installed.  
**Patch 01 ZIP SHA-256** `a4c3578274b3e750d5c55c141f7801acfab4dfec9aeeb4fbf5f52a8a0b8f0c20`

## What changed and why

The old benchmark recorder selected the latest snapshot after execution. The candidate runner then copied the live tree and derived an identity from the claimed snapshot and patch. That allowed changes outside the screened source roots to enter a candidate under the old identity.

Screening now saves a full project input manifest. The benchmark pins its source, configuration, mission, raw contract, compiled files, installed dependencies and Node executable. It checks the pinned subject again before recording. Proof reuses only a registered, eligible receipt matching the screened inputs and current executable state. The candidate is built from verified bytes and identified by its actual patched tree. Relocation and measured executable identities are recorded separately.

## File inventory

| Project-relative file | Purpose | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `src/analysis/source/snapshot.ts` | Share the existing generated-path exclusions with the proof patch validator. | `add7d6ab5977a027cc567cbf428201f9be646717d71e30d2ac45bfae45547ad6` | `d0695ea206474fb003a5a0fad1d9902aa701c7e47100d6472dea661bc9445fc3` |
| `src/control/exactRunInputs.ts` | Capture and compare a project-wide input manifest and materialize only verified bytes. | `Added` | `a4dfe0af6837f51449b0514a78f3edb76477405c0c5c0f4d406da5cc32c1de74` |
| `src/control/benchmarkRun.ts` | Pin the run subject before execution and verify it before recording. Separate registered evidence from diagnostics. | `9105262e01f0386cc07b33ef6a6b3e8745db17455b7251d0d130c451eac67ad2` | `5fe406ed6d091a67098bd28b2901c80e459e55faaa066c51805da19ccef17cd7` |
| `src/benchmark/benchmarkRunner.ts` | Execute and hash the exact raw benchmark bytes supplied by the caller. | `b3c4356d7b4fa6c522bf9ddb98a422203c023ee19d382c030cc7169731da1183` | `48ca229b22e3634b357ed0ce0d10a997a5b6ea63cb6c880a915a4b3959936c1f` |
| `src/cli/commands/benchmarkCommands.ts` | Record against the same installation root selected before execution. | `c05c60b3d782bd934628bbaa9d151af7bb810fa0aa55815bcefc506a2d563e5b` | `53b467c6280a34056075f688d1333a75bc7f036a0a494f6e28ee3fb5cbb92b08` |
| `src/cli/commands/cycleCommands.ts` | Pass the closing run its expected mission and benchmark lock. | `8e70a6932984748cda135fe5ef934d1d6c53f20fab84335c0315fff06df4e143` | `da36c3ac8e4bec7d21388251bed6b50db512b87651c126acedfd24a08da464ef` |
| `src/cycle/cycleOrchestrator.ts` | Bind screening, baseline reuse, candidate evidence and closing evidence to the measured inputs. | `90f70ce357341042722d04ea61f1dea0427dfc1f2fe977d368a6b33a8228f767` | `4dc09b8c85f42b246247405c5029c890b5ae11449cf17de4c7ff34b2ec2cd116` |
| `src/experiment/proof/executionCoordinator.ts` | Verify the copied inputs and the actual candidate tree and executable bytes. | `76a711e8d535c0760a665dc497e9487f5f45473ee9ec2eb48b1de86b4d8b52bb` | `a24dcf22da6b059e7ef320a37e76055a3bfc657077d24c63f3f2bde86a13a98e` |
| `selftest/exact-run-inputs.test.ts` | Check manifest, copy and benchmark-recording refusals on drift or links. | `Added` | `6f277fbee7380384c26074a6d2e6e005aeaf1cc707dcf5c48bae56dad1939311` |
| `selftest/benchmark-runner.test.ts` | Check raw benchmark and executable identities. | `58e99e8084403574f202d61e317e76da4d4d91d11c59ee84040e2b453bea5c9d` | `83dd157def9214b370c2f615c6727861e0f23446fea20c3c9ef4064b2c760eb1` |
| `selftest/cycle-closure.test.ts` | Exercise the pinned closing-run subject in the existing fixtures. | `ac2c118c4852089367b2991f3330899a20b538237550c788ee00e62c24a276a5` | `5671667bcc09b3ecb3d96521b9f0d20821355d26abff0e74731f42fd409a06f4` |
| `selftest/proof-cli.test.ts` | Use the unlocked benchmark path before recording and proving through the CLI. | `8f0e2feef27c13288d6629ebb22641f0f9816af48d26a8b202fa956e0dc50d70` | `c71adfbe369675015914d6a820a2ee321aabd7fb9e3dcad3510581098804d11e` |
| `selftest/proof.test.ts` | Exercise candidate and baseline drift refusals and verify that diagnostic runs stay ineligible. | `253a01bb4769adfb6311ce824c022074af74eece10917e61f90420b2689b69b6` | `a14326e707caf1909e1bc699ec9417028fce7957ba4104dc0439c25cb06c7af4` |
| `selftest/self-target-proof-relocation.test.ts` | Exercise the self-target benchmark with pinned source and isolated relocation records. | `cba4bb982018d3e341b9365d3bb1ac8859b218fc9c1b350c77e84248a361a668` | `5d5cfa770ac4e21b3ae75ef130664f3f89929b3fda5c1ab9410f8b2e129b9cfd` |

This manifest is an added file. Its own hash is excluded from its table.

## Apply and verify

Stop the dashboard and any cycle or benchmark process before replacing files. Compare the before hashes if the project has local edits. Extract the ZIP contents directly into `F:\CLU\CLU` and replace the listed files. Run from that directory in Windows PowerShell.

```powershell
npm.cmd run verify
```

Build and focused proof, benchmark and relocation tests passed on Linux. Run the full suite on Windows with the native SQLite addon before using these changes for P2 evidence.

## Evidence compatibility and next step

Historical benchmark events remain readable. Proof reuse requires a fresh cycle screened under Patch 02 and a fresh registered `clue benchmark run` receipt. Keep proof input JSON and release reports outside the project tree, such as under `F:\CLU\release-evidence`, so preparing evidence does not change the screened inputs.

The before/after checks detect persistent drift across the run. Worker isolation and transient mutation protection remain the next milestone. Proof protocol and verdict corrections are planned for Patch 04.

**Next patch** Patch 03 — Execution isolation.

## Rollback

Restore the replaced files from the cleaned Batch 8 plus Patch 01 baseline and remove the three added files including this manifest. Keep any run evidence and rebuild `dist` from the restored source. A fresh cycle is required before using Patch 02 proof evidence.
