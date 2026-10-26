param([string]$GoExe = '', [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$source = Join-Path $projectRoot 'integrations\net-merge'
$staging = Join-Path $projectRoot 'resources\net-merge'
if (-not $GoExe) {
  $command = Get-Command go -ErrorAction SilentlyContinue
  if ($command) { $GoExe = $command.Source }
  else { $GoExe = Join-Path $projectRoot 'artifacts\net-merge-toolchain\go\bin\go.exe' }
}
if (-not (Test-Path -LiteralPath $GoExe -PathType Leaf)) { throw 'Go 1.27 or newer is required. Install Go or pass -GoExe.' }
New-Item -ItemType Directory -Force $staging | Out-Null
Push-Location $source
try {
  if (-not $SkipTests) {
    & $GoExe test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Net Merge tests failed.' }
    & $GoExe vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'Net Merge vet failed.' }
  }
  & $GoExe build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=fluxfetch-$appVersion" -o (Join-Path $staging 'net-merge.exe') ./cmd/net-merge
  if ($LASTEXITCODE -ne 0) { throw 'Net Merge build failed.' }
  & $GoExe build -trimpath -buildvcs=false -ldflags "-s -w -H=windowsgui -X main.defaultCmd=tray -X main.version=fluxfetch-$appVersion" -o (Join-Path $staging 'net-merge-tray.exe') ./cmd/net-merge
  if ($LASTEXITCODE -ne 0) { throw 'Net Merge tray build failed.' }
  & (Join-Path $source 'scripts\fetch-wintun.ps1') -OutDir $staging
  foreach ($name in @('LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md', 'FLUXFETCH-INTEGRATION.md')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $staging -Force
  }
} finally { Pop-Location }
Write-Host "Built Net Merge in $staging"
