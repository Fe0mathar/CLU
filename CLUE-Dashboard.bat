@echo off
setlocal
REM ==========================================================================
REM  CLU-E Dashboard launcher
REM
REM  1. Rebuilds from source every launch, so freshly-copied engine code is
REM     never run stale (the old launcher only built on the very first run).
REM  2. Offers to use the saved active Project Profile when startup is legacy.
REM  3. Migrates the workspace schema via an idempotent writer. The dashboard
REM     opens READ-ONLY (so it never locks out a concurrent recognize) and a
REM     read-only connection cannot create projection tables, so a writer must
REM     apply any pending schema migration first. `init` is safe to repeat.
REM  4. Opens the dashboard after the loopback server is listening.
REM ==========================================================================

title CLU-E Dashboard
cd /d "%~dp0" || exit /b 1

REM Use the installed Windows tools even when Explorer inherited an older PATH.
if exist "%SystemRoot%\System32\where.exe" set "PATH=%SystemRoot%\System32;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%ProgramFiles%\GitHub CLI\gh.exe" set "PATH=%ProgramFiles%\GitHub CLI;%PATH%"

if not exist "node_modules\.bin\tsc.cmd" (
  echo Dependencies are missing. Run npm ci in this folder, then reopen this launcher.
  pause
  exit /b 1
)

echo [1/4] Building CLU-E from source...
call npm run build
if errorlevel 1 (
  echo.
  echo Build failed - see the errors above.
  pause
  exit /b 1
)

echo [2/4] Checking dashboard startup profile...
node dist\src\cli\index.js project prepare-dashboard
set "CLUE_PROFILE_EXIT=%ERRORLEVEL%"
if "%CLUE_PROFILE_EXIT%"=="2" (
  echo Startup canceled.
  exit /b 2
)
if not "%CLUE_PROFILE_EXIT%"=="0" (
  echo.
  echo Startup stopped. Review the profile error above.
  pause
  exit /b %CLUE_PROFILE_EXIT%
)
if exist "config\project-profiles.yaml" set "CLU_SHOW_HOST_CONSOLE=1"

echo [3/4] Migrating / initialising the workspace ^(idempotent^)...
node dist\src\cli\index.js init
if errorlevel 1 (
  echo.
  echo Init failed - see the errors above.
  pause
  exit /b 1
)

echo [4/4] Starting CLU-E dashboard on http://127.0.0.1:47900/ ...
node dist\src\cli\index.js console dashboard --port 47900 --open
set "CLUE_DASHBOARD_EXIT=%ERRORLEVEL%"

pause
exit /b %CLUE_DASHBOARD_EXIT%
