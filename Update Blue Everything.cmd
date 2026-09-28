@echo off
REM Double-click this to update to the newest release. Your data is backed up
REM to the backups folder first, and nothing of yours is changed.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" -Open
pause
