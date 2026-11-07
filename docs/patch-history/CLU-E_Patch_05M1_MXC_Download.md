# CLU-E Patch 05M1 — MXC release download

**Applies to** a clean checkout with Patch 05M installed.

The 05M Windows build passed and setup stopped during release metadata validation. The v1.0.1 archive is listed at about 542 MB, above the old 512 MiB limit. The old message combined size, URL, release state and digest into one error.

This patch allows an official asset of up to 1 GiB and gives the transfer up to 15 minutes. It streams the ZIP to the temporary staging directory, checks the exact published length and SHA-256, and requires a valid Microsoft Authenticode signature on the extracted executable. It reports the specific failed stage and the published byte count when available. The archive is obtained from the official release URL with redirects restricted to GitHub's release hosts.

1. Extract the patch ZIP outside the checkout and run **APPLY-05M1.bat**. It verifies the manifest and creates the local commit.
2. In `F:\CLU\CLU`, run **CLUE-Windows-Supervisor.bat**. Send the newest `CLU-E_MXC_SUPERVISOR_DIAGNOSTIC_*.json` from `F:\CLU\release-evidence`.

The setup remains for Windows diagnostics. The native Windows retry is the acceptance check for the release transfer. The patch manifest records exact before and after hashes. Revert the installer-created commit to roll back the hotfix.

- [Official Microsoft MXC release](https://github.com/microsoft/mxc/releases/tag/v1.0.1)
- [Mirror archive size listing](https://sourceforge.net/projects/microsoft-mxc.mirror/files/v1.0.1/)
