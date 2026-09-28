<#
.SYNOPSIS
  Updates Blue Everything to the newest release, keeping everything that is yours.

.DESCRIPTION
  Two kinds of install, one script:

    - a git clone is updated with `git pull --ff-only`, and refuses rather than
      merging if you have changed tracked files — your edits are not this
      script's to resolve;
    - an unzipped release is updated from the newest release zip on GitHub.
      Every release carries `release-files.txt`, the list of files it shipped.
      The new release's files are copied over, and a file the *old* list names
      that the new one does not is deleted — otherwise a removed package would
      linger and still be loaded. Anything neither list names is never touched,
      which is what keeps your data, installed packages and voice models safe.

  Never touched, either way: packages\server\data (the database, your library,
  pictures, Suwayomi), features.json, modules.json, modules\, the agent's
  config and packages\server\.env.

  Before anything changes, those are backed up to backups\<when>-v<version>.zip
  (the database and settings — not Suwayomi's 700MB or the chapter cache, which
  an update does not touch). Migrations only move forward, so that backup is
  the way back if a new version turns out to be wrong for you. The last five are
  kept.

.EXAMPLE
  .\scripts\update.ps1                 # update if there is something newer
  .\scripts\update.ps1 -CheckOnly      # just say what is available
  .\scripts\update.ps1 -Open           # open the app window afterwards
  .\scripts\update.ps1 -FromZip .\Blue-Everything-0.4.1.zip   # a zip already on disk, offline
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$Open,
  [switch]$Force,
  [string]$Repo = 'blue91321/Blue-Everything-App',
  # Install from a release zip already on disk instead of downloading one.
  [string]$FromZip = '',
  # Leave the app stopped afterwards: for trying an update on a spare copy.
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Say([string]$text) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $text" }

function VersionOf([string]$text) {
  $clean = $text.Trim().TrimStart('v')
  try { return [version]$clean } catch { return [version]'0.0.0' }
}

$current = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$isGit = Test-Path (Join-Path $root '.git')
Say "Blue Everything $current ($(if ($isGit) { 'git clone' } else { 'release install' }))"

# ---- what is available ------------------------------------------------------

$headers = @{ 'User-Agent' = 'blue-everything-updater'; 'Accept' = 'application/vnd.github+json' }
if ($FromZip) {
  if ($isGit) { throw '-FromZip is for release installs; a git clone updates with git' }
  $FromZip = (Resolve-Path $FromZip).Path
  $latest = if ((Split-Path $FromZip -Leaf) -match 'Blue-Everything-(.+)\.zip$') { $Matches[1] } else { '0.0.0' }
  $release = $null
}
else {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
  $latest = $release.tag_name.TrimStart('v')
}
Say "Newest release: $latest"

if (-not $Force -and (VersionOf $latest) -le (VersionOf $current)) {
  Say 'Already up to date.'
  exit 0
}
if ($CheckOnly) {
  Say "$latest is available. Run without -CheckOnly to update."
  exit 0
}

# ---- back up what is yours --------------------------------------------------

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backups = Join-Path $root 'backups'
$staging = Join-Path $env:TEMP "be-backup-$stamp"
New-Item -ItemType Directory -Force -Path $backups, $staging | Out-Null

$data = Join-Path $root 'packages\server\data'
if (Test-Path $data) {
  $dest = Join-Path $staging 'packages\server\data'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem $data -Force | Where-Object {
    # Not Suwayomi (a program and its own library, hundreds of MB), not the
    # chapter cache, not the test databases, and not the old .bak copies.
    $_.Name -notin @('suwayomi', 'manga-pages', 'smoke.db', 'integrations-check.db') -and $_.Name -notlike '*.bak-*'
  } | ForEach-Object { Copy-Item $_.FullName -Destination $dest -Recurse -Force }
}
foreach ($file in 'features.json', 'modules.json', 'packages\agent\agent.config.json', 'packages\server\.env') {
  $path = Join-Path $root $file
  if (Test-Path $path) {
    $target = Join-Path $staging $file
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Copy-Item $path $target -Force
  }
}
$backupZip = Join-Path $backups "$stamp-v$current.zip"
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $backupZip -Force
Remove-Item $staging -Recurse -Force
Say "Backed up your data to $backupZip"
Get-ChildItem $backups -Filter '*.zip' | Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Force

# ---- stop, update, start ----------------------------------------------------

Say 'Stopping the app...'
& (Join-Path $PSScriptRoot 'stop.ps1')

if ($isGit) {
  $dirty = git status --porcelain --untracked-files=no
  if ($dirty) {
    Say 'You have changed files git tracks, so this will not pull over them:'
    $dirty | ForEach-Object { Say "  $_" }
    Say 'Commit or discard them, then run this again. Starting the app as it was.'
    & (Join-Path $PSScriptRoot 'start.ps1')
    exit 1
  }
  git fetch --tags --quiet origin
  git pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { throw 'git pull failed — see above; your data is untouched and backed up' }
}
else {
  $work = Join-Path $env:TEMP "be-update-$stamp"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  if ($FromZip) {
    $zip = $FromZip
  }
  else {
    $asset = $release.assets | Where-Object { $_.name -like 'Blue-Everything-*.zip' } | Select-Object -First 1
    if (-not $asset) { throw "release $latest has no zip to install from" }
    $zip = Join-Path $work $asset.name
    Say "Downloading $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers $headers
  }
  Expand-Archive -Path $zip -DestinationPath $work -Force
  $new = Get-ChildItem $work -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'release-files.txt') } | Select-Object -First 1
  if (-not $new) { throw 'the download does not look like a Blue Everything release' }

  $oldList = Join-Path $root 'release-files.txt'
  $newList = Join-Path $new.FullName 'release-files.txt'
  $newFiles = Get-Content $newList
  if (Test-Path $oldList) {
    $keep = [System.Collections.Generic.HashSet[string]]::new([string[]]$newFiles, [StringComparer]::OrdinalIgnoreCase)
    foreach ($rel in Get-Content $oldList) {
      if ($rel -and -not $keep.Contains($rel)) {
        $gone = Join-Path $root $rel
        if (Test-Path $gone -PathType Leaf) { Remove-Item $gone -Force; Say "Removed $rel (no longer shipped)" }
      }
    }
  }
  foreach ($rel in $newFiles) {
    if (-not $rel) { continue }
    $from = Join-Path $new.FullName $rel
    $to = Join-Path $root $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
    Copy-Item $from $to -Force
  }
  Copy-Item $newList $oldList -Force
  Remove-Item $work -Recurse -Force
}

Say 'Installing dependencies...'
& npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw 'npm install failed — your data is untouched and backed up' }

# The built app page is rebuilt by start.ps1 when the sources are newer.
if ($NoStart) { Say "Updated $current -> $latest. Left stopped (-NoStart)."; exit 0 }
Say "Updated $current -> $latest. Starting..."
if ($Open) { & (Join-Path $PSScriptRoot 'start.ps1') -Open } else { & (Join-Path $PSScriptRoot 'start.ps1') }
