# 屏幕记忆 · 截图后端（PowerShell + .NET，Windows 自带，无需 ffmpeg）
#
# v0.4.18：
#   · 先声明 DPI 感知 —— 否则 150% 缩放下 VirtualScreen 只有逻辑尺寸，
#     截出来就是「屏幕左上角一块」，不是整屏
#   · -WindowTitle auto 表示当前前台窗口
#
# 参数：
#   -Out          输出文件路径（.png / .jpg）
#   -Format       png / jpg（默认 png）
#   -Quality      1..100，jpg 有效（默认 85）
#   -WindowTitle  窗口标题（包含匹配；auto=当前前台窗口；不填=整个虚拟桌面）
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Format = 'png',
    [int]$Quality = 85,
    [string]$WindowTitle = ''
)

$ErrorActionPreference = 'Stop'

if (-not ('DpiHelper' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct Win32Rect { public int Left, Top, Right, Bottom; }
public class DpiHelper {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Win32Rect rect);
}
'@
}
# 关键：必须在任何屏幕尺寸查询之前，让本进程变成 DPI 感知
try { [DpiHelper]::SetProcessDpiAwareness(2) | Out-Null } catch { }
try { [DpiHelper]::SetProcessDPIAware() | Out-Null } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$srcLeft = $virtual.Left
$srcTop = $virtual.Top
$srcWidth = $virtual.Width
$srcHeight = $virtual.Height
$matchedTitle = ''
$autoWindow = $false

if ($WindowTitle -eq 'auto') {
    $autoWindow = $true
    $fg = [DpiHelper]::GetForegroundWindow()
    $win = $null
    foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
        try {
            if ($p.MainWindowHandle -eq $fg) { $win = $p; break }
        } catch { }
    }
    if (-not $win) {
        Write-Error '拿不到当前前台窗口（可能切到了本进程）'
        exit 3
    }
    $rect = New-Object Win32Rect
    if (-not [DpiHelper]::GetWindowRect($win.MainWindowHandle, [ref]$rect)) {
        Write-Error '拿不到前台窗口位置'
        exit 4
    }
    $matchedTitle = $win.MainWindowTitle
    $x1 = [Math]::Max($rect.Left, $virtual.Left)
    $y1 = [Math]::Max($rect.Top, $virtual.Top)
    $x2 = [Math]::Min($rect.Right, $virtual.Left + $virtual.Width)
    $y2 = [Math]::Min($rect.Bottom, $virtual.Top + $virtual.Height)
    $srcLeft = $x1; $srcTop = $y1
    $srcWidth = [Math]::Max(1, $x2 - $x1)
    $srcHeight = [Math]::Max(1, $y2 - $y1)
}
elseif ($WindowTitle) {
    $target = $null
    $exact = $null
    foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
        try {
            if ($p.MainWindowHandle -eq [IntPtr]::Zero) { continue }
            if (-not $p.MainWindowTitle) { continue }
            if ($p.MainWindowTitle -eq $WindowTitle) { $exact = $p; break }
            if (-not $target -and $p.MainWindowTitle.IndexOf($WindowTitle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $target = $p }
        } catch { }
    }
    $win = if ($exact) { $exact } else { $target }
    if (-not $win) {
        Write-Error "找不到标题包含「$WindowTitle」的窗口"
        exit 3
    }
    $rect = New-Object Win32Rect
    if (-not [DpiHelper]::GetWindowRect($win.MainWindowHandle, [ref]$rect)) {
        Write-Error '拿不到窗口位置'
        exit 4
    }
    $matchedTitle = $win.MainWindowTitle
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $h -le 0) {
        Write-Error '窗口尺寸异常（可能已最小化）'
        exit 5
    }
    $x1 = [Math]::Max($rect.Left, $virtual.Left)
    $y1 = [Math]::Max($rect.Top, $virtual.Top)
    $x2 = [Math]::Min($rect.Right, $virtual.Left + $virtual.Width)
    $y2 = [Math]::Min($rect.Bottom, $virtual.Top + $virtual.Height)
    $srcLeft = $x1; $srcTop = $y1
    $srcWidth = [Math]::Max(1, $x2 - $x1)
    $srcHeight = [Math]::Max(1, $y2 - $y1)
}

$bitmap = New-Object System.Drawing.Bitmap $srcWidth, $srcHeight
try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($srcLeft, $srcTop, 0, 0, $bitmap.Size)
    } finally {
        $graphics.Dispose()
    }

    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    if ($Format -ieq 'jpg' -or $Format -ieq 'jpeg') {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
        $bitmap.Save($Out, $codec, $params)
    } else {
        $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    }
} finally {
    $bitmap.Dispose()
}

$meta = [pscustomobject]@{
    ok          = $true
    path        = $Out
    width       = $srcWidth
    height      = $srcHeight
    left        = $srcLeft
    top         = $srcTop
    format      = $Format
    windowTitle = $matchedTitle
    autoWindow  = $autoWindow
}
$meta | ConvertTo-Json -Compress
try {
    $meta | ConvertTo-Json -Compress | Set-Content -Path "$Out.meta.json" -Encoding UTF8
} catch { }
