# CLU-E Patch 05G — GitHub launcher and empty remote registration

**Date** 7 November 2026  
**Prerequisite** CLU-E with Patch 05F applied.  
**Patch 05F ZIP SHA-256** `dec1e227dd703423dc1333485bab9459a071b931f4cdb335ef9fd483fe2defcf`

## Changes

- `CLUE-Dashboard.bat` supplies System32 and the standard installed Git and GitHub CLI directories to the dashboard process. The change is scoped to the launcher and its children. Custom installation paths can still come from the inherited PATH.
- GitHub connection accepts a reachable remote with no advertised Git refs. It still verifies the GitHub account, exact checkout, committed local branch, and credential-free remote URL. A populated remote with a missing selected branch is reported separately. Connecting saves the profile without pushing a branch.

## Apply

Close the dashboard process, extract this ZIP into `F:\CLU\CLU` and allow replacements. Start `CLUE-Dashboard.bat` normally and open Configuration.

## Connect existing source to a new empty GitHub repository

Keep `F:\CLU\CLU` as the Target Root for the existing `clue1` profile. If the folder still has no Git repository, initialize it in place and add the chosen GitHub remote. Replace `OWNER/REPO` with the exact repository you intend to connect.

```cmd
cd /d F:\CLU\CLU
git init -b main
git remote add origin https://github.com/OWNER/REPO.git
git status --short
```

Stage only the files intended for Git. Review the staged list with `git diff --cached --name-only` and the staged contents with `git diff --cached`. Keep credentials, local settings with secrets, and generated data out of the commit. Make the first commit locally with `git commit -m "Initial CLU-E source"`.

In **Configuration → Git Sync**, select the same repo and `main`, then click **Test & Connect Repository**. Successful empty-remote registration is shown as **CONNECTED**. Reuse your existing GitHub sign-in or click **Sign in to GitHub** if needed.

Publishing the first branch remains a separate step after review. The normal Sync Git action still expects the remote branch to exist. The empty-remote rule also distinguishes an empty repository from a repository that already has a README commit, another branch, or a tag.

## Verification

The TypeScript build, dashboard suite and mocked Windows GitHub connection scenarios passed locally. The normal launch and GitHub connection still need a live Windows check.

## Rollback

Restore both files from 05F and remove this manifest. Any local commits or saved profile registration remain available for separate review.

## File inventory

| Project-relative file | Before SHA-256 | After SHA-256 |
|---|---|---|
| `CLUE-Dashboard.bat` | `43b5373dd3a5806e5ddd7f1fd4e80de67fd587385f6214ff56b268badc8f679a` | `20c4c121c40eddc0283e39f0a07dd03477b7cef9e337ef0a3d19ef1f4da45d65` |
| `src/integration/git/githubProfileConnection.ts` | `47f525480ded80c7b65605910824b5096819ca5ae94f73432476d53fa60ef40c` | `02084be65f27da5eb446174f28b40e9c0b12da693b98fbdf91609781749c3f70` |

This manifest is an added file. Its own hash is excluded from its table.
