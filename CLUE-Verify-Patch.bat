@echo off
setlocal
title CLU-E patch verification
cd /d "%~dp0" || exit /b 1
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if "%~1"=="" goto interactive
node "%~dp0tools\verify-patch.mjs" %*
exit /b %ERRORLEVEL%

:interactive
node "%~dp0tools\verify-patch.mjs" --offer-commit
set "CLUE_PATCH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %CLUE_PATCH_EXIT%
