# CLU-E Patch 04 — Proof verdicts, protocol, and templates

**Date** 7 November 2026  
**Prerequisite** Cleaned Batch 8 `CLU.zip` with Patches 01–03 applied.  
**Patch 03 ZIP SHA-256** `9859c36e41384aff09833ffd3e21622f254daf3a20561d801321110f1e19fe21`

## What changed and why

Proof now checks both runs against the frozen protocol. Each declared measurement must have the specified unit, warm-ups, repetitions, and statistic. Exact measurements must agree across retained repetitions. Missing, contradictory, or out-of-protocol evidence blocks acceptance. A recorded candidate must change the pinned project inputs and deliver a strictly positive improvement meeting the threshold while every frozen mandatory gate passes. Identical valid measurements produce REVISE at a zero threshold. A valid ACCEPT carries its matching Great Book entry in the same verdict event.

The shipped CLU-E benchmark now retains warm-up observations and raw repetitions. Its harness digest and exact file hash change. The stock P2 template uses the shipped v9 lock shape, one warm-up, three measured repetitions, median timing, and the exact-count guardrails. The candidate template uses the CLI's versioned whole-file format. The runbook documents the Project Profile-bound v2 variant.

## Apply and verify

Stop the dashboard and any running cycle, proof, or benchmark. Extract the ZIP contents directly into `F:\CLU\CLU` and allow replacements. If you have local edits, compare the before hashes first. Run this command in Windows PowerShell from the project directory.

```powershell
npm.cmd run verify
```

The Linux build, portable acceptance, and focused regression checks passed. The regression cases include one mean offered for a 15-run median, identical values at a zero threshold, invalid units and observations, mandatory-gate failure, and a valid ACCEPT linked to one Great Book entry. Native Windows proof and durable projection remain pending on the qualified Patch 03 supervisor.

## Evidence and next step

Keep the old history for review. Use a fresh cycle locking the patched benchmark and record a new registered baseline before running proof. If an earlier ratification pinned the old benchmark bytes, follow the runbook to bind the new benchmark before the P2 ceremony. Keep contract, patch, and release evidence files outside the canonical project tree.

**Next patch** Patch 05 — Release packaging and readiness checks.

## Rollback

Restore replaced files from cleaned Batch 8 with Patches 01–03 applied, remove the entries marked Added and this manifest, and rebuild `dist`. Retain existing evidence separately.

## File inventory

| Project-relative file | Purpose | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `docs/P2_CLOSURE_RUNBOOK.md` | Describe baseline capture, proof input formats, and the stock proof protocol. | `d4e7ddd439e1d475313ded47efd0ae166d91f22e40bf199471d17340a0f7e2b7` | `06a41a0288b92f2112e6a8738c708e37ae66e69846c3593aadc0070c01c17207` |
| `selftest/benchmark-runner.test.ts` | Check observed benchmark samples and timing limits. | `08f9192dc817a5adba636fc8327b57ff69d59375ade3440a0af44b2e2b3bfaf0` | `f35fd1bf87ab427fc08c1aaa10fbfb206dd007a91391ebbb02d6954b39072489` |
| `selftest/p2-proof-templates.test.ts` | Check both templates against the CLI, lock capabilities, and stock signal table. | Added | `47198c23450151c71bd121edb07ee8a0c9249eb36a29f39ab990f4e7db358546` |
| `selftest/proof-cli.test.ts` | Record matching protocol evidence in the native CLI fixture. | `b9fb9e08a62443121b88ae2dbfb669fbc341bf05810f6c49127c93aba9ef7560` | `5b36540c36842213775fed1e3b827d3e6af14232a88246d126f2055f2c702ba6` |
| `selftest/proof-cycle-project-isolation.test.ts` | Carry real protocol fields through Project Profile-bound fixtures. | `4931cd0df71431d4e4cb78f250d74e57061ed613d0629b1f048da0740b1b7e35` | `998652bfc2fe1830e86643069702d9dd66414b77a834a9ab843d958912629ae7` |
| `selftest/proof-verdict-protocol.test.ts` | Reproduce the false ACCEPT cases and verify guards and Great Book linkage. | Added | `6e064491078aabd9fc5204831d8377ac1f380781f8cb8a1a8c5d3ecf9f9646a4` |
| `selftest/proof.test.ts` | Exercise contract validation, no-op refusal, and exactly one durable ACCEPT for the valid fixture. | `dab92722f704ac847082411c23cfd8586d0e2f6d9597d215bfcd3f847efd0603` | `fd02d9c56a8c6d90df0460ff05d7f975cb13e2c38e9125d70ba64a5befad2fcf` |
| `selftest/self-target-proof-relocation.test.ts` | Exercise self-target relocation with matching proof observations. | `f7607239311a85d0fff88e95eac91148e01377230813eba3b8951195980a60df` | `4c18c8f660f00daefa0d48d6e4a6f3bb4f215380c4d584cdf7f5658d43195c35` |
| `src/benchmark/benchmarkRunner.ts` | Parse retained warm-ups and cap candidate measurement by the frozen deadline. | `81789895bec244bc8a75b615722a7d71b559d015f42c8634b1ec405faff75ea9` | `cf4bbb6fed1244f4ef52245d2d3718e58900bb87ded5bd8953f527fb5ceffc99` |
| `src/control/benchmarkRun.ts` | Require retained observations before recording a receipt as potentially reusable. | `c0e9e3a3e04ce2af024e8a9e4a6ffd9f53b15275d566f6c181e4bc0af160775b` | `a92d2fdce76a601786ce6d9d5c1114ee2c16895de366faf1e9257ffb86feed27` |
| `src/experiment/proof/executionCoordinator.ts` | Apply the frozen measurement deadline and reject unchanged candidate trees. | `23e533b80e53fb3e5514094fd7f782529468e1245f296c7fe3e7c1321d29841b` | `8e5b3af955619ccbbf1a9314c0ab7cfb4838ae599e3e071864e24a37b3d0ff23` |
| `src/proof/baselineRegistry.ts` | Carry observation data and elapsed time and validate reuse. | `28b7bed9e98e1aa4bf3061bc12baa68567b910d51ffba6a6beb3c0db07257499` | `12847ded55158f337b527c003ce72ae9868560c0394ed6db4d4a6e72551b08ea` |
| `src/proof/measurementProtocol.ts` | Validate units, aggregation, sample counts, and observed duration. | Added | `62b23c31e9a611a1727a294f9f23244540bbec9f1ec432a7e34e2fe4f2d6650a` |
| `src/proof/proofContract.ts` | Declare exact measurements and reject ambiguous measures or thresholds. | `fd98486cf89cf068b95fe0fc6704869ace5d3e50e101be10a3a8fafa9bbacdbf` | `9c774d3bc78abbc90c03ca6fc0a85b0c9be4bdac04e379919bd9c0ffe2394c5d` |
| `src/proof/verdict.ts` | Recalculate the statistic from raw data and require a strictly positive gain. | `dab5bbc23e0df1902d9027d399196d6b78b348f008c01cba5d9548c9c9858483` | `b416e53ab9bf26f9f74c4b9073db55b04f85d6ade8223d362135dfc43191db6b` |
| `targets/clu/benchmark/master-benchmark.md` | Capture measured repetitions and warm-ups and re-pin the harness. | `0376de2efa9fc66b1604fc1746e51d9573518932b44fb973a470267003eed219` | `af3f9c650dbff200416d39bd5e23c055091c11a74e580c5247144215f6a9ef78` |
| `templates/p2-closure/candidate-patch.template.json` | Use CLI manifest version and whole-file replacement shape. | `1aa94d70fe177764db51c239e95d7e817b9d3292994994360b7f94a5317efe28` | `d2f6f477ab7698a5ba7eb5c146cff3d6e91a955bf1dacba6286690568c291932` |
| `templates/p2-closure/proof-contract.template.json` | Use real stock v9 lock fields, signals, statistics, and guardrails. | `131606bae5f63645f33a03cf548485040b7590d275f9b142627fd8790c83781c` | `5655e26be82c8bcc9ef065eed597b27a9122bf22096952aa545f045faf48f2b0` |

This manifest is an added file. Its own hash is excluded from its table.
