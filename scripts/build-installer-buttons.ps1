$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -products '*' -latest -property installationPath
if (!$vs) { throw 'Visual Studio C++ Build Tools are required for installer buttons.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvarsall.bat'
Push-Location $root
try {
  & cmd /c "call `"$vcvars`" x86 >nul && cl /nologo /LD /MT /O2 /DUNICODE /D_UNICODE build\installer-buttons.cpp /Febuild\FluxFetchButtons.dll /Fobuild\installer-buttons.obj /link /DEF:build\installer-buttons.def user32.lib gdi32.lib comctl32.lib"
  if ($LASTEXITCODE -ne 0) { throw 'Installer button compilation failed.' }
} finally { Pop-Location }
