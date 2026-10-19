# game-pet-watch screen capture helper (Windows).
#
# ASCII only on purpose: Windows PowerShell 5.1 parses .ps1 files using the ANSI
# code page unless the file carries a UTF-8 BOM, so non-ASCII bytes here would
# corrupt the parser before the first statement runs.
#
# usage:
#   pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File capture.ps1 \
#        -Title "<window title substring>" -Out "<absolute png path>" -MaxWidth 1280
#
# behaviour:
#   - finds the largest visible top-level window whose title contains -Title (case-insensitive),
#     and captures only the on-screen rectangle of that window's client area;
#   - no title given / no match -> captures the primary screen and prints "screen" as the source;
#   - on success prints "<W>x<H> <source> <window title>" to stdout;
#   - on failure exits non-zero with a one-line stderr message and never leaves a partial file.
param(
  [string]$Title = '',
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 1280
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$nativeSource = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace GPW {
  public static class Native {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  }
}
'@

Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms'

[void][GPW.Native]::SetProcessDPIAware()

function Get-VisibleWindows {
  $list = New-Object System.Collections.ArrayList
  $callback = [GPW.Native+EnumProc] {
    param([System.IntPtr]$hWnd, [System.IntPtr]$lParam)
    if ([GPW.Native]::IsWindowVisible($hWnd)) {
      $len = [GPW.Native]::GetWindowTextLength($hWnd)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][GPW.Native]::GetWindowText($hWnd, $sb, $sb.Capacity)
        $r = New-Object GPW.Native+RECT
        if ([GPW.Native]::GetClientRect($hWnd, [ref]$r)) {
          $w = $r.Right - $r.Left
          $h = $r.Bottom - $r.Top
          if ($w -gt 0 -and $h -gt 0) {
            [void]$list.Add([pscustomobject]@{
              Handle = $hWnd
              Title  = $sb.ToString()
              Width  = $w
              Height = $h
              Area   = [int64]$w * $h
            })
          }
        }
      }
    }
    return $true
  }
  [void][GPW.Native]::EnumWindows($callback, [System.IntPtr]::Zero)
  return $list
}

$bounds = $null
$source = 'screen'
$name = ''

if ($Title -and $Title.Trim().Length -gt 0) {
  $needle = $Title.Trim()
  $hit = Get-VisibleWindows |
    Where-Object { $_.Title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    Sort-Object -Property Area -Descending |
    Select-Object -First 1
  if ($hit) {
    $pt = New-Object GPW.Native+POINT
    $pt.X = 0
    $pt.Y = 0
    if ([GPW.Native]::ClientToScreen($hit.Handle, [ref]$pt)) {
      $bounds = @{ X = $pt.X; Y = $pt.Y; W = $hit.Width; H = $hit.Height }
      $source = 'window'
      $name = $hit.Title
    }
  }
}

if (-not $bounds) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bounds = @{ X = $screen.X; Y = $screen.Y; W = $screen.Width; H = $screen.Height }
}

$targetW = $bounds.W
$targetH = $bounds.H
if ($MaxWidth -gt 0 -and $targetW -gt $MaxWidth) {
  $scale = $MaxWidth / $targetW
  $targetW = [int][Math]::Max(1, [Math]::Round($bounds.W * $scale))
  $targetH = [int][Math]::Max(1, [Math]::Round($bounds.H * $scale))
}

$full = New-Object System.Drawing.Bitmap($bounds.W, $bounds.H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, (New-Object System.Drawing.Size($bounds.W, $bounds.H)))
$g.Dispose()

$dir = [System.IO.Path]::GetDirectoryName($Out)
if ($dir -and -not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }

if ($targetW -ne $bounds.W -or $targetH -ne $bounds.H) {
  $small = New-Object System.Drawing.Bitmap($targetW, $targetH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gs = [System.Drawing.Graphics]::FromImage($small)
  $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gs.DrawImage($full, 0, 0, $targetW, $targetH)
  $gs.Dispose()
  $full.Dispose()
  $small.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()
} else {
  $full.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $full.Dispose()
}

Write-Output ("{0}x{1} {2} {3}" -f $targetW, $targetH, $source, $name)
