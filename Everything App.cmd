@echo off
REM Double-click this to start Everything and open it.
REM Everything else - installing dependencies, building the app, starting the
REM server and the agent - is handled by start.ps1.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" -Open
if errorlevel 1 (
  echo.
  echo Something went wrong. The window will stay open so you can read it.
  pause
)
