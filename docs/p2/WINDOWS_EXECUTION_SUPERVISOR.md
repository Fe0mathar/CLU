# Windows execution supervisor

CLU-E's Windows execution boundary requires an operator-qualified OS supervisor. This repository supplies the launcher pin and request protocol. Install and qualify a compatible Windows supervisor separately before enabling execution. Missing configuration, invalid paths, changed bytes, or a failed supervisor launch cause execution to be refused.

## Trust and installation

1. Install the supervisor in a dedicated administrator-managed local directory. Protect the executable, its ancestor directories, and its dependent DLLs, configuration, and search paths from writes by the CLU-E operator account where practical, and always by the confined candidate account. Keep the executable and request directory outside all writable experiment roots.
2. Verify the executable and its dependencies against a trusted release record. Set `CLU_WINDOWS_SUPERVISOR_PATH` to the canonical absolute local `.exe` path and `CLU_WINDOWS_SUPERVISOR_SHA256` to the independently verified lowercase SHA-256 digest. Put these settings in the trusted CLU-E launcher environment. A candidate has no authority over either setting.
3. Pin and retain the exact supervisor, OS configuration, Node, npm, native addon, and benchmark. Qualify both baseline and candidate under the same OS boundary and toolchain. Repeat the qualification after a change to the supervisor, host policy, image, or toolchain.

The resolver checks the executable's path and bytes before launch. The digest authenticates the selected bytes against the operator's pin. Host filesystem ownership and ACLs protect the binary against replacement between verification and launch.

## Supervisor request

CLU-E launches the pinned executable directly and passes two arguments, `--request-file` and the absolute path of a private UTF-8 JSON file. The supervisor reads that file as structured data. It must validate all fields before it starts any child.

| Field | Meaning |
|---|---|
| `schemaVersion` | Required protocol discriminator `clue-proof-exec/1`. |
| `command` | Executable to run inside the qualified boundary. Resolve it through the trusted, pinned toolchain policy. |
| `args` | Ordered argument vector. Preserve argument boundaries and use the Windows executable's compatible quoting. |
| `cwd` | Exact candidate or baseline working directory. Require it to resolve under a declared root. The baseline project root is read-only. |
| `readOnlyRoots` | Explicit additional input/toolchain roots available for reads. Canonical project and evidence must stay inaccessible except for approved read-only inputs. |
| `writableRoots` | Explicit run workspace, candidate checkout when present, and scratch roots. Verify their physical paths and keep request files, canonical project source, the supervisor, and unrelated user data outside them. |
| `env` | Complete allowlisted child environment. Pass exactly the declared variables and keep inherited credentials, launcher configuration, and host user variables out of it. |
| `timeoutMs` | Positive wall-clock deadline for the whole child tree. |
| `denyNetwork` | Required value `true`. Activate OS network denial before starting the process. |

Reject ambiguous paths, relative or missing roots, reparse points or aliases that escape the permitted scope, and configurations the supervisor cannot enforce. Apply writable access only within the stated roots and read access only to declared inputs and the minimum trusted runtime/system resources. Constrain child filesystem, process, registry, and IPC access so the child cannot inspect host credentials or communicate with the supervising authority. Keep request files and their directory inaccessible to the candidate, and preserve report integrity across the host/guest boundary.

Use direct process creation with a validated executable and structured arguments. Refuse an invocation that cannot be safely represented, or that would reinterpret a caller-supplied path as shell syntax.

Forward the child's stdout and stderr bytes to the corresponding supervisor streams. Return the child's exit code when supervision and cleanup succeed. Exit `124` is reserved for a deadline and `125` for supervisor setup, enforcement, or cleanup refusal. Normalize a child that tries to return either reserved code to a generic failure. CLU-E independently enforces its deadline and bounds captured output.

## OS enforcement

A Windows Job Object can enforce process-tree lifetime. When using a Job Object, assign the initial process before it runs, disallow breakaway, and use kill-on-close with handles the confined process cannot inherit. Pair the Job Object with a qualified restricted identity and filesystem and network controls. Where the host cannot enforce all access rules, use an isolated native Windows guest with explicit mounts, disabled host integrations and networking, and disposal on stop. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) · [Microsoft Windows Sandbox configuration](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

The supervisor must terminate all child processes on deadline, cancellation, refusal, and supervisor shutdown. It must surface failure if setup, cleanup, or policy enforcement fails. Baseline and candidate require equivalent OS confinement and timing semantics. Run dependency installation and build in the same qualified boundary. Prepare a trusted npm cache before launching the proof, make only that approved cache available to the child, and run `npm ci --offline` with the locked package manifest. Treat a cache miss, unsupported native addon, or installation script that requires network access as a readiness failure.

## Native Windows qualification

Use a disposable fixture containing harmless canaries and run these cases against the exact binary and machine intended for P2.

| Case | Required evidence |
|---|---|
| Successful command | The allowed tool executes in the specified working directory, can read the allowed read-only fixture, and can write only to its experiment root. |
| Denied filesystem access | Writes to the read-only fixture and canonical project source fail. Reads and writes to an undeclared sibling, workspace belonging to another run, and fake credential file fail. Verify each host canary is unchanged. Include junctions, alternate data streams, case aliases, and traversal. |
| No secret inheritance | A harmless host-only sentinel, `OPENAI_API_KEY`, and supervisor-launch settings are absent from the child environment and output. Use fixture values and record presence checks only. |
| Network denied | A child cannot reach a controlled endpoint, including loopback or the LAN. The OS boundary has no network or IPC path that bypasses the policy. |
| Descendant timeout | A child starts a descendant that outlives its parent. The deadline terminates both, with the reported outcome matching the timeout. Check that both PIDs are gone and temporary resources are reclaimed. |
| Launcher cancellation | Terminate the supervising host process mid-run and verify cleanup removes the complete process tree and releases any guest or Job resources. |
| Tamper and failure | Missing configuration, a modified executable, inaccessible policy, or unqualified supervisor results in refusal. Observe that no candidate child starts. |
| Measurement parity | Opening, candidate, and closing runs use the same native Windows boundary and pinned toolchain. Preserve their execution receipts with the release evidence. |

The portable tests check input and pin validation. Run this native suite before claiming Windows containment or starting the P2 proof ceremony.
