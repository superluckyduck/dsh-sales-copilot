param(
  [string]$ApiUrl = 'http://127.0.0.1:54525/sales-copilot/api',
  [string]$PidFile = '',
  [switch]$SelfTest
)

# Always-on-top card for live calls. It polls the plugin API directly, so the
# DSH window can be minimised behind Zoom / Teams / WeChat and the card stays.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# Record our PID so the plugin can close us precisely even after a DSH restart
# lost its in-memory child handle. This file is our single source of truth for
# "is an overlay window alive".
if ($PidFile -ne '') {
  try { [System.IO.File]::WriteAllText($PidFile, "$PID", [System.Text.Encoding]::ASCII) } catch { }
}

function Get-Newest {
  $payload = Invoke-RestMethod -Uri "$ApiUrl/rt/state" -TimeoutSec 3
  $items = @($payload.rt.items)
  $card = $null
  if ($items.Count -gt 0) { $card = $items[0] }
  return [pscustomobject]@{ payload = $payload; card = $card; count = $items.Count }
}

if ($SelfTest) {
  $result = Get-Newest
  [pscustomobject]@{
    ok = $true
    url = $ApiUrl
    running = $result.payload.rt.running
    cards = $result.count
    matched = ($null -ne $result.card -and $result.card.matched -eq $true)
    newest = if ($null -ne $result.card) { $result.card.heard } else { '' }
    model = $result.payload.model.model
  } | ConvertTo-Json -Compress
  exit 0
}

Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool RegisterHotKey(System.IntPtr hWnd, int id, uint fsModifiers, uint vk);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool UnregisterHotKey(System.IntPtr hWnd, int id);
'@

# Ctrl+Alt+Q always closes the overlay, even when locked (mouse click-through).
$script:hotkeyId = 0xBEEF
$script:hotkeyRegistered = $false

$script:locked = $false

$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = 'Transparent'
$win.Topmost = $true
$win.ShowInTaskbar = $false
$win.ShowActivated = $false
$win.ResizeMode = 'NoResize'
$win.Title = '销售助手 · 实时'
$win.Width = 470
$win.SizeToContent = 'Height'

$root = New-Object System.Windows.Controls.Border
$root.CornerRadius = 12
$root.Background = '#E6141619'
$root.BorderBrush = '#33FFFFFF'
$root.BorderThickness = 1
$root.Padding = '14,10,14,12'
$win.Content = $root

$outer = New-Object System.Windows.Controls.StackPanel

$header = New-Object System.Windows.Controls.DockPanel
$header.LastChildFill = $false

$closeButton = New-Object System.Windows.Controls.Button
$closeButton.Content = '×'
$closeButton.Width = 24
$closeButton.Height = 22
$closeButton.FontSize = 15
$closeButton.Foreground = '#99FFFFFF'
$closeButton.Background = 'Transparent'
$closeButton.BorderThickness = 0
$closeButton.ToolTip = '关闭浮层'
$closeButton.Add_Click({ $win.Close() })
[System.Windows.Controls.DockPanel]::SetDock($closeButton, 'Right')

$lockButton = New-Object System.Windows.Controls.Button
$lockButton.Content = '解锁'
$lockButton.Width = 48
$lockButton.Height = 22
$lockButton.FontSize = 11
$lockButton.Foreground = '#99FFFFFF'
$lockButton.Background = 'Transparent'
$lockButton.BorderThickness = 0
$lockButton.ToolTip = '锁定后鼠标点不到它'
$lockButton.Add_Click({
    $script:locked = -not $script:locked
    $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
    $style = [Win32.Native]::GetWindowLong($hwnd, -20)
    if ($script:locked) {
      [Win32.Native]::SetWindowLong($hwnd, -20, $style -bor 0x20) | Out-Null
      $lockButton.Content = '锁定'
    } else {
      [Win32.Native]::SetWindowLong($hwnd, -20, $style -band (-bnot 0x20)) | Out-Null
      $lockButton.Content = '解锁'
    }
  })
[System.Windows.Controls.DockPanel]::SetDock($lockButton, 'Right')

$title = New-Object System.Windows.Controls.TextBlock
$title.Text = '销售助手 · 实时'
$title.FontSize = 12
$title.Foreground = '#B3FFFFFF'
$title.VerticalAlignment = 'Center'
$title.Margin = '0,0,8,0'

[void]$header.Children.Add($title)
[void]$header.Children.Add($lockButton)
[void]$header.Children.Add($closeButton)

$heard = New-Object System.Windows.Controls.TextBlock
$heard.FontSize = 12.5
$heard.Foreground = '#B3FFFFFF'
$heard.TextWrapping = 'Wrap'
$heard.Margin = '0,6,0,0'
$heard.Text = '等待客户开口…（先在面板里点「开始听」）'

$zh = New-Object System.Windows.Controls.TextBlock
$zh.FontSize = 16
$zh.FontWeight = 'SemiBold'
$zh.Foreground = '#FFFFFFFF'
$zh.TextWrapping = 'Wrap'
$zh.Margin = '0,8,0,0'
$zh.Text = ''

$en = New-Object System.Windows.Controls.TextBlock
$en.FontSize = 13
$en.Foreground = '#8FB4FF'
$en.TextWrapping = 'Wrap'
$en.Margin = '0,8,0,0'
$en.Text = ''

$badge = New-Object System.Windows.Controls.TextBlock
$badge.FontSize = 11
$badge.Foreground = '#66FFFFFF'
$badge.Margin = '0,8,0,0'
$badge.Text = ''

$hint = New-Object System.Windows.Controls.TextBlock
$hint.FontSize = 10
$hint.Foreground = '#55FFFFFF'
$hint.Margin = '0,6,0,0'
$hint.Text = 'Ctrl+Alt+Q 关闭 · 面板「收起浮层」也可关闭'

[void]$outer.Children.Add($header)
[void]$outer.Children.Add($heard)
[void]$outer.Children.Add($zh)
[void]$outer.Children.Add($en)
[void]$outer.Children.Add($badge)
[void]$outer.Children.Add($hint)
$root.Child = $outer

$root.Add_MouseLeftButtonDown({
    if (-not $script:locked) {
      try { $win.DragMove() } catch { }
    }
  })

$area = [System.Windows.SystemParameters]::WorkArea
$win.Left = [Math]::Max(0, $area.Right - $win.Width - 24)
$win.Top = [Math]::Max(0, $area.Bottom - 220)
$win.Add_LocationChanged({ })

function Update-Card {
  try {
    $result = Get-Newest
  } catch {
    $heard.Text = '连不上销售助手（DSH 关了吗？）'
    $zh.Text = ''
    $en.Text = ''
    $badge.Text = ''
    return
  }
  $state = $result.payload.rt
  if ($result.count -eq 0) {
    if ($state.running -eq $true) {
      $heard.Text = '正在听…客户一开口这里就出答案'
    } else {
      $heard.Text = '未在听（先在面板里点「开始听」）'
    }
    $zh.Text = ''
    $en.Text = ''
    $badge.Text = ''
    return
  }
  $card = $result.card
  $heard.Text = [string]$card.heard
  if ($null -ne $card.faq -and $card.matched -eq $true) {
    $zh.Text = [string]$card.faq.zh
    $en.Text = [string]$card.faq.en
    $pct = [int]([double]$card.faq.confidence * 100)
    $badge.Text = "问答库命中 $pct% · 第 $($card.seq) 句"
  } else {
    $zh.Text = '（问答库没命中，可开 AI 精确回答）'
    $en.Text = ''
    $badge.Text = "第 $($card.seq) 句"
  }
  if ($null -ne $card.ai -and $null -ne $card.ai.zh) {
    $badge.Text = $badge.Text + "`nAI：" + [string]$card.ai.zh
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(900)
$timer.Add_Tick({ Update-Card })
$win.Add_Loaded({
    $timer.Start()
    try {
      $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
      # MOD_CONTROL(0x2) + MOD_ALT(0x1) = 0x3, VK_Q = 0x51
      if ([Win32.Native]::RegisterHotKey($hwnd, $script:hotkeyId, 0x3, 0x51)) {
        $script:hotkeyRegistered = $true
        $source = [System.Windows.Interop.HwndSource]::FromHwnd($hwnd)
        if ($null -ne $source) {
          $source.AddHook({
            param($hwnd, $msg, $wParam, $lParam, [ref]$handled)
            if ($msg -eq 0x312 -and $wParam -eq $script:hotkeyId) {  # WM_HOTKEY
              $handled.Value = $true
              $win.Close()
            }
            return [IntPtr]::Zero
          })
        }
      }
    } catch {
      # Hotkey registration can fail if another app grabbed Ctrl+Alt+Q; the
      # panel button and the × button still close the overlay.
    }
  })
$win.Add_Closed({
    $timer.Stop()
    if ($PidFile -ne '') {
      try { [System.IO.File]::Delete($PidFile) } catch { }
    }
    if ($script:hotkeyRegistered) {
      try {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
        [Win32.Native]::UnregisterHotKey($hwnd, $script:hotkeyId) | Out-Null
      } catch { }
    }
  })

Update-Card
[void]$win.ShowDialog()
exit 0
