# CLU-E Patch 05U — Desktop Windows Sandbox diagnostic

## Purpose

The operator uses CLU-E on the normal Windows desktop. This patch tests whether CLU-E can create a disposable Windows Sandbox worker on that same machine. The first test is deliberately scoped to a bundled fixture, its temporary inputs, and its result. The current production qualification still requires a separate receipt for the exact production supervisor.

## How it runs

- The batch launcher calls a standalone Node diagnostic. It checks Windows 11 build, edition, optional feature state, and the current user's Windows Sandbox app and command-line entry point. `--check-only` limits it to preflight and read-only session inventory.
- The full diagnostic requires an empty, parseable session inventory. It requests a fresh GUID and uses that ID for its own session. If the fixture has yet to report after a short grace period, the diagnostic requests a connection to that session so the fixed logon command can run. Cleanup targets the exact observed ID and verifies its absence from inventory. [Microsoft Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)
- The sandbox requests disabled networking, vGPU, clipboard, audio, video, and printer redirection, with Protected Client enabled. Its only mounts are a read-only temporary input folder and a temporary result folder. The input contains a bundled script and a bounded request. The guest writes its report atomically and the host verifies the per-run nonce. [Microsoft Windows Sandbox configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)
- The fixture attempts a write to the read-only input and tests IPv4 and IPv6 TCP and UDP binds on the guest's own localhost. When the host exposes exactly one eligible private IPv4 address and the control connects, it also attempts a bounded TCP connection to a temporary listener on that exact address and an ephemeral port. The host verifies its listener before and after the test and records a correlated nonce if received. The report records route counts and outcomes. Each result is scoped to the tested endpoint or bind.

## Reading the report

| State | Meaning |
|---|---|
| `WSB_FIXTURE_COMPLETED` | A nonce-bound fixture result arrived, the input write was denied, and the exact session and fixture stage were removed. Inspect the separate network and loopback results. |
| `WSB_FIXTURE_BOUNDARY_MISMATCH` | The run observed a writable input, guest connection to the controlled host endpoint, or a guest default route. |
| `WSB_FEATURE_NOT_ENABLED` or `WSB_CLI_UNAVAILABLE` | The standard Windows feature or current user's command-line app needs attention. The report includes what was detected. |
| `WSB_EXISTING_SESSION` | An existing Sandbox was detected. Close it normally if it is yours, then rerun. |
| `WSB_CLEANUP_UNVERIFIED` | The fixture stage was retained. The console prints the requested ID for review. |

`guestLocalhost = BIND_AVAILABLE` records that a bind inside the guest succeeded. This matters independently of whether the guest could reach the host. `hostEndpoint.guestReachability` can remain unverified when the address is ambiguous, a local control fails, or no fixture result arrives.

The JSON retains `proofAuthorization: false`. The controlled connection and bind measurements are limited diagnostics. Real workload admission, confined loopback enforcement, fault containment, and production qualification still need evidence.

## Verification

Portable tests exercise configuration escaping, mount scope, inventory parsing, and exact-session lifecycle decisions with mocked CLI responses. The actual Microsoft CLI, guest fixture, and host-to-guest mapping require a Windows run.
