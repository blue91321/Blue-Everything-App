<#
    Teach Windows what an `everything:` link means, so the app can start itself.

    The app window survives the server stopping — the service worker keeps the
    shell — and the offline screen offers a button to start it again. A web page
    has no other way to launch a process: a custom URL scheme is the mechanism
    Windows provides for exactly this, and it is what the button navigates to.

    Two things make this narrower than it sounds:

      * **HKCU, not HKLM.** It is registered for this user, needs no
        administrator, and is undone by deleting one key.
      * **The URL is never passed on.** The command has no `%1`, so nothing from
        the link reaches PowerShell. Any page on the internet can invoke
        `everything://` and the whole of what it achieves is starting your own
        app — the same thing the desktop shortcut does.

    Run by `Create Desktop Icon.cmd`, alongside the shortcut it makes, because
    both answer "set this machine up to run the app".
#>

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $repo 'scripts\start.ps1'

if (-not (Test-Path $startScript)) {
    throw "start.ps1 not found at $startScript"
}

# `-Open` so the button also brings the window up, which is what somebody
# pressing "Start it" is asking for.
$command = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Open' -f `
    (Join-Path $PSHOME 'powershell.exe'), $startScript

$root = 'HKCU:\Software\Classes\everything'

New-Item -Path $root -Force | Out-Null
Set-ItemProperty -Path $root -Name '(Default)' -Value 'URL:Blue Everything'
# The marker that makes Windows treat this key as a protocol at all. It has to
# exist and its value is ignored, which is why it is an empty string rather than
# anything meaningful.
Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''

$commandKey = Join-Path $root 'shell\open\command'
New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -Path $commandKey -Name '(Default)' -Value $command

Write-Host "Registered everything: -> $startScript -Open"
Write-Host 'The offline screen in the app can now start the server.'
