# CLU-E Patch 05I — Windows execution and readiness

**Applies to** the cleaned CLU-E tree with Patches 01–05H. The reference installation is `F:\CLU\CLU`, with Patch 05H recorded at `b417146`.

**Scope** legacy `clu` P2 setup, Windows proof qualification and operator visibility. `clue1` generation 4 passed saved-profile validation before this patch. The live report still identified legacy `clu`. Project Profile activation is a separate operation.

## What changed

| Area | Change | Reason |
|---|---|---|
| Shadow setup | The foreground launcher reads the installed roots, checks local physical directories and rejects overlapping roots before creating the missing shadow directory. | Prepare the configured external shadow safely while keeping the source checkout clean. |
| Gateway | A masked prompt supplies `OPENAI_API_KEY` to the legacy check and managed dashboard session. The model check authenticates against the OpenAI model endpoint and requires the exact governed ID. | The legacy runtime and the saved Project Profile resolve credentials independently. |
| Windows supervisor | The launcher accepts a separately installed `clue-proof-exec/1` supervisor and an independently trusted SHA-256 pin. It can run the native canaries and validate the resulting receipt. Proof execution requires the matching receipt and records its hash in the execution boundary. | Bind each Windows proof to a qualified installation, host account and Node executable. |
| Operator visibility | The managed dashboard opens a dedicated PowerShell activity window for actual host requests. The activity window shows the request name, reply validation, elapsed time and exit status when available. It remains open until dismissed. The existing **Open Test Chrome** action still opens the profile's dedicated visible Chrome window. | Make the work observable while preserving the structured host protocol and exact browser target. |
| Proof visibility | `CLU_PROOF_VISIBLE=1` in the foreground Windows proof CLI shows the stage, heartbeats, exit result and output size. | Keep live observation separate from candidate control and bounded evidence capture. |
| Benchmark path | Candidate proof uses the hash-verified locked benchmark path, including an absolute path such as `F:\master-benchmark.md`. | Remove the duplicated drive path when a Project Profile binds an external benchmark. |

The ZIP contains supervisor integration and qualification tooling. **A compatible native supervisor executable is a separate prerequisite.** Patch 03 supplied the broker and protocol. Install and verify the actual supervisor using [Windows execution supervisor](../p2/WINDOWS_EXECUTION_SUPERVISOR.md). The canaries use disposable files and controlled network endpoints. The report records pass, failure or an unexecuted check. Actual opening, candidate and closing measurement parity is established by the corresponding proof receipts.

## Apply and run

1. Close the running dashboard console. Extract the ZIP contents directly into `F:\CLU\CLU`. Review the source changes and commit only the patch files to preserve a clean Git baseline.
2. Double-click **`CLUE-Windows-Setup.bat`**. It uses installed Node, npm and PowerShell 7. If Windows blocks the reviewed PowerShell script because it came from a downloaded archive, unblock that script through its file Properties and rerun the launcher.
3. At the supervisor prompt, provide the absolute path to the installed compatible executable and the expected SHA-256 from its trusted release record. Press Enter to skip if that executable is unavailable. You can still complete shadow setup and check the gateway. If the launcher inherited a trusted binary and receipt pin, it can revalidate the existing receipt.
4. Enter the API key only at the masked legacy prompt on your machine. The check reads model metadata and verifies the exact `gpt-5.6` ID without submitting an inference task. It does not clear a governed provider pause. Each new setup session prompts again. The key stays out of arguments, reports, Git tools, build processes and the proof child environment.
5. Choose whether to start the dashboard. Select a saved profile and click **PowerShell / Host → Test Connection** to see its dedicated activity window. Use **Chrome / Browser → Open Test Chrome** for the dedicated browser. Chrome requires the saved managed profile, debug port and allowed target URL.

Reports go to `F:\CLU\release-evidence` on the reference installation.

| Report | What it verifies |
|---|---|
| `P2_WINDOWS_READINESS_*.json` | Installation preflight, Git, shadow, key presence, supervisor pin and qualification receipt status |
| `P2_LEGACY_GATEWAY_*.json` | Authenticated access to the exact model metadata, with credential presence and no key value |
| `P2_WINDOWS_SUPERVISOR_*.json` | Native canaries for the supplied supervisor, if run |

## Qualification and the first run

A foreground proof CLI session needs the trusted settings below. Reuse the same reviewed receipt for opening, candidate and closing runs. Changing the receipt changes the pinned execution boundary. Keep the receipt outside the target, workspace, shadow and approved toolchain roots. Supply the offline npm cache required by Patch 03 when dependency installation needs it.

| Environment variable | Expected value |
|---|---|
| `CLU_WINDOWS_SUPERVISOR_PATH` | Canonical absolute path of the independently trusted executable |
| `CLU_WINDOWS_SUPERVISOR_SHA256` | Expected lowercase SHA-256 from the trusted release record |
| `CLU_WINDOWS_SUPERVISOR_QUALIFICATION` | Canonical absolute path of the passing native canary report from this host |
| `CLU_WINDOWS_SUPERVISOR_QUALIFICATION_SHA256` | Lowercase SHA-256 of the exact reviewed receipt |
| `CLU_PROOF_VISIBLE` | `1` to show progress in the current Windows CLI console |

The qualification tool requires an active host LAN IPv4 interface for its local network checks and host-observable process identities for the cleanup checks. It reports missing premises explicitly. Requalify when the binary, host policy, OS or toolchain changes. Follow the [P2 closure runbook](../p2/P2_CLOSURE_RUNBOOK.md) for live gateway status, release packaging, Creator ratification, epoch sealing and the first authoritative cycle.

## Verification and rollback

Portable checks cover TypeScript, profile and dashboard acceptance, documentation seals, the benchmark-path regression and receipt validation. Native PowerShell window behavior, the supervisor canaries and the live OpenAI request require your Windows host. A successful setup run only establishes the checks it records.

The full self-test was attempted on Linux. All 267 failures were `ERR_DLOPEN_FAILED` for the Windows build of `better-sqlite3` in the supplied dependencies. Run the full suite with Windows-native dependencies before treating this patch as release-qualified.

To roll back, restore the overwritten files from the previous commit and remove the files listed as added below. Retain the external evidence and any existing workspace or shadow data.

## File inventory

| Project-relative path | Action | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `CLUE-Windows-Setup.bat` | Added | `—` | `49ca71c17051541717c7db39d8b140fb0302f775d783f6063eb86cd9b4335287` |
| `package.json` | Replaced | `0979590234bd766bcbcb2dfd87be282cc4d936467b0f3967aeec8e5db6b5d1d8` | `48d8b05dee138a91969ac795e5d8cfa2c98c9c1472d5546623c0cd58e68449ab` |
| `scripts/clue-windows-setup.ps1` | Added | `—` | `5b11249a414360853e53677654dcbb09e31c930e67df712297e4ce9979a681f6` |
| `selftest/proof.test.ts` | Replaced | `fd02d9c56a8c6d90df0460ff05d7f975cb13e2c38e9125d70ba64a5befad2fcf` | `aad8edcb9e10999f669adf80dce8f32f1c28df990a393cd3ab4824faff06e443` |
| `selftest/windows-supervisor-qualification.test.ts` | Added | `—` | `37e3273b0a7af06e6c59b540a98d2b2eccca98aa70d4aaf344a9017e4434286d` |
| `src/benchmark/restrictedExecution.ts` | Replaced | `ad1a69abf98ae075d33cef1299a743cd33526c1edd6ced93a117b807428b2410` | `263884adb8c00fdb3fb243af501496d20ce42d8b96f048c36cd6d840d2fca2f2` |
| `src/benchmark/windowsSupervisorQualification.ts` | Added | `—` | `886a19c9fe1f3d78a23b2ec5b1cfa328247ce7f6459b743f1bd4fae584e62149` |
| `src/control/projectProfiles/gitReadiness.ts` | Replaced | `2a1989efb7a10583283af9f2dad1bacf007b1648b3aab10eaca2ab0100174a3f` | `72c0eb9836c1e6c32a55fe62e75d56c640f6b9e7b5c73d12acc14443f4fe1a21` |
| `src/cycle/cycleOrchestrator.ts` | Replaced | `f674969fca4c155e016dfe7da69fa6208b768d6e917db288970a714f37ab8da6` | `e4ebbd0662f9a2d15a260114bd30b0451dca53d6ae231d55799e6b0a01192a65` |
| `src/daemon/clueDashboardServer.ts` | Replaced | `b1d5e62d3c8384a7c431f2343b543d2b1eff2bac545c3d5fe014b92d4508e187` | `d6e36c905218a8a2f49ebdb617279e40da8ad180873f5ae598bb4dc15b8c02e0` |
| `src/experiment/host/hostClient.ts` | Replaced | `93d658b447b37814d0aa9f556b127a4c7dbec269ca65554c1f270b3137ad57e2` | `ce74edcda0d7469d30e06ae6dc3a7cff28ee4da76e2c8e74474075ffbaabe295` |
| `src/experiment/host/windowsHostObserver.ts` | Added | `—` | `3452bd4ac1af6fe81db0905ad149b998e53015b668b9fa417c9964d8f0d228ac` |
| `tools/p2-closure-preflight.mjs` | Replaced | `65ef51e1f57e7976ef9a1cb1fc1881e79b2a01482a6cd5d3a45b21bce033aac3` | `bf11907a6eb78d8e673938d1194fcb5af47c2d21c97c7d4b8d64df295f962a73` |
| `tools/p2-windows-readiness-probe.mjs` | Replaced | `32f2c8a536ce56591388a74ff825e25d590812b4dc916ce952bec6279d9d91a8` | `5e967fc0402527bac5a73d9528b5c74e0ca764f071a1f754abd25a03f708a367` |
| `tools/p2-windows-setup.mjs` | Added | `—` | `87e0a4e5679a614bdfd53de0174c2c0a00b1a0c75a76f95c7c9587af77046be4` |
| `tools/p2-windows-supervisor-qualify.mjs` | Added | `—` | `3964e75cd3eed6e46797b869a541db93e317e88f65c2f984597ba400f9e6b46a` |
| `tools/release.mjs` | Replaced | `92836dd94dc741406075d34c0033e7939854a8fec89ede238b18cd0be431520c` | `dda2e7def47d688c910b4985ffc0b44060840aa3c395d617d7a372c2f3068368` |
| `ui/clue-dashboard/configuration/hostEditor.js` | Replaced | `6094b12011bb78e1e5b46fc79980683f4f5dbfaea37cc81d4f74056513d9ea68` | `96268e5944059d10da095ed9ed4e19324cff4d63bc1441d1921e596f40f917be` |

The patch-history manifest is also added. Its own hash is excluded from the table.
