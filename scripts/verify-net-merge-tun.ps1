param([string]$Engine = '', [int]$RunSeconds = 10)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Engine) { $Engine = Join-Path $root 'artifacts\net-merge-release\win-unpacked\resources\net-merge\net-merge.exe' }
if ($RunSeconds -lt 5 -or $RunSeconds -gt 30) { throw 'Use a bounded test duration from 5 to 30 seconds.' }
if (-not (Test-Path -LiteralPath $Engine -PathType Leaf)) { throw 'Build the packaged engine first.' }
if (Get-Process -Name net-merge,net-merge-tray,omnilink-tray -ErrorAction SilentlyContinue) { throw 'Stop existing routing engines before this test.' }
$splitRoutes = @(Get-NetRoute -AddressFamily IPv4 | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/1','128.0.0.0/1') })
if ($splitRoutes.Count -gt 0) { throw 'Existing split-default routes were found. Test stopped to avoid interfering with another tunnel.' }
function Get-Defaults {
  @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ForEach-Object { "$($_.InterfaceIndex)|$($_.NextHop)|$($_.RouteMetric)" } | Sort-Object)
}
$before = Get-Defaults
$state = Join-Path $root ('artifacts\net-merge-tun-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $state | Out-Null
$log = Join-Path $state 'engine.log'
Write-Host "Approve the Windows administrator prompt. The engine will stop automatically after $RunSeconds seconds."
& $Engine run -hidden -for ($RunSeconds.ToString() + 's') -state-dir $state -log $log
if ($LASTEXITCODE -ne 0) { throw "Engine launch failed. See $log" }
$active = $null
$deadline = [DateTime]::UtcNow.AddSeconds(30)
try {
  while ([DateTime]::UtcNow -lt $deadline) {
    $statusPath = Join-Path $state 'status.json'
    if (Test-Path -LiteralPath $statusPath) {
      try { $candidate = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { $candidate = $null }
      if ($candidate -and $candidate.Mode -eq 'system-wide') { $active = $candidate; break }
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $active) { throw "System-wide startup was not confirmed. See $log" }
  $during = @(Get-NetRoute -AddressFamily IPv4 | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/1','128.0.0.0/1') })
  foreach ($prefix in @('0.0.0.0/1','128.0.0.0/1')) {
    if (-not ($during | Where-Object DestinationPrefix -eq $prefix)) { throw "Missing TUN route $prefix" }
  }
  if (@(Compare-Object $before (Get-Defaults)).Count -ne 0) { throw 'Original default routes changed while the engine was active.' }
  $reply = Invoke-WebRequest 'https://1.1.1.1/cdn-cgi/trace' -UseBasicParsing -TimeoutSec 5
  if ($reply.StatusCode -ne 200) { throw 'HTTPS did not work through the active tunnel.' }
} finally {
  # Ask for cleanup even on a failed assertion; -for is an independent fallback.
  New-Item -ItemType Directory -Path (Join-Path $state 'ctl') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $state 'ctl\off') -Value ''
}
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ((Test-Path -LiteralPath (Join-Path $state 'status.json')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
$afterSplit = @(Get-NetRoute -AddressFamily IPv4 | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/1','128.0.0.0/1') })
if ($afterSplit.Count -ne 0) { throw 'Split-default routes remain after shutdown; inspect the engine log before continuing.' }
if (@(Compare-Object $before (Get-Defaults)).Count -ne 0) { throw 'Original default routes were not restored.' }
$result = @{ Passed = $true; OriginalDefaults = $before; SplitRoutesWhileActive = @($during | Select-Object DestinationPrefix,InterfaceIndex); HTTPSStatus = $reply.StatusCode; Log = $log }
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $state 'result.json')
$result | ConvertTo-Json -Depth 4
