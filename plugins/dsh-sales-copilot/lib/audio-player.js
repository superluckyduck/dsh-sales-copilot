/** Play an audio file with the built-in WPF MediaPlayer (Windows, no deps). */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = [
  'param([string]$File)',
  'Add-Type -AssemblyName PresentationCore',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  '$p.Open([Uri]$File); $p.Play()',
  '$deadline = (Get-Date).AddSeconds(30)',
  'while ((Get-Date) -lt $deadline -and -not $p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 100 }',
  'if ($p.NaturalDuration.HasTimeSpan) {',
  '  $total = $p.NaturalDuration.TimeSpan.TotalMilliseconds',
  '  $sw = [Diagnostics.Stopwatch]::StartNew()',
  '  while ($sw.Elapsed.TotalMilliseconds -lt $total + 400 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }',
  '}',
  '$p.Stop(); $p.Close()',
].join('\n')

/**
 * @param {Buffer} audio file bytes (wav/mp3)
 * @param {{ ext?: string, timeoutMs?: number }} options
 */
export function playAudio(audio, { ext = 'wav', timeoutMs = 30000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sales-play-'))
  const file = join(dir, `line.${ext}`)
  const script = join(dir, 'play.ps1')
  writeFileSync(file, audio)
  writeFileSync(script, SCRIPT, 'utf8')
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, file], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('朗读超时')) }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      if (code === 0) resolve()
      else reject(new Error(`朗读失败（${code}）`))
    })
  })
}
