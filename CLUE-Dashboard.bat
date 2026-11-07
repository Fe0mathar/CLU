@echo off
setlocal
REM ==========================================================================
REM  CLU-E Dashboard launcher
REM
REM  1. Rebuilds from source every launch, so freshly-copied engine code is
REM     never run stale (the old launcher only built on the very first run).
REM  2. Migrates the workspace schema via an idempotent writer. The dashboard
REM     opens READ-ONLY (so it never locks out a concurrent recognize) and a
REM     read-only connection cannot create projection tables, so a writer must
REM     apply any pending schema migration first. `init` is safe to repeat.
REM  3. Serves the read-only dashboard on http://127.0.0.1:47900/.
REM
REM  Once your workspace is stable you may comment out the build and/or init
REM  steps for a faster launch; re-enable them after copying in updated code.
REM ==========================================================================

title CLU-E Dashboard
cd /d %~dp0

REM Use the installed Windows tools even when Explorer inherited an older PATH.
if exist "%SystemRoot%\System32\where.exe" set "PATH=%SystemRoot%\System32;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%ProgramFiles%\GitHub CLI\gh.exe" set "PATH=%ProgramFiles%\GitHub CLI;%PATH%"

echo [1/3] Building CLU-E from source...
call npm run build
if errorlevel 1 (
  echo.
  echo Build failed - see the errors above.
  pause
  exit /b 1
)

echo [2/3] Migrating / initialising the workspace ^(idempotent^)...
node dist\src\cli\index.js init
if errorlevel 1 (
  echo.
  echo Init failed - see the errors above.
  pause
  exit /b 1
)

echo [3/3] Starting CLU-E dashboard on http://127.0.0.1:47900/ ...
start "" http://127.0.0.1:47900/
node dist\src\cli\index.js console dashboard --port 47900

pause
