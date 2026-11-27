import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function powershellPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const candidate = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

/**
 * Windows PowerShell 5.1 reads -File scripts as ANSI unless there is a BOM,
 * which mangles the Chinese UI strings and breaks parsing. Passing the script
 * through -EncodedCommand (UTF-16LE) makes the encoding explicit and immune to
 * BOM/editing accidents. Args are appended as a `param(...)` call in the decoded
 * command.
 */
function encodedCommand(script, args) {
  let source = readFileSync(script, 'utf8').replace(/^\uFEFF/, '')
  // Drop the script's own param(...) block; we inject its variables below so
  // there is exactly one param-like declaration and no encoding ambiguity.
  source = source.replace(/^\s*param\s*\([\s\S]*?^\s*\)\s*/m, '')
  const prefix = Object.entries(args)
    .map(([k, v]) => `$${k} = ${JSON.stringify(String(v))}`)
    .join('\n')
  const command = `${prefix}\n${source}`
  return Buffer.from(command, 'utf16le').toString('base64')
}

function pidFile() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'sales-copilot', 'overlay.pid')
}

/** Read the PID the overlay window wrote for itself; 0 if none/stale. */
function readPid() {
  try {
    const raw = readFileSync(pidFile(), 'ascii').trim()
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

/** Is a process with this pid still alive? */
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Kill a recorded overlay process by its exact PID. No command-line pattern
 * matching (which could kill unrelated PowerShell processes) — the PID file
 * is the single source of truth, written by the window itself on startup.
 */
function killRecorded() {
  const pid = readPid()
  if (pid && alive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  try { unlinkSync(pidFile()) } catch { /* already gone */ }
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
  let closing = false

  function state() {
    const recorded = readPid()
    const isOpen = (child !== null && child.exitCode === null) || (recorded !== 0 && alive(recorded))
    return { supported, open: isOpen, pid: child?.pid ?? (recorded || null), failure }
  }

  function open() {
    if (!supported) return { ok: false, error: '当前系统暂不支持系统置顶窗口（仅 Windows）', overlay: state() }
    if (disposed) return { ok: false, error: '插件已卸载', overlay: state() }
    if (state().open) {
      // A window from an earlier session may still be alive even though our
      // in-memory child handle is gone — close it first so "open" always gives
      // a fresh, controllable window.
      closing = true
      killRecorded()
      if (child !== null) {
        try { child.kill() } catch { /* already gone */ }
        child = null
      }
    }
    closing = false
    const origin = getOrigin()
    if (origin === null || origin === '') return { ok: false, error: 'Web 服务尚未就绪', overlay: state() }
    failure = null
    const cmd = encodedCommand(script, {
      ApiUrl: `${origin}/sales-copilot/api`,
      PidFile: pidFile(),
    })
    try {
      child = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', cmd],
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
      if (closing) {
        // We killed it on purpose (收起浮层 / dispose): the nonzero exit code
        // and any CLIXML on stderr are expected, not a failure to show.
        log('overlay: window closed')
        return
      }
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
    closing = true
    const current = child
    child = null
    if (current !== null) {
      try {
        current.kill()
      } catch {
        // already gone
      }
    }
    // Kill the window by its recorded PID as well. This covers the case where
    // the child handle is stale (DSH restarted) but the WPF window is alive.
    killRecorded()
    return state()
  }

  function dispose() {
    disposed = true
    close()
  }

  return { state, open, close, dispose }
}
