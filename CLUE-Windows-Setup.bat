@echo off
setlocal
title CLU-E Windows setup
cd /d "%~dp0"

if exist "%SystemRoot%\System32\where.exe" set "PATH=%SystemRoot%\System32;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%ProgramFiles%\GitHub CLI\gh.exe" set "PATH=%ProgramFiles%\GitHub CLI;%PATH%"
set "CLUE_PWSH=pwsh.exe"
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "CLUE_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
"%CLUE_PWSH%" -NoLogo -NoProfile -File "%~dp0scripts\clue-windows-setup.ps1"
set "CLUE_SETUP_EXIT=%ERRORLEVEL%"
echo.
echo CLU-E Windows setup exited with code %CLUE_SETUP_EXIT%.
pause
exit /b %CLUE_SETUP_EXIT%
