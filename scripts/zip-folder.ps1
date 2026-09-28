<#
.SYNOPSIS
  Zips one folder, keeping the folder itself as the top of the archive, with
  entry names that use forward slashes as the zip format requires.

.DESCRIPTION
  Used by package-release.mjs. [ZipFile]::CreateFromDirectory in Windows
  PowerShell writes backslashes, which Windows reads and other unzip tools turn
  into files with backslashes in their names; tar.exe crashed on the tens of
  thousands of files a bundled release holds. So each entry is written by hand.

.EXAMPLE
  .\scripts\zip-folder.ps1 -Folder dist\release\Blue-Everything-0.4.2 -Zip dist\release\Blue-Everything-0.4.2.zip
#>
param(
  [Parameter(Mandatory)][string]$Folder,
  [Parameter(Mandatory)][string]$Zip
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Folder = (Resolve-Path $Folder).Path.TrimEnd('\')
$top = Split-Path $Folder -Leaf
if (Test-Path $Zip) { Remove-Item -LiteralPath $Zip -Force }

$archive = [IO.Compression.ZipFile]::Open($Zip, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in Get-ChildItem -LiteralPath $Folder -Recurse -File -Force) {
    $name = $top + '/' + $file.FullName.Substring($Folder.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $file.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
  }
}
finally {
  $archive.Dispose()
}
