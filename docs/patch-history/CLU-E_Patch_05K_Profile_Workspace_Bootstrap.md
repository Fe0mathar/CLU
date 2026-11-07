# CLU-E Patch 05K — Project Profile workspace bootstrap

**Applies to** the CLU-E tree through Patch 05J. The activation report showed `clue1` saved at generation 6. The dashboard reported `legacy-v2`, and opening the exact saved workspace read-only failed because its database directory did not exist.

## What changed

| Area | Change |
|---|---|
| Native workspace | `project init` previews one saved generation. The exact confirmation initializes its workspace, establishes its SQLite ownership and registers the founding mission. Existing ownership and durable state are checked before opening a writer. |
| Profile identity | A profile-bound runtime uses the registered Project ID, including when its checkout folder has a different name. |
| Cutover | `project cutover-v3` verifies the exact saved generation, profile validation, workspace ownership and mission before publishing the startup selector. Its confirmation now includes the generation and 12 digest characters. |
| Dashboard | Clicking **Activate** before a successful validation displays `PROJECT_VALIDATION_REQUIRED`. Profile-bound startup through `CLUE-Dashboard.bat` enables the PowerShell activity window. |
| Local Git | The local startup selector and its byte-exact installation backups are ignored by Git. |

## Apply and initialize

Close the running dashboard and extract the ZIP into `F:\CLU\CLU`. Review and commit the patch files before the readiness check, which requires a clean Git worktree. Then run these commands in CMD.

```cmd
cd /d F:\CLU\CLU
npm run build
node .\dist\src\cli\index.js project init clue1
```

Review the reported workspace and database paths. Copy the exact `confirmation` value into the command below. The confirmation is specific to the saved generation shown in the preview.

```cmd
node .\dist\src\cli\index.js project init clue1 --confirmation "PASTE THE EXACT CONFIRMATION HERE"
node .\dist\src\cli\index.js project readiness clue1 --operation local-proof
```

The successful initialization receipt includes the profile generation, workspace ownership origin and mission identity. A refusal for an existing unowned or conflicting database calls for workspace diagnosis before a retry.

## Startup cutover

Workspace initialization and startup cutover are separate operations. After the profile-bound readiness check succeeds and the operator elects to switch startup mode, review the [Configuration-v3 runbook](../project-profiles/PROJECT_PROFILES_CLI_AND_CUTOVER.md). Confirm the current saved generation and run `project cutover-v3` with its state-bound phrase. Then launch `CLUE-Dashboard.bat` and verify `project active`. The legacy P2 setup and closure runbook serve the separate legacy runtime and authority lane.

The shipped dashboard hosts one runtime per process. **Activate** requests a live switch through a runtime manager. The supported path in this installation is an explicit startup cutover followed by a restart.

## Verification

The CLI smoke test reproduced a missing database, initialized the confirmed profile workspace, repeated initialization, and reopened the same profile read-only. Workspace and cutover tests used the scratch Linux SQLite compatibility adapter. Windows startup and workspace initialization still need verification on the installation host.

## Rollback

For a completed startup cutover, run `project rollback-v3 --confirmation "DISABLE PROJECT PROFILE STARTUP"` and restart. To revert the patch files, restore the prior versions listed below and remove the listed additions. Retain the native workspace, registry history and installation backup.

## File inventory

| Project-relative path | Action | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `.gitignore` | Replaced | `e64c0554018b7b0e7768977ec32cb84846c21e96a06880a68d50bd1ea067d908` | `86421549eb826c61c30e9cda2fbb39683eb02b3682d036b732b6cc523865ea9c` |
| `CLUE-Dashboard.bat` | Replaced | `20c4c121c40eddc0283e39f0a07dd03477b7cef9e337ef0a3d19ef1f4da45d65` | `50da2f04c206edbe51ec5215ea5a4064182cf3803696d944eb3476642f41f997` |
| `docs/project-profiles/PROJECT_PROFILES_CLI_AND_CUTOVER.md` | Replaced | `9d29fc57f09b3011d2a04935d86d7f94fa5ddfff08ca98aea78c343a05f6536a` | `8ee0eedf25936c0262668a8be2ae8faa2e66584a53f5725b67eeed3ec5fd00f0` |
| `selftest/command-authority.test.ts` | Replaced | `32b5f94e7480765c27af280bdfb3d693c55f9c5a593e1511b4649dbeba31196f` | `1c51074811f9b3727b626ba6f9785d5c9533b47f87e0305b59201b149eaa8e80` |
| `selftest/project-cli.test.ts` | Replaced | `07c2db7ba4cc51bc72db49bec93ed32cff62a53ce6b51892f2321f283824df65` | `ec80303a390709c2a9e40e9dbbb4056cf53e6f921cbb297eae47b2c1c508c659` |
| `selftest/project-profile-runtime.test.ts` | Replaced | `50d2563d3e98b6d5a24e6c1ca53a4deb2713e4aea1911bd7d301111ecae121cd` | `9fd9960debce4216bda5873d0a30830e68c521c241ee918d08773ce1941218dc` |
| `selftest/project-profile-startup.test.ts` | Replaced | `edcbeaa1ffe313e8777c7f7a3baca2f469924ad18fd93c8d2e38fbdfdd3d2735` | `86fafad2659558b22aa4cb0fd9294ac4454433c75ebc2882ed70bbb1db4919ad` |
| `selftest/project-workspace-bootstrap.test.ts` | Added | `—` | `67978e02e13aef974aa8d436644d2b0519ed631975f56cf8f3ce348b1bc2cfce` |
| `src/cli/commandAuthority.ts` | Replaced | `32ab0851863657f8b32c5df9f21906e22982388cee46c245b6f3169e0dd46c94` | `088b092d50f9f2b8b182b49f9c15ce94f0d79056fc8693b9e1571fb2a2b80dfa` |
| `src/cli/commands/initCommands.ts` | Replaced | `20b1eff038f96f407f75b940723f38c3c264fa62f3efd83f7d2ded3602246d70` | `5ef672d8fd411d8a3e4db785b05efc0aa46eaa37308c526e735e4e54595264ed` |
| `src/cli/commands/projectCommands.ts` | Replaced | `0b4baec62c4c2b1806326f82ba1ac33d87ebd5088c9cdd1e9698fc1295aedb2b` | `bada5883e4a896766db8272093d5f5940fe2653d7e81aab27618b380f8dc9297` |
| `src/control/projectProfiles/profileRegistry.ts` | Replaced | `9f1ed613c59b01bca307036b3a5689b3ed6aeb141588367bbed108ccfc22ec04` | `780695ea3b5bf4284794e0d7b901dfa82a0635e36556cf9ad0163a7905fea5c0` |
| `src/control/projectProfiles/projectProfileStartup.ts` | Replaced | `d2d31592a124e7fd956893a4afc2b2eafcbc06ec486cc3a169d3984c74eec6d0` | `71ead45c72324c208fb1f1bdd5af5548a79b43333364644efd8c9019a6d9d636` |
| `src/control/projectProfiles/projectWorkspaceBootstrap.ts` | Added | `—` | `db9f7158733a12aa54b50b040d660e319f03f185d03a5ac695924a4a848c8f9c` |
| `src/control/runtime.ts` | Replaced | `9859146c88bdd9f34b3ffaa51213351721c18e99636f4a9ed787d82b1730642d` | `c05d2aa5081af0cca78a6184c5d178b3b59e3a34d56cdb3c26d2dd101b119734` |
| `ui/clue-dashboard/configuration/configurationPanel.js` | Replaced | `83caf8654012e21e94f5c94ab71c3fdd95abb70454a888adcd1ee4146a82d91e` | `fa833c1476faa83d394efeb6133c2d2199d277a720705e5700969634625f11fb` |
| `ui/clue-dashboard/test/profileConnections.test.mjs` | Replaced | `3021240e96d3d5f16703dc96fc3df0f2dea5c77a48a510be71478a7e34c5d080` | `2977f7094cee90d4b1401132353dc2bb63c47caee5194a6192a4bd465793987b` |

The patch-history manifest is also added. Its own hash is excluded from the table.
