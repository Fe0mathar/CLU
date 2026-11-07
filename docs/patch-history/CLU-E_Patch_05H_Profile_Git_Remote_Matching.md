# CLU-E Patch 05H — Profile Git remote matching

**Date** 7 November 2026  
**Prerequisite** CLU-E with Patch 05G applied.  
**Patch 05G ZIP SHA-256** `5403b1fa929cc1fd45f3a7501d8df58de77fa57ae57a425a2347bde051239aac`

## What changed

The checkout verifier lists the selected profile's Git remotes and reads each literal local URL with `git config --local --no-includes --null --get-all remote.<name>.url`. It previously parsed combined config keys and values from a regex query. The new check accepts ordinary GitHub HTTPS and SSH remotes with any valid local remote name. The mismatch message distinguishes absent remotes, unreadable configuration, and a different GitHub repository. It shows repository identities without exposing credential-bearing URLs.

The editor retains the attempted repository and branch after a verified selection fails. Connection state stays with the selected Project Profile. Each profile uses its own checkout, saved repository, and branch. GitHub sign-in still uses the Windows host account.

## Apply and verify

1. Close CLU-E. Extract this ZIP into `F:\CLU\CLU` and allow replacements. Restart `CLUE-Dashboard.bat` and press Ctrl+F5.
2. In **Configuration → Git Sync**, select profile **clue1**. Click **List Repositories**, choose **Fe0mathar/CLU** and **main**, then click **Test & Connect Repository**. Use the existing local commit.
3. If CLU-E still reports a mismatch, capture the new message. From `F:\CLU\CLU` run `git config --local --no-includes --get-all remote.origin.url` and verify it prints the exact GitHub URL you configured. Only share URLs without credentials.

The build, dashboard tests, simulated Windows Git output, and literal reads against Git 2.52.0 passed locally. The original native Windows failure remains to be verified on the installation host.

## Rollback

Restore the replaced files from 05G and remove this manifest.

## File inventory

| Project-relative file | Before SHA-256 | After SHA-256 |
|---|---|---|
| `src/integration/git/githubProfileConnection.ts` | `02084be65f27da5eb446174f28b40e9c0b12da693b98fbdf91609781749c3f70` | `2756d707c958eb11bc57e81b9019f95ea031b5660476e0b983084178ab3e47ab` |
| `ui/clue-dashboard/configuration/gitEditor.js` | `0269fcd8a7414f3b63a49ffd4b575c0d8dd37122e34555718df68a688640e8bc` | `3915279f9ada69482f6defb6f7d12b084ac672efe430c0134bbc59c157d9c039` |
| `ui/clue-dashboard/test/profileConnections.test.mjs` | `a866bd86c25504ab6e09286f2fcc1db32e799822e664c4d383c12dc047025978` | `3021240e96d3d5f16703dc96fc3df0f2dea5c77a48a510be71478a7e34c5d080` |

This manifest is an added file. Its own hash is excluded from its table.
