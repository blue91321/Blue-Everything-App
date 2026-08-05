# Raises a real Windows toast through WinRT.
#
# Kept as a signed-off script file rather than an inline -Command string so the
# title and body arrive as PowerShell parameters. Nothing from the server is
# ever concatenated into executable text.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Body = '',
  [string]$Tag = ''
)

$ErrorActionPreference = 'Stop'

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

# XML-escape both values; a task titled "Buy milk & <eggs>" must not break the payload.
$safeTitle = [System.Security.SecurityElement]::Escape($Title)
$safeBody = [System.Security.SecurityElement]::Escape($Body)

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(@"
<toast activationType="foreground">
  <visual>
    <binding template="ToastGeneric">
      <text>$safeTitle</text>
      <text>$safeBody</text>
    </binding>
  </visual>
</toast>
"@)

$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
if ($Tag) { $toast.Tag = $Tag }

# Piggy-backing on PowerShell's own registered AUMID. A dedicated one requires
# installing a Start Menu shortcut, which is not worth it for a personal app.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
