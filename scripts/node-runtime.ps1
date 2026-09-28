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
