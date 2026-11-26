param(
  [string]$Text,
  [string]$Lang = 'en',
  [int]$Rate = 0,
  [int]$Volume = 100,
  [switch]$ListVoices,
  [switch]$SelfTest
)

# Windows SAPI voice for the role-play room. ASCII-only on purpose: Windows
# PowerShell 5.1 decodes a UTF-8 script without BOM as ANSI, so the text to
# speak always arrives through stdin (UTF-8) instead of the command line.
Add-Type -AssemblyName System.Speech
$ErrorActionPreference = 'Stop'
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Get-VoiceRows {
  $rows = @()
  foreach ($v in $synth.GetInstalledVoices()) {
    $info = $v.VoiceInfo
    $rows += [pscustomobject]@{
      name    = $info.Name
      culture = $info.Culture.Name
      gender  = [string]$info.Gender
      enabled = [bool]$v.Enabled
    }
  }
  return $rows
}

if ($ListVoices) {
  $rows = Get-VoiceRows
  $json = ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
  [Console]::Out.Write($json)
  $synth.Dispose()
  exit 0
}

if ($SelfTest) {
  $synth.Volume = 60
  $synth.Speak('Voice test. This is the sales role-play room.')
  $rows = Get-VoiceRows
  $names = @($rows | ForEach-Object { $_.name })
  [Console]::Out.Write((ConvertTo-Json -InputObject ([pscustomobject]@{ ok = $true; voices = $names }) -Compress))
  $synth.Dispose()
  exit 0
}

if (-not $PSBoundParameters.ContainsKey('Text') -or [string]::IsNullOrWhiteSpace($Text)) {
  $Text = [Console]::In.ReadToEnd()
}
$Text = $Text.Trim()
if ([string]::IsNullOrWhiteSpace($Text)) {
  [Console]::Error.Write('empty text')
  $synth.Dispose()
  exit 2
}

$prefix = 'en'
if ($Lang -like 'zh*') { $prefix = 'zh' }
$match = $null
foreach ($v in $synth.GetInstalledVoices()) {
  if (-not $v.Enabled) { continue }
  if ($v.VoiceInfo.Culture.Name -like "$prefix*") {
    $match = $v
    if ($v.VoiceInfo.Gender -eq 'Male') { break }
  }
}
if ($null -ne $match) { $synth.SelectVoice($match.VoiceInfo.Name) }
$synth.Rate = $Rate
$synth.Volume = $Volume

$started = Get-Date
$synth.Speak($Text)
$elapsed = [int]((Get-Date) - $started).TotalMilliseconds
$voiceName = $synth.Voice.Name
$synth.Dispose()

[Console]::Out.Write((ConvertTo-Json -InputObject ([pscustomobject]@{
  ok      = $true
  voice   = $voiceName
  ms      = $elapsed
  chars   = $Text.Length
}) -Compress))
exit 0
