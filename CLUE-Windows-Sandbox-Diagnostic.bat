@echo off
setlocal
node "%~dp0tools\p2-windows-sandbox-diagnostic.mjs" %*
set "CLUE_SANDBOX_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %CLUE_SANDBOX_EXIT%
