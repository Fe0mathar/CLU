# CLU-E P01 Windows Preflight

This patch adds `clue project preflight` to the installation that already has the Dashboard Test Console patch. It reports static local-proof prerequisites for the exact Project Profile selected for startup. It emits one JSON object to standard output. It reads the profile and committed workspace state, inspects local Git, and verifies the installed Windows supervisor and its qualification pins from the current process environment. It uses a temporary database snapshot outside the operating roots to avoid touching live SQLite files. Browser and model live acceptance remain separate checks.

## Apply

1. Close the dashboard and any active CLU-E command. Keep a backup of the files marked `replace` in `CLU-E-P01-Manifest.json`.
2. Extract this ZIP directly into the folder containing `CLUE-Dashboard.bat`. Accept replacement of those files.
3. From the same PowerShell environment you use for governed proof, open the installation folder and run the build.

```powershell
Set-Location 'F:\CLU\CLU'
npm run build
```

## Verify and collect the report

After the build succeeds, run the following in the same PowerShell window. The PowerShell wrapper saves a UTF-8 copy in your temporary directory. If that directory is inside a CLU-E operating root, such as the installation, target, workspace, shadow, profile registry, or dedicated browser profile, choose an existing report directory outside those roots.

```powershell
$report = Join-Path ([IO.Path]::GetTempPath()) ('CLU-E-P01-' + [guid]::NewGuid().ToString('N') + '.json')
$lines = @(node .\dist\src\cli\index.js project preflight)
$preflightExit = $LASTEXITCODE
if ($lines.Count -gt 0) {
    [IO.File]::WriteAllLines($report, [string[]]$lines, [Text.UTF8Encoding]::new($false))
    $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    $result.status
    $result.blockers | Format-Table id, code, action -AutoSize
    Write-Host "Report: $report"
}
Write-Host "Preflight exit: $preflightExit"
```

- `READY_FOR_LOCAL_PROOF_PREFLIGHT` with exit 0 means the reported Windows static prerequisites passed. Native proof execution and live acceptance have their own evidence.
- `BLOCKED` with exit 1 means one or more prerequisite checks need attention. Use `blockers` in the JSON for each code and next action.
- `NOT_WINDOWS` with exit 1 means the report was collected on a different OS. Inspect any local findings and repeat on Windows for the supervisor check.

Check that `profile` names your intended project and generation. On a **disposable test profile**, save a governed document binding, change the bound document without updating the profile, then rerun preflight. The authority check must report the mismatch. Revert the test edit after recording the result. Installation and project paths are included for troubleshooting. Review them before sharing the report.

If CLU-E is its own target, extracting the patch will usually make that checkout dirty. Review the intended changes and establish a clean local revision on the profile's configured branch before using the report as a pass gate. Re-run preflight after any change to the checkout or profile.

If the Windows supervisor check is blocked, use the installation's existing guide in `docs/p2/WINDOWS_EXECUTION_SUPERVISOR.md` to verify the executable and production qualification receipt. Use the four supervisor and qualification variables from that guide in the PowerShell session that runs preflight. A diagnostic receipt has a different scope from a production qualification.

The next authority checkpoint follows `README_v10.md` and `docs/project-profiles/PROJECT_PROFILES_FINAL_ACCEPTANCE.md`. Treat the formal P2 receipt as historical evidence and record the native Windows and live acceptance gates for the successor separately.

## Roll back

Close CLU-E. Restore the files marked `replace` in `CLU-E-P01-Manifest.json` and remove the files marked `add` and the manifest. Run `npm run clean`, then `npm run build` to regenerate `dist` from the restored source. The rollback is limited to the installation files.
