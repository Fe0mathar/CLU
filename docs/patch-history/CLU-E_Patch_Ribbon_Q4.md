# CLU-E ribbon and Q4 command console

9 November 2026

## Install

Close CLU-E. This direct-copy patch targets `updated.zip` with `CLU-E_Patch_Q1-SURF-PERF-01_Updated.zip` applied. Extract the patch to a staging folder, then copy its contents into `F:\CLU\CLU`. Allow replacement of the included files. Reopen `CLUE-Dashboard.bat` to rebuild and restart the server, then refresh the dashboard with Ctrl+F5. The patch uses the existing dependencies and preserves installation settings, workspace files and sealed documentation.

## Operator workflow

- The ribbon has a WebGPU CLU-E wordmark with a styled fallback. The green seal animation reveals an abbreviated hash from sealed Status after a short coalescing delay. Hover to inspect the full hash.
- STATUS combines stream and run state. Open it to read the two states separately. GIT, AI, CHROME and CONSOLE run explicit capability checks when opened for the first time or when **Run live check** is selected. An AI check can consume provider usage.
- The icon-only tabs open Dashboard and Configuration. Window Composition lives at the top of Configuration. Book and Metrics are in Q2, Backlog is in Q1, and Proof is in Q4.
- Q4 has a scrollable operational feed above the Master Agent terminal. Enter `/help`, `/status`, `/start` or `/git sync` for program control. Enter plain text to talk to the Master Agent through the configured GPT gateway. The lower pane accepts those CLU-E commands and conversation. The upper pane records real command receipts and retains the sealed operational feed.
- `/start` drives the governed cycle and remains available without GPT. `/git sync` uses the configured Git policy and stays an explicit operator command. The Master Agent can request the governed cycle start after an explicit operator instruction. The agent uses bounded status and recent operational facts as context.

## Readiness interpretation

- GIT green requires verified authorization and reachability for the configured supported remote. The check is read-only. Git publication retains its own preconditions.
- AI green requires a live response from the exact configured model.
- CHROME green requires a dedicated test window and a command/event round trip against the selected DevTools console. Open the dedicated window using the project test-browser setup before running the check.
- CONSOLE checks fixed normal-permission PowerShell and CMD commands and captures their output. Verified shells with pending scoped elevation remain amber. A live approval-bound elevation broker is a separate Windows host setup item.

The Windows readiness probe has a distinct source-fingerprint baseline for this overlay. Source `MATCH` records byte identity of the six pinned inputs. Windows qualification and live connectivity have separate gates.

## Verification

The portable run passed 950 engine self-tests with eight platform-specific skips, 197 dashboard tests and 12 Navigator tests. A disposable Chromium session verified the split console, window composition controls, honest unavailable AI, local-only Git refusal and the `/start` route through `SCREENED`. A configured Windows host is required to verify the real capability checks with its provider credential, remote and dedicated Chrome session.
