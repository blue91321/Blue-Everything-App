@echo off
REM Double-click this once to make Everything start whenever you log in.
REM Double-click it again to turn that off.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-autostart.ps1" -Toggle
pause
