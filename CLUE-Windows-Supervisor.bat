@echo off
setlocal
title CLU-E Windows proof supervisor setup
cd /d "%~dp0"
set "PATH=%SystemRoot%\System32;%PATH%"
set "CLUE_PWSH=pwsh.exe"
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "CLUE_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
"%CLUE_PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\windows-supervisor\Setup.ps1" %*
set "CLUE_EXIT=%ERRORLEVEL%"
echo.
if not "%CLUE_EXIT%"=="0" echo CLU-E supervisor setup stopped. Read the message above.
pause
exit /b %CLUE_EXIT%
