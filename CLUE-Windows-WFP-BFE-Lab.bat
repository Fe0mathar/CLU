@echo off
setlocal
call "%~dp0CLUE-Windows-Supervisor.bat" -WfpPairedDiagnostic -WfpBfeLab
exit /b %ERRORLEVEL%
