@echo off
REM Double-click this once to put an "Everything" icon on your Desktop and in
REM the Start Menu. After that you can ignore this folder entirely.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1"
pause
