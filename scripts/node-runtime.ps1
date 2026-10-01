<#
.SYNOPSIS
  Puts the app's own Node.js first on PATH, downloading it into the app folder
  if it is not there yet. Dot-sourced by start.ps1, update.ps1 and
  create-shortcut.ps1:

    . (Join-Path $PSScriptRoot 'node-runtime.ps1')

.DESCRIPTION
  The app runs on the Node in `runtime\node\`, never on one installed on the PC.
  Asking people to install Node first was the first thing to go wrong on another
  machine, and a PC's own Node can be any version — so the app brings its own
  and uses nothing else. A release zip already has it inside; a git clone
  fetches it on first run, about 30MB from nodejs.org, into the same folder.

  Only this process's PATH changes, and everything it starts inherits it — the
  server, the agent, npm. Nothing is installed or changed outside the folder.
#>

$script:NodeMajor = 24
$appRoot = Split-Path $PSScriptRoot -Parent
$nodeDir = Join-Path $appRoot 'runtime\node'
$nodeExe = Join-Path $nodeDir 'node.exe'

if (-not (Test-Path $nodeExe)) {
  Write-Host "Downloading Node.js $script:NodeMajor into the app's folder (once, about 30MB)..."
  $ProgressPreference = 'SilentlyContinue'
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -Headers @{ 'User-Agent' = 'blue-everything' }
  $version = ($index | Where-Object { $_.version -like "v$script:NodeMajor.*" } | Select-Object -First 1).version
  if (-not $version) { throw "could not find a Node.js $script:NodeMajor release to download" }

  $name = "node-$version-win-x64"
  $work = Join-Path $env:TEMP "be-node-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $zip = Join-Path $work "$name.zip"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $work -Force

  New-Item -ItemType Directory -Force -Path (Split-Path $nodeDir) | Out-Null
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item (Join-Path $work $name) $nodeDir
  Remove-Item $work -Recurse -Force
  Write-Host "Node.js $version is in runtime\node."
}

if ($env:PATH -notlike "$nodeDir;*") { $env:PATH = "$nodeDir;$env:PATH" }

<#
  Two named copies of node.exe, so the two processes say what they are.

  The app was two rows reading `node.exe` in Task Manager, which is no use for
  the question people actually ask of that list: which of these is mine, how
  much is it costing me, and what do I end if it misbehaves. A dev machine has
  several node processes and none of them says whose it is.

  **A running program cannot name itself here.** Windows takes a process's name
  from the file it was started from, and `process.title` — which does rename the
  process on Linux — only sets the console window title on Windows, which these
  do not have. So the only way to be legible is to be *started from* a file with
  the right name.

  **And the filename is only half of it**, which is the part that cost a round
  trip. Task Manager's **Details** tab lists the image name, so renaming the
  file is all that tab needs. Its **Processes** tab — the one people actually
  open — names a background process by the `FileDescription` inside the binary,
  so both rows went on reading "Node.js JavaScript Runtime" and the rename
  looked from the outside like nothing at all had happened. `name-node.mjs`
  edits that field, which is why these are copies rather than links.

  Everything here is best-effort and falls back, first to a hard link and then
  to `node.exe` itself. A label is worth a few seconds of setup and not worth an
  app that will not start, so every step is verified by running what it produced
  before anything is asked to depend on it.
#>
$script:ServerExe = $nodeExe
$script:AgentExe = $nodeExe

$node = Get-Item $nodeExe
$nodeVersion = $node.VersionInfo.ProductVersion
$namer = Join-Path $PSScriptRoot 'name-node.mjs'

<#
  Wrapped whole, because start.ps1 dot-sources this under
  $ErrorActionPreference = 'Stop' inside a try/catch that gives up on the app
  entirely. Everything below is a *label*, and no label is worth the app
  refusing to start — so anything unexpected in here leaves $ServerExe and
  $AgentExe as node.exe itself and the app runs exactly as it did before.
#>
try {
foreach ($pair in @(
    @{ Var = 'ServerExe'; Name = 'Blue Everything Server.exe'; Label = 'Blue Everything Server' },
    @{ Var = 'AgentExe'; Name = 'Blue Everything.exe'; Label = 'Blue Everything' }
  )) {
  $named = Join-Path $nodeDir $pair.Name
  $have = Get-Item $named -ErrorAction SilentlyContinue

  <#
    Two shapes count as up to date, because there are two shapes it can be.

    A named copy is current when it carries the label *and* the Node version it
    was cut from — which is the check that matters, since a copy left behind by
    a Node upgrade would go on running the app on a version it is not meant to
    be on, invisibly, because everything would still work.

    A hard link is current when it is byte-for-byte node.exe, which is what it
    is by definition. That is the fallback shape, and recognising it is what
    stops a machine where patching failed from copying 90MB on every start.
  #>
  $current = $have -and (
    ($have.VersionInfo.FileDescription -and $have.VersionInfo.FileDescription.Trim() -eq $pair.Label -and
     $have.VersionInfo.ProductVersion -eq $nodeVersion) -or
    ($have.Length -eq $node.Length -and $have.LastWriteTimeUtc -eq $node.LastWriteTimeUtc)
  )

  if (-not $current) {
    # A stale one is in the way. A running one cannot be removed, and then the
    # rest of this fails and whatever is already there stands.
    if ($have) { Remove-Item $named -Force -ErrorAction SilentlyContinue }

    if (-not (Test-Path $named)) {
      try { & $nodeExe $namer $nodeExe $named $pair.Label | Out-Null } catch { }
    }

    <#
      Prove it runs before adopting it.

      This writes an unsigned copy of a signed binary into a folder an
      antivirus is entitled to have opinions about, and a quarantined or
      truncated launcher must not be the reason the app will not start. So it
      is run once, and only a copy that answers is used.
    #>
    $ok = $false
    if (Test-Path $named) {
      try { $ok = ((& $named --version 2>$null) -join '') -match '^v\d' } catch { $ok = $false }
      if (-not $ok) { Remove-Item $named -Force -ErrorAction SilentlyContinue }
    }

    # Falling back to a hard link: the name is still right, only the
    # description stays Node's. Same folder, so the same volume by
    # construction, which is the one thing a hard link needs.
    if (-not $ok -and -not (Test-Path $named)) {
      try { New-Item -ItemType HardLink -Path $named -Target $nodeExe -ErrorAction Stop | Out-Null } catch { }
    }
  }

  if (Test-Path $named) { Set-Variable -Scope Script -Name $pair.Var -Value $named }
}
}
catch {
  Write-Verbose "could not name the Node launchers: $($_.Exception.Message)"
}
