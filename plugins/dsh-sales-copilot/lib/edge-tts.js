/**
 * Free neural TTS for the role-play room, via `edge-tts` (Microsoft Edge's
 * online speech service — no API key, no cloud account). The Windows SAPI
 * voices (Huihui/Zira) are robotic and their PowerShell stdin path mangles
 * UTF-8, so we synthesise an MP3 with edge-tts and play it with the built-in
 * WPF MediaPlayer. Nothing is cached; each line is a short temp file.
 *
 * The Python dependency is installed into DSH's bundled runtime on first use.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VOICES = {
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-JennyNeural',
}

/** Locate the bundled Python with edge-tts installed (or install it once). */
function bundledPython() {
  const candidates = [
    process.env.DSH_PYTHON,
    join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python.exe',
  ].filter((item) => typeof item === 'string' && item !== '')
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import edge_tts'], { windowsHide: true, timeout: 8000 })
    if (probe.status === 0) return candidate
  }
  // Auto-install into the first existing candidate so the next call works.
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const install = spawnSync(candidate, ['-m', 'pip', 'install', 'edge-tts', '--quiet'], { windowsHide: true, timeout: 120000 })
    if (install.status === 0) return candidate
  }
  return null
}

export function createEdgeTts({ log, platform = process.platform }) {
  const supported = platform === 'win32'
  const muted = (process.env.DSH_SALES_COPILOT_TTS ?? '').toLowerCase() === 'off'
  let python = null
  let current = null
  let speaking = false
  let lastError = null
  let lastVoice = null
  let lastMs = null

  function state() {
    return { supported: supported && !muted, engine: 'edge-tts', speaking, voice: lastVoice, lastMs, error: lastError }
  }

  function ensurePython() {
    if (python === null) python = bundledPython()
    return python
  }

  function stop() {
    if (current !== null) {
      try { current.kill() } catch { /* already exited */ }
      current = null
    }
    speaking = false
    return true
  }

  /**
   * Synthesise + play one line. Resolves when playback finished, rejects on
   * failure. A new call replaces whatever is playing.
   */
  async function speak({ text, lang = 'en', rate = 0, timeoutMs }) {
    if (!supported || muted) throw new Error('这台机器上没有可用的语音引擎')
    const line = String(text ?? '').trim()
    if (line === '') throw new Error('没有可朗读的文本')
    stop()
    const interpreter = ensurePython()
    if (interpreter === null) throw new Error('edge-tts 未安装：无法自动安装 Python 依赖')

    const voice = VOICES[lang === 'zh' ? 'zh' : 'en']
    const dir = mkdtempSync(join(tmpdir(), 'sales-tts-'))
    const file = join(dir, 'line.mp3')
    const budget = Math.max(20000, Math.round(line.length * 300) + 12000)
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : budget
    speaking = true
    lastError = null
    const started = Date.now()
    const args = ['-m', 'edge_tts', '--voice', voice, '--text', line, '--write-media', file]
    if (rate !== 0) args.push('--rate', `${rate > 0 ? '+' : ''}${rate}%`)
    const synth = spawn(interpreter, args, { windowsHide: true, stdio: 'ignore' })

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { synth.kill(); reject(new Error('语音合成超时')) }, limit)
        synth.on('error', (error) => { clearTimeout(timer); reject(error) })
        synth.on('close', (code) => {
          clearTimeout(timer)
          if (code !== 0 || !existsSync(file)) reject(new Error(`edge-tts 合成失败（${code}）`))
          else resolve()
        })
      })
      current = synth

      // Play with the built-in WPF MediaPlayer via PowerShell (no extra deps).
      const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const script = join(dir, 'play.ps1')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(script, [
        'param([string]$File)',
        'Add-Type -AssemblyName PresentationCore',
        '$p = New-Object System.Windows.Media.MediaPlayer',
        '$p.Open([Uri]$File); $p.Play()',
        '$deadline = (Get-Date).AddSeconds(25)',
        'while ((Get-Date) -lt $deadline -and -not $p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 100 }',
        'if ($p.NaturalDuration.HasTimeSpan) {',
        '  $total = $p.NaturalDuration.TimeSpan.TotalMilliseconds',
        '  $sw = [Diagnostics.Stopwatch]::StartNew()',
        '  while ($sw.Elapsed.TotalMilliseconds -lt $total + 400 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }',
        '}',
        '$p.Stop(); $p.Close()',
      ].join('\n'), 'utf8')
      current = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, file], { windowsHide: true, stdio: 'ignore' })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { current?.kill(); reject(new Error('朗读超时')) }, limit)
        const child = current
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`朗读失败（${code}）`))
        })
      })
      lastVoice = voice
      lastMs = Date.now() - started
      log(`edge-tts: spoke ${line.length} chars in ${lastMs} ms with ${voice}`)
      return { voice, ms: lastMs }
    } catch (error) {
      lastError = error.message
      throw error
    } finally {
      speaking = false
      current = null
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  return { supported: supported && !muted, voices: async () => Object.values(VOICES), speak, stop, state }
}
