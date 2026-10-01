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
  [switch]$Open,
  # Start only the agent, and start it even though the server is already up.
  # The app's own "Start it" button uses this: an agent that has stopped while
  # the server is fine is the one case the ordinary path cannot serve, because
  # it short-circuits on the server's port being open.
  [switch]$AgentOnly
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'packages\server'
$agentDir = Join-Path $root 'packages\agent'
$logDir = Join-Path $root 'logs'
$port = if ($env:PORT) { $env:PORT } else { 8787 }
$url = "http://127.0.0.1:$port"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# The app's own Node, in runtime\node — downloaded there on a git clone's first
# run, already inside a release zip. Nothing on the PC needs installing.
try {
  . (Join-Path $PSScriptRoot 'node-runtime.ps1')
}
catch {
  Write-Host "Could not get Node.js: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'The first run needs the internet once, to download it into the app folder.'
  exit 1
}

function Test-Listening {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

<#
  Is the agent up?

  The same question stop.ps1 asks, the same way: an image name Node is started
  from here, and a command line naming this checkout. The server's command line
  names the checkout too and ends in packages\server\src\main.ts, so it can
  never match on 'agent'.
#>
function Test-AgentRunning {
  $escaped = [regex]::Escape($root)
  [bool](@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='Blue Everything.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped -and $_.CommandLine -match 'agent' }).Count)
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

<#
  Already up: a second double-click should just bring the app to the front
  rather than complaining. Skipped for -AgentOnly, which is asking for the half
  this check cannot see.

  **"Already running" has to mean both halves.** This asked only whether the
  port was open, and the app is a server *and* an agent — so ending the agent
  from Task Manager left a server with no tray icon, and double-clicking the
  app then printed "already running" and did nothing at all. The agent never
  came back, and ninety seconds later the server closed itself for the lack of
  it, so the restart appeared to shut the app down rather than start it.

  Reported the day the two processes were given names, which is not a
  coincidence: naming them is what made ending one the obvious thing to try.

  The answer is the -AgentOnly path, which already exists for exactly this
  shape — the Voice screen's "Start it" is the same situation reached from
  inside the app. So this hands over to it rather than growing a second way to
  start an agent.
#>
if ((Test-Listening) -and -not $AgentOnly) {
  if (Test-AgentRunning) {
    Write-Host "Blue Everything is already running at $url" -ForegroundColor Green
    if ($Open) { Open-AppWindow }
    exit 0
  }
  Write-Host 'The server is running but the agent is not — starting the agent.' -ForegroundColor Cyan
  $AgentOnly = $true
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
elseif (-not (Test-Path (Join-Path $root 'node_modules\@everything\server'))) {
  # A release zip carries every dependency but not the four links npm makes to
  # the app's own packages — a zip cannot hold them. Making them needs nothing
  # downloaded.
  Write-Host 'First run: finishing the install...' -ForegroundColor Cyan
  Push-Location $root
  try {
    & npm install --offline --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { & npm install --no-fund --no-audit }
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

  # Both trees, because a shipped package's screens are compiled into this same
  # bundle from `packages\modules\<id>\web`. Watching only `packages\web\src`
  # would mean deleting a package left its tab on screen until something
  # unrelated happened to change — the exact "silently serves the old build"
  # failure this check exists to prevent, just one folder further out.
  $watch = @(
    (Join-Path $root 'packages\web\src'),
    (Join-Path $root 'packages\modules')
  )
  $newest = Get-ChildItem $watch -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*\models\*' -and $_.FullName -notlike '*\node_modules\*' } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($newest -and $newest.LastWriteTimeUtc -gt $builtAt) { $needsBuild = $true }
}

# A deleted package leaves nothing behind to be "newer", so a timestamp check
# alone can never notice one. The count is recorded beside the build and
# compared instead — cheap, and it is the only signal a removal produces.
$stamp = Join-Path $root 'packages\web\dist\.modules-stamp'
$moduleCount = (Get-ChildItem (Join-Path $root 'packages\modules') -Directory -ErrorAction SilentlyContinue).Count
if (-not $needsBuild) {
  $wasCount = if (Test-Path $stamp) { Get-Content $stamp -Raw } else { '' }
  if ($wasCount.Trim() -ne "$moduleCount") { $needsBuild = $true }
}

if ($needsBuild) {
  Write-Host 'Building the app...' -ForegroundColor Cyan
  Push-Location $root
  try {
    & npm run build -w @everything/web
    if ($LASTEXITCODE -ne 0) { throw 'building the web app failed' }
  } finally { Pop-Location }
  # Written after the build, not before: a failed build must not record a state
  # it never reached, or the next start would skip the rebuild it still needs.
  Set-Content -Path $stamp -Value "$moduleCount" -Encoding utf8
}

# Absolute entry paths, even though -WorkingDirectory is also set. The working
# directory is what lets `--import tsx` resolve the loader, but only the command
# line is visible to Get-CimInstance — and that's how stop.ps1 tells these
# processes apart from every other node on the machine.
#
# $ServerExe and $AgentExe come from node-runtime.ps1: the same Node under two
# names, so Task Manager lists "Blue Everything Server" and "Blue Everything"
# rather than two anonymous node.exe rows. They fall back to node.exe itself
# when the names could not be made, so this path never depends on the label.
$serverEntry = Join-Path $serverDir 'src\main.ts'
$agentEntry = Join-Path $agentDir 'src\index.ts'

# -AgentOnly starts the agent and not the server. The install and build checks
# above still run and are nearly free once they have been done once; what is
# skipped is starting a second server on a port something is already holding.
if ($AgentOnly) {
  Write-Host 'Starting agent... ' -NoNewline
  $only = Start-Process $script:AgentExe `
    -ArgumentList '--import', 'tsx', "`"$agentEntry`"" `
    -WorkingDirectory $agentDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'agent.log') `
    -RedirectStandardError (Join-Path $logDir 'agent.err.log') `
    -PassThru
  Start-Sleep -Milliseconds 800
  if ($only.HasExited) {
    Write-Host 'failed' -ForegroundColor Red
    Write-Host "Check $logDir\agent.err.log" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "ok (pid $($only.Id))" -ForegroundColor Green
  exit 0
}

# The server closes itself when the agent stops checking in: the tray icon is
# the app, and a server left running without it has nothing on screen admitting
# it is there. Set here, for the server this script starts, and nowhere else.
$env:EXIT_WITHOUT_AGENT = 'true'

Write-Host 'Starting server...' -NoNewline
$server = Start-Process $script:ServerExe `
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
  Write-Host 'Running the agent here. Ctrl+C stops the agent, and the server follows within 90s.' -ForegroundColor Cyan
  Push-Location $agentDir
  try { & $script:AgentExe --import tsx $agentEntry } finally { Pop-Location }
  exit 0
}

<#
  Not if one is already there. The server having been down does not mean the
  agent was, and a second agent means a second tray icon, two sets of nudges
  and two microphones wanting the same device.
#>
if (Test-AgentRunning) {
  Write-Host 'Agent is already running.' -ForegroundColor Green
  if ($Open) { Open-AppWindow }
  Write-Host ''
  Write-Host "App:  $url" -ForegroundColor Cyan
  exit 0
}

Write-Host 'Starting agent... ' -NoNewline
$agent = Start-Process $script:AgentExe `
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
