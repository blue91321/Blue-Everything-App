<#
.SYNOPSIS
  Blue Everything Desktop: the agent on its own, signed in to a Blue Everything
  that runs somewhere else.

.DESCRIPTION
  The desktop client is a separate download (`package-release.mjs --desktop`)
  for a PC that does not run the server: a friend whose copy is on someone
  else's PC, or your own second PC. It is the part of the app a web browser
  cannot be: the tray icon, the popup above games, noticing when a match ends,
  and voice. The app itself stays a web page, opened in its own window.

  First run asks for the app's address and a sign-in code (made in the app,
  Settings -> Devices -> Sign in another device), swaps the code for this PC's
  own key, and puts it in packages\agent\agent.config.json, where the agent
  has always looked. It also offers to start with Windows.

.EXAMPLE
  .\scripts\desktop.ps1 -Open      # sign in if needed, start, open the app
  .\scripts\desktop.ps1 -Shortcut  # a Desktop and Start Menu icon, "Blue Everything Desktop\"
  .\scripts\desktop.ps1 -SignIn    # sign in again, to another address or with a new code
  .\scripts\desktop.ps1 -Restart   # the tray's Restart
  .\scripts\desktop.ps1 -Stop      # the tray's Stop
#>
[CmdletBinding()]
param(
  [switch]$Open,
  [switch]$SignIn,
  [switch]$Restart,
  [switch]$Stop,
  [switch]$Shortcut
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$agentDir = Join-Path $root 'packages\agent'
$agentEntry = Join-Path $agentDir 'src\index.ts'
$configPath = Join-Path $agentDir 'agent.config.json'
$logDir = Join-Path $root 'logs'
<#
  The icon: the one the copy chose (its colour and shape), fetched from it at
  each start by Update-AppIcon, else the default one in the zip. Named by its
  contents, because Windows keeps a shortcut's icon by path and would go on
  showing the old picture under the same name.
#>
$icon = Join-Path $root 'assets\everything.ico'
$chosenIcon = Get-ChildItem (Join-Path $root 'assets') -Filter 'app-*.ico' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($chosenIcon) { $icon = $chosenIcon.FullName }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Show-Problem([string]$text) {
  [void][System.Windows.Forms.MessageBox]::Show($text, 'Blue Everything Desktop', 'OK', 'Warning')
}

function Get-AgentProcess {
  # With the separator: "...\Everything App" must not match "...\Everything app test user"
  # (Windows compares without case), or another install's processes count as this one's.
  $escaped = [regex]::Escape($root.TrimEnd('\') + '\')
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='Blue Everything.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped -and $_.CommandLine -match 'agent' })
}

function Stop-Agent {
  foreach ($p in Get-AgentProcess) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Stop) {
  Stop-Agent
  exit 0
}

function Read-Config {
  if (-not (Test-Path $configPath)) { return $null }
  try { return (Get-Content $configPath -Raw | ConvertFrom-Json) } catch { return $null }
}

<#
  The address as typed: a sign-in link (which carries its code), an https
  address, or a bare name like desktop-x.ts.net:8788.
#>
function Split-Address([string]$typed) {
  $text = $typed.Trim()
  $code = $null
  if ($text -match '#invite=([A-Za-z0-9_-]+)') { $code = $Matches[1] }
  $text = ($text -replace '#.*$', '').TrimEnd('/')
  if ($text -and $text -notmatch '^https?://') { $text = "https://$text" }
  return @{ Url = $text; Code = $code }
}

<# Swap a sign-in code for this PC's own key. Returns the token, or throws with the server's reason. #>
function Redeem([string]$url, [string]$code) {
  $body = @{ code = $code; name = "$env:COMPUTERNAME (desktop app)"; kind = 'windows-agent' } | ConvertTo-Json
  try {
    $answer = Invoke-RestMethod -Method Post -Uri "$url/api/invite/redeem" -Body $body -ContentType 'application/json' -TimeoutSec 20
  } catch {
    $said = $null
    try { $said = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { }
    if ($said) { throw $said }
    throw "Could not reach $url. Is the address right, and is Tailscale on?"
  }
  if (-not $answer.token) { throw 'The app did not send a key back.' }
  return [string]$answer.token
}

function New-Shortcut([string]$path, [string]$arguments) {
  $shell = New-Object -ComObject WScript.Shell
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = 'powershell.exe'
  $link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" $arguments"
  $link.WorkingDirectory = $root
  $link.Description = 'Blue Everything Desktop'
  if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
  $link.WindowStyle = 7
  $link.Save()
  try { Set-ShortcutAppId -Path $path } catch { }
}

$startMenuLink = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Blue Everything Desktop.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Blue Everything Desktop.lnk'

<#
  The copy's own icon, as an .ico (`/icon/app.ico`, outside /api/ so it needs
  no key). Quietly kept as it was if the copy cannot be reached.
#>
function Update-AppIcon([string]$url) {
  try {
    $bytes = [byte[]](Invoke-WebRequest -Uri "$url/icon/app.ico" -UseBasicParsing -TimeoutSec 10).Content
    # An .ico starts 00 00 01 00; anything else is an error page.
    if ($bytes.Length -lt 22 -or $bytes[0] -ne 0 -or $bytes[1] -ne 0 -or $bytes[2] -ne 1) { return }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').Substring(0, 12).ToLower()
    $assets = Join-Path $root 'assets'
    $named = Join-Path $assets "app-$hash.ico"
    if (-not (Test-Path $named)) {
      [System.IO.File]::WriteAllBytes($named, $bytes)
      Get-ChildItem $assets -Filter 'app-*.ico' | Where-Object { $_.FullName -ne $named } | Remove-Item -Force -ErrorAction SilentlyContinue
    }
    # And under a fixed name, for the tray icon, which the agent loads at start.
    [System.IO.File]::WriteAllBytes((Join-Path $assets 'app.ico'), $bytes)
    $script:icon = $named
  } catch { }
}

<#
  The shortcuts there are, made again: pointing at where this folder is now
  (it may have been moved since; a Startup shortcut into Downloads started
  nothing), with the current icon.
#>
function Update-Shortcuts {
  if (Test-Path $desktopLink) { New-Shortcut $desktopLink '-Open' }
  if (Test-Path $startMenuLink) { New-Shortcut $startMenuLink '-Open' }
  if (Test-Path $startupLink) { New-Shortcut $startupLink '' }
}
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Blue Everything Desktop.lnk'

<# The sign-in window. Returns $true once signed in, $false if closed. #>
function Show-SignIn {
  $config = Read-Config
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Blue Everything Desktop'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.StartPosition = 'CenterScreen'
  $form.ClientSize = New-Object System.Drawing.Size(440, 300)
  $form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  if (Test-Path $icon) { $form.Icon = New-Object System.Drawing.Icon($icon) }

  $intro = New-Object System.Windows.Forms.Label
  $intro.Text = "Sign this PC in to your Blue Everything. In the app, open Settings, then Devices, then Sign in another device: it shows the address and a code."
  $intro.SetBounds(16, 12, 408, 60)
  $form.Controls.Add($intro)

  $addressLabel = New-Object System.Windows.Forms.Label
  $addressLabel.Text = 'Address, or a sign-in link'
  $addressLabel.SetBounds(16, 76, 408, 20)
  $form.Controls.Add($addressLabel)
  $address = New-Object System.Windows.Forms.TextBox
  $address.SetBounds(16, 98, 408, 26)
  if ($config -and $config.serverUrl) { $address.Text = $config.serverUrl }
  $form.Controls.Add($address)

  $codeLabel = New-Object System.Windows.Forms.Label
  $codeLabel.Text = 'Sign-in code'
  $codeLabel.SetBounds(16, 132, 408, 20)
  $form.Controls.Add($codeLabel)
  $code = New-Object System.Windows.Forms.TextBox
  $code.SetBounds(16, 154, 200, 26)
  $code.CharacterCasing = 'Upper'
  $form.Controls.Add($code)

  $startup = New-Object System.Windows.Forms.CheckBox
  $startup.Text = 'Start when I sign in to Windows'
  # Off unless already on: nothing of the app needs to run in the background on a
  # friend's PC. This is for popups over games and voice, and only if wanted.
  $startup.Checked = Test-Path $startupLink
  $startup.SetBounds(16, 192, 408, 24)
  $form.Controls.Add($startup)

  $problem = New-Object System.Windows.Forms.Label
  $problem.ForeColor = [System.Drawing.Color]::Firebrick
  $problem.SetBounds(16, 218, 408, 40)
  $form.Controls.Add($problem)

  $go = New-Object System.Windows.Forms.Button
  $go.Text = 'Sign in'
  $go.SetBounds(324, 262, 100, 30)
  $form.Controls.Add($go)
  $form.AcceptButton = $go

  $script:signedIn = $false
  $go.Add_Click({
    $problem.Text = ''
    $parts = Split-Address $address.Text
    $typedCode = ($code.Text -replace '\s', '')
    if (-not $typedCode -and $parts.Code) { $typedCode = $parts.Code }
    if (-not $parts.Url) { $problem.Text = 'Type the address the app showed.'; return }
    if (-not $typedCode) { $problem.Text = 'Type the sign-in code, or paste a sign-in link above.'; return }
    $form.Cursor = 'WaitCursor'
    try {
      $token = Redeem $parts.Url $typedCode
      # No byte-order mark: the agent reads this with JSON.parse.
      $json = @{ serverUrl = $parts.Url; token = $token } | ConvertTo-Json
      [System.IO.File]::WriteAllText($configPath, $json)
      New-Shortcut $startMenuLink '-Open'
      if ($startup.Checked) { New-Shortcut $startupLink '' }
      elseif (Test-Path $startupLink) { Remove-Item $startupLink -Force }
      $script:signedIn = $true
      $form.Close()
    } catch {
      $problem.Text = $_.Exception.Message
    } finally {
      $form.Cursor = 'Default'
    }
  })

  [void]$form.ShowDialog()
  return $script:signedIn
}

. (Join-Path $PSScriptRoot 'app-id.ps1')
<#
  Its own taskbar ID, not the full app's: on a PC that also runs Blue
  Everything (yours, testing a friend's copy), the two are different apps and
  get a button each. Its shortcuts are named "Blue Everything Desktop" for the
  same reason, so neither replaces the other's.
#>
$script:BlueAppId = 'BlueEverything.Desktop'

if ($Shortcut) {
  $signedIn = Read-Config
  if ($signedIn -and $signedIn.serverUrl) { Update-AppIcon $signedIn.serverUrl }
  New-Shortcut $desktopLink '-Open'
  New-Shortcut $startMenuLink '-Open'
  # One made by an older version carries the full app's ID; this gives it its own.
  if (Test-Path $startupLink) { New-Shortcut $startupLink '' }
  [void][System.Windows.Forms.MessageBox]::Show(
    "Made ""Blue Everything Desktop"" on the Desktop and in the Start Menu.",
    'Blue Everything Desktop', 'OK', 'Information')
  exit 0
}

try {
  . (Join-Path $PSScriptRoot 'node-runtime.ps1')
} catch {
  Show-Problem "Could not get Node.js: $($_.Exception.Message)`n`nThe first run needs the internet once, to download it into this folder."
  exit 1
}

<#
  The agent imports @everything/shared by name. npm would link it; a zip
  cannot hold a link, so it is a junction (no admin needed).

  **Checked at every start, not only made once.** A junction holds an absolute
  path, so moving the folder (out of Downloads, the usual first move) left it
  pointing at a folder that was gone, and the agent stopped as it started with
  "Cannot find package '@everything/shared'". One pointing anywhere but here
  is replaced; removing a junction removes the link, never what it points at.
#>
$sharedLink = Join-Path $root 'node_modules\@everything\shared'
$sharedTarget = Join-Path $root 'packages\shared'
$existing = Get-Item -LiteralPath $sharedLink -Force -ErrorAction SilentlyContinue
if ($existing -and $existing.LinkType -and (@($existing.Target)[0] -ne $sharedTarget)) {
  [System.IO.Directory]::Delete($sharedLink)
  $existing = $null
}
if (-not $existing) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sharedLink) | Out-Null
  New-Item -ItemType Junction -Path $sharedLink -Target $sharedTarget | Out-Null
}

$config = Read-Config
if ($SignIn -or -not ($config -and $config.serverUrl -and $config.token)) {
  if (-not (Show-SignIn)) { exit 0 }
  $config = Read-Config
  # Signed in afresh: a running agent is still holding the old address and key.
  $Restart = $true
}

Update-AppIcon $config.serverUrl
Update-Shortcuts

if ($Restart) { Stop-Agent; Start-Sleep -Milliseconds 500 }

if (-not (Get-AgentProcess)) {
  foreach ($name in 'agent', 'agent.err') {
    $log = Join-Path $logDir "$name.log"
    if (Test-Path $log) { Move-Item $log (Join-Path $logDir "$name.prev.log") -Force }
  }
  # `--expose-gc`: switching voice off gives its memory back. See CLAUDE.md, Leanness.
  $agent = Start-Process $script:AgentExe `
    -ArgumentList '--expose-gc', '--import', 'tsx', "`"$agentEntry`"" `
    -WorkingDirectory $agentDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'agent.log') `
    -RedirectStandardError (Join-Path $logDir 'agent.err.log') `
    -PassThru
  Start-Sleep -Milliseconds 1500
  if ($agent.HasExited) {
    $why = (Get-Content (Join-Path $logDir 'agent.err.log') -Tail 8 -ErrorAction SilentlyContinue) -join "`n"
    Show-Problem "The desktop app stopped as it started.`n`n$why`n`nThe whole log is in $logDir."
    exit 1
  }
}

if ($Open) { Open-AppWindowAt $config.serverUrl }
