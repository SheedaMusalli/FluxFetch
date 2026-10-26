param([string]$MSBuild = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $MSBuild) {
  $cmd = Get-Command MSBuild.exe -ErrorAction SilentlyContinue
  if ($cmd) { $MSBuild = $cmd.Source }
  else {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
      $MSBuild = & $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    }
  }
}
if (-not $MSBuild) { throw 'Install Visual Studio C++ Build Tools and the matching Windows SDK/WDK, then rerun. No driver has been installed.' }
$project = Join-Path $root 'integrations\net-merge\driver\windows\FluxFetchNetMerge.vcxproj'
& $MSBuild $project /m /p:Configuration=Release /p:Platform=x64
if ($LASTEXITCODE -ne 0) { throw 'Net Merge kernel driver build failed.' }
$driver = Join-Path $root 'integrations\net-merge\driver\windows\out\FluxFetchNetMerge.sys'
if (-not (Test-Path -LiteralPath $driver)) { throw 'Driver build did not produce FluxFetchNetMerge.sys.' }
Write-Host "Built experimental driver: $driver"
Write-Host 'Sign and validate in a disposable Windows test VM before release packaging.'
