# CLU-E Patch 05 — Release packaging and readiness

**Date** 7 November 2026  
**Prerequisite** Cleaned Batch 8 `CLU.zip` with Patches 01–04 applied.  
**Patch 04 ZIP SHA-256** `3760177aa96d235a9cc87eea3c81935c966f251e7b649a90c46d6243195aa16f`

## What changed and why

The source release includes both verified documentation packs, the v9 selector, closure templates, and required operator files. The packager checks both seals before archiving and again in a fresh extraction. Git provenance now compares every archived file with its committed blob in the same clean local repository. This catches content drift that `git status` alone can miss. The release report binds the archive SHA-256, the file inventory, the local commit and tree, and the gate results. Git stays local.

The gated package installs locked dependencies in the fresh extraction, typechecks, builds, and runs the compiled selftests, Project Profiles acceptance, and P0 probes. Native Windows proof integration must run for a formal `RELEASE`. The report distinguishes `RELEASE_CANDIDATE` when qualification remains pending, `UNGATED` for structural checks, and `BLOCKED` when a required check fails.

## Apply and verify

Stop the dashboard and any running proof or benchmark. Extract these files directly into `F:\CLU\CLU` and allow replacements. Compare the before hashes if the tree has local edits. Review and commit the applied source in the local Git repository, preserving exact file bytes. Qualify the Patch 03 supervisor using `docs/p2/WINDOWS_EXECUTION_SUPERVISOR.md`. Then run in Windows PowerShell from the project directory.

```powershell
npm.cmd ci
npm.cmd run release:package -- --out 'F:\CLU\release-evidence\Patch05'
```

Keep the archive, its SHA-256, the per-file sums, release report and gate log together. For the remaining live checks and Creator approval, follow `docs/p2/P2_CLOSURE_RUNBOOK.md`.

The portable build, acceptance, and focused archive checks passed on Linux. The Windows clean-install and native proof gates still require the installation host and qualified supervisor.

## Next step

Patch 05 completes the planned source patches before the Windows P2 ceremony. The ceremony verifies the live host and provider, ratifies v9, seals the P2 epoch, and records a governed ACCEPT, matching Great Book entry, proof-authoritative close, and Creator approval. The v10 pack is packaged for later promotion.

## Rollback

Restore replaced files from the cleaned Batch 8 plus Patches 01–04. Remove entries marked Added and this manifest. Keep previously emitted archive and proof evidence separately.

## File inventory

| Project-relative file | Purpose | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `docs/P2_CLOSURE_RUNBOOK.md` | Point operators to the cumulative installation and gated release flow. | `06a41a0288b92f2112e6a8738c708e37ae66e69846c3593aadc0070c01c17207` | `460189286c72d4ffd89b0c080166aa17651153bf476129819b93108df9d5cceb` |
| `docs/p2/P2_CLOSURE_CHECKLIST.md` | Add the dual seals, exact archive, Git and native proof checks. | `346755db037495664bb77794b8fb620d8d06db043cd4c807a1f0a87fd2f393a8` | `12a69c75a5ba8f325e0e58828ec1725cfcb6c32041113255af5db11a8b577282` |
| `docs/p2/P2_CLOSURE_RUNBOOK.md` | Document the Windows release command and archive evidence before closure. | `13125ecf009dd07d829b492795d689289fa6e009df03155ea4d9638771d8cf36` | `55724e0b7ba451c360458077f3f2246c7944d037ca58b6f6397a51f0b4d64ed5` |
| `package.json` | Expose the release package command from PowerShell. | `28ed6313ea30fe8202b39885d03f40798c9638cd5d58819b2b04b2fa3b389b68` | `0979590234bd766bcbcb2dfd87be282cc4d936467b0f3967aeec8e5db6b5d1d8` |
| `selftest/release-packaging.test.ts` | Exercise deterministic contents, both seals, v9 selection and local Git binding. | Added | `3cf2585e84d873c7f3d3ec2ccf5a28f476dc5b043644aa6e5507485f04ce123a` |
| `selftest/release-readiness.test.ts` | Check TAP accounting and Windows proof readiness refusal. | Added | `49ef2747333b0a93c8b44971375b9abfdc75988adbef677e9bfa20b4d36e5bcf` |
| `tools/p2-closure-preflight.mjs` | Require v9 selection and both documentation packs before P2. | `0a1f9db1c9abeff842c634d79547aa10d602944a737ea4ebb222bdcebe9fdfb5` | `65ef51e1f57e7976ef9a1cb1fc1881e79b2a01482a6cd5d3a45b21bce033aac3` |
| `tools/release-readiness.mjs` | Interpret TAP output and the native proof readiness gates. | Added | `91310e09e7aec2ea28f43bf18d0de94e4b4698058815c949e1c20c7ffac0b031` |
| `tools/release.mjs` | Package the complete source release and qualify the extracted archive against Windows and Git gates. | `aa79b742b86f5364171bf88e1d2c779ad3ec7db3e37b2ebe07bc606ea3a86dd0` | `92836dd94dc741406075d34c0033e7939854a8fec89ede238b18cd0be431520c` |

This manifest is an added file. Its own hash is excluded from its table.
