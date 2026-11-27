import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 8787

export function createTranslateFree({ root, log, platform = process.platform }) {
  const server = join(root, 'native', 'translate-free', 'server.mjs')
  let child = null
  let lastError = null

  function state() {
    return { supported: platform === 'win32' && existsSync(server), running: child !== null && child.exitCode === null, port: PORT, error: lastError }
  }

  async function healthy() {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(700) })
      return response.ok
    } catch {
      return false
    }
  }

  async function start() {
    if (!state().supported || await healthy()) return { ok: true, already: true, state: state() }
    if (child !== null) return { ok: true, already: true, state: state() }
    lastError = null
    child = spawn(process.execPath, [server], {
      cwd: join(root, 'native', 'translate-free'),
      windowsHide: true,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), MODEL_NAME: 'free-google-microsoft' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr?.on('data', (chunk) => log(`translate-free: ${String(chunk).trim().slice(-500)}`))
    child.once('error', (error) => { lastError = error?.message ?? String(error); child = null })
    child.once('exit', (code) => { if (code !== 0) lastError = `翻译桥退出（${code}）`; child = null })
    return { ok: true, started: true, state: state() }
  }

  function stop() {
    if (child === null) return { ok: true, stopped: false }
    const current = child
    child = null
    current.kill()
    return { ok: true, stopped: true }
  }

  return { start, stop, state }
}
