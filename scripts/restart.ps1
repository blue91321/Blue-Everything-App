<#
.SYNOPSIS
  Stops Blue Everything and starts it again.

.DESCRIPTION
  Exists so the tray menu has one thing to call rather than having to sequence
  two scripts itself — and, more importantly, so the sequencing survives the
  caller. `stop.ps1` kills every node process belonging to this project, which
  includes the agent whose tray menu asked for the restart. Anything driving
  that from inside the agent would be killed halfway through and leave the app
  stopped rather than restarted.

  This runs as powershell.exe, which `stop.ps1` does not match, so it is still
  here to run the second half.

.EXAMPLE
  .\scripts\restart.ps1
  .\scripts\restart.ps1 -Open      # also open the app window afterwards
#>
[CmdletBinding()]
param(
  [switch]$Open
)

$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'stop.ps1')

# stop.ps1 already waits for the port and warns if it is still held, but a
# freshly killed process can hold the listener a moment longer than it takes to
# get back here — and start.ps1 treats a live port as "already running" and does
# nothing at all. That failure is silent and looks exactly like the restart
# having worked.
$port = if ($env:PORT) { $env:PORT } else { 8787 }
foreach ($i in 1..40) {
  if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 250
}

$start = Join-Path $PSScriptRoot 'start.ps1'
if ($Open) { & $start -Open } else { & $start }
