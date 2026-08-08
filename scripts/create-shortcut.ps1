<#
.SYNOPSIS
  Puts a "Blue Everything" icon on the Desktop and in the Start Menu.

.DESCRIPTION
  The shortcut runs start.ps1 -Open, so clicking it works whether or not the
  services are already running: it starts whatever is missing, then opens the
  app in its own window.

  It points at start.ps1 rather than straight at the browser because a shortcut
  that opens a window onto a server that isn't running would just show an error.

.EXAMPLE
  .\scripts\create-shortcut.ps1
  .\scripts\create-shortcut.ps1 -Remove
#>
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start.ps1'
$icon = Join-Path $root 'assets\everything.ico'

$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Blue Everything.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Blue Everything.lnk')
)

# Shortcuts left behind by the old name. Cleaned up whenever this script runs,
# because the alternative is two icons that launch the same app and no way to
# tell from the Desktop which one is current.
$legacyTargets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Everything.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Everything.lnk')
)

foreach ($path in $legacyTargets) {
  if (Test-Path $path) { Remove-Item $path -Force; Write-Host "Removed the old $([IO.Path]::GetFileName($path))" }
}

if ($Remove) {
  foreach ($path in $targets) {
    if (Test-Path $path) { Remove-Item $path -Force; Write-Host "Removed $path" }
  }
  Write-Host 'Shortcuts removed.' -ForegroundColor Green
  exit 0
}

if (-not (Test-Path $icon)) {
  Write-Host 'Building the icon first...' -ForegroundColor Cyan
  Push-Location $root
  try { & npm run icons -w @everything/web | Out-Null } finally { Pop-Location }
}

$shell = New-Object -ComObject WScript.Shell

foreach ($path in $targets) {
  $parent = Split-Path -Parent $path
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

  $link = $shell.CreateShortcut($path)
  $link.TargetPath = 'powershell.exe'
  $link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -Open"
  $link.WorkingDirectory = $root
  $link.Description = 'Blue Everything - tasks, habits and well-timed nudges'
  if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
  $link.WindowStyle = 7 # start minimised, so the launcher doesn't flash a window
  $link.Save()

  Write-Host "Created $path" -ForegroundColor Green
}

Write-Host ''
Write-Host 'You can drag the Desktop icon onto your taskbar to pin it.' -ForegroundColor Cyan
