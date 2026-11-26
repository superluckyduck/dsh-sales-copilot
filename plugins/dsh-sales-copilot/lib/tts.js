// Windows SAPI text-to-speech for the role-play room. Uses the built-in
// System.Speech voices through native/speak.ps1, so there is no download and
// no cloud round-trip: a customer line is spoken the moment it is generated.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Prefer the real Windows PowerShell that ships with every Windows 10/11. */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

/**
 * @param {{ root: string, log: (message: string) => void, platform?: string }} options
 */
export function createTts({ root, log, platform = process.platform }) {
  const script = join(root, 'native', 'speak.ps1')
  // DSH_SALES_COPILOT_TTS=off keeps automated tests silent (and headless CI
  // green on machines without a voice installed).
  const muted = (process.env.DSH_SALES_COPILOT_TTS ?? '').toLowerCase() === 'off'
  const supported = !muted && platform === 'win32' && existsSync(script)
  const ps = powershellPath()

  /** @type {import('node:child_process').ChildProcess | null} */
  let current = null
  let speaking = false
  let lastError = null
  let lastVoice = null
  let lastMs = null

  function spawnSpeak(args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(ps, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-STA',
        '-File',
        script,
        ...args,
      ], { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(stderr.trim() || `speak.ps1 exited with ${code}`))
      })
      if (input !== null) child.stdin.end(input, 'utf8')
      else child.stdin.end()
    })
  }

  async function voices() {
    if (!supported) return []
    const { stdout } = await spawnSpeak(['-ListVoices'], null)
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  /**
   * Speak one line. Resolves after the audio finished, rejects on failure.
   * Only one line plays at a time: a new call replaces the previous one.
   */
  async function speak({ text, lang = 'en', rate = 0, timeoutMs }) {
    if (!supported) throw new Error('这台机器上没有可用的 Windows 语音（需要 Windows + native/speak.ps1）')
    if (typeof text !== 'string' || text.trim() === '') throw new Error('没有可朗读的文本')
    stop()
    const budget = Math.max(15000, Math.round(text.length * 140) + 8000)
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : budget
    speaking = true
    lastError = null
    const child = spawn(ps, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      script,
      '-Lang',
      lang === 'zh' ? 'zh' : 'en',
      '-Rate',
      String(Number.isFinite(rate) ? rate : 0),
    ], { windowsHide: true })
    current = child
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.end(text, 'utf8')

    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`朗读超时（${Math.round(limit / 1000)} 秒）`))
        }, limit)
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (child.killed) {
            reject(new Error('朗读已停止'))
            return
          }
          if (code !== 0) {
            reject(new Error(stderr.trim() || `speak.ps1 exited with ${code}`))
            return
          }
          resolve(stdout)
        })
      })
      const parsed = JSON.parse(result)
      lastVoice = typeof parsed.voice === 'string' ? parsed.voice : lastVoice
      lastMs = Number.isFinite(parsed.ms) ? parsed.ms : null
      log(`tts: spoke ${text.length} chars in ${lastMs ?? '?'} ms with ${lastVoice ?? 'default voice'}`)
      return parsed
    } catch (error) {
      lastError = error.message
      throw error
    } finally {
      speaking = false
      if (current === child) current = null
    }
  }

  /** Stop whatever is playing right now (kill the PowerShell that owns the audio). */
  function stop() {
    if (current === null) return false
    try {
      current.kill()
    } catch {
      // the process may have exited between the check and the kill
    }
    current = null
    speaking = false
    return true
  }

  function state() {
    return { supported, speaking, voice: lastVoice, lastMs, error: lastError }
  }

  return { supported, voices, speak, stop, state }
}
