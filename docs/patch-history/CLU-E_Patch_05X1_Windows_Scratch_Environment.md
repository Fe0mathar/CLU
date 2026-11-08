# CLU-E Patch 05X1 — Windows scratch environment diagnostics

The first 05X run on Windows 11 started both pinned fixtures. All four invalid requests were refused before launch. The expected file access checks and the synthetic host environment exclusion check passed in both fixtures. The combined `scratchEnvironmentMatches` check failed in each case, leaving the mismatched values unidentified.

Each fixture now emits `scratchEnvironment`, a fixed map for the ten existing keys. The collector rejects unknown keys and statuses and checks that the map agrees with the aggregate result. The report carries classifications only.

| Classification | Meaning |
| --- | --- |
| `MATCH` | The value passes the existing absolute-path comparison. |
| `MISSING`, `EMPTY`, `RELATIVE` | The value is absent, empty, or lacks an absolute path. |
| `EXTENDED_PATH_ALIAS` | Removing the Windows extended drive-path prefix gives the expected spelling under the existing comparison. |
| `APP_CONTAINER_PROFILE`, `APP_CONTAINER_TEMP` | The value has the shape of an MXC AppContainer profile or its temp directory. |
| `OTHER_PATH` | The absolute path differs from the expected path. |

Microsoft documents AppContainer profile and temp remapping for `LOCALAPPDATA`, `TEMP`, and `TMP`. The two AppContainer classifications describe the path shape only. See [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).

All ten values must still pass the original comparison. The diagnostic retains `proofAuthorization: false` and the existing file and request controls. The Windows launcher uses the verified MXC installation and the normal supervisor request path.
