@echo off
REM Double-click this to run setup.ps1 without fighting PowerShell's default
REM execution policy. See README.md "Quick install" for what it does.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
