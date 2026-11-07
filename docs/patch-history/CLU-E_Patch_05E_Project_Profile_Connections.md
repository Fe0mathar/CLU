# CLU-E Patch 05E — Project Profile connections

**Date** 7 November 2026  
**Prerequisite** CLU-E with Patch 05D applied.  
**Patch 05D ZIP SHA-256** `03898f91eb88cf67f75a9216bd801085c9bd9d373d66bd439a3cb1863045c599`

## What changed

Configuration now offers GitHub.com repository connection and Windows OpenAI key setup inside a saved Project Profile. GitHub sign-in uses the installed GitHub CLI. The connection checks the account, remote repository, checked-out branch, local repository root and read access through the host Git transport. The profile stores the verified credential-free remote and branch. Manual Sync uses the active runtime profile and refuses a different branch or a stale profile generation.

The GPT card opens a masked Windows prompt. The key is stored in the Windows Credential Manager for the current Windows account. The profile stores a credential reference. **Test connection** probes the exact configured model. **Check saved key** checks credential availability separately.

## Apply on Windows

1. Close the dashboard launcher. Extract this ZIP directly into the CLU-E project directory and allow replacements.
2. Confirm that `git --version` and `gh --version` work in the same Windows session. Use a current GitHub CLI with the Windows credential store.
3. Start `CLUE-Dashboard.bat` and press Ctrl+F5 on the dashboard page.
4. Open **Configuration**, then select a saved Project Profile. For a new profile, the **Target Root** must name the existing local Git checkout for the intended repository. For the current legacy CLU-E target, use the existing **New Profile** flow or the explicit legacy migration command after the configured paths are available.

```powershell
npm.cmd run clue -- project migrate-legacy --confirmation "MIGRATE LEGACY ACTIVE TARGET"
```

Use migration only to register the existing legacy target, once. The migration command prints the separate workspace adoption step when applicable. Profile activation and configuration cutover remain explicit operations.

## Connect and verify

- **Git Sync** → **Sign in to GitHub**. Complete the browser authorization from the Windows sign-in window. In Configuration, choose **List repositories**, pick the matching repository and branch, then click **Test & connect repository**. The registered remote, branch and local checkout path should agree. Registration does not synchronize files or push commits. If the directory came from a ZIP, prepare a matching local Git checkout before connecting it. GitHub CLI can fall back to file-based credentials when its credential store is unavailable. CLU-E refuses that sign-in state.
- **GPT / OpenAI** → **Set / replace API key**. Enter the key in the masked Windows prompt. Use **Check saved key**, then **Test connection**. Expect the configured and effective model to agree when the live check succeeds. Close the native prompt to cancel.
- An already running profile-bound dashboard needs its current saved profile activated and loaded before a changed connection applies to runtime actions. Profile tests work from Configuration independently. The legacy P2 launcher and its Windows readiness report still check the environment key. Profile-bound startup remains a separate cutover. Native Windows execution supervisor qualification remains a separate P2 requirement.

## Verification scope

Portable build and tests cover the dashboard flow, connection guards, credential reference boundary and Git sync. GitHub authorization, the Windows credential prompt and the real OpenAI model probe require a live Windows session.

## Rollback

Restore replaced files from the 05D tree and remove the entries marked Added. A previously saved connection remains in the Project Profile registry and a saved key remains in Windows Credential Manager. The ZIP has no profile or credential data.

## File inventory

| Project-relative file | Before SHA-256 | After SHA-256 |
|---|---|---|
| `selftest/project-git-readiness.test.ts` | `919c201eff4b57a2f259d4d577e851acc4d472080a934a77bfa092770c029ca4` | `df5dec1812a282ddeb0f2e5c24af415f9c254b7afaa2c9160cb33e1d29923cb2` |
| `selftest/project-profiles-api.test.ts` | `927c0c5b109567acf311d6539744838ed101f2caee48043a20a0f0797849f3f1` | `35c945976b91416d38e8e3247dcae4b5aae0c0f441b9ecab183af13180385344` |
| `selftest/windows-openai-credential.test.ts` | Added | `7e59ae869d524360bbe6935f5da777b6f7e1aa67922ecf6e6166a6c5fab3ec48` |
| `src/ai/gateway/modelGateway.ts` | `fb52be57b01a00479172ac1765e53dca8dbeb844fbe5f0b5bccdf03d0a167aa5` | `56e0e1787b58c22ca8e6b38420ec5a439050de4a6cc743a30540600324b92fd3` |
| `src/control/projectProfiles/gitReadiness.ts` | `351df64c5c33da0400c2a57c506c80cc9895196c82d09ba904a25ae9dacf8e81` | `2a1989efb7a10583283af9f2dad1bacf007b1648b3aab10eaca2ab0100174a3f` |
| `src/control/projectProfiles/windowsOpenAiCredential.ts` | Added | `1d27a00525d1316feff9a601cd99f6ce99ec63c372c5f34e0ce9264cb2942433` |
| `src/daemon/clueDashboardServer.ts` | `cfda969b6900b1a74fbed8f7306392a6b89e319d6f488d7083c16ffd88196920` | `b1d5e62d3c8384a7c431f2343b543d2b1eff2bac545c3d5fe014b92d4508e187` |
| `src/daemon/projectProfilesApi.ts` | `b6ab7f59565e097ea756bef37da61180bb654f483457efbb6865b85afb28552b` | `982d601757e5ca1fa9d9d42a0754fbb9ed42e3f02cadddf35899de5967c85a24` |
| `src/integration/git/githubProfileConnection.ts` | Added | `47f525480ded80c7b65605910824b5096819ca5ae94f73432476d53fa60ef40c` |
| `src/integration/git/manualGitSync.ts` | `800e3d4cdce0d11fe172299632025311abfd1d9d50f64f42ed15439c93f30ff2` | `fcc33c84b456dcd167c445c69be5cfe2759f8d24bd23c77a4afc2152393328f0` |
| `ui/clue-dashboard/configuration/actionContracts.js` | `ac4122be5accc195fee0626b13f7171648126ab19eadea497f41a31fa69886ee` | `94f53250d3727a98c8e6bdfae726a9e62391e08e3d2b875096923d4f1032b7a9` |
| `ui/clue-dashboard/configuration/configurationPanel.js` | `6c75f30b967aa3f24ad81c8b1b99b30ab564cd2afc010adbf1008ff5467542ed` | `0ced20679fb0f8f731c82a74fabedeb9c20a95118029b991cda9a2dde5d27aff` |
| `ui/clue-dashboard/configuration/configurationState.js` | `3978ae6360af15460bd06b2b6116b8431ffcacd66780104a61edf7bbb523b89a` | `461f98abf5b3e2ec124b85edeec0cb71f611ed40c76083f5cb05801a500a1ccd` |
| `ui/clue-dashboard/configuration/gatewayEditor.js` | `f0c7fbd20d03f4115cc7c85a31970fb7e57fde60448ca24e442f9304dd3419f4` | `8d06a86edc26a6a0861d0ca65dd5b23224c4aff14a8fe04aa7c861e0051ac75b` |
| `ui/clue-dashboard/configuration/gitEditor.js` | `b560e12865482f78b6ce815e68f1bccd73802c09b7ffb77c9075b22e44b96b64` | `0269fcd8a7414f3b63a49ffd4b575c0d8dd37122e34555718df68a688640e8bc` |
| `ui/clue-dashboard/test/profileConnections.test.mjs` | Added | `a866bd86c25504ab6e09286f2fcc1db32e799822e664c4d383c12dc047025978` |

This manifest is an added file. Its own hash is excluded from its table.
