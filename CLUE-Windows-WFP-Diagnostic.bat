@echo off
setlocal
call "%~dp0CLUE-Windows-Supervisor.bat" -WfpPairedDiagnostic
exit /b %ERRORLEVEL%
