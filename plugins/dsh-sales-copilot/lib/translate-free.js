import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.TRANSLATE_FREE_PORT ?? 8787)

/**
 * Node 24's fetch ignores Windows system proxy settings unless these are set
 * AT PROCESS START. Detect the WinINET proxy here, in the parent, so the
 * spawned bridge can reach the free Google/Microsoft translation endpoints
 * on machines that require a proxy.
 */
function proxyEnv() {
  const env = {}
  const hasExplicit =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy
  if (hasExplicit) return { NODE_USE_ENV_PROXY: '1' }
  if (process.platform !== 'win32') return env
  try {
    const read = (name) =>
      execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name],
        { encoding: 'utf8', windowsHide: true, timeout: 2000 },
      )
    if (!/0x1\b/.test(read('ProxyEnable'))) return env
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(read('ProxyServer'))
    if (match === null) return env
    const server = match[1].trim()
    const url = /:\/\//.test(server) ? server : `http://${server}`
    return { HTTPS_PROXY: url, HTTP_PROXY: url, NODE_USE_ENV_PROXY: '1' }
  } catch {
    return env
  }
}

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
      env: { ...process.env, ...proxyEnv(), HOST: '127.0.0.1', PORT: String(PORT), MODEL_NAME: 'free-google-microsoft' },
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
