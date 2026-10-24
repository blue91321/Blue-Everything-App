@echo off
rem Puts a "Blue Everything Desktop" icon on the Desktop and in the Start Menu. Shipped in the desktop app's zip as "Create Desktop Icon.cmd".
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\desktop.ps1" -Shortcut
