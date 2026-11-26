import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function powershellPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidate = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

/**
 * Always-on-top answer card as a real OS window.
 *
 * The DSH window cannot stay above Zoom / Teams / WeChat while the salesperson
 * is talking, so the card has to be its own window. The Host is plain Node and
 * cannot create one, therefore we spawn `native/overlay.ps1` (WPF, STA) which
 * polls `/rt/state` itself and keeps itself topmost.
 */
export function createOverlay({ root, log, getOrigin }) {
  const script = join(root, 'native', 'overlay.ps1')
  const supported = process.platform === 'win32' && existsSync(script)
  let child = null
  let failure = null
  let disposed = false

  function state() {
    return { supported, open: child !== null, pid: child?.pid ?? null, failure }
  }

  function open() {
    if (!supported) return { ok: false, error: '当前系统暂不支持系统置顶窗口（仅 Windows）', overlay: state() }
    if (disposed) return { ok: false, error: '插件已卸载', overlay: state() }
    if (child !== null) return { ok: true, note: '浮层已经开着', overlay: state() }
    const origin = getOrigin()
    if (origin === null || origin === '') return { ok: false, error: 'Web 服务尚未就绪', overlay: state() }
    failure = null
    try {
      child = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, '-ApiUrl', `${origin}/sales-copilot/api`],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      child = null
      failure = error.message
      return { ok: false, error: `无法启动浮层窗口：${error.message}`, overlay: state() }
    }
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length > 2000) return
      stderr += String(chunk)
    })
    child.stdout.on('data', () => {})
    child.on('error', (error) => {
      child = null
      failure = error.message
      log(`overlay: spawn failed: ${error.message}`)
    })
    child.on('exit', (code) => {
      child = null
      if (code !== 0 && stderr.trim() !== '') {
        failure = stderr.trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 400)
        log(`overlay: window exited (${code}): ${failure}`)
      } else {
        log(`overlay: window exited (${code})`)
      }
    })
    log('overlay: starting always-on-top card')
    return { ok: true, overlay: state() }
  }

  function close() {
    const current = child
    child = null
    if (current !== null) {
      try {
        current.kill()
      } catch {
        // already gone
      }
    }
    return state()
  }

  function dispose() {
    disposed = true
    close()
  }

  return { state, open, close, dispose }
}
