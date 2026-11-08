@echo off
setlocal
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
call "%~dp0CLUE-Windows-Supervisor.bat" -GovernedWorkloadDiagnostic
exit /b %ERRORLEVEL%
