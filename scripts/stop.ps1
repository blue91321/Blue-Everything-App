<#
.SYNOPSIS
  Stops the Blue Everything server and agent.

.DESCRIPTION
  Finds them by command line rather than a PID file, so it still works after a
  reboot, a crash, or a stray copy started by hand.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Matching on the project path avoids killing unrelated node processes — there
# are usually several on a dev machine.
$escaped = [regex]::Escape($root)
$processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped }

if (-not $processes) {
  Write-Host 'Not running.'
  exit 0
}

foreach ($p in $processes) {
  $what = if ($p.CommandLine -match 'agent') { 'agent' } elseif ($p.CommandLine -match 'server') { 'server' } else { 'node' }
  Write-Host "Stopping $what (pid $($p.ProcessId))"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 600
$port = if ($env:PORT) { $env:PORT } else { 8787 }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  Write-Warning "Port $port is still in use."
} else {
  Write-Host 'Stopped.' -ForegroundColor Green
}
