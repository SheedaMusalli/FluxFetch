$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$source = [System.Drawing.Image]::FromFile((Join-Path $root 'build\icon.png'))
$frames = @()
foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($source, 0, 0, $size, $size)
  $graphics.Dispose()
  $stream = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($stream)
  # Windows DIB icon frame: bottom-up BGRA pixels followed by a 1-bit transparency mask.
  $maskStride = [int]([math]::Ceiling($size / 32) * 4)
  $writer.Write([int]40); $writer.Write([int]$size); $writer.Write([int]($size * 2))
  $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([int]0)
  $writer.Write([int]($size * $size * 4 + $maskStride * $size))
  foreach ($unused in 1..4) { $writer.Write([int]0) }
  for ($y = $size - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $size; $x++) {
      $pixel = $bitmap.GetPixel($x, $y)
      $writer.Write([byte]$pixel.B); $writer.Write([byte]$pixel.G)
      $writer.Write([byte]$pixel.R); $writer.Write([byte]$pixel.A)
    }
  }
  for ($y = $size - 1; $y -ge 0; $y--) {
    $mask = [byte[]]::new($maskStride)
    for ($x = 0; $x -lt $size; $x++) {
      if ($bitmap.GetPixel($x, $y).A -eq 0) {
        $index = [int][math]::Floor($x / 8)
        $mask[$index] = $mask[$index] -bor (128 -shr ($x % 8))
      }
    }
    $writer.Write($mask)
  }
  $writer.Flush()
  $frames += @{ Size = $size; Bytes = $stream.ToArray() }
  $writer.Dispose(); $stream.Dispose(); $bitmap.Dispose()
}
$source.Dispose()
$output = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($output)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($frame in $frames) {
  $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
  $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
  $offset += $frame.Bytes.Length
}
foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
$writer.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $root 'build\icon.ico'), $output.ToArray())
[System.IO.File]::WriteAllBytes((Join-Path $root 'resources\icon.ico'), $output.ToArray())
$writer.Dispose(); $output.Dispose()
Write-Host 'Generated Windows icon: 16, 24, 32, 48, 64, 128 and 256 pixels.'
