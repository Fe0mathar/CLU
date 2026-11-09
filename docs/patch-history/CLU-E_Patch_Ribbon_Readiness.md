# CLU-E ribbon typography and startup readiness

9 November 2026

## Apply

Close CLU-E. Extract `CLU-E_Patch_Ribbon_Readiness.zip` to a staging folder and copy its contents into `F:\CLU\CLU` over the existing SURF and Ribbon/Q4 patches. Reopen `CLUE-Dashboard.bat` and refresh the browser with Ctrl+F5. The patch uses the installed dependencies and rebuilds with the normal launcher.

## Operator changes

- CLU-E uses a smaller angular wordmark. The compact green, tracked science-fiction seal still reveals an abbreviated hash from sealed Status.
- A dashboard page opening starts one live check for each capability. A bulb click uses that opening’s result. Green opens details. Other states open the matching Configuration card. STATUS continues to show stream and run details.
- AI opens GPT API Key, Git opens Git Sync, Chrome opens Dedicated Test Chrome, and Console opens PowerShell / Host. The card receives keyboard focus after Configuration loads.
- Saved AI and Git check outcomes and timestamps are scoped to the active profile. A previous result is displayed as history. Current bulb color comes from the opening’s live result.
- For the legacy target, choose **Set / replace active target API key** in the AI card to save the key once in Windows Credential Manager. A key supplied by the current launcher remains an override. Saved v3 Project Profiles continue to use their credential references and Windows key storage.
- GitHub sign-in uses the existing Windows GitHub CLI credential store. The Git check verifies that sign-in and read access to the registered remote. Git publication remains an explicit `/git sync` action.

Reopen the dashboard after changing a connection. The automatic AI verification can consume a small provider request. Native Windows credential entry and live services require the configured Windows host.
