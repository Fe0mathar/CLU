@echo off
setlocal
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
node.exe "%~dp0tools\p2-windows-candidate-comparison.mjs" %*
set "CLUE_CANDIDATE_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %CLUE_CANDIDATE_EXIT%
