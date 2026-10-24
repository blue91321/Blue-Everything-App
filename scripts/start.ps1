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
  .\scripts\start.ps1 -Instance sam # start a guest copy called "sam", making it the first time
#>
[CmdletBinding()]
param(
  [switch]$Foreground,
  [switch]$Open,
  # Start only the agent, and start it even though the server is already up.
  # The app's own "Start it" button uses this: an agent that has stopped while
  # the server is fine is the one case the ordinary path cannot serve, because
  # it short-circuits on the server's port being open.
  [switch]$AgentOnly,
  # A guest copy of the server: somebody else's, on this PC (plan A in "Blue
  # Everything for friends"). Its database, data, settings and logs live in
  # instances\<name>\, on a port of its own, and it starts no agent: a guest's
  # agent runs on their own PC. The first start makes the folder and prints a
  # device token for it.
  [string]$Instance = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'packages\server'
$agentDir = Join-Path $root 'packages\agent'
$logDir = Join-Path $root 'logs'
$port = if ($env:PORT) { $env:PORT } else { 8787 }
$url = "http://127.0.0.1:$port"

<#
  A guest copy: its folder, and the port it keeps. The port is chosen once,
  the first free one from 8788 that no other copy has, and written to
  instance.json so the copy's address does not move between starts.
#>
$instanceDir = $null
$newInstance = $false
if ($Instance) {
  if ($Instance -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') {
    Write-Host 'A copy needs a lowercase name: letters, digits and hyphens, up to 32.' -ForegroundColor Red
    exit 1
  }
  $instancesDir = Join-Path $root 'instances'
  $instanceDir = Join-Path $instancesDir $Instance
  $instanceFile = Join-Path $instanceDir 'instance.json'
  if (Test-Path $instanceFile) {
    $port = [int]((Get-Content $instanceFile -Raw | ConvertFrom-Json).port)
  } else {
    $newInstance = $true
    $taken = @(8787)
    if (Test-Path $instancesDir) {
      foreach ($other in Get-ChildItem $instancesDir -Directory) {
        $otherFile = Join-Path $other.FullName 'instance.json'
        if (Test-Path $otherFile) {
          try { $taken += [int]((Get-Content $otherFile -Raw | ConvertFrom-Json).port) } catch { }
        }
      }
    }
    $port = 8788
    while (($taken -contains $port) -or (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
      $port++
    }
    New-Item -ItemType Directory -Force -Path $instanceDir | Out-Null
    # No byte-order mark: the server reads this, and JSON.parse refuses one.
    [System.IO.File]::WriteAllText($instanceFile, (@{ port = $port; created = (Get-Date).ToString('o') } | ConvertTo-Json))
    Write-Host "Made a copy called ""$Instance"" in instances\$Instance, on port $port." -ForegroundColor Cyan
  }
  $url = "http://127.0.0.1:$port"
  $logDir = Join-Path $instanceDir 'logs'
}

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
  # With the separator: "...\Everything App" must not match "...\Everything app test user"
  # (Windows compares without case), or another install's processes count as this one's.
  $escaped = [regex]::Escape($root.TrimEnd('\') + '\')
  # A guest copy's server is never the agent, whatever its name says.
  [bool](@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='Blue Everything.exe'" |
    Where-Object {
      $_.CommandLine -and $_.CommandLine -match $escaped -and $_.CommandLine -match 'agent' -and
      $_.CommandLine -notmatch '--instance='
    }).Count)
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
  # In app-id.ps1, which the desktop client (desktop.ps1) shares.
  . (Join-Path $PSScriptRoot 'app-id.ps1')
  Open-AppWindowAt $url
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
if ($Instance -and (Test-Listening)) {
  Write-Host "The copy ""$Instance"" is already running at $url" -ForegroundColor Green
  if ($Open) { Open-AppWindow }
  exit 0
}

if (-not $Instance -and (Test-Listening) -and -not $AgentOnly) {
  if (Test-AgentRunning) {
    Write-Host "Blue Everything is already running at $url" -ForegroundColor Green
    if ($Open) { Open-AppWindow }
    exit 0
  }
  Write-Host 'The server is running but the agent is not — starting the agent.' -ForegroundColor Cyan
  $AgentOnly = $true
}

<#
  Runs npm without letting its stderr end this script. With
  $ErrorActionPreference = 'Stop', Windows PowerShell 5.1 turns each line a
  native program writes to stderr into an error, but only when the output is
  redirected: in a console window it passes through. The tray's Restart sends
  everything to logs	ray.log, so a harmless warning from vite during
  "rendering chunks" ended the restart halfway through the build, after the
  server had been stopped and before anything was started again. The exit code
  is what decides failure, and the callers still check $LASTEXITCODE.
#>
function Invoke-Npm {
  $npmArgs = $args
  $ErrorActionPreference = 'Continue'
  & npm @npmArgs 2>&1 | ForEach-Object { "$_" }
}

# First run — this takes a couple of minutes, then never happens again.
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host 'First run: installing dependencies (a few minutes)...' -ForegroundColor Cyan
  Push-Location $root
  try {
    Invoke-Npm install --no-fund --no-audit
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
    Invoke-Npm install --offline --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Invoke-Npm install --no-fund --no-audit }
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
    Invoke-Npm run build -w @everything/web
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

<#
  Starting a process here empties its log, so the last run's log is kept as
  <name>.prev.log first. Twice the evidence for a problem was lost to the
  restart that followed it: a timeline read minutes before, and an app that
  "went offline" with nothing left to say why.

  Only a log with something in it is moved, so an empty .err.log never replaces
  the one that holds the last crash. A log something is still writing to cannot
  be moved, and is left alone: starting matters more than the copy.
#>
function Save-PreviousLog([string]$name) {
  $path = Join-Path $logDir "$name.log"
  try {
    if ((Test-Path $path) -and (Get-Item $path).Length -gt 0) {
      Move-Item -LiteralPath $path -Destination (Join-Path $logDir "$name.prev.log") -Force -ErrorAction Stop
    }
  } catch {
    # In use, or not ours to move: the new run writes over it as it always did.
  }
}

<#
  A guest copy: its server only, told which copy it is. `--instance=<name>`
  on the command line is for stop.ps1, which tells copies apart by it; the
  server reads EVERYTHING_INSTANCE. No EXIT_WITHOUT_AGENT: a guest's agent is
  on their own PC, so none checks in here.
#>
if ($Instance) {
  $env:EVERYTHING_INSTANCE = $Instance
  $env:PORT = "$port"
  Remove-Item Env:EXIT_WITHOUT_AGENT -ErrorAction SilentlyContinue
  Save-PreviousLog 'server'
  Save-PreviousLog 'server.err'
  Write-Host "Starting the copy ""$Instance""..." -NoNewline
  $copy = Start-Process $script:ServerExe `
    -ArgumentList '--import', 'tsx', "`"$serverEntry`"", "--instance=$Instance" `
    -WorkingDirectory $serverDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'server.log') `
    -RedirectStandardError (Join-Path $logDir 'server.err.log') `
    -PassThru
  $ready = $false
  foreach ($i in 1..60) {
    if ($copy.HasExited) { break }
    if (Test-Listening) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) {
    Write-Host ' failed.' -ForegroundColor Red
    Write-Host "Check $logDir\server.err.log" -ForegroundColor Yellow
    if (-not $copy.HasExited) { Stop-Process -Id $copy.Id -Force }
    exit 1
  }
  Write-Host " ok (pid $($copy.Id))" -ForegroundColor Green

  # Its key to the host's Suwayomi. The host makes one at its own start for
  # any copy without; asked here so a new copy need not wait for that.
  if (-not (Test-Path (Join-Path $instanceDir 'host-key'))) {
    $hostUrl = if ($env:EVERYTHING_HOST_URL) { $env:EVERYTHING_HOST_URL } else { 'http://127.0.0.1:8787' }
    try {
      Invoke-RestMethod -Method Post -Uri "$hostUrl/api/instances/$Instance/key" -TimeoutSec 10 | Out-Null
      Write-Host 'The host gave this copy its key to the shared Suwayomi.'
    } catch {
      Write-Host "The host did not give this copy its key yet (is it running this version?). It does at its next start; manga waits until then." -ForegroundColor Yellow
    }
  }

  if ($newInstance) {
    Write-Host ''
    Write-Host "A device token for the copy ""$Instance"", shown once. Paste it into the app at $url." -ForegroundColor Cyan
    Push-Location $serverDir
    try { & $script:ServerExe --import tsx (Join-Path $serverDir 'src\cli\pair.ts') "$Instance (first device)" browser }
    finally { Pop-Location }
  }

  if ($Open) { Open-AppWindow }
  Write-Host ''
  Write-Host "App:  $url" -ForegroundColor Cyan
  Write-Host "Logs: $logDir"
  Write-Host "Stop: scripts\stop.ps1 -Instance $Instance"
  exit 0
}

# -AgentOnly starts the agent and not the server. The install and build checks
# above still run and are nearly free once they have been done once; what is
# skipped is starting a second server on a port something is already holding.
# `--expose-gc` on the agent: the speech models have no free in their binding and
# go back when collected, so switching voice off asks for a collection rather
# than leaving ~150MB to whenever the collector next gets round to it.
if ($AgentOnly) {
  Save-PreviousLog 'agent'
  Save-PreviousLog 'agent.err'
  Write-Host 'Starting agent... ' -NoNewline
  $only = Start-Process $script:AgentExe `
    -ArgumentList '--expose-gc', '--import', 'tsx', "`"$agentEntry`"" `
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

Save-PreviousLog 'server'
Save-PreviousLog 'server.err'
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
  try { & $script:AgentExe --expose-gc --import tsx $agentEntry } finally { Pop-Location }
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

Save-PreviousLog 'agent'
Save-PreviousLog 'agent.err'
Write-Host 'Starting agent... ' -NoNewline
$agent = Start-Process $script:AgentExe `
  -ArgumentList '--expose-gc', '--import', 'tsx', "`"$agentEntry`"" `
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
