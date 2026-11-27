# Always-on-top caption overlay window.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so
# every user-visible string (Chinese included) is fetched from the plugin's own
# /overlay-boot payload instead of being embedded here.
#
# The window polls /state, renders the newest bilingual captions and posts its
# own settings (font size, opacity, lock, close) plus its screen geometry back to
# the plugin, so the panel and this window stay one system.
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl
)

$ErrorActionPreference = 'Stop'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Windows PowerShell starts DPI-unaware, which makes WPF render at 96 dpi and
# lets the OS bitmap-scale the window: blurry text and coordinates that do not
# match the screen. Ask for per-monitor v2 awareness before any window exists.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LcDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Enable() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { return; } } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
"@
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LcRect {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
[LcDpi]::Enable()

function Invoke-LcApi {
  param([string]$Method, [string]$Path, $Body)
  try {
    if ($Method -eq 'GET') {
      return Invoke-RestMethod -Uri ($ApiUrl + $Path) -Method Get -TimeoutSec 5
    }
    $json = $Body | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Uri ($ApiUrl + $Path) -Method Post -ContentType 'application/json;charset=utf-8' -Body $bytes -TimeoutSec 5
  } catch {
    return $null
  }
}

$boot = Invoke-LcApi -Method GET -Path '/overlay-boot'
if ($null -eq $boot) { exit 1 }
$labels = $boot.labels
$settings = $boot.settings
$geometry = $boot.geometry

function Save-Settings {
  param($Patch)
  Invoke-LcApi -Method POST -Path '/command' -Body @{ action = 'settings'; settings = $Patch } | Out-Null
}

# ------------------------------------------------------------------ window

$win = New-Object System.Windows.Window
$win.Title = [string]$labels.title
$win.WindowStyle = [System.Windows.WindowStyle]::None
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.Topmost = $true
$win.ShowInTaskbar = $false
$win.ResizeMode = [System.Windows.ResizeMode]::NoResize
# Explicit geometry keeps WPF from sizing the window to its content; the Loaded
# handler replaces these with the remembered position and size.
$win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$win.Left = 200
$win.Top = 200
$win.Width = 748
$win.Height = 235

# #20252c is the theme's overlay surface, the same colour the in-app overlay used.
$color = [System.Windows.Media.Color]::FromArgb(255, 32, 37, 44)
# Barely-there hover wash: a full 15% white read as a pressed chip on the card,
# so the tool buttons only lift a couple of steps above the background.
$hoverBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(20, 255, 255, 255))
$lineBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(40, 255, 255, 255))
# Muted toolbar text that brightens on hover, like the in-app overlay's tools.
$mutedTextBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(210, 152, 160, 169))
$brightTextBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, 232, 234, 240))
$root = New-Object System.Windows.Controls.Border
$root.CornerRadius = New-Object System.Windows.CornerRadius(12)
$root.Background = New-Object System.Windows.Media.SolidColorBrush($color)
$root.BorderBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(33, 255, 255, 255))
$root.BorderThickness = New-Object System.Windows.Thickness(1)
$root.Padding = New-Object System.Windows.Thickness(12, 8, 12, 8)
$win.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI, Segoe UI')

$grid = New-Object System.Windows.Controls.Grid
$rowTools = New-Object System.Windows.Controls.RowDefinition
$rowTools.Height = [System.Windows.GridLength]::Auto
$rowRule = New-Object System.Windows.Controls.RowDefinition
$rowRule.Height = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Pixel)
$rowBody = New-Object System.Windows.Controls.RowDefinition
$rowBody.Height = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
$grid.RowDefinitions.Add($rowTools)
$grid.RowDefinitions.Add($rowRule)
$grid.RowDefinitions.Add($rowBody)

$tools = New-Object System.Windows.Controls.StackPanel
$tools.Orientation = 'Horizontal'
$tools.VerticalAlignment = 'Center'

# The thin rule under the tool row, and the dashed rules between entries, are
# what make this window read like the in-app overlay it replaces.
$rule = New-Object System.Windows.Shapes.Rectangle
$rule.Height = 1
$rule.Fill = $lineBrush
$rule.Margin = New-Object System.Windows.Thickness(0, 2, 0, 8)
[System.Windows.Controls.Grid]::SetRow($rule, 1)

# The stock WPF button template paints its own light-blue hover and focus wash,
# which reads as a bright chip on this dark card and ignores the brushes set
# below. A minimal template keeps the background ours: transparent at rest, a
# barely-there wash on hover, rounded like the in-app tool buttons.
$toolTemplate = @"
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                 xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                 TargetType="{x:Type Button}">
  <Border x:Name="Shell" Background="{TemplateBinding Background}"
          BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"
          CornerRadius="6" SnapsToDevicePixels="True">
    <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center"
                      VerticalAlignment="Center" RecognizesAccessKey="False" />
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsKeyboardFocused" Value="True">
      <Setter TargetName="Shell" Property="BorderBrush" Value="#6F9BFF" />
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
"@

function New-ToolButton {
  param([string]$Text, [string]$Tip, [scriptblock]$OnClick)
  $button = New-Object System.Windows.Controls.Button
  $button.Content = $Text
  $button.ToolTip = $Tip
  $button.Padding = New-Object System.Windows.Thickness(6, 1, 6, 1)
  $button.Margin = New-Object System.Windows.Thickness(0, 0, 4, 0)
  $button.FontSize = 11
  $button.Background = [System.Windows.Media.Brushes]::Transparent
  $button.Foreground = $mutedTextBrush
  $button.BorderBrush = [System.Windows.Media.Brushes]::Transparent
  # A permanent 1 px border keeps the focus outline from shifting the layout.
  $button.BorderThickness = New-Object System.Windows.Thickness(1)
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  $button.Template = [System.Windows.Markup.XamlReader]::Parse($toolTemplate)
  $button.Add_Click($OnClick)
  $button.Add_MouseEnter({
    param($sender, $event)
    $sender.Background = $hoverBrush
    $sender.Foreground = $brightTextBrush
  })
  $button.Add_MouseLeave({
    param($sender, $event)
    $sender.Background = [System.Windows.Media.Brushes]::Transparent
    $sender.Foreground = $mutedTextBrush
  })
  return $button
}

$fontOutButton = New-ToolButton -Text ([string]$labels.fontOut) -Tip ([string]$labels.font) -OnClick {
  $script:settings.lyricFontSize = [Math]::Max(14, [int]$script:settings.lyricFontSize - 2)
  Save-Settings @{ lyricFontSize = $script:settings.lyricFontSize }
}
$tools.Children.Add($fontOutButton) | Out-Null
$fontInButton = New-ToolButton -Text ([string]$labels.fontIn) -Tip ([string]$labels.font) -OnClick {
  $script:settings.lyricFontSize = [Math]::Min(34, [int]$script:settings.lyricFontSize + 2)
  Save-Settings @{ lyricFontSize = $script:settings.lyricFontSize }
}
$tools.Children.Add($fontInButton) | Out-Null
$dimOutButton = New-ToolButton -Text ([string]$labels.dimOut) -Tip ([string]$labels.dim) -OnClick {
  $script:settings.lyricOpacity = [Math]::Max(0.3, [double]$script:settings.lyricOpacity - 0.08)
  Save-Settings @{ lyricOpacity = $script:settings.lyricOpacity }
}
$tools.Children.Add($dimOutButton) | Out-Null
$dimInButton = New-ToolButton -Text ([string]$labels.dimIn) -Tip ([string]$labels.dim) -OnClick {
  $script:settings.lyricOpacity = [Math]::Min(1, [double]$script:settings.lyricOpacity + 0.08)
  Save-Settings @{ lyricOpacity = $script:settings.lyricOpacity }
}
$tools.Children.Add($dimInButton) | Out-Null
$script:sourceButton = New-ToolButton -Text ([string]$labels.sourceOn) -Tip ([string]$labels.source) -OnClick {
  $script:settings.lyricShowSource = -not [bool]$script:settings.lyricShowSource
  Save-Settings @{ lyricShowSource = $script:settings.lyricShowSource }
}
$tools.Children.Add($script:sourceButton) | Out-Null
$lockButton = New-ToolButton -Text ([string]$labels.lock) -Tip ([string]$labels.lockHint) -OnClick {
  $script:settings.lyricLocked = $true
  Save-Settings @{ lyricLocked = $true }
}
$tools.Children.Add($lockButton) | Out-Null
$closeButton = New-ToolButton -Text ([string]$labels.closeGlyph) -Tip ([string]$labels.close) -OnClick {
  Invoke-LcApi -Method POST -Path '/command' -Body @{ action = 'overlay_close' } | Out-Null
  $script:running = $false
}
$closeButton.Margin = New-Object System.Windows.Thickness(0)
$closeButton.Padding = New-Object System.Windows.Thickness(8, 1, 0, 1)
$closeButton.FontSize = 13
$closeButton.VerticalAlignment = 'Center'

# Tool row: the tools stay on the left, the hide button keeps the top-right
# corner of the box. The whole strip drags the window; only the buttons do not.
$toolbar = New-Object System.Windows.Controls.Grid
[System.Windows.Controls.Grid]::SetRow($toolbar, 0)
$colTools = New-Object System.Windows.Controls.ColumnDefinition
$colTools.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
$colClose = New-Object System.Windows.Controls.ColumnDefinition
$colClose.Width = [System.Windows.GridLength]::Auto
$toolbar.ColumnDefinitions.Add($colTools)
$toolbar.ColumnDefinitions.Add($colClose)
[System.Windows.Controls.Grid]::SetColumn($tools, 0)
[System.Windows.Controls.Grid]::SetColumn($closeButton, 1)
$closeButton.HorizontalAlignment = 'Right'
$toolbar.Children.Add($tools) | Out-Null
$toolbar.Children.Add($closeButton) | Out-Null

$scroll = New-Object System.Windows.Controls.ScrollViewer
$scroll.VerticalScrollBarVisibility = 'Hidden'
$scroll.HorizontalScrollBarVisibility = 'Disabled'
[System.Windows.Controls.Grid]::SetRow($scroll, 2)

$items = New-Object System.Windows.Controls.StackPanel
$items.Margin = New-Object System.Windows.Thickness(0, 2, 4, 0)
$scroll.Content = $items

$grid.Children.Add($toolbar) | Out-Null
$grid.Children.Add($rule) | Out-Null
$grid.Children.Add($scroll) | Out-Null
$root.Child = $grid
$win.Content = $root

# One safety net for every callback: a failure inside a timer or a mouse handler
# closes nothing, it only gets logged with its line number.
$win.Dispatcher.Add_UnhandledException({
  param($sender, $event)
  Write-OverlayFailure $event.Exception
  $event.Handled = $true
})

# ------------------------------------------------------------------ state

$script:settings = @{
  lyricFontSize = if ($null -ne $settings.lyricFontSize) { [int]$settings.lyricFontSize } else { 22 }
  lyricOpacity = if ($null -ne $settings.lyricOpacity) { [double]$settings.lyricOpacity } else { 0.92 }
  lyricShowSource = if ($null -ne $settings.lyricShowSource) { [bool]$settings.lyricShowSource } else { $true }
  lyricLocked = if ($null -ne $settings.lyricLocked) { [bool]$settings.lyricLocked } else { $false }
}
$script:running = $true
$script:dirty = $true
$script:signature = ''
$script:lockedShown = $false
$script:geomTimer = $null
$script:scale = 1.0

function Get-Scale {
  # DIP -> physical pixel factor for this monitor (1 for 100% scaling).
  try {
    $source = [System.Windows.PresentationSource]::FromVisual($win)
    if ($null -ne $source) { return [double]$source.CompositionTarget.TransformToDevice.M11 }
  } catch { }
  return 1.0
}

function Save-Geometry {
  # Settings hold DIPs (the same unit the web overlay uses), never raw pixels.
  Save-Settings @{ lyricX = [int]$win.Left; lyricY = [int]$win.Top; lyricW = [int]$win.Width; lyricH = [int]$win.Height }
}

# ------------------------------------------------------------------ move/resize
# A transparent WPF window cannot use the native resize frame, and Window.DragMove
# silently does nothing on the click that activates an inactive window, so both
# gestures are driven by hand. Every gesture keeps an immutable start rect and
# applies the *total* delta to it: adding the delta to the already-updated size
# (start + delta, then size + delta ...) grows the window quadratically, which is
# why a tiny pull used to blow it up.

$script:gesture = $null
# Generous edge band: the visible border is 1px and the rounded corner eats into
# the very corner, so a wider band is what makes "grab the edge" reliable.
$EDGE = 10

<#
  True when the press landed on one of the tool buttons: those own the click, and
  every other press (empty toolbar, body) starts a drag.
#>
function Test-OnButton {
  param($Source)
  $node = $Source
  try {
    while ($null -ne $node) {
      if ($node -is [System.Windows.Controls.Button]) { return $true }
      if ($node -is [System.Windows.Media.Visual]) { $node = [System.Windows.Media.VisualTreeHelper]::GetParent($node) }
      elseif ($node -is [System.Windows.Media.Media3D.Visual3D]) { $node = [System.Windows.Media.Media3D.VisualTreeHelper]::GetParent($node) }
      else { return $false }
    }
  } catch { }
  return $false
}

function Get-Zone {
  param([System.Windows.Point]$Point)
  $w = $win.ActualWidth
  $h = $win.ActualHeight
  $left = $Point.X -lt $EDGE
  $right = $Point.X -gt ($w - $EDGE)
  $top = $Point.Y -lt $EDGE
  $bottom = $Point.Y -gt ($h - $EDGE)
  if ($left -and $top) { return 'nw' }
  if ($right -and $top) { return 'ne' }
  if ($left -and $bottom) { return 'sw' }
  if ($right -and $bottom) { return 'se' }
  if ($left) { return 'w' }
  if ($right) { return 'e' }
  if ($top) { return 'n' }
  if ($bottom) { return 's' }
  return ''
}

function Get-WorkAreaDip {
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $scale = if ($script:scale -gt 0) { $script:scale } else { 1.0 }
  return @{ x = $area.Left / $scale; y = $area.Top / $scale; w = $area.Width / $scale; h = $area.Height / $scale }
}

# A WPF DispatcherTimer callback that throws kills the whole window process. A
# rendering or geometry hiccup must never take the overlay down, so every callback
# body runs inside this guard; the exact error and line land in a log file.
function Write-OverlayFailure {
  param($Failure)
  try {
    if ($Failure -is [System.Management.Automation.ErrorRecord]) {
      $exception = $Failure.Exception
      $stack = $Failure.ScriptStackTrace
    } else {
      $exception = $Failure
      $stack = $exception.StackTrace
    }
    $text = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $exception.GetType().FullName + ': '
      + $exception.Message + ' @ ' + $stack
    [System.IO.File]::AppendAllText((Join-Path $env:TEMP 'lc-overlay-error.log'), $text + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    # Write the line as UTF-8 bytes so the Host's log (which decodes stderr as
    # UTF-8) keeps the message readable instead of mojibake.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text + [Environment]::NewLine)
    $stream = [Console]::OpenStandardError()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  } catch { }
}

$root.Add_PreviewMouseMove({
  param($sender, $event)
  $gesture = $script:gesture
  if ($null -ne $gesture) {
    $now = [System.Windows.Forms.Cursor]::Position
    $scale = if ($script:scale -gt 0) { $script:scale } else { 1.0 }
    $dx = ($now.X - $gesture.startX) / $scale
    $dy = ($now.Y - $gesture.startY) / $scale
    if ($gesture.kind -eq 'drag') {
      $area = Get-WorkAreaDip
      $x = [Math]::Max($area.x - $gesture.w0 + 80, [Math]::Min($gesture.x0 + $dx, $area.x + $area.w - 80))
      $y = [Math]::Max($area.y, [Math]::Min($gesture.y0 + $dy, $area.y + $area.h - 48))
      $win.Left = $x
      $win.Top = $y
    } else {
      $x = $gesture.x0
      $y = $gesture.y0
      $w = $gesture.w0
      $h = $gesture.h0
      $zone = $gesture.zone
      if ($zone.Contains('e')) { $w = [Math]::Max(320, $gesture.w0 + $dx) }
      if ($zone.Contains('s')) { $h = [Math]::Max(140, $gesture.h0 + $dy) }
      if ($zone.Contains('w')) {
        $w = [Math]::Max(320, $gesture.w0 - $dx)
        $x = $gesture.x0 + ($gesture.w0 - $w)
      }
      if ($zone.Contains('n')) {
        $h = [Math]::Max(140, $gesture.h0 - $dy)
        $y = $gesture.y0 + ($gesture.h0 - $h)
      }
      # Never let a drag push the box off the work area.
      $area = Get-WorkAreaDip
      $w = [Math]::Min($w, $area.w - 8)
      $h = [Math]::Min($h, $area.h - 8)
      if ($x -lt $area.x) { $w = $w + ($x - $area.x); $w = [Math]::Max(320, $w); $x = $area.x }
      if ($y -lt $area.y) { $h = $h + ($y - $area.y); $h = [Math]::Max(140, $h); $y = $area.y }
      $win.Left = $x
      $win.Top = $y
      $win.Width = $w
      $win.Height = $h
    }
    $event.Handled = $true
    return
  }
  if (-not $win.IsMouseOver) { return }
  $point = $event.GetPosition($win)
  $zone = Get-Zone -Point $point
  switch ($zone) {
    'w' { $win.Cursor = [System.Windows.Input.Cursors]::SizeWE }
    'e' { $win.Cursor = [System.Windows.Input.Cursors]::SizeWE }
    'n' { $win.Cursor = [System.Windows.Input.Cursors]::SizeNS }
    's' { $win.Cursor = [System.Windows.Input.Cursors]::SizeNS }
    'nw' { $win.Cursor = [System.Windows.Input.Cursors]::SizeNWSE }
    'se' { $win.Cursor = [System.Windows.Input.Cursors]::SizeNWSE }
    'ne' { $win.Cursor = [System.Windows.Input.Cursors]::SizeNESW }
    'sw' { $win.Cursor = [System.Windows.Input.Cursors]::SizeNESW }
    default {
      # Toolbar and body both drag the window, so both advertise a hand.
      $win.Cursor = [System.Windows.Input.Cursors]::Hand
    }
  }
})

$root.Add_PreviewMouseLeftButtonDown({
  param($sender, $event)
  if ($script:settings.lyricLocked) { return }
  if ($null -ne $script:gesture) { return }
  $point = $event.GetPosition($win)
  $zone = Get-Zone -Point $point
  $cursor = [System.Windows.Forms.Cursor]::Position
  if ($zone -ne '') {
    $script:gesture = @{
      kind = 'resize'; zone = $zone
      startX = $cursor.X; startY = $cursor.Y
      x0 = [double]$win.Left; y0 = [double]$win.Top
      w0 = [double]$win.Width; h0 = [double]$win.Height
    }
    $root.CaptureMouse() | Out-Null
    $event.Handled = $true
    return
  }
  # A press on a tool button belongs to that button; the rest of the strip drags.
  if (Test-OnButton $event.OriginalSource) { return }
  $script:gesture = @{
    kind = 'drag'
    startX = $cursor.X; startY = $cursor.Y
    x0 = [double]$win.Left; y0 = [double]$win.Top
    w0 = [double]$win.Width; h0 = [double]$win.Height
  }
  # Taking focus makes the very first drag behave like every later one.
  try { $win.Activate() } catch { }
  $win.Cursor = [System.Windows.Input.Cursors]::SizeAll
  $root.CaptureMouse() | Out-Null
  $event.Handled = $true
})

$root.Add_PreviewMouseLeftButtonUp({
  param($sender, $event)
  if ($null -ne $script:gesture) {
    $script:gesture = $null
    $root.ReleaseMouseCapture()
    $win.Cursor = [System.Windows.Input.Cursors]::Arrow
    Save-Geometry
    $event.Handled = $true
  }
})

# A cancelled capture (alt-tab, another app stealing the mouse) must not leave a
# half-finished gesture behind.
$root.Add_LostMouseCapture({
  param($sender, $event)
  if ($null -ne $script:gesture) {
    $script:gesture = $null
    Save-Geometry
  }
})

# ------------------------------------------------------------------ render

function New-TextBlock {
  param([string]$Text, [double]$Size, [bool]$Bold, [int]$Alpha)
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = $Text
  $block.FontSize = $Size
  $block.TextWrapping = 'Wrap'
  $block.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb($Alpha, 232, 234, 240))
  if ($Bold) { $block.FontWeight = [System.Windows.FontWeights]::SemiBold }
  return $block
}

function Update-Entries {
  param($State)
  $state = $State
  if ($null -eq $state) { return }
  $settings = $state.settings
  if ($null -ne $settings) {
    if ($null -ne $settings.lyricFontSize) { $script:settings.lyricFontSize = [int]$settings.lyricFontSize }
    if ($null -ne $settings.lyricOpacity) { $script:settings.lyricOpacity = [double]$settings.lyricOpacity }
    if ($null -ne $settings.lyricShowSource) { $script:settings.lyricShowSource = [bool]$settings.lyricShowSource }
    if ($null -ne $settings.lyricLocked) { $script:settings.lyricLocked = [bool]$settings.lyricLocked }
    if ($null -eq $settings.translate) { $translate = $true } else { $translate = [bool]$settings.translate }
  } else {
    $translate = $true
  }
  if ($state.settings -and $state.settings.lyricVisible -eq $false) { $script:running = $false; return }

  $baseSize = [double]$script:settings.lyricFontSize
  $win.Opacity = [double]$script:settings.lyricOpacity

  $locked = [bool]$script:settings.lyricLocked
  if ($locked -ne $script:lockedShown) {
    $script:lockedShown = $locked
    $root.IsHitTestVisible = -not $locked
    if ($locked) { $tools.Visibility = 'Collapsed'; $rule.Visibility = 'Collapsed' } else { $tools.Visibility = 'Visible'; $rule.Visibility = 'Visible' }
  }
  # The source toggle carries its state in the glyph, exactly like the panel's
  # source button does.
  if ($null -ne $script:sourceButton) {
    $script:sourceButton.Content = if ($script:settings.lyricShowSource) { [string]$labels.sourceOn } else { [string]$labels.sourceOff }
  }

  $running = ($state.status -eq 'running' -or $state.status -eq 'starting')
  $rows = @($state.entries)
  $signature = ''
  foreach ($row in $rows) { $signature += ([string]$row.seq + '|' + [string]$row.text + '|' + [string]$row.translation + ';') }
  $signature = [string]$baseSize + '|' + [string]$script:settings.lyricShowSource + '|' + [string]$translate + '|' + [string]$running + '|' + $signature
  if ($signature -eq $script:signature) { return }
  $script:signature = $signature

  $items.Children.Clear()
  if ($rows.Count -eq 0) {
    $idle = if ($running) { [string]$labels.listening } else { [string]$labels.idle }
    $items.Children.Add((New-TextBlock -Text $idle -Size ($baseSize * 0.8) -Bold $false -Alpha 200)) | Out-Null
  } else {
    $limit = [Math]::Max(0, $rows.Count - 60)
    for ($index = $limit; $index -lt $rows.Count; $index++) {
      $row = $rows[$index]
      $entry = New-Object System.Windows.Controls.Grid
      $entry.Margin = New-Object System.Windows.Thickness(0, 0, 0, 8)
      $colTime = New-Object System.Windows.Controls.ColumnDefinition
      $colTime.Width = [System.Windows.GridLength]::Auto
      $colText = New-Object System.Windows.Controls.ColumnDefinition
      $colText.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
      $entry.ColumnDefinitions.Add($colTime) | Out-Null
      $entry.ColumnDefinitions.Add($colText) | Out-Null
      $time = New-TextBlock -Text ([string]$row.at) -Size ([Math]::Max(9, $baseSize * 0.45)) -Bold $false -Alpha 170
      $time.Margin = New-Object System.Windows.Thickness(0, 2, 8, 0)
      $time.TextWrapping = 'NoWrap'
      $time.VerticalAlignment = 'Top'
      $stack = New-Object System.Windows.Controls.StackPanel
      if ($script:settings.lyricShowSource) {
        $stack.Children.Add((New-TextBlock -Text ([string]$row.text) -Size ($baseSize * 0.72) -Bold $false -Alpha 210)) | Out-Null
      }
      $hasTranslation = $null -ne $row.translation -and [string]$row.translation -ne [string]$row.text
      if ($translate -and $hasTranslation) {
        $stack.Children.Add((New-TextBlock -Text ([string]$row.translation) -Size $baseSize -Bold $true -Alpha 255)) | Out-Null
      }
      $entry.Children.Add($time) | Out-Null
      $entry.Children.Add($stack) | Out-Null
      [System.Windows.Controls.Grid]::SetColumn($stack, 1)
      $items.Children.Add($entry) | Out-Null
      # Dashed rule between entries, the same visual separator the in-app
      # overlay draws under every caption pair.
      if ($index -lt $rows.Count - 1) {
        $separator = New-Object System.Windows.Shapes.Rectangle
        $separator.Height = 1
        $separator.Stroke = $lineBrush
        $separator.StrokeThickness = 1
        $separator.StrokeDashArray = [System.Windows.Media.DoubleCollection]::new([double[]](2, 2))
        $separator.Margin = New-Object System.Windows.Thickness(0, 0, 0, 10)
        $items.Children.Add($separator) | Out-Null
      }
    }
    $scroll.ScrollToEnd()
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(400)
$script:misses = 0
$timer.Add_Tick({
  try {
    if (-not $script:running) { $timer.Stop(); $win.Close(); return }
    $state = Invoke-LcApi -Method GET -Path '/state?since=0'
    if ($null -eq $state -or $null -eq $state.state) {
      # The Host is gone (app quit or plugin unloaded): never leave an orphan
      # window floating on top of everything forever.
      $script:misses += 1
      if ($script:misses -gt 15) { $timer.Stop(); $win.Close() }
      return
    }
    $script:misses = 0
    Update-Entries -State $state.state
  } catch {
    Write-OverlayFailure $_
  }
})
$timer.Start()

# A geometry change is persisted once the drag/resize has settled.
$geomTimer = New-Object System.Windows.Threading.DispatcherTimer
$geomTimer.Interval = [TimeSpan]::FromMilliseconds(1200)
$script:lastRect = ''
$script:lastSaved = ''
$geomTimer.Add_Tick({
  try {
    $signature = [string][int]$win.Left + ',' + [string][int]$win.Top + ',' + [string][int]$win.Width + ',' + [string][int]$win.Height
    if ($signature -eq $script:lastRect) { return }
    if ($signature -eq $script:lastSaved) { return }
    $script:lastRect = $signature
    $script:lastSaved = $signature
    Save-Geometry
  } catch {
    Write-OverlayFailure $_
  }
})
$geomTimer.Start()

$win.Add_Loaded({
  try {
    $script:scale = Get-Scale
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $areaW = $area.Width / $script:scale
    $areaH = $area.Height / $script:scale
    $areaX = $area.Left / $script:scale
    $areaY = $area.Top / $script:scale
    $w = 748
    $h = 235
    if ($null -ne $geometry) {
      if ($null -ne $geometry.w) { $w = [int]$geometry.w }
      if ($null -ne $geometry.h) { $h = [int]$geometry.h }
    }
    $w = [Math]::Max(320, [Math]::Min($w, $areaW - 16))
    $h = [Math]::Max(140, [Math]::Min($h, $areaH - 16))
    $x = $areaX + [int](($areaW - $w) / 2)
    $y = $areaY + $areaH - $h - [int]($areaH * 0.12)
    if ($null -ne $geometry) {
      if ($null -ne $geometry.x) { $x = [int]$geometry.x }
      if ($null -ne $geometry.y) { $y = [int]$geometry.y }
    }
    $x = [Math]::Max($areaX + 8, [Math]::Min($x, $areaX + $areaW - $w - 8))
    $y = [Math]::Max($areaY + 8, [Math]::Min($y, $areaY + $areaH - $h - 8))
    $win.Left = $x; $win.Top = $y; $win.Width = $w; $win.Height = $h
    # Prime the view immediately instead of waiting for the first tick.
    $state = Invoke-LcApi -Method GET -Path '/state?since=0'
    if ($null -ne $state -and $null -ne $state.state) { Update-Entries -State $state.state }
    # A one-line diagnostic makes DPI/geometry bugs visible without a debugger.
    try {
      $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
      $rect = New-Object LcRect+RECT
      [void][LcRect]::GetWindowRect($hwnd, [ref]$rect)
      $diag = 'scale=' + $script:scale + ' dip=' + [int]$win.Left + ',' + [int]$win.Top + ' size=' + [int]$win.Width + 'x' + [int]$win.Height
      $diag += ' phys=' + $rect.Left + ',' + $rect.Top + ' ' + ($rect.Right - $rect.Left) + 'x' + ($rect.Bottom - $rect.Top)
      $diag += ' area=' + $area.Width + 'x' + $area.Height + ' dpi=' + [System.Windows.Media.VisualTreeHelper]::GetDpi($win).DpiScaleX
      [System.IO.File]::WriteAllText((Join-Path $env:TEMP 'lc-overlay.log'), $diag)
    } catch { }
  } catch {
    Write-OverlayFailure $_
  }
})

$win.Add_Closed({
  $timer.Stop()
  $geomTimer.Stop()
  try { $root.ReleaseMouseCapture() } catch { }
})

[void]$win.ShowDialog()
