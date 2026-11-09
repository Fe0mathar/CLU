# Project Browser Execution Runtime

**Scope:** dedicated Chrome launch, deterministic page control, WebGPU scenarios and durable evidence

## Runtime boundary

The analysis plane attaches to one pre-authorized DevTools page. It never discovers authority from
ordinary desktop windows and never launches Chrome itself. The host-owned PowerShell launcher
creates or reuses one dedicated process only after its profile, port, target URL, allowed origin and
Project Profile generation match the durable browser state file.

Managed launch, reuse and status verify the Windows Chrome process, its visible window, and its
ownership of the loopback debugging listener. Profile readiness verifies a command return and
separate receipt of its matching Chrome console event. Scenario execution also requires one exact
configured page URL, the original Project Profile generation, and the current mission. A second
eligible tab at the same URL requires the operator to resolve the ambiguity.

## Identity chain

```text
Project Profile record
  -> Project Operation Identity + profileGeneration
  -> Chrome Instance ID
  -> Browser Session ID
  -> Target/Page ID
  -> Browser Execution ID
  -> immutable request/response evidence
```

Every transition validates the complete predecessor identity. Page title or URL alone is not an
identity.

## Target resolution

A pinned Page ID is authoritative while present. Its disappearance produces
`TARGET DISCONNECTED` and requires explicit re-resolution. Without a pin, one exact configured URL
may be selected. If no exact URL matches, exactly one page under an allowed origin may be selected.
Two eligible pages produce `TARGET AMBIGUOUS`; CLU-E does not choose the first.

## Session lifecycle

```text
registered -> active -> parked -> active
                         \-> released/closed
```

A parked or closed session cannot execute. An active registration cannot be silently replaced. A
project switch parks the predecessor before activating the successor and restores the predecessor
on rollback.

## Evidence layout

Each execution directory contains:

```text
request.json
receipt.json
response.json   # only after terminal completion
```

`receipt.json` binds the request and optional response hashes. Reads re-validate schemas, project
identity, generation and file hashes. A crash between durable steps yields explicit invalid or
non-terminal evidence; it cannot yield a fabricated successful response.

Command text is represented only by `commandSha256`. Result summaries and external evidence
references are bounded and secret-scanned before persistence.

## Live acceptance gate

On Windows, the operator must prove:

1. dedicated Chrome executable/profile/port launch;
2. unrelated endpoint refusal;
3. two matching tabs produce `TARGET AMBIGUOUS`;
4. wrong origin is refused;
5. closing the selected page produces `TARGET DISCONNECTED`;
6. one governed command creates one valid request/response pair;
7. Project A can never remain executable after Project B is active.

## Run Test Chrome from the dashboard on Windows

Start the dashboard under the active saved Project Profile. In **Configuration → Chrome / Browser**,
use **CLU-E Managed** with target `http://127.0.0.1:5179/` and allow origin `http://127.0.0.1:5179`.
Save and restart the dashboard if the profile generation changes.

Click **Test Chrome** and keep the dedicated window visible until the result appears. The dashboard
starts the bundled canary page, launches or reuses the dedicated Chrome window, and runs the
reviewed input and WebGPU scenario. A pass includes the three GPU readbacks and execution ID.
The top Chrome bulb reflects the last test for the current dashboard server session. Closing the
test window preserves the verdict. Restart the dashboard server to begin a new test session.

## Run the same scenario from the Windows CLI

1. Launch `CLUE-Dashboard.bat` under the saved Project Profile. In **Configuration → Browser**,
   use **CLU-E Managed** mode and a dedicated local Chrome profile outside the target, workspace
   and shadow directories. Set **Target URL** to `http://127.0.0.1:5179/` and include
   `http://127.0.0.1:5179` in **Allowed Origins**. Save and restart the dashboard if the profile
   generation changes. Close an older dedicated Chrome window if it still holds the configured port.
2. From the CLU-E directory, start the loopback test application and leave its terminal open.

   ```powershell
   node tools/serve-webgpu-canary.mjs
   ```

3. In a second PowerShell terminal in the CLU-E directory, use the actual active profile ID.
   The example uses `clue1`.

   ```powershell
   $scenario = 'tools/browser-scenarios/webgpu-canary.json'
   $sha = (Get-FileHash -Algorithm SHA256 $scenario).Hash
   node dist/src/cli/index.js project browser-run clue1 --scenario $scenario --sha256 $sha --build-id webgpu-canary-1
   ```

4. Read the printed evidence path. The included scenario reloads the test page, uses trusted click,
   text and Enter input, then runs a WebGPU compute dispatch and reads back `42`. A completed run
   contains three measured readbacks, submit-to-readback latency, Chrome and adapter identity,
   console output and a JPEG of the final page. A separate console nonce confirms both DevTools
   directions. A fallback adapter can verify the mechanism. Use the intended Windows GPU for
   performance evidence.

The launcher starts Chrome itself for the command. This CLI route is also available for separately
reviewed browser scenarios against the active profile.

## Use it in an improvement loop

1. **Review and deploy.** Pin the baseline build and candidate revision in the proof workflow. Build
   and serve each sequentially in the test workspace at the same profile URL. Give each build a
   distinct ID exposed by the app. Keep source edits, build commands and deployment in the existing
   project and proof tooling.
2. **Freeze the browser scenario.** Review a `clue-browser-scenario/1` JSON file and retain its
   SHA-256. Its ordered steps support reload, pointer motion, click, wheel, text entry, named keys,
   and JavaScript expressions in the exact main page. Use evaluate steps and bounded console output
   to inspect DOM state, or enable a final screenshot. Start the sequence with a reload for builds
   served sequentially. Use the same file and repetition counts for both builds.
3. **Measure completed work.** The `measure` expression returns
   `{ buildId, webgpuWorkload, metrics: [{ name, unit, value }] }`. Set `webgpuWorkload` from the
   target harness after verifying completed GPU work, for example by observing the expected frame,
   queue completion and result. Discovery of the browser's default adapter is recorded separately.
   Keep the dedicated window visible at a stable size and on the same display. Use app-specific timing
   and correctness metrics, and explicitly account for warmup, build readiness and device loss.
4. **Compare evidence.** Run the original build with `--phase baseline`. Serve the candidate and run
   the same command with its expected build ID and
   `--phase candidate --baseline <baseline-execution-id>`. Comparison checks the mission, profile,
   scenario digest, target URL, Chrome, viewport, adapter, and sample/metric contract. It returns the
   median differences or a reason the runs are incomparable. Exit status 2 indicates completed
   measurements with an incomparable baseline. Metric direction, noise tolerance,
   correctness thresholds and acceptance still belong to the project’s proof contract.
5. **Integrate the agent.** Use the same typed scenario interface as the automation boundary for a
   planning agent. Give it bounded evidence and reviewed scenario digests. Route future autonomous
   runs through the proof coordinator with a host-side browser adapter, frozen build and deployment
   receipts, and the existing verdict rules. This release exposes the operator-run connection,
   evidence and comparison. It provides no automated candidate deploy or proof decision.

Use a test-only browser profile and data. The local DevTools port is a privileged browser control
interface. Review scenario expressions as executable code, and keep credentials out of input data
and optional screenshots. The browser connection is scoped to the configured test page.

[Chrome remote debugging and separate user data directories](https://developer.chrome.com/blog/remote-debugging-port) ·
[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
