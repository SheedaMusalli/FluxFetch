$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$omniLinkRoot = Join-Path $projectRoot 'integrations\omnilink'
$manifest = Join-Path $omniLinkRoot 'Cargo.toml'
$output = Join-Path $omniLinkRoot 'target\release'
$staging = Join-Path $projectRoot 'resources\omnilink'

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo) {
  $cargoExe = $cargo.Source
} else {
  $cargoExe = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}
if (-not (Test-Path -LiteralPath $cargoExe -PathType Leaf)) {
  throw 'Rust Cargo is required to build OmniLink. Install the stable MSVC Rust toolchain and try again.'
}
$env:PATH = "$(Split-Path -Parent $cargoExe);$env:PATH"

Push-Location $omniLinkRoot
try {
  & $cargoExe build --release --locked --manifest-path $manifest
  if ($LASTEXITCODE -ne 0) { throw "OmniLink build failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$requiredFiles = @('omnilink-tray.exe', 'WinDivert.dll', 'WinDivert64.sys')
foreach ($file in $requiredFiles) {
  $source = Join-Path $output $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "OmniLink build output is missing: $source"
  }
}

New-Item -ItemType Directory -Path $staging -Force | Out-Null
foreach ($file in $requiredFiles) {
  Copy-Item -LiteralPath (Join-Path $output $file) -Destination $staging -Force
}
Copy-Item -LiteralPath (Join-Path $omniLinkRoot 'vendor\windivert\LICENSE') -Destination (Join-Path $staging 'WinDivert-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $omniLinkRoot 'vendor\ferrisetw-LICENSE.txt') -Destination (Join-Path $staging 'FerrisETW-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $omniLinkRoot 'README.md') -Destination (Join-Path $staging 'OmniLink-README.md') -Force
Write-Host "Built and staged OmniLink for FluxFetch: $staging"
