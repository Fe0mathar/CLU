@echo off
setlocal
title CLU-E live Windows candidate proof
if "%~3"=="" (
    echo Usage: %~nx0 "opening-report.json" "proof-contract.json" "candidate-patch.json" ["offline-npm-cache"]
    exit /b 2
)
set "CLUE_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%CLUE_PWSH%" set "CLUE_PWSH=pwsh.exe"
"%CLUE_PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\windows-supervisor\RunReviewedOpeningBaseline.ps1" -Candidate -OpeningReport "%~1" -ProofContract "%~2" -PatchManifest "%~3" -OfflineCache "%~4"
set "CLUE_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %CLUE_EXIT%
