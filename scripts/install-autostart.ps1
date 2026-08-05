<#
.SYNOPSIS
  Runs the Everything App automatically when you log in.

.DESCRIPTION
  Registers a Scheduled Task that runs scripts\start.ps1 at logon, hidden.

  A Scheduled Task rather than a Startup-folder shortcut because it runs without
  a visible console window, can be delayed until the network is up, and can be
  inspected and disabled from Task Scheduler like anything else.

  Runs as the current user only — no admin rights needed and no elevation, which
  matters for something that watches your foreground window all day.

.EXAMPLE
  .\scripts\install-autostart.ps1
  .\scripts\install-autostart.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch]$Remove,
  # For the double-clickable shortcut: on if it's off, off if it's on.
  [switch]$Toggle,
  [int]$DelaySeconds = 30
)

$ErrorActionPreference = 'Stop'

$taskName = 'EverythingApp'
$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start.ps1'

if ($Toggle) {
  $Remove = [bool](Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
}

if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Everything will NO LONGER start automatically when you log in.' -ForegroundColor Yellow
  } else {
    Write-Host "It wasn't set to start automatically."
  }
  exit 0
}

if (-not (Test-Path $startScript)) { throw "Cannot find $startScript" }

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`"" `
  -WorkingDirectory $root

# A short delay lets the network and OneDrive settle before the server binds and
# opens the database.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT$($DelaySeconds)S"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

# Interactive, so it runs in your session and can raise toasts you actually see.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Everything App: attention-aware nudge server and Windows agent.' `
  -Force | Out-Null

Write-Host "Everything will now start automatically when you log in (after ${DelaySeconds}s)." -ForegroundColor Green
Write-Host 'To turn this off again, double-click "Start Automatically.cmd" a second time.'
