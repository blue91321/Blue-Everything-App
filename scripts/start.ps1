<#
.SYNOPSIS
  Starts the Blue Everything server and Windows agent.

.DESCRIPTION
  Does whatever is needed to get to a running app: installs dependencies on
  first run, builds the PWA if it's missing, then starts both services.

  Launches them as plain `node` processes rather than through `npm run`, which
  would leave an extra npm wrapper process alive per service for no benefit.
  Output goes to logs\.

.EXAMPLE
  .\scripts\start.ps1
  .\scripts\start.ps1 -Open         # also open the app in the browser
  .\scripts\start.ps1 -Foreground   # run the agent in this window, to watch it
#>
[CmdletBinding()]
param(
  [switch]$Foreground,
  [switch]$Open
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'packages\server'
$agentDir = Join-Path $root 'packages\agent'
$logDir = Join-Path $root 'logs'
$port = if ($env:PORT) { $env:PORT } else { 8787 }
$url = "http://127.0.0.1:$port"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed, or not on PATH.' -ForegroundColor Red
  Write-Host 'Install it from https://nodejs.org and run this again.'
  exit 1
}

function Test-Listening {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

<#
  Opens the app in its own window instead of as a browser tab.

  Chromium's --app mode gives a window with no tabs, no address bar, its own
  taskbar button and its own Alt-Tab entry, so it stops getting lost among
  browser tabs. It still uses the browser's engine, which is the point: a real
  native shell would mean Electron and 150-250MB of resident memory to display
  the same page.
#>
function Open-AppWindow {
  $candidates = @(
    "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
    "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )

  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

  if ($browser) {
    # Chromium remembers this window's size and position per --app URL after
    # the first launch, so the initial size is only ever used once.
    Start-Process $browser -ArgumentList "--app=$url", '--window-size=1150,860'
  } else {
    # No Chromium-based browser found: a normal tab beats nothing.
    Start-Process $url
  }
}

# Already up: a second double-click should just bring the app to the front
# rather than complaining.
if (Test-Listening) {
  Write-Host "Blue Everything is already running at $url" -ForegroundColor Green
  if ($Open) { Open-AppWindow }
  exit 0
}

# First run — this takes a couple of minutes, then never happens again.
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host 'First run: installing dependencies (a few minutes)...' -ForegroundColor Cyan
  Push-Location $root
  try {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  } finally { Pop-Location }
}

# Rebuild when the source is newer than the build, not just when it's missing.
# Otherwise editing the app and restarting silently serves the old one, which is
# a genuinely baffling thing to debug.
$builtIndex = Join-Path $root 'packages\web\dist\index.html'
$needsBuild = -not (Test-Path $builtIndex)
if (-not $needsBuild) {
  $builtAt = (Get-Item $builtIndex).LastWriteTimeUtc
  $newest = Get-ChildItem (Join-Path $root 'packages\web\src') -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($newest -and $newest.LastWriteTimeUtc -gt $builtAt) { $needsBuild = $true }
}

if ($needsBuild) {
  Write-Host 'Building the app...' -ForegroundColor Cyan
  Push-Location $root
  try {
    & npm run build -w @everything/web
    if ($LASTEXITCODE -ne 0) { throw 'building the web app failed' }
  } finally { Pop-Location }
}

# Absolute entry paths, even though -WorkingDirectory is also set. The working
# directory is what lets `--import tsx` resolve the loader, but only the command
# line is visible to Get-CimInstance — and that's how stop.ps1 tells these
# processes apart from every other node on the machine.
$serverEntry = Join-Path $serverDir 'src\main.ts'
$agentEntry = Join-Path $agentDir 'src\index.ts'

Write-Host 'Starting server...' -NoNewline
$server = Start-Process node `
  -ArgumentList '--import', 'tsx', "`"$serverEntry`"" `
  -WorkingDirectory $serverDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'server.log') `
  -RedirectStandardError (Join-Path $logDir 'server.err.log') `
  -PassThru

# Wait for the port rather than sleeping a fixed amount: migrations run at boot
# and take an unpredictable moment on first launch.
$ready = $false
foreach ($i in 1..60) {
  if ($server.HasExited) { break }
  if (Test-Listening) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}

if (-not $ready) {
  Write-Host ' failed.' -ForegroundColor Red
  Write-Host "Check $logDir\server.err.log" -ForegroundColor Yellow
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  exit 1
}
Write-Host " ok (pid $($server.Id))" -ForegroundColor Green

if ($Foreground) {
  if ($Open) { Open-AppWindow }
  Write-Host "App:  $url" -ForegroundColor Cyan
  Write-Host 'Running the agent here. Ctrl+C stops the agent; the server keeps running.' -ForegroundColor Cyan
  Push-Location $agentDir
  try { & node --import tsx $agentEntry } finally { Pop-Location }
  exit 0
}

Write-Host 'Starting agent... ' -NoNewline
$agent = Start-Process node `
  -ArgumentList '--import', 'tsx', "`"$agentEntry`"" `
  -WorkingDirectory $agentDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'agent.log') `
  -RedirectStandardError (Join-Path $logDir 'agent.err.log') `
  -PassThru

Start-Sleep -Milliseconds 800
if ($agent.HasExited) {
  Write-Host 'failed.' -ForegroundColor Red
  Write-Host "Check $logDir\agent.err.log" -ForegroundColor Yellow
} else {
  Write-Host "ok (pid $($agent.Id))" -ForegroundColor Green
}

if ($Open) { Open-AppWindow }

Write-Host ''
Write-Host "App:  $url" -ForegroundColor Cyan
Write-Host "Logs: $logDir"
Write-Host 'Stop: "Stop Blue Everything.cmd"'
