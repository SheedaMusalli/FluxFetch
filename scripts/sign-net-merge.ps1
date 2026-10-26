param(
  [Parameter(Mandatory=$true)][string]$CertificateThumbprint,
  [string]$SignTool = '',
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [switch]$IncludeDriver
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($CertificateThumbprint -notmatch '^[0-9a-fA-F]{40}$') { throw 'Provide a SHA-1 certificate thumbprint from the current-user Personal certificate store.' }
if (-not $SignTool) {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { $SignTool = $cmd.Source }
  else {
    $SignTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not $SignTool) { throw 'Install the Windows SDK signing tools or pass -SignTool.' }
$files = @((Join-Path $root 'resources\net-merge\net-merge.exe'), (Join-Path $root 'resources\net-merge\net-merge-tray.exe'))
if ($IncludeDriver) { $files += Join-Path $root 'integrations\net-merge\driver\windows\out\FluxFetchNetMerge.sys' }
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Build the artifact first: $file" }
  & $SignTool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $file
  if ($LASTEXITCODE -ne 0) { throw "Signing failed: $file" }
  & $SignTool verify /pa /v $file
  if ($LASTEXITCODE -ne 0) { throw "Signature is not trusted: $file" }
}
if ($IncludeDriver) { Write-Host 'Publisher signing is not Microsoft kernel approval. Submit the driver for Microsoft hardware signing before deployment on standard Secure Boot Windows.' }
