# CLU-E integrity update

9 November 2026 · source archive for an existing CLU-E installation

## Apply on Windows

1. Close CLU-E and its workers. Back up the checkout and the external workspace. Keep your current `.git`, `config/clue.config.yaml`, `targets/clu/profile.yaml`, any `config/project-profiles.yaml`, and any local policy edits. Compare the supplied config and target profile before copying them over an installation you have customized.
2. Extract `updated.zip` into a staging directory. Copy the project files from the ZIP root into your existing CLU-E checkout. The default registered source is `F:\CLU\CLU`. Workspace and shadow paths are installation settings documented in `CONFIG-EDIT.md`.
3. From the checkout, run `npm ci` with Node.js and Git available. Node 22 LTS, version 22.11 or newer, is the simplest Windows install target for the locked native SQLite dependency. Other supported Node builds may require a native compiler toolchain.
4. Open `CLUE-Dashboard.bat`. It builds the CLI, initializes the configured workspace and opens the browser after the server is listening. Use `CLUE-Windows-Setup.bat` when you need the masked OpenAI key prompt and native supervisor readiness checks.
5. Press **START CLU-E** and check Q1, Q3 and the Q4 receipt. START drives the governed cycle to the stage supported by current inputs. A stage that requires proof, a benchmark or authority can legitimately wait for that evidence. The receipt and cycle status distinguish that wait from a scan or a failed command.

The dependency and schema changes can register a successor mission at initialization. Keep the original workspace and closure evidence together so the historical mission, cycle and approval remain independently verifiable.

The archive is source-only. The build and npm installation recreate generated files and platform-specific dependencies. The original ZIP contained `.git`, `node_modules`, root `dist`, three generated UI `dist` folders and a local Configuration backup. These are omitted. The project source, lockfile, operator launchers, self-tests, governed templates and both documentation seals travel with this update. An overlay copies source files and leaves cleanup of older local files to the operator.

## Authority and P2 provenance

| Evidence | Verified result |
| --- | --- |
| Input source | Git commit `cc8410239b14fb58005bd755105551b7aac94d75` and tree `fca61a2c62ea4ca5e7ebcdabbd5c34e02e202f0e` match the P2 receipts. |
| Formal closure | `CLU-E_P2_Formal_Closure.zip` verifies against its checksum manifest. The Creator's approval binds machine receipt SHA-256 `f036e1658f99052919f345a3d91ef2b202832bc722580c841b60f2338d9c4b94`. Windows recorded proof-authoritative closure at `EVENT-000832` for `CYCLE-000001`. |
| Supporting evidence | All 15 member references in the machine receipt matched their recorded byte lengths and SHA-256 digests. The finalization archive digest matched the formal receipt. The machine receipt records an `ACCEPT`, Great Book entry, 13 closing measurements, zero closure blockers and native proof integration. |
| Document baseline | The separate knowledge ZIP is an earlier v9 realignment snapshot. It lacks the Execution Model and 10 same-named files differ. The installed v9 seal and manifest match the ratified hashes in the P2 receipt and govern this audit. The sealed v10 release candidate provides the Project Profiles comparison. |
| Release scope | `updated.zip` changes the source after the historical Windows acceptance. Its tests and checksum apply to this update. The historical P2 evidence remains attached to the original commit and archive. |

`MANIFEST.txt`, `clue-status.md` and `docs/P2_CLOSURE_LEDGER.md` are carried forward as historical project records. This audit and the formal receipt identify the newer evidence. The active selector is v9. v10 promotion and ratification are separate Creator decisions.

## Audit scope

The review traced operator entry points through the dashboard, CLI, runtime assembly, event and artifact stores, Status projection, source inventory and graph, cycle and proof handling, AI transport, Project Profiles, Git, PowerShell and archive construction. It compared implemented behavior with the v9 owners and ADRs, the v10 acceptance matrix, the source inventory and the baseline tests.

The security review used [OWASP ASVS 5.0](https://asvs.owasp.org/) for request and trust boundaries, [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) for testing and release integrity, and [npm clean-install guidance](https://docs.npmjs.com/cli/v11/commands/npm-ci/) for repeatable dependencies. These are review criteria. Formal CLU-E release approval also requires the project's own native gates.

## Findings and changes

| Area | Finding and resolution |
| --- | --- |
| START and Q3 | The old START action launched standalone snapshot and recognition. The update dispatches the governed cycle with Navigator output, binds it to the dashboard's project and workspace, and presents the run receipt. Gauge readings use sealed Console facts with explicit unavailable or paused states. |
| Dashboard boundary | Loopback detection now validates IP addresses. Static asset requests stay inside the intended roots, startup failure cleans up resources, and operator actions preserve refused receipts and their reasons. |
| Dependency validation | The input lockfile reported one high-severity advisory for Zod collection validation. The update locks Zod 4.6.7, with compatibility handling for persisted events, optional values and records. [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) |
| Durable audit | Multiple rotations in one millisecond could overwrite an archive segment. Unique filenames preserve each segment. Present malformed manifests and segment path escapes fail verification. |
| Source and graph evidence | Explicit roots, exclusions, symlink boundaries, snapshot parity and cache admission were tightened. Recognition binds the compiler-consumed source to the snapshot and avoids a redundant compile for changed cache rows. |
| Cycle and closure | Closure resumes from durable state and rechecks the cycle and mission after an unlocked benchmark. P2 assessment verifies the active document bytes, proof timing and completeness of the closing evidence. |
| OpenAI gateway | Response reading shares the request deadline. Redirected and incomplete responses are refused. Concurrent batch pollers cannot duplicate terminal events. Provider access depends on the configured credential and model entitlement. |
| Project Profiles | State paths are checked for physical overlap and ownership. Legacy migration preserves the blob store and Chrome binding. Activation guards reject stale selection and preserve async runtime leases. |
| Git and PowerShell | Manual sync uses the registered remote with controlled Git configuration. The host checks path operands against the governed zones and restricts shadow refresh operations. |
| Release inputs | The exact archive builder omitted three Windows launchers present in the input checkout. It now requires the reviewed release, production network fault and WFP BFE lab launchers. The normal launcher quotes the checkout path, detects missing dependencies and opens the browser after successful bind. |

## Verification

The input suite ran 919 tests on Linux. It recorded 904 passes, 14 skips and one reproducible audit-rotation failure. The rotation regression is covered with a fixed clock. The live dependency audit after the upgrade reported zero known vulnerabilities.

The normal dashboard HTTP endpoint was exercised with a real CLI subprocess, SQLite and a disposable Git target. START returned `202`, created `CYCLE-000001`, reached `SCREENED` with grade `diagnostic`, and returned a successful cycle receipt with sealed Status and Console output. Chromium launch was blocked by the execution environment's socket policy, so UI behavior was verified through the dashboard and Navigator suites.

The update uses the project's deterministic source archive builder. The portable checks include exact extraction and file digests, both documentation seals, a clean `npm ci`, type checking, self-tests and P0 adversarial probes. Windows host behavior, native WFP, a live OpenAI credential and a real remote have separate acceptance requirements.

## Open acceptance and roadmap

| Area | Remaining evidence or work |
| --- | --- |
| Windows P2 compatibility | Run the updated checkout with the pinned, production-qualified Windows supervisor and the workspace's real PowerShell and Chrome paths. Independently verify OpenAI authentication and model access. Treat the v10 model wording and the prior live model identifier `gpt-5.6-sol` as a documentation and configuration reconciliation item. |
| Project Profiles v10 | Live dashboard switching and A→B→A isolation acceptance still require Windows qualification with real project state, graph and Navigator streams, proof history and Great Book. The current dashboard keeps activation gated. |
| Autonomy | The supervised workflow and manual publication remain the implemented operating model. AI-driven candidate planning, fully autonomous proof scheduling, governed landing and rollback, and Golden outcomes remain roadmap work. Some Status fields intentionally represent unavailable evidence. |
