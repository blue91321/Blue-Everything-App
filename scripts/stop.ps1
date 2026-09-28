<#
.SYNOPSIS
  Stops the Blue Everything server and agent, and the Suwayomi it started.

.DESCRIPTION
  Finds them by command line rather than a PID file, so it still works after a
  reboot, a crash, or a stray copy started by hand.

  Suwayomi goes too. The tray icon is what says Blue Everything is running, and
  a JVM left serving manga sources after the icon has gone is a running app
  with nothing on screen admitting it. The server stops it on a clean shutdown,
  but this script force-kills the server, so no shutdown hook ever runs.

.PARAMETER KeepSuwayomi
  Leave Suwayomi running. For restart.ps1: the icon is back within seconds, and
  the server adopts the JVM rather than spending most of a minute starting one.
#>
[CmdletBinding()]
param(
  [switch]$KeepSuwayomi
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Matching on the project path avoids killing unrelated node processes — there
# are usually several on a dev machine.
$escaped = [regex]::Escape($root)
$processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped }

foreach ($p in $processes) {
  $what = if ($p.CommandLine -match 'agent') { 'agent' } elseif ($p.CommandLine -match 'server') { 'server' } else { 'node' }
  Write-Host "Stopping $what (pid $($p.ProcessId))"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

<#
  After the server, so it cannot start Suwayomi again in between.

  A Java or CEF helper process whose command line names this checkout and
  "suwayomi": the JVM, whose rootDir is our data folder, and the helpers it runs
  from there. A Suwayomi somebody runs themselves, from anywhere else, names
  neither and is left alone — the app only stops what it started. The process
  names are part of the match so that a terminal or an editor whose command
  line happens to mention both is never on the list.
#>
$suwayomi = @()
if (-not $KeepSuwayomi) {
  $suwayomi = @(Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -match '^(java|javaw|jcef_helper)\.exe$' -and
      $_.CommandLine -and $_.CommandLine -match $escaped -and $_.CommandLine -match 'suwayomi'
    })
  # The JVM first: its helpers usually leave with it.
  foreach ($p in ($suwayomi | Sort-Object { if ($_.Name -eq 'java.exe') { 0 } else { 1 } })) {
    if ($p.Name -eq 'java.exe') { Write-Host "Stopping Suwayomi (pid $($p.ProcessId))" }
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if (-not $processes -and $suwayomi.Count -eq 0) {
  Write-Host 'Not running.'
  exit 0
}

Start-Sleep -Milliseconds 600
$port = if ($env:PORT) { $env:PORT } else { 8787 }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  Write-Warning "Port $port is still in use."
} else {
  Write-Host 'Stopped.' -ForegroundColor Green
}
