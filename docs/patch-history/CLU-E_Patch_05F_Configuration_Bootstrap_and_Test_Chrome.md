# CLU-E Patch 05F — First Project Profile and visible test Chrome

**Date** 7 November 2026  
**Prerequisite** CLU-E with Patch 05E applied.  
**Patch 05E ZIP SHA-256** `99fd0d7b6f2f927109dc7c0c34b598e9dc929afff926a90e32b3ee46c0f0d628`

## What changed

- **Project** can prepare the first saved profile from installation defaults. The backend resolves the supplied directories before preparing the draft. Save writes a profile explicitly. A new profile uses the installation credential default and keeps its own authority and connection settings.
- **Project Authority**, **PowerShell / Host**, and **Chrome / Browser** show guidance before a profile exists. Their editors appear when you prepare or select a profile. Project Authority binds governed Markdown files and checks their SHA-256 hashes. Metric Catalogue JSON imports remain in the separate Metric Catalogue section.
- **Metric Catalogue** selects the canonical catalogue by default and offers a direct way to restore it after a preview.
- **PowerShell / Host** shows the verified executable, script, and handshake details after Test Connection. The host continues to exchange structured commands and results through its protocol.
- **Chrome / Browser** can open and verify a real, dedicated Windows desktop Chrome window using the profile's saved debugging port, profile directory, and target URL. The verification writes a fixed message to DevTools Console using Chrome's debugging protocol.

## Apply and check

1. Close the dashboard launcher. Extract the ZIP contents into the CLU-E project directory and allow replacements. Restart `CLUE-Dashboard.bat` and press Ctrl+F5.
2. In **Configuration → Project**, click **Create New**. Enter an existing target directory and separate workspace and shadow paths. Click **Resolve & Prepare**, then **Save**. Profile-bound startup and live activation still depend on the launcher mode.
3. In **Project Authority**, select the appropriate `.md` paths for Target Description, Master Benchmark, and Project Intent. Save the profile after editing.
4. Start your development server. In **Chrome / Browser**, choose **CLU-E Managed**, enter its URL, and ensure the origin is on the allowlist. Save the profile, then click **Open Test Chrome**. Use a separate debugging port per concurrently open test browser. If you changed a profile whose dedicated Chrome window is still open, close that window before opening the new generation.
5. In the dedicated Chrome window, press F12 and open **Console**. A successful launch and connection should show `[CLU-E] Dedicated browser connection verified`. If needed, leave DevTools open and click **Open Test Chrome** again to repeat the probe on the same matching window.
6. In **PowerShell / Host**, click **Test Connection** after the configured workspace, shadow, and browser profile directories are present. Expand **Host handshake details** to review the result.

The portable build and tests cover draft preparation, save, authority binding, host readiness and browser targeting. The Windows PowerShell parser and desktop launch require a live Windows check.

## Rollback

Restore the replaced files from the 05E tree and remove this manifest. Profiles saved in the registry can be reviewed separately.

## File inventory

| Project-relative file | Before SHA-256 | After SHA-256 |
|---|---|---|
| `scripts/launch-test-browser.ps1` | `ace14eec11f7f7426e6217395b685fe82d9c6c9c68d1853e92867ad789437302` | `c0619d3448e60e6e5e83f66c87f2f7cd92ee19fa78587a02aad70df0b9f04697` |
| `selftest/project-profiles-api.test.ts` | `35c945976b91416d38e8e3247dcae4b5aae0c0f441b9ecab183af13180385344` | `7ae4159dc43ac8f581e5fcbc0bbd37e03479e9c6741f06d626890fcc5aa4f0a3` |
| `src/control/projectProfiles/browserReadiness.ts` | `7e4af3288f346ebc7af3a84419c174eb843ea63621b2bf68a398785adaccb365` | `32b6e4226e7948bff93f208ddcccf466c5b21898213edc5774c04017bf15f14c` |
| `src/control/projectProfiles/profileDraftPreparation.ts` | `9fd719f87dde151be97f5f92b8714e10eb6eb1ea581c79f615bd2ae821aae6bc` | `573e6eef6ae3d2da038c2de55c5373b71de8a1334ae43a2fa4605a025893979c` |
| `src/daemon/projectProfilesApi.ts` | `982d601757e5ca1fa9d9d42a0754fbb9ed42e3f02cadddf35899de5967c85a24` | `e31e9769a99be79ce60a158dc4e1fe47a980125136b7552506985f138f7e846d` |
| `ui/clue-dashboard/configuration/actionContracts.js` | `94f53250d3727a98c8e6bdfae726a9e62391e08e3d2b875096923d4f1032b7a9` | `1d01a46830bb70ef5bed0b6e83cd1ce53f6b13041e7284b8f309d5f7c9c231f9` |
| `ui/clue-dashboard/configuration/authorityEditor.js` | `d8d465f25e217c57c4b1ac617edd541b42e3145ab755c434450a9659860d5e91` | `88e1cd0a238710c7a0a21bd647e82161a2a4829d3174db997a9cb66e4a1339f3` |
| `ui/clue-dashboard/configuration/browserEditor.js` | `24fdf832fe24ab501ddb23e6912a87d0245615a4f7865c5340f27335ed251573` | `d9f27505365f557ed18f47e839588aee36b2d84474e95aac9b83658e2e82f93f` |
| `ui/clue-dashboard/configuration/configurationPanel.js` | `0ced20679fb0f8f731c82a74fabedeb9c20a95118029b991cda9a2dde5d27aff` | `b258cfba8b6ab8d2176728fb7db49fe2e0d01d8452815956b8aaa688e4841901` |
| `ui/clue-dashboard/configuration/configurationState.js` | `461f98abf5b3e2ec124b85edeec0cb71f611ed40c76083f5cb05801a500a1ccd` | `51f094dda4fffc330b53b29cc31eaa5f1282bc4b6ab0a4b856e9d45c71f8acb1` |
| `ui/clue-dashboard/configuration/hostEditor.js` | `d139ae7c365dfda1bef6485d1aaf125b71344ff546e9eb96a3bc860cc6fc717a` | `6094b12011bb78e1e5b46fc79980683f4f5dbfaea37cc81d4f74056513d9ea68` |
| `ui/clue-dashboard/configuration/projectEditor.js` | `7f44919479eddb92bfccf1228d1933267b6f44db27689c007f2feaea527f451b` | `e9379b8e3bba2f148eea632041ea2a521f6d1f4f91b5f16a7782158a3ec911fa` |
| `ui/clue-dashboard/test/configurationState.test.mjs` | `7bde1b5ea8372ebe8d1b204a397b447f8fb933c53f0f565186ba2a89b906e81c` | `3bcd207cc091b77fa03262f98ceb96072a95d8620982e5d347eeef94458e0885` |

This manifest is an added file. Its own hash is excluded from its table.
