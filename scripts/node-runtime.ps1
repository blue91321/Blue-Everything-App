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
<#
  The oldest Node this app will run on. Raised by hand when Node ships a
  security release: the folder was only ever filled when node.exe was missing,
  so an install kept whatever Node it first downloaded for good (24.21.0 here
  when 24.22.1 fixed security issues; 24.22.3, 2026-11-10, fixed nine High
  ones in http, tls and http2). An older one is replaced at the next
  start, which on a restart is after the app has stopped and nothing holds it.
#>
$script:NodeMinimum = [version]'24.22.3'
$appRoot = Split-Path $PSScriptRoot -Parent
$nodeDir = Join-Path $appRoot 'runtime\node'
$nodeExe = Join-Path $nodeDir 'node.exe'

$nodeTooOld = $false
if (Test-Path $nodeExe) {
  try {
    $have = [version](((Get-Item $nodeExe).VersionInfo.ProductVersion) -replace '[^0-9.].*$', '')
    $nodeTooOld = $have -lt $script:NodeMinimum
  } catch { $nodeTooOld = $false }
}
<#
  Replaced only when nothing is running from the folder. -AgentOnly starts the
  agent beside a server still up on this Node, and a running node.exe cannot be
  deleted, so that start carries on with the old one and says so; the next full
  start replaces it.
#>
if ($nodeTooOld) {
  $inUse = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($nodeDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  }
  if ($inUse) {
    Write-Host "Node.js in runtime\node is older than $script:NodeMinimum but in use; it is updated at the next full start." -ForegroundColor Yellow
    $nodeTooOld = $false
  }
}

if (-not (Test-Path $nodeExe) -or $nodeTooOld) {
  Write-Host "Downloading Node.js $script:NodeMajor into the app's folder (about 30MB)..."
  $ProgressPreference = 'SilentlyContinue'
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -Headers @{ 'User-Agent' = 'blue-everything' }
  $version = ($index | Where-Object { $_.version -like "v$script:NodeMajor.*" } | Select-Object -First 1).version
  if (-not $version) { throw "could not find a Node.js $script:NodeMajor release to download" }
  if ([version]$version.TrimStart('v') -lt $script:NodeMinimum) { throw "the newest Node.js $script:NodeMajor on nodejs.org ($version) is older than $script:NodeMinimum" }

  $name = "node-$version-win-x64"
  $work = Join-Path $env:TEMP "be-node-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $zip = Join-Path $work "$name.zip"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip
  <#
    Checked against the SHA-256 nodejs.org publishes for the release, as an
    update is against its SHA256SUMS: a download cut short or altered on the
    way is refused here rather than unpacked into the folder the app runs from.
  #>
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -Headers @{ 'User-Agent' = 'blue-everything' }).Content
  $want = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1) -replace '\s.*$', ''
  $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash
  if (-not $want -or $got -ne $want.ToUpperInvariant()) {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    throw "the Node.js download did not match the checksum nodejs.org publishes for $name.zip"
  }
  Expand-Archive -Path $zip -DestinationPath $work -Force

  New-Item -ItemType Directory -Force -Path (Split-Path $nodeDir) | Out-Null
  # Moved aside, not deleted: a rename either happens or does not, where a
  # delete stopped by one locked file leaves half a Node and no app.
  $old = "$nodeDir.old"
  if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $nodeDir) { Move-Item $nodeDir $old }
  try { Move-Item (Join-Path $work $name) $nodeDir }
  catch { if (Test-Path $old) { Move-Item $old $nodeDir }; throw }
  if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
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

<#
  The rest of the app's processes, labeled the same way (2026-11-03).

  Suwayomi is a Java program, so its 700MB showed in Task Manager as
  "OpenJDK Platform binary", and its built-in browser as three rows of "Java
  Chromium Embedded Framework (JCEF) Helper", nothing saying whose. Once manga
  is set up:

  - **Java** gets a labeled copy beside `java.exe`, `Blue Everything Manga.exe`
    (the launcher is a few hundred KB, and finds Java by its own folder, so a
    copy in the same folder is the same Java). The manga package starts it
    when it is there. It is run once with `-version` before it is trusted.
  - **The browser helpers** are started by Suwayomi's browser component by
    their own file name, so they cannot be renamed: their description is
    relabeled in place, with the original kept beside it. Not while one is
    running (a restart that keeps Suwayomi up), and done again whenever an
    update of the component brings an unlabeled one back.

  And the agent's `esbuild.exe`, which `--import tsx` starts to read the
  app's TypeScript: it carries no description at all, so Task Manager shows
  its file name, and a hard link named `Blue Everything Loader.exe` is all it
  needs. The agent and the server are pointed at it (`$LoaderExe`, as
  ESBUILD_BINARY_PATH, set only around their launch). esbuild refuses a binary
  of another version, and Vite's is another version: so the Code screen asks
  tsx's esbuild for its syntax check, and start.ps1 and update.ps1 clear the
  variable first, since a Restart from the tray or the app inherits it and
  then builds with Vite.
#>
$script:LoaderExe = $null
try {
  $prevPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $data = Join-Path $appRoot 'packages\server\data'

  $javaBin = Join-Path $data 'suwayomi-runtime\java\bin'
  $java = Join-Path $javaBin 'java.exe'
  if (Test-Path $java) {
    $labeled = Join-Path $javaBin 'Blue Everything Manga.exe'
    $source = Get-Item $java
    $have = Get-Item $labeled -ErrorAction SilentlyContinue
    $current = $have -and $have.VersionInfo.FileDescription -and $have.VersionInfo.FileDescription.Trim() -eq 'Blue Everything Manga' -and
      $have.VersionInfo.ProductVersion -eq $source.VersionInfo.ProductVersion
    if (-not $current) {
      if ($have) { Remove-Item $labeled -Force -ErrorAction SilentlyContinue }
      if (-not (Test-Path $labeled)) { & $nodeExe $namer $java $labeled 'Blue Everything Manga' *> $null }
      if (Test-Path $labeled) {
        $says = (& $labeled -version 2>&1 | Out-String)
        if ($says -notmatch 'version') { Remove-Item $labeled -Force -ErrorAction SilentlyContinue }
      }
    }
  }

  $kcef = Join-Path $data 'suwayomi\bin\kcef'
  $helper = Join-Path $kcef 'jcef_helper.exe'
  $helperLabel = 'Blue Everything Manga browser'
  if ((Test-Path $helper) -and ((Get-Item $helper).VersionInfo.FileDescription.Trim() -ne $helperLabel)) {
    $running = Get-CimInstance Win32_Process -Filter "Name = 'jcef_helper.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -eq $helper }
    if (-not $running) {
      $patched = "$helper.labeled"
      & $nodeExe $namer $helper $patched $helperLabel *> $null
      if ((Test-Path $patched) -and (Get-Item $patched).VersionInfo.FileDescription.Trim() -eq $helperLabel) {
        Copy-Item $helper "$helper.unlabeled" -Force
        Move-Item $patched $helper -Force
      }
      Remove-Item $patched -Force -ErrorAction SilentlyContinue
    }
  }

  $esbuild = Join-Path $appRoot 'node_modules\tsx\node_modules\@esbuild\win32-x64\esbuild.exe'
  if (Test-Path $esbuild) {
    $loader = Join-Path $nodeDir 'Blue Everything Loader.exe'
    $source = Get-Item $esbuild
    $have = Get-Item $loader -ErrorAction SilentlyContinue
    # A link shares its size and time with esbuild.exe; one that does not was
    # left behind by an update, and the old binary would refuse the new tsx.
    if ($have -and ($have.Length -ne $source.Length -or $have.LastWriteTimeUtc -ne $source.LastWriteTimeUtc)) {
      Remove-Item $loader -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $loader)) {
      try { New-Item -ItemType HardLink -Path $loader -Target $esbuild -ErrorAction Stop | Out-Null } catch { }
    }
    if (Test-Path $loader) { $script:LoaderExe = $loader }
  }
}
catch {
  Write-Verbose "could not label Suwayomi or the loader: $($_.Exception.Message)"
}
finally {
  $ErrorActionPreference = $prevPreference
}
