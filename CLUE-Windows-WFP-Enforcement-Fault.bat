@echo off
setlocal
call "%~dp0CLUE-Windows-Supervisor.bat" -WfpEnforcementFaultDiagnostic
exit /b %ERRORLEVEL%
