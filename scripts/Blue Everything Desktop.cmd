@echo off
rem Blue Everything Desktop: the tray icon, popups over games and voice, for a PC whose app runs somewhere else.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\desktop.ps1" -Open
