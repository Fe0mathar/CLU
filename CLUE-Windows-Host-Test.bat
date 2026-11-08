@echo off
setlocal
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
node.exe "%~dp0tools\p2-windows-host-test.mjs" --approved-dashboard-tests %*
set "CLUE_HOST_TEST_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %CLUE_HOST_TEST_EXIT%
