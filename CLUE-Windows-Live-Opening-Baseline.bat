@echo off
setlocal
title CLU-E live Windows opening baseline
set "CLUE_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%CLUE_PWSH%" set "CLUE_PWSH=pwsh.exe"
"%CLUE_PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\windows-supervisor\RunReviewedOpeningBaseline.ps1"
set "CLUE_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %CLUE_EXIT%
