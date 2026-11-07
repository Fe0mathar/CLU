# CLU-E Patch 03 — Execution isolation

**Date** 7 November 2026  
**Prerequisite** Cleaned Batch 8 `CLU.zip` with Patches 01 and 02 applied.  
**Patch 02 ZIP SHA-256** `2fda7cab409da05f89bd54181bc5a6d0c7ed95ba47b7f30d42336a984d98dde2`

## What changed and why

A registered benchmark harness now runs in a separate permission-restricted Node process with an empty inherited environment and a narrow message protocol. Commands run through an OS isolation broker. The baseline project and its toolchain are read-only. The candidate can write to its own checkout, run workspace and temporary directories. The broker supplies an explicit environment, denies network access through the OS boundary and enforces deadlines, output limits and process-tree cleanup. Setup and supervision failures stop the run.

Linux uses Bubblewrap. Windows requires a separately installed and qualified supervisor pinned by SHA-256. The [Windows execution supervisor guide](../p2/WINDOWS_EXECUTION_SUPERVISOR.md) defines installation, protocol and native verification. Candidate dependency installation uses offline npm. If a clean install needs packages, populate an approved offline cache and set `CLU_OFFLINE_NPM_CACHE` in the trusted launcher.

The broker maps the registered benchmark's `npm run selftest` to the same serial TAP test selection over the prebuilt `dist/selftest` on both sides. This keeps the measured baseline tree read-only. Run the ordinary build before taking a fresh baseline.

## Apply and verify

Stop the dashboard and any benchmark or cycle process. Compare the before hashes if there are local edits. Extract these files directly into `F:\CLU\CLU` and allow replacements. Run in Windows PowerShell from that directory.

```powershell
npm.cmd run verify
```

Type checking, build, portable acceptance and focused worker, broker and proof tests were checked on Linux. The Linux host denied the network namespace, so the tests verified refusal and skipped live namespace acceptance. Native Windows containment must be verified using the operator guide before producing P2 evidence.

After configuring and qualifying the supervisor, rerun the full suite and run the P2 closure preflight. Keep reports outside the project tree.

```powershell
npm.cmd run p2:closure-preflight -- --output 'F:\CLU\release-evidence\Patch03\P2_CLOSURE_PREFLIGHT.json'
```

## Evidence and next step

Historical receipts remain readable. Use a fresh cycle and a new registered `clue benchmark run` receipt for candidate proof. Reuse requires the baseline receipt and candidate execution to agree on the current isolation kind and SHA-256 pin.

**Next patch** Patch 04 — Proof verdicts, protocol and templates.

## Rollback

Restore the replaced files from the cleaned Batch 8 plus Patches 01 and 02. Remove the entries marked Added and this manifest. Rebuild `dist` and retain any existing run evidence separately.

## File inventory

| Project-relative file | Purpose | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `docs/p2/WINDOWS_EXECUTION_SUPERVISOR.md` | Specify supervisor trust, request protocol and native qualification. | Added | `580e0de651de4e996a83c381db7542c1492ebe2ea3c6cc4dedb7f2e6ab87be6a` |
| `selftest/benchmark-runner.test.ts` | Check worker isolation, invalid input and deadlines. | `83dd157def9214b370c2f615c6727861e0f23446fea20c3c9ef4064b2c760eb1` | `08f9192dc817a5adba636fc8327b57ff69d59375ade3440a0af44b2e2b3bfaf0` |
| `selftest/contained-process.test.ts` | Check output caps, cancellation, descendant cleanup and Linux mounts. | Added | `97cbfd7589e22054188ac96cc0fe8007e73cbee06a289c8d567276a48a9ffb01` |
| `selftest/proof-cli.test.ts` | Use separate test roots and require native isolation for the real CLI proof. | `c71adfbe369675015914d6a820a2ee321aabd7fb9e3dcad3510581098804d11e` | `b9fb9e08a62443121b88ae2dbfb669fbc341bf05810f6c49127c93aba9ef7560` |
| `selftest/proof-isolation-fixture.ts` | Detect availability of native proof isolation for integration tests. | Added | `3cab070704f261927d72f16adc909c11371b61ec3aee714ce1b29d9e7c421fe4` |
| `selftest/proof.test.ts` | Exercise the proof chain with separate test roots and an available native boundary. | `a14326e707caf1909e1bc699ec9417028fce7957ba4104dc0439c25cb06c7af4` | `dab92722f704ac847082411c23cfd8586d0e2f6d9597d215bfcd3f847efd0603` |
| `selftest/restricted-execution.test.ts` | Check production refusals, mount overlap and absence of an uncontained fallback. | Added | `5f5861e4116b897a318969a2db0b57e7f97c31c40a07d74b1eba963cf06b28a9` |
| `selftest/self-target-proof-relocation.test.ts` | Exercise relocation with a separate opening workspace and native isolation. | `5d5cfa770ac4e21b3ae75ef130664f3f89929b3fda5c1ab9410f8b2e129b9cfd` | `f7607239311a85d0fff88e95eac91148e01377230813eba3b8951195980a60df` |
| `selftest/windows-execution-supervisor.test.ts` | Check Windows supervisor path and pin refusals. | Added | `f67050b6d208bf479a957c0753c48bd4a35dbd601bf6c3e04b9a0465c7797e2c` |
| `src/benchmark/benchmarkHarnessProcess.ts` | Start and supervise the benchmark worker and broker its IPC requests. | Added | `650142db46676768a9c7f679f87995178267125db887871575703429975b7291` |
| `src/benchmark/benchmarkHarnessWorker.ts` | Evaluate the registered harness in a restricted Node subprocess. | Added | `44f3fe3690318199b40c4ea4bf328f38aeb47507df7e21919269d1a59c1eb166` |
| `src/benchmark/benchmarkRunner.ts` | Send executable harness work through the worker and OS command broker. | `48ca229b22e3634b357ed0ce0d10a997a5b6ea63cb6c880a915a4b3959936c1f` | `81789895bec244bc8a75b615722a7d71b559d015f42c8634b1ec405faff75ea9` |
| `src/benchmark/containedProcess.ts` | Bound command time and output, and construct the Linux sandbox invocation. | Added | `f83d8062947668455f85849f2fc0e606153c0b4c8e0718204b40850d7a031e35` |
| `src/benchmark/restrictedExecution.ts` | Scope child filesystem, environment and command access to the run. | Added | `ad1a69abf98ae075d33cef1299a743cd33526c1edd6ced93a117b807428b2410` |
| `src/benchmark/windowsExecutionSupervisor.ts` | Resolve and verify the pinned Windows supervisor executable. | Added | `2fa08f48a526ba15cb58ab1c560947c80e1b5aea3f0b470ca59897e0ce6c8b1f` |
| `src/cli/commands/benchmarkCommands.ts` | Refuse executable contracts outside benchmark registration. | `53b467c6280a34056075f688d1333a75bc7f036a0a494f6e28ee3fb5cbb92b08` | `3ad78595f9326513dbe97b78bdb1d8072f28ec0c6b85775639f6f4f8cc4eccbb` |
| `src/control/benchmarkRun.ts` | Gate benchmark entry and bind recorded evidence to its execution boundary. | `5fe406ed6d091a67098bd28b2901c80e459e55faaa066c51805da19ccef17cd7` | `c0e9e3a3e04ce2af024e8a9e4a6ffd9f53b15275d566f6c181e4bc0af160775b` |
| `src/cycle/cycleOrchestrator.ts` | Require matching isolation evidence when reusing a baseline and deciding a candidate. | `4dc09b8c85f42b246247405c5029c890b5ae11449cf17de4c7ff34b2ec2cd116` | `f674969fca4c155e016dfe7da69fa6208b768d6e917db288970a714f37ab8da6` |
| `src/experiment/proof/executionCoordinator.ts` | Confine candidate install, checks, build, initialization and measurement. | `a24dcf22da6b059e7ef320a37e76055a3bfc657077d24c63f3f2bde86a13a98e` | `23e533b80e53fb3e5514094fd7f782529468e1245f296c7fe3e7c1321d29841b` |
| `tools/p2-closure-preflight.mjs` | Report Windows supervisor configuration as a release readiness gate. | `c3a08d5c173154f19bf2a65a73df114d8e18ae4a103713da00bf9e3df41306ed` | `0a1f9db1c9abeff842c634d79547aa10d602944a737ea4ebb222bdcebe9fdfb5` |

This manifest is an added file. Its own hash is excluded from the table.
