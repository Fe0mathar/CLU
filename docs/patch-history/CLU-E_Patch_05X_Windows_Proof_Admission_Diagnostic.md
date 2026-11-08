# CLU-E Patch 05X — Windows proof admission diagnostic

## Purpose

05W compared reviewed changes directly on the Windows host. 05X exercises the native request entry point for the next stage of automated proof. The launcher compiles the existing Supervisor entry point with a temporary, pinned fixture scope and reuses the previously verified MXC engine. The report binds the supervisor, engine, Node executable, and fixture by SHA-256.

## Requests

Both positive fixtures use the common `clue-proof-exec/1` request fields and the real native job path. They carry an exact Node executable path, a pinned inline script, disjoint roots, a minimal child environment, a 20-second deadline, and the required network-denial flag.

| Case | What the diagnostic checks |
|---|---|
| Baseline | The fixture reads the checkout and trusted source. It writes to workspace, scratch temp, and scratch home. It is denied writes to the checkout and trusted source, and reads of the private and undeclared markers. |
| Candidate | The same checks apply, with a permitted write to the disposable candidate checkout. |
| Refusal controls | Network opt-out, writable baseline layout, an extra environment field, and a changed workload are refused before launch. |

Both positive cases check that synthetic host-only environment fields are absent and the scratch environment paths match the request. The host independently verifies the output markers and unchanged protected inputs. The stage is removed after verified completion and retained if cleanup is uncertain.

## Acceptance and scope

`PRODUCTION_SHAPED_FIXTURES_OBSERVED` requires both positive fixtures, all four refusal controls, and verified stage cleanup. The diagnostic executable admits the exact pinned fixture only. The report records `proofAuthorization: false`.

The network flag refusal tests the request parser. The fixtures exercise file and environment access. Production qualification still needs real workload admission and network fault-containment evidence.

Portable validation exercised report and refusal handling and ran the fixture against controlled filesystem permissions. Native C# compilation and actual MXC execution require the Windows run.
