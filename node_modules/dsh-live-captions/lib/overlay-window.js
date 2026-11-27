import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../native/overlay.ps1', import.meta.url))

function powershellPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ]
  for (const candidate of candidates) {
    if (candidate === 'powershell.exe' || existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * Desktop overlay as a real OS window.
 *
 * The in-page overlay lives inside the app window, so it disappears when that
 * window is minimised, and Document Picture-in-Picture is not guaranteed in an
 * Electron shell. The Host cannot create an Electron BrowserWindow (it is a
 * Node child process), so the overlay is a small native window of its own:
 * - Windows: WPF window started through PowerShell (`native/overlay.ps1`).
 * - macOS:   AppKit panel compiled from `native/overlay.swift` and cached by
 *            `native-bin.js`.
 *
 * Both poll `/state` for captions, post their geometry and button actions back
 * through the plugin's own API, and stay above everything. Everything
 * degrades gracefully: `describe()` reports `supported: false` where the
 * native helper is unavailable and the client keeps PiP / the in-app overlay.
 */
export function createOverlayManager({ ctx, log, onState, getNativeOverlay }) {
  const scriptSupported = process.platform === 'win32' && existsSync(SCRIPT)
  const isMac = process.platform === 'darwin'
  const supported = scriptSupported || isMac
  let child = null
  let disposed = false
  let failure = null

  function describe() {
    return { supported, open: child !== null, failure }
  }

  function origin() {
    try {
      const webServer = ctx.get('webServer')
      return typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : null
    } catch {
      return null
    }
  }

  function open(settings) {
    if (!supported) return { ok: false, error: '当前系统无法创建系统置顶窗口' }
    if (disposed) return { ok: false, error: '插件已卸载' }
    if (child !== null) return { ok: true, note: '浮层窗口已打开' }
    const base = origin()
    if (base === null) return { ok: false, error: 'Web 服务尚未就绪' }
    failure = null

    let command
    let args
    if (isMac) {
      const nativeOverlay = typeof getNativeOverlay === 'function' ? getNativeOverlay() : null
      if (nativeOverlay === null) {
        return {
          ok: false,
          error: 'macOS 浮层助手尚未就绪：需要 Xcode Command Line Tools（`xcode-select --install`），首次启用会自动编译，稍后再试。',
        }
      }
      command = nativeOverlay
      args = ['--api-url', `${base}/live-captions/api`]
    } else {
      command = powershellPath()
      args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-STA',
        '-File', SCRIPT,
        '-ApiUrl', `${base}/live-captions/api`,
      ]
    }
    try {
      child = spawn(command, args, {
        windowsHide: process.platform !== 'darwin',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      child = null
      failure = error.message
      return { ok: false, error: `无法启动浮层窗口：${error.message}` }
    }
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length > 2000) return
      stderr += String(chunk)
    })
    child.stdout.on('data', () => {})
    child.on('error', (spawnError) => {
      child = null
      failure = spawnError.message
      log(`overlay: spawn failed: ${spawnError.message}`)
      onState?.()
    })
    child.on('exit', (code) => {
      child = null
      if (code !== 0 && stderr.trim() !== '') {
        failure = stderr.trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 400)
        log(`overlay: window exited (${code}): ${failure}`)
      } else {
        log(`overlay: window exited (${code})`)
      }
      onState?.()
    })
    log('overlay: starting always-on-top window')
    onState?.()
    return { ok: true }
  }

  /** The window polls the API itself; nothing to push synchronously. */
  function sync() {}

  function close() {
    const current = child
    child = null
    if (current !== null) {
      try { current.kill() } catch { /* already gone */ }
    }
    onState?.()
  }

  function dispose() {
    disposed = true
    close()
  }

  return { describe, open, close, sync, dispose }
}
