# Builds everything into dist\: the two exes, wintun.dll, the installer, and a portable zip.
#   scripts\build.ps1 -Version 0.1.0
# Needs Go and Inno Setup 6 (ISCC.exe on PATH, in a default install dir, or in $env:ISCC).
param(
    [string]$Version = '0.0.0',
    [string]$RepoUrl = ''
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Invoke-Native {
    param([string]$What, [scriptblock]$Cmd)
    & $Cmd
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3, got '$Version'" }

if (Test-Path dist) { Remove-Item dist -Recurse -Force }
New-Item -ItemType Directory dist | Out-Null

Invoke-Native 'go vet'  { go vet ./... }
Invoke-Native 'go test' { go test ./... }

# Version info, icon and manifest for each exe: antivirus ML models flag bare unsigned Go exes
# (Microsoft's Trojan:Win32/Wacatac.B!ml).
function New-Resources([string]$Exe, [string]$Description) {
    Invoke-Native "resources $Exe" { go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --out cmd\net-merge\rsrc --icon packaging\icons\hicolor\256x256\apps\net-merge.png --manifest cli --product-name net-merge --file-description $Description --original-filename $Exe --product-version $Version --file-version $Version --copyright 'net-merge contributors' }
}

# One source, two exes: a console CLI, and a windowless build that defaults to the tray.
New-Resources 'net-merge.exe' 'net-merge'
Invoke-Native 'build cli'  { go build -trimpath -ldflags "-s -w -X main.version=$Version" -o dist\net-merge.exe .\cmd\net-merge }
New-Resources 'net-merge-tray.exe' 'net-merge tray'
Invoke-Native 'build tray' { go build -trimpath -ldflags "-s -w -H=windowsgui -X main.defaultCmd=tray -X main.version=$Version" -o dist\net-merge-tray.exe .\cmd\net-merge }
Remove-Item cmd\net-merge\rsrc_windows_amd64.syso
Invoke-Native 'icon' { .\dist\net-merge.exe _icon dist\net-merge.ico }

& "$PSScriptRoot\fetch-wintun.ps1" -OutDir dist

$iscc = $env:ISCC
if (-not $iscc) { $iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source }
if (-not $iscc) {
    $iscc = Get-ChildItem 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe', 'C:\Program Files\Inno Setup 6\ISCC.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $iscc) { throw 'ISCC.exe not found. Install Inno Setup 6 or set $env:ISCC.' }

$isccArgs = @("/DVersion=$Version")
if ($RepoUrl) { $isccArgs += "/DRepoUrl=$RepoUrl" }
Invoke-Native 'inno setup' { & $iscc @isccArgs installer\net-merge.iss }

$portable = "dist\net-merge-$Version-portable.zip"
Compress-Archive -Path dist\net-merge.exe, dist\net-merge-tray.exe, dist\wintun.dll, dist\wintun-LICENSE.txt, LICENSE, THIRD-PARTY-NOTICES.md, README.md -DestinationPath $portable
Get-ChildItem dist\net-merge-setup-$Version.exe, $portable | ForEach-Object { '{0}  {1:N1} MB' -f $_.Name, ($_.Length / 1MB) }
