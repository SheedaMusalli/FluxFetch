$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
# Neutral surfaces for setup and uninstall; branding is text only in the page headings.
foreach ($asset in @(@{ Name = 'installerSidebar.bmp'; Width = 164; Height = 314 }, @{ Name = 'installerHeader.bmp'; Width = 150; Height = 57 })) {
  $bitmap = [System.Drawing.Bitmap]::new($asset.Width, $asset.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#171925'))
  $graphics.Dispose()
  $bitmap.Save((Join-Path $build $asset.Name), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bitmap.Dispose()
}
Write-Host 'Generated installer surfaces without logo artwork.'
