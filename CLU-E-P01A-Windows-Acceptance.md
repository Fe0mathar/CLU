# CLU-E P01A Windows acceptance fixes

Apply this overlay to the clean P01 baseline `209878e626577171a4c4e6f48558b54de47896c0`. It fixes the two dashboard restart tests so their SQLite handles close before their temporary files are removed. The proof broker now preserves the bounded native refusal code when the supervisor supplies one. The acceptance runner retains bounded, redacted TAP failure blocks alongside its log tails.

The six failures in the supplied Windows log were two SQLite cleanup failures and four native proof failures. The native runtimes were about 12 to 14 seconds, consistent with the production supervisor timing out while waiting for a live registration session. The saved supervisor executable and qualification pins satisfy the static preflight. The reviewed Windows release launcher starts the live guardian for execution.

## Apply and commit

1. Close CLU-E and any active CLU-E command. Back up the files listed in `CLU-E-P01A-Manifest.json`.
2. Extract this ZIP into the folder containing `CLUE-Dashboard.bat`, replacing the files listed in the manifest.
3. From normal Windows PowerShell, run the build and the focused tests.

```powershell
Set-Location 'F:\CLU\CLU'
npm.cmd run build
node --test --test-concurrency=1 dist/selftest/dashboard-startup-binding.test.js dist/selftest/windows-execution-supervisor.test.js dist/selftest/windows-verification-tools.test.js
```

After the focused tests pass, stage and review just the overlay files.

```powershell
$patch = Get-Content -LiteralPath .\CLU-E-P01A-Manifest.json -Raw | ConvertFrom-Json
$files = @($patch.files.path) + @($patch.metadataFiles)
git add -- $files
git diff --cached --check
git diff --cached --stat
```

Once the staged changes match the overlay, make a local commit. The reviewed launcher tests a clean isolated checkout of the committed `HEAD`.

```powershell
git commit -m "Fix P01 Windows acceptance teardown and diagnostics"
git status --short --branch
```

## Run the reviewed Windows gates

From your normal Windows account, run the existing launcher.

```powershell
.\CLUE-Windows-Reviewed-Release.bat
```

Review the displayed scope and source commit. The launcher asks for `QUALIFY AND RELEASE` and requests Windows elevation for the pinned guardian. It runs the full suite and Project Profiles matrix in an isolated checkout. Keep the launcher open until it reports the result.

Send the `CLU-E_WINDOWS_REVIEWED_RELEASE_*.json` identified by the launcher. On success, retain the `*.project-profiles-acceptance.json` and native proof test logs from its release evidence directory. If the launcher blocks, send the named blocker and the report it produces. Keep v9 active while the Windows and separate live acceptance gates are being collected.

## Roll back

Before committing the overlay, restore the backed-up source files and remove this guide and the P01A manifest, then rebuild. If the overlay has been committed and needs to be rolled back, review the local commit and revert it as a separate Git change. This overlay changes source, diagnostics, and tests.
